/**
 * @module LevelTransitionWorkflow
 * @description Validates a host-loaded level completely before the live editor adopts it.
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
