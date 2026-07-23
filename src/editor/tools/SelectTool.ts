/**
 * @module SelectTool
 * @description Click to select nodes. Click empty space to deselect.
 *
 * Hit-testing runs against computed world geometry, NOT against per-node DOM
 * elements: the Milestone 3 Canvas/WebGL renderer has no `data-node-id` to read,
 * so selection must not depend on the SVG backend.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { computeWorldGeometry, hitTest } from "../../core/geometry/ComputedGeometry";
import { EditorState } from "../EditorState";
import { Tool } from "./ToolController";

export class SelectTool implements Tool {
    private dispatcher: ActionDispatcher;
    private editorState: EditorState;
    private refresh: () => void;

    constructor(dispatcher: ActionDispatcher, editorState: EditorState, refresh: () => void) {
        this.dispatcher = dispatcher;
        this.editorState = editorState;
        this.refresh = refresh;
    }

    onMouseDown(e: MouseEvent, canvasRect?: DOMRect): void {
        const nodeId = this.pick(e, canvasRect);

        if (nodeId) {
            if (e.shiftKey) {
                const idx = this.editorState.selectedNodeIds.indexOf(nodeId);
                if (idx >= 0) {
                    this.editorState.selectedNodeIds = this.editorState.selectedNodeIds.filter(id => id !== nodeId);
                } else {
                    this.editorState.selectedNodeIds = [...this.editorState.selectedNodeIds, nodeId];
                }
            } else {
                this.editorState.selectedNodeIds = [nodeId];
            }
        } else {
            this.editorState.selectedNodeIds = [];
        }
        this.refresh();
    }

    /** Topmost node under the pointer, resolved in world space. */
    private pick(e: MouseEvent, canvasRect?: DOMRect): string | null {
        if (!canvasRect) return null;
        const vp = this.editorState.viewport;
        const zoom = Math.max(0.01, vp.zoom);
        const worldX = (e.clientX - canvasRect.left + vp.x) / zoom;
        const worldY = (e.clientY - canvasRect.top + vp.y) / zoom;

        const computed = computeWorldGeometry(
            this.dispatcher.getDocument(),
            this.editorState.pendingGeometry
        );
        return hitTest(computed, worldX, worldY);
    }
}
