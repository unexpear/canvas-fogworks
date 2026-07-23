/**
 * @module UpdateNodeGeometryAction
 * @description Updates a node's geometry through the dispatcher.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { MutationResult, ActionPayload } from "./types";

export interface GeometryUpdate {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
}

export class UpdateNodeGeometryAction extends Action {
    private nodeId: string;
    private newGeometry: GeometryUpdate;

    constructor(document: ReadonlyDocument, nodeId: string, geometry: GeometryUpdate) {
        super(document);
        this.nodeId = nodeId;
        this.newGeometry = geometry;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        const g = this.newGeometry;
        // Presence-based, NOT value-based: `{ width: undefined }` is a present key,
        // and Object.assign would copy it into the node regardless of its value —
        // producing an undefined dimension that makes the node vanish and the saved
        // file unloadable. A key that is present must always be validated.
        if ("x" in g && !Number.isFinite(g.x)) return false;
        if ("y" in g && !Number.isFinite(g.y)) return false;
        if ("width" in g && (!Number.isFinite(g.width) || (g.width as number) <= 0)) return false;
        if ("height" in g && (!Number.isFinite(g.height) || (g.height as number) <= 0)) return false;
        return true;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid geometry for node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", geometry: this.newGeometry } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "UpdateNodeGeometryAction",
            payload: { nodeId: this.nodeId, geometry: this.newGeometry },
            timestamp: Date.now()
        };
    }
}
