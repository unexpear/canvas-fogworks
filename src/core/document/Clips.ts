/**
 * @module Clips
 * @description Named frame ranges — `idle`, `walk`, `jump` — over the one timeline.
 *
 * A game character is not one animation, it is a dozen. Until this existed a document held exactly
 * one timeline, so idle, walk and jump could not live in the same file, and a character would have
 * had to be split across as many documents as it has moods. That is the wrong unit: the thing a
 * person makes and ships is the CHARACTER.
 *
 * A clip is a NAMED RANGE rather than a timeline of its own, which is how sprite sheets and every
 * 2D engine express the same idea — one strip of frames, cut into runs. Keeping a single clock is
 * what makes this cheap: a keyframe is still just a keyframe, the motion trace still measures
 * frames, onion skinning still looks at neighbours, and nothing below this had to learn a new
 * concept. Separate timelines per clip would have meant every one of those growing a notion of
 * "which timeline", for no expressive gain.
 *
 * BOTH ENDS INCLUSIVE, matching `traceTiming` and the timeline strip. A clip from 0 to 11 at 12fps
 * is one second and twelve drawings, not eleven twelfths of one — and an exclusive end is the kind
 * of off-by-one nobody notices until a loop stutters at the seam.
 */

import { TimelineSettings } from "./Timeline";

/** Clips one document may hold — a character has a dozen, not thousands. */
export const CLIPS_MAX = 256;
/** Longest a clip name may be. Hand-editable, so bounded like every other string here. */
export const CLIP_NAME_MAX = 64;

export interface Clip {
    /** The identity — a clip is selected by name, so two of the same would be ambiguous. */
    name: string;
    /** First frame, inclusive. */
    from: number;
    /** Last frame, INCLUSIVE — see the module note. */
    to: number;
    /**
     * Cycle at the end rather than stopping. Absent = TRUE.
     *
     * The default is the common case rather than the cautious one: idle, walk and run all cycle,
     * and the clips that do not — a death, a one-shot attack — are exactly the ones an author is
     * already thinking about when they make them.
     */
    loop?: boolean;
}

/**
 * Are these clips usable against this timeline? Shared by the edit and load paths.
 *
 * The TIMELINE is a parameter because a clip is meaningless without one: a range over a clock that
 * does not exist cannot be played, and accepting it would push the failure onto whoever tried.
 */
export function clipsError(clips: unknown, timeline: TimelineSettings | undefined): string | null {
    if (clips === undefined) return null;
    if (!Array.isArray(clips)) return "clips must be an array";
    if (clips.length === 0) return null;
    if (!timeline) return "clips need a timeline — a frame range means nothing without a clock";
    if (clips.length > CLIPS_MAX) return `clips must hold at most ${CLIPS_MAX}`;
    const seen = new Set<string>();
    for (const c of clips as Clip[]) {
        if (typeof c !== "object" || c === null || Array.isArray(c)) return "clip must be an object";
        if (typeof c.name !== "string" || c.name.length === 0) return "clip.name must be a non-empty string";
        if (c.name.length > CLIP_NAME_MAX) return `clip.name must be at most ${CLIP_NAME_MAX} characters`;
        // UNIQUE, because the name is the identity. Two clips called `walk` make "play walk"
        // ambiguous, and picking one of them silently is the kind of answer nobody can debug.
        if (seen.has(c.name)) return `clip.name "${c.name}" is used twice — a clip is selected by name`;
        seen.add(c.name);
        if (!Number.isInteger(c.from) || !Number.isInteger(c.to)) return "clip.from and clip.to must be whole frames";
        if (c.from < 0) return "clip.from must not be negative";
        // INSIDE the timeline. A clip reaching past the last frame plays silence at the end, which
        // reads as the animation being broken rather than as the range being wrong.
        if (c.to > timeline.frames - 1) return `clip "${c.name}" ends past the timeline's last frame`;
        if (c.to < c.from) return `clip "${c.name}" ends before it begins`;
        if (c.loop !== undefined && typeof c.loop !== "boolean") return "clip.loop must be a boolean";
    }
    return null;
}

/** The clip of that name, or null. Named lookup because the name IS how a clip is chosen. */
export function findClip(clips: readonly Clip[] | undefined, name: string): Clip | null {
    return clips?.find(c => c.name === name) ?? null;
}

/** How many frames a clip shows. Inclusive of both ends, so a one-frame clip is 1. */
export function clipLength(clip: Clip): number {
    return Math.max(0, clip.to - clip.from + 1);
}

/**
 * Where the playhead sits after `elapsed` frames of playing this clip.
 *
 * `elapsed` counts from the clip's start rather than from the timeline's, because a clip is the
 * unit being played — a caller should not have to know where in the strip it happens to live.
 *
 * A LOOPING clip wraps; a one-shot HOLDS on its last frame rather than stopping at some other
 * value or wrapping to the start. Holding is what a finished animation looks like: a character
 * that has died stays dead, and one whose attack has landed stays on the last pose until something
 * else is played.
 */
export function clipFrameAt(clip: Clip, elapsed: number): number {
    const length = clipLength(clip);
    if (length <= 0) return clip.from;
    const e = Math.max(0, Math.floor(elapsed));
    if (clip.loop === false) return clip.from + Math.min(e, length - 1);
    return clip.from + (e % length);
}
