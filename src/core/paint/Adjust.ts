/**
 * @module Adjust
 * @description Destructive colour adjustments — brightness, contrast, HSV, posterize and the rest.
 *
 * The audit's next gap after selection, and the shape this codebase is best at: a family of small
 * pure functions over a buffer, each independently testable, each with one decision in it.
 *
 * EVERY ONE HAS THE SAME SIGNATURE `(buffer, ...args) => number`, which is not a coincidence — it is
 * the shape `surfaceEditAction` takes, so a new adjustment needs no adapter, no action of its own and
 * no plumbing: it becomes a panel button by being written. The number is HOW MANY PIXELS CHANGED,
 * and it is the difference between an undo step and no undo step.
 *
 * THEY ARE DESTRUCTIVE, and that is a decision rather than a shortcut. The alternative is an
 * adjustment LAYER — a non-destructive stack re-evaluated per frame — which is a schema change, a
 * derivation-chain change and a render-model change all at once, and which every one of these
 * functions would still be needed to implement. Destructive first is the small part done well; the
 * layer, if it comes, is a caller.
 *
 * ALPHA IS NEVER TOUCHED, by any of them. Inverting alpha turns an erased area opaque, brightening
 * it makes a transparent corner solid, and neither is ever what "adjust the colours" meant. The one
 * consequence worth stating: these change what a pixel LOOKS like, never whether it is there.
 *
 * FULLY TRANSPARENT PIXELS ARE SKIPPED ENTIRELY. Their RGB is invisible, so changing it changes
 * nothing a person can see — but it does enlarge the patch every edit has to store and undo, and on
 * a mostly-empty sprite that is most of the surface. Measured in the count, which is why the count
 * is "pixels changed" rather than "pixels visited".
 */

import { Rgba } from "./PixelBuffer";

/** The mid-point of the 0..255 range. NOT 128 — see `adjustContrast`. */
export const MID = 127.5;

/** How many levels `posterize` will accept. One level is not a picture; 256 is the input. */
export const POSTERIZE_MIN = 2;
export const POSTERIZE_MAX = 256;

/** A byte, from any arithmetic. */
function byte(v: number): number {
    // ROUNDED, THEN CLAMPED. `Uint8ClampedArray` would clamp on assignment and round half-to-even —
    // banker's rounding — which is a different answer from `Math.round` at exactly .5 and would make
    // a hand-computed expectation disagree with the code for no reason anybody could find.
    return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Apply a per-pixel colour map to a whole buffer, in place. Returns how many pixels CHANGED.
 *
 * MEMOISED BY COLOUR, for the reason `quantizeToPalette` is: an image has far more pixels than
 * distinct colours, and every function here is a pure map from one colour to another. A 4096-square
 * photograph is 16.7 million pixels and rarely more than a few hundred thousand colours; a sprite is
 * usually under fifty.
 *
 * THE MAP TAKES AND RETURNS RGB ONLY. Alpha is carried through untouched by construction rather than
 * by convention — a map that could return an alpha would eventually return one.
 */
export function mapColours(
    buffer: { width: number; height: number; data: Uint8ClampedArray },
    map: (r: number, g: number, b: number) => [number, number, number]
): number {
    const seen = new Map<number, number>();
    let changed = 0;
    for (let i = 0; i < buffer.data.length; i += 4) {
        // SKIPPED BEFORE THE MAP IS EVEN ASKED: a transparent pixel's colour is not a colour anybody
        // sees, and mapping it would put invisible bytes into every patch.
        if (buffer.data[i + 3] === 0) continue;
        const r = buffer.data[i], g = buffer.data[i + 1], b = buffer.data[i + 2];
        const key = (r << 16) | (g << 8) | b;
        let out = seen.get(key);
        if (out === undefined) {
            const [nr, ng, nb] = map(r, g, b);
            out = (byte(nr) << 16) | (byte(ng) << 8) | byte(nb);
            seen.set(key, out);
        }
        if (out === key) continue;
        buffer.data[i] = (out >> 16) & 255;
        buffer.data[i + 1] = (out >> 8) & 255;
        buffer.data[i + 2] = out & 255;
        changed++;
    }
    return changed;
}

/**
 * Add `amount` (-255..255) to every channel.
 *
 * ADDITIVE, NOT MULTIPLICATIVE, which is what "brightness" means in every editor that has both: a
 * multiply is `value` in HSV terms and leaves black black, while an add lifts the whole range and is
 * what an artist reaches for when a sprite is too dark. Both exist here; this is the one that moves
 * black.
 */
export function adjustBrightness(
    buffer: { width: number; height: number; data: Uint8ClampedArray }, amount: number
): number {
    if (amount === 0) return 0;
    return mapColours(buffer, (r, g, b) => [r + amount, g + amount, b + amount]);
}

/**
 * Stretch or compress the range about its middle. `amount` is a percentage: 0 changes nothing, +100
 * doubles the distance from mid-grey, -100 collapses everything to mid-grey.
 *
 * THE PIVOT IS 127.5, NOT 128, and that is the whole of what makes this reversible-looking. The
 * range 0..255 has its true centre half a step above 127, so pivoting on 128 pulls every image
 * imperceptibly toward black — invisible once, and a visible drift after ten applications, which is
 * exactly how an adjustment gets blamed on the file format.
 */
export function adjustContrast(
    buffer: { width: number; height: number; data: Uint8ClampedArray }, amount: number
): number {
    if (amount === 0) return 0;
    const k = (100 + amount) / 100;
    return mapColours(buffer, (r, g, b) => [
        (r - MID) * k + MID, (g - MID) * k + MID, (b - MID) * k + MID
    ]);
}

/**
 * A colour's hue (0..360), saturation and value (0..1).
 *
 * HSV RATHER THAN HSL, because it is what pixel-art tools use and what an artist's mental model of a
 * ramp is: a shade ramp is one hue at falling VALUE, and HSL's lightness turns both ends to grey.
 */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    // THE MAX CHANNEL DECIDES THE SECTOR, and a grey (d === 0) has no hue at all rather than an
    // arbitrary one — returning 0 for it keeps the round trip exact instead of inventing red.
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return [h, max === 0 ? 0 : d / max, max / 255];
}

/** The colour a hue/saturation/value names, back in 0..255. Hue wraps; s and v are clamped. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const hue = ((h % 360) + 360) % 360;
    const sat = Math.max(0, Math.min(1, s));
    const val = Math.max(0, Math.min(1, v));
    const c = val * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = val - c;
    const sector = Math.floor(hue / 60) % 6;
    const rgb: [number, number, number] =
        sector === 0 ? [c, x, 0] : sector === 1 ? [x, c, 0] : sector === 2 ? [0, c, x]
        : sector === 3 ? [0, x, c] : sector === 4 ? [x, 0, c] : [c, 0, x];
    return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

/**
 * Rotate the hue by `hueShift` degrees and scale saturation and value.
 *
 * ONE FUNCTION FOR THREE CONTROLS, because they share the conversion: doing them separately would
 * mean three round trips through HSV per pixel, and each round trip can lose a unit to rounding — so
 * "shift the hue, then desaturate a little" would come out different from doing both at once, for
 * reasons an artist could never see the cause of.
 *
 * The scales are MULTIPLIERS, so 1 is unchanged. That makes "half the saturation" 0.5 rather than
 * -50, which is the same choice `value` makes and keeps the two controls reading alike.
 */
export function adjustHsv(
    buffer: { width: number; height: number; data: Uint8ClampedArray },
    hueShift: number, saturationScale: number, valueScale: number
): number {
    if (hueShift === 0 && saturationScale === 1 && valueScale === 1) return 0;
    return mapColours(buffer, (r, g, b) => {
        const [h, s, v] = rgbToHsv(r, g, b);
        return hsvToRgb(h + hueShift, s * saturationScale, v * valueScale);
    });
}

/**
 * Every pixel to its grey, by perceived brightness.
 *
 * REC.601 LUMA (0.299, 0.587, 0.114), and it is worth saying why this is NOT the 2:4:3 weighting
 * `Quantize.colourDistance` uses: that one weights SQUARED DIFFERENCES for a distance metric, this
 * one is a linear combination for a luminance. They answer different questions and sharing a
 * constant would make one of them wrong — the plain average is what looks obviously wrong, turning
 * a saturated blue into a mid-grey that reads far too light.
 */
export function desaturate(buffer: { width: number; height: number; data: Uint8ClampedArray }): number {
    return mapColours(buffer, (r, g, b) => {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        return [y, y, y];
    });
}

/**
 * The photographic negative: every channel to `255 - v`.
 *
 * ALPHA IS NOT INVERTED — see the module header. An inverted alpha turns everything the artist
 * erased into solid paint and everything they drew into nothing, which is not a negative of the
 * picture but a destruction of it.
 */
export function invertColours(buffer: { width: number; height: number; data: Uint8ClampedArray }): number {
    return mapColours(buffer, (r, g, b) => [255 - r, 255 - g, 255 - b]);
}

/**
 * Reduce each channel to `levels` evenly spaced steps.
 *
 * THE ENDPOINTS SURVIVE, which is the whole difficulty and the reason this is not `floor(v / step) *
 * step`. That naive form maps 255 to 240 at 16 levels, so a white sprite comes out grey and a
 * black-and-white one loses its white — the quantiser has to divide the RANGE into `levels - 1`
 * intervals, not the values into `levels` buckets.
 *
 * Fewer than two levels is refused rather than clamped: "one level" is a solid colour, which is not
 * what anybody meant by posterize, and the arithmetic would divide by zero.
 */
export function posterize(
    buffer: { width: number; height: number; data: Uint8ClampedArray }, levels: number
): number {
    const n = Math.round(levels);
    if (!Number.isFinite(n) || n < POSTERIZE_MIN || n > POSTERIZE_MAX) return 0;
    const step = 255 / (n - 1);
    const quantise = (v: number) => Math.round(v / step) * step;
    return mapColours(buffer, (r, g, b) => [quantise(r), quantise(g), quantise(b)]);
}

/**
 * Repaint every pixel matching `from` as `to`.
 *
 * `same` IS INJECTED, exactly as `wandSelection` takes it, so what "matching" means stays the
 * caller's decision — an exact match and a tolerance are both legitimate and neither belongs baked
 * in here. It also keeps one rule in the app: the panel hands over the same matcher the magic wand
 * uses, so "select this colour" and "replace this colour" cannot come to disagree about which pixels
 * they mean.
 *
 * THE REPLACEMENT'S ALPHA IS IGNORED, like every other adjustment here: this changes what a pixel
 * looks like, never whether it is there. Erasing a colour is the bucket's job, with a transparent
 * swatch.
 */
export function replaceColour(
    buffer: { width: number; height: number; data: Uint8ClampedArray },
    from: Rgba, to: Rgba,
    same: (a: readonly number[], b: readonly number[]) => boolean
): number {
    return mapColours(buffer, (r, g, b) => {
        // THE ALPHA HANDED TO THE MATCHER IS THE TARGET'S OWN, so a matcher that compares four
        // channels is not deciding on a channel this function refuses to change. Without it, an
        // exact matcher would never fire on a semi-transparent pixel and the reason would be
        // invisible from the panel.
        if (!same([r, g, b, from[3]], from)) return [r, g, b];
        return [to[0], to[1], to[2]];
    });
}
