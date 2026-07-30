/**
 * @module GeometryEngine
 * @description Milestone 1: turns stored INTENT into computed RESULTS.
 *
 *     Document → GeometryEngine → ComputedState → Renderer
 *
 * The engine is the only place coordinates are composed. It walks the scene graph
 * parents-first, multiplies each node's local matrix into its parent's world matrix,
 * and publishes per node: a world matrix, a local rect, and a world-space AABB.
 *
 * Two rules it enforces, which everything above depends on:
 *   1. COORDINATE SPACE — `geometry.x/y` is PARENT-RELATIVE. World position is a
 *      computed output, never stored. `toLocal`/`toWorld` are the only sanctioned
 *      conversions, and they use real inverse matrices rather than subtraction.
 *   2. PREVIEWS ARE INPUTS — an in-progress drag is passed in as `pending` patches to
 *      STORED geometry and composed like anything else, so it inherits parent
 *      transforms (and, from M2, layout) instead of bypassing them.
 *
 * DIRTY TRACKING: `compute` accepts a previous ComputedState and a dirty set. A node
 * whose subtree is untouched reuses its previous entry by reference. The dirty set
 * must be a SUPERSET of the nodes whose stored geometry/transform changed since
 * `previous` was computed: an over-broad set only costs time, but an UNDER-broad set
 * silently reuses a stale entry and renders the node in the wrong place. Callers own
 * that guarantee; the invariant that keeps them honest is `incremental === full`
 * (property-tested). Descendant propagation is handled here: a node is recomputed if
 * it OR ANY ANCESTOR is dirty, because a parent's transform composes downward — so a
 * caller only needs to list the directly-changed ids, not their subtrees.
 */

import { DeepReadonly, ReadonlyDocument } from "../document/Document";
import { Geometry, Margins, Node } from "../document/Node";
import { traverseSceneGraph } from "../document/SceneGraph";
import { expandInstances, isVirtualId } from "../document/Components";
import { expandDirtyForLayout, isAbsolute, isLayoutContainer, layoutChildren, layoutGridChildren, measureIntrinsicSizes, resolveConstraints } from "./LayoutEngine";
import {
    Mat2D, IDENTITY, Rect, multiply, compose, invert, applyToPoint,
    transformRectToAABB, unionRect
} from "./Matrix";

export interface ComputedNode {
    /** Local→world matrix, ready for `matrix(a b c d e f)`. */
    world: Mat2D;
    /** The node's own box in its LOCAL space (post-pending-patch). */
    local: Rect;
    /** Axis-aligned bounds of that box in WORLD space (rotation-aware). */
    bounds: Rect;
}

export interface ComputedState {
    /** Node ids in draw order, back to front. */
    order: string[];
    nodes: Map<string, ComputedNode>;
}

export type PendingGeometry = Map<string, Partial<Geometry>> | null | undefined;

/** Local matrix for one node from its stored geometry + optional transform. */
function localMatrix(geo: Rect, t: { rotation?: number; scaleX?: number; scaleY?: number; origin?: { x: number; y: number } } | undefined): Mat2D {
    if (!t) return { a: 1, b: 0, c: 0, d: 1, e: geo.x, f: geo.y };
    const ox = (t.origin?.x ?? 0.5) * geo.width;
    const oy = (t.origin?.y ?? 0.5) * geo.height;
    return compose(geo.x, geo.y, t.rotation ?? 0, t.scaleX ?? 1, t.scaleY ?? 1, ox, oy);
}

function isFiniteRect(r: Rect): boolean {
    return Number.isFinite(r.x) && Number.isFinite(r.y)
        && Number.isFinite(r.width) && Number.isFinite(r.height);
}

/**
 * @param pending patches to STORED (parent-relative) geometry — drag/resize previews.
 * @param previous prior state to reuse entries from (pure optimisation).
 * @param dirty ids whose own geometry/transform changed; descendants are derived.
 */
export function computeGeometry(
    doc: ReadonlyDocument,
    pending?: PendingGeometry,
    previous?: ComputedState,
    dirty?: ReadonlySet<string>
): ComputedState {
    // COMPONENT INSTANCES (M6) resolve FIRST: `expandInstances` materializes each instance's
    // master subtree as ordinary virtual children, so everything below — layout, transforms,
    // culling, hit-testing, both backends — works unchanged on an ordinary tree. It returns
    // the SAME document reference when there is nothing to expand, so an instance-free
    // document pays nothing. Doing it here (rather than at each call site) is what keeps every
    // consumer — renderer, tools, inspector — reading one consistent scene.
    const stored = doc;
    doc = expandInstances(doc);
    // Dirty-tracking reuse is DISABLED while instances are present: the dirty set names STORED
    // ids (that is what actions report), but a master edit changes its VIRTUAL copies, whose
    // ids are not in that set — reusing them would render a stale copy. A full recompute is
    // always correct; incremental reuse for instanced documents is a documented deferral.
    if (doc !== stored) { previous = undefined; dirty = undefined; }

    const order: string[] = [];
    const nodes = new Map<string, ComputedNode>();
    // A node is recomputed if it, or any ancestor, is dirty.
    const dirtySubtree = new Set<string>();
    // One scene walk, shared by the measure pass (reversed = bottom-up) and the
    // position pass (forward = top-down).
    const scene = traverseSceneGraph(doc);
    // MEASURE PASS: resolved own-size per node, with hug containers folded from their
    // children. Always full (never memoized), so the size layer is identical between a
    // full and an incremental compute — the invariant then rests only on the climb.
    const measured = measureIntrinsicSizes(scene, pending);
    // Layout ripple: a change to a container's child (or a pending size preview) moves
    // its SIBLINGS and can resize hug ancestors, so climb the dirty set up the
    // layout/hug chain. Pending keys join the seed so a live resize ripples up too.
    let effectiveDirty = dirty;
    if (dirty) {
        const seed = new Set(dirty);
        if (pending) for (const k of pending.keys()) seed.add(k);
        effectiveDirty = expandDirtyForLayout(doc, seed);
    }
    // childId → parent-relative rect computed by the parent's auto-layout.
    const laidOut = new Map<string, Rect>();

    for (const node of scene) {
        const id = node.id;
        const parentId = node.parent ?? null;

        // A node whose parent never resolved means a damaged tree: skip it rather
        // than silently placing it at the origin, which would draw it in the wrong
        // place AND make hit-testing agree with the wrong drawing.
        const parentComputed = parentId != null ? nodes.get(parentId) : undefined;
        if (parentId != null && !parentComputed) continue;

        const selfDirty = !previous || !effectiveDirty || effectiveDirty.has(id) || pending?.has(id) === true;
        const inherited = parentId != null && dirtySubtree.has(parentId);
        if (selfDirty || inherited) dirtySubtree.add(id);

        const reusable = previous?.nodes.get(id);
        if (!selfDirty && !inherited && reusable) {
            order.push(id);
            nodes.set(id, reusable);
            layoutContainerPass(doc, node, reusable.local, laidOut, measured);
            continue;
        }

        const patch = pending?.get(id);
        const g = node.geometry;
        // A child of an auto-layout container gets its position (and, when stretched,
        // size) from the parent — replacing stored x/y with a computed one. A pending
        // drag patch still wins, so a laid-out node can be previewed if a tool allows it.
        // A node's OWN size comes from the measure pass (its stored size, or a hug
        // container's computed size); the parent's layout already used that same measured
        // size, so a laid-out child (`computedLocal`) and a root agree.
        const computedLocal = laidOut.get(id);
        const m = measured.get(id);
        let base: Rect;
        if (computedLocal) {
            base = computedLocal;
        } else {
            const stored = { x: g.x, y: g.y, width: m?.width ?? g.width, height: m?.height ?? g.height };
            // CONSTRAINTS: a child of a PLAIN parent (never a flex/grid one — those set
            // `computedLocal`) repositions relative to the parent's CURRENT resolved size
            // vs the child's frozen `constraintRef`. Top-down, so the parent's local is
            // already computed; a resize of the parent (direct or layout-driven) dirties
            // it and the child inherits.
            // Constraints resolve for a child of a PLAIN parent, OR for an `absolute` child
            // of ANY parent (it is out of flow, so it positions against the parent box like
            // a plain-parent child would). An in-flow child of a container never reaches
            // here (it has a laidOut rect); the gate only guards damaged trees.
            const parentNode = node.layout.constraints && parentId != null ? doc.nodes.get(parentId) : undefined;
            base = parentComputed && parentNode && (!isLayoutContainer(parentNode) || isAbsolute(node))
                ? resolveConstraints(stored, node.layout.constraints, node.layout.constraintRef, parentComputed.local)
                : stored;
        }
        // A laid-out child's WHOLE rect is a layout RESULT: its position is the slot/cell,
        // and its size already folded any pending size via the MEASURE pass (a flex child
        // resizes through measure; a grid child fills its cell). So a raw pending patch
        // must NOT touch it — applying patch.x/y would leak the child's ignored stored x/y
        // (a grid item flies to its stored 999,999), and patch.width/height would
        // double-count (a grow child clamps back below its grown size). Free (non-laid-out)
        // nodes still take the pending patch — that is the drag/resize preview.
        const local: Rect = computedLocal
            ? base
            : patch
                ? { x: patch.x ?? base.x, y: patch.y ?? base.y, width: patch.width ?? base.width, height: patch.height ?? base.height }
                : base;

        if (!isFiniteRect(local)) continue;

        const parentWorld = parentComputed ? parentComputed.world : IDENTITY;
        const world = multiply(parentWorld, localMatrix(local, node.transform));
        // The box in local space sits at the origin: its position is carried by the
        // matrix, so composing it again here would double-apply the translation.
        const boxAtOrigin: Rect = { x: 0, y: 0, width: local.width, height: local.height };

        order.push(id);
        nodes.set(id, { world, local, bounds: transformRectToAABB(world, boxAtOrigin) });
        layoutContainerPass(doc, node, local, laidOut, measured);
    }

    return { order, nodes };
}

/**
 * If `node` is an auto-layout container, compute its direct children's parent-relative
 * rects and record them in `laidOut`. Runs when the PARENT is visited; because the
 * scene graph is walked parents-first, each child then reads its computed rect before
 * it is itself processed. Child sizes come from the MEASURE pass, so they already
 * reflect any pending patch (a live resize reflows siblings) and any child's own hug.
 */
function layoutContainerPass(
    doc: ReadonlyDocument,
    node: DeepReadonly<Node>,
    parentLocal: Rect,
    laidOut: Map<string, Rect>,
    measured: ReadonlyMap<string, { width: number; height: number }>
): void {
    // GRID: children fill cells, but `auto` tracks size to the children's measured own-sizes,
    // so the grid now needs those sizes (the SAME `measured` map the hug fold read). The
    // in-flow filter — skip absolute (out of flow, no cell) and skip unmeasured — MUST match
    // the measure fold's grid branch, or the auto-track flow indices would drift between the
    // container's hug size and its cells.
    const grid = node.layout.grid;
    if (grid) {
        const children: { id: string; width: number; height: number; colSpan?: number; rowSpan?: number; margin?: number | Margins; gridColumn?: readonly [number, number]; gridRow?: readonly [number, number] }[] = [];
        for (const childId of node.children) {
            const child = doc.nodes.get(childId);
            if (!child || isAbsolute(child)) continue;
            const own = measured.get(childId);
            if (!own) continue;
            children.push({ id: childId, width: own.width, height: own.height, colSpan: child.layout.colSpan, rowSpan: child.layout.rowSpan, margin: child.layout.margin, gridColumn: child.layout.gridColumn, gridRow: child.layout.gridRow });
        }
        for (const [id, rect] of layoutGridChildren(grid, { width: parentLocal.width, height: parentLocal.height }, children)) {
            laidOut.set(id, rect);
        }
        return;
    }

    const container = node.layout.container;
    if (!container) return;
    const children: { id: string; width: number; height: number; grow?: number; shrink?: number; margin?: number | Margins }[] = [];
    for (const childId of node.children) {
        const child = doc.nodes.get(childId);
        if (!child || isAbsolute(child)) continue; // absolute children are out of the flow
        const own = measured.get(childId) ?? { width: child.geometry.width, height: child.geometry.height };
        children.push({ id: childId, width: own.width, height: own.height, grow: child.layout.grow, shrink: child.layout.shrink, margin: child.layout.margin });
    }
    // A REALLY-wrapping container must break lines against its OWN (measured) MAIN size — the
    // same size the measure cross-hug fold used — NOT the container's computed local rect, which
    // a grow/stretch/grid-cell parent may have enlarged. Otherwise measure and position would
    // wrap differently and a cross-hug container's size would not match its laid-out lines (a
    // fuzz-blind bug). The cross axis still uses the real local rect. (Extra main space from a
    // stretching parent is a documented deferral — wrap does not re-flow into it.)
    //
    // Gate on `effectiveWrap` (wrap AND main not hugged) — the SAME condition `layoutChildren`
    // and the measure fold use — NOT `wrap === true`. A hug-MAIN container is inert (a single
    // line either way), so it must keep the parent's actual (possibly grown) main; substituting
    // its un-grown intrinsic main there would starve its grow/shrink children. (Review-found.)
    const own = measured.get(node.id);
    const row = container.direction === "row";
    const effectiveWrap = container.wrap === true && !(row ? container.hugWidth : container.hugHeight);
    const parentSize = effectiveWrap && own
        ? { width: row ? own.width : parentLocal.width, height: row ? parentLocal.height : own.height }
        : { width: parentLocal.width, height: parentLocal.height };
    for (const [id, rect] of layoutChildren(container, parentSize, children)) {
        laidOut.set(id, rect);
    }
}

/** World-space AABB of a node and everything beneath it. */
export function subtreeBounds(doc: ReadonlyDocument, state: ComputedState, rootId: string): Rect | null {
    const start = state.nodes.get(rootId);
    if (!start) return null;
    let acc = start.bounds;
    const walk = (id: string): void => {
        const node = doc.nodes.get(id);
        if (!node) return;
        for (const childId of node.children) {
            const c = state.nodes.get(childId);
            if (c) acc = unionRect(acc, c.bounds);
            walk(childId);
        }
    };
    walk(rootId);
    return acc;
}

/** World-space AABB enclosing every listed node. Null when none resolve. */
export function selectionBounds(state: ComputedState, ids: readonly string[]): Rect | null {
    let acc: Rect | null = null;
    for (const id of ids) {
        const c = state.nodes.get(id);
        if (!c) continue;
        acc = acc ? unionRect(acc, c.bounds) : c.bounds;
    }
    return acc;
}

/** World point → a node's local space. Null if the node is unknown or non-invertible. */
export function toLocal(state: ComputedState, nodeId: string, x: number, y: number): { x: number; y: number } | null {
    const c = state.nodes.get(nodeId);
    if (!c) return null;
    const inverse = invert(c.world);
    if (!inverse) return null;
    return applyToPoint(inverse, x, y);
}

/** A node's local point → world space. */
export function toWorld(state: ComputedState, nodeId: string, x: number, y: number): { x: number; y: number } | null {
    const c = state.nodes.get(nodeId);
    return c ? applyToPoint(c.world, x, y) : null;
}

/**
 * Topmost node within `tolerance` world units of a world point, or null.
 *
 * Walks draw order in reverse so the front-most wins, and tests in each node's LOCAL
 * space via the inverse matrix — so a rotated node hit-tests against its true shape,
 * not its bounding box.
 *
 * `tolerance` (world units, default 0) is a pick halo that inflates both the AABB
 * reject and the local box. Its point: a ZERO-EXTENT node — an axis-aligned
 * `core.line` (width 0 or height 0) — has a zero-area box, so with no tolerance only
 * a click whose world coordinate exactly equals the collapsed axis could ever hit it,
 * making the visible hairline effectively unselectable. A few screen px, converted to
 * world by the caller (`px / zoom`), makes it (and thin targets generally) pickable.
 * Applied to the local box directly — approximate under a node scale, which is
 * acceptable for a fuzzy affordance, and exact for the common unscaled case.
 */
export function hitTest(state: ComputedState, x: number, y: number, tolerance: number = 0): string | null {
    for (let i = state.order.length - 1; i >= 0; i--) {
        const id = state.order[i];
        // A VIRTUAL node (an instance's materialized copy, M6) is not a document node: it has
        // no stored geometry to edit, so selecting it would produce a selection no action can
        // act on. Clicking instance content therefore selects the INSTANCE, whose own box is
        // tested normally. Per-child picking arrives with overrides (M6 slice 2).
        if (isVirtualId(id)) continue;
        const c = state.nodes.get(id);
        if (!c) continue;
        // Cheap AABB reject first (inflated by the halo), then the exact local-space test.
        const b = c.bounds;
        if (x < b.x - tolerance || y < b.y - tolerance || x > b.x + b.width + tolerance || y > b.y + b.height + tolerance) continue;
        const p = toLocal(state, id, x, y);
        if (!p) continue;
        if (p.x >= -tolerance && p.y >= -tolerance && p.x <= c.local.width + tolerance && p.y <= c.local.height + tolerance) return id;
    }
    return null;
}

/**
 * Marquee (box) selection: every node whose WORLD bounds OVERLAP `rect` (world units),
 * returned in draw order (back to front). Overlap — "touch" semantics — not containment:
 * a node the marquee merely grazes counts, so you needn't fully enclose a target (the
 * Illustrator/Sketch default; the Figma-style directional contain-vs-touch is a later
 * refinement). The test is the rotation-aware AABB (`bounds`), like `hitTest`'s cheap
 * reject — a fuzzy affordance, so an AABB rather than the exact rotated shape is fine.
 * Inclusive edges: a rect flush against a node's edge selects it. Non-finite bounds
 * fail every comparison (NaN), so a degenerate node is silently skipped, never thrown.
 */
export function nodesInRect(state: ComputedState, rect: Rect): string[] {
    const hits: string[] = [];
    const rx2 = rect.x + rect.width;
    const ry2 = rect.y + rect.height;
    for (const id of state.order) {
        // Virtual (instance-copy) nodes are not selectable — same rule as `hitTest`, so a
        // marquee over an instance selects the instance itself, not its materialized children.
        if (isVirtualId(id)) continue;
        const c = state.nodes.get(id);
        if (!c) continue;
        const b = c.bounds;
        if (b.x <= rx2 && b.x + b.width >= rect.x && b.y <= ry2 && b.y + b.height >= rect.y) hits.push(id);
    }
    return hits;
}
