/**
 * @module RendererState
 * @description The read-only input the renderer draws from: resolved world
 * geometry (`ComputedState`) plus the transient editor selection/hover/preview
 * and viewport. Kept in its own module so both the pure `RenderModel` builder and
 * the `SVGRenderer` shim can depend on it without a cycle.
 */

import { ComputedState } from "../core/geometry/GeometryEngine";
import { PathCommand } from "../core/document/Node";
import { SnapGuide } from "../core/geometry/Snapping";
import { ReadonlyDocument } from "../core/document/Document";

type Rect = { x: number; y: number; width: number; height: number };

export interface RendererState {
    selectedNodeIds: string[];
    hoveredNodeId: string | null;
    previewRect?: Rect | null;
    /** Box-select marquee in world coordinates (drawn as an overlay); absent when not dragging. */
    marqueeRect?: Rect | null;
    /** Alignment (smart) guides in world coordinates, drawn while a drag snaps; absent otherwise. */
    snapGuides?: SnapGuide[] | null;
    /** The pen stroke in progress, WORLD space — drawn as overlay, never in the document. */
    pendingPath?: PathCommand[] | null;
    /**
     * Resolved world geometry + draw order. The renderer reads ONLY this for
     * positions — it never composes coordinates itself.
     */
    computed: ComputedState;
    /**
     * ONION SKINS: neighbouring frames to draw faintly BEHIND the current one (schema 39).
     *
     * Each carries its own already-derived document and computed geometry, because the renderer
     * reads every position from a `ComputedState` and composes none itself. Deriving the other
     * frames here would break that rule; the app already runs `computeGeometry`, so it supplies
     * them and the model stays a pure read.
     */
    ghosts?: { doc: ReadonlyDocument; computed: ComputedState; opacity: number }[];
    viewport: { x: number; y: number; zoom: number };
}
