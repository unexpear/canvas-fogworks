/**
 * @module preload
 * @description contextBridge preload: exposes a minimal, explicitly-enumerated
 * `window.electronAPI` to the sandboxed renderer. Every subscription returns a
 * disposer so the renderer can remove the exact listener it added.
 */

const { contextBridge, ipcRenderer } = require("electron");

// Each subscription returns a disposer so the renderer can remove the exact
// listener it added (e.g. from a React effect cleanup) instead of leaking one
// per mount.
function subscribe(channel, callback, transform) {
    const handler = (_event, ...args) => callback(transform ? transform(...args) : undefined);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("electronAPI", {
    onMenuNew: (callback) => subscribe("menu-new", callback),
    onMenuSave: (callback) => subscribe("menu-save", callback),
    // Carries { filePath, content } so the renderer can remember where the
    // document came from and let Ctrl+S write back to that same file.
    onFileOpened: (callback) => subscribe("file-opened", callback, (payload) => payload),
    onRequestSave: (callback) => subscribe("request-save", callback, (filePath) => filePath),
    saveFile: (filePath, content) => ipcRenderer.invoke("save-file", filePath, content),
    requestSaveAs: () => ipcRenderer.invoke("request-save-as")
});
