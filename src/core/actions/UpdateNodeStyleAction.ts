/**
 * @module UpdateNodeStyleAction
 * @description Updates a node's style through the dispatcher.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { MutationResult, ActionPayload } from "./types";

export interface StyleUpdate {
    fill?: string;
    opacity?: number;
    stroke?: string;
    radius?: number;
    fontSize?: number;
}

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
        const s = this.newStyle;
        // Presence-based, not value-based — see UpdateNodeGeometryAction.validate().
        if ("opacity" in s && (!Number.isFinite(s.opacity) || (s.opacity as number) < 0 || (s.opacity as number) > 1)) return false;
        if ("radius" in s && (!Number.isFinite(s.radius) || (s.radius as number) < 0)) return false;
        if ("fontSize" in s && (!Number.isFinite(s.fontSize) || (s.fontSize as number) <= 0)) return false;
        if ("fill" in s && typeof s.fill !== "string") return false;
        if ("stroke" in s && typeof s.stroke !== "string") return false;
        return true;
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
