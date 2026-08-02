/**
 * @module ConvexDecompose
 * @description A shape as CONVEX pieces — the decomposition that makes area queries one test.
 *
 * `Tessellate` already cuts a shape into triangles, which is what a GPU needs. Triangles are the
 * finest decomposition there is, and finer is not better for everything else: a query that has to
 * visit every piece wants as FEW pieces as possible, and it wants each one convex, because
 * convexity is what turns a hard geometric question into an easy one.
 *
 * The question this exists for is OVERLAP — does this shape touch that region. For two convex
 * polygons the SEPARATING AXIS THEOREM answers it completely: if no line separates them they
 * intersect, and one polygon lying entirely inside the other is not a special case, it is just an
 * absence of separating axes. For CONCAVE polygons no such theorem holds, and the usual
 * substitute — test every edge pair for crossing, then test a vertex of each inside the other —
 * is three separate cases, two of which exist only to catch containment. Decomposing first
 * replaces all three with one uniform test.
 *
 * The method is HERTEL–MEHLHORN: triangulate, then merge neighbouring pieces back together
 * wherever the merge stays convex. It is the standard approach for the good reason that it is
 * cheap on top of a triangulation one already has, and it guarantees no more than four times the
 * fewest possible pieces — a bound worth having, since the alternative (an optimal decomposition)
 * is dynamic programming in O(n³) for a result no consumer here could tell apart.
 *
 * Every piece it emits is built from the INPUT's own vertices. Ear clipping invents no points, and
 * merging two polygons along a shared edge invents none either, so a decomposed shape sits exactly
 * on the geometry it came from — the same promise flattening and the booleans make.
 */

import { Point, Ring } from "./PathBoolean";
import { signedArea2, triangulate } from "./Tessellate";

/** Below this a cross product counts as a straight corner rather than a turn. */
const EPS = 1e-9;

/** A vertex key exact enough to match two triangles that share an edge, and no looser. */
function key(p: Point): string {
    return `${p.x},${p.y}`;
}

/**
 * Is the ring convex, walking in the given direction?
 *
 * Collinear corners are allowed — a merge that leaves three points in a line produces a piece that
 * is still convex in every sense a caller cares about, and rejecting it would split shapes at
 * corners that are not corners.
 */
export function isConvexRing(ring: Ring): boolean {
    if (ring.length < 3) return false;
    let sign = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], c = ring[(i + 2) % ring.length];
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(cross) <= EPS) continue;
        const s = cross > 0 ? 1 : -1;
        if (sign === 0) sign = s;
        else if (s !== sign) return false;
    }
    return true;
}

/**
 * Merge two rings across the edge they share, or null when they do not share one.
 *
 * Both rings wind the same way, so a shared internal edge is walked in OPPOSITE directions by its
 * two owners — `a → b` in one and `b → a` in the other. That is what identifies the edge, and it
 * is also what makes the merge a matter of splicing rather than of geometry: walk the first ring
 * from `b` all the way round to `a`, then the second from `a` round to `b`.
 */
function mergeAcrossSharedEdge(p: Ring, q: Ring): Ring | null {
    for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        for (let j = 0; j < q.length; j++) {
            // The shared edge, seen the other way round.
            if (key(q[j]) !== key(b) || key(q[(j + 1) % q.length]) !== key(a)) continue;
            // Everything EXCEPT the shared edge's own traversal: from `p`, the run that starts
            // after `b` and ends at `a`; from `q`, the run that starts after `a` and ends at `b`.
            // Each contributes `length - 1` vertices, so neither `a` nor `b` is emitted twice.
            const out: Ring = [];
            for (let k = 2; k <= p.length; k++) out.push(p[(i + k) % p.length]);
            for (let k = 2; k <= q.length; k++) out.push(q[(j + k) % q.length]);
            return out;
        }
    }
    return null;
}

/** Upper bound on the triangles one decomposition will consider — the OOM guard's twin. */
export const DECOMPOSE_MAX_PIECES = 20_000;

/**
 * Rings as CONVEX pieces covering exactly the same area.
 *
 * Holes and islands need no special handling here because they needed none in `triangulate`
 * either: it resolves them into one triangle list by signed area, and a triangle list has no
 * memory of which ring a triangle came from. So a donut decomposes into convex pieces that
 * together cover the ring and leave the hole empty, without this module knowing what a hole is.
 *
 * Returns [] for degenerate input, exactly as `triangulate` does — a shape with no area is a
 * legitimate mid-edit state, not an error.
 */
export function convexPieces(rings: readonly Ring[]): Ring[] {
    const flat = triangulate(rings);
    const pieces: Ring[] = [];
    for (let i = 0; i + 5 < flat.length; i += 6) {
        pieces.push([
            { x: flat[i], y: flat[i + 1] },
            { x: flat[i + 2], y: flat[i + 3] },
            { x: flat[i + 4], y: flat[i + 5] }
        ]);
    }
    if (pieces.length > DECOMPOSE_MAX_PIECES) return [];

    // Greedy merging. Hertel-Mehlhorn is usually written as "delete every inessential diagonal",
    // which is the same thing said from the diagonals' side; said from the pieces' side it needs
    // no diagonal bookkeeping, and each step is one question with a yes/no answer a test can ask
    // directly. Its guarantee does not depend on the ORDER diagonals are removed in, which is what
    // lets this grow one piece to exhaustion before moving on rather than restarting the whole
    // scan after every merge — the difference between O(P²) and O(P³), and this now runs on the
    // marquee path where P is the triangle count of a path being dragged over.
    for (let i = 0; i < pieces.length; i++) {
        for (let j = i + 1; j < pieces.length; j++) {
            const candidate = mergeAcrossSharedEdge(pieces[i], pieces[j]);
            if (!candidate || !isConvexRing(candidate)) continue;
            pieces[i] = candidate;
            pieces.splice(j, 1);
            j = i;                     // the piece grew: rescan for neighbours it did not touch before
        }
    }
    return pieces;
}

/** The axes to test: one outward normal per edge. Duplicates cost a little time and no accuracy. */
function axes(ring: Ring, out: Point[]): void {
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) out.push({ x: -dy, y: dx });
    }
}

function project(ring: Ring, ax: Point): { min: number; max: number } {
    let min = Infinity, max = -Infinity;
    for (const p of ring) {
        const d = p.x * ax.x + p.y * ax.y;
        if (d < min) min = d;
        if (d > max) max = d;
    }
    return { min, max };
}

/**
 * Do two CONVEX rings share any area? — the separating axis theorem, and nothing else.
 *
 * Touching counts as overlap: the marquee that grazes a shape's edge selects it, which is the
 * behaviour the box-select tests already pin ("overlap, not containment"). Containment needs no
 * mention at all — a polygon inside another admits no separating axis, so it falls out.
 *
 * Convexity is a PRECONDITION, not something this checks. Handed a concave ring it will report
 * overlap for a region that only touches the ring's hull, which is why the only way in is through
 * `convexPieces`.
 *
 * TWO points is a legitimate operand. A segment is a convex set with no area, and SAT does not
 * care about area — which is what lets the ink of a `core.line` and of an unfilled path be tested
 * by the same routine as the ink of a filled one.
 */
export function convexOverlaps(a: Ring, b: Ring): boolean {
    if (a.length < 2 || b.length < 2) return false;
    const ax: Point[] = [];
    axes(a, ax);
    axes(b, ax);
    for (const axis of ax) {
        const pa = project(a, axis), pb = project(b, axis);
        // A strict gap is a separating axis. Equality is a touch, and a touch is a hit.
        if (pa.max < pb.min || pb.max < pa.min) return false;
    }
    return true;
}

/** Does any piece of a decomposed shape meet the convex region `region`? */
export function piecesOverlap(pieces: readonly Ring[], region: Ring): boolean {
    for (const piece of pieces) if (convexOverlaps(piece, region)) return true;
    return false;
}

/** A rectangle as a ring, wound to match what `convexPieces` emits (either winding is fine for SAT). */
export function rectRing(x: number, y: number, width: number, height: number): Ring {
    return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}

/** Total area of a decomposition — the number that must equal the shape it came from. */
export function piecesArea(pieces: readonly Ring[]): number {
    let a = 0;
    for (const piece of pieces) a += Math.abs(signedArea2(piece)) / 2;
    return a;
}

/**
 * Does any EDGE of these subpaths meet the convex region?
 *
 * For ink with no AREA — a `core.line`, or a path drawn as a stroke and never filled — the shape
 * IS its outline, so there is nothing to decompose and the pieces would come back empty. Each
 * segment is convex on its own, so the same overlap test applies unchanged; only the operands are
 * different. This mirrors `hitsShape`, which switches on exactly the same distinction for a click.
 *
 * `closed` says whether the last point joins back to the first. An open subpath that silently
 * closed would gain an edge the author never drew, and a marquee near that phantom edge would
 * select a shape that is not there.
 */
export function edgesOverlap(
    subpaths: readonly { points: readonly Point[]; closed: boolean }[], region: Ring
): boolean {
    for (const sub of subpaths) {
        const n = sub.points.length;
        if (n === 1) {
            // A lone point still has a position, and a marquee over it should find it.
            if (convexOverlaps([sub.points[0], sub.points[0]], region)) return true;
            continue;
        }
        const last = sub.closed ? n : n - 1;
        for (let i = 0; i < last; i++) {
            if (convexOverlaps([sub.points[i], sub.points[(i + 1) % n]], region)) return true;
        }
    }
    return false;
}
