/**
 * @module Rig
 * @description The document side of inverse kinematics — a solved limb is an ORDINARY document.
 *
 * `geometry/Ik` takes points and lengths and returns angles. This turns a node into those points
 * and the angles back into transforms, and it is a separate file for the reason every seam here is
 * separate: the arithmetic is worth testing without a document, and the document work is worth
 * reading without the trigonometry.
 *
 * THE CONSTRAINT SITS ON THE END EFFECTOR, because that is the node whose position is being stated.
 * The two bones it drives are its PARENT and its GRANDPARENT — a hand states where it is, and the
 * forearm and upper arm follow.
 *
 * BONE LENGTHS ARE NOT STORED. A bone runs JOINT TO JOINT — from the parent's transform origin to
 * the child's — and its length is the magnitude of that vector, which the document already holds.
 * A stored length would be a second copy free to disagree the first time somebody moves a joint.
 * The joints matter and are not a detail: measuring bones between node POSITIONS instead puts the
 * end effector up to several pixels off its target and makes it WANDER as the middle joint turns,
 * because the vector the rotation actually swings starts at the pivot rather than at the corner.
 * That is what a planted foot drifting 11px turned out to be.
 *
 * IT SOLVES IN THE ROOT'S PARENT SPACE, which is what keeps it out of the geometry engine. Bone
 * lengths are magnitudes of stored offsets and magnitudes do not care about rotation, so the whole
 * solve needs the document and nothing else. `applyIk` therefore slots in beside `applyFrame`, and
 * layout, picking, snapping and all three backends learn nothing about skeletons.
 *
 * THE SOLVED ANGLE IS A DELTA FROM THE REST POSE. A bone's rest direction is the direction of its
 * own joint-to-joint vector, so a rig posed by IK composes with however the character was drawn
 * rather than assuming every limb was authored pointing down one particular axis.
 */

import { ReadonlyDocument, ProjectDocument } from "./Document";
import { Node } from "./Node";
import { solveTwoBone, rotationDelta, IkBend } from "../geometry/Ik";

/** How far a target may sit from the origin. Bounded for the reason every hand-editable number is. */
export const IK_TARGET_MAX = 1_000_000;

/**
 * Where a node is asked to be, and which way its chain folds.
 *
 * The target is in the ROOT's parent space — the same space the root's own `geometry.x/y` is in,
 * so an author placing a foot reads its coordinates off the same ruler as everything else.
 */
export interface IkConstraint {
    x: number;
    y: number;
    /** Anatomy, so it is stated. Absent = +1. See `geometry/Ik` for why it is never inferred. */
    bend?: IkBend;
}

/** Validity of an IK constraint, SHARED by the edit path and the load path. */
export function ikError(ik: unknown): string | null {
    if (ik === undefined) return null;
    if (typeof ik !== "object" || ik === null || Array.isArray(ik)) return "ik must be an object";
    const c = ik as Partial<IkConstraint>;
    for (const axis of ["x", "y"] as const) {
        const v = c[axis];
        // NON-FINITE is the one that matters: a NaN target makes every angle NaN, and a transform
        // built from those puts the whole limb nowhere at all, frames from the cause.
        if (!Number.isFinite(v)) return `ik.${axis} must be a finite number`;
        if (Math.abs(v as number) > IK_TARGET_MAX) return `ik.${axis} must be within ±${IK_TARGET_MAX}`;
    }
    if (c.bend !== undefined && c.bend !== 1 && c.bend !== -1) return "ik.bend must be 1 or -1";
    return null;
}

/**
 * Where a node's JOINT sits inside its own box — its transform origin, in pixels.
 *
 * A bone runs from joint to joint, and a joint is the point the node turns about. Measuring bones
 * between node POSITIONS instead is subtly wrong in a way that looks like a loose solver: the hip
 * in the demo pivots 11px right of its own corner, so a bone measured corner-to-corner is a
 * different vector from the one the rotation actually swings, and the foot lands up to 7px off its
 * target and wanders as the knee turns. Found by measuring a planted foot and watching it drift.
 */
function jointOffset(node: Node): { x: number; y: number } {
    const origin = node.transform?.origin;
    return {
        x: (origin?.x ?? 0.5) * node.geometry.width,
        y: (origin?.y ?? 0.5) * node.geometry.height
    };
}

/** The bone reaching a child: from the PARENT's joint to the CHILD's, in the parent's own frame. */
function boneTo(child: Node, parentJoint: { x: number; y: number }): { x: number; y: number } {
    const own = jointOffset(child);
    return { x: child.geometry.x + own.x - parentJoint.x, y: child.geometry.y + own.y - parentJoint.y };
}

/**
 * Every IK constraint in the document, solved — an ordinary document out.
 *
 * A document with no constraint is returned BY REFERENCE, the same bargain `applyFrame` makes: this
 * runs on every derivation, so a document that is not rigged must cost what it did before rigs
 * existed.
 */
export function applyIk(doc: ReadonlyDocument): ReadonlyDocument {
    let any = false;
    doc.nodes.forEach(n => { if (n.ik) any = true; });
    if (!any) return doc;

    const nodes = new Map<string, Node>();
    doc.nodes.forEach((n, id) => nodes.set(id, n as Node));

    doc.nodes.forEach((effector, id) => {
        const ik = effector.ik;
        if (!ik) return;
        // THE CHAIN IS THE SCENE GRAPH: the effector's parent is the second bone's node and its
        // grandparent is the first bone's. A chain that does not have both is not a two-bone limb,
        // and posing whatever is there instead would be a guess about what the author meant.
        const mid = effector.parent ? doc.nodes.get(effector.parent) : undefined;
        const root = mid?.parent ? doc.nodes.get(mid.parent) : undefined;
        if (!mid || !root) return;

        const rootJoint = jointOffset(root as Node), midJoint = jointOffset(mid as Node);
        const bone1 = boneTo(mid as Node, rootJoint), bone2 = boneTo(effector as Node, midJoint);
        const l1 = Math.hypot(bone1.x, bone1.y), l2 = Math.hypot(bone2.x, bone2.y);
        // The chain starts at the root's JOINT, in its parent's space — the same space the target
        // is given in, so an author places a foot on the same ruler everything else is placed on.
        const from = { x: root.geometry.x + rootJoint.x, y: root.geometry.y + rootJoint.y };
        const solution = solveTwoBone(from, { x: ik.x, y: ik.y }, l1, l2, ik.bend ?? 1);

        // REST DIRECTIONS come from the authored offsets, so the deltas compose with the drawing
        // rather than assuming a limb points down any particular axis. The second bone's rest is
        // its own offset direction PLUS whatever the first bone already contributes, because a
        // child's rotation is relative to its parent — leaving that out double-counts the shoulder.
        const rest1 = Math.atan2(bone1.y, bone1.x);
        const rest2 = Math.atan2(bone2.y, bone2.x);
        const turn1 = rotationDelta(rest1, solution.angle1);
        const turn2 = rotationDelta(rest2 + turn1, solution.angle2);

        nodes.set(root.id, turned(nodes.get(root.id) as Node, turn1));
        nodes.set(mid.id, turned(nodes.get(mid.id) as Node, turn2));
    });

    return {
        version: doc.version,
        metadata: doc.metadata as ProjectDocument["metadata"],
        nodes,
        rootNodeUuids: [...doc.rootNodeUuids],
        variables: doc.variables as ProjectDocument["variables"],
        activeTheme: doc.activeTheme,
        activeState: doc.activeState,
        timeline: doc.timeline,
        clips: doc.clips as ProjectDocument["clips"],
        frame: doc.frame
    } as ProjectDocument;
}

/**
 * A copy of the node turned by `rotation`, keeping whatever else its transform said.
 *
 * The transform group is REPLACED rather than written into: the node in the map may still be the
 * very object the stored document holds, and editing it here would change the document from a
 * function that only derives from it — the same trap channels had to be written around.
 */
function turned(node: Node, rotation: number): Node {
    return {
        ...node,
        transform: { scaleX: 1, scaleY: 1, ...node.transform, rotation }
    } as Node;
}
