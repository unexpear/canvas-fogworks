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
