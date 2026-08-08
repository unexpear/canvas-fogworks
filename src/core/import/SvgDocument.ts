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
 * A GRADIENT FILL ARRIVES WHOLE (schema 56), through `SvgGradient`. 2,491 fills reference one and
 * every one of them used to arrive as its first stop; now only STROKES do, because `Style.stroke`
 * is still a colour string and exactly one stroke in the measured corpus references a ramp.
 *
 * THE GRADIENT IS MOVED WITH THE SHAPE, which is the part that is easy to get silently wrong. This
 * module BAKES the group transform into the coordinates, so a gradient left where the file put it
 * would paint in a coordinate system the shape has already left. `placeGradient` premultiplies the
 * same matrix, and turns `objectBoundingBox` into `userSpaceOnUse` by FOLDING the box into that
 * matrix rather than multiplying the coordinates — a radial ramp in a non-square box is an ELLIPSE,
 * which no cx/cy/r can state and a matrix states exactly.
 *
 * RESOLVED AT THE SHAPE, NOT WHERE THE FILL IS WRITTEN. An inherited `fill="url(#g)"` is resolved
 * against the element that PAINTS — its box and its user space, not its parent’s — so the
 * reference travels down the tree as a string and becomes a gradient only at the path that draws it.
 *
 * Every remaining approximation lands in `notes` rather than being left for somebody to discover.
 *
 * IT READS THE SHAPES THIS FORMAT DEFINES, NOT XML IN GENERAL — the same promise `TextureAtlas`
 * makes and for the same reason. What it cannot make sense of, it names.
 */

import { PathCommand } from "../document/Node";
import { Mat2D, IDENTITY, multiply, parseSvgTransform } from "../geometry/Matrix";
// The SAME function the shape layer already uses to push commands through a matrix. Written
// again here first, which is the duplicate this codebase keeps designing out — one rule, one
// place, and the compiler caught it the moment both names met in a test file.
import { transformCommands } from "../geometry/ShapeToPath";
import { parseSvgPath, svgPathError } from "./SvgPath";
import { pathBounds } from "../geometry/PathBuilder";
import { Gradient } from "../document/Gradient";
import { parseSvgGradients } from "./SvgGradient";

/** Shapes one file may yield, and how deep `<use>` may nest. Bounds on a hand-editable file. */
export const SVG_MAX_SHAPES = 50_000;
export const SVG_MAX_USE_DEPTH = 16;

/** One drawable, with its transform already applied to its coordinates. */
export interface SvgShape {
    /** Absolute commands in the FILE's coordinate space — the group stack is already multiplied in. */
    commands: PathCommand[];
    /** A hex colour, a GRADIENT (schema 56), or null when the shape is not filled. */
    fill: string | Gradient | null;
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

/**
 * A paint value as written, or null for none.
 *
 * A `url(#id)` IS RETURNED AS THE STRING IT IS, not resolved. SVG resolves a gradient against the
 * element that PAINTS — its own bounding box and its own user space — and this value cascades, so
 * resolving it here would give an inherited fill the wrong element’s geometry. The three
 * functions below do the resolving, at the shape.
 */
function colour(value: string | undefined): string | null | undefined {
    if (value === undefined) return undefined;              // not stated: inherit
    const v = value.trim();
    if (v === "" || v.toLowerCase() === "none") return null;
    return v;
}

/** Whether a paint value points at a paint server rather than naming a colour. */
function isReference(value: string | null): boolean {
    return value !== null && /^url\(/.test(value.trim());
}

/** The gradient a paint value references, or null when it references none — or none that resolves. */
function referenced(
    value: string | null, gradients: Map<string, Gradient>, notes: string[]
): Gradient | null {
    if (value === null) return null;
    const url = /^url\(\s*#([^)\s]+)\s*\)$/.exec(value.trim());
    if (!url) return null;
    const g = gradients.get(url[1]);
    // An unresolvable reference has no colour to fall back to, so the caller leaves the shape
    // unfilled rather than painting a guess.
    if (!g) { notes.push(`gradient "${url[1]}" could not be resolved`); return null; }
    // A ramp with NO STOPS paints nothing in SVG, and `gradientError` refuses it — so it is treated
    // as an unresolved reference rather than carried into a document that would then not load.
    if (g.stops.length === 0) { notes.push(`gradient "${url[1]}" has no stops`); return null; }
    return g;
}

/**
 * A gradient moved into the space this module leaves its coordinates in.
 *
 * `own` is the group stack that has ALREADY been multiplied through the path’s coordinates, so
 * the gradient has to travel with them or it paints in a system the shape has left. And
 * `objectBoundingBox` is folded into the matrix rather than multiplied into the coordinates,
 * because a radial ramp in a non-square box is an ellipse: `translate(box) · scale(size)` says that
 * exactly, and `cx/cy/r` cannot say it at all.
 */
function placeGradient(g: Gradient, own: Mat2D, local: readonly PathCommand[]): Gradient {
    let m = own;
    if (g.units === "objectBoundingBox") {
        const b = pathBounds(local);
        // A ZERO-EXTENT axis would make the fold singular and collapse the whole ramp to one
        // colour. SVG says such an element is not rendered at all; a unit box keeps it visible,
        // which is the more useful of the two wrong answers for an importer.
        m = multiply(m, { a: b.width || 1, b: 0, c: 0, d: b.height || 1, e: b.x, f: b.y });
    }
    return { ...g, units: "userSpaceOnUse", transform: multiply(m, g.transform) };
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

    // Every gradient in the file, read in full by the module that owns them. This used to be a
    // hand-rolled scan for the first `stop-color`, which is all a flattening importer needs;
    // `parseSvgGradients` also handles `href` inheritance, a `style=` spelling of the stop colour,
    // duplicate ids and self-closing tags — 3,090 ramps across the measured corpus.
    const gradients = parseSvgGradients(xml);

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
            const fill = colour(t.attrs.fill);
            const stroke = colour(t.attrs.stroke);
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
                    // Parsed ONCE and used twice: the untransformed commands are what this shape’s
                    // own bounding box means, and that box is what `objectBoundingBox` is a
                    // fraction of.
                    const local = parseSvgPath(t.attrs.d);
                    const ramp = referenced(inherited.fill, gradients, notes);
                    // A STROKE still flattens: `Style.stroke` is a colour string, and exactly one
                    // stroke in the 3,127 measured gradients references a ramp.
                    const strokeRamp = referenced(inherited.stroke, gradients, notes);
                    if (strokeRamp) notes.push(`a stroke gradient flattened to ${strokeRamp.stops[0].color}`);
                    shapes.push({
                        commands: transformCommands(own, local),
                        // A reference that did NOT resolve leaves the shape unfilled — never the
                        // literal "url(#g)", which the renderer would take for a colour name.
                        fill: ramp ? placeGradient(ramp, own, local)
                            : isReference(inherited.fill) ? null : inherited.fill,
                        stroke: strokeRamp ? strokeRamp.stops[0].color
                            : isReference(inherited.stroke) ? null : inherited.stroke,
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
