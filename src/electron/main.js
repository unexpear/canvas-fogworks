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

    const menuTemplate = [
        {
            label: "File",
            submenu: [
                {
                    label: "New Project",
                    accelerator: "CmdOrCtrl+N",
                    click: () => mainWindow?.webContents.send("menu-new")
                },
                {
                    label: "Open...",
                    accelerator: "CmdOrCtrl+O",
                    click: () => openFileDialog()
                },
                {
                    label: "Save",
                    accelerator: "CmdOrCtrl+S",
                    click: () => mainWindow?.webContents.send("menu-save")
                },
                {
                    label: "Save As...",
                    accelerator: "CmdOrCtrl+Shift+S",
                    click: () => saveFileDialog()
                },
                { type: "separator" },
                { role: "quit" }
            ]
        },
        {
            label: "Edit",
            submenu: [
                { role: "cut" },
                { role: "copy" },
                { role: "paste" },
                { role: "delete" },
                { role: "selectAll" }
            ]
        },
        {
            label: "View",
            submenu: [
                { role: "reload" },
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "togglefullscreen" }
            ]
        },
        {
            label: "Help",
            submenu: [
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
            } else if (match(e.name)) {
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
