/**
 * @module GamePackageExport
 * @description Collects only a saved 3D project's referenced graph into a bounded inline package; never writes or scans folders.
 */
import { promises as fs, realpathSync } from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { deserializeDocument } from "../core/document/Serializer";
import { parseGlb } from "../core/import/Gltf";
import { fontFileError, parseFontFile } from "../core/import/FontFile";
import { createPackageReader, GAME_PACKAGE_LIMITS as LIMIT, packageLocalPath } from "../runtime/GamePackage";
import type { GamePackageManifest, PackageFile, PackageFileKind, PackageFont, PackageLevel } from "../runtime/GamePackage";
import { fontStackFamilies, isGenericFontFamily, normalizeFontFamily } from "../runtime/PackageProfile";
import type { PackageDiagnostic } from "../runtime/PackageProfile";
const { resolveConfined } = require("./confine");
const { validateSaveMigrationTable } = require("../runtime/saveMigrationTable") as {
    validateSaveMigrationTable: (migrations: unknown, toGameId?: string) => { fromGameId: string; versions: number[] }[];
};

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

export interface GamePackageSources {
    fontsDirectory?: string;
    fontPayloads?: Uint8Array[];
    /** Stamped onto the manifest when non-empty. Older readers that refuse unknown fields reject that package. */
    saveMigrations?: readonly { fromGameId: string; versions: readonly number[] }[];
}
export interface ProvenanceIdentity { appVersion: string; sourceRevision: string | null }
export interface GameProvenance {
    format: "canvas-fogworks-game-provenance";
    version: 1;
    profile: "spatial3d-v1";
    packageFormat: "canvas-fogworks-game";
    packageVersion: 1;
    appVersion: string;
    sourceRevision: string | null;
    manifestSha256: string;
    authenticity: "unsigned";
    files: { id: string; kind: PackageFileKind; bytes: number; sha256: string }[];
    fonts: { family: string; weight: number; italic: boolean; file: string; sha256: string }[];
    warnings: Pick<PackageDiagnostic, "code" | "feature" | "subject" | "detail">[];
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
    return true;
}
/** Renderer-supplied font bytes. Canonical base64 only, bounded before the package reader sees them. */
export function fontPayloadsFromJson(value: unknown): Uint8Array[] {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid packaged font list.");
    return value.map(item => {
        const data = item && typeof item === "object" && !Array.isArray(item) ? (item as { data?: unknown }).data : undefined;
        if (typeof data !== "string" || data.length > 4 * Math.ceil(LIMIT.fileBytes / 3)) throw new Error("Invalid packaged font.");
        const bytes = Buffer.from(data, "base64");
        if (!bytes.length || bytes.length > LIMIT.fileBytes || bytes.toString("base64") !== data) throw new Error("Invalid packaged font.");
        return new Uint8Array(bytes);
    });
}
async function readFontDirectory(directory: string): Promise<Uint8Array[]> {
    const root = realpathSync.native(directory);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Font source must be a directory.");
    const names = (await fs.readdir(root)).filter(name => /\.(ttf|otf)$/i.test(name)).sort();
    if (names.length > 64) throw new Error("Font directory exceeds 64 faces.");
    const payloads: Uint8Array[] = [];
    for (const name of names) payloads.push(new Uint8Array(await readBounded(resolveConfined(root, root, name, "a package font"), LIMIT.fileBytes)));
    return payloads;
}

export async function collectGamePackage(project: string, liveContent: string, sources: GamePackageSources = {}): Promise<string> {
    if (typeof project !== "string" || !project) throw new Error("Save the project before exporting a 3D game.");
    const entryPath = realpathSync.native(project);
    const manifest: GamePackageManifest = { format: "canvas-fogworks-game", version: 1, entry: "level0",
        requiredCapabilities: ["spatial3d-v1"], levels: [], files: [] };
    const seenLevels = new Map<string, string>(), seenFiles = new Map<string, PackageFile>();
    const neededFonts = new Map<string, { name: string; subject: string }>();
    let assetBytes = 0, textBytes = 0, resources = 0, imageBytes = 0;
    function noteFonts(doc: { nodes: { values(): Iterable<{ id: string; style?: { fontFamily?: string } }> } }): void {
        for (const node of doc.nodes.values()) {
            if (typeof node.style?.fontFamily !== "string") continue;
            for (const name of fontStackFamilies(node.style.fontFamily)) {
                if (isGenericFontFamily(name)) continue;
                const key = normalizeFontFamily(name);
                if (!neededFonts.has(key)) neededFonts.set(key, { name, subject: node.id });
            }
        }
    }

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
                    if (mime === "svg") throw new Error("Unsupported package feature: SVG image payloads are not packaged.");
                    if (!["png", "jpeg", "gif", "webp"].includes(mime)) throw new Error("Package images must be raster PNG/JPEG/WebP/GIF.");
                    const bytes = await readBounded(source, Math.min(2_999_970, LIMIT.assetBytes - imageBytes));
                    imageBytes += bytes.length;
                    images.set(source, `data:image/${mime};base64,${bytes.toString("base64")}`);
                }
                (value as Record<string, unknown>)[key] = images.get(source)!;
            }
        }
        noteFonts(doc);
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
    if (neededFonts.size) {
        const supplied = [...(sources.fontPayloads ?? [])];
        if (sources.fontsDirectory) supplied.push(...await readFontDirectory(sources.fontsDirectory));
        const available = new Map<string, { family: string; weight: number; italic: boolean; bytes: Uint8Array }[]>();
        for (const bytes of supplied) {
            const bad = fontFileError(bytes);
            if (bad) throw new Error(`Unsupported package feature: font file: ${bad}.`);
            const info = parseFontFile(bytes);
            if (!info.family) throw new Error("Unsupported package feature: font declares no family name.");
            const key = normalizeFontFamily(info.family);
            const faces = available.get(key) ?? [];
            const prior = faces.find(face => face.weight === info.weight && face.italic === info.italic);
            if (prior && !sameBytes(prior.bytes, bytes)) throw new Error(`Unsupported package feature: conflicting faces for "${info.family}".`);
            if (!prior) faces.push({ family: info.family, weight: info.weight, italic: info.italic, bytes });
            available.set(key, faces);
        }
        const records: PackageFont[] = [];
        for (const key of [...neededFonts.keys()].sort()) {
            const request = neededFonts.get(key)!, faces = available.get(key);
            if (!faces?.length) throw new Error(`Unsupported package feature: custom font "${request.name}" on ${request.subject} is not in this package.`);
            for (const face of [...faces].sort((left, right) => left.weight - right.weight || Number(left.italic) - Number(right.italic))) {
                if (seenFiles.size >= LIMIT.files) throw new Error("Too many package files.");
                if (assetBytes + face.bytes.length > LIMIT.assetBytes) throw new Error("Package asset byte limit exceeded.");
                const payload: PackageFile = { id: `file${seenFiles.size}`, kind: "font", bytes: face.bytes.length, data: Buffer.from(face.bytes).toString("base64") };
                seenFiles.set(`font:${payload.id}`, payload); manifest.files.push(payload); assetBytes += face.bytes.length;
                records.push({ family: face.family, weight: face.weight, italic: face.italic, file: payload.id });
            }
        }
        manifest.fonts = records;
    }
    if (sources.saveMigrations !== undefined) {
        const table = validateSaveMigrationTable(sources.saveMigrations);
        if (table.length) manifest.saveMigrations = table;
    }
    const serialized = JSON.stringify(manifest);
    createPackageReader(serialized); // No output is published until the independent player accepts it.
    return serialized;
}

/** Unsigned release identity. The manifest hash detects accidental damage, not a substituted publisher. */
export function gameProvenance(serialized: string, identity: ProvenanceIdentity): GameProvenance {
    if (!/^\d+\.\d+\.\d+$/.test(identity.appVersion)) throw new Error("Invalid provenance app version.");
    if (identity.sourceRevision !== null && !/^[0-9a-f]{7,64}$/.test(identity.sourceRevision)) throw new Error("Invalid provenance revision.");
    const reader = createPackageReader(serialized);
    const manifest = JSON.parse(serialized) as GamePackageManifest;
    const sha256 = (data: string) => createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
    const files = new Map(manifest.files.map(file => [file.id, file]));
    return { format: "canvas-fogworks-game-provenance", version: 1, profile: "spatial3d-v1",
        packageFormat: "canvas-fogworks-game", packageVersion: 1, appVersion: identity.appVersion,
        sourceRevision: identity.sourceRevision, manifestSha256: createHash("sha256").update(serialized).digest("hex"),
        authenticity: "unsigned",
        files: manifest.files.map(file => ({ id: file.id, kind: file.kind, bytes: file.bytes, sha256: sha256(file.data) })),
        fonts: (manifest.fonts ?? []).map(font => ({ family: font.family, weight: font.weight, italic: font.italic, file: font.file,
            sha256: sha256(files.get(font.file)!.data) })),
        warnings: reader.warnings.map(warning => ({ code: warning.code, feature: warning.feature, subject: warning.subject, detail: warning.detail })) };
}

/** A self-contained artifact. The digest detects accidental payload damage, not malicious replacement. */
export function game3DHtml(serialized: string, bundle: Buffer, provenance?: GameProvenance): string {
    const identity = provenance ?? gameProvenance(serialized, { appVersion: "0.0.5", sourceRevision: null });
    if (identity.manifestSha256 !== createHash("sha256").update(serialized).digest("hex")) throw new Error("Provenance does not match this package.");
    if (!bundle.length || bundle.length > 8 * 1024 * 1024) throw new Error("Invalid player bundle size.");
    const digest = identity.manifestSha256;
    const report = JSON.stringify(identity).replace(/</g, "\\u003c");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Canvas Fogworks — 3D Player</title>
<style>body{margin:0;background:#17191f;color:#eee;font:15px system-ui}header{padding:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}button{padding:8px 16px}#viewport{position:relative}#viewport canvas{display:block;width:100%;height:calc(100vh - 140px);min-height:100px}#text{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}p{padding:0 12px}#status,#diagnostics{overflow-wrap:anywhere}#diagnostics{color:#f3d48a}</style></head><body>
<header><strong>Canvas Fogworks · 3D Player</strong><button id="start">Restart</button><button id="pause">Pause</button><button id="stop">Stop</button><button id="retry" hidden>Retry level</button></header>
<p id="status" role="status" aria-live="polite">Checking package…</p>
<p id="diagnostics" role="status" hidden></p>
<p id="fonts" hidden></p>
<p id="audio" hidden></p>
<header><button id="checkpoint">Set checkpoint</button><button id="respawn">Respawn</button><button id="save-progress">Save progress</button><button id="load-progress">Load progress</button><button id="input-settings" type="button" aria-expanded="false" aria-controls="input-settings-panel">Controls</button><span id="progress-note" role="status"></span></header>
<div id="input-settings-panel" hidden></div>
<div id="viewport"><canvas id="scene" tabindex="0" aria-label="3D game viewport"></canvas><canvas id="text" aria-hidden="true"></canvas></div>
<p id="input-summary">WASD / arrows: move · Q/E: down/up · Shift: faster · F: interact. Focus loss pauses; use Resume to continue.</p>
<script id="game-provenance" type="application/json">${report}</script>
<script id="game-data" type="application/octet-stream" data-sha256="${digest}">${Buffer.from(serialized).toString("base64")}</script>
<script src="data:text/javascript;base64,${bundle.toString("base64")}"></script></body></html>`;
}
