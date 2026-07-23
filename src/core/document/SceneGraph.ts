/**
 * @module SceneGraph
 * @description Ordered traversal of the document tree.
 *
 * Draw order (z-order) and layer order are defined by `rootNodeUuids` order,
 * then each node's `children` order — NOT by the insertion order of the flat
 * `nodes` Map. Every consumer that paints or lists nodes must go through here,
 * or the same document renders differently depending on how it was built.
 *
 * Milestone 1 note: the GeometryEngine must emit ComputedState in this order.
 */

import { ReadonlyDocument } from "./Document";
import { Node } from "./Node";
import { DeepReadonly } from "./Document";

export type ReadonlyNode = DeepReadonly<Node>;

/**
 * Depth-first traversal: parents before their children, siblings in `children`
 * order, roots in `rootNodeUuids` order.
 *
 * - Cycle-safe (a `visited` set guards re-entry).
 * - Ids that do not resolve to a node are skipped.
 * - Nodes unreachable from any root are appended last, in Map order, so a
 *   structurally damaged document still renders everything it contains rather
 *   than silently dropping nodes off the canvas.
 */
/**
 * Reduce a selection to its "roots": ids whose ancestors are not also selected.
 *
 * Any operation that propagates down the tree — delete (cascades to descendants)
 * or move (a parent's offset composes into its children) — must act ONLY on these,
 * or a node whose parent is also selected gets the operation applied twice.
 *
 * This lives here, shared, because duplicating it is exactly how the double-move
 * bug was introduced: `deleteSelectedNodes` had the filter and `MoveTool` did not.
 */
export function selectionRoots(doc: ReadonlyDocument, ids: string[]): string[] {
    const selected = new Set(ids);

    const hasSelectedAncestor = (id: string): boolean => {
        const seen = new Set<string>([id]);
        let cursor = doc.nodes.get(id)?.parent ?? null;
        while (cursor != null && !seen.has(cursor)) {
            if (selected.has(cursor)) return true;
            seen.add(cursor);
            cursor = doc.nodes.get(cursor)?.parent ?? null;
        }
        return false;
    };

    return ids.filter(id => doc.nodes.has(id) && !hasSelectedAncestor(id));
}

export function traverseSceneGraph(doc: ReadonlyDocument): ReadonlyNode[] {
    const ordered: ReadonlyNode[] = [];
    const visited = new Set<string>();

    const walk = (id: string): void => {
        if (visited.has(id)) return;
        const node = doc.nodes.get(id);
        if (!node) return;
        visited.add(id);
        ordered.push(node);
        for (const childId of node.children) walk(childId);
    };

    for (const rootId of doc.rootNodeUuids) walk(rootId);

    // Orphans: present in `nodes` but unreachable from any root.
    doc.nodes.forEach((node, id) => {
        if (!visited.has(id)) {
            visited.add(id);
            ordered.push(node);
        }
    });

    return ordered;
}
