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
 * ONE-WAY PLATFORMS ARE AN INVENTION, and this is the first thing in this module that is. Every
 * rule above was read from the corpus — `bodyType`, `friction`, a class without a body — and the
 * corpus's vocabulary is now spent: it declares nothing about platforms you jump up through. So
 * `bodyType=oneway` is a CHOICE, said plainly rather than dressed as a measurement, and it is a new
 * VALUE on a field that already exists rather than a new field, because a value costs nothing to a
 * reader that has never met it: `bodyTypeOf` already answers null for a word it does not know, and
 * a level written before this one existed behaves exactly as it did.
 *
 * THE RULE IS "SOLID ONLY FROM ABOVE, ONLY WHILE FALLING", and both halves matter. A body moving up
 * passes through, which is the point; a body already overlapping passes through too, so something
 * standing inside a platform falls out rather than being launched to its surface. The test is where
 * the body WAS at the start of the step, not where it is now — a body 15px above a platform is
 * below it one step later, and asking about the present would let it through.
 *
 * BODY-VS-BODY CONTACT IS THE SECOND INVENTION, AND A LARGER ONE THAN `oneway` — said here first
 * because everything below it is easier to read as a measurement than it deserves. The numbers,
 * counted across the same 97 Tiled files every other rule here was read from:
 *
 *   - ONE object in the whole corpus declares `bodyType=dynamic`, and it lives in
 *     `templates/block.tx`, which `TiledMap.ts:644` refuses to import. So ZERO dynamic bodies reach
 *     this runtime from the corpus. Not one of the 248 placed objects is dynamic.
 *   - The nearest pair of declared dynamic bodies sits 654px apart on different platform tiers.
 *     They never touch, in any map.
 *   - The vocabulary for what a contact would MEAN does not exist: damage, health, hp, bounce,
 *     restitution, stomp, kill, hurt, pushable, mass, weight, hit, attack, collide, impulse, force,
 *     kinematic, knockback, squash — 24 stems, every one of them zero across all 65 files.
 *
 * By this module's own published scale that is BELOW `density`, which was refused at one
 * declaration, and below `floating`, refused at twenty-four. So this is not `oneway`'s justification
 * wearing a bigger coat. `oneway` was a new VALUE on a field that already had a reader, leaving
 * every prior document bit-identical; this is a mechanism for a situation the corpus never declares.
 * It is here because the STATED TEST GAME needs it — an authored enemy must fall off a ledge, so it
 * must be a dynamic body, and a Region cannot move — which is a legitimate reason to build a thing
 * and a different one from every slice before it.
 *
 * AND THE OBVIOUS MOTIVATION IS FALSE AGAINST THE DATA, which is worth stating because it is the
 * thing everyone will assume. "Stomping an enemy is two dynamic bodies meeting" is not true of this
 * corpus: every blob (x2), enemy (x1), NPC (x2) and spike (x4) carries a class and NO `bodyType`,
 * and so does the hero. Under slice 5's rule all nine are already REGIONS, and a stomp is already an
 * `enter blob` event. That is why `side` is added to enter/leave in the same breath — THAT half is
 * measured, and it serves content that exists today, while the pair pass serves content that does not.
 *
 * IT REPORTS AND IT DOES NOT RESOLVE, and the refusal is the design rather than a shortcut. Making
 * bodies solid to each other was written out in full and rejected on three concrete failures, each
 * reachable with ordinary level geometry: (1) neither resolution loop breaks and both re-read the
 * mutated velocity, so a body landing on a floor while overlapping a crate takes the crate's `else`
 * branch and is driven INTO the floor, then ejected the solid's full width on the next step's
 * horizontal pass; (2) the same shove puts a body's top at a one-way platform's top, where slice
 * 7's `was.y + h <= s.y` correctly refuses it forever and the body leaves the level; (3) the
 * tunnelling guarantee above — "any solid 20px or deeper is safe" — is a fact about SOLIDS, which
 * the corpus makes 32px and up. A body has no depth floor, and two 10px bodies give a margin of
 * exactly zero, which is exactly hittable because every position here is a dyadic rational.
 * Resolution needs a design that answers all three; reporting needs none of them, because it moves
 * nothing.
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
import { isParallaxed } from "../document/Depth";

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
 * How much harder a TURN pushes than a start — the whole of the skid (M18 slice 17), and the only
 * new magnitude the slice introduces.
 *
 * IN THE ORIGINAL IT IS NOT A NUMBER AT ALL, IT IS A BIT SHIFT. There is no skid constant in the
 * ROM: holding the opposite direction takes the SAME table entry as releasing, and the whole effect
 * is `asl FrictionAdderLow / rol FrictionAdderHigh` — a doubling that fires on the frames the facing
 * direction and the moving direction disagree. So the ratio is exactly 2, not approximately 2, and
 * writing anything else here would be inventing a number where the era has an operation.
 */
export const SKID_TURN = 2;

/**
 * The acceleration a held key applies, and the one a turn applies — ONE GRAVITY, and two of it.
 *
 * NO NEW MAGNITUDE, WHICH IS SLICE 4'S STANDARD AND THE ERA'S OWN STRUCTURE. In the original's WALK
 * tier — the tier this runtime is in, because it has no run button and one speed — the acceleration
 * byte and the release-friction byte are THE SAME BYTE, `$98`. Acceleration equals friction there;
 * it is one addition per frame whose sign the D-pad chooses. This runtime already has a friction of
 * `mu * g`, defaulting to `mu = 1` because 44 of the corpus's 45 surfaces declare exactly 1 — so
 * "the push is one gravity" reproduces the original's identity using the number slice 4 already had.
 *
 * THE FIRST VERSION OF THIS ANCHORED ON THE RUN TIER and was wrong for a reason worth keeping: our
 * `MOVE_SPEED` of 220 px/s is 1.47x the original's RUNNING top speed, so it looked like the run. But
 * a tier is chosen by the BUTTON, not by the speed, and with no run button a held key is a walk.
 * Read off the run tier the run-up came out at 3.5 tiles against the walk tier's 1.5, and the skid
 * at 2 tiles against 0.75 — both more than twice the era's own figures.
 *
 * IT TAKES THE STEP'S GRAVITY, not the default, so a level that changes gravity keeps the identity
 * rather than silently keeping the 900. That matches `jumpSpeedFor`, which is stated against gravity
 * for the same reason.
 */
export function walkAccel(gravity = DEFAULT_GRAVITY): number {
    return Math.max(0, gravity);
}

/** …and the turn, which is that doubled. */
export function skidAccel(gravity = DEFAULT_GRAVITY): number {
    return walkAccel(gravity) * SKID_TURN;
}

/**
 * WHAT THOSE PRODUCE, FOR A LEVEL: the run-up a standing start needs to reach `speed`, and the room
 * a full-speed turn costs. `v^2 = 2*a*d`.
 *
 * DERIVED RATHER THAN DECLARED, and that is the correction. These read the way `JUMP_HEIGHT` reads —
 * a distance is what a gap, a ledge and a corridor are drawn against, and "is there room to get up
 * to speed before this jump" is a measurement on the map. But they are CONSEQUENCES of one gravity
 * and its double, not knobs standing beside them; declaring the distance and deriving the rate put
 * two numbers where the era has none, and let the skid ratio drift off 2 without anything noticing.
 *
 * MEASURED AGAINST THE ORIGINAL'S WALK TIER: it reaches top speed over 1.90 blocks and turns round
 * in 0.75. Ours is 26.89px = 1.49 tiles and 13.44px = 0.75 tiles — the turn exact, the run-up
 * punchier, which is what a body moving 2.4x faster on a tile only 1.125x bigger has to be. The two
 * cannot both be preserved, and the turn is the one a player feels. A cross-check that fell out
 * rather than being aimed at: the run-up is 26.89px and a TAPPED jump clears 25.92.
 */
export function walkRunup(speed = MOVE_SPEED, gravity = DEFAULT_GRAVITY): number {
    const a = walkAccel(gravity);
    return a > 0 ? (speed * speed) / (2 * a) : Number.POSITIVE_INFINITY;
}

/** The room a full-speed turn costs — `SKID_TURN` times shorter than the run-up, by construction. */
export function skidDistance(speed = MOVE_SPEED, gravity = DEFAULT_GRAVITY): number {
    const a = skidAccel(gravity);
    return a > 0 ? (speed * speed) / (2 * a) : Number.POSITIVE_INFINITY;
}

/**
 * The fraction of gravity that pulls on a RISING body whose jump key is still HELD, and with it the
 * whole of variable jump height (M18 slice 16).
 *
 * THE ERA ASKED FOR THIS. Slice 2 gave the runtime one fixed 72px jump: press, and the arc is
 * decided. Super Mario Bros.' signature vertical rule is that the arc is decided by YOU — a tap
 * clears one block and a full hold clears four — and the ladder this project climbs starts at 8-bit,
 * so a fixed jump is a hole the project INTRODUCED rather than one it found. It is also the first
 * test of whether the input path can carry something other than a boolean edge, and the answer is
 * that it did not need to: `Input.jump` was already a HELD state and only the launch read it.
 *
 * TWO GRAVITIES, NOT A VELOCITY CUT, which is the mechanism the original uses and not the one most
 * tutorials reach for. Cutting `vy` toward zero on release gives the same range of heights and a
 * visible KINK at the moment of release; a weaker gravity while the button is down gives one smooth
 * arc whose curvature changes, which is what the 1985 game does and what it looks like.
 *
 * THE FRACTION IS THE RATIO OF THE SHORTEST JUMP TO THE TALLEST, exactly, and that identity is why
 * this is one constant rather than two. Launch at `v0`, rise under `g*f` while held: the apex is
 * `v0^2 / (2*g*f)`. Release immediately and the same `v0` rises under the full `g` to `v0^2 / (2*g)`
 * — `f` times as far. So `f` is not a tuning knob standing next to a height; it IS the height range,
 * and `JUMP_HEIGHT` keeps meaning what it always meant: how high a FULLY HELD jump goes.
 *
 * WHY 9/25, AND IT IS MEASURED RATHER THAN CHOSEN. The original's `JumpMForceData` and
 * `FallMForceData` tables hold its two vertical accelerations — `$20`/`$70`, `$1e`/`$60`, `$28`/`$90`
 * across three speed tiers — but their ratio is NOT the height ratio, and reading it as one is the
 * trap. Two things pull the realised ratio ABOVE it: the launch frame is exempt from the switch, so
 * even the shortest possible jump gets one frame of weak gravity (+14% on the minimum), and the
 * original moves by its velocity BEFORE it accelerates, which lifts the maximum. Simulating those
 * tables frame by frame gives min-to-max jump heights of 0.350, 0.371 and 0.344 against gravity
 * ratios of 0.286, 0.313 and 0.278. 9/25 = 0.36 sits in the middle of the HEIGHTS, which is the
 * quantity a level is built from, and it is also the value that comes out whole here: the launch
 * speed is EXACTLY 216 px/s under the default gravity and the apex lands on step 40 exactly, so this
 * module's tests stay hand-computable. The published block figures agree from the other side — a tap is documented as
 * "a little over one block" and a full jump as "almost exactly 4 blocks", and 0.36 of `JUMP_HEIGHT`
 * is 25.92px, which on this project's 18px grid is 1.44 tiles against 4.
 *
 * WHAT IS NOT COPIED, said plainly: the original's initial velocity depends on how fast Mario is
 * RUNNING (-4 px/frame walking, -5 flat out, a jump about 25% taller), and this runtime has no run
 * to read — its walk is a single set speed. That gap belongs to the acceleration-and-skid hole, not
 * to this one, and pretending otherwise would put a speed tier on a body with one speed.
 */
export const HELD_JUMP_GRAVITY = 9 / 25;

/**
 * The upward speed that reaches exactly `height` under `gravity` — `v = sqrt(2*g*h)`.
 *
 * STATED AS A HEIGHT rather than as a speed, because a height is the thing a level is built from:
 * a jump that clears a three-tile wall is a sentence about the art, and 360 px/s is not. It also
 * means changing gravity keeps the jump clearing the same wall.
 *
 * THIS IS THE KINEMATIC IDENTITY AND NOTHING MORE — it does not know that a jump can be held. What
 * a jump actually launches at is `jumpLaunchSpeed`, and the two were deliberately not merged: a
 * caller asking "how fast to reach 40px" is asking physics, and a caller asking "how fast does a
 * jump start" is asking this runtime's policy.
 */
export function jumpSpeedFor(height = JUMP_HEIGHT, gravity = DEFAULT_GRAVITY): number {
    return Math.sqrt(2 * gravity * Math.max(0, height));
}

/**
 * The upward speed a jump — or a bounce off something stomped — actually launches at.
 *
 * IT IS THE SHORTEST JUMP'S SPEED, not the tallest's, and that is the whole trick: the launch alone
 * carries you `height * HELD_JUMP_GRAVITY`, and every pixel above that is bought by keeping the key
 * down. A launch sized for the full height would make the tap the only jump and the hold a rocket.
 *
 * THE BOUNCE USES IT TOO, so "the bounce is exactly a jump's height" survives the change — and it
 * survives it in the interesting direction: a stomp with the key held carries as high as a jump, and
 * a stomp with the key released does not. Nothing had to be added for that; it falls out of the
 * bounce and the jump starting at the same speed.
 */
export function jumpLaunchSpeed(gravity = DEFAULT_GRAVITY, height = JUMP_HEIGHT): number {
    return jumpSpeedFor(Math.max(0, height) * HELD_JUMP_GRAVITY, gravity);
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

/**
 * What a body is doing right now. Pixels and pixels-per-second, in WORLD space.
 *
 * It said "the node's own parent space" for four days after slice 6 stopped making that true —
 * `worldFrom` composes ancestor translations and `applyWorld` writes back through them, so a body's
 * x/y have been world coordinates since. The comment mattered: the contact pass reads these
 * directly against other bodies' boxes, and a reader who believed the old sentence would have
 * composed the offset a second time.
 */
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
    /**
     * Whether a SOLID stopped this body horizontally on the last step — `onGround`'s sideways twin.
     *
     * The physics has always known this and thrown it away: the horizontal pass sets `vx = 0` and
     * says nothing. A part that walks needs exactly this one fact to turn around, and deriving it
     * outside would mean re-running the sweep or guessing from "it did not move as far as it should",
     * which is a different question with a different answer on a slope or in a corner.
     *
     * A WALL, NOT A LEDGE. Nothing here reports the edge of a platform, and that is deliberate:
     * Mario's own goombas walk off ledges, so a patrol that turns at a drop would be less faithful,
     * not more.
     */
    blockedX: boolean;
    /**
     * WHICH WAY THIS BODY IS FACING: 1 for right, -1 for left. Never 0.
     *
     * A FACT ABOUT MOTION, not about presentation — which is why it lives here beside `onGround` and
     * `blockedX` rather than in a rule. It is `sign(vx)` with one addition that is the whole point:
     * a body whose vx is zero KEEPS the way it was facing. Deriving it outside the step could not do
     * that, because a stopped character has no velocity left to read and would snap back to facing
     * right the instant it stood still.
     *
     * PER STEP BY CONSTRUCTION. A frame may spend anywhere from zero to five steps, so anything
     * computed once per FRAME and inherited across frames gives a different picture on a different
     * monitor — the defect already measured at 14.25px when rules were sampled per frame. Living on
     * the body means it is updated exactly as often as the physics is, and never more.
     */
    facing: 1 | -1;
    /**
     * How far this body has WALKED, in pixels, only ever increasing.
     *
     * A FACT ABOUT MOTION, like `facing`, and here for the same two reasons. It is per STEP by
     * construction — a frame may spend zero to five steps, so anything accumulated once per FRAME
     * gives a different animation on a different monitor, which is the defect already measured at
     * 14.25px when rules were sampled per frame. And a walk cycle driven by DISTANCE rather than by
     * a clock is what the era does: the original's animation advances as the character covers
     * ground, so it visibly speeds up as you do and stops dead when you stop, with no separate
     * playback rate to keep in sync with the physics.
     *
     * GROUND ONLY. A body in mid-air is not taking steps, so a jump does not wind the cycle on —
     * which is also what keeps a single jump-frame pose stable for the whole arc.
     */
    travelled: number;
    /**
     * The body's POWER tier (M18 slice 34): 0 is small, and the numbers above it are whatever the
     * game's parts declare — SMB1 would say 1 is Super and 2 is Fire, and nothing here knows that.
     *
     * ON THE BODY, because it is a fact about ONE body that other rules read per body — a brick is
     * breakable by a SUPER bumper, not by a super game. It only ever arrives through the `setPower`
     * command, so what raises it is a RULE's decision (collecting a part that declares
     * `vde.powers`), and the physics neither reads nor writes it: a powered body jumps, falls and
     * collides exactly like a small one. SMB1's Super Mario is also TALLER, and this deliberately
     * is not — resizing a body changes every collision, and that is a separate decision to make on
     * purpose or not at all.
     */
    power: number;
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
     * Whether the jump in progress has already been COMMITTED to full gravity (slice 16).
     *
     * VARIABLE JUMP HEIGHT NEEDS A LATCH OR IT IS A PUMP. Without this, letting go of the key and
     * pressing it again mid-rise buys back the weak gravity, so the way to jump highest is to
     * flutter the button — which is not a jump the player is aiming, it is a technique. The original
     * latches for exactly this reason: its `JumpSwimSub` overwrites the rising acceleration with the
     * falling one and never puts it back until a NEW jump reloads it.
     *
     * IT CLOSES ON EITHER OF TWO THINGS, and the second is the one that is easy to miss: the key
     * being released, OR the body stopping rising. The original tests `Player_Y_Speed` first and
     * dumps to fall gravity the moment it is non-negative, holding the key or not — so once you are
     * past the apex the arc is decided, and anything that pushes you up again during it (a stomp
     * bounce) rises under FULL gravity. That is why a bounce in the original does not answer the
     * button, and it falls out of this one field rather than needing a rule of its own.
     */
    jumpCut: boolean;
    /**
     * Which (body, region) pairs were overlapping at the END of the last step.
     *
     * KEPT SO THAT ENTER AND LEAVE CAN BE DIFFED. An overlap on its own is a state; a game wants
     * the EDGE — a coin is collected once, not on every one of the sixty frames the player spends
     * inside it. Keyed `bodyId \u0000 nodeId`, because a NUL cannot occur in either.
     */
    overlaps: ReadonlySet<string>;
    /**
     * Which (body, body) pairs were touching at the END of the last step — the same diff as
     * `overlaps`, one axis over.
     *
     * KEYED WITH THE TWO IDS IN SORTED ORDER, so a pair has exactly one key however the two bodies
     * are reached. `overlaps` can key by (body, region) because those are two different kinds of
     * thing; a pair of bodies has no such asymmetry to borrow, and keying it by encounter order
     * would make `contact` fire twice and `separate` never.
     */
    contacts: ReadonlySet<string>;
    /**
     * Bodies removed from this RUN — by a command, never by the physics.
     *
     * MONOTONIC, and it has to be: `applyWorld` hides these from the derived document, and a body
     * that came back would need its node's geometry restored from a world that no longer holds it.
     * Nothing here un-despawns; Stop throws the whole world away, which is what brings them back.
     *
     * The STORED document is untouched, so a despawned enemy is still listed in the layer panel and
     * still there when the run ends. That is the same bargain every other part of a run strikes.
     */
    despawned: ReadonlySet<string>;
    /**
     * Cells this run has CHANGED, keyed `nodeId NUL col NUL row` — a NUL cannot occur in a node id.
     *
     * THE SAME SHAPE AS `despawned`, and for the same reason: a run's changes are the WORLD's, not
     * the document's, so Stop throws them away and the level is whole again. Empty for every
     * document that never bumps anything, which is all of them until a rule says otherwise.
     */
    cells: ReadonlyMap<string, number>;
    /**
     * What this run has BROUGHT INTO EXISTENCE, in the order it happened.
     *
     * AN ARRAY, AND THAT IS WHAT MAKES THE IDS DETERMINISTIC: the nth spawn of a run is at index n
     * however the run got there, so `templateId#n` is reproducible and a test can assert on it with
     * a literal. `generateUUID` here would make a pure, replayable runtime unreplayable — the one
     * thing this module has refused to give up.
     *
     * IT DIES WITH THE RUN, like `cells` and `despawned`: Stop throws it away and the stored
     * document never had a coin in it.
     */
    spawns: readonly { id: string; templateId: string; x: number; y: number }[];
    /**
     * When each cell's PAYOUT CLOCK started, in world seconds (M18 slice 35) — the state a
     * multi-coin brick needs and nothing else has: SMB1's coin brick pays from the first hit until
     * a timer runs out, and a stateless rule can only implement a timer if the world remembers
     * when it began. Written only by the `startCellClock` command, so what starts a clock is a
     * RULE's decision; keyed like `cells`, and it dies with the run the same way.
     *
     * PER CELL, where SMB1's is famously GLOBAL — one `BrickCoinTimerFlag` per area, so hitting a
     * second coin brick while another's timer runs joins the first one's countdown. That is a
     * quirk of one flag byte, not a design worth reproducing; a declared divergence.
     */
    cellClocks: ReadonlyMap<string, number>;
    /**
     * Whether this run is still going. Set only by an `endRun` command — the physics never decides
     * that a game is over, for the same reason it never decides what a stomp means.
     */
    outcome: RunOutcome;
    /** What the step that produced this world noticed. Empty on most steps, by design. */
    events: readonly WorldEvent[];
}

/** The key for one CELL of one tilemap. Same NUL reasoning as `pairKey`. */
export function cellKey(nodeId: string, col: number, row: number): string {
    return nodeId + "\u0000" + col + "\u0000" + row;
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
     * The tilemap node and CELL this box came from, when it came from a tilemap (M18).
     *
     * A SOLID WAS A BARE BOX, and that is why a block could not be hit. Every collision in this
     * runtime was reported against a BODY or a REGION — both of which are nodes — while a level made
     * of tiles collided perfectly and said NOTHING about which tile. The one thing an author most
     * wants to act on in this era, bumping the block above your head, was the one collision the
     * world could not name. Absent for a node solid, whose own id is already the answer.
     */
    nodeId?: string;
    cell?: { col: number; row: number };
    /**
     * The Coulomb coefficient of whatever a body stands on: 0 is ice, 1 decelerates it at exactly
     * one gravity.
     *
     * DEFAULTS TO 1, which is the measured value rather than a neutral one — 44 of the corpus's 45
     * `friction` values are 1 or "1.00", and the one that is not is 0.45, on the block a player
     * pushes.
     */
    friction: number;
    /**
     * Solid only from ABOVE, and only to a body that is falling — a platform you jump up through.
     *
     * An INVENTION rather than a measurement: the corpus says nothing about these, and this module
     * says so in its header instead of implying otherwise.
     */
    oneWay: boolean;
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

/**
 * WHERE THE OTHER THING SITS, relative to the one being reported to — not "which of my edges was
 * touched", which is the same fact said backwards and reads wrong in every test that uses it.
 *
 * So a STOMP is `below`: the reporting body is above, the thing it met is under its feet. That is
 * the whole reason this exists — "did I land on it or walk into it" is the single question a
 * contact has to answer, and it is the only genuinely new information in this slice.
 *
 * `inside` is a REFUSAL rather than an approximation, in the posture `runtimeExclusions` already
 * takes: one box entirely within another has no side, and guessing one would be a direction an app
 * acts on that the geometry never supported.
 */
/**
 * WHETHER THE RUN IS STILL GOING, and how it stopped if it is not.
 *
 * Until this existed a run could not be lost, won or ended — it could only be STOPPED by the editor,
 * which is a different thing entirely: the person watching decided, not the game. Building a real
 * level proved how much that costs. With no bounds, one stomp bounced the player past the level edge
 * and it reached y=4658 still at terminal velocity, with the run happily continuing and nothing to
 * do but reach for Stop.
 *
 * IT IS ALSO WHAT MAKES A LEVEL TEACHABLE. Every published account of World 1-1 turns on
 * consequence — the first Goomba teaches by killing you once, and the first pit is deliberately
 * given a filled-in bottom so the jump can be rehearsed before the identical next pit charges for
 * it. A safe-then-lethal pair means nothing while both halves are survivable.
 *
 * MONOTONIC WITHIN A RUN. Nothing here returns to `running`; a finished run is finished, and
 * starting again is Play building a new world, which is the same bargain despawn already strikes.
 */
export type RunOutcome = "running" | "lost" | "won";

export type ContactSide = "above" | "below" | "left" | "right" | "inside";

/** An axis-aligned box, for the one function here that does not care what it belongs to. */
export interface ContactBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Where `b` sits relative to `a`, for two boxes already known to overlap.
 *
 * PURE, AND DOCUMENT-FREE ON PURPOSE: two boxes in, one word out. No `was`, no clock, no ordering,
 * no document — which is what lets it answer for a body pair and for a region with the same code,
 * and lets a test pin it with literal numbers.
 *
 * A SPANNED AXIS CANNOT BE THE CONTACT AXIS, and this is the part a shallowest-overlap test gets
 * wrong. If `a` is entirely covered by `b` horizontally there is no left or right to report, however
 * thin the horizontal overlap happens to be; the contact is necessarily vertical. Checking that
 * first is what makes a narrow body meeting a wide floor answer `below` rather than `left`.
 *
 * THE TIE GOES VERTICAL, deliberately: equal overlaps mean a corner, and a platformer's commonest
 * contact by far is a landing. A stated wrong answer beats one chosen by whichever axis the
 * arithmetic happened to reach first.
 */
export function sideOf(a: ContactBox, b: ContactBox): ContactSide {
    const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    // Asked about boxes that do not overlap at all, which no caller here does. There is no side.
    if (!(ox > 0) || !(oy > 0)) return "inside";
    const spannedX = a.x >= b.x && a.x + a.width <= b.x + b.width;
    const spannedY = a.y >= b.y && a.y + a.height <= b.y + b.height;
    if (spannedX && spannedY) return "inside";
    const vertical = () => (a.y + a.height / 2 < b.y + b.height / 2 ? "below" : "above");
    const horizontal = () => (a.x + a.width / 2 < b.x + b.width / 2 ? "right" : "left");
    if (spannedX) return vertical();
    if (spannedY) return horizontal();
    return oy <= ox ? vertical() : horizontal();
}

/**
 * The same contact seen from the other body — `above` for `below`, `right` for `left`.
 *
 * DERIVED, NOT RE-COMPUTED, because `sideOf` is not antisymmetric and cannot be: it answers a
 * question about two boxes, and "b is entirely inside a" is true while "a is entirely inside b" is
 * false. Asking it twice therefore yields (below, inside) for the ordinary case of a small enemy
 * under a big hero — which is not wrong about the geometry and is useless as a pair.
 */
export function oppositeSide(side: ContactSide): ContactSide {
    return side === "above" ? "below"
        : side === "below" ? "above"
        : side === "left" ? "right"
        : side === "right" ? "left"
        : "inside";
}

/**
 * Something a body touched — a region's edge crossed, or another body met.
 *
 * `enter`/`leave` name a REGION; `contact`/`separate` name another BODY. Both are EDGES for the
 * reason slice 5 gave: a coin is collected once, not on all sixty frames a player stands in it.
 *
 * A CONTACT IS REPORTED TO BOTH BODIES, one event each, because there is no non-arbitrary way to
 * pick which of two bodies is the subject — and the two carry OPPOSITE sides, which is exactly what
 * distinguishes a stomp from being stomped.
 *
 * `side` is absent on `leave` and `separate`: they say the boxes are no longer touching, and a
 * direction for a contact that has ended would be a fact about the past dressed as one about now.
 */
export interface WorldEvent {
    kind: "enter" | "leave" | "contact" | "separate" | "bump";
    bodyId: string;
    /** The region entered, the OTHER body met, or the TILEMAP whose cell was hit. */
    nodeId: string;
    className: string;
    side?: ContactSide;
    /**
     * WHICH CELL was hit, for a `bump`. Absent for every other kind.
     *
     * The column and row rather than a tile index, because a rule wants to act on the PLACE — that
     * cell becomes a used block, that cell spawns something — and the index is already readable
     * from the map at those coordinates. Reporting the index instead would be reporting the answer
     * to a different question.
     */
    cell?: { col: number; row: number };
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

/**
 * `"static"`, `"dynamic"`, `"oneway"`, or null for the 216-of-248 objects that are not bodies.
 *
 * A WORD IT DOES NOT KNOW IS NOT A BODY, which is what makes adding one safe: a document written
 * against an older build behaves identically, and a typo becomes decoration rather than a wall
 * somewhere unexpected.
 */
export function bodyTypeOf(node: { userData?: UserData }): "static" | "dynamic" | "oneway" | null {
    const raw = propertyOf(node.userData, "bodyType");
    if (raw === null) return null;
    const lower = raw.trim().toLowerCase();
    return lower === "static" || lower === "dynamic" || lower === "oneway" ? lower : null;
}

/**
 * The world a document starts in: every DYNAMIC body at rest, where the document puts it.
 *
 * STATIC BODIES ARE NOT IN HERE. They do not move, so storing a position for them would be a second
 * copy of something the document already states — and the two could disagree the moment somebody
 * edits the level. They are read fresh from the document every step, by `solidsOf`.
 */
/**
 * The rectangle a RUN is held inside — the camera's clamp and the death plane's floor.
 *
 * WITHOUT A DECLARED SCREEN IT IS THE CONTENT'S EXTENT, exactly as before, and every level authored
 * before schema 72 plays identically. WITH ONE, the VERTICAL span is the screen's — [0, height],
 * anchored where the screen is — and the horizontal span stays measured, because a side-scroller is
 * as LONG as its content but as TALL as one screen: SMB1 scrolls five screens of length and not one
 * pixel of height, and its pits kill at the screen's bottom even though the shaft is drawn below.
 *
 * THIS IS THE SLICE-30 DEFECT CLOSED PROPERLY. An empty trailing scenery row moved `contentBounds`
 * from 252 to 270 and the death plane with it; deepening a floor for looks once moved it to 900 and
 * TRIPLED how long a pit took to kill (0.47s to 1.27s, measured). A declared screen makes the play
 * area a statement instead of a measurement, so decoration below the floor changes nothing.
 *
 * STATED LIMIT: a VERTICALLY scrolling level wants the opposite axes, and this function does not
 * serve one — its author should not declare a screen yet. The tower level that reaches M18's ladder
 * will find this hole, which is what the ladder is for.
 */
export function playBounds(
    content: { x: number; y: number; width: number; height: number } | null,
    screen?: { readonly width: number; readonly height: number }
): { x: number; y: number; width: number; height: number } | null {
    if (!screen) return content;
    if (!content) return { x: 0, y: 0, width: screen.width, height: screen.height };
    return { x: content.x, y: 0, width: content.width, height: screen.height };
}

export function worldFrom(doc: ReadonlyDocument): WorldState {
    const bodies = new Map<string, Body>();
    for (const node of doc.nodes.values()) {
        // A HIDDEN NODE IS NOT IN THE WORLD (M18 slice 34). `hidden` already means "out of the
        // DISPLAYED scene, subtree and all" — and a TEMPLATE is hidden precisely to be a mould
        // rather than a thing. Minting it anyway made the mushroom template a live body that fell
        // from its parking spot through the sky and was COLLECTED mid-level, template and all —
        // found the first time a level parked a dynamic template, measured in the arc replay.
        if (node.hidden) continue;
        if (bodyTypeOf(node) !== "dynamic") continue;
        const at = worldOffsetOf(doc, node.id);
        if (!at) continue;                        // refused, and `runtimeExclusions` says why
        bodies.set(node.id, {
            x: node.geometry.x + at.dx, y: node.geometry.y + at.dy,
            vx: 0, vy: 0, onGround: false, groundFriction: 1, blockedX: false, facing: 1,
            travelled: 0, power: 0
        });
    }
    return { bodies, time: 0, contacts: new Set(), despawned: new Set(), cells: new Map(), cellClocks: new Map(), spawns: [], outcome: "running", jumpWas: false, jumpCut: false, overlaps: new Set(), events: [] };
}

/** Every static body's box, read from the document each step so a level edit is picked up. */
/**
 * Is this node at a DEPTH — and therefore invisible to the physics?
 *
 * THE PHYSICS MUST NOT COLLIDE WITH SOMETHING WHOSE POSITION DEPENDS ON WHERE YOU ARE LOOKING, and
 * that is the whole rule. `applyParallax` shifts a layered node by an offset derived from the
 * VIEWPORT, so a depth-1 cloud is drawn in a different place on every frame of a pan while its
 * stored geometry never moves. Collide against the stored box and the wall is nowhere near the
 * picture; collide against the drawn one and the level plays differently depending on the camera,
 * which is the same class of defect as a frame-rate-dependent jump and far harder to notice.
 *
 * FOUND BY PUTTING SCENERY IN THE TEST LEVEL. Solidity is a property of the TILESET TILE, and every
 * layer drawing that tile shares it — the Kenney map draws all three of its tile layers from ONE
 * tileset — so a background built from the same sheet as the ground was a wall in the sky. Measured
 * on the real level: 0 solids up there before adding the layer, 2 after.
 *
 * DEPTH RATHER THAN A NEW DECLARATION, because it is a consequence rather than a choice. Nothing
 * had to be invented and no property added: a layer says it is scenery by being at a depth, which
 * is the same statement that makes it parallax. A level that wants solid ground keeps it at 0,
 * which is where every node already is.
 */
function isLayered(node: { depth?: number; depthY?: number }): boolean {
    return isParallaxed(node);
}

export function solidsOf(doc: ReadonlyDocument): Solid[] {
    const out: Solid[] = [];
    for (const node of doc.nodes.values()) {
        if (node.hidden) continue;                     // out of the scene, out of the world
        if (isLayered(node)) continue;                 // see `isLayered`
        const kind = bodyTypeOf(node);
        if (kind !== "static" && kind !== "oneway") continue;
        const at = worldOffsetOf(doc, node.id);
        if (!at) continue;
        const g = { x: node.geometry.x + at.dx, y: node.geometry.y + at.dy,
            width: node.geometry.width, height: node.geometry.height };
        // A ZERO-AREA SOLID IS NOT A FLOOR. The corpus has none, but an author dragging a new box
        // out passes through 0x0 on the way, and a zero-height solid would catch a falling body on
        // an infinitely thin line — which reads as a bug in the physics rather than in the level.
        if (g.width <= 0 || g.height <= 0) continue;
        out.push({ x: g.x, y: g.y, width: g.width, height: g.height,
            friction: frictionOf(node), oneWay: kind === "oneway" });
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
    const kind = tile === null ? null : bodyTypeOf(tile);
    return kind === "static" || kind === "oneway";
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
        if (node.hidden) continue;                     // out of the scene, out of the world
        if (isLayered(node)) continue;                 // see `isLayered`
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
                const kind = tile === null ? null : bodyTypeOf(tile);
                out.push({
                    x: originX + col * map.tileWidth,
                    y: originY + row * map.tileHeight,
                    width: map.tileWidth, height: map.tileHeight,
                    friction: tile && propertyOf(tile.userData, "friction") !== null
                        ? frictionOf(tile) : frictionOf(node),
                    oneWay: kind === "oneway",
                    nodeId: node.id,
                    cell: { col, row }
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
        if (node.hidden) continue;                     // out of the scene, out of the world
        if (isLayered(node)) continue;                 // see `isLayered`
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
    // COLLECTED IN THE BODY LOOP, which runs before the event list below exists — a tile bump is
    // discovered during collision resolution and there is nowhere else it could be noticed.
    const bumps: WorldEvent[] = [];
    // THE JUMP LATCH, decided ONCE for the step rather than per body, because it is a fact about the
    // player's key and the body that key drives — see `WorldState.jumpCut`. It closes when the key is
    // released or when the driven body stops rising, and only a fresh launch below reopens it.
    const driver = controlled !== null ? world.bodies.get(controlled) : undefined;
    const cutNow = world.jumpCut || !input.jump || driver === undefined || driver.vy >= 0;
    let launched = false;

    for (const [id, was] of world.bodies) {
        const node = doc.nodes.get(id);
        // A BODY WHOSE NODE HAS GONE keeps its state and stops moving, rather than throwing or
        // vanishing — the inert-reference rule this schema follows everywhere. Deleting a node
        // mid-run must not take the run down.
        if (!node) { next.set(id, { ...was }); continue; }
        const w = node.geometry.width, h = node.geometry.height;

        // Declared with vx because the HORIZONTAL pass below is what sets it, and that pass runs
        // before onGround is even declared.
        let blockedX = false;
        let vx = was.vx;
        // GRAVITY IS NOT ONE NUMBER while a jump is being held (slice 16). A RISING controlled body
        // whose jump key is still down is pulled by `HELD_JUMP_GRAVITY` of it, and that is the whole
        // of variable jump height — see the constant for why it is two gravities rather than a
        // velocity cut, and for why the fraction IS the ratio of the shortest jump to the tallest.
        //
        // THREE CONDITIONS, AND EACH IS LOAD-BEARING. `id === controlled` because nothing else has a
        // key to hold, and without it every enemy in the level floats the moment the player jumps.
        // `input.jump` because that is the question. `was.vy < 0` because holding the key must not
        // slow the FALL — a jump that hangs on the way down is a glide, not a jump, and asking the
        // PRE-gravity velocity is what keeps the apex step from picking up half a weak step. And
        // `!world.jumpCut` is the latch: once this arc has been committed to full gravity, pressing
        // the key again does not buy any of it back.
        const heldJump = id === controlled && input.jump && was.vy < 0 && !world.jumpCut;
        let vy = was.vy + (heldJump ? gravity * HELD_JUMP_GRAVITY : gravity) * FIXED_STEP;
        let x = was.x, y = was.y;

        // THE CONTROLLED BODY, and only it. Which node that is comes from the caller: nothing in
        // the measured corpus says "this one is the player" — 216 of 248 objects carry no class at
        // all — so inventing a property for it would be designing ahead of any content. The app
        // passes the node that was SELECTED when Play was pressed, which is how a level gets
        // tested; a real convention can replace that the day real content declares one.
        // FRICTION ONLY WHEN NOTHING IS PUSHING (slice 17). A body only loses speed to a surface it
        // is actually ON: in the air it keeps what it has, which is what air control means and why a
        // jump carries you forward.
        //
        // WHY A HELD KEY SUPPRESSES IT RATHER THAN COMPOSING WITH IT, and this is forced rather than
        // chosen. Compose them and the effective acceleration is `a - mu*g`; the default mu is 1 and
        // g is 900, so ANY walk acceleration below 900 px/s^2 leaves the player unable to move at
        // all on ordinary ground, and 44 of the corpus's 45 declared surfaces say exactly 1. The
        // original agrees for its own reasons — its friction routine runs only on the frames no
        // direction is held. Until slice 17 this line ran always and the walk simply ASSIGNED over
        // it, which is the same suppression written less honestly.
        //
        // COULOMB, WHICH IS WHY THERE IS NO NEW CONSTANT HERE. Friction opposes motion with a force
        // proportional to the normal one — on flat ground that is `mu * m * g`, so the deceleration
        // is `mu * g` and the gravity this module already has supplies the g. The first version of
        // this multiplied the speed by `1 - mu` each step, which reads well and is wrong twice:
        // mu = 1 stopped a body inside one 16ms step, and since 44 of the corpus's 45 surfaces say
        // exactly 1, every surface in the tree would have been instant-stop and the one 0.45 would
        // have meant nothing. At mu = 1 a body walking at 220 px/s now slides 27px over a quarter
        // second, and at 0 it never stops.
        // EXACTLY ONE DIRECTION HELD is what counts as pushing: both at once cancels, and a body
        // being asked to go two ways is a body being asked to go nowhere, which is what friction is
        // for. Only the controlled body has a key to hold.
        const push = id === controlled ? (input.left ? -1 : 0) + (input.right ? 1 : 0) : 0;
        if (was.onGround && was.groundFriction > 0 && vx !== 0 && push === 0) {
            const drop = was.groundFriction * gravity * FIXED_STEP;
            // NEVER PAST ZERO: a deceleration that overshoots would push the body backwards, which
            // is friction turning into a spring.
            vx = vx > 0 ? Math.max(0, vx - drop) : Math.min(0, vx + drop);
        }

        if (id === controlled) {
            // A WALK IS BUILT UP, NOT SWITCHED ON (slice 17), and this is the second era mismatch
            // the slice-15 research found. Slice 2 SET the speed on the reasoning that "a
            // platformer's walk is a speed you have while the key is down" — defensible arcade feel,
            // and not what the 8-bit era does. The original accelerates, carries the momentum, and
            // gives turning around its OWN much larger deceleration. Releasing must still not set
            // the speed to zero: that hands the body back to the surface, which is what friction is
            // for, and it is why a jump carries you forward.
            //
            // SKID IS A SEPARATE RATE, NOT A SIGN. Turning around at the walking rate takes as long
            // to stop as it took to start, which reads as ice rather than as a turn; the original
            // spends a much larger number on it, and so does every platformer that feels sharp. It
            // is the SAME acceleration applied against the motion, so no direction logic is needed
            // — only the rate changes.
            if (push !== 0) {
                const skid = vx !== 0 && Math.sign(vx) !== push;
                const rate = skid ? skidAccel(gravity) : walkAccel(gravity);
                const want = vx + push * rate * FIXED_STEP;
                // CLAMPED TO THE TOP SPEED, BUT NEVER BRAKING. A body already travelling faster than
                // MOVE_SPEED — thrown, or carried out of a bounce — must not be slammed down to it
                // by its own input; the clamp catches the step that CROSSES the cap and nothing
                // else. Above it, the surface is what brings a body back, on the frames it can.
                vx = Math.abs(want) > MOVE_SPEED && Math.abs(vx) <= MOVE_SPEED
                    ? push * MOVE_SPEED : want;
            }
            // A JUMP IS AN EDGE, not a state: it fires on the step the key GOES DOWN while the
            // body is on the ground. Holding it must not bunny-hop, and `jumpWas` is what
            // remembers the press across the several steps one frame may take.
            //
            // THE LAUNCH IS AN EDGE; THE HEIGHT IS NOT (slice 16). Keeping the key down after this
            // line has fired buys altitude through the weaker gravity above, so the two readings of
            // `input.jump` are asking different questions — "did it just go down" here, "is it still
            // down" there — and the edge is what stops the second one re-launching.
            if (input.jump && !world.jumpWas && was.onGround) {
                vy = -jumpLaunchSpeed(gravity);
                launched = true;                  // …and a fresh launch is what REOPENS the latch
            }
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
            // A ONE-WAY PLATFORM HAS NO SIDES. Walking into the edge of one must not stop a body:
            // the whole shape is "a floor that is only a floor from above".
            if (s.oneWay) continue;
            if (!overlaps(x, y, w, h, s)) continue;
            x = vx > 0 ? s.x - w : s.x + s.width;
            vx = 0;
            blockedX = true;
        }

        // VERTICAL, then resolve — and this is where `onGround` is decided.
        let onGround = false;
        let groundFriction = was.groundFriction;
        y += vy * FIXED_STEP;
        const underTiles = tiles ? tileSolidsNear(doc, { x, y, width: w, height: h }) : [];
        for (const s of [...solids, ...underTiles]) {
            if (!overlaps(x, y, w, h, s)) continue;
            // ONLY FROM ABOVE. `was.y` is where the body STARTED the step, not where it is now: at
            // 15px a step a body that was clear of a platform is inside it by the time this runs,
            // so asking about the present would let every landing through. A body that BEGAN
            // overlapping falls out rather than being launched to the surface.
            //
            // THERE IS NO `vy > 0` HERE, and there was until a mutant proved it could not matter.
            // "Was above" means the body did not overlap vertically at the start of the step; it
            // overlaps now; the only motion between the two is `y += vy * dt` — so it moved DOWN,
            // and vy was positive by construction. A second statement of one fact reads like care
            // and is really a place for the two halves to disagree later. `<=` rather than `<` is
            // the part that IS load-bearing: a body resting on the surface has `was.y + h` exactly
            // equal to `s.y`, and `<` drops it through the platform it just landed on.
            if (s.oneWay && !(was.y + h <= s.y)) continue;
            if (vy > 0) { y = s.y - h; onGround = true; groundFriction = s.friction; }
            else {
                y = s.y + s.height;
                // A HEAD HIT ON A TILE, REPORTED (M18). The `else` is the whole condition: the body
                // was rising and something stopped it from below, which is what hitting a block IS.
                // Landing on one is the branch above and is not a bump — a floor you stand on must
                // not fire an event sixty times a second.
                //
                // THE WORLD REPORTS AND DOES NOT ACT, which is slice 5's rule and the reason this
                // is an event rather than a rule. Turning a `?` into a used block and putting a coin
                // above it are a GAME's decisions, and they need something the command channel does
                // not have yet: a way to change a CELL, and a way to bring a thing into existence.
                // Both want their own design. This is the half that is a measurement.
                if (s.nodeId !== undefined && s.cell !== undefined) {
                    bumps.push({ kind: "bump", bodyId: id, nodeId: s.nodeId,
                        className: doc.nodes.get(s.nodeId)?.className ?? "", side: "above",
                        cell: s.cell });
                }
            }
            vy = 0;
        }

        // FACING KEEPS ITS LAST NON-ZERO DIRECTION. Read from the SETTLED vx, so a body stopped by
        // a wall goes on facing the wall it walked into rather than flipping the instant it stops.
        const facing: 1 | -1 = vx > 0 ? 1 : vx < 0 ? -1 : was.facing;
        // DISTANCE WALKED, from the SETTLED velocity so a body held against a wall stops winding
        // its cycle on — a character jogging on the spot against a wall is the tell that this read
        // the velocity it wanted rather than the one it got.
        const travelled = was.travelled + (onGround ? Math.abs(vx) * FIXED_STEP : 0);
        // `power` is CARRIED, never computed: the step is the seventh literal in this codebase that
        // rebuilds an object field-by-field, and the sixth one dropped a renderer's fields — so the
        // one field the physics does not touch is named here rather than trusted to be remembered.
        next.set(id, { x, y, vx, vy, onGround, groundFriction, blockedX, facing, travelled,
                       power: was.power });
    }

    // OVERLAPS ARE COMPUTED AFTER EVERYTHING HAS MOVED, once, on the settled positions — asking
    // mid-resolution would report a body inside a wall it is about to be pushed out of.
    const regions = opts?.regions ?? regionsOf(doc);
    // NOT `overlaps` — that is the box test used a dozen lines up, and shadowing it inside the same
    // function turns every collision check into a call on a Set.
    const inside = new Set<string>();
    // BUMPS FIRST, because they happened first: a head hit is resolved during the step, while
    // enters and contacts are diffed from the SETTLED positions afterwards.
    const events: WorldEvent[] = [...bumps];
    for (const [id, body] of next) {
        const node = doc.nodes.get(id);
        if (!node) continue;
        const w = node.geometry.width, h = node.geometry.height;
        for (const r of regions) {
            if (!overlaps2(body.x, body.y, w, h, r)) continue;
            const key = pairKey(id, r.nodeId);
            inside.add(key);
            if (!world.overlaps.has(key)) {
                // THE SIDE IS THE MEASURED HALF OF THIS SLICE. Every one of the corpus's nine
                // hittable actors — blob x2, enemy x1, NPC x2, spikes x4 — is a REGION, so
                // "landed on it" versus "walked into it" is a question about content that exists
                // today, unlike the body pair below.
                events.push({ kind: "enter", bodyId: id, nodeId: r.nodeId, className: r.className,
                    side: sideOf({ x: body.x, y: body.y, width: w, height: h }, r) });
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

    // ── BODY MEETS BODY ────────────────────────────────────────────────────────────────────────
    // Read the invention notice in this module's header before extending any of this. It REPORTS
    // and it does not resolve: no position and no velocity is touched here, which is what makes it
    // immune to the three failures that killed the resolving design.
    //
    // BUILT FROM A SORTED ID LIST, not from the `next` Map, and that is not tidiness. `world.bodies`
    // inherits the document's node-Map order, which `applyMutations` permutes when a DELETE IS
    // UNDONE — so two files with byte-identical content, saved after different edit sequences, would
    // emit their events in different orders. Sorting costs one pass over a handful of bodies and
    // makes the event stream a function of the document alone.
    const contactBoxes: (ContactBox & { id: string; className: string })[] = [];
    for (const id of [...next.keys()].sort()) {
        const node = doc.nodes.get(id);
        if (!node) continue;
        const g = node.geometry;
        // THE SAME TWO REFUSALS `solidsOf` AND `regionsOf` ALREADY MAKE, and for the same reasons: a
        // zero-area box is a position rather than a volume (an author dragging a new node out passes
        // through 0x0), and a body whose world offset cannot be composed is not drawn where it is
        // simulated, so a contact reported against it names a place with nothing in it.
        if (g.width <= 0 || g.height <= 0) continue;
        if (!worldOffsetOf(doc, id)) continue;
        const b = next.get(id)!;
        contactBoxes.push({ id, className: node.className ?? "",
            x: b.x, y: b.y, width: g.width, height: g.height });
    }
    const touching = new Set<string>();
    for (let i = 0; i < contactBoxes.length; i++) {
        const a = contactBoxes[i];
        for (let j = i + 1; j < contactBoxes.length; j++) {
            const b = contactBoxes[j];
            // `i < j` is the whole self-collision guard: a body is never its own partner, and each
            // pair is visited exactly once.
            if (!(a.x < b.x + b.width && a.x + a.width > b.x
                && a.y < b.y + b.height && a.y + a.height > b.y)) continue;
            const key = pairKey(a.id, b.id);            // already sorted: the ids are
            touching.add(key);
            if (world.contacts.has(key)) continue;
            // ONE EVENT EACH, WITH OPPOSITE SIDES — and the reciprocal is DERIVED rather than
            // computed a second time, which was a defect the first version shipped. Asking
            // `sideOf(b, a)` independently answers `inside` whenever b's box is contained in a's,
            // so an ordinary small enemy under a big hero produced the pair (below, INSIDE) while
            // this comment claimed (below, above) — and every rule keyed on the STOMPED body's side
            // was unreachable for exactly the commonest case. Measured: hero 32x32 at y=368 over a
            // 32x8 enemy at y=392 gives `sideOf(E,H) === "inside"`.
            // THE INFORMATIVE DIRECTION WINS. Deriving from whichever id sorts first is not enough:
            // that may be the CONTAINED body, whose own answer is `inside`, and the pair then reads
            // (inside, inside) — the same uselessness by a shorter route. Only one of the two can be
            // `inside` unless the boxes are identical, so ask both and keep the one that says
            // something; the other is its opposite by construction.
            const ab = sideOf(a, b);
            const side = ab !== "inside" ? ab : oppositeSide(sideOf(b, a));
            events.push({ kind: "contact", bodyId: a.id, nodeId: b.id,
                className: b.className, side });
            events.push({ kind: "contact", bodyId: b.id, nodeId: a.id,
                className: a.className, side: oppositeSide(side) });
        }
    }
    // SEPARATING SURVIVES EITHER BODY VANISHING, exactly as leaving survives a deleted region: a
    // game holding "what am I touching" must be told when the answer changes, including when it
    // changes because something was removed under it.
    for (const key of world.contacts) {
        if (touching.has(key)) continue;
        const [first, second] = key.split("\u0000");
        events.push({ kind: "separate", bodyId: first, nodeId: second,
            className: doc.nodes.get(second)?.className ?? "" });
        events.push({ kind: "separate", bodyId: second, nodeId: first,
            className: doc.nodes.get(first)?.className ?? "" });
    }

    return { bodies: next, time: world.time + FIXED_STEP, contacts: touching, despawned: world.despawned, cells: world.cells, cellClocks: world.cellClocks, spawns: world.spawns, outcome: world.outcome, jumpWas: input.jump, jumpCut: launched ? false : cutNow, overlaps: inside, events };
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
    // DESPAWNED NODES ARE HANDLED BEFORE EITHER EARLY RETURN, and that ordering is the whole of it.
    // Both gates below — "no bodies at all" and "nothing moved" — are about POSITIONS, and a run
    // that despawned something has a picture to change whether or not anything moved. Hanging the
    // stamp off the lazily-allocated `nodes` map would drop it on exactly the frames where the
    // survivors are all sitting still, which for a stomped enemy is most of them.
    //
    // `hidden` rather than deletion: `dropHidden` already means "gone from the DISPLAYED scene with
    // its subtree, still stored, still listed", which is precisely a despawn, and it takes the
    // node's children with it. Omitting the node instead would leave `rootNodeUuids` naming
    // something absent and make `validateDocumentIntegrity` throw on a dangling parent.
    let nodes: Map<string, Node> | null = null;
    if (world.despawned.size > 0) {
        for (const id of world.despawned) {
            const node = doc.nodes.get(id);
            if (!node || node.hidden) continue;
            if (!nodes) nodes = new Map(doc.nodes as ReadonlyMap<string, Node>);
            nodes.set(id, { ...(node as Node), hidden: true });
        }
    }
    if (world.bodies.size === 0) return nodes ? { ...(doc as ProjectDocument), nodes } as ReadonlyDocument : doc;
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

/**
 * THE CHANNEL BY WHICH SOMETHING OUTSIDE THE PHYSICS ACTS ON A RUN — and the whole reason it is a
 * closed union applied BETWEEN steps rather than a callback handed to `stepWorld`.
 *
 * Slice 5 established that the world reports and does not act, and gave the reason: spawning,
 * scripts and level transitions are each a separate decision about what an APP does, and welding
 * any of them into the physics makes all three undesignable. That rule survives here intact. A
 * command cannot be issued from inside a step, cannot see a step in progress, and cannot make the
 * physics conditional on anything; it is applied to a finished world, producing another finished
 * world, by a caller that has read the events.
 *
 * BEFORE THIS, THERE WAS NO CHANNEL AT ALL. `stepWorld`'s options carry gravity, solids, tiles,
 * regions, input and controlled, and not one of them can set a velocity or remove a body — so an
 * app could hear a stomp and had no way to answer it. API-CONTRACTS said so as a stated limit; this
 * is the limit being lifted deliberately rather than by leaving `es.world` writable, which was "a
 * hole, not a contract".
 *
 * TWO VERBS, because two is what a stomp needs and inventing a third ahead of a caller is the
 * `Document.clips` mistake. Neither is measured — see the invention notice in this module's header.
 */
export type RuntimeCommand =
    | { kind: "despawn"; bodyId: string }
    /** Absent components are LEFT ALONE, so a bounce can set vy without touching a walk in progress. */
    | { kind: "setVelocity"; bodyId: string; vx?: number; vy?: number }
    /**
     * SET A BODY'S POWER TIER (M18 slice 34). A command, not a physics event, because what grants
     * power is a RULE's reading of a part (`vde.powers` on the thing collected) — the channel stays
     * as ignorant of what a mushroom is as it is of what a stomp means. Absolute, not additive:
     * the rule decides the arithmetic (SMB1 keeps the higher tier), the channel records it.
     */
    | { kind: "setPower"; bodyId: string; power: number }
    /**
     * START A CELL'S PAYOUT CLOCK (M18 slice 35), at the world's CURRENT time. Idempotent: a clock
     * already running is left alone, which is what lets the rule issue it on every paying hit
     * without tracking whether it already did — the disassembly's own shape, where the flag guards
     * the store.
     */
    | { kind: "startCellClock"; nodeId: string; col: number; row: number }
    /**
     * The run is over. THE THIRD VERB, and the one the built level demanded loudest — before it a
     * run had no way to end, so a level could not be lost, won, or taught.
     *
     * FIRST ONE WINS. A step that both kills the player and reaches the goal reports the kill,
     * because a later command must not overwrite an ending that already happened; and a run that
     * has ended issues nothing further at all.
     */
    | { kind: "endRun"; outcome: Exclude<RunOutcome, "running"> }
    /**
     * A CELL BECOMES A DIFFERENT TILE — the fourth verb, and the one the block bump demanded.
     *
     * THE FIRST COMMAND THAT DOES NOT NAME A BODY. Despawn, setVelocity and endRun are all about
     * things that move; a level made of tiles has ten thousand cells and one node, and until now
     * nothing could touch one of them. A `?` block that stays a `?` after you hit it is the whole
     * of what was missing.
     *
     * IT DOES NOT EDIT THE DOCUMENT, exactly as despawn does not delete a node. The change lives on
     * the WORLD and is stamped onto a derived copy, so Stop restores the level and nothing lands on
     * the undo stack — a run is not an edit.
     */
    | { kind: "setCell"; nodeId: string; col: number; row: number; tile: number }
    /**
     * A THING COMES INTO EXISTENCE — the fifth verb, and the only one that adds rather than changes.
     *
     * IT COPIES A TEMPLATE rather than describing a node, because describing one means naming a
     * type, a geometry, a style, a source rect and whatever else the schema grows next — a second
     * definition of "what a node is", drifting from the first from the day it is written. A template
     * is a node the AUTHOR made, in the editor, with every field they wanted; spawning places a copy
     * of it. That is also Tiled's own shape (`templates/*.tx`) and Mario Maker's.
     *
     * A TEMPLATE THAT IS NOT THERE SPAWNS NOTHING, inertly — the dangling-reference rule this schema
     * follows everywhere. A level whose template was deleted keeps playing.
     */
    | { kind: "spawn"; templateId: string; x: number; y: number;
        /**
         * The velocity to bring it into the world MOVING with, and the thing that makes it a BODY.
         *
         * WHY THE COMMAND CARRIES THIS AND NOT THE DERIVE. `worldFrom` establishes bodies ONCE, at
         * Play, so a node that appears later never becomes one — and `applySpawns` cannot fix that,
         * because it returns a DOCUMENT. Letting a derive write to `world.bodies` would give the
         * runtime a second producer of world state; `stepWorld` and `applyCommands` are the only
         * two, and that is what makes a run replayable from its inputs.
         *
         * THE RULE DECIDES, because the rule has the document: it reads the template's `bodyType`
         * and asks for a body or does not. The channel stays ignorant, exactly as it is about what
         * a stomp means.
         */
        body?: { vx: number; vy: number } };

/**
 * A world with the commands applied, in array order.
 *
 * APPLIED PER STEP, NOT PER FRAME, and the caller must honour that: a frame may earn five steps, and
 * batching the commands to the end of it delays every bounce by up to four steps. Measured on a
 * stomp-and-bounce: per-step and per-frame land the hero 14.25px apart.
 *
 * DESPAWN WINS OVER A LATER setVelocity ON THE SAME BODY, because it must — the body is gone, and
 * reading `world.bodies` fresh per command rather than from the map being built is what leaves a
 * body in `bodies` AND `despawned` at once: an invisible thing with full physics.
 *
 * Returns the SAME world when there is nothing to do, so an ordinary step costs nothing.
 */
export function applyCommands(world: WorldState, commands: readonly RuntimeCommand[]): WorldState {
    if (commands.length === 0) return world;
    let bodies: Map<string, Body> | null = null;
    let despawned: Set<string> | null = null;
    let cells: Map<string, number> | null = null;
    let clocks: Map<string, number> | null = null;
    let spawns: { id: string; templateId: string; x: number; y: number }[] | null = null;
    let outcome: RunOutcome | null = null;
    for (const c of commands) {
        if (c.kind === "endRun") {
            // FIRST ONE WINS, and the world's own is checked too: nothing may un-end a run.
            if (outcome === null && world.outcome === "running") outcome = c.outcome;
            continue;
        }
        if (c.kind === "spawn") {
            // NAMES NO BODY EITHER, so it goes above the lookup with setCell. The id is the INDEX,
            // which is what makes a replayed run produce the same ids.
            if (!spawns) spawns = [...world.spawns];
            const id = c.templateId + "#" + spawns.length;
            spawns.push({ id, templateId: c.templateId, x: c.x, y: c.y });
            // A SPAWN THAT ASKED TO MOVE BECOMES A BODY, minted with the same defaults `worldFrom`
            // gives every other one — at the position the spawn named, on nothing, with grip.
            if (c.body) {
                if (!bodies) bodies = new Map(world.bodies);
                bodies.set(id, { x: c.x, y: c.y, vx: c.body.vx, vy: c.body.vy,
                    onGround: false, groundFriction: 1, blockedX: false,
                    facing: c.body.vx < 0 ? -1 : 1, travelled: 0, power: 0 });
            }
            continue;
        }
        if (c.kind === "setCell") {
            // BEFORE THE BODY LOOKUP, because this command names no body — the guard below would
            // drop every one of them.
            if (!cells) cells = new Map(world.cells);
            cells.set(cellKey(c.nodeId, c.col, c.row), c.tile);
            continue;
        }
        if (c.kind === "startCellClock") {
            const key = cellKey(c.nodeId, c.col, c.row);
            // Idempotent by contract — see the command's docstring.
            if (!(clocks ?? world.cellClocks).has(key)) {
                if (!clocks) clocks = new Map(world.cellClocks);
                clocks.set(key, world.time);
            }
            continue;
        }
        if (c.kind === "despawn") {
            // ABOVE THE BODY LOOKUP SINCE SPAWNING (M18). A spawned REGION is not a body — bodies
            // are established once, by `worldFrom`, at Play — so the guard below dropped every
            // attempt to take one away, and a coin could be made and never collected. Despawn is
            // about a NODE leaving the run, and only some nodes are bodies.
            if (!despawned) despawned = new Set(world.despawned);
            despawned.add(c.bodyId);
            const had = (bodies ?? world.bodies).get(c.bodyId);
            if (had) {
                if (!bodies) bodies = new Map(world.bodies);
                bodies.delete(c.bodyId);
            }
            continue;
        }
        // ACCUMULATING MAP, never `world.bodies` — see above.
        const live = bodies ?? world.bodies;
        const body = live.get(c.bodyId);
        if (!body) continue;                       // already gone, or never a body
        if (c.kind === "setPower") {
            if (body.power === c.power) continue;  // nothing to change, so nothing is copied
            if (!bodies) bodies = new Map(world.bodies);
            bodies.set(c.bodyId, { ...body, power: c.power });
            continue;
        }
        if (c.vx === undefined && c.vy === undefined) continue;
        if (!bodies) bodies = new Map(world.bodies);
        bodies.set(c.bodyId, {
            ...body,
            vx: c.vx ?? body.vx,
            vy: c.vy ?? body.vy,
            // A body given an upward velocity is NOT on the ground any more, and saying so here is
            // what stops the next step's jump gate from handing out a second jump off the bounce.
            onGround: (c.vy !== undefined && c.vy < 0) ? false : body.onGround
        });
    }
    if (!bodies && !despawned && !outcome && !cells && !spawns && !clocks) return world;
    return {
        ...world,
        cells: cells ?? world.cells,
        cellClocks: clocks ?? world.cellClocks,
        spawns: spawns ?? world.spawns,
        bodies: bodies ?? world.bodies,
        despawned: despawned ?? world.despawned,
        outcome: outcome ?? world.outcome
    };
}

/**
 * The document with each body MIRRORED to face the way it is going — the `applyFrame` move again,
 * for a different question.
 *
 * A SIBLING OF `applyWorld` RATHER THAN PART OF IT, because they answer different questions to
 * different readers: `applyWorld` says where the bodies are and is consumed by the camera, the dirty
 * set and every downstream derivation, while this says which way they point and is consumed by
 * nothing but the renderer. Keeping them apart is what lets a caller take one without the other.
 *
 * THE MAGNITUDE IS THE AUTHOR'S, THE SIGN IS THE RUN'S. A node scaled 2x stays 2x; only which side
 * of zero it sits on belongs to the runtime, so an artist's scale survives being played.
 *
 * IT CANNOT MOVE ANYTHING. A negative `scaleX` about the default origin leaves the axis-aligned box
 * identical, so nothing derived from bounds — the camera, `contentBounds`, the level extent the run
 * lifecycle uses as its death plane — can shift because a character turned around. That was checked
 * rather than assumed: a pose that changed a node's BOX would feed back into policy through
 * `contentBounds` and move the death plane, which is why the frame half of this is not here yet.
 */
/**
 * The document with every cell this run has CHANGED stamped onto a copy.
 *
 * A SIBLING OF `applyWorld`, and the same bargain: the STORED level is never touched, so Stop
 * restores it and a run leaves nothing on the undo stack. `applyWorld` stamps positions and the
 * `hidden` flag; this stamps tiles.
 *
 * THE SAME REFERENCE WHEN NOTHING CHANGED, which is every document until a rule bumps something —
 * this runs on every frame of every run and a tilemap's `tiles` array is thousands of entries, so
 * copying one speculatively would be the most expensive thing in the loop.
 *
 * A CHANGE TO A CELL THAT NO LONGER EXISTS IS INERT — a tilemap deleted or resized mid-run leaves
 * the override naming nothing, and naming nothing does nothing. The dangling-reference rule this
 * schema follows everywhere, and the alternative is a run that throws because a level was edited.
 */
/**
 * The document with everything this run has SPAWNED materialised into it.
 *
 * THE ONE DERIVE THAT MUST RUN BEFORE THE STEP, and it inverts the pattern the other four follow.
 * `applyWorld`, `applyFacing`, `applyPose` and `applyCells` all run AFTER `stepWorld` and feed only
 * the picture. A spawned node fed that way would be DRAWN and invisible to the physics: not a
 * solid, not a region, not collidable — because the step reads the document it is given, and that
 * document would not contain it. So the caller steps against `applySpawns(base, world)`.
 *
 * AND NOTHING CACHES, which is what makes that affordable: `stepWorld` re-derives its solids and
 * regions from the document every step, so a node that appears between two steps takes part in the
 * next one with no invalidation to arrange.
 *
 * A COPY OF A TEMPLATE, placed. The template keeps its own type, style, source rect and everything
 * else the schema grows later; only the id and the position are the run's. It is COPIED BY SPREAD
 * rather than rebuilt field by field — the sixth instance of that bug in this codebase was a
 * document that lost its tilesets, and a spawner that enumerated would drop whatever was added next.
 *
 * A MISSING TEMPLATE SPAWNS NOTHING, inertly, and so does one that is itself spawned: a template
 * naming a template would let one bump fill the level.
 */
export function applySpawns(doc: ReadonlyDocument, world: WorldState): ReadonlyDocument {
    if (world.spawns.length === 0) return doc;
    let nodes: Map<string, Node> | null = null;
    const roots: string[] = [];
    for (const s of world.spawns) {
        const template = doc.nodes.get(s.templateId) as Node | undefined;
        // A DESPAWNED SPAWN IS NOT MATERIALISED, which is how a collected coin goes away. Stamping
        // `hidden` the way `applyWorld` does would leave it in the scene as an invisible region,
        // still reporting enters; never making it is the honest removal.
        if (world.despawned.has(s.id)) continue;
        if (!template || (nodes ?? doc.nodes).has(s.id)) continue;
        if (!nodes) nodes = new Map(doc.nodes as ReadonlyMap<string, Node>);
        nodes.set(s.id, {
            ...template,
            id: s.id,
            // A SPAWNED THING IS A ROOT. Keeping the template's parent would put it inside a frame
            // whose offset it was never positioned against, and `worldOffsetOf` would then compose
            // that offset a second time — the exact defect slice 6 was written to fix.
            parent: null,
            children: [],
            // A TEMPLATE IS HIDDEN BECAUSE IT IS A TEMPLATE, and its instances are not. Copying the
            // flag through made every spawn invisible — `dropHidden` takes a hidden node out of the
            // scene entirely — so the one way to keep a template out of the picture also stopped
            // anything it spawned from appearing. Measured, not assumed: the spread copies every
            // field, which is exactly what it is for, and this is the one field that must not be.
            hidden: undefined,
            geometry: { ...template.geometry, x: s.x, y: s.y }
        } as Node);
        roots.push(s.id);
    }
    if (!nodes) return doc;
    return { ...(doc as ProjectDocument), nodes,
             rootNodeUuids: [...doc.rootNodeUuids, ...roots] } as ReadonlyDocument;
}

export function applyCells(doc: ReadonlyDocument, world: WorldState): ReadonlyDocument {
    if (world.cells.size === 0) return doc;
    let nodes: Map<string, Node> | null = null;
    for (const [key, tile] of world.cells) {
        const sep = key.indexOf("\u0000");
        const nodeId = key.slice(0, sep);
        const rest = key.slice(sep + 1).split("\u0000");
        const col = Number(rest[0]), row = Number(rest[1]);
        const node = (nodes ?? doc.nodes).get(nodeId) as Node | undefined;
        const map = node?.tilemap as ReadonlyTilemap | undefined;
        if (!node || !map) continue;
        const i = row * map.cols + col;
        if (i < 0 || i >= map.tiles.length || map.tiles[i] === tile) continue;
        if (!nodes) nodes = new Map(doc.nodes as ReadonlyMap<string, Node>);
        const tiles = [...map.tiles];
        tiles[i] = tile;
        nodes.set(nodeId, { ...node, tilemap: { ...map, tiles } } as Node);
    }
    if (!nodes) return doc;
    return { ...(doc as ProjectDocument), nodes } as ReadonlyDocument;
}

export function applyFacing(doc: ReadonlyDocument, world: WorldState): ReadonlyDocument {
    let nodes: Map<string, Node> | null = null;
    for (const [id, body] of world.bodies) {
        const node = doc.nodes.get(id);
        if (!node) continue;
        const authored = node.transform?.scaleX ?? 1;
        // `|authored|` because the sign is ours and the size is not; a node authored mirrored has a
        // magnitude of 1 either way, so it simply faces the run's direction like everything else.
        const want = body.facing * Math.abs(authored);
        if (authored === want) continue;
        if (!nodes) nodes = new Map(doc.nodes as ReadonlyMap<string, Node>);
        nodes.set(id, { ...(node as Node),
            transform: { ...(node.transform ?? {}), scaleX: want } } as Node);
    }
    if (!nodes) return doc;
    return { ...(doc as ProjectDocument), nodes } as ReadonlyDocument;
}

/**
 * Which ids `applyFacing` would flip — the dirty set's other half.
 *
 * WITHOUT THIS THE MIRROR IS DRAWN ONCE AND NEVER AGAIN. `movedIds` names bodies whose POSITION
 * differs, and a character that turns around while standing still has not moved a pixel, so the
 * incremental geometry path would keep the old matrix for ever. Exactly the shape of the two stale
 * geometry bugs this runtime has already paid for.
 *
 * SPAWNS FIRST, for the reason `movedIds` gives at length: a thrown enemy that turns around has a
 * node in no stored document, so asking one would leave it facing the way it was thrown for ever.
 */
export function facedIds(doc: ReadonlyDocument, world: WorldState): Set<string> {
    const live = applySpawns(doc, world);
    const out = new Set<string>();
    for (const [id, body] of world.bodies) {
        const node = live.nodes.get(id);
        if (!node) continue;
        const authored = node.transform?.scaleX ?? 1;
        if (authored !== body.facing * Math.abs(authored)) out.add(id);
    }
    return out;
}

/**
 * The dirty set the incremental geometry path wants: every id whose DRAWN position differs from the
 * one the previous frame drew.
 *
 * `previous` IS NOT OPTIONAL IN SPIRIT, and omitting it was a defect that shipped. This asked "does
 * the world disagree with the STORED document", but a dirty set has to answer "did this frame's
 * geometry change since the LAST one" — and those differ in exactly one case, which a platformer
 * hits every time anybody jumps. A body that leaves its authored position and comes back is
 * identical to the stored document on the frame it lands, so it was named on every frame of the
 * flight and NOT on the frame it arrived; `computeGeometry` therefore reused the previous frame's
 * entry and drew it mid-air, permanently, because it never moves again. Measured on a 72px jump
 * onto a floor at y=400: **6px of divergence from a full recompute, from step 49 onward, forever.**
 *
 * The union is the whole fix. An id belongs in the set if it differs from the stored document NOW
 * (it moved) or differed LAST frame (it moved back). If neither holds it has been sitting still at
 * its authored position and there is nothing to redraw.
 *
 * Same family as the Play/Stop reuse bug this file already records — a stale geometry chain showing
 * a body where it used to be, invisible to every test because the DOCUMENT was right the whole time.
 *
 * ASKED AGAINST THE DOCUMENT THE FRAME DRAWS, which is why `applySpawns` runs here. A spawned body's
 * node exists in NO stored document — it is minted by `applySpawns` for the picture and thrown away
 * with the run — so a caller holding the stored one gets "no such node, nothing to say" for every
 * spawn, and the incremental geometry keeps the matrix it first drew. Measured in the running app:
 * a coin thrown out of a block arced through its whole flight in the world and sat motionless on
 * screen for all of it. The FIFTH stale-dirty-set defect here, and the first where the node the set
 * was asked about did not exist yet — so the fix is inside rather than at the call site, because a
 * question no caller can ask wrongly is the only kind that stops coming back.
 *
 * PASS THE STORED DOCUMENT. This materialises the spawns itself, and handing it one that already
 * has them would overwrite the positions `applyWorld` just stamped with the spawn points they were
 * thrown from — every spawn would then read as "moved" on every frame for ever.
 *
 * It costs nothing when nothing has spawned: `applySpawns` returns the document itself.
 */
export function movedIds(doc: ReadonlyDocument, world: WorldState,
                         previous?: WorldState): Set<string> {
    const live = applySpawns(doc, world);
    const out = new Set<string>();
    const differs = (id: string, body: Body) => {
        const node = live.nodes.get(id);
        if (!node) return false;
        const at = worldOffsetOf(live, id);
        if (!at) return false;
        return node.geometry.x !== body.x - at.dx || node.geometry.y !== body.y - at.dy;
    };
    for (const [id, body] of world.bodies) if (differs(id, body)) out.add(id);
    if (previous) {
        for (const [id, body] of previous.bodies) if (differs(id, body)) out.add(id);
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
