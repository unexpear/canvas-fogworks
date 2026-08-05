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
    writePngIntoFolder: (folder, filename, dataUrl) =>
        ipcRenderer.invoke("write-png-into-folder", folder, filename, dataUrl),
    requestSaveAs: () => ipcRenderer.invoke("request-save-as"),
    // Folder workflows. Every one starts from a folder the USER picked in a native dialog;
    // the renderer never names a path of its own, and all of these are read-only.
    pickFolder: () => ipcRenderer.invoke("pick-folder"),
    readSourceFolder: (folder) => ipcRenderer.invoke("read-source-folder", folder),
    readAssetFolder: (folder) => ipcRenderer.invoke("read-asset-folder", folder),
    readImageDataUrl: (filePath) => ipcRenderer.invoke("read-image-data-url", filePath),
    writeIntoFolder: (folder, filename, content) => ipcRenderer.invoke("write-into-folder", folder, filename, content)
});
