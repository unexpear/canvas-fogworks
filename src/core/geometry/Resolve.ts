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

import { FILL_RULES, FillRule } from "../document/Node";
import { Piece, Ring, chainPieces, splitAgainst, windingAt } from "./PathBoolean";

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
    if (usable.length === 0) return [];

    const kept: Piece[] = [];
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
        const leftFilled = insideRule(usable, mx - dy * t, my + dx * t, rule);
        const rightFilled = insideRule(usable, mx + dy * t, my - dx * t, rule);
        if (leftFilled === rightFilled) continue;             // interior or stray: not a boundary
        kept.push(leftFilled ? piece : { from: piece.to, to: piece.from });
    }
    return chainPieces(kept);
}
