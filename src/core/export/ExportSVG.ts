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
import { computeGeometry, contentBounds } from "../geometry/GeometryEngine";
import { Rect } from "../geometry/Matrix";
import { toMatrixString } from "../geometry/Matrix";
import { buildRenderModel, commandsToPathData, textParagraphs, effectFilterId as effectId, DrawItem, FilterDef, PaintGradient, Shape } from "../../renderer/RenderModel";
import { RendererState } from "../../renderer/RendererState";

/** Padding around the content, in world units, so strokes and shadows are not clipped. */
export const EXPORT_MARGIN = 8;

/**
 * The two things an export needs that a PURE function cannot know, injected the same way
 * `TextLines` already is.
 *
 * A SOURCE RECT needs the image's NATURAL SIZE. SVG's `<image>` has no attribute for "draw this
 * rectangle of the file", so the only way to say it is a nested `<svg viewBox>` over an image
 * placed at its natural size — which means knowing that size, which means having decoded the
 * picture. The exporter has not.
 *
 * A RASTER needs its pixels ENCODED. Its href is `raster:<id>:...`, an identity key rather than a
 * URL, so writing it into a standalone file produces an `<image>` that will never load anywhere.
 *
 * Both are optional. Absent, the exporter OMITS what it cannot express rather than writing
 * something wrong — see `itemMarkup`.
 */
export interface ExportImages {
    naturalSize?(href: string): { width: number; height: number } | null;
    surfaceUrl?(href: string, surface: { data: string; width: number; height: number }): string | null;
}

/** XML-escape a string used as an attribute value or text node. */
function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Numbers are emitted verbatim, but rounded enough that the file is readable and stable. */
function num(n: number): string {
    return String(Math.round(n * 1000) / 1000);
}

/**
 * The union of every node's world AABB, plus the export margin — the frame an export is cropped to.
 *
 * The union itself is `geometry/contentBounds`, which the editor's zoom-to-fit also asks. Written
 * twice they would agree until one of them learned something — that a non-finite box is skipped,
 * say — and then quietly disagree about what "all the content" means. The MARGIN stays here,
 * because it belongs to exporting and not to the geometry.
 */
function framedBounds(doc: ReadonlyDocument): Rect | null {
    const box = contentBounds(computeGeometry(doc));
    if (!box) return null;
    return {
        x: box.x - EXPORT_MARGIN, y: box.y - EXPORT_MARGIN,
        width: box.width + EXPORT_MARGIN * 2, height: box.height + EXPORT_MARGIN * 2
    };
}

/** Paint attributes shared by every shape, in the same presence rules the DOM backend uses:
 *  a null field emits NO attribute, so an exported shape carries exactly what it was given. */
function paintAttrs(item: DrawItem): string {
    const p = item.paint;
    const parts: string[] = [];
    // A GRADIENT becomes a reference to the def this exporter also writes (schema 56). The id is
    // the model's own, so content and `<defs>` cannot name different things — the same discipline
    // `filterIdOf` follows.
    if (p.fill !== null) parts.push(`fill="${esc(typeof p.fill === "string" ? p.fill : `url(#${p.fill.id})`)}"`);
    else parts.push(`fill="none"`);
    if (p.stroke !== null) parts.push(`stroke="${esc(p.stroke)}"`);
    if (p.strokeWidth !== null) parts.push(`stroke-width="${num(p.strokeWidth)}"`);
    if (p.fillRule !== undefined) parts.push(`fill-rule="${esc(p.fillRule)}"`);
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

/** How a text shape breaks into lines. The default honours explicit newlines and nothing else. */
export type TextLines = (shape: Extract<Shape, { kind: "text" }>) => string[];
const HARD_BREAKS_ONLY: TextLines = shape => textParagraphs(shape.text);

/** One shape as SVG markup, placed by its world matrix. */
function itemMarkup(item: DrawItem, linesOf: TextLines, images: ExportImages): string {
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
            // WRAPPING is INJECTED, because this module is pure and wrapping needs to measure.
            // Without a measurer only the explicit newlines break — which is what this did for as
            // long as it existed, and it meant a long paragraph ran past its box in the exported
            // file while the editor wrapped it on screen. The app supplies `TextRaster.textLinesFor`,
            // so the export breaks lines exactly where the Canvas and GPU backends do rather than
            // having an opinion of its own.
            const anchor = s.textAlign === "center" ? "middle" : s.textAlign === "right" ? "end" : "start";
            const x = s.textAlign === "center" ? s.x + s.width / 2 : s.textAlign === "right" ? s.x + s.width : s.x;
            const step = s.fontSize * s.lineHeight;
            const lines: string[] = linesOf(s);
            const tspans = lines.map((line, i) =>
                `<tspan x="${num(x)}" y="${num(s.y + s.fontSize + i * step)}">${esc(line)}</tspan>`).join("");
            const font = ` font-size="${num(s.fontSize)}" font-family="${esc(s.fontFamily)}" font-weight="${num(s.fontWeight)}"`
                + ` text-anchor="${anchor}"` + (s.letterSpacing !== 0 ? ` letter-spacing="${num(s.letterSpacing)}"` : "");
            return `<text${font} ${paint}${t}>${tspans}</text>`;
        }
        case "image": {
            if (s.href === null) return "";
            // A RASTER'S HREF IS A CACHE KEY, not a URL. Written verbatim it is an image that
            // loads nowhere — so the pixels are encoded, or the node is omitted. Omitting loses
            // the node; writing the key loses it too AND leaves a broken-image glyph behind.
            const href = s.surface ? (images.surfaceUrl?.(s.href, s.surface) ?? null) : s.href;
            if (href === null) return "";
            // PIXEL ART, said the way SVG says it — and set BOTH ways for the reason the live
            // backend sets it both ways: writing it only when true leaves the reader guessing at
            // the default, and an exported sprite smoothed into mush is the failure this prevents.
            const rendering = ` image-rendering="${s.pixelated ? "pixelated" : "auto"}"`;
            const src = s.source;
            const natural = src ? (images.naturalSize?.(s.href) ?? null) : null;
            if (src && natural) {
                // A SOURCE RECT has no `<image>` attribute. A nested `<svg viewBox>` does the job:
                // the viewBox maps the source rectangle onto the destination box and the nested
                // element clips what falls outside, with the inner image at its NATURAL size so
                // the viewBox's units are source pixels. The same construction `emitSVG` uses.
                return `<svg x="${num(s.x)}" y="${num(s.y)}" width="${num(s.width)}" height="${num(s.height)}"`
                    + ` viewBox="${num(src.x)} ${num(src.y)} ${num(src.width)} ${num(src.height)}"`
                    + ` preserveAspectRatio="none"${t}>`
                    + `<image x="0" y="0" width="${num(natural.width)}" height="${num(natural.height)}"`
                    + ` href="${esc(href)}" preserveAspectRatio="none"${rendering}/>`
                    + `</svg>`;
            }
            // A SOURCE RECT WITH NO SIZE TO RESOLVE IT draws nothing, rather than the whole sheet.
            // One cell of a tileset and the entire tileset are not a near miss — the second is a
            // different picture, and a silent one.
            if (src && !natural) return "";
            return `<image x="${num(s.x)}" y="${num(s.y)}" width="${num(s.width)}" height="${num(s.height)}"`
                + ` href="${esc(href)}" preserveAspectRatio="none"${rendering}${t}/>`;
        }
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
 * A gradient `<defs>` entry, matching what `emitSVG` builds for the same def.
 *
 * DELIBERATELY THE SAME ATTRIBUTES IN THE SAME ORDER as the live backend's `buildGradients`. The
 * two are separate code because one writes DOM and one writes text, and the last four silent
 * export losses were all a case of this file quietly saying less than the screen did.
 */
function gradientMarkup(g: PaintGradient): string {
    const parts: string[] = [`id="${esc(g.id)}"`, `gradientUnits="${esc(g.units)}"`];
    const t = g.transform;
    if (t.a !== 1 || t.b !== 0 || t.c !== 0 || t.d !== 1 || t.e !== 0 || t.f !== 0) {
        parts.push(`gradientTransform="${esc(toMatrixString(t))}"`);
    }
    if (g.kind === "linear") {
        parts.push(`x1="${num(g.x1)}"`, `y1="${num(g.y1)}"`, `x2="${num(g.x2)}"`, `y2="${num(g.y2)}"`);
    } else {
        parts.push(`cx="${num(g.cx)}"`, `cy="${num(g.cy)}"`, `r="${num(g.r)}"`,
            `fx="${num(g.fx)}"`, `fy="${num(g.fy)}"`);
    }
    const stops = g.stops.map(st =>
        `<stop offset="${num(st.offset)}" stop-color="${esc(st.color)}"`
        + (st.opacity !== 1 ? ` stop-opacity="${num(st.opacity)}"` : "") + `/>`).join("");
    return `<${g.kind}Gradient ${parts.join(" ")}>${stops}</${g.kind}Gradient>`;
}

/**
 * The document as standalone SVG text. Returns an empty `<svg/>` for an empty document rather
 * than null, so a caller always has something valid to write.
 */
export function exportSVG(doc: ReadonlyDocument, linesOf: TextLines = HARD_BREAKS_ONLY,
    images: ExportImages = {}): string {
    const bounds = framedBounds(doc);
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

    const defBody = model.defs.map(defMarkup).join("") + model.gradients.map(gradientMarkup).join("");
    const defs = defBody.length > 0 ? `<defs>${defBody}</defs>` : "";
    // OPACITY GROUPS (schema 32). A node with children and opacity < 1 composites as ONE, so the
    // model sets each child's own opacity to 1 and lists the group separately — and this exporter
    // read `content` and never `groups`, so every such group exported at FULL strength with its
    // children individually opaque. Both live backends compensate; this one silently did not.
    //
    // The model lists an item's enclosing groups outermost-first, so nesting is a lookup: open
    // each `<g opacity>` the first time it is named and close them when the run ends.
    const alpha = new Map(model.groups.map(g => [g.id, g.opacity]));
    const parts: string[] = [];
    let open: string[] = [];
    for (const item of model.content) {
        const want = item.groups ?? [];
        let shared = 0;
        while (shared < open.length && shared < want.length && open[shared] === want[shared]) shared++;
        // Close every group this item is NOT inside, innermost first...
        for (let i = open.length; i > shared; i--) parts.push("</g>");
        // ...then open the ones it is.
        for (let i = shared; i < want.length; i++) parts.push(`<g opacity="${num(alpha.get(want[i]) ?? 1)}">`);
        open = [...want];
        const markup = itemMarkup(item, linesOf, images);
        if (markup) parts.push(markup);
    }
    for (let i = open.length; i > 0; i--) parts.push("</g>");
    const body = parts.filter(Boolean).join("\n  ");
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
