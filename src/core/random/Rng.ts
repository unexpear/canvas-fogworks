/**
 * @module Rng
 * @description Reproducible randomness — the supplier this engine has never had.
 *
 * WHY THIS EXISTS AT ALL. `Math.random` appears in this repository only inside comments FORBIDDING
 * it, and `Brush.pickFace(brush, roll)` has taken an injected roll since the day it was written,
 * with a header stating why: a stroke has to be replayable, so the same drag must produce the same
 * marks when an action is re-applied. It has never had a caller, because nothing here could supply
 * a roll that would come out the same twice.
 *
 * ITS FIRST CALLER IS THE CAVE GENERATOR, and `pickFace` is STILL UNWIRED — said plainly because
 * the alternative is a header claiming a connection that does not exist, which is the defect this
 * project keeps finding rather than a way of describing intent. Wiring the brush is a slice of its
 * own: a roll has to be drawn per DAB and carried on the stroke session, so that a re-applied
 * action re-draws the same sequence, and that is a change to the stroke path rather than to this.
 *
 * A GENERATED MAP THAT CHANGES WHEN REOPENED IS NOT A DOCUMENT, which is the sharper form of the
 * same rule. A cave generated from seed 7 must be the same cave in this process, in the next one,
 * and in a build shipped a year from now — so the sequence is defined by arithmetic written down
 * here rather than by whatever the host's `Math.random` happens to be that week.
 *
 * MULBERRY32, chosen for the reason its size suggests: it is small enough that the port can be
 * CHECKED rather than trusted. A 32-bit PRNG written in a language whose numbers are doubles and
 * whose bitwise operators are 32-bit SIGNED is exactly the kind of transcription that comes out
 * subtly wrong and still looks random — the failure mode is a stream that is merely different, and
 * nothing about the output would tell you. So the test pins its first draws against the same
 * arithmetic computed in BigInt with every 32-bit wrap done by hand, which shares no operator with
 * the implementation below: `Math.imul`, `>>>` and `|0` are all absent from the reference.
 *
 * NOT FOR ANYTHING THAT MUST BE UNGUESSABLE. This is a deterministic sequence with a 32-bit state,
 * for placing rocks. Identity comes from `ids/UUID`.
 */

/** A stream of reproducible numbers. Holds its own state, so two streams never interfere. */
export interface Rng {
    /** The next value in [0, 1). Never reaches 1 — the divisor is 2^32 and the numerator is at most 2^32 - 1. */
    next(): number;
    /**
     * The next whole number in [0, `bound`), or 0 when `bound` is not a positive integer.
     *
     * BY MULTIPLICATION rather than by modulo. The bias is the same either way at these sizes, but
     * `%` on a float is a different operation than most readers expect, and a caller passing 0
     * would get NaN rather than the "there is nothing to choose" answer that 0 gives.
     */
    int(bound: number): number;
}

/**
 * A stream from a numeric seed.
 *
 * SEED 0 IS A REAL SEED, unlike in the generator families that need a non-zero state — mulberry32
 * adds a constant before its first mix, so 0 behaves like any other value. A caller therefore never
 * has to special-case it, and an author who types 0 gets a cave rather than a surprise.
 */
export function rngFrom(seed: number): Rng {
    // TRUNCATED TO 32 BITS UP FRONT, so a caller handing over 1.5 or 2^40 gets a defined stream
    // rather than one whose first `| 0` silently reinterprets their number.
    let a = Number.isFinite(seed) ? seed >>> 0 : 0;
    const next = (): number => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        // `>>> 0` BEFORE the divide, because `^` yields a SIGNED 32-bit number and half of all
        // draws would otherwise be negative — the single easiest way to get this port wrong.
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        int: (bound: number) => (Number.isInteger(bound) && bound > 0 ? Math.floor(next() * bound) : 0)
    };
}

/**
 * A 32-bit seed from a word an author typed — FNV-1a.
 *
 * A SEED THE AUTHOR CHOSE IS A WORD, not a number: "cave", "level 3", "again". Hashing it here means
 * the document stores what was typed and the stream follows from it, rather than the panel inventing
 * a number nobody can write down again.
 *
 * FNV-1a rather than anything cleverer, because the requirement is only that different words differ
 * and the same word never doesn't. `Math.imul` does the 32-bit multiply that plain `*` would lose.
 */
export function seedFrom(text: string): number {
    let h = 0x811C9DC5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
