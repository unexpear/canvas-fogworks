/**
 * @module ProjectReadHost
 * @description Read-only host contracts for project levels and transient 3D assets.
 * Project keys are host-owned: filesystem paths in the editor, opaque package keys in the player.
 * The host validates access, resolves relative references and enforces byte/decode limits.
 * These types provide no filesystem authority or security isolation by themselves.
 */

export interface Asset3DReader {
    read3DFile(folder: string, filePath: string): Promise<string>;
    read3DSidecar(folder: string, modelPath: string, relative: string): Promise<string>;
}

export interface ProjectAsset3DReader {
    readProject3DFile(projectFilePath: string, source: string): Promise<string>;
    readProject3DSidecar(projectFilePath: string, modelSource: string, relative: string): Promise<string>;
}

export interface Environment3DReader {
    readEnvironmentFile(folder: string, filePath: string): Promise<string>;
}

export interface ProjectEnvironment3DReader {
    readProjectEnvironmentFile(projectFilePath: string, source: string): Promise<string>;
}


export interface ProjectLevelReader {
    readLevelFile(currentFilePath: string, target: string): Promise<{ filePath: string; content: string }>;
}

/** 2D hosts may omit 3D readers; asset-bearing transitions require all three methods. */
export type RuntimeProjectReader = ProjectLevelReader
    & Partial<ProjectAsset3DReader & ProjectEnvironment3DReader>;

/** Loads an authorized entry directly, without inventing a current level or relative link. */
export interface ProjectEntryReader {
    readEntryFile(entryKey: string): Promise<{ filePath: string; content: string }>;
    /** Optional save restore: only a known packaged level, never a filesystem fallback. */
    readProgressLevel?(levelKey: string): Promise<{ filePath: string; content: string }>;
}

export type PlayerProjectReader = RuntimeProjectReader & ProjectEntryReader;
