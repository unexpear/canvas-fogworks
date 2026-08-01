/**
 * @module SlotActions
 * @description The two write paths for slots (schema 29): naming one, and filling one.
 *
 * A slot is a named hole in a master that an instance fills with content of its own. Like a
 * variant set, it needs no object of its own: naming a node makes it a slot, and clearing the
 * name unmakes it. The filled content is a REFERENCE to a node that goes on living where it is,
 * exactly as `componentId` references a master — nothing is moved, so nothing has to be moved
 * back when the fill is cleared.
 *
 * Both actions validate through the SAME `slotError` / `slotContentError` the load path runs.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { slotError, slotContentError } from "../document/Node";
import { MutationResult, ActionPayload } from "./types";

/** Name a node as a slot, or (with `null`) stop it being one. */
export class SetSlotAction extends Action {
    private nodeId: string;
    private slot: string | null;

    constructor(document: ReadonlyDocument, nodeId: string, slot: string | null) {
        super(document);
        this.nodeId = nodeId;
        this.slot = slot;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        return slotError(this.slot ?? undefined) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid slot name for node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", slot: this.slot ?? undefined } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "SetSlotAction", payload: { nodeId: this.nodeId, slot: this.slot }, timestamp: Date.now() };
    }
}

/**
 * Put a node in ONE of an instance's slots, or (with `null`) empty it.
 *
 * Fills MERGE, so choosing content for `header` does not forget what is in `body`. An emptied
 * map is stored as ABSENT rather than `{}`, the same rule the variant selection follows — two
 * equal documents must compare equal.
 */
export class SetSlotContentAction extends Action {
    private instanceId: string;
    private slot: string;
    private nodeId: string | null;

    constructor(document: ReadonlyDocument, instanceId: string, slot: string, nodeId: string | null) {
        super(document);
        this.instanceId = instanceId;
        this.slot = slot;
        this.nodeId = nodeId;
    }

    private next(): Record<string, string> | undefined {
        const node = this.document.nodes.get(this.instanceId);
        const current: Record<string, string> = { ...(node?.slotContent ?? {}) };
        if (this.nodeId === null) delete current[this.slot];
        else current[this.slot] = this.nodeId;
        return Object.keys(current).length === 0 ? undefined : current;
    }

    public validate(): boolean {
        const node = this.document.nodes.get(this.instanceId);
        if (!node || node.type !== "core.instance") return false;
        if (typeof this.slot !== "string" || this.slot.length === 0) return false;
        // Filling a slot with the instance ITSELF is the one fill that can never draw: expansion
        // would re-enter the instance and the chain guard would stop it, leaving an empty slot
        // and no explanation. Refuse it at the edit path instead of rendering a mystery.
        if (this.nodeId === this.instanceId) return false;
        return slotContentError("core.instance", this.next()) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: cannot put "${this.nodeId}" in slot "${this.slot}" of "${this.instanceId}".`);
        }
        return {
            updatedNodeIds: new Set([this.instanceId]),
            propertyDeltas: new Map([[this.instanceId, { kind: "patch", slotContent: this.next() } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "SetSlotContentAction",
            payload: { nodeId: this.instanceId, slot: this.slot, contentId: this.nodeId },
            timestamp: Date.now()
        };
    }
}
