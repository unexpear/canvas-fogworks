/**
 * @module SVGRenderer
 * @description Read-only renderer. Draws the grid, nodes, selection/hover
 * outlines, resize handles, and the rectangle-tool preview.
 *
 * Structure (all reused across calls, never torn down):
 *   svg > g#viewport-transform > { g#grid, g#content, g#overlay }
 * The viewport transform is re-applied every frame, but the grid's children are
 * only regenerated when the visible range changes — so node drags and selection
 * changes (which don't move the viewport) don't thrash thousands of grid lines.
 */

import { ReadonlyDocument } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { ComputedGeometry } from "../core/geometry/ComputedGeometry";

const svgNS = "http://www.w3.org/2000/svg";
const GRID_BASE = 20;
const GRID_MAX_LINES_PER_AXIS = 300; // density cap: coarsen the grid instead of exploding line count
/** Resize-handle size in SCREEN pixels (converted to world by dividing by zoom). */
export const HANDLE_SIZE_PX = 8;

type Rect = { x: number; y: number; width: number; height: number };

export interface RendererState {
    selectedNodeIds: string[];
    hoveredNodeId: string | null;
    previewRect?: Rect | null;
    /**
     * Resolved world geometry + draw order. The renderer reads ONLY this for
     * positions — it never composes coordinates itself. In Milestone 1 this
     * becomes the full ComputedState.
     */
    computed: ComputedGeometry;
    viewport: { x: number; y: number; zoom: number };
}

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

function isFiniteGeometry(geo: { x: number; y: number; width: number; height: number }): boolean {
    return Number.isFinite(geo.x) && Number.isFinite(geo.y) &&
        Number.isFinite(geo.width) && Number.isFinite(geo.height);
}

export function renderSVG(
    container: HTMLElement,
    doc: ReadonlyDocument,
    state: RendererState
): void {
    let svg = container.querySelector("svg") as SVGSVGElement | null;
    if (!svg) {
        svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.style.background = "#1a1a2e";
        container.appendChild(svg);
    }

    const z = Math.max(0.01, state.viewport.zoom);

    const g = getOrCreateGroup(svg, "viewport-transform");
    g.setAttribute("transform", `translate(${-state.viewport.x}, ${-state.viewport.y}) scale(${z})`);

    const gridGroup = getOrCreateGroup(g, "grid");
    const contentGroup = getOrCreateGroup(g, "content");
    const overlayGroup = getOrCreateGroup(g, "overlay");

    renderGrid(gridGroup, container, state, z);
    renderContent(contentGroup, doc, z, state.computed);
    renderOverlay(overlayGroup, doc, state, z);
}

function renderGrid(gridGroup: SVGGElement, container: HTMLElement, state: RendererState, z: number): void {
    const vpW = (container.clientWidth || 800) / z;
    const vpH = (container.clientHeight || 600) / z;

    // Coarsen the grid at low zoom so the visible line count stays bounded.
    let gridSize = GRID_BASE;
    while (vpW / gridSize > GRID_MAX_LINES_PER_AXIS || vpH / gridSize > GRID_MAX_LINES_PER_AXIS) {
        gridSize *= 2;
    }

    const startX = Math.floor(state.viewport.x / z / gridSize) * gridSize;
    const startY = Math.floor(state.viewport.y / z / gridSize) * gridSize;

    // Skip the (expensive) rebuild when the visible range is unchanged.
    const sig = `${startX}|${startY}|${gridSize}|${Math.round(vpW)}|${Math.round(vpH)}|${z.toFixed(4)}`;
    if (gridGroup.getAttribute("data-sig") === sig) return;
    gridGroup.setAttribute("data-sig", sig);
    clearChildren(gridGroup);

    const endX = startX + vpW + gridSize * 2;
    const endY = startY + vpH + gridSize * 2;

    for (let x = startX; x < endX; x += gridSize) {
        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", String(x));
        line.setAttribute("y1", String(startY));
        line.setAttribute("x2", String(x));
        line.setAttribute("y2", String(endY));
        line.setAttribute("stroke", x % (gridSize * 5) === 0 ? "#ffffff0a" : "#ffffff05");
        line.setAttribute("stroke-width", String(1 / z));
        line.style.pointerEvents = "none";
        gridGroup.appendChild(line);
    }
    for (let y = startY; y < endY; y += gridSize) {
        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", String(startX));
        line.setAttribute("y1", String(y));
        line.setAttribute("x2", String(endX));
        line.setAttribute("y2", String(y));
        line.setAttribute("stroke", y % (gridSize * 5) === 0 ? "#ffffff0a" : "#ffffff05");
        line.setAttribute("stroke-width", String(1 / z));
        line.style.pointerEvents = "none";
        gridGroup.appendChild(line);
    }
}

function renderContent(
    contentGroup: SVGGElement,
    doc: ReadonlyDocument,
    z: number,
    computed: ComputedGeometry
): void {
    clearChildren(contentGroup);

    // Paint in computed draw order (scene-graph order), using resolved world rects.
    computed.order.forEach((id: string) => {
        const node = doc.nodes.get(id);
        const geo = computed.rects.get(id);
        if (!node || !geo) return;
        const sty = node.style;
        if (!isFiniteGeometry(geo)) return;

        let el: SVGElement | null = null;

        if (node.type === "core.rectangle") {
            const rect = document.createElementNS(svgNS, "rect");
            rect.setAttribute("x", String(geo.x));
            rect.setAttribute("y", String(geo.y));
            rect.setAttribute("width", String(geo.width));
            rect.setAttribute("height", String(geo.height));
            rect.setAttribute("fill", sty.fill);
            rect.setAttribute("opacity", String(sty.opacity));
            if (sty.radius) rect.setAttribute("rx", String(sty.radius));
            if (sty.stroke) {
                rect.setAttribute("stroke", sty.stroke);
                rect.setAttribute("stroke-width", String(1 / z));
            }
            el = rect;
        } else if (node.type === "core.text") {
            const fo = document.createElementNS(svgNS, "foreignObject");
            fo.setAttribute("x", String(geo.x));
            fo.setAttribute("y", String(geo.y));
            fo.setAttribute("width", String(geo.width));
            fo.setAttribute("height", String(geo.height));
            fo.setAttribute("opacity", String(sty.opacity));
            const div = document.createElement("div");
            div.style.width = "100%";
            div.style.height = "100%";
            div.style.color = sty.fill;
            div.style.fontSize = `${sty.fontSize ?? 14}px`;
            div.style.overflow = "hidden";
            div.textContent = node.text ?? "Text";
            fo.appendChild(div);
            el = fo;
        } else if (node.type === "core.image") {
            const img = document.createElementNS(svgNS, "image");
            img.setAttribute("x", String(geo.x));
            img.setAttribute("y", String(geo.y));
            img.setAttribute("width", String(geo.width));
            img.setAttribute("height", String(geo.height));
            if (node.src) img.setAttribute("href", node.src);
            img.setAttribute("opacity", String(sty.opacity));
            img.setAttribute("preserveAspectRatio", "none");
            el = img;
        } else {
            const rect = document.createElementNS(svgNS, "rect");
            rect.setAttribute("x", String(geo.x));
            rect.setAttribute("y", String(geo.y));
            rect.setAttribute("width", String(geo.width));
            rect.setAttribute("height", String(geo.height));
            rect.setAttribute("fill", "#ff006e33");
            rect.setAttribute("stroke", "#ff006e");
            rect.setAttribute("stroke-width", String(1 / z));
            el = rect;
        }

        if (el) {
            el.setAttribute("data-node-id", id);
            el.style.cursor = "pointer";
            contentGroup.appendChild(el);
        }
    });
}

function renderOverlay(overlayGroup: SVGGElement, doc: ReadonlyDocument, state: RendererState, z: number): void {
    clearChildren(overlayGroup);
    const selectedSet = new Set(state.selectedNodeIds);
    const computed = state.computed;

    // Selection + hover outlines, in the same computed draw order as the content.
    computed.order.forEach((id: string) => {
        const geo = computed.rects.get(id);
        if (!geo || !isFiniteGeometry(geo)) return;

        if (selectedSet.has(id)) {
            overlayGroup.appendChild(makeOutline(geo, 3 / z, "#00bfff", 1.5 / z));
        } else if (state.hoveredNodeId === id) {
            overlayGroup.appendChild(makeOutline(geo, 2 / z, "#ffffff44", 1 / z));
        }
    });

    // Resize handles (world-space, so they belong in the transform group).
    // Clamp in SCREEN pixels, then convert to world once. Clamping `8/z` directly
    // clamps a world-space size, so past zoom 2 (or below 0.5) the handle stopped
    // being 8px on screen — the opposite of what the clamp was for.
    const HS = HANDLE_SIZE_PX / z;
    state.selectedNodeIds.forEach(nodeId => {
        const geo = computed.rects.get(nodeId);
        if (!geo || !isFiniteGeometry(geo)) return;

        const corners: Record<string, { cx: number; cy: number; cursor: string }> = {
            "nw": { cx: geo.x, cy: geo.y, cursor: "nwse-resize" },
            "ne": { cx: geo.x + geo.width, cy: geo.y, cursor: "nesw-resize" },
            "sw": { cx: geo.x, cy: geo.y + geo.height, cursor: "nesw-resize" },
            "se": { cx: geo.x + geo.width, cy: geo.y + geo.height, cursor: "nwse-resize" }
        };

        Object.entries(corners).forEach(([handle, { cx, cy, cursor }]) => {
            const hr = document.createElementNS(svgNS, "rect");
            hr.setAttribute("x", String(cx - HS / 2));
            hr.setAttribute("y", String(cy - HS / 2));
            hr.setAttribute("width", String(HS));
            hr.setAttribute("height", String(HS));
            hr.setAttribute("fill", "#ffffff");
            hr.setAttribute("stroke", "#00bfff");
            hr.setAttribute("stroke-width", String(1 / z));
            hr.style.cursor = cursor;
            hr.setAttribute("data-node-id", nodeId);
            hr.setAttribute("data-resize-handle", handle);
            overlayGroup.appendChild(hr);
        });
    });

    // Rectangle-tool drag preview.
    const preview = state.previewRect;
    if (preview && isFiniteGeometry(preview) && preview.width > 0 && preview.height > 0) {
        const pr = document.createElementNS(svgNS, "rect");
        pr.setAttribute("x", String(preview.x));
        pr.setAttribute("y", String(preview.y));
        pr.setAttribute("width", String(preview.width));
        pr.setAttribute("height", String(preview.height));
        pr.setAttribute("fill", "#4a90d933");
        pr.setAttribute("stroke", "#4a90d9");
        pr.setAttribute("stroke-width", String(1 / z));
        pr.setAttribute("stroke-dasharray", `${4 / z} ${4 / z}`);
        pr.style.pointerEvents = "none";
        overlayGroup.appendChild(pr);
    }
}

function makeOutline(
    geo: { x: number; y: number; width: number; height: number },
    pad: number,
    stroke: string,
    strokeWidth: number
): SVGRectElement {
    const outline = document.createElementNS(svgNS, "rect");
    outline.setAttribute("x", String(geo.x - pad));
    outline.setAttribute("y", String(geo.y - pad));
    outline.setAttribute("width", String(geo.width + pad * 2));
    outline.setAttribute("height", String(geo.height + pad * 2));
    outline.setAttribute("fill", "none");
    outline.setAttribute("stroke", stroke);
    outline.setAttribute("stroke-width", String(strokeWidth));
    outline.style.pointerEvents = "none";
    return outline;
}
