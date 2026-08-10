/**
 * @module BucketTool
 * @description One click, one region filled — the seam that makes `floodFill` reachable.
 *
 * `PixelBuffer.floodFill` has been written, tested and mutation-checked since the paint layer
 * landed, and NOTHING CALLED IT. The feature audit found it by asking a different question than
 * "does the code exist": does anything in the app reach it? Four capabilities failed that question,
 * and this closes the first — no new arithmetic, just the door.
 *
 * THE WHOLE SURFACE IS THE CAPTURED REGION, unlike a stroke's. `RasterTool` guesses a reach and lets
 * `capturePatch` narrow it, because a stroke's future is unknown but bounded by the brush; a fill has
 * no bound at all short of the surface — one click on a background can change every pixel. So the
 * before-image is the whole surface and the patch that comes back is the tight box of what actually
 * changed, which for a fill in a corner is a corner and not a megabyte.
 *
 * ONE CLICK, ONE HISTORY ENTRY, and no coalescing: two fills are two decisions, and merging them
 * would make one Ctrl+Z undo both. That is the opposite of a stroke, where every move commits into
 * one entry — the difference is that a drag is one gesture and two clicks are two.
 *
 * NO DOM, like every tool here: events and a rect in, actions out.
 */

import { Tool } from "./ToolController";
import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { EditorState, screenToWorld } from "../EditorState";
import { PaintSurfaceAction } from "../../core/actions/PaintSurfaceAction";
import { ComputedState } from "../../core/geometry/GeometryEngine";
import { decodeSurface } from "../../core/paint/PixelCodec";
import { floodFill } from "../../core/paint/PixelBuffer";
import { Rgba } from "../../core/paint/PixelBuffer";
import { capturePatch, readRegion } from "../../core/paint/PixelPatch";
import { SurfaceSpace, worldToSurface } from "../../core/paint/SurfaceSpace";

export class BucketTool implements Tool {
    constructor(
        private dispatcher: ActionDispatcher,
        private editorState: EditorState,
        private refresh: () => void,
        private colour: () => Rgba
    ) { }

    /**
     * THE SELECTION IS THE TARGET, for the reason `RasterTool` gives: picking by hit-test would let a
     * click near an overlapping raster fill the wrong one, and the author has already said which
     * canvas they mean by selecting it.
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
                // The SIZE only — `c.world` already places the node, and `c.local` also carries its
                // stored x/y, so passing both would count the position twice.
                world: c.world, localWidth: c.local.width, localHeight: c.local.height,
                surfaceWidth: node.surface.width, surfaceHeight: node.surface.height
            }
        };
    }

    onMouseDown(e: MouseEvent, canvasRect?: DOMRect, computed?: ComputedState): void {
        if (e.button !== 0 || !canvasRect || !computed) return;
        const found = this.target(computed);
        if (!found) return;
        const stored = this.dispatcher.getDocument().nodes.get(found.nodeId)?.surface;
        if (!stored) return;
        // The tool's OWN copy. The document is only ever written through the action, so nothing here
        // can mutate it directly.
        const buffer = decodeSurface(stored.data, stored.width, stored.height);
        if (!buffer) return;

        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        const p = worldToSurface(found.space, w.x, w.y);
        // A CLICK OFF THE SURFACE FILLS NOTHING. Clamping to the nearest edge pixel would fill the
        // region at the border, which is a large edit nobody asked for.
        if (!p) return;
        e.preventDefault();

        const before = readRegion(buffer, 0, 0, buffer.width, buffer.height);
        const filled = floodFill(buffer, p[0], p[1], this.colour());
        // NOTHING CHANGED means nothing is dispatched — clicking a region that already holds the
        // colour must not leave an undo step that undoes nothing.
        //
        // THIS IS AN OPTIMISATION, NOT THE GUARANTEE, and the difference is worth stating because a
        // mutant that removes it SURVIVES and should: `PaintSurfaceAction` refuses an empty patch by
        // itself, so the behaviour is identical either way. What this buys is not correctness but
        // work — a misclick on an already-filled region skips a full-surface diff (67MB at the
        // maximum size) and a dispatch that would only fail. A second check on `isEmptyPatch` was
        // here too and was DELETED as dead: `filled > 0` cannot produce an empty patch.
        if (filled === 0) return;
        const patch = capturePatch(buffer, before, 0, 0, buffer.width, buffer.height);
        this.dispatcher.dispatchAction(new PaintSurfaceAction(this.dispatcher.getDocument(), found.nodeId, patch));
        this.refresh();
    }
}
