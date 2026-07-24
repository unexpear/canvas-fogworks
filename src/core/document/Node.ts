/**
 * @module Node
 * @description Defines the canonical structure and type system for every object stored in the document.
 * Nodes are never mutated directly; changes happen via Actions.
 */

/**
 * The closed set of node types. Single source of truth: `NodeType` is derived from
 * it, and both validation paths check membership against it — so adding a type is
 * one edit, and an unknown type cannot slip in through a hand-edited file.
 */
export const NODE_TYPES = ["core.rectangle", "core.text", "core.image"] as const;
export type NodeType = typeof NODE_TYPES[number];

export function isNodeType(value: unknown): value is NodeType {
    return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

/**
 * Represents the immutable, persisted definition of a node instance.
 */
export interface Node {
    id: string;
    type: NodeType;
    parent?: string | null;
    children: string[];
    geometry: Geometry;
    style: Style;
    layout: Layout;
    /**
     * Rotation / scale about a pivot. Optional and absent by default — a node with
     * no `transform` is exactly a translated axis-aligned box, which is what every
     * schema-1 document is. Deliberately NOT folded into `Geometry`, which stays a
     * pure AABB so Milestone 2 layout can compute it.
     */
    transform?: Transform;
    states?: Record<string, StateDefinition>;
    text?: string;
    src?: string;
    name?: string;
}

/** Geometry defines the bounding box and initial position intent. */
export interface Geometry {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Style holds the visual attributes that define appearance. */
export interface Style {
    fill: string;      // Color value or token ID (e.g., "$color/primary")
    stroke?: string;   // Optional border color
    radius?: number;   // Corner radius
    opacity: number;
    fontSize?: number; // Text nodes: font size in world units (defaults to 14)
}

/** Layout defines how the node should behave within its parent container. */
export interface Layout {
    // Constraint relationships, not absolute positions.
    horizontalAlignment?: "left" | "right" | "center";
    verticalAlignment?: "top" | "bottom" | "center";
    spacing?: number; // Gap size for children or siblings
    /**
     * Auto-layout (Milestone 2). When set, this node's DIRECT CHILDREN are POSITIONED
     * by the layout engine — their stored `geometry.x/y` is ignored and computed from
     * the stack rule. This is what "store 'center inside parent' instead of x=240" means.
     */
    container?: LayoutContainer;
    /**
     * Flex-grow (Milestone 2). This node's share of the LEFTOVER main-axis space in its
     * flex-container parent, distributed in proportion to siblings' `grow`. `0`/absent =
     * fixed to its own (base) main size. Only takes effect when the parent is a container
     * with free space — a parent that HUGS its main axis has none, so `grow` is inert
     * there. A property of the CHILD, consumed by its container parent (like CSS
     * `flex-grow`), so it lives on the node's own `Layout`, not on `LayoutContainer`.
     */
    grow?: number;
    /**
     * Flex-shrink (Milestone 2). When the flex children OVERFLOW their container's main
     * axis, this node gives up a share of the DEFICIT, weighted (CSS-style) by
     * `shrink × base-main-size`, clamped so it never shrinks below 0. `0`/absent = never
     * shrinks (the pre-shrink overflow behaviour). Mutually exclusive with `grow` by sign:
     * only one of grow (free > 0) / shrink (free < 0) applies on a given layout.
     */
    shrink?: number;
    /**
     * Grid auto-layout (Milestone 2). An ALTERNATIVE to `container` (flex) — the two are
     * mutually exclusive. This node's direct children are auto-flowed row-major into a
     * grid of the given column tracks, each filling its cell. See `LayoutGrid`.
     */
    grid?: LayoutGrid;
    /**
     * Constraints / anchors (Milestone 2). How THIS node repositions when its PLAIN
     * (non-flex, non-grid) parent's size differs from `constraintRef`. A per-child hint
     * (like `grow`); ignored when the parent lays this node out (flex/grid). Absent =
     * `left`/`top` = today's static behavior. See `Constraints`.
     */
    constraints?: Constraints;
    /**
     * The parent size this node's stored geometry is "at rest" against — a FROZEN
     * reference, decoupled from the parent's stored AND computed size, so a constraint
     * responds to BOTH a direct parent resize and a layout-driven one. Auto-captured from
     * the parent's stored size when `constraints` is first set (`UpdateNodeLayoutAction`);
     * the resize path never rewrites it. Constraints are inert without it.
     */
    constraintRef?: { width: number; height: number };
    /**
     * Absolute-position escape (Milestone 2). `"absolute"` takes this node OUT of its
     * flex/grid parent's flow: it takes no slot/cell, does not contribute to the parent's
     * hug size or consume flex free space, and is positioned by its stored geometry +
     * `constraints` relative to the parent's box (like CSS `position: absolute`). Absent =
     * in-flow (normal).
     */
    position?: "absolute";
    /**
     * Per-child margin (Milestone 2), uniform on all sides, in a FLEX parent's flow: the
     * child is spaced `margin` from its neighbours on the main axis and inset `margin` on
     * the cross axis. Absent = 0. Ignored for a grid child, a constrained/absolute child,
     * or a child of a plain parent (out of flow). >= 0.
     */
    margin?: number;
}

/** Horizontal anchor: pin left, pin right, pin both (stretch), keep centered, or scale. */
export type HConstraint = "left" | "right" | "left-right" | "center" | "scale";
/** Vertical anchor: pin top, pin bottom, pin both (stretch), keep centered, or scale. */
export type VConstraint = "top" | "bottom" | "top-bottom" | "center" | "scale";

/** Per-axis anchor modes for a child of a plain (non-auto-layout) parent. */
export interface Constraints {
    horizontal?: HConstraint;
    vertical?: VConstraint;
}

/**
 * A grid track size: a fixed pixel size (`px`), a fraction of the leftover space (`fr`),
 * or `auto` — sized to the MAX intrinsic (measured own-) size of the children auto-flowed
 * into that track. `auto` is the object `{ auto: true }`, NOT the string `"auto"`, so that
 * every track stays an object and the `"px" in t` discriminant (used in the engine's
 * must-never-throw measure pass) can never hit the `in`-on-a-primitive `TypeError`.
 */
export type TrackSize = { px: number } | { fr: number } | { auto: true };

/**
 * A CSS-grid-like container: children auto-flow row-major into cells and STRETCH to fill
 * them (their stored size is ignored, like a laid-out flex child's position). Row count is
 * derived from the child count (`ceil(count / columns)`); every row uses `rowHeight`.
 *
 * `auto` tracks (and grid-container hug, below) pull grid INTO the bottom-up measure pass —
 * an `auto` track sizes to the max measured own-size of its children, so grid reads child
 * sizes exactly as flex hug does. `fr` tracks share the container's leftover inner size on
 * a NON-hugged axis (on a hugged axis there is no definite size to share, so `fr` → 0).
 */
export interface LayoutGrid {
    columns: readonly TrackSize[];   // ≥1 column tracks; defines the column count
    rowHeight: TrackSize;   // IMPLICIT row size — used for every row NOT sized by `rows` (px, fr, or auto)
    /**
     * EXPLICIT per-row track sizes (Milestone 2 grid tail), the mirror of `columns`. Row
     * `r` is sized by `rows[r]` when present, else falls back to `rowHeight` (like CSS
     * `grid-template-rows` + `grid-auto-rows`: `rows` sizes the leading rows, `rowHeight`
     * the implicit overflow rows). `fr` rows share the leftover inner height after the `px`
     * rows, exactly as columns do. Absent = every row is `rowHeight` (the pre-tail
     * behaviour). Row COUNT is still derived from the child count — `rows` only sizes them.
     */
    rows?: readonly TrackSize[];
    /**
     * Grid-container HUG (Milestone 2 grid tail), mirroring `LayoutContainer.hugWidth/Height`.
     * When set, this axis sizes to the grid's own tracks: `2·padding + Σtracks + gaps`, with
     * `auto` tracks folded from the children's measured sizes in the bottom-up measure pass.
     * On a hugged axis `fr` tracks collapse to 0 (no definite size to share). Absent = the
     * grid's own size on that axis is fixed / inherited (the pre-hug behaviour).
     */
    hugWidth?: boolean;
    hugHeight?: boolean;
    columnGap?: number;     // between columns (>= 0)
    rowGap?: number;        // between rows (>= 0)
    padding?: number;       // inset from the container's edges (>= 0)
}

/** A flex-stack: children packed along one axis, with padding, gap and cross-align. */
export interface LayoutContainer {
    direction: "row" | "column";
    gap?: number;        // space between children (>= 0)
    padding?: number;    // inset from the container's edges (>= 0)
    /** Cross-axis placement; "stretch" also sets each child's cross-size to fill. */
    alignItems?: "start" | "center" | "end" | "stretch";
    /**
     * Intrinsic ("hug") sizing (Milestone 2). When set, this container sizes the given
     * PHYSICAL axis to its contents instead of using its stored `geometry`: the hugged
     * width/height becomes a computed RESULT, exactly as a laid-out child's position is.
     *   - `hugWidth`  → width  = (row: sum of child widths + gaps; column: max child width) + 2·padding
     *   - `hugHeight` → height = (row: max child height; column: sum of child heights + gaps) + 2·padding
     * Absolute axes (not main/cross) on purpose: flipping `direction` must never
     * silently re-interpret which axis hugs. Hug composes — a hug container inside a hug
     * container ripples upward — which is why sizing needs a bottom-up measure pass.
     */
    hugWidth?: boolean;
    hugHeight?: boolean;
}

const DIRECTIONS = new Set(["row", "column"]);
const ALIGNMENTS = new Set(["start", "center", "end", "stretch"]);
const H_CONSTRAINTS = new Set(["left", "right", "left-right", "center", "scale"]);
const V_CONSTRAINTS = new Set(["top", "bottom", "top-bottom", "center", "scale"]);

/** Validity check for one grid `TrackSize` — exactly one of `px` (≥0), `fr` (>0), or `auto` (true). */
function trackError(t: unknown): string | null {
    if (typeof t !== "object" || t === null) return "must be an object";
    const hasPx = "px" in t;
    const hasFr = "fr" in t;
    const hasAuto = "auto" in t;
    if ((hasPx ? 1 : 0) + (hasFr ? 1 : 0) + (hasAuto ? 1 : 0) !== 1) return "must have exactly one of px, fr or auto";
    const px = (t as { px?: unknown }).px;
    const fr = (t as { fr?: unknown }).fr;
    const auto = (t as { auto?: unknown }).auto;
    if (hasPx && (typeof px !== "number" || !Number.isFinite(px) || px < 0)) return "px must be finite and >= 0";
    if (hasFr && (typeof fr !== "number" || !Number.isFinite(fr) || fr <= 0)) return "fr must be finite and > 0";
    if (hasAuto && auto !== true) return "auto must be true";
    return null;
}

/**
 * Validity check for a layout patch, shared by the edit path (`UpdateNodeLayoutAction`)
 * and the load path (`validateDocumentIntegrity`) so the two cannot drift — the same
 * round-trip discipline transform uses. Only present fields are checked. Returns an
 * error string, or null.
 */
export function layoutError(l: Partial<Layout>): string | null {
    // `grow` is independent of `container` and must be checked BEFORE the no-container
    // early return, or a `{ grow: -5 }` patch would slip through unvalidated.
    if (l.grow !== undefined && (!Number.isFinite(l.grow) || l.grow < 0)) return "layout.grow must be finite and >= 0";
    if (l.shrink !== undefined && (!Number.isFinite(l.shrink) || l.shrink < 0)) return "layout.shrink must be finite and >= 0";
    if (l.margin !== undefined && (!Number.isFinite(l.margin) || l.margin < 0)) return "layout.margin must be finite and >= 0";
    if (l.position !== undefined && l.position !== "absolute") return 'layout.position must be "absolute"';
    // Constraints + reference are independent per-child fields (like grow), so validate
    // them BEFORE the no-container early return — else a `{ constraints }` patch slips by.
    if ("constraints" in l && l.constraints !== undefined) {
        const c = l.constraints;
        if (typeof c !== "object" || c === null) return "layout.constraints must be an object";
        if (c.horizontal !== undefined && !H_CONSTRAINTS.has(c.horizontal)) return "layout.constraints.horizontal is invalid";
        if (c.vertical !== undefined && !V_CONSTRAINTS.has(c.vertical)) return "layout.constraints.vertical is invalid";
    }
    if ("constraintRef" in l && l.constraintRef !== undefined) {
        const r = l.constraintRef;
        if (typeof r !== "object" || r === null) return "layout.constraintRef must be an object";
        // > 0 (not just finite): a zero/negative reference would make `scale`'s C/R divide
        // by zero or flip sign; the engine also treats R <= 0 as static, so this is belt-and-braces.
        if (!Number.isFinite(r.width) || r.width <= 0) return "layout.constraintRef.width must be finite and > 0";
        if (!Number.isFinite(r.height) || r.height <= 0) return "layout.constraintRef.height must be finite and > 0";
    }
    // Grid is independent of `container` (and mutually exclusive with it), so validate it
    // BEFORE the no-container early return — else a `{ grid: <bad> }` patch would slip by.
    if ("grid" in l && l.grid !== undefined) {
        const g = l.grid as LayoutGrid;
        if (typeof g !== "object" || g === null) return "layout.grid must be an object";
        if (l.container !== undefined) return "layout.grid and layout.container are mutually exclusive";
        if (!Array.isArray(g.columns) || g.columns.length === 0) return "layout.grid.columns must be a non-empty array";
        for (const t of g.columns) { const e = trackError(t); if (e) return `layout.grid.columns track ${e}`; }
        const rhe = trackError(g.rowHeight); if (rhe) return `layout.grid.rowHeight ${rhe}`;
        // Explicit per-row tracks: optional, but if present a non-empty array of valid
        // tracks (omit it for "all rows use rowHeight"; `[]` would be a redundant no-op).
        if (g.rows !== undefined) {
            if (!Array.isArray(g.rows) || g.rows.length === 0) return "layout.grid.rows must be a non-empty array when present";
            for (const t of g.rows) { const e = trackError(t); if (e) return `layout.grid.rows track ${e}`; }
        }
        if (g.hugWidth !== undefined && typeof g.hugWidth !== "boolean") return "layout.grid.hugWidth must be a boolean";
        if (g.hugHeight !== undefined && typeof g.hugHeight !== "boolean") return "layout.grid.hugHeight must be a boolean";
        if (g.columnGap !== undefined && (!Number.isFinite(g.columnGap) || g.columnGap < 0)) return "layout.grid.columnGap must be finite and >= 0";
        if (g.rowGap !== undefined && (!Number.isFinite(g.rowGap) || g.rowGap < 0)) return "layout.grid.rowGap must be finite and >= 0";
        if (g.padding !== undefined && (!Number.isFinite(g.padding) || g.padding < 0)) return "layout.grid.padding must be finite and >= 0";
        return null; // grid is exclusive with container — skip the flex checks below
    }
    if (!("container" in l) || l.container === undefined) return null;
    const c = l.container;
    if (typeof c !== "object" || c === null) return "layout.container must be an object";
    if (!DIRECTIONS.has(c.direction)) return 'layout.container.direction must be "row" or "column"';
    if (c.gap !== undefined && (!Number.isFinite(c.gap) || c.gap < 0)) return "layout.container.gap must be finite and >= 0";
    if (c.padding !== undefined && (!Number.isFinite(c.padding) || c.padding < 0)) return "layout.container.padding must be finite and >= 0";
    if (c.alignItems !== undefined && !ALIGNMENTS.has(c.alignItems)) return "layout.container.alignItems is invalid";
    if (c.hugWidth !== undefined && typeof c.hugWidth !== "boolean") return "layout.container.hugWidth must be a boolean";
    if (c.hugHeight !== undefined && typeof c.hugHeight !== "boolean") return "layout.container.hugHeight must be a boolean";
    return null;
}

/**
 * Rotation and scale, applied about `origin` expressed as a fraction of the node's
 * own box (0.5,0.5 = centre, the default). Normalized rather than absolute so the
 * pivot survives a resize.
 */
export interface Transform {
    rotation?: number;   // radians, clockwise
    scaleX?: number;
    scaleY?: number;
    origin?: { x: number; y: number };
}

/**
 * Validity check for a transform, shared by the edit path (`UpdateNodeTransformAction`)
 * and the load path (`validateDocumentIntegrity`) so the two CANNOT drift — the M0
 * round-trip invariant applied to schema 2: anything one path rejects, the other must.
 * Only present fields are checked (a partial patch). Returns an error string, or null.
 */
export function transformError(t: Partial<Transform>): string | null {
    if ("rotation" in t && !Number.isFinite(t.rotation)) return "transform.rotation must be finite";
    // Zero scale is non-invertible: toLocal/hit-testing would fail, so the node could
    // never be selected. Negative scale (a flip) is legitimate.
    if ("scaleX" in t && (!Number.isFinite(t.scaleX) || t.scaleX === 0)) return "transform.scaleX must be finite and non-zero";
    if ("scaleY" in t && (!Number.isFinite(t.scaleY) || t.scaleY === 0)) return "transform.scaleY must be finite and non-zero";
    if ("origin" in t) {
        const o = t.origin;
        if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return "transform.origin must have finite x and y";
    }
    return null;
}

/** StateDefinition captures the properties of a node in a specific context (e.g., :hover). */
export interface StateDefinition {
    [key: string]: any; // e.g., scale, opacity adjustments
}