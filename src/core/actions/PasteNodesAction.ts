/**
 * @module PasteNodesAction
 * @description Puts the clipboard's nodes into the document — one Action, so one undo.
 *
 * ONE ACTION FOR THE WHOLE PASTE, not one per node wrapped in a transaction. A paste is a single
 * thing a user did: pressing undo after pasting a five-node group must remove the group, not its
 * last node. `AddNodeAction` cannot do it — it creates one node from a type and a box, and a paste
 * carries whole subtrees that already exist as nodes.
 *
 * THE IDS ARE MINTED BEFORE THE ACTION, in `remapForPaste`, and held for its lifetime. The
 * dispatcher may execute an action more than once (redo replays it), and minting inside `execute`
 * would produce different ids each time — so a redo would add a SECOND copy rather than restoring
 * the first, and the selection left pointing at nodes that no longer exist.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Node, nodeIdError } from "../document/Node";
import { MutationResult, ActionPayload, NodeDelta } from "./types";

export class PasteNodesAction extends Action {
    private nodes: Node[];
    private rootIds: string[];

    constructor(document: ReadonlyDocument, nodes: readonly Node[], rootIds: readonly string[]) {
        super(document);
        this.nodes = nodes.map(n => n);
        this.rootIds = [...rootIds];
    }

    /** The nodes this paste created, for selecting them afterwards. */
    public getCreatedRootIds(): string[] {
        return [...this.rootIds];
    }

    public validate(): boolean {
        if (this.nodes.length === 0) return false;
        const incoming = new Set(this.nodes.map(n => n.id));
        for (const node of this.nodes) {
            // A COLLIDING ID would silently REPLACE an existing node and orphan its children.
            // `remapForPaste` mints fresh ones, so a collision here means the caller assembled the
            // payload some other way — and the check is cheap next to a lost subtree.
            if (this.document.nodes.has(node.id)) return false;
            if (nodeIdError(node.id) !== null) return false;
            // EVERY PARENT MUST BE IN THE PAYLOAD OR ABSENT. A node claiming a parent that is
            // neither is an orphan, which the integrity check refuses on the next load — so it
            // would save fine and fail to reopen.
            if (node.parent !== null && node.parent !== undefined && !incoming.has(node.parent)) return false;
        }
        for (const id of this.rootIds) if (!incoming.has(id)) return false;
        return true;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error("Validation failed: nothing to paste.");
        const deltas = new Map<string, NodeDelta>();
        for (const node of this.nodes) {
            deltas.set(node.id, { kind: "add", node } as NodeDelta);
        }
        return {
            updatedNodeIds: new Set(this.nodes.map(n => n.id)),
            propertyDeltas: deltas,
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "PasteNodesAction",
            payload: {
                // The NODES are deliberately absent from the log: a paste of a painted canvas
                // carries a megabyte of pixels, and an action log is for replay and diagnosis.
                // The ids identify the edit; the nodes are in the document.
                rootIds: this.rootIds,
                count: this.nodes.length
            },
            timestamp: Date.now()
        };
    }
}
