/**
 * @module ToolController
 * @description Routes pointer events to the active tool. Handles resize mode.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { UpdateNodeGeometryAction } from "../../core/actions/UpdateNodeGeometryAction";
import { DeleteNodeAction } from "../../core/actions/DeleteNodeAction";
import { TransactionAction } from "../../core/actions/TransactionAction";
import { EditorState } from "../EditorState";
import { selectionRoots } from "../../core/document/SceneGraph";

export interface Tool {
    onMouseDown?(e: MouseEvent, canvasRect?: DOMRect): void;
    onMouseMove?(e: MouseEvent, canvasRect?: DOMRect): void;
    onMouseUp?(e: MouseEvent): void;
    onKeyDown?(e: KeyboardEvent): void;
    onWheel?(e: WheelEvent, canvasRect?: DOMRect): void;
}

export class ToolController {
    private activeTool: Tool | null = null;
    private resizeMode = false;
    private resizeNodeId: string | null = null;
    private resizeHandle: string | null = null;
    private resizeOrigin: { x: number; y: number; width: number; height: number } | null = null;
    private resizePreview: { x: number; y: number; width: number; height: number } | null = null;
    private resizeStartX = 0;
    private resizeStartY = 0;

    private dispatcher: ActionDispatcher;
    private editorState: EditorState;
    private refresh: () => void;

    constructor(dispatcher: ActionDispatcher, editorState: EditorState, refresh: () => void) {
        this.dispatcher = dispatcher;
        this.editorState = editorState;
        this.refresh = refresh;
    }

    setTool(tool: Tool): void {
        this.activeTool = tool;
    }

    onMouseDown(e: MouseEvent, canvasRect: DOMRect): void {
        const target = e.target as HTMLElement;
        const nodeId = target.getAttribute("data-node-id");
        const handle = target.getAttribute("data-resize-handle");

        if (nodeId && handle) {
            const doc = this.dispatcher.getDocument();
            const node = doc.nodes.get(nodeId);
            if (!node) { this.resetResize(); return; }

            this.resizeMode = true;
            this.resizeNodeId = nodeId;
            this.resizeHandle = handle;
            this.resizeStartX = e.clientX;
            this.resizeStartY = e.clientY;
            this.resizeOrigin = {
                x: node.geometry.x,
                y: node.geometry.y,
                width: node.geometry.width,
                height: node.geometry.height
            };
            e.preventDefault();
            return;
        }

        this.activeTool?.onMouseDown?.(e, canvasRect);
    }

    onMouseMove(e: MouseEvent, canvasRect: DOMRect): void {
        if (this.resizeMode && this.resizeNodeId && this.resizeHandle && this.resizeOrigin) {
            const zoom = Math.max(0.01, this.editorState.viewport.zoom);
            const dx = (e.clientX - this.resizeStartX) / zoom;
            const dy = (e.clientY - this.resizeStartY) / zoom;

            const doc = this.dispatcher.getDocument();
            if (!doc.nodes.has(this.resizeNodeId)) { this.resetResize(); this.refresh(); return; }

            // Preview via geometry override — no document mutation until commit.
            const g = this.computeResizedGeometry(this.resizeHandle, this.resizeOrigin, dx, dy);
            this.resizePreview = g;
            this.editorState.pendingGeometry = new Map([[this.resizeNodeId, g]]);

            this.refresh();
            return;
        }

        this.activeTool?.onMouseMove?.(e, canvasRect);
    }

    onMouseUp(e: MouseEvent): void {
        if (this.resizeMode && this.resizeNodeId) {
            const doc = this.dispatcher.getDocument();
            if (this.resizePreview && doc.nodes.has(this.resizeNodeId)) {
                this.dispatcher.dispatchAction(new UpdateNodeGeometryAction(
                    doc,
                    this.resizeNodeId,
                    this.resizePreview
                ));
            }
            this.resetResize();
            this.refresh();
            return;
        }

        this.activeTool?.onMouseUp?.(e);
    }

    onKeyDown(e: KeyboardEvent): void {
        const target = e.target as HTMLElement;
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;

        if (e.key === "Escape") {
            if (this.resizeMode) {
                this.resetResize();
                this.refresh();
                return;
            }
        }

        if (e.key === "Delete" || e.key === "Backspace") {
            this.deleteSelectedNodes();
            return;
        }

        this.activeTool?.onKeyDown?.(e);
    }

    /**
     * New geometry for a corner drag, computed from the fixed opposite corner
     * and the moving corner so the rect flips (rather than pinning at 1px) when
     * the pointer crosses an edge.
     */
    private computeResizedGeometry(
        handle: string,
        o: { x: number; y: number; width: number; height: number },
        dx: number,
        dy: number
    ): { x: number; y: number; width: number; height: number } {
        let fixedX: number, fixedY: number, movingX: number, movingY: number;
        if (handle === "se") {
            fixedX = o.x; fixedY = o.y;
            movingX = o.x + o.width + dx; movingY = o.y + o.height + dy;
        } else if (handle === "nw") {
            fixedX = o.x + o.width; fixedY = o.y + o.height;
            movingX = o.x + dx; movingY = o.y + dy;
        } else if (handle === "ne") {
            fixedX = o.x; fixedY = o.y + o.height;
            movingX = o.x + o.width + dx; movingY = o.y + dy;
        } else { // sw
            fixedX = o.x + o.width; fixedY = o.y;
            movingX = o.x + dx; movingY = o.y + o.height + dy;
        }
        return {
            x: Math.min(fixedX, movingX),
            y: Math.min(fixedY, movingY),
            width: Math.max(1, Math.abs(movingX - fixedX)),
            height: Math.max(1, Math.abs(movingY - fixedY))
        };
    }

    private resetResize(): void {
        this.resizeMode = false;
        this.resizeNodeId = null;
        this.resizeHandle = null;
        this.resizeOrigin = null;
        this.resizePreview = null;
        this.editorState.pendingGeometry = null;
    }

    private deleteSelectedNodes(): void {
        const ids = [...this.editorState.selectedNodeIds];
        if (ids.length === 0) return;
        const doc = this.dispatcher.getDocument();

        // Delete only the roots of the selection: a selected node whose ancestor
        // is also selected would be cascade-deleted by that ancestor, and asking
        // to delete it again would fail the atomic transaction.
        const roots = selectionRoots(doc, ids);

        this.editorState.selectedNodeIds = [];
        if (roots.length === 1) {
            this.dispatcher.dispatchAction(new DeleteNodeAction(doc, roots[0]));
        } else if (roots.length > 1) {
            // One transaction → one undo restores the whole deleted selection.
            this.dispatcher.dispatchAction(new TransactionAction(
                doc,
                "delete-nodes",
                roots.map(id => new DeleteNodeAction(doc, id))
            ));
        }
        this.refresh();
    }

    onWheel(e: WheelEvent, canvasRect: DOMRect): void {
        this.activeTool?.onWheel?.(e, canvasRect);
    }
}
