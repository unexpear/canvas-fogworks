/**
 * @module Node
 * @description Defines the canonical structure and type system for every object stored in the document.
 * Nodes are never mutated directly; changes happen via Actions.
 */

import { isTokenRef } from "./Variables";
import { Gradient, gradientError } from "./Gradient";
import { NineSliceInsets } from "../geometry/NineSlice";
import { Interaction } from "./Prototype";
import { IkConstraint } from "./Rig";
import { Tilemap, tilemapError } from "./Tilemap";

/** A `"$token"` reference in a NUMBER slot (radius/fontSize, schema 20). Same syntax as color
 *  tokens; the resolved value's range is checked at render time (broken → visible fallback). */
function isNumberToken(v: unknown): boolean {
    return isTokenRef(v);
}

/**
 * The closed set of node types. Single source of truth: `NodeType` is derived from
 * it, and both validation paths check membership against it — so adding a type is
 * one edit, and an unknown type cannot slip in through a hand-edited file.
 */
export const NODE_TYPES = ["core.rectangle", "core.text", "core.image", "core.ellipse", "core.line", "core.path", "core.instance", "core.boolean", "core.raster", "core.tilemap"] as const;
export type NodeType = typeof NODE_TYPES[number];

/**
 * A node id no document may use: the action layer's delta map is keyed by node id, and
 * DOCUMENT-level deltas (the M5 `"variables"` kind) travel under this sentinel — a real node
 * with the same id would collide with them in a transaction's merged result (the doc delta
 * would overwrite the node's edits). Rejected on BOTH paths (`AddNodeAction` + `Integrity`),
 * like the reserved variable keys.
 */
export const RESERVED_NODE_ID = "__document__";

/**
 * A substring no STORED node id may contain: instance expansion (M6) builds VIRTUAL node ids
 * as `<instance path>::<master node id>`, so a stored id containing `::` could collide with a
 * materialized copy — and `splitVirtualId` would mis-attribute it to an instance. Rejected on
 * BOTH paths (`AddNodeAction` + `Integrity`), like `RESERVED_NODE_ID`. Kept here (not in
 * Components.ts) so the document layer owns every id rule in one place; Components re-exports
 * the separator it forms ids with.
 */
export const RESERVED_ID_SUBSTRING = "::";

/** Validity of a stored node id: not the document-delta sentinel, and free of the virtual-id
 *  separator. Shared by the edit path (`AddNodeAction`) and the load path (`Integrity`). */
export function nodeIdError(id: string): string | null {
    if (id === RESERVED_NODE_ID) return `node id "${RESERVED_NODE_ID}" is reserved`;
    if (id.includes(RESERVED_ID_SUBSTRING)) return `node id "${id}" must not contain "${RESERVED_ID_SUBSTRING}" (reserved for component instances)`;
    return null;
}

export function isNodeType(value: unknown): value is NodeType {
    return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

/**
 * Validity check for a node's dimensions, keyed on type and SHARED by the edit path
 * (`AddNode`/`Resize`/`UpdateNodeGeometry`) and the load path (`Integrity`) so the two
 * cannot drift — the same round-trip discipline `layoutError`/`transformError` use.
 *
 * Most shapes need a positive box. A `core.line` is the box DIAGONAL, so it may collapse
 * ONE axis (a horizontal line has height 0, a vertical line width 0) — but not both (a
 * zero-length line is a degenerate point). Returns an error string, or null.
 */
export function dimensionError(type: NodeType, width: number, height: number): string | null {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return "must have finite dimensions";
    // A `core.line` (box diagonal) and a `core.path` (drawn from its commands, box is just the
    // declared bbox) may collapse ONE axis — a horizontal/vertical line, or a flat path bbox.
    // A `core.instance` mirrors its MASTER's box, which may itself be a line/path, so it takes
    // the same rule — otherwise a horizontal rule could never be instanced.
    // A `core.boolean` is sized by the RESULT of combining its children, so its stored box is
    // derived data that a stale save may not match; it takes the permissive rule for the same
    // reason a path does — the box is a declared bbox, not the shape.
    if (type === "core.line" || type === "core.path" || type === "core.instance" || type === "core.boolean") {
        if (width < 0 || height < 0) return "dimensions must be >= 0";
        if (width === 0 && height === 0) return "must have a non-zero extent on at least one axis";
        return null;
    }
    if (width <= 0 || height <= 0) return "must have positive dimensions";
    return null;
}

/** Upper bound on a path's command count — the OOM guard on a hand-editable unbounded field,
 *  mirroring `GRID_MAX_TRACKS`. A path's cost is LINEAR (one `<path>`, a `d` string of
 *  O(commands) length) unlike a grid's quadratic occupancy, so the cap is looser while still
 *  rejecting a millions-of-commands file. */
export const PATH_MAX_COMMANDS = 100_000;

/**
 * One command of a `core.path`, in ABSOLUTE coordinates in the node's LOCAL box space
 * (drawn at the local origin, placed by the world matrix like every other shape). Only the
 * explicit absolute subset SVG rendering reduces to — relative/shorthand (`h`/`v`/`s`/`t`)
 * and arcs (`A`) are deferred to a future SVG-import normalizer whose output feeds this same
 * type through `pathError`.
 */
export type PathCommand =
    | { c: "M"; x: number; y: number }
    | { c: "L"; x: number; y: number }
    | { c: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { c: "Q"; x1: number; y1: number; x: number; y: number }
    | { c: "Z" };

/** Required finite-numeric fields per command letter (`Z` carries none). */
const PATH_COMMAND_COORDS: Record<string, readonly string[]> = {
    M: ["x", "y"], L: ["x", "y"],
    C: ["x1", "y1", "x2", "y2", "x", "y"], Q: ["x1", "y1", "x", "y"], Z: []
};

/**
 * Validity check for `Node.path`, keyed on type and SHARED by the load path (`Integrity`)
 * and a future path-edit action — the same closure discipline `dimensionError`/`layoutError`
 * use. An absent path is always fine (a `core.path` with no commands draws nothing, like an
 * absent `text`/`src`); only a `core.path` may carry path data; a present path must be a
 * non-empty, bounded array opening with `M`, every command a known letter with finite coords.
 */
/** The four boolean operations, in the order the toolbar offers them. */
export const BOOLEAN_OPS = ["union", "subtract", "intersect", "exclude"] as const;
export type BooleanOp = typeof BOOLEAN_OPS[number];

/**
 * Shared validator for `Node.booleanOp` (schema 33) — the edit path and the loader run this one.
 *
 * Type-aware like `pathError`: only a `core.boolean` may carry an operation, so a file that puts
 * one on a rectangle is refused rather than silently ignored. Absent is legal and means `"union"`,
 * which is what makes every pre-33 document a valid 33 one for this field.
 */
export function booleanOpError(type: NodeType, op: unknown): string | null {
    if (op === undefined) return null;
    if (type !== "core.boolean") return "only a core.boolean node may carry a boolean operation";
    if (typeof op !== "string" || !(BOOLEAN_OPS as readonly string[]).includes(op)) {
        return `booleanOp must be one of ${BOOLEAN_OPS.join(", ")}`;
    }
    return null;
}

export function pathError(type: NodeType, path: unknown): string | null {
    if (path === undefined) return null;
    if (type !== "core.path") return "only a core.path node may carry path data";
    if (!Array.isArray(path)) return "path must be an array of commands";
    if (path.length === 0) return "path must have at least one command";
    if (path.length > PATH_MAX_COMMANDS) return `path must have at most ${PATH_MAX_COMMANDS} commands`;
    // Must open with a moveto: without a current point the first draw is undefined.
    const first = path[0] as { c?: unknown };
    if (typeof first !== "object" || first === null || first.c !== "M") return 'path must start with an "M" (moveto) command';
    for (let i = 0; i < path.length; i++) {
        const cmd = path[i];
        if (typeof cmd !== "object" || cmd === null || Array.isArray(cmd)) return `path command ${i} must be an object`;
        const c = (cmd as { c?: unknown }).c;
        // OWN-property check, not `c in …`: `in` walks the prototype chain, so a command
        // named "toString"/"constructor"/"__proto__" would read as known and then crash the
        // for-of on the inherited function (a validator must never throw). Same family as the
        // grid `"px" in t` throw hazard.
        if (typeof c !== "string" || !Object.prototype.hasOwnProperty.call(PATH_COMMAND_COORDS, c)) return `path command ${i} has an unknown command "${String(c)}"`;
        for (const key of PATH_COMMAND_COORDS[c]) {
            const v = (cmd as Record<string, unknown>)[key];
            if (typeof v !== "number" || !Number.isFinite(v)) return `path command ${i} (${c}) ${key} must be a finite number`;
        }
    }
    return null;
}

/**
 * Longest `Node.src` a document may carry. An image source is usually a short URL, but the
 * editor's file picker inlines a chosen file as a `data:` URL — which lands the whole encoded
 * image IN the document. Without a bound, one picked photo makes a document that cannot be
 * saved (browser storage quotas are a few MB) and is slow to parse forever after. ~4 MB of
 * characters is roughly a 3 MB image: generous for a design asset, still bounded.
 */
export const IMAGE_SRC_MAX = 4_000_000;

/** URL schemes an image source may use. Anything else (`javascript:`, `file:`, …) is not a
 *  thing a renderer can draw, so it is rejected rather than handed to the DOM. A source with
 *  NO scheme is a relative path and always allowed. */
const SRC_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const SRC_ALLOWED = ["http", "https", "blob"];

/**
 * Validity check for `Node.src`, keyed on type and SHARED by the load path (`Integrity`) and
 * the edit path (`AddNodeAction`'s content) — the same closure discipline `pathError` and
 * `dimensionError` use. An absent src is always fine (an image with no source draws nothing);
 * only a `core.image` may carry one; a present one must be a non-empty, bounded string whose
 * scheme is something a renderer could actually load.
 */
/** Largest a source rectangle's coordinates may be — a bound on a hand-editable number. */
export const SOURCE_RECT_MAX = 1_000_000;

/** A sub-rectangle of an image, in the SOURCE image's own pixels. */
/** A painted surface as the document stores it: run-length text plus its size. */
export interface RasterSurface {
    /** `PixelCodec` output — base64 of the run-length payload. */
    data: string;
    width: number;
    height: number;
}

/**
 * What is wrong with a surface, or null.
 *
 * The PAYLOAD is not decoded here. Validation runs on every load and a 4096-square surface would
 * cost a full decode to check — so this checks the SHAPE, and `decodeSurface` refuses a payload
 * that does not fill the size when something actually needs the pixels.
 */
export function rasterSurfaceError(surface: unknown): string | null {
    if (surface === null || typeof surface !== "object") return "surface must be an object";
    const s = surface as Partial<RasterSurface>;
    if (typeof s.data !== "string") return "surface.data must be a string";
    if (!Number.isInteger(s.width) || !Number.isInteger(s.height)) {
        return "surface dimensions must be whole numbers";
    }
    if ((s.width as number) < 1 || (s.height as number) < 1) return "a surface must be at least one pixel";
    if ((s.width as number) > RASTER_MAX_SIDE || (s.height as number) > RASTER_MAX_SIDE) {
        return `a surface may not exceed ${RASTER_MAX_SIDE} on a side`;
    }
    return null;
}

/** Mirrors `PIXEL_MAX_SIDE`; stated here so the document layer needs no paint import. */
export const RASTER_MAX_SIDE = 4096;

export interface SourceRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Validity of an image's source rectangle, SHARED by the edit path and the load path.
 *
 * IT CANNOT BE CHECKED AGAINST THE IMAGE, and being explicit about that is worth more than a
 * validator that pretends otherwise. Whether the rect lies inside the real pixels is unknowable
 * until the file decodes and unknowable forever if it never does — the document holds a URL, not a
 * bitmap. So this checks what a document CAN be wrong about on its own: finite numbers, a positive
 * extent, and a bound. A rect outside the image draws nothing, which is what these backends already
 * do with an href that will not load.
 *
 * PIXELS, NOT FRACTIONS — the opposite of the call schema 43 made for mesh points, for a reason that
 * does not carry over. A mesh's box is in the document, so a fraction stays meaningful when it
 * resizes; an image's pixel size is not. Pixels are also the unit the art is authored in.
 */
export function sourceRectError(rect: unknown): string | null {
    if (rect === undefined) return null;
    if (typeof rect !== "object" || rect === null || Array.isArray(rect)) return "sourceRect must be an object";
    const r = rect as Partial<SourceRect>;
    for (const key of ["x", "y", "width", "height"] as const) {
        const v = r[key];
        if (!Number.isFinite(v)) return `sourceRect.${key} must be a finite number`;
        if (Math.abs(v as number) > SOURCE_RECT_MAX) return `sourceRect.${key} must be within ±${SOURCE_RECT_MAX}`;
    }
    // A ZERO OR NEGATIVE extent is not a degenerate region to draw carefully, it is a region that
    // cannot be sampled at all — every backend would divide by it to build its texture coordinates.
    if ((r.width as number) <= 0 || (r.height as number) <= 0) return "sourceRect.width and .height must be positive";
    return null;
}

/**
 * Validity of a nine-slice, SHARED by the edit path and the load path.
 *
 * LIKE `sourceRectError`, IT CANNOT BE CHECKED AGAINST THE IMAGE. Whether four insets fit inside
 * the real bitmap is unknowable until the file decodes and unknowable forever if it never does —
 * so this checks what a document can be wrong about alone, and `nineSliceRects` clamps the rest
 * against the size it actually gets. Being explicit about the split is worth more than a validator
 * that pretends to know.
 *
 * ONLY A BITMAP MAY CARRY ONE. A nine-sliced rectangle is a rectangle with four numbers nothing
 * reads — silently ignored, which is the kind of field somebody sets and then spends an hour
 * wondering about.
 */
export function nineSliceError(type: NodeType, slice: unknown): string | null {
    if (slice === undefined) return null;
    if (type !== "core.image" && type !== "core.raster") {
        return "only a core.image or core.raster node may carry a nineSlice";
    }
    if (typeof slice !== "object" || slice === null || Array.isArray(slice)) return "nineSlice must be an object";
    const n = slice as Partial<NineSliceInsets>;
    for (const key of ["left", "top", "right", "bottom"] as const) {
        const v = n[key];
        if (!Number.isFinite(v)) return `nineSlice.${key} must be a finite number`;
        // NEGATIVE IS NOT A MIRRORED INSET, it is a corner reaching outside the art. Zero is legal
        // and means that edge has no corner — a three-slice, which is how a horizontal bar is done.
        if ((v as number) < 0) return `nineSlice.${key} must not be negative`;
        if ((v as number) > SOURCE_RECT_MAX) return `nineSlice.${key} must be within ${SOURCE_RECT_MAX}`;
    }
    return null;
}

export function srcError(type: NodeType, src: unknown): string | null {
    if (src === undefined) return null;
    // A TILEMAP CARRIES ITS SHEET THE SAME WAY an image carries its picture, deliberately: the
    // renderer's image cache is keyed by `src`, so a sheet loads, decodes and is reused through the
    // path that already exists rather than through a second one that would have its own bugs.
    if (type !== "core.image" && type !== "core.tilemap") {
        return "only a core.image or core.tilemap node may carry a src";
    }
    return srcValueError(src);
}

/**
 * The TYPE-FREE half of `srcError`: everything true of an image source regardless of which
 * node carries it. Split out because a per-instance OVERRIDE also carries a `src` and is
 * validated without knowing the master's type (`overridesError` sees a bare map) — the type
 * half runs in `overrideAgainstMasterError`, which holds the document. Without this split the
 * override seam validated `src` as merely "a string", so an override could smuggle in a value
 * no stored node may hold and a detach would bake it into an unloadable document.
 */
export function srcValueError(src: unknown): string | null {
    if (typeof src !== "string" || src.length === 0) return "src must be a non-empty string";
    if (src.length > IMAGE_SRC_MAX) return `src must be at most ${IMAGE_SRC_MAX} characters`;
    const scheme = SRC_SCHEME.exec(src);
    if (scheme === null) return null;                    // relative path
    const name = scheme[1].toLowerCase();
    // A `data:` URL must actually be an IMAGE: `data:text/html,…` in an <image href> draws
    // nothing, and handing arbitrary data URLs to the DOM is not a habit worth having.
    if (name === "data") {
        return /^data:image\/[a-zA-Z0-9.+-]+[;,]/.test(src) ? null : "a data: src must be an image media type";
    }
    return SRC_ALLOWED.includes(name) ? null : `src scheme "${name}" is not allowed`;
}

/**
 * Represents the immutable, persisted definition of a node instance.
 */
export interface Node {
    id: string;
    type: NodeType;
    parent?: string | null;
    children: string[];
    geometry: Geometry;
    style: Style;
    layout: Layout;
    /**
     * Rotation / scale about a pivot. Optional and absent by default — a node with
     * no `transform` is exactly a translated axis-aligned box, which is what every
     * schema-1 document is. Deliberately NOT folded into `Geometry`, which stays a
     * pure AABB so Milestone 2 layout can compute it.
     */
    transform?: Transform;
    /**
     * Named STATES (Milestone 7, schema 30): what this node looks like in a given context —
     * `{ hover: { style: { fill: "#333" } } }`. The document's `activeState` selects one, and
     * every node that defines it shows it; nodes that do not are untouched.
     *
     * A state is the same shape of statement as a per-instance override ("in this context,
     * these fields differ"), so it IS one, and shares `overrideValueError` — two copies of
     * those rules would drift the first time a field was added.
     */
    states?: Record<string, StateDefinition>;
    /**
     * KEYFRAMES over time (schema 39) — the node's animation.
     *
     * A keyframe is the same statement a state and an instance override make ("here these fields
     * differ"), with a frame number and a note on how to leave it. That is why animating a node
     * needed no new field rules: `overrideValueError` already governs the values, and
     * `materializeNode` already applies them. See `document/Timeline`.
     */
    track?: Keyframe[];
    /**
     * Per-property TRACKS (schema 47), keyed by property path — `"transform.rotation"`,
     * `"geometry.x"`. Absent = the node's `track` says everything.
     *
     * A keyframe holds a whole state, which is what made animation cheap and is also what forces
     * every animated property onto the same frames. A channel lifts exactly that: rotation can key
     * where position has no keyframe at all, which is what overlapping action — a body that stops
     * while its arm keeps going — is made of. Applied AFTER `track`, so the more specific statement
     * wins. See `document/Timeline`.
     */
    channels?: Record<string, Keyframe[]>;
    /**
     * Where this node is asked to BE, with its parent and grandparent derived to put it there
     * (schema 49). Absent = the node is placed the ordinary way.
     *
     * Carried by the END EFFECTOR because that is the node whose position is being stated — a hand
     * says where it is and the forearm and upper arm follow. The rig itself is the scene graph;
     * this adds the solve, not a bone type. See `document/Rig`.
     */
    ik?: IkConstraint;
    /**
     * How far BACK this node sits (schema 40). Absent = 0, the plane of the page.
     *
     * Three things read it and nothing else does: display ORDER (far draws first, ahead of the
     * tree's own order), the GPU's Z-BUFFER, and PARALLAX. A layer panel says which sibling is on
     * top of which; depth says which is nearer the viewer, and those are different questions.
     * See `document/Depth`.
     */
    depth?: number;
    /**
     * A GRID of control points that BENDS this node's outline (schema 41).
     *
     * Resolved at the display seam into an ordinary `core.path`, so nothing downstream knows a
     * mesh from a drawing. Absent = rigid, which every node was until this field. See
     * `document/Mesh`.
     */
    mesh?: Mesh;
    text?: string;
    src?: string;
    /**
     * A sub-rectangle of the SOURCE image, in that image's own pixels (schema 51). Absent = whole.
     *
     * What a tileset and a sprite strip are made of, and what every backend was unable to say: they
     * all drew whole images, so a 15x7 grid of 24px tiles in one file could only ever be drawn as
     * one 360x168 picture. See `sourceRectError` for why the unit is pixels rather than fractions.
     */
    sourceRect?: SourceRect;
    /**
     * How far in from each edge a bitmap's CORNERS reach, in source pixels (schema 57).
     *
     * Nine-slice: the corners keep their size at any scale, the edges stretch along one axis, the
     * middle along both. A nine-pixel button bitmap becomes a button of any size with a border
     * that stays four pixels thick — which is what a fraction-based inset could never do, since it
     * would thicken as the panel grew.
     *
     * Absent = the whole region is drawn as one stretched picture, which is what every image was
     * before this field existed. The arithmetic is `geometry/NineSlice`; the insets are relative to
     * `sourceRect` when there is one, so a sliced button can live inside an atlas.
     */
    nineSlice?: NineSliceInsets;

    /**
     * Whether this node's CHILDREN are clipped to its own box (schema 59).
     *
     * MEASURED BEFORE BUILDING, and the measurement cut the feature down: of the 5,279 SVG files
     * in `freeassets`, **zero** use `<mask>` and eight use clipping at all — 72 clip paths between
     * them, and every single one is a plain `<rect>` in user space. They are icon sets clipping
     * each glyph to its own viewBox, which is this exact feature. A general path clip and a soft
     * alpha mask both have no demand here, and `core.boolean` intersect already covers "cut this
     * shape to that one" destructively.
     *
     * THE CLIP IS THE NODE'S OWN SHAPE, radius included, not a separate region. That is what makes
     * it a boolean rather than a subtree: there is nothing to keep in sync, nothing to place, and a
     * node that is resized clips to where it now is. It is also what Figma and Sketch offer, which
     * is worth matching where the meaning is identical.
     *
     * IT AFFECTS PICKING, not only drawing — `computeGeometry` records the clipping ancestors on
     * every descendant and `hitTest` refuses a point outside them. A thing you cannot see must not
     * be a thing you can click, or the canvas grows invisible targets.
     */
    clipsContent?: boolean;

    /**
     * A GRID OF TILE INDICES, for a `core.tilemap` (schema 61).
     *
     * Measured: importing one 100x100 five-layer map as a node per cell made 10,618 nodes, 22ms of
     * derivation and 5.66MB of JSON. It becomes five nodes here. See `document/Tilemap` for the
     * shape, and for why the indices are the map rather than the tiles it draws.
     */
    tilemap?: Tilemap;
    /**
     * A surface this document OWNS, for `core.raster` (schema 55).
     *
     * The difference from `src` is authorship. An image node REFERENCES a picture somebody else
     * made; a raster node holds pixels the user painted, and every paint tool writes here.
     *
     * DIMENSIONS LIVE BESIDE THE PAYLOAD, not inside it, so a surface resized in the document and
     * a payload written before the resize cannot disagree about which is authoritative — the
     * decoder is TOLD the size and refuses a payload that does not fill it.
     */
    surface?: RasterSurface;
    /**
     * Scale by NEAREST NEIGHBOUR rather than interpolating (schema 51). Absent = smooth, as before.
     *
     * Pixel art must not be interpolated — the packs measured for this have hard alpha edges and
     * palettes of a dozen colours, and every backend blurred them unconditionally. Per NODE because
     * one scene mixes a tileset that must stay crisp with a photograph that must not.
     */
    pixelated?: boolean;
    /** `core.path` drawing commands (absolute, local-space). Absent = an empty path. See `PathCommand`. */
    path?: PathCommand[];
    /**
     * `core.boolean` → how its CHILDREN combine (schema 33). The node keeps its operands as an
     * ordinary subtree and the combination is DERIVED, at the display seam, so the operation
     * stays editable: move a child and the result follows. Absent = `"union"`.
     *
     * The stored `geometry.width/height` of such a node is derived data — the resolver sizes it
     * from the result — and its `style` paints that result.
     */
    booleanOp?: BooleanOp;
    /**
     * Prototype INTERACTIONS (Milestone 7, schema 35): what a pointer gesture on this node does.
     * Absent = the node is not interactive. See `Prototype.interactionsError`.
     */
    interactions?: Interaction[];
    /**
     * `core.instance` → the id of the MASTER node this instance copies (M6). The master is an
     * ordinary node subtree in the same document. Absent = an empty instance (draws nothing);
     * a DANGLING reference is valid at rest and also draws nothing, so deleting a master can
     * never corrupt a document that instances it. See `Components.expandInstances`.
     */
    componentId?: string;
    /**
     * `core.instance` → per-instance OVERRIDES, keyed by MASTER NODE ID (schema 22). What this
     * instance changes about the copy it renders: geometry / style / text / src. Keyed by
     * identity rather than position, so an override survives edits to the master and goes inert
     * (never invalid) if that master node is deleted. See `Components.InstanceOverride`.
     */
    overrides?: Record<string, import("./Components").InstanceOverride>;
    /**
     * A MASTER's place in a variant set (schema 27): which set it belongs to, and the property
     * values that identify it within that set — `{ set: "Button", values: { size: "large",
     * state: "hover" } }`. Any node may carry one; it means nothing until something instances it.
     *
     * There is no variant-set OBJECT. A set is just the nodes that name it, exactly as a master
     * is just a node — the same "no new storage" discipline components were built on, which is
     * what keeps every existing mechanism (validation, geometry, layout, serialization, actions,
     * editing) working on variants for free.
     */
    variant?: VariantKey;
    /**
     * `core.instance` → the variant SELECTION (schema 27): which property values this instance
     * wants. SPARSE — properties it does not name keep the value of the master it points at, so
     * an instance need only record what it changed. See `resolveVariantMaster`.
     */
    variants?: Record<string, string>;
    /**
     * A SLOT (schema 29): this node is a named hole in a master, which an instance may fill
     * with content of its own. The slot node still supplies the BOX — position, size, layout —
     * and its own children are the DEFAULT content, drawn whenever nothing fills it.
     *
     * Any node may carry one; it means nothing until something instances the master.
     */
    slot?: string;
    /**
     * `core.instance` → what this instance puts in each slot (schema 29): slot NAME → the id of
     * a node to draw there. That node keeps living wherever it is in the document — a slot fill
     * is a reference, exactly as `componentId` is, not a move.
     *
     * A name matching no slot, or an id matching no node, is inert: the slot falls back to its
     * own default children, which is the same "a broken reference draws the honest fallback"
     * rule `componentId` and `$token` follow.
     */
    slotContent?: Record<string, string>;
    /**
     * HIDDEN (schema 31): this node and its subtree are dropped from the displayed scene —
     * not drawn, not pickable, and not occupying space in an auto-layout parent, the way
     * `display: none` behaves. It stays in the stored document and in the layer panel, which
     * is the whole point: hiding is a view decision, not a deletion.
     */
    hidden?: boolean;
    /**
     * LOCKED (schema 31): still drawn, but not selectable — clicks and marquees pass through
     * it to whatever is behind. INHERITED: locking a group locks everything inside it, so a
     * background can be locked once rather than node by node.
     */
    locked?: boolean;
    name?: string;
}

/** A master's identity within a variant set: the set's name, plus its property values. */
export interface VariantKey {
    set: string;
    values: Record<string, string>;
}

/** Caps on the hand-editable variant maps, in the `VARIABLES_MAX` tradition. */
export const VARIANT_PROPS_MAX = 64;
export const VARIANT_NAME_MAX = 200;

/**
 * The same reserved-key family `variableKeyError` guards: a property named `__proto__` would be
 * swallowed by the prototype setter rather than stored, so a value written could never be read
 * back — a silent, un-round-trippable loss rather than a rejection.
 */
const RESERVED_VARIANT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** One property name or value: non-empty, bounded, and not a reserved key. */
export function variantNameError(what: string, s: unknown, checkReserved: boolean): string | null {
    if (typeof s !== "string" || s.length === 0) return `${what} must be a non-empty string`;
    if (s.length > VARIANT_NAME_MAX) return `${what} must be at most ${VARIANT_NAME_MAX} characters`;
    if (checkReserved && RESERVED_VARIANT_KEYS.has(s)) return `${what} "${s}" is reserved`;
    return null;
}

/**
 * Validity of a node's `variant`, SHARED by the load path (`Integrity`) and the edit path
 * (`SetVariantAction`). A set with no properties is allowed — that is a set of one, which is
 * how a set looks the moment you tag its first master and before you have added a second.
 */
export function variantError(variant: unknown): string | null {
    if (variant === undefined) return null;
    if (typeof variant !== "object" || variant === null || Array.isArray(variant)) return "variant must be an object";
    const v = variant as Partial<VariantKey>;
    const se = variantNameError("variant.set", v.set, false);
    if (se) return se;
    if (typeof v.values !== "object" || v.values === null || Array.isArray(v.values)) return "variant.values must be an object";
    return variantValuesError("variant.values", v.values);
}

/** The property map both `variant.values` and an instance's `variants` selection obey. */
function variantValuesError(what: string, values: Record<string, unknown>): string | null {
    const entries = Object.entries(values);
    if (entries.length > VARIANT_PROPS_MAX) return `${what} must have at most ${VARIANT_PROPS_MAX} properties`;
    for (const [k, val] of entries) {
        const ke = variantNameError(`${what} property name`, k, true);
        if (ke) return ke;
        const ve = variantNameError(`${what}.${k}`, val, false);
        if (ve) return ve;
    }
    return null;
}

/** Validity of a node's SLOT name (schema 29): non-empty and bounded, like every other
 *  hand-editable name here. Any node type may be a slot. */
export function slotError(slot: unknown): string | null {
    if (slot === undefined) return null;
    return variantNameError("slot", slot, false);
}

/**
 * Validity of an instance's SLOT CONTENT (schema 29). Only a `core.instance` may carry it;
 * keys are slot names and values are node ids, both bounded and non-empty. Neither is required
 * to RESOLVE — an unfilled or dangling entry falls back to the slot's own children.
 */
/**
 * What is wrong with a `clipsContent` flag, or null (schema 59).
 *
 * A BOOLEAN OR ABSENT, nothing else. It is checked at all because the loader accepts hand-edited
 * files, and a truthy string would clip on the edit path and then round-trip into something a
 * stricter reader refuses — the same reason every other one-field flag here has a validator.
 */
export function clipsContentError(clipsContent: unknown): string | null {
    if (clipsContent === undefined) return null;
    if (typeof clipsContent !== "boolean") return "clipsContent must be a boolean";
    return null;
}

export function slotContentError(type: string, slotContent: unknown): string | null {
    if (slotContent === undefined) return null;
    if (type !== "core.instance") return "only a core.instance node may carry slot content";
    if (typeof slotContent !== "object" || slotContent === null || Array.isArray(slotContent)) return "slotContent must be an object";
    const entries = Object.entries(slotContent as Record<string, unknown>);
    if (entries.length > VARIANT_PROPS_MAX) return `slotContent must have at most ${VARIANT_PROPS_MAX} entries`;
    for (const [name, id] of entries) {
        const ne = variantNameError("slotContent slot name", name, true);
        if (ne) return ne;
        const ie = variantNameError(`slotContent.${name}`, id, false);
        if (ie) return ie;
    }
    return null;
}

/** Validity of an instance's variant SELECTION. Only a `core.instance` may carry one; a
 *  property naming nothing in the set is inert, like a dangling `componentId` or `$token`. */
export function variantSelectionError(type: string, variants: unknown): string | null {
    if (variants === undefined) return null;
    if (type !== "core.instance") return "only a core.instance node may carry a variant selection";
    if (typeof variants !== "object" || variants === null || Array.isArray(variants)) return "variants must be an object";
    return variantValuesError("variants", variants as Record<string, unknown>);
}

/** Geometry defines the bounding box and initial position intent. */
export interface Geometry {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A drop shadow: offset + gaussian softness + colour, all in world units. Persisted (schema 18). */
export interface Shadow {
    dx: number;
    dy: number;
    blur: number;    // gaussian std-dev radius in world units, >= 0 (0 = a sharp shadow)
    color: string;   // colour value or token id, like `fill` (not parsed)
}

/**
 * How a stroke turns a corner and how it ends (schema 37).
 *
 * SVG's spellings, because they reach `stroke-linejoin`/`stroke-linecap` and Canvas's
 * `lineJoin`/`lineCap` verbatim. They live HERE rather than beside the offsetting geometry for
 * the same reason `TEXT_ALIGNS` does: the document layer owns what a document may say, and
 * `geometry/StrokeOutline` reads them from here — the other direction would be a cycle.
 */
export const STROKE_JOINS = ["miter", "round", "bevel"] as const;
export type StrokeJoin = typeof STROKE_JOINS[number];
export const STROKE_CAPS = ["butt", "round", "square"] as const;
export type StrokeCap = typeof STROKE_CAPS[number];
/** SVG's default miter limit, and what every backend falls back to when none is given. */
export const DEFAULT_MITER_LIMIT = 4;

/**
 * Which points a closed outline encloses (schema 38).
 *
 * SVG's `fill-rule` and Canvas's `fill(rule)` spelled their way, for the same reason the join and
 * cap names are: both backends take these verbatim. NONZERO asks whether the contours wind around
 * a point at all; EVENODD asks only how many boundaries lie between it and infinity. The two
 * disagree wherever a path crosses itself, which is exactly where a design tool needs the author
 * to be able to say which they meant — a five-pointed star drawn in one stroke is solid under one
 * and hollow under the other. Absent = "nonzero", which is what every backend already drew.
 */
export const FILL_RULES = ["nonzero", "evenodd"] as const;
export type FillRule = typeof FILL_RULES[number];

/** Horizontal text alignment inside a node's box (schema 34). */
export const TEXT_ALIGNS = ["left", "center", "right", "justify"] as const;
export type TextAlign = typeof TEXT_ALIGNS[number];
/** Cap on a font STACK string — hand-editable and it reaches CSS, so it is bounded like `name`. */
export const FONT_FAMILY_MAX = 200;

/** Style holds the visual attributes that define appearance. */
export interface Style {
    /**
     * A colour value, a token ID (`"$color/primary"`), or a GRADIENT (schema 56).
     *
     * THE STRING CASE IS UNCHANGED, which is why every schema-55 document loads untouched. The
     * union is what moves the version: a 56 document holding a gradient reaches a 55 build as an
     * object where it expects a string, and `styleError` there refuses it — the gate is what makes
     * that a clear failure rather than a shape drawn in black.
     *
     * ONLY THE FILL. `stroke` stays a string: SVG and Canvas can both stroke with a gradient, but
     * exactly ONE stroke in the 3,127 measured gradients references one, and widening `stroke` too
     * would double the work in three backends and the exporter to serve that one.
     */
    fill: string | Gradient;
    stroke?: string;   // Optional border color
    /**
     * Border thickness in WORLD units — a number, or a NUMBER-token reference (schema 25).
     * Absent = a hairline: 1 SCREEN pixel at any zoom, which is what every stroke was before
     * this field existed. World units are the meaningful default for a shape's own border (it
     * should thicken as you zoom in, unlike the selection chrome, which stays hairline).
     */
    strokeWidth?: number | string;
    /**
     * How a stroke turns a corner, ends, and when a miter gives up (schema 37).
     *
     * The values are SVG's spellings, and they are passed to `stroke-linejoin`/`stroke-linecap`
     * and to Canvas's `lineJoin`/`lineCap` verbatim — a private vocabulary would need a
     * translation table in every backend. Absent means the value all three already drew:
     * "miter", "butt", and a limit of 4.
     *
     * Stroke ALIGNMENT is deliberately NOT here. Neither SVG nor Canvas can draw an inside or
     * outside border, so a document field for it would render differently on different backends
     * — it lives on the Outline Stroke command instead, where the result is a fill every backend
     * draws identically. See `geometry/StrokeOutline`.
     */
    strokeJoin?: StrokeJoin;
    strokeCap?: StrokeCap;
    strokeMiterLimit?: number;
    /** Which points a closed outline encloses (schema 38); absent = "nonzero". */
    fillRule?: FillRule;
    /** Corner radius — a number, or a NUMBER-token reference like "$radius/medium" (schema 20). */
    radius?: number | string;
    opacity: number;
    /**
     * How this node's colour combines with what is already behind it (schema 60).
     *
     * THREE MODES, AND THE CORPUS PICKED THEM. Of the 5,279 SVG files in `freeassets`, 65 use
     * `mix-blend-mode` and between them they name exactly three: overlay (63), multiply (54) and
     * screen (13). No darken, lighten, dodge, burn, difference, hue, saturation, colour or
     * luminosity anywhere — and on the pixel-art side all 92 Aseprite layers across 26 files are
     * `normal` at full opacity, so the `blendMode` that importer already parses is always zero.
     * Eighteen modes across three backends is a very different job from three, and two thirds of
     * that job would be for nothing.
     *
     * Absent means `normal`, which is what every document meant before this existed.
     */
    blendMode?: BlendMode;
    /** Text font size in world units (defaults to 14) — a number, or a number-token reference (schema 20). */
    fontSize?: number | string;
    /**
     * TYPOGRAPHY (schema 34). Every one of these is optional and absent means the old default,
     * so a schema-33 document draws identically — the bump is for the fields themselves.
     *
     * `fontFamily` is a CSS font STACK ("Inter, sans-serif"), not a resolved face: the app has
     * no font loading, so what a family means is the platform's answer, and pretending
     * otherwise would be a promise the renderer cannot keep.
     */
    fontFamily?: string;
    /** 100–900, or a number token. Absent = 400. */
    fontWeight?: number | string;
    /** Horizontal alignment inside the node's box. Absent = "left". */
    textAlign?: TextAlign;
    /** A MULTIPLE of the font size (CSS unitless line-height), > 0. Absent = 1.2, the browser's `normal`. */
    lineHeight?: number | string;
    /** Extra space between characters, in WORLD units like `fontSize`. May be negative (tightening). Absent = 0. */
    letterSpacing?: number | string;
    shadow?: Shadow;   // Drop shadow (schema 18); absent = none
    blur?: number;     // Whole-node gaussian blur radius in world units, >= 0 (schema 18); absent/0 = none
}

/**
 * A fill as ONE colour — the string itself, or a gradient's FIRST stop (schema 56).
 *
 * For the places that genuinely cannot hold a ramp: hit-testing asks only whether a fill paints
 * anything, the script sandbox hands out a plain string, and the GPU backend has one colour per
 * draw. FIRST rather than an average because averaging needs a colour space and `Style.fill` may
 * hold a design TOKEN, which cannot be blended without resolving it — the same reason
 * `sampleGradient` returns the stop pair instead of a colour.
 *
 * A gradient always has at least one stop (`gradientError` refuses an empty one), so the fallback
 * here is for a malformed value that never passed validation, not for a legal document.
 */
export function flatFill(fill: string | Gradient): string {
    if (typeof fill === "string") return fill;
    return fill.stops[0]?.color ?? "#000000";
}

/**
 * Validity check for a style patch, SHARED by the edit path (`UpdateNodeStyleAction`) and the
 * load path (`Integrity.checkNodeRanges`) so the two cannot drift — the same discipline
 * `layoutError`/`transformError` use, and it also closes the pre-existing inline duplication of
 * the opacity/radius/fontSize rules. Only present fields are checked. Message substrings are
 * load-bearing (tests assert "opacity must be within"). Returns an error string, or null.
 */
/**
 * The blend modes this engine supports — measured, not chosen. See `Style.blendMode`.
 *
 * `normal` is not in the list because absent IS normal: offering both would put two spellings of
 * "do nothing" into every file and every comparison.
 */
export const BLEND_MODES = ["multiply", "screen", "overlay"] as const;
export type BlendMode = typeof BLEND_MODES[number];

/** What is wrong with a blend mode, or null. */
export function blendModeError(mode: unknown): string | null {
    if (mode === undefined) return null;
    if (typeof mode !== "string" || !(BLEND_MODES as readonly string[]).includes(mode)) {
        return `style.blendMode must be one of ${BLEND_MODES.join(", ")}`;
    }
    return null;
}

export function styleError(s: Partial<Style>): string | null {
    const blendErr = blendModeError(s.blendMode);
    if (blendErr) return blendErr;
    // fill (schema 56): a colour/token string, or a gradient — whose own rules live in
    // `gradientError` so the edit path, the load path and the importer cannot disagree about what
    // a legal ramp is. The old message is kept verbatim for the non-object case: tests assert the
    // substring, and a document holding a number in `fill` is still exactly the old mistake.
    if ("fill" in s && typeof s.fill !== "string") {
        if (s.fill === null || typeof s.fill !== "object") return "style.fill must be a string";
        const bad = gradientError(s.fill);
        if (bad) return `style.fill: ${bad}`;
    }
    if ("stroke" in s && s.stroke !== undefined && typeof s.stroke !== "string") return "style.stroke must be a string";
    if ("opacity" in s && (!Number.isFinite(s.opacity) || (s.opacity as number) < 0 || (s.opacity as number) > 1)) return "style.opacity must be within [0, 1]";
    // radius/fontSize (schema 20): a concrete number under the old range rules, OR a "$token"
    // reference — an arbitrary NON-token string is rejected (it would silently render as the
    // fallback with no hint that it was never a token). The token's RESOLVED value is range-
    // checked at render time (a broken/out-of-range token falls back visibly, never throws).
    if ("radius" in s && s.radius !== undefined && !isNumberToken(s.radius)
        && (typeof s.radius !== "number" || !Number.isFinite(s.radius) || s.radius < 0)) return "style.radius must be >= 0 or a $token";
    if ("fontSize" in s && s.fontSize !== undefined && !isNumberToken(s.fontSize)
        && (typeof s.fontSize !== "number" || !Number.isFinite(s.fontSize) || s.fontSize <= 0)) return "style.fontSize must be > 0 or a $token";
    // TYPOGRAPHY (schema 34). Same shape as fontSize: a concrete number in range, or a token.
    // `fontFamily` is a bounded string — hand-editable, and it reaches CSS, so it is capped like
    // `name` rather than left unbounded.
    if ("fontFamily" in s && s.fontFamily !== undefined
        && (typeof s.fontFamily !== "string" || s.fontFamily.length > FONT_FAMILY_MAX)) return `style.fontFamily must be a string of at most ${FONT_FAMILY_MAX} characters`;
    if ("fontWeight" in s && s.fontWeight !== undefined && !isNumberToken(s.fontWeight)
        && (typeof s.fontWeight !== "number" || !Number.isFinite(s.fontWeight) || s.fontWeight < 1 || s.fontWeight > 1000)) return "style.fontWeight must be within [1, 1000] or a $token";
    if ("textAlign" in s && s.textAlign !== undefined
        && !(TEXT_ALIGNS as readonly string[]).includes(s.textAlign as string)) return `style.textAlign must be one of ${TEXT_ALIGNS.join(", ")}`;
    if ("lineHeight" in s && s.lineHeight !== undefined && !isNumberToken(s.lineHeight)
        && (typeof s.lineHeight !== "number" || !Number.isFinite(s.lineHeight) || s.lineHeight <= 0)) return "style.lineHeight must be > 0 or a $token";
    // Letter spacing is the one that may be NEGATIVE — tightening is a real typographic choice.
    if ("letterSpacing" in s && s.letterSpacing !== undefined && !isNumberToken(s.letterSpacing)
        && (typeof s.letterSpacing !== "number" || !Number.isFinite(s.letterSpacing))) return "style.letterSpacing must be a finite number or a $token";
    // strokeWidth (schema 25): same shape as radius — >= 0 (0 means "no visible border") or a token.
    if ("strokeWidth" in s && s.strokeWidth !== undefined && !isNumberToken(s.strokeWidth)
        && (typeof s.strokeWidth !== "number" || !Number.isFinite(s.strokeWidth) || s.strokeWidth < 0)) return "style.strokeWidth must be >= 0 or a $token";
    // Stroke corners and ends (schema 37): a closed vocabulary each, checked the same way
    // `textAlign` is. The miter limit is >= 1 because SVG says so — a ratio below 1 would mean a
    // miter shorter than the stroke is wide, which no join can be.
    if ("strokeJoin" in s && s.strokeJoin !== undefined
        && !(STROKE_JOINS as readonly string[]).includes(s.strokeJoin as string)) return `style.strokeJoin must be one of ${STROKE_JOINS.join(", ")}`;
    if ("strokeCap" in s && s.strokeCap !== undefined
        && !(STROKE_CAPS as readonly string[]).includes(s.strokeCap as string)) return `style.strokeCap must be one of ${STROKE_CAPS.join(", ")}`;
    if ("strokeMiterLimit" in s && s.strokeMiterLimit !== undefined
        && (typeof s.strokeMiterLimit !== "number" || !Number.isFinite(s.strokeMiterLimit) || s.strokeMiterLimit < 1)) return "style.strokeMiterLimit must be >= 1";
    if ("fillRule" in s && s.fillRule !== undefined
        && !(FILL_RULES as readonly string[]).includes(s.fillRule as string)) return `style.fillRule must be one of ${FILL_RULES.join(", ")}`;
    if ("blur" in s && s.blur !== undefined && (!Number.isFinite(s.blur) || (s.blur as number) < 0)) return "style.blur must be finite and >= 0";
    if ("shadow" in s && s.shadow !== undefined) {
        const sh = s.shadow as Partial<Shadow>;
        if (typeof sh !== "object" || sh === null || Array.isArray(sh)) return "style.shadow must be an object";
        if (!Number.isFinite(sh.dx) || !Number.isFinite(sh.dy)) return "style.shadow dx and dy must be finite";
        if (!Number.isFinite(sh.blur) || (sh.blur as number) < 0) return "style.shadow.blur must be finite and >= 0";
        if (typeof sh.color !== "string") return "style.shadow.color must be a string";
    }
    return null;
}

/** Layout defines how the node should behave within its parent container. */
export interface Layout {
    // Constraint relationships, not absolute positions.
    horizontalAlignment?: "left" | "right" | "center";
    verticalAlignment?: "top" | "bottom" | "center";
    spacing?: number; // Gap size for children or siblings
    /**
     * Auto-layout (Milestone 2). When set, this node's DIRECT CHILDREN are POSITIONED
     * by the layout engine — their stored `geometry.x/y` is ignored and computed from
     * the stack rule. This is what "store 'center inside parent' instead of x=240" means.
     */
    container?: LayoutContainer;
    /**
     * Flex-grow (Milestone 2). This node's share of the LEFTOVER main-axis space in its
     * flex-container parent, distributed in proportion to siblings' `grow`. `0`/absent =
     * fixed to its own (base) main size. Only takes effect when the parent is a container
     * with free space — a parent that HUGS its main axis has none, so `grow` is inert
     * there. A property of the CHILD, consumed by its container parent (like CSS
     * `flex-grow`), so it lives on the node's own `Layout`, not on `LayoutContainer`.
     */
    grow?: number;
    /**
     * Flex-shrink (Milestone 2). When the flex children OVERFLOW their container's main
     * axis, this node gives up a share of the DEFICIT, weighted (CSS-style) by
     * `shrink × base-main-size`, clamped so it never shrinks below 0. `0`/absent = never
     * shrinks (the pre-shrink overflow behaviour). Mutually exclusive with `grow` by sign:
     * only one of grow (free > 0) / shrink (free < 0) applies on a given layout.
     */
    shrink?: number;
    /**
     * Grid auto-layout (Milestone 2). An ALTERNATIVE to `container` (flex) — the two are
     * mutually exclusive. This node's direct children are auto-flowed row-major into a
     * grid of the given column tracks, each filling its cell. See `LayoutGrid`.
     */
    grid?: LayoutGrid;
    /**
     * Constraints / anchors (Milestone 2). How THIS node repositions when its PLAIN
     * (non-flex, non-grid) parent's size differs from `constraintRef`. A per-child hint
     * (like `grow`); ignored when the parent lays this node out (flex/grid). Absent =
     * `left`/`top` = today's static behavior. See `Constraints`.
     */
    constraints?: Constraints;
    /**
     * The parent size this node's stored geometry is "at rest" against — a FROZEN
     * reference, decoupled from the parent's stored AND computed size, so a constraint
     * responds to BOTH a direct parent resize and a layout-driven one. Auto-captured from
     * the parent's stored size when `constraints` is first set (`UpdateNodeLayoutAction`);
     * the resize path never rewrites it. Constraints are inert without it.
     */
    constraintRef?: { width: number; height: number };
    /**
     * Absolute-position escape (Milestone 2). `"absolute"` takes this node OUT of its
     * flex/grid parent's flow: it takes no slot/cell, does not contribute to the parent's
     * hug size or consume flex free space, and is positioned by its stored geometry +
     * `constraints` relative to the parent's box (like CSS `position: absolute`). Absent =
     * in-flow (normal).
     */
    position?: "absolute";
    /**
     * Per-child margin (Milestone 2). A single `number` is uniform on all four sides; a
     * `Margins` object gives PER-SIDE margins (any omitted side = 0). In a FLEX parent it is
     * flow spacing (main-axis before/after + cross-axis inset, mapped from the physical sides by
     * `direction`); in a GRID parent it insets the child WITHIN its cell (and an `auto` track
     * grows to fit the child + its margins). Absent = 0. Ignored for a constrained/absolute
     * child or a child of a plain parent (out of flow). Every side >= 0.
     */
    margin?: number | Margins;
    /**
     * Grid SPAN (Milestone 2). How many columns / rows this node occupies in its GRID parent's
     * auto-placement. Absent = 1 (a single cell). `colSpan` is clamped to the column count; a
     * spanning item's cell covers its tracks plus the internal gaps. Integers in
     * `[1, GRID_SPAN_MAX]`. Ignored by a flex/plain parent. A spanning item does NOT drive `auto`
     * track sizing (a documented simplification — CSS's first sizing pass only).
     */
    colSpan?: number;
    rowSpan?: number;
    /**
     * EXPLICIT grid line placement (Milestone 2). `[startLine, endLine]`, 1-indexed and end-
     * EXCLUSIVE (CSS grid lines): `[2, 4]` pins the item to two tracks starting at index 1. An item
     * is explicitly placed only when BOTH `gridColumn` AND `gridRow` are present — auto items then
     * flow AROUND it. Supersedes `colSpan`/`rowSpan` on that axis (span = end − start). Lines in
     * `[1, GRID_MAX_TRACKS + 1]`. Single-axis placement and explicit-under-column-flow are deferred.
     */
    gridColumn?: readonly [number, number];
    gridRow?: readonly [number, number];
}

/** Upper bound on a grid `colSpan`/`rowSpan` — a per-item cap (bounds one item's cell block). */
export const GRID_SPAN_MAX = 1000;
/**
 * Upper bound on a grid's COLUMN count and its DERIVED row count. Columns are capped on
 * validation; the derived rows are capped in placement. Together they bound the placement's
 * occupancy set to `GRID_MAX_TRACKS²` cells — so a hand-edited grid (huge columns, or many
 * wide-spanning children) cannot exhaust memory. A grid larger than this is beyond scope (use a
 * flex column for a long list).
 */
export const GRID_MAX_TRACKS = 1000;

/**
 * Merge a layout PATCH over a base layout, keeping grid ⊕ container exclusivity.
 *
 * A plain spread is not enough: a master laying its children out with `container` and a patch
 * supplying `grid` would produce a node carrying BOTH, which `layoutError` refuses — an
 * expanded node no loader would accept. The PATCH wins, because it is the more specific
 * statement; naming either half of the pair clears the other.
 *
 * This is the same rule `UpdateNodeLayoutAction` carries in its delta, which is why it lives
 * here as one function rather than as a second copy that can drift from the first.
 */
export function mergeLayout(base: Layout, patch: Partial<Layout>): Layout {
    // Exclusivity is decided on the PATCH, then spread — so the answer does not depend on what
    // the base happened to carry, and this is the same call the action makes on its delta.
    return { ...base, ...layoutExclusivity({ ...patch }) };
}

/**
 * Clear whichever of `grid` / `container` a layout patch does not name — the ONE statement of
 * their mutual exclusivity, shared by `mergeLayout` (the instance-override path) and
 * `UpdateNodeLayoutAction` (the direct-edit path).
 *
 * It takes and returns a PATCH rather than a whole layout because the action must emit a
 * partial: its delta is merged field-by-field with any other layout patch in the same
 * transaction, and a delta carrying every field would clobber instead of resolving last-wins.
 * That difference is exactly why this is a separate function from `mergeLayout` rather than
 * the same one used twice — and why, for one commit, the two paths each kept their own copy.
 *
 * MUTATES and returns its argument; callers pass a fresh object.
 */
export function layoutExclusivity<T extends Partial<Layout>>(patch: T): T {
    if (patch.grid !== undefined) patch.container = undefined;
    else if (patch.container !== undefined) patch.grid = undefined;
    return patch;
}

/**
 * The layout patch that turns a node INTO a grid.
 *
 * `columns` and `rowHeight` are mandatory, so "become a grid" must supply a WHOLE grid — which
 * is easy to get wrong (and impossible to test) spelled out inline at a checkbox, so it lives
 * here where a test can dispatch the real thing. The particular numbers are only a starting
 * point; every one is editable afterwards.
 *
 * It does NOT clear `container`: `UpdateNodeLayoutAction` carries grid ⊕ container exclusivity
 * in the delta itself, so an explicit `container: undefined` here would be a second copy of a
 * rule the action already owns — the kind of duplication that later drifts.
 */
export function newGridPatch(): Partial<Layout> {
    return {
        grid: { columns: [{ fr: 1 }, { fr: 1 }], rowHeight: { px: 80 }, columnGap: 8, rowGap: 8, padding: 8 }
    };
}

/** Horizontal anchor: pin left, pin right, pin both (stretch), keep centered, or scale. */
export type HConstraint = "left" | "right" | "left-right" | "center" | "scale";
/** Vertical anchor: pin top, pin bottom, pin both (stretch), keep centered, or scale. */
export type VConstraint = "top" | "bottom" | "top-bottom" | "center" | "scale";

/** Per-axis anchor modes for a child of a plain (non-auto-layout) parent. */
export interface Constraints {
    horizontal?: HConstraint;
    vertical?: VConstraint;
}

/** Per-side margins (any omitted side = 0). The object form of `Layout.margin`. */
export interface Margins {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}

/**
 * A grid track size: a fixed pixel size (`px`), a fraction of the leftover space (`fr`),
 * or `auto` — sized to the MAX intrinsic (measured own-) size of the children auto-flowed
 * into that track. `auto` is the object `{ auto: true }`, NOT the string `"auto"`, so that
 * every track stays an object and the `"px" in t` discriminant (used in the engine's
 * must-never-throw measure pass) can never hit the `in`-on-a-primitive `TypeError`.
 */
export type TrackSize = { px: number } | { fr: number } | { auto: true };

/**
 * A CSS-grid-like container: children auto-flow row-major into cells and STRETCH to fill
 * them (their stored size is ignored, like a laid-out flex child's position). Row count is
 * derived from the child count (`ceil(count / columns)`); every row uses `rowHeight`.
 *
 * `auto` tracks (and grid-container hug, below) pull grid INTO the bottom-up measure pass —
 * an `auto` track sizes to the max measured own-size of its children, so grid reads child
 * sizes exactly as flex hug does. `fr` tracks share the container's leftover inner size on
 * a NON-hugged axis (on a hugged axis there is no definite size to share, so `fr` → 0).
 */
export interface LayoutGrid {
    columns: readonly TrackSize[];   // ≥1 column tracks; defines the column count
    rowHeight: TrackSize;   // IMPLICIT row size — used for every row NOT sized by `rows` (px, fr, or auto)
    /**
     * EXPLICIT per-row track sizes (Milestone 2 grid tail), the mirror of `columns`. Row
     * `r` is sized by `rows[r]` when present, else falls back to `rowHeight` (like CSS
     * `grid-template-rows` + `grid-auto-rows`: `rows` sizes the leading rows, `rowHeight`
     * the implicit overflow rows). `fr` rows share the leftover inner height after the `px`
     * rows, exactly as columns do. Absent = every row is `rowHeight` (the pre-tail
     * behaviour). Row COUNT is still derived from the child count — `rows` only sizes them.
     */
    rows?: readonly TrackSize[];
    /**
     * Grid-container HUG (Milestone 2 grid tail), mirroring `LayoutContainer.hugWidth/Height`.
     * When set, this axis sizes to the grid's own tracks: `2·padding + Σtracks + gaps`, with
     * `auto` tracks folded from the children's measured sizes in the bottom-up measure pass.
     * On a hugged axis `fr` tracks collapse to 0 (no definite size to share). Absent = the
     * grid's own size on that axis is fixed / inherited (the pre-hug behaviour).
     */
    hugWidth?: boolean;
    hugHeight?: boolean;
    /**
     * Auto-placement flow (Milestone 2). `"row"` (default) fixes the `columns` and derives the rows
     * from the flow; `"column"` fixes the ROWS (from `rows`, default 1) and derives the columns
     * (implicit columns beyond `columns` are `auto`-sized). `"dense"` backfills earlier gaps instead
     * of the forward-only (sparse) cursor. Absent = `"row"`.
     */
    autoFlow?: "row" | "row dense" | "column" | "column dense";
    columnGap?: number;     // between columns (>= 0)
    rowGap?: number;        // between rows (>= 0)
    padding?: number;       // inset from the container's edges (>= 0)
}

/** A flex-stack: children packed along one axis, with padding, gap and cross-align. */
export interface LayoutContainer {
    direction: "row" | "column";
    gap?: number;        // space between children (>= 0) — used BETWEEN items AND between wrapped lines
    padding?: number;    // inset from the container's edges (>= 0)
    /** Cross-axis placement; "stretch" also sets each child's cross-size to fill. */
    alignItems?: "start" | "center" | "end" | "stretch";
    /**
     * Flex WRAP (Milestone 2). When true, children that overflow the container's inner MAIN
     * axis wrap onto new lines (the first child on a line always stays even if it alone
     * overflows). Each line distributes its OWN grow/shrink free space; lines stack on the
     * cross axis separated by `gap`; `alignItems` aligns each child within its line's cross
     * band. A cross-axis-hug container sizes its cross to the stacked lines. Absent = nowrap
     * (a single line, today's behaviour). Inert when the MAIN axis hugs (no definite main to
     * wrap against — like `grow` under a hugged main). Wrapping is measured against the
     * container's OWN size; extra space from a parent that STRETCHES the main axis is not
     * re-wrapped into (a documented deferral that keeps the measure pass acyclic).
     */
    wrap?: boolean;
    /**
     * Cross-axis distribution of the wrapped LINES (Milestone 2), when they have leftover cross
     * space (`Σ line sizes < inner cross`). Absent = `start`. A no-op for a single line or a
     * cross-hug container (which sized itself to its lines). `stretch` grows each line's band
     * (feeding `alignItems: stretch`); `space-between`/`space-around` distribute the gaps.
     */
    alignContent?: "start" | "center" | "end" | "space-between" | "space-around" | "stretch";
    /**
     * Flex WRAP-REVERSE (Milestone 2). When true, wrapped lines stack from the OPPOSITE cross
     * edge (also flipping per-line `alignItems` and `alignContent`, like CSS `wrap-reverse`).
     * Absent = false. Inert without `wrap` (or when the main axis hugs, which makes wrap inert).
     */
    wrapReverse?: boolean;
    /**
     * Intrinsic ("hug") sizing (Milestone 2). When set, this container sizes the given
     * PHYSICAL axis to its contents instead of using its stored `geometry`: the hugged
     * width/height becomes a computed RESULT, exactly as a laid-out child's position is.
     *   - `hugWidth`  → width  = (row: sum of child widths + gaps; column: max child width) + 2·padding
     *   - `hugHeight` → height = (row: max child height; column: sum of child heights + gaps) + 2·padding
     * Absolute axes (not main/cross) on purpose: flipping `direction` must never
     * silently re-interpret which axis hugs. Hug composes — a hug container inside a hug
     * container ripples upward — which is why sizing needs a bottom-up measure pass.
     */
    hugWidth?: boolean;
    hugHeight?: boolean;
}

const DIRECTIONS = new Set(["row", "column"]);
const ALIGNMENTS = new Set(["start", "center", "end", "stretch"]);
const ALIGN_CONTENT = new Set(["start", "center", "end", "space-between", "space-around", "stretch"]);
const GRID_AUTO_FLOWS = new Set(["row", "row dense", "column", "column dense"]);
const H_CONSTRAINTS = new Set(["left", "right", "left-right", "center", "scale"]);
const V_CONSTRAINTS = new Set(["top", "bottom", "top-bottom", "center", "scale"]);

/** Validity check for `Layout.margin` — a finite `number >= 0`, or a `Margins` object of finite `>= 0` sides. */
function marginError(m: unknown): string | null {
    if (typeof m === "number") return (!Number.isFinite(m) || m < 0) ? "must be finite and >= 0" : null;
    // Reject arrays (and non-objects): an array is `typeof "object"` but is not a `Margins`, and
    // without this guard it would validate clean (every named side reads `undefined`) and silently
    // drop to {0,0,0,0} — a round-trip-closure gap, since TypeScript forbids an array at the edit path.
    if (typeof m !== "object" || m === null || Array.isArray(m)) return "must be a number or a per-side object";
    for (const side of ["top", "right", "bottom", "left"] as const) {
        const v = (m as Record<string, unknown>)[side];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return `${side} must be finite and >= 0`;
    }
    return null;
}

/** Validity check for a `[startLine, endLine]` grid-line pair — integers, `1 <= start < end <= GRID_MAX_TRACKS + 1`. */
function gridLineError(v: unknown): string | null {
    if (!Array.isArray(v) || v.length !== 2) return "must be a [start, end] pair";
    const [s, e] = v as unknown[];
    if (!Number.isInteger(s) || !Number.isInteger(e)) return "lines must be integers";
    if ((s as number) < 1 || (e as number) > GRID_MAX_TRACKS + 1 || (s as number) >= (e as number)) return `must satisfy 1 <= start < end <= ${GRID_MAX_TRACKS + 1}`;
    return null;
}

/** Validity check for one grid `TrackSize` — exactly one of `px` (≥0), `fr` (>0), or `auto` (true). */
export function trackError(t: unknown): string | null {
    if (typeof t !== "object" || t === null) return "must be an object";
    const hasPx = "px" in t;
    const hasFr = "fr" in t;
    const hasAuto = "auto" in t;
    if ((hasPx ? 1 : 0) + (hasFr ? 1 : 0) + (hasAuto ? 1 : 0) !== 1) return "must have exactly one of px, fr or auto";
    const px = (t as { px?: unknown }).px;
    const fr = (t as { fr?: unknown }).fr;
    const auto = (t as { auto?: unknown }).auto;
    if (hasPx && (typeof px !== "number" || !Number.isFinite(px) || px < 0)) return "px must be finite and >= 0";
    if (hasFr && (typeof fr !== "number" || !Number.isFinite(fr) || fr <= 0)) return "fr must be finite and > 0";
    if (hasAuto && auto !== true) return "auto must be true";
    return null;
}

/**
 * Validity check for a layout patch, shared by the edit path (`UpdateNodeLayoutAction`)
 * and the load path (`validateDocumentIntegrity`) so the two cannot drift — the same
 * round-trip discipline transform uses. Only present fields are checked. Returns an
 * error string, or null.
 */
export function layoutError(l: Partial<Layout>): string | null {
    // `grow` is independent of `container` and must be checked BEFORE the no-container
    // early return, or a `{ grow: -5 }` patch would slip through unvalidated.
    if (l.grow !== undefined && (!Number.isFinite(l.grow) || l.grow < 0)) return "layout.grow must be finite and >= 0";
    if (l.shrink !== undefined && (!Number.isFinite(l.shrink) || l.shrink < 0)) return "layout.shrink must be finite and >= 0";
    if (l.margin !== undefined) {
        const e = marginError(l.margin);
        if (e) return `layout.margin ${e}`;
    }
    // Grid spans: positive integers, capped so the derived row count cannot OOM. Per-child
    // (grid children have no container), so validate BEFORE the no-container early return.
    if (l.colSpan !== undefined && (!Number.isInteger(l.colSpan) || l.colSpan < 1 || l.colSpan > GRID_SPAN_MAX)) return `layout.colSpan must be an integer in [1, ${GRID_SPAN_MAX}]`;
    if (l.rowSpan !== undefined && (!Number.isInteger(l.rowSpan) || l.rowSpan < 1 || l.rowSpan > GRID_SPAN_MAX)) return `layout.rowSpan must be an integer in [1, ${GRID_SPAN_MAX}]`;
    if (l.gridColumn !== undefined) { const e = gridLineError(l.gridColumn); if (e) return `layout.gridColumn ${e}`; }
    if (l.gridRow !== undefined) { const e = gridLineError(l.gridRow); if (e) return `layout.gridRow ${e}`; }
    if (l.position !== undefined && l.position !== "absolute") return 'layout.position must be "absolute"';
    // Constraints + reference are independent per-child fields (like grow), so validate
    // them BEFORE the no-container early return — else a `{ constraints }` patch slips by.
    if ("constraints" in l && l.constraints !== undefined) {
        const c = l.constraints;
        if (typeof c !== "object" || c === null) return "layout.constraints must be an object";
        if (c.horizontal !== undefined && !H_CONSTRAINTS.has(c.horizontal)) return "layout.constraints.horizontal is invalid";
        if (c.vertical !== undefined && !V_CONSTRAINTS.has(c.vertical)) return "layout.constraints.vertical is invalid";
    }
    if ("constraintRef" in l && l.constraintRef !== undefined) {
        const r = l.constraintRef;
        if (typeof r !== "object" || r === null) return "layout.constraintRef must be an object";
        // > 0 (not just finite): a zero/negative reference would make `scale`'s C/R divide
        // by zero or flip sign; the engine also treats R <= 0 as static, so this is belt-and-braces.
        if (!Number.isFinite(r.width) || r.width <= 0) return "layout.constraintRef.width must be finite and > 0";
        if (!Number.isFinite(r.height) || r.height <= 0) return "layout.constraintRef.height must be finite and > 0";
    }
    // Grid is independent of `container` (and mutually exclusive with it), so validate it
    // BEFORE the no-container early return — else a `{ grid: <bad> }` patch would slip by.
    if ("grid" in l && l.grid !== undefined) {
        const g = l.grid as LayoutGrid;
        if (typeof g !== "object" || g === null) return "layout.grid must be an object";
        if (l.container !== undefined) return "layout.grid and layout.container are mutually exclusive";
        // Column count is capped (with the derived-row cap in placement) so the sparse
        // auto-placement's occupancy set stays bounded — see GRID_MAX_TRACKS.
        if (!Array.isArray(g.columns) || g.columns.length === 0) return "layout.grid.columns must be a non-empty array";
        if (g.columns.length > GRID_MAX_TRACKS) return `layout.grid.columns must have at most ${GRID_MAX_TRACKS} tracks`;
        for (const t of g.columns) { const e = trackError(t); if (e) return `layout.grid.columns track ${e}`; }
        const rhe = trackError(g.rowHeight); if (rhe) return `layout.grid.rowHeight ${rhe}`;
        // Explicit per-row tracks: optional, but if present a non-empty array of valid
        // tracks (omit it for "all rows use rowHeight"; `[]` would be a redundant no-op).
        if (g.rows !== undefined) {
            if (!Array.isArray(g.rows) || g.rows.length === 0) return "layout.grid.rows must be a non-empty array when present";
            if (g.rows.length > GRID_MAX_TRACKS) return `layout.grid.rows must have at most ${GRID_MAX_TRACKS} tracks`;
            for (const t of g.rows) { const e = trackError(t); if (e) return `layout.grid.rows track ${e}`; }
        }
        if (g.hugWidth !== undefined && typeof g.hugWidth !== "boolean") return "layout.grid.hugWidth must be a boolean";
        if (g.hugHeight !== undefined && typeof g.hugHeight !== "boolean") return "layout.grid.hugHeight must be a boolean";
        if (g.autoFlow !== undefined && !GRID_AUTO_FLOWS.has(g.autoFlow)) return 'layout.grid.autoFlow must be "row" | "row dense" | "column" | "column dense"';
        if (g.columnGap !== undefined && (!Number.isFinite(g.columnGap) || g.columnGap < 0)) return "layout.grid.columnGap must be finite and >= 0";
        if (g.rowGap !== undefined && (!Number.isFinite(g.rowGap) || g.rowGap < 0)) return "layout.grid.rowGap must be finite and >= 0";
        if (g.padding !== undefined && (!Number.isFinite(g.padding) || g.padding < 0)) return "layout.grid.padding must be finite and >= 0";
        return null; // grid is exclusive with container — skip the flex checks below
    }
    if (!("container" in l) || l.container === undefined) return null;
    const c = l.container;
    if (typeof c !== "object" || c === null) return "layout.container must be an object";
    if (!DIRECTIONS.has(c.direction)) return 'layout.container.direction must be "row" or "column"';
    if (c.gap !== undefined && (!Number.isFinite(c.gap) || c.gap < 0)) return "layout.container.gap must be finite and >= 0";
    if (c.padding !== undefined && (!Number.isFinite(c.padding) || c.padding < 0)) return "layout.container.padding must be finite and >= 0";
    if (c.alignItems !== undefined && !ALIGNMENTS.has(c.alignItems)) return "layout.container.alignItems is invalid";
    if (c.hugWidth !== undefined && typeof c.hugWidth !== "boolean") return "layout.container.hugWidth must be a boolean";
    if (c.hugHeight !== undefined && typeof c.hugHeight !== "boolean") return "layout.container.hugHeight must be a boolean";
    if (c.wrap !== undefined && typeof c.wrap !== "boolean") return "layout.container.wrap must be a boolean";
    if (c.alignContent !== undefined && !ALIGN_CONTENT.has(c.alignContent)) return "layout.container.alignContent is invalid";
    if (c.wrapReverse !== undefined && typeof c.wrapReverse !== "boolean") return "layout.container.wrapReverse must be a boolean";
    return null;
}

/**
 * Rotation and scale, applied about `origin` expressed as a fraction of the node's
 * own box (0.5,0.5 = centre, the default). Normalized rather than absolute so the
 * pivot survives a resize.
 */
export interface Transform {
    rotation?: number;   // radians, clockwise
    scaleX?: number;
    scaleY?: number;
    origin?: { x: number; y: number };
}

/**
 * Validity check for a transform, shared by the edit path (`UpdateNodeTransformAction`)
 * and the load path (`validateDocumentIntegrity`) so the two CANNOT drift — the M0
 * round-trip invariant applied to schema 2: anything one path rejects, the other must.
 * Only present fields are checked (a partial patch). Returns an error string, or null.
 */
export function transformError(t: Partial<Transform>): string | null {
    if ("rotation" in t && !Number.isFinite(t.rotation)) return "transform.rotation must be finite";
    // Zero scale is non-invertible: toLocal/hit-testing would fail, so the node could
    // never be selected. Negative scale (a flip) is legitimate.
    if ("scaleX" in t && (!Number.isFinite(t.scaleX) || t.scaleX === 0)) return "transform.scaleX must be finite and non-zero";
    if ("scaleY" in t && (!Number.isFinite(t.scaleY) || t.scaleY === 0)) return "transform.scaleY must be finite and non-zero";
    if ("origin" in t) {
        const o = t.origin;
        if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return "transform.origin must have finite x and y";
    }
    return null;
}

/**
 * What a node looks like in one named context (e.g. `hover`) — the same shape as a
 * per-instance override, deliberately: both say "in this situation, these fields differ".
 *
 * Until schema 30 this was `{ [key: string]: any }` — declared, serialized, validated by
 * nothing and read by nothing, which is the dead-but-consumed field DOCUMENT-SCHEMA warns
 * against. The 29→30 migration therefore SANITIZES: anything the old type allowed but the
 * real one does not is dropped, so a file written under the old rules still opens.
 */
export type StateDefinition = import("./Components").InstanceOverride;
/** A node's keyframe — declared in `document/Timeline`, referenced here like `Interaction`. */
export type Keyframe = import("./Timeline").Keyframe;
/** A node's deformation grid — declared in `document/Mesh`, referenced here like `Keyframe`. */
export type Mesh = import("./Mesh").Mesh;

/** Cap on a node's state map, and on a state NAME — hand-editable, so bounded. */
export const STATES_MAX = 64;
