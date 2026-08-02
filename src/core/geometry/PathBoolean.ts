/**
 * @module PathBoolean
 * @description Union, subtract, intersect and exclude on closed shapes.
 *
 * The method is edge classification, which is the one polygon-boolean scheme whose every step can
 * be checked on its own:
 *
 *   1. Split every edge of A wherever it crosses an edge of B, and vice versa. After this no two
 *      edges cross anywhere except at their endpoints, so each piece is wholly inside or wholly
 *      outside the other shape.
 *   2. Classify each piece by testing its MIDPOINT — the one point on a piece guaranteed not to
 *      be an endpoint, and therefore not on a boundary the test would have to break a tie on.
 *   3. Keep the pieces the operation asks for, reversing B's when subtracting (a hole runs the
 *      other way round, which is exactly what the nonzero fill rule reads).
 *   4. Chain the kept pieces back into closed loops by joining endpoints.
 *
 * Curves are FLATTENED first (`flattenPath`), so a boolean of two curved shapes returns polylines,
 * not curves. That is a real loss of fidelity and it is deliberate: exact bezier-bezier clipping
 * needs curve-curve intersection and splitting, which is a much larger piece of work, and an
 * approximation that is honest about being one beats a curve-preserving result that is subtly
 * wrong at the joins. The resolution is `flattenPath`'s fixed 16 segments per curve.
 *
 * KNOWN LIMIT, stated rather than hidden: shapes that share an edge exactly (collinear overlap)
 * are not special-cased. A shared edge is classified by its midpoint like any other, which keeps
 * the result closed and sane but can keep or drop a seam that a full sweep-line implementation
 * would resolve by rule. Shapes that merely touch at a point, or overlap normally, are fine.
 */

import { PathCommand } from "../document/Node";
import { flattenPath } from "./ShapeHit";

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";

export interface Point { x: number; y: number; }
/** A closed ring. The closing edge (last → first) is implied, never stored. */
export type Ring = Point[];

/**
 * How close two coordinates must be to count as the same point.
 *
 * Chaining edges back into loops is endpoint MATCHING, and an intersection computed from two
 * different edge pairs lands on the same place only to within rounding. Too small and loops fail
 * to close; too large and distinct nearby vertices merge. 1e-9 is far below any coordinate a
 * document uses and far above double-precision noise on those coordinates.
 */
const EPS = 1e-9;

const key = (p: Point): string => `${Math.round(p.x / EPS)},${Math.round(p.y / EPS)}`;
const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

/** Signed winding of `rings` about a point — the nonzero fill rule, summed across rings. */
function windingAt(rings: readonly Ring[], x: number, y: number): number {
    let w = 0;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[j], b = ring[i];
            if (a.y <= y) {
                if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) w++;
            } else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) {
                w--;
            }
        }
    }
    return w;
}

/** Is a point inside a set of rings (nonzero rule)? */
export function insideRings(rings: readonly Ring[], x: number, y: number): boolean {
    return windingAt(rings, x, y) !== 0;
}

/**
 * The parameters along `p→p2` at which it crosses any edge of `rings`.
 *
 * Only proper crossings and touches STRICTLY inside the segment matter: a hit exactly at t=0 or
 * t=1 is already a vertex, and splitting there would emit a zero-length piece that the chaining
 * step would then have to filter out anyway.
 */
function crossings(p: Point, p2: Point, rings: readonly Ring[]): number[] {
    const ts: number[] = [];
    const rx = p2.x - p.x, ry = p2.y - p.y;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const q = ring[j], q2 = ring[i];
            const sx = q2.x - q.x, sy = q2.y - q.y;
            const denom = rx * sy - ry * sx;
            if (denom === 0) continue;              // parallel (collinear overlap is the known limit)
            const t = ((q.x - p.x) * sy - (q.y - p.y) * sx) / denom;
            const u = ((q.x - p.x) * ry - (q.y - p.y) * rx) / denom;
            if (t > EPS && t < 1 - EPS && u >= -EPS && u <= 1 + EPS) ts.push(t);
        }
    }
    return ts.sort((a, b) => a - b);
}

/** One directed piece of an edge after splitting. */
interface Piece { from: Point; to: Point; }

/** Every edge of `rings`, split wherever it crosses `other`. */
function splitAgainst(rings: readonly Ring[], other: readonly Ring[]): Piece[] {
    const out: Piece[] = [];
    for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            // No zero-length guard here: a repeated vertex makes `crossings` degenerate (its
            // direction vector is zero, so every determinant is), and the `!same(prev, b)` test
            // below then drops the piece. A separate guard looked like it was doing that work and
            // was provably equivalent to nothing — a mutation of it changed no behaviour at all.
            let prev = a;
            for (const t of crossings(a, b, other)) {
                const cut = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
                if (!same(prev, cut)) out.push({ from: prev, to: cut });
                prev = cut;
            }
            if (!same(prev, b)) out.push({ from: prev, to: b });
        }
    }
    return out;
}

/** Pieces whose midpoint is inside / outside the other shape, optionally reversed. */
function select(pieces: readonly Piece[], other: readonly Ring[], wantInside: boolean, reverse: boolean): Piece[] {
    const out: Piece[] = [];
    for (const piece of pieces) {
        const mx = (piece.from.x + piece.to.x) / 2, my = (piece.from.y + piece.to.y) / 2;
        if (insideRings(other, mx, my) !== wantInside) continue;
        out.push(reverse ? { from: piece.to, to: piece.from } : piece);
    }
    return out;
}

/**
 * Join pieces end-to-start into closed rings.
 *
 * Pieces are consumed as they are used, so a vertex where several pieces meet (two shapes
 * crossing at a point) hands out each continuation exactly once instead of looping forever.
 *
 * A run that cannot be closed is DROPPED rather than emitted open: an unclosed ring would fill as
 * if a straight line joined its ends, which draws a shape nobody asked for. That branch is
 * DEFENSIVE and not mutation-killable — for well-formed input every kept piece has a continuation,
 * so no test can reach it without hand-building a piece list the splitter cannot produce. It stays
 * because the alternative failure is silent and visible on screen.
 */
function chain(pieces: readonly Piece[]): Ring[] {
    const byStart = new Map<string, Piece[]>();
    for (const piece of pieces) {
        const k = key(piece.from);
        const list = byStart.get(k);
        if (list) list.push(piece); else byStart.set(k, [piece]);
    }
    const take = (k: string): Piece | undefined => {
        const list = byStart.get(k);
        if (!list || list.length === 0) return undefined;
        const piece = list.pop() as Piece;
        if (list.length === 0) byStart.delete(k);
        return piece;
    };

    const rings: Ring[] = [];
    for (const seed of pieces) {
        // Already consumed by an earlier walk? `take` is the only way a piece leaves the map,
        // so a seed that cannot be taken from its own start key has been used.
        const list = byStart.get(key(seed.from));
        if (!list || !list.includes(seed)) continue;
        list.splice(list.indexOf(seed), 1);
        if (list.length === 0) byStart.delete(key(seed.from));

        const ring: Ring = [seed.from];
        let current = seed;
        // Bounded by the piece count: every step consumes one, so this cannot spin.
        for (let guard = 0; guard <= pieces.length; guard++) {
            if (same(current.to, seed.from)) { rings.push(ring); break; }
            ring.push(current.to);
            const next = take(key(current.to));
            if (!next) break;                       // dead end → drop this run
            current = next;
        }
    }
    return rings.filter(r => r.length >= 3);
}

/** The boolean of two sets of closed rings. */
export function booleanRings(a: readonly Ring[], b: readonly Ring[], op: BooleanOp): Ring[] {
    const aPieces = splitAgainst(a, b);
    const bPieces = splitAgainst(b, a);
    switch (op) {
        case "union":
            return chain([...select(aPieces, b, false, false), ...select(bPieces, a, false, false)]);
        case "intersect":
            return chain([...select(aPieces, b, true, false), ...select(bPieces, a, true, false)]);
        case "subtract":
            // A minus B: keep A outside B, plus B's pieces INSIDE A wound the other way — the
            // reversal is what makes the removed part read as a hole under the nonzero rule.
            return chain([...select(aPieces, b, false, false), ...select(bPieces, a, true, true)]);
        case "exclude":
            // (A−B) ∪ (B−A): every outside piece of both, which leaves the overlap unfilled
            // because nothing bounds it any more.
            return chain([...select(aPieces, b, false, false), ...select(bPieces, a, false, false),
                ...select(aPieces, b, true, true), ...select(bPieces, a, true, true)]);
    }
}

/** Closed rings as drawing commands — one `M …L…Z` subpath per ring. */
export function ringsToCommands(rings: readonly Ring[]): PathCommand[] {
    const out: PathCommand[] = [];
    for (const ring of rings) {
        if (ring.length < 3) continue;
        out.push({ c: "M", x: ring[0].x, y: ring[0].y });
        for (let i = 1; i < ring.length; i++) out.push({ c: "L", x: ring[i].x, y: ring[i].y });
        out.push({ c: "Z" });
    }
    return out;
}

/**
 * Drawing commands as closed rings — the input side of a boolean.
 *
 * Every subpath is treated as CLOSED, whether or not it ends in `Z`, for the same reason picking
 * does: a filled open subpath paints as though it were closed, so that is the region a boolean
 * has to operate on. A trailing point equal to the first is dropped, since the closing edge is
 * implied and storing it twice would make a zero-length edge.
 */
export function commandsToRings(commands: readonly PathCommand[]): Ring[] {
    const rings: Ring[] = [];
    for (const sub of flattenPath(commands)) {
        const pts = sub.points.slice();
        while (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();
        if (pts.length >= 3) rings.push(pts);
    }
    return rings;
}

/** The boolean of two paths, flattened to polylines. */
export function booleanPaths(a: readonly PathCommand[], b: readonly PathCommand[], op: BooleanOp): PathCommand[] {
    return ringsToCommands(booleanRings(commandsToRings(a), commandsToRings(b), op));
}
