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
import { computeGeometry } from "../../core/geometry/GeometryEngine";
import { computeSnap, snapTargetsExcludingSubtree, SNAP_THRESHOLD_PX } from "../../core/geometry/Snapping";
import { Rect } from "../../core/geometry/Matrix";
import { Tool } from "./ToolController";

export class MoveTool implements Tool {
    private dispatcher: ActionDispatcher;
    private editorState: EditorState;
    private refresh: () => void;
    private isDragging = false;
    private startX = 0;
    private startY = 0;
    private nodeStartPositions: Map<string, { x: number; y: number }> = new Map();
    // Alignment snapping applies to a SINGLE top-level, unrotated node (stored == world, so a
    // world snap delta is also the stored delta). `snapTargets` = other nodes' world bounds,
    // captured once at mouse-down (they don't move during the drag); null disables snapping.
    private snapTargets: Rect[] | null = null;
    private snapNodeId: string | null = null;
    private snapSize: { width: number; height: number } = { width: 0, height: 0 };

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
        this.captureSnapTargets(doc);
    }

    /**
     * Enable alignment snapping only for the clean case: a SINGLE moving node that is top-level
     * (parent === null) and unrotated/unscaled (no transform), so its world bounds equal its
     * stored box and a world snap delta is also its stored delta. Targets = every OTHER node's
     * world AABB (excluding the moving node's own subtree, which travels with it), captured now.
     */
    private captureSnapTargets(doc: ReturnType<ActionDispatcher["getDocument"]>): void {
        this.snapTargets = null;
        this.snapNodeId = null;
        if (this.nodeStartPositions.size !== 1) return;
        const id = [...this.nodeStartPositions.keys()][0];
        const node = doc.nodes.get(id);
        if (!node || node.parent !== null || node.transform) return;

        const computed = computeGeometry(doc);
        const movingBounds = computed.nodes.get(id)?.bounds;
        if (!movingBounds) return;
        this.snapTargets = snapTargetsExcludingSubtree(doc, computed, id); // excludes this node's own subtree
        this.snapNodeId = id;
        // Computed size (a hug container's rendered size can differ from its stored width/height).
        this.snapSize = { width: movingBounds.width, height: movingBounds.height };
    }

    /**
     * Fold alignment snapping into a raw drag delta. Returns the (possibly adjusted) delta and
     * the guides to show. A no-op (returns the delta unchanged, no guides) unless this drag
     * enabled snapping (single top-level unrotated node) — see `captureSnapTargets`.
     */
    private snapDelta(dx: number, dy: number): { dx: number; dy: number; guides: EditorState["snapGuides"] } {
        if (!this.snapTargets || this.snapNodeId === null) return { dx, dy, guides: null };
        // A pointer that hasn't moved is a CLICK, not a drag — never snap it, or a click on a
        // node that merely sits within threshold of an alignment would nudge it (and add an undo).
        if (dx === 0 && dy === 0) return { dx: 0, dy: 0, guides: null };
        const start = this.nodeStartPositions.get(this.snapNodeId);
        if (!start) return { dx, dy, guides: null };
        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        // start.x/y == the node's world bounds origin (top-level, unrotated), so a world snap
        // delta is also its stored delta.
        const moving = { x: start.x + dx, y: start.y + dy, width: this.snapSize.width, height: this.snapSize.height };
        const snap = computeSnap(moving, this.snapTargets, SNAP_THRESHOLD_PX / zoom);
        return { dx: dx + snap.dx, dy: dy + snap.dy, guides: snap.guides.length > 0 ? snap.guides : null };
    }

    onMouseMove(e: MouseEvent): void {
        if (!this.isDragging) return;

        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        const rawDx = (e.clientX - this.startX) / zoom;
        const rawDy = (e.clientY - this.startY) / zoom;
        // Fold in alignment snapping (a no-op unless this drag enabled it) and get the guides.
        const { dx, dy, guides } = this.snapDelta(rawDx, rawDy);

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
            this.editorState.snapGuides = guides;
        }
        this.refresh();
    }

    onMouseUp(e: MouseEvent): void {
        if (!this.isDragging) return;

        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        const rawDx = (e.clientX - this.startX) / zoom;
        const rawDy = (e.clientY - this.startY) / zoom;
        // Commit the SNAPPED position, so the drop lands exactly where the preview showed it.
        const { dx, dy } = this.snapDelta(rawDx, rawDy);

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
        this.editorState.snapGuides = null;
        this.nodeStartPositions = new Map();
        this.snapTargets = null;
        this.snapNodeId = null;
    }
}
