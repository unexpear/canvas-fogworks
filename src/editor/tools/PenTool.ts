/**
 * @module PenTool
 * @description Draws a `core.path` by clicking points — the first way to create one.
 *
 * Click places a corner; click-and-DRAG places a smooth point whose handle follows the pointer,
 * which is the gesture every vector tool uses and the reason a path can curve at all. Clicking
 * the first point again closes the shape; Enter finishes it open; Escape abandons it.
 *
 * The tool owns only the in-progress points. Everything about turning them into a node — which
 * segments are lines and which are cubics, what box the path occupies, and re-basing every
 * coordinate onto that box — is `PathBuilder`, so the hard part is testable without synthesising
 * a single pointer event. What is left here is the gesture, which stays a smoke-tested boundary
 * like every other tool.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { AddNodeAction } from "../../core/actions/AddNodeAction";
import { UpdateNodePathAction } from "../../core/actions/UpdateNodePathAction";
import { TransactionAction } from "../../core/actions/TransactionAction";
import { EditorState, screenToWorld } from "../EditorState";
import { PenPoint, penCommands, penNodeFrom } from "../../core/geometry/PathBuilder";
import { Tool } from "./ToolController";
import { generateUUID } from "../../core/ids/UUID";

/** How near the first point counts as "close the shape", in SCREEN px (so it holds at any zoom). */
const CLOSE_RADIUS_PX = 8;
/** How far the pointer must move before a press becomes a handle DRAG rather than a click. */
const DRAG_THRESHOLD_PX = 3;

export class PenTool implements Tool {
    private points: PenPoint[] = [];
    private dragging = false;
    private pressX = 0;
    private pressY = 0;

    constructor(
        private dispatcher: ActionDispatcher,
        private editorState: EditorState,
        private refresh: () => void,
        private fill: () => string
    ) { }

    /** The stroke as it currently stands, in world space — what the overlay draws. */
    private publishPreview(through?: { x: number; y: number }): void {
        const pts = through ? [...this.points, { x: through.x, y: through.y }] : this.points;
        this.editorState.pendingPath = pts.length > 0 ? penCommands(pts, false) : null;
    }

    onMouseDown(e: MouseEvent, canvasRect?: DOMRect): void {
        if (!canvasRect) return;
        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        this.pressX = e.clientX;
        this.pressY = e.clientY;

        // Clicking the FIRST point again closes the shape. Measured in screen px so the target
        // is the same size however far in you are zoomed.
        if (this.points.length > 1) {
            const z = Math.max(0.01, this.editorState.viewport.zoom);
            const first = this.points[0];
            if (Math.hypot(w.x - first.x, w.y - first.y) * z <= CLOSE_RADIUS_PX) {
                this.commit(true);
                return;
            }
        }

        this.points.push({ x: w.x, y: w.y });
        this.dragging = true;
        this.publishPreview();
        this.refresh();
    }

    onMouseMove(e: MouseEvent, canvasRect?: DOMRect): void {
        if (!canvasRect) return;
        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);

        if (this.dragging && this.points.length > 0) {
            const moved = Math.hypot(e.clientX - this.pressX, e.clientY - this.pressY);
            if (moved > DRAG_THRESHOLD_PX) {
                // Dragging OUT of the point sets its handle; the in-handle is the mirror, so the
                // curve is smooth by construction rather than by the user matching two handles.
                const p = this.points[this.points.length - 1];
                p.hx = w.x;
                p.hy = w.y;
                this.publishPreview();
                this.refresh();
            }
            return;
        }

        // Not pressing: rubber-band the segment that WOULD be added, so the next click is
        // predictable rather than a guess.
        if (this.points.length > 0) {
            this.publishPreview(w);
            this.refresh();
        }
    }

    onMouseUp(): void {
        this.dragging = false;
    }

    onKeyDown(e: KeyboardEvent): void {
        if (e.key === "Enter") { this.commit(false); return; }
        if (e.key === "Escape") { this.cancel(); return; }
    }

    /** Abandon the stroke — nothing is dispatched, so there is no undo step for a false start. */
    cancel(): void {
        this.points = [];
        this.dragging = false;
        this.editorState.pendingPath = null;
        this.refresh();
    }

    private commit(closed: boolean): void {
        const built = penNodeFrom(this.points, closed);
        this.points = [];
        this.dragging = false;
        this.editorState.pendingPath = null;
        // `penNodeFrom` refuses what the document would refuse (fewer than two points, a
        // degenerate box), so a stray click leaves nothing behind rather than failing an action.
        if (!built) { this.refresh(); return; }

        const doc = this.dispatcher.getDocument();
        // The id is minted HERE so both halves of the transaction can name it — the second
        // action has to target a node the first is still creating.
        const id = generateUUID();
        const add = new AddNodeAction(doc, "core.path", built.geometry.x, built.geometry.y,
            built.geometry.width, built.geometry.height, this.fill(), id);
        // ONE transaction: a node and its commands are a single act, so a single undo removes
        // the whole path rather than leaving an empty `core.path` behind.
        this.dispatcher.dispatchAction(new TransactionAction(doc, "pen-commit", [
            add,
            new UpdateNodePathAction(doc, id, built.path)
        ]));
        this.editorState.selectedNodeIds = [id];
        this.refresh();
    }
}
