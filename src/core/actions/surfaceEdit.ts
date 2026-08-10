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
import { SelectionMask, restoreUnselected } from "../paint/Selection";

/**
 * An Action applying `edit` to the whole of a raster's surface, or null when it changes nothing.
 *
 * `edit` mutates the buffer in place and returns how many pixels it touched — the shape every
 * whole-surface operation in `core/paint` already has, so a new one needs no adapter.
 *
 * `mask` CONFINES IT TO A SELECTION, and it is applied by putting back what fell outside rather than
 * by asking `edit` to respect it: `edit` is a caller's function, and the only thing this can rely on
 * is that it mutated the buffer. `restoreUnselected` carries the reasoning.
 *
 * A MASK THAT DOES NOT FIT THE SURFACE REFUSES THE WHOLE EDIT. The tempting alternative — ignore it
 * and edit everything — is the worst of the three: an author who selected a corner and pressed
 * "quantise" would have the entire canvas quantised because their selection was stale from a resize.
 * Nothing happening is a bug they can see and undo nothing for.
 */
export function surfaceEditAction(
    doc: ReadonlyDocument, nodeId: string, edit: (buffer: PixelBuffer) => number,
    mask?: SelectionMask | null
): Action | null {
    const node = doc.nodes.get(nodeId);
    // ONLY A RASTER HAS PIXELS. The same rule `PaintSurfaceAction` enforces and — since the surviving
    // mutant that found the hole — `Integrity` does too.
    if (!node || node.type !== "core.raster" || !node.surface) return null;
    const buffer = decodeSurface(node.surface.data, node.surface.width, node.surface.height);
    if (!buffer) return null;
    // CHECKED BEFORE ANYTHING IS EDITED, so a stale selection costs nothing at all rather than an
    // edit that is then thrown away.
    if (mask && (mask.width !== buffer.width || mask.height !== buffer.height)) return null;

    const before = readRegion(buffer, 0, 0, buffer.width, buffer.height);
    if (edit(buffer) === 0) return null;
    // AFTER the edit and BEFORE the diff — the only order that works: restoring first would have
    // nothing to restore, and diffing first would record the pixels this puts back.
    if (mask) restoreUnselected(buffer, before, mask);
    const patch = capturePatch(buffer, before, 0, 0, buffer.width, buffer.height);
    // BOTH CHECKED, unlike the bucket's single guard, because `edit` is a stranger: a caller's
    // function may report a count that its pixels do not support, and the count is the cheap test
    // while the patch is the true one.
    //
    // AND NOW FOR A SECOND REASON, which is the mask: an edit that changed only pixels OUTSIDE the
    // selection reports a truthful non-zero count and leaves an empty patch once they are put back.
    // Without this, quantising with a marquee over an already-quantised corner would add a history
    // entry that undoes nothing.
    if (isEmptyPatch(patch)) return null;
    return new PaintSurfaceAction(doc, nodeId, patch);
}

/** Every pixel of a raster snapped to its nearest palette colour, or null when none moves. */
export function quantizeAction(
    doc: ReadonlyDocument, nodeId: string, palette: Palette, mask?: SelectionMask | null
): Action | null {
    return surfaceEditAction(doc, nodeId, buffer => quantizeToPalette(buffer, palette), mask);
}
