/**
 * @module CanvasRenderer
 * @description Canvas backend entry point — the immediate-mode twin of `renderSVG`. A thin
 * DOM shim: it ensures a `<canvas>` fills the container, sizes its backing store for the
 * device pixel ratio, and hands the SAME `buildRenderModel` `DisplayList` to `emitCanvas`.
 *
 * The MODEL is built in CSS pixels (`clientWidth/Height`, like `renderSVG`); the canvas
 * backing store is CSS × `devicePixelRatio` device pixels, and `emitCanvas` folds the DPR
 * into its base transform — so shapes stay crisp on HiDPI while culling and hit-testing keep
 * working in the same CSS-px world. All draw decisions live in the pure model; this module
 * only does canvas/DOM plumbing (the untested boundary, like `renderSVG`/`emitSVG` — validated
 * by browser smoke tests). Immediate-mode has no retained grid node, so there is no per-frame
 * cache to thread (the model's grid `unchanged` flag is inert here — every frame redraws).
 *
 * This element is sized in fixed CSS px (unlike the SVG root's `width/height=100%`), so `App`
 * must trigger a repaint on container-resize / DPR-change (a `ResizeObserver` + a resolution
 * media query) for the canvas to keep filling the pane and stay sharp.
 */

import { ReadonlyDocument } from "../core/document/Document";
import { buildRenderModel } from "./RenderModel";
import { emitCanvas, setImageReadyCallback } from "./emitCanvas";
import { RendererState } from "./RendererState";

export function renderCanvas(
    container: HTMLElement,
    doc: ReadonlyDocument,
    state: RendererState,
    onAsyncReady?: () => void
): void {
    // A lazily-loaded image repaints the canvas when it finishes decoding.
    setImageReadyCallback(onAsyncReady ?? null);
    const size = { width: container.clientWidth, height: container.clientHeight };

    // Reuse the container's <canvas>, or replace whatever else is there (e.g. an SVG left by
    // the other backend) — so a backend switch self-heals even without an external clear.
    let canvas = container.firstElementChild as HTMLCanvasElement | null;
    if (!canvas || canvas.tagName !== "CANVAS") {
        container.innerHTML = "";
        canvas = document.createElement("canvas");
        canvas.style.display = "block";
        container.appendChild(canvas);
    }

    const dpr = window.devicePixelRatio || 1;
    const deviceW = Math.round(size.width * dpr);
    const deviceH = Math.round(size.height * dpr);
    // Setting width/height clears the canvas, so only touch them when the size actually
    // changed (emitCanvas clears every frame anyway).
    if (canvas.width !== deviceW || canvas.height !== deviceH) {
        canvas.width = deviceW;
        canvas.height = deviceH;
    }
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const model = buildRenderModel(size, doc, state);
    emitCanvas(ctx, model, dpr);
}
