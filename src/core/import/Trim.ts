/**
 * @module Trim
 * @description Cutting the transparent padding off a frame WITHOUT moving what it draws.
 *
 * The padding is not small. The measured stick-figure frames are 512x512 PNGs whose ink covers 4.0%
 * of the file; the rest is transparent, and it costs texture memory, fill rate, and a selection box
 * four times wider than the character it claims to be.
 *
 * TRIMMING NAIVELY IS WORSE THAN NOT TRIMMING, which is the thing to understand before reading any
 * of this. Each frame's ink sits at a different place inside its padding — across four consecutive
 * run frames the ink origin measured (223,210), (209,204), (222,208), (225,215), with sizes from
 * 106x165 to 122x146. Trim each frame to its own ink, drop them all into one box, and the character
 * jitters sixteen pixels sideways and changes size every frame. The padding was what held the
 * animation still.
 *
 * SO A TRIM IS A RECTANGLE AND A PLACEMENT, never a rectangle alone. Narrowing the source region is
 * paid for by moving and shrinking the destination by exactly the same proportion, which leaves
 * every pixel of ink precisely where it already was. A trim that changed what a frame LOOKS like
 * would be a bug wearing an optimisation's clothes.
 *
 * PURE, and it takes the ink measurement as an argument. Measuring needs pixels and lives in the
 * renderer; this is the arithmetic, which is the half that can be wrong in a way a test can catch.
 */

import { SourceRect } from "../document/Node";

/** A destination box, in the same terms a node's `geometry` uses. */
export interface TrimBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** What a trim decides: a narrower source region, and where it must now be drawn. */
export interface Trim {
    /** The tightened region, in the source image's own pixels. */
    source: SourceRect;
    /** Where that region goes, so the ink does not move. */
    box: TrimBox;
}

/**
 * The tightened source region and its matching placement, or null when there is nothing to draw.
 *
 * `ink` is in the SOURCE image's pixels — the same space as `source` — because that is what a pixel
 * scan naturally reports and converting it first would put a rounding step between the measurement
 * and its use.
 *
 * NULL FOR AN EMPTY FRAME rather than a zero-sized rect. A blank frame is a real thing in a
 * sequence (an attack that starts on nothing), and `sourceRectError` refuses a zero extent because
 * every backend divides by it — so the honest answer is "there is no region", which a caller can
 * act on by drawing nothing.
 */
export function trimmedPlacement(box: TrimBox, source: SourceRect, ink: SourceRect): Trim | null {
    // A DEGENERATE source is refused up front. Precisely: this is CLARITY, not correctness, and a
    // mutation removing it survives — a zero or negative extent makes the overlap test below fail
    // on its own, because the clipped far edge lands at or before the near one. It stays because
    // "you cannot scale from a cell with no width" is worth saying where the division is, rather
    // than leaving the next reader to find it two guards later.
    if (!(source.width > 0) || !(source.height > 0)) return null;
    // CLIPPED TO THE CELL first. An ink measurement taken over a whole sheet can report pixels that
    // belong to the neighbouring frame; anything outside this cell is not part of this frame, and
    // keeping it would widen the region into somebody else's drawing.
    const x0 = Math.max(source.x, ink.x);
    const y0 = Math.max(source.y, ink.y);
    const x1 = Math.min(source.x + source.width, ink.x + ink.width);
    const y1 = Math.min(source.y + source.height, ink.y + ink.height);
    if (!(x1 > x0) || !(y1 > y0)) return null;

    // THE SAME PROPORTION, which is the whole point. The destination is moved by the distance the
    // source moved and scaled by the amount the source shrank, so every pixel of ink lands exactly
    // where it already was and an animation that was steady stays steady.
    const scaleX = box.width / source.width;
    const scaleY = box.height / source.height;
    return {
        source: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        box: {
            x: box.x + (x0 - source.x) * scaleX,
            y: box.y + (y0 - source.y) * scaleY,
            width: (x1 - x0) * scaleX,
            height: (y1 - y0) * scaleY
        }
    };
}

/**
 * The union of several ink rectangles — the box that holds every frame of an animation.
 *
 * The alternative to trimming each frame separately, and often the better one: a character trimmed
 * to a COMMON box loses most of the padding while keeping every frame registered against the same
 * origin, so nothing can jitter by construction. On the measured run cycle the union is about a
 * quarter of the file where a per-frame trim reaches 4%, which is the trade — less saved, nothing
 * risked.
 */
export function inkUnion(rects: readonly SourceRect[]): SourceRect | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) {
        if (!(r.width > 0) || !(r.height > 0)) continue;
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.width);
        y1 = Math.max(y1, r.y + r.height);
    }
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
