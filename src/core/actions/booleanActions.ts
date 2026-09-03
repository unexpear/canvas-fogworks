/**
 * @module booleanActions
 * @description Combining selected shapes into one path — the editor-facing half of `PathBoolean`.
 *
 * A factory returning a `TransactionAction`, like `alignAction`/`distributeAction`: the whole
 * combine is one atomic result and therefore ONE undo, and returning null when the operation
 * cannot apply keeps an impossible click from pushing an empty revision onto the history.
 *
 * The maths runs in WORLD space, because that is the only space two nodes with different parents
 * and transforms share. The result is then re-based onto its own tight box (`normalizePathNode`),
 * so the new node's stored geometry describes where its ink actually is.
 *
 * DESTRUCTIVE by design: the operands are deleted and replaced by one `core.path`. The live
 * schema-33 alternative below creates a `core.boolean` node that keeps its children and resolves
 * at derivation time. This factory remains the explicit flatten path; both forms use the same
 * boolean geometry.
 */

import { Action } from "./Action";
import { AddNodeAction } from "./AddNodeAction";
import { DeleteNodeAction } from "./DeleteNodeAction";
import { TransactionAction } from "./TransactionAction";
import { UpdateNodePathAction } from "./UpdateNodePathAction";
import { SetBooleanOpAction } from "./SetBooleanOpAction";
import { ReparentNodeAction } from "./ReparentNodeAction";
import { MoveNodeAction } from "./MoveNodeAction";
import { ReadonlyDocument } from "../document/Document";
import { PathCommand, flatFill } from "../document/Node";
import { resolveScene } from "../document/Components";
import { selectionRoots } from "../document/SceneGraph";
import { ComputedState } from "../geometry/GeometryEngine";
import { isLayoutContainer } from "../geometry/LayoutEngine";
import { resolveBooleanPaths } from "../geometry/Resolve";
import { BooleanOp } from "../document/Node";
import { normalizePathNode } from "../geometry/PathBuilder";
import { shapeToCommands, transformCommands } from "../geometry/ShapeToPath";

/** A node's outline in WORLD space, or null when it has none (a line, an empty path). */
export function worldCommandsOf(computed: ComputedState, nodeId: string): PathCommand[] | null {
    const c = computed.nodes.get(nodeId);
    if (!c) return null;
    const local = shapeToCommands(c.shape, c.local.width, c.local.height);
    return local ? transformCommands(c.world, local) : null;
}

/**
 * Combine the selected nodes with `op`, bottom-most first.
 *
 * Order matters for `subtract`: the bottom-most shape is the one being cut, matching every design
 * tool and matching what the canvas shows — the thing underneath survives. Draw order comes from
 * the computed state rather than from selection order, so clicking two shapes in either sequence
 * gives the same, predictable result.
 *
 * Null when fewer than two operands have an outline, or when the result is empty (an intersect of
 * shapes that do not overlap). An empty result would otherwise delete the operands and leave a
 * zero-area node behind — destroying work to produce nothing.
 */
export function booleanAction(
    doc: ReadonlyDocument,
    computed: ComputedState,
    selectedNodeIds: readonly string[],
    op: BooleanOp,
    /** The result's id, MINTED BY THE CALLER — both halves of the transaction have to name it,
     *  and an id `AddNodeAction` generated internally would be invisible to the second half. */
    newId: string
): Action | null {
    const roots = selectionRoots(resolveScene(doc), [...selectedNodeIds]);
    // STORED nodes only: an instance copy has no stored identity to delete, and baking one into
    // a path would silently detach part of an instance. Deep vector edits on instance content go
    // through detach first, which is the same rule the vertex editor and the pen follow.
    const ids = computed.order.filter(id => roots.includes(id) && doc.nodes.has(id));

    const operands: { id: string; commands: PathCommand[] }[] = [];
    for (const id of ids) {
        const commands = worldCommandsOf(computed, id);
        if (commands) operands.push({ id, commands });
    }
    // ONE count check, on the operands rather than the ids: an id that converts to no outline is
    // not an operand, so a separate `ids.length` guard could only ever refuse a subset of what
    // this refuses. (Two earlier guards — that one, and an empty-intermediate early return —
    // were both provably equivalent to nothing and are gone. An empty intermediate can only come
    // from intersect or subtract, and both keep it empty, so the zero-area check below is the
    // only one that ever fires.)
    if (operands.length < 2) return null;

    let result = operands[0].commands;
    for (let i = 1; i < operands.length; i++) {
        result = resolveBooleanPaths(result, operands[i].commands, op);
    }

    // The new node inherits the BOTTOM-most operand's paint: the result occupies the place the
    // shape underneath did, so taking its appearance is the least surprising answer.
    const base = doc.nodes.get(operands[0].id);
    const norm = normalizePathNode({ x: 0, y: 0, width: 0, height: 0 }, result);
    if (norm.geometry.width === 0 && norm.geometry.height === 0) return null;

    const actions: Action[] = [
        new AddNodeAction(
            doc, "core.path",
            norm.geometry.x, norm.geometry.y, norm.geometry.width, norm.geometry.height,
            base ? flatFill(base.style.fill) : "#cccccc", newId, null, undefined,
            base?.style.stroke, base?.style.strokeWidth
        ),
        // The path itself needs its own action: `AddNodeAction` creates the node and its box,
        // and `path` is the one field only `UpdateNodePathAction` may write. Inside a transaction
        // the second action sees the first's node, which is exactly what create-then-edit is for.
        new UpdateNodePathAction(doc, newId, norm.path)
    ];
    for (const operand of operands) actions.push(new DeleteNodeAction(doc, operand.id));

    return new TransactionAction(doc, `boolean:${op}`, actions);
}

/**
 * Wrap the selection in a LIVE `core.boolean` node (schema 33) — the non-destructive combine.
 *
 * The operands become its children and stay editable: move one, restyle it, or change the
 * operation, and the result follows, because the combination is derived at the display seam
 * rather than baked. `booleanAction` above is the same maths flattened into a plain path; this is
 * the form a design tool actually wants, and the flat one is what "flatten" should mean later.
 *
 * The new node's box is the operands' union in their shared parent space, and each child is
 * re-based onto it — the same reparenting `FrameSelectionAction` does, and for the same reason:
 * `geometry.x/y` is parent-relative, so a child that moves house has to be re-expressed.
 *
 * Null when fewer than two operands share a parent, or when any of them is a laid-out child (its
 * stored x/y is dead data that a container computes, so re-basing it would move the wrong thing).
 */
export function makeBooleanNodeAction(
    doc: ReadonlyDocument,
    computed: ComputedState,
    selectedNodeIds: readonly string[],
    op: BooleanOp,
    newId: string
): Action | null {
    const roots = selectionRoots(resolveScene(doc), [...selectedNodeIds]);
    const ids = computed.order.filter(id => roots.includes(id) && doc.nodes.has(id));
    if (ids.length < 2) return null;

    const nodes = ids.map(id => doc.nodes.get(id)!);
    // ONE parent: the new node is inserted there, and every child's stored position is relative
    // to it. Mixing parents would need each child re-expressed through a different chain.
    const parent = nodes[0].parent ?? null;
    if (nodes.some(n => (n.parent ?? null) !== parent)) return null;
    // A laid-out child's position is computed by its container, so its stored x/y is dead data.
    const parentNode = parent != null ? doc.nodes.get(parent) : undefined;
    if (parentNode && isLayoutContainer(parentNode)) return null;

    const minX = Math.min(...nodes.map(n => n.geometry.x));
    const minY = Math.min(...nodes.map(n => n.geometry.y));
    const maxX = Math.max(...nodes.map(n => n.geometry.x + n.geometry.width));
    const maxY = Math.max(...nodes.map(n => n.geometry.y + n.geometry.height));
    if (!(maxX > minX || maxY > minY)) return null;

    const actions: Action[] = [
        new AddNodeAction(
            doc, "core.boolean", minX, minY, maxX - minX, maxY - minY,
            flatFill(nodes[0].style.fill), newId, parent, undefined, nodes[0].style.stroke, nodes[0].style.strokeWidth
        ),
        new SetBooleanOpAction(doc, newId, op)
    ];
    for (const node of nodes) {
        actions.push(new ReparentNodeAction(doc, node.id, newId));
        // Re-based INTO the new box, so the child lands where it already was on screen.
        actions.push(new MoveNodeAction(doc, node.id, node.geometry.x - minX, node.geometry.y - minY));
    }
    return new TransactionAction(doc, `boolean-node:${op}`, actions);
}
