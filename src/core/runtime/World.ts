/**
 * @module World
 * @description The runtime's mutable half — bodies that move, stepped at a fixed rate (M18 slice 1).
 *
 * VDE derives everything it draws from one immutable document. A game does not: a falling crate has
 * a velocity, and a velocity is a fact about *this run* rather than about the file. So this module
 * holds the part that changes and keeps the document exactly as it was — the same bargain
 * `EditorState` already strikes for selection ("Runtime editor context. Never serialized").
 *
 * THE SEAM IS THE ONE `applyFrame` ALREADY USES. `applyFrame(doc, frame)` takes the document and a
 * moment and hands back a NEW document showing that moment; every consumer downstream — layout,
 * picking, culling, three backends, the exporter — reads it without knowing time exists. `applyWorld`
 * is the same move for a different question: take the document and a world, hand back the document
 * with the bodies where they now are. Nothing downstream learns that a runtime exists.
 *
 * WHAT A BODY IS, AND WHY IT IS `userData.bodyType`. Measured over every `.tmx` in the tree: 248
 * objects, of which only 24 carry a class at all — and the level's actual collision geometry carries
 * NONE. It is six untyped rectangles on a layer named `bounds` with `visible="0"`, and the only
 * thing they say about themselves is `bodyType=static`. `bodyType` is also the single most-declared
 * property in the corpus (51 of 138). So the runtime reads the field the art already uses rather
 * than a `core.entity` invented ahead of any content — and `Node.userData` was already carried,
 * already round-tripping through import and export, and read by NOTHING until now.
 *
 * VALUES ARE READ LENIENTLY, and that is measured too rather than defensive. The same property name
 * is declared with two different types inside one map: `friction` is `type="float"` 17 times and
 * untyped (so, a string) 28 times; `floating` is `type="bool"` 6 times and a string 18 times. A
 * reader that demanded the declared type would drop more than half of the real data.
 *
 * A FIXED TIMESTEP, NOT A FRAME DELTA. `stepWorld` advances exactly `FIXED_STEP` seconds, and the
 * caller runs it as many times as the wall clock earned. Integrating a variable delta makes a jump
 * height depend on the frame rate, which is the classic way a game plays differently on a fast
 * machine; it also makes a replay impossible, and this engine's whole character is that the same
 * inputs give the same output. The accumulator lives with the caller because the clock does.
 *
 * COLLISION IS DISCRETE, AND IT TUNNELS — measured, not suspected. A body moves, then overlaps are
 * resolved; nothing sweeps the path between. So a solid THINNER than the distance a body covers in
 * one step is passed straight through: a 2px floor at y=800 lets a body reach y=11,287 having never
 * touched it. THE RULE THAT FOLLOWS: a solid must be at least as deep as the fastest body's travel
 * per step, which at the default gravity is 15px after one second of falling and 20px after two.
 * Every solid in the measured corpus is far thicker than that — the `bounds` rectangles are 32px
 * and up — so the corpus is safe and a hand-drawn hairline floor is not. Sweeping is what a later
 * slice buys; a test pins the failure so it is a known shape rather than a surprise.
 *
 * WHAT THIS SLICE DELIBERATELY IS NOT: no rotation, no friction (the property is read and ignored —
 * said out loud rather than half-applied), no restitution, no per-tile collision, no broadphase, no
 * joints, no triggers, no spawning. Axis-aligned boxes, gravity, and stopping on solid ground. The
 * corpus's other property names (`spawncount`, `spawntype`, `script`, `triggering`, `map`) are what
 * the next slices are for, and each wants its own design against real content.
 */

import { ReadonlyDocument, ProjectDocument } from "../document/Document";
import { Node, UserData } from "../document/Node";

/** One tick, in seconds. 60Hz: the rate every measurement in this module's tests assumes. */
export const FIXED_STEP = 1 / 60;

/**
 * How many steps one wall-clock gap may spend, so a slow frame cannot spiral.
 *
 * If a tab is backgrounded for ten seconds the accumulator would otherwise ask for 600 steps at
 * once, each of which costs a derivation — the frame that resumes would hang for a second and earn
 * itself an even bigger gap next time. Capping DROPS time instead: the world runs slow for one
 * frame rather than freezing the app, which is what every engine does under the name "spiral of
 * death".
 */
export const MAX_STEPS_PER_FRAME = 5;

/** Pixels per second per second. Positive is DOWN, because y grows downward on this canvas. */
export const DEFAULT_GRAVITY = 900;

/** What a body is doing right now. Pixels and pixels-per-second, in the node's own parent space. */
export interface Body {
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Whether it ended the last step resting on something solid — what a jump would ask. */
    onGround: boolean;
}

/** The run's whole mutable state. Keyed by STORED node id, never serialized. */
export interface WorldState {
    bodies: ReadonlyMap<string, Body>;
    /** Seconds since the run began, advanced only by whole steps. */
    time: number;
}

/** An axis-aligned box in world units — what a solid is, for this slice. */
export interface Solid {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * One property, read the way the corpus actually writes it.
 *
 * `type="float"` and no type at all both occur for the same NAME in the same file, so the declared
 * type is not something a reader may lean on — see the module header.
 */
export function propertyOf(data: UserData | undefined, name: string): string | null {
    const entry = data?.[name];
    return entry === undefined ? null : entry.value;
}

/** `"static"`, `"dynamic"`, or null for the 216-of-248 objects that are not bodies at all. */
export function bodyTypeOf(node: { userData?: UserData }): "static" | "dynamic" | null {
    const raw = propertyOf(node.userData, "bodyType");
    if (raw === null) return null;
    const lower = raw.trim().toLowerCase();
    return lower === "static" || lower === "dynamic" ? lower : null;
}

/**
 * The world a document starts in: every DYNAMIC body at rest, where the document puts it.
 *
 * STATIC BODIES ARE NOT IN HERE. They do not move, so storing a position for them would be a second
 * copy of something the document already states — and the two could disagree the moment somebody
 * edits the level. They are read fresh from the document every step, by `solidsOf`.
 */
export function worldFrom(doc: ReadonlyDocument): WorldState {
    const bodies = new Map<string, Body>();
    for (const node of doc.nodes.values()) {
        if (bodyTypeOf(node) !== "dynamic") continue;
        bodies.set(node.id, {
            x: node.geometry.x, y: node.geometry.y, vx: 0, vy: 0, onGround: false
        });
    }
    return { bodies, time: 0 };
}

/** Every static body's box, read from the document each step so a level edit is picked up. */
export function solidsOf(doc: ReadonlyDocument): Solid[] {
    const out: Solid[] = [];
    for (const node of doc.nodes.values()) {
        if (bodyTypeOf(node) !== "static") continue;
        const g = node.geometry;
        // A ZERO-AREA SOLID IS NOT A FLOOR. The corpus has none, but an author dragging a new box
        // out passes through 0x0 on the way, and a zero-height solid would catch a falling body on
        // an infinitely thin line — which reads as a bug in the physics rather than in the level.
        if (g.width <= 0 || g.height <= 0) continue;
        out.push({ x: g.x, y: g.y, width: g.width, height: g.height });
    }
    return out;
}

/** Do two boxes overlap? Touching edges do NOT count, or a body resting on a floor is inside it. */
function overlaps(ax: number, ay: number, aw: number, ah: number, b: Solid): boolean {
    return ax < b.x + b.width && ax + aw > b.x && ay < b.y + b.height && ay + ah > b.y;
}

/**
 * The world one FIXED_STEP later — pure, and the whole of the physics in this slice.
 *
 * AXES ARE RESOLVED SEPARATELY, horizontal first. Moving both at once and then testing gives a body
 * that catches on a corner it should slide past, because a single overlap cannot say WHICH axis
 * caused it; resolving one axis at a time is the standard fix and the reason a player can run along
 * a row of floor tiles without snagging on every seam.
 *
 * A BODY'S SIZE COMES FROM THE DOCUMENT, not from the body: the runtime moves things, it does not
 * resize them, so keeping one copy of the box means an edit to the level is picked up next step.
 */
export function stepWorld(
    doc: ReadonlyDocument, world: WorldState,
    opts?: { gravity?: number; solids?: readonly Solid[] }
): WorldState {
    const gravity = opts?.gravity ?? DEFAULT_GRAVITY;
    const solids = opts?.solids ?? solidsOf(doc);
    const next = new Map<string, Body>();

    for (const [id, was] of world.bodies) {
        const node = doc.nodes.get(id);
        // A BODY WHOSE NODE HAS GONE keeps its state and stops moving, rather than throwing or
        // vanishing — the inert-reference rule this schema follows everywhere. Deleting a node
        // mid-run must not take the run down.
        if (!node) { next.set(id, { ...was }); continue; }
        const w = node.geometry.width, h = node.geometry.height;

        let vx = was.vx;
        let vy = was.vy + gravity * FIXED_STEP;
        let x = was.x, y = was.y;

        // HORIZONTAL, then resolve.
        x += vx * FIXED_STEP;
        for (const s of solids) {
            if (!overlaps(x, y, w, h, s)) continue;
            x = vx > 0 ? s.x - w : s.x + s.width;
            vx = 0;
        }

        // VERTICAL, then resolve — and this is where `onGround` is decided.
        let onGround = false;
        y += vy * FIXED_STEP;
        for (const s of solids) {
            if (!overlaps(x, y, w, h, s)) continue;
            if (vy > 0) { y = s.y - h; onGround = true; } else { y = s.y + s.height; }
            vy = 0;
        }

        next.set(id, { x, y, vx, vy, onGround });
    }

    return { bodies: next, time: world.time + FIXED_STEP };
}

/**
 * The document with its bodies where the world says they are — the `applyFrame` move.
 *
 * A NEW DOCUMENT AND A NEW MAP, never a mutation, because the stored document is what undo, save
 * and every other reader depend on. Only the nodes that MOVED are copied; the rest pass through by
 * reference, which is what lets the caller hand `computeGeometry` a dirty set naming exactly those
 * ids and reuse the geometry of everything else — measured at 3-4.6x on a 1,000-node scene.
 *
 * THE SAME DOCUMENT COMES BACK when nothing moved, so an idle run costs nothing downstream.
 */
export function applyWorld(doc: ReadonlyDocument, world: WorldState): ReadonlyDocument {
    if (world.bodies.size === 0) return doc;
    let nodes: Map<string, Node> | null = null;
    for (const [id, body] of world.bodies) {
        const node = doc.nodes.get(id);
        if (!node) continue;
        if (node.geometry.x === body.x && node.geometry.y === body.y) continue;
        // `as Node` for the same reason `applyFrame` needs it: a `ReadonlyDocument`'s nodes are
        // deep-readonly, and the document being BUILT is an ordinary one. The copy is new either
        // way — nothing here writes through the reference.
        if (!nodes) nodes = new Map(doc.nodes as ReadonlyMap<string, Node>);
        nodes.set(id, { ...(node as Node), geometry: { ...node.geometry, x: body.x, y: body.y } });
    }
    if (!nodes) return doc;
    return { ...(doc as ProjectDocument), nodes } as ReadonlyDocument;
}

/** Which ids `applyWorld` would move — the dirty set the incremental geometry path wants. */
export function movedIds(doc: ReadonlyDocument, world: WorldState): Set<string> {
    const out = new Set<string>();
    for (const [id, body] of world.bodies) {
        const node = doc.nodes.get(id);
        if (!node) continue;
        if (node.geometry.x !== body.x || node.geometry.y !== body.y) out.add(id);
    }
    return out;
}

/**
 * How many fixed steps a wall-clock gap has earned, and what is left over.
 *
 * THE REMAINDER IS CARRIED, not dropped: at 60Hz on a 59.94Hz display the leftovers accumulate into
 * a whole step every few seconds, and discarding them makes the world run measurably slow. The cap
 * is the spiral guard described on `MAX_STEPS_PER_FRAME`, and it reports what it dropped so a caller
 * can say so rather than quietly losing time.
 */
export function stepsFor(accumulator: number, elapsedSeconds: number):
    { steps: number; accumulator: number; dropped: number } {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
        return { steps: 0, accumulator, dropped: 0 };
    }
    let acc = accumulator + elapsedSeconds;
    let steps = Math.floor(acc / FIXED_STEP);
    let dropped = 0;
    if (steps > MAX_STEPS_PER_FRAME) {
        dropped = steps - MAX_STEPS_PER_FRAME;
        steps = MAX_STEPS_PER_FRAME;
        acc = 0;                                  // the dropped time is gone; do not owe it back
        return { steps, accumulator: acc, dropped };
    }
    acc -= steps * FIXED_STEP;
    return { steps, accumulator: acc, dropped };
}
