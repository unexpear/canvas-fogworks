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
import { MutationResult, ActionPayload, NodeDelta, DOCUMENT_DELTA_KEY,
    documentDeltaKey, isDocumentDeltaKey } from "./types";
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
        frame: doc.frame,
        // AND THE FIELDS THIS LIST KEEPS FORGETTING. The comment above says every field added since
        // this was written was dropped by any transaction that ran; it then went on to omit the
        // clips, the lighting and the tilesets. An action inside a transaction reading `doc.tilesets`
        // would see none, which for an import that sets them and then places layers is fatal.
        clips: doc.clips as ProjectDocument["clips"],
        lights: doc.lights as ProjectDocument["lights"],
        ambient: doc.ambient,
        tilesets: doc.tilesets as ProjectDocument["tilesets"]
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
        let lightingDelta: Extract<NodeDelta, { kind: "lighting" }> | null = null;
        // LAST WINS, like every other document-level value here: each action builds its delta
        // from the working document, so an import that sets the clock and then the clips it
        // indexes into composes in the order it was written.
        let clipsDelta: Extract<NodeDelta, { kind: "clips" }> | null = null;
        let tilesetsDelta: Extract<NodeDelta, { kind: "tilesets" }> | null = null;
        let backgroundDelta: Extract<NodeDelta, { kind: "background" }> | null = null;

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
                } else if (delta.kind === "lighting") {
                    lightingDelta = delta;
                } else if (delta.kind === "clips") {
                    clipsDelta = delta;
                } else if (delta.kind === "tilesets") {
                    tilesetsDelta = delta;
                } else if (delta.kind === "background") {
                    backgroundDelta = delta;
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
        // The net document-level state, one slot PER KIND. This used to be one slot in total, and
        // a transaction touching two document-level things was REFUSED — the right call while the
        // alternative was losing one silently, but it made a legitimate edit impossible: a clock
        // and the named ranges that index INTO it are one act, and an Aseprite import performs
        // exactly that. Keying by kind lets them coexist without reintroducing the loss, because
        // two deltas of the SAME kind still collapse last-wins, which is what they always did.
        //
        // `applyMutations` was already indifferent — "the key is ignored, the KIND carries the
        // meaning" — so the change is confined to who may share the map.
        const documentDeltas = [variablesDelta, activeStateDelta, timelineDelta, lightingDelta,
            clipsDelta, tilesetsDelta, backgroundDelta].filter(d => d !== null);
        for (const delta of documentDeltas) {
            finalDeltas.set(documentDeltaKey((delta as NodeDelta & { kind: string }).kind), delta as NodeDelta);
        }

        return {
            // The document-delta keys are NOT node ids — leaking one would seed the geometry
            // dirty-tracker with a ghost and break the variables-delta contract ("updatedNodeIds
            // stays empty for doc-level changes"). Matched by PREFIX now that there are several.
            updatedNodeIds: new Set([...finalDeltas.keys()].filter(k => !isDocumentDeltaKey(k))),
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
