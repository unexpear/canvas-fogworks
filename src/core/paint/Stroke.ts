/**
 * @module Stroke
 * @description A drag, from the first press to the patch it becomes.
 *
 * The pieces to paint a stroke all exist — a brush, a buffer, a patch — and nothing joins them.
 * This does, and it is where the SEQUENCE lives: capture the region before anything is drawn, paint,
 * then diff. Getting that order wrong is the whole difficulty, and it is invisible afterwards
 * because the picture is right either way; only the undo is broken.
 *
 * THE BEFORE-IMAGE IS TAKEN ONCE, AT THE START. A stroke that captured per segment would record the
 * previous segment's paint as the "before" of the next, so undoing the stroke would leave most of
 * it on the canvas. A stroke that captured at the END would record no change at all.
 *
 * THE REGION IS THE WHOLE STROKE'S BOX, not each segment's. One patch per drag means one undo step
 * per drag — which is what a user means by "undo my last stroke" — and it is why the box has to be
 * known before the painting starts rather than accumulated as it goes.
 */

import { PixelBuffer, Rgba, PixelClip } from "./PixelBuffer";
import { Brush, strokePath, strokeBounds } from "./Brush";
import { rollAt, seedFrom } from "../random/Rng";
import { PixelPatch, EMPTY_PATCH, capturePatch, readRegion } from "./PixelPatch";

/** A stroke in progress: where it will paint, and what was there first. */
export interface StrokeSession {
    brush: Brush;
    colour: Rgba;
    /** Every point sampled so far, including the first press. */
    points: [number, number][];
    /** The clipped box the stroke may touch, and the bytes it held before anything was drawn. */
    region: { x: number; y: number; width: number; height: number };
    before: Uint8ClampedArray;
    /**
     * Which pixels this stroke may touch — a selection, captured with everything else at the press.
     *
     * ON THE SESSION RATHER THAN PASSED PER CALL, and that is deliberate. A stroke paints from three
     * places — the press's dot, each move's segment, and the mirrors — and a clip handed to some of
     * them and not the others is a selection the brush half-obeys. Held here, there is one answer for
     * the whole gesture, and it cannot change halfway through because the author clicked a panel.
     */
    clip?: PixelClip;
    /**
     * What this stroke's random faces follow from — the PRESS POINT, hashed.
     *
     * NOT A CLOCK AND NOT A COUNTER. The same drag has to leave the same marks, or a stroke could
     * not be replayed; two different drags should differ, or a variant brush would stamp one face
     * forever. The press point gives both for free and stores nothing: it is already part of the
     * gesture, and no two strokes start in the same place unless the author meant them to.
     */
    seed: number;
    /**
     * How many dabs this stroke has laid, which is the INDEX the next face is drawn at.
     *
     * COUNTED RATHER THAN STREAMED, because the symmetry mirrors are walked as separate passes over
     * COPIES of this session — `{ ...session, points: [from] }`. A copy takes this number by value,
     * so a mirror re-walks the same indices as the primary and lands on the same faces. A shared
     * stream would have advanced, and a symmetric stroke would come out with a different face on
     * each side.
     */
    dabs: number;
}

/** A rectangle clipped to a surface, or null when none of it lands. */
function clipToSurface(
    buffer: PixelBuffer, box: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } | null {
    const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y);
    const x1 = Math.min(buffer.width, box.x + box.width);
    const y1 = Math.min(buffer.height, box.y + box.height);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Begin a stroke at one point.
 *
 * `reach` is how far the drag is EXPECTED to travel, in pixels, and is what the captured region is
 * sized by. It has to be guessed because the future of a drag is unknown — and guessing generously
 * is free, since `capturePatch` narrows the result to what actually changed. Guessing too small is
 * not free: paint outside the captured region cannot be undone.
 */
export function beginStroke(
    buffer: PixelBuffer, brush: Brush, x: number, y: number, colour: Rgba, reach: number,
    clip?: PixelClip
): StrokeSession | null {
    const box = strokeBounds(brush, [[x, y]]);
    if (!box) return null;
    const grown = {
        x: box.x - reach, y: box.y - reach,
        width: box.width + reach * 2, height: box.height + reach * 2
    };
    const region = clipToSurface(buffer, grown);
    if (!region) return null;
    return {
        brush, colour, points: [[x, y]],
        region,
        // HASHED FROM WHERE THE PRESS LANDED — see `seed`. `seedFrom` is reused rather than a second
        // hash written here, so there is one answer to "what number does this text mean".
        seed: seedFrom(`${x},${y}`),
        dabs: 0,
        // BEFORE ANY PAINT. This is the line the whole module exists to get right.
        before: readRegion(buffer, region.x, region.y, region.width, region.height),
        // THE REGION IS NOT NARROWED TO THE CLIP, on purpose: the region is what can be UNDONE, and
        // a selection is not a promise about what will change — the clip is checked per dab, so a
        // region matching the selection's box would only make the two able to disagree.
        clip
    };
}

/**
 * Extend a stroke to a new point, painting the segment.
 *
 * Only the NEW segment is painted, not the whole path again. Repainting would be correct for an
 * opaque colour and wrong the moment anything blends — and it would turn a long drag quadratic.
 */
export function extendStroke(
    buffer: PixelBuffer, session: StrokeSession, x: number, y: number,
    line: (x0: number, y0: number, x1: number, y1: number) => [number, number][]
): void {
    const last = session.points[session.points.length - 1];
    session.points.push([x, y]);
    // THE COUNTER ADVANCES ON THIS SESSION and is read through a closure, so a mirror — which holds
    // a COPY of `dabs` — re-walks the same indices and picks the same faces.
    let at = session.dabs;
    strokePath(buffer, session.brush, [last, [x, y]], session.colour, line, session.clip,
        () => rollAt(session.seed, at++));
    session.dabs = at;
}

/**
 * Finish a stroke, as one patch.
 *
 * A press with no drag still paints — `beginStroke` records the point but paints nothing, so the
 * dot is stamped here. That keeps the "before" capture strictly ahead of every mark, rather than
 * having the first stamp happen before the region it belongs to was read.
 */
export function endStroke(
    buffer: PixelBuffer, session: StrokeSession,
    line: (x0: number, y0: number, x1: number, y1: number) => [number, number][]
): PixelPatch {
    if (session.points.length === 1) {
        strokePath(buffer, session.brush, session.points, session.colour, line, session.clip);
    }
    const patch = capturePatch(buffer, session.before,
        session.region.x, session.region.y, session.region.width, session.region.height);
    return patch;
}

/** Whether a stroke wandered outside the region captured for it — paint that cannot be undone. */
export function strokeEscaped(session: StrokeSession): boolean {
    const box = strokeBounds(session.brush, session.points);
    if (!box) return false;
    return box.x < session.region.x || box.y < session.region.y
        || box.x + box.width > session.region.x + session.region.width
        || box.y + box.height > session.region.y + session.region.height;
}

/** A patch that changed nothing, for a caller that needs one. */
export const NO_STROKE: PixelPatch = EMPTY_PATCH;
