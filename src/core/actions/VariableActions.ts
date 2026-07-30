/**
 * @module VariableActions
 * @description The write path for the document's design tokens (schema 19): upsert a
 * variable, delete one, switch the active theme. All three emit the same DOCUMENT-level
 * delta — `{ kind: "variables" }` under `DOCUMENT_DELTA_KEY`, carrying the WHOLE new
 * store + theme — so transactions compose last-wins and undo restores both at once.
 *
 * Validation delegates to the shared `variableStoreError` (the same rule the load path
 * runs), so the edit path can never author a store the loader would reject — the
 * round-trip-closure discipline. Deleting a variable that other variables alias (or that
 * node styles reference) is deliberately allowed: dangling references are valid at rest
 * and resolve to the visible fallback, so a delete can never corrupt a document.
 *
 * `updatedNodeIds` stays EMPTY: no node changed, and the id set feeds the geometry
 * dirty-tracker, which variables never affect (colors don't move boxes). Listeners
 * repaint off the onChange itself.
 */

import { Action } from "./Action";
import { ReadonlyDocument, VariableStore, ThemeMode } from "../document/Document";
import { Variable, THEME_MODES, variableStoreError } from "../document/Variables";
import { MutationResult, ActionPayload, NodeDelta, DOCUMENT_DELTA_KEY } from "./types";

/** The shared success shape: a whole-state document delta under the reserved key. */
function variablesResult(variables: VariableStore, activeTheme: ThemeMode): MutationResult {
    const delta: NodeDelta = { kind: "variables", variables, activeTheme };
    return {
        updatedNodeIds: new Set(),
        propertyDeltas: new Map([[DOCUMENT_DELTA_KEY, delta]]),
        success: true
    };
}

/** A deep-enough copy of the store for a delta: new map + new per-variable objects. */
function copyStore(store: ReadonlyDocument["variables"]): VariableStore {
    return JSON.parse(JSON.stringify(store));
}

/** Upsert one variable (create or replace `key`). */
export class SetVariableAction extends Action {
    private key: string;
    private variable: Variable;

    constructor(document: ReadonlyDocument, key: string, variable: Variable) {
        super(document);
        this.key = key;
        this.variable = variable;
    }

    public validate(): boolean {
        // Validate the RESULTING store with the shared load-path rule (covers the key
        // rules, the definition, and the entry cap in one place).
        const next = copyStore(this.document.variables);
        next[this.key] = this.variable;
        return variableStoreError(next) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid variable "${this.key}".`);
        }
        const next = copyStore(this.document.variables);
        next[this.key] = JSON.parse(JSON.stringify(this.variable));
        return variablesResult(next, this.document.activeTheme);
    }

    public serialize(): ActionPayload {
        return {
            actionId: "SetVariableAction",
            payload: { key: this.key, variable: this.variable },
            timestamp: Date.now()
        };
    }
}

/** Delete one variable. References to it (aliases, node styles) stay valid and resolve
 *  to the visible fallback — a delete can never corrupt the document. */
export class DeleteVariableAction extends Action {
    private key: string;

    constructor(document: ReadonlyDocument, key: string) {
        super(document);
        this.key = key;
    }

    public validate(): boolean {
        return Object.prototype.hasOwnProperty.call(this.document.variables, this.key);
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: no variable "${this.key}" to delete.`);
        }
        const next = copyStore(this.document.variables);
        delete next[this.key];
        return variablesResult(next, this.document.activeTheme);
    }

    public serialize(): ActionPayload {
        return {
            actionId: "DeleteVariableAction",
            payload: { key: this.key },
            timestamp: Date.now()
        };
    }
}

/** Switch the document's active theme mode ("light"/"dark") — undoable and persisted. */
export class SetActiveThemeAction extends Action {
    private theme: ThemeMode;

    constructor(document: ReadonlyDocument, theme: ThemeMode) {
        super(document);
        this.theme = theme;
    }

    public validate(): boolean {
        return (THEME_MODES as readonly string[]).includes(this.theme);
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: unknown theme "${String(this.theme)}".`);
        }
        // Carries the CURRENT store (from the working document when inside a transaction),
        // so an earlier same-transaction variable edit rides along — last-wins loses nothing.
        return variablesResult(copyStore(this.document.variables), this.theme);
    }

    public serialize(): ActionPayload {
        return {
            actionId: "SetActiveThemeAction",
            payload: { theme: this.theme },
            timestamp: Date.now()
        };
    }
}
