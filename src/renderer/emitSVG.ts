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
import { tileAt, tileSourceRect, flipAt, flipMatrix, collectionTileBox } from "../core/document/Tilemap";
import { DisplayList, DrawItem, Paint, FilterDef, PaintGradient, commandsToPathData, effectFilterId } from "./RenderModel";
import { naturalSize, surfaceUrl } from "./ImageCache";
import { nineSliceRects } from "../core/geometry/NineSlice";
import { LightingFactors, lightingFactors, lightingFilterId } from "./Lighting";

const svgNS = "http://www.w3.org/2000/svg";

/** The `<defs>` element holding effect `<filter>`s; created once under the svg, rebuilt each frame. */
function getOrCreateDefs(svg: SVGSVGElement): SVGDefsElement {
    let defs = svg.querySelector(":scope > defs") as SVGDefsElement | null;
    if (!defs) {
        defs = document.createElementNS(svgNS, "defs");
        svg.insertBefore(defs, svg.firstChild);
    }
    return defs;
}

/** Build one `<filter>` per def: gaussian blur first, then drop shadow (default input chaining). */
function buildFilters(defs: SVGDefsElement, filterDefs: FilterDef[]): void {
    for (const def of filterDefs) {
        const filter = document.createElementNS(svgNS, "filter");
        filter.setAttribute("id", def.id);
        // Box-relative region so a def is size-independent (dedup holds); clips extreme offset/blur.
        filter.setAttribute("x", "-50%");
        filter.setAttribute("y", "-50%");
        filter.setAttribute("width", "200%");
        filter.setAttribute("height", "200%");
        if (def.blur !== null && def.blur > 0) {
            const b = document.createElementNS(svgNS, "feGaussianBlur");
            b.setAttribute("stdDeviation", String(def.blur));
            filter.appendChild(b);
        }
        if (def.shadow !== null) {
            const s = document.createElementNS(svgNS, "feDropShadow");
            s.setAttribute("dx", String(def.shadow.dx));
            s.setAttribute("dy", String(def.shadow.dy));
            s.setAttribute("stdDeviation", String(def.shadow.blur));
            s.setAttribute("flood-color", def.shadow.color);
            filter.appendChild(s);
        }
        defs.appendChild(filter);
    }
}

/**
 * One `<linearGradient>` or `<radialGradient>` per def (schema 56).
 *
 * TRANSCRIPTION, not arithmetic — which is the whole reason `PaintGradient` carries `units` and
 * the authored coordinates instead of a pre-multiplied matrix. SVG has `gradientUnits` and
 * `gradientTransform` natively, so the backend that renders a gradient EXACTLY is the one that
 * copies the numbers across. Anything folded together in the model would have to be unfolded here.
 */
function buildGradients(defs: SVGDefsElement, gradients: PaintGradient[]): void {
    for (const g of gradients) {
        const el = document.createElementNS(svgNS, `${g.kind}Gradient`);
        el.setAttribute("id", g.id);
        el.setAttribute("gradientUnits", g.units);
        // Emitted only when it is not the identity, for the same reason the item transform picks
        // `translate` over `matrix`: an attribute that says nothing is noise in the output.
        const t = g.transform;
        if (t.a !== 1 || t.b !== 0 || t.c !== 0 || t.d !== 1 || t.e !== 0 || t.f !== 0) {
            el.setAttribute("gradientTransform", toMatrixString(t));
        }
        if (g.kind === "linear") {
            el.setAttribute("x1", String(g.x1)); el.setAttribute("y1", String(g.y1));
            el.setAttribute("x2", String(g.x2)); el.setAttribute("y2", String(g.y2));
        } else {
            el.setAttribute("cx", String(g.cx)); el.setAttribute("cy", String(g.cy));
            el.setAttribute("r", String(g.r));
            el.setAttribute("fx", String(g.fx)); el.setAttribute("fy", String(g.fy));
        }
        for (const stop of g.stops) {
            const s = document.createElementNS(svgNS, "stop");
            s.setAttribute("offset", String(stop.offset));
            s.setAttribute("stop-color", stop.color);
            // Written ONLY when it is not full: SVG's default is 1, and an explicit "1" on every
            // stop of every gradient is bytes that say nothing.
            if (stop.opacity !== 1) s.setAttribute("stop-opacity", String(stop.opacity));
            el.appendChild(s);
        }
        defs.appendChild(el);
    }
}

/** One sRGB component-transfer filter matching the WebGL fragment shader's flat-surface sum. */
function buildLightingFilter(defs: SVGDefsElement, factors: LightingFactors): string {
    const id = lightingFilterId(factors);
    const filter = document.createElementNS(svgNS, "filter");
    filter.setAttribute("id", id);
    filter.setAttribute("x", "-50%");
    filter.setAttribute("y", "-50%");
    filter.setAttribute("width", "200%");
    filter.setAttribute("height", "200%");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const transfer = document.createElementNS(svgNS, "feComponentTransfer");
    for (const [tag, slope] of [["feFuncR", factors[0]], ["feFuncG", factors[1]], ["feFuncB", factors[2]]] as const) {
        const fn = document.createElementNS(svgNS, tag);
        fn.setAttribute("type", "linear");
        fn.setAttribute("slope", String(slope));
        fn.setAttribute("intercept", "0");
        transfer.appendChild(fn);
    }
    filter.appendChild(transfer);
    defs.appendChild(filter);
    return id;
}

/**
 * What goes in a `fill` attribute: a colour verbatim, or a reference to the def (schema 56).
 *
 * The def itself is built from `model.gradients`, which `buildRenderModel` deduped by the same id
 * — so a hundred shapes sharing a ramp reference one element.
 */
function fillAttr(fill: string | PaintGradient): string {
    return typeof fill === "string" ? fill : `url(#${fill.id})`;
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

/** Transform, hit-test tags, and interaction styles shared by every item. */
function applyTail(el: SVGElement, item: DrawItem, lightingId: string | null): void {
    if (item.world) {
        if (!isTranslationOnly(item.world)) el.setAttribute("transform", toMatrixString(item.world));
        else el.setAttribute("transform", `translate(${item.world.e}, ${item.world.f})`);
    }
    if (item.nodeId !== null) el.setAttribute("data-node-id", item.nodeId);
    if (item.handle) el.setAttribute("data-resize-handle", item.handle);
    const paint = item.paint;
    // Effects (schema 18): reference the deduped <filter> def. Same pure id the model deduped by,
    // so it always resolves; null (no effect / grid / overlay) emits no attr.
    const fid = effectFilterId(paint.shadow, paint.blur);
    const filters = [fid, lightingId].filter((id): id is string => id !== null).map(id => `url(#${id})`);
    if (filters.length > 0) el.setAttribute("filter", filters.join(" "));
    if (paint.cursor !== null) el.style.cursor = paint.cursor;
    if (!paint.pointerEvents) el.style.pointerEvents = "none";
    // BLENDING (schema 60), in the shared tail so every shape kind gets it from one line — the
    // opacity attribute above is set in three separate places, and a fourth thing set three times
    // is a fourth thing to forget once. The CSS PROPERTY, not an attribute: `mix-blend-mode` was
    // never defined as a presentation attribute, so browsers read it from style only. The mode
    // names are shared with Canvas and with the document, so nothing translates anywhere.
    if (paint.blendMode !== null) el.style.mixBlendMode = paint.blendMode;
}

/**
 * Corner and end treatment, wherever a stroke is set (schema 37).
 *
 * One function rather than three lines repeated at each stroke site, because "the line shape
 * forgot one of them" is precisely the drift a shared helper removes. Absent = emit nothing, and
 * the SVG default is then what the renderer drew before these fields existed.
 */
function applyStrokeCorners(el: SVGElement, paint: Paint): void {
    if (paint.fillRule !== undefined) el.setAttribute("fill-rule", paint.fillRule);
    if (paint.strokeJoin !== undefined) el.setAttribute("stroke-linejoin", paint.strokeJoin);
    if (paint.strokeCap !== undefined) el.setAttribute("stroke-linecap", paint.strokeCap);
    if (paint.strokeMiterLimit !== undefined) el.setAttribute("stroke-miterlimit", String(paint.strokeMiterLimit));
}

function applyRectPaint(el: SVGElement, paint: Paint): void {
    if (paint.fill !== null) el.setAttribute("fill", fillAttr(paint.fill));
    if (paint.opacity !== null) el.setAttribute("opacity", String(paint.opacity));
    if (paint.radius !== null) el.setAttribute("rx", String(paint.radius));
    if (paint.stroke !== null) el.setAttribute("stroke", paint.stroke);
    if (paint.strokeWidth !== null) el.setAttribute("stroke-width", String(paint.strokeWidth));
    if (paint.strokeDash !== null) el.setAttribute("stroke-dasharray", paint.strokeDash);
    applyStrokeCorners(el, paint);
}

function appendItem(group: SVGGElement, item: DrawItem, lightingId: string | null = null): void {
    const shape = item.shape;
    const paint = item.paint;

    if (shape.kind === "rect") {
        const el = document.createElementNS(svgNS, "rect");
        el.setAttribute("x", String(shape.x));
        el.setAttribute("y", String(shape.y));
        el.setAttribute("width", String(shape.width));
        el.setAttribute("height", String(shape.height));
        applyRectPaint(el, paint);
        applyTail(el, item, lightingId);
        group.appendChild(el);
    } else if (shape.kind === "ellipse") {
        const el = document.createElementNS(svgNS, "ellipse");
        el.setAttribute("cx", String(shape.cx));
        el.setAttribute("cy", String(shape.cy));
        el.setAttribute("rx", String(shape.rx));
        el.setAttribute("ry", String(shape.ry));
        applyRectPaint(el, paint); // paint.radius is null for ellipses, so no conflicting `rx` attr
        applyTail(el, item, lightingId);
        group.appendChild(el);
    } else if (shape.kind === "line") {
        const el = document.createElementNS(svgNS, "line");
        el.setAttribute("x1", String(shape.x1));
        el.setAttribute("y1", String(shape.y1));
        el.setAttribute("x2", String(shape.x2));
        el.setAttribute("y2", String(shape.y2));
        if (paint.stroke !== null) el.setAttribute("stroke", paint.stroke);
        if (paint.strokeWidth !== null) el.setAttribute("stroke-width", String(paint.strokeWidth));
        // THE DASH. This branch spells its paint out by hand instead of going through
        // `applyRectPaint` — a line has no fill and no corner radius — and that is exactly how it
        // came to be the one shape that ignored `strokeDash`. Canvas dashes it, the exporter
        // dashes it, and this backend drew a solid line: two backends disagreeing about the same
        // display list. Nothing asked for a dashed LINE until the gradient axis did.
        if (paint.strokeDash !== null) el.setAttribute("stroke-dasharray", paint.strokeDash);
        applyStrokeCorners(el, paint);
        if (paint.opacity !== null) el.setAttribute("opacity", String(paint.opacity));
        applyTail(el, item, lightingId);
        group.appendChild(el);
    } else if (shape.kind === "path") {
        const el = document.createElementNS(svgNS, "path");
        const d = commandsToPathData(shape.commands); // pure, unit-tested join
        if (d) el.setAttribute("d", d);               // omit for an empty path (mirrors image's href)
        applyRectPaint(el, paint);                    // radius is null → no `rx`
        applyTail(el, item, lightingId);
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
        // TEXT FLATTENS. This backend draws text through a `foreignObject` div, and CSS `color`
        // takes no paint server — a gradient-filled label would need `background-clip: text`,
        // which is a different mechanism with different clipping and no `gradientTransform`.
        // The first stop is what the other backends flatten to as well, so all three agree.
        if (paint.fill !== null) div.style.color = typeof paint.fill === "string" ? paint.fill : paint.fill.flat;
        div.style.fontSize = `${shape.fontSize}px`;
        // Typography (schema 34). The model resolved every one of these, so this is transcription:
        // family and weight as given, alignment as CSS, line height as a UNITLESS multiple (the
        // CSS meaning), letter spacing in the same world units as the font size.
        div.style.fontFamily = shape.fontFamily;
        div.style.fontWeight = String(shape.fontWeight);
        div.style.textAlign = shape.textAlign;
        div.style.lineHeight = String(shape.lineHeight);
        div.style.letterSpacing = `${shape.letterSpacing}px`;
        // Explicit newlines are honoured; the browser still wraps on the box width.
        div.style.whiteSpace = "pre-wrap";
        div.style.overflow = "hidden";
        div.textContent = shape.text;
        fo.appendChild(div);
        applyTail(fo, item, lightingId);
        group.appendChild(fo);
    } else if (shape.kind === "tilemap") {
        // ONE GROUP, ONE `<image>` PER VISIBLE CELL, each showing a window onto the sheet.
        //
        // SVG HAS NO NINE-ARGUMENT DRAW. Canvas and the GPU can say "this rectangle of that
        // bitmap" in one call; here a sub-rectangle is an `<image>` scaled up inside a `<svg>`
        // viewport that crops it, which is the same trick the sprite-region path already uses.
        // So a tilemap is genuinely more elements on this backend than on the others — but it is
        // bounded by what is ON SCREEN, which the model already worked out, rather than by the
        // size of the map. That is the difference between 4,749 elements and 10,618.
        const g = document.createElementNS(svgNS, "g") as SVGGElement;
        const map = shape.map;
        const cells = shape.cells;
        // THE SHEET'S REAL SIZE, from the same cache the other two backends draw from — NOT a size
        // derived from the grid description, which is what this did and what drew a whole map from
        // the wrong rows.
        //
        // THE BUG, in full, because the shape of it is worth keeping: the inner `<image>` is placed
        // at natural size so the `viewBox` above measures in SOURCE PIXELS, and it was being sized
        // to a size DERIVED from the grid description instead, whose height was the one implied by
        // the HIGHEST INDEX THE MAP HAPPENS TO USE. A real 968x526 sheet whose map only reaches row 18 was
        // declared 305 tall, so every tile was sampled 1.7x too far down and stretched to match.
        // Canvas was right all along (`drawImage` takes the bitmap itself) and the GPU was wrong the
        // same way, so a two-backend comparison would have called it agreement. It was found by
        // importing a real map and looking at it beside the node-per-cell import of the same file.
        //
        // NULL MEANS NOT DECODED YET, and then nothing is drawn — exactly what the Canvas backend
        // does. `ImageCache` bumps its generation on load and asks for the repaint.
        const sheetSize = shape.href === null ? null : naturalSize(shape.href);
        // THE SLICING RULE COMES FROM THE MODEL (schema 67), which resolved the layer's tileset. A
        // dangling id and a COLLECTION set both arrive as null and both draw nothing, rather than
        // making an unopenable document out of a deleted tileset.
        const sheet = shape.sheet;
        // A COLLECTION SET: one `<image>` per cell at its OWN size, with no nested `<svg>` because
        // there is no crop to express — the whole file is the tile. Every other backend concern
        // (turning, pixelation, the visible range) stays exactly as it is for a sheet.
        if (cells && !sheet && shape.pictures) {
            for (let row = cells.row0; row <= cells.row1; row++) {
                for (let col = cells.col0; col <= cells.col1; col++) {
                    const box = collectionTileBox(shape.pictures, map, col, row, shape.x, shape.y);
                    if (!box) continue;
                    const img = document.createElementNS(svgNS, "image");
                    img.setAttribute("href", box.href);
                    img.setAttribute("width", String(box.width));
                    img.setAttribute("height", String(box.height));
                    if (box.flip !== 0) {
                        // The same shared matrix, in the tile's OWN box — a collection tile is not
                        // cell-sized, so turning it about the cell would swing it out of place.
                        const m = flipMatrix(box.flip, box.width, box.height);
                        img.setAttribute("x", "0");
                        img.setAttribute("y", "0");
                        img.setAttribute("transform", `translate(${box.x}, ${box.y}) `
                            + `matrix(${m[0]} ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]})`);
                    } else {
                        img.setAttribute("x", String(box.x));
                        img.setAttribute("y", String(box.y));
                    }
                    if (shape.pixelated) img.setAttribute("image-rendering", "pixelated");
                    g.appendChild(img);
                }
            }
        }
        if (cells && shape.href && sheetSize && sheet) {
            for (let row = cells.row0; row <= cells.row1; row++) {
                for (let col = cells.col0; col <= cells.col1; col++) {
                    const src = tileSourceRect(sheet, tileAt(map, col, row));
                    if (!src) continue;
                    const cell = document.createElementNS(svgNS, "svg");
                    cell.setAttribute("x", String(shape.x + col * map.tileWidth));
                    cell.setAttribute("y", String(shape.y + row * map.tileHeight));
                    cell.setAttribute("width", String(map.tileWidth));
                    cell.setAttribute("height", String(map.tileHeight));
                    // The VIEWBOX is the window: the whole sheet is placed inside a viewport the
                    // size of one tile, offset so the wanted tile lands in it.
                    cell.setAttribute("viewBox", `${src.x} ${src.y} ${src.width} ${src.height}`);
                    cell.setAttribute("preserveAspectRatio", "none");
                    // A TURNED CELL (schema 62), by the same shared matrix the other two use.
                    // On the nested `<svg>` rather than on the image inside it: the inner element
                    // is positioned by the viewBox, so turning it would move the crop instead of
                    // the tile.
                    const flip = flipAt(map, col, row);
                    if (flip !== 0) {
                        const m = flipMatrix(flip, map.tileWidth, map.tileHeight);
                        // Composed with the cell's own placement, because an `<svg>` takes x/y OR
                        // a transform and the two do not stack the way they would on a `<g>`.
                        cell.setAttribute("x", "0");
                        cell.setAttribute("y", "0");
                        cell.setAttribute("transform",
                            `translate(${shape.x + col * map.tileWidth}, ${shape.y + row * map.tileHeight}) ` +
                            `matrix(${m[0]} ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]})`);
                    }
                    const img = document.createElementNS(svgNS, "image");
                    img.setAttribute("href", shape.href);
                    img.setAttribute("x", "0");
                    img.setAttribute("y", "0");
                    // Sized to the SHEET's own pixels, not the tile: the viewBox above does the
                    // cropping and measures in source pixels, which only holds if this is the
                    // bitmap's real size.
                    img.setAttribute("width", String(sheetSize.width));
                    img.setAttribute("height", String(sheetSize.height));
                    if (shape.pixelated) img.setAttribute("image-rendering", "pixelated");
                    cell.appendChild(img);
                    g.appendChild(cell);
                }
            }
        }
        if (paint.opacity !== null) g.setAttribute("opacity", String(paint.opacity));
        applyTail(g, item, lightingId);
        group.appendChild(g);
    } else if (shape.kind === "image") {
        const el = document.createElementNS(svgNS, "image");
        el.setAttribute("x", String(shape.x));
        el.setAttribute("y", String(shape.y));
        el.setAttribute("width", String(shape.width));
        el.setAttribute("height", String(shape.height));
        // A RASTER'S HREF IS AN IDENTITY KEY, NOT A URL — `raster:<id>:<w>x<h>:<len>:<sum>` — so
        // setting it directly produces an `<image>` that is correctly placed, correctly sized, and
        // loads nothing. That is precisely what shipped: a painted canvas was INVISIBLE on the
        // default backend while behaving normally everywhere else, and only driving the real app
        // showed it. The surface is decoded through the SAME cache the Canvas backend uses, so
        // there is one notion of "loaded" rather than a second that could disagree.
        // A raster with NO href names nothing to cache under, so there is nothing to resolve —
        // `RenderModel` already returns null for a raster carrying no surface. SVG is the one
        // backend that can only take a URL, so it asks for the encoded form; the others draw the
        // decoded canvas straight, and both come from the same entry.
        const decoded = shape.surface && shape.href ? surfaceUrl(shape.href, shape.surface) : null;
        const href = shape.surface ? decoded : shape.href;
        // NO HREF WHILE IT DECODES, rather than the unusable key: an `<image>` with a broken href
        // is a broken-image glyph in some renderers, which is a WRONG picture rather than a
        // missing one. `ImageCache` bumps its generation on load and asks for the repaint.
        if (href) el.setAttribute("href", href);
        if (paint.opacity !== null) el.setAttribute("opacity", String(paint.opacity));
        el.setAttribute("preserveAspectRatio", "none");
        // PIXEL ART, said the way SVG says it. Set on every image for the same reason the Canvas
        // backend sets its flag on every image — a per-element attribute cannot leak, but writing
        // it only sometimes would leave the two backends disagreeing about the default.
        el.setAttribute("image-rendering", shape.pixelated ? "pixelated" : "auto");
        // A SOURCE RECT, which SVG's `<image>` has no attribute for. A nested `<svg>` carrying a
        // `viewBox` does exactly the job: the viewBox maps the source rectangle onto the
        // destination box and the nested element clips whatever falls outside. The inner image is
        // placed at its NATURAL size, which is what makes the viewBox's units source pixels.
        const src = shape.source;
        // A RASTER KNOWS ITS OWN SIZE — it is in the payload — while an image's comes from the
        // decoded bitmap. Both are needed for the same thing: the inner image is placed at natural
        // size so the viewBox's units are source pixels.
        const natural = shape.surface
            ? { width: shape.surface.width, height: shape.surface.height }
            : shape.href ? naturalSize(shape.href) : null;

        /** One (source → destination) piece as a nested `<svg>` holding its own `<image>`. */
        const piece = (sx: number, sy: number, sw: number, sh: number,
                       dx: number, dy: number, dw: number, dh: number): SVGElement => {
            const nested = document.createElementNS(svgNS, "svg");
            nested.setAttribute("x", String(dx));
            nested.setAttribute("y", String(dy));
            nested.setAttribute("width", String(dw));
            nested.setAttribute("height", String(dh));
            nested.setAttribute("viewBox", `${sx} ${sy} ${sw} ${sh}`);
            nested.setAttribute("preserveAspectRatio", "none");
            const img = el.cloneNode(false) as SVGElement;
            img.setAttribute("x", "0");
            img.setAttribute("y", "0");
            img.setAttribute("width", String(natural!.width));
            img.setAttribute("height", String(natural!.height));
            nested.appendChild(img);
            return nested;
        };

        // NINE-SLICE (schema 57) is nine of the nested-`<svg>` trick this backend already does for
        // one source rect — which is the whole reason the arithmetic lives in `nineSliceRects` and
        // not in a per-backend idea of what a stretched border should look like.
        if (shape.nineSlice && natural) {
            const region = src ?? { x: 0, y: 0, width: natural.width, height: natural.height };
            const dest = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
            // A GROUP, so the whole panel carries ONE `data-node-id` and picks as one thing —
            // nine separately-tagged images would make a click land on whichever piece it hit.
            const g = document.createElementNS(svgNS, "g");
            for (const slice of nineSliceRects(region, dest, shape.nineSlice)) {
                g.appendChild(piece(slice.src.x, slice.src.y, slice.src.width, slice.src.height,
                    slice.dst.x, slice.dst.y, slice.dst.width, slice.dst.height));
            }
            applyTail(g, item, lightingId);
            group.appendChild(g);
            return;
        }
        if (src && natural) {
            const nested = piece(src.x, src.y, src.width, src.height,
                shape.x, shape.y, shape.width, shape.height);
            applyTail(nested, item, lightingId);
            group.appendChild(nested);
            return;
        }
        // A rect on an image that has NOT decoded draws nothing, exactly as Canvas draws nothing
        // for an href that is not ready — rather than briefly drawing the whole sheet, which is
        // the wrong picture rather than a missing one. The same holds for a nine-slice, which
        // cannot be cut without knowing what it is cutting.
        if ((src || shape.nineSlice) && !natural) return;
        applyTail(el, item, lightingId);
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
    // THE DOCUMENT'S OWN BACKGROUND (schema 70), and set EVERY FRAME rather than at creation like
    // the default above — the element is reused across frames, so a background assigned once could
    // never change and clearing it would leave the last sky on screen for ever. Absent falls back
    // to the editor's own backdrop, which is what every document without one has always shown.
    svg.style.background = model.background ?? "#1a1a2e";

    // Effect filter defs — rebuilt each frame (shares content's lifecycle; leak-free).
    const defs = getOrCreateDefs(svg);
    clearChildren(defs);
    buildFilters(defs, model.defs);
    buildGradients(defs, model.gradients);
    const factors = lightingFactors(model.lights, model.ambient);
    const lightingId = factors ? buildLightingFilter(defs, factors) : null;

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
    // OPACITY GROUPS (schema 32): a node with children and opacity < 1 composites as one, so
    // its subtree goes inside a real `<g opacity>` and SVG fades the result once. Folding the
    // alpha into each child instead makes overlapping children show through each other.
    // The model lists each item's enclosing groups outermost-first, so nesting is a lookup:
    // create each `<g>` the first time it is named, then append into the innermost.
    const groupAlpha = new Map(model.groups.map(gr => [gr.id, gr.opacity]));
    const groupClip = new Map(model.groups.filter(gr => gr.clip).map(gr => [gr.id, gr.clip!]));
    const groupEls = new Map<string, SVGGElement>();
    for (const item of model.content) {
        let parent: SVGGElement = contentGroup;
        for (const id of item.groups ?? []) {
            let el = groupEls.get(id);
            if (!el) {
                el = document.createElementNS(svgNS, "g") as SVGGElement;
                el.setAttribute("opacity", String(groupAlpha.get(id) ?? 1));
                // CLIPPING (schema 59). A `<clipPath>` holding the frame's own rounded box, with
                // the frame's world matrix ON THE RECT rather than on the group: putting it on the
                // group would move the CONTENT too, and the content already carries its own.
                const clip = groupClip.get(id);
                if (clip) {
                    const path = document.createElementNS(svgNS, "clipPath") as SVGClipPathElement;
                    const clipId = `clip-${id}`;
                    path.setAttribute("id", clipId);
                    const rect = document.createElementNS(svgNS, "rect");
                    rect.setAttribute("width", String(Math.max(0, clip.width)));
                    rect.setAttribute("height", String(Math.max(0, clip.height)));
                    if (clip.radius > 0) {
                        rect.setAttribute("rx", String(clip.radius));
                        rect.setAttribute("ry", String(clip.radius));
                    }
                    rect.setAttribute("transform", toMatrixString(clip.world));
                    path.appendChild(rect);
                    defs.appendChild(path);
                    el.setAttribute("clip-path", `url(#${clipId})`);
                }
                parent.appendChild(el);
                groupEls.set(id, el);
            }
            parent = el;
        }
        appendItem(parent, item, lightingId);
    }

    clearChildren(overlayGroup);
    model.overlay.forEach(item => appendItem(overlayGroup, item));
}
