/**
 * @module VariantActions
 * @description The two write paths for variants (schema 27): tagging a MASTER, choosing on an
 * INSTANCE.
 *
 * A variant set has no object of its own — it is just the masters that name it. So "create a
 * set" is not an operation: you tag a node with `{ set, values }` and the set exists, exactly
 * as tagging a node as a master was never an operation either. That keeps sets from needing
 * their own lifecycle, their own integrity rules, or their own thing to leak when a node is
 * deleted; a set with no members simply stops being mentioned.
 *
 * Both actions validate through the SAME `variantError` / `variantSelectionError` the load path
 * runs, so neither can author something a reload would refuse.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { VariantKey, variantError, variantSelectionError } from "../document/Node";
import { InstanceOverride, remapOverridesForVariant, resolveVariantMaster } from "../document/Components";
import { MutationResult, ActionPayload } from "./types";

/** Tag a node as a member of a variant set, or (with `null`) remove it from one. */
export class SetVariantAction extends Action {
    private nodeId: string;
    private variant: VariantKey | null;

    constructor(document: ReadonlyDocument, nodeId: string, variant: VariantKey | null) {
        super(document);
        this.nodeId = nodeId;
        this.variant = variant;
    }

    public validate(): boolean {
        if (!this.document.nodes.has(this.nodeId)) return false;
        return variantError(this.variant ?? undefined) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid variant for node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", variant: this.variant ?? undefined } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "SetVariantAction",
            payload: { nodeId: this.nodeId, variant: this.variant },
            timestamp: Date.now()
        };
    }
}

/**
 * Choose ONE variant property on an instance — the switch a picker drives.
 *
 * The selection MERGES, so choosing `size` does not forget the `state` chosen a moment ago.
 * Passing `null` for a value clears that property, which means "go back to whatever the master
 * I point at says" — the selection is sparse by design, and an empty one is simply absent.
 */
export class SetInstanceVariantAction extends Action {
    private instanceId: string;
    private property: string;
    private value: string | null;

    constructor(document: ReadonlyDocument, instanceId: string, property: string, value: string | null) {
        super(document);
        this.instanceId = instanceId;
        this.property = property;
        this.value = value;
    }

    /** The instance's selection with this property set or removed. */
    private next(): Record<string, string> | undefined {
        const node = this.document.nodes.get(this.instanceId);
        const current: Record<string, string> = { ...(node?.variants ?? {}) };
        if (this.value === null) delete current[this.property];
        else current[this.property] = this.value;
        // An empty selection is ABSENT, not `{}` — otherwise a document grows an empty map per
        // instance that was ever switched and back, and two equal documents stop comparing equal.
        return Object.keys(current).length === 0 ? undefined : current;
    }

    public validate(): boolean {
        const node = this.document.nodes.get(this.instanceId);
        if (!node || node.type !== "core.instance") return false;
        if (typeof this.property !== "string" || this.property.length === 0) return false;
        return variantSelectionError("core.instance", this.next()) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid variant selection "${this.property}" on instance "${this.instanceId}".`);
        }
        const node = this.document.nodes.get(this.instanceId)!;
        const variants = this.next();
        const before = resolveVariantMaster(this.document, node);
        const after = resolveVariantMaster(this.document, { ...node, variants });

        const delta: {
            kind: "patch";
            variants?: Record<string, string>;
            geometry?: { width: number; height: number };
            overrides?: Record<string, InstanceOverride>;
        } = { kind: "patch", variants };

        if (before !== null && after !== null && before !== after) {
            const from = this.document.nodes.get(before);
            const to = this.document.nodes.get(after);
            if (from && to) {
                // RESIZE to the new variant, but only if the instance is still the size the old
                // variant made it. A box that has been deliberately resized is a decision, and
                // switching `state=hover` is not a request to throw it away — so the two cases
                // are distinguished rather than one of them being picked for everybody.
                if (node.geometry.width === from.geometry.width && node.geometry.height === from.geometry.height) {
                    delta.geometry = { width: to.geometry.width, height: to.geometry.height };
                }
                // CARRY the overrides across. They are keyed by master node id and each variant
                // is a different node, so without this every edit made to the copy is silently
                // dropped the moment someone switches.
                const remapped = remapOverridesForVariant(this.document, node.overrides as Record<string, InstanceOverride> | undefined, before, after);
                if (remapped) delta.overrides = remapped;
            }
        }

        return {
            updatedNodeIds: new Set([this.instanceId]),
            propertyDeltas: new Map([[this.instanceId, delta]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "SetInstanceVariantAction",
            payload: { nodeId: this.instanceId, property: this.property, value: this.value },
            timestamp: Date.now()
        };
    }
}
