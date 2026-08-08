/**
 * @module Skin
 * @description Linear blend skinning — a point carried by bones that have moved.
 *
 * `Rig` poses a skeleton and `Mesh` bends a shape, and nothing joins them: a rig can swing a limb
 * and the artwork stays exactly where it was drawn. This is the join. Each control point names the
 * bones that carry it and how strongly, and its new position is the weighted average of where each
 * of those bones would have put it.
 *
 * ONE BONE'S ANSWER IS `posed · rest⁻¹` APPLIED TO THE POINT — where the bone has moved TO, undoing
 * where it started FROM. The inverse is the whole idea and the reason a rest pose has to exist at
 * all: without it a bone drawn already rotated would snap its artwork to the axis on the first
 * frame, because "the bone's matrix" and "how far the bone has turned" are not the same thing. It
 * is the same reasoning `Rig` states for its own rest directions, one dimension up: a delta from
 * how the character was drawn, not an absolute pose.
 *
 * FOUR BONES, MEASURED. Every one of the 52 skins in the 5,037 glTF models here carries `JOINTS_0`
 * and `WEIGHTS_0` and never a `JOINTS_1` — four influences per vertex is what real rigs use, and
 * their skeletons are small (6 or 7 joints in 47 of the 52). The cap is not a guess about what is
 * enough; it is what the art in this repository actually needs, and a bound on a hand-editable
 * list besides.
 *
 * WEIGHTS ARE NORMALISED HERE rather than trusted. A rig where they sum to 1.2 does not deform 20%
 * more, it deforms WRONGLY — the point flies off along whichever bones happened to be listed — and
 * exported weights very often miss by a rounding error. Dividing by the sum makes the common near
 * miss a non-event and the pathological case merely wrong-looking rather than divergent.
 *
 * WHAT THIS DOES NOT DO: dual quaternion blending. Linear blending collapses a joint bent past
 * about 120 degrees — the "candy wrapper" — and every 2D rigging tool ships with it anyway,
 * because at the angles a limb actually bends the difference is invisible and the arithmetic is a
 * quarter the size. Stated so the limitation is a decision rather than a surprise.
 */

import { Mat2D, applyToPoint, invert, multiply } from "./Matrix";

/**
 * Influences one control point may carry.
 *
 * See the module note: four is what every measured rig uses, not a guess.
 */
export const SKIN_MAX_BONES = 4;

/** One bone's pull on a point: which node, and how strongly. */
export interface BoneWeight {
    /** The node acting as the bone. */
    node: string;
    /** Relative strength. Normalised against the other weights on the same point. */
    weight: number;
}

/** One influence resolved to matrices — where the bone was drawn, and where it is now. */
export interface BonePose {
    rest: Mat2D;
    posed: Mat2D;
    weight: number;
}

/** What went wrong with a list of influences, or null. */
export function boneWeightsError(weights: unknown): string | null {
    if (weights === undefined) return null;
    if (!Array.isArray(weights)) return "bone weights must be an array";
    if (weights.length > SKIN_MAX_BONES) return `a point may not name more than ${SKIN_MAX_BONES} bones`;
    const seen = new Set<string>();
    for (const w of weights) {
        if (w === null || typeof w !== "object") return "every bone weight must be an object";
        if (typeof w.node !== "string" || w.node.length === 0) return "a bone weight must name a node";
        // THE SAME BONE TWICE is not two influences, it is one written twice — and it would count
        // double in the normalisation, quietly outvoting the others.
        if (seen.has(w.node)) return `a point may not name the bone "${w.node}" twice`;
        seen.add(w.node);
        if (!Number.isFinite(w.weight)) return "a bone weight must be a finite number";
        // NEGATIVE IS NOT A REPULSION. It makes the normalising sum shrink or flip sign, so one
        // bone's small negative weight can send a point to infinity — refused rather than clamped,
        // because there is no sensible thing the author could have meant.
        if (w.weight < 0) return "a bone weight must not be negative";
    }
    return null;
}

/**
 * A point carried by its bones, in whatever space the matrices are expressed in.
 *
 * SPACE-AGNOSTIC ON PURPOSE. Everything here is `posed · rest⁻¹`, which is a change of pose rather
 * than a change of frame, so the caller decides what space the point and the matrices live in and
 * this stays testable with hand-written matrices and no document at all.
 *
 * NO BONES, OR NO WEIGHT BETWEEN THEM, LEAVES THE POINT WHERE IT IS. An unweighted point is not
 * pinned to the origin — it is simply not skinned, which is what an unbound part of a drawing
 * should do. A bone whose rest matrix cannot be inverted (a limb scaled to nothing) contributes
 * nothing rather than a NaN that would spread through the average and take the others with it.
 */
export function skinnedPoint(
    point: { x: number; y: number },
    bones: readonly BonePose[]
): { x: number; y: number } {
    let total = 0;
    let x = 0, y = 0;
    for (const bone of bones) {
        // A FAST PATH, NOT A RULE, and deleting it passes every test — a zero weight contributes
        // `moved * 0` to the sum and `0` to the total, which is exactly nothing. It is kept because
        // a 64x64 mesh is 4,225 points and this skips an inversion and a multiply per bone on every
        // one of them, every frame. Noted so the survivor is a measured no-op rather than a hole.
        if (!(bone.weight > 0)) continue;
        const inv = invert(bone.rest);
        if (!inv) continue;
        const moved = applyToPoint(multiply(bone.posed, inv), point.x, point.y);
        if (!Number.isFinite(moved.x) || !Number.isFinite(moved.y)) continue;
        x += moved.x * bone.weight;
        y += moved.y * bone.weight;
        total += bone.weight;
    }
    if (total <= 0) return { x: point.x, y: point.y };
    return { x: x / total, y: y / total };
}
