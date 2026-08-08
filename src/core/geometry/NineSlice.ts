/**
 * @module NineSlice
 * @description A bitmap stretched without stretching its corners — the nine rectangles it becomes.
 *
 * A panel, a button, a speech bubble: art whose border must keep its thickness at any size while
 * its middle grows. Four insets cut the source into nine regions; the corners draw at their native
 * size, the edges stretch along one axis, the middle stretches along both. Every 2D engine has
 * this — Unity's sprite border, Godot's `NinePatchRect`, CSS's `border-image-slice` — and it is
 * the one thing all of them had that this engine did not.
 *
 * SOLVED HERE, AS GEOMETRY, RATHER THAN THREE TIMES IN THREE BACKENDS. Each backend already knows
 * how to draw one sub-rectangle of an image into one destination rectangle: Canvas has the
 * nine-argument `drawImage`, SVG a nested `<svg viewBox>`, the GPU a quad with a uv rect. So the
 * whole feature is a list of (source, destination) pairs, computed once, and each backend doing
 * nine of what it already does. A clever per-backend trick — a shader remap here, a pattern there
 * — would be three implementations to keep in step and three ways to disagree.
 *
 * INSETS ARE IN SOURCE PIXELS, relative to the region being drawn, which is what makes them a
 * property of the ART. A border is four pixels of a nine-pixel bitmap however large the box is;
 * expressing it as a fraction of the box would make it thicken as the panel grew, which is the
 * exact thing nine-slice exists to prevent.
 *
 * STRETCHED, NOT TILED. Engines offer both — Godot's axis stretch mode, CSS's `border-image-repeat`
 * — and tiling needs a repeat count, a decision about partial tiles, and a different answer per
 * axis. Stretching is the common case and the one every backend can already do; tiling would be a
 * second mode and is not pretended to exist.
 */

import { Rect } from "./Matrix";

/** How far in from each edge the corners reach, in the SOURCE region's own pixels. */
export interface NineSliceInsets {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** One piece: where to read, and where to put it. Both in the spaces their names imply. */
export interface Slice {
    /** In the image's own pixels. */
    src: Rect;
    /** In the node's local units. */
    dst: Rect;
}

/**
 * Two opposing insets reduced to fit inside `limit`, keeping their ratio.
 *
 * WHAT EVERY OTHER ANSWER GETS WRONG. A 12-pixel border drawn into an 8-pixel-tall box cannot have
 * both corners at native size, and the alternatives are worse than scaling: clamping only one side
 * makes the shape asymmetric, clipping makes the corners lose the very detail they exist for, and
 * letting them overlap draws the same pixels twice with whatever the blend mode happens to be.
 * Scaling both is what CSS `border-image` does and what the result looks like anywhere else.
 */
function fitPair(a: number, b: number, limit: number): [number, number] {
    const total = a + b;
    if (total <= limit || total <= 0) return [a, b];
    const k = limit / total;
    return [a * k, b * k];
}

/**
 * The nine (source, destination) pairs for one nine-sliced image.
 *
 * `source` is the region of the bitmap being drawn — the whole image, or a sprite's rect inside an
 * atlas. `dest` is the node's box in local units. Insets are clamped against the SOURCE first,
 * because a corner cannot contain more pixels than exist, and then against the DESTINATION, which
 * is where a box too small for its own border is resolved.
 *
 * A ZERO-EXTENT PIECE IS OMITTED rather than emitted at zero size. Every backend would either
 * refuse it or draw something undefined — Canvas throws on a zero-width source rect — and a panel
 * whose middle has collapsed genuinely has eight pieces, not nine with a hole.
 */
export function nineSliceRects(source: Rect, dest: Rect, insets: NineSliceInsets): Slice[] {
    const [sl, sr] = fitPair(Math.max(0, insets.left), Math.max(0, insets.right), source.width);
    const [st, sb] = fitPair(Math.max(0, insets.top), Math.max(0, insets.bottom), source.height);
    const [dl, dr] = fitPair(sl, sr, dest.width);
    const [dt, db] = fitPair(st, sb, dest.height);

    // Three columns and three rows, each as (offset, extent) in its own space. The middle takes
    // whatever the two edges left behind, which is what makes the edges keep their size.
    const cols: [number, number, number, number][] = [
        [source.x, sl, dest.x, dl],
        [source.x + sl, source.width - sl - sr, dest.x + dl, dest.width - dl - dr],
        [source.x + source.width - sr, sr, dest.x + dest.width - dr, dr]
    ];
    const rows: [number, number, number, number][] = [
        [source.y, st, dest.y, dt],
        [source.y + st, source.height - st - sb, dest.y + dt, dest.height - dt - db],
        [source.y + source.height - sb, sb, dest.y + dest.height - db, db]
    ];

    const out: Slice[] = [];
    for (const [sy, sh, dy, dh] of rows) {
        for (const [sx, sw, dx, dw] of cols) {
            if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) continue;
            out.push({
                src: { x: sx, y: sy, width: sw, height: sh },
                dst: { x: dx, y: dy, width: dw, height: dh }
            });
        }
    }
    return out;
}
