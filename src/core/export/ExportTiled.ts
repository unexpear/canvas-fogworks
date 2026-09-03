/**
 * @module ExportTiled
 * @description A document's tile layers back out as a `.tmx` — so a map authored here can leave.
 *
 * VDE can read a Tiled map, turn each layer into one `core.tilemap`, place its objects, and author
 * terrain that derives its own picture. Nothing could go the other way, which makes this tool a
 * one-way door: art comes in and never returns to the pipeline it came from.
 *
 * THE ORACLE IS THE ROUND TRIP, and it is the reason this module can be trusted at all. An exporter
 * with no reader is checked by reading its output and squinting; this one is checked by importing a
 * real Kenney map, exporting it, importing THAT, and comparing every cell. `parseTiledMap` is a
 * stranger to this file — it was written against files Tiled itself wrote — so agreeing with it is
 * evidence rather than a tautology.
 *
 * IT EXPORTS THE RESOLVED SCENE. An autotiled layer stores terrain and no tiles at all, so exporting
 * the stored document would write an empty map for the very layers this engine is proudest of.
 * `resolveTilemaps` is what turns the question back into the answer, and the answer is what `.tmx`
 * can hold — Tiled has no dual-grid terrain of its own, so the picture is the honest export.
 *
 * ONE `<tileset>` PER DISTINCT SET, each with its own `firstgid`. A document has been able to hold
 * several since schema 67 and this wrote one, so every other layer's cells indexed the first set's
 * picture: right places, wrong pictures, in a file that parses, opens in Tiled and reads as an art
 * mistake rather than as an export bug. A set declares the tile count ITS OWN layers reach — count
 * across the map and a small set inherits a large one's, which moves every set after it.
 *
 * ONE MAP SIZE, ONE TILE SIZE, which is the format's rule and not this module's. A document may hold
 * tilemap nodes of different grids and different cell sizes; a `.tmx` cannot. So the first layer sets
 * the map, and every layer that disagrees is REPORTED and dropped rather than squeezed in — a map
 * that silently lost a layer is the kind of export somebody discovers a week later.
 *
 * OBJECT LAYERS GO OUT TOO, and the reason is the same silent-nothing this codebase keeps finding:
 * a document imported from a map full of entities would otherwise export as tile layers alone, with
 * every door, spawn point and collision volume gone and no line saying so. What cannot be written is
 * counted instead — an image node drawing from a sheet this map does not declare has no gid to be.
 *
 * THE ANCHORING IS REVERSED HERE. A tile object's (x, y) is its BOTTOM-LEFT in the format and its
 * top-left in this engine, so exporting adds the height back that `objectBox` took off. Reading and
 * writing disagreeing about that would be invisible in the file and obvious on the screen, one
 * object-height down, which is exactly how it looks when an importer gets it wrong.
 *
 * CSV, NOT BASE64. The format allows both and the corpus uses both, but a `.tmx` is a file people
 * open, diff and hand-edit; a wall of base64 is the version that cannot be reviewed. It costs bytes
 * and buys a file that a person can read, which is the same trade `PixelCodec` refused for pixels
 * (there the array is a megabyte, here it is ten thousand short numbers).
 */

import { ReadonlyDocument } from "../document/Document";
import { ReadonlyTilemap, TileSheet, TILE_EMPTY, FLIP_H, FLIP_V, FLIP_D, tileIndexAt } from "../document/Tilemap";
import { findTileset, Tileset } from "../document/Tileset";
import { resolveTilemaps } from "../document/Components";

/** What an export could not represent, alongside the file itself. */
export interface TiledExport {
    xml: string;
    /** One line per layer that could not be written, and why. Empty when everything fit. */
    notes: string[];
}

/**
 * A tileset's name as a filename, for the `<image source>` of every set after the first.
 *
 * THE FIRST SET KEEPS THE CALLER'S NAME because that is what the `image` argument has always meant;
 * the rest are named from the set so two of them do not collide on one path. NOTHING HERE WRITES AN
 * IMAGE — this function produces XML, and the caller was already responsible for putting the sheet
 * beside the `.tmx`. That was true when there was one and is merely more visible now there can be
 * several.
 */
function safeFileName(name: string): string {
    const safe = name.replace(/[^\w.\- ]+/g, "_").trim();
    return safe.length > 0 ? safe : "tiles";
}

/** The three flags Tiled packs into the top of a gid — the encode half of `decodeGid`. */
const GID_FLIP_H = 0x80000000;
const GID_FLIP_V = 0x40000000;
const GID_FLIP_D = 0x20000000;

/** XML text, with the five characters that would otherwise end an attribute or a tag. */
function escapeXml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * One cell as the gid a `.tmx` holds: the tile's own id plus the flip bits.
 *
 * `firstgid` IS ADDED HERE, and it is the whole reason a tileset declares one: a `.tmx` numbers
 * tiles across every set in the map, so a set's first tile is 1 rather than 0 and an EMPTY cell is
 * the 0 that leaves. A reader that forgot it would draw every tile one place off in the sheet.
 *
 * THE FLAGS ARE ADDED WITH `>>> 0`, because the top bit makes a signed 32-bit integer negative in
 * JavaScript and `String(-2147483641)` is not a gid any reader accepts.
 */
export function encodeGid(index: number, flip: number, firstGid: number): number {
    if (index === TILE_EMPTY) return 0;
    let gid = index + firstGid;
    if ((flip & FLIP_H) !== 0) gid |= GID_FLIP_H;
    if ((flip & FLIP_V) !== 0) gid |= GID_FLIP_V;
    if ((flip & FLIP_D) !== 0) gid |= GID_FLIP_D;
    return gid >>> 0;
}

/** A grid's cells as the CSV a `<data>` element holds, one row per line. */
export function tilemapCsv(map: ReadonlyTilemap, firstGid: number): string {
    const rows: string[] = [];
    for (let row = 0; row < map.rows; row++) {
        const cells: string[] = [];
        for (let col = 0; col < map.cols; col++) {
            const at = row * map.cols + col;
            cells.push(String(encodeGid(map.tiles[at], map.flips ? map.flips[at] : 0, firstGid)));
        }
        // A TRAILING COMMA ON EVERY ROW BUT THE LAST, which is what Tiled writes and what its own
        // examples hold. The reader here ignores blanks either way; matching the writer means a
        // round trip through Tiled itself leaves the file unchanged.
        rows.push(cells.join(",") + (row === map.rows - 1 ? "" : ","));
    }
    return rows.join("\n");
}

/**
 * The `<properties>` block for a node's authored metadata, and what could not be written.
 *
 * A VALUE THAT XML CANNOT CARRY IS COUNTED, NOT ESCAPED INTO NONSENSE. `escapeXml` handles the five
 * entities; it cannot make a C0 control character legal in XML 1.0, and writing one produces a file
 * that no reader — including this one — will open. So the property is left out and said out loud,
 * which is the bargain the rest of this exporter already makes for an object it cannot write.
 */
function propertiesXml(
    data: Readonly<Record<string, { type: string; propertyType?: string; value: string }>> | undefined,
    owner: string, indent: string
): { xml: string; notes: string[] } {
    const notes: string[] = [];
    if (!data) return { xml: "", notes };
    const rows: string[] = [];
    // SORTED BY NAME, because a map has no order of its own and an export that reordered its own
    // properties between two saves would show a diff where nothing changed.
    for (const name of Object.keys(data).sort()) {
        const p = data[name];
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(p.value)) {
            notes.push(`${owner} property "${name}" holds a character XML cannot carry, and was not written`);
            continue;
        }
        const a = [`name="${escapeXml(name)}"`];
        // `string` IS THE DEFAULT and writing it back is noise — the reader puts it in, and leaving
        // it out is what makes an exported file look like one a person would have written.
        if (p.type !== "string") a.push(`type="${escapeXml(p.type)}"`);
        if (p.propertyType !== undefined) a.push(`propertytype="${escapeXml(p.propertyType)}"`);
        a.push(`value="${escapeXml(p.value)}"`);
        rows.push(`${indent} <property ${a.join(" ")}/>`);
    }
    if (rows.length === 0) return { xml: "", notes };
    return { xml: `${indent}<properties>\n${rows.join("\n")}\n${indent}</properties>`, notes };
}

/** Rich per-tile definitions that a plain sheet image cannot express. */
function tileMetadataXml(set: Tileset, notes: string[]): string {
    const rows: string[] = [];
    for (const tile of [...set.tiles].sort((a, b) => a.id - b.id)) {
        const attrs = [`id="${tile.id}"`];
        if (tile.className) attrs.push(`class="${escapeXml(tile.className)}"`);
        if (tile.probability !== undefined) attrs.push(`probability="${tile.probability}"`);
        const parts: string[] = [];
        const props = propertiesXml(tile.userData, `tile ${tile.id}`, "    ");
        notes.push(...props.notes);
        if (props.xml) parts.push(props.xml);
        if (tile.collision && tile.collision.length > 0) {
            const objects = tile.collision.map((shape, i) => {
                const a = [`id="${i + 1}"`, `x="${shape.x}"`, `y="${shape.y}"`,
                    `width="${shape.width}"`, `height="${shape.height}"`];
                if (shape.rotation !== 0) a.push(`rotation="${shape.rotation}"`);
                const inner = shape.kind === "ellipse" ? "<ellipse/>"
                    : shape.kind === "point" ? "<point/>"
                    : shape.kind === "polygon" || shape.kind === "polyline"
                        ? `<${shape.kind} points="${(shape.points ?? []).map(p => `${p.x},${p.y}`).join(" ")}"/>`
                        : "";
                return inner ? `     <object ${a.join(" ")}>${inner}</object>` : `     <object ${a.join(" ")}/>`;
            });
            parts.push(`    <objectgroup>\n${objects.join("\n")}\n    </objectgroup>`);
        }
        if (tile.animation && tile.animation.length > 0) {
            parts.push(`    <animation>\n${tile.animation.map(f =>
                `     <frame tileid="${f.tileId}" duration="${f.duration}"/>`).join("\n")}\n    </animation>`);
        }
        if (parts.length > 0 || attrs.length > 1) {
            rows.push(parts.length > 0
                ? `   <tile ${attrs.join(" ")}>\n${parts.join("\n")}\n   </tile>`
                : `   <tile ${attrs.join(" ")}/>`);
        }
    }
    if (set.wangsets && set.wangsets.length > 0) {
        const sets = set.wangsets.map(wang => {
            const a = [`name="${escapeXml(wang.name)}"`, `tile="${wang.tile}"`];
            if (wang.className) a.push(`class="${escapeXml(wang.className)}"`);
            const parts: string[] = [];
            const props = propertiesXml(wang.userData, `wangset "${wang.name}"`, "    ");
            notes.push(...props.notes);
            if (props.xml) parts.push(props.xml);
            for (const color of wang.colors) {
                const ca = [`name="${escapeXml(color.name)}"`, `color="${escapeXml(color.color)}"`,
                    `tile="${color.tile}"`, `probability="${color.probability}"`];
                const cp = propertiesXml(color.userData, `wang color "${color.name}"`, "     ");
                notes.push(...cp.notes);
                parts.push(cp.xml ? `    <wangcolor ${ca.join(" ")}>\n${cp.xml}\n    </wangcolor>`
                    : `    <wangcolor ${ca.join(" ")}/>`);
            }
            for (const wt of wang.tiles) parts.push(`    <wangtile tileid="${wt.tileId}" wangid="${wt.wangId.join(",")}"/>`);
            return `   <wangset ${a.join(" ")}>\n${parts.join("\n")}\n   </wangset>`;
        });
        rows.push(`  <wangsets>\n${sets.join("\n")}\n  </wangsets>`);
    }
    return rows.length > 0 ? "\n" + rows.join("\n") : "";
}

/** One object as a `.tmx` element, or null with the reason it cannot be written. */
function objectXml(
    node: { type: string; name?: string; geometry: { x: number; y: number; width: number; height: number };
            transform?: { rotation?: number; origin?: { x: number; y: number } };
            src?: string; sourceRect?: { x: number; y: number; width: number; height: number } | null;
            path?: readonly { c: string; x?: number; y?: number }[];
            className?: string;
            userData?: Readonly<Record<string, { type: string; propertyType?: string; value: string }>> },
    id: number, sheet: Readonly<TileSheet>, firstGid: number
): { xml: string; why: null; notes: string[] } | { xml: null; why: string; notes: string[] } {
    const g = node.geometry;
    const name = node.name ?? "";
    const attrs: string[] = [`id="${id}"`];
    if (name) attrs.push(`name="${escapeXml(name)}"`);
    // `class`, NOT `type`, because this file declares version 1.10 and that is what 1.10 calls it.
    // The reader takes either — `a.class ?? a.type` — so an older file still comes back in.
    if (node.className) attrs.push(`class="${escapeXml(node.className)}"`);
    const props = propertiesXml(node.userData, `object "${name || id}"`, "   ");
    // WHAT LEAVES WITH A REFUSED OBJECT IS COUNTED TOO. An object this exporter cannot write takes
    // its properties with it, and "3 objects were not written" does not say that a room's worth of
    // gameplay data went with them.
    const carried = node.userData ? Object.keys(node.userData).length : 0;
    const lost = (why: string) => ({
        xml: null as null,
        why: carried > 0 ? `${why} (and its ${carried} propert${carried === 1 ? "y" : "ies"})` : why,
        notes: [] as string[]
    });
    /** A self-closing tag when there is nothing inside, and a wrapped one when there is. */
    const wrap = (inner: string): { xml: string; why: null; notes: string[] } => {
        const body = [props.xml, inner].filter(x => x !== "").join("\n");
        return {
            xml: body === "" ? `  <object ${attrs.join(" ")}/>`
                : `  <object ${attrs.join(" ")}>\n${body}\n  </object>`,
            why: null, notes: props.notes
        };
    };
    // DEGREES, and the sign is not flipped — the format's rotation is clockwise on a y-down screen
    // and so are this engine's radians, which is the same agreement `objectTransform` states going
    // the other way.
    const rotation = node.transform?.rotation ?? 0;

    if (node.type === "core.image") {
        const rect = node.sourceRect ?? null;
        if (!rect) return lost(`object "${name || id}" draws a whole image rather than a tile`);
        const index = tileIndexAt(sheet, rect.x, rect.y);
        if (index === null) {
            return lost(`object "${name || id}" draws from a sheet this map does not declare`);
        }
        // THE HEIGHT GOES BACK ON: a tile object is anchored at its bottom-left in the file.
        attrs.push(`gid="${index + firstGid}"`, `x="${g.x}"`, `y="${g.y + g.height}"`,
            `width="${g.width}"`, `height="${g.height}"`);
        if (rotation !== 0) attrs.push(`rotation="${rotation * 180 / Math.PI}"`);
        return wrap("");
    }

    attrs.push(`x="${g.x}"`, `y="${g.y}"`, `width="${g.width}"`, `height="${g.height}"`);
    if (rotation !== 0) attrs.push(`rotation="${rotation * 180 / Math.PI}"`);
    if (node.type === "core.ellipse") {
        return wrap("   <ellipse/>");
    }
    if (node.type === "core.path") {
        const commands = node.path ?? [];
        const points = commands.filter(c => c.c === "M" || c.c === "L")
            .map(c => `${c.x ?? 0},${c.y ?? 0}`).join(" ");
        if (points === "") return lost(`object "${name || id}" is a path with no points`);
        // A CLOSED path is a polygon and an open one is a polyline — the only thing that tells the
        // two apart once both are paths, and the same distinction the reader makes coming in.
        const tag = commands.some(c => c.c === "Z") ? "polygon" : "polyline";
        return wrap(`   <${tag} points="${points}"/>`);
    }
    if (node.type === "core.rectangle") return wrap("");
    return lost(`object "${name || id}" is a ${node.type}, which a .tmx has no shape for`);
}

/**
 * The document's tile layers as a `.tmx`.
 *
 * `image` names the sheet as the file should reference it — a relative path, which only the caller
 * knows. This module will not invent one: a `.tmx` whose tileset points at a file that is not there
 * is a map that opens as an error dialog.
 */
export function exportTiledMap(doc: ReadonlyDocument, image: string): TiledExport {
    const notes: string[] = [];
    // THE RESOLVED SCENE, so an autotiled layer exports the picture its terrain derives rather than
    // the empty grid it stores.
    const resolved = resolveTilemaps(doc);
    const layers: { name: string; map: ReadonlyTilemap; opacity: number; hidden: boolean }[] = [];
    resolved.nodes.forEach(node => {
        if (node.type !== "core.tilemap" || !node.tilemap) return;
        layers.push({
            name: node.name ?? "",
            map: node.tilemap,
            opacity: node.style.opacity ?? 1,
            hidden: node.hidden === true
        });
    });
    if (layers.length === 0) {
        return { xml: "", notes: ["there is no tilemap node to export"] };
    }

    // THE FIRST LAYER SETS THE MAP, because the format has one size and one tile size for all of
    // them. Every layer that disagrees is dropped WITH A REASON rather than stretched to fit.
    const first = layers[0].map;
    const fitting = layers.filter(l => {
        const m = l.map;
        if (m.cols === first.cols && m.rows === first.rows
            && m.tileWidth === first.tileWidth && m.tileHeight === first.tileHeight) return true;
        notes.push(`layer "${l.name}" is ${m.cols}x${m.rows} at ${m.tileWidth}x${m.tileHeight} `
            + `and the map is ${first.cols}x${first.rows} at ${first.tileWidth}x${first.tileHeight}; `
            + "a .tmx has one size for every layer, so it was not written");
        return false;
    });
    // ONE `<tileset>` PER DISTINCT SET, each with its own `firstgid` — which is what the format
    // wanted all along and what schema 67 finally made expressible. Before it, one tileset was
    // written and every other layer's cells indexed the first one's picture: right places, wrong
    // pictures, reported in a note nobody could act on because the document could not hold a second
    // set anyway.
    //
    // IN FIRST-SEEN ORDER, so the file lists them the way the layers introduce them and a round trip
    // does not reshuffle. A set is entered once however many layers name it.
    const used: { set: Tileset; firstGid: number; tileCount: number; image: string }[] = [];
    const gidOf = new Map<string, number>();
    const writable = fitting.filter(l => {
        if (gidOf.has(l.map.tilesetId)) return true;
        const set = findTileset(doc.tilesets, l.map.tilesetId) as Tileset | null;
        if (!set?.sheet) {
            // A COLLECTION SET lands here too: writing one means a `<tile><image>` per tile, which
            // this does not do yet. Dropped WITH THE REASON rather than written as an empty grid.
            notes.push(`layer "${l.name}" draws from a tileset with no sheet to write `
                + "(a collection tileset, or an id naming nothing), so it was not written");
            return false;
        }
        // THE HIGHEST INDEX ANY LAYER OF THIS SET USES decides how many tiles it must declare — a
        // set claiming fewer than a layer references is a file Tiled refuses to open. Counted per
        // set, not across all of them, or a small set inherits a large one's count.
        const mine = fitting.filter(x => x.map.tilesetId === l.map.tilesetId);
        const highest = Math.max(0, ...mine.flatMap(x => x.map.tiles.filter(t => t !== TILE_EMPTY)));
        const count = set.sheet.columns * Math.max(1, Math.ceil((highest + 1) / set.sheet.columns));
        const firstGid = used.reduce((n, u) => n + u.tileCount, 1);
        gidOf.set(set.id, firstGid);
        used.push({
            set, firstGid, tileCount: count,
            // THE FIRST SET KEEPS THE CALLER'S NAME, because that is what every caller means by the
            // argument today; the rest are named from the set so two files do not collide. NEITHER
            // IS WRITTEN by this function — it produces XML, and the images were already the
            // caller's problem before there were several of them.
            image: used.length === 0 ? image : `${safeFileName(set.name)}.png`
        });
        return true;
    });
    if (writable.length === 0) {
        notes.push("no tile layer has a tileset with a sheet to write");
        return { xml: "", notes };
    }

    /**
     * Which written set a tile object draws from, by the picture it names.
     *
     * AN IMAGE NODE HAS NO `tilesetId` — it carries a `src` and a `sourceRect`, because it is an
     * image and not a cell. So the picture is the only identity it has, and matching on it is what
     * lets an object in a two-set map get the gid of the set it actually came from.
     *
     * IT FALLS BACK TO THE FIRST SET, which is exactly what this did when there could only be one.
     * The fallback is not a guess that succeeds quietly: `tileIndexAt` refuses a rect that is not a
     * cell of the sheet it is given, and the object leaves with "draws from a sheet this map does
     * not declare" rather than a gid pointing at the wrong picture.
     */
    const setFor = (src: string | undefined) => used.find(u => u.set.src === src) ?? used[0];

    const body = writable.map((l, i) => {
        const attrs = [`id="${i + 1}"`, `name="${escapeXml(l.name || `layer ${i + 1}`)}"`,
            `width="${l.map.cols}"`, `height="${l.map.rows}"`];
        // WRITTEN ONLY WHEN THEY DIFFER FROM THE DEFAULT, which is what Tiled does and what keeps a
        // round trip through it from rewriting every line of the file.
        if (l.opacity < 1) attrs.push(`opacity="${l.opacity}"`);
        if (l.hidden) attrs.push(`visible="0"`);
        // EACH LAYER'S OWN SET'S `firstgid`, which is the whole point of writing several: a cell
        // stores an index into ITS set, and the file numbers tiles across all of them.
        return ` <layer ${attrs.join(" ")}>\n  <data encoding="csv">\n`
            + tilemapCsv(l.map, gidOf.get(l.map.tilesetId) ?? 1) + `\n</data>\n </layer>`;
    }).join("\n");

    // OBJECT LAYERS: a frame with children is one, and its children are its objects. That is the
    // shape the importer builds, so a map that came in this way goes back out the same.
    let nextObjectId = 1;
    const objectGroups: string[] = [];
    resolved.nodes.forEach(node => {
        if (node.type !== "core.rectangle" || node.children.length === 0) return;
        const written: string[] = [];
        for (const childId of node.children) {
            const child = resolved.nodes.get(childId);
            if (!child) continue;
            const from = setFor((child as { src?: string }).src);
            const one = objectXml(child as never, nextObjectId, from.set.sheet!, from.firstGid);
            notes.push(...one.notes);
            if (one.xml === null) { notes.push(one.why); continue; }
            nextObjectId++;
            written.push(one.xml);
        }
        if (written.length === 0) return;
        const attrs = [`id="${writable.length + objectGroups.length + 1}"`,
            `name="${escapeXml(node.name ?? "")}"`];
        if ((node.style.opacity ?? 1) < 1) attrs.push(`opacity="${node.style.opacity}"`);
        if (node.hidden === true) attrs.push(`visible="0"`);
        objectGroups.push(` <objectgroup ${attrs.join(" ")}>\n${written.join("\n")}\n </objectgroup>`);
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n`
        + `<map version="1.10" orientation="orthogonal" renderorder="right-down" `
        + `width="${first.cols}" height="${first.rows}" `
        + `tilewidth="${first.tileWidth}" tileheight="${first.tileHeight}" `
        + `infinite="0" nextlayerid="${writable.length + objectGroups.length + 1}" nextobjectid="${nextObjectId}">\n`
        // ONE ELEMENT PER SET, in first-seen order and each with its own `firstgid`.
        + used.map(u => ` <tileset firstgid="${u.firstGid}" name="${escapeXml(u.set.name)}"`
            + ` tilewidth="${u.set.sheet!.tileWidth}" tileheight="${u.set.sheet!.tileHeight}"`
            + (u.set.sheet!.spacing !== 0 ? ` spacing="${u.set.sheet!.spacing}"` : "")
            + (u.set.sheet!.margin !== 0 ? ` margin="${u.set.sheet!.margin}"` : "")
            + ` tilecount="${u.tileCount}" columns="${u.set.sheet!.columns}">\n`
            + `  <image source="${escapeXml(u.image)}"/>`
            + tileMetadataXml(u.set, notes) + `\n`
            + ` </tileset>\n`).join("")
        + body + (objectGroups.length > 0 ? "\n" + objectGroups.join("\n") : "") + `\n</map>\n`;
    return { xml, notes };
}
