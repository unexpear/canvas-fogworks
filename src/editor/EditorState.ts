/**
 * @module EditorState
 * @description Runtime editor context. Never serialized to the document.
 */

import { Easing } from "../core/document/Prototype";
import { Geometry, PathCommand } from "../core/document/Node";
import { SnapGuide } from "../core/geometry/Snapping";

export interface EditorState {
    selectedNodeIds: string[];
    hoveredNodeId: string | null;
    /** CSS cursor for the handle currently under an idle pointer (resize/rotate), or null. Lets the
     * Canvas backend show handle cursors, which — unlike SVG's per-element `cursor` — it can't itself. */
    hoverCursor: string | null;
    activeTool: string;
    /** True while a tool is actively dragging (drives the "grabbing" cursor). */
    isDragging: boolean;
    /**
     * PLAY MODE (Milestone 7): the canvas stops being an editor and becomes the prototype. A
     * click fires the interaction under the pointer instead of selecting; nothing is editable.
     * Ephemeral, like selection — a prototype run is not a document change.
     */
    playing: boolean;
    /**
     * The state the RUNNING prototype is in. Separate from `ProjectDocument.activeState` on
     * purpose: playing a prototype must not edit the document, so a run's state lives here and
     * disappears when play stops — the document is exactly as it was.
     */
    playState: string | null;
    /**
     * The transition currently running, or null. `startedAt` is a timestamp the app's clock
     * compares against; the blend factor is derived from it per frame rather than stored, so a
     * dropped frame lands in the right place instead of accumulating drift.
     */
    transition: { from: string | null; to: string | null; startedAt: number; duration: number; easing: Easing } | null;
    /** Ephemeral rectangle-tool drag preview, drawn by the renderer; never persisted. */
    previewRect: { x: number; y: number; width: number; height: number } | null;
    /**
     * Ephemeral box-select marquee in WORLD coordinates, drawn by the renderer as an
     * overlay (so it composes with the viewport transform like any world-space item);
     * never persisted. Non-null only while a marquee drag is in flight.
     */
    marqueeRect: { x: number; y: number; width: number; height: number } | null;
    /**
     * Ephemeral alignment (smart) guides in WORLD coordinates, drawn by the renderer while a
     * drag snaps the moving node's edges/centre onto another node's; never persisted.
     */
    snapGuides: SnapGuide[] | null;
    /** The pen stroke in progress, in WORLD space (schema 17's `core.path`, finally drawable).
     *  Drawn as an overlay so an unfinished path is visible without existing in the document. */
    pendingPath: PathCommand[] | null;
    /**
     * Ephemeral per-node patches to STORED (parent-relative) geometry, used to
     * preview a move/resize drag WITHOUT mutating the document. These are fed
     * into `computeGeometry` as an input and composed like any other
     * geometry — not applied as a renderer-side override — so future layout
     * passes apply to previews too. The real action is dispatched on mouse-up.
     */
    pendingGeometry: Map<string, Partial<Geometry>> | null;
    viewport: {
        x: number;
        y: number;
        zoom: number;
    };
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;
const PAN_LIMIT = 10000;

export function clampViewport(vp: EditorState["viewport"]): void {
    vp.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, vp.zoom));
    // vp.x/y are SCREEN offsets (the transform applies translate before scale), so
    // the reachable world area shrinks as zoom rises. Scale the limit by zoom so
    // PAN_LIMIT means the same ±10000 WORLD units at every zoom level — otherwise
    // at zoom 20 nothing beyond world x=500 could be scrolled to.
    const limit = PAN_LIMIT * vp.zoom;
    vp.x = Math.max(-limit, Math.min(limit, vp.x));
    vp.y = Math.max(-limit, Math.min(limit, vp.y));
}

/**
 * Pan by a SCREEN-pixel delta (the pointer's frame movement), zoom-independent — a drag
 * of `dx` px moves the content `dx` px so it tracks the pointer. The viewport transform is
 * `screen = z·world − vp`, so following a `+dx` pointer move (raising a point's screen x)
 * means LOWERING `vp.x`. Re-clamps.
 */
export function panBy(vp: EditorState["viewport"], dx: number, dy: number): void {
    vp.x -= dx;
    vp.y -= dy;
    clampViewport(vp);
}

/**
 * Zoom by `factor` about a CURSOR point (canvas-relative screen px), keeping the world point
 * under the cursor fixed. From `screen = z·world − vp`, the world at the cursor is
 * `(cursor + vp)/z`; holding it fixed under the new zoom gives `vp' = f·vp + (f−1)·cursor`,
 * where `f` is the ACTUAL factor after the zoom clamp (so a clamped zoom doesn't drift the anchor).
 */
export function zoomAt(vp: EditorState["viewport"], factor: number, cursorX: number, cursorY: number): void {
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, vp.zoom * factor));
    const f = newZoom / vp.zoom;
    vp.zoom = newZoom;
    vp.x = f * vp.x + (f - 1) * cursorX;
    vp.y = f * vp.y + (f - 1) * cursorY;
    clampViewport(vp);
}

/**
 * Canvas-relative SCREEN pixels → WORLD coordinates — the exact inverse of the render
 * transform `screen = z·world − vp`. The single sanctioned conversion, shared by every
 * tool so the picking math can't drift (zoom is floored like `clampViewport`'s minimum).
 */
export function screenToWorld(
    vp: EditorState["viewport"],
    canvasRect: { left: number; top: number },
    clientX: number,
    clientY: number
): { x: number; y: number } {
    const zoom = Math.max(0.01, vp.zoom);
    return {
        x: (clientX - canvasRect.left + vp.x) / zoom,
        y: (clientY - canvasRect.top + vp.y) / zoom
    };
}

export function createEditorState(): EditorState {
    return {
        selectedNodeIds: [],
        hoveredNodeId: null,
        hoverCursor: null,
        activeTool: "select",
        isDragging: false,
        playing: false,
        playState: null,
        transition: null,
        previewRect: null,
        marqueeRect: null,
        snapGuides: null,
        pendingPath: null,
        pendingGeometry: null,
        viewport: { x: 0, y: 0, zoom: 1 }
    };
}
