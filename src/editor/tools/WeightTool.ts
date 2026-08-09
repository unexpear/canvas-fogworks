/**
 * @module WeightTool
 * @description The drag that becomes a weight — painting a bone's pull across a mesh.
 *
 * Binding a control point by hand is one point and one dropdown at a time, and `autoBindMesh` does
 * every point at once by a rule. This is the middle, and the one an author reaches for most: the
 * places a guess gets wrong are a REGION — a shoulder, the inside of an elbow — and correcting a
 * region is a stroke rather than a dozen visits to a panel.
 *
 * THE BRUSH ACTS WHERE THE POINTS ARE DRAWN, which for a rigged mesh is not where they are stored.
 * It asks `meshHandles` for their positions — the same call the overlay draws with, handed the same
 * posed scene — so the brush covers the handles the author can see. Deriving the positions here
 * instead would be a second answer to "where is this point", and the two would part company the
 * first time anything about the pose changed.
 *
 * THE DOCUMENT IS THE PREVIEW, as in `RasterTool`: every move commits, coalesced into one history
 * entry, so the deform updates under the stroke and undo takes the whole gesture. An ephemeral
 * overlay of pending weights would be a second source of truth for what the rig is.
 *
 * A STROKE IS A SERIES OF DABS AT THE POINTER, not a swept capsule between samples. A mesh is a
 * grid of at most a few dozen points and the brush is far wider than the gap between two mouse
 * events, so a dab per event covers what a swept one would; `RasterTool` interpolates because it
 * paints PIXELS, where a fast drag really does leave gaps.
 *
 * NO DOM. Like every tool here it takes events and a rect and computes, which is what lets the
 * gesture be driven by fake events in a test.
 */

import { Tool } from "./ToolController";
import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { EditorState, screenToWorld } from "../EditorState";
import { SetMeshAction } from "../../core/actions/SetMeshAction";
import { paintWeights } from "../../core/document/MeshEdit";
import { meshHandles, meshIndexOf } from "../../core/geometry/SelectionHandles";
import { computeGeometry } from "../../core/geometry/GeometryEngine";
import { resolveScene } from "../../core/document/Components";
import { Mesh } from "../../core/document/Mesh";

/** What the tool needs from the panel: which bone, how wide, how hard, and which way. */
export interface WeightBrush {
    bone: string | null;
    radius: number;
    strength: number;
    erasing: boolean;
}

export class WeightTool implements Tool {
    private painting = false;

    constructor(
        private dispatcher: ActionDispatcher,
        private editorState: EditorState,
        private refresh: () => void,
        private brush: () => WeightBrush
    ) { }

    /** The one meshed node this stroke may touch, or null. */
    private target(): string | null {
        const selected = this.editorState.selectedNodeIds;
        if (selected.length !== 1) return null;
        const node = this.dispatcher.getDocument().nodes.get(selected[0]);
        return node?.mesh ? selected[0] : null;
    }

    onMouseDown(e: MouseEvent, canvasRect?: DOMRect): void {
        if (e.button !== 0 || !canvasRect) return;
        if (!this.target() || !this.brush().bone) return;
        this.painting = true;
        e.preventDefault();
        this.dab(e, canvasRect, false);
    }

    onMouseMove(e: MouseEvent, canvasRect?: DOMRect): void {
        if (!this.painting || !canvasRect) return;
        this.dab(e, canvasRect, true);
    }

    onMouseUp(): void {
        this.painting = false;
    }

    /**
     * One dab.
     *
     * `coalesce` is false for the FIRST one and true after, so the whole stroke is a single undo
     * step — the same bargain the rotate handle and the raster brush make. Opening with a
     * coalescing dab would merge this stroke into whatever the author did before it.
     */
    private dab(e: MouseEvent, canvasRect: DOMRect, coalesce: boolean): void {
        const nodeId = this.target();
        const brush = this.brush();
        if (!nodeId || !brush.bone) { this.painting = false; return; }
        const doc = this.dispatcher.getDocument();
        const mesh = doc.nodes.get(nodeId)?.mesh;
        if (!mesh) { this.painting = false; return; }

        // WHERE THE HANDLES ARE, from the call that draws them. `meshHandles` returns them in no
        // guaranteed order, so each is placed by its own index rather than by position in the list.
        const posed = resolveScene(doc);
        const at: { x: number; y: number }[] = new Array(mesh.points.length);
        for (const handle of meshHandles(doc, computeGeometry(doc), [nodeId], posed)) {
            const index = meshIndexOf(handle.handle);
            if (index !== null) at[index] = { x: handle.cx, y: handle.cy };
        }

        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        const next = paintWeights(mesh, at,
            { x: w.x, y: w.y, radius: brush.radius },
            brush.bone,
            brush.erasing ? -brush.strength : brush.strength);
        // BY REFERENCE when the dab touched nothing — a stroke off the side of the mesh must not
        // push an undo entry, and `paintWeights` says so by handing back what it was given.
        if (next === mesh) return;
        this.dispatcher.dispatchAction(
            new SetMeshAction(doc, nodeId, next as Mesh),
            { coalesce });
        this.refresh();
    }
}
