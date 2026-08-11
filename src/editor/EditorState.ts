/**
 * @module EditorState
 * @description Runtime editor context. Never serialized to the document.
 */

import { Easing } from "../core/document/Prototype";
import { Geometry, PathCommand } from "../core/document/Node";
import { SnapGuide } from "../core/geometry/Snapping";
import { Mat2D } from "../core/geometry/Matrix";
import { SelectionMask, isEmptySelection } from "../core/paint/Selection";

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
     * The PLAYHEAD, and how many frames of onion skin to show either side (schema 39).
     *
     * Ephemeral, like the marquee and the drag preview, and for the same reason: scrubbing is not
     * an edit. `doc.frame` records where the playhead was SAVED; this is where it is now.
     */
    frame?: number;
    onion?: number;
    /**
     * The mesh control point most recently PRESSED, and on which node (schema 58).
     *
     * A point had no identity outside a drag until bones needed one: `ToolController` knew which
     * handle was moving and forgot it on release, which is all a drag ever needs. Binding a point
     * is not a drag — it is a choice made in a panel about a point the user is looking at — so the
     * pick has to outlive the gesture that made it.
     *
     * Held as {node, index} rather than an index alone because a mesh belongs to a node and the
     * selection can change underneath it; anything reading this re-checks that the node still has
     * a mesh that reaches this far, rather than trusting a stale pair.
     */
    meshPoint?: { nodeId: string; index: number };
    /**
     * The PIXEL SELECTION: which pixels of which raster an edit may touch.
     *
     * NOT `marqueeRect`, WHICH SELECTS NODES. The two words collide and the things do not: one is a
     * box being dragged over the canvas to pick objects, this is a mask over one surface's pixels.
     * Naming it `pixelSelection` rather than `selection` is the same choice `maskBounds` made against
     * the geometry engine's `selectionBounds`.
     *
     * EDITOR STATE, NOT DOCUMENT STATE, and `Selection`'s header argues it: a selection is what the
     * author is pointing at, not content, so it never enters the schema and never survives a save.
     *
     * HELD WITH THE NODE IT BELONGS TO, because a mask is meaningless without one — its coordinates
     * are that surface's pixels. Read it through `pixelMaskFor`, which re-checks that the node still
     * exists and still has a surface of the same size, for the reason `pickedMeshPoint` validates on
     * read: a resize, a delete or an undo would each otherwise have to remember to clear this.
     */
    pixelSelection?: { nodeId: string; mask: SelectionMask } | null;
    /** Whether the TIMELINE is running (distinct from `playing`, which is the prototype). */
    playingTimeline?: boolean;
    /**
     * A running NAVIGATION (schema 36): the viewport gliding from where it was to the frame an
     * interaction pointed at. Kept beside the state transition rather than folded into it,
     * because they are independent — one interaction can change the screen, change the state, or
     * do both, and each has its own start and end.
     */
    viewportTransition: { from: EditorState["viewport"]; to: EditorState["viewport"]; startedAt: number; duration: number; easing: Easing } | null;
    /**
     * Where the canvas was looking when PLAY started, restored when it stops.
     *
     * A prototype run navigates the viewport, and the viewport is editor state — so without this,
     * pressing Play, clicking through three screens and pressing Stop leaves you somewhere you
     * never chose to be. "Playing is not editing" has to cover where you are looking as well as
     * what the document says.
     */
    playReturnViewport: EditorState["viewport"] | null;
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
 * Margin left around a framed rect, in SCREEN px.
 *
 * Shared by the editor's zoom-to-fit and a prototype NAVIGATE, because they are the same gesture
 * with different triggers — content that touches every edge reads as clipped rather than framed,
 * and two numbers for that would be two answers to one question.
 */
export const FIT_PADDING_PX = 24;

/**
 * The viewport that FITS a world rect into a canvas, with a margin — "zoom to this frame".
 *
 * From `screen = z·world − vp`: the zoom is whichever axis is tighter, and the offset places the
 * rect's world centre at the canvas centre. A degenerate rect (a zero-extent line, an empty
 * frame) would divide by zero, so each axis falls back to the current zoom rather than producing
 * an infinity that `clampViewport` would then silently pin to a limit.
 *
 * Clamped like every other viewport change, so navigating to a huge or microscopic frame lands
 * somewhere reachable instead of somewhere the user cannot get back from.
 */
export function viewportToFit(
    bounds: { x: number; y: number; width: number; height: number },
    size: { width: number; height: number },
    padding: number,
    fallbackZoom: number
): EditorState["viewport"] {
    const w = bounds.width + padding * 2, h = bounds.height + padding * 2;
    const zx = w > 0 ? size.width / w : fallbackZoom;
    const zy = h > 0 ? size.height / h : fallbackZoom;
    const zoom = Math.min(zx, zy);
    const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
    const vp = { zoom, x: zoom * cx - size.width / 2, y: zoom * cy - size.height / 2 };
    clampViewport(vp);
    return vp;
}

/**
 * A viewport part-way between two others — the frame a NAVIGATION is currently on.
 *
 * ZOOM INTERPOLATES GEOMETRICALLY (a constant ratio per unit time), which is what makes a zoom feel
 * even: linear interpolation from 0.1 to 10 spends most of its run barely moving and then lurches.
 *
 * THE OFFSETS DO NOT, AND THAT WAS A BUG. Interpolating `x` and `y` linearly alongside a geometric
 * zoom looks obviously right and is obviously wrong the moment the two are written down together:
 * this engine's transform is `screen = z·world − vp`, so the world point under a given pixel is
 * `(pixel + vp)/z`. Move `vp` linearly while `z` moves geometrically and that quotient is a
 * straight line over a curve — the arithmetic mean divided by the geometric mean, which exceeds 1
 * everywhere between the ends. The focused point SWINGS OUT AND COMES BACK, both ends exact.
 *
 * IT IS PROPORTIONAL TO DISTANCE FROM THE WORLD ORIGIN, which is why it went unnoticed: measured on
 * an 800px canvas over a 1→2 zoom, the peak excursion is 0 at the origin, 86px at x=1000, 430px at
 * x=5000 and 1,721px at x=20,000 — and 12,098px for a 1→10 zoom at x=5000. The test that covered
 * this function used a viewport at {x: 0, y: 0}, where the defect is exactly zero, and asserted the
 * MECHANISM ("mid.x is 50") rather than the effect ("the focused point stays focused"), so it would
 * have passed anywhere.
 *
 * WHAT IS INTERPOLATED NOW is the world point under the screen CENTRE, linearly, with `vp` derived
 * from it — which holds that point on a straight line and is exact at 0 for every distance and every
 * zoom ratio. That needs the viewport's SIZE, and requiring it is the honest signature: you cannot
 * interpolate between two viewports without saying which point is meant to stay still. A zero size
 * degrades to holding the screen ORIGIN, which is bounded (24.6px on those numbers) rather than
 * unbounded, so a caller whose canvas has not measured yet is merely imprecise.
 */
export function lerpViewport(
    a: EditorState["viewport"],
    b: EditorState["viewport"],
    t: number,
    size: { width: number; height: number }
): EditorState["viewport"] {
    const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
    // A NON-POSITIVE ZOOM HAS NO GEOMETRIC PATH — the ratio is undefined — so the destination is
    // taken whole, as it was before. Copied rather than returned, since the caller assigns onto the
    // live viewport.
    if (!(a.zoom > 0) || !(b.zoom > 0)) return { x: b.x, y: b.y, zoom: b.zoom };
    const zoom = a.zoom * Math.pow(b.zoom / a.zoom, k);
    const halfW = size.width / 2;
    const halfH = size.height / 2;
    // The world point under the screen centre at each end, which is what a navigation is ABOUT.
    const ax = (halfW + a.x) / a.zoom, ay = (halfH + a.y) / a.zoom;
    const bx = (halfW + b.x) / b.zoom, by = (halfH + b.y) / b.zoom;
    return {
        x: zoom * (ax + (bx - ax) * k) - halfW,
        y: zoom * (ay + (by - ay) * k) - halfH,
        zoom
    };
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
 * A node's world matrix as the CSS transform that puts a DOM overlay exactly on it.
 *
 * The render transform is `screen = z·world − vp`, so an element placed at the canvas's top-left
 * and given this matrix lands on the node — rotation, scale and all. The on-canvas text editor is
 * the caller: a text field that only matched the node's AABB would sit square over a rotated
 * label, and one placed from the bounds alone would drift the moment the node was scaled.
 *
 * THE SAME RELATIONSHIP `screenToWorld` INVERTS, which is why it lives here. A second idea of
 * where the canvas thinks a node is would put the caret next to the letters rather than in them.
 */
export function overlayTransform(world: Mat2D, vp: EditorState["viewport"]): string {
    const z = Math.max(0.01, vp.zoom);
    return `matrix(${z * world.a}, ${z * world.b}, ${z * world.c}, ${z * world.d}, `
        + `${z * world.e - vp.x}, ${z * world.f - vp.y})`;
}

/**
 * Canvas-relative SCREEN pixels → WORLD coordinates — the exact inverse of the render
 * transform `screen = z·world − vp`. The single sanctioned conversion, shared by every
 * tool so the picking math can't drift (zoom is floored like `clampViewport`'s minimum).
 */
/**
 * WORLD coordinates → canvas-relative SCREEN pixels — the exact forward of `screenToWorld`, and here
 * beside it so the two cannot drift.
 *
 * WRITTEN BECAUSE THE PAIR IS THE ORACLE. `screenToWorld` calls itself the single sanctioned
 * conversion and is right to; what it had no way to state was that it inverts anything, because
 * there was nothing to invert it against. A round trip over a zoom sweep is a test the relationship
 * could not have before — and the defect it was written for, `lerpViewport` swinging the focused
 * point out and back, is exactly the kind that survives when a relationship is only ever travelled
 * in one direction.
 *
 * The zoom floor matches `screenToWorld`'s, or the round trip would fail below 0.01 for a reason
 * that has nothing to do with either function.
 */
export function worldToScreen(
    vp: EditorState["viewport"],
    canvasRect: { left: number; top: number },
    worldX: number,
    worldY: number
): { x: number; y: number } {
    const zoom = Math.max(0.01, vp.zoom);
    return {
        x: zoom * worldX - vp.x + canvasRect.left,
        y: zoom * worldY - vp.y + canvasRect.top
    };
}

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

/**
 * Where the playhead should sit for a document that has just been LOADED.
 *
 * `doc.frame` was always written — it is what "records where the playhead was SAVED" means — and
 * never read back, so opening an animation put the scrubber at 0 while the canvas drew whatever
 * frame the file stored. Both halves were self-consistent and they disagreed with each other: the
 * render is right because an undefined `es.frame` falls through to the document's own, and the
 * widget is right because it shows `es.frame ?? 0`. The first scrub then jumped.
 *
 * CLAMPED, because a file may hold a frame past a timeline that has since been shortened, and a
 * playhead outside the scrubber's range is one the user cannot get back. Undefined when there is
 * no timeline at all — there is no playhead to place.
 */
export function frameOnLoad(doc: { timeline?: { frames: number }; frame?: number }): number | undefined {
    if (!doc.timeline) return undefined;
    const last = Math.max(0, doc.timeline.frames - 1);
    return Math.min(last, Math.max(0, Math.round(doc.frame ?? 0)));
}

/**
 * The mesh control point the inspector should be editing, or null.
 *
 * VALIDATED ON READ rather than cleared on write. A pick can be invalidated by selecting another
 * node, by deleting the node it was on, by turning the warp off, or by choosing a coarser grid
 * that no longer reaches that index — four sites that would each have to remember, and a fifth
 * arriving with the next feature. Asking here instead means a stale pick is impossible to observe,
 * whoever forgot.
 *
 * The STORED document: a resolved scene has already turned a warped node into a path and dropped
 * the mesh, so a point picked on the canvas would stop existing the moment it started working.
 */
export function pickedMeshPoint(
    es: Pick<EditorState, "meshPoint" | "selectedNodeIds">,
    doc: { nodes: { get(id: string): { mesh?: { points: readonly unknown[] } } | undefined } }
): { nodeId: string; index: number } | null {
    const pick = es.meshPoint;
    if (!pick) return null;
    // Only for the node actually selected — otherwise the panel would edit something the canvas
    // is not showing handles for.
    if (es.selectedNodeIds.length !== 1 || es.selectedNodeIds[0] !== pick.nodeId) return null;
    const mesh = doc.nodes.get(pick.nodeId)?.mesh;
    if (!mesh || pick.index < 0 || pick.index >= mesh.points.length) return null;
    return pick;
}

/**
 * The mask an edit to `nodeId` must respect, or null when it may touch every pixel.
 *
 * VALIDATED ON READ, exactly like `pickedMeshPoint` and for the same reason: a mask can be invalidated
 * by selecting another node, by deleting the one it was drawn on, by an undo that removes the surface,
 * or by a resize that changes how many pixels there are — four sites that would each have to remember
 * to clear it, and a fifth arriving with the next feature. Asking here means a stale mask is
 * impossible to observe, whoever forgot.
 *
 * THE SIZE CHECK IS THE ONE THAT MATTERS. A mask captured on a 32x32 surface and read against a 64x64
 * one indexes every row after the first from the wrong place, so a brush would be clipped to a sheared
 * ghost of what the author drew — visible, baffling, and impossible to attribute to a resize that
 * happened ten actions ago.
 *
 * AN EMPTY MASK IS NO CONSTRAINT, and that is `Selection`'s rule rather than one invented here — see
 * `selectionClip`, which every consumer goes through.
 */
export function pixelMaskFor(
    es: Pick<EditorState, "pixelSelection">,
    doc: { nodes: { get(id: string): { surface?: { width: number; height: number } } | undefined } },
    nodeId: string
): SelectionMask | null {
    const sel = es.pixelSelection;
    // ONLY FOR THE NODE ASKED ABOUT: a mask drawn on one sprite must not clip a stroke on another,
    // which is what a single global mask would do the moment the author selected a different canvas.
    if (!sel || sel.nodeId !== nodeId) return null;
    const surface = doc.nodes.get(nodeId)?.surface;
    if (!surface) return null;
    if (sel.mask.width !== surface.width || sel.mask.height !== surface.height) return null;
    if (isEmptySelection(sel.mask)) return null;
    return sel.mask;
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
        frame: undefined,
        onion: undefined,
        meshPoint: undefined,
        pixelSelection: null,
        viewportTransition: null,
        playReturnViewport: null,
        transition: null,
        previewRect: null,
        marqueeRect: null,
        snapGuides: null,
        pendingPath: null,
        pendingGeometry: null,
        viewport: { x: 0, y: 0, zoom: 1 }
    };
}
