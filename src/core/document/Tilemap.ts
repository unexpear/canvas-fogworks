/**
 * @module Tilemap
 * @description A grid of tile indices into one sheet — the node a map should have been all along.
 *
 * MEASURED BEFORE BUILDING. Importing `Roguelike Base Pack/Map/sample_map.tmx` (100x100, 5 layers)
 * made one `core.image` per non-empty cell: **10,618 nodes**, 22ms to compute geometry and build the
 * render model — over a 16ms frame, before anything was drawn — and 5.66MB of JSON to save. Every
 * one of those nodes carried a full geometry, style, layout and transform to say "this 16px tile,
 * here". The document was storing the same four numbers ten thousand times.
 *
 * This is one node per LAYER instead, holding a flat array of indices. The same map becomes five
 * nodes and 50,000 small integers.
 *
 * AND MEASURED AFTER, both halves in one run now that `tilemapForLayer` exists — the same map
 * imported both ways, then the frame derived over the whole map:
 *
 *     one core.image per cell    10,618 nodes   7.80MB   32.3ms first frame, 12.1ms warm
 *     one core.tilemap per layer      5 nodes   0.77MB    0.8ms first frame,  0.1ms warm
 *
 * Placing it went from 1,244ms to 4ms as well, which is the part a person notices first. The figures
 * above differ from the ones recorded when this was designed and are not corrections of them: 22ms
 * was a single cold derivation, and the 32.3ms here is the same kind of measurement on a machine and
 * a schema several versions apart. What has not changed is the shape of the answer.
 *
 * IT IS ALSO WHAT AUTOTILING NEEDS, and that is the deeper reason. Autotiling is a function from
 * TERRAIN to tile, and the node-per-cell document stored only the answer — the rendered tile — with
 * nowhere to put the question. The same shape of mistake as flattening a gradient to its midpoint
 * colour: keep the thing the author means, derive the thing the screen shows.
 *
 * INDICES, NOT GIDS. Tiled's global ids are numbered across every set a map uses, so a cell's
 * meaning depends on a tileset table it is not stored beside. A `Tilemap` names its sheet and
 * indexes into that one sheet, so a layer means the same thing wherever it is pasted. Resolving
 * gid -> (sheet, index) is the importer's job and happens once.
 */

/**
 * The most cells one tilemap node may hold.
 *
 * A hand-editable array needs a bound for the same reason every other one here does. The number is
 * chosen against the measurement rather than by feel: the largest map in `freeassets` is 100x100,
 * so this is two orders of magnitude of headroom and still refuses the file that would otherwise
 * allocate until the tab dies.
 */
export const TILEMAP_MAX_CELLS = 1_048_576;

/** The index that means "nothing here" — not tile zero, which is a real tile. */
export const TILE_EMPTY = -1;

/**
 * How a cell is turned, as three bits — the same three Tiled stores in the top of a gid.
 *
 * MEASURED, and the measurement is why all three exist rather than just the mirrors: of the 22,808
 * non-empty cells in the corpus's 20 maps, 820 are flipped and every one of the eight combinations
 * appears, including 351 with the diagonal bit. Fourteen of the twenty maps use them. Dropping
 * orientation would have quietly rotated a fifth of the art in most maps here.
 *
 * THE DIAGONAL IS A TRANSPOSE, applied FIRST — reflect across the main diagonal, then mirror
 * horizontally, then vertically. That order is Tiled's and it is not commutative, so the three
 * backends each apply it in exactly this sequence.
 */
export const FLIP_H = 1;
export const FLIP_V = 2;
export const FLIP_D = 4;
export const FLIP_MAX = FLIP_H | FLIP_V | FLIP_D;

/**
 * How a sheet is cut into tiles.
 *
 * SPACING AND MARGIN ARE HERE because real sheets have them: Tiled writes both, and a reader that
 * assumed a tight grid would be off by a pixel per column, cumulatively, which reads as tiles
 * slowly shearing across the map rather than as a slicing bug.
 */
export interface TileSheet {
    /** How many tiles across the sheet is. Rows follow from the tile count. */
    columns: number;
    /** One tile's size IN THE SHEET, in image pixels. */
    tileWidth: number;
    tileHeight: number;
    /** Pixels between neighbouring tiles, and around the whole grid. Both default to 0. */
    spacing: number;
    margin: number;
}

export interface Tilemap {
    cols: number;
    rows: number;
    /** One cell's size in the node's LOCAL units — which is not the sheet's tile size. */
    tileWidth: number;
    tileHeight: number;
    sheet: TileSheet;
    /**
     * `cols * rows` indices into the sheet, row-major, `TILE_EMPTY` for a blank cell.
     *
     * A FLAT ARRAY rather than rows of arrays: it is what the file holds, what a texture upload
     * wants, and it makes the length a single check against `cols * rows` rather than a check per
     * row plus a count.
     */
    tiles: number[];
    /**
     * How each cell is turned, `cols * rows` of them, or absent when nothing is turned.
     *
     * A PARALLEL ARRAY rather than bits packed into `tiles`, so an index stays an index: every
     * reader, every test and every eye scanning a saved file sees the tile number it expects
     * instead of one with three invisible bits on top. Absent is the common case and costs nothing.
     */
    flips?: number[];
    /**
     * TERRAIN (schema 63): what the author MEANT, from which `tiles` is derived.
     *
     * THE QUESTION INSTEAD OF THE ANSWER, which is the reason `core.tilemap` exists at all. A map
     * drawn tile by tile stores only the picture; terrain stores which cells are grass and lets
     * `Autotile` decide which of the sixteen silhouettes each corner shows. Change one cell and the
     * eight tiles around it re-derive — the same bargain a gradient makes by storing stops rather
     * than a midpoint colour.
     *
     * `cells` IS SIZED BY THIS GRID, `cols * rows`, and that is deliberate rather than a separate
     * pair of dimensions: two sizes that must agree are two things that can disagree, and the
     * disagreement would only appear as a sheared coastline. So the node's own box measures the
     * TERRAIN, and the DISPLAY grid — one larger each way, offset half a cell — is what the
     * derivation produces. That is why a stored terrain node's `tiles` must be empty: the picture
     * does not live here.
     */
    terrain?: TerrainField;
}

/** The authored half of an autotiled layer: which cells, which material, and the six drawn tiles. */
export interface TerrainField {
    /** `cols * rows` material ids, row-major. 0 is "nothing", so an empty grid needs no special case. */
    cells: number[];
    /** Which material THIS layer draws. One material per layer, as `Autotile`'s header argues. */
    material: number;
    /**
     * The art: one tile per SYMMETRY CLASS, as `autotileClasses` names them.
     *
     * SIX ENTRIES, NOT SIXTEEN, because the other ten are the same shapes turned — storing the full
     * table would be storing a derivation, and an author who redrew one corner would have to
     * remember to update three more. `rotatedTable` expands this, and its own tests check that each
     * expanded flip really does map the class's mask onto the mask it is filed under.
     */
    art: { mask: number; index: number }[];
}

export interface ReadonlyTilemap {
    readonly cols: number;
    readonly rows: number;
    readonly tileWidth: number;
    readonly tileHeight: number;
    readonly sheet: Readonly<TileSheet>;
    readonly tiles: readonly number[];
    readonly flips?: readonly number[];
    readonly terrain?: {
        readonly cells: readonly number[];
        readonly material: number;
        readonly art: readonly { readonly mask: number; readonly index: number }[];
    };
}

/** What is wrong with a tilemap, or null. */
export function tilemapError(map: unknown): string | null {
    if (map === undefined) return null;
    if (map === null || typeof map !== "object" || Array.isArray(map)) return "tilemap must be an object";
    const m = map as Record<string, unknown>;
    for (const [field, value] of [["cols", m.cols], ["rows", m.rows]] as const) {
        if (!Number.isInteger(value) || (value as number) < 1) return `tilemap.${field} must be a whole number >= 1`;
    }
    const cells = (m.cols as number) * (m.rows as number);
    if (cells > TILEMAP_MAX_CELLS) return `tilemap must hold at most ${TILEMAP_MAX_CELLS} cells`;
    for (const [field, value] of [["tileWidth", m.tileWidth], ["tileHeight", m.tileHeight]] as const) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
            return `tilemap.${field} must be a positive number`;
        }
    }
    const sheetErr = tileSheetError(m.sheet);
    if (sheetErr) return sheetErr;
    if (!Array.isArray(m.tiles)) return "tilemap.tiles must be an array";
    // THE ONE CHECK THAT MATTERS MOST: a grid whose length disagrees with its own dimensions reads
    // every row after the first from the wrong place, which looks like corrupt art rather than a
    // malformed file. The mesh's point count is guarded the same way, for the same reason.
    if (m.tiles.length !== cells) {
        return `tilemap.tiles must hold exactly cols * rows (${cells}) entries, got ${m.tiles.length}`;
    }
    for (const t of m.tiles as unknown[]) {
        if (!Number.isInteger(t) || (t as number) < TILE_EMPTY) return "tilemap.tiles must be whole numbers >= -1";
    }
    if (m.flips !== undefined) {
        if (!Array.isArray(m.flips)) return "tilemap.flips must be an array";
        // THE SAME LENGTH RULE, for the same reason: a shorter list turns the wrong cells from the
        // first mismatch onward, which reads as art placed by hand rather than as a bad file.
        if (m.flips.length !== cells) {
            return `tilemap.flips must hold exactly cols * rows (${cells}) entries, got ${m.flips.length}`;
        }
        for (const f of m.flips as unknown[]) {
            if (!Number.isInteger(f) || (f as number) < 0 || (f as number) > FLIP_MAX) {
                return `tilemap.flips must be whole numbers 0..${FLIP_MAX}`;
            }
        }
    }
    const bad = terrainError(m.terrain, cells);
    if (bad) return bad;
    // A STORED GRID AND A DERIVED ONE ARE TWO PICTURES, and a file carrying both can carry two
    // different ones. Terrain means the tiles are computed, so the stored array must be empty —
    // which also makes "is this layer autotiled?" a question with one answer rather than a guess
    // from whichever of the two happens to be non-empty.
    if (m.terrain !== undefined && (m.tiles as number[]).some(t => t !== TILE_EMPTY)) {
        return "a tilemap with terrain must store no tiles; the grid is derived from the terrain";
    }
    return null;
}

/**
 * What is wrong with a terrain field, or null. `cells` is the grid's own `cols * rows`.
 *
 * THE LENGTH IS CHECKED AGAINST THE GRID rather than against a pair of dimensions of its own,
 * because terrain has none: the node's box measures the TERRAIN and the display grid is derived one
 * larger. Two sizes that must agree are two things that can disagree, and the disagreement would
 * surface as a coastline sheared by one cell per row — art placed by hand, to look at.
 */
export function terrainError(terrain: unknown, cells: number): string | null {
    if (terrain === undefined) return null;
    if (terrain === null || typeof terrain !== "object" || Array.isArray(terrain)) {
        return "tilemap.terrain must be an object";
    }
    const t = terrain as Record<string, unknown>;
    if (!Array.isArray(t.cells)) return "tilemap.terrain.cells must be an array";
    if (t.cells.length !== cells) {
        return `tilemap.terrain.cells must hold exactly cols * rows (${cells}) entries, got ${t.cells.length}`;
    }
    for (const c of t.cells as unknown[]) {
        // A MATERIAL IS AN ID, NOT AN INDEX INTO ANYTHING HERE, so the only rule is that it is a
        // whole number and not negative — 0 means "nothing", which is what an empty grid holds.
        if (!Number.isInteger(c) || (c as number) < 0) return "tilemap.terrain.cells must be whole numbers >= 0";
    }
    if (!Number.isInteger(t.material) || (t.material as number) < 1) {
        // MATERIAL 0 IS RESERVED for "nothing", so a layer drawing it would autotile the holes.
        return "tilemap.terrain.material must be a whole number >= 1";
    }
    if (!Array.isArray(t.art)) return "tilemap.terrain.art must be an array";
    for (const entry of t.art as unknown[]) {
        if (entry === null || typeof entry !== "object") return "a terrain art entry must be an object";
        const e = entry as Record<string, unknown>;
        if (!Number.isInteger(e.mask) || (e.mask as number) < 0 || (e.mask as number) >= 16) {
            return "a terrain art entry's mask must be a whole number 0..15";
        }
        if (!Number.isInteger(e.index) || (e.index as number) < 0) {
            return "a terrain art entry's index must be a whole number >= 0";
        }
    }
    return null;
}

/** What is wrong with a sheet description, or null. */
export function tileSheetError(sheet: unknown): string | null {
    if (sheet === null || typeof sheet !== "object" || Array.isArray(sheet)) return "tilemap.sheet must be an object";
    const s = sheet as Record<string, unknown>;
    if (!Number.isInteger(s.columns) || (s.columns as number) < 1) return "tilemap.sheet.columns must be a whole number >= 1";
    for (const field of ["tileWidth", "tileHeight"] as const) {
        const v = s[field];
        if (!Number.isInteger(v) || (v as number) < 1) return `tilemap.sheet.${field} must be a whole number >= 1`;
    }
    for (const field of ["spacing", "margin"] as const) {
        const v = s[field];
        if (!Number.isInteger(v) || (v as number) < 0) return `tilemap.sheet.${field} must be a whole number >= 0`;
    }
    return null;
}

/**
 * The grid a `core.tilemap` is born with — one cell, empty, on a 16px sheet.
 *
 * SIXTEEN because the corpus says so: of the 40 Tiled maps in `freeassets`, 21 use 16x16 tiles,
 * more than any other size. A default nobody changes should be the one most files already use.
 *
 * A node must have a grid to be saveable at all (`Integrity` refuses one without), so this exists
 * to keep "create a tilemap" from producing something that cannot be written to disk.
 */
export function emptyTilemap(): Tilemap {
    return {
        cols: 1, rows: 1, tileWidth: 16, tileHeight: 16,
        sheet: { columns: 1, tileWidth: 16, tileHeight: 16, spacing: 0, margin: 0 },
        tiles: [TILE_EMPTY]
    };
}

/** The index at a cell, or `TILE_EMPTY` when the cell is outside the grid. */
export function tileAt(map: ReadonlyTilemap, col: number, row: number): number {
    if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return TILE_EMPTY;
    return map.tiles[row * map.cols + col] ?? TILE_EMPTY;
}

/** How the cell at `col`,`row` is turned — 0 when nothing is, or the cell is off the grid. */
export function flipAt(map: ReadonlyTilemap, col: number, row: number): number {
    if (!map.flips || col < 0 || row < 0 || col >= map.cols || row >= map.rows) return 0;
    return map.flips[row * map.cols + col] ?? 0;
}

/**
 * The matrix that turns one cell, about its own centre, in a box `w` by `h`.
 *
 * ONE STATEMENT OF THE ORDER, shared by every backend that can take a matrix. Transpose first,
 * then mirror — Tiled's order, and not commutative, so three separate transcriptions of it would
 * be three chances for one of them to turn a tile the wrong way in a case nobody has a fixture for.
 *
 * Returned as the six numbers of a 2D affine, ready for `ctx.transform` or an SVG `matrix()`.
 */
export function flipMatrix(flip: number, w: number, h: number): [number, number, number, number, number, number] {
    // Work about the centre so a flip does not also move the tile out of its cell.
    let a = 1, b = 0, c = 0, d = 1;
    if (flip & FLIP_D) { a = 0; b = 1; c = 1; d = 0; }          // transpose: (x,y) -> (y,x)
    if (flip & FLIP_H) { a = -a; c = -c; }
    if (flip & FLIP_V) { b = -b; d = -d; }
    // The translation that puts the centre back where it was.
    const e = w / 2 - (a * w / 2 + c * h / 2);
    const f = h / 2 - (b * w / 2 + d * h / 2);
    return [a, b, c, d, e, f];
}

/**
 * Where one tile sits IN THE SHEET, in image pixels — or null when the index is empty or absurd.
 *
 * The margin is applied once and the spacing once per preceding tile, which is Tiled's own layout.
 * Getting this wrong is the shearing described on `TileSheet`: right for column zero and further
 * out with every column after it, which never looks like arithmetic.
 */
export function tileSourceRect(
    sheet: Readonly<TileSheet>, index: number
): { x: number; y: number; width: number; height: number } | null {
    if (!Number.isInteger(index) || index < 0) return null;
    // A DEGENERATE SHEET HAS NOWHERE TO POINT AT. `tileSheetError` refuses these on the way into a
    // document, but this is also called with a sheet derived from a Tiled tileset that no
    // validator has seen — and `index % 0` is NaN, which travels as a source rect and draws the
    // whole sheet in one cell. Caught by the importer's own tests when this arithmetic was
    // unified: they had guarded it and the shared version had not.
    if (!(sheet.columns > 0) || !(sheet.tileWidth > 0) || !(sheet.tileHeight > 0)) return null;
    const col = index % sheet.columns;
    const row = Math.floor(index / sheet.columns);
    return {
        x: sheet.margin + col * (sheet.tileWidth + sheet.spacing),
        y: sheet.margin + row * (sheet.tileHeight + sheet.spacing),
        width: sheet.tileWidth,
        height: sheet.tileHeight
    };
}

/**
 * Which tile a point in SHEET pixels falls on — the exact inverse of `tileSourceRect`, for picking a
 * tile out of a sheet by clicking it.
 *
 * NULL IN THE GUTTER, and that is the whole reason this is not a division. With spacing, part of the
 * sheet is not any tile at all; answering with the preceding tile would mean a click one pixel wide
 * of a boundary silently selects its neighbour, and answering with a wrapped index would select a
 * tile from the next row. The margin is the same: a click in the border round the grid is not a tile.
 *
 * The inverse being a separate function rather than a search is deliberate — a picker that scanned
 * `tileSourceRect` over every index would be O(tiles) per click and would still need this arithmetic
 * to know where to stop.
 */
export function tileIndexAt(sheet: Readonly<TileSheet>, x: number, y: number): number | null {
    if (!(sheet.columns > 0) || !(sheet.tileWidth > 0) || !(sheet.tileHeight > 0)) return null;
    const px = x - sheet.margin, py = y - sheet.margin;
    if (px < 0 || py < 0) return null;                       // inside the margin, which is not a tile
    const pitchX = sheet.tileWidth + sheet.spacing;
    const pitchY = sheet.tileHeight + sheet.spacing;
    const col = Math.floor(px / pitchX);
    const row = Math.floor(py / pitchY);
    // PAST THE TILE AND INTO THE GAP AFTER IT. With spacing 1 and 16px tiles the pitch is 17, so an
    // offset of 16 within a cell is the gutter — not a tile, and not the next one either.
    if (px - col * pitchX >= sheet.tileWidth) return null;
    if (py - row * pitchY >= sheet.tileHeight) return null;
    if (col >= sheet.columns) return null;                   // past the right edge of the grid
    return row * sheet.columns + col;
}

/*
 * THERE IS NO `sheetWidth` OR `sheetHeight` HERE, AND THERE WAS. Both derived the sheet's pixel size
 * from the grid description, so a backend needing "how big is the sheet" could ask without decoding
 * it. `sheetHeight` took the row count from THE HIGHEST INDEX THE MAP HAPPENED TO USE, which is only
 * the sheet's height when the map reaches the last row.
 *
 * A real 968x526 sheet whose map reaches row 18 was therefore called 305 tall. SVG places its inner
 * `<image>` at that size so its `viewBox` measures source pixels, and the GPU divides by it, so both
 * sampled 1.7x too far down and drew the whole map from the wrong rows. Canvas was right throughout,
 * because `drawImage` takes the bitmap and never asks. The two wrong backends were wrong the SAME
 * way, so cross-backend comparison would have called it agreement, and no fixture noticed because a
 * small test sheet's last row is the one the fixture uses.
 *
 * The lesson is narrower than "don't derive": a derived value that MUST equal a fact about a file is
 * not a derivation, it is an assumption with arithmetic around it. Both backends now read the size
 * from the decoded bitmap, through the one cache all three share.
 */

/**
 * Which cell a point in the node's LOCAL space falls in, WHETHER OR NOT the grid has that cell —
 * so `col` may be negative or past the last column. Null only when the tile size is unusable.
 *
 * FLOOR, NOT ROUND. A cell owns the half-open range `[n*size, (n+1)*size)`, so a point one unit
 * inside a cell's left edge is in that cell rather than half in its neighbour.
 *
 * THE OFF-GRID ANSWER IS THE USEFUL ONE FOR A DRAG that is not painting cell by cell. A rectangle
 * gesture pulled past the map's edge should keep its other corner following the pointer and clamp
 * only where the grid runs out — which `rectCells` already does — while a rectangle told "no cell"
 * would freeze in BOTH axes, so filling the last column would mean stopping exactly inside it.
 */
export function cellCoordAt(
    map: { cols: number; rows: number; tileWidth: number; tileHeight: number }, x: number, y: number
): { col: number; row: number } | null {
    if (!(map.tileWidth > 0) || !(map.tileHeight > 0)) return null;
    return { col: Math.floor(x / map.tileWidth), row: Math.floor(y / map.tileHeight) };
}

/**
 * Which cell a point in the node's LOCAL space falls in, or null when it falls outside the grid.
 *
 * The single-point twin of `visibleCells`, and here beside it so the two cannot round differently:
 * a renderer that culled by one rule while a tool picked by another would paint the cell next to the
 * one under the cursor along every boundary.
 *
 * DERIVED FROM `cellCoordAt`, which is the same bargain `surfaceToWorld` makes with its corner: two
 * copies of one floor can disagree by a cell at some coordinates, and this pair is asked the same
 * question by the same gesture — one call apart, when a rectangle drag crosses the map's edge.
 */
export function cellAt(
    map: ReadonlyTilemap, x: number, y: number
): { col: number; row: number } | null {
    const cell = cellCoordAt(map, x, y);
    if (!cell) return null;
    if (cell.col < 0 || cell.row < 0 || cell.col >= map.cols || cell.row >= map.rows) return null;
    return cell;
}

/**
 * The cells of `map` that overlap a rectangle in the node's LOCAL space, clamped to the grid.
 *
 * CULLING IS THE WHOLE POINT of drawing a tilemap rather than ten thousand nodes: the measured map
 * had 4,749 cells on screen out of 10,618, and a backend that walked the grid would do the other
 * 5,869 for nothing. Returned as bounds rather than a list so a caller loops without allocating.
 *
 * `null` when nothing overlaps, so the caller can skip rather than loop over an empty range.
 */
export function visibleCells(
    map: ReadonlyTilemap, visible: { x: number; y: number; width: number; height: number }
): { col0: number; row0: number; col1: number; row1: number } | null {
    if (!(map.tileWidth > 0) || !(map.tileHeight > 0)) return null;
    const col0 = Math.max(0, Math.floor(visible.x / map.tileWidth));
    const row0 = Math.max(0, Math.floor(visible.y / map.tileHeight));
    // INCLUSIVE bounds, and `ceil` on the far edge: a rectangle ending one unit into a cell still
    // shows that cell, and flooring would leave a one-tile gap along the right and bottom of the
    // viewport that only appears while scrolling.
    const col1 = Math.min(map.cols - 1, Math.ceil((visible.x + visible.width) / map.tileWidth) - 1);
    const row1 = Math.min(map.rows - 1, Math.ceil((visible.y + visible.height) / map.tileHeight) - 1);
    if (col1 < col0 || row1 < row0) return null;
    return { col0, row0, col1, row1 };
}
