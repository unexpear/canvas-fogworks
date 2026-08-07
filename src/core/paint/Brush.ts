/**
 * @module Brush
 * @description The shape a pencil leaves, and dragging it along a path.
 *
 * `setPixel` paints one dot; a pencil paints a disc, and a drag paints one per mouse sample. Both
 * are arithmetic over a buffer, so both belong here rather than in a tool that owns a DOM event.
 *
 * A BRUSH IS A SET OF OFFSETS, computed once. Recomputing the disc per stamp would do the same
 * circle test thousands of times across one stroke, and the offsets are what a stamp actually
 * needs — an alternative that returned a mask would make every stamp scan the empty corners too.
 *
 * EVEN DIAMETERS HAVE NO CENTRE PIXEL, and pretending otherwise is the classic pixel-art
 * frustration: a 2px brush that lands 1px up-left of the cursor at some sizes and centred at
 * others. The rule here is that the offsets are symmetric about the cursor for ODD sizes and
 * biased consistently down-right for EVEN ones, so a brush never drifts as its size changes.
 */

import { PixelBuffer, Rgba, setPixel } from "./PixelBuffer";

/** The widest brush this builds. Beyond this a "brush" is a fill with extra steps. */
export const BRUSH_MAX_SIZE = 256;

/**
 * One dab of a brush: where, and optionally what colour.
 *
 * A NULL COLOUR MEANS "use the stroke's colour", which is what a shape brush wants. A stamp read
 * from an image carries its own, which is what makes a grass or star brush a picture rather than a
 * silhouette — measured from Pixelorama, which ships exactly those as PNGs.
 */
export interface BrushDab {
    dx: number;
    dy: number;
    colour: Rgba | null;
}

/**
 * A brush: a set of dabs, and the box they occupy.
 *
 * NOT SQUARE. `width` and `height` are separate because single-axis brushes are a real pixel-art
 * tool — Pixelorama ships a 3x1 and a 1x3 — and a single `size` cannot express either.
 */
export interface Brush {
    width: number;
    height: number;
    /** True only for a brush built by `makeBrush` as a disc; a stamp is neither. */
    round: boolean;
    dabs: BrushDab[];
    /**
     * Other faces of the SAME brush, chosen at random per stamp.
     *
     * Pixelorama marks these with a `~` filename prefix — `~Grass1..5` is one brush with five
     * faces — and it is what makes scattered foliage look natural rather than tiled. Empty for a
     * brush with only one face; `this` is always face zero.
     */
    variants: Brush[];
}

/** What went wrong, or null. */
export function brushError(size: unknown, round: unknown): string | null {
    if (!Number.isInteger(size)) return "a brush size must be a whole number of pixels";
    const n = size as number;
    if (n < 1) return "a brush must be at least one pixel";
    if (n > BRUSH_MAX_SIZE) return `a brush may not exceed ${BRUSH_MAX_SIZE} pixels`;
    if (typeof round !== "boolean") return "a brush must state whether it is round";
    return null;
}

/**
 * A brush of `size` pixels across.
 *
 * Throws on anything `brushError` refuses.
 *
 * THE DISC TEST USES THE PIXEL'S CENTRE, not its corner. Testing the corner produces a circle
 * visibly flattened on two sides — the shape looks like a rounded square at small sizes, which is
 * exactly where a pixel artist can count the dots.
 */
export function makeBrush(size: number, round: boolean): Brush {
    const bad = brushError(size, round);
    if (bad) throw new Error(`Invalid brush: ${bad}.`);
    const offsets: [number, number][] = [];
    // For an ODD size the cursor pixel is the centre and the arm each way is (size-1)/2. For an
    // EVEN one there is no centre, so the span runs from -(size/2 - 1) to +size/2 — biased
    // down-right, consistently, at every even size.
    // `0 - x` rather than `-x`: negating a floor of zero yields NEGATIVE zero, which would sit in
    // the offsets of every 1px brush. It indexes identically, but it survives serialisation and
    // fails `Object.is` against 0 — a wart that shows up far from here as a brush that "isn't" at
    // the origin.
    const lo = 0 - Math.floor((size - 1) / 2);
    const hi = lo + size - 1;
    const dabs: BrushDab[] = [];
    // Radius measured from the span's true middle, which for an even size sits on a pixel BOUNDARY.
    const centre = (lo + hi) / 2;
    const radius = size / 2;
    for (let dy = lo; dy <= hi; dy++) {
        for (let dx = lo; dx <= hi; dx++) {
            if (round) {
                const ox = dx - centre, oy = dy - centre;
                // Squared, rather than a square root: the same comparison without the float error.
                //
                // NO FUDGE CONSTANT. An earlier version subtracted 0.25 to force a 3px round brush
                // into a plus sign, because that is what some editors draw — but geometrically a
                // disc of diameter 3 DOES contain all nine pixel centres, the corner sitting at
                // 1.414 against a radius of 1.5. The plus is an artistic convention, and tuning a
                // constant until the shape matched a preconception is how a rule stops being one.
                // ROUND therefore starts differing from square at size 4, where the corner is at
                // 2.12 against a radius of 2.
                if (ox * ox + oy * oy > radius * radius) continue;
            }
            // A SHAPE brush carries no colour of its own — the stroke supplies it.
            dabs.push({ dx, dy, colour: null });
        }
    }
    return { width: size, height: size, round, dabs, variants: [] };
}

/**
 * A brush from an image — a STAMP, which is a picture rather than a silhouette.
 *
 * Fully transparent pixels are dropped rather than stamped, because an image brush's rectangle is
 * mostly empty and painting its transparent corners would erase whatever the stamp was placed over.
 * That is the difference between a stamp and a rubber.
 *
 * The origin is the image's CENTRE, by the same rule `makeBrush` uses, so swapping a shape brush
 * for a stamp of the same size does not move where it lands.
 */
export function brushFromImage(buffer: PixelBuffer): Brush {
    const dabs: BrushDab[] = [];
    const lox = 0 - Math.floor((buffer.width - 1) / 2);
    const loy = 0 - Math.floor((buffer.height - 1) / 2);
    for (let y = 0; y < buffer.height; y++) {
        for (let x = 0; x < buffer.width; x++) {
            const at = (y * buffer.width + x) * 4;
            if (buffer.data[at + 3] === 0) continue;
            dabs.push({
                dx: lox + x, dy: loy + y,
                colour: [buffer.data[at], buffer.data[at + 1], buffer.data[at + 2], buffer.data[at + 3]]
            });
        }
    }
    return { width: buffer.width, height: buffer.height, round: false, dabs, variants: [] };
}

/** One brush with several faces, chosen at random per stamp. */
export function brushWithVariants(faces: readonly Brush[]): Brush | null {
    if (faces.length === 0) return null;
    return { ...faces[0], variants: faces.slice(1).map(f => ({ ...f, variants: [] })) };
}

/**
 * The face a stamp should use.
 *
 * RANDOMNESS IS INJECTED, not taken from `Math.random`. A stroke has to be replayable — the same
 * drag must produce the same marks when an action is re-applied, or undo and redo would disagree
 * about what was painted.
 */
export function pickFace(brush: Brush, roll: number): Brush {
    if (brush.variants.length === 0) return brush;
    const faces = [brush, ...brush.variants];
    const i = Math.min(faces.length - 1, Math.max(0, Math.floor(roll * faces.length)));
    return faces[i];
}

/** Stamp a brush once, centred on `(x, y)`. */
export function stampBrush(buffer: PixelBuffer, brush: Brush, x: number, y: number, colour: Rgba): void {
    const cx = Math.round(x), cy = Math.round(y);
    // `setPixel` bounds each dot itself, so a stamp near an edge is clipped rather than wrapped —
    // the same guard, not a second copy of it that could disagree.
    // A dab's OWN colour wins when it has one: that is what makes a stamp a picture.
    for (const d of brush.dabs) setPixel(buffer, cx + d.dx, cy + d.dy, d.colour ?? colour);
}

/**
 * The bounding box a stamp at `(x, y)` would touch, unclipped.
 *
 * Reported so a caller can hand `capturePatch` a region without guessing. It is deliberately NOT
 * clipped to the surface: the patch layer clips, and doing it twice in two places is how the two
 * end up disagreeing by a pixel.
 */
export function brushBounds(
    brush: Brush, x: number, y: number
): { x: number; y: number; width: number; height: number } {
    const lox = 0 - Math.floor((brush.width - 1) / 2);
    const loy = 0 - Math.floor((brush.height - 1) / 2);
    // THE BOX SPANS EVERY VARIANT, because a stamp may pick any face and a patch captured for one
    // face would leave another's marks outside the region it can undo.
    let w = brush.width, h = brush.height;
    for (const v of brush.variants) { w = Math.max(w, v.width); h = Math.max(h, v.height); }
    return { x: Math.round(x) + lox, y: Math.round(y) + loy, width: w, height: h };
}

/**
 * Drag a brush along a path of points.
 *
 * THE GAPS BETWEEN SAMPLES ARE FILLED, which is the difference between a stroke and a dotted line.
 * A pointer at 60 Hz moving quickly reports positions tens of pixels apart, so stamping only at the
 * reported points draws beads — every painting program interpolates, and the interpolation is
 * Bresenham so it matches the line tool exactly rather than approximately.
 */
export function strokePath(
    buffer: PixelBuffer, brush: Brush, points: readonly [number, number][], colour: Rgba,
    line: (x0: number, y0: number, x1: number, y1: number) => [number, number][]
): void {
    if (points.length === 0) return;
    // A single point is a CLICK, and a click with a pencil leaves a mark.
    if (points.length === 1) { stampBrush(buffer, brush, points[0][0], points[0][1], colour); return; }
    for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        for (const [x, y] of line(x0, y0, x1, y1)) stampBrush(buffer, brush, x, y, colour);
    }
}

/** The box a whole stroke would touch, for one `capturePatch` around the lot. */
export function strokeBounds(
    brush: Brush, points: readonly [number, number][]
): { x: number; y: number; width: number; height: number } | null {
    if (points.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of points) {
        const b = brushBounds(brush, px, py);
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.width > maxX) maxX = b.x + b.width;
        if (b.y + b.height > maxY) maxY = b.y + b.height;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
