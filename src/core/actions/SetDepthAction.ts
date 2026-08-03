/**
 * @module SetDepthAction
 * @description Sets how far BACK a node sits (schema 40) — the only write path to `depth`.
 *
 * A one-field action for the same reason `SetBooleanOpAction` is: depth is meant to stay a
 * decision. Nudging a layer backwards is one undoable edit that re-sorts the drawing, re-parallaxes
 * it and re-writes its z, with the shape itself untouched.
 *
 * Validation is the shared `depthError`, the rule the loader runs, so this cannot author a depth a
 * reload would refuse. A depth of exactly 0 REMOVES the field rather than storing it, so a node
 * pushed back and then returned to the page serialises like one that was never layered.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { depthError } from "../document/Depth";
import { MutationResult, ActionPayload } from "./types";

export class SetDepthAction extends Action {
    private nodeId: string;
    private depth: number;

    constructor(document: ReadonlyDocument, nodeId: string, depth: number) {
        super(document);
        this.nodeId = nodeId;
        this.depth = depth;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        return depthError(this.depth) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error(`Validation failed: invalid depth for node "${this.nodeId}".`);
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", depth: this.depth === 0 ? undefined : this.depth } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetDepthAction", payload: { nodeId: this.nodeId, depth: this.depth }, timestamp: Date.now() };
    }
}
