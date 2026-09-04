/**
 * @module Selection
 * @description Which pixels an edit is allowed to touch — the hole every other paint feature sits in.
 *
 * A feature audit put this first among the real gaps, and the reason is that almost nothing on the
 * paint side is a feature of its own: crop, cut, copy, paste, "transform this region", "fill only
 * inside here", grow/shrink/border are all the SAME question with different verbs, and the question
 * is which pixels. Canvas Fogworks had no answer at all — `EditorState.marqueeRect` selects NODES.
 *
 * A MASK, NOT A RECTANGLE, and that decision is the whole module. A rectangle cannot express a lasso,
 * a magic wand, or a rectangle minus a bite; and a system that starts with rectangles grows a special
 * case per shape until something has to unify them anyway. One byte per pixel unifies them on day one,
 * and the cost is measured rather than assumed: a 4096-square surface is 16MB of mask against 67MB of
 * RGBA, and the largest surface this engine allows is bounded by the same `PIXEL_MAX_SIDE`.
 *
 * BINARY, NOT ANTIALIASED. A byte per pixel could hold coverage, and for pixel art it must not: a
 * half-selected pixel means a half-applied edit, which in a 32-colour sprite is a colour that is not
 * in the palette. Every value is 0 or `SELECTED`, and the type says so rather than trusting callers.
 *
 * IT IS EDITOR STATE, NOT DOCUMENT STATE. A selection is not content — it is what the author is
 * pointing at — so it does not enter the schema, does not need a migration, and does not travel in a
 * saved file. That is a real decision and it is not the only one possible: Pixelorama persists its
 * `SelectionMap` inside the project. The reason this engine should not is the round-trip rule — a
 * saved document must reopen identically, and a selection that survived a save would make "what does
 * this file mean" depend on where the marquee happened to be.
 */

import { PIXEL_MAX_SIDE, PixelBuffer, PixelClip } from "./PixelBuffer";

/** The only truthy value a mask byte may hold. */
export const SELECTED = 255;

/**
 * A selection over ONE surface, in that surface's own pixels.
 *
 * The dimensions are here rather than inferred from the surface for the reason `RasterSurface`
 * carries its own: a mask captured before a resize and a surface resized after it must not be able to
 * disagree about which is authoritative, and a consumer can then refuse the mismatch outright.
 */
export interface SelectionMask {
    width: number;
    height: number;
    /** `width * height` bytes, row-major. 0 or `SELECTED`, and nothing between. */
    data: Uint8Array;
}

/** How a new shape combines with what is already selected. */
export type SelectionOp = "replace" | "add" | "subtract" | "intersect";

/** What is wrong with a mask, or null. */
export function selectionMaskError(mask: unknown): string | null {
    if (mask === null || typeof mask !== "object") return "a selection must be an object";
    const m = mask as Partial<SelectionMask>;
    for (const [field, value] of [["width", m.width], ["height", m.height]] as const) {
        if (!Number.isInteger(value) || (value as number) < 1) return `selection.${field} must be a whole number >= 1`;
        if ((value as number) > PIXEL_MAX_SIDE) return `selection.${field} must be at most ${PIXEL_MAX_SIDE}`;
    }
    if (!(m.data instanceof Uint8Array)) return "selection.data must be a Uint8Array";
    // THE CHECK THAT MATTERS MOST, and the same one `tilemapError` makes about its grid: a mask whose
    // length disagrees with its own dimensions reads every row after the first from the wrong place,
    // so an edit would be clipped to a sheared version of what the author drew.
    const cells = (m.width as number) * (m.height as number);
    if (m.data.length !== cells) {
        return `selection.data must hold exactly width * height (${cells}) bytes, got ${m.data.length}`;
    }
    return null;
}

/** A mask of the given size with nothing selected. */
export function emptyMask(width: number, height: number): SelectionMask {
    return { width, height, data: new Uint8Array(Math.max(0, width * height)) };
}

/** A mask with every pixel selected — what "select all" means, and the state an edit ignores. */
export function fullMask(width: number, height: number): SelectionMask {
    const mask = emptyMask(width, height);
    mask.data.fill(SELECTED);
    return mask;
}

/** Whether a pixel is selected. Off the mask is NOT selected, so an edit clips at the border. */
export function isSelected(mask: SelectionMask, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
    return mask.data[y * mask.width + x] !== 0;
}

/** Whether nothing at all is selected — which every consumer must read as "no constraint". */
export function isEmptySelection(mask: SelectionMask): boolean {
    return !mask.data.some(v => v !== 0);
}

/** How many pixels are selected, for a status line and for a test that wants one number. */
export function selectedCount(mask: SelectionMask): number {
    let n = 0;
    for (const v of mask.data) if (v !== 0) n++;
    return n;
}

/**
 * The tight box around the selected pixels, or null when nothing is selected.
 *
 * WHAT CROP AND "TRANSFORM THIS REGION" BOTH NEED, and the reason it is here rather than computed by
 * each: two implementations of "the bounds of a mask" would eventually disagree about whether the far
 * edge is inclusive, and a crop one pixel short is a crop that eats the artist's outline.
 *
 * NAMED `maskBounds` RATHER THAN `selectionBounds`, which the geometry engine already uses for the
 * bounds of the selected NODES. Two different questions deserve two names; sharing one would make
 * every call site ambiguous about whether it means pixels or nodes.
 */
export function maskBounds(
    mask: SelectionMask
): { x: number; y: number; width: number; height: number } | null {
    let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1;
    for (let y = 0; y < mask.height; y++) {
        for (let x = 0; x < mask.width; x++) {
            if (mask.data[y * mask.width + x] === 0) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;
    // INCLUSIVE bounds turned into a size, which is where an off-by-one lives: a single selected
    // pixel is a 1x1 box, not a 0x0 one.
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * `into` combined with `shape` under `op`, as a new mask.
 *
 * THE FOUR OPERATORS ARE WHY A SHAPE IS A MASK rather than a rectangle: shift-drag adds, alt-drag
 * subtracts, and both need to work between a lasso and an ellipse. A caller passing a shape of the
 * wrong size gets null rather than a silently sheared combination.
 */
export function combineSelection(
    into: SelectionMask, shape: SelectionMask, op: SelectionOp
): SelectionMask | null {
    if (into.width !== shape.width || into.height !== shape.height) return null;
    const out = emptyMask(into.width, into.height);
    for (let i = 0; i < out.data.length; i++) {
        const had = into.data[i] !== 0;
        const now = shape.data[i] !== 0;
        const keep = op === "replace" ? now
            : op === "add" ? (had || now)
            : op === "subtract" ? (had && !now)
            : (had && now);
        if (keep) out.data[i] = SELECTED;
    }
    return out;
}

/** A rectangle, clipped to the mask size. Either corner may be first. */
export function rectSelection(
    width: number, height: number, a: { x: number; y: number }, b: { x: number; y: number }
): SelectionMask {
    const mask = emptyMask(width, height);
    const x0 = Math.max(0, Math.min(Math.floor(a.x), Math.floor(b.x)));
    const y0 = Math.max(0, Math.min(Math.floor(a.y), Math.floor(b.y)));
    const x1 = Math.min(width - 1, Math.max(Math.floor(a.x), Math.floor(b.x)));
    const y1 = Math.min(height - 1, Math.max(Math.floor(a.y), Math.floor(b.y)));
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) mask.data[y * width + x] = SELECTED;
    }
    return mask;
}

/**
 * An ellipse inscribed in the box between two corners.
 *
 * THE PIXEL CENTRE IS WHAT IS TESTED, which is what keeps a 1x1 drag from selecting nothing: the
 * point `(x + 0.5, y + 0.5)` is inside a box of radius 0.5 exactly, so a single-pixel ellipse is one
 * pixel. Testing the corner instead makes the smallest ellipse empty, and an author dragging out a
 * small circle sees nothing happen.
 */
export function ellipseSelection(
    width: number, height: number, a: { x: number; y: number }, b: { x: number; y: number }
): SelectionMask {
    const mask = emptyMask(width, height);
    const x0 = Math.min(Math.floor(a.x), Math.floor(b.x)), x1 = Math.max(Math.floor(a.x), Math.floor(b.x));
    const y0 = Math.min(Math.floor(a.y), Math.floor(b.y)), y1 = Math.max(Math.floor(a.y), Math.floor(b.y));
    const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
    const rx = (x1 - x0 + 1) / 2, ry = (y1 - y0 + 1) / 2;
    if (rx <= 0 || ry <= 0) return mask;
    for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
            const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
            if (dx * dx + dy * dy <= 1) mask.data[y * width + x] = SELECTED;
        }
    }
    return mask;
}

/**
 * The inside of a polygon — a lasso, and the free-form shape the whole module exists for.
 *
 * EVEN-ODD BY RAY CROSSING, tested at the pixel's CENTRE for the reason the ellipse tests its centre:
 * a boundary that ran through a pixel would otherwise include or exclude it depending on which side
 * of an integer the polygon's edge fell, which is invisible until an author draws a thin shape.
 *
 * The polygon is CLOSED implicitly — a lasso is released wherever the pointer is, and asking the
 * caller to repeat its first point is asking it to forget.
 */
export function lassoSelection(
    width: number, height: number, points: readonly { x: number; y: number }[]
): SelectionMask {
    const mask = emptyMask(width, height);
    if (points.length < 3) return mask;
    for (let y = 0; y < height; y++) {
        const py = y + 0.5;
        for (let x = 0; x < width; x++) {
            const px = x + 0.5;
            let inside = false;
            for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
                const a = points[i], b = points[j];
                // The half-open rule on Y — `>` on one end and `<=` on the other — is what stops a
                // vertex exactly level with the ray being counted twice, which would flip the whole
                // row's parity and stripe the selection.
                if ((a.y > py) === (b.y > py)) continue;
                const t = (py - a.y) / (b.y - a.y);
                if (px < a.x + t * (b.x - a.x)) inside = !inside;
            }
            if (inside) mask.data[y * width + x] = SELECTED;
        }
    }
    return mask;
}

/**
 * Every pixel matching the one at a seed, either four-connected or across the whole surface.
 *
 * BOTH TOOLS FROM ONE FUNCTION: a magic wand is the connected run and "select by colour" is the
 * global one, and they differ by a single flag rather than by an implementation. The connected form
 * is four-connected for the reason the bucket is — a diagonal seam is a wall in pixel art.
 *
 * `same` is injected so the caller decides what "matching" means; `Quantize.colourDistance` with a
 * tolerance and exact equality are both legitimate, and neither belongs baked in here.
 */
export function wandSelection(
    buffer: { width: number; height: number; data: Uint8ClampedArray },
    x: number, y: number,
    same: (a: readonly number[], b: readonly number[]) => boolean,
    contiguous: boolean
): SelectionMask {
    const mask = emptyMask(buffer.width, buffer.height);
    if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return mask;
    const at = (px: number, py: number) => {
        const i = (py * buffer.width + px) * 4;
        return [buffer.data[i], buffer.data[i + 1], buffer.data[i + 2], buffer.data[i + 3]];
    };
    const seed = at(x, y);
    if (!contiguous) {
        for (let py = 0; py < buffer.height; py++) {
            for (let px = 0; px < buffer.width; px++) {
                if (same(at(px, py), seed)) mask.data[py * buffer.width + px] = SELECTED;
            }
        }
        return mask;
    }
    // A QUEUE, NOT RECURSION, for the reason `floodFill` uses one: a 4096-square surface is 16.7
    // million frames deep in the worst case, and every engine gives out long before that.
    const queue: number[] = [x, y];
    mask.data[y * buffer.width + x] = SELECTED;
    while (queue.length > 0) {
        const cy = queue.pop() as number;
        const cx = queue.pop() as number;
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
            // THIS BOUND IS NOT OBSERVABLE IN THE RESULT, and that is worth saying rather than
            // leaving to be re-discovered: a mutant using `width` for the row limit SURVIVES, because
            // a read past the buffer yields `undefined` (so no `same` implementation matches) and a
            // write past a `Uint8Array` is a silent no-op. It is kept because relying on either of
            // those is relying on a coincidence — the next `same` a caller writes may well treat two
            // undefined alphas as equal.
            if (nx < 0 || ny < 0 || nx >= buffer.width || ny >= buffer.height) continue;
            const key = ny * buffer.width + nx;
            if (mask.data[key] !== 0) continue;
            if (!same(at(nx, ny), seed)) continue;
            // MARKED WHEN PUSHED, so a pixel reached from two directions is queued once — the same
            // rule `fillRegion` states, and the difference between a frontier and the whole area.
            mask.data[key] = SELECTED;
            queue.push(nx, ny);
        }
    }
    return mask;
}

/**
 * A selection grown or shrunk by `by` pixels, four-connected per step.
 *
 * ONE FUNCTION FOR BOTH DIRECTIONS, because shrinking is growing the INVERSE: a special case for each
 * is two chances to get the border wrong at the surface edge. A negative `by` shrinks.
 *
 * THE SURFACE EDGE IS TREATED AS SELECTED WHILE SHRINKING, which is a decision worth stating: without
 * it, shrinking a full selection would eat a ring off the outside, so "select all, shrink by 1" would
 * leave a border nobody asked to lose.
 */
export function growSelection(mask: SelectionMask, by: number): SelectionMask {
    const steps = Math.abs(Math.round(by));
    if (steps === 0) return { width: mask.width, height: mask.height, data: mask.data.slice() };
    const shrinking = by < 0;
    let current = mask.data;
    for (let step = 0; step < steps; step++) {
        const next = new Uint8Array(current.length);
        for (let y = 0; y < mask.height; y++) {
            for (let x = 0; x < mask.width; x++) {
                const i = y * mask.width + x;
                const inside = (px: number, py: number): boolean => {
                    if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return shrinking;
                    return current[py * mask.width + px] !== 0;
                };
                const self = current[i] !== 0;
                const neighbours = inside(x + 1, y) && inside(x - 1, y) && inside(x, y + 1) && inside(x, y - 1);
                const any = self || inside(x + 1, y) || inside(x - 1, y) || inside(x, y + 1) || inside(x, y - 1);
                if (shrinking ? (self && neighbours) : any) next[i] = SELECTED;
            }
        }
        current = next;
    }
    return { width: mask.width, height: mask.height, data: current };
}

/**
 * The `by`-pixel band along the edge of a selection — what it has and its shrunk self does not.
 *
 * Derived from `growSelection` rather than walked separately, so "border" and "shrink" cannot
 * disagree about where the edge is.
 *
 * THE BORDER OF A FULL SELECTION IS THEREFORE EMPTY, and that is a consequence rather than a choice
 * — found by clicking Select All and then Border in the running app. Shrinking treats the surface
 * edge as selected (so "select all, shrink" does not eat a ring nobody asked to lose), which makes a
 * full selection shrink to itself, which leaves this nothing to report. The alternative would be a
 * second shrink that does NOT hold the edge, used only here; one rule with a documented consequence
 * beats two rules that will eventually disagree about a corner.
 */
export function borderSelection(mask: SelectionMask, by: number): SelectionMask {
    const inner = growSelection(mask, -Math.abs(Math.round(by)));
    const out = emptyMask(mask.width, mask.height);
    for (let i = 0; i < out.data.length; i++) {
        if (mask.data[i] !== 0 && inner.data[i] === 0) out.data[i] = SELECTED;
    }
    return out;
}

/**
 * The mask as the predicate the paint primitives take, or undefined when it constrains nothing.
 *
 * ONE PLACE DECIDES WHAT AN EMPTY SELECTION MEANS, and it is here. "Nothing selected" has to read as
 * "no constraint" — an author who has never drawn a marquee must be able to paint — and if each
 * consumer answered that for itself, one of them would eventually clip everything to nothing. So the
 * conversion returns UNDEFINED for an empty mask, and `undefined` is exactly what every clip parameter
 * treats as unconstrained.
 */
export function selectionClip(mask: SelectionMask | null | undefined): PixelClip | undefined {
    if (!mask || isEmptySelection(mask)) return undefined;
    return (x, y) => isSelected(mask, x, y);
}

/**
 * Put back every pixel a whole-surface edit changed OUTSIDE the selection. Returns how many it undid.
 *
 * THE ONE PLACE A MASK IS HONOURED AFTER THE FACT, and it exists because a whole-surface edit —
 * quantise, an adjustment, anything `surfaceEditAction` is handed — is a STRANGER'S FUNCTION. A clip
 * predicate can be threaded through code this project owns; it cannot be threaded through a callback
 * whose only contract is "mutate the buffer and say how many you touched". Restoring afterwards is
 * exact for the same reason a patch is: `before` holds the bytes that were there.
 *
 * IT RESTORES THE BUFFER, NOT THE PATCH, so the tool's live copy keeps agreeing with the document. A
 * version that clipped only the dispatched patch would leave the caller holding a buffer showing paint
 * the document never received, and the next edit would build on it.
 *
 * `before` is a WHOLE-SURFACE region as `readRegion(buffer, 0, 0, w, h)` returns it. A mask or a
 * before-image whose size disagrees with the buffer restores nothing rather than shearing rows.
 */
export function restoreUnselected(
    buffer: PixelBuffer, before: Uint8ClampedArray, mask: SelectionMask
): number {
    if (mask.width !== buffer.width || mask.height !== buffer.height) return 0;
    if (before.length !== buffer.data.length) return 0;
    let undone = 0;
    for (let i = 0; i < mask.data.length; i++) {
        if (mask.data[i] !== 0) continue;
        const at = i * 4;
        // COUNTED BY PIXEL, NOT BY BYTE, and only where something actually differs: an edit that
        // never touched the unselected half must report zero restored, or a caller cannot tell "the
        // mask did work" from "the mask was there".
        if (buffer.data[at] === before[at] && buffer.data[at + 1] === before[at + 1]
            && buffer.data[at + 2] === before[at + 2] && buffer.data[at + 3] === before[at + 3]) continue;
        buffer.data[at] = before[at];
        buffer.data[at + 1] = before[at + 1];
        buffer.data[at + 2] = before[at + 2];
        buffer.data[at + 3] = before[at + 3];
        undone++;
    }
    return undone;
}

/** The complement — every pixel the mask does not hold. */
export function invertSelection(mask: SelectionMask): SelectionMask {
    const out = emptyMask(mask.width, mask.height);
    for (let i = 0; i < out.data.length; i++) if (mask.data[i] === 0) out.data[i] = SELECTED;
    return out;
}
