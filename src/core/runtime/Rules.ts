/**
 * @module Rules
 * @description Mario's rules, as a replaceable policy over runtime events (M18 slice 10, rewritten
 * onto the parts vocabulary in slice 12).
 *
 * THIS MODULE IS A GAME, NOT AN ENGINE, and the separation is the point of it existing at all.
 * `World` reports what happened and `applyCommands` is the channel by which anything may answer;
 * neither knows what a stomp is. This file is the first CALLER of that channel, and it is here
 * rather than in `App` because the Mario clone is a probe for what the engine is missing — a rule
 * buried in a React component teaches the engine nothing and cannot be tested without a DOM.
 *
 * IT NOW READS DECLARATIONS RATHER THAN GUESSING FROM A CLASS. Slice 10 treated `className !== ""`
 * as "authored as an actor": the corpus's measured disjointness (51 objects carry a bodyType and no
 * class, 26 a class and no bodyType, none both) pressed into service as a marker it never was. A
 * part now says what it is — see `core/runtime/Parts` for why a declaration beats both a hard-coded
 * rule and a class-to-behaviour table. The class is back to being a NAME.
 *
 * WHAT IS INVENTED HERE, said plainly:
 *   - that landing on a stompable part should remove it. Nothing in the corpus says a thing may be
 *     removed; `stomp`, `kill`, `damage`, `hurt` and `squash` are zero across all 65 Tiled files.
 *   - that the bounce is exactly a jump's height. It adds no new constant, which is slice 4's
 *     standard — but "as high as a jump" is taste rather than data, and it is higher than most
 *     platformers choose. Said here so it is a decision rather than a discovery.
 *
 * WHAT THIS DELIBERATELY IS NOT: no death, no damage, no score, no lives, no respawn, no coins
 * collected, no level transition. Walking into an enemy does nothing at all. Death in particular is
 * not one rule but a SYSTEM — it needs a respawn point, a run that can restart, and a decision about
 * what happens to the level — and stapling a despawn onto the player would be the guess dressed as a
 * feature this project keeps refusing.
 */
import { ReadonlyDocument } from "../document/Document";
import {
    DEFAULT_GRAVITY, RuntimeCommand, WorldState, jumpLaunchSpeed, propertyOf, worldOffsetOf, bodyTypeOf, cellKey, jumpSpeedFor } from "./World";
import { partOf, PART_PREFIX } from "./Parts";
import { findTileset, tilesetTile } from "../document/Tileset";
import { tileAt } from "../document/Tilemap";

/** What the rules need that the world does not carry: which body the player drives. */
export interface RuleContext {
    controlled: string | null;
    /**
     * The level's extent, for the one ending that no part can declare: falling out of the world.
     *
     * A LEVEL'S EDGE IS `playBounds` — the content's measured extent, unless the document DECLARES
     * a screen (schema 72), which pins the vertical span. The caller supplies it, and it is the
     * same rectangle the camera refuses to scroll past — one edge of the world, not two. Absent
     * means no floor of last resort, which is what the runtime did before.
     */
    bounds?: { x: number; y: number; width: number; height: number } | null;
    /** Matches `stepWorld`'s, so a level with a different gravity keeps the bounce proportionate. */
    gravity?: number;
}

/**
 * The commands Mario's rules would issue for the step that produced `world`.
 *
 * PURE, AND A FUNCTION OF THE DOCUMENT AND THE EVENTS — no clock, no camera, no randomness — so a
 * run stays reproducible from its inputs and this is testable with literal numbers.
 *
 * ONE STOMP PER STEP PER TARGET: the events it reads are already EDGES (`contact` fires once for a
 * pair, not on every frame they overlap), so the rule inherits that and cannot fire twice for one
 * landing. Two parts landed on in the same step give two despawns and ONE bounce, because a velocity
 * is a state rather than an accumulation.
 */
export function marioRules(
    doc: ReadonlyDocument, world: WorldState, ctx: RuleContext
): RuntimeCommand[] {
    const out: RuntimeCommand[] = [];
    // A FINISHED RUN DECIDES NOTHING FURTHER. Not an optimisation: without it a dead player keeps
    // patrolling enemies, keeps stomping, and keeps re-reporting its own death every step.
    if (world.outcome !== "running") return out;

    // ── PARTS THAT WALK ──────────────────────────────────────────────────────────────────────────
    // Every step, not only on an event: a walk is a STATE the part is in, unlike a stomp, which is
    // a thing that happened. The velocity is SET rather than accumulated, for the same reason the
    // player's walk is set — a speed you have, not a speed you build up.
    //
    // THE TURN IS `blockedX`, the fact the physics already had and threw away. Reversing on "it did
    // not move as far as it should" would be a different question with a different answer in a
    // corner, and reversing at a LEDGE is deliberately absent: Mario's own goombas walk off ledges.
    for (const [id, body] of world.bodies) {
        const node = doc.nodes.get(id);
        if (!node) continue;
        const speed = partOf(node).patrol;
        if (speed === null || speed === 0) continue;
        // The SIGN of the current velocity is the direction, so the part needs no memory of its own.
        // At rest it starts in the direction its declared speed names.
        const dir = body.vx === 0 ? Math.sign(speed) : Math.sign(body.vx);
        const turned = body.blockedX ? -dir : dir;
        out.push({ kind: "setVelocity", bodyId: id, vx: turned * Math.abs(speed) });
    }

    // ── PARTS THAT BOUNCE (M18 slice 36) ────────────────────────────────────────────
    // SMB1's star is a body that never rests: every landing sets the upward speed again
    // (`EnemyJump` writes the Y speed on every touch-down). The declaration is an apex HEIGHT and
    // the speed is derived through the same identity every jump uses — no constant of its own.
    // ON LANDING ONLY: firing while airborne would re-launch sixty times a second and the body
    // would simply fly. Composes with `vde.patrol`, which sets vx every step, airborne included.
    for (const [id, body] of world.bodies) {
        if (!body.onGround) continue;
        const node = doc.nodes.get(id);
        if (!node) continue;
        const apex = partOf(node).bounces;
        if (apex === null || apex <= 0) continue;
        out.push({ kind: "setVelocity", bodyId: id, vy: -jumpSpeedFor(apex, ctx.gravity ?? DEFAULT_GRAVITY) });
    }

    // ── STOMPS ───────────────────────────────────────────────────────────────────────────────────
    const me = ctx.controlled;
    if (!me) return out;                        // a run driving nothing has nothing else to decide

    // ── FALLING OUT OF THE WORLD ─────────────────────────────────────────────────────────────────
    // THE ONE ENDING NO PART CAN DECLARE, because it is the absence of parts. A body below the
    // level's bottom is gone: it will never come back, terminal velocity is 1200 px/s, and the run
    // that produced this rule had reached y=4658 with nothing to do but press Stop.
    //
    // ONE BODY HEIGHT OF SLACK, so standing on the very lowest floor is not death. `bounds` is
    // `playBounds` — the content's extent, unless the document DECLARES a screen (schema 72), in
    // which case the bottom edge is the screen's and decoration drawn below it kills nothing.
    const body = world.bodies.get(me);
    const node = doc.nodes.get(me);
    if (body && node && ctx.bounds) {
        if (body.y > ctx.bounds.y + ctx.bounds.height + node.geometry.height) {
            out.push({ kind: "endRun", outcome: "lost" });
            return out;                          // nothing that happened this step outlives the fall
        }
    }

    // ── BUMPING A BLOCK ──────────────────────────────────────────────────────────────────────────
    // THE TILE SAYS WHAT IT BECOMES, which is the parts vocabulary applied one level down. A `?`
    // block declares `vde.bumpsTo` on its TILESET entry and the rule reads it — so no index is
    // hard-coded here, a level can use any sheet, and a brick that declares nothing simply does not
    // change. `TilesetTile.userData` is already how a tile declares its bodyType, so this adds a
    // word to a vocabulary rather than a channel.
    //
    // IT ALSO PUTS SOMETHING OUT, since slice 25 — see `vde.spawns` below. This comment used to end
    // "what this still cannot do is put a coin above the block", which was true for exactly one
    // slice; leaving it would have been a lie in the source, which is worse than no comment.
    for (const e of world.events) {
        if (e.kind !== "bump" || e.bodyId !== me || e.cell === undefined) continue;
        const node = doc.nodes.get(e.nodeId);
        const map = node?.tilemap;
        if (!map) continue;
        const set = findTileset(doc.tilesets, map.tilesetId);
        const tile = set ? tilesetTile(set, tileAt(map, e.cell.col, e.cell.row)) : null;
        const becomes = tile ? propertyOf(tile.userData, PART_PREFIX + "bumpsTo") : null;
        const index = becomes === null ? NaN : Number(becomes.trim());
        // `Number("")` IS 0 AND FINITE, and 0 is a real tile index — so an empty declaration would
        // silently turn a bumped block into tile zero. The trap this project has already paid for
        // twice, checked rather than remembered.
        if (becomes !== null && becomes.trim() !== "" && Number.isFinite(index)) {
            // A MULTI-PAY BLOCK (M18 slice 35): `vde.paysFor` is a payout window in SECONDS from
            // the FIRST hit — every hit inside it pays WITHOUT converting, and the first hit past
            // it pays AND converts. The numbers are the disassembly's, derived not quoted:
            // BrickCoinTimer = $0B ticks of an interval timer that fires every 21 frames, so
            // 231 frames = 3.85s — the level declares that, not this file. Absent means the block
            // converts on its first hit, which is every block authored before this slice.
            //
            // ONE DECLARED DIVERGENCE: SMB1's timer flag is GLOBAL — every coin brick in an area
            // joins one countdown, hit any of them — which is one flag byte's quirk, not a design.
            // Ours is per cell, and the clock starts idempotently through the channel.
            const paysFor = tile ? propertyOf(tile.userData, PART_PREFIX + "paysFor") : null;
            const window = paysFor === null ? NaN : Number(paysFor.trim());
            const clock = world.cellClocks.get(cellKey(e.nodeId, e.cell.col, e.cell.row));
            const paying = Number.isFinite(window) && window > 0
                && (clock === undefined || world.time - clock < window);
            if (paying) {
                out.push({ kind: "startCellClock", nodeId: e.nodeId, col: e.cell.col, row: e.cell.row });
            } else {
                out.push({ kind: "setCell", nodeId: e.nodeId, col: e.cell.col, row: e.cell.row, tile: index });
            }
            // …AND WHAT IT PUTS OUT. `vde.spawns` names a TEMPLATE node the author made in the
            // editor, so this rule invents no geometry and no node shape — it places a copy, one
            // cell above the block that was hit, which is where a coin goes.
            const spawns = tile ? propertyOf(tile.userData, PART_PREFIX + "spawns") : null;
            if (spawns !== null && spawns.trim() !== "") {
                const origin = worldOffsetOf(doc, e.nodeId);
                if (origin) {
                    // A TEMPLATE THAT DECLARES A bodyType COMES OUT MOVING. The rule reads that
                    // here because it has the document and the channel does not; a template that
                    // declares none is a region and simply appears, which is what a coin sitting
                    // in a niche is. The pop is a jump's launch speed, so it adds no constant.
                    const template = doc.nodes.get(spawns.trim());
                    const moves = template !== undefined && bodyTypeOf(template) === "dynamic";
                    out.push({ kind: "spawn", templateId: spawns.trim(),
                        x: origin.dx + node!.geometry.x + e.cell.col * map.tileWidth,
                        y: origin.dy + node!.geometry.y + (e.cell.row - 1) * map.tileHeight,
                        ...(moves ? { body: { vx: 0, vy: -jumpLaunchSpeed(ctx.gravity ?? DEFAULT_GRAVITY) } } : {}) });
                }
            }
            continue;   // CONTENTS WIN: a block that pays out never also breaks — SMB1's coin
                        // brick pops its coin and becomes spent, even under a Super bumper.
        }
        // ── BREAKING (M18 slice 34) — Mario's own eligibility, all three clauses ──────────────
        // A tile BREAKS only when: it DECLARES `vde.breaks` (bricks do, ? blocks never do, and a
        // spent block's own tile declares nothing, so it is inert however hard it is hit); it has
        // NO CONTENTS this hit should deliver — checked above, contents win; and the bumper's
        // POWER is above small. A small player bumping a brick gets nothing at all, which is the
        // "can also give nothing" case — SMB1 jiggles the brick, and the jiggle is a cosmetic gap
        // stated here rather than half-built.
        //
        // BREAKING IS `setCell` TO EMPTY — the run's override, never the file. -1 has no tileset
        // entry, so the cell stops drawing AND stops being solid the moment the step reads the
        // stamped document; Stop restores the brick like every other override.
        const breaks = tile ? propertyOf(tile.userData, PART_PREFIX + "breaks") : null;
        if (breaks !== null && breaks.trim() !== "" && breaks.trim() !== "false"
            && (world.bodies.get(me)?.power ?? 0) > 0) {
            out.push({ kind: "setCell", nodeId: e.nodeId, col: e.cell.col, row: e.cell.row, tile: -1 });
        }
    }

    // ── COLLECTING ───────────────────────────────────────────────────────────────────────────────
    // A PART SAYS IT CAN BE PICKED UP, rather than a class table saying `coin` means collectible —
    // the same refusal `Parts` was built on, and the corpus's twelve coin objects carry zero
    // properties between them, so their word could not have meant anything anyway.
    //
    // `enter` OR `contact`, because a collectible may be either shape and the author chooses which.
    // A coin sitting in a niche declares no `bodyType` and is a REGION, so touching it is an enter;
    // a coin thrown out of a block declares `dynamic` and is a BODY, so touching it is a contact.
    // Reading only enters made the second kind uncollectable the moment slice 27 let it move — the
    // deadly and goal rules below already accept both, for exactly this reason.
    //
    // BOTH ARE ALREADY EDGES: a region reports entering once rather than on all sixty frames the
    // body spends inside it, and a contact fires once per pair. So this cannot fire twice for one
    // pickup without a set to remember it.
    //
    // AND THE SIDE DOES NOT MATTER, unlike a stomp. Walking into a coin collects it; there is no
    // way to touch one that should not.
    for (const e of world.events) {
        if (e.kind !== "enter" && e.kind !== "contact") continue;
        if (e.bodyId !== me) continue;
        const got = doc.nodes.get(e.nodeId);
        if (got && partOf(got).collectible) {
            out.push({ kind: "despawn", bodyId: e.nodeId });
            // …AND WHAT COLLECTING IT GRANTS (M18 slice 34). `vde.powers` names a TIER, and the
            // SMB1 arithmetic lives here, not in the channel: the HIGHER tier is kept, so a
            // mushroom collected by Fire Mario grants nothing and a flower collected by small
            // grants everything. The command carries the absolute result.
            const powers = partOf(got).powers;
            const held = world.bodies.get(me)?.power ?? 0;
            if (powers !== null && powers > held) {
                out.push({ kind: "setPower", bodyId: me, power: powers });
            }
            // …INVINCIBILITY, for the part's own declared seconds (M18 slice 36). The rule owns
            // the arithmetic — now + duration — and a fresh star simply moves the end time out.
            const stars = partOf(got).stars;
            if (stars !== null && stars > 0) {
                out.push({ kind: "setStar", bodyId: me, until: world.time + stars });
            }
            // …AND THE COUNT. A collected thing is TALLIED under its class — CoinTally's shape,
            // and the whole of what SMB1's 1-up pickup does. A classless collectible counts as
            // nothing, which is what having no name means.
            if (got.className) out.push({ kind: "tally", key: got.className });
        }
    }

    let bounced = false;
    for (const e of world.events) {
        // `contact` NAMES ANOTHER BODY; `enter` names a REGION and must not be read here, or the
        // player bounces off every coin, spike and exit it lands on — those are volumes, not things.
        if (e.kind !== "contact") continue;
        if (e.bodyId !== me) continue;          // reported to somebody else
        if (e.side !== "below") continue;       // walked into it, or was landed on
        const other = doc.nodes.get(e.nodeId);
        if (!other || !partOf(other).stompable) continue;
        out.push({ kind: "despawn", bodyId: e.nodeId });
        if (!bounced) {
            bounced = true;
            // THE SAME SPEED A JUMP LAUNCHES AT, which since slice 16 is the SHORTEST jump's speed
            // rather than the tallest's.
            //
            // AND THE KEY DOES NOT MAKE IT HIGHER, which is worth saying because the obvious guess
            // is the opposite one. A stomp requires falling onto the thing, `stepWorld`'s jump latch
            // closes the moment a body stops rising, and a closed latch means full gravity — so the
            // bounce is the same height whether the player is leaning on the button or not. That is
            // the original's behaviour too, for exactly the same reason: it dumps its falling
            // acceleration in on the frame the rise ends, and a stomp never reloads the rising one.
            // Nothing here had to know any of that; it falls out of `jumpCut`.
            out.push({ kind: "setVelocity", bodyId: me,
                vy: -jumpLaunchSpeed(ctx.gravity ?? DEFAULT_GRAVITY) });
        }
    }

    // ── TOUCHING SOMETHING THAT ENDS THE RUN ─────────────────────────────────────────────────────
    // A PART MAY BE BOTH DEADLY AND STOMPABLE — which is exactly what a Goomba is — and landing on
    // it must win. `e.side !== "below"` is the whole of that: an event whose side is `below` is the
    // one the stomp loop above already acted on.
    //
    // A SET OF WHAT WAS STOMPED WAS TRIED HERE AND DELETED as an EQUIVALENT mutant rather than
    // tested around. It could only ever hold a part the stomp loop despawned, which requires that
    // same event's side to be `below` — so it was implied by the line above it and guarded nothing,
    // while masking the mutant that removes the side check. Same shape as slice 7's `vy > 0`.
    for (const e of world.events) {
        if (e.bodyId !== me) continue;
        // A GOAL MAY BE EITHER, because a flagpole is a volume you reach and a coin is a thing you
        // touch, and nothing in the corpus decides which shape a level author will reach for.
        if (e.kind === "enter" || e.kind === "contact") {
            const other = doc.nodes.get(e.nodeId);
            if (!other) continue;
            const part = partOf(other);
            if (part.goal) { out.push({ kind: "endRun", outcome: "won" }); return out; }
            if (part.deadly && e.side !== "below") {
                // A STARRED PLAYER KILLS WHAT WOULD KILL IT (M18 slice 36) — SMB1's star, where
                // any contact destroys the enemy. The comparison is against the world's own clock,
                // so expiry needs no event: the first deadly touch past `star` is death as usual.
                const starred = (world.bodies.get(me)?.star ?? 0) > world.time;
                if (starred) {
                    out.push({ kind: "despawn", bodyId: e.nodeId });
                    continue;
                }
                out.push({ kind: "endRun", outcome: "lost" });
                return out;
            }
        }
    }
    return out;
}
