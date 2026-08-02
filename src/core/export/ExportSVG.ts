/**
 * @module ExportSVG
 * @description Serializes a document to standalone SVG text — the artefact you hand to a
 * developer, or drop in a folder next to the code you are designing for.
 *
 * PURE: it returns a string and touches no DOM, so the export is node-testable and can run
 * anywhere (including where `emitSVG` cannot, since that one builds live DOM elements). Both
 * read the SAME `DisplayList`, so what exports is what the editor draws — a second, divergent
 * description of every shape is exactly the drift this codebase keeps designing out.
 *
 * What it deliberately leaves out: the grid and the selection overlay. Those are editor chrome,
 * not the design. The viewport is ignored too — an export is the whole document, framed to its
 * own content, not "whatever happened to be on screen".
 */

import { ReadonlyDocument } from "../document/Document";
import { computeGeometry } from "../geometry/GeometryEngine";
import { Rect } from "../geometry/Matrix";
import { toMatrixString } from "../geometry/Matrix";
import { buildRenderModel, commandsToPathData, textParagraphs, effectFilterId as effectId, DrawItem, FilterDef } from "../../renderer/RenderModel";
import { RendererState } from "../../renderer/RendererState";

/** Padding around the content, in world units, so strokes and shadows are not clipped. */
export const EXPORT_MARGIN = 8;

/** XML-escape a string used as an attribute value or text node. */
function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Numbers are emitted verbatim, but rounded enough that the file is readable and stable. */
function num(n: number): string {
    return String(Math.round(n * 1000) / 1000);
}

/** The union of every node's world AABB — the frame an export is cropped to. */
function contentBounds(doc: ReadonlyDocument): Rect | null {
    const computed = computeGeometry(doc);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    computed.nodes.forEach(c => {
        const b = c.bounds;
        if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return;
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    });
    if (!Number.isFinite(minX)) return null;
    return {
        x: minX - EXPORT_MARGIN, y: minY - EXPORT_MARGIN,
        width: (maxX - minX) + EXPORT_MARGIN * 2, height: (maxY - minY) + EXPORT_MARGIN * 2
    };
}

/** Paint attributes shared by every shape, in the same presence rules the DOM backend uses:
 *  a null field emits NO attribute, so an exported shape carries exactly what it was given. */
function paintAttrs(item: DrawItem): string {
    const p = item.paint;
    const parts: string[] = [];
    if (p.fill !== null) parts.push(`fill="${esc(p.fill)}"`);
    else parts.push(`fill="none"`);
    if (p.stroke !== null) parts.push(`stroke="${esc(p.stroke)}"`);
    if (p.strokeWidth !== null) parts.push(`stroke-width="${num(p.strokeWidth)}"`);
    if (p.strokeJoin !== undefined) parts.push(`stroke-linejoin="${esc(p.strokeJoin)}"`);
    if (p.strokeCap !== undefined) parts.push(`stroke-linecap="${esc(p.strokeCap)}"`);
    if (p.strokeMiterLimit !== undefined) parts.push(`stroke-miterlimit="${num(p.strokeMiterLimit)}"`);
    if (p.strokeDash !== null) parts.push(`stroke-dasharray="${esc(p.strokeDash)}"`);
    if (p.opacity !== null) parts.push(`opacity="${num(p.opacity)}"`);
    const filter = filterIdOf(item);
    if (filter) parts.push(`filter="url(#${filter})"`);
    return parts.join(" ");
}

/** An item's filter id, recomputed from its own paint so content and defs cannot disagree. */
function filterIdOf(item: DrawItem): string | null {
    const { shadow, blur } = item.paint;
    if (!shadow && !(blur !== null && blur > 0)) return null;
    // Same id scheme the render model uses; imported rather than duplicated would be better,
    // but `effectFilterId` is the model's own and is re-exported for exactly this.
    return effectId(shadow, blur);
}

/** One shape as SVG markup, placed by its world matrix. */
function itemMarkup(item: DrawItem): string {
    const t = item.world ? ` transform="${toMatrixString(item.world)}"` : "";
    const paint = paintAttrs(item);
    const s = item.shape;
    switch (s.kind) {
        case "rect": {
            const r = item.paint.radius !== null ? ` rx="${num(item.paint.radius)}"` : "";
            return `<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.width)}" height="${num(s.height)}"${r} ${paint}${t}/>`;
        }
        case "ellipse":
            return `<ellipse cx="${num(s.cx)}" cy="${num(s.cy)}" rx="${num(s.rx)}" ry="${num(s.ry)}" ${paint}${t}/>`;
        case "line":
            return `<line x1="${num(s.x1)}" y1="${num(s.y1)}" x2="${num(s.x2)}" y2="${num(s.y2)}" ${paint}${t}/>`;
        case "path":
            return `<path d="${esc(commandsToPathData(s.commands))}" ${paint}${t}/>`;
        case "text": {
            // TYPOGRAPHY (schema 34) and hard LINE BREAKS. Both were missing, and both are the
            // kind of gap that only shows up on export: the editor drew weight, family, spacing
            // and multiple lines while the exported file was one default-styled run. The model
            // has already resolved every value, so this is transcription.
            //
            // Alignment is SVG's `text-anchor`, which anchors about a POINT — so the x moves with
            // it, exactly as the canvas backend moves its anchor. The first baseline sits one
            // font-size below the box top (matching the editor's top-aligned box), and each
            // further line steps by `fontSize × lineHeight`.
            //
            // KNOWN GAP, stated rather than papered over: this does not WRAP. Wrapping needs text
            // measurement, which a pure exporter has no access to — the canvas backend wraps
            // because it has `measureText`. Explicit newlines are honoured; a long unbroken
            // paragraph will run past the box in the exported file where the editor wrapped it.
            const anchor = s.textAlign === "center" ? "middle" : s.textAlign === "right" ? "end" : "start";
            const x = s.textAlign === "center" ? s.x + s.width / 2 : s.textAlign === "right" ? s.x + s.width : s.x;
            const step = s.fontSize * s.lineHeight;
            const lines = textParagraphs(s.text);
            const tspans = lines.map((line, i) =>
                `<tspan x="${num(x)}" y="${num(s.y + s.fontSize + i * step)}">${esc(line)}</tspan>`).join("");
            const font = ` font-size="${num(s.fontSize)}" font-family="${esc(s.fontFamily)}" font-weight="${num(s.fontWeight)}"`
                + ` text-anchor="${anchor}"` + (s.letterSpacing !== 0 ? ` letter-spacing="${num(s.letterSpacing)}"` : "");
            return `<text${font} ${paint}${t}>${tspans}</text>`;
        }
        case "image":
            return s.href === null ? "" :
                `<image x="${num(s.x)}" y="${num(s.y)}" width="${num(s.width)}" height="${num(s.height)}" href="${esc(s.href)}"${t}/>`;
        default:
            return "";
    }
}

/** A `<filter>` definition, matching what `emitSVG` builds for the same def. */
function defMarkup(def: FilterDef): string {
    const parts: string[] = [];
    if (def.blur !== null && def.blur > 0) parts.push(`<feGaussianBlur stdDeviation="${num(def.blur)}"/>`);
    if (def.shadow) {
        parts.push(`<feDropShadow dx="${num(def.shadow.dx)}" dy="${num(def.shadow.dy)}" stdDeviation="${num(def.shadow.blur)}" flood-color="${esc(def.shadow.color)}"/>`);
    }
    return `<filter id="${esc(def.id)}" x="-50%" y="-50%" width="200%" height="200%">${parts.join("")}</filter>`;
}

/**
 * The document as standalone SVG text. Returns an empty `<svg/>` for an empty document rather
 * than null, so a caller always has something valid to write.
 */
export function exportSVG(doc: ReadonlyDocument): string {
    const bounds = contentBounds(doc);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>`;
    }
    // Frame the WHOLE document: a viewport at the content's origin, zoom 1, sized to the
    // content. That also defeats the model's viewport culling, which would otherwise drop
    // anything outside the editor's current view.
    const state = {
        viewport: { x: bounds.x, y: bounds.y, zoom: 1 },
        selectedNodeIds: [],
        hoveredNodeId: null,
        computed: computeGeometry(doc)
    } as unknown as RendererState;
    const model = buildRenderModel({ width: bounds.width, height: bounds.height }, doc, state);

    const defs = model.defs.length > 0 ? `<defs>${model.defs.map(defMarkup).join("")}</defs>` : "";
    const body = model.content.map(itemMarkup).filter(Boolean).join("\n  ");
    // The viewBox carries the content's own origin, so shapes keep their document coordinates
    // instead of being translated — a diff between two exports then shows real changes only.
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${num(bounds.width)}" height="${num(bounds.height)}"`,
        ` viewBox="${num(bounds.x)} ${num(bounds.y)} ${num(bounds.width)} ${num(bounds.height)}">`,
        defs,
        body ? `\n  ${body}\n` : "",
        `</svg>`
    ].join("");
}
