/**
 * @module Action
 * @description Defines the contract for all document mutations. Actions must be atomic and reversible.
 * Actions are declarative: they calculate what should change but do not mutate the document directly.
 * The Dispatcher applies mutations after execution.
 */

import { ProjectDocument } from "../document/Document";
import { MutationResult, ActionPayload } from "./types";

/** Base class for all executable mutations. */
export abstract class Action {
    protected document: ProjectDocument;

    constructor(document: ProjectDocument) {
        this.document = document;
    }

    /**
     * Retarget this action at a different document. Used by TransactionAction to
     * run component actions against a working copy so each observes the effects
     * of the ones before it (e.g. create-a-node-then-move-it in one transaction).
     */
    public rebind(document: ProjectDocument): void {
        this.document = document;
    }

    /**
     * Calculates the mutations that should be applied to the document.
     * Does NOT mutate the document directly.
     * @returns A MutationResult describing what should change.
     */
    public abstract execute(): MutationResult;

    /**
     * Validates whether this action can be executed against the current document state.
     * @returns true if the action is valid, false otherwise.
     */
    public abstract validate(): boolean;

    /**
     * Serializes the action's parameters for history tracking.
     * @returns The serializable payload for the Revision stack.
     */
    public abstract serialize(): ActionPayload;
}
