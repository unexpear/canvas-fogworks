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
 * answer every run. Longer chains need FABRIK or CCD and are deliberately not here: a general
 * solver whose two-bone case is worse than the closed form is a poor trade for the case that
 * matters most.
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
