/**
 * @module UpdateNodeContentAction
 * @description Edits a node's CONTENT — its text, its image source, or its display name.
 *
 * The gap this fills is blunt: a `core.text` node's text could be authored (the shape tool
 * writes "Text") and rendered, but never CHANGED — there was no action that touched `text` at
 * all, so the field was write-once-at-creation. Same for a `core.image`'s `src` and for
 * `Node.name`, which the layers panel displays and nothing could set.
 *
 * All three live together because they are the same kind of thing — terminal per-node values
 * with no geometry or paint semantics — and because the delta layer already carries them side
 * by side (`patch.text` / `.src` / `.name`).
 *
 * A patch omits what it does not change. It cannot CLEAR a field back to absent: the delta
 * layer skips `undefined` (that is how "not mentioned" is encoded), so removing a field would
 * need a distinct signal in `applyMutationsToDocument`. Empty string covers the useful cases —
 * an empty text node, an unnamed node — and `src` cannot be emptied at all, since `srcError`
 * requires a non-empty string. Half-supporting a clear that silently did nothing would be
 * worse than not offering one.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { srcError, sourceRectError, SourceRect } from "../document/Node";
import { MutationResult, ActionPayload, NodeDelta } from "./types";

type PatchDelta = Extract<NodeDelta, { kind: "patch" }>;

/** `undefined` = leave unchanged; `null` = clear the field; a string = set it. */
export interface ContentPatch {
    text?: string;
    src?: string;
    name?: string;
    /** An image's SOURCE REGION (schema 51). `null` clears it back to the whole image. */
    sourceRect?: SourceRect | null;
    /** Whether the image scales by nearest neighbour (schema 51). */
    pixelated?: boolean;
}

/** Longest display name a node may carry — an OOM guard on a hand-editable field. */
export const NODE_NAME_MAX = 200;

export class UpdateNodeContentAction extends Action {
    private nodeId: string;
    private patch: ContentPatch;

    constructor(document: ReadonlyDocument, nodeId: string, patch: ContentPatch) {
        super(document);
        this.nodeId = nodeId;
        this.patch = patch;
    }

    public validate(): boolean {
        const node = this.document.nodes.get(this.nodeId);
        if (!node) return false;
        if (this.patch.text !== undefined && typeof this.patch.text !== "string") return false;
        if (this.patch.name !== undefined) {
            if (typeof this.patch.name !== "string") return false;
            if (this.patch.name.length > NODE_NAME_MAX) return false;
        }
        // `src` obeys the SAME shared rule the loader and `AddNodeAction` apply, so the
        // inspector cannot author an image source the document could not reopen.
        if (this.patch.src !== undefined && srcError(node.type, this.patch.src) !== null) return false;
        // The SAME shared rule the loader applies, so an inspector cannot author a region the
        // document could not reopen. `null` is the clear and is not a rect to check.
        if (this.patch.sourceRect !== undefined && this.patch.sourceRect !== null
            && sourceRectError(this.patch.sourceRect) !== null) return false;
        if (this.patch.pixelated !== undefined && typeof this.patch.pixelated !== "boolean") return false;
        return true;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid content patch for node "${this.nodeId}".`);
        }
        // An omitted field never reaches the delta. Defence in depth rather than the only
        // guard: `applyMutationsToDocument` skips an `undefined` value, and `mergePatch` uses
        // `??`, so an explicit `text: undefined` would fall through in both places anyway.
        // Building the delta from what was actually asked for still reads better than relying
        // on two downstream layers to ignore a key that should not be there.
        const delta: PatchDelta = { kind: "patch" };
        if (this.patch.text !== undefined) delta.text = this.patch.text;
        if (this.patch.src !== undefined) delta.src = this.patch.src;
        if (this.patch.name !== undefined) delta.name = this.patch.name;
        // `null` SURVIVES here on purpose — it is the clear, and dropping it the way an omitted
        // field is dropped would make a region impossible to remove once set.
        if (this.patch.sourceRect !== undefined) delta.sourceRect = this.patch.sourceRect;
        if (this.patch.pixelated !== undefined) delta.pixelated = this.patch.pixelated;

        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, delta]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "UpdateNodeContentAction",
            payload: { nodeId: this.nodeId, patch: this.patch },
            timestamp: Date.now()
        };
    }
}
