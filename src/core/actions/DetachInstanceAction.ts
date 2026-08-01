/**
 * @module DetachInstanceAction
 * @description Bakes an instance into ordinary nodes, severing the link to its master (M6).
 *
 * The third leg of components — create, override, DETACH — and the escape hatch that makes the
 * first two safe to use: content inside an instance is otherwise only editable through the
 * override system, which deliberately reaches a limited set of fields. Detaching replaces the
 * `core.instance` node with a real copy of what it was drawing, after which every node is an
 * ordinary one with no special rules.
 *
 * "What it was drawing" is not re-derived here: each node is built by the SHARED
 * `materializeNode`, the same function `expandInstances` uses, so the overrides, the root's
 * (0,0) re-origin and its stripped constraints all come out identically. The one thing the
 * detach adds is POSITION — the instance's own geometry, which is what placed the copy on the
 * canvas — and fresh ids, since these nodes now exist in the document.
 *
 * A NESTED instance inside the master stays an instance (it is copied, not expanded), so
 * detaching the outer component does not silently detach the inner ones. The walk is therefore
 * over the master's STORED children only and can never enter another master's subtree.
 *
 * A DANGLING instance (its `componentId` resolves to nothing) is valid at rest but draws
 * nothing, so there is nothing to bake: the action refuses it rather than deleting the node
 * behind the user's back — `DeleteNodeAction` is how you remove an empty instance.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Node } from "../document/Node";
import { INSTANCE_MAX_NODES, materializeNode , masterSubtreeIds, resolveVariantMaster, VIRTUAL_ID_SEP, mergeOverrides} from "../document/Components";
import { MutationResult, ActionPayload, NodeDelta } from "./types";
import { generateUUID } from "../ids/UUID";

export class DetachInstanceAction extends Action {
    private instanceId: string;
    /** master node id → the stored id its copy took. Cached so that executing the SAME action
     *  instance twice produces the same ids — `getCreatedNodeIds()` is what the caller selects
     *  and names afterwards, and a second run minting fresh ids would strand that. (Undo/redo
     *  does NOT re-execute: it restores a document snapshot, so this is idempotence insurance
     *  for a re-dispatched action, not the redo path.) */
    private idMap: Map<string, string> | null = null;
    private createdNodeIds: string[] = [];

    constructor(document: ReadonlyDocument, instanceId: string) {
        super(document);
        this.instanceId = instanceId;
    }

    /** The master subtree in parent-before-child order, cycle-safe against a damaged document.
     *  Empty when the master does not resolve. */
    /** The master this instance is actually DRAWING — resolved through its variant selection
     *  (schema 27), not blindly `componentId`. A detach must bake what was on screen; reading
     *  `componentId` here baked the un-switched variant instead. */
    private resolvedMasterId(): string | null {
        const instance = this.document.nodes.get(this.instanceId);
        if (!instance) return null;
        const id = resolveVariantMaster(this.document, instance);
        return id !== null && this.document.nodes.has(id) ? id : null;
    }

    private masterSubtree(): string[] {
        const masterId = this.resolvedMasterId();
        // The SHARED walk, so detach and expansion cannot disagree about what the subtree is.
        return masterId === null ? [] : masterSubtreeIds(this.document, masterId);
    }

    public validate(): boolean {
        const instance = this.document.nodes.get(this.instanceId);
        if (!instance || instance.type !== "core.instance") return false;
        // A master that is the instance itself would copy the instance into its own replacement.
        if (this.resolvedMasterId() === this.instanceId) return false;
        const subtree = this.masterSubtree();
        if (subtree.length === 0) return false;            // dangling — nothing to bake
        // The instance lives INSIDE the subtree it would bake: the copies would be parented
        // within the master, so the master would permanently gain a copy of itself (plus a
        // still-live recursive instance) and EVERY other instance of it would change. Detach
        // must touch only the node being detached. This is the write-path analogue of the
        // per-path master CHAIN guard `expandInstances` uses to stop the same recursion.
        if (subtree.includes(this.instanceId)) return false;
        // Both the instance and the master root carrying a transform cannot be represented as
        // the single `Node.transform` the baked root gets: composing two rotate+scale-about-
        // origin matrices is not generally another one. Refuse rather than silently drop one.
        if (instance.transform && this.document.nodes.get(subtree[0])?.transform) return false;
        // The same OOM bound expansion obeys: a detach materializes into the DOCUMENT, where the
        // cost is permanent rather than per-frame, so the cap matters at least as much here.
        return subtree.length <= INSTANCE_MAX_NODES;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: cannot detach "${this.instanceId}".`);
        }
        const instance = this.document.nodes.get(this.instanceId)!;
        const subtree = this.masterSubtree();
        const masterRootId = subtree[0];

        // Reuse the ids across re-executions of this instance (see `idMap`).
        const idMap = this.idMap ?? new Map(subtree.map(id => [id, generateUUID()]));
        this.idMap = idMap;
        this.createdNodeIds = subtree.map(id => idMap.get(id)!);

        const deltas = new Map<string, NodeDelta>();
        for (const masterNodeId of subtree) {
            const master = this.document.nodes.get(masterNodeId)! as Node;
            const isRoot = masterNodeId === masterRootId;
            const newId = idMap.get(masterNodeId)!;
            const parent = isRoot ? (instance.parent ?? null) : idMap.get(master.parent!)!;
            const copy = materializeNode(master, instance.overrides?.[masterNodeId], isRoot, newId, parent);
            // The copies become STORED, MUTABLE nodes, so every object they hold must be their
            // own — `materializeNode` shares the master's style/layout/transform by reference
            // where no override replaced them (safe for the read-only expanded document, NOT
            // here: editing the copy would silently edit the master).
            copy.style = { ...copy.style };
            copy.layout = { ...copy.layout };
            if (copy.transform) copy.transform = { ...copy.transform };
            if (copy.overrides) copy.overrides = JSON.parse(JSON.stringify(copy.overrides));
            // A NESTED instance survives the detach as an instance node — so the outer
            // instance's PATH overrides that reached through it (schema 28) have to move onto
            // it, or they would name a path that no longer exists and the copy would silently
            // lose every edit made through it. `OI::IM` on the outer becomes `IM` on the copy
            // of `OI`; the outer's entry wins, being the more specific statement.
            if (copy.type === "core.instance") {
                const prefix = masterNodeId + VIRTUAL_ID_SEP;
                for (const [key, value] of Object.entries(instance.overrides ?? {})) {
                    if (!key.startsWith(prefix)) continue;
                    const inner = key.slice(prefix.length);
                    copy.overrides = { ...copy.overrides, [inner]: mergeOverrides(copy.overrides?.[inner], value) };
                }
            }
            if (copy.path) copy.path = copy.path.map(c => ({ ...c }));
            // The root inherits everything the INSTANCE contributed to what was on screen. In
            // the expanded document the root copy is a CHILD of the instance, so the instance's
            // own position, transform and parent-facing layout all compose into the rendered
            // result; deleting the instance without carrying them over is what made a rotated
            // instance snap upright and a constrained one jump.
            if (isRoot) {
                // Position: `materializeNode` re-origined the root to (0,0) precisely because
                // the instance carried it. Size is already the master's (plus any root override).
                copy.geometry.x = instance.geometry.x;
                copy.geometry.y = instance.geometry.y;
                // Transform: at most one of the two has one (validate() refuses both).
                if (instance.transform) copy.transform = { ...instance.transform };
                // Layout splits by who it talks to. PARENT-facing fields (how this node behaves
                // inside its parent) belong to the instance — it is the node the parent was
                // laying out. CHILD-facing fields (container/grid, how it arranges what is
                // inside it) belong to the master root, which is what actually holds the copies.
                copy.layout = {
                    ...copy.layout,
                    constraints: instance.layout.constraints,
                    constraintRef: instance.layout.constraintRef,
                    grow: instance.layout.grow,
                    shrink: instance.layout.shrink,
                    margin: instance.layout.margin,
                    position: instance.layout.position,
                    colSpan: instance.layout.colSpan,
                    rowSpan: instance.layout.rowSpan,
                    gridColumn: instance.layout.gridColumn,
                    gridRow: instance.layout.gridRow
                };
            }
            // Children are wired here (materializeNode always returns an empty list) so the
            // copies form a tree among themselves rather than pointing back at the master's.
            copy.children = master.children.filter(c => idMap.has(c)).map(c => idMap.get(c)!);
            deltas.set(newId, isRoot
                // Take the instance's place in the sibling order — appending would pop the
                // detached content to the front of the z-order.
                ? { kind: "add", node: copy, index: this.siblingIndex(instance) }
                : { kind: "add", node: copy });
        }
        // Ordered AFTER the adds so the map is parent-before-child throughout; either order
        // lands the root at the right index (the delete removes the instance from the same
        // list), but parents must exist before their children are added.
        deltas.set(this.instanceId, { kind: "delete" });

        const updatedNodeIds = new Set([...this.createdNodeIds, this.instanceId]);
        // An auto-layout parent reflows around the replacement, exactly as on a delete.
        if (instance.parent) updatedNodeIds.add(instance.parent);

        return { updatedNodeIds, propertyDeltas: deltas, success: true };
    }

    /** The instance's position among its siblings (its parent's children, or the root list). */
    private siblingIndex(instance: { parent?: string | null }): number | undefined {
        const siblings = instance.parent
            ? this.document.nodes.get(instance.parent)?.children
            : this.document.rootNodeUuids;
        const at = siblings?.indexOf(this.instanceId) ?? -1;
        return at < 0 ? undefined : at;
    }

    public serialize(): ActionPayload {
        return {
            actionId: "DetachInstanceAction",
            payload: { nodeId: this.instanceId, createdNodeIds: [...this.createdNodeIds] },
            timestamp: Date.now()
        };
    }

    /** The ids of the nodes this detach created, root FIRST (null-safe before `execute`). */
    public getCreatedNodeIds(): string[] {
        return [...this.createdNodeIds];
    }
}
