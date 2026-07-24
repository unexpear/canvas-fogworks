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
 * SCOPE: a flex stack — row/column, gap, padding, cross-axis align
 * (start/center/end/stretch), intrinsic ("hug") sizing (a container sizes an axis to
 * its contents; see `measureIntrinsicSizes`), AND flex-grow (children fill leftover
 * main-axis space). DEFERRED with their own milestone weight: flex-shrink, wrap, grid,
 * per-child margins, absolute-position escapes, constraints/anchors. See MILESTONES.md.
 */

import { ReadonlyDocument } from "../document/Document";
import { Geometry, LayoutContainer } from "../document/Node";
import { ReadonlyNode } from "../document/SceneGraph";
import { Rect } from "./Matrix";

/** Minimal read-only shape — accepts both `Node` and a `ReadonlyDocument` node. */
type HasLayout = { readonly layout: { readonly container?: unknown } } | undefined;

/** True when this node auto-positions its children. */
export function isLayoutContainer(node: HasLayout): boolean {
    return !!node && node.layout.container !== undefined;
}

/** True when this node is a container that sizes at least one axis to its contents. */
function containerHugs(node: HasLayout): boolean {
    const c = node && (node.layout.container as { hugWidth?: unknown; hugHeight?: unknown } | undefined);
    return !!c && (c.hugWidth === true || c.hugHeight === true);
}

/** A resolved own-size. */
type Size = { width: number; height: number };

/**
 * Bottom-up MEASURE pass: the resolved OWN size of every node, with a hug container's
 * hugged axis folded from its children (`hugWidth`/`hugHeight`).
 *
 * Two properties make this the safe half of intrinsic sizing:
 *  - It reads ONLY stored/pending sizes and container rules — never positions, never a
 *    child's STRETCHED size — so it is an acyclic fold (hug depends on children's
 *    PRE-stretch sizes only) and stays TOTAL: an orphan/cyclic node whose children were
 *    not measured falls back to its own stored size rather than throwing.
 *  - It is run FULLY on every compute (never memoized), so the size layer is
 *    byte-identical between a full recompute and an incremental one — which is what lets
 *    `incremental === full` reduce to the dirty climb in `expandDirtyForLayout`.
 *
 * @param scene nodes in parents-first order (as `traverseSceneGraph` yields them).
 * @param pending in-flight size previews (drag/resize), folded in like stored size.
 */
export function measureIntrinsicSizes(
    scene: readonly ReadonlyNode[],
    pending: ReadonlyMap<string, Partial<Geometry>> | null | undefined
): Map<string, Size> {
    const measured = new Map<string, Size>();
    // Reverse of parents-first = descendants before ancestors: exactly the order a hug
    // fold needs, reusing the single graph walk the caller already did.
    for (let i = scene.length - 1; i >= 0; i--) {
        const node = scene[i];
        const g = node.geometry;
        const p = pending?.get(node.id);
        let width = p?.width ?? g.width;
        let height = p?.height ?? g.height;

        const c = node.layout.container;
        if (c && (c.hugWidth || c.hugHeight)) {
            const row = c.direction === "row";
            const gap = c.gap ?? 0;
            const pad = c.padding ?? 0;
            let mainSum = 0;
            let crossMax = 0;
            let count = 0;
            for (const childId of node.children) {
                const own = measured.get(childId); // already measured (bottom-up)
                if (!own) continue;                // damaged/unmeasured child — skip (stays total)
                mainSum += row ? own.width : own.height;
                crossMax = Math.max(crossMax, row ? own.height : own.width);
                count++;
            }
            const mainHug = 2 * pad + mainSum + gap * Math.max(0, count - 1);
            const crossHug = 2 * pad + crossMax; // empty container → 2*pad
            // Overwrite ONLY the hugged PHYSICAL axis; the other keeps pending ?? stored.
            if (c.hugWidth) width = row ? mainHug : crossHug;
            if (c.hugHeight) height = row ? crossHug : mainHug;
        }
        measured.set(node.id, { width, height });
    }
    return measured;
}

/**
 * Compute the parent-relative rect for each direct child of a container.
 *
 * @param container the parent's layout rule
 * @param parentSize the container's own width/height (already resolved by the measure
 *   pass, so a hug container's size reflects its contents)
 * @param children the child nodes in `parent.children` order, each with its base
 *   (measured) size and optional flex `grow`
 * @returns child id → computed local rect (position always; main size grown to fill
 *   leftover space; cross size only when stretched, else the child's own)
 */
export function layoutChildren(
    container: LayoutContainer,
    parentSize: { width: number; height: number },
    children: readonly { id: string; width: number; height: number; grow?: number }[]
): Map<string, Rect> {
    const gap = container.gap ?? 0;
    const pad = container.padding ?? 0;
    const align = container.alignItems ?? "start";
    const row = container.direction === "row";

    // Axis abstraction: "main" is the packing axis, "cross" is the other.
    const innerMain = (row ? parentSize.width : parentSize.height) - 2 * pad;
    const innerCross = (row ? parentSize.height : parentSize.width) - 2 * pad;

    // Flex-grow: share the LEFTOVER main-axis space among children in proportion to
    // `grow`. No leftover (fixed content, or a main-axis hug where innerMain == used)
    // means everyone keeps their base size; overflow (free < 0) is NOT shrunk here
    // (flex-shrink is deferred). Runs before positioning so `cursor` advances by the
    // grown size. NOTE (intentional, differs from CSS): all free space is distributed by
    // grow ratio, so a lone `grow: 0.5` still fills the row — we do not reserve the
    // (1 - Σgrow) fraction CSS leaves empty when Σgrow < 1. "grow" here means "take my
    // share of the space", not "take my fraction of one unit".
    let usedMain = gap * Math.max(0, children.length - 1);
    let growSum = 0;
    for (const child of children) {
        usedMain += row ? child.width : child.height;
        growSum += Math.max(0, child.grow ?? 0);
    }
    const free = innerMain - usedMain;
    const distribute = free > 0 && growSum > 0;

    const out = new Map<string, Rect>();
    let cursor = pad; // main-axis offset, starts after the leading padding
    for (const child of children) {
        const grow = Math.max(0, child.grow ?? 0);
        const baseMain = row ? child.width : child.height;
        const mainSize = distribute && grow > 0 ? baseMain + free * (grow / growSum) : baseMain;
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
 * Expand a dirty set up the LAYOUT dependency chain, so `computeGeometry` recomputes
 * everything whose position OR computed size a change can move — while a caller still
 * reports only the directly-changed node.
 *
 * For each dirty id, climb its ancestors:
 *  - every layout-container ancestor is added (its child set/sizes shifted, so it must
 *    re-lay-out its children — the SIBLING ripple, now at any depth);
 *  - the climb continues only while the container HUGS, because only a hug container's
 *    OWN size changes when a child resizes. It therefore reaches every hug ancestor AND
 *    the first FIXED container that absorbs the ripple — which is added (its children
 *    reflow) but stops the climb (its size is stable).
 *
 * With no hug flags anywhere this degenerates to the original one-level bump (add the
 * immediate container parent, stop), so the fixed-size behaviour and its tests are
 * unchanged. Each seed climbs with its own `seen` guard because the document may be
 * mid-edit or hand-authored into a cycle, and this walk — unlike `traverseSceneGraph`
 * — is not otherwise cycle-safe.
 */
export function expandDirtyForLayout(doc: ReadonlyDocument, dirty: ReadonlySet<string>): Set<string> {
    const expanded = new Set(dirty);
    for (const id of dirty) {
        const seen = new Set<string>([id]);
        let cursor: string | null | undefined = doc.nodes.get(id)?.parent ?? null;
        while (cursor != null && !seen.has(cursor)) {
            seen.add(cursor);
            const node = doc.nodes.get(cursor);
            if (!node || !isLayoutContainer(node)) break; // non-container absorbs the change
            expanded.add(cursor);
            if (!containerHugs(node)) break;              // fixed container: added, but size stable — stop
            cursor = node.parent ?? null;
        }
    }
    return expanded;
}
