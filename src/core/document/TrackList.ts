/**
 * @module TrackList
 * @description Parses and formats a grid track list — the authoring form of `TrackSize[]`.
 *
 * `TrackSize` is stored STRUCTURED (`{px}` / `{fr}` / `{auto:true}`), for the same reason
 * `core.path` stores structured commands rather than a `d` string: one shared field-by-field
 * validator, and no backend has to re-parse. But a row-per-track widget is a poor way to author
 * six columns, and every designer already thinks in `1fr 1fr 200px`. So the text form lives
 * here, as a pure pair with the structured form on the other side.
 *
 * The parser does NOT restate what a valid track is — it builds a candidate and hands it to
 * `trackError`, the same function the loader and every layout action use. A field cannot author
 * a track the document would refuse, because the field and the document ask the same question.
 * (Compare `tokenRefFor` in Variables.ts: when the engine already decides a format, the engine
 * owns the constructor.)
 */

import { TrackSize, trackError, GRID_MAX_TRACKS } from "./Node";

/**
 * A parse attempt. `error === null` exactly when `tracks !== null` — one of the two is always
 * present, so a caller that checks either has checked both.
 */
export interface TrackListParse {
    tracks: readonly TrackSize[] | null;
    error: string | null;
}

/**
 * A number with an optional unit. The exponent form is accepted because `formatTrackList` can
 * emit it (`String(1e21)` is `"1e+21"`), and a format the formatter produces must re-parse or
 * the round trip is a lie for large values.
 */
const TOKEN = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(px|fr)?$/i;

/** One token → one track, or a message naming the token. */
function parseToken(raw: string): { track: TrackSize } | { error: string } {
    if (raw.toLowerCase() === "auto") return { track: { auto: true } };

    const m = TOKEN.exec(raw);
    if (!m) return { error: `"${raw}" is not a track — use a number, "1fr", "100px" or "auto"` };

    const n = Number(m[1]);
    // A bare number is pixels, the unit people omit most often.
    const track: TrackSize = (m[2] || "px").toLowerCase() === "fr" ? { fr: n } : { px: n };

    // The SHARED validator decides whether this is a legal track — not a rule restated here.
    const e = trackError(track);
    return e ? { error: `"${raw}": ${e}` } : { track };
}

/**
 * Parse a whitespace- or comma-separated track list. Empty input is an ERROR rather than an
 * empty list, because `columns` may not be empty and "no tracks" is never what someone meant —
 * a caller wanting "absent" (the optional `rows`) tests for empty input before calling.
 */
export function parseTrackList(text: string): TrackListParse {
    const tokens = text.trim().split(/[\s,]+/).filter(t => t.length > 0);
    if (tokens.length === 0) return { tracks: null, error: "needs at least one track" };
    if (tokens.length > GRID_MAX_TRACKS) return { tracks: null, error: `at most ${GRID_MAX_TRACKS} tracks` };

    const tracks: TrackSize[] = [];
    for (const raw of tokens) {
        const r = parseToken(raw);
        if ("error" in r) return { tracks: null, error: r.error };
        tracks.push(r.track);
    }
    return { tracks, error: null };
}

/** One track → its text form. */
function formatTrack(t: TrackSize): string {
    if ("auto" in t) return "auto";
    if ("fr" in t) return `${t.fr}fr`;
    return `${t.px}px`;
}

/** The text form of a track list — the inverse of `parseTrackList` for any VALID list. */
export function formatTrackList(tracks: readonly TrackSize[]): string {
    return tracks.map(formatTrack).join(" ");
}
