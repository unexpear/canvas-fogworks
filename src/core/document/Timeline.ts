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

import { Easing, blendNode, easingAt, easingError } from "./Prototype";
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
        const bad = valuesError(k.values);
        if (bad) return bad;
    }
    return null;
}

/**
 * The pair of keyframes a frame falls between, and how far between them it is.
 *
 * Outside the track's own range the nearest keyframe is HELD rather than extrapolated. Before the
 * first, the animation has not started and the shape sits where it was authored to start; after
 * the last, it has finished and stays. Extrapolating instead would send a shape flying off in both
 * directions from a two-keyframe track, which nobody has ever wanted.
 */
export function keyframesAt(track: readonly Keyframe[], frame: number): { from: Keyframe; to: Keyframe | null; t: number } | null {
    if (track.length === 0) return null;
    if (frame <= track[0].frame) return { from: track[0], to: null, t: 0 };
    const last = track[track.length - 1];
    if (frame >= last.frame) return { from: last, to: null, t: 0 };
    for (let i = track.length - 1; i >= 0; i--) {
        if (track[i].frame > frame) continue;
        const from = track[i], to = track[i + 1];
        // A HELD keyframe never blends toward its successor: it simply stays until replaced.
        if (from.hold) return { from, to: null, t: 0 };
        const span = to.frame - from.frame;
        return { from, to, t: easingAt(from.easing, (frame - from.frame) / span) };
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
    doc.nodes.forEach(n => { if (n.track && n.track.length > 0) any = true; });
    if (!any) return doc;

    const nodes = new Map<string, Node>();
    doc.nodes.forEach((n, id) => {
        const track = n.track;
        const at = track && track.length > 0 ? keyframesAt(track, f) : null;
        if (!at) { nodes.set(id, n as Node); return; }
        // `materializeNode` is the ONE place a node and a statement of differences are combined,
        // so a keyframe lands exactly as a state and an override do — same field rules, same
        // layout exclusivity. `isRoot: false`: the node keeps its own position and constraints.
        const value = (k: Keyframe): Node => {
            const built = materializeNode(n as Node, k.values, false, id, n.parent ?? null);
            built.children = [...n.children];       // materializeNode empties children
            return built;
        };
        const from = value(at.from);
        nodes.set(id, at.to ? withChildren(blendNode(from, value(at.to), at.t), n.children) : from);
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
