/**
 * @module GradientEdit
 * @description The operations an editor performs on a gradient: add a stop, remove one, move one,
 * recolour one, and turn a flat fill into a ramp and back.
 *
 * SEPARATE FROM `Gradient`, which says what a gradient IS and what makes one legal. These say what
 * you may do to one, and they need `blendColor` — which lives with the transition code, imports
 * `Node`, and `Node` imports `Gradient`. Putting these here is what keeps that a line rather than a
 * loop.
 *
 * EVERY OPERATION RETURNS A NEW GRADIENT. The document is edited through actions, and an action
 * receives the value it is to store; a mutating helper would write behind the dispatcher's back and
 * leave undo with nothing to restore.
 *
 * TWO OF THEM RETURN AN INDEX ALONGSIDE, and that is the whole reason they are not one-liners at
 * the call site. Stops are kept sorted, so inserting one or dragging one past its neighbour
 * RENUMBERS the list — and an editor holding "the selected stop" as a number would silently start
 * editing a different stop mid-drag. The new index comes back with the gradient so it cannot.
 *
 * REFUSAL IS `null`, never a silent no-op. Removing the second-to-last stop would leave something
 * `gradientError` refuses, and a helper that quietly declined would look to the editor exactly like
 * one that worked.
 */

import { Gradient, GradientStop, defaultGradient, normalizeStops, sampleGradient, GRADIENT_MAX_STOPS } from "./Gradient";
import { blendColor } from "./Prototype";
import { GradientHandle } from "../geometry/SelectionHandles";

/** Below this a ramp is a flat colour wearing a gradient's clothes; the editor converts instead. */
export const GRADIENT_MIN_STOPS = 2;

/**
 * A flat colour as a two-stop ramp: the colour, fading to nothing.
 *
 * THE SAME COLOUR AT BOTH ENDS, one opaque and one transparent — so pressing "make gradient" does
 * not change what the shape looks like at its start, and the ramp reads as an edit of the fill
 * rather than a replacement of it. A second, invented colour would be the tool making a choice the
 * author did not.
 *
 * `objectBoundingBox` because a NEW gradient belongs to the shape: it is the only units that
 * follows the box when the shape is resized, and a `userSpaceOnUse` ramp authored at one size
 * slides off the shape at the next. Imported gradients keep whatever the file said.
 *
 * THE AXIS IS PUT DOWN THE MIDDLE — y = 0.5 rather than SVG's own y = 0 — and it makes no visual
 * difference at all: a linear ramp is a family of parallel lines, so where the axis sits along its
 * own perpendicular is not part of what it paints. It becomes visible the moment you press
 * "radial", because `withKind` centres the circle on the axis midpoint, and SVG's default axis
 * would put that on the shape's TOP EDGE. That is not a bug in the conversion — a linear ramp
 * genuinely does not record where it sits perpendicular to itself — so the fix belongs here, where
 * a new gradient is authored, rather than in a conversion that would have to guess.
 *
 * `defaultGradient` keeps SVG's real defaults untouched: the importer depends on them meaning
 * exactly what the specification says a gradient stating nothing means.
 */
export function gradientFromColor(color: string, kind: "linear" | "radial" = "linear"): Gradient {
    return {
        ...defaultGradient(kind),
        y1: 0.5, y2: 0.5,
        stops: [{ offset: 0, color, opacity: 1 }, { offset: 1, color, opacity: 0 }]
    };
}

/**
 * The colour and opacity the ramp ALREADY shows at `t` — what a stop inserted there must take.
 *
 * `sampleGradient` deliberately returns the two stops and the ratio rather than a colour, because
 * blending needs a colour space and a stop may hold a `$token` that cannot be blended at all. This
 * is where that choice is made: `blendColor` steps at the halfway point when either end is not a
 * hex value, which is the same answer a keyframed token gets. Opacity is a plain number and simply
 * interpolates.
 */
export function colorAt(gradient: Gradient, t: number): { color: string; opacity: number } | null {
    const s = sampleGradient(gradient, t);
    if (!s) return null;
    if (s.mix === null) return { color: s.color, opacity: s.opacity };
    const b = gradient.stops[s.to];
    return {
        color: blendColor(s.color, b.color, s.mix),
        opacity: s.opacity + (b.opacity - s.opacity) * s.mix
    };
}

/**
 * A stop added at `t`, taking the colour the ramp already shows there.
 *
 * SO THE SHAPE DOES NOT CHANGE when a stop is added. Adding a handle is a preparation for an edit,
 * not an edit; a new stop in some default colour would repaint the shape the moment you clicked
 * the ramp, and you would then have to undo to find out what it looked like before.
 *
 * Returns the new stop's index with it — the list is sorted, so it is rarely the last one.
 */
export function withStop(gradient: Gradient, t: number): { gradient: Gradient; index: number } | null {
    if (gradient.stops.length >= GRADIENT_MAX_STOPS) return null;
    const at = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
    const found = colorAt(gradient, at);
    if (!found) return null;
    return place([...gradient.stops, { offset: at, ...found }], gradient.stops.length, gradient);
}

/** Stop `index` removed — null when that would leave a ramp too short to be one. */
export function withoutStop(gradient: Gradient, index: number): Gradient | null {
    if (index < 0 || index >= gradient.stops.length) return null;
    if (gradient.stops.length <= GRADIENT_MIN_STOPS) return null;
    return { ...gradient, stops: gradient.stops.filter((_, i) => i !== index) };
}

/** Stop `index` recoloured. `opacity` absent leaves the stop's own. */
export function withStopColor(
    gradient: Gradient, index: number, color: string, opacity?: number
): Gradient | null {
    if (index < 0 || index >= gradient.stops.length) return null;
    return {
        ...gradient,
        stops: gradient.stops.map((s, i) => i !== index ? s : {
            offset: s.offset, color,
            opacity: opacity === undefined ? s.opacity : Math.min(1, Math.max(0, opacity))
        })
    };
}

/**
 * Stop `index` moved to `offset`, and where it ended up.
 *
 * DRAGGING ONE STOP PAST ANOTHER IS THE ORDINARY CASE, not an edge one — it is how you reverse a
 * two-stop ramp. The list re-sorts, so the index comes back with the gradient and the editor keeps
 * hold of the stop the pointer is on.
 */
export function withStopOffset(
    gradient: Gradient, index: number, offset: number
): { gradient: Gradient; index: number } | null {
    if (index < 0 || index >= gradient.stops.length) return null;
    const at = Math.min(1, Math.max(0, Number.isFinite(offset) ? offset : 0));
    return place(gradient.stops.map((s, i) => i === index ? { ...s, offset: at } : s), index, gradient);
}

/**
 * The same ramp, drawn the other way.
 *
 * DERIVED FROM THE EXISTING GEOMETRY rather than reset to the defaults. A radial takes the linear
 * axis's midpoint and half its length; a linear takes the diameter through the radial's centre. The
 * defaults are a unit square, which is right for a fresh `objectBoundingBox` gradient and
 * microscopic for an imported `userSpaceOnUse` one — switching kind would make an imported ramp
 * vanish to a point at the origin.
 */
export function withKind(gradient: Gradient, kind: "linear" | "radial"): Gradient {
    if (gradient.kind === kind) return gradient;
    if (kind === "radial") {
        const cx = (gradient.x1 + gradient.x2) / 2, cy = (gradient.y1 + gradient.y2) / 2;
        const r = Math.hypot(gradient.x2 - gradient.x1, gradient.y2 - gradient.y1) / 2;
        return { ...gradient, kind, cx, cy, r, fx: cx, fy: cy };
    }
    return {
        ...gradient, kind,
        x1: gradient.cx - gradient.r, y1: gradient.cy,
        x2: gradient.cx + gradient.r, y2: gradient.cy
    };
}

/**
 * Stops sorted and repaired, and where the stop that was at `moved` now sits.
 *
 * The sort is run HERE and then handed to `normalizeStops`, rather than the index being worked out
 * arithmetically alongside it. Both are stable and the second sees an already-sorted list, so the
 * two agree by construction — a parallel calculation of "where would it land" is the kind that
 * matches on every fixture and disagrees on the tie nobody wrote a test for.
 *
 * THE EXPLICIT TIE-BREAK IS NOT DEAD CODE, though deleting it passes every test: `Array.sort` has
 * been stable since ES2019, so on this engine it is an equivalent mutation. It is written out for
 * the reason `normalizeStops` gives for its own — stable ACROSS engines, not only where the engine
 * happens to be. REVERSING it is killed, which is how that was told apart from an untested guard.
 */
function place(
    stops: GradientStop[], moved: number, gradient: Gradient
): { gradient: Gradient; index: number } {
    const tagged = stops.map((s, i) => ({ s, i })).sort((a, b) => (a.s.offset - b.s.offset) || (a.i - b.i));
    return {
        gradient: { ...gradient, stops: normalizeStops(tagged.map(t => t.s)) },
        index: tagged.findIndex(t => t.i === moved)
    };
}

/**
 * The ramp moved by one of its on-canvas handles, in the gradient's OWN coordinates.
 *
 * The caller maps the pointer back to gradient space (`gradientPointOf`) and hands the result
 * here, so the arithmetic that decides what a handle MEANS is testable without a matrix, a canvas
 * or a pointer — and the tool composes nothing.
 *
 * `grad:radius` reads the DISTANCE from the centre, not the x offset. The rim handle is drawn on
 * the +x side because a radius is a scalar and the direction has to be chosen, but dragging it
 * upward is still dragging it away from the centre and must still grow the circle.
 *
 * THE FOCUS IS PULLED BACK INSIDE THE CIRCLE, because SVG does: a focal point outside the end
 * circle is moved onto its edge before anything is painted. Storing one outside would mean the
 * document said one thing and every renderer drew another.
 */
export function withHandleAt(
    gradient: Gradient, handle: GradientHandle, x: number, y: number
): Gradient | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    switch (handle) {
        case "grad:start": return { ...gradient, x1: x, y1: y };
        case "grad:end": return { ...gradient, x2: x, y2: y };
        case "grad:center": {
            // The focus travels with the centre, so dragging a circle does not silently reshape
            // the ramp inside it — the offset between the two is what the author set.
            const dx = x - gradient.cx, dy = y - gradient.cy;
            return { ...gradient, cx: x, cy: y, fx: gradient.fx + dx, fy: gradient.fy + dy };
        }
        case "grad:radius": {
            const r = Math.hypot(x - gradient.cx, y - gradient.cy);
            return clampFocus({ ...gradient, r });
        }
        case "grad:focus": return clampFocus({ ...gradient, fx: x, fy: y });
        default: return null;
    }
}

/** SVG's rule: a focus outside the end circle is moved onto its edge. */
function clampFocus(g: Gradient): Gradient {
    const dx = g.fx - g.cx, dy = g.fy - g.cy;
    const d = Math.hypot(dx, dy);
    // ON the edge and not just inside it, which is what the specification says — and `d === 0`
    // needs no move at all, so the division is never by zero.
    if (d <= g.r || d === 0) return g;
    return { ...g, fx: g.cx + (dx / d) * g.r, fy: g.cy + (dy / d) * g.r };
}
