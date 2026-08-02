/**
 * @module Tessellate
 * @description Filled shapes as TRIANGLES — the form a GPU can draw.
 *
 * Everything above this point describes a fill as an outline plus a fill rule, because that is
 * what SVG and Canvas take. A GPU takes triangles and nothing else, so somebody has to do the
 * conversion; doing it here, purely, means the WebGL backend stays the same kind of dumb
 * transcriber the other two are, and the hard part is testable in the `node` environment like
 * every other piece of geometry in this codebase.
 *
 * The method is EAR CLIPPING, chosen for the same reason edge classification was chosen for the
 * booleans: every step is separately checkable. A vertex is an "ear" when the triangle it forms
 * with its neighbours is convex and contains no other vertex; clipping it removes one vertex and
 * leaves a smaller polygon of the same shape. Repeat until three remain. It is O(n²) in the worst
 * case, which is the right trade here — the alternative (a sweep-line/monotone decomposition) is
 * substantially more code for a speed-up that only matters at vertex counts a design document
 * does not reach, and this runs once per shape per change, not per frame.
 *
 * HOLES are handled by BRIDGING: each hole is joined to the outer ring by a doubled edge, turning
 * a ring-with-holes into one simple polygon. The bridge is invisible in the result because the
 * two halves of the doubled edge are coincident and enclose no area.
 */

import { Ring } from "./PathBoolean";

/** Twice the signed area of a ring — positive for one winding, negative for the other. */
export function signedArea2(ring: readonly { x: number; y: number }[]): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    }
    return a;
}

/** Cross product of (b−a) × (c−a): > 0 when a→b→c turns one way, < 0 the other. */
function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * Is `p` inside (or on) the triangle abc?
 *
 * Written with three same-sign cross products rather than barycentric coordinates so it needs no
 * division — a triangle degenerate enough to divide by zero is exactly the case an ear test meets
 * most often, and returning a sensible answer there matters more than speed.
 */
function pointInTriangle(
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number
): boolean {
    const d1 = cross(ax, ay, bx, by, px, py);
    const d2 = cross(bx, by, cx, cy, px, py);
    const d3 = cross(cx, cy, ax, ay, px, py);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
}

/** A vertex in the working polygon — a doubly linked ring, so clipping an ear is O(1). */
interface Vertex {
    x: number;
    y: number;
    prev: Vertex;
    next: Vertex;
    /** Set when the vertex has been clipped, so a stale reference can be recognised. */
    gone: boolean;
}

/**
 * Build a linked ring from points, dropping any that REPEATS its predecessor.
 *
 * A repeated vertex makes a zero-length edge, and a zero-length edge is never an ear: its corner
 * is degenerate, so the convexity test rejects it and clipping STALLS — the loop finds no ear and
 * bails with a partial fan. Found by tessellating a fully-rounded rectangle, where the radius
 * clamp turns the straight edges into zero-length `L`s: 116 triangles of the 130 needed, covering
 * 2365 of 7853 units. The shape is not unusual; any path with a doubled point does this.
 */
function toLinked(points: readonly { x: number; y: number }[]): Vertex {
    const EPS = 1e-12;
    const clean = points.filter((p, i) => {
        const prev = points[(i + points.length - 1) % points.length];
        return Math.abs(p.x - prev.x) > EPS || Math.abs(p.y - prev.y) > EPS;
    });
    let first: Vertex | null = null;
    let last: Vertex | null = null;
    for (const p of (clean.length >= 3 ? clean : points)) {
        const v: Vertex = { x: p.x, y: p.y, prev: null as unknown as Vertex, next: null as unknown as Vertex, gone: false };
        if (!first) { first = v; v.prev = v; v.next = v; } else {
            v.prev = last as Vertex;
            v.next = first;
            (last as Vertex).next = v;
            first.prev = v;
        }
        last = v;
    }
    return first as Vertex;
}

/** The ring as an array, walking `next` from `start`. */
function toArray(start: Vertex): Vertex[] {
    const out: Vertex[] = [];
    let v = start;
    do { out.push(v); v = v.next; } while (v !== start && out.length < 1e6);
    return out;
}

/**
 * Is the vertex `v` an ear of the polygon it belongs to?
 *
 * Two conditions, and both are needed: the corner must be CONVEX (a reflex corner's triangle
 * falls outside the polygon), and the triangle must contain no other REFLEX vertex (otherwise
 * clipping it would cut across a part of the shape that is still there).
 *
 * All three parts of that are load-bearing, and each is held by a shape that fails without it:
 * a STAR without convexity, a SLIT without containment, and — less obviously — the rounded
 * rectangle without the reflex restriction, because testing every vertex rejects legitimate ears
 * whose corner merely touches another vertex and clipping then stalls. It reads like a speed
 * filter and is not one.
 *
 * Convexity is tested as a strict turn, not merely "not reflex": a COLLINEAR corner would
 * otherwise be clipped into a triangle with no area, which paints nothing and costs a draw.
 */
function isEar(v: Vertex, all: readonly Vertex[]): boolean {
    const a = v.prev, b = v, c = v.next;
    if (cross(a.x, a.y, b.x, b.y, c.x, c.y) >= 0) return false;   // reflex or degenerate
    for (const p of all) {
        if (p === a || p === b || p === c || p.gone) continue;
        if (cross(p.prev.x, p.prev.y, p.x, p.y, p.next.x, p.next.y) >= 0
            && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y)) return false;
    }
    return true;
}

/**
 * Join a hole into the outer ring with a doubled ("bridge") edge.
 *
 * The hole's RIGHTMOST vertex is used as the anchor: a ray cast right from it is guaranteed to
 * leave the hole immediately, so the first outer edge it meets is visible from it. The outer
 * vertex chosen is the one on that edge nearer the ray's hit point — a vertex, not the hit point
 * itself, so no new coordinates are invented and the result stays exactly on the input geometry.
 *
 * Returns false when no outer vertex is visible, which happens only for input that is not a
 * ring-with-holes at all (a hole outside its outer ring). The caller then drops that hole rather
 * than emitting triangles for a shape it cannot describe.
 */
function bridgeHole(outer: Vertex, hole: Vertex): boolean {
    const holeVerts = toArray(hole);
    let anchor = holeVerts[0];
    for (const v of holeVerts) if (v.x > anchor.x) anchor = v;

    // The outer vertex to bridge to: among those to the RIGHT of the anchor and reachable, take
    // the one whose horizontal distance is smallest — the first thing the ray would meet.
    let best: Vertex | null = null;
    let bestDx = Infinity;
    for (const v of toArray(outer)) {
        if (v.x < anchor.x) continue;
        const dx = v.x - anchor.x + Math.abs(v.y - anchor.y) * 1e-9;   // tie-break toward the same row
        if (dx < bestDx) { bestDx = dx; best = v; }
    }
    if (!best) return false;

    // Splice: outer …→ best → anchor …(the hole)… → anchor' → best' → … outer. Both `best` and
    // `anchor` are duplicated, which is what makes the bridge a zero-area doubled edge.
    const bestCopy: Vertex = { x: best.x, y: best.y, prev: null as unknown as Vertex, next: null as unknown as Vertex, gone: false };
    const anchorCopy: Vertex = { x: anchor.x, y: anchor.y, prev: null as unknown as Vertex, next: null as unknown as Vertex, gone: false };
    const bestNext = best.next;
    const anchorPrev = anchor.prev;

    best.next = anchor;
    anchor.prev = best;
    anchorPrev.next = anchorCopy;
    anchorCopy.prev = anchorPrev;
    anchorCopy.next = bestCopy;
    bestCopy.prev = anchorCopy;
    bestCopy.next = bestNext;
    bestNext.prev = bestCopy;
    return true;
}

/** Upper bound on the vertices one shape may contribute — the OOM guard, like `PATH_MAX_COMMANDS`. */
export const TESSELLATE_MAX_VERTICES = 100_000;

/**
 * Rings as a flat triangle list: `[x0,y0, x1,y1, x2,y2, …]`, three points per triangle.
 *
 * Rings are classified by SIGNED AREA, not by position in the array: the largest-magnitude ring is
 * the outline and every ring wound the other way is a hole. That matches what the rest of the
 * engine already believes — the nonzero fill rule, which picking and both backends use — so a
 * donut tessellates with its hole rather than as two overlapping discs.
 *
 * Returns an empty list for degenerate input rather than throwing: a shape with no area is a
 * legitimate thing to have on a canvas mid-edit, and a renderer must not fall over on one.
 */
export function triangulate(rings: readonly Ring[]): number[] {
    const usable = rings.filter(r => r.length >= 3);
    if (usable.length === 0) return [];
    const total = usable.reduce((n, r) => n + r.length, 0);
    if (total > TESSELLATE_MAX_VERTICES) return [];

    // The OUTLINE is the ring enclosing the most area; the rest are holes if they wind the other
    // way. A same-winding second ring is a separate island and is tessellated on its own.
    const withArea = usable.map(r => ({ ring: r, area: signedArea2(r) }));
    withArea.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    const outline = withArea[0];
    const holes = withArea.slice(1).filter(r => Math.sign(r.area) !== Math.sign(outline.area));
    const islands = withArea.slice(1).filter(r => Math.sign(r.area) === Math.sign(outline.area));

    const out: number[] = [];
    tessellateOne(outline.ring, holes.map(h => h.ring), outline.area, out);
    // Islands are independent shapes sharing one path; each is tessellated with no holes of its
    // own. Nesting an island's own holes would need a containment tree, which no shape this
    // engine produces has yet asked for — stated rather than half-built.
    for (const island of islands) tessellateOne(island.ring, [], island.area, out);
    return out;
}

/** One outline plus its holes, appended to `out`. */
function tessellateOne(outline: Ring, holes: readonly Ring[], area: number, out: number[]): void {
    // Ear clipping needs ONE known winding to tell convex from reflex. Everything below assumes
    // clockwise-in-screen-space (negative signed area), and holes must run the other way so the
    // bridge does not fold the polygon onto itself.
    const outerPoints = area > 0 ? [...outline].reverse() : [...outline];
    let start = toLinked(outerPoints);
    for (const hole of holes) {
        const holeArea = signedArea2(hole);
        const holePoints = holeArea < 0 ? [...hole].reverse() : [...hole];
        if (!bridgeHole(start, toLinked(holePoints))) continue;   // not actually inside — drop it
    }

    // Re-dedupe AFTER bridging. A hole that TOUCHES the outer ring shares a vertex with it, and
    // the bridge to that vertex is zero-length: the splice emits it twice in a row at both ends of
    // the doubled edge. A zero-length edge is never an ear, so clipping stalled immediately and a
    // pentagram under the even-odd rule — whose central hole meets the star at all five crossings
    // — produced no triangles at all. Collapsing the repeats turns the degenerate bridge into
    // exactly the right thing: the outline entering the hole at the shared vertex and leaving by
    // it, which is the splice one would write by hand for that case.
    start = toLinked(toArray(start));

    let verts = toArray(start);
    // Every clip removes one vertex, so the loop is bounded by the vertex count; the guard is
    // there for input the ear test cannot make progress on (a self-intersecting ring), where
    // stopping with a partial fan beats spinning.
    let guard = verts.length * 2;
    while (verts.length > 3 && guard-- > 0) {
        let clipped = false;
        for (const v of verts) {
            if (v.gone || !isEar(v, verts)) continue;
            out.push(v.prev.x, v.prev.y, v.x, v.y, v.next.x, v.next.y);
            v.gone = true;
            v.prev.next = v.next;
            v.next.prev = v.prev;
            start = v.next;
            clipped = true;
            break;
        }
        // No ear found: the ring is not simple (a bowtie), so emit what is done. This break is a
        // PERFORMANCE early-out, not the safety net — `guard` already bounds the loop, which is
        // why replacing it with `continue` changes no output, only wasted iterations.
        if (!clipped) break;
        verts = toArray(start);
    }
    if (verts.length === 3) out.push(verts[0].x, verts[0].y, verts[1].x, verts[1].y, verts[2].x, verts[2].y);
}
