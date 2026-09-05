/**
 * @module SetAnimationControllerAction
 * @description Undoable, whole-value edits of a node's animation controller.
 */
import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { AnimationController, animationControllerError } from "../document/AnimationController";
import { ActionPayload, MutationResult } from "./types";
export class SetAnimationControllerAction extends Action {
    constructor(document: ReadonlyDocument, private nodeId: string, private animation: AnimationController | undefined) { super(document); }
    validate(): boolean { return this.document.nodes.has(this.nodeId) && animationControllerError(this.animation) === null; }
    execute(): MutationResult {
        if (!this.validate()) throw new Error("Invalid animation controller");
        const animation = this.animation ? JSON.parse(JSON.stringify(this.animation)) as AnimationController : null;
        return { success: true, updatedNodeIds: new Set([this.nodeId]), propertyDeltas: new Map([[this.nodeId, { kind: "patch", animation }]]) };
    }
    serialize(): ActionPayload {
        return { actionId: "SetAnimationControllerAction", payload: { nodeId: this.nodeId, animation: this.animation }, timestamp: Date.now() };
    }
}
