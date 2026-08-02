/**
 * @module StrokeOutline
 * @description A stroke as an OUTLINE — the shape a border actually covers, as fillable rings.
 *
 * Until now a stroke was something only a rasterizer knew about: SVG and Canvas take a width and
 * a colour and draw the border themselves, so no layer of this engine ever had to know what area
 * a border occupies. Three things wanted that answer and could not have it — a GPU (which fills
 * triangles and cannot "stroke"), an OUTLINE STROKE command (turn the border into an editable
 * shape, which every design tool has), and stroke ALIGNMENT (inside/outside the path, which
 * neither SVG nor Canvas can express). This module is that answer, and it is pure geometry, so
 * all three get the same one.
 *
 * The method is POLYLINE OFFSETTING. The path is flattened by the same adaptive subdivision
 * picking and tessellation use (`flattenPath`), each side of the centreline is offset, and the
 * corners are resolved. Offsetting a cubic exactly produces a curve that is not itself a cubic —
 * the honest options are to approximate the offset with more cubics or to flatten first, and
 * flattening first means the result is exact to the same stated tolerance as everything else this
 * engine flattens, rather than exact to a different one.
 *
 * The interesting part is the corners, and the two sides of a corner are NOT symmetric:
 *
 *   - the OUTER side opens up, leaving a gap that the JOIN fills — a miter (extend both edges to
 *     their intersection, falling back to a bevel past `miterLimit`, exactly as SVG defines it),
 *     a round arc, or a bevel.
 *   - the INNER side folds over itself. The correct outline there is the two offset edges TRIMMED
 *     to their intersection, and that is what this computes whenever the intersection lands
 *     within both edges. Emitting them untrimmed would make a self-intersecting ring, which the
 *     nonzero fill rule hides in SVG and Canvas and the triangulator cannot — the same stroke
 *     would look right on two backends and wrong on the third.
 *
 * When no trim exists — a stroke wider than the segments it turns through — the fallback runs the
 * outline through the centreline vertex. That removes the FOLD at that corner and under-fills it
 * slightly; it is not a promise of a simple ring, and the promise is not available: a stroke wide
 * enough to cover itself describes a region no single ring can express. What is guaranteed is
 * that every join stays within `miterLimit` half-widths of a centreline vertex, so the outline is
 * bounded by the path's own box grown by that much and a degenerate corner cannot throw a spike.
 */

import { DEFAULT_MITER_LIMIT, PathCommand, STROKE_CAPS, STROKE_JOINS, StrokeCap, StrokeJoin } from "../document/Node";
import { Point, Ring } from "./PathBoolean";
import { FLATTEN_TOLERANCE, Subpath, flattenPath } from "./ShapeHit";

// The join and cap vocabularies are the DOCUMENT's (`document/Node`), re-exported here so a
// caller doing geometry has one import rather than two. Alignment is not among them, and that is
// the point: it is not a document field, because no backend could draw it.
export { STROKE_JOINS, STROKE_CAPS, DEFAULT_MITER_LIMIT };
export type { StrokeJoin, StrokeCap };

/**
 * Where the stroke sits relative to the path.
 *
 * "center" is what SVG and Canvas draw and the only one they can express. The other two are why
 * this module produces geometry rather than parameters: an inside border keeps the shape's
 * silhouette exactly, which is what a UI frame usually wants, and neither backend can do it.
 */
export const STROKE_ALIGNS = ["center", "inner", "outer"] as const;
export type StrokeAlign = typeof STROKE_ALIGNS[number];

export interface StrokeStyle {
    width: number;
    join?: StrokeJoin;
    cap?: StrokeCap;
    /** Ratio of miter length to stroke width past which a miter becomes a bevel. Default 4. */
    miterLimit?: number;
    align?: StrokeAlign;
}

/** Squared length below which two points count as one — the twin of `toLinked`'s dedupe. */
const EPS2 = 1e-18;
/** Below this |sin| between neighbouring directions a corner is straight and needs no join. */
const COLLINEAR = 1e-12;

interface Seg {
    /** Unit direction. */
    dx: number;
    dy: number;
    len: number;
}

function segments(points: readonly Point[], closed: boolean): Seg[] {
    const out: Seg[] = [];
    const n = points.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
        const a = points[i], b = points[(i + 1) % n];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        out.push({ dx: dx / len, dy: dy / len, len });
    }
    return out;
}

/**
 * Points on a circular arc from angle `a0` to `a1` about `c`, EXCLUSIVE of both ends.
 *
 * The step is chosen from the radius and the flatness tolerance, not from a fixed count: the
 * sagitta of a chord subtending `θ` on radius `r` is `r(1 − cos(θ/2))`, so the largest θ that
 * stays within `tol` is `2·acos(1 − tol/r)`. That keeps a round join on a hairline cheap and one
 * on a 200-unit border smooth, and — like every other flattening here — it reads the geometry
 * rather than the zoom, so the same path yields the same points at every magnification.
 */
function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, tol: number): Point[] {
    const sweep = a1 - a0;
    const out: Point[] = [];
    if (r <= tol) return out;                       // smaller than the tolerance: the join IS a point
    const maxStep = 2 * Math.acos(Math.max(-1, 1 - tol / r));
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / maxStep));
    for (let i = 1; i < steps; i++) {
        const a = a0 + (sweep * i) / steps;
        out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return out;
}

/** Intersection of the lines through p+t·u and q+s·v, or null when they are parallel. */
function lineIntersect(p: Point, u: Seg, q: Point, v: Seg): { point: Point; t: number; s: number } | null {
    const denom = u.dx * v.dy - u.dy * v.dx;
    if (Math.abs(denom) < COLLINEAR) return null;
    const t = ((q.x - p.x) * v.dy - (q.y - p.y) * v.dx) / denom;
    const s = ((q.x - p.x) * u.dy - (q.y - p.y) * u.dx) / denom;
    return { point: { x: p.x + u.dx * t, y: p.y + u.dy * t }, t, s };
}

/**
 * One side of the centreline as a chain of points.
 *
 * `dist` is SIGNED: positive offsets to the left of travel (the normal of `(dx, dy)` being
 * `(−dy, dx)`), negative to the right. Everything about which side of a corner is outer follows
 * from that sign, so the two sides share this one routine and cannot drift apart.
 */
function offsetChain(
    points: readonly Point[], closed: boolean, dist: number, style: StrokeStyle, tol: number
): Point[] {
    const segs = segments(points, closed);
    if (segs.length === 0) return [];
    const join = style.join ?? "miter";
    const miterLimit = style.miterLimit ?? DEFAULT_MITER_LIMIT;
    const n = points.length;
    const off = (p: Point, s: Seg): Point => ({ x: p.x - s.dy * dist, y: p.y + s.dx * dist });

    const chain: Point[] = [];
    const first = closed ? 0 : 1;
    const stop = closed ? n : n - 1;
    if (!closed) chain.push(off(points[0], segs[0]));

    for (let i = first; i < stop; i++) {
        const v = points[i];
        const prev = segs[(i - 1 + segs.length) % segs.length];
        const next = segs[i % segs.length];
        const a = off(v, prev), b = off(v, next);
        // Positive cross = the path turns left. The LEFT side (dist > 0) is then the inner one.
        const cross = prev.dx * next.dy - prev.dy * next.dx;
        if (Math.abs(cross) < COLLINEAR) { chain.push(a); continue; }
        const outer = dist > 0 ? cross < 0 : cross > 0;

        if (outer) {
            if (join === "bevel") { chain.push(a, b); continue; }
            if (join === "round") {
                const r = Math.abs(dist);
                const a0 = Math.atan2(a.y - v.y, a.x - v.x);
                let a1 = Math.atan2(b.y - v.y, b.x - v.x);
                // Sweep the SHORT way round — the long way would arc across the shape.
                while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
                while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
                chain.push(a, ...arcPoints(v.x, v.y, r, a0, a1, tol), b);
                continue;
            }
            // MITER: the two offset edges meet at the intersection of their lines. SVG measures
            // the limit as miter length / stroke width, and past it the join degrades to a bevel
            // — without that, a nearly-doubled-back corner throws a spike off to infinity.
            const hit = lineIntersect(a, prev, b, next);
            if (hit) {
                const half = Math.abs(dist);
                const miterLen = Math.hypot(hit.point.x - v.x, hit.point.y - v.y);
                if (half > 0 && miterLen / half <= miterLimit) { chain.push(hit.point); continue; }
            }
            chain.push(a, b);
            continue;
        }

        // INNER side: the two offset edges overlap, and the outline is where they cross. That
        // crossing is only the outline when it lies within BOTH edges, and it can fail in exactly
        // two ways — it can start before the incoming edge did (`t < 0`) or run past where the
        // outgoing one ends (`s > next.len`). The other two bounds are what "the offsets overlap
        // here" already means, so they are not checked: on the inner side the crossing is always
        // after the outgoing edge's start and before the incoming edge's end, and asserting it
        // would be asserting the branch condition twice.
        //
        // Both live bounds are load-bearing and an L with EQUAL arms fails them together, which
        // is why one alone looked sufficient at first: a 10-long elbow stroked 30 wide put the
        // inner boundary at x = -5, five units outside the shape.
        //
        // When neither holds, the stroke is wider than the corner can absorb and no trim exists;
        // the centreline vertex is the valid fallback (see the module note).
        const hit = lineIntersect(off(points[(i - 1 + n) % n], prev), prev, b, next);
        if (hit && hit.t >= 0 && hit.s <= next.len) chain.push(hit.point);
        else chain.push(a, v, b);
    }
    if (!closed) chain.push(off(points[n - 1], segs[segs.length - 1]));
    return chain;
}

/** The points that close an open stroke at one end — from `from` round to `to`, exclusive. */
function capPoints(end: Point, dir: Seg, from: Point, to: Point, cap: StrokeCap, half: number, tol: number): Point[] {
    if (cap === "square") {
        // Extend both edges by half the width along the direction of travel — a square cap is a
        // butt cap pushed out, which is exactly how SVG defines it.
        return [
            { x: from.x + dir.dx * half, y: from.y + dir.dy * half },
            { x: to.x + dir.dx * half, y: to.y + dir.dy * half }
        ];
    }
    if (cap === "round") {
        // `from` and `to` are the two OPPOSITE normals of the same direction, so the cap spans
        // exactly half a turn and the only question is which way round. It is always the way that
        // passes through the direction of travel — the other bulges back over the stroke — and
        // measured from `from` that is always the NEGATIVE half turn.
        //
        // An earlier version chose between the two by testing where the arc's midpoint pointed.
        // That test could only ever come out one way, for the reason above, so the branch it
        // guarded was unreachable: removed rather than left in as a decision the code never makes.
        const a0 = Math.atan2(from.y - end.y, from.x - end.x);
        return arcPoints(end.x, end.y, half, a0, a0 - Math.PI, tol);
    }
    return [];                                       // butt: the two edges meet directly
}

/** Consecutive duplicates removed — the offsets produce them at straight joins and zero-length caps. */
function dedupe(ring: Ring, closed: boolean): Ring {
    const out: Ring = [];
    for (const p of ring) {
        const q = out[out.length - 1];
        if (q && (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < EPS2) continue;
        out.push(p);
    }
    if (closed && out.length > 1) {
        const a = out[0], b = out[out.length - 1];
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 < EPS2) out.pop();
    }
    return out;
}

/** Twice the signed area — the winding test, duplicated nowhere: `Tessellate` exports the same idea. */
function area2(ring: Ring): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    return a;
}

/**
 * The area a stroke covers, as rings ready for `triangulate`, `ringsToCommands` or a nonzero fill.
 *
 * A CLOSED subpath contributes two rings — the outer edge and the inner edge as a hole, wound
 * opposite so the nonzero rule leaves the middle empty. An OPEN subpath contributes one ring: up
 * one side, round the cap, back the other, round the other cap.
 *
 * Alignment applies only where it means something. On a closed subpath "inner" and "outer" are
 * measured against the shape's own winding, so the result does not depend on which direction the
 * author happened to draw it. On an OPEN subpath there is no inside, and align is treated as
 * "center" rather than picking a side arbitrarily.
 *
 * Returns [] for a width of zero or less, or for a path with no length — a legitimate mid-edit
 * state, not an error.
 */
export function strokeOutline(
    commands: readonly PathCommand[], style: StrokeStyle, tolerance: number = FLATTEN_TOLERANCE
): Ring[] {
    if (!Number.isFinite(style.width) || style.width <= 0) return [];
    const cap = style.cap ?? "butt";
    const align = style.align ?? "center";
    const half = style.width / 2;
    const out: Ring[] = [];

    for (const sub of flattenPath(commands, tolerance)) {
        const points = dedupeSubpath(sub);
        if (points.length < 2) continue;

        if (!sub.closed) {
            // No inside to align against: centre it, and say so rather than guessing a side.
            const left = offsetChain(points, false, half, style, tolerance);
            const right = offsetChain(points, false, -half, style, tolerance);
            if (left.length === 0 || right.length === 0) continue;
            const segs = segments(points, false);
            const endDir = segs[segs.length - 1];
            const startDir = { dx: -segs[0].dx, dy: -segs[0].dy, len: segs[0].len };
            const revRight = [...right].reverse();
            const ring = [
                ...left,
                ...capPoints(points[points.length - 1], endDir, left[left.length - 1], revRight[0], cap, half, tolerance),
                ...revRight,
                ...capPoints(points[0], startDir, revRight[revRight.length - 1], left[0], cap, half, tolerance)
            ];
            const clean = dedupe(ring, true);
            if (clean.length >= 3) out.push(clean);
            continue;
        }

        // CLOSED: which side is outside follows from the winding, not from the sign of `dist`, so
        // an author who drew a rectangle anticlockwise gets the same inner border as one who
        // drew it clockwise.
        const outward = area2(points) > 0 ? -1 : 1;
        const outDist = align === "inner" ? 0 : align === "outer" ? style.width : half;
        const inDist = align === "outer" ? 0 : align === "inner" ? style.width : half;
        const outer = dedupe(offsetChain(points, true, outward * outDist, style, tolerance), true);
        const inner = dedupe(offsetChain(points, true, -outward * inDist, style, tolerance), true);
        if (outer.length < 3 || inner.length < 3) continue;
        // The hole must wind the other way for both the nonzero rule and `triangulate`.
        if (Math.sign(area2(outer)) === Math.sign(area2(inner))) inner.reverse();
        out.push(outer, inner);
    }
    return out;
}

/** A flattened subpath's points with consecutive duplicates and a repeated closing point removed. */
function dedupeSubpath(sub: Subpath): Point[] {
    const pts = dedupe(sub.points, sub.closed);
    return pts;
}
