/**
 * @module SetBackgroundAction
 * @description The only write path to `Document.background` (schema 70).
 *
 * WRITTEN IN THE SAME COMMIT AS THE FIELD, which is the whole point of this file existing on the
 * day the field does. `Document.clips` shipped at schema 46 validated, serialised, migrated and
 * READ BY THE SPRITE-SHEET EXPORTER with nothing able to set it; `Document.tilesets` shipped the
 * same way, and every imported layer named a tileset the document did not have. Twice is a pattern,
 * so `SetTilesetsAction`'s header asked for this to be a rule. A field with no write path is not a
 * feature with a gap; it is a feature that does not exist.
 *
 * A DOCUMENT-LEVEL ACTION, like `SetTilesetsAction` and `SetTimelineAction`: a background is a
 * property of the SCENE rather than of any shape on it — see `Document.background` for why it is
 * not simply a very large rectangle behind everything. Travelling under its own kind's key is what
 * lets a Tiled import set the tilesets, the nodes AND the sky in one transaction.
 *
 * `undefined` REMOVES it, which is how a document says it has no background — the state every
 * document was in before this field existed, and the state it must serialise back to byte for byte.
 * An EMPTY string is refused rather than treated as removal: clearing a field and typing nothing
 * into it are different intentions, and the validator that refuses it is the loader's own.
 */

import { Action } from "./Action";
import { ReadonlyDocument, backgroundError } from "../document/Document";
import { MutationResult, ActionPayload, documentDeltaKey } from "./types";

export class SetBackgroundAction extends Action {
    private background: string | undefined;

    constructor(document: ReadonlyDocument, background: string | undefined) {
        super(document);
        this.background = background;
    }

    public validate(): boolean {
        // THE SHARED RULE, the one the loader runs, so this cannot author a document a reload
        // refuses — the same reason `SetTilesetsAction` calls `tilesetsError` rather than its own.
        return backgroundError(this.background) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error("Validation failed: invalid background.");
        return {
            // NOT a node id, and leaking one would seed the geometry dirty-tracker with a ghost —
            // the rule every document-level action follows.
            updatedNodeIds: new Set(),
            propertyDeltas: new Map([[documentDeltaKey("background"),
                { kind: "background", background: this.background } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetBackgroundAction", payload: { background: this.background }, timestamp: Date.now() };
    }
}
