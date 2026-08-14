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
 * SURFACE FRICTION IS THE GROUND'S, NOT THE BODY'S, and the corpus is what settles that. `friction`
 * is the second most-declared property in the tree (45 of 138) and **44 of the 45 sit on STATIC
 * bodies** — it describes what you are standing on. Its values are 1 and "1.00" forty-four times and
 * 0.45 once, on the block a player pushes. It is applied as COULOMB friction, `a = mu * g`, which is
 * why this brought no new constant with it: the gravity already here supplies the g. A default of 1
 * for a surface that says nothing means a body walking at 220 px/s slides 27px over a quarter second
 * before stopping; 0 is ice and never stops.
 *
 * `floating` IS MEASURED AND NOT IMPLEMENTED, deliberately. It is the third most-declared property
 * (24) and every single one of its 24 objects is STATIC — a body that never moves cannot be exempted
 * from a gravity that never touches it. Whatever sticker-knight means by it is not something this
 * data can tell us, and a guess dressed as a feature is worse than the gap. The same goes for
 * `density`, which one object in the whole tree declares.
 *
 * A REGION IS A CLASSED NODE THAT IS NOT A BODY, and the corpus divides itself that way with no
 * overlap at all: **26 objects carry a class and no `bodyType`** — coin, spikes, exit, Trigger,
 * Location, NPC, Sign — while **51 carry a `bodyType` and no class**, and those are the collision
 * geometry. Not one object in the tree carries both. So the split is the data's own, not a rule
 * imposed on it, and `Node.className` is the second field this module has found shipping validated,
 * round-tripping and read by nothing.
 *
 * THE WORLD REPORTS, IT DOES NOT ACT. An overlap becomes an `enter`/`leave` event naming the region
 * and its class, and that is the whole of it: nothing here spawns a maggot, runs
 * `chest-discovered.lua` or loads `sandbox2.json`. Each of those is a separate decision about what
 * an app does with an event, and each wants its own design — the events are the seam that lets them
 * be designed at all, and building any of them into the physics would weld the two together.
 *
 * EVERYTHING HERE IS IN WORLD SPACE, and getting that wrong was a live defect rather than a
 * hypothetical. A node's `geometry` is stated in its PARENT's space, and this module read it as
 * though it were the world's — so a floor stored at (10, 200) inside a frame at (100, 50) really
 * sits at (110, 250) and was collided against at (10, 200). A body dropped over that floor's ART
 * landed on a phantom fifty pixels above it. It is not an exotic case either: the Tiled importer
 * puts every object of an object layer INSIDE a frame, which is exactly how the corpus's own
 * collision geometry arrives.
 *
 * SO ANCESTOR TRANSLATIONS ARE COMPOSED, by walking the parent chain and summing. That is exact for
 * the case that actually occurs — a frame is a position — and it costs a short walk rather than a
 * second geometry derivation, which this module cannot afford per step and could not order
 * correctly anyway (the world moves before geometry is computed, not after).
 *
 * A NODE UNDER A ROTATION, A SCALE OR A LAYOUT CONTAINER IS REFUSED, not approximated. Offsets
 * cannot be summed through a rotation, and inside an auto-layout container a stored x/y is dead
 * data the layout overwrites — so such a node is not a body, a solid or a region at all, and
 * `runtimeExclusions` says which and why rather than leaving it to be discovered. Half-composing
 * would put the art in one place and its collision in another, which is the defect this replaced.
 *
 * WHAT THIS SLICE DELIBERATELY IS NOT: no rotation, no restitution (the property does not exist in
 * the corpus at all —
 * said out loud rather than half-applied), no joints, no triggers, no spawning, no slopes and no
 * one-way platforms. Axis-aligned boxes, gravity, and stopping on solid ground. The
 * corpus's other property names (`spawncount`, `spawntype`, `script`, `triggering`, `map`) are what
 * the next slices are for, and each wants its own design against real content.
 */

import { ReadonlyDocument, ProjectDocument } from "../document/Document";
import { Node, UserData } from "../document/Node";
import { ReadonlyTilemap, TILE_EMPTY, tileAt, visibleCells } from "../document/Tilemap";
import { Tileset, findTileset, tilesetTile } from "../document/Tileset";

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

/**
 * The fastest a body may fall, and it is not a feel decision — it is the tunnelling bound.
 *
 * Collision here is discrete, so a body passes through any solid thinner than the distance it
 * covers in one step. Uncapped, a long fall makes that distance unbounded and the rule becomes
 * "thick enough for how far it fell". Capped at 1200 px/s the travel is at most 20px a step, so
 * ANY SOLID 20px OR DEEPER IS SAFE, full stop — and every solid in the measured corpus is 32px and
 * up. A terminal velocity is also what a falling body does, so the honest bound and the expected
 * behaviour are the same change.
 */
export const MAX_FALL_SPEED = 1200;

/** How fast a controlled body walks, and how high it jumps — see `jumpSpeedFor`. */
export const MOVE_SPEED = 220;
export const JUMP_HEIGHT = 72;

/**
 * The upward speed that reaches exactly `height` under `gravity` — `v = sqrt(2*g*h)`.
 *
 * STATED AS A HEIGHT rather than as a speed, because a height is the thing a level is built from:
 * a jump that clears a three-tile wall is a sentence about the art, and 360 px/s is not. It also
 * means changing gravity keeps the jump clearing the same wall.
 */
export function jumpSpeedFor(height = JUMP_HEIGHT, gravity = DEFAULT_GRAVITY): number {
    return Math.sqrt(2 * gravity * Math.max(0, height));
}

/**
 * What the player is holding down. Three booleans, and deliberately not a key map: this module
 * knows about intent, and which physical key means "jump" is the app's business.
 */
export interface Input {
    left: boolean;
    right: boolean;
    jump: boolean;
}

/** Nothing held — the input a run starts with and the one a test uses when it means "no input". */
export const NO_INPUT: Input = { left: false, right: false, jump: false };

/** What a body is doing right now. Pixels and pixels-per-second, in the node's own parent space. */
export interface Body {
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Whether it ended the last step resting on something solid — what a jump would ask. */
    onGround: boolean;
    /**
     * The friction of whatever it landed on, carried to the NEXT step.
     *
     * A body decelerates according to what it was standing on, which is one step behind what it is
     * standing on now — imperceptible at 60Hz, and the alternative is resolving the vertical axis
     * before the horizontal one, which is the ordering that makes a body snag on every seam.
     */
    groundFriction: number;
}

/** The run's whole mutable state. Keyed by STORED node id, never serialized. */
export interface WorldState {
    bodies: ReadonlyMap<string, Body>;
    /** Seconds since the run began, advanced only by whole steps. */
    time: number;
    /**
     * Whether jump was held at the END of the last step — which is what makes a jump an EDGE.
     *
     * Without it, holding the key fires a new jump on every step the body is grounded, so a
     * character bunny-hops for as long as you lean on the button. The state has to live here rather
     * than in the app because the app produces ONE input per frame while the world may take several
     * steps from it, and the second step must already know the first consumed the press.
     */
    jumpWas: boolean;
    /**
     * Which (body, region) pairs were overlapping at the END of the last step.
     *
     * KEPT SO THAT ENTER AND LEAVE CAN BE DIFFED. An overlap on its own is a state; a game wants
     * the EDGE — a coin is collected once, not on every one of the sixty frames the player spends
     * inside it. Keyed `bodyId \u0000 nodeId`, because a NUL cannot occur in either.
     */
    overlaps: ReadonlySet<string>;
    /** What the step that produced this world noticed. Empty on most steps, by design. */
    events: readonly WorldEvent[];
}

/** The key for one (body, region) pair. A NUL separator cannot collide with any node id. */
function pairKey(bodyId: string, nodeId: string): string {
    return bodyId + "\u0000" + nodeId;
}

/** An axis-aligned box in world units — what a solid is, for this slice. */
export interface Solid {
    x: number;
    y: number;
    width: number;
    height: number;
    /**
     * The Coulomb coefficient of whatever a body stands on: 0 is ice, 1 decelerates it at exactly
     * one gravity.
     *
     * DEFAULTS TO 1, which is the measured value rather than a neutral one — 44 of the corpus's 45
     * `friction` values are 1 or "1.00", and the one that is not is 0.45, on the block a player
     * pushes.
     */
    friction: number;
}

/** A volume a body can be inside — a coin, a trigger, the mouth of an exit. */
export interface Region {
    nodeId: string;
    /** The node's `className`, carried straight through: this module does not interpret it. */
    className: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A body crossed a region's edge. Produced by the step that noticed, consumed by the app. */
export interface WorldEvent {
    kind: "enter" | "leave";
    bodyId: string;
    nodeId: string;
    className: string;
}

/** A surface's `friction`, read leniently and clamped — 0 is ice, 1 stops a body dead. */
export function frictionOf(node: { userData?: UserData }): number {
    const raw = propertyOf(node.userData, "friction");
    if (raw === null) return 1;
    const text = raw.trim();
    // AN EMPTY VALUE IS ABSENT, NOT ZERO. `Number("")` is 0 and finite, so the check below waves it
    // through as ice — and the corpus really does hold a property with an empty value. The comment
    // beside this warned about exactly that and the first version of the code did it anyway.
    if (text === "") return 1;
    const n = Number(text);
    // "1.00" IS 1 AND "" IS NOTHING. The corpus writes both `1` and `1.00` for the same idea and
    // one property with an empty value; a reader that took `Number("")` as 0 would turn a surface
    // that meant "grippy" into ice.
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0, n));
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
        const at = worldOffsetOf(doc, node.id);
        if (!at) continue;                        // refused, and `runtimeExclusions` says why
        bodies.set(node.id, {
            x: node.geometry.x + at.dx, y: node.geometry.y + at.dy,
            vx: 0, vy: 0, onGround: false, groundFriction: 1
        });
    }
    return { bodies, time: 0, jumpWas: false, overlaps: new Set(), events: [] };
}

/** Every static body's box, read from the document each step so a level edit is picked up. */
export function solidsOf(doc: ReadonlyDocument): Solid[] {
    const out: Solid[] = [];
    for (const node of doc.nodes.values()) {
        if (bodyTypeOf(node) !== "static") continue;
        const at = worldOffsetOf(doc, node.id);
        if (!at) continue;
        const g = { x: node.geometry.x + at.dx, y: node.geometry.y + at.dy,
            width: node.geometry.width, height: node.geometry.height };
        // A ZERO-AREA SOLID IS NOT A FLOOR. The corpus has none, but an author dragging a new box
        // out passes through 0x0 on the way, and a zero-height solid would catch a falling body on
        // an infinitely thin line — which reads as a bug in the physics rather than in the level.
        if (g.width <= 0 || g.height <= 0) continue;
        out.push({ x: g.x, y: g.y, width: g.width, height: g.height, friction: frictionOf(node) });
    }
    return out;
}

/**
 * Is the tile at this INDEX solid — asked of the tileset, once per distinct tile rather than per cell.
 *
 * `TilesetTile.userData` has existed since schema 67, validates by the same `userDataError` a node's
 * does, round-trips through import and export, and is read by NOTHING — not even the exporter. This
 * is its first reader. The vocabulary is the one a node body already uses (`bodyType=static`) rather
 * than a second word for one idea, and the corpus offers no convention to follow: it holds exactly
 * THREE per-tile properties in 1,235 tiles (`door` and `pickup`, in `perspective_walls.tsx`) and not
 * one per-tile collision shape.
 */
export function tileIsSolid(set: Tileset | null, index: number): boolean {
    if (!set || index === TILE_EMPTY) return false;
    const tile = tilesetTile(set, index);
    return tile !== null && bodyTypeOf(tile) === "static";
}

/**
 * The solid CELLS of one tilemap that a box could touch — the broadphase, and the reason this is
 * not just `solidsOf` with more entries.
 *
 * A LEVEL IS ONE NODE HOLDING TEN THOUSAND CELLS. Emitting a `Solid` per solid cell would build an
 * array of thousands every step and test a body against all of them; asking which CELLS THE BOX
 * OVERLAPS turns that into the four or six a body can actually touch, and it is the same
 * `visibleCells` arithmetic the renderer culls with — one statement of "which cells does this
 * rectangle cover", not two.
 *
 * THE BOX ARRIVES IN WORLD UNITS and the grid is in the node's own, so it is shifted onto the grid's
 * WORLD origin on the way in and the cells are shifted back on the way out. That origin composes the
 * node's ancestors (`worldOffsetOf`) rather than reading `geometry` alone — this paragraph used to
 * say a nested level "is NOT handled and must not be pretended about", which was true and also an
 * understatement: it was not a transformed-parent edge case but an ordinary frame, and the Tiled
 * importer puts every object layer inside one. A level under a ROTATED or SCALED ancestor is still
 * refused, and now says so through `runtimeExclusions` instead of colliding somewhere else.
 */
export function tileSolidsNear(
    doc: ReadonlyDocument, box: { x: number; y: number; width: number; height: number }
): Solid[] {
    const out: Solid[] = [];
    for (const node of doc.nodes.values()) {
        const map = node.tilemap as ReadonlyTilemap | undefined;
        if (node.type !== "core.tilemap" || !map) continue;
        const set = findTileset(doc.tilesets, map.tilesetId) as Tileset | null;
        // NO SET, NO SOLIDS — a dangling id draws nothing and must collide with nothing, or a level
        // whose tileset was deleted becomes an invisible wall.
        if (!set || set.tiles.length === 0) continue;
        const at = worldOffsetOf(doc, node.id);
        if (!at) continue;
        const originX = node.geometry.x + at.dx, originY = node.geometry.y + at.dy;
        const local = { x: box.x - originX, y: box.y - originY,
            width: box.width, height: box.height };
        const range = visibleCells(map, local);
        if (!range) continue;
        for (let row = range.row0; row <= range.row1; row++) {
            for (let col = range.col0; col <= range.col1; col++) {
                if (!tileIsSolid(set, tileAt(map, col, row))) continue;
                // THE TILE'S OWN FRICTION, falling back to the LAYER's — a level made of tiles has
                // one surface per cell, and a per-cell answer is the only one that can describe an
                // icy patch. The corpus declares none, so the fallback is what it actually gets.
                const tile = tilesetTile(set, tileAt(map, col, row));
                out.push({
                    x: originX + col * map.tileWidth,
                    y: originY + row * map.tileHeight,
                    width: map.tileWidth, height: map.tileHeight,
                    friction: tile && propertyOf(tile.userData, "friction") !== null
                        ? frictionOf(tile) : frictionOf(node)
                });
            }
        }
    }
    return out;
}

/** Why a node cannot take part in the runtime, or null when it can. */
export function runtimeRefusal(doc: ReadonlyDocument, nodeId: string): string | null {
    let at = doc.nodes.get(nodeId)?.parent ?? null;
    let guard = 0;
    while (at !== null) {
        // A CYCLE CANNOT HANG THE RUNTIME. `Integrity` refuses one at rest, but a document is edited
        // between loads and this runs sixty times a second — the same reasoning `traverseSceneGraph`
        // uses for its own cycle guard.
        if (++guard > 64) return "sits deeper than 64 parents, or in a cycle";
        const parent = doc.nodes.get(at);
        if (!parent) return `names a parent (${at}) that is not in the document`;
        const t = parent.transform;
        if (t && ((t.rotation ?? 0) !== 0 || (t.scaleX ?? 1) !== 1 || (t.scaleY ?? 1) !== 1)) {
            return `is inside "${parent.name ?? parent.id}", which is rotated or scaled`;
        }
        if (parent.layout && (parent.layout.container || parent.layout.grid)) {
            return `is inside "${parent.name ?? parent.id}", an auto-layout container whose children have no stored position`;
        }
        at = parent.parent ?? null;
    }
    return null;
}

/**
 * How far a node's parent space is from the world's — the sum of its ancestors' positions.
 *
 * NULL WHEN IT CANNOT BE SUMMED, which is what `runtimeRefusal` explains. Everything the runtime
 * reads goes through this, and everything it writes goes back through it, so the two directions
 * cannot drift apart.
 */
export function worldOffsetOf(doc: ReadonlyDocument, nodeId: string): { dx: number; dy: number } | null {
    if (runtimeRefusal(doc, nodeId) !== null) return null;
    let dx = 0, dy = 0;
    let at = doc.nodes.get(nodeId)?.parent ?? null;
    while (at !== null) {
        const parent = doc.nodes.get(at);
        if (!parent) return null;
        dx += parent.geometry.x;
        dy += parent.geometry.y;
        at = parent.parent ?? null;
    }
    return { dx, dy };
}

/** Every node the runtime had to leave out, and why — counted rather than silently dropped. */
export function runtimeExclusions(doc: ReadonlyDocument): { nodeId: string; why: string }[] {
    const out: { nodeId: string; why: string }[] = [];
    for (const node of doc.nodes.values()) {
        const isBody = bodyTypeOf(node) !== null;
        const isRegion = !!node.className && !isBody;
        if (!isBody && !isRegion && node.type !== "core.tilemap") continue;
        const why = runtimeRefusal(doc, node.id);
        if (why) out.push({ nodeId: node.id, why: `"${node.name ?? node.id}" ${why}` });
    }
    return out;
}

/**
 * Every region in the document, in document order so the events are deterministic.
 *
 * A NODE WITH A CLASS AND NO BODY TYPE. The corpus is unambiguous about that split — 26 with a class
 * and no body, 51 with a body and no class, none with both — so this reads the data rather than
 * imposing a convention on it.
 *
 * A ZERO-AREA REGION IS SKIPPED, and the corpus has one that matters: `player-start` is a POINT with
 * no width or height at all. A point is somewhere to PUT something, not a volume to be inside, and
 * pretending otherwise would give it an overlap that can never be entered or left.
 */
export function regionsOf(doc: ReadonlyDocument): Region[] {
    const out: Region[] = [];
    for (const node of doc.nodes.values()) {
        const className = node.className;
        if (!className || bodyTypeOf(node) !== null) continue;
        const g = node.geometry;
        if (g.width <= 0 || g.height <= 0) continue;
        const at = worldOffsetOf(doc, node.id);
        if (!at) continue;
        out.push({ nodeId: node.id, className, x: g.x + at.dx, y: g.y + at.dy,
            width: g.width, height: g.height });
    }
    return out;
}

/** Do two boxes overlap? Touching edges do NOT count, or a body resting on a floor is inside it. */
function overlaps(ax: number, ay: number, aw: number, ah: number, b: Solid): boolean {
    return ax < b.x + b.width && ax + aw > b.x && ay < b.y + b.height && ay + ah > b.y;
}

/** The same test against a REGION. Two boxes, one rule — separate only because the types differ. */
function overlaps2(ax: number, ay: number, aw: number, ah: number, b: Region): boolean {
    return ax < b.x + b.width && ax + aw > b.x && ay < b.y + b.height && ay + ah > b.y;
}

/** Does ANY tileset mark a tile solid? One pass over the sets, never over the cells. */
export function documentHasSolidTiles(doc: ReadonlyDocument): boolean {
    for (const set of doc.tilesets ?? []) {
        for (const tile of set.tiles) {
            if (bodyTypeOf(tile) === "static") return true;
        }
    }
    return false;
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
    opts?: { gravity?: number; solids?: readonly Solid[]; input?: Input;
             controlled?: string | null; tileSolids?: boolean; regions?: readonly Region[] }
): WorldState {
    const gravity = opts?.gravity ?? DEFAULT_GRAVITY;
    const solids = opts?.solids ?? solidsOf(doc);
    const input = opts?.input ?? NO_INPUT;
    const controlled = opts?.controlled ?? null;
    // ASKED ONCE PER STEP, NOT PER BODY PER AXIS: whether ANY tileset in the document marks a tile
    // solid. Most documents do not — a design file has no tilemap at all — and the check is what
    // keeps them paying nothing for a feature they never asked for.
    const tiles = opts?.tileSolids ?? documentHasSolidTiles(doc);
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

        // THE CONTROLLED BODY, and only it. Which node that is comes from the caller: nothing in
        // the measured corpus says "this one is the player" — 216 of 248 objects carry no class at
        // all — so inventing a property for it would be designing ahead of any content. The app
        // passes the node that was SELECTED when Play was pressed, which is how a level gets
        // tested; a real convention can replace that the day real content declares one.
        // FRICTION FIRST, so a held key overrides it rather than fighting it. A body only loses
        // speed to a surface it is actually ON: in the air it keeps what it has, which is what air
        // control means and why a jump carries you forward.
        //
        // COULOMB, WHICH IS WHY THERE IS NO NEW CONSTANT HERE. Friction opposes motion with a force
        // proportional to the normal one — on flat ground that is `mu * m * g`, so the deceleration
        // is `mu * g` and the gravity this module already has supplies the g. The first version of
        // this multiplied the speed by `1 - mu` each step, which reads well and is wrong twice:
        // mu = 1 stopped a body inside one 16ms step, and since 44 of the corpus's 45 surfaces say
        // exactly 1, every surface in the tree would have been instant-stop and the one 0.45 would
        // have meant nothing. At mu = 1 a body walking at 220 px/s now slides 27px over a quarter
        // second, and at 0 it never stops.
        if (was.onGround && was.groundFriction > 0 && vx !== 0) {
            const drop = was.groundFriction * gravity * FIXED_STEP;
            // NEVER PAST ZERO: a deceleration that overshoots would push the body backwards, which
            // is friction turning into a spring.
            vx = vx > 0 ? Math.max(0, vx - drop) : Math.min(0, vx + drop);
        }

        if (id === controlled) {
            // SET WHILE HELD, AND ONLY WHILE HELD. Adding an acceleration each step gives ice; a
            // platformer's walk is a speed you have while the key is down. But letting go must not
            // SET it to zero — that was the first version, and it made friction meaningless for the
            // one body a player actually controls: no slide on ice, and no air control, because
            // releasing mid-jump killed the flight. Releasing now hands the body back to the
            // surface, which is what friction is for.
            const held = (input.left ? -MOVE_SPEED : 0) + (input.right ? MOVE_SPEED : 0);
            if (held !== 0) vx = held;
            // A JUMP IS AN EDGE, not a state: it fires on the step the key GOES DOWN while the
            // body is on the ground. Holding it must not bunny-hop, and `jumpWas` is what
            // remembers the press across the several steps one frame may take.
            if (input.jump && !world.jumpWas && was.onGround) vy = -jumpSpeedFor(JUMP_HEIGHT, gravity);
        }

        // TERMINAL VELOCITY, which is a collision bound before it is a feel decision — see
        // `MAX_FALL_SPEED`. Capped downward only: a jump's rise is bounded by gravity already.
        if (vy > MAX_FALL_SPEED) vy = MAX_FALL_SPEED;

        // HORIZONTAL, then resolve — against the node solids AND the solid cells the box can
        // reach. Asked PER AXIS AND PER MOVE, because the box has just moved and the cells it can
        // touch have moved with it; asking once for the step would test yesterday's neighbourhood.
        x += vx * FIXED_STEP;
        const acrossTiles = tiles ? tileSolidsNear(doc, { x, y, width: w, height: h }) : [];
        for (const s of [...solids, ...acrossTiles]) {
            if (!overlaps(x, y, w, h, s)) continue;
            x = vx > 0 ? s.x - w : s.x + s.width;
            vx = 0;
        }

        // VERTICAL, then resolve — and this is where `onGround` is decided.
        let onGround = false;
        let groundFriction = was.groundFriction;
        y += vy * FIXED_STEP;
        const underTiles = tiles ? tileSolidsNear(doc, { x, y, width: w, height: h }) : [];
        for (const s of [...solids, ...underTiles]) {
            if (!overlaps(x, y, w, h, s)) continue;
            if (vy > 0) { y = s.y - h; onGround = true; groundFriction = s.friction; }
            else { y = s.y + s.height; }
            vy = 0;
        }

        next.set(id, { x, y, vx, vy, onGround, groundFriction });
    }

    // OVERLAPS ARE COMPUTED AFTER EVERYTHING HAS MOVED, once, on the settled positions — asking
    // mid-resolution would report a body inside a wall it is about to be pushed out of.
    const regions = opts?.regions ?? regionsOf(doc);
    // NOT `overlaps` — that is the box test used a dozen lines up, and shadowing it inside the same
    // function turns every collision check into a call on a Set.
    const inside = new Set<string>();
    const events: WorldEvent[] = [];
    for (const [id, body] of next) {
        const node = doc.nodes.get(id);
        if (!node) continue;
        const w = node.geometry.width, h = node.geometry.height;
        for (const r of regions) {
            if (!overlaps2(body.x, body.y, w, h, r)) continue;
            const key = pairKey(id, r.nodeId);
            inside.add(key);
            if (!world.overlaps.has(key)) {
                events.push({ kind: "enter", bodyId: id, nodeId: r.nodeId, className: r.className });
            }
        }
    }
    // LEAVING IS THE OTHER HALF, and it has to survive the body or the region VANISHING: a coin that
    // is collected and deleted must still report the leave, or a game counting "how many am I
    // inside" drifts up by one every time something is removed under a player.
    for (const key of world.overlaps) {
        if (inside.has(key)) continue;
        const [bodyId, nodeId] = key.split("\u0000");
        const was = regions.find(r => r.nodeId === nodeId);
        events.push({ kind: "leave", bodyId, nodeId,
            className: was?.className ?? doc.nodes.get(nodeId)?.className ?? "" });
    }

    return { bodies: next, time: world.time + FIXED_STEP, jumpWas: input.jump, overlaps: inside, events };
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
        // BACK INTO PARENT SPACE, which is the symmetric half of reading it out. Writing a world
        // position into a nested node's `geometry` would move it by the frame's offset a second
        // time — every frame, so it would accelerate away.
        const at = worldOffsetOf(doc, id);
        if (!at) continue;
        const px = body.x - at.dx, py = body.y - at.dy;
        if (node.geometry.x === px && node.geometry.y === py) continue;
        // `as Node` for the same reason `applyFrame` needs it: a `ReadonlyDocument`'s nodes are
        // deep-readonly, and the document being BUILT is an ordinary one. The copy is new either
        // way — nothing here writes through the reference.
        if (!nodes) nodes = new Map(doc.nodes as ReadonlyMap<string, Node>);
        nodes.set(id, { ...(node as Node), geometry: { ...node.geometry, x: px, y: py } });
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
        const at = worldOffsetOf(doc, id);
        if (!at) continue;
        if (node.geometry.x !== body.x - at.dx || node.geometry.y !== body.y - at.dy) out.add(id);
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
