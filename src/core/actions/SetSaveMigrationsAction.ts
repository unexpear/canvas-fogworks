/**
 * @module SetSaveMigrationsAction
 * @description The write path for the document's cross-build save list.
 */
import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { DocumentSaveMigration, normalizeSaveMigrations, saveMigrationsError } from "../document/SaveMigrations";
import { ActionPayload, MutationResult, documentDeltaKey } from "./types";

export class SetSaveMigrationsAction extends Action {
    constructor(document: ReadonlyDocument, private migrations: readonly DocumentSaveMigration[] | undefined) {
        super(document);
    }

    validate(): boolean {
        return saveMigrationsError(this.migrations) === null;
    }

    execute(): MutationResult {
        if (!this.validate()) throw new Error("Invalid save migration table.");
        return {
            success: true,
            updatedNodeIds: new Set(),
            propertyDeltas: new Map([[documentDeltaKey("saveMigrations"), {
                kind: "saveMigrations",
                saveMigrations: normalizeSaveMigrations(this.migrations)
            }]])
        };
    }

    serialize(): ActionPayload {
        return { actionId: "SetSaveMigrationsAction", payload: { migrations: this.migrations }, timestamp: Date.now() };
    }
}
