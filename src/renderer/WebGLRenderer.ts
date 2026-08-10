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
 * AND IT SAYS SO, WHICH IT DID NOT. A silent fallback is worse than a visible failure for a reason
 * that took a whole verification session to notice: the picture appears, the backend stamp reads
 * "webgl", every probe looks healthy — and nothing GPU-specific has run. Every "verified on the GPU"
 * claim made by driving the live app was measuring Canvas. So the fallback now records WHY, once per
 * distinct reason, in three places a person or a probe might look: a console warning, a `data-`
 * attribute on the container, and (through the app) a line in the toolbar.
 *
 * It also registers the image-ready callback, for the same reason `CanvasRenderer` does: a decode
 * finishing is a reason to repaint, and it is the only one that arrives from outside the app.
 */

import { ReadonlyDocument } from "../core/document/Document";
import { buildRenderModel } from "./RenderModel";
import { RendererState } from "./RendererState";
import { emitWebGL, lastGLFailure } from "./emitWebGL";
import { renderCanvas } from "./CanvasRenderer";
import { setImageReadyCallback } from "./ImageCache";

/**
 * The attribute a fallback leaves on the container, and the app reads.
 *
 * A DOM ATTRIBUTE rather than a callback, because the fallback is discovered mid-frame inside an
 * imperative repaint that React does not own: a setState from here would be a render inside a render.
 * The app reads it after `renderScene` returns, which is the same place it already reads the size.
 */
export const GL_FALLBACK_ATTR = "vdeGlFallback";

/** Reasons already warned about, so a repaint loop reports each once rather than sixty times a second. */
const warned = new Set<string>();

/**
 * Why this PROCESS has no GPU path, once it is known — so the attempt is made once, not per frame.
 *
 * Every reason `initGL` can give is a property of the build or the driver: a shader that will not
 * compile now will not compile in a second, and a browser that refuses a context refuses the next
 * one too. Retrying per frame would mean creating a canvas and asking for a context sixty times a
 * second, which is precisely how a browser runs out of contexts and starts losing the oldest — the
 * cost the reuse above exists to avoid.
 *
 * THE PRICE IS THAT RECOVERY NEEDS A RELOAD, and that is the right trade for a cause that cannot
 * change under a running app. It is a module-level fact rather than a per-container one because the
 * causes are not per-container either.
 */
let noGpuPath: string | null = null;

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

    // ALREADY KNOWN TO BE IMPOSSIBLE: draw through Canvas without touching a canvas element or a
    // context. The reason is still stamped, because the app reads it every frame and a note that
    // vanished on the second frame would be worse than none.
    if (noGpuPath !== null) {
        container.dataset[GL_FALLBACK_ATTR] = noGpuPath;
        renderCanvas(container, doc, state, onAsyncReady);
        return;
    }

    // The canvas is reused across frames — a WebGL context is expensive to create, and creating
    // one per frame is how a browser runs out of contexts and starts silently losing the oldest.
    //
    // BUT NOT A CANVAS THAT ALREADY HOLDS A 2D CONTEXT. A canvas gives out ONE context type for
    // life, so reusing the one the Canvas backend left behind guarantees `getContext("webgl")`
    // answers null — and this function's own fallback is what puts that canvas there. So the first
    // fallback made every later frame fall back too, for a reason that had nothing to do with the
    // first: switching Canvas → WebGL could never work, and neither could recovering from one bad
    // frame. `getContext("2d")` is the honest test (it returns null on a canvas that holds a GL
    // context) and it cannot make things worse — a canvas with no context at all is one we are about
    // to replace anyway.
    let canvas = container.firstElementChild as HTMLCanvasElement | null;
    const reusable = canvas !== null && canvas.tagName === "CANVAS"
        && (canvas as HTMLCanvasElement).getContext("2d") === null;
    if (!reusable) {
        container.innerHTML = "";
        canvas = document.createElement("canvas");
        canvas.style.display = "block";
        container.appendChild(canvas);
    }
    canvas = canvas as HTMLCanvasElement;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const model = buildRenderModel(size, doc, state);
    const dpr = window.devicePixelRatio || 1;
    if (emitWebGL(canvas, model, state.viewport, dpr)) {
        delete container.dataset[GL_FALLBACK_ATTR];
        return;
    }
    // No GPU path available: hand the frame to Canvas, which shares the same display list — and
    // SAY SO, because a backend that quietly draws itself with another one is indistinguishable
    // from a backend that works.
    const why = lastGLFailure() ?? "no reason recorded";
    noGpuPath = why;
    container.dataset[GL_FALLBACK_ATTR] = why;
    if (!warned.has(why)) {
        warned.add(why);
        console.warn(`[VDE] The WebGL backend is drawing through Canvas instead: ${why}`);
    }
    container.innerHTML = "";
    renderCanvas(container, doc, state, onAsyncReady);
}
