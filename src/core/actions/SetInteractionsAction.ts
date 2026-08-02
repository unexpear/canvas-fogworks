/**
 * @module SetInteractionsAction
 * @description Sets a node's prototype INTERACTIONS (Milestone 7, schema 35).
 *
 * A whole-array replace, like `UpdateNodePathAction`: a node's interactions are edited as a list
 * (add one, drop one, retarget one), and a partial merge of two lists has no meaning. An empty
 * list is stored ABSENT rather than `[]`, so a node that had its last interaction removed compares
 * equal to one that never had any — the same rule the variant selection and slot maps follow.
 *
 * Validation is the shared `interactionsError`, the rule the loader runs, so this cannot author a
 * document a reload would refuse.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Interaction, interactionsError } from "../document/Prototype";
import { MutationResult, ActionPayload } from "./types";

export class SetInteractionsAction extends Action {
    private nodeId: string;
    private interactions: Interaction[];

    constructor(document: ReadonlyDocument, nodeId: string, interactions: Interaction[]) {
        super(document);
        this.nodeId = nodeId;
        this.interactions = interactions;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        return interactionsError(this.interactions) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid interactions for node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, {
                kind: "patch",
                interactions: this.interactions.length > 0 ? this.interactions : undefined
            } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetInteractionsAction", payload: { nodeId: this.nodeId, interactions: this.interactions }, timestamp: Date.now() };
    }
}
