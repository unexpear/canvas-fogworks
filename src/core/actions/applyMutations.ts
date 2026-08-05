/**
 * @module applyMutations
 * @description Single source of truth for turning a MutationResult's node deltas
 * into concrete changes on a ProjectDocument. Shared by ActionDispatcher (applies
 * to the live document) and TransactionAction (applies to a working copy so later
 * component actions observe earlier ones).
 *
 * This is the ONLY function in the codebase that mutates a live document.
 */

import { ProjectDocument } from "../document/Document";
import { Node } from "../document/Node";
import { NodeDelta } from "./types";

/** Detach a node from wherever it currently sits (its parent, or the root list). */
function detach(doc: ProjectDocument, node: Node, nodeId: string): void {
    if (node.parent) {
        const oldParent = doc.nodes.get(node.parent);
        if (oldParent) {
            oldParent.children = oldParent.children.filter(id => id !== nodeId);
        }
    } else {
        doc.rootNodeUuids = doc.rootNodeUuids.filter(id => id !== nodeId);
    }
}

/** Insert into a sibling list at a clamped `index`, or APPEND when none is given — the
 *  same clamping a `patch` reparent uses, so the two placement paths behave identically. */
function insertAt(list: string[], nodeId: string, index?: number): void {
    if (typeof index !== "number") {
        list.push(nodeId);
        return;
    }
    list.splice(Math.max(0, Math.min(index, list.length)), 0, nodeId);
}

export function applyMutationsToDocument(
    doc: ProjectDocument,
    propertyDeltas: Map<string, NodeDelta>
): void {
    propertyDeltas.forEach((delta, nodeId) => {
        switch (delta.kind) {
            case "add": {
                const node = delta.node;
                doc.nodes.set(nodeId, node);
                const parent = node.parent ? doc.nodes.get(node.parent) : null;
                if (parent) {
                    if (!parent.children.includes(nodeId)) insertAt(parent.children, nodeId, delta.index);
                } else {
                    // No parent, or one that does not resolve: land it at the root
                    // rather than leaving it unreachable (which would fail integrity
                    // validation on the next save/load round-trip).
                    node.parent = null;
                    if (!doc.rootNodeUuids.includes(nodeId)) insertAt(doc.rootNodeUuids, nodeId, delta.index);
                }
                return;
            }

            case "delete": {
                const node = doc.nodes.get(nodeId);
                if (node) detach(doc, node, nodeId);
                doc.nodes.delete(nodeId);
                doc.rootNodeUuids = doc.rootNodeUuids.filter(id => id !== nodeId);
                return;
            }

            case "patch": {
                const node = doc.nodes.get(nodeId);
                if (!node) return;

                if (delta.reparent) {
                    const { parent: newParentId, index } = delta.reparent;

                    // Resolve the destination FIRST. Detaching without being able to
                    // re-attach would leave the node in `nodes` but in no parent and
                    // no root.
                    const newParent = newParentId != null ? doc.nodes.get(newParentId) : null;
                    if (newParentId != null && !newParent) return;

                    detach(doc, node, nodeId);

                    // Detach from the DESTINATION too: the node may already be listed
                    // there (e.g. an `add` that baked the child into its new parent's
                    // children), and re-inserting would duplicate the entry.
                    if (newParent) {
                        newParent.children = newParent.children.filter(id => id !== nodeId);
                    } else {
                        doc.rootNodeUuids = doc.rootNodeUuids.filter(id => id !== nodeId);
                    }

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

                if (delta.geometry) Object.assign(node.geometry, delta.geometry);
                if (delta.transform) node.transform = { ...node.transform, ...delta.transform };
                if (delta.style) Object.assign(node.style, delta.style);
                // grid ⊕ container exclusivity is carried IN the delta by
                // UpdateNodeLayoutAction (it sets the other field to `undefined`), so a
                // plain field-by-field merge is correct — and a merged transaction delta
                // resolves last-wins instead of dropping both.
                if (delta.layout) Object.assign(node.layout, delta.layout);
                if (delta.overrides !== undefined) node.overrides = delta.overrides;
                // `in`, not `!== undefined`: clearing is a real edit (see the delta type).
                if ("variant" in delta) node.variant = delta.variant;
                if ("variants" in delta) node.variants = delta.variants;
                if ("slot" in delta) node.slot = delta.slot;
                if ("slotContent" in delta) node.slotContent = delta.slotContent;
                if ("states" in delta) node.states = delta.states;
                if ("hidden" in delta) node.hidden = delta.hidden;
                if ("locked" in delta) node.locked = delta.locked;
                if (delta.path !== undefined) node.path = delta.path;
                if ("booleanOp" in delta) node.booleanOp = delta.booleanOp;
                if ("interactions" in delta) node.interactions = delta.interactions;
                if ("track" in delta) node.track = delta.track;
                if ("depth" in delta) node.depth = delta.depth;
                if ("mesh" in delta) node.mesh = delta.mesh;
                if (delta.text !== undefined) node.text = delta.text;
                if (delta.src !== undefined) node.src = delta.src;
                if (delta.name !== undefined) node.name = delta.name;
                // NULL means REMOVE, which is why this cannot use the same `!== undefined` shape as
                // its neighbours: "the whole image" is a real state and has to be reachable from a
                // node that currently names a region.
                if (delta.sourceRect !== undefined) {
                    if (delta.sourceRect === null) delete node.sourceRect;
                    else node.sourceRect = delta.sourceRect;
                }
                if (delta.pixelated !== undefined) node.pixelated = delta.pixelated;
                return;
            }

            case "lighting": {
                doc.lights = delta.lights;
                doc.ambient = delta.ambient;
                return;
            }
            case "timeline": {
                doc.timeline = delta.timeline;
                return;
            }
            case "activeState": {
                // Document-level state (M7): which named state everything resolves against.
                doc.activeState = delta.activeState;
                return;
            }

            case "variables": {
                // Document-level state (schema 19): whole-store + theme replace. The key
                // (DOCUMENT_DELTA_KEY) is ignored — the KIND carries the meaning.
                doc.variables = delta.variables;
                doc.activeTheme = delta.activeTheme;
                return;
            }

            default: {
                // Exhaustiveness: adding a NodeDelta variant without handling it here
                // is now a compile error.
                const never: never = delta;
                throw new Error(`Unhandled node delta: ${JSON.stringify(never)}`);
            }
        }
    });
}
