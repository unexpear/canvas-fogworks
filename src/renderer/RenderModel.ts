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

import { ReadonlyDocument } from "../core/document/Document";
import { PathCommand, Shadow, StrokeCap, StrokeJoin, TextAlign } from "../core/document/Node";
import { resolveColor, resolveNumber, VariableStore } from "../core/document/Variables";
import { selectionRoots } from "../core/document/SceneGraph";
import { resolveScene } from "../core/document/Components";
import { ComputedState, selectionBounds } from "../core/geometry/GeometryEngine";
import { Mat2D } from "../core/geometry/Matrix";
import { selectionHandles, selectionFrame, pathVertexHandles, groupRotateHandle, groupCornerHandles, SelectionHandle, HANDLE_SIZE_PX } from "../core/geometry/SelectionHandles";
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
    | { kind: "image"; x: number; y: number; width: number; height: number; href: string | null };

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
export interface Paint {
    fill: string | null;
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
    strokeDash: string | null;
    radius: number | null;
    cursor: string | null;
    /** `false` → the backend sets `pointer-events: none` (grid/outline/preview). */
    pointerEvents: boolean;
    /** Drop shadow (world units), or null. Both backends read it; SVG also builds a `<filter>` def. */
    shadow: Shadow | null;
    /** Whole-node gaussian blur radius (world units), or null. */
    blur: number | null;
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
export function effectFilterId(shadow: Shadow | null, blur: number | null): string | null {
    const hasBlur = blur !== null && blur > 0;
    if (!shadow && !hasBlur) return null;
    let id = "fx";
    if (shadow) id += `_s${tok(shadow.dx)}_${tok(shadow.dy)}_${tok(shadow.blur)}_${hexColor(shadow.color)}`;
    if (hasBlur) id += `_b${tok(blur as number)}`;
    return id;
}

export type DrawRole = "grid-line" | "content" | "outline" | "handle" | "preview" | "marquee" | "guide";

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
    role: DrawRole;
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
    /** Deduped filter defs referenced by content items — emitSVG builds `<defs>` from these. */
    defs: FilterDef[];
    /** The opacity groups `content` items refer to, outermost first. */
    groups: OpacityGroup[];
}

/** A node whose subtree composites as one before being faded. */
export interface OpacityGroup {
    id: string;
    opacity: number;
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
            strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null
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
        if (isOpacityGroup(node)) chain.push(cur);
        cur = node.parent ?? null;
    }
    chain.reverse();                                   // outermost first, the order a backend nests in
    memo.set(id, chain);
    return chain;
}

/** A node whose subtree must composite before being faded. */
function isOpacityGroup(node: { children: readonly string[]; style: { opacity: number } }): boolean {
    return node.children.length > 0 && typeof node.style.opacity === "number" && node.style.opacity < 1;
}



function buildContent(doc: ReadonlyDocument, computed: ComputedState, z: number, visible: Box): DrawItem[] {
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
    // NUMBER slots (schema 20): radius/fontSize may be "$token" strings. The RESOLVED value is
    // range-checked here (the store only guarantees a finite number — a negative "spacing" is a
    // legal variable but an illegal radius): out-of-range/broken → the slot's fallback (radius:
    // none; fontSize: the 14 default) — visible-but-harmless, never a throw into the backend.
    const radiusOf = (raw: number | string | undefined): number | null => {
        if (raw === undefined) return null;
        const r = typeof raw === "number" ? raw : resolveNumber(store, raw, theme);
        return r !== null && r > 0 ? r : null; // 0/negative/broken → no corner radius (matches the old `sty.radius ? …` truthiness)
    };
    /**
     * A resolved NUMBER slot with a range and a fallback (schema 34 typography).
     *
     * The same rule `radiusOf`/`fontSizeOf` follow, generalised because there are now five of
     * them: resolve a token, range-check the RESULT (the store only promises a finite number —
     * a legal `spacing` variable is an illegal font weight), and fall back visibly-but-harmlessly
     * rather than letting a broken token reach a backend.
     */
    const numberSlot = (raw: number | string | undefined, fallback: number, min: number, max: number): number => {
        if (raw === undefined) return fallback;
        const n = typeof raw === "number" ? raw : resolveNumber(store, raw, theme);
        return n !== null && n >= min && n <= max ? n : fallback;
    };
    const fontSizeOf = (raw: number | string | undefined): number => {
        if (raw === undefined) return 14;
        const r = typeof raw === "number" ? raw : resolveNumber(store, raw, theme);
        return r !== null && r > 0 ? r : 14;   // broken/non-positive token → the documented default
    };
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
        const shadow: Shadow | null = (hasArea && sty.shadow)
            ? { dx: sty.shadow.dx, dy: sty.shadow.dy, blur: sty.shadow.blur, color: color(sty.shadow.color) }
            : null;
        const blur: number | null = (hasArea && sty.blur) ? sty.blur : null;

        let shape: Shape;
        let paint: Paint;

        if (node.type === "core.rectangle") {
            shape = { kind: "rect", x, y, width, height };
            paint = {
                fill: color(sty.fill),
                opacity: isOpacityGroup(node) ? 1 : sty.opacity, shadow, blur,
                stroke: sty.stroke ? color(sty.stroke) : null,
                strokeWidth: sty.stroke ? strokeWidthOf(sty.strokeWidth) : null,
                strokeJoin: sty.strokeJoin, strokeCap: sty.strokeCap, strokeMiterLimit: sty.strokeMiterLimit,
                strokeDash: null,
                radius: radiusOf(sty.radius),
                cursor: "pointer",
                pointerEvents: true
            };
        } else if (node.type === "core.ellipse") {
            // Fills its local box: centre + radii from the box (no corner radius).
            shape = { kind: "ellipse", cx: width / 2, cy: height / 2, rx: width / 2, ry: height / 2 };
            paint = {
                fill: color(sty.fill),
                opacity: isOpacityGroup(node) ? 1 : sty.opacity, shadow, blur,
                stroke: sty.stroke ? color(sty.stroke) : null,
                strokeWidth: sty.stroke ? strokeWidthOf(sty.strokeWidth) : null,
                strokeJoin: sty.strokeJoin, strokeCap: sty.strokeCap, strokeMiterLimit: sty.strokeMiterLimit,
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
                opacity: isOpacityGroup(node) ? 1 : sty.opacity, shadow, blur,
                // `||` not `??`: an empty-string stroke also falls back to `fill`, so a line
                // is never invisible (a line's stroke IS its body, unlike a rect's border).
                // The fallback picks the RAW winner first, THEN resolves — so a token stroke
                // wins over a token fill exactly like concrete colors.
                stroke: color(sty.stroke || sty.fill),
                strokeWidth: strokeWidthOf(sty.strokeWidth),
                strokeJoin: sty.strokeJoin, strokeCap: sty.strokeCap, strokeMiterLimit: sty.strokeMiterLimit,
                strokeDash: null,
                radius: null,
                cursor: "pointer",
                pointerEvents: true
            };
        } else if (node.type === "core.text") {
            shape = {
                kind: "text", x, y, width, height, text: node.text ?? "Text",
                fontSize: fontSizeOf(sty.fontSize),
                fontFamily: sty.fontFamily && sty.fontFamily.trim() !== "" ? sty.fontFamily : "sans-serif",
                fontWeight: numberSlot(sty.fontWeight, 400, 1, 1000),
                textAlign: sty.textAlign ?? "left",
                // `normal` in a browser is ~1.2, which is what the Canvas backend already used to
                // break lines — so an absent line height keeps the two backends where they were.
                lineHeight: numberSlot(sty.lineHeight, 1.2, 0.01, 100),
                letterSpacing: numberSlot(sty.letterSpacing, 0, -1e6, 1e6)
            };
            paint = {
                fill: color(sty.fill), opacity: isOpacityGroup(node) ? 1 : sty.opacity, stroke: null, strokeWidth: null,
                strokeDash: null, radius: null, cursor: "pointer", pointerEvents: true, shadow, blur
            };
        } else if (node.type === "core.image") {
            shape = { kind: "image", x, y, width, height, href: node.src ?? null };
            paint = {
                fill: null, opacity: isOpacityGroup(node) ? 1 : sty.opacity, stroke: null, strokeWidth: null,
                strokeDash: null, radius: null, cursor: "pointer", pointerEvents: true, shadow, blur
            };
        } else if (node.type === "core.path") {
            // Drawn ONLY from its commands (the first shape whose ink is independent of the
            // box); absent path → empty commands (draws nothing) but still one item, so the
            // node's box keeps its selection/handles/culling. Filled like a rect (no radius).
            shape = { kind: "path", commands: node.path ?? [] };
            paint = {
                fill: color(sty.fill),
                opacity: isOpacityGroup(node) ? 1 : sty.opacity, shadow, blur,
                stroke: sty.stroke ? color(sty.stroke) : null,
                strokeWidth: sty.stroke ? strokeWidthOf(sty.strokeWidth) : null,
                strokeJoin: sty.strokeJoin, strokeCap: sty.strokeCap, strokeMiterLimit: sty.strokeMiterLimit,
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
                strokeDash: null, radius: null, cursor: "pointer", pointerEvents: true, shadow: null, blur: null
            };
        }

        // The enclosing groups travel WITH the item, so a backend that can composite nests it
        // and one that cannot folds the alphas in itself — neither has to re-walk the tree.
        const groups = opacityGroupsFor(doc, id, groupMemo);
        items.push({ shape, paint, world: c.world, nodeId: id, role: "content", ...(groups.length ? { groups } : {}) });
    });

    return items;
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
            strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null
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
            strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null
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
            strokeDash: null, radius: null, cursor: h.cursor, pointerEvents: true, shadow: null, blur: null
        },
        world: null,
        nodeId: h.nodeId,
        handle: h.handle,
        role: "handle"
    };
}

function buildOverlay(state: RendererState, z: number, doc: ReadonlyDocument): DrawItem[] {
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
        pathVertexHandles(doc, computed, roots)
            .filter(h => isHandleOffered(doc, h.nodeId, h.handle))
            .forEach(h => items.push(handleItem(h, z)));
    }

    // Rectangle-tool drag preview.
    const preview = state.previewRect;
    if (preview && isFiniteRect(preview) && preview.width > 0 && preview.height > 0) {
        items.push({
            shape: { kind: "rect", x: preview.x, y: preview.y, width: preview.width, height: preview.height },
            paint: {
                fill: "#4a90d933", opacity: null, stroke: "#4a90d9", strokeWidth: 1 / z,
                strokeDash: `${4 / z} ${4 / z}`, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null
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
                strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null
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
                strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null
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
                strokeDash: null, radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null
            },
            world: null,
            nodeId: null,
            role: "preview"
        });
    }

    return items;
}


/** The opacity groups the visible content refers to, deduped, outermost-first per item. */
function collectGroups(doc: ReadonlyDocument, content: DrawItem[]): OpacityGroup[] {
    const out: OpacityGroup[] = [];
    const seen = new Set<string>();
    for (const item of content) {
        for (const id of item.groups ?? []) {
            if (seen.has(id)) continue;
            seen.add(id);
            const opacity = doc.nodes.get(id)?.style.opacity;
            out.push({ id, opacity: typeof opacity === "number" ? opacity : 1 });
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
    const content = buildContent(effective, state.computed, z, visible);
    return {
        viewport: state.viewport,
        grid: buildGrid(size, state.viewport, z, prev),
        content,
        overlay: buildOverlay(state, z, doc),
        defs: collectDefs(content),
        groups: collectGroups(doc, content)
    };
}
