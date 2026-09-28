/**
 * @module ElectronAPI
 * @description Renderer-side type contract for the narrow contextBridge API exposed by preload.
 */

export interface ElectronAPI {
    onMenuCommand: (cb: (command: string) => void) => () => void;
    onFileOpened: (cb: (payload: { filePath: string; content: string }) => void) => () => void;
    onRequestSave: (cb: (filePath: string) => void) => () => void;
    saveFile: (filePath: string, content: string, sourceProjectPath?: string | null) => Promise<boolean>;
    confirmDiscard: () => boolean;
    readRecovery: () => Promise<import("./RecoveryRestore").DesktopRecoveryRead>;
    writeRecovery: (snapshot: import("./ProjectSession").RecoverySnapshot | null) => Promise<void>;
    exportGame: (folder: string, content: string, sourceProjectPath: string | null) => Promise<string>;
    exportGame3D: (folder: string, content: string, sourceProjectPath: string | null) => Promise<string>;
    readLevelFile: (currentFilePath: string, target: string) => Promise<{ filePath: string; content: string }>;
    requestSaveAs: () => Promise<boolean>;
    pickFolder: () => Promise<string | null>;
    readSourceFolder: (folder: string) => Promise<{ path: string; content: string }[]>;
    readAssetFolder: (folder: string) => Promise<{ path: string; name: string; relative: string }[]>;
    readImageDataUrl: (folder: string, filePath: string) => Promise<string>;
    writeIntoFolder: (folder: string, filename: string, content: string) => Promise<string>;
    writePngIntoFolder: (folder: string, filename: string, dataUrl: string) => Promise<string>;
    readFontFolder: (folder: string) => Promise<{ path: string; name: string; relative: string }[]>;
    readFontBytes: (filePath: string) => Promise<string>;
    readPaletteFolder: (folder: string) => Promise<{ path: string; name: string; relative: string }[]>;
    readPaletteFile: (folder: string, filePath: string) => Promise<string>;
    readTiledFolder: (folder: string) => Promise<{ path: string; name: string; relative: string }[]>;
    readTiledMap: (folder: string, mapPath: string) => Promise<string>;
    readTiledTileset: (folder: string, mapPath: string, relative: string) => Promise<string>;
    readTiledImage: (folder: string, mapPath: string, relative: string) => Promise<string>;
    readUnityFolder: (folder: string) => Promise<{ path: string; name: string; bytes: number; relative: string }[]>;
    readUnityPackage: (folder: string, filePath: string) => Promise<string>;
    readAsepriteFolder: (folder: string) => Promise<{ path: string; name: string; bytes: number; relative: string }[]>;
    readAsepriteBytes: (folder: string, filePath: string) => Promise<string>;
    read3DFolder: (folder: string) => Promise<{ path: string; name: string; bytes: number; relative: string }[]>;
    readEnvironmentFolder: (folder: string) => Promise<{ path: string; name: string; bytes: number; relative: string }[]>;
    readEnvironmentFile: (folder: string, filePath: string) => Promise<string>;
    read3DFile: (folder: string, filePath: string) => Promise<string>;
    read3DSidecar: (folder: string, modelPath: string, relative: string) => Promise<string>;
    project3DSource: (projectFilePath: string, modelPath: string) => Promise<string>;
    projectEnvironmentSource: (projectFilePath: string, filePath: string) => Promise<string>;
    readProjectEnvironmentFile: (projectFilePath: string, source: string) => Promise<string>;
    readProject3DFile: (projectFilePath: string, source: string) => Promise<string>;
    readProject3DSidecar: (projectFilePath: string, modelSource: string, relative: string) => Promise<string>;
    inflateSync: (base64: string) => { ok: boolean; data?: string; error?: string };
    gunzipSync: (base64: string) => { ok: boolean; data?: string; error?: string };
    reportProjectOpened: (filePath: string, ok: boolean, error?: string) => void;
}

declare global {
    interface Window {
        electronAPI?: ElectronAPI;
    }
}
