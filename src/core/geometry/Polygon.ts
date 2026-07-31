/**
 * @module Polygon
 * @description Pure vertex generation for regular N-gons — triangle, pentagon, hexagon,
 * octagon and anything else with a side count. DOM-free and node-tested; `ShapeTool` turns the
 * result into `core.path` commands, so no new node type is needed (a polygon IS a path).
 *
 * The vertices are generated on a unit circle starting at the TOP (−90°) and going clockwise,
 * then NORMALIZED so the polygon's own bounding box exactly fills the drawn box. Normalizing is
 * what makes the shape behave like every other one in the editor: the box you drag is the box
 * you get, selection handles and culling use that same box, and a non-square drag gives an
 * affine-stretched polygon rather than a small circle-inscribed one floating inside its bounds.
 *
 * It also makes the 3-gon come out as EXACTLY the box-filling triangle — apex at top-centre,
 * base along the bottom edge — which is both the conventional "triangle" shape and the one this
 * editor already shipped, so the general case subsumes the preset instead of contradicting it.
 */

/** Fewest sides a polygon can have (a 2-gon is a line, which has its own node type). */
export const POLYGON_MIN_SIDES = 3;
/**
 * Most sides a polygon may have. Not an OOM guard — `PATH_MAX_COMMANDS` bounds that at 100k —
 * but a meaningfulness one: past a few dozen sides a regular polygon is visually an ellipse,
 * which this editor draws better and cheaper as `core.ellipse`.
 */
export const POLYGON_MAX_SIDES = 64;
/** The side count the polygon tool starts on — a hexagon, the most recognisable N-gon. */
export const POLYGON_DEFAULT_SIDES = 6;

/** A point in the node's LOCAL space (the renderer emits shapes at the local origin). */
export interface Point {
    x: number;
    y: number;
}

/** `sides` clamped to the representable range and rounded — a shared rule so the tool, the UI
 *  control and the tests all agree on what a given input means. */
export function clampSides(sides: number): number {
    if (!Number.isFinite(sides)) return POLYGON_MIN_SIDES;
    return Math.min(POLYGON_MAX_SIDES, Math.max(POLYGON_MIN_SIDES, Math.round(sides)));
}

/**
 * The vertices of a regular `sides`-gon filling a `width` × `height` box, in LOCAL coordinates
 * (0,0 = the box's top-left). First vertex is the topmost one; order is clockwise.
 *
 * A zero-extent axis yields vertices collapsed onto that axis rather than NaN — the caller
 * decides whether such a box is drawable (`ShapeTool` refuses one), and a pure geometry helper
 * should not be the thing that throws.
 */
export function polygonPoints(sides: number, width: number, height: number): Point[] {
    const n = clampSides(sides);
    const raw: Point[] = [];
    for (let i = 0; i < n; i++) {
        // Start at the top and go clockwise: -90° puts a vertex at the box's top edge, which is
        // what makes the 3-gon read as an upright triangle rather than a tilted one.
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
        raw.push({ x: Math.cos(angle), y: Math.sin(angle) });
    }
    // Normalize the polygon's OWN bounds onto the drawn box. For odd side counts the unit-circle
    // bbox is not centred (a triangle reaches y=-1 at the apex but only y=+0.5 at the base), so
    // scaling by the circle's diameter instead would leave the shape floating off-centre.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of raw) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    return raw.map(p => ({
        x: spanX === 0 ? 0 : snap(((p.x - minX) / spanX) * width),
        y: spanY === 0 ? 0 : snap(((p.y - minY) / spanY) * height)
    }));
}

/**
 * Round away the representable noise trigonometry leaves behind — `sin(30°)` is
 * 0.49999999999999994, so a 40-unit triangle's base would land at 39.999999999999986 and be
 * PERSISTED that way. Snapping at 1e-10 is far below anything visible (or drawable: the tool's
 * minimum drag is 2 screen pixels) and far above float noise, and it makes the 3-gon come out
 * bit-identical to the hand-written triangle this generator replaced.
 */
function snap(v: number): number {
    return Math.round(v * 1e10) / 1e10;
}
