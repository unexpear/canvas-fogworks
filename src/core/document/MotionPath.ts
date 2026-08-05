/**
 * @module MotionPath
 * @description A position tween that is a CURVE rather than a straight line (schema 48).
 *
 * Everything moved in straight lines. A thrown ball travels on an ARC, and the only way to say so
 * was to add keyframes along the curve — which is not the same animation. It is a polyline the
 * author re-fits by hand every time either end moves, and an editor then shows six keyframes nobody
 * authored. One curve says it once.
 *
 * THE ENDPOINTS ARE NOT STORED. A segment's ends are the two keyframes' own positions, so only the
 * two control points are kept and a path cannot come to disagree with the keyframes it joins. They
 * are OFFSETS from their nearest endpoint — `c1` from the leaving keyframe, `c2` from the arriving
 * one — the same choice mesh points made in schema 43: move a keyframe and the curve follows it,
 * rather than snapping back to coordinates authored against a position that no longer exists.
 *
 * PROGRESS IS ARC LENGTH, and that is the part worth getting right. Equal steps in a cubic's
 * PARAMETER are not equal steps in DISTANCE — a curve with long handles crawls at its ends and
 * races through its middle. Evaluated naively a motion path would add an ease nobody authored, and
 * it would do it silently, fighting the easing curve that IS authored. Spacing is the entire
 * subject of the exercises this engine exists for, so the parameter is resolved against a sampled
 * cumulative-length table. The easing shapes the SPACING; the path shapes only the ROUTE.
 *
 * This module is pure arithmetic over two points and two offsets. It knows nothing about keyframes,
 * which is what lets `Timeline` use it without this file learning what time is.
 */

/** A point in whatever space the caller is working in — parent-relative, here. */
export interface Point {
    x: number;
    y: number;
}

/**
 * The two control points of a position tween, as OFFSETS from the segment's own endpoints.
 *
 * `c1` is measured from the keyframe being left, `c2` from the keyframe being arrived at. Storing
 * offsets rather than absolute coordinates is what makes the curve survive either keyframe moving.
 */
export interface MotionPath {
    c1: Point;
    c2: Point;
}

/**
 * Samples in the arc-length table.
 *
 * A cubic's length has no closed form, so a table is the honest way to do this. FIXED rather than
 * adaptive: the same document must always produce the same motion, or a trace stops being
 * comparable with another trace — which is the property the whole diagnostics layer leans on.
 * Sixty-four segments hold a hand-drawn curve to well under a pixel over the distances a canvas
 * spans, and the table is built once per lookup rather than cached, because caching it would need
 * a key on four points and the arithmetic is cheaper than the bookkeeping.
 */
export const ARC_SAMPLES = 64;

/** How far a control-point offset may reach. Bounded for the reason every hand-editable number is. */
export const MOTION_OFFSET_MAX = 100_000;

/** Validity of a motion path, SHARED by the edit path and the load path. */
export function motionPathError(m: unknown): string | null {
    if (m === undefined) return null;
    if (typeof m !== "object" || m === null || Array.isArray(m)) return "motion must be an object";
    const p = m as Partial<MotionPath>;
    for (const [name, c] of [["c1", p.c1], ["c2", p.c2]] as [string, Point | undefined][]) {
        if (typeof c !== "object" || c === null) return `motion.${name} must be a point`;
        for (const axis of ["x", "y"] as const) {
            const v = c[axis];
            // NON-FINITE is the one that matters. A NaN offset makes every sampled length NaN, the
            // cumulative table monotonically nothing, and the shape simply vanishes — a failure
            // that surfaces frames later and nowhere near its cause.
            if (!Number.isFinite(v)) return `motion.${name}.${axis} must be a finite number`;
            if (Math.abs(v as number) > MOTION_OFFSET_MAX) {
                return `motion.${name}.${axis} must be within ±${MOTION_OFFSET_MAX}`;
            }
        }
    }
    return null;
}

/** The cubic's point at PARAMETER s — not at progress. Private on purpose; see `motionPointAt`. */
function pointAtParam(from: Point, to: Point, path: MotionPath, s: number): Point {
    // The control points are OFFSETS, resolved against their own end here and nowhere else.
    const p1x = from.x + path.c1.x, p1y = from.y + path.c1.y;
    const p2x = to.x + path.c2.x, p2y = to.y + path.c2.y;
    const u = 1 - s;
    const a = u * u * u, b = 3 * u * u * s, c = 3 * u * s * s, d = s * s * s;
    return {
        x: a * from.x + b * p1x + c * p2x + d * to.x,
        y: a * from.y + b * p1y + c * p2y + d * to.y
    };
}

/**
 * The cumulative distance to each sample, from 0 to the curve's full length.
 *
 * A polyline through `ARC_SAMPLES` points UNDERSTATES a curve's length — every chord is shorter
 * than the arc it spans. That does not matter here, because only the RATIO of a prefix to the
 * total is used and both are understated the same way; it would matter if this ever reported a
 * length as a distance, which it deliberately does not.
 */
function lengthTable(from: Point, to: Point, path: MotionPath): number[] {
    const table = new Array<number>(ARC_SAMPLES + 1);
    table[0] = 0;
    let previous = pointAtParam(from, to, path, 0);
    for (let i = 1; i <= ARC_SAMPLES; i++) {
        const point = pointAtParam(from, to, path, i / ARC_SAMPLES);
        table[i] = table[i - 1] + Math.hypot(point.x - previous.x, point.y - previous.y);
        previous = point;
    }
    return table;
}

/**
 * Where a shape is at progress `t` along the path — `t` being DISTANCE travelled, not parameter.
 *
 * The inversion is a binary search over the cumulative table plus one linear step inside the
 * bracketing sample. Linear interpolation is right there and not a shortcut: between two adjacent
 * samples the curve is very nearly straight, which is the same assumption the table itself is
 * built on, so refining it further would be precision the table cannot support.
 */
export function motionPointAt(from: Point, to: Point, path: MotionPath, t: number): Point {
    const progress = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const table = lengthTable(from, to, path);
    const total = table[ARC_SAMPLES];
    // A ZERO-LENGTH path — two keyframes on one spot with no handles — is a real authoring state
    // rather than an error. This is CLARITY, NOT CORRECTNESS, and a mutation removing it survives:
    // the `span > 0` fallback below already reaches the same answer, because a curve of zero length
    // has all four control points in one place and every parameter evaluates to it. It stays
    // because arriving at the right point by way of a binary search over a table of zeros is not an
    // argument anybody should have to reconstruct.
    if (!(total > 0)) return { x: from.x, y: from.y };

    const target = progress * total;
    let lo = 0, hi = ARC_SAMPLES;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (table[mid] <= target) lo = mid; else hi = mid;
    }
    const span = table[hi] - table[lo];
    // A FLAT span means several samples landed on one spot — possible where a curve doubles back
    // through a cusp. The fraction is meaningless there and any value in the sample is equally
    // right, so it takes the low end rather than dividing by zero.
    const within = span > 0 ? (target - table[lo]) / span : 0;
    return pointAtParam(from, to, path, (lo + within) / ARC_SAMPLES);
}

/**
 * The path's route as points, for drawing it — the editor's overlay and nothing else.
 *
 * Sampled by PARAMETER rather than by distance, because this answers "what shape is the route",
 * where even spacing along the curve buys nothing and costs a length table per redraw.
 */
export function motionPolyline(from: Point, to: Point, path: MotionPath, steps: number = 24): Point[] {
    const n = Math.max(1, Math.min(ARC_SAMPLES, Math.round(steps)));
    const out: Point[] = [];
    for (let i = 0; i <= n; i++) out.push(pointAtParam(from, to, path, i / n));
    return out;
}
