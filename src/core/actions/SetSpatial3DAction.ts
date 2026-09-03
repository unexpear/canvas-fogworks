/**
 * @module SetSpatial3DAction
 * @description The undoable write path for a node's typed 3D authoring components (schemas 74-75).
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Spatial3D, spatial3DError } from "../document/Spatial3D";
import { ActionPayload, MutationResult } from "./types";

export class SetSpatial3DAction extends Action {
    constructor(document: ReadonlyDocument, private nodeId: string, private spatial3d: Spatial3D | undefined) {
        super(document);
    }

    public validate(): boolean {
        return this.document.nodes.has(this.nodeId) && spatial3DError(this.spatial3d) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error(`Validation failed: invalid spatial3d for node "${this.nodeId}".`);
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", spatial3d: this.spatial3d ?? null }]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetSpatial3DAction", payload: { nodeId: this.nodeId, spatial3d: this.spatial3d }, timestamp: Date.now() };
    }
}
