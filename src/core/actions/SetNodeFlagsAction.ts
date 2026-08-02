/**
 * @module SetNodeFlagsAction
 * @description The write path for a node's LAYER FLAGS (schema 31): hidden and locked.
 *
 * Both are view decisions rather than design ones — hiding is not deleting and locking is not
 * read-only-ness — so they live on the node, travel with it, and are undoable like any edit.
 * One action for both because they are the same kind of statement and a layer row toggles them
 * from the same place; the patch is partial, so toggling `hidden` never disturbs `locked`.
 *
 * `false` is stored as ABSENT rather than `false`, so a document that has never used these
 * fields stays byte-identical to one where they were toggled on and off again.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { MutationResult, ActionPayload } from "./types";

export interface NodeFlags {
    hidden?: boolean;
    locked?: boolean;
}

export class SetNodeFlagsAction extends Action {
    private nodeId: string;
    private flags: NodeFlags;

    constructor(document: ReadonlyDocument, nodeId: string, flags: NodeFlags) {
        super(document);
        this.nodeId = nodeId;
        this.flags = flags;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        for (const v of [this.flags.hidden, this.flags.locked]) {
            if (v !== undefined && typeof v !== "boolean") return false;
        }
        return true;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid layer flags for node "${this.nodeId}".`);
        }
        const delta: { kind: "patch"; hidden?: boolean; locked?: boolean } = { kind: "patch" };
        // `|| undefined` so a cleared flag is ABSENT, not `false` — see the module note.
        if ("hidden" in this.flags) delta.hidden = this.flags.hidden || undefined;
        if ("locked" in this.flags) delta.locked = this.flags.locked || undefined;
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, delta]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetNodeFlagsAction", payload: { nodeId: this.nodeId, flags: this.flags }, timestamp: Date.now() };
    }
}
