/**
 * @module Bezier
 * @description Arbitrary easing as a CUBIC BÉZIER — the curve an animator actually draws.
 *
 * Four named easings is the difference between a toy and a tool. `ease-in`, `ease-out` and their
 * symmetric pair cover the cases nobody has an opinion about; every animation with an opinion
 * needs a curve of its own — a slow start that snaps, a settle that overshoots, the particular
 * weight that makes a thing feel heavy. CSS and every timeline editor express that the same way,
 * as a cubic Bézier from (0,0) to (1,1) with two free control points, so this engine does too
 * rather than inventing a fourth vocabulary for the same idea.
 *
 * THE PROBLEM the numerics solve: the curve is parametric. Both x and y are cubics in some
 * parameter s, and what an animator means by "the curve" is y as a function of x — x is the
 * fraction of the DURATION elapsed, y is the fraction of the CHANGE applied. Those are different
 * things, and there is no closed form for s given x. So this inverts x(s) numerically and then
 * evaluates y at the s it found.
 *
 * NEWTON-RAPHSON with a BISECTION fallback, because Newton alone is not safe here. It converges in
 * two or three steps over most of the curve, and stalls exactly where the derivative approaches
 * zero — which is not a pathological input but the most ordinary one an animator picks, a curve
 * that starts or ends flat. Bisection cannot stall; it is just slower. Taking Newton's step only
 * while it stays inside the bracket gets both.
 *
 * X IS CLAMPED TO [0, 1] AND Y IS NOT, and that asymmetry is the whole expressive point. x outside
 * [0,1] would make the curve fold back on itself in time — two different progress values for one
 * moment, which is not a slower animation but an undefined one, so it is refused by the validator.
 * y outside [0,1] is OVERSHOOT: the value going past its target and settling back. That is what
 * anticipation and bounce ARE, and a model that clamped y would silently flatten every curve worth
 * drawing.
 */

/** A cubic Bézier easing: the two free control points, with (0,0) and (1,1) fixed. */
export interface CubicBezier {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/**
 * Is this a usable easing curve?
 *
 * The X coordinates must lie in [0, 1] — CSS's own rule, and for a reason worth stating: x is
 * TIME. A control point outside that range makes x(s) non-monotonic, so one moment maps to several
 * progress values and "how far through is it" stops having an answer. The Y coordinates are
 * deliberately unbounded; see the module note.
 */
export function cubicBezierError(v: unknown): string | null {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return "easing must be an object";
    const c = v as Partial<CubicBezier>;
    for (const k of ["x1", "y1", "x2", "y2"] as const) {
        if (!Number.isFinite(c[k])) return `easing.${k} must be a finite number`;
    }
    for (const k of ["x1", "x2"] as const) {
        if ((c[k] as number) < 0 || (c[k] as number) > 1) {
            return `easing.${k} must be within [0, 1] — x is TIME, and a curve that folds back on it has no single progress per moment`;
        }
    }
    return null;
}

/** One coordinate of the curve at parameter `s`, with the endpoints fixed at 0 and 1. */
function coord(s: number, a: number, b: number): number {
    // The Bernstein form with P0 = 0 and P3 = 1, expanded so it is three multiplies rather than a
    // loop: 3(1-s)²s·a + 3(1-s)s²·b + s³.
    const u = 1 - s;
    return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s;
}

/** d/ds of the same, needed by Newton and cheap enough to write out. */
function slope(s: number, a: number, b: number): number {
    const u = 1 - s;
    return 3 * u * u * a + 6 * u * s * (b - a) + 3 * s * s * (1 - b);
}

/** How close to the target x a solution has to be before it is accepted. */
const EPS = 1e-7;
/** Newton attempts before falling back. Convergence is quadratic, so this is generous. */
const NEWTON_STEPS = 8;
/**
 * Bisection steps. 2^-60 is far below `EPS`, so the loop is bounded by precision rather than by
 * this — it is an upper bound that cannot be hit rather than a tolerance in disguise.
 */
const BISECT_STEPS = 60;

/**
 * The parameter `s` at which the curve's x equals `x`.
 *
 * Exported because it is the part with the numerics in it, and a function whose failure mode is
 * "converged to the wrong root" deserves to be checked directly rather than through the eased
 * value that hides it.
 */
export function solveForX(curve: CubicBezier, x: number): number {
    // No identity short-circuit HERE, and the reason is worth keeping: `x1 === y1 && x2 === y2`
    // makes the EASING the identity — y and x are the same cubic, so y(x) = x — but it says
    // nothing about the parameter. Returning `s = x` from it and then evaluating y at that s
    // computes the cubic AT x rather than the identity, which is a curve nobody asked for. The
    // check belongs in `cubicBezierAt`, where y(x) is what is being answered. Written here first,
    // and caught by asserting a non-default curve rather than only the symmetric one.
    let s = x;                                    // x is a good first guess: the curve is near-diagonal
    for (let i = 0; i < NEWTON_STEPS; i++) {
        const error = coord(s, curve.x1, curve.x2) - x;
        if (Math.abs(error) < EPS) return s;
        const d = slope(s, curve.x1, curve.x2);
        // A FLAT derivative is where Newton stalls, and a flat start or end is the most ordinary
        // curve an animator draws — so this is the expected path, not a guard against nonsense.
        if (Math.abs(d) < 1e-6) break;
        const next = s - error / d;
        // Newton may step outside the interval on a curve with a near-zero slope, and outside it
        // the cubic is not the easing any more — x(s) is only monotonic on [0, 1], so a root found
        // out there solves the wrong equation.
        //
        // DEFENSIVE and not mutation-killable: the bisection below restarts inside the bracket and
        // converges regardless, so removing this changes no answer for any valid curve. It stays
        // for the case it is named after — Newton converging to an out-of-range root and returning
        // it early, which would be silently the wrong easing rather than a visible failure. Same
        // standing as `chainPieces`'s dead-end branch.
        if (next < 0 || next > 1) break;
        s = next;
    }
    // BISECTION: cannot stall, and x(s) is monotonic on [0,1] because `cubicBezierError` refused
    // the control points that would make it otherwise — which is what makes a bracket meaningful.
    let lo = 0, hi = 1;
    s = x;
    for (let i = 0; i < BISECT_STEPS; i++) {
        const at = coord(s, curve.x1, curve.x2);
        if (Math.abs(at - x) < EPS) return s;
        if (at < x) lo = s; else hi = s;
        s = (lo + hi) / 2;
    }
    return s;
}

/**
 * The eased fraction at `t`, where both are fractions of the way through.
 *
 * `t` is clamped because a caller outside [0, 1] is asking about a moment outside the tween, and
 * the answer there is the endpoint rather than an extrapolation of the curve. The RESULT is not
 * clamped: overshoot is the point.
 */
export function cubicBezierAt(curve: CubicBezier, t: number): number {
    const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
    // Exact at the ends whatever the control points. A COST short-circuit rather than a guard, and
    // a mutation of it changed nothing: `coord` is exactly 0 at s = 0 and exactly 1 at s = 1, and
    // the solver returns those parameters on its first iteration because the error is already
    // zero. It stays because the ends are evaluated on every tween that starts or finishes.
    if (x === 0 || x === 1) return x;
    // The IDENTITY easing: y and x are the same cubic in s, so y(x) = x whatever s is. Worth
    // short-circuiting because it is the shape a curve picker lands on when somebody drags the
    // handles back to the diagonal, and inverting a cubic to rediscover `x` is work spent losing
    // precision. It has to be asked here rather than inside the solver — see the note there.
    if (curve.x1 === curve.y1 && curve.x2 === curve.y2) return x;
    return coord(solveForX(curve, x), curve.y1, curve.y2);
}

/**
 * Curves worth having by name in a picker.
 *
 * Not a substitute for drawing one — the point of schema 44 is that any curve is expressible — but
 * a list somebody can reach for. The two OVERSHOOT entries are the reason `y` is unbounded: their
 * control points sit outside [0,1] on the y axis, so the value goes past its target and settles
 * back, which is what anticipation and follow-through are made of. The first three are CSS's own,
 * so a document that came from the web keeps the feel it had there.
 */
export const BEZIER_PRESETS: readonly { name: string; curve: CubicBezier }[] = [
    { name: "ease", curve: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } },
    { name: "ease-in-quad", curve: { x1: 0.55, y1: 0.085, x2: 0.68, y2: 0.53 } },
    { name: "ease-out-quad", curve: { x1: 0.25, y1: 0.46, x2: 0.45, y2: 0.94 } },
    { name: "snap", curve: { x1: 0.9, y1: 0, x2: 1, y2: 0.3 } },
    { name: "anticipate", curve: { x1: 0.6, y1: -0.28, x2: 0.735, y2: 0.045 } },
    { name: "overshoot", curve: { x1: 0.175, y1: 0.885, x2: 0.32, y2: 1.275 } }
];
