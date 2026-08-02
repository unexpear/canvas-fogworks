/**
 * @module ShapeHit
 * @description What a node's INK covers, in its own local space — so a click hits the shape
 * you can see rather than the rectangle it happens to live in.
 *
 * Picking used to be a local-box test. That is rotation-aware and cheap, and it is wrong for
 * every node whose ink is not its box: the empty half of a triangle, the corner outside an
 * ellipse, the whole interior of an open pen stroke. Those pixels selected the node while
 * showing nothing, and — worse — swallowed clicks meant for whatever was drawn behind them.
 *
 * The shape descriptor is derived once per node by `computeGeometry` and read by the pickers,
 * the same arrangement as `bounds` and `locked`: one derivation, no consumer re-deriving it.
 * Each variant mirrors exactly what `buildRenderModel` emits for that node type, because the
 * whole point is that hit and ink agree — an ellipse fills its box, a line is the box diagonal,
 * a path is its own commands, everything else is the box (rounded when it draws rounded).
 *
 * Everything here is LOCAL space: the box sits at the origin (its position is carried by the
 * node's world matrix), and path commands are already stored local to that box.
 */

import { FillRule, PathCommand } from "../document/Node";

/** What a node's ink covers, in local space. Mirrors the render model's `shape` kinds. */
export type HitShape =
    | { kind: "box"; radius: number }
    | { kind: "ellipse" }
    | { kind: "line" }
    /** `filled` = the node carries a paint-bearing fill, so its interior is ink and not just air. */
    | { kind: "path"; commands: readonly PathCommand[]; filled: boolean; fillRule?: FillRule };

/**
 * Whether a fill value paints anything. `Style.fill` is any string, so "none" and "" are how a
 * document says "no fill" — and both backends honour that. Picking has to read the same rule:
 * the interior of an unfilled path is not ink, and the interior of a filled one is, whether or
 * not the path was ever closed.
 */
export function isPaintBearing(fill: string): boolean {
    const f = fill.trim().toLowerCase();
    return f !== "" && f !== "none" && f !== "transparent";
}

/**
 * The ink a node covers, by type — the picking half of what `buildRenderModel` draws.
 *
 * Lives HERE, with the type it produces, rather than inside the geometry engine: the boolean
 * resolver needs the same answer and cannot import the engine (the engine imports the resolver).
 * The corner radius arrives already RESOLVED, so this needs no document and no variable store —
 * the caller does the token lookup with the same `resolveNumber` the renderer uses.
 */
export function hitShapeOf(
    node: { type: string; path?: readonly PathCommand[]; style: { fill: string; fillRule?: FillRule } },
    radius: number
): HitShape {
    if (node.type === "core.ellipse") return { kind: "ellipse" };
    if (node.type === "core.line") return { kind: "line" };
    if (node.type === "core.path") return { kind: "path", commands: node.path ?? [], filled: isPaintBearing(node.style.fill), fillRule: node.style.fillRule };
    return { kind: "box", radius: radius > 0 ? radius : 0 };
}

/**
 * How far a flattened polyline may stray from the curve it replaces, in the PATH's OWN units.
 *
 * This used to be a fixed 16 segments per curve, defended as "the same click must hit at every
 * zoom". The determinism was right; the knob was wrong. A fixed count is an error that scales
 * with the shape: measured against a circular quadrant, 16 segments stray 0.013 units on a
 * radius-10 icon (detail nobody can see, paid for on every hit test) and 1.3 units on a
 * radius-1000 shape — so a boolean cutting a large circle was more than a pixel wrong while a
 * small one wasted work. The error follows r·θ²/8n², so no single n is right for both.
 *
 * A TOLERANCE fixes both ends: subdivide until the curve is flat to within this distance, and no
 * further. It stays viewport-independent — the input is the curve's own geometry and nothing
 * else — so the same click still hits at every zoom, which was the property worth keeping.
 *
 * CONSEQUENCE, named rather than hidden: the tolerance is in the path's own coordinate space, so
 * a node scaled 100x is flattened in ITS units, not the world's. Scaling is rare on paths and the
 * alternative — a world-space tolerance — would make flattening depend on the transform chain,
 * which is how a shape starts hit-testing differently in two places.
 */
export const FLATTEN_TOLERANCE = 0.05;

/**
 * Recursion cap for the subdivision, in halvings — at most 2^depth segments per curve.
 *
 * A curve with coincident or non-finite control points can defeat any flatness test, and this is
 * a hot path reached on every hit test; a bound is the difference between a slow frame and a
 * hung app. 10 allows 1024 segments, far past what the tolerance asks for on any real shape.
 */
export const FLATTEN_MAX_DEPTH = 10;

/**
 * How far a drawn silhouette may stray from its curve, in DEVICE PIXELS.
 *
 * The counterpart to `FLATTEN_TOLERANCE`, and deliberately a different kind of number. That one
 * is in the path's OWN units and never moves, because picking has to hit the same at every
 * magnification — a click that landed at one zoom and missed at another would be unexplainable.
 * Drawing has the opposite requirement: the only error that matters is the one a person can SEE,
 * and that is measured on the screen. A fixed world tolerance is wrong for drawing in both
 * directions at once — at 20x it is a fifth of a pixel of allowed error blown up to four, so
 * circles visibly facet, and at 0.05x it spends a hundred segments on a curve three pixels long.
 *
 * A fifth of a device pixel is below what a display can show and well below what antialiasing
 * would hide.
 */
export const DISPLAY_DEVIATION_PX = 0.2;
/** Bounds on the derived tolerance: nothing coarser than this, and nothing finer. */
export const DISPLAY_TOLERANCE_MAX = 8;
export const DISPLAY_TOLERANCE_MIN = 1e-4;

/**
 * The flattening tolerance to DRAW with, given how many device pixels one world unit covers.
 *
 * QUANTISED to powers of two, which is the part that makes it usable rather than merely correct.
 * A tolerance that tracked the zoom continuously would change the triangle count on every frame
 * of a pinch, and a silhouette whose vertex count changes every frame SHIMMERS. Stepping only at
 * doublings means a curve is re-cut a handful of times across the whole zoom range and holds
 * still in between, while never straying more than a factor of two from the ideal — which, on a
 * fifth-of-a-pixel budget, is still under half a pixel.
 *
 * The bounds are not decoration: `scale` is derived from a matrix a document controls, so a node
 * scaled by 1e9 must not ask for a tolerance of zero and hang the flattener at its depth limit.
 */
export function displayTolerance(scale: number): number {
    if (!Number.isFinite(scale) || scale <= 0) return FLATTEN_TOLERANCE;
    const ideal = DISPLAY_DEVIATION_PX / scale;
    const stepped = Math.pow(2, Math.round(Math.log2(ideal)));
    return Math.min(DISPLAY_TOLERANCE_MAX, Math.max(DISPLAY_TOLERANCE_MIN, stepped));
}

/**
 * How many device pixels one LOCAL unit of a node covers, given the view scale and the node's own
 * world matrix.
 *
 * Flattening happens in the node's local space — that is where a stroke width means what it means
 * — so the tolerance has to be in local units too. A node scaled 10x needs a tolerance ten times
 * finer to look equally smooth. The larger row norm is used rather than the determinant: under a
 * non-uniform scale the determinant averages the two axes and would under-tessellate the stretched
 * one, and erring toward MORE detail is the error that cannot be seen.
 */
export function localScaleOf(m: { a: number; b: number; c: number; d: number }, viewScale: number): number {
    const rx = Math.hypot(m.a, m.b), ry = Math.hypot(m.c, m.d);
    return Math.max(rx, ry) * viewScale;
}

/**
 * Hull distance allowed per unit of tolerance. A cubic's true deviation from its chord is at most
 * 3/4 of its worst control-point offset, so this much hull slack still honours the tolerance —
 * and it removes about a third of the subdivisions that measuring the hull directly would force.
 */
const HULL_SLACK = 4 / 3;

/** One connected run of points, and whether it closes back on itself. */
export interface Subpath {
    points: { x: number; y: number }[];
    closed: boolean;
}

/**
 * How far the control points of a cubic stray from its chord — the flatness measure.
 *
 * A cubic stays within 3/4 of its worst control-point offset from the chord — so a hull distance
 * of `d` guarantees a true deviation of at most `3d/4`, and the caller may allow `4/3 ·
 * tolerance` of hull distance and still keep its promise. That factor is applied by the callers
 * rather than here, so this function reports one plain, checkable quantity.
 *
 * Measuring the hull rather than the curve is what makes the test cheap enough for a hot path:
 * it needs no curve evaluation at all, only two cross products, and it can never UNDER-report,
 * which is the direction that matters for a bound.
 *
 * Distances are computed against the chord's LINE, scaled by its length once at the end, so the
 * hot path does one square root instead of four.
 */
function cubicFlatness(
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, x3: number, y3: number
): number {
    const dx = x3 - x0, dy = y3 - y0;
    const len = Math.hypot(dx, dy);
    // A degenerate chord (the ends coincide) has no line to measure against; fall back to the
    // straight distance from the start, which still shrinks under subdivision.
    if (len === 0) return Math.max(Math.hypot(x1 - x0, y1 - y0), Math.hypot(x2 - x0, y2 - y0));
    const d1 = Math.abs((x1 - x0) * dy - (y1 - y0) * dx);
    const d2 = Math.abs((x2 - x0) * dy - (y2 - y0) * dx);
    return Math.max(d1, d2) / len;
}

/**
 * Subdivide a cubic until it is flat, appending the END point of each flat piece.
 *
 * De Casteljau at t = 0.5, which splits a cubic into two exactly — so this is subdivision, not
 * re-sampling, and the pieces are the same curve. Halving is what makes the result deterministic:
 * the split points depend only on the control points, never on a step count, a zoom or a clock.
 *
 * The start point is NOT appended: the caller already has it, either as the subpath's first point
 * or as the previous segment's end. Emitting it again would put a zero-length edge into every
 * boolean, which is precisely the kind of directionless piece the chaining step has to drop.
 */
function flattenCubic(
    out: { x: number; y: number }[],
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, x3: number, y3: number,
    tolerance: number, depth: number
): void {
    if (depth >= FLATTEN_MAX_DEPTH || cubicFlatness(x0, y0, x1, y1, x2, y2, x3, y3) <= tolerance * HULL_SLACK) {
        out.push({ x: x3, y: y3 });
        return;
    }
    const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
    const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
    const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
    const x012 = (x01 + x12) / 2, y012 = (y01 + y12) / 2;
    const x123 = (x12 + x23) / 2, y123 = (y12 + y23) / 2;
    const mx = (x012 + x123) / 2, my = (y012 + y123) / 2;
    flattenCubic(out, x0, y0, x01, y01, x012, y012, mx, my, tolerance, depth + 1);
    flattenCubic(out, mx, my, x123, y123, x23, y23, x3, y3, tolerance, depth + 1);
}

/** The quadratic twin — same halving, same "append the end only" rule. */
function flattenQuad(
    out: { x: number; y: number }[],
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
    tolerance: number, depth: number
): void {
    // A quadratic IS a cubic with its controls at the 2/3 points, so one flatness measure serves
    // both rather than a second formula to keep in step.
    const c1x = x0 + (2 / 3) * (x1 - x0), c1y = y0 + (2 / 3) * (y1 - y0);
    const c2x = x2 + (2 / 3) * (x1 - x2), c2y = y2 + (2 / 3) * (y1 - y2);
    if (depth >= FLATTEN_MAX_DEPTH || cubicFlatness(x0, y0, c1x, c1y, c2x, c2y, x2, y2) <= tolerance * HULL_SLACK) {
        out.push({ x: x2, y: y2 });
        return;
    }
    const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
    const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
    const mx = (x01 + x12) / 2, my = (y01 + y12) / 2;
    flattenQuad(out, x0, y0, x01, y01, mx, my, tolerance, depth + 1);
    flattenQuad(out, mx, my, x12, y12, x2, y2, tolerance, depth + 1);
}

/**
 * Path commands as polylines — one per subpath (an `M` starts a new one).
 *
 * Kept exported because it is the shared answer to "where does this path actually go":
 * hit-testing needs it, and so will outline stroking and boolean ops.
 */
export function flattenPath(commands: readonly PathCommand[], tolerance: number = FLATTEN_TOLERANCE): Subpath[] {
    const subpaths: Subpath[] = [];
    let current: Subpath | null = null;
    let cx = 0, cy = 0;

    for (const cmd of commands) {
        if (cmd.c === "Z") {
            // `Z` closes the CURRENT subpath; anything after it belongs to the next one, which
            // only an `M` can start. A stray command after `Z` would otherwise silently rejoin
            // a shape that is already closed.
            if (current) current.closed = true;
            current = null;
            continue;
        }
        if (cmd.c === "M") {
            current = { points: [{ x: cmd.x, y: cmd.y }], closed: false };
            subpaths.push(current);
            cx = cmd.x; cy = cmd.y;
            continue;
        }
        // A drawing command with no open subpath: the path never started with `M`. Treat the
        // current point as the origin rather than dropping the ink, which is what the renderers
        // do when they hand the same commands to a backend.
        if (!current) {
            current = { points: [{ x: cx, y: cy }], closed: false };
            subpaths.push(current);
        }
        if (cmd.c === "L") {
            current.points.push({ x: cmd.x, y: cmd.y });
        } else if (cmd.c === "C") {
            flattenCubic(current.points, cx, cy, cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y, tolerance, 0);
        } else {
            flattenQuad(current.points, cx, cy, cmd.x1, cmd.y1, cmd.x, cmd.y, tolerance, 0);
        }
        cx = cmd.x; cy = cmd.y;
    }
    return subpaths;
}

/** Squared distance from a point to a segment — squared, so the hot loop takes no sqrt. */
function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    // A degenerate segment (both ends equal) collapses to a point rather than dividing by zero.
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const qx = ax + t * dx - px, qy = ay + t * dy - py;
    return qx * qx + qy * qy;
}

/** Within `tolerance` of any segment of a polyline (its last edge included when closed). */
function nearPolyline(sub: Subpath, x: number, y: number, tolerance: number): boolean {
    const tolSq = tolerance * tolerance;
    const pts = sub.points;
    if (pts.length === 1) return distSqToSegment(x, y, pts[0].x, pts[0].y, pts[0].x, pts[0].y) <= tolSq;
    for (let i = 1; i < pts.length; i++) {
        if (distSqToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tolSq) return true;
    }
    if (sub.closed && distSqToSegment(x, y, pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y) <= tolSq) return true;
    return false;
}

/**
 * How many times a closed polygon wraps around a point, SIGNED.
 *
 * Summed across every subpath and tested against zero, this is the NONZERO fill rule — what
 * both backends actually paint with (SVG's default `fill-rule`, Canvas's default `fill()`).
 * The sign is what gives a donut its hole: an inner ring wound the other way cancels the outer
 * one to zero, so the middle of an O is not clickable, exactly as it is not filled. A per-shape
 * "inside any subpath" test cannot express that at all — every hole would swallow clicks.
 */
function crossingsOf(pts: readonly { x: number; y: number }[], x: number, y: number): number {
    let n = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j], b = pts[i];
        if ((a.y <= y) !== (b.y <= y)) {
            const t = (y - a.y) / (b.y - a.y);
            if (a.x + t * (b.x - a.x) > x) n++;
        }
    }
    return n;
}

function windingOf(pts: readonly { x: number; y: number }[], x: number, y: number): number {
    let winding = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j], b = pts[i];
        if (a.y <= y) {
            // Upward crossing that leaves the point to the LEFT of the edge: +1.
            if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) winding++;
        } else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) {
            winding--;   // downward crossing on the other side
        }
    }
    return winding;
}

/**
 * Does a local-space point land on the node's ink?
 *
 * `tolerance` is the pick halo in LOCAL units (the caller converts screen px by the zoom). It
 * is what makes a hairline — a zero-extent `core.line`, an open pen stroke — reachable at all:
 * a stroke has no area, so an exact test could only be satisfied by a mathematically perfect
 * click. It also grows every other shape outward by the same amount, which is why a click just
 * outside a circle still selects it, exactly as it did against the old box.
 */
export function hitsShape(shape: HitShape, width: number, height: number, x: number, y: number, tolerance: number): boolean {
    switch (shape.kind) {
        case "line": {
            // The box diagonal, top-left → bottom-right: what the render model emits.
            return distSqToSegment(x, y, 0, 0, width, height) <= tolerance * tolerance;
        }
        case "ellipse": {
            const rx = width / 2 + tolerance, ry = height / 2 + tolerance;
            if (rx <= 0 || ry <= 0) return false;
            const nx = (x - width / 2) / rx, ny = (y - height / 2) / ry;
            return nx * nx + ny * ny <= 1;
        }
        case "path": {
            let winding = 0;
            for (const sub of flattenPath(shape.commands)) {
                // The OUTLINE always hits, filled or not — that is how a bare stroke is picked,
                // and it is why a click on the edge of a filled shape is never a miss.
                if (nearPolyline(sub, x, y, tolerance)) return true;
                // The INTERIOR belongs to the FILL, not to whether the author typed `Z`: both
                // backends close an open subpath implicitly when they fill it, so a pen stroke
                // that was never closed still paints its inside — and gating this on `closed`
                // made exactly that shape unpickable everywhere except along its own edge, which
                // is what drawing one in the real app showed.
                // The rule the DOCUMENT asked for, not the one this file happens to prefer. A
                // click has to agree with the paint: under even-odd the middle of a self-crossing
                // star is a hole, and a hit test still using nonzero would swallow clicks meant
                // for whatever shows through it.
                if (shape.filled && sub.points.length > 2) {
                    winding += shape.fillRule === "evenodd"
                        ? crossingsOf(sub.points, x, y)
                        : windingOf(sub.points, x, y);
                }
            }
            return shape.fillRule === "evenodd" ? winding % 2 !== 0 : winding !== 0;
        }
        case "box": {
            if (x < -tolerance || y < -tolerance || x > width + tolerance || y > height + tolerance) return false;
            // A CORNER RADIUS cuts the box's corners off, so the ink stops before they do.
            // Clamped like the renderer's own rounding: a radius past half the shorter side
            // draws as a stadium/circle, and picking has to agree or the two disagree exactly
            // where the shape is most obviously not a rectangle.
            const r = Math.min(shape.radius, width / 2, height / 2);
            if (r <= 0) return true;
            // Which corner's arc centre is nearest — only points beyond BOTH insets can be in
            // a cut-off corner, so the interior cross returns immediately.
            const dx = x < r ? r - x : x > width - r ? x - (width - r) : 0;
            const dy = y < r ? r - y : y > height - r ? y - (height - r) : 0;
            if (dx === 0 || dy === 0) return true;
            const reach = r + tolerance;
            return dx * dx + dy * dy <= reach * reach;
        }
    }
}
