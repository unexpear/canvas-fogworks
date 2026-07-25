/**
 * @module ResizeNodeAction
 * @description Changes a node's dimensions.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { dimensionError } from "../document/Node";
import { MutationResult, ActionPayload } from "./types";

export class ResizeNodeAction extends Action {
    private nodeId: string;
    private newWidth: number;
    private newHeight: number;

    constructor(document: ReadonlyDocument, nodeId: string, newWidth: number, newHeight: number) {
        super(document);
        this.nodeId = nodeId;
        this.newWidth = newWidth;
        this.newHeight = newHeight;
    }

    public validate(): boolean {
        const node = this.document.nodes.get(this.nodeId);
        if (!node) return false;
        // Shared, per-type dimension rule (a line may collapse one axis).
        return dimensionError(node.type, this.newWidth, this.newHeight) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: Node "${this.nodeId}" not found.`);
        }

        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", geometry: { width: this.newWidth, height: this.newHeight } } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "ResizeNodeAction",
            payload: { nodeId: this.nodeId, newWidth: this.newWidth, newHeight: this.newHeight },
            timestamp: Date.now()
        };
    }
}
