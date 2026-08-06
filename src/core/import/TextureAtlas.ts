/**
 * @module TextureAtlas
 * @description Reading the descriptor that says where each sprite is, when no grid can.
 *
 * MOST REAL SHEETS ARE NOT GRIDS. Across 421 atlases shipped with 88,815 files of game art: 206 are
 * irregularly packed, 33 are uniform but not aligned to their own size, and only 182 are true grids.
 * One holds 359 sprites in 135 distinct sizes at coordinates like 455,849 and 520,179. `SheetSlice`
 * recovers a grid by dividing an image and refuses sizes that do not fit — which is the right answer
 * for the 182 and no answer at all for the other 239.
 *
 * THEY DO NOT NEED MEASURING, BECAUSE THEY ARRIVE WITH A DESCRIPTOR. The Starling/ShoeBox
 * `<TextureAtlas><SubTexture>` format is what almost every packer emits, and its fields land exactly
 * on what this engine already holds: `x,y,width,height` IS a `sourceRect` (schema 51), and
 * `frameX/frameY/frameWidth/frameHeight` IS the trim placement `core/import/Trim` computes.
 *
 * THE TRIM ARITHMETIC IS REUSED, NOT REWRITTEN. An atlas states the untrimmed size and where the kept
 * piece sits inside it; `trimmedPlacement` states where a kept piece goes so its ink does not move.
 * Same question, different names for the inputs — so this hands its numbers to that function rather
 * than growing a second copy of the multiply-and-offset, which would drift from it.
 *
 * IT IS A TEXTUREATLAS READER, NOT AN XML PARSER, and the distinction is the point. Core is pure and
 * has no DOM, and a regex pretending to parse XML is a liability the moment it meets a namespace or a
 * CDATA section. This reads exactly the shape the format defines and refuses anything else by name —
 * a much smaller promise, and one that can be kept.
 */

import { SourceRect } from "../document/Node";
import { Trim, TrimBox, trimmedPlacement } from "./Trim";

/** Sub-textures one atlas may declare — a bound on a hand-editable file. */
export const ATLAS_MAX_ENTRIES = 65_536;

/** One sprite's place in the sheet. */
export interface AtlasEntry {
    /** The sprite's original filename, which is how a packer names it and how a caller finds it. */
    name: string;
    /** Where it lives in the texture — a `sourceRect` under another name. */
    source: SourceRect;
    /**
     * What it was trimmed from, or null when the packer kept the whole sprite.
     *
     * `width`/`height` are the UNTRIMMED size and `x`/`y` where the kept piece sits inside it. The
     * format writes those offsets negated (`frameX="-56"` means 56 pixels in), which is a convention
     * this normalises away so nothing downstream has to remember the sign.
     */
    trim: { x: number; y: number; width: number; height: number } | null;
    /**
     * The sprite is stored TURNED in the texture, so its region is the transpose of its frame.
     *
     * Found by reading every atlas in an 88,815-file tree rather than by reading the spec: two
     * entries declare a 64x10 region inside a 10x64 frame. That is a packer recording rotation by
     * swapping the frame's dimensions instead of writing the `rotated` attribute — which the
     * attribute check cannot see, and which the trim arithmetic would quietly mis-place, because a
     * kept piece wider than its own frame clips to nonsense.
     *
     * REPORTED, NOT REFUSED. The region itself is correct and a caller that turns the draw gets the
     * right picture; failing the whole file would cost the other 357 sprites in it for the sake of
     * two. `atlasPlacement` declines to apply the trim for these, so nothing is placed wrongly.
     */
    rotated: boolean;
}

/** A parsed atlas. */
export interface Atlas {
    /** The texture this describes, as the file names it — relative to the atlas. */
    image: string;
    entries: AtlasEntry[];
}

/** Attributes of one tag, read as the format defines them rather than as XML in general. */
function attributes(tag: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of tag.matchAll(/([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
    return out;
}

/** What went wrong, or null — checked before parsing so a caller can refuse without allocating. */
export function atlasError(text: string): string | null {
    if (!/<TextureAtlas[\s>]/.test(text)) return "not a TextureAtlas: no <TextureAtlas> element";
    const count = (text.match(/<SubTexture[\s/>]/g) || []).length;
    if (count === 0) return "TextureAtlas declares no sub-textures";
    if (count > ATLAS_MAX_ENTRIES) return `TextureAtlas declares ${count} sub-textures, more than this reads`;
    // ROTATION is refused rather than ignored. No atlas in the surveyed tree uses it, so this costs
    // nothing today — but a packer that emitted it and a reader that skipped the flag would draw
    // every affected sprite on its side, which is a wrong picture rather than a missing one.
    if (/\brotated\s*=\s*"(?:true|1)"/i.test(text)) return "rotated sub-textures are not supported yet";
    return null;
}

/**
 * The sprites an atlas declares.
 *
 * Throws on anything `atlasError` refuses, so a caller that skipped the check cannot end up with
 * half an answer. An entry missing a required number is skipped rather than failing the file: one
 * malformed line in a generated descriptor should not cost the other three hundred sprites.
 */
export function parseTextureAtlas(text: string): Atlas {
    const bad = atlasError(text);
    if (bad) throw new Error(`Invalid texture atlas: ${bad}.`);

    const root = /<TextureAtlas[^>]*>/.exec(text);
    const image = root ? (attributes(root[0]).imagePath ?? "") : "";
    const entries: AtlasEntry[] = [];

    for (const m of text.matchAll(/<SubTexture\b[^>]*>/g)) {
        const a = attributes(m[0]);
        const num = (key: string): number | null => {
            const v = a[key];
            if (v === undefined) return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        const x = num("x"), y = num("y"), width = num("width"), height = num("height");
        // ENFORCED BY THE COMPILER, not merely by a test: `num` returns `number | null`, so
        // weakening this check does not produce a wrong atlas — it produces TS18047 and TS2322 and
        // will not build. A mutation of it cannot be written, which is a stronger guarantee than
        // any assertion, and is why the battery for this file reports one un-mutatable line.
        if (x === null || y === null || width === null || height === null) continue;
        // A ZERO-EXTENT region cannot be sampled — every backend divides by it — so it is dropped
        // rather than carried into a document that would refuse it later, further from the cause.
        if (!(width > 0) || !(height > 0)) continue;

        const frameW = num("frameWidth"), frameH = num("frameHeight");
        const frameX = num("frameX"), frameY = num("frameY");
        // TRIM IS OPTIONAL, and mostly absent: 404 of the 421 surveyed atlases omit these entirely,
        // and of 26,892 sub-textures only 120 are actually trimmed. A frame the same size as the
        // region is not a trim either — it is a packer writing the fields out of habit.
        const trimmed = frameW !== null && frameH !== null && frameW > 0 && frameH > 0
            && (frameW !== width || frameH !== height || (frameX ?? 0) !== 0 || (frameY ?? 0) !== 0);
        // THE TRANSPOSE TEST. A square sprite is excluded because its dimensions are its own
        // transpose, so it can never distinguish a turn from an ordinary frame.
        const rotated = trimmed && width !== height
            && width === (frameH as number) && height === (frameW as number);
        entries.push({
            name: a.name ?? "",
            rotated,
            source: { x, y, width, height },
            // NEGATED HERE, once. The format writes `frameX="-56"` to mean "56 pixels in", and
            // normalising the sign at the edge means nothing downstream has to remember it.
            trim: trimmed ? { x: -(frameX ?? 0), y: -(frameY ?? 0), width: frameW as number, height: frameH as number } : null
        });
    }
    return { image, entries };
}

/** One entry by name, or null. Names are a packer's filenames, so they are unique in practice. */
export function atlasEntry(atlas: Atlas, name: string): AtlasEntry | null {
    return atlas.entries.find(e => e.name === name) ?? null;
}

/**
 * Where an entry's region goes, given the box its UNTRIMMED sprite would occupy.
 *
 * The whole reason trim data is worth reading: without it a trimmed sprite drawn into its box sits
 * wherever the packer happened to crop it, and a row of them jitters. With it, the kept piece is
 * offset and scaled so it lands exactly where the untrimmed sprite would have.
 *
 * `trimmedPlacement` does that arithmetic already — an atlas simply states the same thing with the
 * inputs named differently — so this translates and delegates. Its returned `source` is in FRAME
 * space and therefore discarded; the real region is the entry's own, which is in TEXTURE space.
 */
export function atlasPlacement(entry: AtlasEntry, box: TrimBox): Trim {
    // A TURNED sprite's frame describes the picture upright while its region holds it sideways, so
    // the offsets cannot be applied as written — they would clip a kept piece against a frame it is
    // wider than. The region is still right; a caller that rotates the draw gets the sprite, and
    // one that does not gets it sideways in the correct place rather than shrunk in the wrong one.
    if (!entry.trim || entry.rotated) return { source: entry.source, box };
    const frame: SourceRect = { x: 0, y: 0, width: entry.trim.width, height: entry.trim.height };
    const kept: SourceRect = { x: entry.trim.x, y: entry.trim.y, width: entry.source.width, height: entry.source.height };
    const placed = trimmedPlacement(box, frame, kept);
    // A kept piece entirely outside its own frame is a contradictory descriptor. Falling back to the
    // untrimmed box draws the sprite in the right PLACE at the wrong size, which is visible — where
    // returning nothing would silently drop it.
    return placed ? { source: entry.source, box: placed.box } : { source: entry.source, box };
}
