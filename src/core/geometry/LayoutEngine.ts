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
 * SCOPE: a flex stack — row/column, gap, padding, per-child margin, cross-axis align
 * (start/center/end/stretch), intrinsic ("hug") sizing (a container sizes an axis to
 * its contents; see `measureIntrinsicSizes`), flex-grow/shrink (children fill leftover /
 * give up overflow main-axis space), constraints/anchors (`resolveConstraints`),
 * absolute-position escapes (`isAbsolute`), AND a grid (`layoutGridChildren` — auto-flow
 * into px/fr/auto cell tracks with explicit per-row sizes and grid-container hug). Grid
 * `auto` tracks and grid-hug pull grid INTO the bottom-up measure pass (`resolveGridTracks`
 * is the single track-resolver shared by the measure fold and the position pass). DEFERRED
 * with their own milestone weight: flex wrap, explicit grid placement/spans, minmax/
 * fit-content tracks. See MILESTONES.md.
 */

import { ReadonlyDocument } from "../document/Document";
import { Constraints, Geometry, LayoutContainer, LayoutGrid, TrackSize } from "../document/Node";
import { ReadonlyNode } from "../document/SceneGraph";
import { Rect } from "./Matrix";

/** Minimal read-only shape — accepts both `Node` and a `ReadonlyDocument` node. */
type HasLayout = { readonly layout: { readonly container?: unknown; readonly grid?: unknown } } | undefined;

/** True when this node auto-positions its children — a flex container OR a grid. */
export function isLayoutContainer(node: HasLayout): boolean {
    return !!node && (node.layout.container !== undefined || node.layout.grid !== undefined);
}

/** True when this node opts OUT of its parent's flex/grid flow (positioned absolutely). */
export function isAbsolute(node: HasLayout): boolean {
    return !!node && (node.layout as { position?: unknown }).position === "absolute";
}

/** True when this node is a container (flex OR grid) that sizes at least one axis to its contents. */
function containerHugs(node: HasLayout): boolean {
    const c = node && (node.layout.container as { hugWidth?: unknown; hugHeight?: unknown } | undefined);
    if (c && (c.hugWidth === true || c.hugHeight === true)) return true;
    const g = node && (node.layout.grid as { hugWidth?: unknown; hugHeight?: unknown } | undefined);
    return !!g && (g.hugWidth === true || g.hugHeight === true);
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
    const byId = new Map(scene.map(n => [n.id, n])); // for a hug child's margin / absolute flag
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
                const childNode = byId.get(childId);
                if (isAbsolute(childNode)) continue; // out of flow — no contribution to hug size
                const own = measured.get(childId);   // already measured (bottom-up)
                if (!own) continue;                  // damaged/unmeasured child — skip (stays total)
                const m2 = 2 * Math.max(0, childNode?.layout.margin ?? 0);
                mainSum += m2 + (row ? own.width : own.height);
                crossMax = Math.max(crossMax, m2 + (row ? own.height : own.width));
                count++;
            }
            const mainHug = 2 * pad + mainSum + gap * Math.max(0, count - 1);
            const crossHug = 2 * pad + crossMax; // empty container → 2*pad
            // Overwrite ONLY the hugged PHYSICAL axis; the other keeps pending ?? stored.
            if (c.hugWidth) width = row ? mainHug : crossHug;
            if (c.hugHeight) height = row ? crossHug : mainHug;
        }

        // GRID hug: a grid sizes a hugged axis to 2·padding + Σ tracks + gaps, with `auto`
        // tracks folded from the children's measured own-sizes — grid entering the measure
        // pass, exactly like flex hug. Uses the SAME `resolveGridTracks` the position pass
        // uses, so the container's own size equals the sum of the cells it will lay out. The
        // in-flow child set (skip absolute, skip unmeasured, in `children` order) MUST match
        // the position pass's filter or the auto-track flow indices would drift.
        const gr = node.layout.grid;
        if (gr && (gr.hugWidth || gr.hugHeight)) {
            const inFlow: { width: number; height: number }[] = [];
            for (const childId of node.children) {
                const childNode = byId.get(childId);
                if (isAbsolute(childNode)) continue;
                const own = measured.get(childId);
                if (!own) continue;
                inFlow.push(own);
            }
            const pad = gr.padding ?? 0;
            const { colWidths, rowHeights, cols, rows } = resolveGridTracks(gr, inFlow, { width, height });
            if (gr.hugWidth) width = 2 * pad + colWidths.reduce((a, b) => a + b, 0) + (gr.columnGap ?? 0) * Math.max(0, cols - 1);
            if (gr.hugHeight) height = 2 * pad + rowHeights.reduce((a, b) => a + b, 0) + (gr.rowGap ?? 0) * Math.max(0, rows - 1);
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
    children: readonly { id: string; width: number; height: number; grow?: number; shrink?: number; margin?: number }[]
): Map<string, Rect> {
    const gap = container.gap ?? 0;
    const pad = container.padding ?? 0;
    const align = container.alignItems ?? "start";
    const row = container.direction === "row";

    // Axis abstraction: "main" is the packing axis, "cross" is the other.
    const innerMain = (row ? parentSize.width : parentSize.height) - 2 * pad;
    const innerCross = (row ? parentSize.height : parentSize.width) - 2 * pad;

    // Free space drives grow (leftover) OR shrink (overflow), never both — they are
    // mutually exclusive by the sign of `free`. `margin` (uniform per child) is fixed
    // spacing on the main axis (2·margin, before + after) counted into `used` FIRST, so it
    // is never grown or shrunk. Grow distributes leftover by `grow` ratio (NOTE, differs
    // from CSS: all of it, so a lone `grow: 0.5` still fills the row). Shrink distributes
    // the DEFICIT weighted by `shrink × base-main` (CSS-style — bigger items give up more),
    // clamped at 0. No grow/shrink factor ⇒ the child keeps its base size and overflows.
    let usedMain = gap * Math.max(0, children.length - 1);
    let growSum = 0;
    let shrinkWeight = 0;
    for (const child of children) {
        const baseMain = row ? child.width : child.height;
        usedMain += 2 * (child.margin ?? 0) + baseMain;
        growSum += Math.max(0, child.grow ?? 0);
        shrinkWeight += Math.max(0, child.shrink ?? 0) * baseMain;
    }
    const free = innerMain - usedMain;
    const growing = free > 0 && growSum > 0;
    const shrinking = free < 0 && shrinkWeight > 0;

    const out = new Map<string, Rect>();
    let cursor = pad; // main-axis offset, starts after the leading padding
    for (const child of children) {
        const m = Math.max(0, child.margin ?? 0);
        const grow = Math.max(0, child.grow ?? 0);
        const shrink = Math.max(0, child.shrink ?? 0);
        const baseMain = row ? child.width : child.height;
        const mainSize =
            growing && grow > 0 ? baseMain + free * (grow / growSum)
                : shrinking && shrink > 0 ? Math.max(0, baseMain - (-free) * (shrink * baseMain / shrinkWeight))
                    : baseMain;
        const ownCross = row ? child.height : child.width;
        // The child sits in a margin-inset slot: cross span is `innerCross − 2·margin`.
        const availCross = innerCross - 2 * m;
        const crossSize = align === "stretch" ? Math.max(0, availCross) : ownCross;

        let crossOff = 0; // within the available cross, before the leading cross margin
        if (align === "center") crossOff = (availCross - crossSize) / 2;
        else if (align === "end") crossOff = availCross - crossSize;
        const cross = pad + m + crossOff;

        cursor += m; // leading main-axis margin
        out.set(child.id, row
            ? { x: cursor, y: cross, width: mainSize, height: crossSize }
            : { x: cross, y: cursor, width: crossSize, height: mainSize });

        cursor += mainSize + m + gap; // trailing main-axis margin, then the gap
    }
    return out;
}

/**
 * Resolve ONE axis of grid tracks to pixels. `px` tracks take their size; `auto` tracks take
 * their content size (`autoSizes[i]`, the max measured own-size of the children in that track);
 * `fr` tracks share what's left of `available` in proportion to their fraction. `available` is
 * already net of gaps AND of the px/auto tracks conceptually — a NULL `available` means the
 * axis HUGS (no definite size to share), so every `fr` collapses to 0 while px/auto keep their
 * intrinsic size. A negative `available` clamps `fr` to 0 (px/auto still take their size and
 * may overflow). This is the single kernel behind `resolveGridTracks`.
 */
function resolveTracks(tracks: readonly TrackSize[], autoSizes: readonly number[], available: number | null): number[] {
    let fixed = 0;
    let totalFr = 0;
    tracks.forEach((t, i) => {
        if ("px" in t) fixed += Math.max(0, t.px);
        else if ("auto" in t) fixed += Math.max(0, autoSizes[i] ?? 0);
        else totalFr += Math.max(0, t.fr);
    });
    const freeForFr = available === null ? 0 : Math.max(0, available - fixed);
    return tracks.map((t, i) =>
        "px" in t ? Math.max(0, t.px)
            : "auto" in t ? Math.max(0, autoSizes[i] ?? 0)
                : (totalFr > 0 ? freeForFr * (Math.max(0, t.fr) / totalFr) : 0));
}

/**
 * Resolve a grid's column widths and row heights — the SINGLE source of truth, called by BOTH
 * the measure-pass hug fold (to size a hugging grid) and the position pass (to place cells), so
 * a hugged grid's own size is byte-identical to the sum of the cells it lays out.
 *
 * Children auto-flow row-major: child `i` is at column `i % cols`, row `floor(i / cols)`; row
 * COUNT is `ceil(count / cols)`. An `auto` COLUMN sizes to the max own-WIDTH of the children in
 * it, an `auto` ROW to the max own-HEIGHT (the children's PRE-fill measured sizes — never their
 * stretched cell size, which keeps this acyclic, exactly like flex hug). Rows are `rows[r] ??
 * rowHeight` (the schema-10 explicit/implicit split). A hugged axis passes `available = null`,
 * so its `fr` tracks collapse to 0; a non-hugged axis shares its inner size (net of padding+gaps).
 */
export function resolveGridTracks(
    grid: LayoutGrid,
    children: readonly { width: number; height: number }[],
    parentSize: { width: number; height: number }
): { colWidths: number[]; rowHeights: number[]; cols: number; rows: number } {
    const cols = grid.columns.length;
    if (cols === 0) return { colWidths: [], rowHeights: [], cols: 0, rows: 0 };
    const rows = Math.ceil(children.length / cols);
    const colGap = grid.columnGap ?? 0;
    const rowGap = grid.rowGap ?? 0;
    const pad = grid.padding ?? 0;

    const colAuto = new Array<number>(cols).fill(0);
    const rowAuto = new Array<number>(rows).fill(0);
    children.forEach((ch, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        if (ch.width > colAuto[c]) colAuto[c] = ch.width;
        if (ch.height > rowAuto[r]) rowAuto[r] = ch.height;
    });

    const rowTracks: TrackSize[] = [];
    for (let r = 0; r < rows; r++) rowTracks.push(grid.rows?.[r] ?? grid.rowHeight);

    const availW = grid.hugWidth ? null : (parentSize.width - 2 * pad) - colGap * Math.max(0, cols - 1);
    const availH = grid.hugHeight ? null : (parentSize.height - 2 * pad) - rowGap * Math.max(0, rows - 1);

    return {
        colWidths: resolveTracks(grid.columns, colAuto, availW),
        rowHeights: resolveTracks(rowTracks, rowAuto, availH),
        cols,
        rows,
    };
}

/**
 * Compute the cell rect for each child of a GRID container. Children auto-flow row-major and
 * STRETCH to fill their cell, so their stored POSITION is ignored (like a laid-out flex child).
 * Track sizes come from `resolveGridTracks`, which reads the children's measured OWN-sizes for
 * `auto` tracks — so unlike the pre-tail grid this DOES depend on the measure pass (the same
 * `measured` sizes the hug fold used), keeping cells and the container's hug size in lock-step.
 */
export function layoutGridChildren(
    grid: LayoutGrid,
    parentSize: { width: number; height: number },
    children: readonly { id: string; width: number; height: number }[]
): Map<string, Rect> {
    const out = new Map<string, Rect>();
    const cols = grid.columns.length;
    if (cols === 0) return out;
    const colGap = grid.columnGap ?? 0;
    const rowGap = grid.rowGap ?? 0;
    const pad = grid.padding ?? 0;
    const { colWidths, rowHeights, rows } = resolveGridTracks(grid, children, parentSize);

    const colX: number[] = [];
    let x = pad;
    for (let c = 0; c < cols; c++) { colX[c] = x; x += colWidths[c] + colGap; }
    const rowY: number[] = [];
    let y = pad;
    for (let r = 0; r < rows; r++) { rowY[r] = y; y += rowHeights[r] + rowGap; }

    children.forEach((ch, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        out.set(ch.id, { x: colX[col], y: rowY[row], width: colWidths[col], height: rowHeights[row] });
    });
    return out;
}

/** Normalised anchor kind, shared by the horizontal and vertical axes. */
type AxisKind = "start" | "end" | "both" | "center" | "scale";
const H_KIND: Record<string, AxisKind> = { left: "start", right: "end", "left-right": "both", center: "center", scale: "scale" };
const V_KIND: Record<string, AxisKind> = { top: "start", bottom: "end", "top-bottom": "both", center: "center", scale: "scale" };

/**
 * One axis of a constraint. `p0`/`s0` are the child's stored position/size on that axis,
 * `R` the FROZEN reference parent extent, `C` the current parent extent. Returns
 * `[position, size]`. `R <= 0` falls back to static (and guards `scale`'s divide).
 */
function resolveAxis(kind: AxisKind, p0: number, s0: number, R: number, C: number): [number, number] {
    if (!(R > 0)) return [p0, s0];
    const d = C - R;
    switch (kind) {
        case "end": return [p0 + d, s0];               // pin the trailing edge — move with it
        case "both": return [p0, Math.max(0, s0 + d)]; // pin both edges — stretch
        case "center": return [p0 + d / 2, s0];        // keep centred
        case "scale": { const f = C / R; return [p0 * f, Math.max(0, s0 * f)]; }
        default: return [p0, s0];                      // "start" — pin the leading edge (static)
    }
}

/**
 * Reposition a constrained child of a PLAIN parent. `stored` is the child's rest rect;
 * `ref` the frozen parent size it is at rest against; `parentSize` the parent's CURRENT
 * resolved size. `delta = parentSize − ref`, so a child responds to a parent resize from
 * EITHER source (a direct resize moves the parent's computed size while `ref` stays; a
 * layout-driven resize does the same) — one formula, no stored-vs-computed ambiguity.
 * Constraints/ref absent → `stored` unchanged (static left/top = the pre-M2 behavior).
 */
export function resolveConstraints(
    stored: Rect,
    constraints: Constraints | undefined,
    ref: { width: number; height: number } | undefined,
    parentSize: { width: number; height: number }
): Rect {
    if (!constraints || !ref) return stored;
    const hk = H_KIND[constraints.horizontal ?? "left"] ?? "start";
    const vk = V_KIND[constraints.vertical ?? "top"] ?? "start";
    const [x, width] = resolveAxis(hk, stored.x, stored.width, ref.width, parentSize.width);
    const [y, height] = resolveAxis(vk, stored.y, stored.height, ref.height, parentSize.height);
    return { x, y, width, height };
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
