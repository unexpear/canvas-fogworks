/**
 * @module EditorState
 * @description Runtime editor context. Never serialized to the document.
 */

import { Geometry } from "../core/document/Node";

export interface EditorState {
    selectedNodeIds: string[];
    hoveredNodeId: string | null;
    activeTool: string;
    /** True while a tool is actively dragging (drives the "grabbing" cursor). */
    isDragging: boolean;
    /** Ephemeral rectangle-tool drag preview, drawn by the renderer; never persisted. */
    previewRect: { x: number; y: number; width: number; height: number } | null;
    /**
     * Ephemeral per-node patches to STORED (parent-relative) geometry, used to
     * preview a move/resize drag WITHOUT mutating the document. These are fed
     * into `computeGeometry` as an input and composed like any other
     * geometry — not applied as a renderer-side override — so future layout
     * passes apply to previews too. The real action is dispatched on mouse-up.
     */
    pendingGeometry: Map<string, Partial<Geometry>> | null;
    viewport: {
        x: number;
        y: number;
        zoom: number;
    };
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;
const PAN_LIMIT = 10000;

export function clampViewport(vp: EditorState["viewport"]): void {
    vp.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, vp.zoom));
    // vp.x/y are SCREEN offsets (the transform applies translate before scale), so
    // the reachable world area shrinks as zoom rises. Scale the limit by zoom so
    // PAN_LIMIT means the same ±10000 WORLD units at every zoom level — otherwise
    // at zoom 20 nothing beyond world x=500 could be scrolled to.
    const limit = PAN_LIMIT * vp.zoom;
    vp.x = Math.max(-limit, Math.min(limit, vp.x));
    vp.y = Math.max(-limit, Math.min(limit, vp.y));
}

export function createEditorState(): EditorState {
    return {
        selectedNodeIds: [],
        hoveredNodeId: null,
        activeTool: "select",
        isDragging: false,
        previewRect: null,
        pendingGeometry: null,
        viewport: { x: 0, y: 0, zoom: 1 }
    };
}
