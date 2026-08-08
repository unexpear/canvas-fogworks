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

import { applyIk } from "./Rig";
import { ProjectDocument, ReadonlyDocument } from "./Document";
import { dimensionError, Geometry, Layout, layoutError, mergeLayout, Node, slotContentError, STATES_MAX, Style, styleError, srcValueError, Transform, transformError, variantNameError } from "./Node";
import { ReadonlyNode } from "./SceneGraph";
import { PathCommand, SourceRect, sourceRectError } from "./Node";
import { Mat2D, compose, localMatrix } from "../geometry/Matrix";
import { flattenPath, hitShapeOf } from "../geometry/ShapeHit";
import { shapeToCommands, transformCommands } from "../geometry/ShapeToPath";
import { resolveBooleanPaths } from "../geometry/Resolve";
import { normalizePathNode } from "../geometry/PathBuilder";
import { applyFrame } from "./Timeline";
import { isFlatMesh, isIdentityMesh, warpCommands, skinMesh, ReadonlyMesh } from "./Mesh";

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
 * Every master belonging to `set`, in a deterministic order (schema 27).
 *
 * Sorted by ID rather than taken in document order: a set's members are found by a scan, and
 * `Map` iteration order is insertion order, which would make "which variant matches" depend on
 * the order nodes happened to be added — stable within a session, but not across a save and
 * reload, and the whole engine is built on the same input giving the same output.
 */
/**
 * A master's subtree in document order, cycle-safe. Shared by expansion's consumers and by
 * `DetachInstanceAction`, which must walk exactly the tree that was drawn.
 */
export function masterSubtreeIds(doc: ReadonlyDocument, masterId: string): string[] {
    if (!doc.nodes.has(masterId)) return [];
    const order: string[] = [];
    const visited = new Set<string>();
    const walk = (id: string): void => {
        if (visited.has(id) || !doc.nodes.has(id)) return;
        visited.add(id);
        order.push(id);
        for (const childId of doc.nodes.get(id)!.children) walk(childId);
    };
    walk(masterId);
    return order;
}

/**
 * Carry an instance's OVERRIDES across a variant switch (schema 27).
 *
 * Overrides are keyed by master node id, and each variant is a different node — so without
 * this, switching silently drops every change made to a copy. Keys are re-pointed at the
 * corresponding node of the new master: the ROOT structurally (it is the root either way), and
 * everything else by NAME, but only when that name is unambiguous in BOTH subtrees. A guess
 * between two same-named nodes would move someone's edit onto the wrong element, which is worse
 * than not moving it.
 *
 * An entry that cannot be matched is KEPT, not dropped. It is inert against the new master —
 * the same dangling-key rule everything else here follows — and comes back to life if you
 * switch back, so a round trip through a variant loses nothing.
 */
export function remapOverridesForVariant(
    doc: ReadonlyDocument,
    overrides: Record<string, InstanceOverride> | undefined,
    fromMasterId: string,
    toMasterId: string
): Record<string, InstanceOverride> | undefined {
    if (!overrides || fromMasterId === toMasterId) return overrides;

    /** name → id, only for names that appear exactly ONCE in the subtree. */
    const uniqueNames = (rootId: string): Map<string, string> => {
        const seen = new Map<string, string>();
        const dupes = new Set<string>();
        for (const id of masterSubtreeIds(doc, rootId)) {
            const name = doc.nodes.get(id)!.name;
            if (typeof name !== "string" || name.length === 0) continue;
            if (seen.has(name)) dupes.add(name); else seen.set(name, id);
        }
        for (const d of dupes) seen.delete(d);
        return seen;
    };

    const fromNames = uniqueNames(fromMasterId);
    const toNames = uniqueNames(toMasterId);
    const fromIdToName = new Map<string, string>();
    fromNames.forEach((id, name) => fromIdToName.set(id, name));

    const next: Record<string, InstanceOverride> = {};
    for (const [key, value] of Object.entries(overrides)) {
        if (key === fromMasterId) { next[toMasterId] = value; continue; }   // root → root
        const name = fromIdToName.get(key);
        const target = name !== undefined ? toNames.get(name) : undefined;
        next[target ?? key] = value;                                        // unmatched stays put
    }
    return next;
}

/** Whether an instance resolves to a master that exists — the expansion fast path's question,
 *  asked THROUGH the variant selection so a switched instance is never skipped. */
function hasResolvableMaster(doc: ReadonlyDocument, n: ReadonlyNode): boolean {
    const id = resolveVariantMaster(doc, n as { componentId?: string; variants?: Record<string, string> });
    return id !== null && doc.nodes.has(id);
}

export function variantMembers(doc: ReadonlyDocument, set: string): string[] {
    const ids: string[] = [];
    doc.nodes.forEach((n, id) => { if (n.variant?.set === set) ids.push(id); });
    return ids.sort();
}

/** Every property name a set defines, with the values each one takes — what a picker offers. */
export function variantProperties(doc: ReadonlyDocument, set: string): Record<string, string[]> {
    const props: Record<string, Set<string>> = {};
    for (const id of variantMembers(doc, set)) {
        const values = doc.nodes.get(id)!.variant!.values;
        for (const [k, v] of Object.entries(values)) (props[k] ??= new Set()).add(v);
    }
    const out: Record<string, string[]> = {};
    for (const k of Object.keys(props).sort()) out[k] = [...props[k]].sort();
    return out;
}

/**
 * The master an instance should actually expand — the heart of variants (schema 27).
 *
 * The instance points at ONE master via `componentId`; its `variants` selection says which
 * properties it wants DIFFERENT from that master. Merging the two gives the full set of values
 * being asked for, and the member of the set carrying exactly those values is what gets drawn.
 *
 * TOTAL by construction, because every failure has an obvious "draw what you pointed at"
 * answer: not a variant, no set member matches, a property naming something the set never
 * defines. This is the same rule a dangling `componentId` or `$token` follows — a document that
 * cannot resolve something stays valid and renders the nearest honest thing, rather than
 * throwing in the middle of a render pass.
 */
export function resolveVariantMaster(doc: ReadonlyDocument, instance: { componentId?: string; variants?: Record<string, string> }): string | null {
    const base = instance.componentId;
    if (typeof base !== "string") return null;
    const master = doc.nodes.get(base);
    if (!master?.variant) return base;                    // not part of a set — nothing to switch
    if (!instance.variants || Object.keys(instance.variants).length === 0) return base;

    const wanted = { ...master.variant.values, ...instance.variants };
    const keys = Object.keys(wanted);
    for (const id of variantMembers(doc, master.variant.set)) {
        const values = doc.nodes.get(id)!.variant!.values;
        // An EXACT match on every property, both ways — a member defining fewer properties than
        // were asked for is not the thing that was asked for.
        if (Object.keys(values).length !== keys.length) continue;
        if (keys.every(k => values[k] === wanted[k])) return id;
    }
    return base;                                          // nothing matches — draw what was pointed at
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
    /**
     * The image's SOURCE REGION (schema 52).
     *
     * Here rather than only on the node because `StateDefinition` IS this interface — so one
     * addition makes a region keyframable, state-able and instance-overridable at once. That is
     * what makes SPRITE-SHEET PLAYBACK possible: a walk cycle is one image and a keyframe per
     * cell, which is exactly how every 2D engine plays one.
     */
    sourceRect?: SourceRect;
    layout?: Partial<Layout>;
    transform?: Partial<Transform>;
    /** What this instance puts in the copy's slots (schema 29). Overriding it on a NESTED
     *  instance is how an outer instance fills a slot it does not directly own. */
    slotContent?: Record<string, string>;
}

/** Overrides one instance may carry — an OOM guard on a hand-editable map, like `VARIABLES_MAX`. */
export const INSTANCE_MAX_OVERRIDES = 10_000;

const OVERRIDE_FIELDS = new Set(["geometry", "style", "text", "src", "sourceRect", "layout", "transform", "slotContent"]);
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
/**
 * The per-VALUE half of override validation — what one `InstanceOverride` may hold.
 *
 * Extracted so STATES (schema 30) obey exactly the same rules: a state is the same shape of
 * statement about a node ("in this context, these fields differ"), and two copies of these
 * rules would drift the first time a field is added — which is precisely how `mergeOverrides`
 * silently lost `layout` for a schema.
 *
 * `label` prefixes every message, so the caller decides whether this reads as an override or
 * a state.
 */
export function overrideValueError(label: string, value: unknown): string | null {
    if (!isPlain(value)) return `${label} must be an object`;
    for (const field of Object.keys(value)) {
        if (!OVERRIDE_FIELDS.has(field)) return `${label} has an unknown field "${field}"`;
    }
    const o = value as InstanceOverride;
    if (o.geometry !== undefined) {
        if (!isPlain(o.geometry)) return `${label} geometry must be an object`;
        for (const [f, v] of Object.entries(o.geometry)) {
            if (!GEOMETRY_FIELDS.has(f)) return `${label} geometry has an unknown field "${f}"`;
            if (typeof v !== "number" || !Number.isFinite(v)) return `${label} geometry.${f} must be a finite number`;
        }
        // Sizes obey the same floor a STORED node's do. The per-TYPE rule (`dimensionError`)
        // cannot run here — this validates a bare value with no document to resolve a type
        // against — but a negative size is invalid for EVERY type, so reject that much rather
        // than let it hold what no node could. The type-aware half runs in
        // `overrideAgainstMasterError`, which callers holding the document add on top.
        const { width, height } = o.geometry as { width?: number; height?: number };
        if (width !== undefined && width < 0) return `${label} geometry.width must be >= 0`;
        if (height !== undefined && height < 0) return `${label} geometry.height must be >= 0`;
    }
    // Every remaining field goes through the SAME validator its stored counterpart uses, so
    // this can never hold a value the node itself could not — the rule that keeps a detach
    // (which bakes overrides into stored nodes) loadable.
    // THE SAME shared validator the stored field uses, so a keyframe cannot hold a region the
    // node itself could not — the rule that keeps a detach (which bakes overrides into stored
    // nodes) loadable.
    if (o.sourceRect !== undefined) {
        const bad = sourceRectError(o.sourceRect);
        if (bad) return `${label} ${bad}`;
    }
    if (o.style !== undefined) {
        if (!isPlain(o.style)) return `${label} style must be an object`;
        const e = styleError(o.style);
        if (e) return `${label} ${e}`;
    }
    if (o.text !== undefined && typeof o.text !== "string") return `${label} text must be a string`;
    if (o.src !== undefined) {
        const e = srcValueError(o.src);
        if (e) return `${label} ${e}`;
    }
    if (o.layout !== undefined) {
        if (!isPlain(o.layout)) return `${label} layout must be an object`;
        const e = layoutError(o.layout);
        if (e) return `${label} ${e}`;
    }
    if (o.transform !== undefined) {
        if (!isPlain(o.transform)) return `${label} transform must be an object`;
        const e = transformError(o.transform);
        if (e) return `${label} ${e}`;
    }
    if (o.slotContent !== undefined) {
        const e = slotContentError("core.instance", o.slotContent);
        if (e) return `${label} ${e}`;
    }
    return null;
}



/**
 * Validity of a node's `states` (Milestone 7, schema 30), SHARED by the load path
 * (`Integrity`) and the edit path (`SetNodeStateAction`).
 *
 * ANY node may carry states — this is not an instance feature. A state nobody activates simply
 * never shows, the same way an unfilled slot draws its default, so nothing here has to resolve.
 * It lives beside `overrideValueError` because that is the rule it reuses: a state and an
 * override are the same shape of statement about a node.
 */
export function statesError(states: unknown): string | null {
    if (states === undefined) return null;
    if (!isPlain(states)) return "states must be an object";
    const entries = Object.entries(states);
    if (entries.length > STATES_MAX) return `states must have at most ${STATES_MAX} entries`;
    for (const [name, value] of entries) {
        const ne = variantNameError("state name", name, true);
        if (ne) return ne;
        const ve = overrideValueError(`state "${name}"`, value);
        if (ve) return ve;
    }
    return null;
}

export function overridesError(type: string, overrides: unknown): string | null {
    if (overrides === undefined) return null;
    if (type !== "core.instance") return "only a core.instance node may carry overrides";
    if (!isPlain(overrides)) return "overrides must be an object";
    const entries = Object.entries(overrides);
    if (entries.length > INSTANCE_MAX_OVERRIDES) return `overrides must have at most ${INSTANCE_MAX_OVERRIDES} entries`;
    for (const [key, value] of entries) {
        if (key.length === 0) return "override key must be non-empty";
        if (key.length > 200) return "override key must be at most 200 characters";
        // A key is a PATH of master node ids (schema 28): `MC` targets a node of this
        // instance's own master, `OI::IM` a node inside the expansion of the nested instance
        // `OI`. Each SEGMENT is a stored node id, so each must be non-empty — a key like
        // `A::` or `::B` names nothing and would silently never match.
        if (key.split(VIRTUAL_ID_SEP).some(seg => seg.length === 0)) {
            return `override key "${key}" has an empty path segment`;
        }
        const ve = overrideValueError(`override "${key}"`, value);
        if (ve) return ve;
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
        const master = resolveOverridePath(doc, instance, key);
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
 * The MASTER NODE an override key targets, walking a nested path (schema 28), or null when the
 * key resolves to nothing — which is inert, not invalid.
 *
 * `MC` is a node of this instance's own master. `OI::IM` reads "inside the copy of the nested
 * instance `OI`, the node `IM`": each segment after the first is looked up in the master of the
 * instance the previous segment named, which is exactly the walk expansion performs. Anything
 * that is not an instance, or has no master, ends the walk — a path cannot point at a node that
 * the drawing never produces.
 */
export function resolveOverridePath(doc: ReadonlyDocument, instance: { componentId?: string; variants?: Record<string, string> }, key: string): Node | null {
    const segments = key.split(VIRTUAL_ID_SEP);
    let scope = resolveVariantMaster(doc, instance);          // the master this instance draws
    let node: Node | null = null;
    for (const segment of segments) {
        if (scope === null) return null;
        // A segment must name a node INSIDE the scope's subtree, or the path is meaningless.
        if (!masterSubtreeIds(doc, scope).includes(segment)) return null;
        node = (doc.nodes.get(segment) ?? null) as Node | null;
        if (!node) return null;
        // Descend: the next segment lives inside THIS node's own expansion, so it must be an
        // instance — and its master is resolved through ITS variant selection, like any other.
        scope = node.type === "core.instance" ? resolveVariantMaster(doc, node) : null;
    }
    return node;
}

/**
 * Merge one override PATCH over another, field by field — the patch wins.
 *
 * Shared by `SetInstanceOverrideAction` (accumulating a drag then a resize into one entry) and
 * by expansion (an outer instance's path override layered over the one a nested instance
 * carries from its master). The nested maps merge too, so setting `width` never drops an
 * `x` that a previous edit put there.
 */
export function mergeOverrides(base: InstanceOverride | undefined, patch: InstanceOverride): InstanceOverride {
    const b = base ?? {};
    return {
        ...b,
        ...patch,
        geometry: (patch.geometry || b.geometry) ? { ...b.geometry, ...patch.geometry } : undefined,
        style: (patch.style || b.style) ? { ...b.style, ...patch.style } : undefined,
        layout: (patch.layout || b.layout) ? { ...b.layout, ...patch.layout } : undefined,
        transform: (patch.transform || b.transform) ? { ...b.transform, ...patch.transform } : undefined,
        slotContent: (patch.slotContent || b.slotContent) ? { ...b.slotContent, ...patch.slotContent } : undefined
    };
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
        if (override.sourceRect !== undefined) copy.sourceRect = override.sourceRect;
        // `mergeLayout`, not a spread: a master with `container` and an override with `grid`
        // would otherwise produce a node carrying both, which no loader accepts.
        if (override.layout) copy.layout = mergeLayout(master.layout, override.layout);
        if (override.transform) copy.transform = { ...master.transform, ...override.transform };
        // Slot fills MERGE, so an outer instance can fill one slot without clearing the ones
        // the master's own instance already filled.
        if (override.slotContent) copy.slotContent = { ...master.slotContent, ...override.slotContent };
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
        if (n.type === "core.instance" && hasResolvableMaster(doc, n)) hasInstance = true;
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
        // Two overrides can speak about this copy, and both must be heard (schema 28):
        //   · the DRIVING instance's own entry, keyed by master node id — for a stored instance
        //     its own, for a nested one the entries it carried from the master;
        //   · the OWNER (stored) instance's entry keyed by the PATH from itself down to here,
        //     which is what lets an outer instance reach inside a nested one at all.
        // The outer one wins: it is the more specific statement about this particular copy,
        // made about this instance rather than inherited by every instance of the master.
        const own = nodes.get(instancePath)?.overrides?.[masterId];
        const ownerId = ownerInstanceOf(id) ?? instancePath;
        const outer = ownerId === instancePath
            ? undefined
            : doc.nodes.get(ownerId)?.overrides?.[id.slice(ownerId.length + VIRTUAL_ID_SEP.length)];
        const override = outer ? mergeOverrides(own, outer as InstanceOverride) : own;
        // The one materialization rule, shared with DetachInstanceAction so a detach bakes
        // exactly what expansion was drawing.
        const copy = materializeNode(master as Node, override, isRoot, id, parentId);
        nodes.set(id, copy);
        nodes.get(parentId)!.children.push(id);
        materialized++;

        // A copied node that is ITSELF an instance expands one level deeper (nested components).
        if (copy.type === "core.instance") {
            const nested = resolveVariantMaster(doc, copy);
            if (nested !== null) expand(id, nested, depth + 1, chain);
        }
        // A SLOT (schema 29) draws whatever the driving instance put in it, in place of its own
        // children. The slot node itself still supplies the box, so the fill is re-origined to
        // (0,0) inside it — `isRoot: true`, the same rule a master root obeys, for the same
        // reason: the slot places the content, the content does not place itself.
        //
        // The fill becomes a new instance PATH (`…::slotCopy::filled`), so a nested fill nests
        // exactly like a nested instance — and the path-keyed override lookup above reaches
        // into it with no extra machinery.
        const filledId = copy.slot !== undefined
            ? nodes.get(instancePath)?.slotContent?.[copy.slot]
            : undefined;
        if (filledId !== undefined && doc.nodes.has(filledId) && !chain.has(filledId)) {
            // The fill joins the CHAIN, so content that (however indirectly) contains this
            // master cannot expand forever — the same guard nested instances get.
            return materialize(filledId, id, id, true, depth + 1, new Set(chain).add(filledId));
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
        if (n.type !== "core.instance") return;
        // The VARIANT the selection asks for, not blindly the id `componentId` names.
        const masterId = resolveVariantMaster(doc, n);
        if (masterId !== null) expand(id, masterId, 0, new Set<string>());
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

/**
 * Apply the document's ACTIVE STATE (Milestone 7, schema 30) — a pure pass returning a derived
 * document in which every node that defines the active state shows it.
 *
 * Modelled on `activeTheme`: one document-level selection, resolved at display time, nothing
 * persisted about which state a node is "currently" in. A node that does not define the active
 * state is returned by REFERENCE, and a document where nothing defines it returns unchanged —
 * so a state-free document pays nothing, exactly as an instance-free one does.
 *
 * States apply to STORED nodes, before expansion, so a master in its hover state produces
 * hovered copies. An instance's own state applies to the instance node itself.
 */
export function applyActiveState(doc: ReadonlyDocument): ReadonlyDocument {
    const active = doc.activeState;
    if (typeof active !== "string" || active.length === 0) return doc;

    let any = false;
    doc.nodes.forEach(n => { if (n.states?.[active]) any = true; });
    if (!any) return doc;

    const nodes = new Map<string, Node>();
    doc.nodes.forEach((n, id) => {
        const state = n.states?.[active];
        // `materializeNode` is the ONE place a node and an override are combined, so a state
        // lands exactly as an override does — including `mergeLayout`'s exclusivity and the
        // root-copy rules. `isRoot: false` because this node is not being re-parented: it keeps
        // its own position and its own constraints.
        nodes.set(id, state ? materializeNode(n as Node, state, false, id, n.parent ?? null) : (n as Node));
        if (state) nodes.get(id)!.children = [...n.children];   // materializeNode empties children
    });

    return {
        version: doc.version,
        metadata: doc.metadata as ProjectDocument["metadata"],
        nodes,
        rootNodeUuids: [...doc.rootNodeUuids],
        variables: doc.variables as ProjectDocument["variables"],
        activeTheme: doc.activeTheme,
        activeState: doc.activeState
    } as ProjectDocument;
}

/**
 * The scene as it should be DISPLAYED: the active state applied, then instances expanded.
 *
 * This is the seam every consumer reads — renderer, geometry, tools, inspector. Order matters:
 * states resolve on STORED nodes first, so a master in its hover state produces hovered copies;
 * expanding first would leave every copy showing the base state. Calling `expandInstances`
 * directly outside this module would silently skip states, so a test asserts nothing does.
 */
export function resolveScene(doc: ReadonlyDocument): ReadonlyDocument {
    // Hidden FIRST: a hidden node takes no part in anything downstream, including being
    // copied into an instance. Then the active state, then expansion — so a master in its
    // hover state produces hovered copies. Booleans resolve LAST, once every operand a
    // combination could see actually exists: an instance's copies are only real after
    // expansion, and a hidden operand must already be gone rather than silently combined.
    // TIME first, before states: a keyframe says where a node IS, and a state (a hover, say)
    // says how it looks in a situation — so a situation may override the animation, not the other
    // way round. Everything after this point sees an ordinary, un-animated document, which is why
    // layout, picking, snapping, culling, all three backends and the exporter needed no changes
    // when time was added.
    // IK AFTER TIME, because a target is a thing a keyframe may animate — a foot planted on the
    // ground for part of a walk and lifted for the rest is the ordinary case, and solving before
    // the frame was applied would pose every limb to its rest target. Before states and expansion
    // for the same reason time is: everything downstream sees an ordinary, un-rigged document.
    // SKINNING NEEDS THE POSE THE ART WAS DRAWN IN, which is this same chain without the two
    // steps that move things: the frame and the IK solve. Passed as a thunk because it is a second
    // full derivation, and an unskinned document — every document today — must never pay for it.
    return resolveMeshes(
        resolveBooleans(expandInstances(applyActiveState(applyIk(applyFrame(dropHidden(doc), doc.frame))))),
        () => resolveBooleans(expandInstances(applyActiveState(dropHidden(doc))))
    );
}

/**
 * Local matrix for a node from its geometry + transform — the engine's own composition rule.
 *
 * A THIN ALIAS, not a second rule: this and the geometry engine each had their own copy of the
 * same six lines until skinning needed a third, at which point three places could drift about
 * where a rotation pivots. `localMatrix` in `geometry/Matrix` is now the only one.
 */
function nodeMatrix(geo: Geometry, t: Transform | undefined): Mat2D {
    return localMatrix(geo, t);
}

/**
 * Turn every `core.boolean` into the `core.path` it draws as (schema 33).
 *
 * This is what makes the operation NON-DESTRUCTIVE: the document keeps the operands as an
 * ordinary subtree, and the combination is derived every time the scene resolves — so moving a
 * child, restyling it, or changing the operation updates the result, and undo is just an edit to
 * a child. The destructive `booleanAction` bakes the same `booleanPaths` result into a flat path;
 * this keeps it alive.
 *
 * Resolving HERE rather than in the renderer is the whole point: every consumer below — layout,
 * hit-testing, snapping, culling, both backends — sees an ordinary path and needs no knowledge
 * that a boolean exists. It is the same trick `expandInstances` plays.
 *
 * Children are combined in the BOOLEAN's own space (each child's local matrix applied to its
 * outline), and INNERMOST FIRST, so a boolean of booleans resolves bottom-up. The result node
 * keeps the boolean's transform and style, and takes its box from the result's own tight bounds —
 * the stored box is derived data, which is why `dimensionError` treats it permissively.
 *
 * A boolean with fewer than two usable operands resolves to an EMPTY path rather than
 * disappearing: the node stays selectable, so dropping a shape into it is still possible.
 */
/**
 * Every MESHED node as an ordinary `core.path` whose outline the mesh has bent (schema 41).
 *
 * Resolved at the display seam, LAST — after booleans, so a warp applies to a combined shape
 * rather than to one operand of it, and after instances, so a component's copies each bend with
 * their own mesh. Everything downstream sees a path: picking, marquee selection, snapping,
 * tessellation, the decomposition and all three backends need no knowledge that meshes exist, and
 * a warped shape is CLICKABLE exactly where it is drawn.
 *
 * A mesh still at REST is skipped, and a document with no mesh at all is returned by reference —
 * this runs on every derivation, so an unmeshed document must cost what it always did.
 */
/**
 * The scope a virtual id lives in — `I::OI::X` gives `I::OI::`, a stored id gives `""`.
 *
 * A binding names a bone by its STORED id, because that is what the author picked and what gets
 * saved. Inside an instance the same bone exists as a copy under a prefix, so a copy's mesh has to
 * be read against the copies BESIDE IT rather than the masters it came from — otherwise every
 * instance of a rigged component would pose to the master's skeleton and they would all move
 * identically no matter what each instance overrode.
 */
function idScope(id: string): string {
    const at = id.lastIndexOf("::");
    return at === -1 ? "" : id.slice(0, at + 2);
}

/**
 * One node's mesh with its rig applied, or the stored mesh when nothing is bound.
 *
 * THE SIBLING RULE IS ENFORCED HERE, and only here. It began in `Integrity` as a refusal, which
 * made an unopenable file one drag away — regrouping a rigged shape, or dragging its bone out,
 * both left a document that would not reload. Enforcing it at DERIVATION instead is what lets a
 * binding be inert rather than invalid: it survives the regrouping, contributes nothing while the
 * two are in different spaces, and starts working again when they are siblings once more.
 *
 * A bone that no longer exists is skipped by the same lookup, for the same reason.
 */
function poseMesh(
    mesh: ReadonlyMesh,
    id: string,
    node: Node,
    doc: ReadonlyDocument,
    rest: () => ReadonlyDocument | null
): ReadonlyMesh {
    let bound = false;
    for (const p of mesh.points) { if (p.bones && p.bones.length > 0) { bound = true; break; } }
    if (!bound) return mesh;
    const restDoc = rest();
    if (!restDoc) return mesh;
    const restNode = restDoc.nodes.get(id);
    if (!restNode) return mesh;
    const scope = idScope(id);
    const boxOf = (g: { width: number; height: number }) => ({ width: g.width, height: g.height });

    return skinMesh(
        mesh,
        { box: boxOf(restNode.geometry), matrix: localMatrix(restNode.geometry, restNode.transform) },
        { box: boxOf(node.geometry), matrix: localMatrix(node.geometry, node.transform) },
        boneId => {
            // The copy beside this one first, the stored node second — so a rig works both inside
            // an instance and out, and a bone named across scopes is simply not found.
            const candidates = scope ? [scope + boneId, boneId] : [boneId];
            for (const candidate of candidates) {
                const posed = doc.nodes.get(candidate);
                const drawn = restDoc.nodes.get(candidate);
                if (!posed || !drawn) continue;
                // ONE SHARED SPACE, or nothing. Both matrices are local to their parent, so
                // `posed · rest⁻¹` only composes with this node's own pair when the two hang off
                // the same parent. Anywhere else the arithmetic would still produce numbers, and
                // they would be numbers about a different frame.
                if ((posed.parent ?? null) !== (node.parent ?? null)) continue;
                return {
                    rest: localMatrix(drawn.geometry, drawn.transform),
                    posed: localMatrix(posed.geometry, posed.transform),
                };
            }
            return null;
        }
    );
}

export function resolveMeshes(doc: ReadonlyDocument, restOf?: () => ReadonlyDocument): ReadonlyDocument {
    let any = false;
    doc.nodes.forEach(n => { if (n.mesh) any = true; });
    if (!any) return doc;

    // Built ONCE, and only if a bound point is actually reached — see `resolveScene`.
    let restDoc: ReadonlyDocument | null = null;
    const rest = (): ReadonlyDocument | null => {
        if (!restOf) return null;
        if (!restDoc) restDoc = restOf();
        return restDoc;
    };

    const nodes = new Map<string, Node>();
    doc.nodes.forEach((n, id) => {
        const stored = n.mesh;
        const box = { width: n.geometry.width, height: n.geometry.height };
        const mesh = stored ? poseMesh(stored, id, n as Node, doc, rest) : undefined;
        // Converted when the mesh moves the outline (`isIdentityMesh`) OR when it has HEIGHT.
        // Height changes no coordinate, so it looked like nothing to do — but a rectangle
        // tessellates to two triangles whose vertices are only its four CORNERS, and at the rim
        // of a raised mesh the gradient is zero, so every one of them sampled a flat spot and the
        // shading had nowhere to live. Converting subdivides the outline at the grid's own
        // resolution, which is where the surface actually varies.
        if (!mesh || (isIdentityMesh(mesh) && isFlatMesh(mesh))) { nodes.set(id, n as Node); return; }
        // The node's OWN outline, by the same conversion picking and the booleans use — so a
        // warped rectangle bends the rectangle everything else agrees it is.
        const local = shapeToCommands(hitShapeOf(n as Node, radiusOfNode(n as Node)), box.width, box.height);
        if (!local) { nodes.set(id, n as Node); return; }
        const warped = warpCommands(local, box, mesh, flattenPath);
        if (warped.length === 0) { nodes.set(id, n as Node); return; }
        // A `core.path`, and the mesh is DROPPED from the derived node: the bend is now in the
        // commands, and leaving the mesh on would warp the already-warped outline the next time
        // anything resolved. That is the `activeState` trap in a new costume.
        const out: Node = { ...(n as Node), type: "core.path", path: warped };
        delete out.mesh;
        nodes.set(id, out);
    });

    return {
        version: doc.version,
        metadata: doc.metadata as ProjectDocument["metadata"],
        nodes,
        rootNodeUuids: [...doc.rootNodeUuids],
        variables: doc.variables as ProjectDocument["variables"],
        activeTheme: doc.activeTheme,
        activeState: doc.activeState,
        timeline: doc.timeline,
        frame: doc.frame
    } as ProjectDocument;
}

/** A node's resolved corner radius — only a concrete number can reach a shape conversion. */
function radiusOfNode(node: Node): number {
    return typeof node.style.radius === "number" ? node.style.radius : 0;
}

export function resolveBooleans(doc: ReadonlyDocument): ReadonlyDocument {
    let any = false;
    doc.nodes.forEach(n => { if (n.type === "core.boolean") any = true; });
    if (!any) return doc;

    const nodes = new Map<string, Node>();
    doc.nodes.forEach((n, id) => nodes.set(id, n as Node));
    const gone = new Set<string>();

    /** A node's outline in ITS OWN space, resolving a nested boolean first. */
    const outlineOf = (id: string): PathCommand[] | null => {
        const node = nodes.get(id);
        if (!node) return null;
        if (node.type === "core.boolean") resolveOne(id);
        const resolved = nodes.get(id);
        if (!resolved) return null;
        const raw = resolved.style.radius;
        const radius = typeof raw === "number" ? raw : 0;   // a token radius is not resolvable here; square is the safe read
        const shape = hitShapeOf(resolved, radius);
        return shapeToCommands(shape, resolved.geometry.width, resolved.geometry.height);
    };

    const resolving = new Set<string>();
    const resolveOne = (id: string): void => {
        const node = nodes.get(id);
        if (!node || node.type !== "core.boolean" || resolving.has(id)) return;
        resolving.add(id);   // a malformed cycle resolves to nothing rather than recursing forever

        const operands: PathCommand[][] = [];
        for (const childId of node.children) {
            const child = nodes.get(childId);
            const local = outlineOf(childId);
            if (!child || !local) continue;
            operands.push(transformCommands(nodeMatrix(child.geometry, child.transform), local));
        }

        let result: PathCommand[] = operands.length > 0 ? operands[0] : [];
        for (let i = 1; i < operands.length; i++) {
            result = resolveBooleanPaths(result, operands[i], node.booleanOp ?? "union");
        }

        for (const childId of node.children) bury(childId, gone, nodes);
        if (result.length === 0) {
            nodes.set(id, { ...node, type: "core.path", children: [], path: undefined, booleanOp: undefined });
            return;
        }
        const norm = normalizePathNode(node.geometry, result);
        nodes.set(id, {
            ...node,
            type: "core.path",
            children: [],
            geometry: { ...node.geometry, ...norm.geometry },
            path: norm.path,
            booleanOp: undefined
        });
    };

    doc.nodes.forEach((n, id) => { if (n.type === "core.boolean") resolveOne(id); });

    const kept = new Map<string, Node>();
    nodes.forEach((n, id) => {
        if (gone.has(id)) return;
        const children = n.children.filter(c => !gone.has(c));
        kept.set(id, children.length === n.children.length ? n : { ...n, children });
    });

    return {
        version: doc.version,
        metadata: doc.metadata as ProjectDocument["metadata"],
        nodes: kept,
        rootNodeUuids: doc.rootNodeUuids.filter(id => !gone.has(id)),
        variables: doc.variables as ProjectDocument["variables"],
        activeTheme: doc.activeTheme,
        activeState: doc.activeState
    } as ProjectDocument;
}

/** Mark a node and its whole subtree as removed from the resolved scene. */
function bury(id: string, gone: Set<string>, nodes: ReadonlyMap<string, Node>): void {
    if (gone.has(id)) return;
    gone.add(id);
    for (const childId of nodes.get(id)?.children ?? []) bury(childId, gone, nodes);
}

/**
 * Drop every HIDDEN node (schema 31) — a pure pass returning the scene as it should be DISPLAYED.
 *
 * A hidden node is removed with its whole SUBTREE, so nothing inside a hidden group leaks back
 * in through a child reference. Removing it rather than flagging it is what makes hiding behave
 * like `display: none` everywhere at once: the renderer never sees it, the pickers never see it,
 * and an auto-layout parent does not reserve space for it — none of which would follow from a
 * flag each consumer had to remember to check.
 *
 * It stays in the STORED document, so the layer panel still lists it and un-hiding is a toggle
 * rather than an undo.
 */
export function dropHidden(doc: ReadonlyDocument): ReadonlyDocument {
    let any = false;
    doc.nodes.forEach(n => { if (n.hidden) any = true; });
    if (!any) return doc;

    const gone = new Set<string>();
    const bury = (id: string): void => {
        if (gone.has(id)) return;                       // cycle-safe, like every walk here
        gone.add(id);
        for (const childId of doc.nodes.get(id)?.children ?? []) bury(childId);
    };
    doc.nodes.forEach((n, id) => { if (n.hidden) bury(id); });

    const nodes = new Map<string, Node>();
    doc.nodes.forEach((n, id) => {
        if (gone.has(id)) return;
        const kept = n.children.filter(c => !gone.has(c));
        nodes.set(id, kept.length === n.children.length ? (n as Node) : { ...(n as Node), children: kept });
    });

    return {
        version: doc.version,
        metadata: doc.metadata as ProjectDocument["metadata"],
        nodes,
        rootNodeUuids: doc.rootNodeUuids.filter(id => !gone.has(id)),
        variables: doc.variables as ProjectDocument["variables"],
        activeTheme: doc.activeTheme,
        activeState: doc.activeState
    } as ProjectDocument;
}
