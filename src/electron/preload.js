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
    // ONE channel for every menu entry, carrying a command string. A channel per item meant three
    // files had to change to add one line to a menu; this way the menu grows on its own, and a
    // renderer that does not know a command simply ignores it.
    onMenuCommand: (callback) => subscribe("menu-command", callback, (command) => command),
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
    readFontFolder: (folder) => ipcRenderer.invoke("read-font-folder", folder),
    readFontBytes: (filePath) => ipcRenderer.invoke("read-font-bytes", filePath),
    readImageDataUrl: (filePath) => ipcRenderer.invoke("read-image-data-url", filePath),
    readPaletteFolder: (folder) => ipcRenderer.invoke("read-palette-folder", folder),
    readPaletteFile: (folder, filePath) => ipcRenderer.invoke("read-palette-file", folder, filePath),
    readTiledFolder: (folder) => ipcRenderer.invoke("read-tiled-folder", folder),
    readTiledMap: (folder, mapPath) => ipcRenderer.invoke("read-tiled-map", folder, mapPath),
    readTiledTileset: (folder, mapPath, relative) =>
        ipcRenderer.invoke("read-tiled-tileset", folder, mapPath, relative),
    readTiledImage: (folder, mapPath, relative) =>
        ipcRenderer.invoke("read-tiled-image", folder, mapPath, relative),
    // The ONE synchronous channel. Both `parseTiledMap` and `parseAseprite` call their `inflate`
    // during the parse, which is what keeps them pure; an async bridge cannot satisfy that.
    inflateSync: (base64) => ipcRenderer.sendSync("inflate-sync", base64),
    writeIntoFolder: (folder, filename, content) => ipcRenderer.invoke("write-into-folder", folder, filename, content)
});
