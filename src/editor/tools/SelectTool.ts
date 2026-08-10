/**
 * @module SelectTool
 * @description Click to select a node; drag empty space to box-select (marquee).
 * Click empty space (no drag) to deselect. Shift adds to the selection. Escape cancels
 * an in-flight marquee.
 *
 * Hit-testing and marquee both run against computed world geometry, NOT against
 * per-node DOM elements: the Milestone 3 Canvas/WebGL renderer has no `data-node-id`
 * to read, so selection must not depend on the SVG backend.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { computeGeometry, hitTest, nodesInRect, ComputedState } from "../../core/geometry/GeometryEngine";
import { EditorState, screenToWorld } from "../EditorState";
import { Tool } from "./ToolController";

/** Pick halo in SCREEN pixels — converted to world (÷ zoom) so thin/hairline targets stay grabbable. */
export const PICK_RADIUS_PX = 4;
/**
 * A press→release whose pointer moved less than this (SCREEN px, per axis) is a CLICK, not a
 * marquee. It is load-bearing for ROTATED/sheared nodes: `pick` rejects against the EXACT
 * rotated shape, but `nodesInRect` overlaps the world AABB, which bulges past a rotated shape.
 * A click in that AABB-corner margin gives `pick === null` (so a marquee begins), yet a 1px
 * hardware wobble would make the resulting ~0-size box overlap the AABB and SELECT the node —
 * contradicting "click deselects". The threshold collapses that wobble back to a click. (For
 * axis-aligned nodes AABB == shape, so the halo alone would suffice; rotation is why it stays.)
 */
const MARQUEE_THRESHOLD_PX = 3;

export class SelectTool implements Tool {
    private dispatcher: ActionDispatcher;
    private editorState: EditorState;
    private refresh: () => void;

    // Box-select marquee (a drag begun on empty space). Selection is left untouched until
    // mouse-up, so a plain click deselects and a shift-click keeps the selection.
    private marqueeActive = false;
    private marqueeStartWorld = { x: 0, y: 0 };
    private marqueeStartScreenX = 0;
    private marqueeStartScreenY = 0;

    constructor(dispatcher: ActionDispatcher, editorState: EditorState, refresh: () => void) {
        this.dispatcher = dispatcher;
        this.editorState = editorState;
        this.refresh = refresh;
    }

    onMouseDown(e: MouseEvent, canvasRect?: DOMRect, computed?: ComputedState): void {
        // A new gesture supersedes any marquee stranded by a missed mouse-up (release off-window,
        // alt-tab) — clear it first so stale state can never hijack this gesture's selection.
        this.resetMarquee();

        const nodeId = this.pick(e, canvasRect, computed);
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
            this.refresh();
            return;
        }

        // Empty space: begin a marquee, finalized on mouse-up.
        const w = this.screenToWorld(e, canvasRect);
        if (!w) {
            // No canvas frame → can't marquee; fall back to the plain deselect.
            this.editorState.selectedNodeIds = [];
            this.refresh();
            return;
        }
        this.marqueeActive = true;
        this.marqueeStartWorld = w;
        this.marqueeStartScreenX = e.clientX;
        this.marqueeStartScreenY = e.clientY;
    }

    onMouseMove(e: MouseEvent, canvasRect?: DOMRect): void {
        if (!this.marqueeActive) return;
        // No button held → a mouse-up was missed (released off-window): abandon the drag rather
        // than tracking a phantom box and later committing a stale selection.
        if ((e.buttons & 1) === 0) {
            this.resetMarquee();
            this.refresh();
            return;
        }
        const w = this.screenToWorld(e, canvasRect);
        if (!w) return;
        this.editorState.marqueeRect = {
            x: Math.min(this.marqueeStartWorld.x, w.x),
            y: Math.min(this.marqueeStartWorld.y, w.y),
            width: Math.abs(w.x - this.marqueeStartWorld.x),
            height: Math.abs(w.y - this.marqueeStartWorld.y)
        };
        this.refresh();
    }

    onMouseUp(e: MouseEvent): void {
        if (!this.marqueeActive) return;
        this.marqueeActive = false;
        const rect = this.editorState.marqueeRect;
        this.editorState.marqueeRect = null;
        const additive = e.shiftKey;

        // Moved far enough to be a deliberate box (see MARQUEE_THRESHOLD_PX) → select; else a click.
        const dragged =
            Math.abs(e.clientX - this.marqueeStartScreenX) > MARQUEE_THRESHOLD_PX ||
            Math.abs(e.clientY - this.marqueeStartScreenY) > MARQUEE_THRESHOLD_PX;

        if (dragged && rect) {
            const computed = computeGeometry(this.dispatcher.getDocument(), this.editorState.pendingGeometry);
            const hits = nodesInRect(computed, rect);
            if (additive) {
                const set = new Set(this.editorState.selectedNodeIds);
                hits.forEach(id => set.add(id));
                this.editorState.selectedNodeIds = [...set];
            } else {
                this.editorState.selectedNodeIds = hits;
            }
        } else if (!additive) {
            // A plain click on empty space deselects; a shift-click keeps the selection.
            this.editorState.selectedNodeIds = [];
        }
        this.refresh();
    }

    onKeyDown(e: KeyboardEvent): void {
        // Escape cancels an in-flight marquee (parity with move/resize/draw); selection is left as-is.
        if (e.key === "Escape" && this.marqueeActive) {
            this.resetMarquee();
            e.preventDefault();               // claimed: Escape cancels rather than deselecting
            this.refresh();
        }
    }

    /** Drop any in-flight marquee (both the gesture flag and the drawn overlay rect). */
    private resetMarquee(): void {
        this.marqueeActive = false;
        this.editorState.marqueeRect = null;
    }

    /** Topmost node under the pointer, resolved in world space. Reuses `computed` when the
     * controller already resolved it (a resize hit-test that missed), else computes it.
     * Holding ALT deep-picks: it selects a component instance's materialized COPY rather than
     * the instance, so the copy can be edited through a per-instance override (M6 slice 2). */
    private pick(e: MouseEvent, canvasRect?: DOMRect, computed?: ComputedState): string | null {
        const w = this.screenToWorld(e, canvasRect);
        if (!w) return null;
        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        const cs = computed ?? computeGeometry(
            this.dispatcher.getDocument(),
            this.editorState.pendingGeometry
        );
        return hitTest(cs, w.x, w.y, PICK_RADIUS_PX / zoom, e.altKey === true);
    }

    /** Canvas-relative screen pixels → world coordinates (null when there's no canvas frame). */
    private screenToWorld(e: MouseEvent, canvasRect?: DOMRect): { x: number; y: number } | null {
        if (!canvasRect) return null;
        return screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
    }
}
