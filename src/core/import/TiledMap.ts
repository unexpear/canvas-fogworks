/**
 * @module TiledMap
 * @description A `.tmx` map as tiles this engine can already draw.
 *
 * A Tiled map is a grid of references into a sheet, which is exactly what this engine now models: a
 * tile is a `sourceRect` (schema 51), a tileset is a grid `SheetSlice` recovers, and the `spacing`
 * Tiled writes is the gutter that slicer already takes. So the work here is resolving a GID to a
 * tileset and a cell; everything downstream already exists.
 *
 * THE TOP THREE BITS OF A GID ARE FLIP FLAGS. A raw id of 2,684,354,697 in the measured maps is
 * tile 137 with two flips set — a reader taking that at face value would index a million tiles past
 * the end of every tileset it met. Masking them off is not optional, and neither is reporting them:
 * a flipped tile drawn unflipped is a wrong picture rather than a missing one.
 *
 * LAYER DATA ARRIVES THREE WAYS: CSV in 18 of the measured files, base64 in 2, and zlib-compressed
 * base64 in those same 2. Inflating is INJECTED exactly as `Aseprite` injects it, so this stays pure
 * and testable with no decompressor present.
 *
 * TILESETS ARRIVE TWO WAYS as well — embedded in the map (11 files) or as an external `.tsx` the map
 * names (18). Both are read, and an external one is resolved by the CALLER: a parser that reached
 * for a file would need a filesystem and stop being pure.
 *
 * ORIENTATION CHANGES PLACEMENT, NOT PARSING. Four maps are isometric, where a cell sits on a
 * diamond rather than a grid, so the placement formula lives here and the orientation is reported
 * rather than assumed.
 */

import { SourceRect } from "../document/Node";

/** Bounds on a hand-editable file. A corrupt size should fail, not allocate. */
export const TILED_MAX_CELLS = 1_000_000;
export const TILED_MAX_LAYERS = 64;
export const TILED_MAX_TILE_IMAGES = 4096;

/** The three flip bits Tiled packs into the top of every GID. */
const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;
const FLIP_D = 0x20000000;
const GID_MASK = 0x1fffffff;

/** One cell: which tile, and how it is turned. */
export interface TiledCell {
    /** The tile id with its flags stripped. 0 means EMPTY, which is a real and common value. */
    gid: number;
    flipH: boolean;
    flipV: boolean;
    /** The anti-diagonal flip, which with the other two expresses every 90-degree rotation. */
    flipD: boolean;
}

/** A tileset the map refers to, embedded or named. */
export interface TiledTileset {
    /** The GID this set's first tile answers to — how a cell finds its set. */
    firstGid: number;
    /** The `.tsx` this map names, for a caller to resolve. Null when the set is embedded. */
    source: string | null;
    name: string;
    tileWidth: number;
    tileHeight: number;
    columns: number;
    tileCount: number;
    spacing: number;
    margin: number;
    /** The sheet, when the set is embedded or after a caller has read the external file. */
    image: string | null;
    imageWidth: number | null;
    imageHeight: number | null;
    /**
     * A COLLECTION set's own images, one per tile, empty for a sheet-backed set.
     *
     * Tiled allows a tileset whose tiles are separate files rather than cells of one sheet, and
     * three sets in the measured tree are built that way. Such a set has no sheet to cut, so
     * `image` is null and `tileSourceRect` has no rect to return — the whole file IS the tile.
     */
    tiles: TiledTileImage[];
    /**
     * `<tileoffset>`, in pixels, applied to every tile this set draws.
     *
     * Four files in the tree carry one. It exists so a tall tile can hang above the cell it
     * occupies — a building rooted in one square standing over the three behind it — so dropping it
     * lays every such tile flat on its own cell, which reads as a map drawn in the wrong order.
     */
    offsetX: number;
    offsetY: number;
}

/** One tile of a collection set: its own file, at its own size. */
export interface TiledTileImage {
    /** The tile's id WITHIN the set, so the GID is this plus `firstGid`. */
    id: number;
    image: string;
    width: number;
    height: number;
}

/** One layer of cells. */
export interface TiledLayer {
    name: string;
    width: number;
    height: number;
    /** Row-major, `width * height` long. */
    cells: TiledCell[];
}

/** A read map. */
export interface TiledMapResult {
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
    orientation: string;
    tilesets: TiledTileset[];
    layers: TiledLayer[];
    /** What could not be represented exactly, reported rather than left to be discovered. */
    notes: string[];
}

/**
 * Attributes of one tag, read as this format defines them rather than as XML in general.
 *
 * EITHER QUOTE. Tiled writes double quotes and so does every hand-written example, but two files in
 * the measured tree are written `<tile id='0'><image source='../Tiles/x.png'/>` — and a reader that
 * only knew double quotes saw a tag with NO attributes at all rather than an error, which is the
 * quiet kind of wrong. The captured quote is back-referenced so `a="it's"` does not end early.
 */
function attributes(tag: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)) out[m[1]] = m[3];
    return out;
}

const num = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
};

/**
 * `columns` and `tilecount` recovered from the image when the file omits them.
 *
 * AN OLDER TILED WROTE NEITHER. Two of the measured maps carry an embedded set with a tile size, a
 * spacing and an image and nothing else — 10,954 cells, 8.8% of every cell in the tree, which a
 * reader that trusted `columns="0"` would drop silently as empty rather than fail on.
 *
 * The arithmetic is the gutter arithmetic inverted: N cells span `N*tile + (N-1)*spacing`, so adding
 * one spacing to the image makes the division exact. It comes out at exactly 57x31 for both files,
 * which is the check that this is the right formula and not one that merely rounds plausibly.
 */
function deriveGrid(set: TiledTileset): TiledTileset {
    if (set.imageWidth === null || set.tileWidth <= 0 || set.tileHeight <= 0) return set;
    const columns = set.columns > 0
        ? set.columns
        : Math.floor((set.imageWidth - 2 * set.margin + set.spacing) / (set.tileWidth + set.spacing));
    if (columns <= 0) return set;
    const rows = set.imageHeight !== null
        ? Math.floor((set.imageHeight - 2 * set.margin + set.spacing) / (set.tileHeight + set.spacing))
        : 0;
    return {
        ...set,
        columns,
        tileCount: set.tileCount > 0 ? set.tileCount : Math.max(0, columns * rows)
    };
}

/**
 * A collection set's per-tile images, and its draw offset.
 *
 * Read from the same text for both paths — an embedded set and an external `.tsx` are the same
 * element with the same children, so one function serves both rather than two that can drift.
 */
function tilesetExtras(body: string): { tiles: TiledTileImage[]; offsetX: number; offsetY: number } {
    const tiles: TiledTileImage[] = [];
    // A `<tile>` with its OWN `<image>` is what makes this a collection. `<tile>` also appears in
    // sheet-backed sets carrying animation or collision data, where it has no image and is not one
    // of these — so the image is what is matched on, not the tile.
    for (const m of body.matchAll(/<tile\b([^>]*)>\s*<image\b([^>]*)>/g)) {
        if (tiles.length >= TILED_MAX_TILE_IMAGES) break;
        const ta = attributes("<tile" + m[1] + ">");
        const ia = attributes("<image" + m[2] + ">");
        if (ia.source === undefined) continue;
        tiles.push({
            id: num(ta.id, -1),
            image: ia.source,
            // The IMAGE's size, not the set's declared tile size: a collection set states a
            // nominal `tilewidth` that its members freely exceed — in the measured tree the set
            // says 232x110 while every tile in it is 256x352.
            width: num(ia.width, 0),
            height: num(ia.height, 0)
        });
    }
    const off = /<tileoffset\b[^>]*>/.exec(body);
    const oa = off ? attributes(off[0]) : {};
    return { tiles: tiles.filter(t => t.id >= 0), offsetX: num(oa.x, 0), offsetY: num(oa.y, 0) };
}

/** A raw GID split into its tile and its flips. */
export function decodeGid(raw: number): TiledCell {
    // `>>> 0` normalises anything — a negative int32 from a signed read, a double above 2^31 —
    // into the unsigned value this format defines. It is REDUNDANT with the masks below, which
    // coerce to int32 and so give the same answer either way; it is kept because this is exported
    // and its contract is "any number in", not "only what our own reader produced".
    const v = raw >>> 0;
    return {
        gid: v & GID_MASK,
        flipH: (v & FLIP_H) !== 0,
        flipV: (v & FLIP_V) !== 0,
        flipD: (v & FLIP_D) !== 0
    };
}

/** What went wrong, or null. */
export function tiledMapError(xml: unknown): string | null {
    if (typeof xml !== "string") return "a Tiled map must be a string";
    if (!/<map[\s>]/.test(xml)) return "not a Tiled map: no <map> element";
    const m = /<map[^>]*>/.exec(xml);
    const a = attributes(m ? m[0] : "");
    const cells = num(a.width, 0) * num(a.height, 0);
    if (cells > TILED_MAX_CELLS) return `map of ${cells} cells is larger than this reads`;
    if (a.infinite === "1") return "infinite maps are not supported yet";
    return null;
}

/** Layer data, whichever of the three ways it was written. */
function readData(
    body: string, encoding: string, compression: string,
    inflate: ((d: Uint8Array) => Uint8Array) | undefined, notes: string[]
): number[] | null {
    if (encoding === "csv" || encoding === "") {
        // `Number` skips surrounding whitespace itself, and Tiled writes CSV across many lines,
        // so no trimming step is needed here. `>>> 0` is: it makes this path return the same
        // uint32s the binary path's `getUint32` does, rather than a double for a flagged GID.
        return body.split(",").map(v => Number(v) >>> 0);
    }
    if (encoding !== "base64") { notes.push(`layer encoding "${encoding}" is not one this reads`); return null; }
    const binary = typeof atob === "function"
        ? Uint8Array.from(atob(body.trim()), c => c.charCodeAt(0))
        : Uint8Array.from(Buffer.from(body.trim(), "base64"));
    let bytes = binary;
    if (compression) {
        if (!inflate) { notes.push(`layer is ${compression}-compressed and nothing was supplied to inflate it`); return null; }
        bytes = inflate(binary);
    }
    // FOUR BYTES PER GID, little-endian — the one place this format is not text.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: number[] = [];
    for (let i = 0; i + 4 <= bytes.length; i += 4) out.push(view.getUint32(i, true));
    return out;
}

/**
 * The map's tilesets, layers and cells.
 *
 * Throws on anything `tiledMapError` refuses. `inflate` is optional and only needed for a
 * zlib-compressed layer; without it such a layer is skipped with a note rather than failing the map,
 * so the tilesets and the other layers still arrive.
 */
export function parseTiledMap(xml: string, opts?: { inflate?: (d: Uint8Array) => Uint8Array }): TiledMapResult {
    const bad = tiledMapError(xml);
    if (bad) throw new Error(`Invalid Tiled map: ${bad}.`);
    const notes: string[] = [];
    const mapAttrs = attributes((/<map[^>]*>/.exec(xml) as RegExpExecArray)[0]);

    const tilesets: TiledTileset[] = [];
    for (const m of xml.matchAll(/<tileset\b[^>]*>/g)) {
        const a = attributes(m[0]);
        // An EMBEDDED set carries its own <image>, which is the next one after this tag.
        const after = xml.slice(m.index + m[0].length);
        // The element's OWN body, so a collection set's tiles are read and the NEXT set's are not.
        const end = after.search(/<\/tileset>/);
        const body = a.source === undefined ? after.slice(0, end < 0 ? after.length : end) : "";
        const img = a.source === undefined ? /<image\b[^>]*>/.exec(body.slice(0, 400)) : null;
        const ia = img && !/<tile\b/.test(body.slice(0, (img.index ?? 0))) ? attributes(img[0]) : {};
        const extras = tilesetExtras(body);
        tilesets.push(deriveGrid({
            firstGid: num(a.firstgid, 1),
            source: a.source ?? null,
            name: a.name ?? "",
            tileWidth: num(a.tilewidth, num(mapAttrs.tilewidth, 0)),
            tileHeight: num(a.tileheight, num(mapAttrs.tileheight, 0)),
            columns: num(a.columns, 0),
            tileCount: num(a.tilecount, 0),
            spacing: num(a.spacing, 0),
            margin: num(a.margin, 0),
            image: ia.source ?? null,
            imageWidth: ia.width !== undefined ? num(ia.width, 0) : null,
            imageHeight: ia.height !== undefined ? num(ia.height, 0) : null,
            ...extras
        }));
    }

    const layers: TiledLayer[] = [];
    for (const m of xml.matchAll(/<layer\b([^>]*)>([\s\S]*?)<\/layer>/g)) {
        if (layers.length >= TILED_MAX_LAYERS) { notes.push(`more than ${TILED_MAX_LAYERS} layers`); break; }
        const a = attributes("<layer" + m[1] + ">");
        const dataTag = /<data\b([^>]*)>([\s\S]*?)<\/data>/.exec(m[2]);
        if (!dataTag) { notes.push(`layer "${a.name ?? ""}" has no data`); continue; }
        const da = attributes("<data" + dataTag[1] + ">");
        const raw = readData(dataTag[2], da.encoding ?? "", da.compression ?? "", opts?.inflate, notes);
        if (!raw) continue;
        layers.push({
            name: a.name ?? "",
            width: num(a.width, num(mapAttrs.width, 0)),
            height: num(a.height, num(mapAttrs.height, 0)),
            cells: raw.map(decodeGid)
        });
    }

    // Reported for the sets this map could measure. An EXTERNAL one has no image until a caller
    // resolves it, so that caller checks it then — `tilesetOverflow` is exported for exactly that.
    for (const set of tilesets) {
        const over = tilesetOverflow(set);
        if (over) notes.push(over);
    }

    return {
        width: num(mapAttrs.width, 0),
        height: num(mapAttrs.height, 0),
        tileWidth: num(mapAttrs.tilewidth, 0),
        tileHeight: num(mapAttrs.tileheight, 0),
        orientation: mapAttrs.orientation ?? "orthogonal",
        tilesets, layers, notes
    };
}

/** An external `.tsx`, merged onto the stub the map declared. */
export function parseTiledTileset(xml: string, into: TiledTileset): TiledTileset {
    const t = /<tileset\b[^>]*>/.exec(xml);
    const a = t ? attributes(t[0]) : {};
    const img = /<image\b[^>]*>/.exec(xml);
    // A COLLECTION's first `<image>` belongs to its first `<tile>`, not to the set. Taking it as
    // the sheet would give a set whose every cell is cut out of tile zero's picture.
    const ia = img && !/<tile\b/.test(xml.slice(0, img.index)) ? attributes(img[0]) : {};
    const extras = tilesetExtras(xml);
    // The map's `firstgid` is NOT in the external file — it belongs to the reference, not to the
    // set — so it is carried over rather than read, which is the one field a naive merge loses.
    // DERIVED AFTER the merge, never before: the image is what the grid is derived from and it
    // arrives in this file, so a stub deriving on its own would have nothing to divide.
    return deriveGrid({
        ...into,
        name: a.name ?? into.name,
        tileWidth: num(a.tilewidth, into.tileWidth),
        tileHeight: num(a.tileheight, into.tileHeight),
        columns: num(a.columns, into.columns),
        tileCount: num(a.tilecount, into.tileCount),
        spacing: num(a.spacing, into.spacing),
        margin: num(a.margin, into.margin),
        image: ia.source ?? into.image,
        imageWidth: ia.width !== undefined ? num(ia.width, 0) : into.imageWidth,
        imageHeight: ia.height !== undefined ? num(ia.height, 0) : into.imageHeight,
        ...extras
    });
}

/** The set a GID belongs to — the one with the largest `firstGid` at or below it. */
export function tilesetFor(tilesets: readonly TiledTileset[], gid: number): TiledTileset | null {
    let best: TiledTileset | null = null;
    for (const t of tilesets) {
        if (t.firstGid <= gid && (!best || t.firstGid > best.firstGid)) best = t;
    }
    return best;
}

/**
 * Where a tile lives in its sheet.
 *
 * The same arithmetic `SheetSlice` performs, applied to one index rather than a whole grid: N cells
 * take N widths and N-1 gutters, so the spacing is added per cell and the margin once.
 */
export function tileSourceRect(set: TiledTileset, gid: number): SourceRect | null {
    if (gid <= 0 || set.columns <= 0 || set.tileWidth <= 0 || set.tileHeight <= 0) return null;
    const index = gid - set.firstGid;
    if (index < 0) return null;
    if (set.tileCount > 0 && index >= set.tileCount) return null;
    const col = index % set.columns, row = Math.floor(index / set.columns);
    return {
        x: set.margin + col * (set.tileWidth + set.spacing),
        y: set.margin + row * (set.tileHeight + set.spacing),
        width: set.tileWidth,
        height: set.tileHeight
    };
}

/**
 * A cell's flips as a rotation and a scale this document can hold.
 *
 * The three bits are three REFLECTIONS: `flipD` transposes the tile (x and y swap), then `flipH`
 * negates x, then `flipV` negates y, in that order. Together they generate all eight symmetries of
 * a square, which is exactly what a rotation plus one axis flip also generates — so every cell has
 * an exact answer here and none has to be approximated.
 *
 * The mapping is DERIVED rather than tabulated by eye. `Matrix.compose` builds the linear part as
 * `R(t)·S(sx,sy)`, whose entries are `[[cos·sx, -sin·sy], [sin·sx, cos·sy]]`. Fixing `scaleY` at 1
 * leaves eight combinations of `sx` and a quarter turn, and matching entries against the reflection
 * product gives `sx = det(M)`, `cos t = M11`, `sin t = -M01`. Rotation is in RADIANS clockwise,
 * which is the unit `transform.rotation` is defined in.
 */
export function tileTransform(cell: TiledCell): { rotation: number; scaleX: number; scaleY: number } {
    // An odd number of reflections is a mirror image, which is what the sign of the determinant is.
    const mirrored = (cell.flipD ? 1 : 0) + (cell.flipH ? 1 : 0) + (cell.flipV ? 1 : 0);
    const scaleX = mirrored % 2 === 1 ? -1 : 1;
    // Without the transpose the tile stays axis-aligned, so the only turn is the half one `flipV`
    // forces: negating y alone is a 180-degree turn composed with the x flip that `scaleX` carries.
    const quarter = !cell.flipD
        ? (cell.flipV ? 2 : 0)
        // WITH it, the tile turns a quarter. Which way depends on `flipH`: transposing and then
        // mirroring x is a clockwise quarter, while transposing alone is an anticlockwise one.
        : (cell.flipH ? 1 : 3);
    return { rotation: (quarter * Math.PI) / 2, scaleX, scaleY: 1 };
}

/**
 * Whether a set claims more tiles than its own sheet can hold — a warning, not a refusal.
 *
 * THIS EXISTS BECAUSE "IT PARSED" IS NOT A CHECK. Before collection sets were understood, one real
 * `.tsx` had its first tile's image taken as the whole sheet: the set then declared 348 tiles in a
 * 256x352 picture and placed its last one at y=122,144. Every function returned a plausible value,
 * every field was populated, and the file sailed through a sweep whose only question was whether
 * parsing threw. Asking something that CAN fail is the difference.
 *
 * It is a note rather than an error because a set may legitimately over-declare and simply leave
 * the tail unused; what it must not do is go unmentioned.
 */
export function tilesetOverflow(set: TiledTileset): string | null {
    // A collection has no grid to overflow, and an unresolved external set has no image to measure
    // against — neither is a mismatch, so neither is reported.
    if (set.tiles.length > 0) return null;
    if (!set.image || set.imageWidth === null || set.imageHeight === null) return null;
    if (set.tileCount <= 0) return null;
    const last = tileSourceRect(set, set.firstGid + set.tileCount - 1);
    if (!last) return `tileset "${set.name}" declares ${set.tileCount} tiles its grid cannot index`;
    if (last.x + last.width > set.imageWidth || last.y + last.height > set.imageHeight) {
        return `tileset "${set.name}" declares ${set.tileCount} tiles but its `
            + `${set.imageWidth}x${set.imageHeight} image ends before tile ${set.tileCount - 1}`;
    }
    return null;
}

/**
 * A collection set's own file for one GID, or null when the set is sheet-backed.
 *
 * A caller asks this FIRST: a collection tile is a whole file drawn at its own size, and only a
 * sheet-backed set has a rect to cut. Checking `image` on the set would be the wrong test, since
 * both kinds have images — one has a sheet and the other has many.
 */
export function tileImageFor(set: TiledTileset, gid: number): TiledTileImage | null {
    // GID 0 is EMPTY by the format's reservation, not merely by falling below a firstGid of 1 — a
    // set declaring `firstgid="0"` would otherwise make it index tile zero. A sheet-backed set
    // needs no separate test: its `tiles` is empty, so the search below finds nothing.
    if (gid <= 0) return null;
    const id = gid - set.firstGid;
    return set.tiles.find(t => t.id === id) ?? null;
}

/**
 * Where a cell sits on screen.
 *
 * ORTHOGONAL is a plain grid. ISOMETRIC is a diamond — four of the measured maps — where moving one
 * column goes half a tile right and half a tile DOWN, and moving one row goes half a tile left and
 * half down. Treating an isometric map as a grid produces a rectangle of tiles that overlap
 * nothing, which looks like a broken tileset rather than a misread orientation.
 */
export function tilePosition(
    map: { orientation: string; tileWidth: number; tileHeight: number }, col: number, row: number
): { x: number; y: number } {
    if (map.orientation === "isometric") {
        return {
            x: (col - row) * (map.tileWidth / 2),
            y: (col + row) * (map.tileHeight / 2)
        };
    }
    return { x: col * map.tileWidth, y: row * map.tileHeight };
}
