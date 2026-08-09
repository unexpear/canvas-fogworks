/**
 * @module TilemapEdit
 * @description Editing a grid of tiles: what a stroke, a fill or a resize turns one `Tilemap` into.
 *
 * A map can be imported and drawn and NOT PAINTED, which is the gap this closes. Everything here is
 * pure and returns a whole new `Tilemap`, for the reason `MeshEdit` does the same: the arithmetic
 * that can be wrong then lives where a test reaches it, and the action layer stays a thin validated
 * door rather than the place the rules live.
 *
 * NULL MEANS "NOTHING CHANGED", and every function here can return it. That is not tidiness: an
 * action that succeeded without changing anything puts an undo step on the stack that undoes
 * nothing, so a person pressing undo once appears to be ignored. `PaintSurfaceAction` refuses an
 * empty patch for exactly this reason and this is the same refusal, one layer down.
 *
 * WHAT IS NOT HERE. Filling the gaps between pointer samples is the TOOL's business, not the
 * document's: `PixelBuffer.linePoints` already states how a drag becomes a run of integer cells for
 * the pixel brush, and a tile grid is an integer grid, so the tile tool walks the same Bresenham
 * rather than a second one that could disagree with it by a cell at some angles.
 */

import {
    ReadonlyTilemap, Tilemap, TileSheet, TILE_EMPTY, TILEMAP_MAX_CELLS, FLIP_MAX, tileAt, flipAt
} from "./Tilemap";

/** What one cell becomes. */
export interface TileEdit {
    col: number;
    row: number;
    /** The index to write, or `TILE_EMPTY` to clear the cell. */
    index: number;
    /** How to turn it, 0..7. Omitted leaves the cell's current orientation alone. */
    flip?: number;
}

/** The most cells one fill may touch — the grid's own cap, since a fill can reach every cell. */
export const TILE_FILL_MAX = TILEMAP_MAX_CELLS;

/**
 * `map` with `edits` written into it, or null when none of them changes anything.
 *
 * Edits OFF THE GRID are dropped rather than refused, because that is what a drag does: a stroke
 * that leaves the map's edge and comes back is one gesture, and failing it would lose the half that
 * landed. Edits are applied IN ORDER, so a later one on the same cell wins.
 */
export function withTiles(map: ReadonlyTilemap, edits: readonly TileEdit[]): Tilemap | null {
    const tiles = map.tiles.slice();
    // MATERIALISED ONLY IF NEEDED, and dropped again below if it ends up all zeros — see
    // `normaliseFlips`. `Tilemap.flips` documents itself as absent when nothing is turned, and an
    // invariant that only holds until the first edit is not an invariant.
    let flips: number[] | null = map.flips ? map.flips.slice() : null;
    let changed = false;
    for (const edit of edits) {
        if (!Number.isInteger(edit.col) || !Number.isInteger(edit.row)) continue;
        if (edit.col < 0 || edit.row < 0 || edit.col >= map.cols || edit.row >= map.rows) continue;
        if (!Number.isInteger(edit.index) || edit.index < TILE_EMPTY) continue;
        const at = edit.row * map.cols + edit.col;
        if (tiles[at] !== edit.index) { tiles[at] = edit.index; changed = true; }
        if (edit.flip === undefined) continue;
        if (!Number.isInteger(edit.flip) || edit.flip < 0 || edit.flip > FLIP_MAX) continue;
        const was = flips ? flips[at] : 0;
        if (was === edit.flip) continue;
        if (!flips) flips = new Array(map.cols * map.rows).fill(0);
        flips[at] = edit.flip;
        changed = true;
    }
    if (!changed) return null;
    return rebuild(map, tiles, flips);
}

/**
 * The rectangle of cells between two corners, inclusive, clamped to the grid — or null when the
 * rectangle misses the map entirely.
 *
 * EITHER CORNER MAY BE FIRST. A drag from bottom-right to top-left is the same rectangle, and a
 * caller that had to normalise the pair itself is a caller that will sometimes forget.
 */
export function rectCells(
    map: ReadonlyTilemap, a: { col: number; row: number }, b: { col: number; row: number }
): { col: number; row: number }[] {
    const col0 = Math.max(0, Math.min(a.col, b.col));
    const row0 = Math.max(0, Math.min(a.row, b.row));
    const col1 = Math.min(map.cols - 1, Math.max(a.col, b.col));
    const row1 = Math.min(map.rows - 1, Math.max(a.row, b.row));
    const out: { col: number; row: number }[] = [];
    for (let row = row0; row <= row1; row++) {
        for (let col = col0; col <= col1; col++) out.push({ col, row });
    }
    return out;
}

/**
 * The connected run of cells holding the same index as the one at `col,row` — a bucket fill's reach.
 *
 * FOUR-CONNECTED, not eight. A diagonal touch is not a shared edge, and a fill that leaked through
 * one would cross a wall drawn as a diagonal line — which is how most walls in the measured maps are
 * drawn at their corners.
 *
 * MATCHES ON INDEX ALONE, not on orientation: two cells showing the same tile mirrored are the same
 * ground as far as a fill is concerned, and treating them as different would leave a one-cell scar
 * wherever the art happened to be flipped.
 *
 * ITERATIVE, with an explicit stack. A recursive flood over a 1,024x1,024 grid is a million frames
 * deep in the worst case, which is a stack overflow rather than a slow fill.
 */
export function fillRegion(
    map: ReadonlyTilemap, col: number, row: number
): { col: number; row: number }[] {
    if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return [];
    const target = tileAt(map, col, row);
    const seen = new Uint8Array(map.cols * map.rows);
    const out: { col: number; row: number }[] = [];
    const stack: [number, number][] = [[col, row]];
    seen[row * map.cols + col] = 1;
    while (stack.length > 0) {
        const [c, r] = stack.pop() as [number, number];
        out.push({ col: c, row: r });
        if (out.length >= TILE_FILL_MAX) break;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nc = c + dc, nr = r + dr;
            if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) continue;
            const at = nr * map.cols + nc;
            if (seen[at]) continue;
            if (tileAt(map, nc, nr) !== target) continue;
            // MARKED WHEN PUSHED, not when popped. Marking on pop lets a cell reached from two
            // directions sit on the stack twice, which is a fill that visits some cells twice and
            // grows the stack to the area of the region rather than to its frontier.
            seen[at] = 1;
            stack.push([nc, nr]);
        }
    }
    return out;
}

/**
 * `map` resized to `cols` by `rows`, keeping every cell that still exists — or null when the size is
 * unchanged or impossible.
 *
 * CELLS KEEP THEIR COORDINATES rather than their index in the array, which is the whole difficulty:
 * the array is row-major, so widening a map by one column shifts every row after the first. A resize
 * that copied the flat array would slide the whole map diagonally, which looks like corrupted art
 * rather than a resize.
 */
export function resizeTilemap(map: ReadonlyTilemap, cols: number, rows: number): Tilemap | null {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
    if (cols * rows > TILEMAP_MAX_CELLS) return null;
    if (cols === map.cols && rows === map.rows) return null;
    const tiles = new Array<number>(cols * rows).fill(TILE_EMPTY);
    const flips = map.flips ? new Array<number>(cols * rows).fill(0) : null;
    const keepCols = Math.min(cols, map.cols);
    const keepRows = Math.min(rows, map.rows);
    for (let row = 0; row < keepRows; row++) {
        for (let col = 0; col < keepCols; col++) {
            tiles[row * cols + col] = tileAt(map, col, row);
            if (flips) flips[row * cols + col] = flipAt(map, col, row);
        }
    }
    return rebuild({ ...map, cols, rows }, tiles, flips);
}

/**
 * A new map carrying `tiles`/`flips`, with the flip array dropped when nothing is turned.
 *
 * THE ONE PLACE THE ABSENT-WHEN-UNTURNED INVARIANT IS KEPT. Every function above goes through it,
 * so an edit that straightens the last turned cell in a map leaves the file as it would have been
 * had nothing ever been turned — rather than carrying a zero per cell forever after one gesture.
 */
function rebuild(
    map: { cols: number; rows: number; tileWidth: number; tileHeight: number; sheet: Readonly<TileSheet> },
    tiles: number[], flips: number[] | null
): Tilemap {
    const turned = flips !== null && flips.some(f => f !== 0);
    return {
        cols: map.cols, rows: map.rows,
        tileWidth: map.tileWidth, tileHeight: map.tileHeight,
        // COPIED, not shared. A caller holding the old map must keep seeing the old sheet; sharing
        // the object would make an inspector edit to one grid's sheet appear in an undone state too.
        sheet: { ...map.sheet },
        tiles,
        ...(turned ? { flips: flips as number[] } : {})
    };
}
