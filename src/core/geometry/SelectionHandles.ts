/**
 * @module SelectionHandles
 * @description The selection-handle geometry — shared by the renderer (which DRAWS the
 * handles) and the editor (which HIT-TESTS them), so picking can never drift from drawing,
 * and so hit-testing needs no DOM: the Canvas backend has no `data-resize-handle` element
 * to read, yet resize/rotate must still work under it.
 *
 * Positions come from each node's precomputed world MATRIX applied to its own box (`OrientedBox`),
 * so a rotated node's handles sit on the shape's corners rather than on an axis-aligned box it
 * does not touch. The composition is the engine's — this module only applies the matrix it
 * published — so the render model may still depend on it. Both the handle size and
 * the rotate-handle offset are fixed SCREEN pixels, so callers pass `zoom`; the conversion to
 * world (and the zoom floor) lives here ONCE, which is what keeps the drawn square and the
 * grabbable square identical at every zoom.
 */

import { ComputedState, selectionBounds } from "./GeometryEngine";
import { ReadonlyDocument } from "../document/Document";
import { pathVertices } from "./PathBuilder";
import { Rect , applyToPoint} from "./Matrix";
import { boxQuad, cursorForDirection, quadCenter, Quad } from "./OrientedBox";

/** Resize-handle square edge length in SCREEN pixels. */
export const HANDLE_SIZE_PX = 8;
/** How far above the selection's top edge the rotate handle sits, in SCREEN pixels. */
export const ROTATE_OFFSET_PX = 22;

/** A box handle, or a path VERTEX naming its command index (`vertex:3`). The vertex form
 *  is a template literal rather than a separate field so one `handle` string still
 *  identifies a grab completely — which is what lets the renderer, the picker and the
 *  hover cursor keep reading exactly one thing. */
export type HandleId = "nw" | "ne" | "sw" | "se" | "rotate" | `vertex:${number}` | `mesh:${number}`;

export interface SelectionHandle {
    nodeId: string;
    handle: HandleId;
    /** Handle CENTER in world coordinates (a corner of the node's own rotated box, or the rotate knob off its top edge). */
    cx: number;
    cy: number;
    /** CSS cursor for the handle. */
    cursor: string;
}

function isFiniteRect(r: Rect): boolean {
    return Number.isFinite(r.x) && Number.isFinite(r.y)
        && Number.isFinite(r.width) && Number.isFinite(r.height);
}

/** Zoom floored to the same minimum the viewport clamp and renderer use. */
function flooredZoom(zoom: number): number {
    return Math.max(0.01, zoom);
}

/**
 * The world-space frame of one node's box: its four corners as DRAWN, optionally padded.
 *
 * Null for a node that is missing or whose corners are not finite. Shared by the renderer (which
 * strokes it) and the handles below (which sit on it), so the frame and its grips cannot drift.
 */
export function selectionFrame(state: ComputedState, nodeId: string, pad: number = 0): Quad | null {
    const c = state.nodes.get(nodeId);
    // Both rects: `local` is what the frame is built from, and `bounds` is the engine's own
    // finiteness summary for the node — a garbage entry should contribute no frame either way.
    if (!c || !isFiniteRect(c.local) || !isFiniteRect(c.bounds)) return null;
    const q = boxQuad(c.world, c.local.width, c.local.height, pad);
    return q.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) ? q : null;
}

/**
 * Every handle for the selection, in selection order and — per node — nw · ne · sw · se ·
 * rotate.
 *
 * The corners are the ROTATED box's corners, not the world AABB's. An AABB corner is a point the
 * node does not touch as soon as it is turned, so the handles floated off the shape and dragging
 * one resized along world axes while the user watched rotated ones. Each cursor is chosen from
 * the direction its corner actually points on screen, for the same reason: `se` stays the
 * bottom-right of the BOX, but which way that is depends on the rotation.
 *
 * The rotate knob sits `ROTATE_OFFSET_PX` screen px off the top edge (so it needs `zoom`), along
 * the outward normal — measured away from the box centre, so a flipped or negatively scaled node
 * still puts the knob outside itself rather than through its own middle.
 */
export function selectionHandles(state: ComputedState, selectedNodeIds: readonly string[], zoom: number): SelectionHandle[] {
    const rotateOffset = ROTATE_OFFSET_PX / flooredZoom(zoom);
    const handles: SelectionHandle[] = [];
    for (const nodeId of selectedNodeIds) {
        const q = selectionFrame(state, nodeId);
        if (!q) continue;
        const [nw, ne, se, sw] = q;
        const centre = quadCenter(q);
        const cursorAt = (p: { x: number; y: number }): string => cursorForDirection(p.x - centre.x, p.y - centre.y);
        // Outward from the TOP edge: the midpoint pushed away from the centre. A zero-length
        // direction (a fully collapsed box) leaves the knob on the edge rather than at NaN.
        const midTop = { x: (nw.x + ne.x) / 2, y: (nw.y + ne.y) / 2 };
        const outX = midTop.x - centre.x, outY = midTop.y - centre.y;
        const len = Math.hypot(outX, outY);
        const nx = len > 0 ? outX / len : 0, ny = len > 0 ? outY / len : -1;
        handles.push(
            { nodeId, handle: "nw", cx: nw.x, cy: nw.y, cursor: cursorAt(nw) },
            { nodeId, handle: "ne", cx: ne.x, cy: ne.y, cursor: cursorAt(ne) },
            { nodeId, handle: "sw", cx: sw.x, cy: sw.y, cursor: cursorAt(sw) },
            { nodeId, handle: "se", cx: se.x, cy: se.y, cursor: cursorAt(se) },
            { nodeId, handle: "rotate", cx: midTop.x + nx * rotateOffset, cy: midTop.y + ny * rotateOffset, cursor: "grab" }
        );
    }
    return handles;
}

/**
 * The handle under a world-space point, or null. `zoom` sizes the grab square
 * (HANDLE_SIZE_PX / floored-zoom) — the same square the renderer draws, so the grab area
 * equals the visible target — and places the rotate knob. Later-listed handles win an overlap
 * (they draw on top), so the scan runs back to front: the rotate knob beats a corner it grazes.
 */
export function handleAtPoint(
    state: ComputedState,
    selectedNodeIds: readonly string[],
    x: number,
    y: number,
    zoom: number
): SelectionHandle | null {
    const half = (HANDLE_SIZE_PX / flooredZoom(zoom)) / 2;
    const handles = selectionHandles(state, selectedNodeIds, zoom);
    for (let i = handles.length - 1; i >= 0; i--) {
        const h = handles[i];
        if (x >= h.cx - half && x <= h.cx + half && y >= h.cy - half && y <= h.cy + half) return h;
    }
    return null;
}

/**
 * The rotate knob for a GROUP box — one knob `ROTATE_OFFSET_PX` screen px above the top-centre of
 * the union of `rootIds`' world AABBs (a multi-selection rotates as one). Null when the group has no
 * finite box. `nodeId` is "" because the knob belongs to the whole group, not a single node. Shared
 * by the renderer (which draws it) and the editor (which hit-tests it), so the two can't drift —
 * exactly like `selectionHandles`. `zoom` places the knob (fixed screen offset) and sizes the grab.
 */
export function groupRotateHandle(state: ComputedState, rootIds: readonly string[], zoom: number): SelectionHandle | null {
    const b = selectionBounds(state, rootIds);
    if (!b || !isFiniteRect(b)) return null; // no finite union box (empty group, or non-finite bounds)
    const rotateOffset = ROTATE_OFFSET_PX / flooredZoom(zoom);
    return { nodeId: "", handle: "rotate", cx: b.x + b.width / 2, cy: b.y - rotateOffset, cursor: "grab" };
}

/**
 * The four RESIZE corner handles of a GROUP box (the union of `rootIds`' world AABBs) —
 * drawn/picked only for an `isGroupResizable` group (the caller gates; same split as the
 * rotate knob vs `isGroupRotatable`). `nodeId` is "" — the handles belong to the group.
 */
export function groupCornerHandles(state: ComputedState, rootIds: readonly string[], zoom: number): SelectionHandle[] {
    void zoom; // corners are zoom-independent (the knob's offset is why the sibling fns take zoom)
    const b = selectionBounds(state, rootIds);
    if (!b || !isFiniteRect(b)) return [];
    return [
        { nodeId: "", handle: "nw", cx: b.x, cy: b.y, cursor: "nwse-resize" },
        { nodeId: "", handle: "ne", cx: b.x + b.width, cy: b.y, cursor: "nesw-resize" },
        { nodeId: "", handle: "sw", cx: b.x, cy: b.y + b.height, cursor: "nesw-resize" },
        { nodeId: "", handle: "se", cx: b.x + b.width, cy: b.y + b.height, cursor: "nwse-resize" }
    ];
}

/**
 * Whether a world point hits a group handle (grab square = HANDLE_SIZE_PX / floored zoom).
 * Scans the rotate knob first, then — when `includeCorners` (the group is resizable) — the
 * four corners, so the knob wins any overlap exactly as it draws on top.
 */
export function groupHandleAtPoint(
    state: ComputedState,
    rootIds: readonly string[],
    x: number,
    y: number,
    zoom: number,
    includeCorners: boolean = false
): SelectionHandle | null {
    const half = (HANDLE_SIZE_PX / flooredZoom(zoom)) / 2;
    const hit = (h: SelectionHandle | null): boolean =>
        !!h && x >= h.cx - half && x <= h.cx + half && y >= h.cy - half && y <= h.cy + half;
    const knob = groupRotateHandle(state, rootIds, zoom);
    if (hit(knob)) return knob;
    if (includeCorners) {
        for (const c of groupCornerHandles(state, rootIds, zoom)) if (hit(c)) return c;
    }
    return null;
}

/**
 * VERTEX handles for a `core.path` — one per on-curve point, in WORLD space.
 *
 * Kept separate from `selectionHandles` because they answer a different question: the corner
 * handles resize the node's BOX, while these move the ink inside it. A path shows both, and a
 * vertex handle names its command index (`vertex:3`) so the drag knows which point it holds
 * without re-deriving it from a position that two vertices could share.
 *
 * Positions come from the node's WORLD matrix, so a rotated or scaled path still shows its
 * vertices where they are drawn rather than where they are stored.
 */
export function pathVertexHandles(
    doc: ReadonlyDocument,
    state: ComputedState,
    selectedNodeIds: readonly string[]
): SelectionHandle[] {
    const handles: SelectionHandle[] = [];
    for (const nodeId of selectedNodeIds) {
        const node = doc.nodes.get(nodeId);
        // The type check is belt-and-braces: `pathError` already guarantees only a
        // `core.path` can carry `path` on both the load and edit paths, so no reachable
        // document distinguishes the two conditions — it is not mutation-killable, and it
        // is here so this function does not depend on that guarantee to be correct.
        if (!node || node.type !== "core.path" || !node.path) continue;
        const c = state.nodes.get(nodeId);
        if (!c) continue;
        for (const v of pathVertices(node.path)) {
            const w = applyToPoint(c.world, v.x, v.y);
            if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) continue;
            handles.push({ nodeId, handle: `vertex:${v.index}`, cx: w.x, cy: w.y, cursor: "move" });
        }
    }
    return handles;
}

/** The command index a `vertex:N` handle names, or null for any other handle. */
export function vertexIndexOf(handle: string): number | null {
    if (!handle.startsWith("vertex:")) return null;
    const n = Number(handle.slice("vertex:".length));
    return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The VERTEX handle under a world point, or null.
 *
 * Deliberately built from `pathVertexHandles` — the same producer the renderer draws from — so
 * what is drawn and what a press grabs cannot drift. Adding the handles to the renderer alone
 * is exactly that drift: they appeared, and dragging one did nothing.
 *
 * Scanned BACK to front, like `handleAtPoint`, so the later-drawn vertex wins when two overlap.
 */
export function vertexHandleAtPoint(
    doc: ReadonlyDocument,
    state: ComputedState,
    selectedNodeIds: readonly string[],
    x: number,
    y: number,
    zoom: number
): SelectionHandle | null {
    const half = HANDLE_SIZE_PX / flooredZoom(zoom) / 2;
    const handles = pathVertexHandles(doc, state, selectedNodeIds);
    for (let i = handles.length - 1; i >= 0; i--) {
        const h = handles[i];
        if (Math.abs(x - h.cx) <= half && Math.abs(y - h.cy) <= half) return h;
    }
    return null;
}

/**
 * A handle for every CONTROL POINT of a selected node's mesh (schema 41).
 *
 * Built from the node's OWN mesh rather than from the derived path, which is the only thing that
 * could work: `resolveMeshes` turns a warped node into a `core.path`, so the vertices a user can
 * see belong to the bent outline and dragging one of THOSE would edit the result instead of the
 * cause. The mesh points are the cause, and they are what these name.
 *
 * The same producer feeds the renderer and the picker — the drift `pathVertexHandles` was written
 * to avoid, where handles appeared and dragging one did nothing.
 */
export function meshHandles(
    doc: ReadonlyDocument,
    state: ComputedState,
    selectedNodeIds: readonly string[]
): SelectionHandle[] {
    const handles: SelectionHandle[] = [];
    for (const nodeId of selectedNodeIds) {
        const node = doc.nodes.get(nodeId);
        if (!node?.mesh) continue;
        const c = state.nodes.get(nodeId);
        if (!c) continue;
        node.mesh.points.forEach((p, index) => {
            const w = applyToPoint(c.world, p.x, p.y);
            if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) return;
            handles.push({ nodeId, handle: `mesh:${index}`, cx: w.x, cy: w.y, cursor: "move" });
        });
    }
    return handles;
}

/** The control-point index a `mesh:N` handle names, or null for any other handle. */
export function meshIndexOf(handle: string): number | null {
    if (!handle.startsWith("mesh:")) return null;
    const n = Number(handle.slice("mesh:".length));
    return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The MESH handle under a world point, or null — back to front, like every other picker here. */
export function meshHandleAtPoint(
    doc: ReadonlyDocument,
    state: ComputedState,
    selectedNodeIds: readonly string[],
    x: number,
    y: number,
    zoom: number
): SelectionHandle | null {
    const half = HANDLE_SIZE_PX / flooredZoom(zoom) / 2;
    const handles = meshHandles(doc, state, selectedNodeIds);
    for (let i = handles.length - 1; i >= 0; i--) {
        const h = handles[i];
        if (Math.abs(x - h.cx) <= half && Math.abs(y - h.cy) <= half) return h;
    }
    return null;
}
