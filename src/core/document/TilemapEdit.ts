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
    // AN AUTOTILED LAYER HAS NO TILES TO PAINT. Its grid is derived from terrain, and the stored
    // tiles are empty by rule — so a stroke here would write a picture the derivation immediately
    // overrules, and `rebuild` would drop the terrain on the way past. That is a layer silently
    // ceasing to be autotiled because somebody clicked on it once. Paint the terrain instead.
    if (map.terrain) return null;
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

/** What one terrain cell becomes: a material id, or 0 for nothing. */
export interface TerrainEdit {
    col: number;
    row: number;
    material: number;
}

/**
 * `map` with terrain cells painted, or null when nothing changes.
 *
 * THE TWIN OF `withTiles`, and deliberately the same shape: off the grid is dropped rather than
 * refused (a drag that leaves the map and comes back is one gesture), edits apply in order, and null
 * means nothing moved. What differs is what is being written — the QUESTION rather than the answer,
 * so the picture follows from `resolveTilemaps` instead of from here.
 *
 * A MAP WITHOUT TERRAIN IS REFUSED rather than given one. Turning an ordinary layer into an
 * autotiled one throws its tiles away and needs art to draw with; that is a decision an author makes
 * once, in `asTerrain`, not something a brush stroke should do by surprise.
 */
export function withTerrain(map: ReadonlyTilemap, edits: readonly TerrainEdit[]): Tilemap | null {
    const terrain = map.terrain;
    if (!terrain) return null;
    const cells = terrain.cells.slice();
    let changed = false;
    for (const edit of edits) {
        if (!Number.isInteger(edit.col) || !Number.isInteger(edit.row)) continue;
        if (edit.col < 0 || edit.row < 0 || edit.col >= map.cols || edit.row >= map.rows) continue;
        // A MATERIAL IS A WHOLE NUMBER AND NOT NEGATIVE, the same rule `terrainError` states — 0 is
        // "nothing", which is what an eraser writes.
        if (!Number.isInteger(edit.material) || edit.material < 0) continue;
        const at = edit.row * map.cols + edit.col;
        if (cells[at] === edit.material) continue;
        cells[at] = edit.material;
        changed = true;
    }
    if (!changed) return null;
    const next = rebuild(map, map.tiles.slice(), map.flips ? map.flips.slice() : null);
    return { ...next, terrain: { ...next.terrain!, cells } };
}

/**
 * `map` with a different tile assigned to one symmetry class, or null when nothing changes.
 *
 * ONE CLASS AT A TIME, because that is how an artist draws: six shapes, each standing for its whole
 * orbit under the symmetries of a square. Passing the whole table would make the caller responsible
 * for a derivation `rotatedTable` already owns.
 */
export function withTerrainArt(map: ReadonlyTilemap, mask: number, index: number): Tilemap | null {
    const terrain = map.terrain;
    if (!terrain) return null;
    if (!Number.isInteger(mask) || mask < 0 || mask >= 16) return null;
    if (!Number.isInteger(index) || index < 0) return null;
    const art = terrain.art.map(a => ({ mask: a.mask, index: a.index }));
    const at = art.findIndex(a => a.mask === mask);
    if (at >= 0 && art[at].index === index) return null;
    if (at >= 0) art[at] = { mask, index };
    else art.push({ mask, index });
    const next = rebuild(map, map.tiles.slice(), map.flips ? map.flips.slice() : null);
    return { ...next, terrain: { ...next.terrain!, art } };
}

/**
 * An ordinary layer turned into an autotiled one, or null when it already is one.
 *
 * IT THROWS THE TILES AWAY, and says so here rather than doing it quietly: an autotiled layer's
 * stored tiles must be empty, because the picture is derived and a stored one would be a second
 * picture that can disagree. So this is a one-way door an author walks through deliberately — which
 * is exactly why a brush stroke must never do it, and why `withTerrain` refuses a map without
 * terrain instead of helpfully adding some.
 *
 * The cells start at 0, which is "nothing": a fresh terrain layer draws nothing until it is painted,
 * rather than guessing that the map was all one material.
 */
export function asTerrain(map: ReadonlyTilemap, material: number, art: readonly { mask: number; index: number }[]): Tilemap | null {
    if (map.terrain) return null;
    if (!Number.isInteger(material) || material < 1) return null;
    const next = rebuild(map, new Array(map.cols * map.rows).fill(TILE_EMPTY), null);
    return {
        ...next,
        terrain: {
            cells: new Array(map.cols * map.rows).fill(0),
            material,
            art: art.map(a => ({ mask: a.mask, index: a.index }))
        }
    };
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
 * An independent copy of `map` — the identity edit, taken through `rebuild` so it cannot forget a
 * field the way a spread would. Terrain was added to this module after `rebuild` existed and every
 * function here kept working; a hand-written clone beside them would have dropped it silently.
 *
 * WHAT WANTS ONE is a gesture that must keep the map as it was BEFORE the gesture and hand it back
 * later — the rectangle drag, which recomputes each frame from the press rather than from the frame
 * before it. The document hands out readonly maps, and the value it must be given back is mutable.
 */
export function copyTilemap(map: ReadonlyTilemap): Tilemap {
    return rebuild(map, map.tiles.slice(), map.flips ? map.flips.slice() : null);
}

/**
 * A new map carrying `tiles`/`flips`, with the flip array dropped when nothing is turned.
 *
 * THE ONE PLACE THE ABSENT-WHEN-UNTURNED INVARIANT IS KEPT. Every function above goes through it,
 * so an edit that straightens the last turned cell in a map leaves the file as it would have been
 * had nothing ever been turned — rather than carrying a zero per cell forever after one gesture.
 */
function rebuild(
    map: { cols: number; rows: number; tileWidth: number; tileHeight: number; sheet: Readonly<TileSheet>;
           terrain?: ReadonlyTilemap["terrain"] },
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
        ...(turned ? { flips: flips as number[] } : {}),
        // TERRAIN SURVIVES EVERY EDIT THAT IS NOT ABOUT IT, and copied for the same reason the sheet
        // is: a caller holding the old map must keep seeing the old terrain.
        ...(map.terrain ? { terrain: {
            cells: map.terrain.cells.slice(),
            material: map.terrain.material,
            art: map.terrain.art.map(a => ({ mask: a.mask, index: a.index }))
        } } : {})
    };
}
