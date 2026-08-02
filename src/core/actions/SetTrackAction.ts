/**
 * @module SetTrackAction
 * @description Sets a node's KEYFRAMES through the dispatcher — the only write path to animation.
 *
 * Validation is the shared `trackError`, the rule the loader runs, so this cannot author a track a
 * reload would refuse. The keyframes' VALUES go through `overrideValueError`, which is the rule a
 * state and an instance override already obey: there is one definition of "what a node may say
 * differs about itself", and animation did not add a second.
 *
 * An EMPTY track removes the field rather than storing `[]`, so a node whose animation was deleted
 * serialises exactly like one that was never animated — the same discipline `SetInteractionsAction`
 * follows, and the same one Outline Stroke follows when it strips a border.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Keyframe } from "../document/Timeline";
import { trackError } from "../document/Timeline";
import { overrideValueError } from "../document/Components";
import { MutationResult, ActionPayload } from "./types";

export class SetTrackAction extends Action {
    private nodeId: string;
    private track: Keyframe[];

    constructor(document: ReadonlyDocument, nodeId: string, track: Keyframe[]) {
        super(document);
        this.nodeId = nodeId;
        this.track = track;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        return trackError(this.track, v => overrideValueError("keyframe", v)) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid track for node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, {
                kind: "patch",
                track: this.track.length > 0 ? this.track : undefined
            } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetTrackAction", payload: { nodeId: this.nodeId, track: this.track }, timestamp: Date.now() };
    }
}
