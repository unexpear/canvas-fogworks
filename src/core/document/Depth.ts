/**
 * @module Depth
 * @description How far BACK a node sits — one number, and the three things it decides.
 *
 * A design tool is flat, and then one day it is not: a parallax hero, a card that lifts off the
 * page, a background that drifts slower than the thing in front of it. All of those are the same
 * missing quantity — how far away a layer is — and adding it once buys all three:
 *
 *   - ORDER. Depth sorts what draws in front of what, ahead of the tree's own order. A layer panel
 *     says which shape is on top of which SIBLING; depth says which is nearer the viewer, and the
 *     two are different questions. Sorting in the model means all three backends agree, rather
 *     than only the one that happens to have a depth buffer.
 *   - the Z-BUFFER. On the GPU the sort is belt, and the depth buffer is braces: a fragment nearer
 *     the viewer wins whatever order it was drawn in. That is testable in a way sorting is not —
 *     shuffle the draw order and the picture must not change.
 *   - PARALLAX. A distant layer should slide less than a near one when the canvas is panned,
 *     because that is what distance looks like. That is a function of the VIEWPORT and the depth,
 *     and of nothing else.
 *
 * Parallax is applied at the DISPLAY SEAM, as an offset to a node's position, rather than inside
 * the renderer. It has to be: a shape drawn somewhere must be CLICKABLE there, and picking,
 * marquee selection and snapping all read the computed geometry. Shifting a node in the renderer
 * alone would put every one of them a parallax offset away from what the user can see — the exact
 * "picking follows the ink" rule this codebase has already had to learn twice.
 */

/** Depth a document may declare. Bounded because it scales a divisor and reaches a clip coordinate. */
export const DEPTH_MIN = -1000;
export const DEPTH_MAX = 1000;

export function depthError(depth: unknown): string | null {
    if (depth === undefined) return null;
    if (typeof depth !== "number" || !Number.isFinite(depth) || depth < DEPTH_MIN || depth > DEPTH_MAX) {
        return `depth must be a finite number within [${DEPTH_MIN}, ${DEPTH_MAX}]`;
    }
    return null;
}

/** A node's depth, with the default that means "in the plane of the page". */
export function depthOf(node: { depth?: number }): number {
    return node.depth ?? 0;
}

/**
 * How much of the viewport's pan a layer at this depth should follow, in [0, 1].
 *
 * `1 / (1 + d)` for positive depth: at 0 the layer tracks the canvas exactly, at 1 it moves half
 * as far, and far away it barely moves at all — an asymptote rather than a cliff, so there is no
 * depth at which a layer suddenly pins. NEGATIVE depth is the foreground and moves FASTER than the
 * canvas, which is what a near layer does when you pan past it; `1 - d` there, because the
 * reciprocal would blow up and then change sign at d = -1.
 */
export function parallaxRate(depth: number): number {
    return depth >= 0 ? 1 / (1 + depth) : 1 - depth;
}

/**
 * The WORLD-space offset that makes a node at `depth` appear to lag the viewport.
 *
 * On screen a point lands at `world * zoom - viewport`. A layer that should follow only `rate` of
 * the pan wants `world * zoom - viewport * rate`, and the difference between those is
 * `viewport * (1 - rate)` in screen units — so dividing by the zoom gives the offset to add to the
 * node's own position. Depth 0 yields exactly zero, so an unlayered document is untouched, and the
 * ZOOM is deliberately not scaled by depth: parallax is about distance travelled, and a layer that
 * also changed size as you zoomed would read as the shape resizing itself.
 */
export function parallaxOffset(depth: number, viewport: { x: number; y: number; zoom: number }): { x: number; y: number } {
    const lag = 1 - parallaxRate(depth);
    if (lag === 0 || viewport.zoom === 0) return { x: 0, y: 0 };
    return { x: (viewport.x * lag) / viewport.zoom, y: (viewport.y * lag) / viewport.zoom };
}

/**
 * Depth as the z a clip-space vertex carries, in [-1, 1] with NEARER being smaller.
 *
 * A depth buffer keeps the smallest z, and "nearer wins" is the whole contract, so the mapping has
 * to be decreasing in depth. It is also CLAMPED rather than wrapped: a z outside the clip volume is
 * not merely wrong, it is culled entirely, and a node that vanished because somebody typed a large
 * number would look like a bug in everything except the number.
 */
export function depthToClipZ(depth: number): number {
    const t = Math.max(DEPTH_MIN, Math.min(DEPTH_MAX, depth)) / DEPTH_MAX;
    return Math.max(-0.999, Math.min(0.999, t));
}

/**
 * Order two items for drawing: FAR first, and the existing order breaking ties.
 *
 * Stable by construction — equal depths compare zero and a stable sort then leaves the tree's own
 * order alone, so a document that never mentions depth draws exactly as it always did. That is the
 * property that lets this be applied unconditionally rather than only when some node has a depth.
 */
export function byDepth(a: { depth: number }, b: { depth: number }): number {
    return b.depth - a.depth;
}

/**
 * Which nodes `applyParallax` would MOVE — the dirty set's half of the same question.
 *
 * IT EXISTS BECAUSE PARALLAX DID NOT SURVIVE THE INCREMENTAL GEOMETRY PATH, measured at 300px on a
 * single depth-1 layer after a 600px pan. `applyParallax` changes a layered node's stored geometry
 * from the VIEWPORT, and the geometry engine reuses a previous entry for any node the dirty set
 * does not name — it compares set membership, never geometry. A pan dispatches no action and moves
 * no body, so nothing named the shift and the reused entry stayed where the camera used to be.
 *
 * THE FOURTH INSTANCE OF THIS SHAPE in this codebase — after a run's bodies, a scrubbed playhead,
 * and a character that turned around without moving. Each was a thing that changed geometry by a
 * route the dirty set could not see, and each drew a stale picture until something named it.
 *
 * DEPTH 0 IS NOT INCLUDED, because it is not shifted: `parallaxRate(0)` is 1 and the offset is
 * exactly zero. An unlayered document therefore reports NOTHING and pays nothing, which is what
 * keeps this callable on every frame of every pan.
 */
export function parallaxIds<T extends { nodes: ReadonlyMap<string, { depth?: number }> }>(
    doc: T
): Set<string> {
    const out = new Set<string>();
    doc.nodes.forEach((n, id) => { if (depthOf(n) !== 0) out.add(id); });
    return out;
}

/**
 * The document with every layered node shifted to where its depth says it belongs.
 *
 * A DERIVATION, applied by the app beside the frame and the active state, and for the same
 * reason: everything downstream — layout, picking, marquee selection, snapping, all three
 * backends — reads geometry, so shifting a node here shifts it for all of them at once. Doing it
 * in the renderer instead would draw a shape somewhere it could not be clicked.
 *
 * Returned BY REFERENCE when no node is layered, which is the common case and must cost nothing:
 * this runs on every pan, and a pan is the most frequent thing a person does to a canvas.
 */
export function applyParallax<T extends {
    nodes: ReadonlyMap<string, { depth?: number; geometry: { x: number; y: number } }>;
}>(doc: T, viewport: { x: number; y: number; zoom: number }): T {
    let any = false;
    doc.nodes.forEach(n => { if (depthOf(n) !== 0) any = true; });
    if (!any) return doc;

    const nodes = new Map<string, unknown>();
    doc.nodes.forEach((n, id) => {
        const offset = parallaxOffset(depthOf(n), viewport);
        nodes.set(id, offset.x === 0 && offset.y === 0
            ? n
            // Only the POSITION moves. Size is deliberately untouched: a layer that also shrank
            // with distance would read as the shape resizing itself, and a designer who set a
            // width would find the document disagreeing with them.
            : { ...n, geometry: { ...n.geometry, x: n.geometry.x + offset.x, y: n.geometry.y + offset.y } });
    });
    return { ...doc, nodes } as unknown as T;
}
