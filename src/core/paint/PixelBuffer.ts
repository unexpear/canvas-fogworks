/**
 * @module PixelBuffer
 * @description A surface VDE authored, rather than one it borrowed.
 *
 * Every node type this engine has is composed from geometry or references an image someone else
 * made. Nothing holds pixels the user put there, which is why no amount of import work adds up to
 * pixel art: a sprite editor's whole subject is a buffer you can change one dot at a time.
 *
 * THE OPERATIONS ARE PURE FUNCTIONS OVER A BUFFER, not methods on a canvas. A `CanvasRenderingContext2D`
 * would do all of this and could not be unit-tested, could not be undone, and could not be replayed
 * — and the action layer needs exactly those three. Keeping the arithmetic here means a stroke is a
 * value, and a value is something the document can hold and the dispatcher can reverse.
 *
 * PREMULTIPLICATION IS DELIBERATELY ABSENT. These are straight RGBA bytes, the same shape
 * `ImageData` uses, so handing a buffer to the platform is a copy rather than a conversion. The
 * renderer already learned that lesson in the other direction — blurring straight RGBA fringes —
 * but blurring is a filter over neighbours and painting is not, so the pressure runs the other way.
 */

/** Bounds on a surface. A 4096-square RGBA buffer is 67 MB, which is already a lot to undo. */
export const PIXEL_MAX_SIDE = 4096;

/** Flood fill's work queue, bounded so a pathological region cannot exhaust memory. */
export const PIXEL_FILL_MAX = PIXEL_MAX_SIDE * PIXEL_MAX_SIDE;

/** A straight-RGBA surface, row-major, four bytes per pixel. */
export interface PixelBuffer {
    width: number;
    height: number;
    /** `width * height * 4` bytes, R,G,B,A per pixel, NOT premultiplied. */
    data: Uint8ClampedArray;
}

/** One colour, 0..255 per channel. */
export type Rgba = [number, number, number, number];

/** What went wrong, or null. */
export function pixelBufferError(width: unknown, height: unknown): string | null {
    if (!Number.isInteger(width) || !Number.isInteger(height)) return "a surface must have whole dimensions";
    const w = width as number, h = height as number;
    if (w < 1 || h < 1) return "a surface must be at least one pixel";
    if (w > PIXEL_MAX_SIDE || h > PIXEL_MAX_SIDE) return `a surface may not exceed ${PIXEL_MAX_SIDE} on a side`;
    return null;
}

/** A transparent surface. Throws on anything `pixelBufferError` refuses. */
export function createPixelBuffer(width: number, height: number): PixelBuffer {
    const bad = pixelBufferError(width, height);
    if (bad) throw new Error(`Invalid surface: ${bad}.`);
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/**
 * Whether `(x, y)` is on the surface.
 *
 * THE X CHECK IS NOT OPTIONAL AND IS NOT IMPLIED BY THE INDEX. `(y * width + x) * 4` is a valid
 * offset for an x of -1 or of `width` — it simply lands on the previous or next ROW. A plot that
 * only bounds the total index therefore draws a stray column down the opposite edge whenever a
 * stroke runs off the side, which reads as a rendering artefact rather than as missing arithmetic.
 */
export function inBounds(buffer: PixelBuffer, x: number, y: number): boolean {
    return x >= 0 && x < buffer.width && y >= 0 && y < buffer.height;
}

/** The colour at `(x, y)`, or null when it is off the surface. */
export function getPixel(buffer: PixelBuffer, x: number, y: number): Rgba | null {
    if (!inBounds(buffer, x, y)) return null;
    const at = (y * buffer.width + x) * 4;
    return [buffer.data[at], buffer.data[at + 1], buffer.data[at + 2], buffer.data[at + 3]];
}

/**
 * Paint one pixel, replacing whatever was there.
 *
 * REPLACE RATHER THAN BLEND, because a pixel editor's eraser is the same operation as its pencil
 * with a transparent colour. A blending plot cannot erase — painting `alpha: 0` over an opaque
 * pixel leaves it opaque — and every editor that blends by default grows a separate eraser path
 * that then disagrees with the pencil about edges.
 */
export function setPixel(buffer: PixelBuffer, x: number, y: number, colour: Rgba): void {
    if (!inBounds(buffer, x, y)) return;
    const at = (y * buffer.width + x) * 4;
    buffer.data[at] = colour[0];
    buffer.data[at + 1] = colour[1];
    buffer.data[at + 2] = colour[2];
    buffer.data[at + 3] = colour[3];
}

/**
 * A line of pixels from one point to another, as Bresenham walks it.
 *
 * INTEGER ONLY, and that is the point rather than an economy. Stepping `y += dy/dx` and rounding
 * accumulates float error into a line that wobbles by a pixel at some angles and not others — which
 * on a 16-pixel sprite is the difference between a clean diagonal and a visibly broken one. The
 * error term here is exact.
 *
 * The returned points are in order from `x0,y0`, and both ends are INCLUSIVE: a stroke from a point
 * to itself is one pixel, not none, because that is what a click with a pencil means.
 */
export function linePoints(x0: number, y0: number, x1: number, y1: number): [number, number][] {
    const points: [number, number][] = [];
    let x = Math.round(x0), y = Math.round(y0);
    const tx = Math.round(x1), ty = Math.round(y1);
    const dx = Math.abs(tx - x), dy = -Math.abs(ty - y);
    const sx = x < tx ? 1 : -1, sy = y < ty ? 1 : -1;
    let err = dx + dy;
    // Bounded by the span rather than trusted to terminate: a NaN endpoint would otherwise spin.
    const limit = dx - dy + 2;
    for (let i = 0; i <= limit; i++) {
        points.push([x, y]);
        if (x === tx && y === ty) break;
        // THE ERROR IS DOUBLED BEFORE COMPARING, which is what keeps this integer. Halving the
        // error instead would reintroduce the rounding this exists to avoid.
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
    }
    return points;
}

/** Paint a line. */
export function drawLine(
    buffer: PixelBuffer, x0: number, y0: number, x1: number, y1: number, colour: Rgba
): void {
    for (const [x, y] of linePoints(x0, y0, x1, y1)) setPixel(buffer, x, y, colour);
}

/** Whether two colours are the same, which is what a fill spreads across. */
function sameColour(a: Rgba, b: Rgba): boolean {
    // ALPHA COUNTS. Two fully transparent pixels with different RGB are the same pixel to a viewer,
    // but treating them as different stops a fill crossing a region an earlier erase left behind —
    // so transparency is compared as one colour rather than four channels.
    if (a[3] === 0 && b[3] === 0) return true;
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * Flood fill from a seed, four-connected.
 *
 * A QUEUE, NOT RECURSION. The obvious implementation calls itself per neighbour, and a fill across
 * a 4096-square surface is 16.7 million deep — every JavaScript engine gives out long before that,
 * and it does so as a stack overflow in the middle of a user's stroke.
 *
 * FOUR-CONNECTED rather than eight, because a diagonal seam is a WALL in pixel art. An
 * eight-connected fill leaks through the corner where two diagonal lines touch, which is precisely
 * the join an artist uses to enclose a shape.
 *
 * Returns how many pixels changed, so a caller can tell a fill that did nothing from one that did.
 */
export function floodFill(buffer: PixelBuffer, x: number, y: number, colour: Rgba): number {
    const start = getPixel(buffer, x, y);
    if (!start) return 0;
    // FILLING WITH THE COLOUR ALREADY THERE would never terminate on its own — every pixel it
    // painted would still match the seed and be queued again by its neighbours.
    if (sameColour(start, colour)) return 0;

    const queue: number[] = [x, y];
    let filled = 0;
    // `seen` is indexed by pixel rather than by coordinate pair, so membership is one lookup and
    // the whole surface costs one byte per pixel instead of a growing set of strings.
    const seen = new Uint8Array(buffer.width * buffer.height);
    seen[y * buffer.width + x] = 1;
    while (queue.length > 0 && filled < PIXEL_FILL_MAX) {
        const cy = queue.pop() as number;
        const cx = queue.pop() as number;
        const here = getPixel(buffer, cx, cy);
        if (!here || !sameColour(here, start)) continue;
        setPixel(buffer, cx, cy, colour);
        filled++;
        const neighbours: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (const [nx, ny] of neighbours) {
            if (!inBounds(buffer, nx, ny)) continue;
            const key = ny * buffer.width + nx;
            if (seen[key]) continue;
            seen[key] = 1;
            queue.push(nx, ny);
        }
    }
    return filled;
}
