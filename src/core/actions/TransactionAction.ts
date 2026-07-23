/**
 * @module TransactionAction
 * @description Groups multiple actions into a single atomic unit: all succeed or
 * all fail, and they compose — each component action runs against a working copy
 * that already reflects the ones before it, so a transaction can create a node
 * and then move/style it in the same atomic step.
 */

import { Action } from "./Action";
import { ProjectDocument } from "../document/Document";
import { Node } from "../document/Node";
import { MutationResult, ActionPayload } from "./types";
import { applyMutationsToDocument } from "./applyMutations";

/** Deep, independent copy of a document for in-transaction simulation. */
function cloneWorkingDocument(doc: ProjectDocument): ProjectDocument {
    return {
        version: doc.version,
        metadata: JSON.parse(JSON.stringify(doc.metadata)),
        nodes: new Map(
            Array.from(doc.nodes.entries()).map(([k, v]) => [k, JSON.parse(JSON.stringify(v)) as Node])
        ),
        rootNodeUuids: [...doc.rootNodeUuids],
        variables: JSON.parse(JSON.stringify(doc.variables))
    };
}

/** Merge property deltas (geometry/style/layout/…) for the same pre-existing node. */
function mergePropertyDeltas(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (typeof value === "object" && value !== null && !Array.isArray(value) &&
            typeof result[key] === "object" && result[key] !== null && !Array.isArray(result[key])) {
            result[key] = mergePropertyDeltas(result[key], value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

export class TransactionAction extends Action {
    private componentActions: Array<Action>;
    private transactionName: string;

    constructor(document: ProjectDocument, transactionName: string, actions: Array<Action>) {
        super(document);
        this.transactionName = transactionName;
        this.componentActions = actions;
    }

    /**
     * A transaction is valid if it has at least one component action. Per-action
     * validity depends on intermediate state and is enforced during execute()
     * (which the dispatcher runs inside a try/catch), so we don't pre-validate
     * against the original document — that would wrongly reject create-then-edit.
     */
    public validate(): boolean {
        return this.componentActions.length > 0;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Transaction "${this.transactionName}" has no actions.`);
        }

        // Simulate on a throwaway copy so each action observes prior effects and
        // the real document is never touched if any step fails.
        const working = cloneWorkingDocument(this.document);

        const addedIds = new Set<string>();
        const deletedIds = new Set<string>();
        // Nodes created at ANY point in this transaction. `addedIds` is the live
        // set (the delete branch removes from it), so it cannot answer "did this
        // node exist before the transaction?" — and without that, a node added
        // then deleted emitted a __deleteNode for a node the real document never
        // had. This set makes the documented net-no-op skip actually fire.
        const everAdded = new Set<string>();
        const propertyEdits = new Map<string, Record<string, any>>();

        for (const action of this.componentActions) {
            action.rebind(working);
            if (!action.validate()) {
                throw new Error(
                    `Transaction "${this.transactionName}" failed validation at step: ${action.constructor.name}`
                );
            }
            const result = action.execute();
            if (!result.success) {
                throw new Error(
                    `Transaction "${this.transactionName}" failed at step: ${action.constructor.name}`
                );
            }

            for (const [nodeId, deltas] of result.propertyDeltas) {
                if (deltas.__addNode) {
                    addedIds.add(nodeId);
                    everAdded.add(nodeId);
                    deletedIds.delete(nodeId);
                } else if (deltas.__deleteNode) {
                    deletedIds.add(nodeId);
                    addedIds.delete(nodeId);
                    propertyEdits.delete(nodeId);
                } else {
                    const prev = propertyEdits.get(nodeId) ?? {};
                    propertyEdits.set(nodeId, mergePropertyDeltas(prev, deltas));
                }
            }

            applyMutationsToDocument(working, result.propertyDeltas);
        }

        // Collapse the simulated result into one net delta per node.
        const finalDeltas = new Map<string, Record<string, any>>();

        // Nodes created (and not later deleted) in this transaction: emit a
        // single __addNode carrying their final simulated state, so any edits
        // applied afterward are already baked in.
        for (const id of addedIds) {
            const node = working.nodes.get(id);
            if (node) finalDeltas.set(id, { __addNode: node });
        }
        // Pre-existing nodes that were only edited.
        for (const [id, deltas] of propertyEdits) {
            if (addedIds.has(id) || deletedIds.has(id)) continue;
            finalDeltas.set(id, deltas);
        }
        // Pre-existing nodes that were deleted (a node added then deleted in the
        // same transaction is a net no-op and is skipped).
        for (const id of deletedIds) {
            if (everAdded.has(id)) continue; // created and destroyed within the transaction
            finalDeltas.set(id, { __deleteNode: true });
        }

        return {
            updatedNodeIds: new Set(finalDeltas.keys()),
            propertyDeltas: finalDeltas,
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "TransactionAction",
            payload: {
                name: this.transactionName,
                actions: this.componentActions.map(action => action.serialize())
            },
            timestamp: Date.now()
        };
    }

    public getActions(): Array<Action> {
        return [...this.componentActions];
    }

    public getTransactionName(): string {
        return this.transactionName;
    }
}
