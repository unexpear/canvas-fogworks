/**
 * @module main
 * @description Electron main process: owns the native window, the application
 * menu, the Open/Save dialogs, and the `save-file` IPC handler (which only writes
 * to paths the user approved through a dialog). No server — loads the bundled
 * HTML/JS directly.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const pkg = require("../../package.json");

let mainWindow;

// Paths the user has explicitly approved through a Save dialog. The renderer may
// only write to one of these — it cannot supply an arbitrary filesystem path.
const approvedSavePaths = new Set();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: "Visual Design Engine",
        backgroundColor: "#1a1a2e",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js")
        },
        show: false
    });

    mainWindow.loadFile(path.join(__dirname, "..", "app", "index.html")).catch((err) => {
        dialog.showErrorBox("Load Error", `Failed to load the application UI: ${err.message}`);
    });

    mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription) => {
        dialog.showErrorBox(
            "Load Error",
            `The application UI failed to load (${errorCode}): ${errorDescription}.\n` +
            `The build may be missing — run "npm run build".`
        );
    });

    mainWindow.once("ready-to-show", () => {
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
                    label: "About Visual Design Engine",
                    click: () => {
                        if (!mainWindow) return;
                        dialog.showMessageBox(mainWindow, {
                            type: "info",
                            title: "About",
                            message: `Visual Design Engine v${pkg.version}`,
                            detail: "Document-based visual programming engine for interfaces."
                        });
                    }
                }
            ]
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

async function openFileDialog() {
    if (!mainWindow) return;
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Open Project",
            filters: [{ name: "Visual Design Engine", extensions: ["vde", "json"] }],
            properties: ["openFile"]
        });
        if (!mainWindow) return;
        if (!result.canceled && result.filePaths.length > 0) {
            const filePath = result.filePaths[0];
            const content = await fs.promises.readFile(filePath, "utf-8");
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
            filters: [{ name: "Visual Design Engine", extensions: ["vde"] }],
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
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
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
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    if (!mapPath || typeof mapPath !== "string") throw new Error("Invalid map path.");
    if (!relative || typeof relative !== "string") throw new Error("Invalid asset path.");
    const root = path.resolve(folder);
    const map = path.resolve(mapPath);
    if (map !== root && !map.startsWith(root + path.sep)) {
        throw new Error("Refusing to read a map outside the chosen folder.");
    }
    const target = path.resolve(path.dirname(map), relative);
    if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error("Refusing to read outside the chosen folder.");
    }
    return target;
}

/** One map, as text. The renderer parses it — the parser is pure and stays that way. */
ipcMain.handle("read-tiled-map", async (event, folder, mapPath) => {
    const target = resolveTiledAsset(folder, mapPath, path.basename(mapPath));
    if (!TILED_EXT.test(target)) throw new Error("Not a Tiled map.");
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

ipcMain.handle("read-image-data-url", async (event, filePath) => {
    if (!filePath || typeof filePath !== "string") throw new Error("Invalid file path.");
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = ext === "svg" ? "svg+xml" : ext === "jpg" ? "jpeg" : ext;
    const bytes = fs.readFileSync(filePath);
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
    fs.writeFileSync(target, content, "utf8");
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
    fs.writeFileSync(target, Buffer.from(body, "base64"));
    return target;
});


ipcMain.handle("request-save-as", async () => {
    await saveFileDialog();
    return true;
});

ipcMain.handle("save-file", async (event, filePath, content) => {
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
    await fs.promises.writeFile(filePath, content, "utf-8");
    return true;
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
