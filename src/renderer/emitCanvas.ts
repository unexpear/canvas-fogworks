/**
 * @module emitCanvas
 * @description Canvas 2D backend for the render model — the immediate-mode twin of
 * `emitSVG`, consuming the SAME `DisplayList`. A dumb per-kind transcriber: it walks
 * grid → content → overlay and issues `ctx` calls, doing NO coordinate arithmetic.
 *
 * Transform: it sets the viewport matrix `V = scale(z·dpr)·translate(-vp)` as the base
 * CTM ONCE (`setTransform` resets the CTM, so DPR is folded into V rather than a separate
 * `scale`), then brackets every content item in `save()`/`transform(world…)`/`restore()`.
 * `ctx.transform` POST-multiplies (V∘world) — the exact analogue of SVG's nested group
 * transform — so the *canvas* composes and this module forwards `world`'s six raw numbers.
 * Grid/overlay items carry `world: null` (already in world space) and draw directly under V.
 *
 * Since canvas is immediate-mode there is no retained grid node, so the model's
 * `grid.sig`/`unchanged` cache is inert here — every line is redrawn each frame (cheap).
 *
 * Tested by a recording-mock `CanvasRenderingContext2D` (the call sequence IS the output);
 * pixel-level SVG↔canvas parity stays a browser smoke test. Known first-pass gaps (all
 * inherent SVG-vs-canvas rasterizer differences, deferred like text wrapping):
 *   - TEXT word-WRAPS (greedy `measureText` breaking, line height 1.2×font, clip-cropped), but
 *     exact metric parity with the SVG `<foreignObject>`'s HTML typesetting stays inherent.
 *   - IMAGE loads its href lazily (a decoded bitmap, cached) and draws it once ready; a repaint is
 *     requested on load via `setImageReadyCallback`. Nothing draws until it decodes (or with no DOM).
 *   - OPACITY is applied as per-op `globalAlpha` (fill, then stroke), not as SVG *group*
 *     opacity, so a translucent shape WITH a stroke shows a fill-tinted band in the stroke's
 *     inner half — a ≈1-device-px hairline effect. True group opacity needs an offscreen
 *     layer composited once at `opacity`; deferred until canvas is a live backend.
 *   - ROUNDED RECT uses `roundRect(…, radius)` (uniform corner), which clamps a radius >
 *     min(w,h)/2 differently from SVG's independent `rx`/`ry` clamp — diverges only for an
 *     over-large corner radius.
 *   - SHADOW/BLUR on a filled+stroked shape is cast on the fill op AND the stroke op (two draws),
 *     not once for the whole element like SVG's `filter` — same per-op family as the opacity gap.
 *     (Effects on a ZERO-EXTENT shape are dropped in the model — see buildContent — so neither
 *     backend renders one; that keeps SVG's collapsing filter region from hiding the element.)
 *   - PER-REGION CURSOR: canvas is a single element, so it can't set a per-region cursor the way
 *     SVG's per-element `style.cursor` does. The EDITOR fills this gap instead of the backend: on an
 *     idle hover `ToolController` sets `EditorState.hoverCursor` (from `handleAtPoint`) and the app
 *     applies it to the canvas container, so resize/rotate handle cursors show on BOTH backends.
 */

import { isTranslationOnly } from "../core/geometry/Matrix";
import { DisplayList, DrawItem, Paint, Shape } from "./RenderModel";

/** Matches the SVG background (`svg.style.background`) so the two backends look alike. */
const BACKGROUND = "#1a1a2e";

// Async image loading — the one bit of state the immediate-mode backend must keep, because
// `drawImage` needs a DECODED bitmap, not an href. Each href is loaded once and cached; a load
// finishing fires the registered repaint callback so the frame redraws with the image present.
type ImageEntry = { img: HTMLImageElement; loaded: boolean };
const imageCache = new Map<string, ImageEntry>();
let onImageReady: (() => void) | null = null;

/** Register the callback invoked when a lazily-loaded image finishes decoding (so the canvas repaints). */
export function setImageReadyCallback(cb: (() => void) | null): void {
    onImageReady = cb;
}

/** The decoded bitmap for an href, or null while it loads / fails (or with no DOM, e.g. node tests). */
function resolveImage(href: string): HTMLImageElement | null {
    if (typeof Image === "undefined") return null; // no DOM (unit tests) — draw nothing, exactly as before
    let entry = imageCache.get(href);
    if (!entry) {
        const img = new Image();
        entry = { img, loaded: false };
        imageCache.set(href, entry);
        img.onload = () => { entry!.loaded = true; onImageReady?.(); };
        // A failed load stays `loaded: false` and is never retried (the entry exists) — draws nothing.
        img.src = href;
    }
    return entry.loaded ? entry.img : null;
}

/** Compile error if a `Shape`/`PathCommand` variant is added without a case here. */
function unreachable(x: never): never {
    throw new Error(`emitCanvas: unhandled variant ${JSON.stringify(x)}`);
}

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
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const words = text.split(/\s+/).filter(w => w.length > 0); // collapse runs, drop leading/trailing
    if (words.length === 0) return [""];
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
        const candidate = line === "" ? word : `${line} ${word}`;
        if (line !== "" && ctx.measureText(candidate).width > maxWidth) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    lines.push(line);
    return lines;
}

function fillAndStroke(ctx: CanvasRenderingContext2D, paint: Paint): void {
    if (paint.opacity !== null) ctx.globalAlpha = paint.opacity;
    // `fill: "none"` (outline items) has no canvas colour equivalent — skip the fill,
    // exactly as SVG's fill="none" paints no interior.
    if (paint.fill !== null && paint.fill !== "none") {
        ctx.fillStyle = paint.fill;
        ctx.fill();
    }
    if (paint.stroke !== null) {
        ctx.strokeStyle = paint.stroke;
        if (paint.strokeWidth !== null) ctx.lineWidth = paint.strokeWidth;
        if (paint.strokeDash !== null) ctx.setLineDash(paint.strokeDash.split(" ").map(Number));
        ctx.stroke();
    }
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, paint: Paint): void {
    switch (shape.kind) {
        case "rect":
            ctx.beginPath();
            if (paint.radius !== null) ctx.roundRect(shape.x, shape.y, shape.width, shape.height, paint.radius);
            else ctx.rect(shape.x, shape.y, shape.width, shape.height);
            fillAndStroke(ctx, paint);
            return;
        case "ellipse":
            ctx.beginPath();
            ctx.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2);
            fillAndStroke(ctx, paint);
            return;
        case "line":
            ctx.beginPath();
            ctx.moveTo(shape.x1, shape.y1);
            ctx.lineTo(shape.x2, shape.y2);
            fillAndStroke(ctx, paint); // lines carry fill:null, so only the stroke paints
            return;
        case "path":
            ctx.beginPath();
            for (const cmd of shape.commands) {
                switch (cmd.c) {
                    case "M": ctx.moveTo(cmd.x, cmd.y); break;
                    case "L": ctx.lineTo(cmd.x, cmd.y); break;
                    case "C": ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
                    case "Q": ctx.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y); break;
                    case "Z": ctx.closePath(); break;
                    default: unreachable(cmd);
                }
            }
            fillAndStroke(ctx, paint);
            return;
        case "text":
            // Word-WRAPPED text: greedy line breaking against the box width via `measureText`
            // (set `font` FIRST — measurement depends on it), top-left origin (textBaseline
            // "top" reproduces the SVG box origin), clipped to the box. Line height mirrors the
            // browser's `normal` (~1.2 × font size) so the two backends break comparably —
            // exact metric parity with the SVG `<foreignObject>`'s HTML layout stays the
            // documented inherent gap (canvas measures, the browser typesets).
            ctx.font = `${shape.fontSize}px sans-serif`;
            if (paint.opacity !== null) ctx.globalAlpha = paint.opacity;
            if (paint.fill !== null) ctx.fillStyle = paint.fill;
            ctx.textBaseline = "top";
            ctx.beginPath();
            ctx.rect(shape.x, shape.y, shape.width, shape.height);
            ctx.clip();
            {
                const lineHeight = shape.fontSize * 1.2;
                const lines = wrapText(ctx, shape.text, shape.width);
                for (let i = 0; i < lines.length; i++) {
                    ctx.fillText(lines[i], shape.x, shape.y + i * lineHeight);
                }
            }
            return;
        case "image": {
            // Load the href once (cached); draw it when decoded. Until then (or with no href /
            // no DOM) nothing is drawn — the node's box still selects/culls via geometry.
            if (shape.href === null) return;
            const img = resolveImage(shape.href);
            if (img) {
                if (paint.opacity !== null) ctx.globalAlpha = paint.opacity;
                ctx.drawImage(img, shape.x, shape.y, shape.width, shape.height);
            }
            return;
        }
        default:
            return unreachable(shape);
    }
}

/**
 * Effects (schema 18), set BEFORE the shape draws so they apply to its whole ink (fill+stroke+text),
 * matching SVG's element-level `filter`. `scale` = z·dpr: canvas `shadow*`/`ctx.filter` are in
 * DEVICE space (the CTM never touches them), so the backend that owns the CTM must replay its uniform
 * scale on the world-unit effect values — the ONE arithmetic exception to "the backend does no maths".
 */
function applyEffects(ctx: CanvasRenderingContext2D, paint: Paint, scale: number): void {
    if (paint.shadow !== null) {
        ctx.shadowColor = paint.shadow.color;
        ctx.shadowBlur = paint.shadow.blur * scale;
        ctx.shadowOffsetX = paint.shadow.dx * scale;
        ctx.shadowOffsetY = paint.shadow.dy * scale;
    }
    if (paint.blur !== null && paint.blur > 0) {
        ctx.filter = `blur(${paint.blur * scale}px)`;
    }
}

function drawItem(ctx: CanvasRenderingContext2D, item: DrawItem, scale: number): void {
    // save/restore brackets the world transform, paint state AND shadow*/filter, so a null Paint
    // field behaves like SVG's per-element attribute independence (globalAlpha→1, no shadow…).
    ctx.save();
    const w = item.world;
    if (w) {
        // Post-multiplies the base viewport CTM — the analogue of the SVG per-item transform.
        if (isTranslationOnly(w)) ctx.translate(w.e, w.f);
        else ctx.transform(w.a, w.b, w.c, w.d, w.e, w.f);
    }
    applyEffects(ctx, item.paint, scale);
    drawShape(ctx, item.shape, item.paint);
    ctx.restore();
}

/**
 * Draw a `DisplayList` to a Canvas 2D context. `dpr` (device pixel ratio, default 1) is
 * folded into the base CTM; the caller sizes the backing store (`canvas.width = cssW·dpr`)
 * and builds the model from CSS-pixel dimensions (DPR never enters the model).
 */
export function emitCanvas(ctx: CanvasRenderingContext2D, model: DisplayList, dpr: number = 1): void {
    const z = Math.max(0.01, model.viewport.zoom);

    // Clear + opaque background in device space (SVG sets svg.style.background).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    // Base CTM = viewport, DPR folded in (setTransform resets, so DPR can't be a separate scale).
    ctx.setTransform(z * dpr, 0, 0, z * dpr, -model.viewport.x * dpr, -model.viewport.y * dpr);

    // shadow*/filter are device-space (untouched by the CTM), so effect values are replayed × scale.
    const scale = z * dpr;
    model.grid.lines.forEach(item => drawItem(ctx, item, scale));
    model.content.forEach(item => drawItem(ctx, item, scale));
    model.overlay.forEach(item => drawItem(ctx, item, scale));
}
