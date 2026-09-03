/**
 * @module ProjectFileWorkflow
 * @description Testable renderer seam for opening a project and adopting a Save/Save-As path.
 */

import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { deserializeDocument } from "../core/document/Serializer";
import { EditorState, frameOnLoad } from "../editor/EditorState";
import { ElectronAPI } from "./ElectronAPI";

export interface OpenProjectPayload { filePath: string; content: string }

export interface ProjectFileTarget {
    dispatcher: ActionDispatcher;
    editorState: EditorState;
    currentFilePath: { current: string | null };
    refresh: () => void;
    saveTo: (filePath: string) => void;
    reportError?: (message: string, error: unknown) => void;
    afterOpen?: (payload: OpenProjectPayload) => void;
}

export type OpenProjectResult = { ok: true } | { ok: false; error: Error };

/** Apply only after full deserialization, so a malformed file cannot disturb live work. */
export function applyOpenedProject(payload: OpenProjectPayload, target: ProjectFileTarget): OpenProjectResult {
    try {
        const opened = deserializeDocument(payload.content);
        target.dispatcher.loadDocument(opened);
        target.currentFilePath.current = payload.filePath;
        target.editorState.selectedNodeIds = [];
        target.editorState.frame = frameOnLoad(opened);
        target.refresh();
        target.afterOpen?.(payload);
        return { ok: true };
    } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        target.reportError?.(`Failed to open ${payload.filePath}`, error);
        return { ok: false, error };
    }
}

/** Bind project-file events and return one disposer for React effect cleanup. */
export function bindProjectFileWorkflow(api: ElectronAPI, target: ProjectFileTarget): () => void {
    const disposeOpen = api.onFileOpened(payload => {
        const result = applyOpenedProject(payload, target);
        api.reportProjectOpened(payload.filePath, result.ok,
            result.ok ? undefined : result.error.message);
    });
    const disposeSave = api.onRequestSave(filePath => {
        target.currentFilePath.current = filePath;
        target.saveTo(filePath);
    });
    return () => { disposeOpen(); disposeSave(); };
}
