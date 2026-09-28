/**
 * @module main
 * @description Electron main process: owns the native window, the application
 * menu, the Open/Save dialogs, and the `save-file` IPC handler (which only writes
 * to paths the user approved through a dialog). No server — loads the bundled
 * HTML/JS directly.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const path = require("path");
// THE SECURITY BOUNDARY, in its own module because this file cannot be required by a test —
// it is an Electron entry point. See src/electron/confine.js and its junction test.
const { resolveConfined } = require("./confine");
const { atomicWrite } = require("./atomicWrite");
const { copyProjectDependencies } = require("./projectDependencies");
const { embedProjectImages } = require("./projectImages");
const { gameDocumentTargets, gameHtml } = require("../core/export/GameExport");
const { collectGamePackage, game3DHtml } = require("./GamePackageExport");
const fs = require("fs");
const zlib = require("zlib");
const pkg = require("../../package.json");
const STARTUP_SMOKE = process.env.VDE_STARTUP_SMOKE === "1";
const PROJECT_OPEN_SMOKE = process.env.VDE_PROJECT_OPEN_SMOKE || "";
const { isolateSmokeProfile } = require("./smokeProfile");
const smokeProfile = isolateSmokeProfile(app, STARTUP_SMOKE || !!PROJECT_OPEN_SMOKE);
if (smokeProfile) console.log(`VDE_SMOKE_PROFILE: ${smokeProfile}`);
let projectWorkflowSmokeOpened = false;

let mainWindow;

// Paths the user has explicitly approved through a Save dialog. The renderer may
// only write to one of these — it cannot supply an arbitrary filesystem path.
const approvedSavePaths = new Set();
const approvedExportFolders = new Set();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: "Canvas Fogworks",
        backgroundColor: "#1a1a2e",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js")
        },
        ...(PROJECT_OPEN_SMOKE ? { x: -10000, y: -10000 } : {}),
        show: false
    });

    mainWindow.loadFile(path.join(__dirname, "..", "app", "index.html")).catch((err) => {
        if (STARTUP_SMOKE) {
            console.error(`VDE_STARTUP_SMOKE_FAILED: ${err.message}`);
            app.exit(1);
            return;
        }
        dialog.showErrorBox("Load Error", `Failed to load the application UI: ${err.message}`);
    });

    mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription) => {
        if (STARTUP_SMOKE) {
            console.error(`VDE_STARTUP_SMOKE_FAILED: ${errorCode} ${errorDescription}`);
            app.exit(1);
            return;
        }
        dialog.showErrorBox(
            "Load Error",
            `The application UI failed to load (${errorCode}): ${errorDescription}.\n` +
            `The build may be missing — run "npm run build".`
        );
    });

    mainWindow.once("ready-to-show", () => {
        if (STARTUP_SMOKE) {
            console.log("VDE_STARTUP_SMOKE_READY");
            app.exit(0);
            return;
        }
        if (PROJECT_OPEN_SMOKE) {
            // A fully hidden Chromium window lays the flex viewport out at height zero. Show it
            // off-screen so the smoke exercises real canvas and fixed-pixel gizmo dimensions.
            mainWindow.showInactive();
            // Give React's effects time to subscribe, then send exactly what the Open dialog sends.
            setTimeout(async () => {
                try {
                    const filePath = path.resolve(PROJECT_OPEN_SMOKE);
                    const content = await embedProjectImages(filePath, await fs.promises.readFile(filePath, "utf-8"));
                    approvedSavePaths.add(filePath);
                    mainWindow?.webContents.send("file-opened", { filePath, content });
                } catch (err) {
                    console.error(`VDE_PROJECT_OPEN_SMOKE_FAILED: ${err.message}`);
                    app.exit(1);
                }
            }, 100);
            return;
        }
        if (mainWindow) mainWindow.show();
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    /**
     * Send a command the renderer knows how to run.
     *
     * ONE CHANNEL, NOT ONE PER ITEM. The previous menu had a channel per entry (`menu-new`,
     * `menu-save`), which meant every new item needed a preload export, a type in App.tsx and an
     * effect — three files to add one line to a menu. A command string needs none of that, and the
     * renderer ignores what it does not recognise, so an older build never breaks on a newer menu.
     */
    const send = (command) => () => mainWindow?.webContents.send("menu-command", command);

    const menuTemplate = [
        {
            label: "File",
            submenu: [
                { label: "New Project", accelerator: "CmdOrCtrl+N", click: send("file.new") },
                { label: "Open...", accelerator: "CmdOrCtrl+O", click: () => openFileDialog() },
                { type: "separator" },
                { label: "Save", accelerator: "CmdOrCtrl+S", click: send("file.save") },
                { label: "Save As...", accelerator: "CmdOrCtrl+Shift+S", click: () => saveFileDialog() },
                { type: "separator" },
                // ONE HONEST ITEM, not a submenu promising "SVG..." and "Sprite Sheet...". Both
                // exports live behind a folder the user picks, in one panel — so this opens that
                // panel. A menu entry that names a format and then asks a different question is a
                // worse lie than a plain one.
                { label: "Export...", accelerator: "CmdOrCtrl+E", click: send("file.export") },
                { type: "separator" },
                { role: "quit", label: "Exit" }
            ]
        },
        {
            /**
             * DOCUMENT COMMANDS, not web-content ones.
             *
             * This menu used to hold `role: "selectAll"` and `role: "delete"` — Chromium roles that
             * select the DOM and delete text in a focused field. On a canvas app they are simply
             * the wrong verbs: "Select All" has to mean every NODE. The roles stay only where they
             * are still right, on the clipboard items, which serve the inspector's text fields.
             *
             * NO ACCELERATORS ON THE ITEMS THE CANVAS ALREADY BINDS. `editor/shortcuts.ts` owns
             * Ctrl+Z, Ctrl+D, Delete, Ctrl+A and Escape, and a menu accelerator on the same chord
             * fires the command a SECOND time — one undo would jump two steps. The key is shown in
             * the label so it is still discoverable, and there is exactly one thing binding it.
             */
            label: "Edit",
            submenu: [
                { label: "Undo	Ctrl+Z", click: send("edit.undo") },
                { label: "Redo	Ctrl+Shift+Z", click: send("edit.redo") },
                { type: "separator" },
                { label: "Duplicate	Ctrl+D", click: send("edit.duplicate") },
                { label: "Delete	Del", click: send("edit.delete") },
                { type: "separator" },
                { label: "Select All	Ctrl+A", click: send("edit.selectAll") },
                { label: "Deselect	Esc", click: send("edit.deselect") },
                { label: "Frame Selection	Ctrl+G", click: send("edit.group") },
                { type: "separator" },
                // The component commands. No accelerator on either: neither has ever had one, and
                // inventing a chord here would be picking a binding the canvas knows nothing about.
                { label: "Create Instance", click: send("edit.instance") },
                { label: "Detach Instance", click: send("edit.detach") },
                { type: "separator" },
                // Still the right verbs: these serve the inspector's text fields, not the canvas.
                { role: "cut" }, { role: "copy" }, { role: "paste" }
            ]
        },
        {
            label: "View",
            submenu: [
                { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: send("view.zoomIn") },
                { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: send("view.zoomOut") },
                { label: "Zoom to 100%", accelerator: "CmdOrCtrl+0", click: send("view.zoomReset") },
                // FRAMING. Shift+1 and Shift+2 are Figma's, and Sketch and Illustrator put
                // fit-all and fit-selection on the same pair — a person arriving from any of them
                // is right on the first press. The ACCELERATORS live here and not in
                // `shortcuts.ts`, which is the same split the Edit menu makes in reverse: a chord
                // claimed by the native menu never reaches the renderer's key handler, so binding
                // it in both places would leave one of them dead and both of them authoritative.
                { label: "Zoom to Fit", accelerator: "Shift+1", click: send("view.zoomFit") },
                { label: "Zoom to Selection", accelerator: "Shift+2", click: send("view.zoomSelection") },
                { type: "separator" },
                { label: "Timeline", accelerator: "CmdOrCtrl+T", click: send("view.timeline") },
                { label: "Light / Dark Theme", click: send("view.theme") },
                { type: "separator" },
                {
                    // NOT a radio group, deliberately. A checkmark has to be kept in step with the
                    // renderer's state, and a menu that opens showing the WRONG mark is worse than
                    // one that shows none — so these read as actions, which is what they are.
                    label: "Renderer",
                    submenu: [
                        { label: "Use SVG", click: send("view.backend.svg") },
                        { label: "Use Canvas", click: send("view.backend.canvas") },
                        { label: "Use WebGL (preview)", click: send("view.backend.webgl") }
                    ]
                },
                { type: "separator" },
                { role: "togglefullscreen" }
            ]
        },
        {
            /**
             * OFF THE MAIN SURFACE. These were toolbar buttons sitting beside Save, at the same
             * weight as the file actions — including a renderer switch, which is a debugging
             * control that changes what a user sees for no reason they can name.
             */
            label: "Developer",
            submenu: [
                { label: "Script Console", click: send("dev.script") },
                { label: "Design Tokens", click: send("dev.tokens") },
                { label: "Asset Folders", click: send("dev.folders") },
                { type: "separator" },
                { label: "Demo Exercises", click: send("dev.exercises") },
                { type: "separator" },
                { role: "reload" },
                { role: "toggleDevTools" }
            ]
        },
        {
            label: "Help",
            submenu: [
                { label: "Keyboard Shortcuts", click: send("help.shortcuts") },
                { type: "separator" },
                {
                    label: "About Canvas Fogworks",
                    click: () => {
                        if (!mainWindow) return;
                        dialog.showMessageBox(mainWindow, {
                            type: "info",
                            title: "About",
                            message: `Canvas Fogworks v${pkg.version}`,
                            detail: "Document-based visual programming engine for interfaces."
                        });
                    }
                }
            ]
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

// This acknowledgement has no authority during an ordinary run. In smoke mode it validates the
// sender and exact path, proving the file crossed contextBridge and passed the real deserializer.
ipcMain.on("project-open-result", (event, result) => {
    if (!PROJECT_OPEN_SMOKE || !mainWindow || event.sender !== mainWindow.webContents) return;
    const expected = path.resolve(PROJECT_OPEN_SMOKE);
    if (!result || result.filePath !== expected || result.ok !== true) {
        console.error(`VDE_PROJECT_OPEN_SMOKE_FAILED: ${result?.error || "invalid acknowledgement"}`);
        app.exit(1);
        return;
    }
    projectWorkflowSmokeOpened = true;
    void (async () => {
        try {
            // Switch through the real workspace control and wait until the persisted mesh id has
            // reached the GPU draw list. This proves open -> confined IPC -> glTF decode -> frame,
            // rather than merely proving that the current schema deserializes.
            const hydrated = await mainWindow.webContents.executeJavaScript(`new Promise(resolve => {
                document.querySelector('button[title="3D workspace"]')?.click();
                const deadline = Date.now() + 5000;
                let selected = false;
                const check = () => {
                    const canvas = document.querySelector('canvas');
                    const xAxis = document.querySelector('svg[data-vde-gizmo3d] line[data-axis="x"]');
                    const material = document.querySelector('[data-material-slot="0"]');
                    if (canvas?.__vde3D?.pickIds?.includes('model') && canvas?.__vde3D?.readyTextures?.size > 0
                        && xAxis && material?.value === 'smoke-material') {
                        const host = canvas.parentElement;
                        const rect = host.getBoundingClientRect();
                        const x1 = Number(xAxis.getAttribute('x1')), y1 = Number(xAxis.getAttribute('y1'));
                        const x2 = Number(xAxis.getAttribute('x2')), y2 = Number(xAxis.getAttribute('y2'));
                        const x = rect.left + (x1 + x2) / 2, y = rect.top + (y1 + y2) / 2;
                        host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
                        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 24, clientY: y, buttons: 1 }));
                        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 24, clientY: y, button: 0, buttons: 0 }));
                        return setTimeout(() => {
                            document.querySelector('[data-gizmo-mode="rotate"]')?.click();
                            setTimeout(() => {
                                const ring = document.querySelector('svg[data-vde-gizmo3d="rotate"] circle[data-axis="z"]');
                                if (!ring) return resolve({ ok: false, stage: 'rotate-ring' });
                                const box = host.getBoundingClientRect();
                                const cx = Number(ring.getAttribute('cx')), cy = Number(ring.getAttribute('cy'));
                                const radius = Number(ring.getAttribute('r'));
                                const sx = box.left + cx + radius, sy = box.top + cy;
                                host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sx, clientY: sy, button: 0, buttons: 1 }));
                                window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: box.left + cx, clientY: box.top + cy + radius, buttons: 1 }));
                                window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: box.left + cx, clientY: box.top + cy + radius, button: 0, buttons: 0 }));
                                document.querySelector('[data-gizmo-mode="scale"]')?.click();
                                setTimeout(() => {
                                    const scaleAxis = document.querySelector('svg[data-vde-gizmo3d="scale"] line[data-axis="x"]');
                                    if (!scaleAxis) return resolve({ ok: false, stage: 'scale-axis' });
                                    const ax1 = Number(scaleAxis.getAttribute('x1')), ay1 = Number(scaleAxis.getAttribute('y1'));
                                    const ax2 = Number(scaleAxis.getAttribute('x2')), ay2 = Number(scaleAxis.getAttribute('y2'));
                                    const length = Math.hypot(ax2 - ax1, ay2 - ay1);
                                    const scaleBox = host.getBoundingClientRect();
                                    const mx = scaleBox.left + ax2 - (ax2 - ax1) / length * 10;
                                    const my = scaleBox.top + ay2 - (ay2 - ay1) / length * 10;
                                    const dx = (ax2 - ax1) / length * 24, dy = (ay2 - ay1) / length * 24;
                                    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: mx, clientY: my, button: 0, buttons: 1 }));
                                    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: mx + dx, clientY: my + dy, buttons: 1 }));
                                    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: mx + dx, clientY: my + dy, button: 0, buttons: 0 }));
                                    const orbitBox = host.getBoundingClientRect();
                                    const ox = orbitBox.left + orbitBox.width / 2, oy = orbitBox.top + orbitBox.height / 2;
                                    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: ox, clientY: oy,
                                        button: 0, buttons: 1, altKey: true }));
                                    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ox + 30,
                                        clientY: oy - 12, buttons: 1, altKey: true }));
                                    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ox + 30,
                                        clientY: oy - 12, button: 0, buttons: 0, altKey: true }));
                                    const addPoint = document.querySelector('[data-add-light-3d="point"]');
                                    if (!addPoint) return resolve({ ok: false, stage: 'point-light-control' });
                                    addPoint.click();
                                    setTimeout(() => {
                                        document.querySelector('[data-layer-node-id="card"]')?.click();
                                        setTimeout(() => {
                                            const compose = document.querySelector('[data-compose-2d-3d]');
                                            if (!compose || compose.disabled) return resolve({ ok: false, stage: '2d-surface-control' });
                                            compose.click();
                                            setTimeout(() => {
                                                const mode = document.querySelector('[data-composition-2d-mode]');
                                                if (!mode) return resolve({ ok: false, stage: '2d-surface-inspector' });
                                                mode.value = 'billboard';
                                                mode.dispatchEvent(new Event('change', { bubbles: true }));
                                                setTimeout(() => resolve({ ok: true }), 50);
                                            }, 50);
                                        }, 50);
                                    }, 50);
                                }, 50);
                            }, 50);
                        }, 50);
                    }
                    if (!selected && canvas?.__vde3D?.pickIds?.includes('model')) {
                        selected = true;
                        document.querySelector('[data-layer-node-id="model"]')?.click();
                    }
                    if (Date.now() >= deadline) return resolve({
                        ok: false,
                        pickIds: canvas?.__vde3D?.pickIds ?? null,
                        backend: canvas?.parentElement?.dataset?.vdeBackend ?? null,
                        gizmo: Boolean(document.querySelector('svg[data-vde-gizmo3d]')),
                        lines: document.querySelectorAll('svg[data-vde-gizmo3d] line').length,
                        layer: Boolean(document.querySelector('[data-layer-node-id="model"]')),
                        layerBackground: document.querySelector('[data-layer-node-id="model"]')?.style?.background ?? null,
                        material: document.querySelector('[data-material-slot="0"]')?.value ?? null,
                        textures: canvas?.__vde3D?.textures?.size ?? null,
                        readyTextures: canvas?.__vde3D?.readyTextures?.size ?? null,
                        hostSize: canvas?.parentElement
                            ? [canvas.parentElement.clientWidth, canvas.parentElement.clientHeight]
                            : null,
                        viewport: [window.innerWidth, window.innerHeight],
                        rootHeight: document.getElementById('root')?.getBoundingClientRect()?.height ?? null,
                        hostParentHeight: canvas?.parentElement?.parentElement?.clientHeight ?? null
                    });
                    setTimeout(check, 25);
                };
                check();
            })`);
            if (!hydrated?.ok) throw new Error(`persisted 3D mesh did not rehydrate into the viewport: ${JSON.stringify(hydrated)}`);
            // A REAL Action-backed edit, followed by the same Save command the native menu sends.
            mainWindow.webContents.send("menu-command", "view.timeline");
            const animated = await mainWindow.webContents.executeJavaScript(`(async () => {
                const pause = () => new Promise(resolve => setTimeout(resolve, 40));
                for (let i = 0; i < 50 && !document.querySelector('[data-animation-panel]'); i++) await pause();
                const panel = document.querySelector('[data-animation-panel]');
                if (!panel) throw new Error('Animation panel did not appear');
                panel.open = true;
                await pause();
                const name = panel.querySelector('[aria-label="Clip name"]');
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(name, 'smoke-clip');
                name.dispatchEvent(new Event('input', { bubbles: true })); await pause();
                const button = text => [...panel.querySelectorAll('button')].find(b => b.textContent === text);
                button('Add clip').click(); await pause();
                button('Add controller').click(); await pause();
                if (!panel.querySelector('[aria-label="Initial state"]')) throw new Error('Controller was not authored: ' + panel.textContent
                    + ' | selected=' + panel.querySelector('[aria-label="Preview clip"]')?.value);
                const runtime = title => document.querySelector('button[title="' + title + '"]');
                runtime('Play the prototype: clicks and hovers fire interactions').click();
                let seen = false;
                for (let i = 0; i < 50; i++) {
                    await pause();
                    const text = document.querySelector('[data-animation-states]')?.textContent || '';
                    if (/card: idle · [1-9]/.test(text)) { seen = true; break; }
                }
                if (!seen) throw new Error('Authored clip did not advance in the 3D runtime');
                runtime('Stop — back to editing').click(); await pause();
                return true;
            })()`);
            if (!animated) throw new Error("animation workflow did not finish");
            mainWindow.webContents.send("menu-command", "file.save");
        } catch (err) {
            console.error(`VDE_PROJECT_OPEN_SMOKE_FAILED: ${err.message}`);
            app.exit(1);
        }
    })();
});

async function openFileDialog() {
    if (!mainWindow) return;
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Open Project",
            filters: [{ name: "Canvas Fogworks", extensions: ["vde", "json"] }],
            properties: ["openFile"]
        });
        if (!mainWindow) return;
        if (!result.canceled && result.filePaths.length > 0) {
            const filePath = result.filePaths[0];
            const content = await embedProjectImages(filePath, await fs.promises.readFile(filePath, "utf-8"));
            // The user chose this path, so Save (Ctrl+S) may write back to it
            // without forcing them through Save As.
            approvedSavePaths.add(filePath);
            if (mainWindow) mainWindow.webContents.send("file-opened", { filePath, content });
        }
    } catch (err) {
        dialog.showErrorBox("Open Error", `Failed to open file: ${err.message}`);
    }
}

async function saveFileDialog() {
    if (!mainWindow) return;
    try {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: "Save Project",
            filters: [{ name: "Canvas Fogworks", extensions: ["vde"] }],
            defaultPath: "project.vde"
        });
        if (!mainWindow) return;
        if (!result.canceled && result.filePath) {
            approvedSavePaths.add(result.filePath);
            mainWindow.webContents.send("request-save", result.filePath);
        }
    } catch (err) {
        dialog.showErrorBox("Save Error", `Failed to save file: ${err.message}`);
    }
}

// Lets the renderer ask for the Save As dialog when the document has no path
// yet, so Ctrl+S on an unsaved document prompts instead of silently diverting.
/**
 * Folder access for the two workflows that need it: SCANNING a codebase for capabilities that
 * have no UI, and pulling image ASSETS from a directory.
 *
 * Both read only, both bounded, and both start from a folder the user explicitly picked in a
 * native dialog — the renderer can never name a path itself. The caps exist because "read every
 * file under a directory the user pointed at" is otherwise an easy way to hang the app on a
 * home directory or a monorepo.
 */
const SCAN_MAX_FILES = 4000;
const SCAN_MAX_BYTES = 2_000_000;   // per file; a source file larger than this is generated
const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", "vendor", ".cache"]);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
// FONTS are a separate channel from images rather than the same one with a wider pattern: the
// image reader hardcodes a `data:image/…` mime, and a font arriving under it would be a URL no
// `FontFace` accepts. Two narrow doors beat one that lies about what came through it.
const FONT_EXT = /\.(ttf|otf)$/i;
const TILED_EXT = /\.tmx$/i;
const UNITY_EXT = /\.unitypackage$/i;
// BOTH SPELLINGS. Aseprite writes `.aseprite` by default and `.ase` when asked; the 45 files
// in this tree use both, and accepting one would silently hide the other from the picker.
const ASEPRITE_EXT = /\.(aseprite|ase)$/i;
const MODEL_3D_EXT = /\.(gltf|glb)$/i;
const ENVIRONMENT_3D_EXT = /\.hdr$/i;
// PALETTES are `.json`, which is the widest pattern here and deliberately not narrowed further:
// there is no palette extension to match on, and guessing by filename would miss every palette not
// called `Palette.json`. What keeps this honest is that `parsePaletteFile` returns null for a file
// that does not describe one, so the panel reports how many of the files it found were palettes.
const PALETTE_EXT = /\.json$/i;
/**
 * What an inflated blob may expand to.
 *
 * A `.tmx` layer and an `.aseprite` cel are both zlib streams read out of a file, and a hostile
 * one can be a few hundred bytes that expand to gigabytes. `zlib` will stop at this rather than
 * allocate until the process dies.
 */
const INFLATE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Files that are filesystem BOOKKEEPING rather than assets.
 *
 * A macOS copy onto a non-HFS volume leaves an AppleDouble sidecar beside every file — `._sheet.png`
 * next to `sheet.png` — holding the resource fork, not an image. The measured tree carries 465 of
 * them, 410 with a `.png` extension, so an extension test alone puts 410 entries in the asset
 * browser that every decoder then refuses. They look like corrupt art rather than like metadata.
 */
const JUNK_FILE = /^(\._|\.DS_Store$|Thumbs\.db$)/i;

/** Walk a directory, collecting entries that pass `match`, bounded by count. */
function walkDir(root, match, limit) {
    const out = [];
    const stack = [root];
    while (stack.length > 0 && out.length < limit) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (out.length >= limit) break;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SCAN_SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(full);
            } else if (!JUNK_FILE.test(e.name) && match(e.name)) {
                out.push(full);
            }
        }
    }
    return out;
}

/** Ask the user for a folder. Returns its path, or null if they cancelled. */
ipcMain.handle("pick-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: "Choose a folder",
        properties: ["openDirectory"]
    });
    const folder = result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    if (folder) approvedExportFolders.add(folder);
    return folder;
});

/** Read the SOURCE files under a folder, for the capability scan. */
ipcMain.handle("read-source-folder", async (event, folder) => {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    const files = [];
    for (const full of walkDir(folder, name => SOURCE_EXT.test(name), SCAN_MAX_FILES)) {
        try {
            if (fs.statSync(full).size > SCAN_MAX_BYTES) continue;
            files.push({
                path: path.relative(folder, full).replace(/\\/g, "/"),
                content: fs.readFileSync(full, "utf8")
            });
        } catch { /* unreadable file: skip it rather than fail the whole scan */ }
    }
    return files;
});

/** List the IMAGE files under a folder, for the asset browser. Paths only — an image is read
 *  on demand, since inlining a whole folder would be enormous. */
ipcMain.handle("read-asset-folder", async (event, folder) => {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    return walkDir(folder, name => IMAGE_EXT.test(name), SCAN_MAX_FILES).map(full => ({
        path: full,
        name: path.basename(full),
        relative: path.relative(folder, full).replace(/\\/g, "/")
    }));
});

/** Read one image as a data: URL, so a placed asset travels with the document. */
ipcMain.handle("read-font-folder", async (event, folder) => {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    return walkDir(folder, name => FONT_EXT.test(name), SCAN_MAX_FILES).map(full => ({
        path: full,
        name: path.basename(full),
        relative: path.relative(folder, full)
    }));
});

// BYTES, not a data URL: the family has to be read out of the file before anything can register
// it, and base64 is only how they cross the bridge.
ipcMain.handle("read-font-bytes", async (event, filePath) => {
    if (!filePath || typeof filePath !== "string") throw new Error("Invalid file path.");
    if (!FONT_EXT.test(filePath)) throw new Error("Not a font file.");
    return fs.readFileSync(filePath).toString("base64");
});

/** The `.tmx` files under a folder, for the map importer. */
ipcMain.handle("read-tiled-folder", async (event, folder) => {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    return walkDir(folder, name => TILED_EXT.test(name), SCAN_MAX_FILES).map(full => ({
        path: full,
        name: path.basename(full),
        relative: path.relative(folder, full).replace(/\\/g, "/")
    }));
});

/**
 * A path a MAP FILE named, resolved and confined to the folder the user picked.
 *
 * This is the one place a path arrives from FILE CONTENT rather than from a dialog or from the
 * renderer's own state, and a `.tmx` is a plain text file anyone can write. `<image
 * source="../../../../.ssh/id_rsa"/>` is a perfectly well-formed Tiled document.
 *
 * The containment is against the folder the USER PICKED, not the map's own directory — the real
 * maps legitimately reference `../Spritesheet/sheet.png`, one level up from themselves and still
 * well inside the pack. A check against the map's directory would refuse every real file; a check
 * against nothing would hand back whatever the file asked for.
 */
function resolveTiledAsset(folder, mapPath, relative) {
    if (!mapPath || typeof mapPath !== "string") throw new Error("Invalid map path.");
    // THE MAP ITSELF IS CONFINED FIRST, then whatever it points at RELATIVE TO ITS OWN DIRECTORY —
    // still measured against the folder the user picked, because real packs reference
    // `../Spritesheet/sheet.png` and a check against the map's directory would refuse every one.
    const map = resolveConfined(folder, path.dirname(path.resolve(mapPath)), path.basename(mapPath), "a map");
    return resolveConfined(folder, path.dirname(map), relative, "an asset");
}

/** One map, as text. The renderer parses it — the parser is pure and stays that way. */
ipcMain.handle("read-tiled-map", async (event, folder, mapPath) => {
    const target = resolveTiledAsset(folder, mapPath, path.basename(mapPath));
    if (!TILED_EXT.test(target)) throw new Error("Not a Tiled map.");
    return fs.readFileSync(target, "utf8");
});

/**
 * Palette files under a folder the user picked, and one of them as text.
 *
 * TWO NARROW DOORS rather than a reuse of the Tiled pair, for the reason the font channel is separate
 * from the image one: `read-tiled-map` refuses anything that is not a `.tmx`, and widening it to take
 * palettes would make its name a lie about what came through it.
 *
 * The path CONFINEMENT is the same and matters as much: a palette path arrives from the renderer,
 * which got it from a scan, but nothing about that chain is a promise — so it is resolved against the
 * folder the user actually picked and refused if it escapes.
 */
ipcMain.handle("read-palette-folder", async (event, folder) => {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    return walkDir(folder, name => PALETTE_EXT.test(name), SCAN_MAX_FILES).map(full => ({
        path: full,
        name: path.basename(full).replace(/\.json$/i, ""),
        relative: path.relative(folder, full).replace(/\\/g, "/")
    }));
});

ipcMain.handle("read-palette-file", async (event, folder, filePath) => {
    const target = resolveConfined(folder, folder, filePath, "a palette");
    if (!PALETTE_EXT.test(target)) throw new Error("Not a palette file.");
    // BOUNDED like every other read here. A palette is a few kilobytes; a multi-megabyte `.json`
    // under the same folder is something else, and `JSON.parse` on it would block the main process.
    const size = fs.statSync(target).size;
    if (size > SCAN_MAX_BYTES) throw new Error("That file is too large to be a palette.");
    return fs.readFileSync(target, "utf8");
});

/** A `.tsx` the map named, as text. */
ipcMain.handle("read-tiled-tileset", async (event, folder, mapPath, relative) => {
    const target = resolveTiledAsset(folder, mapPath, relative);
    if (!/\.tsx$/i.test(target)) throw new Error("Not a Tiled tileset.");
    return fs.readFileSync(target, "utf8");
});

/** A sheet the map or one of its tilesets named, as a data URL so it travels with the document. */
ipcMain.handle("read-tiled-image", async (event, folder, mapPath, relative) => {
    const target = resolveTiledAsset(folder, mapPath, relative);
    if (!IMAGE_EXT.test(target)) throw new Error("Not an image.");
    const ext = path.extname(target).slice(1).toLowerCase();
    const mime = ext === "svg" ? "svg+xml" : ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${fs.readFileSync(target).toString("base64")}`;
});

/** The `.unitypackage` files under a folder, for the Unity importer. */
ipcMain.handle("read-unity-folder", async (event, folder) => {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    return walkDir(folder, name => UNITY_EXT.test(name), SCAN_MAX_FILES).map(full => ({
        path: full,
        name: path.basename(full),
        bytes: fs.statSync(full).size,
        relative: path.relative(folder, full).replace(/\\/g, "/")
    }));
});

/**
 * One package, as base64 — CONFINED to the folder the user picked, like every other path channel.
 *
 * The path comes from the renderer, which got it from a scan, and nothing about that chain is a
 * promise. Same rule as `resolveTiledAsset`; the difference is that a package names no paths of its
 * own, so only the file itself has to be checked.
 */
ipcMain.handle("read-unity-package", async (event, folder, filePath) => {
    const target = resolveConfined(folder, folder, filePath, "a package");
    if (!UNITY_EXT.test(target)) throw new Error("Not a Unity package.");
    return fs.readFileSync(target).toString("base64");
});

/** The `.aseprite`/`.ase` files under a folder, for the Aseprite importer. */
ipcMain.handle("read-aseprite-folder", async (event, folder) => {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    return walkDir(folder, name => ASEPRITE_EXT.test(name), SCAN_MAX_FILES).map(full => ({
        path: full,
        name: path.basename(full),
        bytes: fs.statSync(full).size,
        relative: path.relative(folder, full).replace(/\\/g, "/")
    }));
});

/**
 * One `.aseprite`, as base64 — CONFINED like every other path that arrives from the renderer.
 *
 * BASE64 RATHER THAN A BUFFER because that is what crosses the bridge intact, the same choice
 * `read-unity-package` made. The renderer turns it back into bytes and parses it there: the parser
 * is pure and stays that way, which is the rule every importer here follows.
 *
 * The file's cel pixels are zlib streams, and the renderer already has `inflate-sync` for exactly
 * that — a `.tmx` layer and an `.aseprite` cel are the same compression, so no new channel is
 * needed to read them.
 */
ipcMain.handle("read-aseprite-bytes", async (event, folder, filePath) => {
    const target = resolveConfined(folder, folder, filePath, "an Aseprite file");
    if (!ASEPRITE_EXT.test(target)) throw new Error("Not an Aseprite file.");
    return fs.readFileSync(target).toString("base64");
});

/**
 * SYNCHRONOUS gunzip, the sibling of `inflate-sync` and deliberately NOT a widening of it.
 *
 * A `.unitypackage` is GZIP, which carries a header `zlib.inflateSync` will not accept, so the two
 * are different calls however similar they look. Widening the inflate channel to take both would
 * make its name a lie about what came through it — the same reason the palette channel is separate
 * from the Tiled one.
 *
 * Measured on the largest package in this tree: 2.8MB in, 9.5MB out, about 25ms including both
 * base64 conversions. That is a one-off during an import, which is what `sendSync` is for.
 */
ipcMain.on("gunzip-sync", (event, base64) => {
    try {
        if (typeof base64 !== "string") throw new Error("Invalid data.");
        const out = zlib.gunzipSync(Buffer.from(base64, "base64"), { maxOutputLength: INFLATE_MAX_BYTES });
        event.returnValue = { ok: true, data: out.toString("base64") };
    } catch (err) {
        // RETURNED, not thrown: a throw inside a sendSync handler leaves the renderer blocked.
        event.returnValue = { ok: false, error: String(err && err.message ? err.message : err) };
    }
});

/**
 * SYNCHRONOUS inflate, because both parsers that need one want it synchronously.
 *
 * `parseTiledMap` and `parseAseprite` take an `inflate` they call DURING the parse, which is what
 * keeps them pure and testable with no decompressor present. An async bridge cannot satisfy that
 * signature, so this is the one channel that blocks — a one-off during an import, which is exactly
 * what `sendSync` is for. Both readers went in with the injection point and neither had anything to
 * inject; this is it.
 */
ipcMain.on("inflate-sync", (event, base64) => {
    try {
        if (typeof base64 !== "string") throw new Error("Invalid data.");
        const out = zlib.inflateSync(Buffer.from(base64, "base64"), { maxOutputLength: INFLATE_MAX_BYTES });
        event.returnValue = { ok: true, data: out.toString("base64") };
    } catch (err) {
        // RETURNED, not thrown: a throw inside a sendSync handler leaves the renderer blocked.
        event.returnValue = { ok: false, error: String(err && err.message ? err.message : err) };
    }
});

ipcMain.handle("read-image-data-url", async (event, folder, filePath) => {
    const target = resolveConfined(folder, folder, filePath, "an image");
    if (!filePath || typeof filePath !== "string") throw new Error("Invalid file path.");
    if (!IMAGE_EXT.test(target)) throw new Error("Not an image file.");
    const ext = path.extname(target).slice(1).toLowerCase();
    const mime = ext === "svg" ? "svg+xml" : ext === "jpg" ? "jpeg" : ext;
    const bytes = fs.readFileSync(target);
    return `data:image/${mime};base64,${bytes.toString("base64")}`;
});


/**
 * Write a text file INTO a folder the user picked. The filename is sanitized and the result is
 * re-checked to be inside that folder, so a name like "../../etc/passwd" cannot escape the
 * directory the user actually approved.
 */
// The one place a renderer-supplied filename becomes a path. It is reduced to a BASENAME,
// sanitised, and the resolved target is re-checked against the folder the user picked in a native
// dialog — a renderer asking for `../../.ssh/authorized_keys` gets a file with a mangled name
// inside that folder and nothing else. Shared by both writers so the two cannot drift apart; a
// second copy of this check is exactly how one of them ends up missing a clause.
function resolveInsideFolder(folder, filename) {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    if (!filename || typeof filename !== "string") throw new Error("Invalid filename.");
    const safe = path.basename(filename).replace(/[^\w.\- ]+/g, "_");
    if (safe.length === 0 || safe === "." || safe === "..") throw new Error("Invalid filename.");
    const target = path.resolve(folder, safe);
    const root = path.resolve(folder);
    if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error("Refusing to write outside the chosen folder.");
    }
    return target;
}

ipcMain.handle("write-into-folder", async (event, folder, filename, content) => {
    if (typeof content !== "string") throw new Error("Invalid content: expected a string.");
    const target = resolveInsideFolder(folder, filename);
    await atomicWrite(target, content);
    return target;
});

/** Largest PNG this will write. A sheet is refused at plan time; this is the backstop. */
const MAX_PNG_BYTES = 256 * 1024 * 1024;

// A SEPARATE channel from the text writer rather than the same one with a flag, and it accepts
// only a PNG data URL. Decoding arbitrary renderer-supplied strings into bytes on disk is a wider
// door than a sprite-sheet export needs, and the narrow one costs a line.
ipcMain.handle("write-png-into-folder", async (event, folder, filename, dataUrl) => {
    if (typeof dataUrl !== "string") throw new Error("Invalid image: expected a data URL.");
    const PREFIX = "data:image/png;base64,";
    if (!dataUrl.startsWith(PREFIX)) throw new Error("Refusing to write anything but a PNG data URL.");
    const body = dataUrl.slice(PREFIX.length);
    // Rejected BEFORE decoding: allocating the buffer is the expensive part, so a size check that
    // happens after it has already been built protects nothing.
    if (body.length > MAX_PNG_BYTES) throw new Error("Refusing to write a PNG that large.");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) throw new Error("Invalid image: not base64.");
    const target = resolveInsideFolder(folder, filename);
    await atomicWrite(target, Buffer.from(body, "base64"));
    return target;
});


ipcMain.handle("request-save-as", async () => {
    await saveFileDialog();
    return true;
});

ipcMain.handle("save-file", async (event, filePath, content, sourceProjectPath) => {
    if (!filePath || typeof filePath !== "string") {
        throw new Error("Invalid file path.");
    }
    if (typeof content !== "string") {
        throw new Error("Invalid content: expected a string.");
    }
    // Only write to a path the user approved via the Save dialog — never an
    // arbitrary path chosen by the renderer.
    if (!approvedSavePaths.has(filePath)) {
        throw new Error("Refusing to write to an unapproved path. Use Save As.");
    }
    if (sourceProjectPath) {
        if (!approvedSavePaths.has(sourceProjectPath)) throw new Error("Unapproved source project.");
        await copyProjectDependencies(sourceProjectPath, filePath, content);
    } else if ((JSON.parse(content)?.document?.assets3d ?? []).length) {
        throw new Error("Reopen the original project before relocating its referenced 3D assets.");
    }
    await atomicWrite(filePath, content);
    if (PROJECT_OPEN_SMOKE && projectWorkflowSmokeOpened
        && path.resolve(filePath) === path.resolve(PROJECT_OPEN_SMOKE)) {
        try {
            const saved = JSON.parse(content);
            if (saved?.document?.timeline?.frames !== 24 || saved?.document?.timeline?.fps !== 12) {
                throw new Error("the Action-backed timeline edit was not serialized");
            }
            if (!(saved?.document?.nodes?.model?.spatial3d?.transform?.position?.x > -1)) {
                throw new Error("the 3D translate-gizmo edit was not serialized");
            }
            if (!(Math.abs(saved?.document?.nodes?.model?.spatial3d?.transform?.rotation?.z) > 0.1)) {
                throw new Error("the 3D rotate-gizmo edit was not serialized");
            }
            if (!(saved?.document?.nodes?.model?.spatial3d?.transform?.scale?.x > 1)) {
                throw new Error(`the 3D scale-gizmo edit was not serialized: ${JSON.stringify(saved?.document?.nodes?.model?.spatial3d?.transform?.scale)}`);
            }
            if (saved?.document?.nodes?.model?.spatial3d?.renderable?.materialAssetIds?.[0] !== "smoke-material") {
                throw new Error("the persisted 3D material assignment was lost");
            }
            if (!Object.values(saved?.document?.nodes ?? {}).some(node => node?.spatial3d?.light?.kind === "point")) {
                throw new Error("the Action-backed point light was not serialized");
            }
            if (!(Math.abs(saved?.document?.nodes?.camera?.spatial3d?.transform?.position?.x) > 0.1)) {
                throw new Error("the orbit-camera edit was not serialized");
            }
            if (saved?.document?.nodes?.card?.spatial3d?.composition2d?.mode !== "billboard") {
                throw new Error("the Action-backed 2D-in-3D composition was not serialized");
            }
            if (saved?.document?.nodes?.card?.animation?.states?.[0]?.clip !== "smoke-clip"
                || saved?.document?.clips?.[0]?.name !== "smoke-clip"
                || saved?.document?.nodes?.card?.frame !== undefined) {
                throw new Error("animation authoring was lost or a transient playhead leaked into the saved node");
            }
            console.log("VDE_PROJECT_FILE_SMOKE_READY");
            app.exit(0);
        } catch (err) {
            console.error(`VDE_PROJECT_OPEN_SMOKE_FAILED: ${err.message}`);
            app.exit(1);
        }
    }
    return true;
});

ipcMain.handle("export-game", async (_event, folder, content, sourceProjectPath) => {
    if (!approvedExportFolders.has(folder)) throw new Error("Choose an export folder first.");
    const destination = resolveInsideFolder(folder, "game.html");
    if (sourceProjectPath && !approvedSavePaths.has(sourceProjectPath)) throw new Error("Unapproved game project path.");
    const root = sourceProjectPath ? path.dirname(sourceProjectPath) : null;
    const levels = Object.create(null), seen = new Map();
    let total = 0;
    async function visit(file, text) {
        if (seen.has(file)) return seen.get(file);
        total += text.length;
        if (seen.size >= 32 || total > 64 * 1024 * 1024) throw new Error("Game export exceeds 32 levels or 64MB.");
        const targets = gameDocumentTargets(text), id = `level${seen.size}`;
        seen.set(file, id); levels[id] = { content: text, links: Object.create(null) };
        for (const target of targets) {
            if (!root) throw new Error("Save the project before exporting linked levels.");
            const next = resolveConfined(root, path.dirname(file), target, "a linked game level");
            if (!/\.(vde|json)$/i.test(next)) throw new Error("Linked levels must be .vde or .json projects.");
            if ((await fs.promises.stat(next)).size > 32 * 1024 * 1024) throw new Error("Linked level exceeds 32MB.");
            levels[id].links[target] = await visit(next, await fs.promises.readFile(next, "utf8"));
        }
        return id;
    }
    const entry = await visit(sourceProjectPath ? fs.realpathSync.native(sourceProjectPath) : "entry", content);
    const bundle = await fs.promises.readFile(path.join(__dirname, "..", "app", "player.js"));
    await atomicWrite(destination, gameHtml({ entry, levels }, bundle.toString("base64")));
    return destination;
});

ipcMain.handle("export-game-3d", async (event, folder, content, sourceProjectPath) => {
    if (event.sender !== mainWindow?.webContents) throw new Error("Unapproved game export sender.");
    if (!approvedExportFolders.has(folder)) throw new Error("Choose an export folder first.");
    if (!sourceProjectPath || !approvedSavePaths.has(sourceProjectPath)) throw new Error("Save the project before exporting a 3D game.");
    const serialized = await collectGamePackage(sourceProjectPath, content);
    const bundle = await fs.promises.readFile(path.join(__dirname, "..", "app", "player3d.js"));
    const destination = resolveInsideFolder(folder, "game-3d.html");
    if (fs.existsSync(destination)) throw new Error("game-3d.html already exists. Choose an empty export folder to preserve it.");
    // Exclusive creation also refuses a conflicting file created after the existence check.
    await fs.promises.writeFile(destination, game3DHtml(serialized, bundle), { flag: "wx" });
    return destination;
});

ipcMain.on("confirm-discard", event => {
    event.returnValue = !!mainWindow && dialog.showMessageBoxSync(mainWindow, {
        type: "warning", title: "Unsaved changes",
        message: "Discard unsaved changes?", detail: "Choose Cancel to return to the project and save it first.",
        buttons: ["Cancel", "Discard"], defaultId: 0, cancelId: 0, noLink: true
    }) === 1;
});

// This file lives in Electron's user-data directory, not in a renderer-chosen path.
const recoveryPath = () => path.join(app.getPath("userData"), "project-recovery.json");
function validateRecovery(snapshot) {
    if (snapshot === null) return;
    if (!snapshot || typeof snapshot.content !== "string" || typeof snapshot.savedContent !== "string"
        || snapshot.content.length > 64 * 1024 * 1024 || snapshot.savedContent.length > 64 * 1024 * 1024
        || !(snapshot.filePath === null || typeof snapshot.filePath === "string")) {
        throw new Error("Invalid or oversized recovery snapshot.");
    }
    JSON.parse(snapshot.content);
    JSON.parse(snapshot.savedContent);
}
ipcMain.handle("read-recovery", async () => {
    let raw;
    try { raw = await fs.promises.readFile(recoveryPath(), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const snapshot = JSON.parse(raw);
    validateRecovery(snapshot);
    // Only main-authored recovery records can restore an earlier approved project path.
    if (snapshot?.filePath) approvedSavePaths.add(snapshot.filePath);
    return snapshot;
});
ipcMain.handle("write-recovery", async (_event, snapshot) => {
    validateRecovery(snapshot);
    if (snapshot?.filePath && !approvedSavePaths.has(snapshot.filePath)) throw new Error("Unapproved recovery project.");
    await atomicWrite(recoveryPath(), JSON.stringify(snapshot));
});

/** List and read glTF models under a user-selected folder; external buffers stay confined there. */
ipcMain.handle("read-3d-folder", async (event, folder) => {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    return walkDir(folder, name => MODEL_3D_EXT.test(name), SCAN_MAX_FILES).map(full => ({
        path: full, name: path.basename(full), bytes: fs.statSync(full).size,
        relative: path.relative(folder, full).replace(/\\/g, "/")
    }));
});

ipcMain.handle("read-environment-folder", async (event, folder) => {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    return walkDir(folder, name => ENVIRONMENT_3D_EXT.test(name), SCAN_MAX_FILES).map(full => ({
        path: full, name: path.basename(full), bytes: fs.statSync(full).size,
        relative: path.relative(folder, full).replace(/\\/g, "/")
    }));
});

ipcMain.handle("read-environment-file", async (event, folder, filePath) => {
    const target = resolveConfined(folder, folder, filePath, "an HDR environment");
    if (!ENVIRONMENT_3D_EXT.test(target)) throw new Error("Only Radiance .hdr environments are supported.");
    if (fs.statSync(target).size > INFLATE_MAX_BYTES) throw new Error("HDR environment exceeds the 64MB input limit.");
    return fs.readFileSync(target).toString("base64");
});

ipcMain.handle("read-3d-file", async (event, folder, filePath) => {
    const target = resolveConfined(folder, folder, filePath, "a 3D model");
    if (!MODEL_3D_EXT.test(target)) throw new Error("Only .gltf and .glb models are supported.");
    if (fs.statSync(target).size > INFLATE_MAX_BYTES) throw new Error("3D model exceeds the 64MB input limit.");
    return fs.readFileSync(target).toString("base64");
});

ipcMain.handle("read-3d-sidecar", async (event, folder, modelPath, relative) => {
    const model = resolveConfined(folder, folder, modelPath, "a 3D model");
    const target = resolveConfined(folder, path.dirname(model), relative, "a 3D buffer");
    if (fs.statSync(target).size > INFLATE_MAX_BYTES) throw new Error("3D buffer exceeds the 64MB input limit.");
    return fs.readFileSync(target).toString("base64");
});

/** The saved project is the authority for persisted 3D paths, not a remembered import folder. */
function approvedProjectRoot(projectFilePath) {
    if (!projectFilePath || typeof projectFilePath !== "string") throw new Error("Save the project before importing 3D assets.");
    const project = path.resolve(projectFilePath);
    if (!approvedSavePaths.has(project)) throw new Error("The project path has not been approved by Open or Save As.");
    return path.dirname(project);
}

ipcMain.handle("project-3d-source", async (event, projectFilePath, modelPath) => {
    const root = approvedProjectRoot(projectFilePath);
    const target = resolveConfined(root, root, modelPath, "a 3D model");
    if (!MODEL_3D_EXT.test(target)) throw new Error("Only .gltf and .glb models are supported.");
    return path.relative(root, target).replace(/\\/g, "/");
});

ipcMain.handle("project-environment-source", async (event, projectFilePath, filePath) => {
    const root = approvedProjectRoot(projectFilePath);
    const target = resolveConfined(root, root, filePath, "an HDR environment");
    if (!ENVIRONMENT_3D_EXT.test(target)) throw new Error("Only Radiance .hdr environments are supported.");
    return path.relative(root, target).replace(/\\/g, "/");
});

ipcMain.handle("read-project-environment-file", async (event, projectFilePath, source) => {
    const root = approvedProjectRoot(projectFilePath);
    const target = resolveConfined(root, root, source, "an HDR environment");
    if (!ENVIRONMENT_3D_EXT.test(target)) throw new Error("Only Radiance .hdr environments are supported.");
    if (fs.statSync(target).size > INFLATE_MAX_BYTES) throw new Error("HDR environment exceeds the 64MB input limit.");
    return fs.readFileSync(target).toString("base64");
});

ipcMain.handle("read-project-3d-file", async (event, projectFilePath, source) => {
    const root = approvedProjectRoot(projectFilePath);
    const target = resolveConfined(root, root, source, "a 3D model");
    if (!MODEL_3D_EXT.test(target)) throw new Error("Only .gltf and .glb models are supported.");
    if (fs.statSync(target).size > INFLATE_MAX_BYTES) throw new Error("3D model exceeds the 64MB input limit.");
    return fs.readFileSync(target).toString("base64");
});

ipcMain.handle("read-project-3d-sidecar", async (event, projectFilePath, modelSource, relative) => {
    const root = approvedProjectRoot(projectFilePath);
    const model = resolveConfined(root, root, modelSource, "a 3D model");
    const target = resolveConfined(root, path.dirname(model), relative, "a 3D buffer");
    if (fs.statSync(target).size > INFLATE_MAX_BYTES) throw new Error("3D buffer exceeds the 64MB input limit.");
    return fs.readFileSync(target).toString("base64");
});

// A level may name a sibling project, but it cannot turn authored data into an arbitrary file read.
// The starting file must have come through Open/Save As, and the destination is confined to its
// directory (including real-path junction resolution) and to project extensions.
ipcMain.handle("read-level-file", async (event, currentFilePath, target) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Untrusted renderer.");
    if (typeof currentFilePath !== "string" || !approvedSavePaths.has(currentFilePath)) {
        throw new Error("The current project path was not approved by the user.");
    }
    if (typeof target !== "string" || target.trim() === "" || path.isAbsolute(target)) {
        throw new Error("A level transition must name a relative project path.");
    }
    const folder = path.dirname(path.resolve(currentFilePath));
    const filePath = resolveConfined(folder, folder, target, "a level project");
    if (!/\.(vde|json)$/i.test(filePath)) throw new Error("A level transition must target a .vde or .json project.");
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 20_000_000) throw new Error("The level project is larger than 20 MB.");
    const content = await embedProjectImages(filePath, await fs.promises.readFile(filePath, "utf-8"));
    approvedSavePaths.add(filePath);
    return { filePath, content };
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
    if (mainWindow === null) {
        createWindow();
    }
});
