/**
 * @module SetClipsAction
 * @description Names ranges of the timeline — the only write path to `Document.clips`.
 *
 * IT DID NOT EXIST. `Document.clips` arrived at schema 46: validated by `clipsError` on every load,
 * serialised, migrated, read by `Rig` and read by the SPRITE-SHEET EXPORTER — and nothing anywhere
 * could set it. So every sheet this engine has ever exported carried an empty clip list, and the
 * field a `.aseprite`'s tags map onto field-for-field had no destination. Reading a format is not
 * importing it if the thing you read cannot be stored.
 *
 * A DOCUMENT-LEVEL ACTION, like `SetTimelineAction` and for the same reason: a clip names frames of
 * the document's clock, not of any shape on it, so it travels under `DOCUMENT_DELTA_KEY` rather
 * than naming a node.
 *
 * WHOLE-VALUE, NOT A PATCH. Clips are identified by NAME and validated as a set — `clipsError`
 * refuses duplicates and ranges outside the timeline — so a per-clip edit would have to re-validate
 * the whole list anyway. Whole-value also composes correctly in a transaction: last wins, and each
 * action builds its delta from the working document, so "import clips, then rename one" carries the
 * import forward.
 *
 * `undefined` REMOVES them, which is how a document stops having named ranges and how it serialises
 * exactly as one that never had any.
 *
 * VALIDATED AGAINST THE TIMELINE THE DOCUMENT WILL HAVE, which is the subtle part. `clipsError`
 * takes the timeline because a clip's range is meaningless without one, and inside a transaction the
 * clock may be arriving in the SAME batch — an Aseprite import sets both. So the caller may state
 * the timeline this list is to be judged against; without it, the document's current one is used.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Clip, clipsError } from "../document/Clips";
import { TimelineSettings } from "../document/Timeline";
import { MutationResult, ActionPayload, DOCUMENT_DELTA_KEY } from "./types";

export class SetClipsAction extends Action {
    private clips: Clip[] | undefined;
    private against: TimelineSettings | undefined;

    /**
     * @param clips the whole list, or `undefined` to remove it
     * @param against the timeline to validate against; omitted uses the document's own. Pass it when
     *        a `SetTimelineAction` earlier in the same transaction has not been applied yet.
     */
    constructor(document: ReadonlyDocument, clips: Clip[] | undefined, against?: TimelineSettings) {
        super(document);
        this.clips = clips;
        this.against = against;
    }

    public validate(): boolean {
        const timeline = this.against ?? this.document.timeline;
        // THE SHARED RULE, the one the loader runs, so this cannot author a list a reload refuses.
        return clipsError(this.clips, timeline) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error("Validation failed: invalid clips.");
        return {
            // NOT the sentinel: it is not a node id, and leaking it would seed the geometry
            // dirty-tracker with a ghost — the rule every document-level action follows.
            updatedNodeIds: new Set(),
            propertyDeltas: new Map([[DOCUMENT_DELTA_KEY, { kind: "clips", clips: this.clips } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetClipsAction", payload: { clips: this.clips }, timestamp: Date.now() };
    }
}
