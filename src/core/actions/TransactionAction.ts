/**
 * @module TransactionAction
 * @description Groups multiple actions into a single atomic unit: all succeed or
 * all fail, and they compose — each component action runs against a working copy
 * that already reflects the ones before it, so a transaction can create a node
 * and then move/style it in the same atomic step.
 */

import { Action } from "./Action";
import { ProjectDocument, ReadonlyDocument } from "../document/Document";
import { Node } from "../document/Node";
import { MutationResult, ActionPayload, NodeDelta } from "./types";
import { applyMutationsToDocument } from "./applyMutations";

/** Deep, independent copy of a document for in-transaction simulation. */
function cloneWorkingDocument(doc: ReadonlyDocument): ProjectDocument {
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

type PatchDelta = Extract<NodeDelta, { kind: "patch" }>;

/** Merge two patches for the same node; the later one wins field by field. */
function mergePatch(target: PatchDelta, source: PatchDelta): PatchDelta {
    return {
        kind: "patch",
        reparent: source.reparent ?? target.reparent,
        geometry: (source.geometry || target.geometry)
            ? { ...target.geometry, ...source.geometry } : undefined,
        transform: (source.transform || target.transform)
            ? { ...target.transform, ...source.transform } : undefined,
        style: (source.style || target.style)
            ? { ...target.style, ...source.style } : undefined,
        layout: (source.layout || target.layout)
            ? { ...target.layout, ...source.layout } : undefined,
        text: source.text ?? target.text,
        src: source.src ?? target.src,
        name: source.name ?? target.name
    };
}

export class TransactionAction extends Action {
    private componentActions: Array<Action>;
    private transactionName: string;

    constructor(document: ReadonlyDocument, transactionName: string, actions: Array<Action>) {
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
        const propertyEdits = new Map<string, PatchDelta>();

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

            for (const [nodeId, delta] of result.propertyDeltas) {
                if (delta.kind === "add") {
                    addedIds.add(nodeId);
                    everAdded.add(nodeId);
                    deletedIds.delete(nodeId);
                } else if (delta.kind === "delete") {
                    deletedIds.add(nodeId);
                    addedIds.delete(nodeId);
                    propertyEdits.delete(nodeId);
                } else {
                    const prev = propertyEdits.get(nodeId) ?? { kind: "patch" as const };
                    propertyEdits.set(nodeId, mergePatch(prev, delta));
                }
            }

            applyMutationsToDocument(working, result.propertyDeltas);
        }

        // Collapse the simulated result into one net delta per node.
        const finalDeltas = new Map<string, NodeDelta>();

        // Nodes created (and not later deleted) in this transaction: emit a
        // single __addNode carrying their final simulated state, so any edits
        // applied afterward are already baked in.
        for (const id of addedIds) {
            const node = working.nodes.get(id);
            if (node) finalDeltas.set(id, { kind: "add", node });
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
            finalDeltas.set(id, { kind: "delete" });
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
