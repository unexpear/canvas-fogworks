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
import { DisplayList, DrawItem, Paint, FilterDef, commandsToPathData, effectFilterId } from "./RenderModel";
import { naturalSize } from "./ImageCache";

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
function applyTail(el: SVGElement, item: DrawItem): void {
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
    if (fid !== null) el.setAttribute("filter", `url(#${fid})`);
    if (paint.cursor !== null) el.style.cursor = paint.cursor;
    if (!paint.pointerEvents) el.style.pointerEvents = "none";
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
    if (paint.fill !== null) el.setAttribute("fill", paint.fill);
    if (paint.opacity !== null) el.setAttribute("opacity", String(paint.opacity));
    if (paint.radius !== null) el.setAttribute("rx", String(paint.radius));
    if (paint.stroke !== null) el.setAttribute("stroke", paint.stroke);
    if (paint.strokeWidth !== null) el.setAttribute("stroke-width", String(paint.strokeWidth));
    if (paint.strokeDash !== null) el.setAttribute("stroke-dasharray", paint.strokeDash);
    applyStrokeCorners(el, paint);
}

function appendItem(group: SVGGElement, item: DrawItem): void {
    const shape = item.shape;
    const paint = item.paint;

    if (shape.kind === "rect") {
        const el = document.createElementNS(svgNS, "rect");
        el.setAttribute("x", String(shape.x));
        el.setAttribute("y", String(shape.y));
        el.setAttribute("width", String(shape.width));
        el.setAttribute("height", String(shape.height));
        applyRectPaint(el, paint);
        applyTail(el, item);
        group.appendChild(el);
    } else if (shape.kind === "ellipse") {
        const el = document.createElementNS(svgNS, "ellipse");
        el.setAttribute("cx", String(shape.cx));
        el.setAttribute("cy", String(shape.cy));
        el.setAttribute("rx", String(shape.rx));
        el.setAttribute("ry", String(shape.ry));
        applyRectPaint(el, paint); // paint.radius is null for ellipses, so no conflicting `rx` attr
        applyTail(el, item);
        group.appendChild(el);
    } else if (shape.kind === "line") {
        const el = document.createElementNS(svgNS, "line");
        el.setAttribute("x1", String(shape.x1));
        el.setAttribute("y1", String(shape.y1));
        el.setAttribute("x2", String(shape.x2));
        el.setAttribute("y2", String(shape.y2));
        if (paint.stroke !== null) el.setAttribute("stroke", paint.stroke);
        if (paint.strokeWidth !== null) el.setAttribute("stroke-width", String(paint.strokeWidth));
        applyStrokeCorners(el, paint);
        if (paint.opacity !== null) el.setAttribute("opacity", String(paint.opacity));
        applyTail(el, item);
        group.appendChild(el);
    } else if (shape.kind === "path") {
        const el = document.createElementNS(svgNS, "path");
        const d = commandsToPathData(shape.commands); // pure, unit-tested join
        if (d) el.setAttribute("d", d);               // omit for an empty path (mirrors image's href)
        applyRectPaint(el, paint);                    // radius is null → no `rx`
        applyTail(el, item);
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
        if (paint.fill !== null) div.style.color = paint.fill;
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
        applyTail(fo, item);
        group.appendChild(fo);
    } else if (shape.kind === "image") {
        const el = document.createElementNS(svgNS, "image");
        el.setAttribute("x", String(shape.x));
        el.setAttribute("y", String(shape.y));
        el.setAttribute("width", String(shape.width));
        el.setAttribute("height", String(shape.height));
        if (shape.href) el.setAttribute("href", shape.href);
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
        const natural = shape.href ? naturalSize(shape.href) : null;
        if (src && natural) {
            const nested = document.createElementNS(svgNS, "svg");
            nested.setAttribute("x", String(shape.x));
            nested.setAttribute("y", String(shape.y));
            nested.setAttribute("width", String(shape.width));
            nested.setAttribute("height", String(shape.height));
            nested.setAttribute("viewBox", `${src.x} ${src.y} ${src.width} ${src.height}`);
            nested.setAttribute("preserveAspectRatio", "none");
            el.setAttribute("x", "0");
            el.setAttribute("y", "0");
            el.setAttribute("width", String(natural.width));
            el.setAttribute("height", String(natural.height));
            nested.appendChild(el);
            applyTail(nested, item);
            group.appendChild(nested);
            return;
        }
        // A rect on an image that has NOT decoded draws nothing, exactly as Canvas draws nothing
        // for an href that is not ready — rather than briefly drawing the whole sheet, which is
        // the wrong picture rather than a missing one.
        if (src && !natural) return;
        applyTail(el, item);
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

    // Effect filter defs — rebuilt each frame (shares content's lifecycle; leak-free).
    const defs = getOrCreateDefs(svg);
    clearChildren(defs);
    buildFilters(defs, model.defs);

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
    const groupEls = new Map<string, SVGGElement>();
    for (const item of model.content) {
        let parent: SVGGElement = contentGroup;
        for (const id of item.groups ?? []) {
            let el = groupEls.get(id);
            if (!el) {
                el = document.createElementNS(svgNS, "g") as SVGGElement;
                el.setAttribute("opacity", String(groupAlpha.get(id) ?? 1));
                parent.appendChild(el);
                groupEls.set(id, el);
            }
            parent = el;
        }
        appendItem(parent, item);
    }

    clearChildren(overlayGroup);
    model.overlay.forEach(item => appendItem(overlayGroup, item));
}
