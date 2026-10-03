/** @module progressPreload @description Exposes the current game's progress slot and declared package stream reads; no paths, project files or arbitrary IPC. */
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("playerProgress", Object.freeze({
    read: () => ipcRenderer.invoke("fogworks-progress-read"),
    write: content => ipcRenderer.invoke("fogworks-progress-write", content)
}));
contextBridge.exposeInMainWorld("playerStreams", Object.freeze({
    read: id => ipcRenderer.invoke("fogworks-stream-read", id)
}));
