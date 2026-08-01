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
 *
 * MUTUAL EXCLUSIVITY (grid ⊕ container): setting one emits the OTHER as `undefined` in
 * the same delta, so the exclusivity is carried IN the delta rather than applied as a
 * side effect in the single mutation site. This is what keeps a TRANSACTION correct: two
 * layout patches on one node merge field-by-field (later wins), so `set container` then
 * `set grid` collapses to `{ container: undefined, grid: … }` — grid wins — instead of a
 * post-hoc "clear both" that would drop BOTH.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Layout, layoutError , layoutExclusivity} from "../document/Node";
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
        // Carry grid ⊕ container exclusivity IN the delta (see the module note): setting
        // one clears the other, self-consistently, so a transaction merge stays correct.
        // The rule itself lives in `layoutExclusivity`, shared with the instance-override
        // merge — two paths that must agree on what "these two are exclusive" means.
        const layout: Partial<Layout> = layoutExclusivity({ ...this.newLayout });
        // Freeze the constraint reference at FIRST opt-in: capture the parent's CURRENT
        // stored size so a static parent (computed == stored) causes no jump. Only when the
        // node has NO existing reference and the caller supplied none — never re-capture on
        // a later mode edit, which would un-freeze the reference (delta -> 0) and teleport
        // the child back to its rest position. An explicit `constraintRef` in the patch
        // (a deliberate re-baseline) skips this and is honoured as-is.
        const node = this.document.nodes.get(this.nodeId);
        if (layout.constraints !== undefined && layout.constraintRef === undefined && node?.layout.constraintRef === undefined) {
            const parentId = node?.parent;
            const parent = parentId ? this.document.nodes.get(parentId) : undefined;
            // Auto-capture ONLY from a NON-container parent. A container's STORED size is an
            // unreliable reference — hug/grow/stretch make its computed size differ from
            // stored — so capturing from it would place an absolute child against the wrong
            // box and teleport it at rest. A ref for an absolute child of a container must
            // come from the tool layer (the parent's COMPUTED size — M5); until then the
            // constraint stays inert (the child keeps its stored position) rather than jumping.
            const parentIsContainer = !!parent && (parent.layout.container !== undefined || parent.layout.grid !== undefined);
            if (parent && !parentIsContainer) layout.constraintRef = { width: parent.geometry.width, height: parent.geometry.height };
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", layout } as const]]),
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
