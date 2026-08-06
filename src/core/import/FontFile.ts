/**
 * @module FontFile
 * @description The facts needed to register a font, read from the font rather than its filename.
 *
 * `style.fontFamily` has always been a string and nothing else. A document could ask for "Kenney
 * Blocks" and every backend would hand that name to the platform, which would shrug and draw
 * something else — text still laid out, in the wrong typeface, which looks like a rendering fault
 * rather than a missing file. Fifty-six fonts sit in the measured tree and none could be used.
 *
 * THE NAME COMES OUT OF THE FILE, NOT OFF THE FILENAME. `Kenney Future Narrow.ttf` is a guess; the
 * `name` table states the family the platform matches on, and the two are not reliably the same —
 * a file renamed on download would silently never match what a document asks for.
 *
 * PARSING STOPS AT THE NAME. Reading glyph outlines would be a typesetting engine and this does not
 * need one: the platform rasterises text itself once a face is registered. What it needs is the
 * handful of facts required to register that face and to describe it in a picker — family,
 * subfamily, weight, italic, and which flavour of outline the file carries.
 *
 * Registration is the impure half and lives in the renderer beside the other decode work, for the
 * same reason: it needs a DOM, and keeping it out of here is what lets these rules be tested
 * without one.
 */

/** Bounds on a hand-editable file: a corrupt table count should fail, not allocate. */
export const FONT_MAX_TABLES = 512;
export const FONT_MAX_NAMES = 4_096;

/** Which outline format the file carries — the two the measured tree holds are both here. */
export type FontFlavour = "truetype" | "cff";

/** What a face needs to be registered and described. */
export interface FontInfo {
    /** The family the platform matches on — nameID 1. */
    family: string;
    /** "Regular", "Bold", "Italic" and so on — nameID 2. */
    subfamily: string;
    /** nameID 4, which is what a picker should show. */
    fullName: string;
    /** nameID 6, the name a PDF or PostScript stream would use. */
    postScriptName: string;
    flavour: FontFlavour;
    /** Design units per em — the scale every metric in the file is expressed in. */
    unitsPerEm: number;
    /**
     * `usWeightClass`, which lands in this engine's `style.fontWeight` unchanged: both are the
     * 1–1000 CSS scale, so no translation table is needed and none can drift.
     */
    weight: number;
    italic: boolean;
}

const TAG_HEAD = "head";
const TAG_NAME = "name";
const TAG_OS2 = "OS/2";

/** The sfnt table directory: tag to [offset, length]. */
function tableDirectory(view: DataView, bytes: Uint8Array): Map<string, [number, number]> | null {
    if (bytes.length < 12) return null;
    const count = view.getUint16(4, false);
    if (count < 1 || count > FONT_MAX_TABLES) return null;
    const out = new Map<string, [number, number]>();
    for (let i = 0; i < count; i++) {
        const at = 12 + i * 16;
        if (at + 16 > bytes.length) return null;
        const tag = new TextDecoder("latin1").decode(bytes.subarray(at, at + 4));
        out.set(tag, [view.getUint32(at + 8, false), view.getUint32(at + 12, false)]);
    }
    return out;
}

/** What went wrong, or null — checked before parsing so a caller can refuse without allocating. */
export function fontFileError(bytes: unknown): string | null {
    if (!(bytes instanceof Uint8Array)) return "a font must be bytes";
    if (bytes.length < 12) return "not a font: shorter than its header";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(0, false);
    // 0x00010000 and `true` are TrueType outlines; `OTTO` is CFF. `ttcf` is a COLLECTION of faces
    // and `wOFF`/`wOF2` are compressed wrappers — all three are named rather than half-read,
    // because each needs a different unpacking step this does not do.
    if (version === 0x74746366) return "font collections (.ttc) are not supported yet";
    if (version === 0x774f4646 || version === 0x774f4632) return "WOFF fonts are not supported yet";
    if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) {
        return "not a font: unrecognised sfnt version";
    }
    const dir = tableDirectory(view, bytes);
    if (!dir) return "not a font: unreadable table directory";
    if (!dir.has(TAG_NAME)) return "font has no name table, so nothing can match it";
    return null;
}

/** One name-table string, decoded by its platform's own encoding. */
function decodeName(bytes: Uint8Array, platform: number): string {
    // Windows (3) and Unicode (0) are UTF-16BE; Macintosh (1) is a single-byte set whose ASCII
    // range is all these files use. Reading a UTF-16 string as bytes yields NULs between every
    // letter, which is the tell that this distinction was skipped.
    if (platform === 3 || platform === 0) return new TextDecoder("utf-16be").decode(bytes);
    return new TextDecoder("latin1").decode(bytes);
}

/**
 * The face's identifying facts.
 *
 * Throws on anything `fontFileError` refuses. A missing optional table is not an error — plenty of
 * fonts omit `OS/2` — so those fall back to the values CSS would assume rather than failing a file
 * that renders perfectly well.
 */
export function parseFontFile(bytes: Uint8Array): FontInfo {
    const bad = fontFileError(bytes);
    if (bad) throw new Error(`Invalid font: ${bad}.`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dir = tableDirectory(view, bytes) as Map<string, [number, number]>;

    const [nameOffset] = dir.get(TAG_NAME) as [number, number];
    const count = view.getUint16(nameOffset + 2, false);
    const storage = nameOffset + view.getUint16(nameOffset + 4, false);
    if (count > FONT_MAX_NAMES) throw new Error("Invalid font: name table declares too many records.");

    // BEST record per id, not the first: a font carries the same name several times for different
    // platforms, and the Macintosh copy often comes first while the Windows one is the string the
    // platform will actually match on.
    const best = new Map<number, { score: number; text: string }>();
    for (let i = 0; i < count; i++) {
        const at = nameOffset + 6 + i * 12;
        if (at + 12 > bytes.length) break;
        const platform = view.getUint16(at, false);
        const language = view.getUint16(at + 4, false);
        const nameId = view.getUint16(at + 6, false);
        const length = view.getUint16(at + 8, false);
        const offset = view.getUint16(at + 10, false);
        const start = storage + offset;
        if (start + length > bytes.length) continue;
        const text = decodeName(bytes.subarray(start, start + length), platform).replace(/\0+$/, "");
        if (text.length === 0) continue;
        // Windows English wins, then any Windows, then anything at all.
        const score = platform === 3 && language === 0x409 ? 3 : platform === 3 ? 2 : 1;
        const held = best.get(nameId);
        if (!held || score > held.score) best.set(nameId, { score, text });
    }
    const nameOf = (id: number) => best.get(id)?.text ?? "";

    const head = dir.get(TAG_HEAD);
    // 1000 for CFF and 2048 for TrueType are the usual values, but the file states it; the fallback
    // is only for a font with no `head` at all, which `fontFileError` does not refuse because such
    // a font still registers and renders.
    const unitsPerEm = head && head[0] + 20 <= bytes.length ? view.getUint16(head[0] + 18, false) : 1000;
    const macStyle = head && head[0] + 46 <= bytes.length ? view.getUint16(head[0] + 44, false) : 0;

    const os2 = dir.get(TAG_OS2);
    const weight = os2 && os2[0] + 6 <= bytes.length ? view.getUint16(os2[0] + 4, false) : 400;
    const version = view.getUint32(0, false);

    return {
        family: nameOf(1),
        subfamily: nameOf(2),
        fullName: nameOf(4),
        postScriptName: nameOf(6),
        flavour: version === 0x4f54544f ? "cff" : "truetype",
        unitsPerEm: unitsPerEm > 0 ? unitsPerEm : 1000,
        // CLAMPED into what `styleError` accepts for `fontWeight`, since the field is a raw uint16
        // in the file and nothing stops a font declaring 0.
        weight: Math.min(1000, Math.max(1, weight)),
        // Bit 1 of `macStyle` is italic. The `OS/2` fsSelection flag says the same thing and the
        // two can disagree in a badly built font; `head` is the one every rasteriser reads.
        italic: (macStyle & 0b10) !== 0
    };
}
