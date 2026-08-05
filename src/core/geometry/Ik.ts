/**
 * @module Ik
 * @description Posing a two-bone limb by its HAND instead of by its shoulder (schema 49).
 *
 * The rig already exists: the scene graph composes a parent's matrix into its children, so a
 * two-bone chain needs no bone type and `wavingLimb` is one already. What was missing is the
 * ability to say where the hand goes and have the shoulder and elbow work themselves out — which
 * is the whole difference between forward and inverse kinematics, and the difference between a rig
 * being usable and not. Planting a foot with forward kinematics means hand-tuning two angles per
 * frame and re-tuning both whenever the hip moves, because the foot's position is a CONSEQUENCE of
 * the angles rather than a thing that can be stated.
 *
 * TWO BONES, SOLVED ANALYTICALLY. A two-bone chain is the limb — arm, leg, wing — and the triangle
 * with sides `l1`, `l2` and the root-to-target distance has a closed form by the law of cosines. No
 * iteration, no convergence to reason about, exactly one answer per bend direction, and the same
 * answer every run.
 *
 * LONGER CHAINS USE FABRIK, AND THE CLOSED FORM STAYS. Past two bones there is no unique answer at
 * all: the same hand position is reachable by infinitely many poses, so the solver's job stops
 * being "find the answer" and becomes "find a natural one". FABRIK does that by alternately
 * dragging the chain back from the target and forward from the root; every step is a projection
 * onto a segment, so the bones keep their lengths no matter how many times it runs. The two-bone
 * case is NOT routed through it — an iterative approximation where a closed form exists would be
 * slower, less exact, and would make the commonest rig in animation depend on a convergence
 * argument. Choosing by chain length costs one comparison.
 *
 * THE ITERATION IS BOUNDED AND THE TOLERANCE IS FIXED, which is not a performance choice. The
 * diagnostics layer rests on the same document always producing the same motion — a trace that
 * differed run to run would stop being comparable with another trace, and every regression check
 * built on it would evaporate. So the loop runs a fixed maximum and stops on a fixed distance,
 * never on elapsed time or an adaptive budget.
 *
 * BEND IS AUTHORED, NOT INFERRED. The triangle has two solutions mirrored about the root-to-target
 * line, elbow up and elbow down, and both are correct. Which one a limb uses is anatomy. Inferring
 * it from the current pose would let a knee flip inside out whenever the chain passed through
 * straight, which is the classic artefact of a rig that guesses.
 *
 * OUT OF REACH IS NOT AN ERROR. A target beyond `l1 + l2` has no triangle, and the honest answer is
 * what every rig gives: the chain straightens and points at it. Done by CLAMPING the distance into
 * the reachable band before the cosines rather than by a special case, so the straightened pose is
 * the ordinary answer at the boundary instead of a second path that can disagree with the first.
 *
 * PURE, AND IN NO PARTICULAR SPACE. This module takes points and lengths and returns angles. It
 * does not know what a node is, which is what lets the document layer solve in the root's parent
 * space without this file learning what a document is.
 */

/** A point in whatever space the caller is working in. */
export interface IkPoint {
    x: number;
    y: number;
}

/** Which way the middle joint folds. Anatomy, so it is stated rather than deduced. */
export type IkBend = 1 | -1;

/** The angles a chain must take, plus where its middle joint ended up. */
export interface IkSolution {
    /** Direction of the FIRST bone, as an absolute angle in the space the caller passed in. */
    angle1: number;
    /** Direction of the SECOND bone — also absolute, NOT relative to the first. */
    angle2: number;
    /** Where the middle joint lands. Returned because a rig draws it, and re-deriving it drifts. */
    joint: IkPoint;
    /**
     * Whether the target was actually reachable.
     *
     * Reported rather than signalled: the chain is posed either way, and a caller that wants to
     * draw a stretched limb differently — or an editor that wants to show a handle in red — should
     * not have to measure the distance a second time to find out.
     */
    reached: boolean;
}

/**
 * The two bone directions that put the end of the chain on `target`.
 *
 * Angles are absolute and in the caller's own space; both are directions, so a caller converting to
 * a node rotation subtracts the bone's REST direction and gets a delta that composes with however
 * the character was drawn.
 */
export function solveTwoBone(root: IkPoint, target: IkPoint, l1: number, l2: number, bend: IkBend = 1): IkSolution {
    const dx = target.x - root.x, dy = target.y - root.y;
    const distance = Math.hypot(dx, dy);
    // A DEGENERATE chain — a zero-length bone, or a target exactly on the root — has no direction
    // to point in and no triangle to solve. Answering with the rest orientation along +x is
    // arbitrary, but it is finite and stable, which a NaN propagated into a transform is not.
    if (!(distance > 0) || !(l1 > 0) || !(l2 > 0)) {
        return { angle1: 0, angle2: 0, joint: { x: root.x + (l1 > 0 ? l1 : 0), y: root.y }, reached: false };
    }

    // CLAMPED into the band the chain can actually span. This states the intent — beyond `l1 + l2`
    // the chain is straight, inside `|l1 - l2|` it is folded as tight as it goes — and it is the
    // line to read to understand what happens out of reach.
    //
    // BE PRECISE ABOUT WHAT IT DOES, THOUGH: mutations of BOTH ends of this clamp survive the
    // suite, because the ratio clamp below subsumes them. An unclamped distance drives the cosine
    // past ±1, the ratio clamp pulls it back to exactly ±1, and `acos` returns the same
    // straightened or folded angle. The two guards mask each other and only one is load-bearing —
    // this one is here because arriving at a straight chain by way of an out-of-range cosine is
    // not an argument the next reader should have to reconstruct.
    const reach = l1 + l2, fold = Math.abs(l1 - l2);
    const d = distance > reach ? reach : distance < fold ? fold : distance;
    const reached = distance <= reach && distance >= fold;

    // Law of cosines for the angle at the ROOT, between the first bone and the line to the target.
    // THE RATIO CLAMP IS THE ONE THAT ACTUALLY CARRIES IT. It is needed even with `d` in range —
    // at exactly full reach the ratio is 1 in real arithmetic and can land a hair above it in
    // floating point, and `acos` of that is NaN, which would poison the whole limb at precisely
    // the pose every out-of-reach target lands on.
    const cosRoot = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
    const atRoot = Math.acos(cosRoot < -1 ? -1 : cosRoot > 1 ? 1 : cosRoot);

    const toTarget = Math.atan2(dy, dx);
    // BEND picks which side of the root-to-target line the joint falls on. Both are valid triangles.
    const angle1 = toTarget - bend * atRoot;
    const joint = { x: root.x + l1 * Math.cos(angle1), y: root.y + l1 * Math.sin(angle1) };
    // The SECOND bone points from the joint to where the target actually is — not to the clamped
    // point. Out of reach that is the same direction anyway, and in reach it is exact, so this
    // avoids the second bone quietly aiming at a target the clamp moved.
    const angle2 = Math.atan2(target.y - joint.y, target.x - joint.x);
    return { angle1, angle2, joint, reached };
}

/**
 * The angle a bone must ROTATE BY, given where it rests and where it must point.
 *
 * Wrapped into `(-π, π]` so a solved rig never asks a limb to take the long way round — the same
 * pose expressed as +350° instead of -10° is identical when static and a full backwards spin when
 * something tweens through it.
 */
export function rotationDelta(rest: number, solved: number): number {
    const TAU = Math.PI * 2;
    let d = (solved - rest) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d <= -Math.PI) d += TAU;
    return d;
}

/**
 * Passes FABRIK may take before it stops, and how close counts as arrived.
 *
 * FIXED, both of them, and for correctness rather than for speed: the same document must always
 * produce the same pose or a motion trace stops being comparable with another trace. Ten passes
 * puts a well-conditioned chain inside a hundredth of a pixel, and a chain that has not converged
 * by then is one being dragged at its own reach limit, where the remaining error is the target
 * being unreachable rather than the loop needing more turns.
 */
export const FABRIK_PASSES = 48;
export const FABRIK_TOLERANCE = 0.01;

/**
 * How far off its own axis a perfectly straight chain is nudged before iterating.
 *
 * A chain drawn straight — which is how a tail or a spine is drawn — aimed at a target lying on
 * that same line is FABRIK's singular case: the backward pass produces a mirror image and the
 * forward pass undoes it exactly, so the chain oscillates between two poses forever and never
 * moves. It is not rare in this engine, because rest poses here ARE straight. A deterministic
 * perpendicular seed breaks the symmetry; the first pass re-projects every joint, so the nudge
 * costs nothing in bone length. A FRACTION of the chain rather than a fixed distance, so it means
 * the same thing to a 40px finger and a 4000px tail.
 */
export const FABRIK_SEED = 1e-3;

/**
 * A chain of three or more joints, posed so its last joint reaches `target`.
 *
 * `joints` are the joint POSITIONS in rest, root first; the segment lengths are taken from them, so
 * a caller cannot pass lengths that disagree with the chain it drew. The root does not move.
 *
 * Returns new positions rather than angles, because that is what the algorithm is expressed in and
 * converting to angles is the document layer's job — which also lets the same conversion serve both
 * solvers instead of each growing its own.
 */
export function solveFabrik(joints: readonly IkPoint[], target: IkPoint): { joints: IkPoint[]; reached: boolean } {
    const n = joints.length;
    // A CHAIN THIS SHORT has no interior joint to move, so there is nothing to iterate on. Handing
    // it back untouched is the honest answer; the two-bone case belongs to `solveTwoBone`.
    if (n < 3) return { joints: joints.map(p => ({ x: p.x, y: p.y })), reached: false };

    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < n; i++) {
        const d = Math.hypot(joints[i].x - joints[i - 1].x, joints[i].y - joints[i - 1].y);
        lengths.push(d);
        total += d;
    }
    const root = { x: joints[0].x, y: joints[0].y };
    const out = joints.map(p => ({ x: p.x, y: p.y }));

    const reach = Math.hypot(target.x - root.x, target.y - root.y);
    if (!(total > 0)) return { joints: out, reached: false };
    if (reach > total) {
        // OUT OF REACH is not iterated toward. Be precise about why: this is COST, not correctness,
        // and a mutation removing it survives — the loop converges to the very same straight chain,
        // because straightening at the target is exactly what FABRIK does when it cannot arrive.
        // Skipping 48 passes to reach a pose that is already known is worth one comparison, and
        // saying so in one line beats making the next reader derive it from the iteration.
        const ux = (target.x - root.x) / reach, uy = (target.y - root.y) / reach;
        for (let i = 1; i < n; i++) {
            out[i] = { x: out[i - 1].x + ux * lengths[i - 1], y: out[i - 1].y + uy * lengths[i - 1] };
        }
        return { joints: out, reached: false };
    }

    // Move a point to sit exactly `length` away from `from`, along the line toward where it already
    // is. This projection IS the algorithm — because every joint is placed this way, the bones keep
    // their lengths however many passes run, which is what makes a partly-converged chain still a
    // valid pose rather than a stretched one.
    const pull = (from: IkPoint, toward: IkPoint, length: number): IkPoint => {
        const d = Math.hypot(toward.x - from.x, toward.y - from.y);
        // COINCIDENT points have no direction to project along. Pushing along +x is arbitrary but
        // finite and stable; dividing by zero here would put NaN into every joint after it.
        if (!(d > 0)) return { x: from.x + length, y: from.y };
        return { x: from.x + (toward.x - from.x) * (length / d), y: from.y + (toward.y - from.y) * (length / d) };
    };

    // THE SINGULAR CASE, broken before the loop rather than detected inside it. When every joint
    // already lies on the line to the target there is no side for the chain to bend toward, and
    // the two passes are exact inverses of one another — the chain sits still and reports failure
    // for a target it could reach easily. Nudging the interior joints perpendicular gives the
    // iteration a side to commit to, and doing it up front keeps the loop free of special cases.
    const ux = (target.x - root.x) / (reach > 0 ? reach : 1);
    const uy = (target.y - root.y) / (reach > 0 ? reach : 1);
    let collinear = true;
    for (let i = 1; i < n && collinear; i++) {
        const cross = (out[i].x - root.x) * uy - (out[i].y - root.y) * ux;
        if (Math.abs(cross) > 1e-9) collinear = false;
    }
    if (collinear) {
        const seed = total * FABRIK_SEED;
        for (let i = 1; i < n - 1; i++) out[i] = { x: out[i].x - uy * seed, y: out[i].y + ux * seed };
    }

    const arrived = () => Math.hypot(out[n - 1].x - target.x, out[n - 1].y - target.y) <= FABRIK_TOLERANCE;
    for (let pass = 0; pass < FABRIK_PASSES; pass++) {
        // ONE exit and ONE definition of having arrived. Written first as an early return plus a
        // second copy of the same expression after the loop, which left the after-the-loop copy
        // reachable only by a chain that never converges — so a mutation hard-coding it to `true`
        // survived every test. Two statements of one fact, and only one of them exercised.
        if (arrived()) break;
        // BACKWARD: the end goes to the target and the chain is dragged after it. This is the pass
        // that satisfies the goal, and it is the one that moves the root off where it belongs.
        out[n - 1] = { x: target.x, y: target.y };
        for (let i = n - 2; i >= 0; i--) out[i] = pull(out[i + 1], out[i], lengths[i]);
        // FORWARD: the root is put back and the chain dragged after IT. This is the pass that
        // restores the anchor, at the cost of the end drifting off the target again — which is why
        // the two alternate rather than either being enough.
        out[0] = { x: root.x, y: root.y };
        for (let i = 1; i < n; i++) out[i] = pull(out[i - 1], out[i], lengths[i - 1]);
    }
    return { joints: out, reached: arrived() };
}
