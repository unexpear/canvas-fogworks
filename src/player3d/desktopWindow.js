/** @module desktopWindow @description Sandboxed game window with only a bounded progress slot; no editor, network or arbitrary filesystem authority. */
const { app, BrowserWindow, session, ipcMain } = require("electron");
const fs = require("fs"), path = require("path");
const { createProgressFile } = require("./progressFile");
const { pathToFileURL } = require("url");
const { randomUUID } = require("crypto");

const progressWindows = new Map(); let handlersInstalled = false;
function installProgressHandlers() {
    if (handlersInstalled) return; handlersInstalled = true;
    const slot = event => {
        const value = progressWindows.get(event.sender.id);
        if (!value || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== value.url) throw new Error("Unapproved progress sender.");
        return value.store;
    };
    ipcMain.handle("fogworks-progress-read", event => slot(event).read());
    ipcMain.handle("fogworks-progress-write", (event, content) => slot(event).write(content));
}
async function createGameWindow(html, { show = true, progressPreload = path.join(__dirname, "progressPreload.js") } = {}) {
    const allowed = pathToFileURL(html).href;
    const isolated = session.fromPartition(`fogworks-player-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", event => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: details.url !== allowed && !/^(data:|blob:)/.test(details.url) });
    });
    const win = new BrowserWindow({ show, width: 1100, height: 760, backgroundColor: "#17191f",
        autoHideMenuBar: true, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, preload: progressPreload,
            nodeIntegration: false, webSecurity: true, webviewTag: false } });
    win.removeMenu();
    const header = fs.readFileSync(html, "utf8");
    const gameId = header.match(/data-sha256="([a-f0-9]{64})"/)?.[1];
    if (!gameId) { win.destroy(); throw new Error("Game package identity is missing."); }
    installProgressHandlers();
    const windowId = win.webContents.id;
    progressWindows.set(windowId, { url: allowed, store: createProgressFile(path.join(app.getPath("userData"), "player-progress"), gameId) });
    win.on("closed", () => progressWindows.delete(windowId));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.on("will-frame-navigate", event => event.preventDefault());
    win.webContents.on("will-attach-webview", event => event.preventDefault());
    try { await win.loadFile(html); return win; }
    catch (error) { win.destroy(); throw error; }
}
module.exports = { createGameWindow };
