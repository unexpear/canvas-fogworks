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
import { Geometry, Node } from "../document/Node";
import { traverseSceneGraph } from "../document/SceneGraph";
import { expandDirtyForLayout, layoutChildren, measureIntrinsicSizes } from "./LayoutEngine";
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
        const base = computedLocal ?? { x: g.x, y: g.y, width: m?.width ?? g.width, height: m?.height ?? g.height };
        const local: Rect = patch
            ? {
                x: patch.x ?? base.x,
                y: patch.y ?? base.y,
                // A laid-out child's SIZE is a layout RESULT that already folded THIS
                // node's pending size in via the measure pass (a grow child fed its
                // pending base is then grown PAST it). Re-imposing patch.width/height here
                // would double-count — clamping the child back below its grown size and
                // leaving a gap before its already-positioned sibling. So a pending patch
                // on a laid-out child previews only POSITION; its size stays the layout's.
                width: computedLocal ? base.width : (patch.width ?? base.width),
                height: computedLocal ? base.height : (patch.height ?? base.height),
            }
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
    const container = node.layout.container;
    if (!container) return;
    const children: { id: string; width: number; height: number; grow?: number }[] = [];
    for (const childId of node.children) {
        const child = doc.nodes.get(childId);
        if (!child) continue;
        const own = measured.get(childId) ?? { width: child.geometry.width, height: child.geometry.height };
        children.push({ id: childId, width: own.width, height: own.height, grow: child.layout.grow });
    }
    for (const [id, rect] of layoutChildren(container, { width: parentLocal.width, height: parentLocal.height }, children)) {
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
 * Topmost node containing a world point, or null.
 *
 * Walks draw order in reverse so the front-most wins, and tests in each node's LOCAL
 * space via the inverse matrix — so a rotated node hit-tests against its true shape,
 * not its bounding box.
 */
export function hitTest(state: ComputedState, x: number, y: number): string | null {
    for (let i = state.order.length - 1; i >= 0; i--) {
        const id = state.order[i];
        const c = state.nodes.get(id);
        if (!c) continue;
        // Cheap AABB reject first, then the exact local-space test.
        const b = c.bounds;
        if (x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height) continue;
        const p = toLocal(state, id, x, y);
        if (!p) continue;
        if (p.x >= 0 && p.y >= 0 && p.x <= c.local.width && p.y <= c.local.height) return id;
    }
    return null;
}
