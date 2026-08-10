/**
 * @module SelectionOutline
 * @description The marching ants — where a selection's edge is, as line segments.
 *
 * A mask is a byte per pixel and a marquee is a LINE, and turning one into the other is the only
 * thing standing between a selection that works and a selection nobody can see. Without it the mask
 * is honoured invisibly: the brush stops at a boundary the author cannot find.
 *
 * THE BOUNDING BOX IS NOT AN OUTLINE, and that is the shortcut this module exists to refuse. Drawing
 * `maskBounds` would be four segments for any shape, so a lasso, a wand's result and a rectangle
 * minus a bite would all look like the same rectangle — and the author would be told a lie about
 * exactly the thing they need to see.
 *
 * COORDINATES ARE GRID LINES, NOT PIXEL CENTRES. Pixel `(x, y)` occupies the square from `(x, y)` to
 * `(x + 1, y + 1)`, so the edge between two pixels has integer coordinates and the outline of a
 * single pixel is a unit square. Centres would put the line half a pixel inside the selection, which
 * at a high zoom is visibly wrong and at a low zoom is what makes an outline look like it is missing
 * a row.
 *
 * RUNS ARE MERGED, and the reason is arithmetic rather than tidiness: a 64x64 selection has 256 edge
 * pixels and 4 merged sides, and the renderer emits one draw item per segment. Unmerged, a marquee
 * would cost more items than the artwork.
 *
 * ONLY THE MASK'S OWN BOX IS SCANNED. An edge can only exist beside a selected pixel, so the bounds
 * are enough — which matters because a `PIXEL_MAX_SIDE` mask is 16.7 million cells and this runs per
 * frame while a drag is in flight.
 */

import { SelectionMask, isSelected, maskBounds } from "./Selection";

/** One straight run of a selection's edge, in surface GRID coordinates. */
export interface MaskSegment {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/**
 * Every segment of a mask's boundary, horizontal runs first then vertical.
 *
 * A HOLE IS AN EDGE TOO: the test is "selected here and not there", so the inside of a ring comes
 * back as its own loop. An implementation that walked only the outer contour would draw a ring as a
 * filled blob, and an author who subtracted a bite from a rectangle would see the bite ignored.
 */
export function maskOutline(mask: SelectionMask): MaskSegment[] {
    const box = maskBounds(mask);
    if (!box) return [];
    const segments: MaskSegment[] = [];
    const x0 = box.x, x1 = box.x + box.width, y0 = box.y, y1 = box.y + box.height;

    // HORIZONTAL runs, row by row: the top edge of a pixel whose neighbour above is not selected,
    // and the bottom edge of one whose neighbour below is not. Each is accumulated as a run and
    // flushed when it breaks, so a straight side is one segment however long it is.
    for (let y = y0; y < y1; y++) {
        for (const side of [0, 1]) {
            const edgeY = y + side;                 // 0 = the top edge, 1 = the bottom
            let runStart: number | null = null;
            for (let x = x0; x <= x1; x++) {
                const edge = x < x1 && isSelected(mask, x, y) && !isSelected(mask, x, y + (side === 0 ? -1 : 1));
                if (edge && runStart === null) runStart = x;
                // FLUSHED ON THE FIRST NON-EDGE, and the loop runs one past the box so a run that
                // reaches the last column is flushed rather than dropped.
                if (!edge && runStart !== null) {
                    segments.push({ x1: runStart, y1: edgeY, x2: x, y2: edgeY });
                    runStart = null;
                }
            }
        }
    }

    // VERTICAL runs, column by column — the same rule turned ninety degrees.
    for (let x = x0; x < x1; x++) {
        for (const side of [0, 1]) {
            const edgeX = x + side;                 // 0 = the left edge, 1 = the right
            let runStart: number | null = null;
            for (let y = y0; y <= y1; y++) {
                const edge = y < y1 && isSelected(mask, x, y) && !isSelected(mask, x + (side === 0 ? -1 : 1), y);
                if (edge && runStart === null) runStart = y;
                if (!edge && runStart !== null) {
                    segments.push({ x1: edgeX, y1: runStart, x2: edgeX, y2: y });
                    runStart = null;
                }
            }
        }
    }
    return segments;
}
