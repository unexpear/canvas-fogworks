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
import { ReadonlyTilemap, TILE_EMPTY, FLIP_H, FLIP_V, FLIP_D, tileIndexAt } from "../document/Tilemap";
import { resolveTilemaps } from "../document/Components";

/** What an export could not represent, alongside the file itself. */
export interface TiledExport {
    xml: string;
    /** One line per layer that could not be written, and why. Empty when everything fit. */
    notes: string[];
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

/** One object as a `.tmx` element, or null with the reason it cannot be written. */
function objectXml(
    node: { type: string; name?: string; geometry: { x: number; y: number; width: number; height: number };
            transform?: { rotation?: number; origin?: { x: number; y: number } };
            src?: string; sourceRect?: { x: number; y: number; width: number; height: number } | null;
            path?: readonly { c: string; x?: number; y?: number }[] },
    id: number, sheet: ReadonlyTilemap["sheet"], firstGid: number
): { xml: string; why: null } | { xml: null; why: string } {
    const g = node.geometry;
    const name = node.name ?? "";
    const attrs: string[] = [`id="${id}"`];
    if (name) attrs.push(`name="${escapeXml(name)}"`);
    // DEGREES, and the sign is not flipped — the format's rotation is clockwise on a y-down screen
    // and so are this engine's radians, which is the same agreement `objectTransform` states going
    // the other way.
    const rotation = node.transform?.rotation ?? 0;

    if (node.type === "core.image") {
        const rect = node.sourceRect ?? null;
        if (!rect) return { xml: null, why: `object "${name || id}" draws a whole image rather than a tile` };
        const index = tileIndexAt(sheet, rect.x, rect.y);
        if (index === null) {
            return { xml: null, why: `object "${name || id}" draws from a sheet this map does not declare` };
        }
        // THE HEIGHT GOES BACK ON: a tile object is anchored at its bottom-left in the file.
        attrs.push(`gid="${index + firstGid}"`, `x="${g.x}"`, `y="${g.y + g.height}"`,
            `width="${g.width}"`, `height="${g.height}"`);
        if (rotation !== 0) attrs.push(`rotation="${rotation * 180 / Math.PI}"`);
        return { xml: `  <object ${attrs.join(" ")}/>`, why: null };
    }

    attrs.push(`x="${g.x}"`, `y="${g.y}"`, `width="${g.width}"`, `height="${g.height}"`);
    if (rotation !== 0) attrs.push(`rotation="${rotation * 180 / Math.PI}"`);
    if (node.type === "core.ellipse") {
        return { xml: `  <object ${attrs.join(" ")}>\n   <ellipse/>\n  </object>`, why: null };
    }
    if (node.type === "core.path") {
        const commands = node.path ?? [];
        const points = commands.filter(c => c.c === "M" || c.c === "L")
            .map(c => `${c.x ?? 0},${c.y ?? 0}`).join(" ");
        if (points === "") return { xml: null, why: `object "${name || id}" is a path with no points` };
        // A CLOSED path is a polygon and an open one is a polyline — the only thing that tells the
        // two apart once both are paths, and the same distinction the reader makes coming in.
        const tag = commands.some(c => c.c === "Z") ? "polygon" : "polyline";
        return { xml: `  <object ${attrs.join(" ")}>\n   <${tag} points="${points}"/>\n  </object>`, why: null };
    }
    if (node.type === "core.rectangle") return { xml: `  <object ${attrs.join(" ")}/>`, why: null };
    return { xml: null, why: `object "${name || id}" is a ${node.type}, which a .tmx has no shape for` };
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
    // A SHEET THAT DIFFERS IS ALSO A PROBLEM, and a quieter one: the cells would land in the right
    // places holding the wrong pictures. One tileset is written, so a second sheet cannot be.
    const sheet = first.sheet;
    for (const l of fitting.slice(1)) {
        const s = l.map.sheet;
        if (s.columns === sheet.columns && s.tileWidth === sheet.tileWidth
            && s.tileHeight === sheet.tileHeight && s.spacing === sheet.spacing && s.margin === sheet.margin) continue;
        notes.push(`layer "${l.name}" draws from a different sheet; one tileset is written, so its `
            + "cells will index the first layer's");
    }

    const tileCount = sheet.columns * Math.max(1, Math.ceil(
        // The highest index any layer actually uses decides how many tiles the set must declare —
        // a set that claims fewer than a layer references is a file Tiled refuses to open.
        (Math.max(0, ...fitting.flatMap(l => l.map.tiles.filter(t => t !== TILE_EMPTY))) + 1) / sheet.columns));
    const body = fitting.map((l, i) => {
        const attrs = [`id="${i + 1}"`, `name="${escapeXml(l.name || `layer ${i + 1}`)}"`,
            `width="${l.map.cols}"`, `height="${l.map.rows}"`];
        // WRITTEN ONLY WHEN THEY DIFFER FROM THE DEFAULT, which is what Tiled does and what keeps a
        // round trip through it from rewriting every line of the file.
        if (l.opacity < 1) attrs.push(`opacity="${l.opacity}"`);
        if (l.hidden) attrs.push(`visible="0"`);
        return ` <layer ${attrs.join(" ")}>\n  <data encoding="csv">\n`
            + tilemapCsv(l.map, 1) + `\n</data>\n </layer>`;
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
            const one = objectXml(child as never, nextObjectId, sheet, 1);
            if (one.xml === null) { notes.push(one.why); continue; }
            nextObjectId++;
            written.push(one.xml);
        }
        if (written.length === 0) return;
        const attrs = [`id="${fitting.length + objectGroups.length + 1}"`,
            `name="${escapeXml(node.name ?? "")}"`];
        if ((node.style.opacity ?? 1) < 1) attrs.push(`opacity="${node.style.opacity}"`);
        if (node.hidden === true) attrs.push(`visible="0"`);
        objectGroups.push(` <objectgroup ${attrs.join(" ")}>\n${written.join("\n")}\n </objectgroup>`);
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n`
        + `<map version="1.10" orientation="orthogonal" renderorder="right-down" `
        + `width="${first.cols}" height="${first.rows}" `
        + `tilewidth="${first.tileWidth}" tileheight="${first.tileHeight}" `
        + `infinite="0" nextlayerid="${fitting.length + objectGroups.length + 1}" nextobjectid="${nextObjectId}">\n`
        + ` <tileset firstgid="1" name="tiles" tilewidth="${sheet.tileWidth}" tileheight="${sheet.tileHeight}"`
        + (sheet.spacing !== 0 ? ` spacing="${sheet.spacing}"` : "")
        + (sheet.margin !== 0 ? ` margin="${sheet.margin}"` : "")
        + ` tilecount="${tileCount}" columns="${sheet.columns}">\n`
        + `  <image source="${escapeXml(image)}"/>\n`
        + ` </tileset>\n`
        + body + (objectGroups.length > 0 ? "\n" + objectGroups.join("\n") : "") + `\n</map>\n`;
    return { xml, notes };
}
