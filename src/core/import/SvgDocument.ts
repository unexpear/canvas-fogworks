/**
 * @module SvgDocument
 * @description A whole SVG file as flat, transformed shapes this engine can hold.
 *
 * `SvgPath` converts one `d` attribute. This walks the file around it: the group tree, the
 * transforms, the fills, and the symbol references that 19,194 elements in the measured art depend
 * on.
 *
 * A `<g transform>` CANNOT BECOME A NODE TRANSFORM. This engine's `Transform` is rotation, scale and
 * an origin; SVG's is an arbitrary affine matrix, and `matrix()` is 23,276 of the 24,861 transforms
 * measured. Decomposing one into rotate-and-scale works only when it holds no skew and silently
 * produces the wrong shape when it does.
 *
 * SO THE TRANSFORM IS BAKED INTO THE COORDINATES, which is exact rather than a compromise: a Bézier
 * curve is affine-invariant, so transforming its control points transforms the curve itself with no
 * error. Composing the group stack down to each path and multiplying through every coordinate loses
 * the group STRUCTURE — a far smaller loss than losing the shape, and the only one available.
 *
 * `<use>` IS EXPANDED, with a depth bound. It is not a corner case here: 19,194 elements reference a
 * defined symbol, and skipping them would drop most of the drawing in the files that use them. A
 * symbol referencing its own ancestor is a loop rather than a picture, hence the bound.
 *
 * GRADIENTS FLATTEN TO THEIR FIRST STOP AND SAY SO. This engine has no gradient and 2,491 fills are
 * one — about three percent. Refusing those files would cost the other ninety-seven percent of their
 * shapes, and dropping the fill would produce an invisible one. Every approximation lands in `notes`
 * rather than being left for somebody to discover.
 *
 * IT READS THE SHAPES THIS FORMAT DEFINES, NOT XML IN GENERAL — the same promise `TextureAtlas`
 * makes and for the same reason. What it cannot make sense of, it names.
 */

import { PathCommand } from "../document/Node";
import { Mat2D, IDENTITY, multiply } from "../geometry/Matrix";
// The SAME function the shape layer already uses to push commands through a matrix. Written
// again here first, which is the duplicate this codebase keeps designing out — one rule, one
// place, and the compiler caught it the moment both names met in a test file.
import { transformCommands } from "../geometry/ShapeToPath";
import { parseSvgPath, svgPathError } from "./SvgPath";

/** Shapes one file may yield, and how deep `<use>` may nest. Bounds on a hand-editable file. */
export const SVG_MAX_SHAPES = 50_000;
export const SVG_MAX_USE_DEPTH = 16;

/** One drawable, with its transform already applied to its coordinates. */
export interface SvgShape {
    /** Absolute commands in the FILE's coordinate space — the group stack is already multiplied in. */
    commands: PathCommand[];
    /** A hex colour, or null when the shape is not filled. */
    fill: string | null;
    stroke: string | null;
    strokeWidth: number | null;
    opacity: number;
}

/** A read file, plus an honest account of what could not be represented exactly. */
export interface SvgDocumentResult {
    /** The file's own size when it states one, else the viewBox's, else null. */
    width: number | null;
    height: number | null;
    shapes: SvgShape[];
    /** Every approximation made, so a caller can show them rather than discover them. */
    notes: string[];
}

/** One tag, as the scanner sees it. */
interface Tag {
    name: string;
    attrs: Record<string, string>;
    closing: boolean;
    selfClosing: boolean;
}

/** Tags in document order. Attribute values may hold `>`, which is why this is not a split. */
function scanTags(xml: string): Tag[] {
    const out: Tag[] = [];
    for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g)) {
        const attrs: Record<string, string> = {};
        for (const a of m[3].matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"|([A-Za-z_][\w:.-]*)\s*=\s*'([^']*)'/g)) {
            // Namespaced attributes are keyed by their LOCAL name, so `xlink:href` and `href` — both
            // of which appear — are one thing rather than two spellings a reader must remember.
            const key = (a[1] ?? a[3]).replace(/^.*:/, "");
            attrs[key] = a[2] ?? a[4];
        }
        // SELF-CLOSING is read from the attribute run, not from a separate group: the run matches
        // `[^>"']`, which happily swallows the trailing slash, so the obvious `(\/?)>` capture is
        // always empty. Nothing was ever detected as self-closing, `<defs>` appeared to close at
        // `</svg>`, and 5,264 of 5,279 files parsed to nothing at all.
        const selfClosing = m[4] === "/" || /\/\s*$/.test(m[3]);
        out.push({ name: m[2].replace(/^.*:/, ""), attrs, closing: m[1] === "/", selfClosing });
    }
    return out;
}

/** One `transform` attribute as a matrix. Unknown functions are skipped by the caller's note. */
export function parseSvgTransform(text: string): Mat2D {
    let m = IDENTITY;
    for (const fn of text.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
        const n = fn[2].trim().split(/[\s,]+/).filter(v => v.length > 0).map(Number);
        if (n.some(v => !Number.isFinite(v))) continue;
        const name = fn[1].toLowerCase();
        let step: Mat2D | null = null;
        if (name === "matrix" && n.length >= 6) step = { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] };
        else if (name === "translate" && n.length >= 1) step = { a: 1, b: 0, c: 0, d: 1, e: n[0], f: n[1] ?? 0 };
        else if (name === "scale" && n.length >= 1) step = { a: n[0], b: 0, c: 0, d: n[1] ?? n[0], e: 0, f: 0 };
        else if (name === "rotate" && n.length >= 1) {
            const r = (n[0] * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
            const rot: Mat2D = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
            // A ROTATION ABOUT A POINT is three steps, and writing it as one is the usual way to get
            // it subtly wrong — the centre has to be moved to the origin and back.
            step = n.length >= 3
                ? multiply(multiply({ a: 1, b: 0, c: 0, d: 1, e: n[1], f: n[2] }, rot),
                    { a: 1, b: 0, c: 0, d: 1, e: -n[1], f: -n[2] })
                : rot;
        } else if (name === "skewx" && n.length >= 1) step = { a: 1, b: 0, c: Math.tan((n[0] * Math.PI) / 180), d: 1, e: 0, f: 0 };
        else if (name === "skewy" && n.length >= 1) step = { a: 1, b: Math.tan((n[0] * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
        // LEFT TO RIGHT: `transform="a b"` means a THEN b, which composes as a·b.
        if (step) m = multiply(m, step);
    }
    return m;
}

/** What went wrong, or null. */
export function svgDocumentError(xml: unknown): string | null {
    if (typeof xml !== "string") return "an SVG document must be a string";
    if (!/<svg[\s>]/i.test(xml)) return "not an SVG document: no <svg> element";
    return null;
}

/** A length attribute like `1940px`, or null. Units other than pixels are not resolved. */
function length(value: string | undefined): number | null {
    if (value === undefined) return null;
    const m = /^\s*(-?[\d.]+(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(value);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}

/** A colour this engine can hold, or null for none — flattening a gradient reference if asked. */
function colour(
    value: string | undefined, gradients: Map<string, string>, notes: string[]
): string | null | undefined {
    if (value === undefined) return undefined;              // not stated: inherit
    const v = value.trim();
    if (v === "" || v.toLowerCase() === "none") return null;
    const url = /^url\(\s*#([^)\s]+)\s*\)$/.exec(v);
    if (url) {
        const first = gradients.get(url[1]);
        // FLATTENED TO THE FIRST STOP and reported. An unresolvable reference has no colour to fall
        // back to, so the shape is left unfilled rather than painted a guess.
        if (first) {
            notes.push(`gradient "${url[1]}" flattened to ${first}`);
            return first;
        }
        notes.push(`gradient "${url[1]}" could not be resolved`);
        return null;
    }
    return v;
}

/**
 * The shapes an SVG file holds, with every transform already applied.
 *
 * Throws on anything `svgDocumentError` refuses. Individual shapes that cannot be read are SKIPPED
 * and noted rather than failing the file: one malformed path in a generated drawing should not cost
 * the other three hundred.
 */
export function parseSvgDocument(xml: string): SvgDocumentResult {
    const bad = svgDocumentError(xml);
    if (bad) throw new Error(`Invalid SVG document: ${bad}.`);

    const tags = scanTags(xml);
    const notes: string[] = [];

    // Gradients first: a fill may reference one defined later in the file, so a single forward pass
    // would resolve some and miss others depending only on where the author put them.
    const gradients = new Map<string, string>();
    for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t.closing || !/^(linear|radial)Gradient$/i.test(t.name) || !t.attrs.id) continue;
        for (let k = i + 1; k < tags.length; k++) {
            if (tags[k].closing && /Gradient$/i.test(tags[k].name)) break;
            const stop = tags[k].attrs["stop-color"];
            if (tags[k].name === "stop" && stop) { gradients.set(t.attrs.id, stop.trim()); break; }
        }
    }

    // Where each id's element begins, so `<use>` can replay it.
    const byId = new Map<string, number>();
    tags.forEach((t, i) => { if (!t.closing && t.attrs.id && !byId.has(t.attrs.id)) byId.set(t.attrs.id, i); });

    const root = tags.find(t => !t.closing && t.name === "svg");
    const viewBox = (root?.attrs.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
    const width = length(root?.attrs.width) ?? (viewBox.length === 4 && Number.isFinite(viewBox[2]) ? viewBox[2] : null);
    const height = length(root?.attrs.height) ?? (viewBox.length === 4 && Number.isFinite(viewBox[3]) ? viewBox[3] : null);

    const shapes: SvgShape[] = [];
    /** Style inherited down the tree — SVG's presentation attributes cascade. */
    interface Inherited { fill: string | null; stroke: string | null; strokeWidth: number | null; opacity: number }

    const walk = (from: number, to: number, matrix: Mat2D, style: Inherited, depth: number): void => {
        // A STACK rather than recursion over children, because the scanner produces a flat list and
        // the tree is implied by open/close pairs.
        const stack: { end: number; matrix: Mat2D; style: Inherited }[] = [];
        let current = { matrix, style };
        for (let i = from; i < to && shapes.length <= SVG_MAX_SHAPES; i++) {
            const t = tags[i];
            if (t.closing) {
                const popped = stack.pop();
                if (popped) current = { matrix: popped.matrix, style: popped.style };
                continue;
            }
            const own = t.attrs.transform ? multiply(current.matrix, parseSvgTransform(t.attrs.transform)) : current.matrix;
            const fill = colour(t.attrs.fill, gradients, notes);
            const stroke = colour(t.attrs.stroke, gradients, notes);
            const sw = length(t.attrs["stroke-width"]);
            const op = Number(t.attrs.opacity);
            const inherited: Inherited = {
                fill: fill === undefined ? current.style.fill : fill,
                stroke: stroke === undefined ? current.style.stroke : stroke,
                strokeWidth: sw ?? current.style.strokeWidth,
                opacity: Number.isFinite(op) ? current.style.opacity * op : current.style.opacity
            };

            if (t.name === "path" && t.attrs.d) {
                if (svgPathError(t.attrs.d) !== null) {
                    notes.push(`a path was skipped: ${svgPathError(t.attrs.d)}`);
                } else {
                    shapes.push({
                        commands: transformCommands(own, parseSvgPath(t.attrs.d)),
                        fill: inherited.fill, stroke: inherited.stroke,
                        strokeWidth: inherited.strokeWidth, opacity: inherited.opacity
                    });
                }
            } else if (t.name === "use") {
                const href = (t.attrs.href ?? "").replace(/^#/, "");
                const target = byId.get(href);
                if (target === undefined) notes.push(`<use> references "${href}", which is not defined`);
                else if (depth >= SVG_MAX_USE_DEPTH) notes.push(`<use> nesting is deeper than ${SVG_MAX_USE_DEPTH}`);
                else {
                    // `x`/`y` on a use are a translation of whatever it references.
                    const dx = length(t.attrs.x) ?? 0, dy = length(t.attrs.y) ?? 0;
                    const placed = dx !== 0 || dy !== 0
                        ? multiply(own, { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy }) : own;
                    walk(target, closingOf(tags, target), placed, inherited, depth + 1);
                }
            }
            // A CONTAINER pushes its state; anything self-closing has no children to push for.
            if (!t.selfClosing && t.name !== "path" && t.name !== "use") {
                stack.push({ end: to, matrix: current.matrix, style: current.style });
                current = { matrix: own, style: inherited };
            }
        }
    };

    // `<defs>` holds definitions rather than drawing, so it is walked only through a `<use>`.
    const defsRanges: [number, number][] = [];
    tags.forEach((t, i) => { if (!t.closing && t.name === "defs") defsRanges.push([i, closingOf(tags, i)]); });
    const inDefs = (i: number) => defsRanges.some(([a, b]) => i >= a && i <= b);

    const base: Inherited = { fill: null, stroke: null, strokeWidth: null, opacity: 1 };
    for (let i = 0; i < tags.length; i++) {
        if (tags[i].closing || tags[i].name !== "svg") continue;
        // Walk the root's children, skipping the definition blocks.
        const end = closingOf(tags, i);
        for (let k = i + 1; k < end; k++) {
            if (inDefs(k)) { k = defsRanges.find(([a]) => a === k)?.[1] ?? k; continue; }
            walk(k, closingOf(tags, k) + 1, IDENTITY, base, 0);
            k = closingOf(tags, k);
        }
        break;
    }
    return { width, height, shapes, notes };
}

/** The index of the tag that closes the one at `open`, or the end of the list. */
function closingOf(tags: Tag[], open: number): number {
    if (tags[open].selfClosing) return open;
    let depth = 0;
    for (let i = open; i < tags.length; i++) {
        if (tags[i].closing) {
            depth--;
            if (depth === 0) return i;
        } else if (!tags[i].selfClosing) depth++;
    }
    return tags.length - 1;
}
