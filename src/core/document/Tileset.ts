/**
 * @module Tileset
 * @description A tileset the DOCUMENT holds, so more than one layer can draw from it (schema 67).
 *
 * WHAT THIS REPLACES, and the three measured defects behind it. Until now a tileset was not a thing
 * at all: it was a SLICING RULE STAPLED TO ONE IMAGE ON ONE NODE — a `core.tilemap` carried the
 * picture as its own `src` and `Tilemap.sheet` said how to cut it. Counted over 63 real files
 * (`scripts/measure-tilesets.py`):
 *
 *   - EVERY LAYER CARRIED ITS OWN COPY. Tiled's own examples hold 41 tile layers drawing from 12
 *     distinct tilesets, so an import produced 1,003KB where 407KB would do — a 2.5x duplication,
 *     before the ~1.37x base64 adds on the way into the document. One map is six layers of one
 *     tileset: six copies of one image.
 *   - A COLLECTION SET COULD NOT BE DESCRIBED. Tiled allows a set whose tiles are separate files
 *     rather than cells of one sheet, and that is not an edge case: 1,207 per-tile images in this
 *     corpus against 25 probabilities. `TiledMap` already parsed them and had nowhere to put them.
 *   - PER-TILE DATA HAD NO HOME, because there was no per-tile record.
 *
 * A SET IS EITHER SHEET-BACKED OR A COLLECTION, never both and never neither. Tiled enforces it and
 * the corpus holds no counterexample, so `tilesetError` refuses the mixture rather than picking one
 * — a set with both would make "where does tile 7 come from" have two answers.
 *
 * `tiles` IS SPARSE. 28 of 1,235 tiles in the corpus say anything at all, so only tiles that carry
 * something appear. A dense array would make a tileset's serialised size proportional to its tile
 * COUNT rather than to what an author actually authored, which for a 1,000-tile sheet is a thousand
 * empty records to hold twenty-five numbers.
 *
 * WHAT IS DELIBERATELY ABSENT: per-tile ANIMATION, COLLISION shapes, CLASS/TYPE, and Tiled's legacy
 * TERRAINTYPES. All four are absent from every file in the corpus. A field designed against nothing
 * is a field that will be wrong when something finally arrives — the same reasoning that kept
 * `sourceRect` out until a file needed it.
 */

import { TileSheet, tileSheetError } from "./Tilemap";
import { UserData, userDataError } from "./Node";
import { entityError } from "./Entity";

/** Caps, in the `TILEMAP_MAX_CELLS` tradition: a hostile file must not exhaust memory. */
export const TILESETS_MAX = 256;
export const TILESET_TILES_MAX = 65_536;
export const TILESET_NAME_MAX = 120;

export interface TileAnimationFrame { tileId: number; duration: number }

export interface TileCollisionShape {
    x: number; y: number; width: number; height: number; rotation: number;
    kind: "rectangle" | "ellipse" | "point" | "polygon" | "polyline";
    points?: { x: number; y: number }[];
}

export interface WangColor {
    name: string; color: string; tile: number; probability: number; userData?: UserData;
}

export interface WangTile { tileId: number; wangId: number[] }

export interface WangSet {
    name: string; className?: string; tile: number; userData?: UserData;
    colors: WangColor[]; tiles: WangTile[];
}

/**
 * One tile that has something to say — sparse, so most tiles of most sets never appear here.
 *
 * A COLLECTION set's tiles carry `src` and their natural size; a sheet-backed set's carry neither,
 * because the sheet and the index already answer where the pixels are.
 */
export interface TilesetTile {
    /** The tile's id WITHIN the set: the same number a cell stores. */
    id: number;
    /** A collection set's own image for this tile. Absent for a sheet-backed set. */
    src?: string;
    /** Its natural size. A collection tile is not on a grid, so it has no cell to infer one from. */
    width?: number;
    height?: number;
    /**
     * Weight when something picks among equivalent tiles — 25 of these in the corpus.
     *
     * NOT NORMALISED, because Tiled does not normalise it either: the weights are relative within
     * whatever set a chooser is choosing from, and rescaling them here would make a file that
     * round-trips through this engine disagree with the one Tiled wrote.
     */
    probability?: number;
    /** The same shape a node carries (schema 64). Three tiles in the corpus have properties. */
    userData?: UserData;
    /** Tiled's tile class/type, kept independently from custom properties. */
    className?: string;
    /** Per-tile collision shapes, in tile-local pixels. */
    collision?: TileCollisionShape[];
    /** The tile's single looping animation, in file order. */
    animation?: TileAnimationFrame[];
    /** Typed runtime declaration for this tile; legacy imported properties remain in userData. */
    entity?: import("./Entity").Entity;
}

/** A tileset the document holds. Any number of tilemap layers may name it. */
export interface Tileset {
    /** What a `Tilemap.tilesetId` names. Unique within the document. */
    id: string;
    /** For a picker. Not an identity — two sets may legitimately be called `Terrain`. */
    name: string;
    /** ONE image cut by a grid, or null for a collection set. */
    src: string | null;
    /** How to cut that image, or null for a collection set. */
    sheet: TileSheet | null;
    /** Sparse per-tile records. A collection set's tiles live here; a sheet-backed set's may. */
    tiles: TilesetTile[];
    /**
     * `<tileoffset>`: every tile this set draws is shifted by it. Eight files in the corpus carry
     * one, and it exists so a tall tile can hang ABOVE the cell it occupies — a building rooted in
     * one square standing over the three behind it.
     */
    offsetX: number;
    offsetY: number;
    /** Tiled terrain/autotiling metadata. It does not alter VDE's own terrain authoring model. */
    wangsets?: WangSet[];
}

/** What is wrong with one tileset, or null. Shared by the loader and the edit path. */
export function tilesetError(set: unknown): string | null {
    if (typeof set !== "object" || set === null || Array.isArray(set)) return "a tileset must be an object";
    const t = set as Partial<Tileset>;
    if (typeof t.id !== "string" || t.id.length === 0) return "tileset.id must be a non-empty string";
    if (typeof t.name !== "string" || t.name.length === 0) return "tileset.name must be a non-empty string";
    if (t.name.length > TILESET_NAME_MAX) return `tileset.name must be at most ${TILESET_NAME_MAX} characters`;
    if (!Number.isFinite(t.offsetX) || !Number.isFinite(t.offsetY)) return "tileset offsets must be finite";
    if (!Array.isArray(t.tiles)) return "tileset.tiles must be an array";
    if (t.tiles.length > TILESET_TILES_MAX) return `tileset.tiles must hold at most ${TILESET_TILES_MAX}`;

    // EITHER A SHEET OR A COLLECTION. Both would give "where does tile 7 come from" two answers;
    // neither leaves a set that can draw nothing, which is not a tileset but a name.
    const hasSheet = t.src !== null && t.src !== undefined && t.sheet !== null && t.sheet !== undefined;
    const halfSheet = (t.src === null || t.src === undefined) !== (t.sheet === null || t.sheet === undefined);
    if (halfSheet) return "a sheet-backed tileset needs both an image and a sheet, or neither";
    if (hasSheet) {
        const bad = tileSheetError(t.sheet);
        if (bad) return bad;
        if (typeof t.src !== "string" || t.src.length === 0) return "tileset.src must be a non-empty string";
    }

    const seen = new Set<number>();
    let collection = 0;
    for (const tile of t.tiles as TilesetTile[]) {
        if (typeof tile !== "object" || tile === null || Array.isArray(tile)) return "a tileset tile must be an object";
        if (!Number.isInteger(tile.id) || tile.id < 0) return "tileset tile.id must be a whole number >= 0";
        // UNIQUE, because the id is how a cell finds its tile. Two records for one id is a file
        // with two answers, and picking either silently is the kind nobody can debug.
        if (seen.has(tile.id)) return `tileset tile.id ${tile.id} appears twice`;
        seen.add(tile.id);
        if (tile.src !== undefined) {
            if (typeof tile.src !== "string" || tile.src.length === 0) return "tileset tile.src must be a non-empty string";
            collection++;
            if (!Number.isFinite(tile.width) || !Number.isFinite(tile.height)
                || (tile.width as number) <= 0 || (tile.height as number) <= 0) {
                return `tileset tile ${tile.id} has an image but no positive size`;
            }
        }
        if (tile.probability !== undefined
            && (!Number.isFinite(tile.probability) || (tile.probability as number) < 0)) {
            return "tileset tile.probability must be a finite number >= 0";
        }
        if (tile.userData !== undefined) {
            const bad = userDataError(tile.userData);
            if (bad) return `tileset tile ${tile.id}: ${bad}`;
        }
        if (tile.className !== undefined && (typeof tile.className !== "string" || tile.className.length === 0)) {
            return `tileset tile ${tile.id}: className must be a non-empty string`;
        }
        if (tile.animation !== undefined) {
            if (!Array.isArray(tile.animation) || tile.animation.length === 0) return `tileset tile ${tile.id}: animation must not be empty`;
            for (const frame of tile.animation) {
                if (!Number.isInteger(frame.tileId) || frame.tileId < 0
                    || !Number.isFinite(frame.duration) || frame.duration <= 0) {
                    return `tileset tile ${tile.id}: animation frames need tileId >= 0 and duration > 0`;
                }
            }
        }
        if (tile.collision !== undefined) {
            if (!Array.isArray(tile.collision)) return `tileset tile ${tile.id}: collision must be an array`;
            for (const shape of tile.collision) {
                if (!shape || typeof shape !== "object" || !["rectangle", "ellipse", "point", "polygon", "polyline"].includes(shape.kind)
                    || ![shape.x, shape.y, shape.width, shape.height, shape.rotation].every(Number.isFinite)
                    || shape.width < 0 || shape.height < 0
                    || (shape.points !== undefined && (!Array.isArray(shape.points)
                        || shape.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))))) {
                    return `tileset tile ${tile.id}: collision shape is invalid`;
                }
            }
        }
        const ee = entityError(tile.entity);
        if (ee) return `tileset tile ${tile.id}: ${ee}`;
    }

    if (t.wangsets !== undefined) {
        if (!Array.isArray(t.wangsets)) return "tileset.wangsets must be an array";
        for (const wang of t.wangsets) {
            if (!wang || typeof wang !== "object" || typeof wang.name !== "string"
                || !Number.isInteger(wang.tile) || !Array.isArray(wang.colors) || !Array.isArray(wang.tiles)) {
                return "tileset wangset is invalid";
            }
            if (wang.userData !== undefined && userDataError(wang.userData)) return `wangset "${wang.name}" has invalid properties`;
            for (const color of wang.colors) {
                if (!color || typeof color.name !== "string" || typeof color.color !== "string"
                    || !Number.isInteger(color.tile) || !Number.isFinite(color.probability)) return `wangset "${wang.name}" has an invalid color`;
                if (color.userData !== undefined && userDataError(color.userData)) return `wang color "${color.name}" has invalid properties`;
            }
            for (const tile of wang.tiles) {
                if (!Number.isInteger(tile.tileId) || tile.tileId < 0 || !Array.isArray(tile.wangId)
                    || tile.wangId.length !== 8 || tile.wangId.some(n => !Number.isInteger(n) || n < 0)) {
                    return `wangset "${wang.name}" has an invalid wang tile`;
                }
            }
        }
    }

    if (hasSheet && collection > 0) return "a tileset may have a sheet or per-tile images, not both";
    if (!hasSheet && collection === 0) return "a tileset needs either a sheet or at least one tile image";
    return null;
}


/** What is wrong with a document's whole table, or null. */
export function tilesetsError(sets: unknown): string | null {
    if (sets === undefined) return null;
    if (!Array.isArray(sets)) return "tilesets must be an array";
    if (sets.length > TILESETS_MAX) return `tilesets must hold at most ${TILESETS_MAX}`;
    const ids = new Set<string>();
    for (const set of sets) {
        const bad = tilesetError(set);
        if (bad) return bad;
        const id = (set as Tileset).id;
        // UNIQUE IDS, because a `tilesetId` names one — the same rule a clip's name follows.
        if (ids.has(id)) return `tileset id "${id}" is used twice`;
        ids.add(id);
    }
    return null;
}

/**
 * The tileset a `tilesetId` names, or null.
 *
 * GENERIC IN THE ELEMENT so one function serves both `ProjectDocument` and `ReadonlyDocument`,
 * whose `tilesets` is a DeepReadonly of the same shape. The alternative was a cast at every call
 * site, and a cast is where a readonly guarantee quietly stops being one.
 *
 * NULL RATHER THAN A THROW, and the caller must draw nothing rather than refuse the document: a
 * reference that stops resolving is INERT here, as everywhere else in this schema. Deleting a
 * tileset a layer still names should leave an empty grid a person can fix, not a file that will
 * not open — see `dangling-references-are-inert` and the `slotContent` precedent.
 */
export function findTileset<T extends { id: string }>(
    sets: readonly T[] | undefined, id: string | undefined
): T | null {
    if (!sets || id === undefined) return null;
    return sets.find(s => s.id === id) ?? null;
}

/** The record for one tile, or null — most tiles of most sets have none, which is not an error. */
export function tilesetTile<T extends { id: number }>(
    set: { tiles: readonly T[] } | null, id: number
): T | null {
    if (!set) return null;
    return set.tiles.find(t => t.id === id) ?? null;
}

/**
 * An independent copy of one tileset.
 *
 * THE ONE PLACE A TILESET IS COPIED, for the reason `copyTerrainMaterial` exists and then failed:
 * a control that rebuilds a record field by field silently drops the field added last, and this
 * codebase has now paid for that five times. The panel edits a table by mapping over it, so every
 * entry it does NOT edit still passes through a rebuild — which is exactly where `name` and `color`
 * were lost from a terrain material.
 *
 * AND IT TAKES A TILESET, NOT PARTS OF ONE. `copyTerrainMaterial` could be handed an object whose
 * fields had already been dropped and would faithfully copy the loss; taking the whole record and
 * spreading it means there is no shape a caller can assemble that omits something.
 */
export function copyTileset(t: Tileset): Tileset {
    return { ...t, sheet: t.sheet ? { ...t.sheet } : null,
        tiles: t.tiles.map(x => ({ ...x,
            ...(x.entity ? { entity: { ...x.entity } } : {}),
            ...(x.animation ? { animation: x.animation.map(f => ({ ...f })) } : {}),
            ...(x.collision ? { collision: x.collision.map(c => ({ ...c,
                ...(c.points ? { points: c.points.map(p => ({ ...p })) } : {}) })) } : {}) })),
        ...(t.wangsets ? { wangsets: t.wangsets.map(w => ({ ...w,
            colors: w.colors.map(c => ({ ...c })), tiles: w.tiles.map(x => ({ ...x, wangId: [...x.wangId] })) })) } : {}) };
}

/**
 * A set's sparse tile records with one tile's WEIGHT set — added, changed, or removed.
 *
 * A WEIGHT OF 1 REMOVES THE RECORD rather than storing it, because 1 is what a tile with no record
 * already means: every chooser weights an unmentioned tile as one. Storing it would make a file's
 * size grow with every tile somebody merely looked at, and would turn `tiles` from "what an author
 * authored" into "what a panel was pointed at" — which is the difference sparse was chosen for.
 *
 * A RECORD CARRYING ANYTHING ELSE SURVIVES. Removing the weight from a tile that also has
 * `userData` must keep the properties, or the panel becomes a way to lose them.
 */
export function withTileWeight(set: Tileset, id: number, weight: number): TilesetTile[] {
    if (!Number.isInteger(id) || id < 0 || !Number.isFinite(weight) || weight < 0) {
        return set.tiles.map(t => ({ ...t }));
    }
    const out = set.tiles.filter(t => t.id !== id).map(t => ({ ...t }));
    const had = set.tiles.find(t => t.id === id);
    if (weight === 1) {
        // The default: keep the record only if it still says something else.
        if (had) {
            const { probability: _dropped, ...rest } = had;
            if (Object.keys(rest).length > 1) out.push({ ...rest });
        }
    } else {
        out.push({ ...(had ?? {}), id, probability: weight });
    }
    return out.sort((a, b) => a.id - b.id);
}
