/**
 * @module UpdateNodeStyleAction
 * @description Updates a node's style through the dispatcher.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Style, styleError } from "../document/Node";
import { MutationResult, ActionPayload } from "./types";

/** A partial style patch — every `Style` field is patchable (shared shape, one drift-free source). */
export type StyleUpdate = Partial<Style>;

export class UpdateNodeStyleAction extends Action {
    private nodeId: string;
    private newStyle: StyleUpdate;

    constructor(document: ReadonlyDocument, nodeId: string, style: StyleUpdate) {
        super(document);
        this.nodeId = nodeId;
        this.newStyle = style;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        // Shared, presence-based validator (also the load path's) — cannot drift.
        return styleError(this.newStyle) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid style for node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", style: this.newStyle } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "UpdateNodeStyleAction",
            payload: { nodeId: this.nodeId, style: this.newStyle },
            timestamp: Date.now()
        };
    }
}
