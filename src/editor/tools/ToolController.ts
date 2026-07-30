/**
 * @module ToolController
 * @description Routes pointer events to the active tool. Handles pan, resize, and rotate modes.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { UpdateNodeGeometryAction } from "../../core/actions/UpdateNodeGeometryAction";
import { UpdateNodeTransformAction } from "../../core/actions/UpdateNodeTransformAction";
import { DeleteNodeAction } from "../../core/actions/DeleteNodeAction";
import { TransactionAction } from "../../core/actions/TransactionAction";
import { EditorState, panBy, screenToWorld } from "../EditorState";
import { computeGeometry, ComputedState } from "../../core/geometry/GeometryEngine";
import { handleAtPoint } from "../../core/geometry/SelectionHandles";
import { snapPoint, guidesForRect, snapTargetsExcludingSubtree, isTranslationOnlyChain, SNAP_THRESHOLD_PX } from "../../core/geometry/Snapping";
import { Rect } from "../../core/geometry/Matrix";
import { selectionRoots } from "../../core/document/SceneGraph";

export interface Tool {
    // `computed` is the geometry the controller already resolved for its handle hit-test;
    // a tool that needs geometry should reuse it rather than recompute (see SelectTool.pick).
    onMouseDown?(e: MouseEvent, canvasRect?: DOMRect, computed?: ComputedState): void;
    onMouseMove?(e: MouseEvent, canvasRect?: DOMRect): void;
    onMouseUp?(e: MouseEvent): void;
    onKeyDown?(e: KeyboardEvent): void;
    onKeyUp?(e: KeyboardEvent): void;
    onWheel?(e: WheelEvent, canvasRect?: DOMRect): void;
}

/** Middle mouse button (per the MouseEvent.button spec). */
const MIDDLE_BUTTON = 1;

export class ToolController {
    private activeTool: Tool | null = null;
    private resizeMode = false;
    private resizeNodeId: string | null = null;
    private resizeHandle: string | null = null;
    private resizeOrigin: { x: number; y: number; width: number; height: number } | null = null;
    private resizePreview: { x: number; y: number; width: number; height: number } | null = null;
    private resizeStartX = 0;
    private resizeStartY = 0;
    // Alignment snap targets for the resize, captured at mouse-down when the resizing node's chain
    // is translation-only (world snap delta == stored delta); null disables resize snapping.
    private resizeSnapTargets: Rect[] | null = null;
    // The node's WORLD-minus-STORED origin offset (constant for a translation chain), so the snap
    // (which runs in world) maps to the stored-geometry resize: {0,0} for a top-level node.
    private resizeSnapOffset: { x: number; y: number } = { x: 0, y: 0 };

    // Rotate mode — grabbing the rotate knob spins the node about its world-AABB centre.
    // Each move live-commits a coalesced UpdateNodeTransformAction, so a CONTINUOUS drag is one
    // undo step (subject to the history coalesce window, exactly like a slider drag).
    private rotateMode = false;
    private rotateNodeId: string | null = null;
    private rotateCenterX = 0;
    private rotateCenterY = 0;
    private rotateStartAngle = 0;   // pointer angle about the centre at grab
    private rotateInitial = 0;      // the node's rotation at grab

    // Viewport pan (space+drag or middle-mouse) — a mode that intercepts before the tool,
    // like resize. The gesture is screen-space, so it applies at any zoom and any tool.
    private spaceHeld = false;
    private panMode = false;
    private panLastX = 0;
    private panLastY = 0;

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
        // Pan takes precedence over everything (any tool, node, or handle): hold Space and drag,
        // or drag with the middle mouse button.
        if (this.spaceHeld || e.button === MIDDLE_BUTTON) {
            this.panMode = true;
            this.panLastX = e.clientX;
            this.panLastY = e.clientY;
            this.editorState.isDragging = true;
            e.preventDefault();
            return;
        }

        // Resize: hit-test the selection's corner handles in WORLD space — no DOM read, so it
        // works under any backend (the Canvas surface has no `data-resize-handle` element).
        // Geometry is resolved once here and handed to the active tool on fall-through, so a
        // plain click that misses the handles doesn't recompute it in `SelectTool.pick`.
        const sel = this.editorState.selectedNodeIds;
        let computed: ComputedState | undefined;
        if (sel.length > 0) {
            const vp = this.editorState.viewport;
            const w = screenToWorld(vp, canvasRect, e.clientX, e.clientY);
            computed = computeGeometry(this.dispatcher.getDocument(), this.editorState.pendingGeometry);
            const hit = handleAtPoint(computed, sel, w.x, w.y, vp.zoom);
            const c = hit ? computed.nodes.get(hit.nodeId) : undefined;
            const node = hit ? this.dispatcher.getDocument().nodes.get(hit.nodeId) : undefined;
            if (hit && c && node) {
                if (hit.handle === "rotate") {
                    // Spin about the world-AABB centre (= the default centre transform-origin).
                    this.rotateMode = true;
                    this.rotateNodeId = hit.nodeId;
                    this.rotateCenterX = c.bounds.x + c.bounds.width / 2;
                    this.rotateCenterY = c.bounds.y + c.bounds.height / 2;
                    this.rotateInitial = node.transform?.rotation ?? 0;
                    this.rotateStartAngle = Math.atan2(w.y - this.rotateCenterY, w.x - this.rotateCenterX);
                    this.editorState.isDragging = true;
                    e.preventDefault();
                    return;
                }
                this.resizeMode = true;
                this.resizeNodeId = hit.nodeId;
                this.resizeHandle = hit.handle;
                this.resizeStartX = e.clientX;
                this.resizeStartY = e.clientY;
                this.resizeOrigin = {
                    x: node.geometry.x,
                    y: node.geometry.y,
                    width: node.geometry.width,
                    height: node.geometry.height
                };
                // Enable snapping for a translation-only chain (world snap delta == stored delta),
                // capturing the constant world↔stored origin offset so the world snap maps to stored.
                if (isTranslationOnlyChain(this.dispatcher.getDocument(), hit.nodeId)) {
                    this.resizeSnapTargets = snapTargetsExcludingSubtree(this.dispatcher.getDocument(), computed, hit.nodeId);
                    this.resizeSnapOffset = { x: c.bounds.x - node.geometry.x, y: c.bounds.y - node.geometry.y };
                } else {
                    this.resizeSnapTargets = null;
                }
                e.preventDefault();
                return;
            }
        }

        this.activeTool?.onMouseDown?.(e, canvasRect, computed);
    }

    onMouseMove(e: MouseEvent, canvasRect: DOMRect): void {
        if (this.panMode) {
            panBy(this.editorState.viewport, e.clientX - this.panLastX, e.clientY - this.panLastY);
            this.panLastX = e.clientX;
            this.panLastY = e.clientY;
            this.refresh();
            return;
        }

        if (this.rotateMode && this.rotateNodeId) {
            const doc = this.dispatcher.getDocument();
            // The node vanished mid-drag (e.g. deleted by a keyboard shortcut): end the gesture
            // AND clear the drag-cursor flag, or it stays stuck on "grabbing".
            if (!doc.nodes.has(this.rotateNodeId)) { this.resetRotate(); this.editorState.isDragging = false; this.refresh(); return; }
            const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
            const angle = Math.atan2(w.y - this.rotateCenterY, w.x - this.rotateCenterX);
            const rotation = this.rotateInitial + (angle - this.rotateStartAngle);
            // Live-commit, coalesced → a continuous drag is one undo step; onChange repaints.
            this.dispatcher.dispatchAction(new UpdateNodeTransformAction(doc, this.rotateNodeId, { rotation }), { coalesce: true });
            return;
        }

        if (this.resizeMode && this.resizeNodeId && this.resizeHandle && this.resizeOrigin) {
            const zoom = Math.max(0.01, this.editorState.viewport.zoom);
            let dx = (e.clientX - this.resizeStartX) / zoom;
            let dy = (e.clientY - this.resizeStartY) / zoom;

            const doc = this.dispatcher.getDocument();
            if (!doc.nodes.has(this.resizeNodeId)) { this.resetResize(); this.refresh(); return; }

            // Alignment snapping: pull the DRAGGED corner (the fixed corner stays put) onto a
            // nearby target edge/centre, then recompute the box from the adjusted delta. The corner
            // and guides run in WORLD (stored + offset); the snap delta applies 1:1 to stored.
            const off = this.resizeSnapOffset;
            if (this.resizeSnapTargets) {
                const corner = this.movingCorner(this.resizeHandle, this.resizeOrigin);
                const snap = snapPoint(corner.x + off.x + dx, corner.y + off.y + dy, this.resizeSnapTargets, SNAP_THRESHOLD_PX / zoom);
                dx += snap.dx;
                dy += snap.dy;
            }

            // Preview via geometry override — no document mutation until commit.
            const g = this.computeResizedGeometry(this.resizeHandle, this.resizeOrigin, dx, dy);
            this.resizePreview = g;
            this.editorState.pendingGeometry = new Map([[this.resizeNodeId, g]]);
            if (this.resizeSnapTargets) {
                const worldBox = { x: g.x + off.x, y: g.y + off.y, width: g.width, height: g.height };
                const guides = guidesForRect(worldBox, this.resizeSnapTargets);
                this.editorState.snapGuides = guides.length > 0 ? guides : null;
            }

            this.refresh();
            return;
        }

        this.activeTool?.onMouseMove?.(e, canvasRect);
    }

    onMouseUp(e: MouseEvent): void {
        if (this.panMode) {
            this.panMode = false;
            this.editorState.isDragging = false;
            this.refresh();
            return;
        }

        if (this.rotateMode) {
            // The rotation was already live-committed (coalesced) during the drag; just end.
            this.resetRotate();
            this.editorState.isDragging = false;
            this.refresh();
            return;
        }

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

        // Hold Space to pan on the next drag; swallow it so the page doesn't scroll.
        if (e.key === " ") {
            this.spaceHeld = true;
            e.preventDefault();
            return;
        }

        if (e.key === "Escape") {
            if (this.resizeMode) {
                this.resetResize();
                this.refresh();
                return;
            }
            if (this.rotateMode && this.rotateNodeId) {
                // Rotate live-committed as it dragged (coalesced), so cancel = revert to the pre-gesture
                // angle, coalesced into the SAME run so the whole gesture nets to a no-op revision.
                const doc = this.dispatcher.getDocument();
                if (doc.nodes.has(this.rotateNodeId)) {
                    this.dispatcher.dispatchAction(new UpdateNodeTransformAction(doc, this.rotateNodeId, { rotation: this.rotateInitial }), { coalesce: true });
                }
                this.resetRotate();
                this.editorState.isDragging = false;
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

    onKeyUp(e: KeyboardEvent): void {
        // Releasing Space stops the NEXT drag from panning; a pan already in progress
        // keeps going until mouse-up (the usual behaviour).
        if (e.key === " ") this.spaceHeld = false;
        this.activeTool?.onKeyUp?.(e);
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

    /** The corner a resize handle DRAGS (the fixed corner is the opposite), in stored coords. */
    private movingCorner(handle: string, o: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
        const right = o.x + o.width, bottom = o.y + o.height;
        if (handle === "se") return { x: right, y: bottom };
        if (handle === "ne") return { x: right, y: o.y };
        if (handle === "sw") return { x: o.x, y: bottom };
        return { x: o.x, y: o.y }; // nw
    }

    private resetResize(): void {
        this.resizeMode = false;
        this.resizeNodeId = null;
        this.resizeHandle = null;
        this.resizeOrigin = null;
        this.resizePreview = null;
        this.resizeSnapTargets = null;
        this.editorState.pendingGeometry = null;
        this.editorState.snapGuides = null;
    }

    private resetRotate(): void {
        this.rotateMode = false;
        this.rotateNodeId = null;
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
