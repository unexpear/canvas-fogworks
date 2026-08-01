/**
 * @module DuplicateNodesAction
 * @description Copies the selected nodes, subtrees and all, offset slightly so the copy is
 * visible and grabbable rather than hidden exactly beneath the original.
 *
 * Only selection ROOTS are duplicated: a child already travels inside its parent's copy, so
 * duplicating both would produce it twice. Each copy is inserted directly AFTER its original in
 * the sibling order, which is where every tool puts it — a duplicate that jumped to the front
 * of the z-order would reshuffle a carefully built stack.
 *
 * Ids are freshly minted and remapped THROUGHOUT the copied subtree, so parent/children links
 * point inside the copy rather than back at the original — the same discipline
 * `DetachInstanceAction` follows when it bakes an instance.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Node } from "../document/Node";
import { isVirtualId } from "../document/Components";
import { MutationResult, ActionPayload, NodeDelta } from "./types";
import { generateUUID } from "../ids/UUID";

/** How far a duplicate lands from its original, in the parent's units. */
export const DUPLICATE_OFFSET = 10;

export class DuplicateNodesAction extends Action {
    private nodeIds: string[];
    private idMap: Map<string, string> | null = null;
    private createdRootIds: string[] = [];

    constructor(document: ReadonlyDocument, nodeIds: readonly string[]) {
        super(document);
        this.nodeIds = [...new Set(nodeIds)];
    }

    /** The selection's ROOTS — an id whose ancestor is also selected is dropped, since it is
     *  copied as part of that ancestor's subtree. */
    private roots(): string[] {
        const selected = new Set(this.nodeIds);
        return this.nodeIds.filter(id => {
            let p = this.document.nodes.get(id)?.parent ?? null;
            while (p) {
                if (selected.has(p)) return false;
                p = this.document.nodes.get(p)?.parent ?? null;
            }
            return true;
        });
    }

    /** A subtree in parent-before-child order, cycle-safe. */
    private subtree(rootId: string, seen: Set<string>): string[] {
        if (seen.has(rootId) || !this.document.nodes.has(rootId)) return [];
        seen.add(rootId);
        const out = [rootId];
        for (const childId of this.document.nodes.get(rootId)!.children) out.push(...this.subtree(childId, seen));
        return out;
    }

    public validate(): boolean {
        if (this.nodeIds.length === 0) return false;
        // A virtual id is an instance's materialized copy: it has no stored node to duplicate.
        // Duplicating the INSTANCE is the gesture that copies that content.
        if (this.nodeIds.some(id => isVirtualId(id) || !this.document.nodes.has(id))) return false;
        return this.roots().length > 0;
    }

    public execute(): MutationResult {
        if (!this.validate()) throw new Error("Validation failed: nothing to duplicate.");

        const roots = this.roots();
        const seen = new Set<string>();
        const all = roots.flatMap(r => this.subtree(r, seen));
        // Reuse the ids across re-executions of this instance, like the other creating actions.
        const idMap = this.idMap ?? new Map(all.map(id => [id, generateUUID()]));
        this.idMap = idMap;
        this.createdRootIds = roots.map(r => idMap.get(r)!);

        const deltas = new Map<string, NodeDelta>();
        const updated = new Set<string>();

        for (const originalId of all) {
            const original = this.document.nodes.get(originalId)! as Node;
            const isRoot = roots.includes(originalId);
            const newId = idMap.get(originalId)!;
            const copy: Node = {
                ...original,
                id: newId,
                parent: isRoot ? (original.parent ?? null) : idMap.get(original.parent!)!,
                // Remapped, so the copy's children are the COPIES, not the originals.
                children: original.children.filter(c => idMap.has(c)).map(c => idMap.get(c)!),
                geometry: { ...original.geometry },
                style: { ...original.style },
                layout: { ...original.layout }
            };
            // Every mutable object must be the copy's own, or editing it would reach back into
            // the original — the bug the detach slice had to fix.
            if (original.transform) copy.transform = { ...original.transform };
            if (original.overrides) copy.overrides = JSON.parse(JSON.stringify(original.overrides));
            if (original.path) copy.path = original.path.map(c => ({ ...c }));
            // Only the ROOT moves: a child's stored position is relative to its parent, which
            // moved with it, so offsetting a child too would double the shift.
            if (isRoot) {
                copy.geometry.x += DUPLICATE_OFFSET;
                copy.geometry.y += DUPLICATE_OFFSET;
            }

            if (isRoot) {
                const siblings = original.parent
                    ? (this.document.nodes.get(original.parent)?.children ?? [])
                    : this.document.rootNodeUuids;
                const at = siblings.indexOf(originalId);
                // Directly after the original, so a duplicate does not re-stack the document.
                deltas.set(newId, { kind: "add", node: copy, index: at < 0 ? undefined : at + 1 });
                if (original.parent) updated.add(original.parent);
            } else {
                deltas.set(newId, { kind: "add", node: copy });
            }
            updated.add(newId);
        }

        return { updatedNodeIds: updated, propertyDeltas: deltas, success: true };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "DuplicateNodesAction",
            payload: { nodeIds: [...this.nodeIds], createdRootIds: [...this.createdRootIds] },
            timestamp: Date.now()
        };
    }

    /** The ids of the duplicated ROOTS — what a caller should select afterwards. */
    public getCreatedRootIds(): string[] {
        return [...this.createdRootIds];
    }
}
