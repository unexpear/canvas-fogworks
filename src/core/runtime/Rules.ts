/**
 * @module Rules
 * @description Mario's rules, as a replaceable policy over runtime events (M18 slice 10).
 *
 * THIS MODULE IS A GAME, NOT AN ENGINE, and the separation is the point of it existing at all.
 * `World` reports what happened and `applyCommands` is the channel by which anything may answer;
 * neither knows what a stomp is. This file is the first CALLER of that channel, and it is here
 * rather than in `App` for the reason the test game exists in the first place: the Mario clone is a
 * probe for what the engine is missing, and a rule buried in a React component teaches the engine
 * nothing and cannot be tested without a DOM.
 *
 * SO THE RULE IS SHIPPED, LABELLED, AND REPLACEABLE. A different game writes a different function of
 * the same shape — events in, commands out, pure — and nothing below it changes.
 *
 * IT NEEDS NO CLASS SEMANTICS, which is the part worth keeping. The measurement is that the corpus
 * NAMES and does not DEFINE: twelve `coin` objects carry zero properties between them, as do four
 * `spikes`, two `blob`, one `enemy` and two `NPC`; `script` names a `.lua` that does not exist and
 * `map` names two `.json` files that do not exist; sticker-knight ships no game source. A
 * class-to-behaviour table would therefore be inventing semantics for words whose semantics were
 * MEASURED to be unrecoverable — strictly worse than inventing new words that mean what you say.
 * Mario's rule does not need one: "the body you drive touched another body, from above" is
 * expressible entirely in what the runtime already knows.
 *
 * WHAT IS INVENTED HERE, said plainly as rule 3 requires:
 *   - that landing on something should remove it. Nothing in the corpus says a thing may be removed;
 *     `stomp`, `kill`, `damage`, `hurt` and `squash` are zero across all 65 Tiled files.
 *   - that a class marks a body as an ACTOR rather than scenery. The disjointness is measured (51
 *     objects carry a bodyType and no class, 26 a class and no bodyType, NONE both) but reading the
 *     non-corpus COMBINATION as a deliberate marker is an INFERENCE from that measurement, not the
 *     measurement. It is the least-invented marker available and it is still invented. It earns its
 *     place by what it protects: the corpus's ONE dynamic body is an unclassed 96x96 block a player
 *     PUSHES, and without the marker this rule would delete it the first time anyone stood on it.
 *   - that the bounce is exactly a jump's height. This adds no new constant, which is slice 4's
 *     standard — but "as high as a jump" is taste rather than data, and it is higher than most
 *     platformers choose. Said here so it is a decision rather than a discovery.
 *
 * WHAT THIS DELIBERATELY IS NOT: no death, no damage, no score, no lives, no respawn, no coins
 * collected, no level transition. Walking into an enemy does nothing at all. Death in particular is
 * not one rule but a system — it needs a respawn point, a run that can restart, and a decision about
 * what happens to the level — and stapling a despawn onto the player would be the guess dressed as a
 * feature this project keeps refusing.
 */
import { JUMP_HEIGHT, DEFAULT_GRAVITY, RuntimeCommand, WorldState, jumpSpeedFor } from "./World";

/** What the rules need to know that the world does not carry: which body the player drives. */
export interface RuleContext {
    controlled: string | null;
    /** Matches `stepWorld`'s, so a level with a different gravity keeps the bounce proportionate. */
    gravity?: number;
}

/**
 * The commands Mario's rules would issue for the step that produced `world`.
 *
 * PURE, AND A FUNCTION OF THE EVENTS ALONE — no clock, no camera, no document, no randomness — so a
 * run is still reproducible from its inputs and this is testable with literal numbers.
 *
 * ONE STOMP PER STEP PER TARGET: the events it reads are already EDGES (`contact` fires once for a
 * pair, not on every frame they overlap), so the rule inherits that and cannot fire twice for one
 * landing. Two enemies landed on in the same step produce two despawns and ONE bounce, because a
 * velocity is a state rather than an accumulation.
 */
export function marioRules(world: WorldState, ctx: RuleContext): RuntimeCommand[] {
    const me = ctx.controlled;
    if (!me) return [];                         // a run driving nothing has no rules to apply
    const out: RuntimeCommand[] = [];
    let bounced = false;
    for (const e of world.events) {
        // `contact` NAMES ANOTHER BODY; `enter` names a REGION and must not be read here, or the
        // player bounces off every coin, spike and exit it lands on — those are volumes, not things.
        if (e.kind !== "contact") continue;
        if (e.bodyId !== me) continue;          // reported to somebody else
        if (e.side !== "below") continue;       // walked into it, or was landed on
        if (e.className === "") continue;       // scenery, not an actor — the pushable block is this
        out.push({ kind: "despawn", bodyId: e.nodeId });
        if (!bounced) {
            bounced = true;
            out.push({ kind: "setVelocity", bodyId: me,
                vy: -jumpSpeedFor(JUMP_HEIGHT, ctx.gravity ?? DEFAULT_GRAVITY) });
        }
    }
    return out;
}
