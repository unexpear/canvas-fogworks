/**
 * @module StateActions
 * @description The two write paths for interaction states (Milestone 7, schema 30): defining one
 * on a node, and choosing which one the document is showing.
 *
 * A state says what a node looks like in a named context — `hover`, `pressed`, `error`. It is the
 * same shape of statement as a per-instance override, so it IS one (`StateDefinition`) and shares
 * `overrideValueError`. Which state is showing is a DOCUMENT-level selection, exactly like
 * `activeTheme`: one choice, resolved at display time, with nothing persisted about a node being
 * "currently" hovered.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { StateDefinition, variantNameError } from "../document/Node";
import { mergeOverrides, statesError } from "../document/Components";
import { MutationResult, ActionPayload, DOCUMENT_DELTA_KEY } from "./types";

/** Define (or, with `null`, remove) ONE named state on a node. */
export class SetNodeStateAction extends Action {
    private nodeId: string;
    private state: string;
    private definition: StateDefinition | null;

    constructor(document: ReadonlyDocument, nodeId: string, state: string, definition: StateDefinition | null) {
        super(document);
        this.nodeId = nodeId;
        this.state = state;
        this.definition = definition;
    }

    /** The node's states with this one merged in, or removed. Absent when none are left. */
    private next(): Record<string, StateDefinition> | undefined {
        const node = this.document.nodes.get(this.nodeId);
        const current: Record<string, StateDefinition> = JSON.parse(JSON.stringify(node?.states ?? {}));
        if (this.definition === null) {
            delete current[this.state];
        } else {
            // The SHARED merge, so a state accumulates field by field exactly as an override
            // does — setting a fill then a width keeps both.
            current[this.state] = mergeOverrides(current[this.state], this.definition);
        }
        return Object.keys(current).length === 0 ? undefined : current;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        if (variantNameError("state name", this.state, true) !== null) return false;
        return statesError(this.next()) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid state "${this.state}" on node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", states: this.next() } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "SetNodeStateAction",
            payload: { nodeId: this.nodeId, state: this.state, definition: this.definition },
            timestamp: Date.now()
        };
    }
}

/**
 * Choose which state the whole document shows, or (with `null`) return to the base.
 *
 * Reports as UPDATED every node defining the state being left OR the one being entered — which is
 * exactly the set whose geometry can change. Without that the caller's dirty set would name
 * nothing, the geometry engine would reuse every entry, and the switch would not appear until
 * something unrelated forced a recompute. A document-level change still has per-node consequences,
 * and the action is the only place that knows which nodes they are.
 */
export class SetActiveStateAction extends Action {
    private state: string | null;

    constructor(document: ReadonlyDocument, state: string | null) {
        super(document);
        this.state = state;
    }

    public validate(): boolean {
        if (this.state === null) return true;
        return variantNameError("state name", this.state, true) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid state name "${this.state}".`);
        }
        const from = this.document.activeState;
        const to = this.state ?? undefined;
        const affected = new Set<string>();
        this.document.nodes.forEach((n, id) => {
            if ((from !== undefined && n.states?.[from]) || (to !== undefined && n.states?.[to])) affected.add(id);
        });
        return {
            updatedNodeIds: affected,
            propertyDeltas: new Map([[DOCUMENT_DELTA_KEY, { kind: "activeState", activeState: to } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetActiveStateAction", payload: { state: this.state }, timestamp: Date.now() };
    }
}
