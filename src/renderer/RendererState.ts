/**
 * @module RendererState
 * @description The read-only input the renderer draws from: resolved world
 * geometry (`ComputedState`) plus the transient editor selection/hover/preview
 * and viewport. Kept in its own module so both the pure `RenderModel` builder and
 * the `SVGRenderer` shim can depend on it without a cycle.
 */

import { ComputedState } from "../core/geometry/GeometryEngine";

type Rect = { x: number; y: number; width: number; height: number };

export interface RendererState {
    selectedNodeIds: string[];
    hoveredNodeId: string | null;
    previewRect?: Rect | null;
    /** Box-select marquee in world coordinates (drawn as an overlay); absent when not dragging. */
    marqueeRect?: Rect | null;
    /**
     * Resolved world geometry + draw order. The renderer reads ONLY this for
     * positions — it never composes coordinates itself.
     */
    computed: ComputedState;
    viewport: { x: number; y: number; zoom: number };
}
