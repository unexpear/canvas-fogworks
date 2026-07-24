/**
 * @module DeleteNodeAction
 * @description Removes a node and its descendants from the document.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { MutationResult, ActionPayload, NodeDelta } from "./types";

export class DeleteNodeAction extends Action {
    private nodeId: string;
    private deletedNodeIds: string[] = [];

    constructor(document: ReadonlyDocument, nodeId: string) {
        super(document);
        this.nodeId = nodeId;
    }

    public validate(): boolean {
        return this.document.nodes.has(this.nodeId);
    }

    private collectDescendants(nodeId: string, visited: Set<string> = new Set()): string[] {
        if (visited.has(nodeId)) return [];
        visited.add(nodeId);
        const ids: string[] = [];
        const node = this.document.nodes.get(nodeId);
        if (!node) return ids;
        for (const childId of node.children) {
            // Guard on `visited` before pushing so a node reachable by more than
            // one path (a DAG diamond) is emitted at most once.
            if (this.document.nodes.has(childId) && !visited.has(childId)) {
                ids.push(childId);
                ids.push(...this.collectDescendants(childId, visited));
            }
        }
        return ids;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: Node "${this.nodeId}" not found.`);
        }

        this.deletedNodeIds = [this.nodeId, ...this.collectDescendants(this.nodeId)];

        const deltas = new Map<string, NodeDelta>();
        for (const id of this.deletedNodeIds) {
            deltas.set(id, { kind: "delete" });
        }

        // Under auto-layout, removing a direct child reflows its container's
        // surviving children, so the container must be dirtied even though its own
        // stored data is unchanged. Only the deleted ROOT's parent can be a surviving
        // container — every descendant's parent is deleted alongside it.
        const parentOfRoot = this.document.nodes.get(this.nodeId)?.parent ?? null;
        const updatedNodeIds = new Set(this.deletedNodeIds);
        if (parentOfRoot) updatedNodeIds.add(parentOfRoot);

        return {
            updatedNodeIds,
            propertyDeltas: deltas,
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "DeleteNodeAction",
            payload: { nodeId: this.nodeId },
            timestamp: Date.now()
        };
    }

    public getDeletedNodeIds(): string[] {
        return [...this.deletedNodeIds];
    }
}
