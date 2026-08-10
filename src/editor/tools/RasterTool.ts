/**
 * @module RasterTool
 * @description The drag that becomes paint — the tool the whole `core/paint` layer was built for.
 *
 * Nine pure modules, an action, a node type and a Canvas draw path all existed before this and NONE
 * of them was reachable: `PaintSurfaceAction` had no caller outside its own tests. This is the seam
 * that makes pixel art part of the editor rather than a library sitting beside it.
 *
 * THE DOCUMENT IS THE PREVIEW. A stroke commits on every move, coalesced into one history entry —
 * the same live-commit gesture the rotate handle already uses. The alternative was an ephemeral
 * preview surface on `EditorState` that the render model would have to prefer over the node's own,
 * and that is a second source of truth for what the picture is: a field one layer emits and the next
 * may not read, which is exactly how `surface` was silently dropped twice before. Committing means
 * every backend draws the stroke with no new plumbing at all.
 *
 * THE PATCH DISPATCHED EACH MOVE IS CUMULATIVE, not per segment — the diff from the stroke's START,
 * against the before-image `beginStroke` captured once. That is what lets the same action be
 * re-applied every frame: its `after` bytes are absolute values for the region, so applying it to a
 * surface that already holds half the stroke lands on the same result. A per-segment patch would be
 * correct too, but only while every segment arrives in order and exactly once — and it would make
 * `Stroke`'s one-before-image-per-drag design pointless.
 *
 * THE SPACE IS CAPTURED AT PRESS and reused for the drag. A node does not move while it is being
 * painted, and re-deriving the mapping per event would let a document change mid-stroke silently
 * relocate the remaining pixels.
 *
 * NO DOM. Like every tool here, it takes events and a rect and computes; the controller does the
 * listening. That is what lets the gesture be tested with fake events instead of a browser.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { PaintSurfaceAction } from "../../core/actions/PaintSurfaceAction";
import { ComputedState } from "../../core/geometry/GeometryEngine";
import { EditorState, screenToWorld, pixelMaskFor } from "../EditorState";
import { Tool } from "./ToolController";
import { selectionClip } from "../../core/paint/Selection";
import { Rgba, PixelBuffer, linePoints } from "../../core/paint/PixelBuffer";
import { Brush } from "../../core/paint/Brush";
import { decodeSurface } from "../../core/paint/PixelCodec";
import { StrokeSession, beginStroke, extendStroke, endStroke } from "../../core/paint/Stroke";
import { isEmptyPatch } from "../../core/paint/PixelPatch";
import { SymmetryMode, symmetryPoints } from "../../core/paint/Symmetry";
import { SurfaceSpace, worldToSurface } from "../../core/paint/SurfaceSpace";

/**
 * How far beyond the first dab the captured region reaches, in SURFACE PIXELS.
 *
 * Generous on purpose. `capturePatch` narrows the result to what actually changed, so guessing too
 * large costs one read of a region nobody paints; guessing too small costs paint that CANNOT BE
 * UNDONE, because it falls outside the before-image the undo is computed against. The two errors
 * are not symmetric, so this errs the cheap way.
 */
export const STROKE_REACH = 512;

/** A stroke in progress, plus everything needed to keep mapping the pointer into it. */
interface PaintSession {
    nodeId: string;
    space: SurfaceSpace;
    buffer: PixelBuffer;
    stroke: StrokeSession;
    /** The last surface pixel painted, so a repeat sample is not re-stamped. */
    last: [number, number];
}

export class RasterTool implements Tool {
    private session: PaintSession | null = null;

    constructor(
        private dispatcher: ActionDispatcher,
        private editorState: EditorState,
        private refresh: () => void,
        private colour: () => Rgba,
        private brush: () => Brush,
        private symmetry: () => SymmetryMode
    ) { }

    /** Whether a stroke is currently being drawn — what a caller needs to know before switching tool. */
    public isPainting(): boolean {
        return this.session !== null;
    }

    /**
     * The raster node this tool would paint, or null.
     *
     * THE SELECTION IS THE TARGET, rather than whatever sits under the pointer. Picking by hit-test
     * would mean a stroke that wandered over a neighbouring raster started painting THAT one
     * halfway through, and the two halves would land in different undo steps.
     */
    private target(computed: ComputedState): { nodeId: string; space: SurfaceSpace } | null {
        const ids = this.editorState.selectedNodeIds;
        if (ids.length !== 1) return null;
        const node = this.dispatcher.getDocument().nodes.get(ids[0]);
        if (!node || node.type !== "core.raster" || !node.surface) return null;
        const c = computed.nodes.get(ids[0]);
        if (!c) return null;
        return {
            nodeId: ids[0],
            space: {
                // THE SIZE ONLY. `c.local` also carries the node's stored x/y, and `c.world`
                // already places it — passing both would count the position twice.
                world: c.world, localWidth: c.local.width, localHeight: c.local.height,
                surfaceWidth: node.surface.width, surfaceHeight: node.surface.height
            }
        };
    }

    onMouseDown(e: MouseEvent, canvasRect?: DOMRect, computed?: ComputedState): void {
        if (!canvasRect || !computed) return;
        const found = this.target(computed);
        if (!found) return;
        const node = this.dispatcher.getDocument().nodes.get(found.nodeId);
        const stored = node?.surface;
        if (!stored) return;
        // DECODED ONCE, PER STROKE. The live buffer is the tool's own copy; the document is only
        // written through the action, so nothing here can mutate the document directly.
        const buffer = decodeSurface(stored.data, stored.width, stored.height);
        if (!buffer) return;

        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        const p = worldToSurface(found.space, w.x, w.y);
        if (!p) return;

        // THE SELECTION IS CAPTURED WITH THE SPACE, at the press, and for the same reason: a mask
        // that changed mid-stroke would clip the first half of a drag differently from the second,
        // and the author would have no way to see why. `pixelMaskFor` is what makes a stale mask
        // unobservable; `selectionClip` is what makes an empty one mean "no constraint".
        const clip = selectionClip(pixelMaskFor(this.editorState, this.dispatcher.getDocument(), found.nodeId));
        const stroke = beginStroke(buffer, this.brush(), p[0], p[1], this.colour(), STROKE_REACH, clip);
        // A press that lands nowhere near the surface has no region to capture, and starting a
        // session without one would paint marks no undo could reach.
        if (!stroke) return;
        this.session = { nodeId: found.nodeId, space: found.space, buffer, stroke, last: p };
        // The press itself paints, so a CLICK leaves a dot — which is what a click with a pencil
        // means, and what `endStroke` would otherwise defer until release.
        this.paintTo(p[0], p[1]);
        this.commit();
    }

    onMouseMove(e: MouseEvent, canvasRect?: DOMRect): void {
        const s = this.session;
        if (!s || !canvasRect) return;
        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        const p = worldToSurface(s.space, w.x, w.y);
        if (!p) return;
        // SAME PIXEL, NO WORK. A pointer at 60 Hz reports many samples inside one surface pixel
        // when zoomed in, and each would re-encode the whole surface for an identical picture.
        if (p[0] === s.last[0] && p[1] === s.last[1]) return;
        this.paintTo(p[0], p[1]);
        this.commit();
    }

    /**
     * RELEASE DISPATCHES NOTHING. Every move already committed the cumulative patch, so a final
     * dispatch would re-send bytes the document already holds — and being the same patch does not
     * make it the same revision: it would land as a SECOND history entry with identical content,
     * so the first Ctrl+Z after a stroke would appear to do nothing at all.
     */
    onMouseUp(): void {
        if (!this.session) return;
        this.session = null;
    }

    /** Abandon mid-stroke. The document keeps what was already committed — that paint really
     *  happened and is on the history; only the session is dropped. */
    cancel(): void {
        if (!this.session) return;
        this.session = null;
        this.refresh();
    }

    onKeyDown(e: KeyboardEvent): void {
        if (e.key === "Escape") this.cancel();
    }

    /** Paint from the last sample to this one, mirrored as the symmetry mode asks. */
    private paintTo(x: number, y: number): void {
        const s = this.session!;
        const mode = this.symmetry();
        const { surfaceWidth: w, surfaceHeight: h } = s.space;
        // EVERY MIRROR IS A SEGMENT OF ITS OWN, walked from the mirror of the LAST point — not a
        // stamp at the mirrored position. Stamping only the endpoint would leave the mirrored side
        // as a dotted line wherever the pointer moved faster than one pixel per event.
        const from = symmetryPoints(s.last[0], s.last[1], w, h, mode);
        const to = symmetryPoints(x, y, w, h, mode);
        for (let i = 0; i < to.length && i < from.length; i++) {
            // `extendStroke` is what records the points; the mirrors are painted through the same
            // brush and line function so they cannot disagree with the original about coverage.
            if (i === 0) extendStroke(s.buffer, s.stroke, to[0][0], to[0][1], linePoints);
            else this.paintMirror(from[i], to[i]);
        }
        s.last = [x, y];
    }

    /** One mirrored segment, painted without adding to the stroke's own point list. */
    private paintMirror(from: [number, number], to: [number, number]): void {
        const s = this.session!;
        // A THROWAWAY session, so the mirror's points do not enter the real stroke's path — they
        // are derived from it, and recording both would make `strokeEscaped` measure a box twice
        // the size of the gesture.
        const mirror: StrokeSession = { ...s.stroke, points: [from] };
        extendStroke(s.buffer, mirror, to[0], to[1], linePoints);
    }

    /**
     * Send the stroke so far to the document.
     *
     * KNOWN AND SHARED WITH EVERY LIVE-COMMITTED GESTURE HERE: the coalesce window is timed, so two
     * separate quick strokes on the SAME node merge into one undo step. The picture is right either
     * way — a later stroke's buffer was decoded from the document after the earlier one, so its
     * cumulative patch already contains it — but the undo is coarser than the gesture. Closing the
     * window on release would need a new dispatcher call that rotate, vertex-drag and the inspector
     * sliders would all want too; it is one change for all of them, not one for this tool.
     */
    private commit(): void {
        const s = this.session!;
        const patch = endStroke(s.buffer, s.stroke, linePoints);
        // A stroke that changed nothing — a click on an already-matching colour — is not dispatched
        // at all: `PaintSurfaceAction` refuses an empty patch precisely so undo has nothing to skip.
        if (isEmptyPatch(patch)) return;
        const doc = this.dispatcher.getDocument();
        // COALESCED ALWAYS, so a continuous drag is one undo step — the same call the rotate and
        // vertex-drag gestures make on every frame of theirs.
        this.dispatcher.dispatchAction(new PaintSurfaceAction(doc, s.nodeId, patch), { coalesce: true });
        this.refresh();
    }
}
