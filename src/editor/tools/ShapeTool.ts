/**
 * @module ShapeTool
 * @description CAD-like corner-to-corner creation for every basic shape. Click a corner and
 * drag to the opposite one; the drag draws an ephemeral preview (no document changes) and a
 * single `AddNodeAction` is committed on release.
 *
 * One tool, parameterised by SHAPE, rather than one class per node type: the gesture, the
 * preview, the Escape handling and the zoom-independent minimum size are identical for a
 * rectangle, an ellipse, a line, a text box and a triangle — only the node type, the default
 * paint and the content differ. (This began as `RectangleTool` with the type hard-coded.)
 *
 * The minimum-size rule is per-type ON PURPOSE, because it must agree with the shared
 * `dimensionError` the action validates against: most shapes need a positive box, while a
 * `core.line` may collapse ONE axis (a horizontal or vertical rule) but not both. A tool that
 * committed what validation rejects would just silently do nothing.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { AddNodeAction, NodeContent } from "../../core/actions/AddNodeAction";
import { NodeType, PathCommand } from "../../core/document/Node";
import { EditorState, screenToWorld } from "../EditorState";
import { polygonPoints, POLYGON_DEFAULT_SIDES } from "../../core/geometry/Polygon";
import { Rect } from "../../core/geometry/Matrix";
import { Tool } from "./ToolController";
import { generateUUID } from "../../core/ids/UUID";
import { RASTER_MAX_SIDE } from "../../core/document/Node";
import { createPixelBuffer } from "../../core/paint/PixelBuffer";
import { encodeSurface } from "../../core/paint/PixelCodec";

const DEFAULT_FILL = "#4a90d9";
/**
 * Minimum drag size to commit, in SCREEN pixels. Expressed in screen units so the same
 * physical gesture behaves identically at every zoom — a world threshold meant "too small to
 * bother with" changed meaning as you zoomed.
 */
const MIN_SIZE_PX = 2;

/** Border thickness a new OUTLINE shape gets, in world units. */
export const DEFAULT_STROKE_WIDTH = 2;
/** Widest border the toolbar offers. Not a document limit — `styleError` accepts any finite
 *  non-negative width — just a sane range for the control. */
export const STROKE_WIDTH_MAX = 100;

/** The ONE clamp the tool and the toolbar share, so the number shown is the number drawn. */
export function clampStrokeWidth(w: number): number {
    if (!Number.isFinite(w)) return DEFAULT_STROKE_WIDTH;
    return Math.min(STROKE_WIDTH_MAX, Math.max(0, w));
}

/** The basic shapes the editor can draw. Each maps to a node type plus, where the type needs
 *  more than a box, the content that makes it visible. */
export type ShapeKind = "rectangle" | "ellipse" | "line" | "text" | "triangle" | "polygon" | "image" | "raster";

/**
 * How an `image` gets its SOURCE. Picking a file is a DOM concern (a file input, a FileReader),
 * and tools in this codebase never touch the DOM — so the app injects this and the tool stays
 * testable in the `node` environment like every other. Resolving to null cancels the creation.
 */
export type SourceResolver = (rect: Rect) => Promise<string | null>;

interface ShapeSpec {
    type: NodeType;
    /** `true` for a shape that may collapse one axis (a line), matching `dimensionError`. */
    allowsCollapsedAxis: boolean;
    /** Content for the drawn box, in the node's LOCAL space (the renderer emits shapes at the
     *  local origin and places them by the world matrix). */
    content?: (width: number, height: number) => NodeContent;
    /** `true` when the shape cannot be created from the drag alone (an image needs a source). */
    needsSource?: boolean;
    /** `true` when the shape's content depends on the toolbar's SIDE COUNT (the N-gon tool). */
    usesSideCount?: boolean;
    /**
     * `true` when FILLED vs OUTLINE is a meaningful choice for this shape. A `core.line` is
     * already nothing but a stroke, and an image draws its own pixels, so forcing the mode on
     * them would produce an invisible node rather than an outlined one.
     */
    supportsPaintMode?: boolean;
}

/**
 * Whether a drawn shape is a solid area or just its border. Not a new document concept — a
 * filled shape has a `fill`, an outline has `fill: "none"` and a `stroke`, both of which
 * `Style` has always had. The toolbar picks the mode; the document just sees the paint.
 */
export type PaintMode = "filled" | "outline";

/**
 * The closed `core.path` outline of a regular `sides`-gon filling a `width` × `height` box.
 * Separate from `polygonPoints` (pure vertices, in `geometry/Polygon`) because turning points
 * into path commands is a document concern, and keeping the maths free of the document type is
 * what lets it be tested as maths.
 */
export function polygonCommands(sides: number, width: number, height: number): PathCommand[] {
    const points = polygonPoints(sides, width, height);
    return [
        { c: "M", x: points[0].x, y: points[0].y } as PathCommand,
        ...points.slice(1).map(p => ({ c: "L", x: p.x, y: p.y }) as PathCommand),
        { c: "Z" } as PathCommand
    ];
}

/**
 * A blank surface sized to the drawn box, at ONE PIXEL PER WORLD UNIT.
 *
 * That ratio is a default, not a law — a pixel artist zooms in and paints big pixels, and a
 * resample tool is what changes it later. It is the only ratio that needs no second control on
 * the toolbar, and it makes the node's pixels and its box agree at 100% zoom, which is what a
 * user drawing a box expects to get.
 *
 * CLAMPED AT BOTH ENDS. A drag can be sub-pixel (a click, or a box drawn while zoomed far out),
 * and a zero-sided buffer is not a surface; a drag can also be enormous, and `RASTER_MAX_SIDE`
 * squared at four bytes is 67 MB, which is already a lot to hold in one undo step.
 */
function blankSurface(width: number, height: number): { data: string; width: number; height: number } {
    const w = Math.max(1, Math.min(RASTER_MAX_SIDE, Math.round(width)));
    const h = Math.max(1, Math.min(RASTER_MAX_SIDE, Math.round(height)));
    const encoded = encodeSurface(createPixelBuffer(w, h));
    return { data: encoded.data, width: w, height: h };
}

const SHAPES: Record<ShapeKind, ShapeSpec> = {
    rectangle: { type: "core.rectangle", allowsCollapsedAxis: false, supportsPaintMode: true },
    ellipse: { type: "core.ellipse", allowsCollapsedAxis: false, supportsPaintMode: true },
    line: { type: "core.line", allowsCollapsedAxis: true },
    text: { type: "core.text", allowsCollapsedAxis: false, content: () => ({ text: "Text" }) },
    // A triangle is just the 3-gon: `polygonPoints` normalizes to the drawn box, which puts the
    // apex at top-centre and the base along the bottom edge — the shape this shipped with.
    triangle: {
        type: "core.path",
        allowsCollapsedAxis: false,
        supportsPaintMode: true,
        content: (width, height): NodeContent => ({ path: polygonCommands(3, width, height) })
    },
    // Pentagon, hexagon, octagon, …: the same generator with the side count the toolbar holds.
    polygon: {
        type: "core.path",
        allowsCollapsedAxis: false,
        usesSideCount: true,
        supportsPaintMode: true
    },
    // The one shape a drag alone cannot finish: an image with no source draws nothing, so the
    // node is only created once a source is resolved (see `SourceResolver`).
    image: { type: "core.image", allowsCollapsedAxis: false, needsSource: true },
    /**
     * A surface to PAINT ON — the one shape whose content is pixels rather than geometry.
     *
     * IT IS BORN WITH A SURFACE, not given one later. A `core.raster` without one is not a
     * smaller picture: `PaintSurfaceAction` refuses it, so the node would exist, validate,
     * serialize and be permanently unpaintable. Creating it and giving it pixels is one act,
     * which is why `NodeContent` carries a surface at all.
     */
    raster: {
        type: "core.raster",
        allowsCollapsedAxis: false,
        content: (width, height): NodeContent => ({ surface: blankSurface(width, height) })
    }
};

/** The shape kinds in toolbar order — the single list the UI and the tests both read. */
export const SHAPE_KINDS: readonly ShapeKind[] = ["rectangle", "ellipse", "line", "text", "triangle", "polygon", "image", "raster"];

/**
 * Whether FILLED/OUTLINE is offered for a kind. Read from the SAME `SHAPES` table the tool
 * commits from, so the toolbar can never show a control the tool would then ignore.
 *
 * Takes a plain `string`, not a `ShapeKind`: the caller is the toolbar, whose active-tool name
 * is just as often `"select"` or `"move"`. Typing this as `ShapeKind` only invited a cast at
 * the call site, and `SHAPES["select"]` is `undefined` — which threw during render and took
 * the whole app down with it.
 */
export function supportsPaintMode(kind: string): boolean {
    return SHAPES[kind as ShapeKind]?.supportsPaintMode === true;
}

export class ShapeTool implements Tool {
    private dispatcher: ActionDispatcher;
    private editorState: EditorState;
    private refresh: () => void;
    private spec: ShapeSpec;
    private isDragging = false;
    private anchorX = 0;
    private anchorY = 0;

    private resolveSource: SourceResolver | null;
    private sides: () => number;
    private paintMode: () => PaintMode;
    private strokeWidth: () => number;

    constructor(
        dispatcher: ActionDispatcher,
        editorState: EditorState,
        refresh: () => void,
        kind: ShapeKind,
        resolveSource?: SourceResolver,
        // A GETTER, not a value: the toolbar's side count changes between drags, and the tool is
        // constructed once. Injected for the same reason `resolveSource` is — the control that
        // holds the number is DOM, and this class never touches DOM.
        sides?: () => number,
        // Same reasoning as `sides`: a getter, read at commit time, injected by the app.
        paintMode?: () => PaintMode,
        // Border thickness for OUTLINE shapes, in world units. Same getter reasoning again.
        strokeWidth?: () => number
    ) {
        this.dispatcher = dispatcher;
        this.editorState = editorState;
        this.refresh = refresh;
        this.spec = SHAPES[kind];
        this.resolveSource = resolveSource ?? null;
        this.sides = sides ?? (() => POLYGON_DEFAULT_SIDES);
        this.paintMode = paintMode ?? (() => "filled");
        this.strokeWidth = strokeWidth ?? (() => DEFAULT_STROKE_WIDTH);
    }

    /** Normalized world-space rect from the anchor to the current pointer. */
    private rectFromEvent(e: MouseEvent, canvasRect: DOMRect): Rect {
        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        return {
            x: Math.min(this.anchorX, w.x),
            y: Math.min(this.anchorY, w.y),
            width: Math.abs(w.x - this.anchorX),
            height: Math.abs(w.y - this.anchorY)
        };
    }

    onMouseDown(e: MouseEvent, canvasRect: DOMRect): void {
        if (!canvasRect) return;
        this.isDragging = true;
        this.editorState.isDragging = true;
        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        this.anchorX = w.x;
        this.anchorY = w.y;
    }

    onMouseMove(e: MouseEvent, canvasRect: DOMRect): void {
        if (!this.isDragging || !canvasRect) return;
        // Preview only — no document mutation until commit.
        this.editorState.previewRect = this.rectFromEvent(e, canvasRect);
        this.refresh();
    }

    /**
     * Same predicate the preview uses, so what is drawn is exactly what commits — and the same
     * rule `dimensionError` applies, so a committed shape is one the loader would reopen. A
     * line needs extent on ONE axis; everything else needs both.
     */
    private meetsMinSize(rect: { width: number; height: number }): boolean {
        const min = MIN_SIZE_PX / Math.max(0.01, this.editorState.viewport.zoom);
        return this.spec.allowsCollapsedAxis
            ? Math.max(rect.width, rect.height) >= min
            : rect.width >= min && rect.height >= min;
    }

    onMouseUp(): void {
        if (!this.isDragging) return;
        const rect = this.editorState.previewRect;
        this.cancel();

        if (rect && this.meetsMinSize(rect)) {
            if (this.spec.needsSource) {
                // Nothing is created until a source arrives. The resolver is async (a file
                // dialog), so the document is re-read when it returns rather than captured now —
                // it may have changed while the dialog was open.
                this.resolveSource?.(rect).then(src => {
                    // Defence in depth, not the only guard: `AddNodeAction` refuses a null src
                    // too, so removing this changes no observable behaviour (dispatch just
                    // fails silently). It stays because "a cancelled dialog creates nothing"
                    // should be visible HERE, not inferred from a validator two layers down.
                    if (src !== null && src !== undefined) this.commit(rect, { src });
                    this.refresh();
                });
            } else if (this.spec.usesSideCount) {
                // Read the count at COMMIT time, not construction: the tool outlives any one
                // setting of the control. `clampSides` is shared with the UI, so what the
                // toolbar shows and what gets drawn cannot disagree.
                this.commit(rect, { path: polygonCommands(this.sides(), rect.width, rect.height) });
            } else {
                this.commit(rect, this.spec.content?.(rect.width, rect.height));
            }
        }
        this.refresh();
    }

    /**
     * The paint a committed shape gets. OUTLINE is `fill: "none"` plus a stroke of the colour a
     * filled shape would have used, so the two modes read as the same shape drawn two ways.
     * Shapes the mode is meaningless for (a line is already only a stroke, an image draws its
     * own pixels) ignore it rather than committing something invisible.
     */
    private paint(): { fill: string; stroke?: string; strokeWidth?: number } {
        return this.spec.supportsPaintMode && this.paintMode() === "outline"
            ? { fill: "none", stroke: DEFAULT_FILL, strokeWidth: clampStrokeWidth(this.strokeWidth()) }
            : { fill: DEFAULT_FILL };
    }

    private commit(rect: Rect, content?: NodeContent): void {
        const { fill, stroke, strokeWidth } = this.paint();
        // The id is minted HERE so the new node can be SELECTED — `AddNodeAction` would generate
        // one internally and the tool would never learn it.
        const id = generateUUID();
        this.dispatcher.dispatchAction(new AddNodeAction(
            this.dispatcher.getDocument(),
            this.spec.type,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            fill,
            id,
            null,
            content,
            stroke,
            strokeWidth
        ));
        // WHAT YOU DREW IS WHAT IS SELECTED, which every editor does and `PenTool` already did.
        // It stopped being a convenience with the raster tool: the brush paints the SELECTION, so
        // without this, drawing a canvas and then painting on it silently does nothing — the exact
        // failure found by driving the real app, where a fresh canvas took a stroke that went
        // nowhere and left the surface blank.
        this.editorState.selectedNodeIds = [id];
        this.refresh();
    }

    onKeyDown(e: KeyboardEvent): void {
        if (e.key === "Escape" && this.isDragging) {
            this.cancel();
            e.preventDefault();               // claimed: Escape cancels rather than deselecting
            this.refresh();
        }
    }

    private cancel(): void {
        this.isDragging = false;
        this.editorState.isDragging = false;
        this.editorState.previewRect = null;
    }
}
