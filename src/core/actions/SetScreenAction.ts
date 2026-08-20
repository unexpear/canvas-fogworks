/**
 * @module SetScreenAction
 * @description The only write path to `Document.screen` (schema 72).
 *
 * WRITTEN IN THE SAME COMMIT AS THE FIELD — the rule `SetBackgroundAction`'s header records, paid
 * for twice (`Document.clips`, `Document.tilesets`): a field with no write path is not a feature
 * with a gap, it is a feature that does not exist.
 *
 * A DOCUMENT-LEVEL ACTION, like the background it sits beside: one screen of the game is a
 * property of the GAME, not of any shape in it. `undefined` REMOVES the declaration — the state
 * every pre-72 document is in — and a malformed size is refused by the loader's own validator, so
 * this cannot author a document a reload rejects.
 */

import { Action } from "./Action";
import { ReadonlyDocument, screenError } from "../document/Document";
import { MutationResult, ActionPayload, documentDeltaKey } from "./types";

export class SetScreenAction extends Action {
    private screen: { width: number; height: number } | undefined;

    constructor(document: ReadonlyDocument, screen: { width: number; height: number } | undefined) {
        super(document);
        this.screen = screen;
    }

    public validate(): boolean {
        // THE SHARED RULE, the one the loader runs — same reason `SetBackgroundAction` calls
        // `backgroundError` rather than writing its own.
        return screenError(this.screen) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error("Validation failed: invalid screen.");
        return {
            // NOT a node id, and leaking one would seed the geometry dirty-tracker with a ghost —
            // the rule every document-level action follows.
            updatedNodeIds: new Set(),
            propertyDeltas: new Map([[documentDeltaKey("screen"),
                { kind: "screen", screen: this.screen ? { ...this.screen } : undefined } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetScreenAction", payload: { screen: this.screen }, timestamp: Date.now() };
    }
}
