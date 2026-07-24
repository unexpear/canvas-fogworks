/**
 * @module LayoutEngine
 * @description Milestone 2 core: auto-layout containers. Computes the PARENT-RELATIVE
 * position (and, when stretching, size) of a container's direct children from a
 * flex-stack rule, so their stored `geometry.x/y` is replaced by a computed one.
 *
 * This is what "store 'center inside parent' instead of x = 240" means: for a
 * container child, position is a computed RESULT, not stored intent. The layout runs
 * inside `computeGeometry` as a producer into `ComputedState` — nothing here mutates
 * the document.
 *
 * SCOPE (deliberately the core, not all of M2): a single flex stack — row/column,
 * gap, padding, cross-axis align (start/center/end/stretch), fixed-size container.
 * DEFERRED with their own milestone weight: flex-grow, wrap, grid, intrinsic/"hug"
 * sizing (needs a bottom-up pass), per-child margins, absolute-position escapes,
 * constraints/anchors. See MILESTONES.md § Milestone 2.
 */

import { ReadonlyDocument } from "../document/Document";
import { LayoutContainer } from "../document/Node";
import { Rect } from "./Matrix";

/** Minimal read-only shape — accepts both `Node` and a `ReadonlyDocument` node. */
type HasLayout = { readonly layout: { readonly container?: unknown } } | undefined;

/** True when this node auto-positions its children. */
export function isLayoutContainer(node: HasLayout): boolean {
    return !!node && node.layout.container !== undefined;
}

/**
 * Compute the parent-relative rect for each direct child of a container.
 *
 * @param container the parent's layout rule
 * @param parentSize the container's own width/height (fixed-size for now)
 * @param children the child nodes, in `parent.children` order
 * @returns child id → computed local rect (x/y always; width/height only when
 *   stretched on the cross axis, else the child keeps its own size)
 */
export function layoutChildren(
    container: LayoutContainer,
    parentSize: { width: number; height: number },
    children: readonly { id: string; width: number; height: number }[]
): Map<string, Rect> {
    const gap = container.gap ?? 0;
    const pad = container.padding ?? 0;
    const align = container.alignItems ?? "start";
    const row = container.direction === "row";

    // Axis abstraction: "main" is the packing axis, "cross" is the other.
    const innerCross = (row ? parentSize.height : parentSize.width) - 2 * pad;

    const out = new Map<string, Rect>();
    let cursor = pad; // main-axis offset, starts after the leading padding
    for (const child of children) {
        const mainSize = row ? child.width : child.height;
        const ownCross = row ? child.height : child.width;
        const crossSize = align === "stretch" ? Math.max(0, innerCross) : ownCross;

        let cross = pad;
        if (align === "center") cross = pad + (innerCross - crossSize) / 2;
        else if (align === "end") cross = pad + (innerCross - crossSize);
        // "start" and "stretch" both begin at the padding edge.

        out.set(child.id, row
            ? { x: cursor, y: cross, width: mainSize, height: crossSize }
            : { x: cross, y: cursor, width: crossSize, height: mainSize });

        cursor += mainSize + gap;
    }
    return out;
}

/**
 * Expand a dirty set for layout's SIBLING dependency: a change to one child of a
 * container shifts its later siblings, but a per-node mutation only reports the one
 * changed node. So mark the whole container dirty (one level up), which the geometry
 * engine's normal parent→descendant propagation then turns into "re-lay-out all
 * siblings". One level suffices for FIXED-size containers — a child change does not
 * resize the container, so it cannot ripple further up. (Intrinsic/"hug" sizing,
 * which would ripple upward, is deferred precisely because it breaks that.)
 */
export function expandDirtyForLayout(doc: ReadonlyDocument, dirty: ReadonlySet<string>): Set<string> {
    const expanded = new Set(dirty);
    for (const id of dirty) {
        const parentId = doc.nodes.get(id)?.parent;
        if (parentId && isLayoutContainer(doc.nodes.get(parentId))) {
            expanded.add(parentId);
        }
    }
    return expanded;
}
