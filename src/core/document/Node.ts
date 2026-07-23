/**
 * @module Node
 * @description Defines the canonical structure and type system for every object stored in the document.
 * Nodes are never mutated directly; changes happen via Actions.
 */

export type NodeType = "core.rectangle" | "core.text" | "core.image"; // Extend with new types later

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

/** StateDefinition captures the properties of a node in a specific context (e.g., :hover). */
export interface StateDefinition {
    [key: string]: any; // e.g., scale, opacity adjustments
}