/**
 * @module TiledMap
 * @description A `.tmx` map as tiles this engine can already draw.
 *
 * A Tiled map is a grid of references into a sheet, which is exactly what this engine now models: a
 * tile is a `sourceRect` (schema 51), a tileset is a grid `SheetSlice` recovers, and the `spacing`
 * Tiled writes is the gutter that slicer already takes. So the work here is resolving a GID to a
 * tileset and a cell; everything downstream already exists.
 *
 * A LAYER ARRIVES AS ONE NODE WHERE IT CAN. `tilemapForLayer` turns a whole tile layer into a single
 * `core.tilemap` (schema 61) holding indices, which is 45 of the 53 layers here and 98.4% of their
 * cells; the rest keep the node-per-cell path, and each is told why. The per-cell functions
 * (`tileSourceRect`, `tileTransform`, `tilePosition`) are therefore not legacy — they are what draws
 * the layers a grid cannot express, and both paths cut a sheet with the same shared arithmetic.
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
 * ORIENTATION CHANGES PLACEMENT, NOT PARSING. THREE maps are isometric, where a cell sits on a
 * diamond rather than a grid, so the placement formula lives here and the orientation is reported
 * rather than assumed. (It was recorded here as four: a fourth file carries `orientation="isometric"`
 * on a tileset's `<grid>`, not on its `<map>`. Counting a string rather than the element it sits on
 * is how a corpus measurement goes quietly wrong. Re-measured since: all three of those maps have an
 * EMPTY tile layer, so no isometric cell in this corpus has ever been placed by anything.)
 *
 * WHAT THE SPEC SAYS IS NOT A GAP. `<grid>` appears in three tilesets here and is deliberately
 * ignored: it "is only used in case of isometric orientation, and determines how tile overlays for
 * terrain and collision information are rendered" — an EDITOR overlay for data this reader does not
 * carry. Listing it as unread would have made it look like missing work.
 *
 * MEASURED AGAINST TWO CORPORA, which is the correction that matters. The ASSET TREE holds 22
 * `.tmx` and 14 `.tsx` (two of them inside a `.zip` the sweep had never opened) and uses none of
 * the format's richer parts. TILED'S OWN EXAMPLES ship nearly all of them, and this reader has now
 * been run over every one: object layers, image layers, properties, tile animations, wangsets,
 * hexagonal maps, templates, parallax factors, and layer opacity/visibility. Nothing threw, nothing
 * was refused, no layer came out the wrong length and no gid failed to resolve.
 *
 * WHAT THAT RUN FOUND was not a crash but a SILENCE: `sticker-knight/sandbox.tmx` is 79x45 with
 * ELEVEN object layers and not one `<layer>`, and it parsed "successfully" into zero layers and
 * zero cells with nothing said — indistinguishable from a blank map. Unread content is now counted
 * and reported for exactly that reason. Layer `opacity` and `visible` are READ rather than noted,
 * because both are cheap and both are wrong to ignore in a way a viewer sees at once.
 *
 * OBJECT LAYERS ARE READ (2026-08-10), which is the half of Tiled a game needs first: a tile layer
 * says what is at every position, an object layer says where a few THINGS are. Measured before it
 * was designed — the asset tree's 20 maps have none at all, and the sandbox fixture has 11 groups
 * and 114 objects that are 103 tile objects, 9 template references and 2 plain rectangles, with not
 * one point, ellipse, polygon, polyline or text among them. So the effort went where the objects
 * are, and the shapes the format allows but this corpus never uses are read as far as their box and
 * REPORTED rather than pretended.
 *
 * A TILE OBJECT'S (x, y) IS ITS BOTTOM-LEFT CORNER and every other object's is its top-left, which
 * is the single most common Tiled importing bug and the reason `objectBox` exists as the only
 * sanctioned way to ask where an object is. It is invisible in the worst way: every object still
 * lands somewhere plausible, one object-height too low.
 *
 * STILL DELIBERATELY UNREAD, and now reported: image layers, group nesting, an object layer's
 * parallax factor, the `.tx` files template objects name, and any orientation `tilePosition` cannot
 * place. Tile animations, wangsets, terrains, infinite chunks and a TILE's custom properties are
 * unread and NOT reported — they change no tile's position, so a note about them would be noise on
 * a map that draws correctly.
 */

import { SourceRect, PathCommand, UserData, UserProperty, variantNameError,
    USER_DATA_MAX, USER_VALUE_MAX } from "../document/Node";
// THE SAME THREE FLAGS IN A SECOND ENCODING. Tiled packs them into the top bits of a 32-bit gid;
// a `Tilemap` cell holds them as 1/2/4 in a parallel array. Aliased rather than renamed either
// side, so the two names cannot be confused at a glance the way `FLIP_H` twice over would be.
import {
    Tilemap, TileSheet, TILE_EMPTY, tilemapError, tileSourceRect as sheetSourceRect,
    FLIP_H as CELL_FLIP_H, FLIP_V as CELL_FLIP_V, FLIP_D as CELL_FLIP_D
} from "../document/Tilemap";

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
    /**
     * `offsetx`/`offsety` in pixels, applied to the whole layer. Both default to 0.
     *
     * DISTINCT FROM A TILESET'S `<tileoffset>`, which shifts every tile drawn FROM THAT SET however
     * many layers use it. This shifts one layer whatever sets it draws from. A reader that folded
     * the two into one number would be right only while a map used exactly one of them.
     */
    offsetX: number;
    offsetY: number;
    /**
     * `opacity`, 0..1, defaulting to 1 — and `visible`, defaulting to true.
     *
     * READ RATHER THAN NOTED, because both are cheap and both are WRONG to ignore in a way a
     * viewer sees immediately. Tiled's own automapping examples hide three layers of a six-layer
     * map; drawing them puts the rule's OUTPUT on top of its input, which looks like a corrupt map
     * rather than a layer flag nobody read.
     */
    opacity: number;
    visible: boolean;
    /** Row-major, `width * height` long. */
    cells: TiledCell[];
}

/**
 * One object in an object layer: an ENTITY rather than a cell.
 *
 * A tile layer says what is at every position; an object layer says where a few things ARE. That is
 * the difference between a map and a level — a spawn point, a door, a collision volume, a decoration
 * placed off the grid — and it is the half of Tiled a game needs first.
 *
 * MEASURED (2026-08-10): the asset tree's 20 maps have NO object layers at all. Tiled's own
 * `sticker-knight` sandbox, kept here as `test-fixtures/tiled/object-only.tmx`, has 11 groups and
 * 114 objects: 103 TILE objects, 9 template references and 2 plain rectangles. Thirteen carry flip
 * bits in their gid, eight carry a rotation, 19 carry custom properties, exactly one carries a
 * `type`, and none carries a name. There is not one point, ellipse, polygon, polyline or text object
 * in the tree — so those are read as far as their box and REPORTED, rather than pretended.
 */
export interface TiledObject {
    id: number;
    name: string;
    /**
     * Tiled's `type` (1.8 and earlier) or `class` (1.9 and later) — one field, renamed mid-format.
     *
     * BOTH ARE READ INTO ONE FIELD because they are the same thing, and a reader that knew only the
     * newer name would silently drop every class in the corpus that exists: the one typed object in
     * this tree writes `type="exit"`.
     */
    className: string;
    /** What the object IS, which decides how its box is anchored — see `objectBox`. */
    kind: "tile" | "rectangle" | "ellipse" | "point" | "polygon" | "polyline" | "text" | "template";
    /** As the file states them. NOT a top-left corner for a tile object — see `objectBox`. */
    x: number;
    y: number;
    width: number;
    height: number;
    /** Degrees, CLOCKWISE, about the object's own (x, y) — which is not its centre. */
    rotation: number;
    visible: boolean;
    /** The tile and its flips, for a tile object; null for every other kind. */
    cell: TiledCell | null;
    /** The `.tx` file a template object names. Resolving it needs a filesystem, so a CALLER does. */
    template: string | null;
    /** Custom properties, values kept as WRITTEN — see `TiledProperty`. */
    properties: TiledProperty[];
    /**
     * What `parseProperties` found and could not read — currently only class properties, whose
     * members are a nested record and not text. COUNTED so the one thing it can never be is silent.
     */
    unreadProperties: string[];
    /** A polygon's or polyline's points, relative to (x, y). Empty for every other kind. */
    points: { x: number; y: number }[];
}

/**
 * One custom property, with its declared type and its value AS WRITTEN.
 *
 * THE VALUE IS NOT PARSED, and that is deliberate. Tiled's types are `string`, `int`, `float`,
 * `bool`, `color`, `file`, `object` and `class`, and what a consumer wants from each differs: a
 * game's loader wants a number, an inspector wants the text the author typed, and a round-trip back
 * to `.tmx` wants the exact string. Parsing here would pick one and lose the others; the type is
 * carried so any of them can be done by whoever knows which.
 */
export interface TiledProperty {
    name: string;
    /** `string` when the file omits it, which is what the format's default means. */
    type: string;
    /**
     * The `propertytype` attribute — the ENUM or class name the type refers to.
     *
     * AN ENUM IS WRITTEN AS ITS BASE TYPE PLUS THIS NAME (`type="string" propertytype="Mood"`), so a
     * reader that keeps only `type` turns every enum into a plain string and cannot write it back.
     * The name is the whole difference, and it costs one field to keep.
     */
    propertyType?: string;
    value: string;
}

/** An object layer: the things, plus what the layer does to all of them. */
export interface TiledObjectGroup {
    id: number;
    name: string;
    opacity: number;
    visible: boolean;
    offsetX: number;
    offsetY: number;
    objects: TiledObject[];
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
    /** Object layers, in file order. Empty for the 20 maps in this tree, which have none. */
    objectGroups: TiledObjectGroup[];
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
/**
 * `body` from `at` to the MATCHING `</tag>`, counting nested opens so a class property's members do
 * not end the scan at the first close. Returns the inner text and where to resume.
 */
function takeElement(body: string, at: number, tag: string): { inner: string; end: number } {
    const scan = new RegExp(`<${tag}\\b[^>]*?(\\/>|>)|<\\/${tag}\\s*>`, "g");
    scan.lastIndex = at;
    let depth = 1;
    let m: RegExpExecArray | null;
    while ((m = scan.exec(body)) !== null) {
        if (m[0].startsWith("</")) {
            if (--depth === 0) return { inner: body.slice(at, m.index), end: scan.lastIndex };
        } else if (m[1] === ">") depth++;
    }
    return { inner: body.slice(at), end: body.length };
}

/**
 * The `<property>` elements of one element's body, and what could not be read.
 *
 * A DEPTH-AWARE SCAN RATHER THAN A FLAT REGEX, and the difference is not tidiness. The flat form
 * this replaces ran over the object's WHOLE inner body, so a CLASS property's nested members matched
 * as siblings of the object's own: a member named `friction` would overwrite the object's real
 * `friction`, and the exporter would then write those members back out as top-level properties the
 * author never wrote. A file silently restructured, not a type word lost — which is why this is a
 * precondition for storing properties at all rather than a refinement of it.
 *
 * A BODY-FORM PROPERTY (`<property name="x">two\nlines</property>`) is how the format writes a
 * MULTILINE string, and the flat form read every one of them as `""`. Reading it is free once the
 * scan exists.
 */
export function parseProperties(body: string): { props: TiledProperty[]; unread: string[] } {
    const props: TiledProperty[] = [];
    const unread: string[] = [];
    const re = /<property\b([^>]*?)(\/>|>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        const a = attributes(`<property${m[1]}>`);
        // THE DEFAULT LIVES IN ONE PLACE. `string` is what an absent type MEANS in the format, and
        // writing it in makes every consumer's switch total — but the two branches below would each
        // have had to remember that, which is one copy too many of a rule.
        const head = { type: a.type ?? "string",
            ...(a.propertytype !== undefined ? { propertyType: a.propertytype } : {}) };
        if (m[2] === "/>") {
            if (a.name === undefined) continue;
            props.push({ name: a.name, ...head, value: a.value ?? "" });
            continue;
        }
        const { inner, end } = takeElement(body, re.lastIndex, "property");
        re.lastIndex = end;
        if (/<properties\b/.test(inner)) {
            // A CLASS PROPERTY'S MEMBERS ARE NOT READ, and this is where that is DECIDED rather than
            // discovered: schema 64 stores text values, and a nested record is not text. Counted, so
            // the one thing it must not be is silent. There are none in this tree's files.
            unread.push(`property "${a.name ?? "?"}" is a class property, whose members are not read`);
            continue;
        }
        if (a.name === undefined) continue;
        props.push({ name: a.name, ...head, value: unescapeXml(inner) });
    }
    return { props, unread };
}

function attributes(tag: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)) out[m[1]] = unescapeXml(m[3]);
    return out;
}

/**
 * An attribute's value as the file MEANT it, with XML's escapes undone.
 *
 * THIS WAS MISSING, and nothing noticed for a simple reason: no map in the corpus contains an
 * ampersand. Tiled escapes layer names, object names, class names and every custom property value,
 * so a map with a layer called `Rocks & Dirt` read back as `Rocks &amp; Dirt` — a name that looks
 * almost right, survives a save, and only reveals itself when somebody searches for it. Found when
 * the EXPORTER started escaping properly and the round trip did not close.
 *
 * AMPERSAND LAST, which is the one ordering rule here: undoing it first would turn `&amp;lt;` — a
 * file that means the literal text `&lt;` — into a `<`, inventing markup the author escaped on
 * purpose. Numeric references are decoded too, because Tiled writes them for anything outside its
 * encoding.
 */
function unescapeXml(value: string): string {
    if (!value.includes("&")) return value;
    return value
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&amp;/g, "&");
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
 * The same set, told how big its image really is — and re-derived.
 *
 * `deriveGrid` runs at parse time and bails on its first line when `imageWidth` is null, because
 * there is nothing to divide. That is the whole of the remaining gap, and it is one file wide.
 * Swept over every `<tileset>` in the tree (46 of them): 32 declare no usable `columns`, 6 of those
 * are COLLECTIONS with no grid to cut, and of the 26 sheet-backed ones **25 declare `<image
 * width height>` and already work**. The twenty-sixth is Tiled's own `perspective_walls.tsx`, which
 * declares neither the count nor the size, so its 79 painted cells all resolved to nothing.
 *
 * A FUNCTION RATHER THAN AN ARGUMENT TO THE PARSER, for the reason the parser takes `inflate` and
 * resolves no paths: reading an image needs a filesystem or a decoder, and this module has neither.
 * The caller is the only thing holding both the set and the bitmap; this is where it puts them
 * together. Pure, synchronous, and testable without either.
 *
 * IT NEVER OVERRIDES WHAT THE FILE SAID. A set that declares its own size or its own `columns` is
 * returned untouched — the file is the authority, and a measured bitmap that disagreed with it
 * would be a second answer to a question already answered. That is also what makes this safe to
 * call on every set rather than only on the broken ones.
 */
export function withImageSize(set: TiledTileset, width: number, height: number): TiledTileset {
    if (set.imageWidth !== null || !Number.isFinite(width) || !Number.isFinite(height)
        || width <= 0 || height <= 0) {
        return set;
    }
    return deriveGrid({ ...set, imageWidth: width, imageHeight: height });
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
/**
 * What one object becomes on this canvas, or null with a reason.
 *
 * THE TWIN OF `tilemapForLayer`, deliberately: it answers "here is a node" or "here is why not", it
 * names the tileset image as a PATH rather than loading it, and the caller resolves that against a
 * filesystem this module refuses to know about. Everything here is arithmetic that can be tested.
 *
 * THREE KINDS NEVER BECOME A NODE, and each is refused rather than approximated:
 *   - a POINT has no size, and a marker of invented size is a lie about where the author clicked;
 *   - a TEXT object's string is not read at all, so it would arrive as an empty box;
 *   - a TEMPLATE names a `.tx` file nothing has opened, so its size and picture are unknown.
 * The map-level notes already count all three; this returns the same reason per object so a caller
 * placing one at a time is not left guessing.
 */
export interface TiledObjectPlacement {
    /** The node type this becomes, named by what the engine already has to hold it. */
    shape: "image" | "rectangle" | "ellipse" | "path";
    /** The node's box, in map pixels, ANCHORED TOP-LEFT — `objectBox` has already been applied. */
    x: number;
    y: number;
    width: number;
    height: number;
    /** A tile object's sheet, as the tileset NAMED it. Null for every shape. */
    image: string | null;
    /** Which part of that sheet, or null for a collection tile (which is a whole file). */
    sourceRect: SourceRect | null;
    /** Radians, and the fraction of the box the turn is about — see `objectTransform`. */
    rotation: number;
    origin: { x: number; y: number };
    /** The gid's flips, as this engine states them. 1 unless the tile is mirrored. */
    scaleX: number;
    scaleY: number;
    /** A polygon's or polyline's commands, relative to the box above. Null for every other shape. */
    path: PathCommand[] | null;
    /** A label for the layers panel: the object's name, else its class, else its id. */
    name: string;
    /** The author's own kind for this object (schema 64), or "" when the file gave none. */
    className: string;
    /** The object's custom properties as the document holds them — see `userDataFor`. */
    userData: UserData;
}

/** A placement, or the reason there is none. */
export interface TiledObjectFit {
    placement: TiledObjectPlacement | null;
    why: string | null;
}

/**
 * A file's property LIST as the document's property MAP, and everything that could not come.
 *
 * IT CANNOT EMIT A MAP THE LOADER WOULD REFUSE, and that is the whole contract rather than caution.
 * Import runs inside a `TransactionAction`, which THROWS when a component action fails validation —
 * so a map that trips `userDataError` does not drop one property, it aborts the whole import and
 * turns a legal file into one that cannot be opened at all. A property named `constructor`, or the
 * sixty-fifth on one object, is a thing a real editor will happily write. Every rule the validator
 * has is therefore enforced here as a skip-and-report.
 *
 * LAST WINS on a duplicate name, and it is REPORTED: a node holding two `friction`s resolves to
 * nothing whichever one is picked, and the editor that wrote the file cannot author the duplicate,
 * so the tie-break is decided once here instead of by every reader downstream.
 */
export function userDataFor(
    props: readonly TiledProperty[]
): { data: UserData; unread: string[] } {
    const data: Record<string, UserProperty> = {};
    const unread: string[] = [];
    for (const p of props) {
        // BEFORE the assignment, and by `hasOwnProperty` rather than `in`, so `__proto__` is CAUGHT
        // rather than swallowed by the prototype setter — a value stored under it could never be
        // read back, which is a silent loss rather than a refusal.
        if (variantNameError("name", p.name, true) !== null) {
            unread.push(`property "${p.name}" has a name this document cannot hold`);
            continue;
        }
        if (p.value.length > USER_VALUE_MAX) {
            unread.push(`property "${p.name}" is ${p.value.length} characters, over the ${USER_VALUE_MAX} limit`);
            continue;
        }
        const already = Object.prototype.hasOwnProperty.call(data, p.name);
        if (!already && Object.keys(data).length >= USER_DATA_MAX) {
            unread.push(`property "${p.name}" is past the ${USER_DATA_MAX}-property limit`);
            continue;
        }
        if (already) unread.push(`property "${p.name}" appears more than once; the last one is kept`);
        data[p.name] = p.propertyType !== undefined
            ? { type: p.type, propertyType: p.propertyType, value: p.value }
            : { type: p.type, value: p.value };
    }
    return { data, unread };
}

export function objectPlacement(
    obj: TiledObject, tilesets: readonly TiledTileset[]
): TiledObjectFit {
    // A NAME FOR THE PANEL, not data: the object's own name if it has one, else its class, else its
    // id. The corpus names nothing and classes exactly one thing, so most of these read "object 90"
    // — which is still the id an author can find in Tiled.
    const name = obj.name || obj.className || `object ${obj.id}`;
    const box = objectBox(obj);
    const turn = objectTransform(obj);
    // THE METADATA TRAVELS WITH THE SHAPE. The reader has parsed the class and the properties since
    // object layers landed, and this function dropped both on the floor because a node had nowhere
    // to put them (schema 64 gave it one). Everything that could not come is reported by the caller.
    const { data: userData } = userDataFor(obj.properties);
    const base = {
        x: box.x, y: box.y, width: box.width, height: box.height,
        rotation: turn.rotation, origin: turn.origin, scaleX: 1, scaleY: 1,
        image: null as string | null, sourceRect: null as SourceRect | null,
        path: null as PathCommand[] | null, name,
        className: obj.className, userData
    };

    if (obj.kind === "template") {
        return { placement: null, why: `object ${obj.id} is a template reference (${obj.template}), `
            + "whose file is not opened here" };
    }
    if (obj.kind === "point") {
        return { placement: null, why: `object ${obj.id} is a point, which has no size to place` };
    }
    if (obj.kind === "text") {
        return { placement: null, why: `object ${obj.id} is text, and its string is not read` };
    }
    if (obj.kind === "polygon" || obj.kind === "polyline") {
        // THE BOX IS THE POINTS' OWN BOUNDS, because a polygon object states no width or height —
        // both are 0 in the file. A node sized 0x0 is invisible and unpickable, so the geometry has
        // to be derived, and the commands are then stated RELATIVE to it: this engine's path
        // commands are local to the node's box, and Tiled's points are relative to the object's
        // origin, which are two different origins whenever a point is negative. The fixture's
        // polyline runs to -5, so this is checkable rather than assumed.
        if (obj.points.length < 2) {
            return { placement: null, why: `object ${obj.id} is a ${obj.kind} with fewer than two points` };
        }
        const xs = obj.points.map(pt => pt.x), ys = obj.points.map(pt => pt.y);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        const commands: PathCommand[] = obj.points.map((pt, i) => (
            i === 0 ? { c: "M" as const, x: pt.x - minX, y: pt.y - minY }
                : { c: "L" as const, x: pt.x - minX, y: pt.y - minY }
        ));
        // A POLYGON CLOSES AND A POLYLINE DOES NOT, which is the whole difference between the two
        // kinds and the only thing a consumer can tell them apart by once they are paths.
        if (obj.kind === "polygon") commands.push({ c: "Z" });
        return {
            placement: {
                ...base, shape: "path",
                x: obj.x + minX, y: obj.y + minY,
                width: Math.max(...xs) - minX, height: Math.max(...ys) - minY,
                path: commands
            },
            why: null
        };
    }
    if (obj.kind === "ellipse") return { placement: { ...base, shape: "ellipse" }, why: null };
    if (obj.kind === "rectangle") return { placement: { ...base, shape: "rectangle" }, why: null };

    // A TILE OBJECT: the picture is a tileset's, resolved exactly as a cell's is — a collection tile
    // is a whole file with no rect to cut, and a sheet tile is a rect inside one image.
    const cell = obj.cell;
    const set = cell ? tilesetFor(tilesets, cell.gid) : null;
    if (!cell || !set) {
        return { placement: null, why: `object ${obj.id} names tile ${cell ? cell.gid : "?"}, `
            + "which is in no tileset this map declares" };
    }
    const own = tileImageFor(set, cell.gid);
    const rect = own ? null : tileSourceRect(set, cell.gid);
    const image = own ? own.image : set.image;
    if (!image || (!own && !rect)) {
        return { placement: null, why: `object ${obj.id} names tile ${cell.gid}, whose tileset has no image` };
    }
    // THE FLIPS ARE THE SAME ARITHMETIC A CELL'S ARE, through the same function — a second copy
    // would be a second chance to disagree about which of the three bits is a mirror.
    const t = tileTransform(cell);
    return {
        placement: {
            ...base, shape: "image", image, sourceRect: rect,
            // THE TILE'S TURN COMPOSES WITH THE OBJECT'S. A flipped-and-rotated object carries both,
            // and adding them is right because both are stated about the same axis; the origin stays
            // the object's bottom-left, which is what Tiled turns about.
            rotation: base.rotation + t.rotation,
            scaleX: t.scaleX, scaleY: t.scaleY
        },
        why: null
    };
}

/**
 * The objects of one `<objectgroup>` body.
 *
 * KIND IS DECIDED BY WHAT THE TAG CARRIES, in the order the format resolves it: a `template`
 * reference first (it supplies everything else and this reader has not opened it), then a child
 * element naming a shape, then a `gid` making it a tile, and a bare box is a rectangle. Deciding on
 * `gid` first would call a templated tile object a tile and then report a box the template holds.
 */
function parseObjects(body: string): TiledObject[] {
    const out: TiledObject[] = [];
    // Each object is its own tag, self-closing or with a body — the same shape the tileset scan
    // uses, and the reason both are written out rather than shared: a `<object>` inside a `<text>`
    // does not exist, but a `<properties>` inside an object does, and the lazy close is what keeps
    // one object's properties out of the next one.
    for (const m of body.matchAll(/<object\b([^>]*?)(\/>|>([\s\S]*?)<\/object>)/g)) {
        const a = attributes(`<object${m[1]}>`);
        const inner = m[3] ?? "";
        const points = (tag: string) => {
            const p = new RegExp(`<${tag}\\b[^>]*>`).exec(inner);
            if (!p) return [];
            const raw = attributes(p[0]).points ?? "";
            return raw.split(" ").filter(Boolean).map(pair => {
                const [px, py] = pair.split(",");
                return { x: num(px, 0), y: num(py, 0) };
            });
        };
        const kind: TiledObject["kind"] =
            a.template !== undefined ? "template"
            : /<point\b/.test(inner) ? "point"
            : /<ellipse\b/.test(inner) ? "ellipse"
            : /<polygon\b/.test(inner) ? "polygon"
            : /<polyline\b/.test(inner) ? "polyline"
            : /<text\b/.test(inner) ? "text"
            : a.gid !== undefined ? "tile"
            : "rectangle";
        // `string` IS THE FORMAT'S DEFAULT, and `parseProperties` writes it in so every consumer's
        // switch is total — an absent type is not a missing property, it is a text one.
        const { props: properties, unread: unreadProps } = parseProperties(inner);
        out.push({
            id: num(a.id, 0),
            name: a.name ?? "",
            // BOTH SPELLINGS, one field: `type` is what 1.8 wrote and `class` is what 1.9 renamed it
            // to. The newer wins when a file somehow carries both.
            className: a.class ?? a.type ?? "",
            kind,
            x: num(a.x, 0),
            y: num(a.y, 0),
            // A POINT AND A TEMPLATE HAVE NO SIZE of their own, and 0 is the honest answer rather
            // than a guess — a template's size lives in the file this has not opened.
            width: num(a.width, 0),
            height: num(a.height, 0),
            rotation: num(a.rotation, 0),
            visible: a.visible === undefined ? true : num(a.visible, 1) !== 0,
            cell: a.gid !== undefined ? decodeGid(num(a.gid, 0)) : null,
            template: a.template ?? null,
            properties,
            unreadProperties: unreadProps,
            points: kind === "polygon" ? points("polygon") : kind === "polyline" ? points("polyline") : []
        });
    }
    return out;
}

/**
 * Where an object's box IS, in map pixels, anchored top-left like every node in this engine.
 *
 * A TILE OBJECT'S (x, y) IS ITS BOTTOM-LEFT CORNER. Every other object's is its top-left. That one
 * asymmetry is the most common Tiled importing bug there is, and it is invisible in the worst way:
 * every object still lands somewhere plausible, just one tile-height too low, so a level looks
 * "slightly off" rather than broken. Tiled inherited it from an era when a tile object was drawn
 * from its baseline, and the format kept it.
 *
 * THE HEIGHT USED IS THE OBJECT'S OWN, not the tile's. A tile object may be stretched — 103 of the
 * 114 objects in the fixture are tile objects and their sizes vary from 32x512 to 2528x385 — so
 * subtracting the tileset's tile height would be right only for an unscaled one.
 */
export function objectBox(obj: TiledObject): { x: number; y: number; width: number; height: number } {
    return {
        x: obj.x,
        y: obj.kind === "tile" ? obj.y - obj.height : obj.y,
        width: obj.width,
        height: obj.height
    };
}

/**
 * An object's rotation, as this engine states one: RADIANS, and the fraction of the box it turns about.
 *
 * TILED ROTATES ABOUT THE OBJECT'S OWN (x, y) — which `objectBox` has just established is the
 * BOTTOM-LEFT for a tile object and the top-left for everything else. This engine rotates about a
 * `transform.origin` given as a fraction of the box, so the two are reconciled by naming the corner
 * rather than by moving the object: {0, 1} for a tile object, {0, 0} for the rest.
 *
 * THE SIGN IS NOT FLIPPED, and that is worth stating because "clockwise" usually means a sign
 * change. It does not here: the format's degrees are clockwise on a screen whose y grows DOWNWARD,
 * and so are this engine's radians — two conventions that happen to agree, and a reader that
 * "corrected" for the word clockwise would mirror every rotated object.
 */
export function objectTransform(obj: TiledObject): { rotation: number; origin: { x: number; y: number } } {
    return {
        rotation: obj.rotation * Math.PI / 180,
        origin: obj.kind === "tile" ? { x: 0, y: 1 } : { x: 0, y: 0 }
    };
}

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
            // BOTH DEFAULT TO 0, per the spec. One map in the tree offsets a layer by -30 vertically;
            // dropping it draws that layer 30 pixels low, which reads as art aligned wrongly rather
            // than as a missing attribute.
            offsetX: num(a.offsetx, 0),
            offsetY: num(a.offsety, 0),
            // CLAMPED, not trusted: the format states 0..1 and nothing enforces it, and an opacity
            // above 1 would brighten rather than fade wherever a backend multiplies by it.
            opacity: Math.min(1, Math.max(0, num(a.opacity, 1))),
            // ABSENT MEANS SHOWN. Only an explicit "0" hides a layer — treating any present value
            // as a flag would hide every layer that says visible="1".
            visible: a.visible === undefined ? true : num(a.visible, 1) !== 0,
            cells: raw.map(decodeGid)
        });
    }

    // CONTENT THIS READER DOES NOT CARRY IS REPORTED, NOT PASSED OVER IN SILENCE. A map whose
    // whole content is object layers — Tiled's own `sticker-knight` sandbox is exactly that, 79x45
    // with not one <layer> in it — otherwise parses "successfully" into zero layers and zero cells,
    // and a caller cannot tell that from an empty map. That is the same silent-nothing this
    // codebase has been bitten by twice, and a count is what makes it visible.
    // OBJECT LAYERS ARE READ NOW, and what remains unread inside them is counted instead. The note
    // this replaces said "object layer(s) are not read", which was the honest report of a real gap;
    // the same discipline applies one level down, because a template this cannot open and a shape it
    // can only give a box to are both content a caller must know it is not getting.
    const objectGroups: TiledObjectGroup[] = [];
    for (const m of xml.matchAll(/<objectgroup\b([^>]*?)(\/>|>([\s\S]*?)<\/objectgroup>)/g)) {
        const a = attributes(`<objectgroup${m[1]}>`);
        objectGroups.push({
            id: num(a.id, 0),
            name: a.name ?? "",
            // The same two rules a tile layer follows, for the same two reasons — clamped because
            // nothing enforces 0..1, and shown unless the file explicitly says "0".
            opacity: Math.min(1, Math.max(0, num(a.opacity, 1))),
            visible: a.visible === undefined ? true : num(a.visible, 1) !== 0,
            offsetX: num(a.offsetx, 0),
            offsetY: num(a.offsety, 0),
            objects: parseObjects(m[3] ?? "")
        });
    }
    const allObjects = objectGroups.flatMap(g => g.objects);
    const templated = allObjects.filter(o => o.kind === "template").length;
    if (templated > 0) {
        notes.push(`${templated} object(s) reference a template file, which is not opened here; `
            + "they carry a position and nothing else");
    }
    // TEXT IS THE ONLY SHAPE WHOSE CONTENT IS LOST, and this note used to claim four. Writing the
    // consumer is what corrected it: an ellipse IS its box, and a polygon's and polyline's points
    // are read — all three have an exact node type waiting for them (`core.ellipse`, `core.path`),
    // so calling them unrepresented was a note that would have sent someone looking for work that
    // was already done. A text object really does lose its string, its font and its alignment.
    const texts = allObjects.filter(o => o.kind === "text").length;
    if (texts > 0) {
        notes.push(`${texts} text object(s) are read as a box only; the string is not read`);
    }
    // A POINT keeps its position and has no size, so nothing is lost in the READING — it is
    // placement that has nowhere to put it, and `objectPlacement` says so per object.

    // PARALLAX IS A LAYER PROPERTY THIS ENGINE HAS (schema 40, `applyParallax`) and this reader does
    // not carry — so a map whose clouds drift at 0.5 comes in pinned to the ground. Counted rather
    // than silently flattened; three groups in the fixture use it.
    const parallaxGroups = [...xml.matchAll(/<objectgroup\b[^>]*\bparallax[xy]=/g)].length;
    if (parallaxGroups > 0) {
        notes.push(`${parallaxGroups} object layer(s) set a parallax factor, which is not read`);
    }
    const imageLayers = [...xml.matchAll(/<imagelayer\b/g)].length;
    if (imageLayers > 0) notes.push(`${imageLayers} image layer(s) are not read`);
    // A <group> NESTS layers, so its children are found by the layer scan above but their grouping
    // — and any offset or opacity the group carries — is lost. Reported for that reason, not
    // because the tiles go missing.
    const nested = [...xml.matchAll(/<group\b/g)].length;
    if (nested > 0) notes.push(`${nested} group layer(s) are flattened; their own offset and opacity are lost`);

    // AN ORIENTATION `tilePosition` CANNOT PLACE. Hexagonal and staggered maps parse perfectly —
    // the cells are right — and then land on an orthogonal grid, which is wrong in a way that looks
    // like a broken tileset. Tiled ships a hexagonal example; this tree has none.
    const orientation = mapAttrs.orientation ?? "orthogonal";
    if (orientation !== "orthogonal" && orientation !== "isometric") {
        notes.push(`orientation "${orientation}" is not one this places; cells are laid out orthogonally`);
    }

    // RENDER ORDER IS REPORTED, NOT IMPLEMENTED. All 20 maps in the tree use the default
    // `right-down`, so nothing here has ever depended on it — which is exactly why a silent
    // assumption is worth a note instead: the day a map says otherwise, the tiles come out in the
    // wrong order and nothing says why. The spec adds that it is "only supported for orthogonal
    // maps at the moment", so an isometric map naming one is Tiled's own no-op, not this reader's.
    const order = mapAttrs.renderorder ?? "right-down";
    if (order !== "right-down") {
        notes.push(`render order "${order}" is not one this places; tiles are laid out right-down`);
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
        orientation,
        tilesets, layers, objectGroups, notes
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
 * Where a tile lives in its sheet, for a GID.
 *
 * THE ARITHMETIC IS NOT HERE. It is `Tilemap.tileSourceRect`, which the RENDERER also calls, and
 * that is the point: a document holding a grid and an importer filling one must slice a sheet the
 * same way or the map draws one pixel out per column. This half is the GID semantics — which set a
 * gid belongs to, and whether the set actually has that many tiles — and it is genuinely this
 * module's business, because a `Tilemap` has no gids.
 */
export function tileSourceRect(set: TiledTileset, gid: number): SourceRect | null {
    if (gid <= 0) return null;
    const index = gid - set.firstGid;
    if (set.tileCount > 0 && index >= set.tileCount) return null;
    return sheetSourceRect(
        { columns: set.columns, tileWidth: set.tileWidth, tileHeight: set.tileHeight,
          spacing: set.spacing, margin: set.margin },
        index
    );
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
 * ORTHOGONAL is a plain grid. ISOMETRIC is a diamond — three of the measured maps — where moving one
 * column goes half a tile right and half a tile DOWN, and moving one row goes half a tile left and
 * half down. Treating an isometric map as a grid produces a rectangle of tiles that overlap
 * nothing, which looks like a broken tileset rather than a misread orientation.
 *
 * THAT USED TO SAY NOTHING HERE HAD EVER PLACED A REAL ISOMETRIC CELL, and it stopped being true
 * when `isometric-sample.tmx` was vendored: 60x32 at 256x128, three layers, **51 painted cells**,
 * found inside `Tiled Sample.zip` — the asset sweep had never looked in archives. The three
 * 60x60-and-empty maps are still there and still empty; they are simply no longer all of it. (It
 * was recorded as four maps until the count was re-run against the `<map>` element itself — one
 * file carries `orientation="isometric"` on a tileset's `<grid>`, which is an editor overlay hint.)
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

/**
 * Where one cell's PICTURE goes, box and all — `tilePosition` plus the thing it does not know.
 *
 * A TILE IS ANCHORED AT THE BOTTOM of its cell, so art taller than the grid stands UP from it. This
 * is not a preference and it is not derivable from `tilePosition`, which answers where the CELL is.
 * Two of Tiled's own examples settle it, and they settle it by what their authors did NOT have to
 * write:
 *
 *   - `perspective_walls.tsx` — 64x64 tiles on 31x31 cells — declares `<tileoffset x="-32" y="0">`.
 *     Under top-alignment those walls would sink 33px through the floor, and the author would have
 *     had to write `y="-33"` to stand them back up. They wrote zero.
 *   - `isometric_grass_and_water.tsx` — 64x64 tiles on 64x32 cells — declares `y="16"`, a nudge.
 *     Under top-alignment it would need to be a whole tile height.
 *
 * Both offsets are SMALL, which is only possible if the default already puts the art where the
 * artist meant. That is the same rule `objectBox` implements for a tile OBJECT (bottom-left in the
 * format, top-left here) and the same one `collectionTileBox` draws with, so all three agree.
 *
 * WHAT THIS FIXES: the per-cell import path placed every tile at the cell's TOP, which is correct
 * for the 98% of layers whose art is exactly cell-sized and wrong for every layer where it is not —
 * nine maps in the measured tree, from a 64x64 tile on a 60x60 grid to 384x332 art on 32x32 cells.
 * The error is the difference between the two heights, so it grew with the overhang and looked like
 * badly drawn art rather than arithmetic.
 *
 * THE X CONVENTION IS LEFT ALONE, deliberately. Bottom-LEFT means the picture's left edge sits at
 * the cell's, which `tilePosition` already gives for an orthogonal map; for isometric, Tiled measures
 * from the diamond's bounding box, which differs from this by a constant half-tile for EVERY cell.
 * A constant translates the whole layer and preserves how tiles of different widths line up against
 * each other, so it is a placement question rather than an anchoring one — and the node's own
 * position is where it belongs. Recorded rather than folded in silently.
 */
export function tileImageBox(
    map: { orientation: string; tileWidth: number; tileHeight: number },
    layer: { offsetX: number; offsetY: number },
    set: { offsetX: number; offsetY: number },
    image: { width: number; height: number },
    col: number, row: number
): { x: number; y: number; width: number; height: number } {
    const at = tilePosition(map, col, row);
    return {
        x: at.x + set.offsetX + layer.offsetX,
        // THE CELL'S BOTTOM, minus the picture's own height. For art exactly one cell tall this is
        // `at.y` — so every layer in the corpus that already looked right still does, byte for byte.
        y: at.y + map.tileHeight - image.height + set.offsetY + layer.offsetY,
        width: image.width,
        height: image.height
    };
}

/** One Tiled layer as the single `core.tilemap` node it can become. */
export interface TiledTilemapLayer {
    /**
     * The sheet, exactly as the map NAMED it — a relative path, not something loadable.
     *
     * Resolving it needs a filesystem, which is what keeps this module pure and testable, so the
     * caller does that and puts the result in the node's `src`.
     */
    image: string;
    /**
     * How that image is CUT — reported rather than stamped on the node (schema 67).
     *
     * The tileset is the document's now, and only the caller can build it, because only the caller
     * sees every layer at once and can tell that six of them name one set. That is where the
     * measured 2.5x duplication is actually collected; this function reports what a set would have
     * to be, and does not decide which one it is.
     */
    sheet: TileSheet;
    /** Where the node goes, in map pixels, and how big it is. */
    x: number;
    y: number;
    width: number;
    height: number;
    tilemap: Tilemap;
    /** The layer's own opacity and visibility, which one node per layer can finally carry. */
    opacity: number;
    hidden: boolean;
    /**
     * Cells whose gid named a tile the tileset does not have — holes, COUNTED rather than hidden.
     *
     * A layer is not refused for these: one bad cell in ten thousand should not send the whole
     * layer back to ten thousand nodes. But it must not go unmentioned either, which is the same
     * rule `notes` follows.
     */
    dropped: number;
}

/** Whether a layer fits one grid, and if not, what stopped it. */
export interface TiledTilemapFit {
    layer: TiledTilemapLayer | null;
    /** Why not — non-null exactly when `layer` is null. */
    why: string | null;
}

/**
 * A whole tile layer as ONE `core.tilemap`, or the reason it cannot be.
 *
 * THIS IS WHY THE NODE EXISTS. The measured import of `Roguelike Base Pack/Map/sample_map.tmx` made
 * one `core.image` per non-empty cell — 10,618 nodes, 22ms of derivation before anything was drawn.
 * A `Tilemap` holds the same map as five arrays of small integers, so this function is the whole
 * distance between the two.
 *
 * A GRID CANNOT EXPRESS EVERY LAYER, and the honest answer is to say so per layer rather than to
 * approximate. Measured over the 53 tile layers in `freeassets`: 45 of them fit, carrying 22,440 of
 * the 22,808 non-empty cells — 98.4%. What stops the other eight is not exotic:
 *
 *   * 5 layers whose TILES ARE BIGGER THAN THEIR CELLS — 64x64 art on a 60x60 grid, and 24x24 on
 *     18x18. Tiled draws such a tile at its own size, overhanging its neighbours; every backend
 *     here draws a tilemap cell INTO its cell, so the grid would squash it. That is a wrong picture
 *     rather than a missing one, so those layers keep the node-per-cell path they already had.
 *   * 3 layers with no tiles at all. There is no sheet to name and nothing to draw, so nothing is
 *     made — the same as today.
 *
 * Two conditions that would have needed handling turned out not to arise, and both were checked
 * rather than assumed: NO layer in the corpus draws from two tilesets (which a single-sheet node
 * could not hold), and no layer's data length disagrees with its own width and height.
 *
 * THE LAST WORD IS `tilemapError`'s. Whatever is built here is offered to the document's own
 * validator before being returned, so this cannot mint a node that would fail to reopen — the
 * failure that made a deleted bone leave an unopenable file.
 */
export function tilemapForLayer(
    map: { orientation: string; tileWidth: number; tileHeight: number },
    layer: TiledLayer,
    tilesets: readonly TiledTileset[],
    /**
     * The document tileset id for the set this layer draws from (schema 67).
     *
     * A FUNCTION, NOT A STRING, because identity is the CALLER's to decide and deduplication is the
     * whole point: only the caller sees every layer at once and can tell that six of them name one
     * set. Passing it in also means there is never an intermediate `Tilemap` carrying an empty id —
     * `tilemapError` refuses one, and a validator with a hole for "not filled in yet" is a hole.
     */
    tilesetIdFor: (set: TiledTileset) => string
): TiledTilemapFit {
    const no = (why: string): TiledTilemapFit => ({ layer: null, why: `layer "${layer.name}" ${why}` });

    // ORIENTATION FIRST, because it is the one condition about the MAP: an isometric cell sits on a
    // diamond and a `Tilemap` is a plain grid, so those maps stay with `tilePosition` and one node
    // per cell. UNEXERCISED BY THE CORPUS, and said plainly rather than left to be assumed: all
    // three isometric maps here have a tile layer holding zero tiles, so this branch is reached only
    // by its unit test. It is written anyway, because the alternative is laying a diamond flat.
    if (map.orientation !== "orthogonal") return no(`is ${map.orientation}, which a grid cannot place`);
    if (layer.cells.length !== layer.width * layer.height) {
        return no(`holds ${layer.cells.length} cells for a ${layer.width}x${layer.height} grid`);
    }

    // ONE SHEET PER NODE is the constraint the whole fit turns on. Compared by `firstGid` rather
    // than by object identity, so a caller that rebuilt its tilesets — which the app does, to merge
    // in the external `.tsx` files — is not told its layer spans two sets.
    let set: TiledTileset | null = null;
    let filled = 0, missing = 0;
    for (const cell of layer.cells) {
        if (cell.gid === 0) continue;
        filled++;
        const found = tilesetFor(tilesets, cell.gid);
        if (!found) { missing++; continue; }
        if (!set) set = found;
        else if (found.firstGid !== set.firstGid) return no("draws from more than one tileset");
    }
    if (filled === 0 || !set) return no("has no tiles");
    // A gid below every `firstGid` belongs to no set at all. Never seen in the corpus, and handed
    // back to the per-cell path rather than drawn as a hole, so it stays counted as `unresolved`
    // wherever it was counted before.
    if (missing > 0) return no(`has ${missing} cell(s) that name no tileset`);
    if (set.tiles.length > 0) return no("draws from a tileset that gives each tile its own file");
    if (!set.image) return no("draws from a tileset that names no sheet");
    // THE CELL AND THE ART MUST BE THE SAME SIZE. Five layers in the corpus fail this and it is not
    // a rounding matter: a 64x64 tile on a 60x60 grid overhangs in Tiled and would be squashed here.
    if (set.tileWidth !== map.tileWidth || set.tileHeight !== map.tileHeight) {
        return no(`draws ${set.tileWidth}x${set.tileHeight} tiles on a `
            + `${map.tileWidth}x${map.tileHeight} grid, which a cell cannot hold`);
    }

    const sheet: TileSheet = {
        columns: set.columns, tileWidth: set.tileWidth, tileHeight: set.tileHeight,
        spacing: set.spacing, margin: set.margin
    };
    const tiles: number[] = [];
    const flips: number[] = [];
    let turned = false, dropped = 0;
    for (const cell of layer.cells) {
        // GID TO INDEX, once, here — the reason a `Tilemap` holds indices at all. A gid means
        // something only beside the map's tileset table; an index means the same thing wherever
        // the layer is pasted.
        const rect = cell.gid === 0 ? null : tileSourceRect(set, cell.gid);
        if (!rect) {
            if (cell.gid !== 0) dropped++;
            tiles.push(TILE_EMPTY);
            flips.push(0);
            continue;
        }
        tiles.push(cell.gid - set.firstGid);
        const flip = (cell.flipH ? CELL_FLIP_H : 0) | (cell.flipV ? CELL_FLIP_V : 0)
            | (cell.flipD ? CELL_FLIP_D : 0);
        flips.push(flip);
        if (flip !== 0) turned = true;
    }

    const tilemap: Tilemap = {
        cols: layer.width, rows: layer.height,
        // THE MAP's cell size, not the sheet's tile size. They are equal by the check above, and
        // they are still two different fields: one is how far apart cells sit on the canvas, the
        // other is how the sheet is cut.
        tileWidth: map.tileWidth, tileHeight: map.tileHeight,
        tilesetId: tilesetIdFor(set),
        tiles,
        // OMITTED WHEN NOTHING IS TURNED, which is most layers — 27 of the 45 that fit carry no
        // flip at all, and an array of zeros per cell would be pure weight in the saved file.
        ...(turned ? { flips } : {})
    };
    const bad = tilemapError(tilemap);
    if (bad) return no(bad);

    return {
        layer: {
            image: set.image,
            sheet,
            // BOTH OFFSETS FOLD INTO THE NODE, which is only sound because exactly one tileset
            // reaches this point: a `<tileoffset>` shifts every tile drawn from that set, and here
            // that is every tile in the layer. The node-per-cell path had to add it per tile.
            x: layer.offsetX + set.offsetX,
            y: layer.offsetY + set.offsetY,
            width: layer.width * map.tileWidth,
            height: layer.height * map.tileHeight,
            tilemap,
            // READ RATHER THAN DROPPED. The node-per-cell path had nowhere to put a layer's opacity
            // — it would have meant fading ten thousand nodes independently, which composites
            // differently — so it silently ignored both. One node per layer makes them a field
            // each. No layer in `freeassets` uses either, and Tiled's own automapping examples hide
            // three layers of six, which is why the parser reads them in the first place.
            opacity: layer.opacity,
            hidden: !layer.visible,
            dropped
        },
        why: null
    };
}
