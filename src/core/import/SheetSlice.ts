/**
 * @module SheetSlice
 * @description Recovering the grid from a sprite sheet nobody wrote an atlas for.
 *
 * Reading a sheet is not the inverse of writing one. `export/SpriteSheet` emits a texture plus a
 * descriptor saying which rectangle is which frame of which clip; a sheet that arrives from an
 * artist has no descriptor at all, only pixels. The whole job here is recovering the grid the file
 * no longer states.
 *
 * AND IT MUST BE THE GRID, NOT THE INK. The tempting approach is to find the transparent gutters
 * between drawings and cut there. It was measured against real packs and it is wrong: on the
 * creature strip the ink runs come out ragged — widths 17, 22, 29, 21, 23…, start pitch 24, 34,
 * 35, 31… — because each drawing fills its cell differently, and where two adjacent drawings touch
 * their ink MERGES into one run. Boundary detection finds 19 "frames" in a sheet that really holds
 * 80. A grid recovers the truth and nothing else does.
 *
 * THE CELL SIZE IS STATED, NOT GUESSED. An author knows their sheet is 32x32 or 24x24 — it is
 * usually in the filename, as `Dungeon_24x24.png` is. Inferring it would mean picking a number
 * that has to be exactly right, has no safe default, and fails silently by producing a plausible
 * grid of the wrong thing.
 *
 * PURE, AND IT PRODUCES PLAIN DATA rather than a document. Cells come back as rectangles in
 * reading order; turning them into keyframes is a separate function, because "which rectangles"
 * and "how fast, in what order" are different decisions and fusing them would force a re-slice
 * every time the timing changed.
 */

import { SourceRect } from "../document/Node";
import { Keyframe } from "../document/Timeline";

/**
 * Cells one slice may produce.
 *
 * A bound on a hand-editable grid, for the reason every other bound here exists: cell size is a
 * number a person types, and a small typo turns a 15x7 sheet into a request for millions of rects.
 */
export const SLICE_MAX_CELLS = 16_384;

/** The grid recovered from an image's dimensions and a stated cell size. */
export interface SliceGrid {
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    /** Columns times rows — the cell count, including any that are blank. */
    count: number;
}

/** How the cells sit inside the file. */
export interface SliceOptions {
    cellWidth: number;
    cellHeight: number;
    /**
     * Border around the WHOLE sheet, before the first cell. Absent = 0.
     *
     * Distinct from `spacing`, and both exist because a sheet can have either without the other —
     * these are the two numbers every tileset editor asks for, so taking one and calling it both
     * would misread half the files in the wild.
     */
    margin?: number;
    /** Gutter BETWEEN cells. Absent = 0. */
    spacing?: number;
}

/**
 * The grid a sheet of this size holds, or null when the cell size does not fit it.
 *
 * NULL RATHER THAN A ROUNDED ANSWER. A cell size that does not divide the sheet means the number
 * is wrong — the wrong sheet, a forgotten margin, a typo — and rounding down would produce a
 * plausible grid whose every cell is offset a little further than the last. Saying "this does not
 * fit" is the only answer that lets a caller notice.
 */
export function sliceGrid(imageWidth: number, imageHeight: number, opts: SliceOptions): SliceGrid | null {
    const cellWidth = Math.round(opts.cellWidth), cellHeight = Math.round(opts.cellHeight);
    const margin = Math.max(0, Math.round(opts.margin ?? 0));
    const spacing = Math.max(0, Math.round(opts.spacing ?? 0));
    if (!(cellWidth > 0) || !(cellHeight > 0)) return null;
    // A NON-FINITE image size is refused up front. Be precise: this is CLARITY, not correctness,
    // and a mutation removing it survives — an infinite extent yields an infinite column count that
    // the cell bound below rejects anyway, and a NaN one fails the exact-fit comparison because
    // NaN equals nothing. It stays because "a sheet of unknown size has no grid" is worth saying
    // once, rather than leaving the next reader to discover it two guards later.
    if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) return null;

    // The usable extent, once the border is taken off both sides.
    const usableW = imageWidth - margin * 2, usableH = imageHeight - margin * 2;
    if (usableW < cellWidth || usableH < cellHeight) return null;

    // N cells take N widths and N-1 gutters, so the gutter is added back before dividing — which
    // is why this is not simply `usable / cell`. Getting that backwards puts every column after
    // the first a gutter further left than the pixels actually are.
    const columns = Math.floor((usableW + spacing) / (cellWidth + spacing));
    const rows = Math.floor((usableH + spacing) / (cellHeight + spacing));
    if (columns < 1 || rows < 1) return null;

    // IT MUST DIVIDE EXACTLY. A leftover strip means the stated cell size is not this sheet's.
    if (columns * cellWidth + (columns - 1) * spacing !== usableW) return null;
    if (rows * cellHeight + (rows - 1) * spacing !== usableH) return null;

    const count = columns * rows;
    if (count > SLICE_MAX_CELLS) return null;
    return { columns, rows, cellWidth, cellHeight, count };
}

/**
 * Every cell of the grid as a source rectangle, in READING ORDER — left to right, top to bottom.
 *
 * Reading order because that is the order sheets are authored in and the order an atlas numbers
 * them; a slicer that returned column-major would disagree with every tool an artist already uses.
 */
export function sliceCells(grid: SliceGrid, opts?: { margin?: number; spacing?: number }): SourceRect[] {
    const margin = Math.max(0, Math.round(opts?.margin ?? 0));
    const spacing = Math.max(0, Math.round(opts?.spacing ?? 0));
    const out: SourceRect[] = [];
    for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.columns; col++) {
            out.push({
                x: margin + col * (grid.cellWidth + spacing),
                y: margin + row * (grid.cellHeight + spacing),
                width: grid.cellWidth,
                height: grid.cellHeight
            });
        }
    }
    return out;
}

/**
 * Cells as a TRACK — one keyframe per cell, `step` frames apart.
 *
 * Separate from slicing because which rectangles and how fast are different decisions: re-timing
 * an animation should not mean re-reading the sheet, and a sheet holding four animations is sliced
 * once and tracked several times.
 *
 * The keyframes are NOT held, and they do not need to be: a region STEPS through an ordinary tween
 * (schema 52), so the cell changes exactly on each keyframe either way. Marking them held would
 * work too and would hide any regression in that rule, which is the opposite of useful.
 */
export function sliceTrack(cells: readonly SourceRect[], opts?: { start?: number; step?: number }): Keyframe[] {
    const start = Math.round(opts?.start ?? 0);
    // A step of zero would put every cell on one frame, where only the last could ever be seen.
    const step = Math.max(1, Math.round(opts?.step ?? 1));
    return cells.map((cell, i) => ({ frame: start + i * step, values: { sourceRect: cell } }));
}

/**
 * Which cells of a sliced sheet are BLANK, given a way to ask whether a rectangle has any ink.
 *
 * The emptiness test is injected because deciding it needs pixels, and this module is pure — the
 * same split `SpriteSheet` makes between planning a sheet and drawing one.
 *
 * REPORTED, NEVER DROPPED. A tileset legitimately has holes: the measured dungeon sheet fills 87
 * of its 105 cells. Which indices are blank is exactly what a tilemap author needs, and removing
 * them would renumber every cell after the first hole — so an atlas written against the file would
 * no longer agree with the file.
 */
export function blankCells(cells: readonly SourceRect[], hasInk: (rect: SourceRect) => boolean): number[] {
    const out: number[] = [];
    cells.forEach((cell, i) => { if (!hasInk(cell)) out.push(i); });
    return out;
}
