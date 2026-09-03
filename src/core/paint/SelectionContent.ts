/**
 * @module SelectionContent
 * @description Copy, clear, paste, move and lossless transforms for a pixel selection.
 */

import { PixelBuffer } from "./PixelBuffer";
import { SelectionMask, SELECTED, emptyMask, isSelected, maskBounds } from "./Selection";

export interface PixelSelectionClipboard {
    width: number;
    height: number;
    /** RGBA bytes in the selection's tight bounds. Bytes outside the mask are transparent. */
    data: Uint8ClampedArray;
    /** Tight, local mask; preserves holes made by lasso/subtract selections. */
    mask: Uint8Array;
    /** Original surface position, used by paste and as the transform anchor. */
    originX: number;
    originY: number;
}

export type PixelSelectionTransform = "flip-horizontal" | "flip-vertical" | "rotate-clockwise";

function fits(buffer: PixelBuffer, mask: SelectionMask): boolean {
    return buffer.width === mask.width && buffer.height === mask.height;
}

/** Copy the selected pixels into a tight payload, preserving transparent pixels and mask holes. */
export function copySelectionContent(buffer: PixelBuffer, mask: SelectionMask): PixelSelectionClipboard | null {
    if (!fits(buffer, mask)) return null;
    const bounds = maskBounds(mask);
    if (!bounds) return null;
    const data = new Uint8ClampedArray(bounds.width * bounds.height * 4);
    const localMask = new Uint8Array(bounds.width * bounds.height);
    for (let y = 0; y < bounds.height; y++) {
        for (let x = 0; x < bounds.width; x++) {
            const sx = bounds.x + x, sy = bounds.y + y;
            if (!isSelected(mask, sx, sy)) continue;
            const source = (sy * buffer.width + sx) * 4;
            const target = (y * bounds.width + x) * 4;
            data.set(buffer.data.subarray(source, source + 4), target);
            localMask[y * bounds.width + x] = SELECTED;
        }
    }
    return { width: bounds.width, height: bounds.height, data, mask: localMask,
        originX: bounds.x, originY: bounds.y };
}

function clearPixel(buffer: PixelBuffer, x: number, y: number): number {
    const at = (y * buffer.width + x) * 4;
    const changed = buffer.data[at] !== 0 || buffer.data[at + 1] !== 0
        || buffer.data[at + 2] !== 0 || buffer.data[at + 3] !== 0;
    if (changed) buffer.data.fill(0, at, at + 4);
    return changed ? 1 : 0;
}

/** Make selected pixels transparent. Returns the number whose bytes actually changed. */
export function clearSelectionContent(buffer: PixelBuffer, mask: SelectionMask): number {
    if (!fits(buffer, mask)) return 0;
    let changed = 0;
    for (let y = 0; y < buffer.height; y++) for (let x = 0; x < buffer.width; x++) {
        if (isSelected(mask, x, y)) changed += clearPixel(buffer, x, y);
    }
    return changed;
}

/** Paste a payload at a surface position. Off-canvas pixels are clipped, never wrapped. */
export function pasteSelectionContent(
    buffer: PixelBuffer,
    content: PixelSelectionClipboard,
    x = content.originX,
    y = content.originY
): { changed: number; mask: SelectionMask } {
    const mask = emptyMask(buffer.width, buffer.height);
    let changed = 0;
    for (let sy = 0; sy < content.height; sy++) for (let sx = 0; sx < content.width; sx++) {
        if (content.mask[sy * content.width + sx] === 0) continue;
        const dx = x + sx, dy = y + sy;
        if (dx < 0 || dy < 0 || dx >= buffer.width || dy >= buffer.height) continue;
        const source = (sy * content.width + sx) * 4;
        const target = (dy * buffer.width + dx) * 4;
        if (buffer.data[target] !== content.data[source]
            || buffer.data[target + 1] !== content.data[source + 1]
            || buffer.data[target + 2] !== content.data[source + 2]
            || buffer.data[target + 3] !== content.data[source + 3]) {
            buffer.data.set(content.data.subarray(source, source + 4), target);
            changed++;
        }
        mask.data[dy * mask.width + dx] = SELECTED;
    }
    return { changed, mask };
}

/** Move selected content by an integer offset, clearing its old pixels before the snapshot is pasted. */
export function moveSelectionContent(
    buffer: PixelBuffer, mask: SelectionMask, dx: number, dy: number
): { changed: number; mask: SelectionMask } | null {
    const content = copySelectionContent(buffer, mask);
    if (!content) return null;
    const cleared = clearSelectionContent(buffer, mask);
    const pasted = pasteSelectionContent(buffer, content,
        content.originX + Math.round(dx), content.originY + Math.round(dy));
    return { changed: cleared + pasted.changed, mask: pasted.mask };
}

/** Transform the tight clipboard payload without interpolation. */
export function transformSelectionClipboard(
    content: PixelSelectionClipboard, transform: PixelSelectionTransform
): PixelSelectionClipboard {
    const rotated = transform === "rotate-clockwise";
    const width = rotated ? content.height : content.width;
    const height = rotated ? content.width : content.height;
    const data = new Uint8ClampedArray(width * height * 4);
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < content.height; y++) for (let x = 0; x < content.width; x++) {
        let nx = x, ny = y;
        if (transform === "flip-horizontal") nx = content.width - 1 - x;
        else if (transform === "flip-vertical") ny = content.height - 1 - y;
        else { nx = content.height - 1 - y; ny = x; }
        const source = (y * content.width + x) * 4;
        const target = (ny * width + nx) * 4;
        data.set(content.data.subarray(source, source + 4), target);
        mask[ny * width + nx] = content.mask[y * content.width + x];
    }
    return { width, height, data, mask, originX: content.originX, originY: content.originY };
}

/** Clear, transform and paste a selection in place at the tight bounds' top-left. */
export function transformSelectionContent(
    buffer: PixelBuffer, mask: SelectionMask, transform: PixelSelectionTransform
): { changed: number; mask: SelectionMask } | null {
    const content = copySelectionContent(buffer, mask);
    if (!content) return null;
    const cleared = clearSelectionContent(buffer, mask);
    const pasted = pasteSelectionContent(buffer, transformSelectionClipboard(content, transform));
    return { changed: cleared + pasted.changed, mask: pasted.mask };
}
