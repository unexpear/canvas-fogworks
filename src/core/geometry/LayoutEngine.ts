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
import { Constraints, Geometry, GRID_MAX_TRACKS, GRID_SPAN_MAX, LayoutContainer, LayoutGrid, Margins, TrackSize } from "../document/Node";
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
            const items: { main: number; cross: number; marginMain: number; marginCross: number }[] = [];
            let mainSum = 0;
            for (const childId of node.children) {
                const childNode = byId.get(childId);
                if (isAbsolute(childNode)) continue; // out of flow — no contribution to hug size
                const own = measured.get(childId);   // already measured (bottom-up)
                if (!own) continue;                  // damaged/unmeasured child — skip (stays total)
                const lm = logicalMargin(resolveMargin(childNode?.layout.margin), row);
                const cm = row ? own.width : own.height;
                const cc = row ? own.height : own.width;
                const marginMain = lm.mainBefore + lm.mainAfter;
                items.push({ main: cm, cross: cc, marginMain, marginCross: lm.crossBefore + lm.crossAfter });
                mainSum += marginMain + cm;
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
                for (const it of items) crossMax = Math.max(crossMax, it.marginCross + it.cross);
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
            const inFlow: { width: number; height: number; colSpan?: number; rowSpan?: number; margin?: number | Margins; gridColumn?: readonly [number, number]; gridRow?: readonly [number, number] }[] = [];
            for (const childId of node.children) {
                const childNode = byId.get(childId);
                if (isAbsolute(childNode)) continue;
                const own = measured.get(childId);
                if (!own) continue;
                inFlow.push({ width: own.width, height: own.height, colSpan: childNode?.layout.colSpan, rowSpan: childNode?.layout.rowSpan, margin: childNode?.layout.margin, gridColumn: childNode?.layout.gridColumn, gridRow: childNode?.layout.gridRow });
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

/** A resolved per-side margin (physical sides, each ≥ 0). */
type PhysicalMargin = { top: number; right: number; bottom: number; left: number };

/** Resolve `Layout.margin` (a uniform number or a per-side object) to explicit physical sides (each ≥ 0). */
export function resolveMargin(m: number | Margins | undefined): PhysicalMargin {
    if (typeof m === "number") { const v = Math.max(0, m); return { top: v, right: v, bottom: v, left: v }; }
    return {
        top: Math.max(0, m?.top ?? 0),
        right: Math.max(0, m?.right ?? 0),
        bottom: Math.max(0, m?.bottom ?? 0),
        left: Math.max(0, m?.left ?? 0),
    };
}

/**
 * Map physical margins to a flex container's LOGICAL axes by `direction`. For a `row` the main
 * axis is horizontal (before = left, after = right) and the cross is vertical; for a `column` the
 * main axis is vertical (before = top, after = bottom) and the cross is horizontal. The measure
 * fold and the position pass BOTH map through this, so a hugged container's size and its laid-out
 * children agree on where each margin lands.
 */
function logicalMargin(pm: PhysicalMargin, row: boolean): { mainBefore: number; mainAfter: number; crossBefore: number; crossAfter: number } {
    return row
        ? { mainBefore: pm.left, mainAfter: pm.right, crossBefore: pm.top, crossAfter: pm.bottom }
        : { mainBefore: pm.top, mainAfter: pm.bottom, crossBefore: pm.left, crossAfter: pm.right };
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
 * NON-EMPTY and adding the next item (its `marginMain + main`, plus one `gap`) would exceed
 * `innerMain` (strict `>`, so an exact fit stays). The FIRST item on a line always stays, even
 * if it alone overflows. `wrap === false` returns a single line holding every item — the
 * nowrap path, byte-identical to the pre-wrap single stack. `marginMain`/`marginCross` are the
 * before+after margin TOTALS on each axis (already mapped from the physical sides by direction).
 * Pure and TOTAL (never throws): an empty list returns `[]`, and every line has ≥1 item.
 */
export function breakFlexLines(
    items: readonly { main: number; cross: number; marginMain: number; marginCross: number }[],
    innerMain: number,
    gap: number,
    wrap: boolean
): FlexLine[] {
    const lineIdx: number[][] = [];
    let cur: number[] | null = null;
    let curMain = 0;
    for (let i = 0; i < items.length; i++) {
        const itemMain = Math.max(0, items[i].marginMain) + items[i].main;
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
            const c = Math.max(0, items[idx].marginCross) + items[idx].cross;
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
    children: readonly { id: string; width: number; height: number; grow?: number; shrink?: number; margin?: number | Margins }[]
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

    // Per-child LOGICAL margins (physical sides mapped by direction — the position pass and the
    // measure fold map identically, so a hugged container agrees with its children).
    const margins = children.map(c => logicalMargin(resolveMargin(c.margin), row));
    // WRAP is inert when the MAIN axis hugs — a hugged main has no definite size to wrap
    // against (like `grow` under a hugged main); the same expression the measure fold uses,
    // so both passes break into the SAME lines.
    const effectiveWrap = container.wrap === true && !(row ? container.hugWidth : container.hugHeight);
    const items = children.map((c, i) => ({ main: mainOf(c), cross: crossOf(c), marginMain: margins[i].mainBefore + margins[i].mainAfter, marginCross: margins[i].crossBefore + margins[i].crossAfter }));
    const lines = breakFlexLines(items, innerMain, gap, effectiveWrap);
    const singleLine = lines.length <= 1;

    // ALIGN-CONTENT distributes the wrapped LINES in the leftover cross space — a no-op for a
    // single line, or when the container CROSS-HUGS (freeCross == 0, since it sized itself to the
    // lines). WRAP-REVERSE then reflects the whole cross layout so lines stack from the far edge
    // (which also flips per-line alignItems and align-content, matching CSS). Both are pure
    // position-pass arithmetic downstream of the shared `breakFlexLines` — the measure fold is
    // untouched, so hug-size still equals the laid-out extent.
    const alignContent = container.alignContent ?? "start";
    const n = lines.length;
    let contentCross = gap * Math.max(0, n - 1);
    for (const ln of lines) contentCross += ln.cross;
    const freeCross = Math.max(0, innerCross - contentCross);
    let leadOff = 0;      // extra cross offset before the first line
    let betweenExtra = 0; // extra cross spacing added between lines
    let bandGrow = 0;     // extra cross size added to each line's band (align-content: stretch)
    if (!singleLine && freeCross > 0) {
        if (alignContent === "center") leadOff = freeCross / 2;
        else if (alignContent === "end") leadOff = freeCross;
        else if (alignContent === "space-between") betweenExtra = freeCross / (n - 1);
        else if (alignContent === "space-around") { leadOff = freeCross / (2 * n); betweenExtra = freeCross / n; }
        else if (alignContent === "stretch") bandGrow = freeCross / n;
        // "start" → all zero (the pre-align-content behaviour)
    }
    const reverse = effectiveWrap && container.wrapReverse === true;

    const out = new Map<string, Rect>();
    let crossCursor = pad + leadOff; // cross-axis offset of the current line's leading edge
    for (const line of lines) {
        // Free space drives grow (leftover) OR shrink (overflow), computed PER LINE — each
        // line distributes its own slack (CSS wrap behaviour). Each child's main margins
        // (before + after) are counted into `used` FIRST, so they are never grown or shrunk.
        // Grow takes all the leftover by `grow` ratio (differs from CSS: a lone `grow: 0.5`
        // still fills the line); shrink gives up the DEFICIT weighted by `shrink × base-main`.
        let usedMain = gap * Math.max(0, line.items.length - 1);
        let growSum = 0;
        let shrinkWeight = 0;
        for (const idx of line.items) {
            const c = children[idx];
            const baseMain = mainOf(c);
            usedMain += margins[idx].mainBefore + margins[idx].mainAfter + baseMain;
            growSum += Math.max(0, c.grow ?? 0);
            shrinkWeight += Math.max(0, c.shrink ?? 0) * baseMain;
        }
        const free = innerMain - usedMain;
        const growing = free > 0 && growSum > 0;
        const shrinking = free < 0 && shrinkWeight > 0;
        // A SINGLE line fills the container's cross (nowrap-preserving, and CSS-correct — a
        // lone flex line stretches to the container); multi-line children sit in their own
        // line's cross band. This keeps every pre-wrap layout byte-identical.
        const bandCross = singleLine ? innerCross : line.cross + bandGrow;

        let cursor = pad; // main-axis offset, reset at each line
        for (const idx of line.items) {
            const c = children[idx];
            const lm = margins[idx];
            const grow = Math.max(0, c.grow ?? 0);
            const shrink = Math.max(0, c.shrink ?? 0);
            const baseMain = mainOf(c);
            const mainSize =
                growing && grow > 0 ? baseMain + free * (grow / growSum)
                    : shrinking && shrink > 0 ? Math.max(0, baseMain - (-free) * (shrink * baseMain / shrinkWeight))
                        : baseMain;
            const ownCross = crossOf(c);
            const availCross = bandCross - lm.crossBefore - lm.crossAfter;
            const crossSize = align === "stretch" ? Math.max(0, availCross) : ownCross;

            let crossOff = 0; // within the available cross, before the leading cross margin
            if (align === "center") crossOff = (availCross - crossSize) / 2;
            else if (align === "end") crossOff = availCross - crossSize;
            // WRAP-REVERSE reflects the child's whole cross rect across the container's inner cross.
            const cross = reverse
                ? 2 * pad + innerCross - (crossCursor + lm.crossBefore + crossOff) - crossSize
                : crossCursor + lm.crossBefore + crossOff;

            cursor += lm.mainBefore; // leading main-axis margin
            out.set(c.id, row
                ? { x: cursor, y: cross, width: mainSize, height: crossSize }
                : { x: cross, y: cursor, width: crossSize, height: mainSize });

            cursor += mainSize + lm.mainAfter + gap; // trailing main-axis margin, then the gap
        }
        crossCursor += bandCross + gap + betweenExtra; // next line, plus any align-content spacing
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
 * `dense` backfills earlier gaps (each item scans from the origin rather than the forward cursor).
 * @returns `cells` index-aligned with `items`, and `rows` = `max(cell.row + cell.rowSpan)` (≤ GRID_MAX_TRACKS).
 */
function placeRowMajor(
    items: readonly { colSpan?: number; rowSpan?: number; explicit?: { col: number; colSpan: number; row: number; rowSpan: number } }[],
    cols: number,
    dense: boolean
): { cells: GridCell[]; rows: number } {
    if (cols <= 0) return { cells: [], rows: 0 };
    // The derived row count is bounded so `cols × rowsCap` (the occupancy) can't exhaust memory.
    const rowsCap = Math.max(1, Math.floor((GRID_MAX_TRACKS * GRID_MAX_TRACKS) / cols));
    const occ = new Set<number>();
    const cells: GridCell[] = new Array(items.length); // pre-sized: explicit + auto passes fill by index
    let rows = 0;
    // PRE-PASS: pin EXPLICITLY-placed items first (clamped into the grid), so auto items flow AROUND
    // them. Explicit items may overlap each other (CSS stacks them) — bounded by the same caps.
    items.forEach((item, i) => {
        const e = item.explicit;
        if (!e) return;
        const col = Math.min(Math.max(0, e.col), cols - 1);
        const colSpan = Math.min(Math.max(1, e.colSpan), cols - col);
        const rowSpan0 = Math.min(rowsCap, Math.max(1, e.rowSpan));
        const row = Math.min(Math.max(0, e.row), rowsCap - rowSpan0);
        const rowSpan = Math.min(rowSpan0, rowsCap - row);
        for (let dr = 0; dr < rowSpan; dr++)
            for (let dc = 0; dc < colSpan; dc++)
                occ.add((row + dr) * cols + (col + dc));
        cells[i] = { col, row, colSpan, rowSpan };
        if (row + rowSpan > rows) rows = row + rowSpan;
    });
    // AUTO pass: place non-explicit items, skipping the already-marked explicit cells.
    let cursorRow = 0;
    let cursorCol = 0;
    items.forEach((item, i) => {
        if (item.explicit) return; // already pinned above
        const cs = Math.min(cols, Math.max(1, Math.floor(item.colSpan ?? 1)));
        const rs = Math.min(rowsCap, Math.min(GRID_SPAN_MAX, Math.max(1, Math.floor(item.rowSpan ?? 1))));
        // DENSE scans from the origin (backfilling earlier gaps); sparse scans from the forward cursor.
        let r = dense ? 0 : cursorRow;
        let c = dense ? 0 : cursorCol;
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
        cells[i] = { col: c, row: r, colSpan: cs, rowSpan: rs };
        if (r + rs > rows) rows = r + rs;
        // Advance the cursor forward-only, past the placed item (sparse — no backfill).
        cursorRow = r;
        cursorCol = c + cs;
        if (cursorCol >= cols) { cursorRow = r + 1; cursorCol = 0; }
    });
    return { cells, rows };
}

/**
 * Grid auto-placement, the single placement authority shared by the measure fold and the position
 * pass. `primaryCount` is the FIXED-axis track count (columns for row-flow, rows for column-flow);
 * the other axis is DERIVED and returned. COLUMN flow is the exact transpose of row flow — fill
 * down-then-across == fill the transposed grid right-then-down — so it reuses `placeRowMajor`
 * verbatim (swap colSpan↔rowSpan in, swap col↔row out) rather than a second algorithm.
 *
 * @returns `cells` index-aligned with `items`, plus BOTH `rows` and `cols` (one is `primaryCount`,
 *   the other derived), so callers read whichever axis they need.
 */
export function placeGridItems(
    items: readonly { colSpan?: number; rowSpan?: number; gridColumn?: readonly [number, number]; gridRow?: readonly [number, number] }[],
    primaryCount: number,
    opts?: { columnFlow?: boolean; dense?: boolean }
): { cells: GridCell[]; rows: number; cols: number } {
    const dense = opts?.dense === true;
    if (opts?.columnFlow) {
        // Explicit line placement is deferred under column flow — items auto-flow (spans transposed).
        const transposed = items.map(it => ({ colSpan: it.rowSpan, rowSpan: it.colSpan }));
        const k = placeRowMajor(transposed, primaryCount, dense); // primaryCount = FIXED row count
        const cells = k.cells.map(cell => ({ col: cell.row, row: cell.col, colSpan: cell.rowSpan, rowSpan: cell.colSpan }));
        // Empty grid → 0×0 (padding-only hug), mirroring row-flow's empty case; else the fixed row
        // count stands and `k.rows` (the transpose's derived rows) is the derived COLUMN count.
        return cells.length === 0 ? { cells, rows: 0, cols: 0 } : { cells, rows: primaryCount, cols: k.rows };
    }
    // Row flow: an item with BOTH grid lines is pinned (end-exclusive lines → 0-indexed col/row +
    // span); placeRowMajor clamps to the grid and marks it before the auto items flow around it.
    const resolved = items.map(it => (it.gridColumn && it.gridRow)
        ? {
            colSpan: it.colSpan, rowSpan: it.rowSpan,
            explicit: {
                col: it.gridColumn[0] - 1, colSpan: it.gridColumn[1] - it.gridColumn[0],
                row: it.gridRow[0] - 1, rowSpan: it.gridRow[1] - it.gridRow[0],
            },
        }
        : { colSpan: it.colSpan, rowSpan: it.rowSpan });
    const k = placeRowMajor(resolved, primaryCount, dense); // primaryCount = FIXED column count
    return { cells: k.cells, rows: k.rows, cols: primaryCount };
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
    children: readonly { width: number; height: number; colSpan?: number; rowSpan?: number; margin?: number | Margins; gridColumn?: readonly [number, number]; gridRow?: readonly [number, number] }[],
    parentSize: { width: number; height: number }
): { colWidths: number[]; rowHeights: number[]; cols: number; rows: number; cells: GridCell[] } {
    if (grid.columns.length === 0) return { colWidths: [], rowHeights: [], cols: 0, rows: 0, cells: [] };
    const colGap = grid.columnGap ?? 0;
    const rowGap = grid.rowGap ?? 0;
    const pad = grid.padding ?? 0;
    // auto-flow: "row" (default) fixes the columns and derives the rows; "column" fixes the rows
    // (from `grid.rows`, default 1) and derives the columns; "dense" backfills gaps.
    const flow = grid.autoFlow ?? "row";
    const dense = flow.includes("dense");
    const columnFlow = flow.startsWith("column");
    const { cells, cols, rows } = columnFlow
        ? placeGridItems(children, grid.rows?.length ?? 1, { columnFlow: true, dense })
        : placeGridItems(children, grid.columns.length, { dense });

    // Track sizes: leading columns from `grid.columns` then implicit `{ auto }` (for derived columns
    // under column flow); each row is `rows[r] ?? rowHeight`. Under row flow this is byte-identical
    // to the pre-auto-flow arrays (cols == grid.columns.length, so every column comes from `columns`).
    const colTracks: TrackSize[] = [];
    for (let c = 0; c < cols; c++) colTracks.push(grid.columns[c] ?? { auto: true });
    const rowTracks: TrackSize[] = [];
    for (let r = 0; r < rows; r++) rowTracks.push(grid.rows?.[r] ?? grid.rowHeight);

    const colAuto = new Array<number>(cols).fill(0);
    const rowAuto = new Array<number>(rows).fill(0);
    children.forEach((ch, i) => {
        const cell = cells[i];
        // An `auto` track fits the SINGLE-span child PLUS its margins (so the inset cell in
        // layoutGridChildren gives the child its own size). A spanning item drives no auto track.
        // Direction-agnostic: keys off `cell.col`/`cell.row`, identical for row and column flow.
        const pm = resolveMargin(ch.margin);
        if (cell.colSpan === 1 && ch.width + pm.left + pm.right > colAuto[cell.col]) colAuto[cell.col] = ch.width + pm.left + pm.right;
        if (cell.rowSpan === 1 && ch.height + pm.top + pm.bottom > rowAuto[cell.row]) rowAuto[cell.row] = ch.height + pm.top + pm.bottom;
    });

    const availW = grid.hugWidth ? null : (parentSize.width - 2 * pad) - colGap * Math.max(0, cols - 1);
    const availH = grid.hugHeight ? null : (parentSize.height - 2 * pad) - rowGap * Math.max(0, rows - 1);

    return {
        colWidths: resolveTracks(colTracks, colAuto, availW),
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
    children: readonly { id: string; width: number; height: number; colSpan?: number; rowSpan?: number; margin?: number | Margins; gridColumn?: readonly [number, number]; gridRow?: readonly [number, number] }[]
): Map<string, Rect> {
    const out = new Map<string, Rect>();
    if (grid.columns.length === 0) return out;
    const colGap = grid.columnGap ?? 0;
    const rowGap = grid.rowGap ?? 0;
    const pad = grid.padding ?? 0;
    // The SAME `resolveGridTracks` the hug fold used — reuse its placement `cells` so the cells
    // laid out here match the container's hugged size exactly (no re-derivation, no drift). Use its
    // DERIVED `cols` (not `grid.columns.length`) — under column flow the real column count differs.
    const { colWidths, rowHeights, cols, rows, cells } = resolveGridTracks(grid, children, parentSize);

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
        // Margins INSET the child within its cell (physical sides — a grid cell is axis-aligned).
        const m = resolveMargin(ch.margin);
        out.set(ch.id, {
            x: colX[cell.col] + m.left,
            y: rowY[cell.row] + m.top,
            width: Math.max(0, width - m.left - m.right),
            height: Math.max(0, height - m.top - m.bottom),
        });
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
