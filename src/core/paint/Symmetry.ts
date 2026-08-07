/**
 * @module Symmetry
 * @description Mirrored drawing — one stroke that paints two, four, or one.
 *
 * A signature pixel-art tool: turn on horizontal symmetry and a character's left side draws its
 * right. It belongs here rather than in a paint tool because it is pure arithmetic over a point,
 * and because putting it in the tool would mean the line tool, the fill and the shapes each grew
 * their own copy — three copies that can disagree about where the axis is.
 *
 * THE AXIS IS BETWEEN PIXELS, NOT ON ONE. A surface of width W mirrors `x` to `W - 1 - x`, so
 * column 0 pairs with the last column and nothing is left over. Placing the axis at `W / 2` instead
 * is the classic off-by-one: the two halves come out a pixel apart, which on a 16-pixel sprite is
 * immediately visible and on a 400-pixel canvas is not — so it ships.
 *
 * A POINT ON THE AXIS MIRRORS TO ITSELF, and is returned ONCE. Stamping it twice costs nothing for
 * an opaque pencil and is wrong for anything that accumulates, which every blending mode does —
 * so the duplicate is removed here rather than in each tool that might one day blend.
 */

/** Which way a stroke is mirrored. */
export interface SymmetryMode {
    /** Mirror left/right about the surface's vertical centre line. */
    horizontal: boolean;
    /** Mirror top/bottom about the horizontal centre line. */
    vertical: boolean;
}

export const NO_SYMMETRY: SymmetryMode = { horizontal: false, vertical: false };

/**
 * Every point a stamp at `(x, y)` should paint.
 *
 * The original comes FIRST, so a caller that only wants one point can take the head rather than
 * having to know which of several is the real one.
 *
 * Points outside the surface are NOT dropped — `setPixel` already bounds every dab, and dropping
 * them here would be a second bounds rule that could disagree with that one.
 */
export function symmetryPoints(
    x: number, y: number, width: number, height: number, mode: SymmetryMode
): [number, number][] {
    const mx = width - 1 - x;
    const my = height - 1 - y;
    const points: [number, number][] = [[x, y]];
    // DE-DUPLICATED BY VALUE rather than by testing whether the point sits on an axis. An axis test
    // has to know that an even width has no centre column while an odd one does, and get both
    // right; comparing the mirrored coordinate to the original cannot get that wrong.
    const add = (px: number, py: number) => {
        if (points.some(p => p[0] === px && p[1] === py)) return;
        points.push([px, py]);
    };
    if (mode.horizontal) add(mx, y);
    if (mode.vertical) add(x, my);
    // THE DIAGONAL is only painted when BOTH axes are on — it is the mirror of a mirror, and a
    // tool that added it for either one alone would paint a phantom in the opposite corner.
    if (mode.horizontal && mode.vertical) add(mx, my);
    return points;
}

/** Whether a mode paints anything beyond the original point. */
export function isMirrored(mode: SymmetryMode): boolean {
    return mode.horizontal || mode.vertical;
}
