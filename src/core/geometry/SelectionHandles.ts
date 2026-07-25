/**
 * @module SelectionHandles
 * @description The resize-handle geometry for a selection — shared by the renderer
 * (which DRAWS the handles) and the editor (which HIT-TESTS them), so picking can
 * never drift from drawing, and so hit-testing needs no DOM: the Canvas backend has
 * no `data-resize-handle` element to read, yet resize must still work under it.
 *
 * Positions are read straight from each node's precomputed world AABB (`bounds`) — no
 * coordinate composition — so this is safe for the render model to depend on.
 */

import { ComputedState } from "./GeometryEngine";
import { Rect } from "./Matrix";

/** Resize-handle square edge length in SCREEN pixels (÷ zoom → world units). */
export const HANDLE_SIZE_PX = 8;

export type HandleId = "nw" | "ne" | "sw" | "se";

export interface SelectionHandle {
    nodeId: string;
    handle: HandleId;
    /** Handle CENTER in world coordinates — a corner of the node's world AABB. */
    cx: number;
    cy: number;
    /** CSS cursor for the handle (diagonal resize matching the corner). */
    cursor: string;
}

function isFiniteRect(r: Rect): boolean {
    return Number.isFinite(r.x) && Number.isFinite(r.y)
        && Number.isFinite(r.width) && Number.isFinite(r.height);
}

/**
 * The four corner resize handles for every selected node, in selection order (and, per
 * node, nw · ne · sw · se). A node missing from the computed state, or with a non-finite
 * AABB, contributes none — never throws.
 */
export function selectionHandles(state: ComputedState, selectedNodeIds: readonly string[]): SelectionHandle[] {
    const handles: SelectionHandle[] = [];
    for (const nodeId of selectedNodeIds) {
        const c = state.nodes.get(nodeId);
        if (!c || !isFiniteRect(c.bounds)) continue;
        const b = c.bounds;
        handles.push(
            { nodeId, handle: "nw", cx: b.x, cy: b.y, cursor: "nwse-resize" },
            { nodeId, handle: "ne", cx: b.x + b.width, cy: b.y, cursor: "nesw-resize" },
            { nodeId, handle: "sw", cx: b.x, cy: b.y + b.height, cursor: "nesw-resize" },
            { nodeId, handle: "se", cx: b.x + b.width, cy: b.y + b.height, cursor: "nwse-resize" }
        );
    }
    return handles;
}

/**
 * The handle under a world-space point, or null. `sizeWorld` is the handle edge length in
 * world units (HANDLE_SIZE_PX / zoom) — the same square the renderer draws, so the grab
 * area equals the visible target. Later-listed handles win an overlap (they draw on top),
 * so the scan runs back to front.
 */
export function handleAtPoint(
    state: ComputedState,
    selectedNodeIds: readonly string[],
    x: number,
    y: number,
    sizeWorld: number
): SelectionHandle | null {
    const half = sizeWorld / 2;
    const handles = selectionHandles(state, selectedNodeIds);
    for (let i = handles.length - 1; i >= 0; i--) {
        const h = handles[i];
        if (x >= h.cx - half && x <= h.cx + half && y >= h.cy - half && y <= h.cy + half) return h;
    }
    return null;
}
