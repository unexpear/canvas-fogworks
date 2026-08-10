/**
 * @module TextRaster
 * @description Laying text out, ONCE, for every backend that can measure.
 *
 * Text is the one thing in this engine whose shape cannot be computed from the document alone: how
 * many words fit on a line depends on the font the machine actually has. Only a canvas context can
 * answer that, so the wrapping lives here rather than in the model — and it lives here rather than
 * inside `emitCanvas` so that the GPU backend can use the SAME answer.
 *
 * That sharing is the whole design, and it is why the GPU backend does not have a glyph atlas. An
 * atlas would mean a second typesetter: its own wrapping, its own kerning, its own idea of where a
 * line breaks, drifting from the Canvas backend in ways only a screenshot comparison would ever
 * catch. Rasterising through this function instead means the GPU shows what Canvas shows because
 * it IS Canvas, drawn once into an offscreen bitmap and uploaded.
 *
 * What that costs, stated: a raster per text item rather than a shared atlas, which is more memory
 * and a re-raster when the text or the zoom changes materially. For a design document — tens of
 * text nodes, not thousands of glyphs a frame — that is the cheaper mistake to make.
 */

import { Paint, Shape, textParagraphs } from "./RenderModel";

/**
 * Greedy word wrap against `maxWidth` using the context's CURRENT font (callers set `font`
 * first). CSS-`normal` semantics, matching the SVG backend's `<foreignObject>` div: ALL
 * whitespace (spaces, tabs, newlines, runs thereof) collapses to single-space separators and
 * is a break opportunity — splitting on `" "` alone would keep a `\n` INSIDE a "word" (canvas
 * renders it as a space on one overlong line while HTML wraps there; review-confirmed
 * divergence). Break between words only; a single word wider than the box gets its own line
 * and overflows (the clip crops it) rather than being split mid-word; the first word of a
 * line always stays (a line is never empty) — the same first-item-always-fits rule
 * `breakFlexLines` uses. Empty/whitespace-only text → one empty line (fillText draws nothing).
 */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    return wrapTextWith(t => ctx.measureText(t).width, text, maxWidth);
}

/**
 * The same wrap, against any way of MEASURING a string.
 *
 * Separated from the context so the SVG EXPORTER can use it. The exporter is pure and has no
 * canvas, but the app that calls it runs in a browser and can supply one — and that is the whole
 * difference between an exported file whose paragraphs wrap where the editor wrapped them and one
 * where every paragraph is a single overlong line. The algorithm is not duplicated for it; there
 * is one wrapper and two ways to measure.
 */
export function wrapTextWith(measure: (text: string) => number, text: string, maxWidth: number): string[] {
    // EXPLICIT newlines break first, then each paragraph wraps on the box width. Collapsing them
    // (as this used to, via a single `\s+` split) made the Canvas backend silently reflow text
    // the SVG backend — now `white-space: pre-wrap` — keeps on separate lines.
    // The hard breaks come from the SHARED `textParagraphs`, so this backend, the SVG one and the
    // EXPORTER cannot disagree about where a newline ends a line. Only the MEASURED wrapping below
    // is this backend's own, because only it can measure.
    const lines: string[] = [];
    for (const paragraph of textParagraphs(text)) {
        const words = paragraph.split(" ").filter(w => w.length > 0);
        if (words.length === 0) { lines.push(""); continue; }
        let line = "";
        for (const word of words) {
            const candidate = line === "" ? word : `${line} ${word}`;
            if (line !== "" && measure(candidate) > maxWidth) {
                lines.push(line);
                line = word;
            } else {
                line = candidate;
            }
        }
        lines.push(line);
    }
    return lines.length > 0 ? lines : [""];
}


/** The text variant of `Shape`, narrowed once so the two functions below can share it. */
export type TextShape = Extract<Shape, { kind: "text" }>;

/**
 * Draw one text shape into a 2D context, at the shape's own coordinates.
 *
 * Moved out of `emitCanvas` UNCHANGED — this is the function that backend already had, and the
 * point of the move is that its output cannot drift from what the GPU shows, because there is only
 * one of it. The context is left CLIPPED to the box, which is what the Canvas backend relied on and
 * what an offscreen raster wants anyway.
 */
export function drawTextInto(ctx: CanvasRenderingContext2D, shape: TextShape, paint: Paint): void {
    // Word-WRAPPED text: greedy line breaking against the box width via `measureText`
    // (set `font` FIRST — measurement depends on it), top-left origin (textBaseline
    // "top" reproduces the SVG box origin), clipped to the box. Line height mirrors the
    // browser's `normal` (~1.2 × font size) so the two backends break comparably —
    // exact metric parity with the SVG `<foreignObject>`'s HTML layout stays the
    // documented inherent gap (canvas measures, the browser typesets).
    // Typography (schema 34), all resolved by the model. `font` carries weight and family
    // and must be set BEFORE measuring; `letterSpacing` is a newer context property, so it
    // is feature-detected rather than assumed (it also feeds `measureText`, which is why it
    // is set before wrapping rather than after).
    ctx.font = `${shape.fontWeight} ${shape.fontSize}px ${shape.fontFamily}`;
    if ("letterSpacing" in ctx) {
        (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${shape.letterSpacing}px`;
    }
    if (paint.opacity !== null) ctx.globalAlpha = paint.opacity;
    // Glyphs take the FIRST STOP of a gradient (schema 56) — the same flattening the SVG
    // backend applies to text, so the two agree about a gradient-filled label.
    if (paint.fill !== null) ctx.fillStyle = typeof paint.fill === "string" ? paint.fill : paint.fill.flat;
    ctx.textBaseline = "top";
    ctx.beginPath();
    ctx.rect(shape.x, shape.y, shape.width, shape.height);
    ctx.clip();
    {
        const lineHeight = shape.fontSize * shape.lineHeight;
        const lines = wrapText(ctx, shape.text, shape.width);
        // Canvas aligns about an ANCHOR, so the anchor moves with the alignment rather
        // than the text. `justify` has no canvas equivalent and falls back to left — a
        // documented gap, like the wider metric difference between the two backends.
        ctx.textAlign = shape.textAlign === "center" ? "center" : shape.textAlign === "right" ? "right" : "left";
        const anchorX = shape.textAlign === "center" ? shape.x + shape.width / 2
            : shape.textAlign === "right" ? shape.x + shape.width
                : shape.x;
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], anchorX, shape.y + i * lineHeight);
        }
    }
}

/**
 * How finely to rasterise text, in device pixels per world unit.
 *
 * QUANTISED to powers of two, for the same reason `displayTolerance` is: a raster keyed on the
 * exact zoom would be rebuilt on every wheel tick, and rebuilding a bitmap mid-gesture is the kind
 * of cost that shows up as the canvas hitching while you scroll. Powers of two mean a zoom crosses
 * a rebuild boundary a handful of times over its whole range instead of continuously.
 *
 * Bounded at both ends: below 1 there is no point rasterising finer than the screen, and the upper
 * bound is what stops a deep zoom from asking for a bitmap larger than the GPU will accept.
 */
export const TEXT_RASTER_MIN = 1;
export const TEXT_RASTER_MAX = 8;
export function textRasterScale(viewScale: number): number {
    if (!Number.isFinite(viewScale) || viewScale <= 0) return TEXT_RASTER_MIN;
    const pow = Math.pow(2, Math.ceil(Math.log2(viewScale)));
    return Math.max(TEXT_RASTER_MIN, Math.min(TEXT_RASTER_MAX, pow));
}

/**
 * A cache key for one rasterised text item.
 *
 * Every field that changes the PIXELS and nothing that does not: the shape's position is absent
 * because the raster is drawn in local coordinates and placed by the geometry, so moving a text
 * node must not throw its bitmap away. Getting that wrong is invisible — the text still looks
 * right, it is just re-rasterised on every frame of a drag.
 */
export function textRasterKey(shape: TextShape, paint: Paint, scale: number): string {
    return [
        shape.text, shape.width, shape.height, shape.fontSize, shape.fontFamily, shape.fontWeight,
        shape.textAlign, shape.lineHeight, shape.letterSpacing, paint.fill ?? "", paint.opacity ?? "", scale
    ].join("\u0000");
}

/**
 * The LINES a text shape breaks into, measured against the font it will actually be drawn in — or
 * null where there is no DOM to measure with.
 *
 * The bridge the SVG exporter needed. It is here rather than in the exporter because the font
 * string and the measuring context are this module's business, and because putting it there would
 * have meant a second place that knows how a line breaks.
 *
 * The measuring canvas is 1x1 and reused: `measureText` needs a context, not a surface, and
 * allocating one per export of a document full of text is a cost with nothing to show for it.
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
export function textLinesFor(shape: TextShape): string[] | null {
    if (measureCtx === undefined) {
        measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    }
    if (!measureCtx) return null;
    // The font must be set BEFORE measuring — `measureText` reads the context's current font, and
    // measuring against the wrong one wraps to a width the exported file will not have.
    measureCtx.font = `${shape.fontWeight} ${shape.fontSize}px ${shape.fontFamily}`;
    if ("letterSpacing" in measureCtx) {
        (measureCtx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${shape.letterSpacing}px`;
    }
    return wrapTextWith(t => measureCtx!.measureText(t).width, shape.text, shape.width);
}
