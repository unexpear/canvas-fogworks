/**
 * @module SetTilesetsAction
 * @description The only write path to `Document.tilesets` (schema 67).
 *
 * IT WAS MISSING FOR AN HOUR, which is the second time this exact gap has appeared in this codebase
 * and the reason it is worth a header. `Document.clips` arrived at schema 46 validated, serialised,
 * migrated and READ BY THE EXPORTER, with nothing able to set it. `Document.tilesets` shipped the
 * same way: the migration wrote one, the importer BUILT a list and dropped it on the floor, and
 * every imported layer named a tileset the document did not have — so it drew nothing at all. A
 * field with no write path is not a feature with a gap; it is a feature that does not exist.
 *
 * A DOCUMENT-LEVEL ACTION, like `SetTimelineAction` and `SetClipsAction`: a tileset is shared by
 * every layer that names it, so it belongs to the file rather than to any shape on it. It travels
 * under its own kind's key, which is what lets an import set the tilesets and the nodes in one
 * transaction — before that key existed a transaction could carry only one document-level change.
 *
 * WHOLE-VALUE, NOT A PATCH, for the reason `SetClipsAction` is: the table is validated as a SET —
 * `tilesetsError` refuses duplicate ids — so a per-entry edit would have to re-validate all of it
 * anyway. Whole-value also composes correctly in a transaction, last wins, and each action builds
 * its delta from the working document, so "import a map, then rename a set" carries the import.
 *
 * `undefined` REMOVES the table, which is how a document with no tilemap serialises exactly as one
 * that never had tilesets.
 *
 * A LAYER NAMING A REMOVED TILESET IS NOT REFUSED. Deleting a set a layer still uses leaves an empty
 * grid somebody can point at something else — the inert-reference rule this schema follows
 * everywhere, and the alternative is a file that will not open because of a deletion.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Tileset, tilesetsError } from "../document/Tileset";
import { MutationResult, ActionPayload, documentDeltaKey } from "./types";

export class SetTilesetsAction extends Action {
    private tilesets: Tileset[] | undefined;

    constructor(document: ReadonlyDocument, tilesets: Tileset[] | undefined) {
        super(document);
        this.tilesets = tilesets;
    }

    public validate(): boolean {
        // THE SHARED RULE, the one the loader runs, so this cannot author a table a reload refuses.
        return tilesetsError(this.tilesets) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error("Validation failed: invalid tilesets.");
        return {
            // NOT a node id, and leaking one would seed the geometry dirty-tracker with a ghost —
            // the rule every document-level action follows.
            updatedNodeIds: new Set(),
            propertyDeltas: new Map([[documentDeltaKey("tilesets"),
                { kind: "tilesets", tilesets: this.tilesets } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetTilesetsAction", payload: { tilesets: this.tilesets }, timestamp: Date.now() };
    }
}
