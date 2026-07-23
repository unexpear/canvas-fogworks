/**
 * @module ResizeNodeAction
 * @description Changes a node's dimensions.
 */

import { Action } from "./Action";
import { ProjectDocument } from "../document/Document";
import { MutationResult, ActionPayload } from "./types";

export class ResizeNodeAction extends Action {
    private nodeId: string;
    private newWidth: number;
    private newHeight: number;

    constructor(document: ProjectDocument, nodeId: string, newWidth: number, newHeight: number) {
        super(document);
        this.nodeId = nodeId;
        this.newWidth = newWidth;
        this.newHeight = newHeight;
    }

    public validate(): boolean {
        return this.document.nodes.has(this.nodeId) &&
            Number.isFinite(this.newWidth) && Number.isFinite(this.newHeight) &&
            this.newWidth > 0 && this.newHeight > 0;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: Node "${this.nodeId}" not found.`);
        }

        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { geometry: { width: this.newWidth, height: this.newHeight } }]]),
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
