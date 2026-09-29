/**
 * @module textOverlay
 * @description Draws screen-space 2D text over the packaged 3D view with the shared typesetter.
 */
import { dropHidden } from "../core/document/Components";
import type { ReadonlyDocument } from "../core/document/Document";
import { flatFill } from "../core/document/Node";
import { resolveColor, type VariableStore } from "../core/document/Variables";
import { computeGeometry } from "../core/geometry/GeometryEngine";
import type { Mat2D } from "../core/geometry/Matrix";
import { drawTextInto, type TextPaint, type TextShape } from "../renderer/TextRaster";
import { resolveTypography } from "../renderer/Typography";

export interface PlayerTextItem { shape: TextShape; world: Mat2D; paint: TextPaint }

function overlayZoom(doc: ReadonlyDocument, width: number, height: number): number {
    const screen = doc.screen;
    if (!screen || !(screen.width > 0) || !(screen.height > 0)) return 1;
    const fitted = Math.min(width / screen.width, height / screen.height);
    return Number.isFinite(fitted) && fitted > 0 ? fitted : 1;
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function inkOpacity(doc: ReadonlyDocument, id: string): number {
    let opacity = 1, current: string | null = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
        seen.add(current);
        const node = doc.nodes.get(current);
        if (!node) break;
        opacity *= node.style.opacity;
        current = node.parent ?? null;
    }
    return opacity;
}

/** Screen-space `core.text` nodes. A node with a 3D transform is left for a later projection. */
export function playerTextPlan(doc: ReadonlyDocument, width: number, height: number): PlayerTextItem[] {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
    const visual = dropHidden(doc);
    const computed = computeGeometry(visual);
    const zoom = overlayZoom(visual, width, height);
    const view = { x: 0, y: 0, width: width / zoom, height: height / zoom };
    const store = visual.variables as VariableStore;
    const items: PlayerTextItem[] = [];
    for (const id of computed.order) {
        const node = visual.nodes.get(id), placed = computed.nodes.get(id);
        if (!node || !placed || node.type !== "core.text" || node.spatial3d) continue;
        if (typeof node.text !== "string" || !node.text.trim() || !overlaps(placed.bounds, view)) continue;
        const fill = typeof node.style.fill === "string"
            ? resolveColor(store, node.style.fill, visual.activeTheme) : flatFill(node.style.fill);
        items.push({
            world: placed.world,
            shape: { kind: "text", x: 0, y: 0, width: placed.local.width, height: placed.local.height,
                text: node.text, ...resolveTypography(node.style, store, visual.activeTheme) },
            paint: { fill, opacity: inkOpacity(visual, id) }
        });
    }
    return items;
}

/** Rasterises `playerTextPlan` into a transparent overlay. The WebGL canvas stays untouched. */
export function drawPlayerText(canvas: HTMLCanvasElement, doc: ReadonlyDocument, width: number, height: number, dpr = 1): void {
    const safeW = Number.isInteger(width) && width > 0 && width <= 16384 ? width : 0;
    const safeH = Number.isInteger(height) && height > 0 && height <= 16384 ? height : 0;
    const plan = safeW && safeH ? playerTextPlan(doc, safeW, safeH) : [];
    canvas.dataset.count = String(plan.length);
    canvas.dataset.text = plan.map(item => item.shape.text).join("\n");
    canvas.dataset.font = plan.map(item => item.shape.fontFamily).join("\n");
    canvas.dataset.presented = plan.length ? "true" : "false";
    if (!safeW || !safeH) return;
    const scale = Math.min(2, Math.max(0.1, Number.isFinite(dpr) && dpr > 0 ? dpr : 1));
    const backingW = Math.max(1, Math.round(safeW * scale)), backingH = Math.max(1, Math.round(safeH * scale));
    if (canvas.width !== backingW) canvas.width = backingW;
    if (canvas.height !== backingH) canvas.height = backingH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const zoom = overlayZoom(doc, safeW, safeH);
    for (const item of plan) {
        ctx.save();
        ctx.setTransform(zoom * scale, 0, 0, zoom * scale, 0, 0);
        ctx.transform(item.world.a, item.world.b, item.world.c, item.world.d, item.world.e, item.world.f);
        drawTextInto(ctx, item.shape, item.paint);
        ctx.restore();
    }
}
