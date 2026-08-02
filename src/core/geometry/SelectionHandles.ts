/**
 * @module SelectionHandles
 * @description The selection-handle geometry — shared by the renderer (which DRAWS the
 * handles) and the editor (which HIT-TESTS them), so picking can never drift from drawing,
 * and so hit-testing needs no DOM: the Canvas backend has no `data-resize-handle` element
 * to read, yet resize/rotate must still work under it.
 *
 * Positions are read from each node's precomputed world AABB (`bounds`) — no coordinate
 * composition — so this is safe for the render model to depend on. Both the handle size and
 * the rotate-handle offset are fixed SCREEN pixels, so callers pass `zoom`; the conversion to
 * world (and the zoom floor) lives here ONCE, which is what keeps the drawn square and the
 * grabbable square identical at every zoom.
 */

import { ComputedState, selectionBounds } from "./GeometryEngine";
import { ReadonlyDocument } from "../document/Document";
import { pathVertices } from "./PathBuilder";
import { Rect , applyToPoint} from "./Matrix";

/** Resize-handle square edge length in SCREEN pixels. */
export const HANDLE_SIZE_PX = 8;
/** How far above the selection's top edge the rotate handle sits, in SCREEN pixels. */
export const ROTATE_OFFSET_PX = 22;

/** A box handle, or a path VERTEX naming its command index (`vertex:3`). The vertex form
 *  is a template literal rather than a separate field so one `handle` string still
 *  identifies a grab completely — which is what lets the renderer, the picker and the
 *  hover cursor keep reading exactly one thing. */
export type HandleId = "nw" | "ne" | "sw" | "se" | "rotate" | `vertex:${number}`;

export interface SelectionHandle {
    nodeId: string;
    handle: HandleId;
    /** Handle CENTER in world coordinates (a corner of the node's world AABB, or the rotate knob above it). */
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
 * Every handle for the selection, in selection order and — per node — nw · ne · sw · se ·
 * rotate. The four corners come straight from the world AABB (zoom-independent); the rotate
 * knob sits `ROTATE_OFFSET_PX` screen px above the top edge's centre (so it needs `zoom`). A
 * node missing from the computed state, or with a non-finite AABB, contributes none — never throws.
 */
export function selectionHandles(state: ComputedState, selectedNodeIds: readonly string[], zoom: number): SelectionHandle[] {
    const rotateOffset = ROTATE_OFFSET_PX / flooredZoom(zoom);
    const handles: SelectionHandle[] = [];
    for (const nodeId of selectedNodeIds) {
        const c = state.nodes.get(nodeId);
        if (!c || !isFiniteRect(c.bounds)) continue;
        const b = c.bounds;
        handles.push(
            { nodeId, handle: "nw", cx: b.x, cy: b.y, cursor: "nwse-resize" },
            { nodeId, handle: "ne", cx: b.x + b.width, cy: b.y, cursor: "nesw-resize" },
            { nodeId, handle: "sw", cx: b.x, cy: b.y + b.height, cursor: "nesw-resize" },
            { nodeId, handle: "se", cx: b.x + b.width, cy: b.y + b.height, cursor: "nwse-resize" },
            { nodeId, handle: "rotate", cx: b.x + b.width / 2, cy: b.y - rotateOffset, cursor: "grab" }
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
