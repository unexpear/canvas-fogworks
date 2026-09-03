/**
 * @module tiledPlacements
 * @description A parsed Tiled map becomes placements and tilesets — the half of the importer that
 * had no caller but a folder dialog.
 *
 * WHY THIS MODULE EXISTS, and it is the failure this project keeps finding rather than a tidiness
 * pass. Two hundred and forty-one lines of this conversion lived inside a `<select onChange>` in
 * `App.tsx`, and `window.electronAPI` is FROZEN and non-configurable — so the handler could not be
 * driven from CDP, from a test, or from a script. The ACTIONS were extracted to
 * `core/actions/tileImport` months ago for exactly this reason; the code that decides WHAT to place
 * never followed them out, so the most complicated part of the importer was the only part nothing
 * could exercise. It was found by trying to import a real asset pack and discovering there was no
 * way to do it twice.
 *
 * THE SEAM IS AFTER THE FILESYSTEM, deliberately. Resolving an external `.tsx`, reading a PNG and
 * measuring an image are all async I/O that belongs to whoever has a filesystem — the parser's own
 * header says so and it is why the parser stays testable. So this takes a map that is already
 * parsed, sets that are already resolved and sheets that are already loaded, and is PURE: no I/O, no
 * clock, no React, and even the id source is a parameter, because a test that cannot predict the
 * ids cannot assert on the output.
 *
 * IT DECIDES NOTHING ABOUT THE DOCUMENT. `tileImportActions` turns placements into actions and this
 * turns a map into placements; neither knows about the other, and the ordering rule between them —
 * a tile layer ends the object layer above it — is stated once, over there.
 */
import { Tileset } from "../document/Tileset";
import { entityFromUserData } from "../document/Entity";
import { TilePlacement } from "../actions/tileImport";
import {
    TiledMapResult, TiledTileset,
    tilemapForLayer, tilesetFor, tileImageFor, tileSourceRect, tileImageBox, tileTransform,
    objectPlacement
} from "./TiledMap";

/** What one map became, and everything a caller needs to report honestly about it. */
export interface PlacementResult {
    placements: TilePlacement[];
    /** One per DISTINCT set, minted on first sight — where the measured 2.5x duplication collapses. */
    tilesets: Tileset[];
    /** Cells and objects that could not be placed, counted the same way whichever path drew them. */
    unresolved: number;
    /** Why, not merely how many — the difference between a file to fix and a feature we lack. */
    problems: string[];
}

export interface PlacementOptions {
    /**
     * The id source. A PARAMETER because a test cannot assert on output it cannot predict, and
     * because identity is the caller's to decide — the same reason `tilemapForLayer` takes a
     * function rather than a string.
     */
    newId?: () => string;
    /** Notes the caller already collected while resolving files, kept in front of ours. */
    problems?: readonly string[];
}

let counter = 0;
const fallbackId = () => `tileset-${++counter}`;

/**
 * The placements and tilesets one parsed map yields.
 *
 * `sheets` maps a path AS THE FILE NAMED IT to the loaded image (a data URL, usually). A path that
 * is missing is not an error here — the layer takes the per-cell path or the cell is counted
 * unresolved — because a half-loaded map that says so beats one that throws.
 */
export function buildPlacements(
    map: TiledMapResult,
    sets: readonly TiledTileset[],
    sheets: ReadonlyMap<string, string>,
    opts?: PlacementOptions
): PlacementResult {
    const newId = opts?.newId ?? fallbackId;
    const placements: TilePlacement[] = [];
    const problems: string[] = [...(opts?.problems ?? [])];
    let unresolved = 0;

    // ONE TILESET PER DISTINCT SET, minted on first sight and reused — this is where the measured
    // 2.5x actually collapses. Tiled's own examples hold 41 tile layers drawing from 12 sets, and
    // every layer used to carry its own copy of the picture.
    const setIds = new Map<TiledTileset, string>();
    const tilesets: Tileset[] = [];
    const tilesetIdFor = (set: TiledTileset): string => {
        const had = setIds.get(set);
        if (had !== undefined) return had;
        const id = newId();
        setIds.set(set, id);
        tilesets.push({
            id,
            name: set.name || "Tileset",
            // RESOLVED BY THE CALLER, as the parser's own header says: it reports the path the file
            // named, and reading it needs a filesystem this module does not have.
            src: sheets.get(set.image ?? "") ?? null,
            sheet: {
                columns: set.columns, tileWidth: set.tileWidth, tileHeight: set.tileHeight,
                spacing: set.spacing, margin: set.margin
            },
            // A COLLECTION set's per-tile images, which had nowhere to live until schema 67 —
            // 1,207 of them in this corpus.
            tiles: set.tiles.map(t => ({
                id: t.id,
                ...(t.image !== null ? { src: sheets.get(t.image) ?? t.image, width: t.width, height: t.height } : {}),
                ...(t.probability !== undefined ? { probability: t.probability } : {}),
                ...(t.className !== undefined ? { className: t.className } : {}),
                ...(t.userData !== undefined ? { userData: t.userData } : {}),
                ...(entityFromUserData(t.userData) ? { entity: entityFromUserData(t.userData) } : {}),
                ...(t.collision !== undefined ? { collision: t.collision } : {}),
                ...(t.animation !== undefined ? { animation: t.animation } : {})
            })),
            offsetX: set.offsetX, offsetY: set.offsetY,
            ...(set.wangsets && set.wangsets.length > 0 ? { wangsets: set.wangsets } : {})
        });
        return id;
    };

    for (const layer of map.layers) {
        // THE GRID IS TRIED FIRST, LAYER BY LAYER. 45 of the corpus's 53 tile layers become one
        // `core.tilemap` each, which is what turns a 10,618-node import into a 5-node one; the rest
        // fall through to the loop below, which is the only thing that can draw them.
        const fit = tilemapForLayer(map, layer, sets, tilesetIdFor);
        const sheet = fit.layer ? sheets.get(fit.layer.image) : undefined;
        if (fit.layer && sheet) {
            placements.push({
                kind: "tilemap",
                x: fit.layer.x, y: fit.layer.y,
                width: fit.layer.width, height: fit.layer.height,
                // NO `src` (schema 68) — the picture went onto the TILESET above, and `sheet` is
                // still read here because a layer whose image did not load takes the per-cell path
                // rather than becoming a grid that draws nothing.
                map: fit.layer.tilemap,
                name: layer.name || "Tile layer",
                opacity: fit.layer.opacity, hidden: fit.layer.hidden
            });
            // A HOLE COUNTS WHERE EVERY OTHER UNPLACEABLE CELL COUNTS, so the same map reports the
            // same number whichever path drew it.
            unresolved += fit.layer.dropped;
            continue;
        }
        // WHY, not merely "not a grid": a layer that fell back is a layer costing a thousand nodes,
        // and the reason is the difference between a file to fix and a feature we lack.
        problems.push(fit.why ?? `layer "${layer.name}" fits a grid but its sheet did not load`);
        for (let i = 0; i < layer.cells.length; i++) {
            const cell = layer.cells[i];
            if (cell.gid === 0) continue;                  // EMPTY is most of a map
            const set = tilesetFor(sets, cell.gid);
            if (!set) { unresolved++; continue; }
            // A COLLECTION tile is asked about FIRST: it is a whole file at its own size, so there
            // is no rect to cut and the set's declared tile size does not apply to it.
            const own = tileImageFor(set, cell.gid);
            const rect = own ? null : tileSourceRect(set, cell.gid);
            const path = own ? own.image : set.image;
            const src = path ? sheets.get(path) : undefined;
            if (!src || (!own && !rect)) { unresolved++; continue; }
            // THE BOX, ANCHORING AND ALL, from `tileImageBox`. Both offsets are applied (the SET's
            // lets a tall tile hang above its own cell; the LAYER's shifts the whole layer, and one
            // corpus map moves one 30 pixels up), and a tile sits at the BOTTOM of its cell, so art
            // taller than the grid stands up from it instead of hanging down through the floor.
            // Nine maps in the tree have such art. The grid path folds the offsets into the node's
            // own position and refuses oversized art outright, so this is the only place either
            // question arises.
            const box = tileImageBox(map, layer, set,
                own ?? { width: set.tileWidth, height: set.tileHeight },
                i % layer.width, Math.floor(i / layer.width));
            const t = tileTransform(cell);
            placements.push({
                kind: "image",
                x: box.x, y: box.y, width: box.width, height: box.height,
                src, sourceRect: rect,
                name: `${layer.name} ${cell.gid}`,
                // Only the 820-in-124,692 that need one, so an unflipped tile carries no transform.
                transform: t.rotation === 0 && t.scaleX === 1 ? null : t
            });
        }
    }

    // OBJECT LAYERS, in file order AFTER the tile layers, so an entity sits above the ground it
    // stands on. Each group becomes a FRAME carrying the layer's opacity and visibility, and
    // `tileImportActions` nests what follows it.
    for (const group of map.objectGroups) {
        // ONE PASS, kept: `objectPlacement` resolves a tileset per object, and asking twice — once
        // to place and once to report — is the same work done again for 114 objects.
        const fits = group.objects.map(o => objectPlacement(o, sets));
        for (const fit of fits) {
            // WHY EACH ONE WAS REFUSED: a template reference and a text object are different gaps.
            if (fit.why) problems.push(fit.why);
        }
        const placeable = fits.filter(f => f.placement !== null);
        // AN EMPTY LAYER GETS NO FRAME. A map full of templates would otherwise import as a stack of
        // empty rectangles, which reads as a broken import rather than as content this cannot open.
        if (placeable.length === 0) continue;
        placements.push({
            kind: "group",
            // THE FRAME SPANS THE MAP, not its contents: an object layer has no box of its own, and
            // a frame sized to the objects would move whenever one did.
            x: group.offsetX, y: group.offsetY,
            width: map.width * map.tileWidth,
            height: map.height * map.tileHeight,
            name: group.name || "Object layer",
            opacity: group.opacity, hidden: !group.visible
        });
        for (const fit of placeable) {
            const pl = fit.placement!;
            const src = pl.image ? sheets.get(pl.image) : undefined;
            // A tile object whose sheet did not load is counted where every other unplaceable thing
            // is counted.
            if (pl.shape === "image" && !src) { unresolved++; continue; }
            placements.push({
                kind: "object",
                shape: pl.shape,
                x: pl.x + group.offsetX, y: pl.y + group.offsetY,
                width: pl.width, height: pl.height,
                name: pl.name,
                src: src ?? null,
                sourceRect: pl.sourceRect,
                // Emitted only when it turns or mirrors, so an ordinary entity carries none.
                transform: pl.rotation !== 0 || pl.scaleX !== 1 || pl.scaleY !== 1
                    ? { rotation: pl.rotation, scaleX: pl.scaleX, scaleY: pl.scaleY, origin: pl.origin }
                    : null,
                path: pl.path,
                // Carried, never read — see `TilePlacement`.
                className: pl.className,
                userData: pl.userData
            });
        }
    }

    return { placements, tilesets, unresolved, problems };
}

/**
 * What the drawer says after an import — extracted with the rest because a sentence assembled from
 * five counts and four plurals is exactly the kind of thing that rots unwatched, and it was
 * unreachable for the same reason everything else here was.
 */
export function importNote(map: TiledMapResult, result: PlacementResult): string {
    const grids = result.placements.filter(t => t.kind === "tilemap").length;
    const loose = result.placements.length - grids;
    const s = (n: number) => (n === 1 ? "" : "s");
    return `${grids} grid${s(grids)} from ${map.layers.length} layer${s(map.layers.length)}`
        + (loose > 0 ? ` · ${loose} loose tile${s(loose)}` : "")
        + ` · ${map.orientation}`
        + (result.unresolved > 0 ? ` · ${result.unresolved} unresolved` : "")
        + (result.problems.length > 0 ? ` · ${result.problems[0]}` : "");
}
