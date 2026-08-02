/**
 * @module OrientedBox
 * @description A node's box as it is actually DRAWN — rotated and scaled with the node — and
 * the arithmetic for resizing along its own axes.
 *
 * The selection frame used to be the world AABB. For anything rotated that is a rectangle the
 * node does not occupy: it balloons out to contain the corners, so the frame is visibly bigger
 * than the shape, its handles float off the shape's corners, and dragging one moves the box
 * along WORLD axes while the user is looking at rotated ones. Everything here works in the
 * node's own frame instead, and only converts to world at the edges.
 *
 * Rotation and scale keep the box a rectangle in world space (`compose` is translate ∘ rotate ∘
 * scale — no shear), which is why a padded frame can be computed exactly rather than
 * approximated: the padding goes on in LOCAL units, scaled per axis, and comes out the same
 * distance from every edge.
 */

import { Mat2D, applyToPoint } from "./Matrix";

export interface Point { x: number; y: number; }

/** The four corners of a local box, in local order: nw · ne · se · sw. */
export type Quad = [Point, Point, Point, Point];

/**
 * How far one unit along each LOCAL axis travels in world — the length of the transformed unit
 * vectors. Used to convert a screen/world padding into the local units the box is measured in,
 * so a scaled node's frame still sits the same distance off its edges on both axes.
 */
export function axisLengths(world: Mat2D): { ux: number; uy: number } {
    return {
        ux: Math.hypot(world.a, world.b),
        uy: Math.hypot(world.c, world.d)
    };
}

/**
 * The node's box in WORLD space as four corners, optionally inflated by `pad` world units.
 *
 * The box sits at the local origin (its position is carried by the matrix), so this is just the
 * corners of `[0,width] × [0,height]` pushed through `world`. A degenerate axis (a zero-length
 * transformed unit vector, i.e. a collapsed scale) would divide by zero when converting the
 * padding, so it contributes no padding on that axis rather than NaN corners.
 */
export function boxQuad(world: Mat2D, width: number, height: number, pad: number = 0): Quad {
    const { ux, uy } = axisLengths(world);
    const px = pad > 0 && ux > 0 ? pad / ux : 0;
    const py = pad > 0 && uy > 0 ? pad / uy : 0;
    const x0 = -px, y0 = -py, x1 = width + px, y1 = height + py;
    return [
        applyToPoint(world, x0, y0),
        applyToPoint(world, x1, y0),
        applyToPoint(world, x1, y1),
        applyToPoint(world, x0, y1)
    ];
}

/** The quad's centre — the average of its corners, which for a parallelogram is its centre. */
export function quadCenter(q: Quad): Point {
    return {
        x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
        y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4
    };
}

/**
 * The four CSS resize cursors, chosen by the direction the handle actually points in world.
 *
 * A rotated node's corner handle keeps its LOCAL identity (`se` is still the bottom-right of the
 * box) but its screen direction changes, so a fixed `nwse-resize` on it points the wrong way as
 * soon as the node turns. Rounding the angle to the nearest 45° picks the closest of the four
 * cursors CSS actually offers.
 */
export function cursorForDirection(dx: number, dy: number): string {
    const CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
    if (dx === 0 && dy === 0) return "nwse-resize";
    // atan2 / 45°, rounded, wrapped into [0,4) — opposite directions share a cursor.
    const octant = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 4) + 4) % 4;
    return CURSORS[octant];
}

/**
 * A node's own local linear map (rotate ∘ scale) recovered from the matrices the engine already
 * published: `parentWorld⁻¹ · world`, linear part only.
 *
 * Recovered rather than rebuilt from `transform.rotation/scale` so there is one definition of the
 * composition convention — the engine's — and a change to it cannot leave the resize maths
 * silently disagreeing about which way a node is turned.
 */
export function localLinear(parentWorld: Mat2D, world: Mat2D): Mat2D {
    const det = parentWorld.a * parentWorld.d - parentWorld.b * parentWorld.c;
    if (det === 0) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    // inverse of the parent's linear part, applied to the node's.
    const ia = parentWorld.d / det, ib = -parentWorld.b / det;
    const ic = -parentWorld.c / det, id = parentWorld.a / det;
    return {
        a: ia * world.a + ic * world.b,
        b: ib * world.a + id * world.b,
        c: ia * world.c + ic * world.d,
        d: ib * world.c + id * world.d,
        e: 0,
        f: 0
    };
}

/** A world-space delta expressed in the node's LOCAL units (the linear part only — no origin). */
export function worldDeltaToLocal(world: Mat2D, dx: number, dy: number): Point {
    const det = world.a * world.d - world.b * world.c;
    if (det === 0) return { x: 0, y: 0 };   // collapsed transform: no sensible local direction
    return {
        x: (dx * world.d - dy * world.c) / det,
        y: (dy * world.a - dx * world.b) / det
    };
}

/** Which corner of the box a handle drags, and which one stays put, as local unit fractions. */
const CORNERS: Record<string, { moving: Point; fixed: Point }> = {
    se: { moving: { x: 1, y: 1 }, fixed: { x: 0, y: 0 } },
    nw: { moving: { x: 0, y: 0 }, fixed: { x: 1, y: 1 } },
    ne: { moving: { x: 1, y: 0 }, fixed: { x: 0, y: 1 } },
    sw: { moving: { x: 0, y: 1 }, fixed: { x: 1, y: 0 } }
};

export interface Box { x: number; y: number; width: number; height: number; }

/**
 * Resize a box by a LOCAL delta, keeping the opposite corner where it is DRAWN.
 *
 * The subtle part is the transform origin. A node rotates about a point expressed as a FRACTION
 * of its own size (the centre by default), so changing width/height moves that point — and with
 * it the whole rotated box. Holding the opposite corner still therefore needs a compensating
 * shift of the box's stored position, not just a new size:
 *
 *     x' = x + Δo + M(Δf − Δo)      Δo = o − o'   (old origin minus new, in local units)
 *                                   Δf = f − f'   (the fixed corner's local coords, old vs new)
 *
 * where `M` is the node's own rotate∘scale. With no transform `M = I` and it collapses to the
 * familiar `x' = x + Δf` — which is why the un-rotated case never needed any of this. Without
 * the compensation a rotated node's opposite corner swings away from under the cursor as soon
 * as the drag starts, which is the tell that a resize is being done in the wrong space.
 *
 * `origin` is the transform-origin fraction (default centre, matching `localMatrix`). `m` is the
 * node's LOCAL linear part; pass the identity for a node with no transform.
 */
export function resizeBox(
    handle: string,
    box: Box,
    dLocal: Point,
    m: { a: number; b: number; c: number; d: number },
    origin: Point = { x: 0.5, y: 0.5 },
    minSize: number = 1
): Box {
    const corner = CORNERS[handle];
    if (!corner) return { ...box };

    // The dragged corner moves by the delta; the size follows from which corner it is. A handle
    // on the LOW side (`x: 0`) shrinks the box when it moves right, hence the sign.
    const signX = corner.moving.x === 1 ? 1 : -1;
    const signY = corner.moving.y === 1 ? 1 : -1;
    const width = Math.max(minSize, box.width + signX * dLocal.x);
    const height = Math.max(minSize, box.height + signY * dLocal.y);

    const oldO = { x: origin.x * box.width, y: origin.y * box.height };
    const newO = { x: origin.x * width, y: origin.y * height };
    const dO = { x: oldO.x - newO.x, y: oldO.y - newO.y };
    const oldF = { x: corner.fixed.x * box.width, y: corner.fixed.y * box.height };
    const newF = { x: corner.fixed.x * width, y: corner.fixed.y * height };
    const dF = { x: oldF.x - newF.x, y: oldF.y - newF.y };

    const vx = dF.x - dO.x, vy = dF.y - dO.y;
    return {
        x: box.x + dO.x + (m.a * vx + m.c * vy),
        y: box.y + dO.y + (m.b * vx + m.d * vy),
        width,
        height
    };
}
