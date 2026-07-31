/**
 * @module MoveTool
 * @description Click-drag to move selected nodes. Commits via dispatcher on mouseUp.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { Action } from "../../core/actions/Action";
import { geometryActionFor, isEditableNode } from "../../core/actions/nodeEdit";
import { TransactionAction } from "../../core/actions/TransactionAction";
import { EditorState } from "../EditorState";
import { Geometry } from "../../core/document/Node";
import { selectionRoots } from "../../core/document/SceneGraph";
import { isAbsolute, isLayoutContainer } from "../../core/geometry/LayoutEngine";
import { computeGeometry, selectionBounds } from "../../core/geometry/GeometryEngine";
import { expandInstances, isVirtualId } from "../../core/document/Components";
import { computeSnap, snapTargetsExcludingSubtrees, isTranslationOnlyChain, SNAP_THRESHOLD_PX } from "../../core/geometry/Snapping";
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
    // Alignment snapping snaps the moving selection's GROUP box (the union of every moving root's
    // world AABB) to other nodes' alignment lines. Enabled only when EVERY moving root is a
    // translation-only chain, so the single world snap delta maps 1:1 to each root's stored
    // geometry (translation composes) — one moving node is just a one-member group. `snapTargets`
    // = other nodes' world bounds, captured once at mouse-down (they don't move during the drag);
    // `snapEnabled` false disables it (a rotated/scaled chain in the set, or nothing to snap).
    private snapTargets: Rect[] | null = null;
    private snapEnabled = false;
    private snapSize: { width: number; height: number } = { width: 0, height: 0 };
    // The moving GROUP box's WORLD origin at mouse-down. Snapping runs in world space, so the
    // moving box is (worldOrigin + drag delta); the snap delta then applies 1:1 to every root's
    // stored geometry because all chains are translation-only.
    private snapWorldOrigin: { x: number; y: number } = { x: 0, y: 0 };

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
        // Resolve against the EXPANDED document so a selected instance COPY (a virtual node,
        // M6) is visible here: its start geometry is the master's plus any existing override,
        // and its ancestry — which `selectionRoots` walks — only exists once expanded. The
        // commit routes each id through `geometryActionFor`, which turns a virtual node's move
        // into a per-instance override rather than a (nonexistent) stored-geometry edit.
        const eff = expandInstances(doc);
        for (const id of selectionRoots(eff, this.editorState.selectedNodeIds)) {
            const node = eff.nodes.get(id);
            if (!node) continue;
            // A copy nested inside ANOTHER instance's expansion can't hold an override yet, so
            // it isn't draggable — better inert than an edit that silently fails to commit.
            if (isVirtualId(id) && !isEditableNode(doc, id)) continue;
            // A LAID-OUT child of an auto-layout container has a COMPUTED position; its
            // stored geometry.x/y is ignored, so dragging it would move nothing on screen.
            // Free-dragging is disabled for such children (reorder-by-drag is M4). An
            // `absolute` child is OUT of flow, positioned by its stored geometry, so it
            // stays draggable even under a container parent.
            const parent = node.parent ? eff.nodes.get(node.parent) : undefined;
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
     * Enable alignment snapping when EVERY moving root is a translation-only chain (node +
     * ancestors unrotated/unscaled), so a world snap delta is also each root's stored delta —
     * top-level OR nested under purely-translated parents, single node OR a whole group. The
     * moving box is the union of the roots' world AABBs; targets = every OTHER node's world AABB
     * (excluding all moving subtrees, which travel with the group), captured now.
     */
    private captureSnapTargets(doc: ReturnType<ActionDispatcher["getDocument"]>): void {
        this.snapTargets = null;
        this.snapEnabled = false;
        const ids = [...this.nodeStartPositions.keys()];
        if (ids.length === 0) return;
        // Snap only if ALL moving roots are translation-only (a world delta == each stored delta).
        // A single rotated/scaled chain in the set disables snapping for the whole gesture.
        if (!ids.every(id => doc.nodes.has(id) && isTranslationOnlyChain(doc, id))) return;

        const computed = computeGeometry(doc);
        const box = selectionBounds(computed, ids); // union of the moving roots' world AABBs
        if (!box) return;
        this.snapTargets = snapTargetsExcludingSubtrees(doc, computed, ids); // excludes every moving subtree
        this.snapEnabled = true;
        // Computed size (a hug container's rendered size can differ from its stored width/height).
        this.snapSize = { width: box.width, height: box.height };
        this.snapWorldOrigin = { x: box.x, y: box.y };
    }

    /**
     * Fold alignment snapping into a raw drag delta. Returns the (possibly adjusted) delta and
     * the guides to show. A no-op (returns the delta unchanged, no guides) unless this drag
     * enabled snapping (all moving roots translation-only) — see `captureSnapTargets`.
     */
    private snapDelta(dx: number, dy: number): { dx: number; dy: number; guides: EditorState["snapGuides"] } {
        if (!this.snapEnabled || !this.snapTargets) return { dx, dy, guides: null };
        // A pointer that hasn't moved is a CLICK, not a drag — never snap it, or a click on a
        // node that merely sits within threshold of an alignment would nudge it (and add an undo).
        if (dx === 0 && dy === 0) return { dx: 0, dy: 0, guides: null };
        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        // Snap in WORLD space (the group box's worldOrigin + drag), then apply the world snap
        // delta 1:1 to each root's stored delta — valid because every chain is translation-only.
        const moving = { x: this.snapWorldOrigin.x + dx, y: this.snapWorldOrigin.y + dy, width: this.snapSize.width, height: this.snapSize.height };
        const snap = computeSnap(moving, this.snapTargets, SNAP_THRESHOLD_PX / zoom);
        return { dx: dx + snap.dx, dy: dy + snap.dy, guides: snap.guides.length > 0 ? snap.guides : null };
    }

    /**
     * If a tracked node was deleted mid-drag, the group box captured at mouse-down is stale (it still
     * includes the deleted member's extent), so stop snapping rather than snap the survivors against a
     * phantom box. Called before every snap so a mid-drag deletion can't nudge the rest.
     */
    private invalidateSnapIfStale(doc: ReturnType<ActionDispatcher["getDocument"]>): void {
        if (this.snapEnabled && ![...this.nodeStartPositions.keys()].every(id => doc.nodes.has(id))) {
            this.snapEnabled = false;
            this.snapTargets = null;
        }
    }

    onMouseMove(e: MouseEvent): void {
        if (!this.isDragging) return;

        const doc = this.dispatcher.getDocument();
        this.invalidateSnapIfStale(doc); // a member deleted mid-drag → the captured group box is stale

        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        const rawDx = (e.clientX - this.startX) / zoom;
        const rawDy = (e.clientY - this.startY) / zoom;
        // Fold in alignment snapping (a no-op unless this drag enabled it) and get the guides.
        const { dx, dy, guides } = this.snapDelta(rawDx, rawDy);

        // Preview as PENDING PATCHES to stored (parent-relative) geometry. These
        // are composed by computeGeometry like any other geometry; the
        // document is never touched until commit.
        const overrides = new Map<string, Partial<Geometry>>();
        // Liveness is checked against the EXPANDED tree: an instance COPY is legitimately absent
        // from the stored map, and treating that as "deleted mid-drag" would silently abandon
        // the drag on its first frame. `computeGeometry` applies pending patches keyed by
        // virtual id just as it does for stored ones, so the preview needs nothing special.
        const eff = expandInstances(doc);
        for (const id of [...this.nodeStartPositions.keys()]) {
            const node = eff.nodes.get(id);
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

        const doc = this.dispatcher.getDocument();
        this.invalidateSnapIfStale(doc); // don't commit a snap computed from a stale group box

        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        const rawDx = (e.clientX - this.startX) / zoom;
        const rawDy = (e.clientY - this.startY) / zoom;
        // Commit the SNAPPED position, so the drop lands exactly where the preview showed it.
        const { dx, dy } = this.snapDelta(rawDx, rawDy);

        const actions: Action[] = [];
        if (dx !== 0 || dy !== 0) {
            for (const [id, start] of this.nodeStartPositions) {
                // Routed: a stored node gets a geometry edit, an instance COPY gets a per-instance
                // override. Null (the node vanished, or an unreachable nested copy) commits nothing.
                const action = geometryActionFor(doc, id, { x: start.x + dx, y: start.y + dy });
                if (action) actions.push(action);
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
        this.snapEnabled = false;
    }
}
