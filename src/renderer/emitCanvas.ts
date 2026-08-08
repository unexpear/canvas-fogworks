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
import { DisplayList, DrawItem, Paint, PaintGradient, Shape, layerTransition, textParagraphs } from "./RenderModel";
import { GradientStop } from "../core/document/Gradient";
import { nineSliceRects } from "../core/geometry/NineSlice";
import { parseColor } from "./emitWebGL";
import { resolveSurface, resolveImage, setImageReadyCallback } from "./ImageCache";
import { drawTextInto } from "./TextRaster";

/** Matches the SVG background (`svg.style.background`) so the two backends look alike. */
const BACKGROUND = "#1a1a2e";

/**
 * Where, and on what, to transcribe — omit it and the model fills the canvas on the editor's own
 * backdrop, which is what the editor wants and what an exported texture never does.
 */
export interface CanvasTarget {
    /** Destination offset in DEVICE pixels. */
    x: number;
    y: number;
    /** `null` leaves the destination transparent. A sprite needs alpha; a backdrop baked into a
     *  texture turns every frame into a solid rectangle. */
    background: string | null;
}

// Image loading lives in `ImageCache`, shared with the GPU backend — one decode serves both, so
// switching backends from the toolbar does not re-download the document. `setImageReadyCallback`
// is re-exported here because that is where callers have always imported it from.
export { setImageReadyCallback };

/** Compile error if a `Shape`/`PathCommand` variant is added without a case here. */
function unreachable(x: never): never {
    throw new Error(`emitCanvas: unhandled variant ${JSON.stringify(x)}`);
}


/**
 * One stop as a CSS colour, its `stop-opacity` folded into the alpha.
 *
 * SVG keeps the two apart — a ramp that fades a colour out states that colour twice with two
 * opacities — and Canvas has one string per stop, so they have to be combined here. The existing
 * alpha is MULTIPLIED rather than replaced: `#ff000080` at `stop-opacity="0.5"` is a quarter
 * opaque, which is what both SVG and this now say.
 *
 * A colour `parseColor` cannot take apart (a `rgb()` string, a CSS name) keeps its own alpha and
 * loses the stop's — the same boundary the GPU backend already draws, and the alternative is a
 * second colour parser in a third place.
 */
function stopCss(stop: GradientStop): string {
    if (stop.opacity >= 1) return stop.color;
    const c = parseColor(stop.color);
    if (!c) return stop.color;
    const ch = (i: number): number => Math.round(c[i] * 255);
    return `rgba(${ch(0)}, ${ch(1)}, ${ch(2)}, ${c[3] * stop.opacity})`;
}

/**
 * A ramp as a Canvas fill style, in the gradient's OWN coordinates.
 *
 * THE CALLER PLACES IT WITH THE CTM, which is the whole technique — see `fillAndStroke`. A radial
 * is built as SVG defines it: an inner circle of radius zero AT THE FOCUS, growing to `r` at the
 * centre, which is exactly `createRadialGradient(fx, fy, 0, cx, cy, r)`.
 *
 * A ZERO RADIUS is legal in SVG and paints the LAST stop everywhere — a real way for a file to
 * flatten a fill. Canvas paints nothing for it, so it is answered here as a colour rather than
 * left as a hole. And `addColorStop` THROWS on a colour it cannot parse, which would take the
 * whole frame down over one bad stop; the catch returns the flat colour instead.
 */
function gradientStyle(ctx: CanvasRenderingContext2D, g: PaintGradient): string | CanvasGradient {
    if (g.kind === "radial" && g.r === 0) return g.stops[g.stops.length - 1]?.color ?? g.flat;
    try {
        const grad = g.kind === "linear"
            ? ctx.createLinearGradient(g.x1, g.y1, g.x2, g.y2)
            : ctx.createRadialGradient(g.fx, g.fy, 0, g.cx, g.cy, g.r);
        for (const s of g.stops) grad.addColorStop(s.offset, stopCss(s));
        return grad;
    } catch {
        return g.flat;
    }
}

function fillAndStroke(ctx: CanvasRenderingContext2D, paint: Paint, localBox?: { width: number; height: number }): void {
    if (paint.opacity !== null) ctx.globalAlpha = paint.opacity;
    // `fill: "none"` (outline items) has no canvas colour equivalent — skip the fill,
    // exactly as SVG's fill="none" paints no interior.
    // `fill: "none"` (outline items) has no canvas colour equivalent — skip the fill,
    // exactly as SVG's fill="none" paints no interior.
    if (paint.fill !== null && paint.fill !== "none") {
        // A GRADIENT (schema 56) is painted by MOVING THE CTM, not by clipping and flooding.
        //
        // Canvas fixes a path's coordinates when each segment is ADDED and evaluates a gradient in
        // the space live at the moment of the FILL. Those are two different moments, and the gap
        // between them is the whole mechanism: the path is already built, so changing the CTM now
        // moves the ramp and leaves the shape exactly where it is.
        //
        // Which is why there is no clip here. Clipping the shape and flooding a rect in gradient
        // space would also work, and would then need its own answer for the drop shadow the clip
        // eats. Nothing needs an answer: `shadow*` and `ctx.filter` are DEVICE-space and the CTM
        // never touches them, so a shadow set before this survives it unchanged. Both facts were
        // measured in the running app before this was written, not read off a specification.
        const ramp = typeof paint.fill === "string" ? null : paint.fill;
        if (typeof paint.fill === "string") ctx.fillStyle = paint.fill;
        if (ramp) {
            ctx.save();
            // `objectBoundingBox` first, then the ramp's own matrix — SVG's order, applied as two
            // context calls so no matrix is multiplied anywhere in this backend.
            if (localBox && ramp.units === "objectBoundingBox") {
                ctx.transform(localBox.width, 0, 0, localBox.height, 0, 0);
            }
            const t = ramp.transform;
            ctx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
            ctx.fillStyle = gradientStyle(ctx, ramp);
        }
        // Canvas takes the rule as an argument to `fill` rather than as state, and its spelling
        // is the document's, so this is a pass-through and not a lookup.
        if (paint.fillRule !== undefined) ctx.fill(paint.fillRule); else ctx.fill();
        if (ramp) ctx.restore();
    }
    if (paint.stroke !== null) {
        ctx.strokeStyle = paint.stroke;
        if (paint.strokeWidth !== null) ctx.lineWidth = paint.strokeWidth;
        // The document's spellings ARE Canvas's, so these are assignments, not a lookup table.
        if (paint.strokeJoin !== undefined) ctx.lineJoin = paint.strokeJoin;
        if (paint.strokeCap !== undefined) ctx.lineCap = paint.strokeCap;
        if (paint.strokeMiterLimit !== undefined) ctx.miterLimit = paint.strokeMiterLimit;
        // ALWAYS set, never only when there IS a dash. `setLineDash` is CONTEXT state and it is
        // sticky: leaving it alone for an undashed item makes that item inherit whatever the last
        // dashed one set, for the rest of the frame. The visible symptom is the box-select marquee
        // coming out dashed because the rectangle tool's preview ran before it — two overlays that
        // have nothing to do with each other, which is why it reads as a rendering glitch rather
        // than as a bug in either. SVG never had it: there, a dash is an attribute on an element
        // rather than a mode on a shared painter.
        ctx.setLineDash(paint.strokeDash !== null ? paint.strokeDash.split(" ").map(Number) : []);
        ctx.stroke();
    }
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, paint: Paint,
                   localBox?: { width: number; height: number }): void {
    switch (shape.kind) {
        case "rect":
            ctx.beginPath();
            if (paint.radius !== null) ctx.roundRect(shape.x, shape.y, shape.width, shape.height, paint.radius);
            else ctx.rect(shape.x, shape.y, shape.width, shape.height);
            fillAndStroke(ctx, paint, localBox);
            return;
        case "ellipse":
            ctx.beginPath();
            ctx.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2);
            fillAndStroke(ctx, paint, localBox);
            return;
        case "line":
            ctx.beginPath();
            ctx.moveTo(shape.x1, shape.y1);
            ctx.lineTo(shape.x2, shape.y2);
            fillAndStroke(ctx, paint, localBox); // lines carry fill:null, so only the stroke paints
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
            fillAndStroke(ctx, paint, localBox);
            return;
        case "text":
            // The layout lives in `TextRaster`, shared with the GPU backend — one typesetter, so
            // the two cannot break a line in different places. This backend used to own it.
            drawTextInto(ctx, shape, paint);
            return;
        case "image": {
            // Load the href once (cached); draw it when decoded. Until then (or with no href /
            // no DOM) nothing is drawn — the node's box still selects/culls via geometry.
            if (shape.href === null) return;
            // A RASTER carries its payload along the display list, because its href is only a
            // cache KEY — the cache cannot decode a surface it cannot see. Both paths return the
            // same `HTMLImageElement`, so everything below is unchanged and the three backends
            // keep ONE notion of when a picture is ready.
            const img = shape.surface
                ? resolveSurface(shape.href, shape.surface)
                : resolveImage(shape.href);
            if (img) {
                if (paint.opacity !== null) ctx.globalAlpha = paint.opacity;
                // SET FOR EVERY IMAGE, both ways, never only when `pixelated` is true.
                // `imageSmoothingEnabled` is sticky context state — precisely like `setLineDash`,
                // which this backend already shipped as a bug once, leaking a dash from the item
                // that set it onto every item after. Written the same careless way, one pixel-art
                // tile would make every later photograph in the frame crunchy.
                ctx.imageSmoothingEnabled = !shape.pixelated;
                const src = shape.source;
                // NINE-SLICE (schema 57) is nine of the nine-argument `drawImage` this backend
                // already makes for a source rect. The pieces come from the shared
                // `nineSliceRects` — a per-backend idea of how a border should stretch is three
                // implementations and three ways to disagree.
                if (shape.nineSlice) {
                    // The bitmap's own size, which is the one thing the pure model could not know
                    // for an image with no source rect: it is not decoded until here.
                    const region = src ?? { x: 0, y: 0, width: img.width, height: img.height };
                    const dest = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
                    for (const piece of nineSliceRects(region, dest, shape.nineSlice)) {
                        ctx.drawImage(img, piece.src.x, piece.src.y, piece.src.width, piece.src.height,
                            piece.dst.x, piece.dst.y, piece.dst.width, piece.dst.height);
                    }
                } else if (src) {
                    // The NINE-argument form, which is the whole feature: a tileset or a sprite
                    // strip is a grid inside one file, and until now only the five-argument form
                    // existed, so the grid could only be drawn entire.
                    ctx.drawImage(img, src.x, src.y, src.width, src.height,
                        shape.x, shape.y, shape.width, shape.height);
                } else {
                    ctx.drawImage(img, shape.x, shape.y, shape.width, shape.height);
                }
            }
            return;
        }
        default:
            return unreachable(shape);
    }
}

/**
 * `shadowBlur` IS TWICE THE STANDARD DEVIATION, which is not what `blur` means anywhere else here.
 *
 * `Shadow.blur` is a gaussian sigma — that is what SVG's `feDropShadow stdDeviation` takes and what
 * CSS `filter: blur()` takes. The canvas shadow property is the odd one out: its spec defines the
 * blur as a gaussian of sigma `shadowBlur / 2`. Passing sigma straight through therefore drew every
 * drop shadow HALF as soft as the SVG backend drew the same document, which looks like a slightly
 * crisper render rather than a wrong one.
 *
 * Measured in the real renderer rather than read off the spec — the reach of a shadow's alpha, in
 * pixels, from a square's edge:
 *
 *     sigma:            4    8   20   40
 *     SVG feDropShadow: 8   17   45   89
 *     canvas, raw:      4    8   22   46      <- half
 *     canvas, doubled:  8   18   46   87      <- matches
 */
const CANVAS_SHADOW_SIGMA_SCALE = 2;

/**
 * Effects (schema 18), set BEFORE the shape draws so they apply to its whole ink (fill+stroke+text),
 * matching SVG's element-level `filter`. `scale` = z·dpr: canvas `shadow*`/`ctx.filter` are in
 * DEVICE space (the CTM never touches them), so the backend that owns the CTM must replay its uniform
 * scale on the world-unit effect values — the ONE arithmetic exception to "the backend does no maths".
 */
function applyEffects(ctx: CanvasRenderingContext2D, paint: Paint, scale: number): void {
    if (paint.shadow !== null) {
        ctx.shadowColor = paint.shadow.color;
        ctx.shadowBlur = paint.shadow.blur * scale * CANVAS_SHADOW_SIGMA_SCALE;
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
    drawShape(ctx, item.shape, item.paint, item.localBox);
    ctx.restore();
}

/**
 * Draw a `DisplayList` to a Canvas 2D context. `dpr` (device pixel ratio, default 1) is
 * folded into the base CTM; the caller sizes the backing store (`canvas.width = cssW·dpr`)
 * and builds the model from CSS-pixel dimensions (DPR never enters the model).
 */
export function emitCanvas(ctx: CanvasRenderingContext2D, model: DisplayList, dpr: number = 1, into?: CanvasTarget): void {
    const z = Math.max(0.01, model.viewport.zoom);
    const offX = into ? into.x : 0, offY = into ? into.y : 0;
    // `undefined` and `null` mean different things here, so the check is for the TARGET rather
    // than for a falsy colour: no target at all is the editor drawing itself and wants the
    // backdrop; a target that asked for `null` wants transparency and must not get a default.
    const background = into ? into.background : BACKGROUND;

    // Clear + background in device space (SVG sets svg.style.background). A caller drawing into
    // part of a larger canvas clips first, so clearing the whole thing only clears its own region.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (background !== null) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }

    // Base CTM = viewport, DPR folded in (setTransform resets, so DPR can't be a separate scale).
    // THE OFFSET GOES HERE and nowhere else. `setTransform` is absolute, so a caller that wrapped
    // this in `ctx.translate` would have it silently discarded — which is exactly what stacked
    // every cell of a sprite sheet on top of the first one until the sheet was looked at. Shifting
    // the VIEWPORT instead is not the same fix: the viewport is what content is culled against, so
    // moving it by a cell's offset culls that cell's contents away.
    // Written as `-(v - off)` rather than `-v + off` only to keep the SIGN of zero: with no
    // target this is bit-identical to what it always emitted, so the offset cannot be blamed
    // for a diff in the editor's own draw path.
    ctx.setTransform(z * dpr, 0, 0, z * dpr, -(model.viewport.x - offX) * dpr, -(model.viewport.y - offY) * dpr);

    // shadow*/filter are device-space (untouched by the CTM), so effect values are replayed × scale.
    const scale = z * dpr;
    model.grid.lines.forEach(item => drawItem(ctx, item, scale));
    // OPACITY GROUPS (schema 32) get a REAL LAYER, one offscreen canvas per group run.
    //
    // This used to fold each group's alpha into its items, and said so: overlapping children inside
    // a translucent group showed through one another here and not in SVG. That is not a subtlety —
    // it is the ordinary case, because a group is usually a group precisely because its parts
    // touch. A cross-backend pixel comparison put the overlap 55 channels apart.
    //
    // THE LAYER IS DEVICE-SIZED and drawn back at the IDENTITY transform, so no resampling happens
    // and the composite is exact. Its context inherits the current CTM, which is what makes the
    // items inside land where they would have.
    const groupAlpha = new Map(model.groups.map(gr => [gr.id, gr.opacity]));
    const layers: { into: CanvasRenderingContext2D; canvas: HTMLCanvasElement; opacity: number }[] = [];
    let target = ctx;
    const closeLayer = (): void => {
        const top = layers.pop();
        if (!top) return;
        const alpha = top.into.globalAlpha;
        top.into.save();
        top.into.setTransform(1, 0, 0, 1, 0, 0);
        top.into.globalAlpha = top.opacity;
        top.into.drawImage(top.canvas, 0, 0);
        top.into.restore();
        top.into.globalAlpha = alpha;
        target = top.into;
    };
    const openLayer = (opacity: number): void => {
        const canvas = document.createElement("canvas");
        canvas.width = target.canvas.width;
        canvas.height = target.canvas.height;
        const into = canvas.getContext("2d");
        // No 2D context (a context-loss, a headless host): the group is drawn WITHOUT its fade
        // rather than not at all. Losing the alpha is visible; losing the subtree is not.
        if (!into) return;
        const m = target.getTransform();
        into.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        layers.push({ into: target, canvas, opacity });
        target = into;
    };
    let openPath: readonly string[] = [];
    for (const item of model.content) {
        const next = item.groups ?? [];
        const step = layerTransition(openPath, next);
        for (let i = 0; i < step.close; i++) closeLayer();
        for (const id of step.open) openLayer(groupAlpha.get(id) ?? 1);
        drawItem(target, item, scale);
        openPath = next;
    }
    while (layers.length > 0) closeLayer();
    model.overlay.forEach(item => drawItem(ctx, item, scale));
}
