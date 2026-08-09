/**
 * @module RenderModel
 * @description The renderer's pure, DOM-free display list. `buildRenderModel`
 * turns a document + its `ComputedState` + the current `RendererState` into a
 * plain-data `DisplayList` — every draw decision (which shape, resolved paint,
 * placement matrix, the grid's visible-range signature, selection overlay) lives
 * here, where it can be asserted in the `node` test environment exactly like the
 * layout engine. The backends (`emitSVG`, later `emitCanvas`) are dumb: they
 * transcribe this list to DOM/canvas API calls and do no arithmetic.
 *
 * Renderer invariant (mechanically enforced): this module imports no coordinate-
 * composition from the geometry layer — only the `Mat2D`/`Quad` *types* and
 * `selectionHandles`/`selectionFrame` (which apply the matrix the ENGINE published, and
 * compose nothing themselves), never `multiply`/`compose`. Positions come straight from
 * `ComputedState` (`world`/`local`/`bounds`); the model never composes coordinates. It
 * reads shape params from `local.width/height`, places by the pre-computed `world`, and
 * takes the selection frame + handles as finished world-space points.
 *
 * Design tokens (M5): every COLOR slot (fill, stroke, shadow.color, the line's
 * stroke||fill fallback) resolves `$token` references against `doc.variables` under
 * `doc.activeTheme` HERE, in the model — so both backends agree, the deduped filter defs
 * key on resolved colors, and a theme switch is just another frame. Broken references
 * resolve to the visible fallback magenta; presence checks stay on the raw style values.
 */

import { SourceRect } from "../core/document/Node";
import { ReadonlyDocument } from "../core/document/Document";
import { FillRule, PathCommand, Shadow, StrokeCap, StrokeJoin, TextAlign, flatFill } from "../core/document/Node";
import { Gradient, GradientStop, GradientUnits } from "../core/document/Gradient";
import { NineSliceInsets, nineSliceRects } from "../core/geometry/NineSlice";
import { depthOf } from "../core/document/Depth";
import { ReadonlyMesh, isFlatMesh } from "../core/document/Mesh";
import { Light, shadowOffset } from "../core/document/Light";
import { castShadows, ShadowShape, SHADOW_ALPHA } from "../core/geometry/CastShadow";
import { Ring, commandsToRings, ringsToCommands } from "../core/geometry/PathBoolean";
import { resolveRings } from "../core/geometry/Resolve";
import { worldCommandsOf } from "../core/actions/booleanActions";
import { resolveColor, resolveNumber, VariableStore } from "../core/document/Variables";
import { BlendMode } from "../core/document/Node";
import { selectionRoots } from "../core/document/SceneGraph";
import { resolveScene } from "../core/document/Components";
import { ComputedState, selectionBounds } from "../core/geometry/GeometryEngine";
import { Mat2D } from "../core/geometry/Matrix";
import { selectionHandles, selectionFrame, pathVertexHandles, meshHandles, gradientHandles, groupRotateHandle, groupCornerHandles, SelectionHandle, HANDLE_SIZE_PX } from "../core/geometry/SelectionHandles";
import { Quad } from "../core/geometry/OrientedBox";
import { isGroupRotatable, isGroupResizable } from "../core/geometry/GroupTransform";
import { isHandleOffered } from "../core/actions/nodeEdit";
import { RendererState } from "./RendererState";

const GRID_BASE = 20;
const GRID_MAX_LINES_PER_AXIS = 300; // density cap: coarsen the grid instead of exploding line count
/** Resize-handle size in SCREEN pixels (converted to world by dividing by zoom). Re-exported for backends/tools. */
export { HANDLE_SIZE_PX };

/** Container pixel size, read from the DOM by the thin `renderSVG` shim and passed in. */
export interface Size {
    width: number;
    height: number;
}

/** A draw primitive in the node's LOCAL space (world placement lives on the item). */
export type Shape =
    | { kind: "rect"; x: number; y: number; width: number; height: number }
    | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
    | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
    | { kind: "path"; commands: readonly PathCommand[] }
    | {
        kind: "text"; x: number; y: number; width: number; height: number; text: string;
        /** Typography, all RESOLVED here (tokens looked up, ranges checked, defaults applied)
         *  so both backends transcribe numbers and strings and decide nothing. */
        fontSize: number; fontFamily: string; fontWeight: number; textAlign: TextAlign;
        lineHeight: number; letterSpacing: number
    }
    | {
        kind: "image"; x: number; y: number; width: number; height: number; href: string | null;
        /** The SOURCE sub-rectangle in the image's own pixels, or null for the whole image. */
        source: SourceRect | null;
        /** Scale by nearest neighbour. Carried for EVERY image, never only when true — see below. */
        pixelated: boolean;
        /**
         * Nine-slice insets in SOURCE pixels, or null for one stretched picture (schema 57).
         *
         * THE INSETS TRAVEL, NOT THE NINE RECTANGLES, and that is forced rather than chosen: the
         * pieces depend on the source's PIXEL SIZE, and for a `core.image` with no `sourceRect`
         * that size is unknown until the file decodes — which this model, being pure, can never
         * wait for. Each backend already resolves the bitmap before it draws, so each calls the
         * one shared `nineSliceRects` with the size it has. Three call sites, one arithmetic.
         */
        nineSlice: NineSliceInsets | null;
        /**
         * The run-length payload for a `core.raster`, or null for a `core.image`.
         *
         * CARRIED, BECAUSE THE HREF IS ONLY A KEY. The cache cannot decode a surface it cannot see,
         * and the alternatives all cost something real: registering from inside the model would
         * make the model impure, and registering on every document change would decode whether or
         * not anything drew. Handing the payload along the display list keeps the model plain data
         * — this is a reference to a string the document already holds, not a copy — and lets the
         * cache decode LAZILY on a miss, which is exactly what image loading already does.
         */
        surface: { data: string; width: number; height: number } | null;
    };

/** Compile error if a `PathCommand` variant is ever added without a `commandsToPathData` case. */
function assertNever(x: never): never {
    throw new Error(`unhandled path command: ${JSON.stringify(x)}`);
}

/**
 * Serialize absolute path commands to an SVG `d` string. Pure (like `toMatrixString`) so the
 * one string-build the backend can't get wrong is unit-tested in the `node` env. Single-space
 * separated, no leading/trailing space; numbers emitted verbatim; empty list → `""`.
 */
export function commandsToPathData(commands: readonly PathCommand[]): string {
    return commands.map(cmd => {
        switch (cmd.c) {
            case "M": return `M ${cmd.x} ${cmd.y}`;
            case "L": return `L ${cmd.x} ${cmd.y}`;
            case "C": return `C ${cmd.x1} ${cmd.y1} ${cmd.x2} ${cmd.y2} ${cmd.x} ${cmd.y}`;
            case "Q": return `Q ${cmd.x1} ${cmd.y1} ${cmd.x} ${cmd.y}`;
            case "Z": return "Z";
            default: return assertNever(cmd);
        }
    }).join(" ");
}

/**
 * Text split into PARAGRAPHS on explicit newlines — the hard breaks, shared by everything that
 * lays text out.
 *
 * A newline is a line in both backends (schema 34), and the exporter has to agree or a document
 * exports as one run of text it does not look like. Wrapping on the box width is a separate,
 * MEASURED step that only the canvas backend can do; this is the part that needs no measurement
 * and therefore must not be re-implemented three times.
 *
 * Whitespace WITHIN a paragraph is collapsed to single separators, matching `white-space:
 * pre-wrap`'s treatment of runs of spaces and tabs.
 */
/** Every typography value a text shape needs, resolved — the shape of what `resolveTypography` answers. */
export interface ResolvedType {
    fontSize: number;
    fontFamily: string;
    fontWeight: number;
    textAlign: TextAlign;
    lineHeight: number;
    letterSpacing: number;
}

/**
 * A style's typography with `$token`s looked up, ranges checked and defaults applied (schema 34).
 *
 * EXPORTED because the render model is no longer the only thing that needs it: the on-canvas text
 * editor puts a real text field over the node, and a field whose metrics disagree with the render
 * puts the caret in the wrong place and makes the text jump the moment editing ends. Re-deriving
 * the defaults there would be five numbers written twice — and the ONE that drifted would be
 * invisible until somebody typed into a node that used it.
 *
 * A broken or out-of-range token falls back to the documented default rather than throwing: a
 * negative `spacing` variable is a legal variable and an illegal line height, and the answer to
 * that is the value the renderer already drew.
 */
export function resolveTypography(
    style: {
        fontSize?: number | string; fontFamily?: string; fontWeight?: number | string;
        textAlign?: TextAlign; lineHeight?: number | string; letterSpacing?: number | string;
    },
    store: VariableStore,
    theme: string
): ResolvedType {
    const slot = (raw: number | string | undefined, fallback: number, min: number, max: number): number => {
        if (raw === undefined) return fallback;
        const n = typeof raw === "number" ? raw : resolveNumber(store, raw, theme as never);
        return n !== null && n >= min && n <= max ? n : fallback;
    };
    return {
        // `fontSize` has no upper bound of its own — only "positive" — which is why it is not just
        // another `slot` call.
        fontSize: (() => {
            if (style.fontSize === undefined) return 14;
            const r = typeof style.fontSize === "number" ? style.fontSize : resolveNumber(store, style.fontSize, theme as never);
            return r !== null && r > 0 ? r : 14;
        })(),
        fontFamily: style.fontFamily && style.fontFamily.trim() !== "" ? style.fontFamily : "sans-serif",
        fontWeight: slot(style.fontWeight, 400, 1, 1000),
        textAlign: style.textAlign ?? "left",
        // `normal` in a browser is ~1.2, which is what the Canvas backend already used to break
        // lines — so an absent line height keeps every backend where it was.
        lineHeight: slot(style.lineHeight, 1.2, 0.01, 100),
        letterSpacing: slot(style.letterSpacing, 0, -1e6, 1e6)
    };
}

export function textParagraphs(text: string): string[] {
    return text.split("\n").map(p => p.split(/[^\S\n]+/).filter(w => w.length > 0).join(" "));
}

/**
 * Resolved appearance. A `null` field is ABSENT (the backend emits no attribute);
 * a non-null field is present with that value — this reproduces the current
 * renderer's attribute presence rules exactly (e.g. the unknown-type fallback rect
 * carries no `opacity`, an outline carries `fill: "none"`). Z-dependent values
 * (`strokeWidth: 1/z`, `strokeDash`) are resolved to world units here so the
 * backend does zero maths.
 */
/**
 * A gradient with its colours RESOLVED, ready for a backend to paint (schema 56).
 *
 * COORDINATES ARE CARRIED AS AUTHORED, with `units` alongside them — NOT multiplied out into the
 * shape's local space. Two reasons, and the second is the load-bearing one:
 *
 *   - This module composes no coordinates. That is the renderer invariant at the top of the file,
 *     and folding `objectBoundingBox` into local units is exactly the matrix arithmetic it forbids.
 *   - SVG has `gradientUnits` and `gradientTransform` natively, so the backend that paints this
 *     exactly is the one that does the least work. Multiplying out here would mean computing a
 *     matrix so the SVG backend could hand it back.
 *
 * `flat` is the SINGLE colour a backend without gradient support paints, decided here so all three
 * agree on what a flattened ramp looks like rather than each choosing.
 */
export interface PaintGradient {
    kind: "linear" | "radial";
    /** Content-derived and stable — `emitSVG` keys one `<defs>` entry per distinct ramp on it. */
    id: string;
    units: GradientUnits;
    /** `$token` colours resolved; offsets already sorted and clamped by the document layer. */
    stops: readonly GradientStop[];
    transform: Mat2D;
    x1: number; y1: number; x2: number; y2: number;
    cx: number; cy: number; r: number; fx: number; fy: number;
    /** The first stop, resolved — what a backend that cannot ramp paints instead. */
    flat: string;
}

/**
 * A stable `<defs>` id for one resolved ramp.
 *
 * The same reasoning as `rasterHref`: a cheap rolling sum, not a real hash, because a collision
 * costs two identical-looking gradients sharing a def and never a wrong picture — and the
 * descriptor's LENGTH travels in the id, so two ramps must agree on both to collide at all.
 */
export function gradientDefId(g: Omit<PaintGradient, "id">): string {
    const s = JSON.stringify([g.kind, g.units, g.transform,
        g.x1, g.y1, g.x2, g.y2, g.cx, g.cy, g.r, g.fx, g.fy, g.stops]);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 0xffffffff;
    return `grad_${g.kind[0]}${h.toString(36)}_${s.length}`;
}

/** A document gradient with every `$token` stop colour resolved under the active theme. */
export function resolvePaintGradient(g: Gradient, color: (raw: string) => string): PaintGradient {
    const stops = g.stops.map(s => ({ offset: s.offset, color: color(s.color), opacity: s.opacity }));
    const body: Omit<PaintGradient, "id"> = {
        kind: g.kind, units: g.units, stops, transform: g.transform,
        x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2,
        cx: g.cx, cy: g.cy, r: g.r, fx: g.fx, fy: g.fy,
        // Resolved, so a token in the first stop flattens to a colour rather than to "$color/x".
        flat: stops[0]?.color ?? "#000000"
    };
    return { ...body, id: gradientDefId(body) };
}

export interface Paint {
    /**
     * A colour, a resolved GRADIENT (schema 56), or null for "emit no fill at all".
     *
     * A UNION RATHER THAN A SECOND FIELD, deliberately. `fill` is read at four sites across the
     * three backends and the exporter; a `fillGradient` sitting beside it would leave each of them
     * compiling perfectly while painting the flat colour, which is the silently-plausible failure
     * this codebase keeps being bitten by. As a union, a site that has not been taught about
     * gradients does not build.
     */
    fill: string | PaintGradient | null;
    opacity: number | null;
    stroke: string | null;
    strokeWidth: number | null;
    /**
     * Corner and end treatment, and the miter cutoff (schema 37).
     *
     * OPTIONAL rather than `null`-when-absent, unlike every other field here, and deliberately:
     * these three only mean anything alongside a stroke, and an absent one is not "draw nothing"
     * but "draw what you already drew" — SVG's own defaults, which all three backends used
     * before the fields existed. Writing them as explicit nulls at the dozen sites that build a
     * Paint would say something the document never said.
     */
    strokeJoin?: StrokeJoin;
    strokeCap?: StrokeCap;
    strokeMiterLimit?: number;
    /** Which points a closed outline encloses; absent = "nonzero", what all three already drew. */
    fillRule?: FillRule;
    strokeDash: string | null;
    radius: number | null;
    cursor: string | null;
    /** `false` → the backend sets `pointer-events: none` (grid/outline/preview). */
    pointerEvents: boolean;
    /** Drop shadow (world units), or null. Both backends read it; SVG also builds a `<filter>` def. */
    shadow: Shadow | null;
    /** Whole-node gaussian blur radius (world units), or null. */
    blur: number | null;
    /**
     * How this item's colour combines with what is behind it (schema 60), or null for normal.
     *
     * On the PAINT rather than on a group, because that is where the document puts it and where
     * every one of the three backends wants it: SVG a CSS property on the element, Canvas a
     * `globalCompositeOperation` around the draw, the GPU a blend function or a shader pass. A
     * node blends against whatever it happens to be over, which is a different question from the
     * one opacity groups answer.
     */
    blendMode: BlendMode | null;
}

/** A deduped filter definition (schema-18 effects) — emitSVG builds one `<filter id>` per entry. */
export interface FilterDef {
    id: string;
    shadow: Shadow | null;
    blur: number | null;
}

/** Encode a finite number into an SVG-id-safe, reversible token (`-`→n, `.`→p, `+`→P). */
function tok(n: number): string {
    return String(n).replace(/-/g, "n").replace(/\./g, "p").replace(/\+/g, "P");
}
/** Hex-encode a colour string (arbitrary, incl. tokens like `$color/x`) into an id-safe, injective form. */
function hexColor(s: string): string {
    let h = "";
    // padStart(4): charCodeAt is a 16-bit code unit (<= 0xFFFF = 4 hex digits). padStart(2) only pads a
    // MINIMUM, so a code point >= U+0100 would emit 3-4 digits and break the fixed-width → non-injective.
    for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, "0");
    return h;
}

/**
 * Deterministic, INJECTIVE, SVG-id-safe filter id for an effect (the twin of `commandsToPathData`
 * — a pure string build, unit-tested in the node env). `null` when there is no effect, so identical
 * effects share ONE `<filter>` def and the backend needs zero escaping. The `fx` prefix guarantees a
 * letter-leading id; the charset is `[A-Za-z0-9_]`.
 */
/**
 * The href a raster surface is resolved by.
 *
 * IDENTITY, NOT A LOCATION. Nothing fetches this — a renderer-side cache decodes the surface it
 * names, exactly as `ImageCache` decodes a `src`. The payload's own length and a cheap checksum ride
 * along so the key CHANGES when the pixels do: a key built from the node id alone would leave every
 * stroke showing the picture from before it, because the id is what does not change when a surface
 * is painted.
 */
export function rasterHref(nodeId: string, surface: { data: string; width: number; height: number }): string {
    // A sum of char codes rather than a real hash: this only has to change when the payload does,
    // and it is recomputed for every raster node on every frame. Collisions cost a stale frame,
    // not a wrong picture, because the length and dimensions travel with it.
    let sum = 0;
    for (let i = 0; i < surface.data.length; i++) sum = (sum + surface.data.charCodeAt(i) * (i + 1)) % 0xffffffff;
    return `raster:${nodeId}:${surface.width}x${surface.height}:${surface.data.length}:${sum}`;
}

export function effectFilterId(shadow: Shadow | null, blur: number | null): string | null {
    const hasBlur = blur !== null && blur > 0;
    if (!shadow && !hasBlur) return null;
    let id = "fx";
    if (shadow) id += `_s${tok(shadow.dx)}_${tok(shadow.dy)}_${tok(shadow.blur)}_${hexColor(shadow.color)}`;
    if (hasBlur) id += `_b${tok(blur as number)}`;
    return id;
}

export type DrawRole = "grid-line" | "content" | "outline" | "handle" | "preview" | "marquee" | "guide" | "shadow";

/** One resolved primitive: a shape, its paint, its world placement, and hit-test tags. */
export interface DrawItem {
    shape: Shape;
    paint: Paint;
    /** World placement. `null` → the backend emits no transform (overlay/grid are in world space already). */
    world: Mat2D | null;
    /** `data-node-id` for hit-testing; `null` → not emitted. */
    nodeId: string | null;
    /** `data-resize-handle` for resize hit-testing (handles only). */
    handle?: string;
    /**
     * The node's own box in LOCAL units — carried only for an `objectBoundingBox` gradient
     * (schema 56), which is a fraction of it.
     *
     * NOT ON `PaintGradient`, deliberately. That is deduped by content into one `<defs>` entry per
     * ramp, and a box on it would split the identical ramp on two differently-sized shapes into
     * two defs. And not derived in the backend either: a `path` item carries commands, not an
     * extent, and working one out there is exactly the arithmetic a backend must not do.
     *
     * The SVG backend never reads it — SVG has `gradientUnits` and applies the box itself.
     */
    localBox?: { width: number; height: number };
    role: DrawRole;
    /**
     * How far BACK the item sits (schema 40). Absent = 0, the plane of the page.
     *
     * Carried on the ITEM rather than looked up per backend, because all three need it and one
     * of them (the GPU) needs it per vertex. See `document/Depth`.
     */
    depth?: number;
    /**
     * The LIGHTING surface this item's shape came from (schema 42), when it had one.
     *
     * Carried separately from the shape because by the time an item exists, `resolveMeshes` has
     * turned a meshed node into a path and dropped its mesh — the bend is in the commands, and
     * what a light needs is the surface that CAUSED the bend. Only the unresolved document still
     * has it, so the model reads it from there and passes it along.
     */
    surface?: { mesh: ReadonlyMesh; box: { width: number; height: number } };
    /**
     * OPACITY GROUPS this item is inside, outermost first (schema 32).
     *
     * A node with children and `opacity < 1` composites as a GROUP: everything inside it is
     * drawn, then the result is faded once. Multiplying the alpha into each child instead makes
     * overlapping children show through one another, which is the wrong picture and the reason
     * this is structure rather than a number.
     *
     * `paint.opacity` stays the node's OWN value. A backend that can group (SVG's `<g opacity>`)
     * uses this; one that cannot folds the group alphas in itself.
     */
    groups?: string[];
}

/**
 * The grid as data. `sig` is the visible-range signature that drives the
 * incremental cache: when it is unchanged the backend leaves the grid DOM alone.
 * `unchanged` records that the builder reused `prev`'s lines by reference (an
 * allocation optimisation for the common viewport-static case, e.g. node drags).
 */
export interface GridModel {
    sig: string;
    lines: DrawItem[];
    unchanged: boolean;
}

/** The whole frame as plain, serializable data. */
export interface DisplayList {
    viewport: { x: number; y: number; zoom: number };
    grid: GridModel;
    content: DrawItem[];
    overlay: DrawItem[];
    /**
     * The scene's LIGHTING (schema 42), carried on the list rather than per item.
     *
     * A light belongs to the document, not to a shape: two shapes lit from different directions
     * do not read as two shapes, they read as a mistake. Absent = unlit, which is what every
     * document was, and what the shader multiplies by one.
     */
    lights?: readonly Light[];
    ambient?: number;
    /** Deduped filter defs referenced by content items — emitSVG builds `<defs>` from these. */
    defs: FilterDef[];
    /**
     * Deduped GRADIENT defs referenced by content items (schema 56), in content order.
     *
     * Separate from `defs` because the two are unrelated things that happen to share an element:
     * a filter is keyed on an effect and a gradient on a ramp, and merging them would mean one
     * list whose entries are a union nothing iterates over as a whole.
     */
    gradients: PaintGradient[];
    /** The opacity groups `content` items refer to, outermost first. */
    groups: OpacityGroup[];
}

/**
 * A node whose subtree a backend must open a LAYER for — to fade it, to clip it, or both.
 *
 * The name is narrower than the type now: a clip is not an opacity, but it is the same SEQUENCING
 * problem — which layers just ended, which just began — and `layerTransition` is the answer to
 * that question rather than to "what is a fade". A second parallel chain would mean two orderings
 * to keep consistent, and the first time a clip and a fade nested the wrong way round would be the
 * first time anyone noticed.
 *
 * `opacity` is 1 and `clip` absent for a layer that only does the other thing, so a backend can
 * take the cheap path: Canvas needs an offscreen canvas to fade a group, but a plain `ctx.clip()`
 * for a clip, and paying for the offscreen either way would make clipping cost what fading does.
 */
export interface OpacityGroup {
    id: string;
    opacity: number;
    /** The region this layer clips to, in WORLD space, or absent (schema 59). */
    clip?: ClipRegion;
}

/**
 * A clip, as the backends need it: a box, its corner radius, and the matrix that places it.
 *
 * THE NODE'S OWN BOX, because that is what `clipsContent` means — there is no separate region to
 * place or keep in sync. Carried as local box + world matrix rather than as a world-space
 * rectangle, because a rotated frame's clip is not axis-aligned and flattening it here would throw
 * away the only form in which it is still exactly a rounded rectangle. Every backend can express
 * that: SVG a `<clipPath>` with a transform, Canvas a `roundRect` under `setTransform`, the GPU a
 * test in the fragment shader against the inverse.
 */
export interface ClipRegion {
    width: number;
    height: number;
    radius: number;
    world: Mat2D;
}

type Box = { x: number; y: number; width: number; height: number };

function isFiniteRect(r: Box): boolean {
    return Number.isFinite(r.x) && Number.isFinite(r.y) &&
        Number.isFinite(r.width) && Number.isFinite(r.height);
}

/**
 * Inclusive AABB overlap. Edges that merely touch (zero-area overlap) count as
 * intersecting, so a node straddling the viewport boundary — or a zero-height
 * hairline whose box sits exactly on it — is kept, not culled.
 */
function rectsIntersect(a: Box, b: Box): boolean {
    return a.x <= b.x + b.width && a.x + a.width >= b.x &&
        a.y <= b.y + b.height && a.y + a.height >= b.y;
}

function lineItem(x1: number, y1: number, x2: number, y2: number, stroke: string, strokeWidth: number): DrawItem {
    return {
        shape: { kind: "line", x1, y1, x2, y2 },
        paint: {
            fill: null, opacity: null, stroke, strokeWidth,
            strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null, blendMode: null
        },
        world: null,
        nodeId: null,
        role: "grid-line"
    };
}

function buildGrid(
    size: Size,
    viewport: { x: number; y: number },
    z: number,
    prev: DisplayList | null | undefined
): GridModel {
    const vpW = (size.width || 800) / z;
    const vpH = (size.height || 600) / z;

    // Coarsen the grid at low zoom so the visible line count stays bounded.
    let gridSize = GRID_BASE;
    while (vpW / gridSize > GRID_MAX_LINES_PER_AXIS || vpH / gridSize > GRID_MAX_LINES_PER_AXIS) {
        gridSize *= 2;
    }

    const startX = Math.floor(viewport.x / z / gridSize) * gridSize;
    const startY = Math.floor(viewport.y / z / gridSize) * gridSize;

    // Same signature the DOM cache keys on. Unchanged visible range → reuse prev's
    // lines by reference (avoids rebuilding the line array on every node drag).
    const sig = `${startX}|${startY}|${gridSize}|${Math.round(vpW)}|${Math.round(vpH)}|${z.toFixed(4)}`;
    if (prev && prev.grid.sig === sig) {
        return { sig, lines: prev.grid.lines, unchanged: true };
    }

    const endX = startX + vpW + gridSize * 2;
    const endY = startY + vpH + gridSize * 2;
    const sw = 1 / z;
    const lines: DrawItem[] = [];

    for (let x = startX; x < endX; x += gridSize) {
        lines.push(lineItem(x, startY, x, endY, x % (gridSize * 5) === 0 ? "#ffffff0a" : "#ffffff05", sw));
    }
    for (let y = startY; y < endY; y += gridSize) {
        lines.push(lineItem(startX, y, endX, y, y % (gridSize * 5) === 0 ? "#ffffff0a" : "#ffffff05", sw));
    }
    return { sig, lines, unchanged: false };
}

/**
 * `visible` is the world-space visible rect (see `buildRenderModel`); content whose
 * world bounds don't overlap it is culled, so a large document only pays for what is
 * on screen. This is why content depends on `viewport`/`size`, not just `z`: the
 * "one item per in-flow node" shape now holds only for the on-screen subset.
 */

/**
 * The OPACITY GROUPS enclosing a node, outermost first (schema 32).
 *
 * A node composites as a group when it has children AND `opacity < 1`: everything inside is
 * drawn, then the whole result is faded once. Multiplying the alpha into each child instead —
 * which is what this used to do — makes overlapping children show through one another, so a
 * translucent group of two overlapping shapes reads as three tones instead of one.
 *
 * A node with no children needs no group: fading it alone IS the same picture, and its own
 * `paint.opacity` says so. A node that IS a group draws its own shape INSIDE that group, so
 * its item's opacity is 1 and the group carries the value.
 *
 * `seen` guards a circular parent chain. The scene walk already drops those before they reach
 * here, so it is defence in depth against a future caller rather than a live path.
 */
function opacityGroupsFor(doc: ReadonlyDocument, id: string, memo: Map<string, string[]>): string[] {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;

    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | null | undefined = id;
    while (cur != null && !seen.has(cur)) {
        seen.add(cur);
        const node = doc.nodes.get(cur);
        if (!node) break;
        // THE NODE'S OWN LAYER IS NOT ITS OWN CLIP. A group's fill fades WITH the group — that is
        // what fading a subtree means, and the node is part of its subtree. A frame's fill and
        // stroke are NOT cut by its own clip: `clipsContent` says what happens to what is inside
        // it, and `hitTest` already agreed by only recording clipping ANCESTORS. Without this the
        // renderer clipped the frame's own ink while picking did not, which is the disagreement
        // this whole module is arranged to prevent.
        if (cur === id ? fadesAsGroup(node) : isOpacityGroup(node)) chain.push(cur);
        cur = node.parent ?? null;
    }
    chain.reverse();                                   // outermost first, the order a backend nests in
    memo.set(id, chain);
    return chain;
}

/**
 * A node whose subtree needs a layer — because it fades, because it clips, or both.
 *
 * CHILDREN ARE REQUIRED for either. A leaf has no subtree to composite and nothing to clip but
 * itself, and a node does not clip its OWN ink: `clipsContent` says what happens to what is
 * inside it, which is the same thing the name says and the same thing Figma and Sketch mean.
 */
function isOpacityGroup(node: { children: readonly string[]; style: { opacity: number }; clipsContent?: boolean }): boolean {
    if (node.children.length === 0) return false;
    if (node.clipsContent === true) return true;
    return fadesAsGroup(node);
}

/** The half of the test that applies to a node's OWN item: a fade takes it, a clip does not. */
function fadesAsGroup(node: { children: readonly string[]; style: { opacity: number } }): boolean {
    return node.children.length > 0 && typeof node.style.opacity === "number" && node.style.opacity < 1;
}



function buildContent(doc: ReadonlyDocument, computed: ComputedState, z: number, visible: Box,
                      original?: ReadonlyDocument): DrawItem[] {
    const items: DrawItem[] = [];
    // The enclosing opacity groups per node, memoized across the frame.
    const groupMemo = new Map<string, string[]>();
    // Design tokens (M5): every COLOR slot resolves "$token" references against the store
    // under the document's active theme — right here in the model, so both backends agree
    // and a theme switch repaints via the normal dispatch → refresh path. Presence checks
    // below stay on the RAW style values (a token string is truthy); only the emitted color
    // is resolved. A broken reference resolves to the visible fallback, never a throw.
    const store = doc.variables as VariableStore;
    const theme = doc.activeTheme;
    const color = (raw: string): string => resolveColor(store, raw, theme);
    // The FILL slot alone may hold a gradient (schema 56). One funnel, so every shape branch
    // resolves it the same way and none of them has to know the union exists.
    const fillOf = (raw: string | Gradient): string | PaintGradient =>
        typeof raw === "string" ? color(raw) : resolvePaintGradient(raw, color);
    // NUMBER slots (schema 20): radius/fontSize may be "$token" strings. The RESOLVED value is
    // range-checked here (the store only guarantees a finite number — a negative "spacing" is a
    // legal variable but an illegal radius): out-of-range/broken → the slot's fallback (radius:
    // none; fontSize: the 14 default) — visible-but-harmless, never a throw into the backend.
    const radiusOf = (raw: number | string | undefined): number | null => {
        if (raw === undefined) return null;
        const r = typeof raw === "number" ? raw : resolveNumber(store, raw, theme);
        return r !== null && r > 0 ? r : null; // 0/negative/broken → no corner radius (matches the old `sty.radius ? …` truthiness)
    };
    // The typography slots used to be two more closures here. They moved to `resolveTypography`
    // when the on-canvas text editor needed the same answers — see the note there on why five
    // defaults written twice is five chances for one of them to drift unseen.
    /**
     * A stroke's width in WORLD units (schema 25). Absent — or a broken/negative token — falls
     * back to `1 / z`, i.e. a 1-SCREEN-pixel hairline, which is exactly what every stroke was
     * before the field existed: an older document renders byte-identically. A settable width is
     * in world units on purpose, so a shape's own border thickens as you zoom in (unlike the
     * selection chrome, which is screen-fixed and keeps using the hairline directly).
     */
    const strokeWidthOf = (raw: number | string | undefined): number => {
        if (raw === undefined) return 1 / z;
        const r = typeof raw === "number" ? raw : resolveNumber(store, raw, theme);
        return r !== null && r >= 0 ? r : 1 / z;
    };

    // Paint in computed draw order (scene-graph order), using resolved world rects.
    computed.order.forEach((id: string) => {
        const node = doc.nodes.get(id);
        const c = computed.nodes.get(id);
        if (!node || !c) return;
        if (!isFiniteRect(c.bounds)) return;
        // Viewport culling. Each node is tested against its OWN world AABB (`c.bounds`),
        // and content is a flat, per-node list, so an off-screen parent never drops an
        // on-screen child. Inclusive-edge (see rectsIntersect) keeps straddling/touching
        // nodes; a node whose box is strictly outside by less than a stroke half-width
        // (~0.5 screen px) can have its stroke sliver clipped — an accepted sub-pixel
        // deferral a margin would close.
        if (!rectsIntersect(c.bounds, visible)) return;
        const sty = node.style;
        // The world matrix carries position/rotation/scale, so the shape itself is
        // emitted at the local origin and placed by the transform.
        const x = 0, y = 0, width = c.local.width, height = c.local.height;
        // Effects (schema 18), resolved once and shared by every content branch (a copy, so the
        // model stays independent plain data). The magenta unknown-type fallback keeps them null.
        // Gated on a POSITIVE-AREA box: SVG's objectBoundingBox filter region is `200% × 0 = 0` for a
        // zero-extent shape (an axis-aligned `core.line`, a flat path), which the spec renders as
        // NOTHING — so a zero-extent box drops its effect (in the model, so both backends agree)
        // rather than vanishing. A shadow on a hairline needs a positive box (or a diagonal line).
        const hasArea = width > 0 && height > 0;
        // The shadow color resolves here too, so `effectFilterId` (and the deduped defs) key on
        // the RESOLVED color — two different tokens resolving to one color share one filter.
        // A shape floating above the page throws its outline away from the light, and further
        // the higher it is (schema 42). DERIVED rather than typed in, which is the whole point:
        // move the light and every shadow moves together, and they cannot disagree with each
        // other the way hand-set ones always eventually do.
        //
        // An EXPLICIT `style.shadow` still wins. Somebody who set one meant it, and a scene light
        // silently overruling a per-shape decision would be the tool arguing with its user.
        const nodeDepth = depthOf(doc.nodes.get(id) ?? {});
        const keyLight = doc.lights?.[0];
        // No `nodeDepth !== 0` test: `shadowOffset` already returns exactly zero at depth 0, and
        // the zero check below already refuses that — a second guard for the same case was
        // provably equivalent to nothing, which a mutation of it demonstrated.
        const cast = (hasArea && !sty.shadow && keyLight)
            ? shadowOffset(keyLight, nodeDepth) : null;
        const shadow: Shadow | null = (hasArea && sty.shadow)
            ? { dx: sty.shadow.dx, dy: sty.shadow.dy, blur: sty.shadow.blur, color: color(sty.shadow.color) }
            : (cast && (cast.x !== 0 || cast.y !== 0))
                // The blur grows with the throw, because a shadow cast from further away is a
                // softer one — that is the whole visual difference between a card lying on the
                // page and one held above it.
                ? { dx: cast.x, dy: cast.y, blur: Math.hypot(cast.x, cast.y) / 2, color: "#00000059" }
                : null;
        const blur: number | null = (hasArea && sty.blur) ? sty.blur : null;
        // Only where there is ink to combine: a node with no area blends nothing with anything,
        // and carrying the mode anyway would make every backend open a blend it then closes.
        const blendMode: BlendMode | null = hasArea && sty.blendMode ? sty.blendMode : null;

        let shape: Shape;
        let paint: Paint;
        // Only when the fill is a ramp that MEASURES itself against the box. A plain colour, or a
        // `userSpaceOnUse` ramp already in local units, needs nothing.
        const localBox = typeof sty.fill !== "string" && sty.fill.units === "objectBoundingBox"
            ? { width, height } : undefined;

        if (node.type === "core.rectangle") {
            shape = { kind: "rect", x, y, width, height };
            paint = {
                fill: fillOf(sty.fill),
                opacity: isOpacityGroup(node) ? 1 : sty.opacity, shadow, blur, blendMode,
                stroke: sty.stroke ? color(sty.stroke) : null,
                strokeWidth: sty.stroke ? strokeWidthOf(sty.strokeWidth) : null,
                strokeJoin: sty.strokeJoin, strokeCap: sty.strokeCap, strokeMiterLimit: sty.strokeMiterLimit,
                fillRule: sty.fillRule,
                strokeDash: null,
                radius: radiusOf(sty.radius),
                cursor: "pointer",
                pointerEvents: true
            };
        } else if (node.type === "core.ellipse") {
            // Fills its local box: centre + radii from the box (no corner radius).
            shape = { kind: "ellipse", cx: width / 2, cy: height / 2, rx: width / 2, ry: height / 2 };
            paint = {
                fill: fillOf(sty.fill),
                opacity: isOpacityGroup(node) ? 1 : sty.opacity, shadow, blur, blendMode,
                stroke: sty.stroke ? color(sty.stroke) : null,
                strokeWidth: sty.stroke ? strokeWidthOf(sty.strokeWidth) : null,
                strokeJoin: sty.strokeJoin, strokeCap: sty.strokeCap, strokeMiterLimit: sty.strokeMiterLimit,
                fillRule: sty.fillRule,
                strokeDash: null,
                radius: null,
                cursor: "pointer",
                pointerEvents: true
            };
        } else if (node.type === "core.line") {
            // The box diagonal, top-left → bottom-right (a collapsed axis gives a
            // horizontal/vertical line). Drawn with a stroke; falls back to `fill` as
            // the line colour so a line authored with only a fill is still visible.
            shape = { kind: "line", x1: 0, y1: 0, x2: width, y2: height };
            paint = {
                fill: null,
                opacity: isOpacityGroup(node) ? 1 : sty.opacity, shadow, blur, blendMode,
                // `||` not `??`: an empty-string stroke also falls back to `fill`, so a line
                // is never invisible (a line's stroke IS its body, unlike a rect's border).
                // The fallback picks the RAW winner first, THEN resolves — so a token stroke
                // wins over a token fill exactly like concrete colors.
                stroke: color(sty.stroke || flatFill(sty.fill)),
                strokeWidth: strokeWidthOf(sty.strokeWidth),
                strokeJoin: sty.strokeJoin, strokeCap: sty.strokeCap, strokeMiterLimit: sty.strokeMiterLimit,
                fillRule: sty.fillRule,
                strokeDash: null,
                radius: null,
                cursor: "pointer",
                pointerEvents: true
            };
        } else if (node.type === "core.text") {
            shape = {
                kind: "text", x, y, width, height, text: node.text ?? "Text",
                // ONE statement of the defaults, shared with the on-canvas editor's text field.
                ...resolveTypography(sty, store, theme)
            };
            paint = {
                fill: fillOf(sty.fill), opacity: isOpacityGroup(node) ? 1 : sty.opacity, stroke: null, strokeWidth: null,
                strokeDash: null, radius: null, cursor: "pointer", pointerEvents: true, shadow, blur, blendMode
            };
        } else if (node.type === "core.image") {
            // BOTH CARRIED ALWAYS, `pixelated` as a plain boolean rather than an optional. A
            // backend reading an absent flag has to invent a default, and the Canvas one has to set
            // its filter for every image whether or not this is true — because the smoothing flag is
            // sticky context state that leaks to the next item otherwise. An always-present value is
            // what makes that impossible to forget.
            shape = {
                kind: "image", x, y, width, height, href: node.src ?? null,
                source: node.sourceRect ?? null, pixelated: node.pixelated === true,
                nineSlice: node.nineSlice ?? null,
                // An image node REFERENCES a picture; there is no payload to carry.
                surface: null
            };
            paint = {
                fill: null, opacity: isOpacityGroup(node) ? 1 : sty.opacity, stroke: null, strokeWidth: null,
                strokeDash: null, radius: null, cursor: "pointer", pointerEvents: true, shadow, blur, blendMode
            };
        } else if (node.type === "core.raster") {
            // A RASTER IS AN IMAGE THE MODEL NAMES RATHER THAN CARRIES. The surface is run-length
            // text; turning it into something a backend can draw needs a decode and, for SVG, an
            // encode — both impure. That is exactly what `href` already means here: the model
            // NAMES a picture and the renderer resolves it, the same seam `core.image` uses with
            // `ImageCache`. Emitting pixels instead would push impurity into the model, which is
            // the property the whole codec decision was made to protect.
            //
            // THE KEY CARRIES THE PAYLOAD'S IDENTITY, not just the node's. A cache keyed on the
            // node id alone would keep showing the pre-stroke picture after every paint, since the
            // id does not change when the pixels do — the surface's own text is what changed.
            shape = {
                kind: "image", x, y, width, height,
                href: node.surface ? rasterHref(node.id, node.surface) : null,
                source: null,
                surface: node.surface ?? null,
                nineSlice: node.nineSlice ?? null,
                // PIXEL ART IS NEAREST-NEIGHBOUR BY DEFAULT. A painted surface zoomed in is meant
                // to show its pixels; smoothing them is the one thing a pixel artist never wants,
                // and an image node defaults the other way because a photograph does.
                pixelated: node.pixelated !== false
            };
            paint = {
                fill: null, opacity: isOpacityGroup(node) ? 1 : sty.opacity, stroke: null, strokeWidth: null,
                strokeDash: null, radius: null, cursor: "pointer", pointerEvents: true, shadow, blur, blendMode
            };
        } else if (node.type === "core.path") {
            // Drawn ONLY from its commands (the first shape whose ink is independent of the
            // box); absent path → empty commands (draws nothing) but still one item, so the
            // node's box keeps its selection/handles/culling. Filled like a rect (no radius).
            shape = { kind: "path", commands: node.path ?? [] };
            paint = {
                fill: fillOf(sty.fill),
                opacity: isOpacityGroup(node) ? 1 : sty.opacity, shadow, blur, blendMode,
                stroke: sty.stroke ? color(sty.stroke) : null,
                strokeWidth: sty.stroke ? strokeWidthOf(sty.strokeWidth) : null,
                strokeJoin: sty.strokeJoin, strokeCap: sty.strokeCap, strokeMiterLimit: sty.strokeMiterLimit,
                fillRule: sty.fillRule,
                strokeDash: null,
                radius: null,
                cursor: "pointer",
                pointerEvents: true
            };
        } else if (node.type === "core.instance") {
            // A component instance (M6) draws NOTHING itself — it is a placement frame whose
            // materialized copies (virtual children, added by `expandInstances`) carry the ink,
            // exactly like a group. Emitting no item keeps it out of the display list entirely;
            // its box still selects and culls via geometry, and an empty/dangling instance is
            // simply invisible rather than a magenta unknown-type box.
            return;
        } else {
            // Unknown type: magenta debug rect (no opacity attr — matches the old renderer).
            shape = { kind: "rect", x, y, width, height };
            paint = {
                fill: "#ff006e33", opacity: null, stroke: "#ff006e", strokeWidth: 1 / z,
                strokeDash: null, radius: null, cursor: "pointer", pointerEvents: true, shadow: null, blur: null, blendMode: null
            };
        }

        // The enclosing groups travel WITH the item, so a backend that can composite nests it
        // and one that cannot folds the alphas in itself — neither has to re-walk the tree.
        const groups = opacityGroupsFor(doc, id, groupMemo);
        const depth = depthOf(doc.nodes.get(id) ?? {});
        // The node BEFORE resolution still has its mesh, and only a mesh with HEIGHT is a
        // surface — a purely in-plane warp faces the viewer everywhere, so shipping its normals
        // would cost a buffer per frame to say "flat" three times per triangle.
        const source = original?.nodes.get(id);
        const mesh = source?.mesh && !isFlatMesh(source.mesh) ? source.mesh : undefined;
        items.push({ shape, paint, world: c.world, nodeId: id, role: "content",
            ...(localBox ? { localBox } : {}),
            ...(depth !== 0 ? { depth } : {}),
            ...(mesh ? { surface: { mesh, box: { width: source!.geometry.width, height: source!.geometry.height } } } : {}),
            ...(groups.length ? { groups } : {}) });
    });

    // FAR FIRST, with the tree's own order breaking ties. Sorting HERE rather than in a backend is
    // what makes all three agree: only one of them has a depth buffer, and a document that drew
    // one way on the GPU and another on SVG would be a document with two meanings. `sort` is
    // stable in every engine this runs on, so a document that never mentions depth is untouched.
    return items.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
}

function outlineItem(
    geo: { x: number; y: number; width: number; height: number },
    pad: number,
    stroke: string,
    strokeWidth: number
): DrawItem {
    return {
        shape: { kind: "rect", x: geo.x - pad, y: geo.y - pad, width: geo.width + pad * 2, height: geo.height + pad * 2 },
        paint: {
            fill: "none", opacity: null, stroke, strokeWidth,
            strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null, blendMode: null
        },
        world: null,
        nodeId: null,
        role: "outline"
    };
}

/**
 * A node's own frame — the four corners of its ROTATED box, closed.
 *
 * Emitted as a `path` rather than a new primitive: a quad IS a closed path, both backends
 * already draw one, and the alternative (an axis-aligned `rect`) is precisely the thing that
 * made a turned node's frame bigger than the node. The points are already WORLD space, so the
 * item carries no matrix — same as every other overlay.
 */
function frameItem(quad: Quad, stroke: string, strokeWidth: number): DrawItem {
    const [nw, ne, se, sw] = quad;
    return {
        shape: {
            kind: "path",
            commands: [
                { c: "M", x: nw.x, y: nw.y },
                { c: "L", x: ne.x, y: ne.y },
                { c: "L", x: se.x, y: se.y },
                { c: "L", x: sw.x, y: sw.y },
                { c: "Z" }
            ]
        },
        paint: {
            fill: "none", opacity: null, stroke, strokeWidth,
            strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null, blendMode: null
        },
        world: null,
        nodeId: null,
        role: "outline"
    };
}

/** A resize/rotate handle as a draw item — a white square (corner) or circle (rotate knob). */
function handleItem(h: SelectionHandle, z: number): DrawItem {
    const HS = HANDLE_SIZE_PX / z;
    const shape: Shape = h.handle === "rotate"
        ? { kind: "ellipse", cx: h.cx, cy: h.cy, rx: HS / 2, ry: HS / 2 }
        : { kind: "rect", x: h.cx - HS / 2, y: h.cy - HS / 2, width: HS, height: HS };
    return {
        shape,
        paint: {
            fill: "#ffffff", opacity: null, stroke: "#00bfff", strokeWidth: 1 / z,
            strokeDash: null, radius: null, cursor: h.cursor, pointerEvents: true, shadow: null, blur: null, blendMode: null
        },
        world: null,
        nodeId: h.nodeId,
        handle: h.handle,
        role: "handle"
    };
}

/**
 * @param posed the RESOLVED scene, for handles a rig has moved (schema 58). Passed rather than
 * added to `RendererState`: the state is a frozen contract and this is a derived value the caller
 * already holds — the same reasoning that keeps `expandInstances` out of `ComputedState`.
 */
function buildOverlay(state: RendererState, z: number, doc: ReadonlyDocument, posed: ReadonlyDocument): DrawItem[] {
    const items: DrawItem[] = [];
    const computed = state.computed;
    const selectedSet = new Set(state.selectedNodeIds);

    // Selection + hover outlines, in the same computed draw order as the content.
    computed.order.forEach((id: string) => {
        const c = computed.nodes.get(id);
        if (!c || !isFiniteRect(c.bounds)) return;
        // The node's OWN box, turned with it — not the world AABB. Padding is applied in the
        // node's local units inside `selectionFrame`, so the gap is even on all four sides
        // however the node is rotated or scaled.
        const selected = selectedSet.has(id);
        if (!selected && state.hoveredNodeId !== id) return;
        const quad = selectionFrame(computed, id, (selected ? 3 : 2) / z);
        if (!quad) return;
        items.push(selected
            ? frameItem(quad, "#00bfff", 1.5 / z)
            : frameItem(quad, "#ffffff44", 1 / z));
    });

    // Handles (world-space). Positions come from the SHARED `selectionHandles`/`groupRotateHandle`/
    // `groupCornerHandles` (the same sources the editor hit-tests), so drawing and picking cannot drift.
    //  - a SINGLE selected root → per-node resize corners + a rotate knob (drawn as a circle);
    //  - a MULTI-root selection → ONE group bounding box, plus GROUP corner handles when the
    //    group is resizable (every root transform-free) and one group rotate knob when it is
    //    rotatable — each affordance gated on its own eligibility, never per-node handles.
    // Resolved on the EXPANDED tree so a selected instance COPY keeps its handles (a virtual id
    // is absent from the stored map, and `selectionRoots` drops what it cannot resolve).
    const roots = selectionRoots(resolveScene(doc), state.selectedNodeIds);
    if (roots.length >= 2) {
        const gb = selectionBounds(computed, roots);
        if (gb && isFiniteRect(gb)) {
            items.push(outlineItem(gb, 0, "#00bfff", 1.5 / z)); // the group's bounding box (the true union)
            // Corner handles only for a RESIZABLE group (every root transform-free — a rotated
            // member scaled non-uniformly would shear); drawn before the knob so the knob wins
            // an overlap, matching groupHandleAtPoint's scan order.
            if (isGroupResizable(doc, roots)) {
                groupCornerHandles(computed, roots, z).forEach(h => items.push(handleItem(h, z)));
            }
            if (isGroupRotatable(doc, roots)) {
                const knob = groupRotateHandle(computed, roots, z);
                if (knob) items.push(handleItem(knob, z));
            }
        }
    } else {
        // 0 or 1 root: per-node handles exactly as before (roots, so a parent+child selection
        // shows the parent's handles once, not one set per selected id). An instance COPY gets
        // the four RESIZE corners (they commit a per-instance override) but NOT the rotate knob —
        // transform overrides are a later slice, and the editor refuses that grab identically,
        // so draw and pick stay in step.
        // A copy shows RESIZE corners only when the edit can actually be recorded — the shared
        // `isHandleOffered` rule, which the picker and the hover cursor read too, so what is
        // drawn, what a press grabs, and what the pointer promises cannot drift apart.
        selectionHandles(computed, roots, z)
            .filter(h => isHandleOffered(doc, h.nodeId, h.handle))
            .forEach(h => items.push(handleItem(h, z)));
        // A selected `core.path` also shows a handle per on-curve POINT. Same gate, because
        // a vertex drag records the same kind of edit and an instance copy can back it too.
        [...pathVertexHandles(doc, computed, roots), ...meshHandles(doc, computed, roots, posed)]
            .filter(h => isHandleOffered(doc, h.nodeId, h.handle))
            .forEach(h => items.push(handleItem(h, z)));
        // A selected node with a GRADIENT fill shows where the ramp runs (schema 56). The AXIS is
        // drawn first and underneath, because it is the thing being placed and the handles are how
        // you place it — and without a line between them two dots say nothing about direction.
        const ramp = gradientHandles(doc, computed, roots)
            .filter(h => isHandleOffered(doc, h.nodeId, h.handle));
        for (const nodeId of new Set(ramp.map(h => h.nodeId))) {
            const own = ramp.filter(h => h.nodeId === nodeId);
            const from = own.find(h => h.handle === "grad:start") ?? own.find(h => h.handle === "grad:center");
            const to = own.find(h => h.handle === "grad:end") ?? own.find(h => h.handle === "grad:radius");
            if (!from || !to) continue;
            items.push({
                shape: { kind: "line", x1: from.cx, y1: from.cy, x2: to.cx, y2: to.cy },
                paint: {
                    fill: null, opacity: null, stroke: "#ffffff", strokeWidth: 1 / z,
                    strokeDash: `${3 / z} ${3 / z}`, radius: null, cursor: null,
                    pointerEvents: false, shadow: null, blur: null, blendMode: null
                },
                world: null, nodeId: null, role: "outline"
            });
        }
        ramp.forEach(h => items.push(handleItem(h, z)));
    }

    // Rectangle-tool drag preview.
    const preview = state.previewRect;
    if (preview && isFiniteRect(preview) && preview.width > 0 && preview.height > 0) {
        items.push({
            shape: { kind: "rect", x: preview.x, y: preview.y, width: preview.width, height: preview.height },
            paint: {
                fill: "#4a90d933", opacity: null, stroke: "#4a90d9", strokeWidth: 1 / z,
                strokeDash: `${4 / z} ${4 / z}`, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null, blendMode: null
            },
            world: null,
            nodeId: null,
            role: "preview"
        });
    }

    // Alignment (smart) guides — thin world-space lines where the dragged node aligns with
    // another. Emitted AFTER the handles (drawn on top) so a handle never hides a guide, and
    // only for finite coordinates (never emit a NaN line — matches the marquee/preview guards).
    (state.snapGuides ?? []).forEach(g => {
        if (!Number.isFinite(g.pos) || !Number.isFinite(g.start) || !Number.isFinite(g.end)) return;
        const shape: Shape = g.axis === "x"
            ? { kind: "line", x1: g.pos, y1: g.start, x2: g.pos, y2: g.end }
            : { kind: "line", x1: g.start, y1: g.pos, x2: g.end, y2: g.pos };
        items.push({
            shape,
            paint: {
                fill: null, opacity: null, stroke: "#ff2d9b", strokeWidth: 1 / z,
                strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null, blendMode: null
            },
            world: null,
            nodeId: null,
            role: "guide"
        });
    });

    // Box-select marquee (world-space; drawn once the drag has positive extent). Dropping
    // zero-area rects matches the preview emitter and keeps a degenerate box (e.g. a strict
    // horizontal drag → height 0, which canvas would stroke as a line) out of the dumb backend.
    const marquee = state.marqueeRect;
    if (marquee && isFiniteRect(marquee) && marquee.width > 0 && marquee.height > 0) {
        items.push({
            shape: { kind: "rect", x: marquee.x, y: marquee.y, width: marquee.width, height: marquee.height },
            paint: {
                fill: "#00bfff22", opacity: null, stroke: "#00bfff", strokeWidth: 1 / z,
                strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null, blendMode: null
            },
            world: null,
            nodeId: null,
            role: "marquee"
        });
    }

    // The PEN stroke in progress (schema 17's `core.path`, finally drawable). An overlay,
    // because it is not in the document yet — committing it is what puts it there. Drawn
    // with no fill so the shape reads as a line being built rather than a solid.
    if (state.pendingPath && state.pendingPath.length > 1) {
        items.push({
            shape: { kind: "path", commands: state.pendingPath },
            paint: {
                fill: "none", opacity: null, stroke: "#00bfff", strokeWidth: 1 / z,
                strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null, blendMode: null
            },
            world: null,
            nodeId: null,
            role: "preview"
        });
    }

    return items;
}


/** The opacity groups the visible content refers to, deduped, outermost-first per item. */
/**
 * The scene's shapes darkening one another — the gap the lighting notes have named since it
 * existed, closed as GEOMETRY rather than as a shadow map. See `geometry/CastShadow`.
 *
 * Inserted here rather than inside `buildContent` because a cast shadow is not a node's drawing:
 * it belongs to a PAIR, it has no id, and it must land between two items in paint order. Each
 * patch is spliced in directly AFTER its receiver, which is the only position that is right —
 * before it, the receiver would paint over its own shadow; after the caster, the shadow would
 * darken the shape that threw it.
 *
 * Returns the list BY REFERENCE when nothing is raised, which is every document that has never
 * touched depth. This runs per frame, so the common case has to cost one pass and no allocation.
 */
function withCastShadows(content: DrawItem[], computed: ComputedState, light: Light | undefined): DrawItem[] {
    if (!light) return content;
    const shapes: ShadowShape[] = [];
    for (const item of content) {
        // Only real, pickable nodes take part. A GHOST has `nodeId: null` — it is a picture of
        // another moment, and a shadow cast by one would be a shadow from a frame nobody is on.
        if (item.nodeId === null || item.paint.fill === null) continue;
        const world = worldCommandsOf(computed, item.nodeId);
        if (!world) continue;
        shapes.push({ id: item.nodeId, rings: commandsToRings(world), depth: item.depth ?? 0 });
    }
    const patches = castShadows(shapes, (c, r) => shadowOffset(light, c, r));
    if (patches.length === 0) return content;

    // MERGED per receiver, not stacked. Two raised shapes over one card each throw a patch onto
    // it, and where those patches overlap a second translucent fill lands on the first — so the
    // overlap comes out DARKER than either shadow. That contradicts the model `CastShadow` argues
    // for in its own comment: a directional light is infinitely far away, every ray is parallel,
    // and occlusion is total or nothing. There is no "twice occluded".
    //
    // The union is `resolveRings` under NONZERO, which is the same primitive the booleans use —
    // the patches are already simple rings, so their union is exactly what it computes. EVEN-ODD
    // would be the opposite mistake: it punches the overlap out as a hole, so the doubly-shadowed
    // band comes out LIGHTER than the rest instead of darker.
    //
    // The single-patch skip is a COST short-circuit, not a correctness guard, and a mutation of it
    // changed no output: one already-simple ring resolves to itself. It stays because resolving is
    // O(n²) in edges and this runs per frame, and one caster is the common case.
    const byReceiver = new Map<string, Ring[]>();
    for (const p of patches) {
        const list = byReceiver.get(p.receiverId);
        if (list) list.push(...p.rings); else byReceiver.set(p.receiverId, [...p.rings]);
    }
    const merged = new Map<string, Ring[]>();
    for (const [id, rings] of byReceiver) {
        merged.set(id, patches.filter(p => p.receiverId === id).length > 1 ? resolveRings(rings, "nonzero") : rings);
    }
    const out: DrawItem[] = [];
    for (const item of content) {
        out.push(item);
        const rings = item.nodeId !== null ? merged.get(item.nodeId) : undefined;
        if (rings && rings.length > 0) {
            out.push({
                shape: { kind: "path", commands: ringsToCommands(rings) },
                // WORLD-space rings with no transform: the patch is the intersection of two shapes
                // that live in different local spaces, so there is no local space for it to be in.
                world: null,
                // No `nodeId`, and unpickable. A shadow is not a thing you can select — clicking
                // one has to fall through to whatever is underneath, which is the receiver.
                nodeId: null,
                role: "shadow",
                ...(item.depth !== undefined ? { depth: item.depth } : {}),
                ...(item.groups ? { groups: item.groups } : {}),
                paint: {
                    fill: SHADOW_ALPHA, opacity: null, stroke: null, strokeWidth: null,
                    strokeDash: null, radius: null, cursor: null, pointerEvents: false,
                    shadow: null, blur: null, blendMode: null
                }
            });
        }
    }
    return out;
}

/**
 * A clipping frame's corner radius, resolved the way the HIT SHAPE resolves it.
 *
 * `shapeOf` in the geometry engine looks a `$token` up and range-checks the result, so a clip that
 * only accepted a literal number would round the corners for picking and square them for drawing —
 * the disagreement this codebase keeps finding, in a new place. One rule, stated twice, is one
 * rule too many; this asks the same question of the same store.
 */
function clipRadius(doc: ReadonlyDocument, node: { style: { radius?: number | string } }): number {
    const raw = node.style.radius;
    if (raw === undefined) return 0;
    const r = typeof raw === "number" ? raw : resolveNumber(doc.variables, raw, doc.activeTheme);
    return r !== null && r > 0 ? r : 0;
}

function collectGroups(doc: ReadonlyDocument, computed: ComputedState, content: DrawItem[]): OpacityGroup[] {
    const out: OpacityGroup[] = [];
    const seen = new Set<string>();
    for (const item of content) {
        for (const id of item.groups ?? []) {
            if (seen.has(id)) continue;
            seen.add(id);
            const node = doc.nodes.get(id);
            const opacity = node?.style.opacity;
            // THE COMPUTED WORLD MATRIX, not one rebuilt from stored geometry: under auto-layout
            // the two differ, and a clip placed by the stored box would cut in the wrong place on
            // exactly the containers people clip most.
            const c = computed.nodes.get(id);
            const clip: ClipRegion | undefined = node?.clipsContent && c
                ? { width: c.local.width, height: c.local.height, radius: clipRadius(doc, node), world: c.world }
                : undefined;
            out.push({
                id,
                opacity: typeof opacity === "number" ? opacity : 1,
                ...(clip ? { clip } : {})
            });
        }
    }
    return out;
}

/** Dedupe (by id) the filter defs referenced by the visible content, in content order. */
function collectDefs(content: DrawItem[]): FilterDef[] {
    const defs: FilterDef[] = [];
    const seen = new Set<string>();
    for (const item of content) {
        const id = effectFilterId(item.paint.shadow, item.paint.blur);
        if (id === null || seen.has(id)) continue;
        seen.add(id);
        defs.push({ id, shadow: item.paint.shadow, blur: item.paint.blur });
    }
    return defs;
}

/**
 * The layers a backend must close and open between two consecutive items (schema 32).
 *
 * An opacity group composites as ONE and is then faded, which every backend has to express as a
 * layer: SVG nests a `<g opacity>`, Canvas needs an offscreen canvas, the GPU a render target. What
 * they share is the SEQUENCING — which layers just ended, and which just began — and it is exactly
 * the part that is easy to get subtly wrong and identical in all three. One statement of it here.
 *
 * A RUN, not a lookup by id. Creating a layer the first time a group is named and reusing it later
 * would pull a group's items back together in draw order, which changes what is in front of what:
 * `content` is sorted by depth before the tree's own order, so a group's items are contiguous in
 * the common case and genuinely are not when its children sit at different depths. Closing and
 * reopening keeps the z-order the model published, at the cost of compositing such a group in two
 * pieces — which is the lesser wrong, because the alternative silently reorders the picture.
 *
 * `prev`/`next` are the enclosing groups outermost-first, which is how `DrawItem.groups` is built.
 */
export function layerTransition(
    prev: readonly string[], next: readonly string[]
): { close: number; open: string[] } {
    let same = 0;
    while (same < prev.length && same < next.length && prev[same] === next[same]) same++;
    return { close: prev.length - same, open: next.slice(same) };
}

/** Dedupe (by id) the gradient defs referenced by the visible content, in content order. */
function collectGradients(content: DrawItem[]): PaintGradient[] {
    const out: PaintGradient[] = [];
    const seen = new Set<string>();
    for (const item of content) {
        const fill = item.paint.fill;
        if (fill === null || typeof fill === "string" || seen.has(fill.id)) continue;
        seen.add(fill.id);
        out.push(fill);
    }
    return out;
}

/**
 * Pure function of `(size, doc, state, prev)` — no DOM, no `Date`/`Math.random`.
 * `prev` (the last frame's list for this container) lets an unchanged grid reuse
 * its lines by reference; pass `null`/`undefined` to always rebuild.
 */
export function buildRenderModel(
    size: Size,
    doc: ReadonlyDocument,
    state: RendererState,
    prev?: DisplayList | null
): DisplayList {
    const z = Math.max(0.01, state.viewport.zoom);
    // The world-space region emitSVG's `translate(-x,-y) scale(z)` maps onto screen
    // [0,W]x[0,H] — the SAME definition (and ||800/||600 fallback) the grid uses, so the
    // cull rect and the actual transform cannot disagree. Culls content only; overlay and
    // grid bound their own visible range.
    const vp = state.viewport;
    const visible: Box = {
        x: vp.x / z,
        y: vp.y / z,
        width: (size.width || 800) / z,
        height: (size.height || 600) / z
    };
    // COMPONENT INSTANCES (M6): `state.computed` was produced from the EXPANDED document, so
    // it contains virtual (materialized) node ids. The model must look those ids up in the
    // same expanded view or every instance's content would silently vanish — the lookup here
    // is what turns a computed entry into a draw item. `expandInstances` is pure and returns
    // the same reference when there is nothing to expand, so an instance-free document pays
    // nothing; running it twice (engine + model) is deliberate — the alternative, threading a
    // document through `ComputedState`, would widen a frozen contract for a derived value.
    const effective = resolveScene(doc);
    // ONION SKINS first, so they sit BEHIND the frame being worked on — a ghost drawn over the
    // real thing would be a smear rather than a reference. Each is built by the same
    // `buildContent` as the live frame and then made faint and unpickable: a ghost is a picture of
    // another moment, and clicking one would select a node where it ISN'T.
    const ghosts: DrawItem[] = [];
    for (const ghost of state.ghosts ?? []) {
        const items = buildContent(resolveScene(ghost.doc), ghost.computed, z, visible);
        for (const item of items) {
            ghosts.push({
                ...item,
                nodeId: null,
                paint: { ...item.paint, opacity: (item.paint.opacity ?? 1) * ghost.opacity, pointerEvents: false, cursor: null }
            });
        }
    }
    const content = withCastShadows(
        [...ghosts, ...buildContent(effective, state.computed, z, visible, doc)],
        state.computed, doc.lights?.[0]);
    return {
        viewport: state.viewport,
        grid: buildGrid(size, state.viewport, z, prev),
        content,
        ...(doc.lights !== undefined ? { lights: doc.lights } : {}),
        ...(doc.ambient !== undefined ? { ambient: doc.ambient } : {}),
        overlay: buildOverlay(state, z, doc, effective),
        defs: collectDefs(content),
        gradients: collectGradients(content),
        // THE EXPANDED document and its computed geometry: a clip's placement comes from the walk
        // that laid the frame out, not from stored numbers an auto-layout container overrides.
        groups: collectGroups(effective, state.computed, content)
    };
}
