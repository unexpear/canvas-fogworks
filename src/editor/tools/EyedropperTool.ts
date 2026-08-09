/**
 * @module EyedropperTool
 * @description The click that takes a colour off the canvas and puts it in your hand.
 *
 * A CLICK, NOT A DRAG. Every other tool here is a gesture with a beginning and an end; this one
 * answers on the press and is finished. Sampling continuously while the button is down is what
 * paint programs do to let you hunt for a shade, and it is worth having — but a drag that keeps
 * changing the colour also keeps changing what the NEXT stroke will be, and there is no preview
 * here to show that yet. One press, one colour, nothing to undo.
 *
 * IT WRITES NOTHING TO THE DOCUMENT, which is why there is no action and no history entry. The
 * picked colour goes to the same place the swatch does — it changes what a future stroke will be,
 * not what the picture is. Undo would have nothing to reverse.
 *
 * A MISS DOES NOTHING. Over empty canvas, over `fill: "none"`, over a transparent pixel, or over a
 * `core.image` whose pixels the pure core never decoded, `pickColorAt` answers null and this leaves
 * the colour alone. Substituting black would be worse than missing: the author finds out two
 * strokes later, having already painted with it.
 */

import { Tool } from "./ToolController";
import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { EditorState, screenToWorld } from "../EditorState";
import { computeGeometry } from "../../core/geometry/GeometryEngine";
import { resolveScene } from "../../core/document/Components";
import { pickColorAt } from "../../core/geometry/Eyedropper";

export class EyedropperTool implements Tool {
    constructor(
        private dispatcher: ActionDispatcher,
        private editorState: EditorState,
        private refresh: () => void,
        private setColour: (hex: string) => void
    ) { }

    onMouseDown(e: MouseEvent, canvasRect?: DOMRect): void {
        if (e.button !== 0 || !canvasRect) return;
        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        // THE RESOLVED SCENE, because that is what is on screen: an instance's copies exist only
        // there, and a warped or skinned node is a path by then. Picking from the stored document
        // would miss every one of those, and miss them silently.
        const doc = resolveScene(this.dispatcher.getDocument());
        const hex = pickColorAt(doc, computeGeometry(doc), w.x, w.y);
        if (hex === null) return;
        e.preventDefault();
        this.setColour(hex);
        this.refresh();
    }
}
