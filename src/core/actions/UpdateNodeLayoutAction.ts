/**
 * @module UpdateNodeLayoutAction
 * @description Sets a node's layout — including the Milestone 2 auto-layout
 * `container` — through the dispatcher.
 *
 * The write-path primitive for `Node.layout`, at the document layer and independent
 * of any UI, so auto-layout is a full document citizen — authorable, undoable,
 * serializable — before Milestone 5 adds a layout inspector to invoke it. Without it,
 * `layout.container` could only enter a document by hand-editing a file: the
 * dead-but-consumed field the schema doc warns against.
 *
 * Passing `{ container: undefined }` REMOVES auto-layout (the children revert to their
 * stored geometry), which is why the patch merges field-by-field rather than replacing.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Layout, layoutError } from "../document/Node";
import { MutationResult, ActionPayload } from "./types";

export class UpdateNodeLayoutAction extends Action {
    private nodeId: string;
    private newLayout: Partial<Layout>;

    constructor(document: ReadonlyDocument, nodeId: string, layout: Partial<Layout>) {
        super(document);
        this.nodeId = nodeId;
        this.newLayout = layout;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        // Shared with the load path — see `layoutError` in Node.ts.
        return layoutError(this.newLayout) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid layout for node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", layout: this.newLayout } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "UpdateNodeLayoutAction",
            payload: { nodeId: this.nodeId, layout: this.newLayout },
            timestamp: Date.now()
        };
    }
}
