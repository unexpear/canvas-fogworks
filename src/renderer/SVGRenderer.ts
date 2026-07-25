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
    state: RendererState
): void {
    const size = { width: container.clientWidth, height: container.clientHeight };
    const prev = prevByContainer.get(container) ?? null;
    const model = buildRenderModel(size, doc, state, prev);
    prevByContainer.set(container, model);
    emitSVG(container, model);
}
