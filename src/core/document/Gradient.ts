/**
 * @module Gradient
 * @description A fill that changes across the shape — the largest hole in this engine's 2D model.
 *
 * VDE has had one kind of fill since the beginning: a single colour. 2,491 fills in the measured
 * SVG corpus reference a gradient, and every one of them currently flattens to its first stop —
 * the import says so out loud, which is honest and still means 516 files arrive wrong.
 *
 * MEASURED BEFORE DESIGNED, and the numbers moved two decisions:
 *
 *   3,127 gradients   97% LINEAR (3,035) against 92 radial
 *   2,860 of 2,969    exactly TWO stops; the most any file uses is 11
 *   2,977 of 3,127    `userSpaceOnUse` — NOT SVG's own default of objectBoundingBox
 *   2,238 of 3,127    carry a `gradientTransform` — 72%, so it is not an optional extra
 *   2,491 fills       reference one; exactly ONE stroke does
 *
 * TWO STOPS ARE THE COMMON CASE AND NOT A SPECIAL CASE. A model with `from`/`to` colours would fit
 * 96% of the corpus and then need replacing for the 11-stop one, and the replacement would be a
 * schema migration. A stop list costs nothing and covers both.
 *
 * THE TRANSFORM IS CARRIED, NOT BAKED. It could be folded into the coordinates at import for a
 * linear gradient — but not for a radial one, where a non-uniform matrix turns a circle into an
 * ellipse that no cx/cy/r can express. Carrying it keeps one representation for both, and it is
 * what every renderer wants anyway: SVG has the attribute, and Canvas and the GPU both want a
 * matrix rather than pre-distorted points.
 *
 * OFFSETS ARE SORTED AND CLAMPED ON THE WAY IN. SVG requires non-decreasing offsets and browsers
 * silently repair files that break the rule, so a reader that trusts the file disagrees with every
 * browser about those files. Repairing here means the rest of the engine can index stops without
 * checking.
 */

import { Mat2D, IDENTITY } from "../geometry/Matrix";

/** Bounds on a hand-editable document. The corpus's worst case is 11 stops. */
export const GRADIENT_MAX_STOPS = 64;

/** One colour at one position along the ramp. */
export interface GradientStop {
    /** 0..1 along the gradient's own axis. */
    offset: number;
    /** `#rgb`/`#rrggbb`/`rgb()`/a token — whatever `Style.fill` already accepts. */
    color: string;
    /**
     * SVG's `stop-opacity`, 0..1, SEPARATE from any alpha in `color`.
     *
     * 920 stops in the corpus state one, and it is genuinely a different thing: a gradient that
     * fades a colour to transparent states the SAME colour twice with two opacities, and folding
     * it into the colour string would mean rewriting the colour to express it.
     */
    opacity: number;
}

/**
 * How a gradient's coordinates are read.
 *
 * `objectBoundingBox` is SVG's DEFAULT and is used by 150 of 3,127. `userSpaceOnUse` is used by
 * 2,977 — so the common case in real files is the one a reader assuming the default gets wrong,
 * and by a whole coordinate system rather than a little.
 */
export type GradientUnits = "objectBoundingBox" | "userSpaceOnUse";

/** A linear or radial ramp. */
export interface Gradient {
    kind: "linear" | "radial";
    stops: GradientStop[];
    units: GradientUnits;
    /**
     * `gradientTransform`. 72% of the corpus carries one, which is why it is not optional.
     *
     * NOT BAKED INTO THE COORDINATES. It can be folded away for a linear gradient and cannot for a
     * radial one — a non-uniform matrix turns the circle into an ellipse that no cx/cy/r can say.
     */
    transform: Mat2D;
    /** LINEAR: the axis, in whatever `units` says. SVG's defaults are (0,0)–(1,0). */
    x1: number; y1: number; x2: number; y2: number;
    /** RADIAL: the end circle, and the focal point the ramp starts from. */
    cx: number; cy: number; r: number; fx: number; fy: number;
}

/** SVG's own defaults, so a gradient stating nothing is still a legal one. */
export function defaultGradient(kind: "linear" | "radial"): Gradient {
    return {
        kind, stops: [], units: "objectBoundingBox", transform: IDENTITY,
        // A LEFT-TO-RIGHT axis across the object, which is what SVG means by stating nothing.
        x1: 0, y1: 0, x2: 1, y2: 0,
        // A circle filling the box, focus at its centre — again SVG's stated defaults.
        cx: 0.5, cy: 0.5, r: 0.5, fx: 0.5, fy: 0.5
    };
}

/** What went wrong, or null. */
export function gradientError(gradient: unknown): string | null {
    if (gradient === null || typeof gradient !== "object") return "a gradient must be an object";
    const g = gradient as Partial<Gradient>;
    if (g.kind !== "linear" && g.kind !== "radial") return "a gradient must be linear or radial";
    if (g.units !== "objectBoundingBox" && g.units !== "userSpaceOnUse") {
        return "a gradient's units must be objectBoundingBox or userSpaceOnUse";
    }
    if (!Array.isArray(g.stops)) return "a gradient must have a list of stops";
    // A GRADIENT WITH NO STOPS PAINTS NOTHING, which SVG defines as `none`. It is refused here
    // rather than treated as transparent, because a fill that silently disappears reads as a
    // broken renderer — and every one of the 3,127 measured gradients has at least two.
    if (g.stops.length < 1) return "a gradient must have at least one stop";
    if (g.stops.length > GRADIENT_MAX_STOPS) return `a gradient may not exceed ${GRADIENT_MAX_STOPS} stops`;
    for (const s of g.stops) {
        if (s === null || typeof s !== "object") return "every stop must be an object";
        if (!Number.isFinite(s.offset) || s.offset < 0 || s.offset > 1) return "a stop's offset must be 0..1";
        if (typeof s.color !== "string" || s.color.length === 0) return "a stop must have a colour";
        if (!Number.isFinite(s.opacity) || s.opacity < 0 || s.opacity > 1) return "a stop's opacity must be 0..1";
    }
    // NON-DECREASING, because `sampleGradient` walks the list once and a jumbled list would make
    // it read a segment backwards. `normalizeStops` is what guarantees this for anything imported.
    for (let i = 1; i < g.stops.length; i++) {
        if (g.stops[i].offset < g.stops[i - 1].offset) return "a gradient's stops must not go backwards";
    }
    const numbers = [g.transform?.a, g.transform?.b, g.transform?.c, g.transform?.d, g.transform?.e, g.transform?.f,
        g.x1, g.y1, g.x2, g.y2, g.cx, g.cy, g.r, g.fx, g.fy];
    if (numbers.some(n => !Number.isFinite(n))) return "a gradient's geometry must be finite";
    // A NEGATIVE RADIUS is an error in SVG rather than a mirrored circle, and zero is legal — it
    // paints the last stop's colour everywhere, which is a real thing files do to flatten a fill.
    if ((g.r as number) < 0) return "a radial gradient's radius must not be negative";
    return null;
}

/**
 * Stops put in the order the rest of the engine may assume: clamped, sorted, and never empty-safe.
 *
 * SVG REQUIRES non-decreasing offsets and browsers silently repair files that break it — an offset
 * lower than the one before is raised to match. Doing the same here means a file that renders one
 * way in a browser does not render another way in this engine, which is the only thing an importer
 * is really for.
 *
 * SORTED STABLY, so two stops at the SAME offset keep their document order — that pair is how a
 * file states a hard colour break, and reversing it reverses the break.
 */
export function normalizeStops(stops: readonly GradientStop[]): GradientStop[] {
    const clamped = stops.map(s => ({
        offset: Math.min(1, Math.max(0, Number.isFinite(s.offset) ? s.offset : 0)),
        color: s.color,
        opacity: Math.min(1, Math.max(0, Number.isFinite(s.opacity) ? s.opacity : 1))
    }));
    // Index-tagged so the sort is stable across engines rather than only where the engine happens
    // to be stable — the same reason the tie-break in `Quantize` is explicit.
    const out = clamped
        .map((s, i) => ({ s, i }))
        .sort((a, b) => (a.s.offset - b.s.offset) || (a.i - b.i))
        .map(x => x.s);
    // Then raise any offset that still trails its predecessor, which is what a browser does.
    for (let i = 1; i < out.length; i++) {
        if (out[i].offset < out[i - 1].offset) out[i].offset = out[i - 1].offset;
    }
    return out;
}

/** A colour and an alpha at one point along the ramp. */
export interface GradientSample {
    color: string;
    opacity: number;
    /** How far between the two stops this sample sits, 0..1 — null when it landed ON a stop. */
    mix: number | null;
    /** The stop indices either side. Equal when the sample is at or past an end. */
    from: number;
    to: number;
}

/**
 * The stops either side of `t`, and how far between them it falls.
 *
 * RETURNS THE PAIR RATHER THAN A BLENDED COLOUR, deliberately. Blending needs a colour space, and
 * this module has no business choosing one: `Style.fill` holds `#rrggbb`, `rgb()` and design
 * TOKENS, and a token cannot be interpolated at all without resolving it first. A renderer that
 * has resolved its colours can blend; SVG blends for itself and only wants the stops.
 *
 * PAST EITHER END IS THE END STOP, which is `spreadMethod="pad"` — the SVG default, and the only
 * value any of the 2,424 files that state one uses.
 */
export function sampleGradient(gradient: Gradient, t: number): GradientSample | null {
    const stops = gradient.stops;
    if (stops.length === 0) return null;
    const at = Number.isFinite(t) ? t : 0;
    if (at <= stops[0].offset) {
        return { color: stops[0].color, opacity: stops[0].opacity, mix: null, from: 0, to: 0 };
    }
    const last = stops.length - 1;
    if (at >= stops[last].offset) {
        return { color: stops[last].color, opacity: stops[last].opacity, mix: null, from: last, to: last };
    }
    // LANDING ON A STOP is reported as that stop with no ratio, so a caller never has to treat a
    // mix of exactly 1 as a special case. Scanned forward, so two stops sharing an offset — a hard
    // break — report the FIRST of the pair, which is the colour on the near side of the break.
    for (let i = 0; i < stops.length; i++) {
        if (stops[i].offset === at) {
            return { color: stops[i].color, opacity: stops[i].opacity, mix: null, from: i, to: i };
        }
    }
    for (let i = 1; i < stops.length; i++) {
        if (at > stops[i].offset) continue;
        const a = stops[i - 1], b = stops[i];
        const span = b.offset - a.offset;
        // A ZERO SPAN is two stops at one offset — a hard break, not a division. The colour on the
        // far side wins, which is what makes the break visible at all.
        if (span <= 0) return { color: b.color, opacity: b.opacity, mix: null, from: i - 1, to: i };
        return { color: a.color, opacity: a.opacity, mix: (at - a.offset) / span, from: i - 1, to: i };
    }
    return { color: stops[last].color, opacity: stops[last].opacity, mix: null, from: last, to: last };
}
