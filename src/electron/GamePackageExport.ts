/**
 * @module GamePackageExport
 * @description Collects only a saved 3D project's referenced graph into a bounded inline package; never writes or scans folders.
 */
import { promises as fs, realpathSync } from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { deserializeDocument } from "../core/document/Serializer";
import { parseGlb } from "../core/import/Gltf";
import { createPackageReader, GAME_PACKAGE_LIMITS as LIMIT, packageLocalPath } from "../runtime/GamePackage";
import type { GamePackageManifest, PackageFile, PackageFileKind, PackageLevel } from "../runtime/GamePackage";
const { resolveConfined } = require("./confine");

/** Read at most max+1 bytes, even if a file grows after stat. Reject changes during this read. */
async function readBounded(file: string, max: number): Promise<Buffer> {
    const handle = await fs.open(file, "r");
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > max) throw new Error("Package source exceeds its file limit.");
        const bytes = Buffer.alloc(Math.min(max, before.size) + 1); let used = 0;
        while (used < bytes.length) {
            const next = await handle.read(bytes, used, bytes.length - used, used);
            if (!next.bytesRead) break;
            used += next.bytesRead;
        }
        const after = await handle.stat();
        if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
            throw new Error("Package source changed while being read. Retry export.");
        }
        return bytes.subarray(0, used);
    } finally { await handle.close(); }
}
const decode = (data: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(data);

export async function collectGamePackage(project: string, liveContent: string): Promise<string> {
    if (typeof project !== "string" || !project) throw new Error("Save the project before exporting a 3D game.");
    const entryPath = realpathSync.native(project);
    const manifest: GamePackageManifest = { format: "canvas-fogworks-game", version: 1, entry: "level0",
        requiredCapabilities: ["spatial3d-v1"], levels: [], files: [] };
    const seenLevels = new Map<string, string>(), seenFiles = new Map<string, PackageFile>();
    let assetBytes = 0, textBytes = 0, resources = 0, imageBytes = 0;

    async function visit(file: string, content?: string): Promise<string> {
        const seen = seenLevels.get(file); if (seen) return seen;
        if (seenLevels.size >= LIMIT.levels) throw new Error("Package exceeds 32 levels.");
        const id = `level${seenLevels.size}`; seenLevels.set(file, id);
        const root = path.dirname(file);
        content ??= decode(await readBounded(file, LIMIT.levelBytes));
        if (typeof content !== "string" || Buffer.byteLength(content) > LIMIT.levelBytes) throw new Error("Package level exceeds its text limit.");
        const doc = deserializeDocument(content);
        const raw = JSON.parse(content), pending: unknown[] = [raw.document.nodes, raw.document.tilesets];
        const images = new Map<string, string>(); let visited = 0;
        while (pending.length) {
            const value = pending.pop(); if (!value || typeof value !== "object") continue;
            for (const [key, child] of Object.entries(value)) {
                if (++visited > 1_000_000) throw new Error("Package document traversal limit exceeded.");
                if (key === "userData") continue;
                if (key !== "src" || typeof child !== "string") {
                    if (child && typeof child === "object") pending.push(child);
                    continue;
                }
                if (child.startsWith("data:")) continue; // The final reader validates embedded raster data.
                const relative = decodeURIComponent(child); packageLocalPath(relative);
                const source = resolveConfined(root, root, relative, "a package image");
                if (!images.has(source)) {
                    if (images.size >= LIMIT.files) throw new Error("Too many package images.");
                    const extension = path.extname(source).slice(1).toLowerCase();
                    const mime = extension === "jpg" ? "jpeg" : extension;
                    if (!["png", "jpeg", "gif", "webp"].includes(mime)) throw new Error("Package images must be raster PNG/JPEG/WebP/GIF.");
                    const bytes = await readBounded(source, Math.min(2_999_970, LIMIT.assetBytes - imageBytes));
                    imageBytes += bytes.length;
                    images.set(source, `data:image/${mime};base64,${bytes.toString("base64")}`);
                }
                (value as Record<string, unknown>)[key] = images.get(source)!;
            }
        }
        content = JSON.stringify(raw); textBytes += Buffer.byteLength(content);
        if (Buffer.byteLength(content) > LIMIT.levelBytes || textBytes > LIMIT.jsonBytes) throw new Error("Package exceeds its text limit.");
        const level: PackageLevel = { id, content, links: [], resources: [] }; manifest.levels.push(level);
        const aliases = new Map<string, PackageFile>();
        async function resource(relative: string, kind: PackageFileKind): Promise<PackageFile> {
            const key = packageLocalPath(relative);
            const real = resolveConfined(root, root, relative, "a package resource");
            let payload = seenFiles.get(real);
            if (payload && payload.kind !== kind) throw new Error("A package file has conflicting resource kinds.");
            if (!payload) {
                if (seenFiles.size >= LIMIT.files) throw new Error("Too many package files.");
                const bytes = await readBounded(real, Math.min(LIMIT.fileBytes, LIMIT.assetBytes - assetBytes));
                assetBytes += bytes.length;
                payload = { id: `file${seenFiles.size}`, kind, bytes: bytes.length, data: bytes.toString("base64") };
                seenFiles.set(real, payload); manifest.files.push(payload);
            }
            if (aliases.has(key) && aliases.get(key) !== payload) throw new Error("Case-aliased package resources conflict.");
            if (!aliases.has(key)) {
                if (++resources > LIMIT.resources) throw new Error("Too many package resources.");
                aliases.set(key, payload); level.resources.push({ path: key, file: payload.id });
            }
            return payload;
        }
        const models = new Set<string>();
        for (const asset of doc.assets3d ?? []) {
            const source = asset.kind === "material" ? asset.source.replace(/#material-\d+$/, "") : asset.source;
            packageLocalPath(source);
            const kind = asset.kind === "texture" && /\.hdr$/i.test(source) ? "hdr"
                : /\.gltf$/i.test(source) ? "gltf" : /\.glb$/i.test(source) ? "glb" : null;
            if (!kind) throw new Error("Unsupported package asset source.");
            const payload = await resource(source, kind);
            if (kind === "hdr" || models.has(packageLocalPath(source))) continue;
            models.add(packageLocalPath(source));
            const bytes = Buffer.from(payload.data, "base64");
            const json = kind === "glb" ? parseGlb(bytes).json : JSON.parse(decode(bytes));
            for (const [field, sidecarKind] of [["buffers", "buffer"], ["images", "image"]] as const) {
                const entries = json[field] ?? [];
                if (!Array.isArray(entries) || entries.length > LIMIT.files) throw new Error("Invalid model dependency table.");
                for (const item of entries) {
                    const uri = item?.uri;
                    if (uri === undefined) continue;
                    if (typeof uri !== "string") throw new Error("Invalid model URI.");
                    if (uri.startsWith("data:")) continue;
                    packageLocalPath(uri, source.split("/").slice(0, -1), true);
                    await resource(path.posix.join(path.posix.dirname(source), decodeURIComponent(uri)), sidecarKind);
                }
            }
        }
        const links = new Map<string, string>();
        for (const node of doc.nodes.values()) {
            const target = node.entity?.transitionTo; if (!target) continue;
            const key = packageLocalPath(target);
            const next = resolveConfined(root, root, target, "a linked package level");
            if (!/\.(vde|json)$/i.test(next)) throw new Error("Linked levels must be .vde or .json projects.");
            const nextId = await visit(next);
            if (links.has(key) && links.get(key) !== nextId) throw new Error("Case-aliased package levels conflict.");
            links.set(key, nextId);
        }
        level.links = [...links].map(([target, level]) => ({ target, level }));
        return id;
    }
    await visit(entryPath, liveContent);
    const serialized = JSON.stringify(manifest);
    createPackageReader(serialized); // No output is published until the independent player accepts it.
    return serialized;
}

/** A self-contained artifact. The digest detects accidental payload damage, not malicious replacement. */
export function game3DHtml(serialized: string, bundle: Buffer): string {
    createPackageReader(serialized);
    if (!bundle.length || bundle.length > 8 * 1024 * 1024) throw new Error("Invalid player bundle size.");
    const digest = createHash("sha256").update(serialized).digest("hex");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Canvas Fogworks — 3D Player</title>
<style>body{margin:0;background:#17191f;color:#eee;font:15px system-ui}header{padding:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}button{padding:8px 16px}canvas{display:block;width:100%;height:calc(100vh - 140px);min-height:100px}p{padding:0 12px}#status{overflow-wrap:anywhere}</style></head><body>
<header><strong>Canvas Fogworks · 3D Player</strong><button id="start">Restart</button><button id="pause">Pause</button><button id="stop">Stop</button><button id="retry" hidden>Retry level</button></header>
<p id="status" role="status" aria-live="polite">Checking package…</p>
<header><button id="checkpoint">Set checkpoint</button><button id="respawn">Respawn</button><button id="save-progress">Save progress</button><button id="load-progress">Load progress</button><span id="progress-note" role="status"></span></header>
<canvas id="scene" tabindex="0" aria-label="3D game viewport"></canvas>
<p>WASD / arrows: move · Q/E: down/up · Shift: faster · F: interact. Focus loss pauses; use Resume to continue.</p>
<script id="game-data" type="application/octet-stream" data-sha256="${digest}">${Buffer.from(serialized).toString("base64")}</script>
<script src="data:text/javascript;base64,${bundle.toString("base64")}"></script></body></html>`;
}
