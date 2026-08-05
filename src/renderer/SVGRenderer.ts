/**
 * @module SVGRenderer
 * @description Read-only renderer entry point. Thin composition of the pure
 * `buildRenderModel` (all draw decisions, testable in the `node` env) and the
 * `emitSVG` backend (DOM transcription). It measures the container, threads the
 * previous frame's `DisplayList` so the grid's incremental cache survives, and
 * emits. All the logic that used to live in the private `renderGrid`/
 * `renderContent`/`renderOverlay` passes now lives across those two modules.
 *
 * `renderSVG`, `RendererState`, and `HANDLE_SIZE_PX` keep their old import paths
 * so `App.tsx` and the API-surface pin are unchanged.
 */

import { setImageReadyCallback } from "./ImageCache";
import { ReadonlyDocument } from "../core/document/Document";
import { buildRenderModel, DisplayList } from "./RenderModel";
import { emitSVG } from "./emitSVG";
import { RendererState } from "./RendererState";

export { RendererState } from "./RendererState";
export { HANDLE_SIZE_PX } from "./RenderModel";

/** Last frame's list per container, so an unchanged grid reuses its lines by reference. */
const prevByContainer = new WeakMap<HTMLElement, DisplayList>();

export function renderSVG(
    container: HTMLElement,
    doc: ReadonlyDocument,
    state: RendererState,
    onAsyncReady?: () => void
): void {
    // THIS BACKEND NOW WAITS FOR A DECODE TOO, which it never used to. A whole image is just an
    // `<image href>` the browser fetches and paints by itself, so nothing here cared when it
    // landed. A SOURCE REGION cannot work that way: it is drawn through a nested `<svg>` whose
    // viewBox is in the image's own pixels, so the natural size has to be known before anything
    // can be placed — and until the decode finishes the tile draws nothing at all. Found live,
    // where a tile-sheet demo showed its whole-sheet control and none of its four tiles.
    setImageReadyCallback(onAsyncReady ?? null);
    const size = { width: container.clientWidth, height: container.clientHeight };
    const prev = prevByContainer.get(container) ?? null;
    const model = buildRenderModel(size, doc, state, prev);
    prevByContainer.set(container, model);
    emitSVG(container, model);
}

/**
 * Drop the cached previous frame for a container. Call this when the container's DOM is
 * cleared out from under the renderer (e.g. switching to the Canvas backend), or the grid's
 * `unchanged` cache would skip re-drawing a grid that no longer exists in the DOM.
 */
export function clearRenderState(container: HTMLElement): void {
    prevByContainer.delete(container);
}
