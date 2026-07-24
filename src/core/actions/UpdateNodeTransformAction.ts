/**
 * @module UpdateNodeTransformAction
 * @description Sets a node's rotation / scale / pivot through the dispatcher.
 *
 * The write-path primitive for `Node.transform` (schema 2). It exists at the
 * document layer, independent of any UI, so `transform` is a full document citizen —
 * authorable, undoable, serializable — before Milestone 4 adds a rotate handle to
 * invoke it. Without it, a transform could only enter a document by hand-editing a
 * file, which is exactly the dead-but-consumed field the schema doc warns against.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Transform } from "../document/Node";
import { MutationResult, ActionPayload } from "./types";

export class UpdateNodeTransformAction extends Action {
    private nodeId: string;
    private newTransform: Partial<Transform>;

    constructor(document: ReadonlyDocument, nodeId: string, transform: Partial<Transform>) {
        super(document);
        this.nodeId = nodeId;
        this.newTransform = transform;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        const t = this.newTransform;
        // Presence-based (see UpdateNodeGeometryAction): a present-but-undefined key
        // must be rejected, not skipped, or Object.assign copies the undefined in.
        if ("rotation" in t && !Number.isFinite(t.rotation)) return false;
        // A zero scale collapses the node: it is non-invertible, so toLocal/hit-test
        // would fail. Negative scale (a flip) is legitimate and allowed.
        if ("scaleX" in t && (!Number.isFinite(t.scaleX) || t.scaleX === 0)) return false;
        if ("scaleY" in t && (!Number.isFinite(t.scaleY) || t.scaleY === 0)) return false;
        if ("origin" in t) {
            const o = t.origin;
            if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return false;
        }
        return true;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid transform for node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", transform: this.newTransform } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "UpdateNodeTransformAction",
            payload: { nodeId: this.nodeId, transform: this.newTransform },
            timestamp: Date.now()
        };
    }
}
