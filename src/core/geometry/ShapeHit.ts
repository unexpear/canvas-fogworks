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

import { PathCommand } from "../document/Node";

/** What a node's ink covers, in local space. Mirrors the render model's `shape` kinds. */
export type HitShape =
    | { kind: "box"; radius: number }
    | { kind: "ellipse" }
    | { kind: "line" }
    /** `filled` = the node carries a paint-bearing fill, so its interior is ink and not just air. */
    | { kind: "path"; commands: readonly PathCommand[]; filled: boolean };

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
 * How many straight segments approximate one curve for hit-testing.
 *
 * Flattening, not exact root-finding: a point-in-curve test has no closed form, and 16
 * segments put the worst-case chord error far below a pixel for any curve a person can
 * draw at a sane zoom. It is a FIXED count on purpose — an adaptive one would make picking
 * depend on the viewport, so the same click could hit at one zoom and miss at another.
 */
const CURVE_SEGMENTS = 16;

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function quadAt(p0: number, p1: number, p2: number, t: number): number {
    const u = 1 - t;
    return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/** One connected run of points, and whether it closes back on itself. */
export interface Subpath {
    points: { x: number; y: number }[];
    closed: boolean;
}

/**
 * Path commands as polylines — one per subpath (an `M` starts a new one).
 *
 * Kept exported because it is the shared answer to "where does this path actually go":
 * hit-testing needs it, and so will outline stroking and boolean ops.
 */
export function flattenPath(commands: readonly PathCommand[]): Subpath[] {
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
            for (let i = 1; i <= CURVE_SEGMENTS; i++) {
                const t = i / CURVE_SEGMENTS;
                current.points.push({ x: cubicAt(cx, cmd.x1, cmd.x2, cmd.x, t), y: cubicAt(cy, cmd.y1, cmd.y2, cmd.y, t) });
            }
        } else {
            for (let i = 1; i <= CURVE_SEGMENTS; i++) {
                const t = i / CURVE_SEGMENTS;
                current.points.push({ x: quadAt(cx, cmd.x1, cmd.x, t), y: quadAt(cy, cmd.y1, cmd.y, t) });
            }
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
                if (shape.filled && sub.points.length > 2) winding += windingOf(sub.points, x, y);
            }
            return winding !== 0;
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
