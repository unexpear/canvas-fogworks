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
import { renderWebGL } from "./WebGLRenderer";
import { RendererState } from "./RendererState";

export type RenderBackend = "svg" | "canvas" | "webgl";

export function renderScene(
    container: HTMLElement,
    doc: ReadonlyDocument,
    state: RendererState,
    backend: RenderBackend,
    onAsyncReady?: () => void
): void {
    if (container.dataset.vdeBackend !== backend) {
        // Backend changed: the old element (and, for SVG, its cached grid) is now invalid.
        clearRenderState(container);
        container.innerHTML = "";
        container.dataset.vdeBackend = backend;
    }
    // `onAsyncReady` repaints when a lazily-loaded resource (a Canvas image) finishes decoding.
    if (backend === "canvas") renderCanvas(container, doc, state, onAsyncReady);
    // WEBGL draws fills as triangles; it falls back to Canvas by itself when no context is
    // available, so this dispatch never has to know whether a GPU is there.
    else if (backend === "webgl") renderWebGL(container, doc, state, onAsyncReady);
    else renderSVG(container, doc, state);
}
