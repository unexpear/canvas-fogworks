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
import { solveTwoBone, solveFabrik, rotationDelta, IkBend, IkPoint } from "../geometry/Ik";

/** How far a target may sit from the origin. Bounded for the reason every hand-editable number is. */
export const IK_TARGET_MAX = 1_000_000;

/**
 * Bones one constraint may drive.
 *
 * Generous rather than tight — a tail with thirty segments is a real thing to draw — but bounded,
 * because the chain walk is a loop over a hand-editable number and an unbounded one is a document
 * that can ask the engine to walk forever.
 */
export const IK_CHAIN_MAX = 32;

/**
 * Where a node is asked to be, and which way its chain folds.
 *
 * The target is in the ROOT's parent space — the same space the root's own `geometry.x/y` is in,
 * so an author placing a foot reads its coordinates off the same ruler as everything else.
 */
export interface IkConstraint {
    x: number;
    y: number;
    /**
     * Anatomy, so it is stated. Absent = +1. See `geometry/Ik` for why it is never inferred.
     *
     * Meaningful only for a TWO-BONE chain: a triangle has exactly two solutions and this names
     * one. A longer chain has a continuum of poses and there is nothing for +1 or -1 to select, so
     * carrying both is refused rather than silently ignored.
     */
    bend?: IkBend;
    /**
     * How many BONES this constraint drives, counted up from the effector. Absent = 2.
     *
     * Two is the limb and the case that existed before longer chains did, so an older document
     * reinterprets to exactly what it always meant. Three or more is a spine, a tail, a tentacle —
     * and is solved by FABRIK rather than the closed form, because past two bones the pose is not
     * unique.
     */
    chain?: number;
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
    if (c.chain !== undefined) {
        if (!Number.isInteger(c.chain) || c.chain < 2 || c.chain > IK_CHAIN_MAX) {
            return `ik.chain must be a whole number within [2, ${IK_CHAIN_MAX}]`;
        }
        // A STATEMENT THE ENGINE CANNOT HONOUR. `bend` names one of a triangle's two solutions;
        // a longer chain has a continuum and there is nothing for it to select. Refusing beats
        // ignoring the field, which would leave an author believing it did something.
        if (c.bend !== undefined && c.chain > 2) return "ik.bend applies to a two-bone chain only";
    }
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
 * The nodes and bones a constraint drives, root first — or null if the graph cannot supply them.
 *
 * THE CHAIN IS THE SCENE GRAPH: walking `bones` ancestors up from the effector is the whole of it,
 * which is why there is no bone type. A chain that runs out of ancestors is not the chain the
 * author described, and posing whatever happens to be there would be a guess — so it is left alone.
 */
function walkChain(doc: ReadonlyDocument, effector: Node, bones: number): Chain | null {
    const nodes: Node[] = [];
    let node: Node | undefined = effector;
    // `bones` bones need `bones` + 1 joints, so the walk collects the effector and that many
    // ancestors. Collected effector-first and reversed, because the graph only points upward.
    for (let i = 0; i <= bones; i++) {
        if (!node) return null;
        nodes.push(node);
        const parent: string | null | undefined = node.parent;
        node = parent ? (doc.nodes.get(parent) as Node | undefined) : undefined;
    }
    nodes.reverse();

    const root = nodes[0];
    const rootJoint = jointOffset(root);
    // The chain starts at the root's JOINT, in its parent's space — the same space the target is
    // given in, so an author places a foot on the same ruler everything else is placed on.
    const from = { x: root.geometry.x + rootJoint.x, y: root.geometry.y + rootJoint.y };

    const boneVectors: IkPoint[] = [];
    const joints: IkPoint[] = [from];
    let parentJoint = rootJoint;
    for (let i = 1; i < nodes.length; i++) {
        const bone = boneTo(nodes[i], parentJoint);
        boneVectors.push(bone);
        joints.push({ x: joints[i - 1].x + bone.x, y: joints[i - 1].y + bone.y });
        parentJoint = jointOffset(nodes[i]);
    }
    // The DRIVEN nodes are every one but the effector: a bone is turned by the node at its start,
    // and the effector starts no bone. Dropping it here is CLARITY rather than correctness — the
    // rotation walk runs over the BONES, so an effector left in the list is simply never indexed,
    // and a mutation keeping it survives. It goes because a list called `nodes` that drives
    // rotations should not contain a node that drives none.
    return { nodes: nodes.slice(0, nodes.length - 1), bones: boneVectors, joints };
}

/** A resolved chain: the nodes that turn, the bones they turn, and where the joints rest. */
interface Chain {
    nodes: Node[];
    bones: IkPoint[];
    joints: IkPoint[];
}

/** The closed form, as absolute bone directions. */
function twoBoneAngles(chain: Chain, target: IkPoint, bend: IkBend): number[] {
    const l1 = Math.hypot(chain.bones[0].x, chain.bones[0].y);
    const l2 = Math.hypot(chain.bones[1].x, chain.bones[1].y);
    const s = solveTwoBone(chain.joints[0], target, l1, l2, bend);
    return [s.angle1, s.angle2];
}

/**
 * FABRIK's solved joint positions, turned into absolute bone directions.
 *
 * The conversion is here rather than in the solver because it is what the DOCUMENT needs, and
 * keeping it beside the two-bone conversion is what lets both feed the same rotation walk. A second
 * copy of that walk is how the two solvers would come to disagree about composing a parent's turn.
 */
function fabrikAngles(chain: Chain, target: IkPoint): number[] {
    const solved = solveFabrik(chain.joints, target).joints;
    const out: number[] = [];
    for (let i = 1; i < solved.length; i++) {
        out.push(Math.atan2(solved[i].y - solved[i - 1].y, solved[i].x - solved[i - 1].x));
    }
    return out;
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

    doc.nodes.forEach(effector => {
        const ik = effector.ik;
        if (!ik) return;
        const chain = walkChain(doc, effector as Node, ik.chain ?? 2);
        if (!chain) return;

        const target = { x: ik.x, y: ik.y };
        // TWO BONES KEEP THE CLOSED FORM. An iterative approximation where an exact answer exists
        // would be slower, less exact, and would make the commonest rig in animation depend on a
        // convergence argument. One comparison buys the right solver.
        const angles = chain.bones.length === 2
            ? twoBoneAngles(chain, target, ik.bend ?? 1)
            : fabrikAngles(chain, target);

        // REST DIRECTIONS come from the authored joint-to-joint vectors, so the deltas compose with
        // the drawing rather than assuming a limb points down any particular axis. Each bone's rest
        // is its own direction PLUS every turn its ancestors in the chain have already contributed,
        // because a child's rotation is relative to its parent — leaving that out double-counts the
        // shoulder, and does so once more per extra bone.
        let carried = 0;
        for (let i = 0; i < chain.bones.length; i++) {
            const rest = Math.atan2(chain.bones[i].y, chain.bones[i].x);
            const turn = rotationDelta(rest + carried, angles[i]);
            carried += turn;
            const node = chain.nodes[i];
            nodes.set(node.id, turned(nodes.get(node.id) as Node, turn));
        }
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
