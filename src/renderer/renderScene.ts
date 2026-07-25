/**
 * @module renderScene
 * @description Backend selector — renders a frame through the SVG or the Canvas backend,
 * from the SAME `buildRenderModel` `DisplayList`. On a backend switch it clears the
 * container (removing the other backend's element) and drops the SVG grid cache, so the
 * next frame starts clean; within a backend it just delegates each frame. DOM plumbing
 * (the untested boundary, like the two backends it dispatches to).
 */

import { ReadonlyDocument } from "../core/document/Document";
import { renderSVG, clearRenderState } from "./SVGRenderer";
import { renderCanvas } from "./CanvasRenderer";
import { RendererState } from "./RendererState";

export type RenderBackend = "svg" | "canvas";

export function renderScene(
    container: HTMLElement,
    doc: ReadonlyDocument,
    state: RendererState,
    backend: RenderBackend
): void {
    if (container.dataset.vdeBackend !== backend) {
        // Backend changed: the old element (and, for SVG, its cached grid) is now invalid.
        clearRenderState(container);
        container.innerHTML = "";
        container.dataset.vdeBackend = backend;
    }
    if (backend === "canvas") renderCanvas(container, doc, state);
    else renderSVG(container, doc, state);
}
