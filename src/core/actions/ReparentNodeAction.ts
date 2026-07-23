/**
 * @module ReparentNodeAction
 * @description Moves a node to a new parent (or to the document root),
 * optionally at a specific index among its new siblings.
 *
 * This is the authoring path for the scene graph: without it the tree can only
 * ever be one level deep, because AddNodeAction alone cannot restructure it.
 */

import { Action } from "./Action";
import { ProjectDocument } from "../document/Document";
import { MutationResult, ActionPayload } from "./types";

export class ReparentNodeAction extends Action {
    private nodeId: string;
    private newParentId: string | null;
    private index: number | undefined;

    /**
     * @param newParentId The new parent's id, or null to move the node to the root.
     * @param index Insertion position among the new siblings (appended if omitted).
     */
    constructor(
        document: ProjectDocument,
        nodeId: string,
        newParentId: string | null,
        index?: number
    ) {
        super(document);
        this.nodeId = nodeId;
        this.newParentId = newParentId;
        this.index = index;
    }

    /** True when `candidateId` is the node itself or lives beneath it. */
    private isSelfOrDescendant(candidateId: string): boolean {
        if (candidateId === this.nodeId) return true;
        // Walk up from the candidate; if we reach the node, the candidate is
        // inside the subtree we are trying to move (which would create a cycle).
        const seen = new Set<string>();
        let cursor: string | null | undefined = candidateId;
        while (cursor && !seen.has(cursor)) {
            seen.add(cursor);
            const parent: string | null | undefined = this.document.nodes.get(cursor)?.parent;
            if (parent === this.nodeId) return true;
            cursor = parent ?? null;
        }
        return false;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;

        if (this.newParentId !== null) {
            if (!this.document.nodes.has(this.newParentId)) return false;
            // Reject self-parenting and any move that would create a cycle.
            if (this.isSelfOrDescendant(this.newParentId)) return false;
        }

        if (this.index !== undefined) {
            if (!Number.isInteger(this.index) || this.index < 0) return false;
        }
        return true;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(
                `Validation failed: cannot reparent "${this.nodeId}" to "${this.newParentId}".`
            );
        }

        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[
                this.nodeId,
                { kind: "patch", reparent: { parent: this.newParentId, index: this.index } } as const
            ]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "ReparentNodeAction",
            payload: { nodeId: this.nodeId, newParentId: this.newParentId, index: this.index },
            timestamp: Date.now()
        };
    }
}
