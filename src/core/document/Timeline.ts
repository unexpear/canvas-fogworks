/**
 * @module Timeline
 * @description Animation over FRAMES — and the observation that it is one mechanism, not four.
 *
 * Cutout animation, frame-by-frame, tweening and onion skinning sound like four features. They are
 * one plus a display option, and saying so is what keeps this small:
 *
 *   - a KEYFRAME is a statement that certain fields differ at a certain time. This engine already
 *     has that statement — an instance OVERRIDE and a named STATE are both "in this context these
 *     fields differ", and they already share `overrideValueError` and `materializeNode`. A
 *     keyframe is the same shape with a frame number on it, so it inherits both.
 *   - TWEENING is what happens between two keyframes, and that is `blendNode`, written for state
 *     transitions and identical here. Two copies of that arithmetic would drift the first time a
 *     field learned to interpolate.
 *   - FRAME-BY-FRAME is tweening turned off. A keyframe marked `hold` shows its values until the
 *     next one and then snaps, which is exactly what a sequence of drawings does. It is not a
 *     different animation model, it is a flag.
 *   - CUTOUT animation is keyframes on a rig's TRANSFORMS. The scene graph already composes a
 *     parent's matrix into its children, so animating an upper arm carries the forearm and the
 *     hand with it and this module needs to know nothing about limbs.
 *   - ONION SKINNING is not animation at all — it draws neighbouring frames faintly and belongs to
 *     the renderer, which is where it lives (`RendererState.ghosts`).
 *
 * `applyFrame` slots into `resolveScene` beside `applyActiveState`, so a document at a frame is an
 * ORDINARY document. Layout, picking, snapping, culling, the three backends and the exporter need
 * no knowledge that time exists — the same trick components and booleans play, and the reason a
 * whole animation system costs almost nothing below the display seam.
 */

import { Easing, EaseFor, blendNode, easingAt, easingError } from "./Prototype";
import { Node, StateDefinition } from "./Node";
import { ReadonlyDocument, ProjectDocument } from "./Document";
import { materializeNode } from "./Components";

/** Longest timeline a document may declare — an OOM guard on a hand-editable number. */
export const TIMELINE_MAX_FRAMES = 100_000;
/** Keyframes one node may carry, bounded for the same reason `INTERACTIONS_MAX` is. */
export const TRACK_MAX_KEYFRAMES = 10_000;
/** Frame rates a document may declare. Bounded below by 1 — a timeline that never advances. */
export const FPS_MIN = 1;
export const FPS_MAX = 240;

export interface Keyframe {
    /** Whole frames from zero. Fractional frames would make "the frame you are on" ambiguous. */
    frame: number;
    /**
     * HOLD this value until the next keyframe instead of tweening toward it.
     *
     * The whole of frame-by-frame animation. A held keyframe is a drawing that stays on screen
     * until the next drawing replaces it, which is what a sequence of cels does.
     */
    hold?: boolean;
    /** How the tween LEAVING this keyframe is shaped. Absent = linear. Ignored when held. */
    easing?: Easing;
    /**
     * PER-PROPERTY curves, keyed by path — `"geometry.x"`, `"transform.rotation"`,
     * `"style.opacity"`. Anything not named uses `easing` (schema 45).
     *
     * The first exercise anybody animates cannot be authored without this. A bouncing ball crosses
     * the floor at a CONSTANT horizontal speed while its vertical speed changes continuously; that
     * difference IS the lesson about spacing. With one curve per keyframe the horizontal motion
     * inherits gravity's easing and the ball decelerates sideways as it rises — measured at
     * 16,10,8,6,4,4,2,2,1,1,1,0 pixels per frame before this existed.
     *
     * A MAP rather than splitting each property into its own track, which is the larger and
     * eventually right answer: independent per-property TIMING lets rotation key on frames that
     * position does not. This shares the keyframe times and varies only the curve, which is what
     * the classical exercises need, and it does not stand in the way of channels later.
     */
    easings?: Record<string, Easing>;
    /** What differs at this frame — the same statement a state or an instance override makes. */
    values: StateDefinition;
}

/** The document's own clock. Absent = the document is not animated at all. */
export interface TimelineSettings {
    frames: number;
    fps: number;
}

export function timelineError(t: unknown): string | null {
    if (t === undefined) return null;
    if (typeof t !== "object" || t === null || Array.isArray(t)) return "timeline must be an object";
    const s = t as Partial<TimelineSettings>;
    if (!Number.isInteger(s.frames) || (s.frames as number) < 1 || (s.frames as number) > TIMELINE_MAX_FRAMES) {
        return `timeline.frames must be a whole number within [1, ${TIMELINE_MAX_FRAMES}]`;
    }
    if (!Number.isFinite(s.fps) || (s.fps as number) < FPS_MIN || (s.fps as number) > FPS_MAX) {
        return `timeline.fps must be within [${FPS_MIN}, ${FPS_MAX}]`;
    }
    return null;
}

/**
 * Validity of a node's track, SHARED by the edit path and the load path.
 *
 * The keyframes' VALUES are not checked here: they are a `StateDefinition`, and the rules for one
 * live in `overrideValueError`, which both the state path and the override path already call. A
 * second copy of those rules is the drift this codebase keeps designing out — so this checks only
 * what is new, which is the timing.
 */
export function trackError(track: unknown, valuesError: (v: unknown) => string | null): string | null {
    if (track === undefined) return null;
    if (!Array.isArray(track)) return "track must be an array";
    if (track.length > TRACK_MAX_KEYFRAMES) return `track must hold at most ${TRACK_MAX_KEYFRAMES} keyframes`;
    let previous = -1;
    for (const k of track as Keyframe[]) {
        if (typeof k !== "object" || k === null || Array.isArray(k)) return "keyframe must be an object";
        if (!Number.isInteger(k.frame) || k.frame < 0) return "keyframe.frame must be a whole number >= 0";
        // SORTED and distinct, checked rather than assumed. Every lookup below is a walk in frame
        // order, and two keyframes on one frame is not a drawing anybody can mean.
        if (k.frame <= previous) return "track keyframes must be in ascending frame order";
        previous = k.frame;
        if (k.hold !== undefined && typeof k.hold !== "boolean") return "keyframe.hold must be a boolean";
        const easingBad = easingError(k.easing);
        if (easingBad) return `keyframe ${easingBad}`;
        if (k.easings !== undefined) {
            if (typeof k.easings !== "object" || k.easings === null || Array.isArray(k.easings)) {
                return "keyframe.easings must be an object keyed by property path";
            }
            for (const [path, e] of Object.entries(k.easings)) {
                // The PATH is checked as well as the curve. An unknown one is not harmless: it
                // silently eases nothing, so the animator sees the default curve and has no way to
                // tell a typo from a property that does not tween.
                if (!EASABLE_PATHS.has(path)) return `keyframe.easings has no such property "${path}"`;
                const bad = easingError(e);
                if (bad) return `keyframe.easings["${path}"] ${bad}`;
            }
        }
        const bad = valuesError(k.values);
        if (bad) return bad;
    }
    return null;
}

/**
 * Channels one node may carry. The map is keyed by property path and the paths are a fixed set, so
 * this is generous rather than tight — it exists for the same reason every other map here is
 * bounded, not because anybody will approach it.
 */
export const CHANNELS_MAX = 64;

/**
 * Validity of a node's CHANNELS (schema 47), shared by the edit path and the load path.
 *
 * A channel is a TRACK, so this delegates to `trackError` rather than restating the timing rules —
 * ascending frames, the keyframe count, `hold`, the easing curves and the per-property ones are all
 * already governed there, and a second copy is the drift this codebase keeps designing out.
 *
 * ONLY TWO RULES ARE NEW. The PATH must be one the engine actually interpolates, for the same
 * reason `easings` checks it: a channel on a path that tweens nothing animates nothing, and that
 * is indistinguishable from a curve being wrong. And a channel's keyframes may name ONLY its own
 * path — a channel called `transform.rotation` that also sets `geometry.x` is a statement with two
 * meanings, and refusing it is better than picking one.
 */
export function channelsError(channels: unknown, valuesError: (v: unknown) => string | null): string | null {
    if (channels === undefined) return null;
    if (typeof channels !== "object" || channels === null || Array.isArray(channels)) {
        return "channels must be an object keyed by property path";
    }
    const entries = Object.entries(channels as Record<string, unknown>);
    if (entries.length > CHANNELS_MAX) return `channels must hold at most ${CHANNELS_MAX} paths`;
    for (const [path, track] of entries) {
        if (!EASABLE_PATHS.has(path)) return `channels has no such property "${path}"`;
        if (!Array.isArray(track)) return `channels["${path}"] track must be an array`;
        const bad = trackError(track, valuesError);
        if (bad) return `channels["${path}"] ${bad}`;
        for (const k of track as Keyframe[]) {
            const named = pathsNamedBy(k.values);
            // An EMPTY keyframe is refused too. "This channel says nothing at this frame" is not a
            // drawing anybody means, and silently holding the previous value would make a typo in
            // the group name look like an intentional hold.
            if (named.length !== 1 || named[0] !== path) {
                return `channels["${path}"] keyframe must set exactly that property, not ${JSON.stringify(named)}`;
            }
        }
    }
    return null;
}

/** The `group.field` paths a keyframe's values actually name — the check `channelsError` makes. */
function pathsNamedBy(values: unknown): string[] {
    if (typeof values !== "object" || values === null) return [];
    const out: string[] = [];
    for (const [group, fields] of Object.entries(values as Record<string, unknown>)) {
        if (typeof fields !== "object" || fields === null) continue;
        for (const field of Object.keys(fields as Record<string, unknown>)) out.push(`${group}.${field}`);
    }
    return out;
}

/**
 * The pair of keyframes a frame falls between, and how far between them it is.
 *
 * Outside the track's own range the nearest keyframe is HELD rather than extrapolated. Before the
 * first, the animation has not started and the shape sits where it was authored to start; after
 * the last, it has finished and stays. Extrapolating instead would send a shape flying off in both
 * directions from a two-keyframe track, which nobody has ever wanted.
 */
/**
 * Property paths a keyframe may name in `easings` — exactly the ones `blendNode` interpolates.
 *
 * Listed rather than inferred because the point is to REJECT a path that eases nothing. A
 * misspelled key would otherwise be accepted and quietly do nothing, which is indistinguishable
 * from the curve being wrong.
 */
export const EASABLE_PATHS: ReadonlySet<string> = new Set([
    "geometry.x", "geometry.y", "geometry.width", "geometry.height",
    "style.opacity", "style.fill", "style.stroke",
    "style.radius", "style.strokeWidth", "style.fontSize", "style.letterSpacing",
    "style.lineHeight", "style.fontWeight",
    "transform.rotation", "transform.scaleX", "transform.scaleY"
]);

export function keyframesAt(track: readonly Keyframe[], frame: number): { from: Keyframe; to: Keyframe | null; t: number; raw: number } | null {
    if (track.length === 0) return null;
    if (frame <= track[0].frame) return { from: track[0], to: null, t: 0, raw: 0 };
    const last = track[track.length - 1];
    if (frame >= last.frame) return { from: last, to: null, t: 0, raw: 0 };
    for (let i = track.length - 1; i >= 0; i--) {
        if (track[i].frame > frame) continue;
        const from = track[i], to = track[i + 1];
        // A HELD keyframe never blends toward its successor: it simply stays until replaced.
        if (from.hold) return { from, to: null, t: 0, raw: 0 };
        const span = to.frame - from.frame;
        // RAW is returned alongside the eased value so a caller can re-shape individual properties
        // from the same progress. `t` stays the keyframe's own curve, so every existing caller is
        // unchanged and per-property easing is something a caller opts into.
        const raw = (frame - from.frame) / span;
        return { from, to, t: easingAt(from.easing, raw), raw };
    }
    return null;
}

/**
 * The document as it stands at `frame` — an ORDINARY document, derived.
 *
 * Nodes without a track are passed through untouched, and a document with no animated node at all
 * is returned by reference. That is not only a saving: `resolveScene` runs on every derivation, so
 * a document that is not animated must cost exactly what it did before this module existed.
 */
export function applyFrame(doc: ReadonlyDocument, frame: number | undefined): ReadonlyDocument {
    if (!Number.isFinite(frame)) return doc;
    const f = Math.round(frame as number);

    let any = false;
    doc.nodes.forEach(n => {
        if (n.track && n.track.length > 0) any = true;
        if (n.channels && Object.keys(n.channels).length > 0) any = true;
    });
    if (!any) return doc;

    const nodes = new Map<string, Node>();
    doc.nodes.forEach((n, id) => {
        const track = n.track;
        const at = track && track.length > 0 ? keyframesAt(track, f) : null;
        if (!at) { nodes.set(id, applyChannels(n as Node, n as Node, id, f)); return; }
        // `materializeNode` is the ONE place a node and a statement of differences are combined,
        // so a keyframe lands exactly as a state and an override do — same field rules, same
        // layout exclusivity. `isRoot: false`: the node keeps its own position and constraints.
        const value = (k: Keyframe): Node => {
            const built = materializeNode(n as Node, k.values, false, id, n.parent ?? null);
            built.children = [...n.children];       // materializeNode empties children
            return built;
        };
        const from = value(at.from);
        // PER-PROPERTY curves (schema 45): a path named in `easings` is re-eased from the RAW
        // progress; everything else takes the keyframe's own `t`. Built once per node rather than
        // per property, and skipped entirely when no keyframe names one — which is every document
        // authored before this existed.
        const easings = at.from.easings;
        const easeFor: EaseFor | undefined = easings
            ? (path: string) => (easings[path] !== undefined ? easingAt(easings[path], at.raw) : at.t)
            : undefined;
        const posed = at.to ? withChildren(blendNode(from, value(at.to), at.t, easeFor), n.children) : from;
        // CHANNELS LAST (schema 47): the more specific statement wins. A property named by both the
        // track and a channel takes the channel's, which is the order that makes a channel worth
        // adding — and it is why a document with none behaves exactly as it did before they existed.
        nodes.set(id, applyChannels(posed, n as Node, id, f));
    });

    return {
        version: doc.version,
        metadata: doc.metadata as ProjectDocument["metadata"],
        nodes,
        rootNodeUuids: [...doc.rootNodeUuids],
        variables: doc.variables as ProjectDocument["variables"],
        activeTheme: doc.activeTheme,
        activeState: doc.activeState,
        timeline: doc.timeline,
        // NO frame. The derived document has already been placed in time, and `resolveScene` runs
        // `applyFrame` again on whatever it is given — naming the frame here would re-apply the
        // track to a document that is already at it. That is the same trap `blendStates` fell into
        // with `activeState`, where a 2-second transition landed on its end state in one frame.
        frame: undefined
    } as ProjectDocument;
}

/**
 * Each channel's own value at this frame, written over whatever the track produced.
 *
 * THE BLENDING IS NOT RE-IMPLEMENTED. A channel's two keyframes are materialized onto the ORIGINAL
 * node and run through the same `blendNode` the track uses, and only the one path the channel owns
 * is taken from the result. Interpolation rules for numbers, angles and colours therefore live in
 * exactly one place, and a channel cannot come to disagree with a track about what halfway means.
 *
 * Materialized onto the ORIGINAL rather than onto the posed node because a channel states what its
 * property is at a frame, absolutely, not relative to whatever the track had already done to it.
 * Being precise about the strength of that claim: with the validator guaranteeing each keyframe
 * names exactly its own path, the two are EQUIVALENT today — the blended value of that path
 * depends only on the two keyframes, so the base cannot change it, and a mutation swapping them
 * survives the suite. It is written this way because it is the clearer statement of intent, not
 * because a defect follows from the other.
 */
function applyChannels(posed: Node, original: Node, id: string, frame: number): Node {
    const channels = original.channels;
    if (!channels) return posed;
    let out = posed;
    for (const [path, track] of Object.entries(channels) as [string, Keyframe[]][]) {
        if (!track || track.length === 0) continue;
        const at = keyframesAt(track, frame);
        if (!at) continue;
        const build = (k: Keyframe): Node => materializeNode(original, k.values, false, id, original.parent ?? null);
        const from = build(at.from);
        const easings = at.from.easings;
        const easeFor: EaseFor | undefined = easings
            ? (p: string) => (easings[p] !== undefined ? easingAt(easings[p], at.raw) : at.t)
            : undefined;
        const solved = at.to ? blendNode(from, build(at.to), at.t, easeFor) : from;
        // COPIED ON WRITE, and only on the first channel that changes something: an untouched node
        // must stay the same object, because `computeGeometry` reuses by reference and a fresh
        // object every frame would defeat the dirty tracking the whole engine leans on.
        if (out === posed) out = { ...posed } as Node;
        copyPath(out, solved, path);
    }
    return out;
}

/** Move one `group.field` from a solved node onto the node being built. */
function copyPath(target: Node, source: Node, path: string): void {
    const dot = path.indexOf(".");
    const group = path.slice(0, dot), field = path.slice(dot + 1);
    const src = (source as unknown as Record<string, Record<string, unknown> | undefined>)[group];
    if (!src || src[field] === undefined) return;
    const t = target as unknown as Record<string, Record<string, unknown> | undefined>;
    // The GROUP is cloned before it is written into. `posed` was shallow-copied above, so its
    // `geometry` and `transform` are still the very objects the stored node holds — writing
    // straight into one would edit the document from a function that only derives from it.
    t[group] = { ...(t[group] ?? {}), [field]: src[field] };
}

/** `blendNode` builds from the TO side, which has no children of its own here. */
function withChildren(node: Node, children: readonly string[]): Node {
    node.children = [...children];
    return node;
}

/**
 * The frames an onion skin should show around `frame` — earlier and later, clamped to the timeline.
 *
 * Pure and separate from any drawing, because "which frames" is a decision and "draw them faintly"
 * is plumbing. The current frame is never among them: it is drawn normally, and a ghost of it
 * would only darken it.
 */
export function onionFrames(frame: number, before: number, after: number, frames: number): number[] {
    const out: number[] = [];
    for (let i = Math.max(0, frame - before); i < frame; i++) out.push(i);
    for (let i = frame + 1; i <= Math.min(frames - 1, frame + after); i++) out.push(i);
    return out;
}
