/**
 * @module SurfaceSpace
 * @description Where a pointer is, in pixels.
 *
 * A raster node is two coordinate systems wearing one name. It occupies a BOX in world units that
 * can be moved, scaled and rotated like any other node, and it holds a SURFACE measured in pixels
 * that has nothing to do with those units — a 16x16 sprite scaled to 400 world units across is one
 * pixel per 25 units. A paint tool is handed the first and must paint in the second, and every
 * interesting mistake in a pixel editor lives in that conversion.
 *
 * IT IS THE INVERSE OF THE NODE'S OWN MATRIX, not a subtraction. Reading `worldX - node.x` is right
 * exactly until the node is rotated or sits inside a rotated parent, and then it is wrong in a way
 * that looks like the brush lagging the cursor rather than like arithmetic. `ComputedNode.world`
 * already holds the local→world matrix the renderer draws with, so inverting THAT is what keeps the
 * paint and the picture in the same place by construction.
 *
 * THE LOCAL BOX'S ORIGIN IS DELIBERATELY ABSENT, and this is the one thing here that is easy to get
 * backwards. `ComputedNode.local` is a Rect whose x/y hold the node's stored position — but the
 * renderer does not place with them: `buildRenderModel` emits every shape at `x = 0, y = 0` with
 * `local.width/height`, and `world` carries the whole placement. Subtracting `local.x` as well
 * therefore counts the node's position TWICE. Taking only the size makes that unrepresentable.
 *
 * The first version of this module got it wrong, and every unit test passed — because the fixture
 * paired an IDENTITY `world` with a non-zero `local` origin, which is a combination
 * `computeGeometry` never produces. A self-consistent fixture that is not a state the system can
 * reach proves nothing about the system. It surfaced the moment the tool was wired to a real
 * document, where `world` was `translate(100,40)` and `local` was `{100,40,...}`.
 *
 * A PIXEL IS A CELL, NOT A POINT — so the map FLOORS. Rounding would make the leftmost and topmost
 * half-pixel map off the surface and double the width of the two edge columns, which reads as a
 * brush that will not reach the border.
 *
 * OUT-OF-RANGE RESULTS ARE RETURNED, NOT DROPPED. `setPixel` already bounds every dab, and a second
 * bounds rule here is a second thing that can disagree with it — the same reason `Symmetry` returns
 * mirrored points that fall outside the surface. What IS refused is a conversion that has no answer
 * at all: a collapsed box, or a matrix that cannot be inverted.
 */

import { Mat2D, invert, applyToPoint } from "../geometry/Matrix";

/** Everything the conversion needs about a raster node: where its box is, and how big its grid is. */
export interface SurfaceSpace {
    /** Local→world, as `ComputedNode.world` gives it. Carries the node's whole placement. */
    world: Mat2D;
    /**
     * The node's box SIZE, from `ComputedNode.local.width/height`.
     *
     * THE ORIGIN IS NOT HERE ON PURPOSE — `world` already holds it. See the module header.
     */
    localWidth: number;
    localHeight: number;
    /** The surface's grid, in pixels. */
    surfaceWidth: number;
    surfaceHeight: number;
}

/** Whether a space can be converted through at all. */
export function surfaceSpaceError(space: SurfaceSpace): string | null {
    if (!Number.isFinite(space.localWidth) || !Number.isFinite(space.localHeight)) {
        return "a raster node's box must be finite";
    }
    // A COLLAPSED BOX HAS NO MAPPING. Dividing by it yields Infinity, which floors to a number that
    // is not a pixel and would be painted somewhere.
    if (space.localWidth <= 0 || space.localHeight <= 0) return "a raster node's box must have area";
    if (!Number.isInteger(space.surfaceWidth) || !Number.isInteger(space.surfaceHeight)) {
        return "a surface must have whole dimensions";
    }
    if (space.surfaceWidth < 1 || space.surfaceHeight < 1) return "a surface must be at least one pixel";
    if (invert(space.world) === null) return "a raster node's transform must be invertible";
    return null;
}

/**
 * The surface pixel under a world point, or null when the space has no mapping.
 *
 * The returned pixel MAY BE OUTSIDE the surface — that is what a drag off the edge of a sprite
 * genuinely is, and the paint layer is where it stops mattering.
 */
export function worldToSurface(space: SurfaceSpace, worldX: number, worldY: number): [number, number] | null {
    if (surfaceSpaceError(space) !== null) return null;
    const inv = invert(space.world);
    if (!inv) return null;
    const p = applyToPoint(inv, worldX, worldY);
    // The two axes are scaled INDEPENDENTLY, so a non-uniformly scaled node paints square pixels in
    // its own grid rather than the stretched ones a single scale factor would give.
    const u = p.x / space.localWidth;
    const v = p.y / space.localHeight;
    const sx = Math.floor(u * space.surfaceWidth);
    const sy = Math.floor(v * space.surfaceHeight);
    // A NaN can only arrive from a NaN world point, and flooring one gives NaN rather than throwing
    // — which would be stored as a coordinate and compared falsely against every bound.
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
    return [sx, sy];
}

/**
 * The world point at the CENTRE of a surface pixel, or null when the space has no mapping.
 *
 * THE CENTRE, NOT THE CORNER, because this exists to place things a user sees — a brush cursor, a
 * pixel highlight. Drawn at the corner each sits half a pixel up and to the left of the pixel it
 * claims to mark, which at a high zoom is the difference between a cursor on a pixel and beside it.
 */
export function surfaceToWorld(space: SurfaceSpace, sx: number, sy: number): { x: number; y: number } | null {
    if (surfaceSpaceError(space) !== null) return null;
    const u = (sx + 0.5) / space.surfaceWidth;
    const v = (sy + 0.5) / space.surfaceHeight;
    return applyToPoint(space.world, u * space.localWidth, v * space.localHeight);
}

/**
 * How many world units one surface pixel spans, along each axis.
 *
 * A brush measured in surface pixels needs this to be drawn at the right size on screen, and a tool
 * deciding whether a drag moved far enough to be a new sample needs it to compare a screen distance
 * against a pixel. Both axes are reported because a non-uniformly scaled node has two answers.
 */
export function surfacePixelSize(space: SurfaceSpace): { x: number; y: number } | null {
    if (surfaceSpaceError(space) !== null) return null;
    // MEASURED THROUGH THE MATRIX rather than divided out of the box, so a rotated or skewed node
    // reports the distance its pixels actually cover rather than the distance they would cover if
    // it were upright.
    const origin = surfaceToWorld(space, 0, 0);
    const right = surfaceToWorld(space, 1, 0);
    const down = surfaceToWorld(space, 0, 1);
    if (!origin || !right || !down) return null;
    return {
        x: Math.hypot(right.x - origin.x, right.y - origin.y),
        y: Math.hypot(down.x - origin.x, down.y - origin.y)
    };
}
