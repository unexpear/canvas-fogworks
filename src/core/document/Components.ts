/**
 * @module Components
 * @description Reusable components (Milestone 6) — the pure INSTANCE RESOLUTION pass.
 *
 * A component MASTER is an ordinary node subtree living in the document (like a Figma
 * component on the canvas): no new storage, so masters reuse every existing mechanism —
 * validation, geometry, layout, serialization, actions, editing. An INSTANCE is a
 * `core.instance` node carrying `componentId` (the master node's id); it draws nothing
 * itself and has NO children in the stored document.
 *
 * `expandInstances(doc)` materializes each instance's master subtree as VIRTUAL children of
 * the instance, returning a derived document. Everything downstream — `computeGeometry`,
 * hit-testing, both render backends — then works UNCHANGED, because an expanded instance is
 * just an ordinary parent with ordinary children. The expanded document is derived and
 * never persisted, never mutated, and never reaches an Action: the dispatcher still writes
 * only the stored document.
 *
 * Virtual ids are `<instance path>::<master node id>` (`VIRTUAL_ID_SEP`), so they are stable
 * across frames, unique, and REVERSIBLE — `splitVirtualId` recovers the owning instance and
 * the master node it copies, which is what a per-child override (M6 slice 2) will key on.
 * `::` is therefore a RESERVED substring in stored node ids, rejected on both the edit and
 * load paths (`Node.RESERVED_NODE_ID` is the same discipline for a whole id).
 *
 * Recursion is the hazard this module exists to bound: a master containing an instance of
 * itself, or a cycle through several masters, would expand forever, and NESTED instances
 * multiply rather than add. Three guards, in the `GRID_MAX_TRACKS` tradition: a per-path
 * master CHAIN (a cycle stops expanding), a DEPTH cap, and a total materialized-NODE cap.
 * A stopped expansion simply draws nothing — it never throws.
 */

import { ProjectDocument, ReadonlyDocument } from "./Document";
import { Node } from "./Node";

/** Separator between an instance path and the master node id in a VIRTUAL node id.
 *  Reserved: a stored node id may not contain it (checked on the edit AND load paths). */
export const VIRTUAL_ID_SEP = "::";

/** Nesting cap: an instance of a component that contains an instance… this many levels deep. */
export const INSTANCE_MAX_DEPTH = 16;
/** Total virtual nodes one expansion may materialize — the OOM guard, since NESTED
 *  instances multiply (a 10-node master instanced 10 deep is 10¹⁰ without a cap). */
export const INSTANCE_MAX_NODES = 50_000;

/** The virtual id of `masterNodeId` copied under the instance at `instancePath`. */
export function virtualId(instancePath: string, masterNodeId: string): string {
    return `${instancePath}${VIRTUAL_ID_SEP}${masterNodeId}`;
}

/** True for a node id produced by instance expansion (never a stored id — `::` is reserved). */
export function isVirtualId(id: string): boolean {
    return id.includes(VIRTUAL_ID_SEP);
}

/**
 * Split a virtual id into the owning INSTANCE PATH and the MASTER NODE it copies, or null
 * when the id is a stored (non-virtual) one. Splits at the LAST separator, so a nested
 * expansion `i1::i2::child` yields the full instance path `i1::i2` — the id of the (itself
 * virtual) instance node that owns the copy — and the master node `child`.
 */
export function splitVirtualId(id: string): { instancePath: string; masterNodeId: string } | null {
    const at = id.lastIndexOf(VIRTUAL_ID_SEP);
    if (at < 0) return null;
    return { instancePath: id.slice(0, at), masterNodeId: id.slice(at + VIRTUAL_ID_SEP.length) };
}

/**
 * Validity of a node's `componentId`, SHARED by the load path (`Integrity`) and the edit
 * path (`CreateInstanceAction`) so the two cannot drift. Only a `core.instance` may carry
 * one; when present it must be a non-empty string. It is deliberately NOT required to
 * RESOLVE: a dangling reference stays valid at rest (the instance renders nothing), so
 * deleting a master can never corrupt a document that still instances it — the same rule
 * dangling `$token` aliases follow. Absent on an instance = an empty instance.
 */
export function componentError(type: string, componentId: unknown): string | null {
    if (componentId === undefined) return null;
    if (type !== "core.instance") return "only a core.instance node may carry a componentId";
    if (typeof componentId !== "string" || componentId.length === 0) return "componentId must be a non-empty string";
    return null;
}

/** Shallow node copy with a fresh children array + geometry (the only fields expansion
 *  rewrites). Style/layout/transform are shared by REFERENCE — the expanded document is
 *  read-only downstream, and a future override slice REPLACES rather than mutates them. */
function copyForExpansion(n: Node, id: string, parent: string, geometry: Node["geometry"]): Node {
    return { ...n, id, parent, children: [], geometry };
}

/**
 * Materialize every instance's master subtree as virtual children, returning a DERIVED
 * document. Returns the input UNCHANGED (same reference) when it contains no expandable
 * instance, so an instance-free document pays nothing.
 *
 * The materialized master ROOT is re-positioned to the instance's local origin (0,0): the
 * master's own canvas x/y belongs to the master, while the instance's stored geometry places
 * the copy. Sizes are copied as-is (per-instance resizing arrives with overrides).
 */
export function expandInstances(doc: ReadonlyDocument): ReadonlyDocument {
    // Fast path: nothing to do (the overwhelmingly common case) — no allocation at all.
    let hasInstance = false;
    doc.nodes.forEach(n => {
        if (n.type === "core.instance" && typeof n.componentId === "string" && doc.nodes.has(n.componentId)) hasInstance = true;
    });
    if (!hasInstance) return doc;

    const nodes = new Map<string, Node>();
    doc.nodes.forEach((n, id) => nodes.set(id, { ...(n as Node), children: [...n.children] }));

    let materialized = 0;

    /**
     * Copy `masterId`'s subtree under `parentId` (an instance node in the expanded map).
     * `chain` holds the master ids already being expanded on this path — re-entering one is
     * a cycle and stops. Returns false when a cap stopped the expansion.
     */
    const materialize = (
        masterId: string,
        instancePath: string,
        parentId: string,
        isRoot: boolean,
        depth: number,
        chain: ReadonlySet<string>
    ): boolean => {
        if (materialized >= INSTANCE_MAX_NODES) return false;
        const master = doc.nodes.get(masterId);
        if (!master) return true; // dangling child reference in a damaged master — skip, don't throw
        const id = virtualId(instancePath, masterId);
        const geo = isRoot
            ? { ...master.geometry, x: 0, y: 0 } // the instance's own geometry places the copy
            : { ...master.geometry };
        const copy = copyForExpansion(master as Node, id, parentId, geo);
        nodes.set(id, copy);
        nodes.get(parentId)!.children.push(id);
        materialized++;

        // A copied node that is ITSELF an instance expands one level deeper (nested components).
        if (copy.type === "core.instance" && typeof copy.componentId === "string") {
            expand(id, copy.componentId, depth + 1, chain);
        }
        for (const childId of master.children) {
            if (!materialize(childId, instancePath, id, false, depth, chain)) return false;
        }
        return true;
    };

    /** Expand ONE instance node (stored or virtual) against its master, guarded. */
    const expand = (instanceNodeId: string, masterId: string, depth: number, chain: ReadonlySet<string>): void => {
        if (depth > INSTANCE_MAX_DEPTH) return;   // nesting cap — draw nothing deeper
        if (chain.has(masterId)) return;          // cycle: this master is already on the path
        if (!doc.nodes.has(masterId)) return;     // dangling reference — valid at rest, draws nothing
        materialize(masterId, instanceNodeId, instanceNodeId, true, depth, new Set(chain).add(masterId));
    };

    // Expand the STORED instances; nested ones expand from inside `materialize`.
    doc.nodes.forEach((n, id) => {
        if (n.type === "core.instance" && typeof n.componentId === "string") {
            expand(id, n.componentId, 0, new Set<string>());
        }
    });

    const expanded: ProjectDocument = {
        version: doc.version,
        metadata: doc.metadata as ProjectDocument["metadata"],
        nodes,
        rootNodeUuids: [...doc.rootNodeUuids],
        variables: doc.variables as ProjectDocument["variables"],
        activeTheme: doc.activeTheme
    };
    return expanded;
}
