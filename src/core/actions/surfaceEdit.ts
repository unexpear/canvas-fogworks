/**
 * @module surfaceEdit
 * @description Whole-surface pixel edits as Actions — the door for the ones a panel triggers.
 *
 * A brush and a bucket are GESTURES and live in `editor/tools`; quantising a canvas is a BUTTON, and
 * a button in a panel has nowhere testable to put its arithmetic. So it goes here, beside
 * `tileImport`, for the same two reasons that one exists: a function returning an Action can be
 * tested, and `App.tsx` should not be where the sequence "decode, edit, diff, dispatch" is written
 * out by hand for the third time.
 *
 * THE SEQUENCE IS THE WHOLE DIFFICULTY, and it is invisible afterwards because the picture is right
 * either way — only the undo is broken. Capture the region BEFORE anything is edited, edit, then diff:
 * a capture taken afterwards records no change at all, and `capturePatch` narrows a whole-surface
 * before-image down to the pixels that actually moved, so quantising a canvas whose colours are
 * already in the palette costs nothing to store.
 *
 * NULL MEANS NOTHING CHANGED, as everywhere else in this codebase: an action that succeeded without
 * changing anything leaves a step on the undo stack that undoes nothing, so a person pressing undo
 * once appears to be ignored.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { PaintSurfaceAction } from "./PaintSurfaceAction";
import { decodeSurface } from "../paint/PixelCodec";
import { capturePatch, readRegion, isEmptyPatch } from "../paint/PixelPatch";
import { PixelBuffer } from "../paint/PixelBuffer";
import { Palette } from "../paint/Palette";
import { quantizeToPalette } from "../paint/Quantize";

/**
 * An Action applying `edit` to the whole of a raster's surface, or null when it changes nothing.
 *
 * `edit` mutates the buffer in place and returns how many pixels it touched — the shape every
 * whole-surface operation in `core/paint` already has, so a new one needs no adapter.
 */
export function surfaceEditAction(
    doc: ReadonlyDocument, nodeId: string, edit: (buffer: PixelBuffer) => number
): Action | null {
    const node = doc.nodes.get(nodeId);
    // ONLY A RASTER HAS PIXELS. The same rule `PaintSurfaceAction` enforces and — since the surviving
    // mutant that found the hole — `Integrity` does too.
    if (!node || node.type !== "core.raster" || !node.surface) return null;
    const buffer = decodeSurface(node.surface.data, node.surface.width, node.surface.height);
    if (!buffer) return null;

    const before = readRegion(buffer, 0, 0, buffer.width, buffer.height);
    if (edit(buffer) === 0) return null;
    const patch = capturePatch(buffer, before, 0, 0, buffer.width, buffer.height);
    // BOTH CHECKED, unlike the bucket's single guard, because `edit` is a stranger: a caller's
    // function may report a count that its pixels do not support, and the count is the cheap test
    // while the patch is the true one.
    if (isEmptyPatch(patch)) return null;
    return new PaintSurfaceAction(doc, nodeId, patch);
}

/** Every pixel of a raster snapped to its nearest palette colour, or null when none moves. */
export function quantizeAction(doc: ReadonlyDocument, nodeId: string, palette: Palette): Action | null {
    return surfaceEditAction(doc, nodeId, buffer => quantizeToPalette(buffer, palette));
}
