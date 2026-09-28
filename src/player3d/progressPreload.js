/** @module progressPreload @description Exposes only the current game's single progress slot; no paths, project files or arbitrary IPC. */
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("playerProgress", Object.freeze({
    read: () => ipcRenderer.invoke("fogworks-progress-read"),
    write: content => ipcRenderer.invoke("fogworks-progress-write", content)
}));
