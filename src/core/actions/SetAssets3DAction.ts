/**
 * @module SetAssets3DAction
 * @description The undoable whole-table write path for stable 3D asset records (schema 74).
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Asset3D, assets3DError } from "../document/Spatial3D";
import { ActionPayload, documentDeltaKey, MutationResult } from "./types";

export class SetAssets3DAction extends Action {
    constructor(document: ReadonlyDocument, private assets3d: Asset3D[] | undefined) {
        super(document);
    }

    public validate(): boolean {
        return assets3DError(this.assets3d) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error("Validation failed: invalid assets3d table.");
        return {
            updatedNodeIds: new Set(),
            propertyDeltas: new Map([[documentDeltaKey("assets3d"), { kind: "assets3d", assets3d: this.assets3d }]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetAssets3DAction", payload: { assets3d: this.assets3d }, timestamp: Date.now() };
    }
}

