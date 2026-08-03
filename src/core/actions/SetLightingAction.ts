/**
 * @module SetLightingAction
 * @description Sets the scene's LIGHTS and ambient floor (schema 42) — the only write path to them.
 *
 * A document-level action, like `SetTimelineAction`: lighting belongs to the scene rather than to
 * any shape in it, so it travels under `DOCUMENT_DELTA_KEY`. Both fields move together because
 * they are one decision — an ambient floor without lights is just a dimmer, and lights without a
 * floor put every unlit face at pure black.
 *
 * Validation is the shared `lightsError`/`ambientError`, the rules the loader runs, so this cannot
 * author a scene a reload would refuse.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Light, ambientError, lightsError } from "../document/Light";
import { MutationResult, ActionPayload, DOCUMENT_DELTA_KEY } from "./types";

export class SetLightingAction extends Action {
    private lights: Light[] | undefined;
    private ambient: number | undefined;

    constructor(document: ReadonlyDocument, lights: Light[] | undefined, ambient: number | undefined) {
        super(document);
        this.lights = lights;
        this.ambient = ambient;
    }

    public validate(): boolean {
        return lightsError(this.lights) === null && ambientError(this.ambient) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error("Validation failed: invalid lighting.");
        return {
            updatedNodeIds: new Set(),
            propertyDeltas: new Map([[DOCUMENT_DELTA_KEY, { kind: "lighting", lights: this.lights, ambient: this.ambient } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetLightingAction", payload: { lights: this.lights, ambient: this.ambient }, timestamp: Date.now() };
    }
}
