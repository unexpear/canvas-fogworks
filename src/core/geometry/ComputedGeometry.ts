/**
 * @module ComputedGeometry
 * @description Resolves stored, parent-relative *intent* into absolute world
 * rectangles, in scene-graph draw order.
 *
 * This is the seam that Milestone 1's GeometryEngine / ComputedState grows into.
 * Deliberately narrow for now:
 *   - translation only (no rotation/scale — `Geometry` has no transform yet)
 *   - geometry only (resolved style/tokens arrive with M1/M5)
 *
 * Two rules it establishes, which M1 depends on:
 *   1. COORDINATE SPACE: `node.geometry.x/y` is **parent-relative**. World position
 *      is a computed output, never stored. (For a root, relative == world.)
 *   2. PREVIEWS ARE INPUTS: an in-progress drag is passed in as `pending` patches
 *      and composed like any other geometry — it is NOT a renderer-side override.
 *      This is what lets M2 layout apply to a preview instead of being bypassed.
 */

import { ReadonlyDocument } from "../document/Document";
import { Geometry } from "../document/Node";
import { traverseSceneGraph } from "../document/SceneGraph";

export interface WorldRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ComputedGeometry {
    /** Node ids in draw order, back to front (scene-graph order). */
    order: string[];
    /** Node id → absolute world rectangle. */
    rects: Map<string, WorldRect>;
}

/**
 * @param pending Optional patches to each node's STORED (parent-relative) geometry,
 *   applied before composition. Drag/resize previews flow through here.
 */
export function computeWorldGeometry(
    doc: ReadonlyDocument,
    pending?: Map<string, Partial<Geometry>> | null
): ComputedGeometry {
    const order: string[] = [];
    const rects = new Map<string, WorldRect>();

    // traverseSceneGraph visits parents before their children, so a parent's world
    // rect is always resolved by the time its children need it.
    for (const node of traverseSceneGraph(doc)) {
        const patch = pending?.get(node.id);
        const local: Geometry = patch ? { ...node.geometry, ...patch } : node.geometry;

        // A node whose parent has not been resolved yet means the tree is damaged
        // (the parent is unreachable from any root, so traversal emitted the child
        // first). Silently falling back to origin (0,0) would draw the node in the
        // wrong place AND make hit-testing agree with the wrong drawing, hiding the
        // corruption completely. Skip it instead: it is absent rather than misplaced.
        let originX = 0;
        let originY = 0;
        if (node.parent != null) {
            const parentRect = rects.get(node.parent);
            if (!parentRect) continue;
            originX = parentRect.x;
            originY = parentRect.y;
        }

        order.push(node.id);
        rects.set(node.id, {
            x: originX + local.x,
            y: originY + local.y,
            width: local.width,
            height: local.height
        });
    }

    return { order, rects };
}

/**
 * Topmost node containing the point, or null. Walks draw order in reverse so the
 * front-most node wins.
 *
 * Geometry-only and DOM-free on purpose: hit-testing must not depend on per-node
 * SVG elements, because the Milestone 3 Canvas/WebGL renderer has none.
 */
export function hitTest(computed: ComputedGeometry, x: number, y: number): string | null {
    for (let i = computed.order.length - 1; i >= 0; i--) {
        const id = computed.order[i];
        const r = computed.rects.get(id);
        if (!r) continue;
        if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
            return id;
        }
    }
    return null;
}
