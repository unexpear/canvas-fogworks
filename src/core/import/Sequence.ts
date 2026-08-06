/**
 * @module Sequence
 * @description A folder of numbered images, grouped into the animations it actually holds.
 *
 * The other way game art ships. One measured pack is 228 PNGs named `fighter_climb_0039.png`,
 * `fighter_run_0017.png` and so on — twelve animations of one character, told apart by nothing but
 * their names. Folder reading already exists and is bounded; what was missing is the reading of the
 * names.
 *
 * THE RULES CAME FROM THE FILES, NOT FROM A GUESS, and the files are messier than a guess would be:
 *
 *   - NUMBERING DOES NOT RESTART per animation. `fighter_run` runs 0017 to 0024, because the artist
 *     numbered the whole character straight through. So a frame's index is only meaningful WITHIN
 *     its stem, and ordering has to be per group.
 *   - THE SEPARATOR IS NOT ALWAYS THERE. `fighter_wallslide0084.png` has its number glued to the
 *     stem while every one of its neighbours uses an underscore. A `_(\d+)` pattern drops that file
 *     silently — one frame missing from one animation, which nobody notices until it plays.
 *   - CASE VARIES between stems: `fighter_Idle` beside `fighter_run`. Stems are therefore compared
 *     exactly rather than folded, because folding would merge two animations an artist named apart.
 *
 * ORDERED BY NUMBER, NEVER BY NAME. Zero-padding is a convention rather than a rule, and the moment
 * one file is `f_9.png` beside `f_10.png` a lexicographic sort puts frame 10 before frame 9. Sorting
 * the parsed integers costs nothing and cannot be wrong.
 *
 * PURE, AND IT TAKES NAMES rather than reading a disk. The importer's decisions are all in the
 * names; the bytes are somebody else's problem, which is what lets every rule above be tested
 * without a filesystem.
 */

import { Keyframe } from "../document/Timeline";

/** Sequences one call may return — a bound on a folder read, like every other bound here. */
export const SEQUENCE_MAX = 4_096;

/** One file's place in its animation. */
export interface SequenceFrame {
    /** The name exactly as given, so a caller can find the file again. */
    file: string;
    /** The trailing number, parsed. Meaningful only WITHIN a stem — numbering is not per-animation. */
    index: number;
}

/** An animation recovered from a folder: its name, and its frames in order. */
export interface Sequence {
    name: string;
    frames: SequenceFrame[];
}

/**
 * A file's stem and trailing number, or null when it carries no number at all.
 *
 * The number is the LAST run of digits before the extension, which is what makes this work on both
 * `fighter_climb_0039.png` and `fighter_wallslide0084.png` — the separator is optional because in
 * the measured pack it genuinely is. A trailing separator is trimmed off the stem so the two
 * spellings group together rather than becoming two animations one frame apart.
 */
export function parseFrameName(file: string): { stem: string; index: number } | null {
    // The extension is removed first so a number inside it could never be mistaken for an index.
    const dot = file.lastIndexOf(".");
    const base = dot > 0 ? file.slice(0, dot) : file;
    const match = /^(.*?)(\d+)$/.exec(base);
    if (!match) return null;
    // A file that is ONLY digits has no stem to group by. It is not an error — a caller may still
    // want it — so it groups under the empty name rather than being dropped.
    const stem = match[1].replace(/[ _\-.]+$/, "");
    return { stem, index: Number(match[2]) };
}

/**
 * The animations a list of filenames holds, each with its frames in numeric order.
 *
 * Groups are returned in the order their first file appeared, so a folder listing's own ordering
 * survives — an alphabetical map would reshuffle the animations relative to how they are listed.
 */
export function groupSequences(files: readonly string[]): Sequence[] {
    const byStem = new Map<string, SequenceFrame[]>();
    for (const file of files) {
        const parsed = parseFrameName(file);
        // A file with NO number is not a frame of anything. Skipped rather than treated as a
        // one-frame animation, because a folder of sprites routinely also holds a `readme` or a
        // `preview` — and inventing an animation out of one is worse than ignoring it.
        if (!parsed) continue;
        const frames = byStem.get(parsed.stem);
        if (frames) frames.push({ file, index: parsed.index });
        else byStem.set(parsed.stem, [{ file, index: parsed.index }]);
        if (byStem.size > SEQUENCE_MAX) break;
    }
    const out: Sequence[] = [];
    byStem.forEach((frames, name) => {
        // BY NUMBER. Padding is a convention, not a rule: one `f_9.png` beside `f_10.png` and a
        // name sort plays frame 10 first. Ties keep their listed order, which `sort` gives for
        // free and which is the only sensible answer for two files claiming one index.
        out.push({ name, frames: frames.slice().sort((a, b) => a.index - b.index) });
    });
    return out;
}

/**
 * A sequence as a TRACK — one keyframe per frame, `step` frames apart.
 *
 * The keyframes are NOT held, and that is the whole reason `src` steps through a blend (schema 53).
 * A held keyframe freezes the ENTIRE node until the next one, so a character running across the
 * screen could not both cycle its drawings and move: the position tween would stop dead at every
 * frame. Unheld keyframes let position interpolate while the picture steps, which is what a running
 * character is.
 */
export function sequenceTrack(sequence: Sequence, opts?: { start?: number; step?: number; hrefFor?: (file: string) => string }): Keyframe[] {
    const start = Math.round(opts?.start ?? 0);
    // A step of zero would stack every frame on one, where only the last could ever be seen.
    const step = Math.max(1, Math.round(opts?.step ?? 1));
    const href = opts?.hrefFor ?? ((file: string) => file);
    return sequence.frames.map((frame, i) => ({
        frame: start + i * step,
        values: { src: href(frame.file) }
    }));
}
