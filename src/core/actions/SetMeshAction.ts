/**
 * @module SetMeshAction
 * @description Sets (or clears) a node's deformation GRID — the only write path to `mesh`.
 *
 * Validation is the shared `meshError`, the rule the loader runs, so this cannot author a mesh a
 * reload would refuse — including the one that matters most, that the point count matches the grid.
 * Every lookup in `warpPoint` indexes by row and column, and a short array would read `undefined`
 * as a coordinate.
 *
 * `undefined` CLEARS the field and makes the node rigid again, so a shape that was warped and then
 * un-warped serialises exactly like one that never was.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Mesh, meshError } from "../document/Mesh";
import { MutationResult, ActionPayload } from "./types";

export class SetMeshAction extends Action {
    private nodeId: string;
    private mesh: Mesh | undefined;

    constructor(document: ReadonlyDocument, nodeId: string, mesh: Mesh | undefined) {
        super(document);
        this.nodeId = nodeId;
        this.mesh = mesh;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        return meshError(this.mesh) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error(`Validation failed: invalid mesh for node "${this.nodeId}".`);
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", mesh: this.mesh } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetMeshAction", payload: { nodeId: this.nodeId, mesh: this.mesh }, timestamp: Date.now() };
    }
}
