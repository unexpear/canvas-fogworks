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
    JUMP_HEIGHT, DEFAULT_GRAVITY, RuntimeCommand, WorldState, jumpSpeedFor
} from "./World";
import { partOf } from "./Parts";

/** What the rules need that the world does not carry: which body the player drives. */
export interface RuleContext {
    controlled: string | null;
    /**
     * The level's extent, for the one ending that no part can declare: falling out of the world.
     *
     * A LEVEL HAS NO EDGE OF ITS OWN — nothing in the document says "the level stops here" — so the
     * caller supplies the content's bounds, which is the same rectangle the camera already refuses
     * to scroll past. Absent means no floor of last resort, which is what the runtime did before.
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

    // ── STOMPS ───────────────────────────────────────────────────────────────────────────────────
    const me = ctx.controlled;
    if (!me) return out;                        // a run driving nothing has nothing else to decide

    // ── FALLING OUT OF THE WORLD ─────────────────────────────────────────────────────────────────
    // THE ONE ENDING NO PART CAN DECLARE, because it is the absence of parts. A body below the
    // level's bottom is gone: it will never come back, terminal velocity is 1200 px/s, and the run
    // that produced this rule had reached y=4658 with nothing to do but press Stop.
    //
    // ONE BODY HEIGHT OF SLACK, so standing on the very lowest floor is not death. `bounds` is the
    // CONTENT's extent, so its bottom edge is the underside of the lowest thing in the level.
    const body = world.bodies.get(me);
    const node = doc.nodes.get(me);
    if (body && node && ctx.bounds) {
        if (body.y > ctx.bounds.y + ctx.bounds.height + node.geometry.height) {
            out.push({ kind: "endRun", outcome: "lost" });
            return out;                          // nothing that happened this step outlives the fall
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
            out.push({ kind: "setVelocity", bodyId: me,
                vy: -jumpSpeedFor(JUMP_HEIGHT, ctx.gravity ?? DEFAULT_GRAVITY) });
        }
    }

    // ── TOUCHING SOMETHING THAT ENDS THE RUN ─────────────────────────────────────────────────────
    // READ AFTER THE STOMP, and that ordering is the rule rather than an accident: a part may be
    // BOTH deadly and stompable — which is exactly what a Goomba is — and landing on it must win.
    // A stomp despawns it, so by the time this loop runs the killing contact is the one that came
    // from any side but above.
    const stomped = new Set(
        out.flatMap(c => (c.kind === "despawn" ? [c.bodyId] : [])));
    for (const e of world.events) {
        if (e.bodyId !== me) continue;
        // A GOAL MAY BE EITHER, because a flagpole is a volume you reach and a coin is a thing you
        // touch, and nothing in the corpus decides which shape a level author will reach for.
        if (e.kind === "enter" || e.kind === "contact") {
            const other = doc.nodes.get(e.nodeId);
            if (!other) continue;
            const part = partOf(other);
            if (part.goal) { out.push({ kind: "endRun", outcome: "won" }); return out; }
            if (part.deadly && e.side !== "below" && !stomped.has(e.nodeId)) {
                out.push({ kind: "endRun", outcome: "lost" });
                return out;
            }
        }
    }
    return out;
}
