/**
 * @module LevelTransitionWorkflow
 * @description Validates host-loaded levels and keeps playback documents separate from the editor savepoint and undo history.
 */

import { ProjectDocument } from "../core/document/Document";
import { deserializeDocument } from "../core/document/Serializer";
import { ElectronAPI } from "./ElectronAPI";

export async function loadLevelTransition(
    api: Pick<ElectronAPI, "readLevelFile">, currentFilePath: string | null, target: string
): Promise<{ filePath: string; document: ProjectDocument }> {
    if (!currentFilePath) throw new Error("Save this project before following a level transition.");
    const loaded = await api.readLevelFile(currentFilePath, target);
    return { filePath: loaded.filePath, document: deserializeDocument(loaded.content) };
}

/** A stopped/restarted run cannot be replaced by a late filesystem response. */
export class RuntimeProject {
    document: ProjectDocument | null = null;
    filePath: string | null = null;
    private generation = 0;
    reset(): void { this.generation++; this.document = null; this.filePath = null; }
    async transition(api: Pick<ElectronAPI, "readLevelFile">, authoringPath: string | null, target: string): Promise<boolean> {
        const generation = this.generation;
        try {
            const loaded = await loadLevelTransition(api, this.filePath ?? authoringPath, target);
            if (generation !== this.generation) return false;
            this.document = loaded.document; this.filePath = loaded.filePath;
            return true;
        } catch (error) {
            if (generation !== this.generation) return false;
            throw error;
        }
    }
}
