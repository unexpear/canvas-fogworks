/**
 * @module applyMutations
 * @description Single source of truth for turning a MutationResult's property
 * deltas into concrete changes on a ProjectDocument. Shared by ActionDispatcher
 * (applies to the live document) and TransactionAction (applies to a working
 * copy so later component actions observe earlier ones).
 */

import { ProjectDocument } from "../document/Document";
import { Node } from "../document/Node";

export function applyMutationsToDocument(
    doc: ProjectDocument,
    propertyDeltas: Map<string, Record<string, any>>
): void {
    propertyDeltas.forEach((deltas, nodeId) => {
        if (deltas.__addNode) {
            const node = deltas.__addNode as Node;
            doc.nodes.set(nodeId, node);
            // Maintain tree linkage: a node with a parent joins that parent's
            // children; only true roots go into rootNodeUuids.
            const parent = node.parent ? doc.nodes.get(node.parent) : null;
            if (parent) {
                if (!parent.children.includes(nodeId)) parent.children.push(nodeId);
            } else {
                // No parent, or a parent that does not resolve: land it at the root
                // rather than leaving it unreachable from any root (which would fail
                // integrity validation on the next save/load round-trip).
                node.parent = null;
                if (!doc.rootNodeUuids.includes(nodeId)) doc.rootNodeUuids.push(nodeId);
            }
            return;
        }

        if (deltas.__deleteNode) {
            const node = doc.nodes.get(nodeId);
            if (node && node.parent) {
                const parent = doc.nodes.get(node.parent);
                if (parent) {
                    parent.children = parent.children.filter(id => id !== nodeId);
                }
            }
            doc.nodes.delete(nodeId);
            doc.rootNodeUuids = doc.rootNodeUuids.filter(id => id !== nodeId);
            return;
        }

        const node = doc.nodes.get(nodeId);
        if (!node) return;

        // NOTE: __reparent is structural but NOT terminal — it falls through to the
        // property assignments below, so "reparent and move" in one delta lands both.
        if (deltas.__reparent) {
            const { parent: newParentId, index } = deltas.__reparent as {
                parent: string | null;
                index?: number;
            };

            // Resolve the destination FIRST. If it cannot be resolved, leave the
            // node exactly where it is — detaching without re-attaching would
            // produce a node that is in `nodes` but in no parent and no root.
            const newParent = newParentId != null ? doc.nodes.get(newParentId) : null;
            if (newParentId != null && !newParent) return;

            // Detach from the current location.
            if (node.parent) {
                const oldParent = doc.nodes.get(node.parent);
                if (oldParent) {
                    oldParent.children = oldParent.children.filter(id => id !== nodeId);
                }
            } else {
                doc.rootNodeUuids = doc.rootNodeUuids.filter(id => id !== nodeId);
            }

            // Detach from the DESTINATION too. The node may already be listed there
            // (e.g. a transaction whose __addNode baked the child into the new
            // parent's `children`); re-inserting without this duplicates the entry
            // and produces a document that fails integrity validation on reload.
            if (newParent) {
                newParent.children = newParent.children.filter(id => id !== nodeId);
            } else {
                doc.rootNodeUuids = doc.rootNodeUuids.filter(id => id !== nodeId);
            }

            // Attach at the requested position (append when unspecified).
            if (newParent) {
                const at = typeof index === "number"
                    ? Math.max(0, Math.min(index, newParent.children.length))
                    : newParent.children.length;
                newParent.children.splice(at, 0, nodeId);
                node.parent = newParentId;
            } else {
                const at = typeof index === "number"
                    ? Math.max(0, Math.min(index, doc.rootNodeUuids.length))
                    : doc.rootNodeUuids.length;
                doc.rootNodeUuids.splice(at, 0, nodeId);
                node.parent = null;
            }
        }

        if (deltas.geometry) Object.assign(node.geometry, deltas.geometry);
        if (deltas.style) Object.assign(node.style, deltas.style);
        if (deltas.layout) Object.assign(node.layout, deltas.layout);
        if (deltas.text !== undefined) node.text = deltas.text;
        if (deltas.src !== undefined) node.src = deltas.src;
        if (deltas.name !== undefined) node.name = deltas.name;
    });
}
