/**
 * @module emitSVG
 * @description SVG backend for the render model. Consumes a `DisplayList` and
 * transcribes it to SVG DOM — creating/reusing the group structure, walking each
 * DrawItem to `document.createElementNS` calls, and setting exactly the attributes
 * the item's resolved paint declares. It does NO arithmetic and makes NO draw
 * decisions (all resolved in `buildRenderModel`); its only branching is the
 * shape-kind switch, the grid `data-sig` cache short-circuit, and the pure
 * translate-vs-matrix transform format. That is why the pure model is unit-tested
 * and this backend is covered by the browser smoke tests: it has no logic to get
 * wrong beyond DOM-API transcription the browser guarantees.
 *
 * Structure (reused across calls, never torn down):
 *   svg > g#viewport-transform > { g#grid, g#content, g#overlay }
 */

import { toMatrixString, isTranslationOnly } from "../core/geometry/Matrix";
import { DisplayList, DrawItem, Paint } from "./RenderModel";

const svgNS = "http://www.w3.org/2000/svg";

function getOrCreateGroup(parent: Element, id: string): SVGGElement {
    let group = parent.querySelector(`:scope > g#${id}`) as SVGGElement | null;
    if (!group) {
        group = document.createElementNS(svgNS, "g");
        group.setAttribute("id", id);
        parent.appendChild(group);
    }
    return group;
}

function clearChildren(el: Element): void {
    while (el.firstChild) el.removeChild(el.firstChild);
}

/** Transform, hit-test tags, and interaction styles shared by every item. */
function applyTail(el: SVGElement, item: DrawItem): void {
    if (item.world) {
        if (!isTranslationOnly(item.world)) el.setAttribute("transform", toMatrixString(item.world));
        else el.setAttribute("transform", `translate(${item.world.e}, ${item.world.f})`);
    }
    if (item.nodeId !== null) el.setAttribute("data-node-id", item.nodeId);
    if (item.handle) el.setAttribute("data-resize-handle", item.handle);
    const paint = item.paint;
    if (paint.cursor !== null) el.style.cursor = paint.cursor;
    if (!paint.pointerEvents) el.style.pointerEvents = "none";
}

function applyRectPaint(el: SVGElement, paint: Paint): void {
    if (paint.fill !== null) el.setAttribute("fill", paint.fill);
    if (paint.opacity !== null) el.setAttribute("opacity", String(paint.opacity));
    if (paint.radius !== null) el.setAttribute("rx", String(paint.radius));
    if (paint.stroke !== null) el.setAttribute("stroke", paint.stroke);
    if (paint.strokeWidth !== null) el.setAttribute("stroke-width", String(paint.strokeWidth));
    if (paint.strokeDash !== null) el.setAttribute("stroke-dasharray", paint.strokeDash);
}

function appendItem(group: SVGGElement, item: DrawItem): void {
    const shape = item.shape;
    const paint = item.paint;

    if (shape.kind === "rect") {
        const el = document.createElementNS(svgNS, "rect");
        el.setAttribute("x", String(shape.x));
        el.setAttribute("y", String(shape.y));
        el.setAttribute("width", String(shape.width));
        el.setAttribute("height", String(shape.height));
        applyRectPaint(el, paint);
        applyTail(el, item);
        group.appendChild(el);
    } else if (shape.kind === "line") {
        const el = document.createElementNS(svgNS, "line");
        el.setAttribute("x1", String(shape.x1));
        el.setAttribute("y1", String(shape.y1));
        el.setAttribute("x2", String(shape.x2));
        el.setAttribute("y2", String(shape.y2));
        if (paint.stroke !== null) el.setAttribute("stroke", paint.stroke);
        if (paint.strokeWidth !== null) el.setAttribute("stroke-width", String(paint.strokeWidth));
        applyTail(el, item);
        group.appendChild(el);
    } else if (shape.kind === "text") {
        const fo = document.createElementNS(svgNS, "foreignObject");
        fo.setAttribute("x", String(shape.x));
        fo.setAttribute("y", String(shape.y));
        fo.setAttribute("width", String(shape.width));
        fo.setAttribute("height", String(shape.height));
        if (paint.opacity !== null) fo.setAttribute("opacity", String(paint.opacity));
        const div = document.createElement("div");
        div.style.width = "100%";
        div.style.height = "100%";
        if (paint.fill !== null) div.style.color = paint.fill;
        div.style.fontSize = `${shape.fontSize}px`;
        div.style.overflow = "hidden";
        div.textContent = shape.text;
        fo.appendChild(div);
        applyTail(fo, item);
        group.appendChild(fo);
    } else if (shape.kind === "image") {
        const el = document.createElementNS(svgNS, "image");
        el.setAttribute("x", String(shape.x));
        el.setAttribute("y", String(shape.y));
        el.setAttribute("width", String(shape.width));
        el.setAttribute("height", String(shape.height));
        if (shape.href) el.setAttribute("href", shape.href);
        if (paint.opacity !== null) el.setAttribute("opacity", String(paint.opacity));
        el.setAttribute("preserveAspectRatio", "none");
        applyTail(el, item);
        group.appendChild(el);
    }
}

export function emitSVG(container: HTMLElement, model: DisplayList): void {
    let svg = container.querySelector("svg") as SVGSVGElement | null;
    if (!svg) {
        svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.style.background = "#1a1a2e";
        container.appendChild(svg);
    }

    const z = Math.max(0.01, model.viewport.zoom);
    const g = getOrCreateGroup(svg, "viewport-transform");
    g.setAttribute("transform", `translate(${-model.viewport.x}, ${-model.viewport.y}) scale(${z})`);

    const gridGroup = getOrCreateGroup(g, "grid");
    const contentGroup = getOrCreateGroup(g, "content");
    const overlayGroup = getOrCreateGroup(g, "overlay");

    // Skip the (expensive) grid rebuild when the visible range is unchanged.
    if (gridGroup.getAttribute("data-sig") !== model.grid.sig) {
        gridGroup.setAttribute("data-sig", model.grid.sig);
        clearChildren(gridGroup);
        model.grid.lines.forEach(item => appendItem(gridGroup, item));
    }

    clearChildren(contentGroup);
    model.content.forEach(item => appendItem(contentGroup, item));

    clearChildren(overlayGroup);
    model.overlay.forEach(item => appendItem(overlayGroup, item));
}
