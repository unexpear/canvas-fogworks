/**
 * @module Resolve
 * @description Arbitrary contours made SIMPLE — the primitive everything downstream assumed it had.
 *
 * A path a person draws is not a well-formed polygon. It crosses itself, it doubles back, it has
 * contours that overlap each other, and what it MEANS is not the outline but the outline plus a
 * FILL RULE. Every consumer below this point wanted a simpler thing than that:
 *
 *   - `Tessellate` ear-clips, and ear clipping is defined only for a simple polygon. Handed a
 *     pentagram — five points drawn as one self-crossing contour, which is how anyone draws one —
 *     it found no ear at the crossings and emitted a partial fan. It said so in its own comments;
 *     this is the thing that makes the comment unnecessary.
 *   - `ConvexDecompose` inherits that, because it starts from the triangles.
 *   - `StrokeOutline` produces self-overlapping rings whenever a stroke is wide relative to the
 *     corner it turns, and documented that no single ring could express the result. Under a fill
 *     rule it can: the overlap is a union, and a union is what this computes.
 *   - picking and the two rasterizing backends have always applied the NONZERO rule and nothing
 *     else, so `fill-rule: evenodd` — which SVG and Canvas both implement natively, and which
 *     every design tool exposes — could not be expressed by a document at all.
 *
 * The method is the one `PathBoolean` already uses, turned on a single input instead of two:
 *
 *   1. Split every edge wherever it crosses ANY edge, including edges of its own contour. After
 *      this no two edges cross except at endpoints, so each piece lies wholly inside or wholly
 *      outside the filled region.
 *   2. Ask, for each piece, whether the region on its LEFT is filled and whether the region on its
 *      RIGHT is. A piece is part of the boundary exactly when those two answers differ — an edge
 *      with fill on both sides is interior scaffolding and an edge with fill on neither is a
 *      leftover, and both are dropped.
 *   3. Direct every kept piece so the filled side is on its left. That single convention is what
 *      makes the output nonzero-fillable no matter which rule went in: holes come out wound
 *      opposite their outer boundary because their filled side faces the other way.
 *   4. Chain the pieces back into closed loops.
 *
 * What comes out is a set of rings that do not cross, do not overlap, and mean the same region
 * under the NONZERO rule that the input meant under the rule asked for. That is what lets one
 * conversion serve every consumer: after resolving, "the fill rule" is no longer a question
 * anybody downstream has to carry.
 *
 * COST is O(n²) in edges, the same as the booleans, and for the same reason: every pair has to be
 * considered. It is therefore not free per frame on a large path, and the callers that run per
 * frame say where they cache it.
 *
 * KNOWN LIMIT, inherited and stated rather than hidden: exactly collinear overlapping edges are
 * not special-cased, so a contour that doubles back along itself keeps a seam a full sweep-line
 * implementation would resolve by rule. Crossings and touches are handled.
 */

import { FILL_RULES, FillRule, PathCommand } from "../document/Node";
import { BooleanOp, Piece, Ring, chainPieces, commandsToRings, ringsToCommands, splitAgainst, windingAt } from "./PathBoolean";

// The vocabulary is the DOCUMENT's (`document/Node`), re-exported so a caller doing geometry has
// one import rather than two — the same arrangement the stroke joins and caps use.
export { FILL_RULES };
export type { FillRule };

/**
 * How far off an edge to look when asking what is on either side of it.
 *
 * After splitting, edges meet only at endpoints, so a point a little to the side of an edge's
 * MIDPOINT is inside one face or the other and never on a boundary. The probe therefore only has
 * to be smaller than the distance from that midpoint to the nearest other edge, and larger than
 * the noise in coordinates that were themselves computed by intersecting lines. 1e-6 sits three
 * orders above `PathBoolean`'s point-matching epsilon and far below any feature a design document
 * has — a shape with detail finer than a millionth of a unit has already lost to that epsilon.
 */
const PROBE = 1e-6;

/** Point identity for de-duplicating coincident survivors, at `PathBoolean`'s own epsilon. */
const KEY_EPS = 1e-9;
const key = (p: { x: number; y: number }): string => `${Math.round(p.x / KEY_EPS)},${Math.round(p.y / KEY_EPS)}`;

/** Number of times a ray from the point crosses the rings — the EVEN-ODD rule's raw material. */
export function crossingCount(rings: readonly Ring[], x: number, y: number): number {
    let n = 0;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[j], b = ring[i];
            // The same half-open ray test `windingAt` uses, counted rather than signed — so a
            // vertex exactly on the ray is counted once, not twice or never.
            if ((a.y <= y) !== (b.y <= y)) {
                const t = (y - a.y) / (b.y - a.y);
                if (a.x + t * (b.x - a.x) > x) n++;
            }
        }
    }
    return n;
}

/**
 * Is the point inside, under the given rule?
 *
 * The one place the two rules differ, so that everything else can be written once. NONZERO asks
 * whether the contours wind around the point at all; EVEN-ODD asks only how many boundaries lie
 * between the point and infinity, which is why a shape drawn as one self-crossing contour has a
 * hole under one rule and not the other.
 */
export function insideRule(rings: readonly Ring[], x: number, y: number, rule: FillRule): boolean {
    return rule === "evenodd" ? crossingCount(rings, x, y) % 2 !== 0 : windingAt(rings, x, y) !== 0;
}

/**
 * Arbitrary contours as SIMPLE, non-overlapping rings meaning the same region under NONZERO.
 *
 * Idempotent on input that is already simple and nonzero-wound: every edge of such a ring has fill
 * on exactly one side and is already directed with it on the left, so it survives unchanged. That
 * matters because callers resolve indiscriminately rather than trying to detect whether they need
 * to — detecting self-intersection costs the same O(n²) as fixing it.
 *
 * Returns [] when the region is empty, which is a real answer: two identical contours wound
 * oppositely cancel exactly, and so does a figure-eight under the even-odd rule.
 */
export function resolveRings(rings: readonly Ring[], rule: FillRule = "nonzero"): Ring[] {
    const usable = rings.filter(r => r.length >= 3);
    return resolveWith(usable, (x, y) => insideRule(usable, x, y, rule));
}

/**
 * The general form: arbitrary contours as simple rings bounding wherever `filled` says.
 *
 * `resolveRings` is this with a fill rule; `resolveBoolean` is this with a boolean's membership
 * test. Both want exactly the same thing — the set of edge pieces where the answer CHANGES across
 * the edge — and that framing is what makes it robust at coincident edges, which is where the
 * older midpoint-classifying boolean fails. A midpoint that lies exactly ON another shape's
 * boundary has no defined inside/outside; the two points either side of it do.
 */
export function resolveWith(rings: readonly Ring[], filled: (x: number, y: number) => boolean): Ring[] {
    const usable = rings.filter(r => r.length >= 3);
    if (usable.length === 0) return [];

    const kept: Piece[] = [];
    const seen = new Set<string>();
    for (const piece of splitAgainst(usable, usable)) {
        const dx = piece.to.x - piece.from.x, dy = piece.to.y - piece.from.y;
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        const mx = (piece.from.x + piece.to.x) / 2, my = (piece.from.y + piece.to.y) / 2;
        // The step is perpendicular, so its ABSOLUTE size is `PROBE` whatever the piece's length
        // — dividing by `len` only undoes the un-normalised direction vector. The cap therefore
        // guards one specific thing: a piece so short that its neighbours' edges begin closer than
        // the probe reaches, where a fixed step would sample the wrong face. It is DEFENSIVE and
        // not mutation-killable — removing it changes nothing on any input this engine produces,
        // because flattening never emits a feature within a millionth of a unit of another. It
        // stays for the same reason `chainPieces`'s dead-end branch does: the failure it prevents
        // is silent and lands on screen. Note it does NOT protect against a thin SLIVER, whose
        // edges are long and close; nothing here does, and that is the module's stated epsilon.
        const t = Math.min(PROBE, len / 4) / len;
        const leftFilled = filled(mx - dy * t, my + dx * t);
        const rightFilled = filled(mx + dy * t, my - dx * t);
        if (leftFilled === rightFilled) continue;             // interior or stray: not a boundary
        const directed = leftFilled ? piece : { from: piece.to, to: piece.from };
        // DEDUPED, and only coincident input can produce a duplicate. Two shapes that share an
        // edge each contribute that edge, and both copies survive the probe because both have the
        // same face on the same side — so a union of a shape with ITSELF came out as two identical
        // rings stacked. It fills correctly under nonzero, which is exactly why it would have gone
        // unnoticed, but this module's whole promise is rings that do not overlap. After directing,
        // coincident survivors point the same way (fill is on the left of both), so identity of
        // the directed endpoints is the right test rather than an unordered one.
        const k = `${key(directed.from)}|${key(directed.to)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        kept.push(directed);
    }
    return chainPieces(kept);
}

/**
 * The boolean of two sets of closed rings — the one this engine uses.
 *
 * It replaces a version that classified each edge piece by whether its MIDPOINT lay inside the
 * other shape. That works until the two shapes share an edge, at which point the midpoint sits
 * exactly ON the other's boundary and "inside" has no answer: a ray cast from a boundary point
 * lands on the parity of its own rounding. The visible consequence was not subtle — the UNION and
 * the INTERSECTION of two axis-aligned rectangles at the same `y` came back EMPTY, and two
 * rectangles merely touching edge-to-edge unioned to nothing. Aligning two rectangles and merging
 * them is close to the most ordinary thing anybody does with a boolean tool, and it silently did
 * nothing. `subtract` and `exclude` happened to survive, which is why it went unnoticed: three of
 * the four operations have a test that passes.
 *
 * Framing it as "where does membership CHANGE across this edge" removes the question rather than
 * answering it more carefully. The probe samples the two points either side of the piece, never
 * the piece itself, so a coincident edge is classified by the faces it separates — which is
 * defined even when the edge lies on top of another.
 *
 * The membership tests are the operations' own definitions, nothing more: a point is in the union
 * when it is in either, in the intersection when it is in both, and so on. NONZERO on each side
 * separately rather than on the combined set, because two shapes wound oppositely would otherwise
 * cancel where they overlap and turn a union into an exclusion.
 */
export function resolveBoolean(a: readonly Ring[], b: readonly Ring[], op: BooleanOp): Ring[] {
    const ra = a.filter(r => r.length >= 3);
    const rb = b.filter(r => r.length >= 3);
    if (ra.length === 0 && rb.length === 0) return [];
    const inA = (x: number, y: number) => windingAt(ra, x, y) !== 0;
    const inB = (x: number, y: number) => windingAt(rb, x, y) !== 0;
    const filled = (x: number, y: number): boolean => {
        switch (op) {
            case "union": return inA(x, y) || inB(x, y);
            case "intersect": return inA(x, y) && inB(x, y);
            case "subtract": return inA(x, y) && !inB(x, y);
            case "exclude": return inA(x, y) !== inB(x, y);
        }
    };
    return resolveWith([...ra, ...rb], filled);
}

/** The same, on path commands — flattened in, converted back out. */
export function resolveBooleanPaths(a: readonly PathCommand[], b: readonly PathCommand[], op: BooleanOp): PathCommand[] {
    return ringsToCommands(resolveBoolean(commandsToRings(a), commandsToRings(b), op));
}
