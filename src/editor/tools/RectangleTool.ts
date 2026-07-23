/**
 * @module RectangleTool
 * @description CAD-like corner-to-corner rectangle creation. Click a corner and
 * drag to the opposite one; the drag draws an ephemeral preview (no document
 * changes) and a single AddNodeAction is committed on release.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { AddNodeAction } from "../../core/actions/AddNodeAction";
import { EditorState } from "../EditorState";
import { Tool } from "./ToolController";

const DEFAULT_FILL = "#4a90d9";
/**
 * Minimum drag size to commit a rectangle, in SCREEN pixels. Expressed in screen
 * units so the same physical gesture behaves identically at every zoom — a world
 * threshold meant "too small to bother with" changed meaning as you zoomed.
 */
const MIN_SIZE_PX = 2;

export class RectangleTool implements Tool {
    private dispatcher: ActionDispatcher;
    private editorState: EditorState;
    private refresh: () => void;
    private isDragging = false;
    private anchorX = 0;
    private anchorY = 0;

    constructor(dispatcher: ActionDispatcher, editorState: EditorState, refresh: () => void) {
        this.dispatcher = dispatcher;
        this.editorState = editorState;
        this.refresh = refresh;
    }

    /** Normalized world-space rect from the anchor to the current pointer. */
    private rectFromEvent(e: MouseEvent, canvasRect: DOMRect) {
        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        const vx = this.editorState.viewport.x;
        const vy = this.editorState.viewport.y;
        const currentX = (e.clientX - canvasRect.left + vx) / zoom;
        const currentY = (e.clientY - canvasRect.top + vy) / zoom;
        return {
            x: Math.min(this.anchorX, currentX),
            y: Math.min(this.anchorY, currentY),
            width: Math.abs(currentX - this.anchorX),
            height: Math.abs(currentY - this.anchorY)
        };
    }

    onMouseDown(e: MouseEvent, canvasRect: DOMRect): void {
        if (!canvasRect) return;
        this.isDragging = true;
        this.editorState.isDragging = true;
        const zoom = Math.max(0.01, this.editorState.viewport.zoom);
        this.anchorX = (e.clientX - canvasRect.left + this.editorState.viewport.x) / zoom;
        this.anchorY = (e.clientY - canvasRect.top + this.editorState.viewport.y) / zoom;
    }

    onMouseMove(e: MouseEvent, canvasRect: DOMRect): void {
        if (!this.isDragging || !canvasRect) return;
        // Preview only — no document mutation until commit.
        this.editorState.previewRect = this.rectFromEvent(e, canvasRect);
        this.refresh();
    }

    /** Same predicate the preview uses, so what is drawn is exactly what commits. */
    private meetsMinSize(rect: { width: number; height: number }): boolean {
        const min = MIN_SIZE_PX / Math.max(0.01, this.editorState.viewport.zoom);
        return rect.width >= min && rect.height >= min;
    }

    onMouseUp(e: MouseEvent, canvasRect?: DOMRect): void {
        if (!this.isDragging) return;
        const rect = this.editorState.previewRect;
        this.cancel();

        if (rect && this.meetsMinSize(rect)) {
            this.dispatcher.dispatchAction(new AddNodeAction(
                this.dispatcher.getDocument(),
                "core.rectangle",
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                DEFAULT_FILL
            ));
        }
        this.refresh();
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
