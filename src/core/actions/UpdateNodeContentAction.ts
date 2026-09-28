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
import { srcError, sourceRectError, nineSliceError, clipsContentError, SourceRect,
    UserData, userDataError, classNameError } from "../document/Node";
import { Entity, entityError } from "../document/Entity";
import {behaviorDataBindingsError} from "../document/BehaviorDataBindings";
import { NineSliceInsets } from "../geometry/NineSlice";
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
    /** A bitmap's nine-slice insets (schema 57). `null` clears it back to one stretched picture. */
    nineSlice?: NineSliceInsets | null;
    /**
     * Whether this node's children are cut to its box (schema 59). `null` clears the flag.
     *
     * Here rather than in `editSelected`'s geometry/style patch because it is neither: it is a
     * fact about the node, like `src` and `nineSlice`. It also lands in the same `execute` that
     * once VALIDATED `nineSlice` and then forgot to copy it into the delta — so the test for this
     * one asks the document what it holds afterwards rather than asking the action what it did.
     */
    clipsContent?: boolean | null;
    /**
     * The author's own kind for this node (schema 64). `null` clears it.
     *
     * Here with `name` and `src` because it is the same kind of fact — a hand-editable label on the
     * node — and putting it anywhere else would mean a second undo step for one imported object.
     */
    className?: string | null;
    /** Author-defined properties (schema 64). `null` clears them; see `UserData`. */
    userData?: UserData | null;
    /** Engine-owned gameplay declarations (schema 73). `null` clears them. */
    entity?: Entity | null;
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
        // THE SAME VALIDATORS THE LOAD PATH USES, which is the rule every field here obeys — an
        // edit must not be able to author a document the loader would then refuse to open.
        // EMPTY IS A CLEAR, not a refusal. A text field hands back "" the moment somebody selects
        // the word and deletes it, and refusing that would make `validate` false — an action that
        // is silently dropped, so the field keeps its old value with nothing to say why. `null` and
        // "" mean the same thing here, and `applyMutations` removes the field for both.
        if (this.patch.className !== undefined && this.patch.className !== null
            && this.patch.className !== "" && classNameError(this.patch.className) !== null) return false;
        if (this.patch.userData !== undefined && this.patch.userData !== null
            && userDataError(this.patch.userData) !== null) return false;
        if (this.patch.entity !== undefined && this.patch.entity !== null
            && entityError(this.patch.entity) !== null) return false;
        if (this.patch.entity?.behaviorAssetId && !this.document.behaviorAssets?.some(a=>a.id===this.patch.entity!.behaviorAssetId)) return false;
        if(behaviorDataBindingsError(this.patch.entity?.behavior,this.document.gameplayVariables,[],this.document.behaviorFunctions))return false;
        // Again the loader's own rule, so the inspector cannot author insets the document could
        // not reopen — and `null` is the clear rather than a value to check.
        if (this.patch.nineSlice !== undefined && this.patch.nineSlice !== null
            && nineSliceError(node.type, this.patch.nineSlice) !== null) return false;
        if (this.patch.clipsContent !== undefined && this.patch.clipsContent !== null
            && clipsContentError(this.patch.clipsContent) !== null) return false;
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
        // `null` survives here too, for the same reason the region's does: it is the clear.
        if (this.patch.nineSlice !== undefined) delta.nineSlice = this.patch.nineSlice;
        if (this.patch.clipsContent !== undefined) delta.clipsContent = this.patch.clipsContent;
        // `null` survives here too — it is the clear. `nineSlice` was VALIDATED here once and then
        // not copied into the delta, so these two are checked by asking the DOCUMENT what it holds
        // afterwards rather than asking the action what it did.
        if (this.patch.className !== undefined) delta.className = this.patch.className;
        if (this.patch.userData !== undefined) delta.userData = this.patch.userData;
        if (this.patch.entity !== undefined) delta.entity = this.patch.entity;

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
