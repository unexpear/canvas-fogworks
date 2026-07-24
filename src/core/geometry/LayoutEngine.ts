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
 * (start/center/end/stretch), WRAP (multi-line flow, per-line grow/shrink, cross-hug summing
 * the lines — `breakFlexLines`), intrinsic ("hug") sizing (a container sizes an axis to
 * its contents; see `measureIntrinsicSizes`), flex-grow/shrink (children fill leftover /
 * give up overflow main-axis space), constraints/anchors (`resolveConstraints`),
 * absolute-position escapes (`isAbsolute`), AND a grid (`layoutGridChildren` — auto-flow
 * into px/fr/auto cell tracks with explicit per-row sizes and grid-container hug). Wrap and
 * grid `auto`/hug pull flex/grid INTO the bottom-up measure pass, each via a single resolver
 * (`breakFlexLines` / `resolveGridTracks`) shared by the measure fold and the position pass.
 * DEFERRED with their own milestone weight: align-content / wrap-reverse, explicit grid
 * placement/spans, minmax/fit-content tracks. See MILESTONES.md.
 */

import { ReadonlyDocument } from "../document/Document";
import { Constraints, Geometry, GRID_MAX_TRACKS, GRID_SPAN_MAX, LayoutContainer, LayoutGrid, TrackSize } from "../document/Node";
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
            const items: { main: number; cross: number; margin: number }[] = [];
            let mainSum = 0;
            for (const childId of node.children) {
                const childNode = byId.get(childId);
                if (isAbsolute(childNode)) continue; // out of flow — no contribution to hug size
                const own = measured.get(childId);   // already measured (bottom-up)
                if (!own) continue;                  // damaged/unmeasured child — skip (stays total)
                const m = Math.max(0, childNode?.layout.margin ?? 0);
                const cm = row ? own.width : own.height;
                const cc = row ? own.height : own.width;
                items.push({ main: cm, cross: cc, margin: m });
                mainSum += 2 * m + cm;
            }
            const mainHug = 2 * pad + mainSum + gap * Math.max(0, items.length - 1);
            // WRAP: the cross axis hugs the STACKED lines. Inert when the MAIN axis hugs (no
            // definite main to wrap against). Uses the SAME `breakFlexLines` the position pass
            // uses, against the container's OWN (pre-override) main size — so crossHug equals
            // the laid-out stack by construction. Non-wrap keeps today's single-line crossMax.
            const effectiveWrap = c.wrap === true && !(row ? c.hugWidth : c.hugHeight);
            let crossHug: number;
            if (effectiveWrap) {
                const lines = breakFlexLines(items, (row ? width : height) - 2 * pad, gap, true);
                let crossSum = 0;
                for (const ln of lines) crossSum += ln.cross;
                crossHug = 2 * pad + crossSum + gap * Math.max(0, lines.length - 1);
            } else {
                let crossMax = 0;
                for (const it of items) crossMax = Math.max(crossMax, 2 * it.margin + it.cross);
                crossHug = 2 * pad + crossMax; // empty container → 2*pad
            }
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
            const inFlow: { width: number; height: number; colSpan?: number; rowSpan?: number }[] = [];
            for (const childId of node.children) {
                const childNode = byId.get(childId);
                if (isAbsolute(childNode)) continue;
                const own = measured.get(childId);
                if (!own) continue;
                inFlow.push({ width: own.width, height: own.height, colSpan: childNode?.layout.colSpan, rowSpan: childNode?.layout.rowSpan });
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

/** One wrapped flex line: indices into the caller's item list, and the line's cross extent. */
export interface FlexLine {
    /** indices into the `items` array passed to `breakFlexLines`, in packing order. */
    items: number[];
    /** the line's cross size = max over its items of `2·margin + item.cross`. */
    cross: number;
}

/**
 * Break flex children into lines — the SINGLE line-breaker shared by the measure cross-hug
 * fold and the position pass, so a wrapping container's own cross size equals the stack it
 * lays out (the grid lesson: one resolver called both places cannot drift).
 *
 * Children pack along the main axis in order; a new line starts when the current line is
 * NON-EMPTY and adding the next item (its `2·margin + main`, plus one `gap`) would exceed
 * `innerMain` (strict `>`, so an exact fit stays). The FIRST item on a line always stays, even
 * if it alone overflows. `wrap === false` returns a single line holding every item — the
 * nowrap path, byte-identical to the pre-wrap single stack. Pure and TOTAL (never throws): an
 * empty list returns `[]`, and every line has ≥1 item, so there is no division or bounds hazard.
 */
export function breakFlexLines(
    items: readonly { main: number; cross: number; margin: number }[],
    innerMain: number,
    gap: number,
    wrap: boolean
): FlexLine[] {
    const lineIdx: number[][] = [];
    let cur: number[] | null = null;
    let curMain = 0;
    for (let i = 0; i < items.length; i++) {
        const itemMain = 2 * Math.max(0, items[i].margin) + items[i].main;
        if (cur === null) {
            cur = [i]; curMain = itemMain; lineIdx.push(cur);
        } else if (wrap && curMain + gap + itemMain > innerMain) {
            cur = [i]; curMain = itemMain; lineIdx.push(cur);   // start a new line
        } else {
            cur.push(i); curMain += gap + itemMain;
        }
    }
    return lineIdx.map(idxs => {
        let cross = 0;
        for (const idx of idxs) {
            const c = 2 * Math.max(0, items[idx].margin) + items[idx].cross;
            if (c > cross) cross = c;
        }
        return { items: idxs, cross };
    });
}

/**
 * Compute the parent-relative rect for each direct child of a container.
 *
 * @param container the parent's layout rule
 * @param parentSize the container's own width/height (already resolved by the measure
 *   pass, so a hug container's size reflects its contents; for a WRAP container the caller
 *   passes the container's MEASURED own main so line-breaking matches the measure fold)
 * @param children the child nodes in `parent.children` order, each with its base
 *   (measured) size and optional flex `grow`/`shrink`/`margin`
 * @returns child id → computed local rect (position always; main size grown/shrunk per line;
 *   cross size only when stretched, else the child's own)
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
    const mainOf = (c: { width: number; height: number }) => row ? c.width : c.height;
    const crossOf = (c: { width: number; height: number }) => row ? c.height : c.width;

    // WRAP is inert when the MAIN axis hugs — a hugged main has no definite size to wrap
    // against (like `grow` under a hugged main); the same expression the measure fold uses,
    // so both passes break into the SAME lines.
    const effectiveWrap = container.wrap === true && !(row ? container.hugWidth : container.hugHeight);
    const items = children.map(c => ({ main: mainOf(c), cross: crossOf(c), margin: Math.max(0, c.margin ?? 0) }));
    const lines = breakFlexLines(items, innerMain, gap, effectiveWrap);
    const singleLine = lines.length <= 1;

    const out = new Map<string, Rect>();
    let crossCursor = pad; // cross-axis offset of the current line's leading edge
    for (const line of lines) {
        // Free space drives grow (leftover) OR shrink (overflow), computed PER LINE — each
        // line distributes its own slack (CSS wrap behaviour). `margin` (2·margin, before +
        // after) is counted into `used` FIRST, so it is never grown or shrunk. Grow takes all
        // the leftover by `grow` ratio (differs from CSS: a lone `grow: 0.5` still fills the
        // line); shrink gives up the DEFICIT weighted by `shrink × base-main`, clamped at 0.
        let usedMain = gap * Math.max(0, line.items.length - 1);
        let growSum = 0;
        let shrinkWeight = 0;
        for (const idx of line.items) {
            const c = children[idx];
            const baseMain = mainOf(c);
            usedMain += 2 * Math.max(0, c.margin ?? 0) + baseMain;
            growSum += Math.max(0, c.grow ?? 0);
            shrinkWeight += Math.max(0, c.shrink ?? 0) * baseMain;
        }
        const free = innerMain - usedMain;
        const growing = free > 0 && growSum > 0;
        const shrinking = free < 0 && shrinkWeight > 0;
        // A SINGLE line fills the container's cross (nowrap-preserving, and CSS-correct — a
        // lone flex line stretches to the container); multi-line children sit in their own
        // line's cross band. This keeps every pre-wrap layout byte-identical.
        const bandCross = singleLine ? innerCross : line.cross;

        let cursor = pad; // main-axis offset, reset at each line
        for (const idx of line.items) {
            const c = children[idx];
            const m = Math.max(0, c.margin ?? 0);
            const grow = Math.max(0, c.grow ?? 0);
            const shrink = Math.max(0, c.shrink ?? 0);
            const baseMain = mainOf(c);
            const mainSize =
                growing && grow > 0 ? baseMain + free * (grow / growSum)
                    : shrinking && shrink > 0 ? Math.max(0, baseMain - (-free) * (shrink * baseMain / shrinkWeight))
                        : baseMain;
            const ownCross = crossOf(c);
            const availCross = bandCross - 2 * m;
            const crossSize = align === "stretch" ? Math.max(0, availCross) : ownCross;

            let crossOff = 0; // within the available cross, before the leading cross margin
            if (align === "center") crossOff = (availCross - crossSize) / 2;
            else if (align === "end") crossOff = availCross - crossSize;
            const cross = crossCursor + m + crossOff;

            cursor += m; // leading main-axis margin
            out.set(c.id, row
                ? { x: cursor, y: cross, width: mainSize, height: crossSize }
                : { x: cross, y: cursor, width: crossSize, height: mainSize });

            cursor += mainSize + m + gap; // trailing main-axis margin, then the gap
        }
        crossCursor += bandCross + gap; // next line stacks below this one (align-content deferred)
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

/** One item's grid placement: its top-left cell and how many columns/rows it occupies. */
export interface GridCell {
    col: number;
    row: number;
    colSpan: number;
    rowSpan: number;
}

/**
 * CSS-style SPARSE auto-placement — the single placement authority shared (via `resolveGridTracks`)
 * by the measure fold and the position pass, so a hugging grid's row count and its laid-out cells
 * cannot drift. A forward-only, row-major cursor gives each item the next FREE `colSpan × rowSpan`
 * block, skipping cells already occupied by earlier items' spans; the cursor never backtracks
 * (sparse packing — earlier gaps are not backfilled).
 *
 * `colSpan` is clamped to `[1, cols]`, `rowSpan` to `[1, GRID_SPAN_MAX]`, and the DERIVED row count is
 * capped at `GRID_MAX_TRACKS` — so with the column count also capped on validation, the occupancy set
 * stays bounded by `GRID_MAX_TRACKS²` and can never OOM or hit the runtime `Set`-size limit, even on a
 * hand-edited grid with a huge column count or many wide-spanning children (which the per-item
 * `GRID_SPAN_MAX` cap alone does NOT bound — the occupancy is `Σ colSpan·rowSpan`, not the row count).
 * Items that would land past the cap are piled into the last band (bounded, deterministic, no mark).
 * Pure and TOTAL: reads only integers, uses a sparse `Set` (never `new Array(rows)`), and terminates
 * (each scan advances row-major within the cap); returns `{ cells: [], rows: 0 }` for a 0-column/empty grid.
 *
 * @returns `cells` index-aligned with `items`, and `rows` = `max(cell.row + cell.rowSpan)` (≤ GRID_MAX_TRACKS).
 */
export function placeGridItems(
    items: readonly { colSpan?: number; rowSpan?: number }[],
    cols: number
): { cells: GridCell[]; rows: number } {
    if (cols <= 0) return { cells: [], rows: 0 };
    // The derived row count is bounded so `cols × rowsCap` (the occupancy) can't exhaust memory.
    const rowsCap = Math.max(1, Math.floor((GRID_MAX_TRACKS * GRID_MAX_TRACKS) / cols));
    const occ = new Set<number>();
    const cells: GridCell[] = [];
    let cursorRow = 0;
    let cursorCol = 0;
    let rows = 0;
    for (const item of items) {
        const cs = Math.min(cols, Math.max(1, Math.floor(item.colSpan ?? 1)));
        const rs = Math.min(rowsCap, Math.min(GRID_SPAN_MAX, Math.max(1, Math.floor(item.rowSpan ?? 1))));
        // Scan row-major from the cursor for the first free cs×rs block.
        let r = cursorRow;
        let c = cursorCol;
        let capped = false;
        for (; ;) {
            if (r + rs > rowsCap) { r = rowsCap - rs; c = 0; capped = true; break; } // cap: pile into the last band
            if (c + cs > cols) { r++; c = 0; continue; } // never straddle the right edge
            let free = true;
            for (let dr = 0; dr < rs && free; dr++)
                for (let dc = 0; dc < cs; dc++)
                    if (occ.has((r + dr) * cols + (c + dc))) { free = false; break; }
            if (free) break;
            c++;
        }
        // Skip marking a capped (piled) item — its cells are already occupied / an overflow band,
        // so total marking stays bounded by GRID_MAX_TRACKS² regardless of the child count.
        if (!capped)
            for (let dr = 0; dr < rs; dr++)
                for (let dc = 0; dc < cs; dc++)
                    occ.add((r + dr) * cols + (c + dc));
        cells.push({ col: c, row: r, colSpan: cs, rowSpan: rs });
        if (r + rs > rows) rows = r + rs;
        // Advance the cursor forward-only, past the placed item (sparse — no backfill).
        cursorRow = r;
        cursorCol = c + cs;
        if (cursorCol >= cols) { cursorRow = r + 1; cursorCol = 0; }
    }
    return { cells, rows };
}

/**
 * Resolve a grid's column widths and row heights — the SINGLE source of truth, called by BOTH
 * the measure-pass hug fold (to size a hugging grid) and the position pass (to place cells), so
 * a hugged grid's own size is byte-identical to the sum of the cells it lays out.
 *
 * Children auto-flow via `placeGridItems` (sparse span-aware placement); row COUNT is DERIVED
 * from that (a `rowSpan` can push it past `ceil(count / cols)`). An `auto` COLUMN sizes to the max
 * own-WIDTH of the SINGLE-column-span children in it, an `auto` ROW to the max own-HEIGHT of the
 * single-row-span children (a SPANNING item drives no auto track — CSS's first sizing pass; the
 * children's PRE-fill measured sizes, never stretched, keep this acyclic like flex hug). Rows are
 * `rows[r] ?? rowHeight` (the schema-10 split). A hugged axis passes `available = null`, so its `fr`
 * tracks collapse to 0; a non-hugged axis shares its inner size (net of padding+gaps). Returns the
 * placement `cells` so the position pass reuses this exact placement rather than re-deriving it.
 */
export function resolveGridTracks(
    grid: LayoutGrid,
    children: readonly { width: number; height: number; colSpan?: number; rowSpan?: number }[],
    parentSize: { width: number; height: number }
): { colWidths: number[]; rowHeights: number[]; cols: number; rows: number; cells: GridCell[] } {
    const cols = grid.columns.length;
    if (cols === 0) return { colWidths: [], rowHeights: [], cols: 0, rows: 0, cells: [] };
    const { cells, rows } = placeGridItems(children, cols);
    const colGap = grid.columnGap ?? 0;
    const rowGap = grid.rowGap ?? 0;
    const pad = grid.padding ?? 0;

    const colAuto = new Array<number>(cols).fill(0);
    const rowAuto = new Array<number>(rows).fill(0);
    children.forEach((ch, i) => {
        const cell = cells[i];
        if (cell.colSpan === 1 && ch.width > colAuto[cell.col]) colAuto[cell.col] = ch.width;
        if (cell.rowSpan === 1 && ch.height > rowAuto[cell.row]) rowAuto[cell.row] = ch.height;
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
        cells,
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
    children: readonly { id: string; width: number; height: number; colSpan?: number; rowSpan?: number }[]
): Map<string, Rect> {
    const out = new Map<string, Rect>();
    const cols = grid.columns.length;
    if (cols === 0) return out;
    const colGap = grid.columnGap ?? 0;
    const rowGap = grid.rowGap ?? 0;
    const pad = grid.padding ?? 0;
    // The SAME `resolveGridTracks` the hug fold used — reuse its placement `cells` so the cells
    // laid out here match the container's hugged size exactly (no re-derivation, no drift).
    const { colWidths, rowHeights, rows, cells } = resolveGridTracks(grid, children, parentSize);

    const colX: number[] = [];
    let x = pad;
    for (let c = 0; c < cols; c++) { colX[c] = x; x += colWidths[c] + colGap; }
    const rowY: number[] = [];
    let y = pad;
    for (let r = 0; r < rows; r++) { rowY[r] = y; y += rowHeights[r] + rowGap; }

    children.forEach((ch, i) => {
        const cell = cells[i];
        // A spanning cell covers its tracks PLUS the internal gaps between them.
        let width = (cell.colSpan - 1) * colGap;
        for (let k = 0; k < cell.colSpan; k++) width += colWidths[cell.col + k];
        let height = (cell.rowSpan - 1) * rowGap;
        for (let k = 0; k < cell.rowSpan; k++) height += rowHeights[cell.row + k];
        out.set(ch.id, { x: colX[cell.col], y: rowY[cell.row], width, height });
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
