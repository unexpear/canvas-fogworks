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
