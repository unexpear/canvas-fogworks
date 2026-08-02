/**
 * @module layerDrop
 * @description Resolves a layer-panel drag into a reparent — the arithmetic, without the DOM.
 *
 * Dropping a row somewhere is three questions at once: which parent does it join, at which
 * index, and is the move legal at all. The index is the part that is quietly wrong in most
 * hand-rolled implementations: `applyMutations` DETACHES the node before inserting it, so an
 * index measured against the list as it looks now is off by one whenever the node is moving
 * DOWN within the list it already belongs to. That is a pure calculation, so it lives here with
 * tests rather than inside a drag handler where it can only be checked by dragging.
 *
 * The legality checks it makes are the ones a drop should REFUSE rather than let the action
 * reject: a no-op move, and dropping a node inside itself. `ReparentNodeAction` independently
 * refuses cycles — this is not a substitute for that, it is what stops the panel from offering
 * a drop it knows will fail.
 */

import { ReadonlyDocument } from "../core/document/Document";

/** Where the pointer released relative to the target row. */
export type DropPosition = "before" | "after" | "inside";

export interface LayerDrop {
    /** The new parent, or null for the document root. */
    parent: string | null;
    /** Insertion index among the new siblings, measured AFTER the node is detached. */
    index: number;
}

/** Siblings of `id`'s parent — the list an index refers to. */
function siblingsOf(doc: ReadonlyDocument, parent: string | null): readonly string[] {
    return parent === null ? doc.rootNodeUuids : (doc.nodes.get(parent)?.children ?? []);
}

/** True when `candidate` is `nodeId` or lives under it — the move that would build a cycle. */
function isSelfOrDescendant(doc: ReadonlyDocument, nodeId: string, candidate: string): boolean {
    let cur: string | null | undefined = candidate;
    const seen = new Set<string>();
    while (cur != null && !seen.has(cur)) {
        if (cur === nodeId) return true;
        seen.add(cur);
        cur = doc.nodes.get(cur)?.parent ?? null;
    }
    return false;
}

/**
 * The reparent a drop means, or null when it should be refused.
 *
 * @param dragged the row being dragged
 * @param target  the row it was dropped on
 * @param position where within that row — its top edge, its bottom edge, or its middle
 */
export function resolveLayerDrop(
    doc: ReadonlyDocument,
    dragged: string,
    target: string,
    position: DropPosition
): LayerDrop | null {
    const node = doc.nodes.get(dragged);
    const targetNode = doc.nodes.get(target);
    if (!node || !targetNode) return null;
    // Into itself or its own subtree: a cycle. Refused here so the panel never shows a drop
    // indicator for it, and refused again by the action, which is the real guarantee.
    if (isSelfOrDescendant(doc, dragged, target)) return null;

    let parent: string | null;
    let index: number;

    if (position === "inside") {
        // An INSTANCE draws its master's subtree and has no stored children, so a node dropped
        // into one would vanish from the picture entirely. Refuse rather than swallow it.
        if (targetNode.type === "core.instance") return null;
        parent = target;
        index = targetNode.children.length;      // append
    } else {
        parent = targetNode.parent ?? null;
        const siblings = siblingsOf(doc, parent);
        const at = siblings.indexOf(target);
        if (at < 0) return null;                 // a damaged tree — refuse rather than guess
        index = position === "after" ? at + 1 : at;
    }

    const currentParent = node.parent ?? null;
    if (currentParent === parent) {
        const from = siblingsOf(doc, parent).indexOf(dragged);
        // The node is removed BEFORE being reinserted, so every position after it shifts down
        // by one. Without this, dragging a row downwards lands it one place short.
        if (from >= 0 && from < index) index -= 1;
        if (from === index) return null;         // a no-op: do not push an undo step for nothing
    }

    return { parent, index };
}
