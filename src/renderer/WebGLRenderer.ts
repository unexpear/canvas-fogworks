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
 *
 * It also registers the image-ready callback, for the same reason `CanvasRenderer` does: a decode
 * finishing is a reason to repaint, and it is the only one that arrives from outside the app.
 */

import { ReadonlyDocument } from "../core/document/Document";
import { buildRenderModel } from "./RenderModel";
import { RendererState } from "./RendererState";
import { emitWebGL } from "./emitWebGL";
import { renderCanvas } from "./CanvasRenderer";
import { setImageReadyCallback } from "./ImageCache";

export function renderWebGL(
    container: HTMLElement,
    doc: ReadonlyDocument,
    state: RendererState,
    onAsyncReady?: () => void
): void {
    // An image DECODES asynchronously, so the frame that first wants one cannot have it. Without
    // this the GPU backend drew the picture only when something ELSE happened to repaint — open a
    // document straight into WebGL and the image stayed missing until you moved the canvas. Canvas
    // has always registered this; the GPU path went without because it had no images to wait for.
    setImageReadyCallback(onAsyncReady ?? null);
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
