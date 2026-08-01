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
 * A stopped expansion never throws: the chain and depth guards stop BEFORE materializing (that
 * branch draws nothing), while the node cap stops mid-walk and leaves a TRUNCATED but
 * structurally consistent tree — a node that trips the cap is added neither to the map nor to
 * its parent's `children`, so no dangling reference is ever produced.
 */

import { ProjectDocument, ReadonlyDocument } from "./Document";
import { dimensionError, Geometry, Layout, layoutError, mergeLayout, Node, Style, styleError, srcValueError, Transform, transformError } from "./Node";
import { ReadonlyNode } from "./SceneGraph";

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
/**
 * The STORED instance a virtual node ultimately belongs to — the FIRST path segment (nested
 * copies like `i1::i2::child` all belong to the stored instance `i1`). Null for a stored id.
 * Consumers that reason about a node's stored OWNER use this: an instance's materialized
 * copies travel with it, so e.g. snapping must not treat them as external targets.
 */
export function ownerInstanceOf(id: string): string | null {
    const at = id.indexOf(VIRTUAL_ID_SEP);
    return at < 0 ? null : id.slice(0, at);
}

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

/**
 * A per-instance OVERRIDE (M6 slice 2): what THIS instance changes about one node of its
 * master subtree. Stored on the instance under `Node.overrides`, keyed by the MASTER NODE ID,
 * so an override survives the master being edited (it targets identity, not position) and is
 * naturally undone when the master node disappears (the key simply never matches).
 *
 * The scope is the fields a user edits on a copy: position/size, appearance, content, and — as
 * of schema 26 — how it lays its children out and how it is transformed. Layout and transform
 * looked like they needed special machinery and turned out not to: expansion runs BEFORE
 * `computeGeometry`, so an overridden layout is simply the layout the engine measures, and a
 * root copy is a CHILD of its instance node, so an overridden transform composes through the
 * ordinary parent chain like any other.
 */
export interface InstanceOverride {
    geometry?: Partial<Geometry>;
    style?: Partial<Style>;
    text?: string;
    src?: string;
    layout?: Partial<Layout>;
    transform?: Partial<Transform>;
}

/** Overrides one instance may carry — an OOM guard on a hand-editable map, like `VARIABLES_MAX`. */
export const INSTANCE_MAX_OVERRIDES = 10_000;

const OVERRIDE_FIELDS = new Set(["geometry", "style", "text", "src", "layout", "transform"]);
const GEOMETRY_FIELDS = new Set(["x", "y", "width", "height"]);

function isPlain(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validity of a node's `overrides`, SHARED by the load path (`Integrity`) and the edit path
 * (`SetInstanceOverrideAction`) so the two cannot drift. Only a `core.instance` may carry them.
 * Keys are master node ids (non-empty, capped, and — like stored ids — free of the virtual-id
 * separator). Each value may only carry the known fields, and each field is validated by the
 * SAME rule its stored counterpart uses (`styleError`, finite geometry numbers), so an override
 * can never smuggle in a value the node itself could not hold. A key that matches NO master
 * node is deliberately allowed: it is inert, exactly like a dangling `componentId` or `$token`.
 */
export function overridesError(type: string, overrides: unknown): string | null {
    if (overrides === undefined) return null;
    if (type !== "core.instance") return "only a core.instance node may carry overrides";
    if (!isPlain(overrides)) return "overrides must be an object";
    const entries = Object.entries(overrides);
    if (entries.length > INSTANCE_MAX_OVERRIDES) return `overrides must have at most ${INSTANCE_MAX_OVERRIDES} entries`;
    for (const [key, value] of entries) {
        if (key.length === 0) return "override key must be non-empty";
        if (key.length > 200) return "override key must be at most 200 characters";
        if (key.includes(VIRTUAL_ID_SEP)) return `override key "${key}" must not contain "${VIRTUAL_ID_SEP}"`;
        if (!isPlain(value)) return `override "${key}" must be an object`;
        for (const field of Object.keys(value)) {
            if (!OVERRIDE_FIELDS.has(field)) return `override "${key}" has an unknown field "${field}"`;
        }
        const o = value as InstanceOverride;
        if (o.geometry !== undefined) {
            if (!isPlain(o.geometry)) return `override "${key}" geometry must be an object`;
            for (const [f, v] of Object.entries(o.geometry)) {
                if (!GEOMETRY_FIELDS.has(f)) return `override "${key}" geometry has an unknown field "${f}"`;
                if (typeof v !== "number" || !Number.isFinite(v)) return `override "${key}" geometry.${f} must be a finite number`;
            }
            // Sizes obey the same floor a STORED node's do. The per-TYPE rule (`dimensionError`)
            // can't run here — the override is keyed by master node id and validated without the
            // document, so the master's type is unknown — but a negative size is invalid for every
            // type, so reject that much rather than let an override hold what no node could. The
            // type-aware half runs in `overrideDimensionError`, which callers holding the document
            // add on top; both paths run it, so neither side of the seam validates less.
            const { width, height } = o.geometry as { width?: number; height?: number };
            if (width !== undefined && width < 0) return `override "${key}" geometry.width must be >= 0`;
            if (height !== undefined && height < 0) return `override "${key}" geometry.height must be >= 0`;
        }
        if (o.style !== undefined) {
            if (!isPlain(o.style)) return `override "${key}" style must be an object`;
            const e = styleError(o.style);           // the SAME rule a stored style obeys
            if (e) return `override "${key}" ${e}`;
        }
        if (o.text !== undefined && typeof o.text !== "string") return `override "${key}" text must be a string`;
        if (o.src !== undefined) {
            // The SAME rule a stored src obeys, minus the part that needs the master's type
            // (see `overrideAgainstMasterError`). Validating this as merely "a string" let an
            // override hold a source no node may hold, which a detach then baked into the
            // document as a stored node — producing a file the loader refuses.
            const e = srcValueError(o.src);
            if (e) return `override "${key}" ${e}`;
        }
        // Layout and transform go through the SAME validators their stored counterparts use,
        // so an override cannot hold a layout or transform the node itself could not — the
        // rule that keeps a detach (which bakes overrides into stored nodes) loadable.
        if (o.layout !== undefined) {
            if (!isPlain(o.layout)) return `override "${key}" layout must be an object`;
            const e = layoutError(o.layout);
            if (e) return `override "${key}" ${e}`;
        }
        if (o.transform !== undefined) {
            if (!isPlain(o.transform)) return `override "${key}" transform must be an object`;
            const e = transformError(o.transform);
            if (e) return `override "${key}" ${e}`;
        }
    }
    return null;
}

/**
 * The TYPE-AWARE half of override validation, for callers that hold the document: an override
 * whose key resolves to a master node must produce a size that master's own type accepts —
 * the SAME `dimensionError` a stored geometry edit obeys. `overridesError` cannot do this (it
 * validates a bare map, with no way to learn the master's type), so without this the routing
 * seam would validate LESS on the override side: `{width: 0}` refused on a stored rectangle
 * but accepted on its copy, materializing a zero-width rect no document could store.
 *
 * Run by the load path (`Integrity`) and the edit path (`SetInstanceOverrideAction`) alike, so
 * the two cannot drift. A key resolving to nothing is skipped — a dangling override stays inert
 * and loadable, exactly like a dangling `componentId` or `$token`. A partial size override is
 * checked against the master's OTHER axis, since that is what expansion will materialize.
 */
export function overrideAgainstMasterError(doc: ReadonlyDocument, instance: ReadonlyNode): string | null {
    if (!instance.overrides) return null;
    for (const key of Object.keys(instance.overrides)) {
        const o = instance.overrides[key];
        const master = doc.nodes.get(key);
        if (!master) continue;   // dangling key — inert, like a dangling componentId
        const g = o.geometry;
        if (g && (g.width !== undefined || g.height !== undefined)) {
            const err = dimensionError(master.type, g.width ?? master.geometry.width, g.height ?? master.geometry.height);
            if (err) return `override "${key}" ${err}`;
        }
        // Only an image may carry a source — the half of `srcError` that needs the type. An
        // override on any other master node would materialize a copy holding a field its own
        // type forbids, which `DetachInstanceAction` then bakes into a stored node.
        if (o.src !== undefined && master.type !== "core.image") {
            return `override "${key}" only a core.image node may carry a src`;
        }
    }
    return null;
}

/**
 * ONE node of a master subtree, as a given instance renders it: the master's data with that
 * instance's override applied, and — for the subtree ROOT — the two rules the root obeys
 * (re-origined to (0,0), because the INSTANCE's geometry places it; constraints stripped,
 * because they describe a parent the copy no longer has).
 *
 * SHARED by `expandInstances`, which materializes it as a VIRTUAL node, and
 * `DetachInstanceAction`, which materializes it as a STORED one — so what a detach bakes
 * into the document is exactly what the instance was drawing, and the two cannot drift.
 * The returned node always has an EMPTY `children`; the caller wires the tree.
 *
 * Style/layout/transform are shared by REFERENCE when no override touches them — the expanded
 * document is read-only downstream, and an override REPLACES rather than mutates. A detach,
 * which produces MUTABLE stored nodes, clones them (see `DetachInstanceAction`).
 */
export function materializeNode(
    master: Node,
    override: InstanceOverride | undefined,
    isRoot: boolean,
    id: string,
    parent: string | null
): Node {
    const geometry = isRoot
        ? { ...master.geometry, ...override?.geometry, x: 0, y: 0 } // the INSTANCE places the root copy
        : { ...master.geometry, ...override?.geometry };
    const copy: Node = { ...master, id, parent, children: [], geometry };
    if (override) {
        if (override.style) copy.style = { ...master.style, ...override.style };
        if (override.text !== undefined) copy.text = override.text;
        if (override.src !== undefined) copy.src = override.src;
        // `mergeLayout`, not a spread: a master with `container` and an override with `grid`
        // would otherwise produce a node carrying both, which no loader accepts.
        if (override.layout) copy.layout = mergeLayout(master.layout, override.layout);
        if (override.transform) copy.transform = { ...master.transform, ...override.transform };
    }
    // The ROOT copy's CONSTRAINTS (and their frozen `constraintRef`) describe the master's
    // relationship to ITS parent, which the copy no longer has — leaving them would let
    // `resolveConstraints` reposition the copy against the instance's box and override the
    // (0,0) re-origin above. Deeper copies keep theirs: their parent IS a faithful copy, so
    // the relationship still holds. (An anchor-to-the-instance affordance is a later slice.)
    if (isRoot && (copy.layout.constraints || copy.layout.constraintRef)) {
        copy.layout = { ...copy.layout, constraints: undefined, constraintRef: undefined };
    }
    return copy;
}

/**
 * Materialize every instance's master subtree as virtual children, returning a DERIVED
 * document. Returns the input UNCHANGED (same reference) when it contains no expandable
 * instance, so an instance-free document pays nothing.
 *
 * The materialized master ROOT is re-positioned to the instance's local origin (0,0): the
 * master's own canvas x/y belongs to the master, while the instance's stored geometry places
 * the copy. (A root override may resize it, but not move it — its position IS the instance's.)
 *
 * Each expansion level applies the OVERRIDES of the instance node driving it, keyed by master
 * node id — so a stored instance overrides its own master's nodes, and a NESTED instance
 * applies the overrides it carries from the master. Overriding THROUGH a nested instance (an
 * outer instance changing a node inside an inner one) is a documented deferral.
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
        // This instance's OVERRIDE for this master node, if any (slice 2). The driving instance
        // node is `parentId` for a root copy and the same instance for deeper ones — either way
        // it is `instancePath`, whose entry in the working map carries the overrides (a stored
        // instance's own, or, for a NESTED instance, the ones copied from the master).
        const override = nodes.get(instancePath)?.overrides?.[masterId];
        // The one materialization rule, shared with DetachInstanceAction so a detach bakes
        // exactly what expansion was drawing.
        const copy = materializeNode(master as Node, override, isRoot, id, parentId);
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
