/**
 * @module Prototype
 * @description Interactions and state transitions (Milestone 7, schema 35) — what makes a
 * document a PROTOTYPE rather than a picture.
 *
 * A node carries `interactions`: a trigger (click / hover / press) and what it does. Today the
 * only thing it can do is change the document's ACTIVE STATE, because that is the mechanism that
 * already exists — named states landed at schema 30 and `applyActiveState` is a pure pass that
 * every consumer already reads through. Prototyping is therefore not a new rendering path; it is
 * a way for a pointer to move the selector that pass already honours.
 *
 * A transition (`duration` + `easing`) turns the switch into an ANIMATION. That is the first time
 * the engine has had a time dimension, and it fits the pure-derivation architecture without
 * bending it: `blendStates(doc, from, to, t)` is a PURE function of two states and a number,
 * returning an ordinary document. The running clock lives in ephemeral editor state and feeds
 * that document into the same `computeGeometry` → `buildRenderModel` pipeline as everything
 * else — an animation frame is just another frame, exactly as a drag preview is.
 */

import { ProjectDocument, ReadonlyDocument } from "./Document";
import { Node } from "./Node";

/** What can start an interaction. */
export const TRIGGERS = ["click", "hover", "press"] as const;
export type Trigger = typeof TRIGGERS[number];

/** How a transition's progress is shaped over its duration. */
export const EASINGS = ["linear", "ease-in", "ease-out", "ease-in-out"] as const;
export type Easing = typeof EASINGS[number];

/** Longest a transition may declare (ms) — a hand-editable field, so bounded like every other. */
export const TRANSITION_MAX_MS = 60_000;
/** Interactions one node may carry — the OOM guard, like `STATES_MAX`. */
export const INTERACTIONS_MAX = 64;

/**
 * One interaction: a trigger, the state it selects, and how long the change takes.
 *
 * `state: null` means "back to the base state", which is what makes hover reversible without a
 * second concept — the pointer leaving fires the same interaction with the opposite target.
 */
export interface Interaction {
    trigger: Trigger;
    /** The named state to select, or null for the base state. */
    state: string | null;
    /** Milliseconds; 0 (or absent) is an instant switch. */
    duration?: number;
    /** Absent = "linear". */
    easing?: Easing;
    /**
     * NAVIGATE to a node (schema 36): the viewport moves to fit it, which is how a prototype
     * changes SCREEN rather than merely changing what one screen looks like.
     *
     * A node id, dangling allowed — deleting a frame must not make a document unloadable, so an
     * unresolvable target simply does not navigate. An interaction may carry a target, a state,
     * or both: "go to the next screen AND light up the button you pressed" is one gesture.
     */
    target?: string;
}

/**
 * Shared validator for `Node.interactions` — the loader and the edit action run this one.
 *
 * The STATE NAME is deliberately not required to exist. A dangling reference is inert (the
 * document simply has no overrides for that name, so the base shows), which is the same rule
 * `componentId`, `$token` aliases and slot fills already follow: deleting a state must never
 * make a document unloadable.
 */
export function interactionsError(interactions: unknown): string | null {
    if (interactions === undefined) return null;
    if (!Array.isArray(interactions)) return "interactions must be an array";
    if (interactions.length > INTERACTIONS_MAX) return `interactions must have at most ${INTERACTIONS_MAX} entries`;
    for (const raw of interactions) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "each interaction must be an object";
        const i = raw as Partial<Interaction>;
        if (!(TRIGGERS as readonly unknown[]).includes(i.trigger)) return `interaction.trigger must be one of ${TRIGGERS.join(", ")}`;
        if (!(typeof i.state === "string" || i.state === null)) return "interaction.state must be a string or null";
        if (i.duration !== undefined && (typeof i.duration !== "number" || !Number.isFinite(i.duration)
            || i.duration < 0 || i.duration > TRANSITION_MAX_MS)) return `interaction.duration must be within [0, ${TRANSITION_MAX_MS}]`;
        if (i.easing !== undefined && !(EASINGS as readonly unknown[]).includes(i.easing)) return `interaction.easing must be one of ${EASINGS.join(", ")}`;
        // A DANGLING target is inert, like a dangling state name — only its shape is checked.
        if (i.target !== undefined && (typeof i.target !== "string" || i.target.length === 0)) return "interaction.target must be a non-empty string";
    }
    return null;
}

/** The FIRST interaction on a node matching a trigger, or null. */
export function interactionFor(node: { interactions?: readonly Interaction[] }, trigger: Trigger): Interaction | null {
    return node.interactions?.find(i => i.trigger === trigger) ?? null;
}

/**
 * Progress shaped by an easing curve. `t` outside [0,1] is CLAMPED rather than extrapolated: a
 * clock that overshoots its duration by a frame must land on the end state, not past it.
 */
export function easingAt(easing: Easing | undefined, t: number): number {
    const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
    switch (easing) {
        case "ease-in": return x * x;
        case "ease-out": return 1 - (1 - x) * (1 - x);
        // The standard symmetric cubic: accelerate to the midpoint, decelerate out of it.
        case "ease-in-out": return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
        default: return x;
    }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** `#rgb` / `#rrggbb` as three channels, or null for anything else (a token, a CSS name). */
function parseHex(c: string): [number, number, number] | null {
    const s = c.trim();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return null;
    const h = s.slice(1);
    const full = h.length === 3 ? h.split("").map(ch => ch + ch).join("") : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/**
 * Two colours blended, in sRGB channel space.
 *
 * Only plain hex interpolates. A `$token` reference or a CSS colour name has no channels to mix
 * without resolving it — and resolution belongs to the render model, which runs AFTER this — so
 * those SNAP at the halfway point. That is a visible, explainable behaviour rather than a
 * silently wrong colour, and it is the documented cost of blending before resolution.
 */
export function blendColor(from: string, to: string, t: number): string {
    const a = parseHex(from), b = parseHex(to);
    if (!a || !b) return t < 0.5 ? from : to;
    const ch = (i: number): string => Math.round(lerp(a[i], b[i], t)).toString(16).padStart(2, "0");
    return `#${ch(0)}${ch(1)}${ch(2)}`;
}

/** The numeric and colour fields a transition animates, blended between two versions of a node. */
/**
 * One node interpolated toward another — exported because a TIMELINE tween is the same question.
 *
 * A transition between two states and a tween between two keyframes differ only in what supplies
 * the endpoints; the arithmetic in between is identical, and two copies of it would drift the
 * first time a field learned to interpolate. See `document/Timeline`.
 */
export function blendNode(from: Node, to: Node, t: number): Node {
    const out: Node = { ...to };
    out.geometry = {
        x: lerp(from.geometry.x, to.geometry.x, t),
        y: lerp(from.geometry.y, to.geometry.y, t),
        width: lerp(from.geometry.width, to.geometry.width, t),
        height: lerp(from.geometry.height, to.geometry.height, t)
    };
    out.style = {
        ...to.style,
        opacity: lerp(from.style.opacity, to.style.opacity, t),
        fill: blendColor(from.style.fill, to.style.fill, t)
    };
    if (from.style.stroke !== undefined && to.style.stroke !== undefined) {
        out.style.stroke = blendColor(from.style.stroke, to.style.stroke, t);
    }
    // Numeric style slots interpolate only when BOTH ends are concrete: a token is a reference,
    // and averaging a reference with a number would produce neither.
    for (const key of ["radius", "strokeWidth", "fontSize", "letterSpacing", "lineHeight", "fontWeight"] as const) {
        const a = from.style[key], b = to.style[key];
        if (typeof a === "number" && typeof b === "number") out.style[key] = lerp(a, b, t);
    }
    if (from.transform || to.transform) {
        const f = from.transform ?? {}, g = to.transform ?? {};
        out.transform = {
            ...g,
            rotation: lerp(f.rotation ?? 0, g.rotation ?? 0, t),
            scaleX: lerp(f.scaleX ?? 1, g.scaleX ?? 1, t),
            scaleY: lerp(f.scaleY ?? 1, g.scaleY ?? 1, t)
        };
    }
    return out;
}

/** The same document with a different active state selected — the input to a blend. */
function atState(doc: ReadonlyDocument, state: string | null): ReadonlyDocument {
    return { ...(doc as ProjectDocument), activeState: state ?? undefined } as ProjectDocument;
}

/**
 * The document PART-WAY between two named states — the frame a transition is currently on.
 *
 * Pure, so an animation is a function of time rather than a mutation over it: the running clock
 * lives in ephemeral editor state and this is called per frame, exactly as a drag preview is
 * passed in as `pendingGeometry` rather than written to the document. At `t = 0` and `t = 1` the
 * result is the corresponding state's own document, so a finished transition is indistinguishable
 * from simply having selected that state.
 *
 * States are applied by the caller-facing `applyActiveState` on BOTH ends, so everything a state
 * can say — geometry, style, transform, layout — is already resolved before the blend; what this
 * adds is only the interpolation between them.
 */
export function blendStates(
    doc: ReadonlyDocument,
    from: string | null,
    to: string | null,
    t: number,
    applyState: (d: ReadonlyDocument) => ReadonlyDocument
): ReadonlyDocument {
    if (t <= 0) return applyState(atState(doc, from));
    if (t >= 1) return applyState(atState(doc, to));
    const a = applyState(atState(doc, from));
    const b = applyState(atState(doc, to));
    const nodes = new Map<string, Node>();
    b.nodes.forEach((node, id) => {
        const before = a.nodes.get(id);
        // A node only one side has cannot be blended against anything; it takes the TO side's
        // value, which is where the transition is going.
        nodes.set(id, before ? blendNode(before as Node, node as Node, t) : (node as Node));
    });
    return {
        version: b.version,
        metadata: b.metadata as ProjectDocument["metadata"],
        nodes,
        rootNodeUuids: [...b.rootNodeUuids],
        variables: b.variables as ProjectDocument["variables"],
        activeTheme: b.activeTheme,
        // NO active state. The blend has already baked both ends in, and every consumer resolves
        // through `resolveScene` — which calls `applyActiveState` again. Naming the target here
        // meant the interpolated geometry was immediately overwritten by the target state's own,
        // so a 2-second transition landed on its end state in the first frame. A derived document
        // must not ask to be derived twice.
        activeState: undefined
    } as ProjectDocument;
}
