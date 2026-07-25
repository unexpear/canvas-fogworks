/**
 * @module RenderModel
 * @description The renderer's pure, DOM-free display list. `buildRenderModel`
 * turns a document + its `ComputedState` + the current `RendererState` into a
 * plain-data `DisplayList` — every draw decision (which shape, resolved paint,
 * placement matrix, the grid's visible-range signature, selection overlay) lives
 * here, where it can be asserted in the `node` test environment exactly like the
 * layout engine. The backends (`emitSVG`, later `emitCanvas`) are dumb: they
 * transcribe this list to DOM/canvas API calls and do no arithmetic.
 *
 * Renderer invariant (mechanically enforced): this module imports ONLY the
 * `Mat2D` *type* from the geometry layer — never `multiply`/`compose`. Positions
 * come straight from `ComputedState` (`world`/`local`/`bounds`); the model never
 * composes coordinates. It reads shape params from `local.width/height`, places
 * by the pre-computed `world`, and outlines/handles from world-space `bounds`.
 */

import { ReadonlyDocument } from "../core/document/Document";
import { ComputedState } from "../core/geometry/GeometryEngine";
import { Mat2D } from "../core/geometry/Matrix";
import { RendererState } from "./RendererState";

const GRID_BASE = 20;
const GRID_MAX_LINES_PER_AXIS = 300; // density cap: coarsen the grid instead of exploding line count
/** Resize-handle size in SCREEN pixels (converted to world by dividing by zoom). */
export const HANDLE_SIZE_PX = 8;

/** Container pixel size, read from the DOM by the thin `renderSVG` shim and passed in. */
export interface Size {
    width: number;
    height: number;
}

/** A draw primitive in the node's LOCAL space (world placement lives on the item). */
export type Shape =
    | { kind: "rect"; x: number; y: number; width: number; height: number }
    | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
    | { kind: "text"; x: number; y: number; width: number; height: number; text: string; fontSize: number }
    | { kind: "image"; x: number; y: number; width: number; height: number; href: string | null };

/**
 * Resolved appearance. A `null` field is ABSENT (the backend emits no attribute);
 * a non-null field is present with that value — this reproduces the current
 * renderer's attribute presence rules exactly (e.g. the unknown-type fallback rect
 * carries no `opacity`, an outline carries `fill: "none"`). Z-dependent values
 * (`strokeWidth: 1/z`, `strokeDash`) are resolved to world units here so the
 * backend does zero maths.
 */
export interface Paint {
    fill: string | null;
    opacity: number | null;
    stroke: string | null;
    strokeWidth: number | null;
    strokeDash: string | null;
    radius: number | null;
    cursor: string | null;
    /** `false` → the backend sets `pointer-events: none` (grid/outline/preview). */
    pointerEvents: boolean;
}

export type DrawRole = "grid-line" | "content" | "outline" | "handle" | "preview";

/** One resolved primitive: a shape, its paint, its world placement, and hit-test tags. */
export interface DrawItem {
    shape: Shape;
    paint: Paint;
    /** World placement. `null` → the backend emits no transform (overlay/grid are in world space already). */
    world: Mat2D | null;
    /** `data-node-id` for hit-testing; `null` → not emitted. */
    nodeId: string | null;
    /** `data-resize-handle` for resize hit-testing (handles only). */
    handle?: string;
    role: DrawRole;
}

/**
 * The grid as data. `sig` is the visible-range signature that drives the
 * incremental cache: when it is unchanged the backend leaves the grid DOM alone.
 * `unchanged` records that the builder reused `prev`'s lines by reference (an
 * allocation optimisation for the common viewport-static case, e.g. node drags).
 */
export interface GridModel {
    sig: string;
    lines: DrawItem[];
    unchanged: boolean;
}

/** The whole frame as plain, serializable data. */
export interface DisplayList {
    viewport: { x: number; y: number; zoom: number };
    grid: GridModel;
    content: DrawItem[];
    overlay: DrawItem[];
}

function isFiniteRect(r: { x: number; y: number; width: number; height: number }): boolean {
    return Number.isFinite(r.x) && Number.isFinite(r.y) &&
        Number.isFinite(r.width) && Number.isFinite(r.height);
}

function lineItem(x1: number, y1: number, x2: number, y2: number, stroke: string, strokeWidth: number): DrawItem {
    return {
        shape: { kind: "line", x1, y1, x2, y2 },
        paint: {
            fill: null, opacity: null, stroke, strokeWidth,
            strokeDash: null, radius: null, cursor: null, pointerEvents: false
        },
        world: null,
        nodeId: null,
        role: "grid-line"
    };
}

function buildGrid(
    size: Size,
    viewport: { x: number; y: number },
    z: number,
    prev: DisplayList | null | undefined
): GridModel {
    const vpW = (size.width || 800) / z;
    const vpH = (size.height || 600) / z;

    // Coarsen the grid at low zoom so the visible line count stays bounded.
    let gridSize = GRID_BASE;
    while (vpW / gridSize > GRID_MAX_LINES_PER_AXIS || vpH / gridSize > GRID_MAX_LINES_PER_AXIS) {
        gridSize *= 2;
    }

    const startX = Math.floor(viewport.x / z / gridSize) * gridSize;
    const startY = Math.floor(viewport.y / z / gridSize) * gridSize;

    // Same signature the DOM cache keys on. Unchanged visible range → reuse prev's
    // lines by reference (avoids rebuilding the line array on every node drag).
    const sig = `${startX}|${startY}|${gridSize}|${Math.round(vpW)}|${Math.round(vpH)}|${z.toFixed(4)}`;
    if (prev && prev.grid.sig === sig) {
        return { sig, lines: prev.grid.lines, unchanged: true };
    }

    const endX = startX + vpW + gridSize * 2;
    const endY = startY + vpH + gridSize * 2;
    const sw = 1 / z;
    const lines: DrawItem[] = [];

    for (let x = startX; x < endX; x += gridSize) {
        lines.push(lineItem(x, startY, x, endY, x % (gridSize * 5) === 0 ? "#ffffff0a" : "#ffffff05", sw));
    }
    for (let y = startY; y < endY; y += gridSize) {
        lines.push(lineItem(startX, y, endX, y, y % (gridSize * 5) === 0 ? "#ffffff0a" : "#ffffff05", sw));
    }
    return { sig, lines, unchanged: false };
}

function buildContent(doc: ReadonlyDocument, computed: ComputedState, z: number): DrawItem[] {
    const items: DrawItem[] = [];

    // Paint in computed draw order (scene-graph order), using resolved world rects.
    computed.order.forEach((id: string) => {
        const node = doc.nodes.get(id);
        const c = computed.nodes.get(id);
        if (!node || !c) return;
        if (!isFiniteRect(c.bounds)) return;
        const sty = node.style;
        // The world matrix carries position/rotation/scale, so the shape itself is
        // emitted at the local origin and placed by the transform.
        const x = 0, y = 0, width = c.local.width, height = c.local.height;

        let shape: Shape;
        let paint: Paint;

        if (node.type === "core.rectangle") {
            shape = { kind: "rect", x, y, width, height };
            paint = {
                fill: sty.fill,
                opacity: sty.opacity,
                stroke: sty.stroke ? sty.stroke : null,
                strokeWidth: sty.stroke ? 1 / z : null,
                strokeDash: null,
                radius: sty.radius ? sty.radius : null,
                cursor: "pointer",
                pointerEvents: true
            };
        } else if (node.type === "core.text") {
            shape = { kind: "text", x, y, width, height, text: node.text ?? "Text", fontSize: sty.fontSize ?? 14 };
            paint = {
                fill: sty.fill, opacity: sty.opacity, stroke: null, strokeWidth: null,
                strokeDash: null, radius: null, cursor: "pointer", pointerEvents: true
            };
        } else if (node.type === "core.image") {
            shape = { kind: "image", x, y, width, height, href: node.src ?? null };
            paint = {
                fill: null, opacity: sty.opacity, stroke: null, strokeWidth: null,
                strokeDash: null, radius: null, cursor: "pointer", pointerEvents: true
            };
        } else {
            // Unknown type: magenta debug rect (no opacity attr — matches the old renderer).
            shape = { kind: "rect", x, y, width, height };
            paint = {
                fill: "#ff006e33", opacity: null, stroke: "#ff006e", strokeWidth: 1 / z,
                strokeDash: null, radius: null, cursor: "pointer", pointerEvents: true
            };
        }

        items.push({ shape, paint, world: c.world, nodeId: id, role: "content" });
    });

    return items;
}

function outlineItem(
    geo: { x: number; y: number; width: number; height: number },
    pad: number,
    stroke: string,
    strokeWidth: number
): DrawItem {
    return {
        shape: { kind: "rect", x: geo.x - pad, y: geo.y - pad, width: geo.width + pad * 2, height: geo.height + pad * 2 },
        paint: {
            fill: "none", opacity: null, stroke, strokeWidth,
            strokeDash: null, radius: null, cursor: null, pointerEvents: false
        },
        world: null,
        nodeId: null,
        role: "outline"
    };
}

function buildOverlay(state: RendererState, z: number): DrawItem[] {
    const items: DrawItem[] = [];
    const computed = state.computed;
    const selectedSet = new Set(state.selectedNodeIds);

    // Selection + hover outlines, in the same computed draw order as the content.
    computed.order.forEach((id: string) => {
        const c = computed.nodes.get(id);
        if (!c || !isFiniteRect(c.bounds)) return;
        const geo = c.bounds;
        if (selectedSet.has(id)) {
            items.push(outlineItem(geo, 3 / z, "#00bfff", 1.5 / z));
        } else if (state.hoveredNodeId === id) {
            items.push(outlineItem(geo, 2 / z, "#ffffff44", 1 / z));
        }
    });

    // Resize handles (world-space). Clamp in SCREEN pixels, convert to world once.
    const HS = HANDLE_SIZE_PX / z;
    state.selectedNodeIds.forEach(nodeId => {
        const c = computed.nodes.get(nodeId);
        if (!c || !isFiniteRect(c.bounds)) return;
        const geo = c.bounds;
        const corners: { handle: string; cx: number; cy: number; cursor: string }[] = [
            { handle: "nw", cx: geo.x, cy: geo.y, cursor: "nwse-resize" },
            { handle: "ne", cx: geo.x + geo.width, cy: geo.y, cursor: "nesw-resize" },
            { handle: "sw", cx: geo.x, cy: geo.y + geo.height, cursor: "nesw-resize" },
            { handle: "se", cx: geo.x + geo.width, cy: geo.y + geo.height, cursor: "nwse-resize" }
        ];
        corners.forEach(({ handle, cx, cy, cursor }) => {
            items.push({
                shape: { kind: "rect", x: cx - HS / 2, y: cy - HS / 2, width: HS, height: HS },
                paint: {
                    fill: "#ffffff", opacity: null, stroke: "#00bfff", strokeWidth: 1 / z,
                    strokeDash: null, radius: null, cursor, pointerEvents: true
                },
                world: null,
                nodeId,
                handle,
                role: "handle"
            });
        });
    });

    // Rectangle-tool drag preview.
    const preview = state.previewRect;
    if (preview && isFiniteRect(preview) && preview.width > 0 && preview.height > 0) {
        items.push({
            shape: { kind: "rect", x: preview.x, y: preview.y, width: preview.width, height: preview.height },
            paint: {
                fill: "#4a90d933", opacity: null, stroke: "#4a90d9", strokeWidth: 1 / z,
                strokeDash: `${4 / z} ${4 / z}`, radius: null, cursor: null, pointerEvents: false
            },
            world: null,
            nodeId: null,
            role: "preview"
        });
    }

    return items;
}

/**
 * Pure function of `(size, doc, state, prev)` — no DOM, no `Date`/`Math.random`.
 * `prev` (the last frame's list for this container) lets an unchanged grid reuse
 * its lines by reference; pass `null`/`undefined` to always rebuild.
 */
export function buildRenderModel(
    size: Size,
    doc: ReadonlyDocument,
    state: RendererState,
    prev?: DisplayList | null
): DisplayList {
    const z = Math.max(0.01, state.viewport.zoom);
    return {
        viewport: state.viewport,
        grid: buildGrid(size, state.viewport, z, prev),
        content: buildContent(doc, state.computed, z),
        overlay: buildOverlay(state, z)
    };
}
