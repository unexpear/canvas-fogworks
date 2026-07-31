/**
 * @module SetInstanceOverrideAction
 * @description Sets (or clears) ONE per-instance override — the write path for M6 slice 2.
 *
 * An override lives on the INSTANCE, keyed by the MASTER NODE id it targets, so editing a copy
 * never touches the master and never materializes the copy into the document: the instance
 * stays a reference plus a small patch. Passing `null` clears the entry, which is what
 * "reset to the master" means.
 *
 * Patches MERGE field-by-field (an existing `geometry` override keeps its `x` when only `width`
 * is set), so a drag followed by a resize accumulates rather than replacing. Validation
 * delegates to the shared `overridesError`, the same rule the load path runs.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { InstanceOverride, overrideDimensionError, overridesError } from "../document/Components";
import { MutationResult, ActionPayload } from "./types";

export class SetInstanceOverrideAction extends Action {
    private instanceId: string;
    private masterNodeId: string;
    private patch: InstanceOverride | null;

    /** @param patch fields to merge into the override; `null` clears the whole entry. */
    constructor(document: ReadonlyDocument, instanceId: string, masterNodeId: string, patch: InstanceOverride | null) {
        super(document);
        this.instanceId = instanceId;
        this.masterNodeId = masterNodeId;
        this.patch = patch;
    }

    /** The instance's overrides map with this patch merged (or the entry removed). */
    private next(): Record<string, InstanceOverride> {
        const node = this.document.nodes.get(this.instanceId);
        const current: Record<string, InstanceOverride> = JSON.parse(JSON.stringify(node?.overrides ?? {}));
        if (this.patch === null) {
            delete current[this.masterNodeId];
            return current;
        }
        const existing = current[this.masterNodeId] ?? {};
        current[this.masterNodeId] = {
            ...existing,
            ...this.patch,
            // The nested maps merge too, so a move then a resize accumulate into one override.
            geometry: (this.patch.geometry || existing.geometry) ? { ...existing.geometry, ...this.patch.geometry } : undefined,
            style: (this.patch.style || existing.style) ? { ...existing.style, ...this.patch.style } : undefined
        };
        return current;
    }

    public validate(): boolean {
        const node = this.document.nodes.get(this.instanceId);
        if (!node || node.type !== "core.instance") return false;
        if (typeof this.masterNodeId !== "string" || this.masterNodeId.length === 0) return false;
        // Validate the RESULTING map with the shared load-path rules — so the edit path can never
        // author an override the loader would reject. Both halves run: the document-free field
        // rules, and the type-aware size rule that resolves each key's master (without which an
        // override could hold a size the master's own type forbids — see `overrideDimensionError`).
        const overrides = this.next();
        if (overridesError("core.instance", overrides) !== null) return false;
        return overrideDimensionError(this.document, { ...node, overrides }) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid override "${this.masterNodeId}" on instance "${this.instanceId}".`);
        }
        const overrides = this.next();
        return {
            updatedNodeIds: new Set([this.instanceId]),
            propertyDeltas: new Map([[this.instanceId, { kind: "patch", overrides } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "SetInstanceOverrideAction",
            payload: { nodeId: this.instanceId, masterNodeId: this.masterNodeId, patch: this.patch },
            timestamp: Date.now()
        };
    }
}
