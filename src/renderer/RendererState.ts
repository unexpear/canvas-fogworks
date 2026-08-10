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
import { SelectionMask } from "../core/paint/Selection";

type Rect = { x: number; y: number; width: number; height: number };

export interface RendererState {
    selectedNodeIds: string[];
    hoveredNodeId: string | null;
    previewRect?: Rect | null;
    /** Box-select marquee in world coordinates (drawn as an overlay); absent when not dragging. */
    marqueeRect?: Rect | null;
    /** Alignment (smart) guides in world coordinates, drawn while a drag snaps; absent otherwise. */
    snapGuides?: SnapGuide[] | null;
    /**
     * The PIXEL SELECTION to outline: which pixels of which raster an edit may touch.
     *
     * A DIFFERENT THING FROM `marqueeRect`, which is a box being dragged over the canvas to pick
     * NODES. This is a mask over one surface's pixels, and it is drawn as the boundary between
     * selected and unselected — not as its bounding box, which would draw a lasso as a rectangle.
     *
     * THE MASK MUST MATCH THAT NODE'S SURFACE, and the CALLER is what guarantees it: `pixelMaskFor`
     * is the validated read, and passing an unvalidated mask would draw an outline the tools do not
     * honour. Checking again here would be a second copy of a rule that already exists — the same
     * reasoning that keeps `expandInstances` out of `ComputedState`.
     */
    pixelSelection?: { nodeId: string; mask: SelectionMask } | null;
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
