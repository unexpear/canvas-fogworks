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
    // Fixed-shape acknowledgement used only when main explicitly runs the project-open smoke.
    reportProjectOpened: (filePath, ok, error) =>
        ipcRenderer.send("project-open-result", { filePath, ok, error }),
    saveFile: (filePath, content, sourceProjectPath) => ipcRenderer.invoke("save-file", filePath, content, sourceProjectPath),
    confirmDiscard: () => ipcRenderer.sendSync("confirm-discard"),
    readRecovery: () => ipcRenderer.invoke("read-recovery"),
    writeRecovery: (snapshot) => ipcRenderer.invoke("write-recovery", snapshot),
    exportGame: (folder, content, sourceProjectPath) => ipcRenderer.invoke("export-game", folder, content, sourceProjectPath),
    exportGame3D: (folder, content, sourceProjectPath) => ipcRenderer.invoke("export-game-3d", folder, content, sourceProjectPath),
    readLevelFile: (currentFilePath, target) => ipcRenderer.invoke("read-level-file", currentFilePath, target),
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
    readImageDataUrl: (folder, filePath) => ipcRenderer.invoke("read-image-data-url", folder, filePath),
    readPaletteFolder: (folder) => ipcRenderer.invoke("read-palette-folder", folder),
    readPaletteFile: (folder, filePath) => ipcRenderer.invoke("read-palette-file", folder, filePath),
    readTiledFolder: (folder) => ipcRenderer.invoke("read-tiled-folder", folder),
    readTiledMap: (folder, mapPath) => ipcRenderer.invoke("read-tiled-map", folder, mapPath),
    readUnityFolder: (folder) => ipcRenderer.invoke("read-unity-folder", folder),
    readUnityPackage: (folder, filePath) => ipcRenderer.invoke("read-unity-package", folder, filePath),
    readAsepriteFolder: (folder) => ipcRenderer.invoke("read-aseprite-folder", folder),
    readAsepriteBytes: (folder, filePath) => ipcRenderer.invoke("read-aseprite-bytes", folder, filePath),
    read3DFolder: (folder) => ipcRenderer.invoke("read-3d-folder", folder),
    readEnvironmentFolder: (folder) => ipcRenderer.invoke("read-environment-folder", folder),
    readEnvironmentFile: (folder, filePath) => ipcRenderer.invoke("read-environment-file", folder, filePath),
    read3DFile: (folder, filePath) => ipcRenderer.invoke("read-3d-file", folder, filePath),
    read3DSidecar: (folder, modelPath, relative) =>
        ipcRenderer.invoke("read-3d-sidecar", folder, modelPath, relative),
    project3DSource: (projectFilePath, modelPath) =>
        ipcRenderer.invoke("project-3d-source", projectFilePath, modelPath),
    projectEnvironmentSource: (projectFilePath, filePath) =>
        ipcRenderer.invoke("project-environment-source", projectFilePath, filePath),
    readProjectEnvironmentFile: (projectFilePath, source) =>
        ipcRenderer.invoke("read-project-environment-file", projectFilePath, source),
    readProject3DFile: (projectFilePath, source) =>
        ipcRenderer.invoke("read-project-3d-file", projectFilePath, source),
    readProject3DSidecar: (projectFilePath, modelSource, relative) =>
        ipcRenderer.invoke("read-project-3d-sidecar", projectFilePath, modelSource, relative),
    readTiledTileset: (folder, mapPath, relative) =>
        ipcRenderer.invoke("read-tiled-tileset", folder, mapPath, relative),
    readTiledImage: (folder, mapPath, relative) =>
        ipcRenderer.invoke("read-tiled-image", folder, mapPath, relative),
    // The ONE synchronous channel. Both `parseTiledMap` and `parseAseprite` call their `inflate`
    // during the parse, which is what keeps them pure; an async bridge cannot satisfy that.
    inflateSync: (base64) => ipcRenderer.sendSync("inflate-sync", base64),
    // The gzip sibling — a `.unitypackage` carries a header `inflateSync` will not accept.
    gunzipSync: (base64) => ipcRenderer.sendSync("gunzip-sync", base64),
    writeIntoFolder: (folder, filename, content) => ipcRenderer.invoke("write-into-folder", folder, filename, content)
});
