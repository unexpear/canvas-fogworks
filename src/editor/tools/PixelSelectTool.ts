/**
 * @module PixelSelectTool
 * @description The four marquees — the gesture that says which pixels an edit may touch.
 *
 * `core/paint/Selection` holds the arithmetic: four shapes, four operators, grow, border, invert. It
 * had no gesture, which made it exactly the kind of thing the feature audit was invented to find —
 * code that exists and cannot be reached. This is the door, and it deliberately adds no arithmetic of
 * its own beyond deciding what a drag MEANS.
 *
 * ONE TOOL, FOUR MODES, rather than four tools. Every mode resolves the same target, reads the same
 * base mask, combines with the same operator and writes to the same place; the only difference is
 * which shape function the drag feeds. Four classes would be four copies of the target rule, and the
 * target rule is where a paint tool goes wrong — the tile brush and the raster brush already prove
 * that the interesting part is never the shape.
 *
 * THE OPERATOR COMES FROM THE MODIFIERS, matching what every editor an author arrives from does:
 * plain replaces, Shift adds, Alt subtracts, both intersect. Held nowhere, because it is a property
 * of the gesture and not of the tool — a panel toggle for it would let the author leave "subtract"
 * on and then wonder why the next marquee erased their selection.
 *
 * A PRESS THAT DOES NOT DRAG DESELECTS. It has to mean something, "select one pixel" is not what
 * anyone wants from a click, and without it there is no way to clear a selection with the mouse at
 * all — the author would be stuck inside their own marquee until they found a keyboard.
 *
 * NOTHING IS DISPATCHED, EVER. A selection is not content: it does not enter the document, does not
 * appear on the undo stack, and does not survive a save. That is `Selection`'s decision and this is
 * what it looks like from the gesture end — the tool writes editor state and calls `refresh`.
 *
 * NO DOM. Events and a rect in, editor state out, so the whole gesture is drivable from a test.
 */

import { Tool } from "./ToolController";
import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { EditorState, screenToWorld, pixelMaskFor } from "../EditorState";
import { ComputedState } from "../../core/geometry/GeometryEngine";
import { SurfaceSpace, worldToSurface } from "../../core/paint/SurfaceSpace";
import { decodeSurface } from "../../core/paint/PixelCodec";
import { linePoints } from "../../core/paint/PixelBuffer";
import {
    SelectionMask, SelectionOp, SELECTED, emptyMask, isEmptySelection, rectSelection,
    ellipseSelection, lassoSelection, wandSelection, combineSelection
} from "../../core/paint/Selection";

/** Which shape a drag makes. */
export type PixelSelectMode = "rect" | "ellipse" | "lasso" | "wand";

/**
 * The widest tolerance a wand can have: 255 across each of four channels.
 *
 * Beyond it the number stops meaning anything — every colour already matches every other, so a
 * larger value is a control that changes nothing. Exported so the panel clamps to the same figure
 * the matcher is built from rather than to a hand-typed one.
 */
export const WAND_TOLERANCE_MAX = 255 * 4;

/** What the panel tells the tool. */
export interface PixelSelectConfig {
    mode: PixelSelectMode;
    /** Wand only: the connected run, or every matching pixel on the surface. */
    contiguous: boolean;
    /**
     * Wand only: how far a colour may differ and still match, as a sum over all four channels.
     *
     * ZERO IS EXACT, and the sum runs over ALPHA as well: two pixels that differ only in
     * transparency are different colours to a wand, for the same reason `floodFill` compares alpha.
     */
    tolerance: number;
}

/**
 * The colour test a wand uses at a given tolerance.
 *
 * Exported because it is the one piece of policy here that a test can check on its own, and because
 * `wandSelection` deliberately takes the predicate rather than baking one in — this is the caller
 * making that decision, in the open.
 */
export function wandMatcher(tolerance: number): (a: readonly number[], b: readonly number[]) => boolean {
    if (tolerance <= 0) {
        return (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
    }
    return (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
        + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]) <= tolerance;
}

/** A marquee in progress. */
interface MarqueeSession {
    nodeId: string;
    space: SurfaceSpace;
    width: number;
    height: number;
    /** What was selected before this gesture — every operator combines against it. */
    base: SelectionMask;
    op: SelectionOp;
    anchor: [number, number];
    /** Every pixel the pointer has visited, for the lasso. */
    trail: [number, number][];
    /** Whether the pointer has left the pixel it pressed on — a press that never does deselects. */
    moved: boolean;
}

export class PixelSelectTool implements Tool {
    private session: MarqueeSession | null = null;

    constructor(
        private dispatcher: ActionDispatcher,
        private editorState: EditorState,
        private refresh: () => void,
        private config: () => PixelSelectConfig
    ) { }

    /**
     * The raster this gesture may select within, or null.
     *
     * THE SELECTED NODE IS THE TARGET, for the reason the brush and the bucket both give: picking by
     * hit-test would let a marquee dragged over two overlapping canvases select within whichever one
     * happened to be under the press, and a mask belongs to exactly one surface.
     */
    private target(computed: ComputedState): { nodeId: string; space: SurfaceSpace; width: number; height: number } | null {
        const ids = this.editorState.selectedNodeIds;
        if (ids.length !== 1) return null;
        const node = this.dispatcher.getDocument().nodes.get(ids[0]);
        if (!node || node.type !== "core.raster" || !node.surface) return null;
        const c = computed.nodes.get(ids[0]);
        if (!c) return null;
        return {
            nodeId: ids[0],
            // THE SIZE ONLY, not `c.local`'s origin: `c.world` already places the node, and passing
            // both counts the position twice — the mistake `SurfaceSpace`'s header is about.
            space: {
                world: c.world, localWidth: c.local.width, localHeight: c.local.height,
                surfaceWidth: node.surface.width, surfaceHeight: node.surface.height
            },
            width: node.surface.width, height: node.surface.height
        };
    }

    /** Which operator the modifiers ask for. */
    private opFor(e: MouseEvent): SelectionOp {
        if (e.shiftKey && e.altKey) return "intersect";
        if (e.shiftKey) return "add";
        if (e.altKey) return "subtract";
        return "replace";
    }

    onMouseDown(e: MouseEvent, canvasRect?: DOMRect, computed?: ComputedState): void {
        if (e.button !== 0 || !canvasRect || !computed) return;
        const found = this.target(computed);
        if (!found) return;
        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        const p = worldToSurface(found.space, w.x, w.y);
        if (!p) return;
        e.preventDefault();

        // THE BASE IS THE VALIDATED READ, so a mask left over from a resize is not combined against.
        // Falling back to an empty mask rather than refusing means "Shift-drag with nothing selected"
        // is an ordinary first marquee instead of doing nothing.
        const base = pixelMaskFor(this.editorState, this.dispatcher.getDocument(), found.nodeId)
            ?? emptyMask(found.width, found.height);
        const op = this.opFor(e);

        // A WAND IS A CLICK, not a drag: there is nothing to preview and nothing to release.
        if (this.config().mode === "wand") {
            this.wand(found, base, op, p);
            return;
        }
        this.session = {
            nodeId: found.nodeId, space: found.space, width: found.width, height: found.height,
            base, op, anchor: p, trail: [p], moved: false
        };
        // NOTHING IS WRITTEN YET. A press has no shape, and writing a one-pixel selection here would
        // make the deselect-on-click gesture below unreachable.
    }

    onMouseMove(e: MouseEvent, canvasRect?: DOMRect): void {
        const s = this.session;
        if (!s || !canvasRect) return;
        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        const p = worldToSurface(s.space, w.x, w.y);
        if (!p) return;
        const last = s.trail[s.trail.length - 1];
        if (p[0] === last[0] && p[1] === last[1]) return;
        s.moved = true;
        s.trail.push(p);
        this.preview(s, p);
    }

    onMouseUp(): void {
        const s = this.session;
        if (!s) return;
        this.session = null;
        // A PRESS THAT NEVER MOVED DESELECTS — see the header. It clears the whole selection rather
        // than applying the operator, because "click to start over" is what the gesture means in
        // every editor and an author holding Shift by habit must not be trapped.
        if (!s.moved) {
            this.editorState.pixelSelection = null;
            this.refresh();
        }
    }

    onKeyDown(e: KeyboardEvent): void {
        // ESCAPE CANCELS THE DRAG IF THERE IS ONE and clears the selection otherwise. Two meanings
        // for one key, and they cannot be confused: mid-drag it puts the base mask back, so the
        // author gets the selection they had before the gesture rather than none at all.
        if (e.key !== "Escape") return;
        const s = this.session;
        if (s) {
            this.session = null;
            this.write(s.nodeId, s.base);
            return;
        }
        this.editorState.pixelSelection = null;
        this.refresh();
    }

    /** Every matching pixel, connected or not, combined into the existing selection. */
    private wand(
        found: { nodeId: string; width: number; height: number },
        base: SelectionMask, op: SelectionOp, p: [number, number]
    ): void {
        const stored = this.dispatcher.getDocument().nodes.get(found.nodeId)?.surface;
        if (!stored) return;
        const buffer = decodeSurface(stored.data, stored.width, stored.height);
        if (!buffer) return;
        const cfg = this.config();
        const shape = wandSelection(buffer, p[0], p[1], wandMatcher(cfg.tolerance), cfg.contiguous);
        this.write(found.nodeId, combineSelection(base, shape, op) ?? base);
    }

    /**
     * The shape the drag currently describes, combined and written for the canvas to draw.
     *
     * REBUILT FROM THE ANCHOR EVERY MOVE rather than accumulated, so nothing compounds: dragging out
     * and back in gives the rectangle the pointer is currently describing, not the union of every
     * rectangle it passed through. The same reason the rotate and group-resize gestures recompute
     * from the pose captured at the press.
     */
    private preview(s: MarqueeSession, p: [number, number]): void {
        const a = { x: s.anchor[0], y: s.anchor[1] }, b = { x: p[0], y: p[1] };
        const mode = this.config().mode;
        const shape = mode === "lasso" ? this.lassoShape(s)
            : mode === "ellipse" ? ellipseSelection(s.width, s.height, a, b)
            : rectSelection(s.width, s.height, a, b);
        // A COMBINATION THAT CANNOT BE MADE LEAVES THE BASE ALONE. `combineSelection` answers null
        // only on a size mismatch, which the shared width/height make unreachable — but reaching for
        // the base rather than for an empty mask means a future mismatch loses the gesture, not the
        // author's existing selection.
        this.write(s.nodeId, combineSelection(s.base, shape, s.op) ?? s.base);
    }

    /**
     * The lasso: what the author drew AROUND, plus what they drew OVER.
     *
     * THE POLYGON'S VERTICES ARE PIXEL CENTRES, because that is where the pointer was — a vertex at
     * a pixel's corner puts the boundary between two pixels and leaves it ambiguous which one was
     * meant. The consequence is that the traced line itself sits exactly on the boundary, so half of
     * the pixels the author dragged over would fall outside by parity. Adding the trail back is what
     * makes a thin lasso select the line it drew rather than a dotted version of it.
     */
    private lassoShape(s: MarqueeSession): SelectionMask {
        const polygon = lassoSelection(s.width, s.height,
            s.trail.map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 })));
        // THE GAPS BETWEEN SAMPLES ARE FILLED with the same Bresenham the brush interpolates with, so
        // a fast drag traces a line rather than beads — the trail is a set of mouse samples, not a
        // continuous path.
        for (let i = 1; i < s.trail.length; i++) {
            const [x0, y0] = s.trail[i - 1];
            const [x1, y1] = s.trail[i];
            for (const [x, y] of linePoints(x0, y0, x1, y1)) {
                if (x < 0 || y < 0 || x >= s.width || y >= s.height) continue;
                polygon.data[y * s.width + x] = SELECTED;
            }
        }
        return polygon;
    }

    /** Put a mask on the editor state, or clear it when it selects nothing. */
    private write(nodeId: string, mask: SelectionMask): void {
        // AN EMPTY RESULT IS NO SELECTION, not an empty one. Both read as "no constraint" through
        // `selectionClip`, but only null makes the marquee disappear and the status line honest.
        this.editorState.pixelSelection = isEmptySelection(mask) ? null : { nodeId, mask };
        this.refresh();
    }
}
