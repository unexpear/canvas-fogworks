/**
 * @module CanvasExport
 * @description Bounded whole-document PNG export through the shared Canvas renderer, with awaited images and no editor overlays.
 */
import { ReadonlyDocument } from "../core/document/Document";
import { computeGeometry, contentBounds } from "../core/geometry/GeometryEngine";
import { buildRenderModel } from "../renderer/RenderModel";
import { emitCanvas } from "../renderer/emitCanvas";
import { imageSizeAsync } from "../renderer/ImageCache";
import { EXPORT_MARGIN } from "../core/export/ExportSVG";

export function planCanvasExport(doc: ReadonlyDocument) {
    if ([...doc.nodes.values()].some(n => n.spatial3d?.renderable)) throw new Error("Whole-canvas PNG exports the 2D document; native 3D capture is not supported.");
    const computed = computeGeometry(doc), bounds = contentBounds(computed);
    if (!bounds) throw new Error("There is no visible content to export.");
    const width = Math.ceil(bounds.width + 2 * EXPORT_MARGIN), height = Math.ceil(bounds.height + 2 * EXPORT_MARGIN);
    if (!(width > 0 && height > 0) || width > 16384 || height > 16384 || width * height > 16_777_216) {
        throw new Error("PNG export exceeds the 16-megapixel or 16384-pixel side limit.");
    }
    const model = buildRenderModel({ width, height }, doc, { computed, selectedNodeIds: [], hoveredNodeId: null,
        viewport: { x: bounds.x - EXPORT_MARGIN, y: bounds.y - EXPORT_MARGIN, zoom: 1 } });
    return { width, height, model: { ...model, grid: { ...model.grid, lines: [] }, overlay: [] } };
}

export async function exportCanvasPng(doc: ReadonlyDocument): Promise<string> {
    const plan = planCanvasExport(doc);
    // Export must never silently omit images still being decoded by the interactive renderer.
    const hrefs = new Set<string>();
    for (const { shape } of plan.model.content) {
        if (shape.kind === "image" && !shape.surface && shape.href) hrefs.add(shape.href);
        if (shape.kind === "tilemap") {
            if (shape.href) hrefs.add(shape.href);
            for (const tile of shape.pictures?.values() ?? []) hrefs.add(tile.href);
        }
    }
    for (const href of hrefs) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const size = await Promise.race([imageSizeAsync(href), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 15000); })]);
            if (!size) throw new Error("An image could not be decoded. PNG export was cancelled.");
        } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    await document.fonts.ready;
    const canvas = document.createElement("canvas"); canvas.width = plan.width; canvas.height = plan.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("A Canvas 2D context is unavailable.");
    emitCanvas(ctx, plan.model, 1, { x: 0, y: 0, background: doc.background ?? null });
    const data = canvas.toDataURL("image/png");
    if (!data.startsWith("data:image/png;base64,")) throw new Error("PNG encoding failed.");
    return data;
}
