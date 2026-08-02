/**
 * @module WebGLRenderer
 * @description The thin DOM shim for the GPU backend — the twin of `CanvasRenderer`.
 *
 * It owns exactly what `emitWebGL` must not: finding or creating the `<canvas>`, reading its
 * size and the device pixel ratio, and building the display list. Everything after that is the
 * backend's, and everything before it is the model's.
 *
 * FALLS BACK rather than failing. If WebGL is unavailable — an old GPU, a headless run, a driver
 * that refuses a context — `emitWebGL` returns false and this draws the frame through the Canvas
 * backend instead. A renderer that shows nothing is the one outcome a user cannot diagnose.
 */

import { ReadonlyDocument } from "../core/document/Document";
import { buildRenderModel } from "./RenderModel";
import { RendererState } from "./RendererState";
import { emitWebGL } from "./emitWebGL";
import { renderCanvas } from "./CanvasRenderer";

export function renderWebGL(
    container: HTMLElement,
    doc: ReadonlyDocument,
    state: RendererState,
    onAsyncReady?: () => void
): void {
    const size = { width: container.clientWidth, height: container.clientHeight };

    // The canvas is reused across frames — a WebGL context is expensive to create, and creating
    // one per frame is how a browser runs out of contexts and starts silently losing the oldest.
    let canvas = container.firstElementChild as HTMLCanvasElement | null;
    if (!canvas || canvas.tagName !== "CANVAS") {
        container.innerHTML = "";
        canvas = document.createElement("canvas");
        canvas.style.display = "block";
        container.appendChild(canvas);
    }
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const model = buildRenderModel(size, doc, state);
    const dpr = window.devicePixelRatio || 1;
    if (!emitWebGL(canvas, model, state.viewport, dpr)) {
        // No GPU path available: hand the frame to Canvas, which shares the same display list.
        container.innerHTML = "";
        renderCanvas(container, doc, state, onAsyncReady);
    }
}
