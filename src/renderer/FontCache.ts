/**
 * @module FontCache
 * @description Registering a font face so `style.fontFamily` names something real.
 *
 * The impure half of font support, beside `ImageCache` and for the same reason: it needs a DOM.
 * `core/import/FontFile` reads the family out of the file; this hands the bytes to the platform
 * under that family, after which every backend draws with it for free — Canvas resolves
 * `ctx.font`, SVG resolves `font-family`, and the GPU rasterises through `TextRaster`, which is
 * Canvas. Nothing below this line had to learn what a font is.
 *
 * REGISTERED ONCE PER FAMILY. A folder of 56 fonts holds several files per family — the measured
 * tree ships each Kenney face as both TrueType and CFF — and adding the same family twice makes the
 * platform pick between them arbitrarily. First one wins, and the second is reported rather than
 * silently ignored.
 */

import { FontInfo } from "../core/import/FontFile";

/** Families registered this session, by family name, with the bytes a package export can embed. */
const faces = new Map<string, { info: FontInfo; bytes: Uint8Array }>();

/** What has been registered — for a picker, and so a caller can tell what a document may ask for. */
export function registeredFonts(): FontInfo[] {
    return [...faces.values()].map(face => face.info);
}
function base64(bytes: Uint8Array): string {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}
/** Copies of the faces loaded in this editor session, for offline package export. */
export function registeredFontPayloads(): { data: string }[] {
    return [...faces.values()].map(face => ({ data: base64(face.bytes) }));
}

/** Forget everything. Exists for tests; a real session only ever adds. */
export function clearFonts(): void {
    faces.clear();
}

/**
 * Make a family available to every backend, or say why not.
 *
 * Returns the reason it could not be registered, or null on success — the same shape the importers
 * use, so a caller reports rather than guesses. A DUPLICATE family is not an error and not a
 * silence: it answers with a note, because "that family was already loaded" is something the person
 * who just picked a folder of 56 files wants to see.
 */
export async function registerFont(info: FontInfo, bytes: Uint8Array): Promise<string | null> {
    if (!info.family) return "the font declares no family name";
    if (faces.has(info.family)) return `"${info.family}" was already registered`;
    // No DOM (a unit test, or the browser build without fonts) — nothing to register into, and
    // saying so beats throwing at a caller that only wanted to try.
    if (typeof FontFace === "undefined" || typeof document === "undefined") return "this build cannot register fonts";
    try {
        // The WEIGHT and STYLE are declared from the file rather than left to the platform to guess:
        // a bold face registered without them competes with its own regular sibling under one name.
        const face = new FontFace(info.family, bytes as unknown as BufferSource, {
            weight: String(info.weight),
            style: info.italic ? "italic" : "normal"
        });
        await face.load();
        document.fonts.add(face);
        faces.set(info.family, { info, bytes: bytes.slice() });
        return null;
    } catch (e) {
        // A font the platform refuses is a fact worth reporting, not a crash: one bad file in a
        // folder of fifty should not stop the other forty-nine.
        return `"${info.family}" was refused by the platform: ${(e as Error).message}`;
    }
}
