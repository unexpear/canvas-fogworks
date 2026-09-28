/**
 * @module PackageProfile
 * @description Names spatial3d-v1 gaps in a packaged level: custom fonts, glTF requirements, and features the player leaves unchanged.
 */
import type { ReadonlyDocument } from "../core/document/Document";
import { fontFileError, parseFontFile } from "../core/import/FontFile";
import { GLTF_IGNORABLE_REQUIRED } from "../core/import/Gltf";

export interface PackageDiagnostic {
    code: string;
    severity: "error" | "warning";
    feature: string;
    subject: string;
    detail: string;
}
export interface DeclaredFontFace { family: string; weight: number; italic: boolean }

const READ_EXTENSIONS = new Set<string>(["KHR_materials_unlit", "KHR_texture_transform"]);
const GENERIC_FONT_FAMILIES = new Set([
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
    "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"
]);

export function normalizeFontFamily(name: string): string {
    return name.normalize("NFC").toLowerCase();
}
export function isGenericFontFamily(name: string): boolean {
    return GENERIC_FONT_FAMILIES.has(normalizeFontFamily(name));
}

/** CSS font-family list. Commas inside quotes stay part of the family name. */
export function fontStackFamilies(stack: string): string[] {
    const names: string[] = [];
    let current = "", quote: string | null = null;
    for (const char of stack) {
        if (quote) {
            if (char === quote) quote = null;
            else current += char;
            continue;
        }
        if (char === "\"" || char === "'") { quote = char; continue; }
        if (char === ",") { names.push(current.trim()); current = ""; continue; }
        current += char;
    }
    if (quote) throw new Error("Invalid font family stack.");
    names.push(current.trim());
    return names.filter(name => name.length > 0);
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Confirms the bytes are the face the manifest names. */
export function fontFaceError(bytes: Uint8Array, declared: DeclaredFontFace): string | null {
    const bad = fontFileError(bytes);
    if (bad) return bad;
    const info = parseFontFile(bytes);
    if (!info.family) return "font declares no family name";
    if (normalizeFontFamily(info.family) !== normalizeFontFamily(declared.family)
        || info.weight !== declared.weight || info.italic !== declared.italic) {
        return `font bytes are ${info.family} ${info.weight}${info.italic ? " italic" : ""}, not ${declared.family} ${declared.weight}${declared.italic ? " italic" : ""}`;
    }
    return null;
}

export function inspectModelProfile(source: string, json: unknown): PackageDiagnostic[] {
    const model = record(json);
    if (!model) return [];
    const diagnostics: PackageDiagnostic[] = [];
    for (const name of Array.isArray(model.extensionsRequired) ? model.extensionsRequired : []) {
        if (typeof name === "string" && !GLTF_IGNORABLE_REQUIRED.includes(name)) {
            diagnostics.push({ code: "gltf-extension", severity: "error", feature: name, subject: source,
                detail: `${source} requires glTF extension ${name}, which spatial3d-v1 does not implement.` });
        }
    }
    for (const name of Array.isArray(model.extensionsUsed) ? model.extensionsUsed : []) {
        if (typeof name === "string" && !READ_EXTENSIONS.has(name)) {
            diagnostics.push({ code: "gltf-extension", severity: "warning", feature: name, subject: source,
                detail: `${source} uses glTF extension ${name}; spatial3d-v1 reads it as the unextended model.` });
        }
    }
    let morph = false, otherMode = false;
    for (const mesh of Array.isArray(model.meshes) ? model.meshes : []) {
        const primitives = record(mesh)?.primitives;
        for (const primitive of Array.isArray(primitives) ? primitives : []) {
            const item = record(primitive);
            if (!item) continue;
            if (item.targets) morph = true;
            if (item.mode !== undefined && item.mode !== 4) otherMode = true;
        }
    }
    if (morph) diagnostics.push({ code: "morph-target", severity: "warning", feature: "morph-targets", subject: source,
        detail: `${source} carries morph targets, which spatial3d-v1 does not apply.` });
    if (otherMode) diagnostics.push({ code: "primitive-mode", severity: "warning", feature: "non-triangle-primitive", subject: source,
        detail: `${source} contains a non-triangle primitive, which spatial3d-v1 does not draw.` });
    return diagnostics;
}

export function inspectDocumentProfile(doc: ReadonlyDocument, packagedFamilies: ReadonlySet<string>): PackageDiagnostic[] {
    const diagnostics: PackageDiagnostic[] = [];
    const textIds: string[] = [];
    for (const node of doc.nodes.values()) {
        if (node.type === "core.text" && typeof node.text === "string" && node.text.trim()) textIds.push(node.id);
        if (typeof node.style?.fontFamily === "string") {
            for (const name of fontStackFamilies(node.style.fontFamily)) {
                if (isGenericFontFamily(name)) continue;
                if (!packagedFamilies.has(normalizeFontFamily(name))) {
                    diagnostics.push({ code: "custom-font", severity: "error", feature: "custom-font", subject: node.id,
                        detail: `custom font "${name}" on ${node.id} is not in this package.` });
                }
            }
        }
        for (const rule of node.entity?.rules ?? []) {
            if (rule.action.kind === "sound") {
                diagnostics.push({ code: "sound-cue", severity: "warning", feature: "embedded-sound", subject: node.id,
                    detail: `embedded sound on ${node.id} is not played by spatial3d-v1.` });
            }
        }
    }
    if (textIds.length) {
        diagnostics.push({ code: "undrawn-text", severity: "warning", feature: "text-overlay", subject: textIds[0],
            detail: `spatial3d-v1 does not draw 2D text into the 3D view (${textIds.slice(0, 8).join(", ")}).` });
    }
    return diagnostics;
}
