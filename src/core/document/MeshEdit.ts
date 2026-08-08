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
