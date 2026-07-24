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