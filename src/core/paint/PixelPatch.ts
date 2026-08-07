/**
 * @module PixelPatch
 * @description What a stroke costs to remember.
 *
 * A 4096-square RGBA surface is 67 MB. Snapshotting it per stroke is the obvious undo and it is
 * unusable: twenty pencil dots would be 1.3 GB, and the dots themselves changed a few hundred bytes.
 * So an edit is stored as the RECTANGLE it touched, with the bytes from before and after.
 *
 * A PATCH IS A VALUE, WHICH IS THE WHOLE POINT. The action layer reverses an edit by applying the
 * inverse of one of these, so painting joins the same dispatcher, transaction and coalescing
 * machinery as every other edit rather than growing a private undo stack beside it.
 *
 * THE BOUNDS ARE MEASURED, NOT DECLARED. A caller says which region it MIGHT have touched — a
 * brush's bounding box — and the capture narrows that to what actually differs. A stroke that
 * changed nothing produces an empty patch, and a tool that overestimates its reach costs nothing
 * for being cautious.
 */

import { PixelBuffer, Rgba } from "./PixelBuffer";

/** A rectangle of changed pixels, with what was there and what replaced it. */
export interface PixelPatch {
    x: number;
    y: number;
    width: number;
    height: number;
    /** `width * height * 4` bytes as they were. */
    before: Uint8ClampedArray;
    /** `width * height * 4` bytes as they became. */
    after: Uint8ClampedArray;
}

/** An edit that changed nothing — a click that missed, or a fill onto its own colour. */
export const EMPTY_PATCH: PixelPatch = {
    x: 0, y: 0, width: 0, height: 0,
    before: new Uint8ClampedArray(0), after: new Uint8ClampedArray(0)
};

/** Whether a patch would change anything if applied. */
export function isEmptyPatch(patch: PixelPatch): boolean {
    return patch.width <= 0 || patch.height <= 0;
}

/** A rectangle clipped to a surface, or null when nothing of it is on the surface. */
function clip(
    buffer: PixelBuffer, x: number, y: number, width: number, height: number
): { x: number; y: number; w: number; h: number } | null {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(buffer.width, Math.ceil(x + width));
    const y1 = Math.min(buffer.height, Math.ceil(y + height));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A rectangle of a surface, copied out. */
export function readRegion(
    buffer: PixelBuffer, x: number, y: number, width: number, height: number
): Uint8ClampedArray {
    const out = new Uint8ClampedArray(Math.max(0, width * height * 4));
    for (let row = 0; row < height; row++) {
        const from = ((y + row) * buffer.width + x) * 4;
        // ROW BY ROW, because a surface's rows are not adjacent in memory unless the region spans
        // its full width. A single `subarray` of the whole span would copy the pixels either side
        // of the rectangle too, and put them back on undo.
        out.set(buffer.data.subarray(from, from + width * 4), row * width * 4);
    }
    return out;
}

/**
 * The difference an edit made, narrowed to the pixels that actually changed.
 *
 * `before` is the region as it was, captured BEFORE the edit ran; `buffer` is the surface after.
 * The declared rectangle is only a hint — the returned patch is the tight bounding box of the
 * pixels that differ, so a brush that reports a generous reach still stores the minimum.
 */
export function capturePatch(
    buffer: PixelBuffer, before: Uint8ClampedArray,
    x: number, y: number, width: number, height: number
): PixelPatch {
    const box = clip(buffer, x, y, width, height);
    if (!box || before.length !== box.w * box.h * 4) return EMPTY_PATCH;

    // The tight bounds of what differs. Starting inverted means "nothing found yet" needs no flag.
    let minX = box.w, minY = box.h, maxX = -1, maxY = -1;
    for (let row = 0; row < box.h; row++) {
        for (let col = 0; col < box.w; col++) {
            const local = (row * box.w + col) * 4;
            const at = ((box.y + row) * buffer.width + box.x + col) * 4;
            if (before[local] !== buffer.data[at] || before[local + 1] !== buffer.data[at + 1]
                || before[local + 2] !== buffer.data[at + 2] || before[local + 3] !== buffer.data[at + 3]) {
                if (col < minX) minX = col;
                if (col > maxX) maxX = col;
                if (row < minY) minY = row;
                if (row > maxY) maxY = row;
            }
        }
    }
    if (maxX < 0) return EMPTY_PATCH;

    const w = maxX - minX + 1, h = maxY - minY + 1;
    const beforeTight = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
        const from = ((minY + row) * box.w + minX) * 4;
        beforeTight.set(before.subarray(from, from + w * 4), row * w * 4);
    }
    return {
        x: box.x + minX, y: box.y + minY, width: w, height: h,
        before: beforeTight,
        after: readRegion(buffer, box.x + minX, box.y + minY, w, h)
    };
}

/** Write one side of a patch onto a surface. */
function write(buffer: PixelBuffer, patch: PixelPatch, bytes: Uint8ClampedArray): void {
    if (isEmptyPatch(patch)) return;
    for (let row = 0; row < patch.height; row++) {
        const to = ((patch.y + row) * buffer.width + patch.x) * 4;
        buffer.data.set(bytes.subarray(row * patch.width * 4, (row + 1) * patch.width * 4), to);
    }
}

/** Apply a patch — the edit it recorded. */
export function applyPatch(buffer: PixelBuffer, patch: PixelPatch): void {
    write(buffer, patch, patch.after);
}

/** Undo a patch — put back what was there. */
export function revertPatch(buffer: PixelBuffer, patch: PixelPatch): void {
    write(buffer, patch, patch.before);
}

/**
 * A patch that does the opposite.
 *
 * Swapping the two sides rather than storing a direction means `applyPatch` has ONE behaviour and
 * redo is `apply(invert(invert(p)))` — the same code path, not a second one that can disagree with
 * it about edges.
 */
export function invertPatch(patch: PixelPatch): PixelPatch {
    return { ...patch, before: patch.after, after: patch.before };
}

/** How many bytes a patch holds, which is what an undo stack is paying per step. */
export function patchCost(patch: PixelPatch): number {
    return patch.before.length + patch.after.length;
}
