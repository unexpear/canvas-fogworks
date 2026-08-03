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
import { MutationResult, ActionPayload, NodeDelta, DOCUMENT_DELTA_KEY } from "./types";
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
        variables: JSON.parse(JSON.stringify(doc.variables)),
        activeTheme: doc.activeTheme,
        // Document-level fields a transaction does not TOUCH must still survive it. This clone
        // listed the ones that existed when it was written, so every field added since was
        // dropped by any transaction that ran — silently, because a lost field looks exactly
        // like one nobody set. That is the same hand-written-list hazard `applyMutations` and
        // `mergePatch` both had; here it cost the active state and then the whole timeline.
        activeState: doc.activeState,
        timeline: doc.timeline,
        frame: doc.frame
    };
}

type PatchDelta = Extract<NodeDelta, { kind: "patch" }>;

/**
 * Merge two patches for the same node; the later one wins field by field.
 *
 * The spread comes FIRST and is what makes this total. Listing the fields by hand — which is
 * what this did — is an allow-list, and every field added to `PatchDelta` afterwards was
 * silently dropped by any transaction that merged two patches on one node: `path`, `hidden`,
 * `locked`, `variant`, `variants`, `slot`, `slotContent`, `states`. A vertex drag (a geometry
 * action + a path action, one node, one transaction) is how that surfaced — the box moved and
 * the ink did not. A spread also preserves KEY PRESENCE, which is the `in`-read contract those
 * fields depend on: a source that carries `slot: undefined` still clears it.
 *
 * The four object-valued fields are then merged field-by-field on purpose: their actions emit
 * PARTIALs, so a whole-value last-wins would drop the earlier action's fields. `layout`'s
 * grid ⊕ container exclusivity rides along inside the patch as an explicit `undefined`, and a
 * field-by-field merge is what lets it resolve last-wins instead of dropping both.
 */
function mergePatch(target: PatchDelta, source: PatchDelta): PatchDelta {
    return {
        ...target,
        ...source,
        kind: "patch",
        geometry: (source.geometry || target.geometry)
            ? { ...target.geometry, ...source.geometry } : undefined,
        transform: (source.transform || target.transform)
            ? { ...target.transform, ...source.transform } : undefined,
        style: (source.style || target.style)
            ? { ...target.style, ...source.style } : undefined,
        layout: (source.layout || target.layout)
            ? { ...target.layout, ...source.layout } : undefined
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
        // The LAST document-level (variables/theme) delta wins. Each component action builds
        // its delta from the WORKING document at execute time, so a later "switch theme"
        // already carries an earlier "set variable" — last-wins loses nothing.
        // Document-level deltas travel under ONE key but are not one VALUE: the variable store
        // and the active state are independent, so a transaction touching both must keep both.
        // A single slot would silently drop whichever came first.
        let variablesDelta: Extract<NodeDelta, { kind: "variables" }> | null = null;
        let activeStateDelta: Extract<NodeDelta, { kind: "activeState" }> | null = null;
        let timelineDelta: Extract<NodeDelta, { kind: "timeline" }> | null = null;

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
                } else if (delta.kind === "variables") {
                    variablesDelta = delta;
                } else if (delta.kind === "activeState") {
                    activeStateDelta = delta;
                } else if (delta.kind === "timeline") {
                    timelineDelta = delta;
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
        // The net document-level state (variables / active state / the clock), if any component
        // touched it. They all travel under ONE key, so only one can occupy it, and a transaction
        // doing more than one is REFUSED rather than silently losing the others — a wrong answer
        // there would be invisible. Counted rather than compared pairwise: the pairwise test was
        // right for two claimants and would have quietly stopped covering them all the moment a
        // third arrived, which is what the timeline is.
        const documentDeltas = [variablesDelta, activeStateDelta, timelineDelta].filter(d => d !== null);
        if (documentDeltas.length > 1) return { updatedNodeIds: new Set(), propertyDeltas: new Map(), success: false };
        if (documentDeltas.length === 1) finalDeltas.set(DOCUMENT_DELTA_KEY, documentDeltas[0] as NodeDelta);

        return {
            // The document-delta sentinel is NOT a node id — leaking it would seed the
            // geometry dirty-tracker with a ghost and break the variables-delta contract
            // ("updatedNodeIds stays empty for doc-level changes").
            updatedNodeIds: new Set([...finalDeltas.keys()].filter(k => k !== DOCUMENT_DELTA_KEY)),
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
