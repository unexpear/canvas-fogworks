/**
 * @module alignActions
 * @description Turns an align/distribute request into one undoable Action.
 *
 * The maths is pure and lives in `geometry/Alignment`; this is the seam that decides WHICH
 * nodes move and how a world-space result becomes a stored-geometry edit.
 *
 * Three rules it enforces, each for the same underlying reason — stored geometry is
 * parent-relative, so a world delta is only a stored delta when nothing between the node and
 * the canvas rotates or scales it:
 *
 *  - only selection ROOTS move (a child travels with its parent, so moving both double-moves it);
 *  - every root must be a TRANSLATION-ONLY chain, exactly as snapping and group-move require;
 *  - a LAID-OUT child is skipped, because an auto-layout parent computes its position and the
 *    stored x/y we would write is dead data.
 *
 * Each move is routed through `geometryActionFor`, so aligning an instance COPY writes a
 * per-instance override instead of failing silently, and the whole set commits as ONE
 * transaction — one undo step for one click.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { TransactionAction } from "./TransactionAction";
import { geometryActionFor } from "./nodeEdit";
import { selectionRoots } from "../document/SceneGraph";
import { expandInstances } from "../document/Components";
import { ComputedState } from "../geometry/GeometryEngine";
import { isTranslationOnlyChain } from "../geometry/Snapping";
import { isAbsolute, isLayoutContainer } from "../geometry/LayoutEngine";
import { alignBoxes, distributeBoxes, AlignEdge, DistributeAxis, Placements } from "../geometry/Alignment";
import { Rect } from "../geometry/Matrix";

/** The nodes an align/distribute may actually move, with their world boxes — in a stable order. */
function movable(doc: ReadonlyDocument, computed: ComputedState, nodeIds: readonly string[]): { ids: string[]; boxes: Rect[] } {
    const eff = expandInstances(doc);
    const ids: string[] = [];
    const boxes: Rect[] = [];
    for (const id of selectionRoots(eff, [...nodeIds])) {
        const node = eff.nodes.get(id);
        const c = computed.nodes.get(id);
        if (!node || !c) continue;
        // A world delta maps 1:1 onto stored geometry only through a translation-only chain.
        if (!isTranslationOnlyChain(eff, id)) continue;
        // An in-flow child of a container is positioned BY the layout; its stored x/y is ignored.
        const parent = node.parent ? eff.nodes.get(node.parent) : undefined;
        if (isLayoutContainer(parent) && !isAbsolute(node)) continue;
        ids.push(id);
        boxes.push(c.bounds);
    }
    return { ids, boxes };
}

/** Build one transaction from the computed placements, or null when nothing moves. */
function commit(doc: ReadonlyDocument, ids: string[], boxes: Rect[], placements: Placements, label: string): Action | null {
    const eff = expandInstances(doc);
    const actions: Action[] = [];
    placements.forEach((p, i) => {
        const id = ids[i];
        const stored = eff.nodes.get(id)?.geometry;
        if (!stored) return;
        // The chain is translation-only, so the WORLD delta is exactly the STORED delta.
        const patch = { x: stored.x + (p.x - boxes[i].x), y: stored.y + (p.y - boxes[i].y) };
        const action = geometryActionFor(doc, id, patch);
        if (action) actions.push(action);
    });
    if (actions.length === 0) return null;
    // Always a transaction, even for one node: one click is one undo step regardless.
    return new TransactionAction(doc, label, actions);
}

/** Align the selection to one edge of its own bounding box. Null when nothing would move. */
export function alignAction(doc: ReadonlyDocument, computed: ComputedState, nodeIds: readonly string[], edge: AlignEdge): Action | null {
    const { ids, boxes } = movable(doc, computed, nodeIds);
    return commit(doc, ids, boxes, alignBoxes(boxes, edge), `align-${edge}`);
}

/** Even out the gaps between the selection along one axis. Null when nothing would move. */
export function distributeAction(doc: ReadonlyDocument, computed: ComputedState, nodeIds: readonly string[], axis: DistributeAxis): Action | null {
    const { ids, boxes } = movable(doc, computed, nodeIds);
    return commit(doc, ids, boxes, distributeBoxes(boxes, axis), `distribute-${axis}`);
}
