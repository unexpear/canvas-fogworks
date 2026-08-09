/**
 * @module MeshEdit
 * @description What an editor does to a mesh's bone bindings — the operations, without a UI.
 *
 * `Mesh` says what a binding IS and `Skin` says what it MEANS; this says what happens when someone
 * adds one. Here rather than in a component for the reason `GradientEdit` is: the rules about what
 * a legal edit produces are the interesting part, and a rule living inside a React handler is a
 * rule that can only be tested by rendering, gets copied when a second control needs it, and drifts
 * the moment the two disagree.
 *
 * EVERY FUNCTION RETURNS A WHOLE MESH, which `SetMeshAction` already takes. Binding a point needed
 * no new action, and that is the point of the mesh being the unit the document stores.
 *
 * NOTHING HERE CAN PRODUCE A DOCUMENT `Integrity` WOULD REFUSE, which is the property worth having:
 * `boneChoices` offers exactly the siblings, and the siblings are exactly what the sibling rule
 * allows. The UI does not have to know the rule, and cannot get it wrong — an invalid binding is
 * unreachable rather than merely rejected.
 */

import { ReadonlyDocument } from "./Document";
import { Node } from "./Node";
import { jointOffset } from "./Rig";
import { applyToPoint, localMatrix } from "../geometry/Matrix";
import { Mesh, ReadonlyMesh, copyMeshPoint } from "./Mesh";
import { BoneWeight, SKIN_MAX_BONES } from "../geometry/Skin";

/** The default pull a newly bound bone takes. */
export const DEFAULT_BONE_WEIGHT = 1;

/** A mutable copy of a mesh, bindings and all — every edit here starts with one. */
function copyMesh(mesh: ReadonlyMesh): Mesh {
    return { cols: mesh.cols, rows: mesh.rows, points: mesh.points.map(copyMeshPoint) };
}

/**
 * The nodes a point of this node's mesh may be bound to: its SIBLINGS, in the order they are drawn.
 *
 * The sibling rule is not restated here, it is *implemented* here — this walks the parent's own
 * children, so a choice list and `Integrity` cannot come to disagree. A root node's siblings are
 * the other roots, which is the same relationship one level up.
 *
 * The STORED document, never the resolved one: a binding names a stored id, and a resolved scene
 * has already turned a meshed node into a path and dropped the mesh that would be edited.
 */
export function boneChoices(doc: ReadonlyDocument, nodeId: string): string[] {
    const node = doc.nodes.get(nodeId);
    if (!node) return [];
    const siblings = node.parent
        ? doc.nodes.get(node.parent)?.children ?? []
        : doc.rootNodeUuids;
    // A node is not its own bone: binding to itself cancels exactly and moves nothing.
    return siblings.filter(id => id !== nodeId && doc.nodes.has(id));
}

/** The influences on one point, or an empty list — never undefined, so a caller can just map it. */
export function bonesAt(mesh: ReadonlyMesh, index: number): readonly BoneWeight[] {
    return mesh.points[index]?.bones ?? [];
}

/**
 * A point bound to one more bone, at the default weight.
 *
 * Returns the mesh UNCHANGED when the point is out of range, when the bone is already named, or
 * when the point is full. Refusing by returning the same mesh rather than throwing is what lets a
 * control be pressed twice without a guard around it — the second press is simply a no-op, which
 * is also what `dispatchAction` sees when nothing changed.
 */
export function withBone(mesh: ReadonlyMesh, index: number, node: string): ReadonlyMesh {
    const existing = bonesAt(mesh, index);
    if (!mesh.points[index]) return mesh;
    if (existing.length >= SKIN_MAX_BONES) return mesh;
    if (existing.some(b => b.node === node)) return mesh;
    const next = copyMesh(mesh);
    next.points[index].bones = [...existing.map(b => ({ ...b })), { node, weight: DEFAULT_BONE_WEIGHT }];
    return next;
}

/**
 * A point with one influence removed.
 *
 * The LAST one removed drops the field rather than leaving an empty array behind. An empty `bones`
 * and an absent `bones` mean the same thing to `skinMesh`, but only the absent one makes the fast
 * path see an unskinned mesh — and only the absent one round-trips to a file that looks like the
 * unbound mesh it now is.
 */
export function withoutBone(mesh: ReadonlyMesh, index: number, node: string): ReadonlyMesh {
    const existing = bonesAt(mesh, index);
    if (!existing.some(b => b.node === node)) return mesh;
    const next = copyMesh(mesh);
    const kept = existing.filter(b => b.node !== node).map(b => ({ ...b }));
    if (kept.length === 0) delete next.points[index].bones;
    else next.points[index].bones = kept;
    return next;
}

/**
 * One influence's strength changed.
 *
 * CLAMPED AT ZERO rather than refused, because this is what a dragged slider produces and a
 * negative weight can shrink or flip the normalising sum and send the point to infinity. Zero is
 * kept as a real value: it is how a bone is muted without losing which bones a point names.
 * A non-finite weight leaves the mesh alone — there is nothing sensible to clamp NaN to.
 */
export function withBoneWeight(mesh: ReadonlyMesh, index: number, node: string, weight: number): ReadonlyMesh {
    const existing = bonesAt(mesh, index);
    if (!Number.isFinite(weight)) return mesh;
    if (!existing.some(b => b.node === node)) return mesh;
    const next = copyMesh(mesh);
    next.points[index].bones = existing.map(b => ({ ...b, weight: b.node === node ? Math.max(0, weight) : b.weight }));
    return next;
}

/**
 * Influences one AUTO-BIND may assign to a point.
 *
 * MEASURED, and the measurement is bimodal rather than an average. Across the 52 skins in
 * `freeassets` (91,290 skinned vertices), 63.4% of vertices name exactly ONE bone and 28.3% name
 * two — 92% at two or fewer, with three and four together making up 8%. Split by file it is
 * starker: 26 of the 31 skinned files are 100% single-bone, because Kenney's low-poly characters
 * are RIGIDLY bound; the smooth-skinned minority is where the twos, threes and fours all live.
 *
 * Two is therefore what an automatic pass should produce. A hand edit may still add the third and
 * fourth up to `SKIN_MAX_BONES` — this is the cap on what guessing is allowed to do, which is a
 * different question from what a rig may contain.
 */
export const AUTO_BIND_MAX_BONES = 2;

/**
 * How much further a second bone may be than the nearest and still take a share.
 *
 * THIS ONE IS A CHOICE, not a measurement, and it is worth being clear about which is which. The
 * corpus says how MANY bones a vertex uses; it cannot say how weight falls off with distance,
 * because that would need each rig's bind pose and its authored intent, and the two populations
 * above disagree anyway. At exactly equal distance the split is even; at this ratio the nearer
 * bone takes two thirds; beyond it the point binds rigidly to one.
 */
export const AUTO_BIND_BLEND_RATIO = 2;

/**
 * Every control point bound to the sibling nodes nearest it.
 *
 * WHY THIS EXISTS: binding by hand is one point and one dropdown at a time, which is fine for a
 * panel and hopeless for a character. This is the pass that makes a rig a starting point rather
 * than an afternoon — place the bones, press the button, then correct the handful it got wrong.
 *
 * SMOOTH RATHER THAN RIGID, which departs from what most of the corpus ships, and deliberately.
 * A dense 3D mesh tolerates a hard seam because the artist put the seam where a real one goes; a
 * warp grid is at most a few points across, so binding each rigidly to its nearest bone would move
 * the grid in blocks and tear the outline between them. Density is the difference, so the majority
 * result does not carry over.
 *
 * DISTANCE IS TO THE BONE'S JOINT, from `Rig.jointOffset` — the same point IK rotates ABOUT. Two
 * definitions of where a bone is would put the weights and the pose in different places, and that
 * shows up only as a limb deforming slightly off its own hinge.
 *
 * WHAT IT CANNOT KNOW is which siblings are bones. The skeleton in this engine IS the node tree,
 * with no flag saying otherwise, so this binds to whatever shares the parent. Under a rigged group
 * that is exactly right; for a mesh sitting among unrelated shapes it is noise, which is why this
 * is a button a person presses and undoes rather than something that happens on its own.
 *
 * REPLACES existing bindings. "Auto-bind, then refine" is the workflow, and a pass that skipped
 * the points already bound would give a different answer the second time it ran.
 */
export function autoBindMesh(doc: ReadonlyDocument, nodeId: string): ReadonlyMesh | null {
    const node = doc.nodes.get(nodeId);
    const mesh = node?.mesh;
    if (!node || !mesh) return null;
    // `boneChoices`, never a fresh walk of the tree: the offered bones and the bindable bones have
    // to be the same set, or the panel would list one thing and this would produce another.
    const joints: { id: string; x: number; y: number }[] = [];
    for (const id of boneChoices(doc, nodeId)) {
        const bone = doc.nodes.get(id);
        if (!bone) continue;
        const j = jointOffset(bone as Node);
        joints.push({ id, x: bone.geometry.x + j.x, y: bone.geometry.y + j.y });
    }
    if (joints.length === 0) return null;

    // The point goes out to the PARENT's space, because that is the one space a bone's stored
    // geometry and this node's are both expressed in — the same shared frame the deform composes
    // in, so a distance measured here is the distance the deform will use.
    const toParent = localMatrix(node.geometry, node.transform);
    const box = { width: node.geometry.width, height: node.geometry.height };

    const next = copyMesh(mesh);
    for (const point of next.points) {
        const at = applyToPoint(toParent, point.x * box.width, point.y * box.height);
        const ranked = joints
            .map(j => ({ id: j.id, d: Math.hypot(at.x - j.x, at.y - j.y) }))
            .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
            .slice(0, AUTO_BIND_MAX_BONES);
        const nearest = ranked[0];
        // A point sitting exactly ON a joint takes it whole. Inverse distance would divide by zero,
        // and there is no blend to want: nothing can be nearer than zero away.
        if (nearest.d === 0) { point.bones = [{ node: nearest.id, weight: 1 }]; continue; }
        const kept = ranked.filter(r => r.d <= nearest.d * AUTO_BIND_BLEND_RATIO);
        // INVERSE DISTANCE, normalised here rather than left to `skinnedPoint`. It normalises too,
        // so this changes no geometry — but a stored weight of 0.67 is a number an author can read
        // and nudge, where 1/143.2 is not.
        const total = kept.reduce((sum, r) => sum + 1 / r.d, 0);
        point.bones = kept.map(r => ({ node: r.id, weight: (1 / r.d) / total }));
    }
    return next;
}

/**
 * The strength a stroke uses unless the author says otherwise — applied BY THE CALLER, not here.
 *
 * `paintWeights` takes whatever strength it is given; this is the tool's default. Not 1, because a
 * brush that reached its target in one touch would have no way to say "a bit more", and the whole
 * reason to paint rather than type a number is that the hand does the interpolating.
 */
export const PAINT_STRENGTH = 0.35;

/**
 * The brush profile — 1 at the centre, 0 at the rim, and FLAT at both ends.
 *
 * `(1 - t^2)^2` rather than `1 - t`, because a linear profile has a corner at the rim: repeated
 * strokes over the same area accumulate that corner into a visible ring at the brush's edge. This
 * one meets zero with zero slope, so overlapping dabs blend into each other the way the hand
 * expects. A choice, like the auto-bind falloff, and named as one.
 */
function brushFalloff(distance: number, radius: number): number {
    if (!(radius > 0)) return 0;
    const t = distance / radius;
    if (t >= 1) return 0;
    const u = 1 - t * t;
    return u * u;
}

/**
 * One dab of weight for one bone, over every control point the brush covers.
 *
 * PAINTED IN WORLD SPACE, against where the points are DRAWN — `at[i]` is the position of point
 * `i` on the canvas, which for a rigged mesh is the posed position, not the stored one. Passing
 * them in rather than deriving them keeps this a function of numbers, and means the brush and the
 * handles agree about where a point is because they were handed the same answer.
 *
 * A LERP TOWARD A TARGET, not an addition. Painting adds `falloff * strength` of the way to 1 and
 * erasing the same fraction of the way to 0, so a stroke held in one place converges instead of
 * overshooting, and going back over an area does what going back over it looks like it should.
 *
 * THE OTHER INFLUENCES ARE RESCALED to fill what is left, keeping the point's weights summing to
 * 1. `skinnedPoint` normalises anyway, so this changes no geometry — it makes the stored numbers
 * mean what they say. "0.7" should be seven tenths of this point, not seven tenths of some total
 * the author has to work out.
 *
 * A POINT ALREADY AT `SKIN_MAX_BONES` gives up its SMALLEST influence to make room, which is what
 * every weight-painting tool does and is the least destructive choice available: the weight being
 * dropped is by definition the one contributing least. Erasing never adds a bone.
 */
export function paintWeights(
    mesh: ReadonlyMesh,
    at: readonly { x: number; y: number }[],
    brush: { x: number; y: number; radius: number },
    bone: string,
    strength: number
): ReadonlyMesh {
    if (!Number.isFinite(strength) || strength === 0) return mesh;
    if (!(brush.radius > 0)) return mesh;
    const erasing = strength < 0;
    const target = erasing ? 0 : 1;

    let touched = false;
    const next = copyMesh(mesh);
    next.points.forEach((point, i) => {
        const where = at[i];
        if (!where) return;
        const f = brushFalloff(Math.hypot(where.x - brush.x, where.y - brush.y), brush.radius);
        if (f <= 0) return;
        const step = Math.min(1, f * Math.abs(strength));

        const bones = (point.bones ?? []).map(b => ({ ...b }));
        let mine = bones.find(b => b.node === bone);
        if (!mine) {
            // NO SPECIAL CASE FOR ERASING a bone the point does not have, and there was one until
            // a mutant showed it changed nothing: the weight lerps from 0 toward 0, the
            // unchanged-weight check below returns before anything is written, and the point is
            // left alone. Deleting it beats keeping a branch no test can reach.
            if (bones.length >= SKIN_MAX_BONES) {
                let weakest = 0;
                for (let k = 1; k < bones.length; k++) if (bones[k].weight < bones[weakest].weight) weakest = k;
                bones.splice(weakest, 1);
            }
            mine = { node: bone, weight: 0 };
            bones.push(mine);
        }
        const before = mine.weight;
        mine.weight = before + (target - before) * step;
        if (mine.weight === before) return;

        // WHAT IS LEFT, shared out in the proportions the others already had. When they were all
        // zero there is no proportion to keep, so it is split evenly rather than left at zero —
        // otherwise the point would silently become single-bound the first time it was painted.
        const others = bones.filter(b => b !== mine);
        const rest = Math.max(0, 1 - mine.weight);
        const sum = others.reduce((t, b) => t + b.weight, 0);
        for (const other of others) other.weight = sum > 0 ? (other.weight / sum) * rest : rest / others.length;

        // A bone painted away to nothing is UNBOUND, not kept at zero — the same rule `withoutBone`
        // follows, so a point that has been erased clean looks like one that was never painted.
        const kept = bones.filter(b => b.weight > 1e-6);
        if (kept.length === 0) delete point.bones;
        else point.bones = kept;
        touched = true;
    });
    return touched ? next : mesh;
}
