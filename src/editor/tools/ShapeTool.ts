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
import { Rect } from "../../core/geometry/Matrix";
import { Tool } from "./ToolController";

const DEFAULT_FILL = "#4a90d9";
/**
 * Minimum drag size to commit, in SCREEN pixels. Expressed in screen units so the same
 * physical gesture behaves identically at every zoom — a world threshold meant "too small to
 * bother with" changed meaning as you zoomed.
 */
const MIN_SIZE_PX = 2;

/** The basic shapes the editor can draw. Each maps to a node type plus, where the type needs
 *  more than a box, the content that makes it visible. */
export type ShapeKind = "rectangle" | "ellipse" | "line" | "text" | "triangle" | "image";

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
}

const SHAPES: Record<ShapeKind, ShapeSpec> = {
    rectangle: { type: "core.rectangle", allowsCollapsedAxis: false },
    ellipse: { type: "core.ellipse", allowsCollapsedAxis: false },
    line: { type: "core.line", allowsCollapsedAxis: true },
    text: { type: "core.text", allowsCollapsedAxis: false, content: () => ({ text: "Text" }) },
    triangle: {
        type: "core.path",
        allowsCollapsedAxis: false,
        // Apex at the top-centre of the box, base along its bottom edge — the box IS the
        // triangle's bounding box, so selection, handles and culling behave like any shape.
        content: (width, height): NodeContent => ({
            path: [
                { c: "M", x: width / 2, y: 0 },
                { c: "L", x: width, y: height },
                { c: "L", x: 0, y: height },
                { c: "Z" }
            ] as PathCommand[]
        })
    },
    // The one shape a drag alone cannot finish: an image with no source draws nothing, so the
    // node is only created once a source is resolved (see `SourceResolver`).
    image: { type: "core.image", allowsCollapsedAxis: false, needsSource: true }
};

/** The shape kinds in toolbar order — the single list the UI and the tests both read. */
export const SHAPE_KINDS: readonly ShapeKind[] = ["rectangle", "ellipse", "line", "text", "triangle", "image"];

export class ShapeTool implements Tool {
    private dispatcher: ActionDispatcher;
    private editorState: EditorState;
    private refresh: () => void;
    private spec: ShapeSpec;
    private isDragging = false;
    private anchorX = 0;
    private anchorY = 0;

    private resolveSource: SourceResolver | null;

    constructor(
        dispatcher: ActionDispatcher,
        editorState: EditorState,
        refresh: () => void,
        kind: ShapeKind,
        resolveSource?: SourceResolver
    ) {
        this.dispatcher = dispatcher;
        this.editorState = editorState;
        this.refresh = refresh;
        this.spec = SHAPES[kind];
        this.resolveSource = resolveSource ?? null;
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
            } else {
                this.commit(rect, this.spec.content?.(rect.width, rect.height));
            }
        }
        this.refresh();
    }

    private commit(rect: Rect, content?: NodeContent): void {
        this.dispatcher.dispatchAction(new AddNodeAction(
            this.dispatcher.getDocument(),
            this.spec.type,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            DEFAULT_FILL,
            undefined,
            null,
            content
        ));
    }

    onKeyDown(e: KeyboardEvent): void {
        if (e.key === "Escape" && this.isDragging) {
            this.cancel();
            this.refresh();
        }
    }

    private cancel(): void {
        this.isDragging = false;
        this.editorState.isDragging = false;
        this.editorState.previewRect = null;
    }
}
