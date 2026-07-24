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