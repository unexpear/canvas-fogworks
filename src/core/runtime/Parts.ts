/**
 * @module Parts
 * @description What a PART declares about its own behaviour (M18 slice 12).
 *
 * THE THIRD ANSWER TO "WHERE DOES POLICY LIVE", after the first two were tried and rejected.
 * Hard-coding a rule in the app teaches the engine nothing and cannot be tested without a DOM. A
 * class-to-behaviour table is worse than that: it would invent semantics for words whose semantics
 * were MEASURED to be unrecoverable — `coin` appears on twelve objects carrying zero properties
 * between them, `script` names a `.lua` that does not exist, `map` names two `.json` files that do
 * not exist, and sticker-knight ships no game source at all. Inventing meanings for someone else's
 * undefined words is strictly worse than inventing words that mean what you say they mean.
 *
 * SO A PART CARRIES ITS OWN RULE. This is Super Mario Maker's shape rather than a level format's: a
 * goomba there is not a name the engine looks up, it is a part that brings its behaviour with it,
 * and the editor's palette IS the vocabulary. That makes the rules DATA authored in the editor,
 * which is what VDE already is.
 *
 * WHY THIS IS NOT "SCHEMA INVENTED AHEAD OF CONTENT", the charge that refused `core.entity`. That
 * charge is about inventing a shape and WAITING for content to justify it. The corpus cannot justify
 * this because the corpus is somebody else's imported level geometry; the content that uses this
 * vocabulary is content WE author, and it ships in the same commit as the vocabulary and the reader.
 * A declaration with no writer would be the `Document.clips` bug; this one has both.
 *
 * IT IS STILL AN INVENTION, and every entry says so. What it does NOT do is cost anything to a
 * document that never met it: `partOf` answers "declares nothing" for every node in the corpus and
 * for every document written before today, so those play exactly as they did. That is `oneway`'s
 * argument, and unlike slice 9's it genuinely transfers.
 *
 * THE VOCABULARY IS CLOSED AND SMALL, and both entries were named by the level rather than guessed.
 * Building the Kenney map into something playable produced a list of what the engine could not
 * express; these are the two that needed no new SYSTEM behind them:
 *
 *   - `vde.stompable` — landing on it from above removes it. This replaces an inference I disliked
 *     the moment I wrote it: slice 10 read `className !== ""` as "authored as an actor", which is
 *     the measured disjointness of the corpus pressed into service as a marker it never was. Now a
 *     part says so itself, and sticker-knight's unclassed push-block is safe because it DECLARES
 *     nothing rather than because of a heuristic about classes.
 *   - `vde.patrol` — it walks, at the declared speed, turning around when a wall stops it. Measured
 *     need: every enemy in the built level was a statue, because `worldFrom` starts every dynamic
 *     body at rest and nothing in the engine could give one a velocity.
 *
 * WHAT IS DELIBERATELY ABSENT: anything needing a SYSTEM rather than a rule. No death, no respawn,
 * no score, no doors, no spawners. The level's loudest gap is that a run cannot be lost or ended —
 * and that is not a part's declaration, it is a run lifecycle, which wants its own design.
 */
import { UserData } from "../document/Node";
import { propertyOf } from "./World";

/** The prefix that marks a property as VDE's own vocabulary rather than an imported file's. */
export const PART_PREFIX = "vde.";

/**
 * What a part says about itself. Every field's absence is the default, and the default is inert.
 */
export interface Part {
    /** Landing on it from above removes it, and launches whoever landed. */
    stompable: boolean;
    /**
     * It walks on its own at this many pixels a second, reversing when a wall stops it.
     *
     * Null means it does not walk. Zero is NOT null — a part declaring `0` has asked to stand still
     * and should keep standing still rather than fall back to some default.
     */
    patrol: number | null;
}

/** A part that declares nothing — what every node in the corpus and every older document is. */
export const INERT: Part = { stompable: false, patrol: null };

/**
 * What this node declares, read LENIENTLY for the reason the whole runtime reads leniently: the same
 * property name arrives typed and untyped in one corpus file, so demanding a declared type would
 * drop more than half of real data.
 *
 * AN UNKNOWN `vde.` KEY IS IGNORED rather than refused. A part authored by a newer build lands in an
 * older one as decoration, which is the same bargain `bodyTypeOf` strikes for an unknown body type.
 */
export function partOf(node: { userData?: UserData }): Part {
    const stomp = propertyOf(node.userData, PART_PREFIX + "stompable");
    const patrol = propertyOf(node.userData, PART_PREFIX + "patrol");
    return {
        // "false" and "0" and "" all mean NO. Anything else present means yes, because a part that
        // bothered to declare the key wants the behaviour.
        stompable: stomp !== null && truthy(stomp),
        patrol: speedOf(patrol)
    };
}

/** Does this document declare ANY part behaviour? One pass, for a caller deciding whether to bother. */
export function hasParts(nodes: Iterable<{ userData?: UserData }>): boolean {
    for (const n of nodes) {
        const p = partOf(n);
        if (p.stompable || p.patrol !== null) return true;
    }
    return false;
}

function truthy(raw: string): boolean {
    const v = raw.trim().toLowerCase();
    return v !== "" && v !== "false" && v !== "0" && v !== "no";
}

/**
 * A declared speed, or null.
 *
 * `Number("")` IS 0 AND FINITE — the trap this project has already paid for once, in `frictionOf`,
 * where an empty property value became ice. An empty declaration is not a speed of zero; it is a
 * part that failed to say anything, and it must read as null.
 */
function speedOf(raw: string | null): number | null {
    if (raw === null) return null;
    const t = raw.trim();
    if (t === "") return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    // A NEGATIVE SPEED IS A DIRECTION, not an error: it starts the part walking left.
    return n;
}
