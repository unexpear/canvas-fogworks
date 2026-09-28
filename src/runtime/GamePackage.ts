/**
 * @module GamePackage
 * @description Bounded inline game manifest and read-only allowlisted player host; no filesystem or network access.
 */

import { FONT_FAMILY_MAX } from "../core/document/Node";
import { deserializeDocument } from "../core/document/Serializer";
import { parseGlb } from "../core/import/Gltf";
import type { PlayerProjectReader } from "./ProjectReadHost";
import { fontFaceError, fontStackFamilies, inspectDocumentProfile, inspectModelProfile, isGenericFontFamily, normalizeFontFamily } from "./PackageProfile";
import type { PackageDiagnostic } from "./PackageProfile";

export const GAME_PACKAGE_LIMITS = Object.freeze({ jsonBytes: 64 * 1024 * 1024,
    levelBytes: 20_000_000, fileBytes: 16 * 1024 * 1024, assetBytes: 32 * 1024 * 1024,
    levels: 32, files: 4096, resources: 4096 });
export type PackageFileKind = "gltf" | "glb" | "hdr" | "buffer" | "image" | "font";
export interface PackageFile { id: string; kind: PackageFileKind; bytes: number; data: string }
export interface PackageFont { family: string; weight: number; italic: boolean; file: string }
export interface PackagedFontFace { family: string; weight: number; italic: boolean; data: string }
export interface PackageLevel {
    id: string;
    content: string;
    links: { target: string; level: string }[];
    resources: { path: string; file: string }[];
}
export interface GamePackageManifest {
    format: "canvas-fogworks-game";
    version: 1;
    entry: string;
    requiredCapabilities: ["spatial3d-v1"];
    levels: PackageLevel[];
    files: PackageFile[];
    fonts?: PackageFont[];
}
export interface PackagedGameReader extends PlayerProjectReader {
    readonly entryKey: string;
    readonly fonts: readonly PackagedFontFace[];
    readonly warnings: readonly PackageDiagnostic[];
}
interface ValidLevel { content: string; links: Map<string, string>; resources: Map<string, PackageFile>; models: Set<string> }

// The native writer shares exactly the reader's virtual namespace, not filesystem casing rules.
export { localPath as packageLocalPath };

function record(value: unknown, fields: string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid package record.");
    const result = value as Record<string, unknown>;
    if (Object.keys(result).length !== fields.length || fields.some(field => !Object.prototype.hasOwnProperty.call(result, field))) {
        throw new Error("Invalid or unsupported package fields.");
    }
    return result;
}
function list(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) throw new Error("Invalid or oversized package table.");
    return value;
}
function id(value: unknown): string {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
        || ["constructor", "prototype"].includes(value)) throw new Error("Invalid package ID.");
    return value;
}
function text(value: unknown, max: number): string {
    if (typeof value !== "string" || value.length > max || new TextEncoder().encode(value).length > max) {
        throw new Error("Invalid or oversized package text.");
    }
    return value;
}

/** Package-local namespace, not OS path resolution. URI decoding is only for glTF sidecars. */
function localPath(value: unknown, base: string[] = [], uri = false): string {
    if (typeof value !== "string" || !value || value.length > 4096) throw new Error("Invalid package path.");
    let path = value;
    if (uri) {
        try { path = decodeURIComponent(path); } catch { throw new Error("Invalid encoded package path."); }
    }
    if (/^[\/]/.test(path) || /[\\:%?#<>"|*\u0000-\u001f\u007f]/.test(path)) throw new Error("Unsafe package path.");
    const parts = [...base];
    for (const segment of path.normalize("NFC").split("/")) {
        if (segment === ".") continue;
        if (segment === "..") {
            if (!parts.length) throw new Error("Package path escapes the level.");
            parts.pop(); continue;
        }
        if (!segment || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
            throw new Error("Unsafe package path segment.");
        }
        parts.push(segment.toLowerCase());
    }
    if (!parts.length) throw new Error("Empty package path.");
    return parts.join("/");
}

function binary(data: unknown, max: number): { data: string; bytes: Uint8Array } {
    if (typeof data !== "string" || data.length > 4 * Math.ceil(max / 3)
        || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Invalid package base64.");
    let decoded: string;
    try { decoded = atob(data); } catch { throw new Error("Invalid package base64."); }
    if (decoded.length > max || btoa(decoded) !== data) throw new Error("Noncanonical or oversized package base64.");
    return { data, bytes: Uint8Array.from(decoded, char => char.charCodeAt(0)) };
}

/** Ordinary scene images must already be embedded; metadata is not treated as an image request. */
function validateImages(content: string, diagnostics: PackageDiagnostic[]): void {
    const raw = JSON.parse(content).document;
    const pending: unknown[] = [raw?.nodes, raw?.tilesets]; let visited = 0;
    while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== "object") continue;
        for (const [key, child] of Object.entries(value)) {
            if (++visited > 1_000_000) throw new Error("Package document traversal limit exceeded.");
            if (key === "userData") continue;
            if (key === "src" && typeof child === "string") {
                if (/^data:image\/svg\+xml/i.test(child) || /\.svg(?:$|[?#])/i.test(child)) {
                    diagnostics.push({ code: "svg-image", severity: "error", feature: "svg-image", subject: "image",
                        detail: "SVG image payloads are not packaged." });
                    continue;
                }
                if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(child)) {
                    throw new Error("Package scene images must be embedded raster data.");
                }
                binary(child.slice(child.indexOf(",") + 1), GAME_PACKAGE_LIMITS.fileBytes);
            } else if (child && typeof child === "object") pending.push(child);
        }
    }
}

function envelope(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid package record.");
    const result = value as Record<string, unknown>;
    const keys = Object.keys(result);
    const required = ["format", "version", "entry", "requiredCapabilities", "levels", "files"];
    if (keys.some(key => !required.includes(key) && key !== "fonts") || required.some(key => !Object.prototype.hasOwnProperty.call(result, key))) {
        throw new Error("Invalid or unsupported package fields.");
    }
    return result;
}
const PACKAGE_KINDS = ["gltf", "glb", "hdr", "buffer", "image", "font"];

/** Parse once, validate all declared references, then retain only private Maps and immutable strings. */
export function createPackageReader(serialized: string): PackagedGameReader {
    const raw = envelope(JSON.parse(text(serialized, GAME_PACKAGE_LIMITS.jsonBytes)));
    if (raw.format !== "canvas-fogworks-game" || raw.version !== 1) throw new Error("Unsupported game package format/version.");
    const capabilities = list(raw.requiredCapabilities, 16);
    if (capabilities.length !== 1 || capabilities[0] !== "spatial3d-v1") throw new Error("Unsupported game package capabilities.");
    const entry = id(raw.entry), files = new Map<string, PackageFile>(), modelJson = new Map<string, unknown>();
    let totalBytes = 0, totalResources = 0;
    for (const value of list(raw.files, GAME_PACKAGE_LIMITS.files)) {
        const file = record(value, ["id", "kind", "bytes", "data"]), key = id(file.id);
        if (files.has(key)) throw new Error("Duplicate package file ID.");
        if (!PACKAGE_KINDS.includes(String(file.kind))) throw new Error("Unsupported package file kind.");
        if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || (file.bytes as number) > GAME_PACKAGE_LIMITS.fileBytes
            || totalBytes + (file.bytes as number) > GAME_PACKAGE_LIMITS.assetBytes) throw new Error("Package asset byte limit exceeded.");
        const payload = binary(file.data, Math.min(GAME_PACKAGE_LIMITS.fileBytes, GAME_PACKAGE_LIMITS.assetBytes - totalBytes));
        if (payload.bytes.length !== file.bytes) throw new Error("Package file byte count mismatch.");
        totalBytes += payload.bytes.length;
        files.set(key, { id: key, kind: file.kind as PackageFileKind, bytes: payload.bytes.length, data: payload.data });
        if (file.kind === "gltf") modelJson.set(key, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload.bytes)));
        if (file.kind === "glb") modelJson.set(key, parseGlb(payload.bytes).json);
    }
    const publishedFonts: PackagedFontFace[] = [];
    const packagedFamilies = new Set<string>(), usedFontFiles = new Set<string>();
    if (Object.prototype.hasOwnProperty.call(raw, "fonts")) {
        const seenFaces = new Set<string>();
        for (const value of list(raw.fonts, 64)) {
            const font = record(value, ["family", "weight", "italic", "file"]);
            const family = text(font.family, FONT_FAMILY_MAX).normalize("NFC");
            if (!family.trim() || /[",\\\u0000-\u001f]/.test(family)) throw new Error("Invalid packaged font family.");
            if (!Number.isInteger(font.weight) || (font.weight as number) < 1 || (font.weight as number) > 1000 || typeof font.italic !== "boolean") {
                throw new Error("Invalid packaged font face.");
            }
            const fileId = id(font.file), file = files.get(fileId);
            if (!file || file.kind !== "font") throw new Error("Packaged font file is missing or the wrong kind.");
            if (usedFontFiles.has(fileId)) throw new Error("Duplicate packaged font file.");
            const faceKey = `${normalizeFontFamily(family)}\0${font.weight}\0${font.italic}`;
            if (seenFaces.has(faceKey)) throw new Error("Duplicate packaged font face.");
            seenFaces.add(faceKey); usedFontFiles.add(fileId);
            const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
            const mismatch = fontFaceError(bytes, { family, weight: font.weight as number, italic: font.italic });
            if (mismatch) throw new Error(`Unsupported package feature: ${fileId}: ${mismatch}.`);
            packagedFamilies.add(normalizeFontFamily(family));
            publishedFonts.push({ family, weight: font.weight as number, italic: font.italic, data: file.data });
        }
    }
    const levels = new Map<string, ValidLevel>(), usedFiles = new Set<string>(usedFontFiles);
    const diagnostics: PackageDiagnostic[] = [], referencedFamilies = new Set<string>();
    for (const value of list(raw.levels, GAME_PACKAGE_LIMITS.levels)) {
        const level = record(value, ["id", "content", "links", "resources"]), key = id(level.id);
        if (levels.has(key)) throw new Error("Duplicate package level ID.");
        const content = text(level.content, GAME_PACKAGE_LIMITS.levelBytes), doc = deserializeDocument(content);
        if (![...doc.nodes.values()].some(node => node.spatial3d?.camera)) throw new Error("Package level requires a 3D camera.");
        validateImages(content, diagnostics);
        const links = new Map<string, string>(), resources = new Map<string, PackageFile>(), models = new Set<string>();
        for (const value of list(level.links, 32)) {
            const link = record(value, ["target", "level"]), target = localPath(link.target);
            if (links.has(target)) throw new Error("Duplicate or case-aliased package link.");
            links.set(target, id(link.level));
        }
        for (const value of list(level.resources, GAME_PACKAGE_LIMITS.resources)) {
            if (++totalResources > GAME_PACKAGE_LIMITS.resources) throw new Error("Package resource limit exceeded.");
            const resource = record(value, ["path", "file"]), source = localPath(resource.path), file = files.get(id(resource.file));
            if (resources.has(source)) throw new Error("Duplicate or case-aliased package resource.");
            if (!file) throw new Error("Missing package resource file.");
            resources.set(source, file);
        }
        const needed = new Set<string>(), targets = new Set<string>();
        const requireResource = (source: string, kinds: PackageFileKind[]): PackageFile => {
            const file = resources.get(source);
            if (!file || !kinds.includes(file.kind)) throw new Error(`Missing or wrong-kind package resource: ${source}`);
            needed.add(source); usedFiles.add(file.id); return file;
        };
        const assets = new Map((doc.assets3d ?? []).map(asset => [asset.id, asset]));
        for (const node of doc.nodes.values()) {
            const spatial = node.spatial3d;
            if (spatial?.renderable && assets.get(spatial.renderable.meshAssetId)?.kind !== "mesh") throw new Error("Missing package mesh asset ID.");
            if (spatial?.renderable?.materialAssetIds?.some(id => assets.get(id)?.kind !== "material")) throw new Error("Missing package material asset ID.");
            if (spatial?.environment && assets.get(spatial.environment.textureAssetId)?.kind !== "texture") throw new Error("Missing package environment asset ID.");
            if (node.entity?.transitionTo) {
                const target = localPath(node.entity.transitionTo); targets.add(target);
                if (!links.has(target)) throw new Error(`Unpackaged level transition: ${target}`);
            }
        }
        if ([...links.keys()].some(target => !targets.has(target))) throw new Error("Unused package level link.");
        for (const asset of assets.values()) {
            let source = asset.source;
            if (asset.kind === "material") {
                if (!/#material-\d+$/.test(source)) throw new Error("Unsupported package material source.");
                source = source.replace(/#material-\d+$/, "");
            }
            const path = localPath(source);
            if (asset.kind === "texture") {
                if (!/\.hdr$/i.test(path)) throw new Error("Unsupported package texture asset source.");
                requireResource(path, ["hdr"]); continue;
            }
            const kind = /\.gltf$/i.test(path) ? "gltf" : /\.glb$/i.test(path) ? "glb" : null;
            if (!kind) throw new Error("Unsupported package model source.");
            requireResource(path, [kind]); models.add(path);
        }
        for (const source of models) {
            const json = modelJson.get(resources.get(source)!.id);
            if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid packaged model JSON.");
            const model = json as Record<string, unknown>;
            for (const [field, kinds] of [["buffers", ["buffer"]], ["images", ["image"]]] as const) {
                for (const item of list(model[field] ?? [], 4096)) {
                    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid packaged model dependency.");
                    const uri = (item as { uri?: unknown }).uri;
                    if (uri === undefined) continue;
                    if (typeof uri !== "string") throw new Error("Invalid packaged model URI.");
                    if (uri.startsWith("data:")) {
                        const pattern = field === "images" ? /^data:image\/(png|jpeg|webp);base64,/ : /^data:application\/(octet-stream|gltf-buffer);base64,/;
                        if (!pattern.test(uri)) throw new Error("Unsupported embedded model data.");
                        binary(uri.slice(uri.indexOf(",") + 1), GAME_PACKAGE_LIMITS.fileBytes);
                    } else requireResource(localPath(uri, source.split("/").slice(0, -1), true), [...kinds]);
                }
            }
        }
        if ([...resources.keys()].some(source => !needed.has(source))) throw new Error("Unused package resource.");
        for (const source of models) diagnostics.push(...inspectModelProfile(source, modelJson.get(resources.get(source)!.id)));
        diagnostics.push(...inspectDocumentProfile(doc, packagedFamilies));
        for (const node of doc.nodes.values()) {
            if (typeof node.style?.fontFamily !== "string") continue;
            for (const name of fontStackFamilies(node.style.fontFamily)) {
                const key = normalizeFontFamily(name);
                if (!isGenericFontFamily(name) && packagedFamilies.has(key)) referencedFamilies.add(key);
            }
        }
        levels.set(key, { content, links, resources, models });
    }
    for (const font of publishedFonts) {
        if (!referencedFamilies.has(normalizeFontFamily(font.family))) diagnostics.push({ code: "custom-font", severity: "error",
            feature: "custom-font", subject: font.family, detail: `Unused packaged font "${font.family}".` });
    }
    const errors = diagnostics.filter(item => item.severity === "error");
    if (errors.length) throw new Error(`Unsupported package feature: ${errors.map(item => item.detail).join(" ")}`);
    const warnings = diagnostics.filter(item => item.severity === "warning").slice(0, 64);
    if (!levels.has(entry)) throw new Error("Missing package entry level.");
    for (const level of levels.values()) for (const target of level.links.values()) {
        if (!levels.has(target)) throw new Error("Missing linked package level.");
    }
    const reached = new Set<string>(), pending = [entry];
    while (pending.length) {
        const key = pending.pop()!; if (reached.has(key)) continue;
        reached.add(key); pending.push(...levels.get(key)!.links.values());
    }
    if (reached.size !== levels.size) throw new Error("Unreachable package level.");
    if (usedFiles.size !== files.size) throw new Error("Unused package file.");
    const level = (key: string): ValidLevel => {
        const found = levels.get(key); if (!found) throw new Error("Unknown package level key."); return found;
    };
    const resource = (key: string, source: string, kinds: PackageFileKind[]): string => {
        const file = level(key).resources.get(source);
        if (!file || !kinds.includes(file.kind)) throw new Error("Resource is not allowed by this package level.");
        return file.data;
    };
    const warningList = Object.freeze(warnings.map(item => Object.freeze({ ...item })));
    const fontList = Object.freeze(publishedFonts.map(font => Object.freeze({ ...font })));
    return Object.freeze({
        entryKey: entry,
        fonts: fontList,
        warnings: warningList,
        async readProgressLevel(key: string) { return { filePath: key, content: level(key).content }; },
        async readEntryFile(key: string) {
            if (key !== entry) throw new Error("Unknown package entry key.");
            return { filePath: entry, content: level(entry).content };
        },
        async readLevelFile(current: string, target: string) {
            const next = level(current).links.get(localPath(target));
            if (!next) throw new Error("Level transition is not allowed by this package.");
            return { filePath: next, content: level(next).content };
        },
        async readProject3DFile(current: string, source: string) { return resource(current, localPath(source), ["gltf", "glb"]); },
        async readProjectEnvironmentFile(current: string, source: string) { return resource(current, localPath(source), ["hdr"]); },
        async readProject3DSidecar(current: string, modelSource: string, uri: string) {
            const source = localPath(modelSource);
            if (!level(current).models.has(source)) throw new Error("Model is not allowed by this package level.");
            return resource(current, localPath(uri, source.split("/").slice(0, -1), true), ["buffer", "image"]);
        }
    });
}
