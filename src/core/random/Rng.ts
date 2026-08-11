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
 * ITS CALLERS ARE THE CAVE GENERATOR AND THE BRUSH. `pickFace` is wired now, through `rollAt`: a
 * stroke draws one roll per DAB, indexed rather than streamed, so the symmetry mirrors — which are
 * walked as separate passes over copies of the session — land on the same faces as the stroke they
 * mirror. This header said UNWIRED for a day, which was worth writing down at the time rather than
 * claiming a connection that did not exist.
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
 * ONE draw for a given (seed, index), with no stream and no state.
 *
 * A STREAM IS THE WRONG SHAPE FOR A STROKE, and that is the whole reason this exists beside
 * `rngFrom`. A brush stroke paints from three places — the press's dot, each segment, and the
 * symmetry mirrors — and the mirrors are walked as SEPARATE passes over copies of the session. Draw
 * from a shared stream and the mirror consumes different values than the primary did, so a
 * symmetric stroke comes out with different faces on each side: symmetry that is not symmetric.
 *
 * Indexed by the DAB, every pass computes the same value for the same dab, and a mirror is a mirror.
 * It also makes a stroke replayable without storing anything: the seed and the dab number are enough.
 *
 * THE INDEX IS MIXED RATHER THAN ADDED, and the reason is a COLLISION, not a correlation. I first
 * wrote that `seed + index` would make neighbouring dabs pick neighbouring faces, then measured it:
 * over 20,000 dabs the two are indistinguishable — adjacent dabs match 33.4% of the time against
 * 33.2% for the mix, both exactly chance. That justification was wrong.
 *
 * What `seed + index` really does is make the pair AMBIGUOUS: dab 5 of a stroke seeded 100 and dab 0
 * of a stroke seeded 105 are the same draw, so two strokes whose press points hash close together
 * lay the same faces offset against each other. Rare, since `seedFrom` disperses, and exact when it
 * happens — a structural collision rather than a statistical wobble, which is the kind worth three
 * multiplies to remove.
 */
export function rollAt(seed: number, index: number): number {
    // SplitMix32's finaliser, which is what turns a counter into something that looks nothing like
    // a counter. Then one mulberry32 draw from the result.
    let h = (Math.imul(index, 0x9E3779B9) ^ seed) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
    return rngFrom((h ^ (h >>> 16)) >>> 0).next();
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
