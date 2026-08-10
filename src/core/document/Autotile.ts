/**
 * @module Autotile
 * @description Terrain in, tiles out — the dual-grid scheme, and the rotation that makes it six tiles.
 *
 * AUTOTILING IS A FUNCTION FROM TERRAIN TO TILE, which is the reason `core.tilemap` exists at all: the
 * node-per-cell document stored only the answer — the rendered tile — with nowhere to put the
 * question. This is the function. It takes what an author means (which cells are grass) and returns
 * what the screen shows (which tile is at each cell), so the author's intent stays editable and the
 * picture stays derived. The same shape of decision as keeping a gradient's stops instead of its
 * midpoint colour.
 *
 * THE DUAL GRID, and why it is the cheap one. Put the DISPLAY grid half a cell off the terrain grid,
 * and every display tile sits over the corner where four terrain cells meet. Four cells, two states
 * each, is SIXTEEN tiles — against the 47 a blob set needs when a tile is chosen from its own cell's
 * eight neighbours. Both describe the same silhouettes; one asks an artist for a third of the work.
 * The display grid is therefore ONE LARGER in each direction: terrain cell (cols-1, rows-1) needs a
 * display tile past its right and bottom edges to be drawn at all.
 *
 * AND SIX TILES WITH ROTATION. The sixteen masks fall into six classes under the symmetries of a
 * square — empty, one corner, two adjacent, two diagonal, three corners, full — so an artist who
 * draws six shapes gets the other ten for free, turned. `Tilemap.flips` already carries orientation
 * on all three backends, so this costs no new machinery: `rotatedTable` derives the sixteen entries
 * from six, and the derivation is checked by asking whether each entry's flip really does map its
 * tile's own mask onto the mask it is filed under.
 *
 * MEASURED, AND THE MEASUREMENT SAYS THE CORPUS CANNOT VALIDATE THIS. There is no terrain data in
 * `freeassets` at all: not one `<wangset>` and not one `<terrain>` in 20 `.tmx` and 14 `.tsx` files.
 * Asking whether the maps were nevertheless drawn AS IF autotiled — is each layer a function of some
 * neighbourhood mask? — gives 0.69 for the dual grid, 0.70 for edges and 0.72 for blob over 22,198
 * cells, and the layers that score highest do so for a reason that is not autotiling: they use FOUR
 * of the sixteen masks, so "the commonest tile for this mask" is just "the commonest tile". One layer
 * puts 166 distinct tiles in 1,650 cells. This art was placed by hand, tile by tile.
 *
 * TWO CONSEQUENCES, both worth writing down. Inferring terrain from an imported map is not a feature
 * to build — it cannot work on this art. And the tables here are exercised by CONSTRUCTED fixtures,
 * because there is no real one to check against; what the tests can and do check is that the scheme
 * is self-consistent, which is a different and weaker claim than "it matches the corpus".
 *
 * ONE MATERIAL PER LAYER. A cell holds one tile, so a map of grass and water is two tilemap nodes —
 * the same shape the importer already produces, one node per Tiled layer.
 */

import { TILE_EMPTY, FLIP_H, FLIP_V, FLIP_D, FLIP_MAX } from "./Tilemap";

/** How many neighbourhoods a dual-grid tile can sit over: four corners, two states each. */
export const AUTOTILE_MASKS = 16;

/**
 * The four corner bits of a dual-grid mask, named once.
 *
 * A display tile at (col, row) sits over the corner where terrain cells (col-1, row-1), (col, row-1),
 * (col-1, row) and (col, row) meet — so these are the four cells' positions WITHIN the tile, which is
 * what makes them transformable by the same flips that transform the tile's pixels.
 */
export const CORNER_TL = 1;
export const CORNER_TR = 2;
export const CORNER_BL = 4;
export const CORNER_BR = 8;

/** Which tile a mask shows, and how it is turned. */
export interface AutotileCell {
    index: number;
    /** 0..7, as `Tilemap.flips` stores it. Absent is 0. */
    flip?: number;
}

/** Sixteen entries, indexed BY MASK; `null` where the mask draws nothing. */
export type AutotileTable = readonly (AutotileCell | null)[];

/** What is wrong with a table, or null. */
export function autotileTableError(table: unknown): string | null {
    if (!Array.isArray(table)) return "an autotile table must be an array";
    if (table.length !== AUTOTILE_MASKS) {
        return `an autotile table must hold exactly ${AUTOTILE_MASKS} entries, got ${table.length}`;
    }
    for (const entry of table as unknown[]) {
        if (entry === null) continue;
        if (entry === undefined || typeof entry !== "object") return "an autotile entry must be an object or null";
        const e = entry as Record<string, unknown>;
        if (!Number.isInteger(e.index) || (e.index as number) < 0) return "an autotile entry's index must be a whole number >= 0";
        if (e.flip !== undefined) {
            if (!Number.isInteger(e.flip) || (e.flip as number) < 0 || (e.flip as number) > FLIP_MAX) {
                return `an autotile entry's flip must be a whole number 0..${FLIP_MAX}`;
            }
        }
    }
    return null;
}

/**
 * How a flip permutes the four corners — the same permutation it applies to the tile's pixels.
 *
 * THIS IS THE ONE PLACE THE TWO CONVENTIONS ARE TIED TOGETHER, and getting it wrong gives a table
 * that is plausible and wrong: every mask would have an entry, every entry would name a real tile,
 * and the map would come out with its corners pointing the wrong ways. `flipMatrix` transposes FIRST
 * and then mirrors, so this does the same, in the same order.
 */
export function flipMask(flip: number, mask: number): number {
    let m = mask;
    const swap = (a: number, b: number) => {
        const has = (bit: number) => (m & bit) !== 0;
        const [av, bv] = [has(a), has(b)];
        m = (m & ~(a | b)) | (av ? b : 0) | (bv ? a : 0);
    };
    // TRANSPOSE — (x, y) -> (y, x) — leaves the two corners ON the diagonal alone and swaps the
    // other pair. Applied first, exactly as `flipMatrix` applies it first.
    if (flip & FLIP_D) swap(CORNER_TR, CORNER_BL);
    if (flip & FLIP_H) { swap(CORNER_TL, CORNER_TR); swap(CORNER_BL, CORNER_BR); }
    if (flip & FLIP_V) { swap(CORNER_TL, CORNER_BL); swap(CORNER_TR, CORNER_BR); }
    return m;
}

/**
 * The six masks a rotated set needs art for — one per class under the symmetries of a square.
 *
 * DERIVED, not tabulated: the classes are found by orbiting every mask under all eight flips and
 * keeping the smallest member of each orbit. A hand-written list of six numbers would be six chances
 * to write down a mask that is really in another class, and nothing would say so.
 */
export function autotileClasses(): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (let mask = 0; mask < AUTOTILE_MASKS; mask++) {
        if (seen.has(mask)) continue;
        out.push(mask);
        for (let flip = 0; flip <= FLIP_MAX; flip++) seen.add(flipMask(flip, mask));
    }
    return out;
}

/**
 * A full sixteen-entry table from one tile per class, turned to fill the rest.
 *
 * `art` maps a CLASS MASK (as `autotileClasses` returns them) to the tile drawn for it; a class with
 * no art leaves every mask in its orbit empty. The flip chosen for a mask is the first that maps the
 * class's own mask onto it, and "first" is not arbitrary: the flips are tried in ascending order, so
 * an unturned tile always wins over a turned one that looks the same.
 */
export function rotatedTable(art: ReadonlyMap<number, number>): AutotileTable {
    const table: (AutotileCell | null)[] = new Array(AUTOTILE_MASKS).fill(null);
    for (const [classMask, index] of art) {
        for (let mask = 0; mask < AUTOTILE_MASKS; mask++) {
            if (table[mask] !== null) continue;
            for (let flip = 0; flip <= FLIP_MAX; flip++) {
                if (flipMask(flip, classMask) !== mask) continue;
                table[mask] = flip === 0 ? { index } : { index, flip };
                break;
            }
        }
    }
    return table;
}

/** A terrain grid: one material id per cell, row-major. 0 means nothing there. */
export interface Terrain {
    cols: number;
    rows: number;
    /** `cols * rows` material ids. */
    cells: readonly number[];
}

/**
 * The mask for one DISPLAY cell — which of the four terrain cells around its top-left corner hold
 * `material`.
 *
 * OFF THE TERRAIN IS NOT THE MATERIAL, which is what makes a coastline appear at the edge of the map
 * rather than the terrain being treated as continuing forever. That is a decision and not the only
 * one possible: a map meant to scroll into more of itself would want the opposite.
 */
export function dualMask(terrain: Terrain, material: number, col: number, row: number): number {
    const has = (c: number, r: number): boolean => {
        if (c < 0 || r < 0 || c >= terrain.cols || r >= terrain.rows) return false;
        return terrain.cells[r * terrain.cols + c] === material;
    };
    return (has(col - 1, row - 1) ? CORNER_TL : 0)
        | (has(col, row - 1) ? CORNER_TR : 0)
        | (has(col - 1, row) ? CORNER_BL : 0)
        | (has(col, row) ? CORNER_BR : 0);
}

/**
 * Which TERRAIN cell a point falls in, given coordinates in the RESOLVED node's own space.
 *
 * THE INVERSE OF THE HALF-CELL OFFSET, and it has to exist because every consumer — tools included
 * — reads geometry from `computeGeometry`, which resolves the scene internally. So a tool that asks
 * "which cell is under the pointer" is answered in the DISPLAY grid: one larger each way and shifted
 * half a cell. Painting terrain needs the other grid.
 *
 * FOUND BY A TEST, not by reasoning: the terrain brush painted nothing, and `toLocal` was returning
 * a point half a cell further along than the arithmetic expected — which on the last column and row
 * falls off the grid entirely and reads as a brush that mysteriously stops working near the edge.
 *
 * It lives here rather than in the tool because the offset is this module's rule; a second copy in a
 * gesture would be a second thing to keep in step with `autotile`.
 */
export function terrainCellAt(
    map: { cols: number; rows: number; tileWidth: number; tileHeight: number },
    localX: number, localY: number
): { col: number; row: number } | null {
    const cell = terrainCoordAt(map, localX, localY);
    if (!cell) return null;
    // `cols`/`rows` here are the STORED grid's — the terrain's own — because that is what a tool
    // reads out of the document. The display grid is one larger and is not what is being painted.
    if (cell.col < 0 || cell.row < 0 || cell.col >= map.cols || cell.row >= map.rows) return null;
    return cell;
}

/**
 * The terrain cell a point falls in WITHOUT the grid's bounds — the twin of `Tilemap.cellCoordAt`,
 * and here for the same reason: a rectangle drag pulled off the map has to keep following the
 * pointer, and `rectCells` is what clamps it. Null only when the tile size is unusable.
 *
 * `terrainCellAt` is derived from this so the half-cell offset exists ONCE. It is the arithmetic
 * that already went wrong once by being written a second time, in a tool.
 */
export function terrainCoordAt(
    map: { cols: number; rows: number; tileWidth: number; tileHeight: number },
    localX: number, localY: number
): { col: number; row: number } | null {
    if (!(map.tileWidth > 0) || !(map.tileHeight > 0)) return null;
    return {
        col: Math.floor((localX - map.tileWidth / 2) / map.tileWidth),
        row: Math.floor((localY - map.tileHeight / 2) / map.tileHeight)
    };
}

/** A resolved display grid: one larger than the terrain in each direction, offset half a cell. */
export interface AutotileResult {
    cols: number;
    rows: number;
    tiles: number[];
    /** Present only when something is turned, as `Tilemap.flips` is. */
    flips?: number[];
}

/**
 * The display tiles for a terrain grid — the whole point of the module.
 *
 * ONE LARGER IN EACH DIRECTION, and offset by half a cell, which the caller has to honour when it
 * places the node: `x - tileWidth / 2`, `y - tileHeight / 2`. Returning the dimensions rather than
 * assuming the caller derives them is what keeps the two from disagreeing.
 */
export function autotile(terrain: Terrain, material: number, table: AutotileTable): AutotileResult {
    const cols = terrain.cols + 1;
    const rows = terrain.rows + 1;
    const tiles: number[] = new Array(cols * rows);
    const flips: number[] = new Array(cols * rows).fill(0);
    let turned = false;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const entry = table[dualMask(terrain, material, col, row)] ?? null;
            const at = row * cols + col;
            tiles[at] = entry ? entry.index : TILE_EMPTY;
            const flip = entry?.flip ?? 0;
            flips[at] = flip;
            if (flip !== 0) turned = true;
        }
    }
    // ABSENT WHEN NOTHING IS TURNED, the same invariant `Tilemap.flips` states and `TilemapEdit`
    // keeps — a derived grid that always carried a flip array would break it from the other side.
    return turned ? { cols, rows, tiles, flips } : { cols, rows, tiles };
}
