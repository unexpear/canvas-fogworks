/**
 * @module Quantize
 * @description Snapping a colour to the palette an artist chose.
 *
 * Pixel art is usually made under a palette constraint — 32 colours, and nothing else — and the
 * tool that enforces it is this: whatever the colour picker or an imported image hands over, the
 * nearest palette entry is what gets painted. Without it a palette is a suggestion.
 *
 * DISTANCE IS WEIGHTED, NOT PLAIN. Equal steps in R, G and B are not equal steps to an eye: green
 * carries most of the perceived brightness and blue almost none. A plain sum-of-squares picks a
 * blue-ish match for a grey and looks visibly wrong while being arithmetically closest, so the
 * channels are weighted 2:4:3 — the cheap approximation every palette tool uses, and enough to be
 * right about the cases a plain distance is wrong about.
 *
 * ALPHA IS A WALL, NOT A CHANNEL. A transparent pixel must never snap to an opaque colour however
 * near its RGB happens to be — an erased area would fill in with paint. Transparency matches only
 * transparency, and everything else competes on colour.
 */

import { Rgba } from "./PixelBuffer";
import { Palette } from "./Palette";

/** Perceptual weights for R, G and B. Green dominates, blue barely registers. */
const WEIGHT_R = 2;
const WEIGHT_G = 4;
const WEIGHT_B = 3;

/**
 * How far apart two colours look, squared.
 *
 * Squared because only the ORDER matters and a square root is a cost per comparison that changes
 * no answer. Alpha is compared separately by the caller, not folded in here.
 */
export function colourDistance(a: Rgba, b: Rgba): number {
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return WEIGHT_R * dr * dr + WEIGHT_G * dg * dg + WEIGHT_B * db * db;
}

/**
 * The palette entry nearest `colour`, or null when the palette holds nothing usable.
 *
 * TIES GO TO THE FIRST, so the same input always gives the same output. A palette often holds two
 * entries equidistant from a grey, and a tool that picked either would make an imported image
 * quantize differently on each run — which looks like a broken importer rather than a tie.
 */
export function nearestColour(palette: Palette, colour: Rgba): Rgba | null {
    // A FULLY TRANSPARENT input stays transparent rather than snapping to the nearest paint: an
    // erased area would otherwise fill in, which is the one result a user can never want.
    if (colour[3] === 0) return [0, 0, 0, 0];
    let best: Rgba | null = null;
    let bestDistance = Infinity;
    for (const entry of palette.colours) {
        // Transparent SLOTS are holes in the grid, not colours to match — a palette with a gap
        // would otherwise quantize half an image to nothing.
        if (entry[3] === 0) continue;
        const d = colourDistance(colour, entry);
        // STRICTLY less, which is what makes the first of a tie win.
        if (d < bestDistance) { bestDistance = d; best = entry; }
    }
    // The input's ALPHA is kept rather than the entry's: a palette states colours, and how
    // transparent a pixel is belongs to the pixel.
    return best ? [best[0], best[1], best[2], colour[3]] : null;
}

/**
 * Every pixel of a buffer snapped to the palette, in place.
 *
 * Returns how many pixels changed, so a caller can tell a quantize that did nothing from one that
 * did — and so an editor can skip pushing an undo step for a no-op.
 */
export function quantizeToPalette(
    buffer: { width: number; height: number; data: Uint8ClampedArray }, palette: Palette
): number {
    // MEMOISED BY COLOUR. An image has far more pixels than distinct colours — a photograph might
    // be a million pixels and a few thousand colours — and the search is linear in the palette, so
    // repeating it per pixel does the same work thousands of times.
    const seen = new Map<number, Rgba | null>();
    let changed = 0;
    for (let i = 0; i < buffer.data.length; i += 4) {
        const r = buffer.data[i], g = buffer.data[i + 1], b = buffer.data[i + 2], a = buffer.data[i + 3];
        // The key folds ALPHA in, because a transparent pixel resolves differently from an opaque
        // one with the same RGB — and a cache that ignored that would paint over erased areas.
        const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
        let mapped = seen.get(key);
        if (mapped === undefined) {
            mapped = nearestColour(palette, [r, g, b, a]);
            seen.set(key, mapped);
        }
        if (!mapped) continue;
        if (mapped[0] === r && mapped[1] === g && mapped[2] === b && mapped[3] === a) continue;
        buffer.data[i] = mapped[0];
        buffer.data[i + 1] = mapped[1];
        buffer.data[i + 2] = mapped[2];
        buffer.data[i + 3] = mapped[3];
        changed++;
    }
    return changed;
}
