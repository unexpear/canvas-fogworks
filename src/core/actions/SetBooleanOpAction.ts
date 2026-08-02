/**
 * @module SetBooleanOpAction
 * @description Changes which operation a `core.boolean` node applies to its children (schema 33).
 *
 * The reason this is a one-field action rather than part of the create: the whole point of a live
 * boolean is that the operation stays editable. Selecting the node and switching union → subtract
 * is a single undoable edit that re-derives the shape, with the operands untouched.
 *
 * Validation is the shared `booleanOpError`, the same rule the loader runs, so this cannot author
 * a document a reload would refuse.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { BooleanOp, booleanOpError } from "../document/Node";
import { MutationResult, ActionPayload } from "./types";

export class SetBooleanOpAction extends Action {
    private nodeId: string;
    private op: BooleanOp;

    constructor(document: ReadonlyDocument, nodeId: string, op: BooleanOp) {
        super(document);
        this.nodeId = nodeId;
        this.op = op;
    }

    public validate(): boolean {
        const node = this.document.nodes.get(this.nodeId);
        if (!node) return false;
        return booleanOpError(node.type, this.op) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid boolean operation for node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", booleanOp: this.op } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetBooleanOpAction", payload: { nodeId: this.nodeId, op: this.op }, timestamp: Date.now() };
    }
}
