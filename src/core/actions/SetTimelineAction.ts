/**
 * @module SetTimelineAction
 * @description Gives a document a CLOCK, or takes it away — the only write path to `timeline`.
 *
 * A document-level action, like `SetActiveStateAction`: it travels under `DOCUMENT_DELTA_KEY`
 * rather than naming a node, because a timeline belongs to the file and not to any shape on it.
 *
 * Validation is the shared `timelineError`, the rule the loader runs, so this cannot author a
 * clock a reload would refuse. `undefined` REMOVES it, which is how a document stops being
 * animated — and a document with no timeline serialises exactly as it did before animation
 * existed, which is the property that keeps a still drawing unaffected by all of this.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { TimelineSettings, timelineError } from "../document/Timeline";
import { MutationResult, ActionPayload, DOCUMENT_DELTA_KEY } from "./types";

export class SetTimelineAction extends Action {
    private timeline: TimelineSettings | undefined;

    constructor(document: ReadonlyDocument, timeline: TimelineSettings | undefined) {
        super(document);
        this.timeline = timeline;
    }

    public validate(): boolean {
        return timelineError(this.timeline) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error("Validation failed: invalid timeline.");
        return {
            // NOT the sentinel: it is not a node id, and leaking it would seed the geometry
            // dirty-tracker with a ghost — the same rule every document-level action follows.
            updatedNodeIds: new Set(),
            propertyDeltas: new Map([[DOCUMENT_DELTA_KEY, { kind: "timeline", timeline: this.timeline } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetTimelineAction", payload: { timeline: this.timeline }, timestamp: Date.now() };
    }
}
