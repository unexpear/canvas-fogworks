/**
 * @module Node
 * @description Defines the canonical structure and type system for every object stored in the document.
 * Nodes are never mutated directly; changes happen via Actions.
 */

import { isTokenRef } from "./Variables";

/** A `"$token"` reference in a NUMBER slot (radius/fontSize, schema 20). Same syntax as color
 *  tokens; the resolved value's range is checked at render time (broken → visible fallback). */
function isNumberToken(v: unknown): boolean {
    return isTokenRef(v);
}

/**
 * The closed set of node types. Single source of truth: `NodeType` is derived from
 * it, and both validation paths check membership against it — so adding a type is
 * one edit, and an unknown type cannot slip in through a hand-edited file.
 */
export const NODE_TYPES = ["core.rectangle", "core.text", "core.image", "core.ellipse", "core.line", "core.path", "core.instance"] as const;
export type NodeType = typeof NODE_TYPES[number];

/**
 * A node id no document may use: the action layer's delta map is keyed by node id, and
 * DOCUMENT-level deltas (the M5 `"variables"` kind) travel under this sentinel — a real node
 * with the same id would collide with them in a transaction's merged result (the doc delta
 * would overwrite the node's edits). Rejected on BOTH paths (`AddNodeAction` + `Integrity`),
 * like the reserved variable keys.
 */
export const RESERVED_NODE_ID = "__document__";

/**
 * A substring no STORED node id may contain: instance expansion (M6) builds VIRTUAL node ids
 * as `<instance path>::<master node id>`, so a stored id containing `::` could collide with a
 * materialized copy — and `splitVirtualId` would mis-attribute it to an instance. Rejected on
 * BOTH paths (`AddNodeAction` + `Integrity`), like `RESERVED_NODE_ID`. Kept here (not in
 * Components.ts) so the document layer owns every id rule in one place; Components re-exports
 * the separator it forms ids with.
 */
export const RESERVED_ID_SUBSTRING = "::";

/** Validity of a stored node id: not the document-delta sentinel, and free of the virtual-id
 *  separator. Shared by the edit path (`AddNodeAction`) and the load path (`Integrity`). */
export function nodeIdError(id: string): string | null {
    if (id === RESERVED_NODE_ID) return `node id "${RESERVED_NODE_ID}" is reserved`;
    if (id.includes(RESERVED_ID_SUBSTRING)) return `node id "${id}" must not contain "${RESERVED_ID_SUBSTRING}" (reserved for component instances)`;
    return null;
}

export function isNodeType(value: unknown): value is NodeType {
    return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

/**
 * Validity check for a node's dimensions, keyed on type and SHARED by the edit path
 * (`AddNode`/`Resize`/`UpdateNodeGeometry`) and the load path (`Integrity`) so the two
 * cannot drift — the same round-trip discipline `layoutError`/`transformError` use.
 *
 * Most shapes need a positive box. A `core.line` is the box DIAGONAL, so it may collapse
 * ONE axis (a horizontal line has height 0, a vertical line width 0) — but not both (a
 * zero-length line is a degenerate point). Returns an error string, or null.
 */
export function dimensionError(type: NodeType, width: number, height: number): string | null {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return "must have finite dimensions";
    // A `core.line` (box diagonal) and a `core.path` (drawn from its commands, box is just the
    // declared bbox) may collapse ONE axis — a horizontal/vertical line, or a flat path bbox.
    // A `core.instance` mirrors its MASTER's box, which may itself be a line/path, so it takes
    // the same rule — otherwise a horizontal rule could never be instanced.
    if (type === "core.line" || type === "core.path" || type === "core.instance") {
        if (width < 0 || height < 0) return "dimensions must be >= 0";
        if (width === 0 && height === 0) return "must have a non-zero extent on at least one axis";
        return null;
    }
    if (width <= 0 || height <= 0) return "must have positive dimensions";
    return null;
}

/** Upper bound on a path's command count — the OOM guard on a hand-editable unbounded field,
 *  mirroring `GRID_MAX_TRACKS`. A path's cost is LINEAR (one `<path>`, a `d` string of
 *  O(commands) length) unlike a grid's quadratic occupancy, so the cap is looser while still
 *  rejecting a millions-of-commands file. */
export const PATH_MAX_COMMANDS = 100_000;

/**
 * One command of a `core.path`, in ABSOLUTE coordinates in the node's LOCAL box space
 * (drawn at the local origin, placed by the world matrix like every other shape). Only the
 * explicit absolute subset SVG rendering reduces to — relative/shorthand (`h`/`v`/`s`/`t`)
 * and arcs (`A`) are deferred to a future SVG-import normalizer whose output feeds this same
 * type through `pathError`.
 */
export type PathCommand =
    | { c: "M"; x: number; y: number }
    | { c: "L"; x: number; y: number }
    | { c: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { c: "Q"; x1: number; y1: number; x: number; y: number }
    | { c: "Z" };

/** Required finite-numeric fields per command letter (`Z` carries none). */
const PATH_COMMAND_COORDS: Record<string, readonly string[]> = {
    M: ["x", "y"], L: ["x", "y"],
    C: ["x1", "y1", "x2", "y2", "x", "y"], Q: ["x1", "y1", "x", "y"], Z: []
};

/**
 * Validity check for `Node.path`, keyed on type and SHARED by the load path (`Integrity`)
 * and a future path-edit action — the same closure discipline `dimensionError`/`layoutError`
 * use. An absent path is always fine (a `core.path` with no commands draws nothing, like an
 * absent `text`/`src`); only a `core.path` may carry path data; a present path must be a
 * non-empty, bounded array opening with `M`, every command a known letter with finite coords.
 */
export function pathError(type: NodeType, path: unknown): string | null {
    if (path === undefined) return null;
    if (type !== "core.path") return "only a core.path node may carry path data";
    if (!Array.isArray(path)) return "path must be an array of commands";
    if (path.length === 0) return "path must have at least one command";
    if (path.length > PATH_MAX_COMMANDS) return `path must have at most ${PATH_MAX_COMMANDS} commands`;
    // Must open with a moveto: without a current point the first draw is undefined.
    const first = path[0] as { c?: unknown };
    if (typeof first !== "object" || first === null || first.c !== "M") return 'path must start with an "M" (moveto) command';
    for (let i = 0; i < path.length; i++) {
        const cmd = path[i];
        if (typeof cmd !== "object" || cmd === null || Array.isArray(cmd)) return `path command ${i} must be an object`;
        const c = (cmd as { c?: unknown }).c;
        // OWN-property check, not `c in …`: `in` walks the prototype chain, so a command
        // named "toString"/"constructor"/"__proto__" would read as known and then crash the
        // for-of on the inherited function (a validator must never throw). Same family as the
        // grid `"px" in t` throw hazard.
        if (typeof c !== "string" || !Object.prototype.hasOwnProperty.call(PATH_COMMAND_COORDS, c)) return `path command ${i} has an unknown command "${String(c)}"`;
        for (const key of PATH_COMMAND_COORDS[c]) {
            const v = (cmd as Record<string, unknown>)[key];
            if (typeof v !== "number" || !Number.isFinite(v)) return `path command ${i} (${c}) ${key} must be a finite number`;
        }
    }
    return null;
}

/**
 * Longest `Node.src` a document may carry. An image source is usually a short URL, but the
 * editor's file picker inlines a chosen file as a `data:` URL — which lands the whole encoded
 * image IN the document. Without a bound, one picked photo makes a document that cannot be
 * saved (browser storage quotas are a few MB) and is slow to parse forever after. ~4 MB of
 * characters is roughly a 3 MB image: generous for a design asset, still bounded.
 */
export const IMAGE_SRC_MAX = 4_000_000;

/** URL schemes an image source may use. Anything else (`javascript:`, `file:`, …) is not a
 *  thing a renderer can draw, so it is rejected rather than handed to the DOM. A source with
 *  NO scheme is a relative path and always allowed. */
const SRC_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const SRC_ALLOWED = ["http", "https", "blob"];

/**
 * Validity check for `Node.src`, keyed on type and SHARED by the load path (`Integrity`) and
 * the edit path (`AddNodeAction`'s content) — the same closure discipline `pathError` and
 * `dimensionError` use. An absent src is always fine (an image with no source draws nothing);
 * only a `core.image` may carry one; a present one must be a non-empty, bounded string whose
 * scheme is something a renderer could actually load.
 */
export function srcError(type: NodeType, src: unknown): string | null {
    if (src === undefined) return null;
    if (type !== "core.image") return "only a core.image node may carry a src";
    return srcValueError(src);
}

/**
 * The TYPE-FREE half of `srcError`: everything true of an image source regardless of which
 * node carries it. Split out because a per-instance OVERRIDE also carries a `src` and is
 * validated without knowing the master's type (`overridesError` sees a bare map) — the type
 * half runs in `overrideAgainstMasterError`, which holds the document. Without this split the
 * override seam validated `src` as merely "a string", so an override could smuggle in a value
 * no stored node may hold and a detach would bake it into an unloadable document.
 */
export function srcValueError(src: unknown): string | null {
    if (typeof src !== "string" || src.length === 0) return "src must be a non-empty string";
    if (src.length > IMAGE_SRC_MAX) return `src must be at most ${IMAGE_SRC_MAX} characters`;
    const scheme = SRC_SCHEME.exec(src);
    if (scheme === null) return null;                    // relative path
    const name = scheme[1].toLowerCase();
    // A `data:` URL must actually be an IMAGE: `data:text/html,…` in an <image href> draws
    // nothing, and handing arbitrary data URLs to the DOM is not a habit worth having.
    if (name === "data") {
        return /^data:image\/[a-zA-Z0-9.+-]+[;,]/.test(src) ? null : "a data: src must be an image media type";
    }
    return SRC_ALLOWED.includes(name) ? null : `src scheme "${name}" is not allowed`;
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
    /** `core.path` drawing commands (absolute, local-space). Absent = an empty path. See `PathCommand`. */
    path?: PathCommand[];
    /**
     * `core.instance` → the id of the MASTER node this instance copies (M6). The master is an
     * ordinary node subtree in the same document. Absent = an empty instance (draws nothing);
     * a DANGLING reference is valid at rest and also draws nothing, so deleting a master can
     * never corrupt a document that instances it. See `Components.expandInstances`.
     */
    componentId?: string;
    /**
     * `core.instance` → per-instance OVERRIDES, keyed by MASTER NODE ID (schema 22). What this
     * instance changes about the copy it renders: geometry / style / text / src. Keyed by
     * identity rather than position, so an override survives edits to the master and goes inert
     * (never invalid) if that master node is deleted. See `Components.InstanceOverride`.
     */
    overrides?: Record<string, import("./Components").InstanceOverride>;
    name?: string;
}

/** Geometry defines the bounding box and initial position intent. */
export interface Geometry {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A drop shadow: offset + gaussian softness + colour, all in world units. Persisted (schema 18). */
export interface Shadow {
    dx: number;
    dy: number;
    blur: number;    // gaussian std-dev radius in world units, >= 0 (0 = a sharp shadow)
    color: string;   // colour value or token id, like `fill` (not parsed)
}

/** Style holds the visual attributes that define appearance. */
export interface Style {
    fill: string;      // Color value or token ID (e.g., "$color/primary")
    stroke?: string;   // Optional border color
    /**
     * Border thickness in WORLD units — a number, or a NUMBER-token reference (schema 25).
     * Absent = a hairline: 1 SCREEN pixel at any zoom, which is what every stroke was before
     * this field existed. World units are the meaningful default for a shape's own border (it
     * should thicken as you zoom in, unlike the selection chrome, which stays hairline).
     */
    strokeWidth?: number | string;
    /** Corner radius — a number, or a NUMBER-token reference like "$radius/medium" (schema 20). */
    radius?: number | string;
    opacity: number;
    /** Text font size in world units (defaults to 14) — a number, or a number-token reference (schema 20). */
    fontSize?: number | string;
    shadow?: Shadow;   // Drop shadow (schema 18); absent = none
    blur?: number;     // Whole-node gaussian blur radius in world units, >= 0 (schema 18); absent/0 = none
}

/**
 * Validity check for a style patch, SHARED by the edit path (`UpdateNodeStyleAction`) and the
 * load path (`Integrity.checkNodeRanges`) so the two cannot drift — the same discipline
 * `layoutError`/`transformError` use, and it also closes the pre-existing inline duplication of
 * the opacity/radius/fontSize rules. Only present fields are checked. Message substrings are
 * load-bearing (tests assert "opacity must be within"). Returns an error string, or null.
 */
export function styleError(s: Partial<Style>): string | null {
    if ("fill" in s && typeof s.fill !== "string") return "style.fill must be a string";
    if ("stroke" in s && s.stroke !== undefined && typeof s.stroke !== "string") return "style.stroke must be a string";
    if ("opacity" in s && (!Number.isFinite(s.opacity) || (s.opacity as number) < 0 || (s.opacity as number) > 1)) return "style.opacity must be within [0, 1]";
    // radius/fontSize (schema 20): a concrete number under the old range rules, OR a "$token"
    // reference — an arbitrary NON-token string is rejected (it would silently render as the
    // fallback with no hint that it was never a token). The token's RESOLVED value is range-
    // checked at render time (a broken/out-of-range token falls back visibly, never throws).
    if ("radius" in s && s.radius !== undefined && !isNumberToken(s.radius)
        && (typeof s.radius !== "number" || !Number.isFinite(s.radius) || s.radius < 0)) return "style.radius must be >= 0 or a $token";
    if ("fontSize" in s && s.fontSize !== undefined && !isNumberToken(s.fontSize)
        && (typeof s.fontSize !== "number" || !Number.isFinite(s.fontSize) || s.fontSize <= 0)) return "style.fontSize must be > 0 or a $token";
    // strokeWidth (schema 25): same shape as radius — >= 0 (0 means "no visible border") or a token.
    if ("strokeWidth" in s && s.strokeWidth !== undefined && !isNumberToken(s.strokeWidth)
        && (typeof s.strokeWidth !== "number" || !Number.isFinite(s.strokeWidth) || s.strokeWidth < 0)) return "style.strokeWidth must be >= 0 or a $token";
    if ("blur" in s && s.blur !== undefined && (!Number.isFinite(s.blur) || (s.blur as number) < 0)) return "style.blur must be finite and >= 0";
    if ("shadow" in s && s.shadow !== undefined) {
        const sh = s.shadow as Partial<Shadow>;
        if (typeof sh !== "object" || sh === null || Array.isArray(sh)) return "style.shadow must be an object";
        if (!Number.isFinite(sh.dx) || !Number.isFinite(sh.dy)) return "style.shadow dx and dy must be finite";
        if (!Number.isFinite(sh.blur) || (sh.blur as number) < 0) return "style.shadow.blur must be finite and >= 0";
        if (typeof sh.color !== "string") return "style.shadow.color must be a string";
    }
    return null;
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
     * Per-child margin (Milestone 2). A single `number` is uniform on all four sides; a
     * `Margins` object gives PER-SIDE margins (any omitted side = 0). In a FLEX parent it is
     * flow spacing (main-axis before/after + cross-axis inset, mapped from the physical sides by
     * `direction`); in a GRID parent it insets the child WITHIN its cell (and an `auto` track
     * grows to fit the child + its margins). Absent = 0. Ignored for a constrained/absolute
     * child or a child of a plain parent (out of flow). Every side >= 0.
     */
    margin?: number | Margins;
    /**
     * Grid SPAN (Milestone 2). How many columns / rows this node occupies in its GRID parent's
     * auto-placement. Absent = 1 (a single cell). `colSpan` is clamped to the column count; a
     * spanning item's cell covers its tracks plus the internal gaps. Integers in
     * `[1, GRID_SPAN_MAX]`. Ignored by a flex/plain parent. A spanning item does NOT drive `auto`
     * track sizing (a documented simplification — CSS's first sizing pass only).
     */
    colSpan?: number;
    rowSpan?: number;
    /**
     * EXPLICIT grid line placement (Milestone 2). `[startLine, endLine]`, 1-indexed and end-
     * EXCLUSIVE (CSS grid lines): `[2, 4]` pins the item to two tracks starting at index 1. An item
     * is explicitly placed only when BOTH `gridColumn` AND `gridRow` are present — auto items then
     * flow AROUND it. Supersedes `colSpan`/`rowSpan` on that axis (span = end − start). Lines in
     * `[1, GRID_MAX_TRACKS + 1]`. Single-axis placement and explicit-under-column-flow are deferred.
     */
    gridColumn?: readonly [number, number];
    gridRow?: readonly [number, number];
}

/** Upper bound on a grid `colSpan`/`rowSpan` — a per-item cap (bounds one item's cell block). */
export const GRID_SPAN_MAX = 1000;
/**
 * Upper bound on a grid's COLUMN count and its DERIVED row count. Columns are capped on
 * validation; the derived rows are capped in placement. Together they bound the placement's
 * occupancy set to `GRID_MAX_TRACKS²` cells — so a hand-edited grid (huge columns, or many
 * wide-spanning children) cannot exhaust memory. A grid larger than this is beyond scope (use a
 * flex column for a long list).
 */
export const GRID_MAX_TRACKS = 1000;

/** Horizontal anchor: pin left, pin right, pin both (stretch), keep centered, or scale. */
export type HConstraint = "left" | "right" | "left-right" | "center" | "scale";
/** Vertical anchor: pin top, pin bottom, pin both (stretch), keep centered, or scale. */
export type VConstraint = "top" | "bottom" | "top-bottom" | "center" | "scale";

/** Per-axis anchor modes for a child of a plain (non-auto-layout) parent. */
export interface Constraints {
    horizontal?: HConstraint;
    vertical?: VConstraint;
}

/** Per-side margins (any omitted side = 0). The object form of `Layout.margin`. */
export interface Margins {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
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
    /**
     * Auto-placement flow (Milestone 2). `"row"` (default) fixes the `columns` and derives the rows
     * from the flow; `"column"` fixes the ROWS (from `rows`, default 1) and derives the columns
     * (implicit columns beyond `columns` are `auto`-sized). `"dense"` backfills earlier gaps instead
     * of the forward-only (sparse) cursor. Absent = `"row"`.
     */
    autoFlow?: "row" | "row dense" | "column" | "column dense";
    columnGap?: number;     // between columns (>= 0)
    rowGap?: number;        // between rows (>= 0)
    padding?: number;       // inset from the container's edges (>= 0)
}

/** A flex-stack: children packed along one axis, with padding, gap and cross-align. */
export interface LayoutContainer {
    direction: "row" | "column";
    gap?: number;        // space between children (>= 0) — used BETWEEN items AND between wrapped lines
    padding?: number;    // inset from the container's edges (>= 0)
    /** Cross-axis placement; "stretch" also sets each child's cross-size to fill. */
    alignItems?: "start" | "center" | "end" | "stretch";
    /**
     * Flex WRAP (Milestone 2). When true, children that overflow the container's inner MAIN
     * axis wrap onto new lines (the first child on a line always stays even if it alone
     * overflows). Each line distributes its OWN grow/shrink free space; lines stack on the
     * cross axis separated by `gap`; `alignItems` aligns each child within its line's cross
     * band. A cross-axis-hug container sizes its cross to the stacked lines. Absent = nowrap
     * (a single line, today's behaviour). Inert when the MAIN axis hugs (no definite main to
     * wrap against — like `grow` under a hugged main). Wrapping is measured against the
     * container's OWN size; extra space from a parent that STRETCHES the main axis is not
     * re-wrapped into (a documented deferral that keeps the measure pass acyclic).
     */
    wrap?: boolean;
    /**
     * Cross-axis distribution of the wrapped LINES (Milestone 2), when they have leftover cross
     * space (`Σ line sizes < inner cross`). Absent = `start`. A no-op for a single line or a
     * cross-hug container (which sized itself to its lines). `stretch` grows each line's band
     * (feeding `alignItems: stretch`); `space-between`/`space-around` distribute the gaps.
     */
    alignContent?: "start" | "center" | "end" | "space-between" | "space-around" | "stretch";
    /**
     * Flex WRAP-REVERSE (Milestone 2). When true, wrapped lines stack from the OPPOSITE cross
     * edge (also flipping per-line `alignItems` and `alignContent`, like CSS `wrap-reverse`).
     * Absent = false. Inert without `wrap` (or when the main axis hugs, which makes wrap inert).
     */
    wrapReverse?: boolean;
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
const ALIGN_CONTENT = new Set(["start", "center", "end", "space-between", "space-around", "stretch"]);
const GRID_AUTO_FLOWS = new Set(["row", "row dense", "column", "column dense"]);
const H_CONSTRAINTS = new Set(["left", "right", "left-right", "center", "scale"]);
const V_CONSTRAINTS = new Set(["top", "bottom", "top-bottom", "center", "scale"]);

/** Validity check for `Layout.margin` — a finite `number >= 0`, or a `Margins` object of finite `>= 0` sides. */
function marginError(m: unknown): string | null {
    if (typeof m === "number") return (!Number.isFinite(m) || m < 0) ? "must be finite and >= 0" : null;
    // Reject arrays (and non-objects): an array is `typeof "object"` but is not a `Margins`, and
    // without this guard it would validate clean (every named side reads `undefined`) and silently
    // drop to {0,0,0,0} — a round-trip-closure gap, since TypeScript forbids an array at the edit path.
    if (typeof m !== "object" || m === null || Array.isArray(m)) return "must be a number or a per-side object";
    for (const side of ["top", "right", "bottom", "left"] as const) {
        const v = (m as Record<string, unknown>)[side];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return `${side} must be finite and >= 0`;
    }
    return null;
}

/** Validity check for a `[startLine, endLine]` grid-line pair — integers, `1 <= start < end <= GRID_MAX_TRACKS + 1`. */
function gridLineError(v: unknown): string | null {
    if (!Array.isArray(v) || v.length !== 2) return "must be a [start, end] pair";
    const [s, e] = v as unknown[];
    if (!Number.isInteger(s) || !Number.isInteger(e)) return "lines must be integers";
    if ((s as number) < 1 || (e as number) > GRID_MAX_TRACKS + 1 || (s as number) >= (e as number)) return `must satisfy 1 <= start < end <= ${GRID_MAX_TRACKS + 1}`;
    return null;
}

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
    if (l.margin !== undefined) {
        const e = marginError(l.margin);
        if (e) return `layout.margin ${e}`;
    }
    // Grid spans: positive integers, capped so the derived row count cannot OOM. Per-child
    // (grid children have no container), so validate BEFORE the no-container early return.
    if (l.colSpan !== undefined && (!Number.isInteger(l.colSpan) || l.colSpan < 1 || l.colSpan > GRID_SPAN_MAX)) return `layout.colSpan must be an integer in [1, ${GRID_SPAN_MAX}]`;
    if (l.rowSpan !== undefined && (!Number.isInteger(l.rowSpan) || l.rowSpan < 1 || l.rowSpan > GRID_SPAN_MAX)) return `layout.rowSpan must be an integer in [1, ${GRID_SPAN_MAX}]`;
    if (l.gridColumn !== undefined) { const e = gridLineError(l.gridColumn); if (e) return `layout.gridColumn ${e}`; }
    if (l.gridRow !== undefined) { const e = gridLineError(l.gridRow); if (e) return `layout.gridRow ${e}`; }
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
        // Column count is capped (with the derived-row cap in placement) so the sparse
        // auto-placement's occupancy set stays bounded — see GRID_MAX_TRACKS.
        if (!Array.isArray(g.columns) || g.columns.length === 0) return "layout.grid.columns must be a non-empty array";
        if (g.columns.length > GRID_MAX_TRACKS) return `layout.grid.columns must have at most ${GRID_MAX_TRACKS} tracks`;
        for (const t of g.columns) { const e = trackError(t); if (e) return `layout.grid.columns track ${e}`; }
        const rhe = trackError(g.rowHeight); if (rhe) return `layout.grid.rowHeight ${rhe}`;
        // Explicit per-row tracks: optional, but if present a non-empty array of valid
        // tracks (omit it for "all rows use rowHeight"; `[]` would be a redundant no-op).
        if (g.rows !== undefined) {
            if (!Array.isArray(g.rows) || g.rows.length === 0) return "layout.grid.rows must be a non-empty array when present";
            if (g.rows.length > GRID_MAX_TRACKS) return `layout.grid.rows must have at most ${GRID_MAX_TRACKS} tracks`;
            for (const t of g.rows) { const e = trackError(t); if (e) return `layout.grid.rows track ${e}`; }
        }
        if (g.hugWidth !== undefined && typeof g.hugWidth !== "boolean") return "layout.grid.hugWidth must be a boolean";
        if (g.hugHeight !== undefined && typeof g.hugHeight !== "boolean") return "layout.grid.hugHeight must be a boolean";
        if (g.autoFlow !== undefined && !GRID_AUTO_FLOWS.has(g.autoFlow)) return 'layout.grid.autoFlow must be "row" | "row dense" | "column" | "column dense"';
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
    if (c.wrap !== undefined && typeof c.wrap !== "boolean") return "layout.container.wrap must be a boolean";
    if (c.alignContent !== undefined && !ALIGN_CONTENT.has(c.alignContent)) return "layout.container.alignContent is invalid";
    if (c.wrapReverse !== undefined && typeof c.wrapReverse !== "boolean") return "layout.container.wrapReverse must be a boolean";
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