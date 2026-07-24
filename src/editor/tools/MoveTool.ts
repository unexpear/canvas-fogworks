/**
 * @module MoveTool
 * @description Click-drag to move selected nodes. Commits via dispatcher on mouseUp.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { UpdateNodeGeometryAction } from "../../core/actions/UpdateNodeGeometryAction";
import { TransactionAction } from "../../core/actions/TransactionAction";
import { EditorState } from "../EditorState";
import { Geometry } from "../../core/document/Node";
import { selectionRoots } from "../../core/document/SceneGraph";
import { isAbsolute, isLayoutContainer } from "../../core/geometry/LayoutEngine";
import { Tool } from "./ToolController";

export class MoveTool implements Tool {
    private dispatcher: ActionDispatcher;
    private editorState: EditorState;
    private refresh: () => void;
    private isDragging = false;
    private startX = 0;
    private startY = 0;
    private nodeStartPositions: Map<string, { x: number; y: number }> = new Map();

    constructor(dispatcher: ActionDispatcher, editorState: EditorState, refresh: () => void) {
        this.dispatcher = dispatcher;
        this.editorState = editorState;
        this.refresh = refresh;
    }

    onMouseDown(e: MouseEvent): void {
        const doc = this.dispatcher.getDocument();
        // Track only the roots of the selection. Stored geometry is parent-relative,
        // so moving a parent already moves its children through composition —
        // patching a selected child too would apply the drag delta twice.
        this.nodeStartPositions = new Map();
        for (const id of selectionRoots(doc, this.editorState.selectedNodeIds)) {
            const node = doc.nodes.get(id);
            if (!node) continue;
            // A LAID-OUT child of an auto-layout container has a COMPUTED position; its
            // stored geometry.x/y is ignored, so dragging it would move nothing on screen.
            // Free-dragging is disabled for such children (reorder-by-drag is M4). An
            // `absolute` child is OUT of flow, positioned by its stored geometry, so it
            // stays draggable even under a container parent.
            const parent = node.parent ? doc.nodes.get(node.parent) : undefined;
            if (isLayoutContainer(parent) && !isAbsolute(node)) continue;
            this.nodeStartPositions.set(id, { x: node.geometry.x, y: node.geometry.y });
        }
        if (this.nodeStartPositions.size === 0) return;

        this.isDragging = true;
        this.editorState.isDragging = true;
        this.startX = e.clientX;
        this.startY = e.clientY;
    }

    onMouseMove(e: MouseEvent): void {
        if (!this.isDragging) return;

        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        const dx = (e.clientX - this.startX) / zoom;
        const dy = (e.clientY - this.startY) / zoom;

        // Preview as PENDING PATCHES to stored (parent-relative) geometry. These
        // are composed by computeGeometry like any other geometry; the
        // document is never touched until commit.
        const doc = this.dispatcher.getDocument();
        const overrides = new Map<string, Partial<Geometry>>();
        for (const id of [...this.nodeStartPositions.keys()]) {
            const node = doc.nodes.get(id);
            const start = this.nodeStartPositions.get(id);
            if (node && start) {
                overrides.set(id, { x: start.x + dx, y: start.y + dy });
            } else {
                // Node was deleted mid-drag — drop it from the drag set.
                this.nodeStartPositions.delete(id);
            }
        }
        if (this.nodeStartPositions.size === 0) {
            this.endDrag(); // every tracked node vanished — abort cleanly
        } else {
            this.editorState.pendingGeometry = overrides;
        }
        this.refresh();
    }

    onMouseUp(e: MouseEvent): void {
        if (!this.isDragging) return;

        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        const dx = (e.clientX - this.startX) / zoom;
        const dy = (e.clientY - this.startY) / zoom;

        const doc = this.dispatcher.getDocument();
        const actions: UpdateNodeGeometryAction[] = [];
        if (dx !== 0 || dy !== 0) {
            for (const [id, start] of this.nodeStartPositions) {
                if (doc.nodes.has(id)) {
                    actions.push(new UpdateNodeGeometryAction(doc, id, { x: start.x + dx, y: start.y + dy }));
                }
            }
        }
        this.endDrag();
        if (actions.length === 1) {
            this.dispatcher.dispatchAction(actions[0]);
        } else if (actions.length > 1) {
            this.dispatcher.dispatchAction(new TransactionAction(doc, "move-nodes", actions));
        }
        this.refresh();
    }

    onKeyDown(e: KeyboardEvent): void {
        if (e.key === "Escape" && this.isDragging) {
            // Nothing was mutated — just drop the preview and cancel.
            this.endDrag();
            this.refresh();
        }
    }

    private endDrag(): void {
        this.isDragging = false;
        this.editorState.isDragging = false;
        this.editorState.pendingGeometry = null;
        this.nodeStartPositions = new Map();
    }
}
