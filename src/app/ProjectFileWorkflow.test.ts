/**
 * @module ProjectFileWorkflow.test
 * @description Pins project-open atomicity, editor reset, Save-As routing and cleanup.
 */

import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { createEmptyDocument } from "../core/document/Document";
import { serializeDocument } from "../core/document/Serializer";
import { createEditorState } from "../editor/EditorState";
import { ElectronAPI } from "./ElectronAPI";
import { applyOpenedProject, bindProjectFileWorkflow, ProjectFileTarget } from "./ProjectFileWorkflow";

function makeTarget(): ProjectFileTarget {
    return {
        dispatcher: new ActionDispatcher(createEmptyDocument()),
        editorState: createEditorState(),
        currentFilePath: { current: null },
        refresh: jest.fn(),
        saveTo: jest.fn(),
        reportError: jest.fn()
    };
}

test("a valid project is adopted and resets file-specific editor state", () => {
    const target = makeTarget();
    target.afterOpen = jest.fn();
    target.editorState.selectedNodeIds = ["stale-selection"];
    target.editorState.frame = 99;
    const opened = createEmptyDocument();
    opened.metadata.project_name = "Opened project";
    opened.timeline = { frames: 6, fps: 24 };
    opened.frame = 4;

    expect(applyOpenedProject({ filePath: "C:\\work\\opened.vde", content: serializeDocument(opened) }, target))
        .toEqual({ ok: true });
    expect(target.dispatcher.getDocument().metadata.project_name).toBe("Opened project");
    expect(target.currentFilePath.current).toBe("C:\\work\\opened.vde");
    expect(target.editorState.selectedNodeIds).toEqual([]);
    expect(target.editorState.frame).toBe(4);
    expect(target.refresh).toHaveBeenCalledTimes(1);
    expect(target.afterOpen).toHaveBeenCalledWith({
        filePath: "C:\\work\\opened.vde", content: serializeDocument(opened)
    });
});

test("a malformed project changes no live document, path or editor state", () => {
    const target = makeTarget();
    target.afterOpen = jest.fn();
    const before = target.dispatcher.getDocument();
    target.currentFilePath.current = "C:\\work\\safe.vde";
    target.editorState.selectedNodeIds = ["keep-me"];
    target.editorState.frame = 3;

    expect(applyOpenedProject({ filePath: "C:\\work\\broken.vde", content: "{" }, target).ok).toBe(false);
    expect(target.dispatcher.getDocument()).toBe(before);
    expect(target.currentFilePath.current).toBe("C:\\work\\safe.vde");
    expect(target.editorState.selectedNodeIds).toEqual(["keep-me"]);
    expect(target.editorState.frame).toBe(3);
    expect(target.refresh).not.toHaveBeenCalled();
    expect(target.reportError).toHaveBeenCalledTimes(1);
    expect(target.afterOpen).not.toHaveBeenCalled();
});

test("binding reports open results, routes Save As, and disposes both subscriptions", () => {
    const target = makeTarget();
    let open: ((payload: { filePath: string; content: string }) => void) | undefined;
    let save: ((filePath: string) => void) | undefined;
    const disposeOpen = jest.fn(), disposeSave = jest.fn();
    const api = {
        onFileOpened: (callback: typeof open) => { open = callback; return disposeOpen; },
        onRequestSave: (callback: typeof save) => { save = callback; return disposeSave; },
        reportProjectOpened: jest.fn()
    } as unknown as ElectronAPI;

    const dispose = bindProjectFileWorkflow(api, target);
    open?.({ filePath: "C:\\work\\ok.vde", content: serializeDocument(createEmptyDocument()) });
    expect(api.reportProjectOpened).toHaveBeenCalledWith("C:\\work\\ok.vde", true, undefined);
    save?.("C:\\work\\save-as.vde");
    expect(target.currentFilePath.current).toBe("C:\\work\\save-as.vde");
    expect(target.saveTo).toHaveBeenCalledWith("C:\\work\\save-as.vde");

    dispose();
    expect(disposeOpen).toHaveBeenCalledTimes(1);
    expect(disposeSave).toHaveBeenCalledTimes(1);
});
