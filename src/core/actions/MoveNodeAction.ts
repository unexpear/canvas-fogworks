/**
 * @module MoveNodeAction
 * @description Moves a node's position within the document.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { MutationResult, ActionPayload } from "./types";

export class MoveNodeAction extends Action {
    private nodeId: string;
    private newX: number;
    private newY: number;

    constructor(document: ReadonlyDocument, nodeId: string, newX: number, newY: number) {
        super(document);
        this.nodeId = nodeId;
        this.newX = newX;
        this.newY = newY;
    }

    public validate(): boolean {
        return this.document.nodes.has(this.nodeId) &&
            Number.isFinite(this.newX) && Number.isFinite(this.newY);
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: Node "${this.nodeId}" not found.`);
        }

        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", geometry: { x: this.newX, y: this.newY } } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "MoveNodeAction",
            payload: { nodeId: this.nodeId, newX: this.newX, newY: this.newY },
            timestamp: Date.now()
        };
    }

    public getNodeId(): string { return this.nodeId; }
    public getNewX(): number { return this.newX; }
    public getNewY(): number { return this.newY; }
}
