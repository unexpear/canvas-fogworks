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
 * whose subtree is untouched reuses its previous entry by reference. Correctness does
 * not depend on the dirty set being right — an over-broad set only costs time — but a
 * node is treated as dirty if it OR ANY ANCESTOR changed, because a parent's transform
 * propagates down.
 */

import { ReadonlyDocument } from "../document/Document";
import { Geometry } from "../document/Node";
import { traverseSceneGraph } from "../document/SceneGraph";
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

    for (const node of traverseSceneGraph(doc)) {
        const id = node.id;
        const parentId = node.parent ?? null;

        // A node whose parent never resolved means a damaged tree: skip it rather
        // than silently placing it at the origin, which would draw it in the wrong
        // place AND make hit-testing agree with the wrong drawing.
        const parentComputed = parentId != null ? nodes.get(parentId) : undefined;
        if (parentId != null && !parentComputed) continue;

        const selfDirty = !previous || !dirty || dirty.has(id) || pending?.has(id) === true;
        const inherited = parentId != null && dirtySubtree.has(parentId);
        if (selfDirty || inherited) dirtySubtree.add(id);

        const reusable = previous?.nodes.get(id);
        if (!selfDirty && !inherited && reusable) {
            order.push(id);
            nodes.set(id, reusable);
            continue;
        }

        const patch = pending?.get(id);
        const g = node.geometry;
        const local: Rect = patch
            ? { x: patch.x ?? g.x, y: patch.y ?? g.y, width: patch.width ?? g.width, height: patch.height ?? g.height }
            : { x: g.x, y: g.y, width: g.width, height: g.height };

        if (!isFiniteRect(local)) continue;

        const parentWorld = parentComputed ? parentComputed.world : IDENTITY;
        const world = multiply(parentWorld, localMatrix(local, node.transform));
        // The box in local space sits at the origin: its position is carried by the
        // matrix, so composing it again here would double-apply the translation.
        const boxAtOrigin: Rect = { x: 0, y: 0, width: local.width, height: local.height };

        order.push(id);
        nodes.set(id, { world, local, bounds: transformRectToAABB(world, boxAtOrigin) });
    }

    return { order, nodes };
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
