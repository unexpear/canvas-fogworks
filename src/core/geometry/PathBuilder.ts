/**
 * @module PathBuilder
 * @description Turns pen-tool points into a `core.path` node — the geometry, without the input.
 *
 * `core.path` has been a full citizen since schema 17: validated by `pathError`, drawn by both
 * backends, round-tripping. Nothing could ever CREATE one, because the awkward part is not the
 * clicking — it is that path commands are stored in the node's LOCAL box space while a pen is
 * drawn in world space, so the box has to be derived from the points and every coordinate
 * re-based onto it. That is arithmetic, so it lives here with tests rather than inside a tool
 * where it could only be checked by drawing.
 *
 * HANDLE CONVENTION: a point stores its OUT handle. The IN handle is its mirror through the
 * point, which is what makes a curve smooth by construction — a pen that stored both would let
 * them drift apart and produce a corner where the user dragged a curve.
 */

import { PathCommand } from "../document/Node";
import { Rect } from "./Matrix";

/** One pen point in WORLD space, with an optional outgoing bezier handle. */
export interface PenPoint {
    x: number;
    y: number;
    /** The OUT handle, in world space. Absent = a corner. */
    hx?: number;
    hy?: number;
}

/** The IN handle of a point: its out handle mirrored through the point itself. */
function inHandle(p: PenPoint): { x: number; y: number } {
    return p.hx === undefined || p.hy === undefined
        ? { x: p.x, y: p.y }
        : { x: 2 * p.x - p.hx, y: 2 * p.y - p.hy };
}

function outHandle(p: PenPoint): { x: number; y: number } {
    return p.hx === undefined || p.hy === undefined ? { x: p.x, y: p.y } : { x: p.hx, y: p.hy };
}

/** True when the segment between two points needs a curve rather than a straight line. */
function isCurved(a: PenPoint, b: PenPoint): boolean {
    return (a.hx !== undefined && a.hy !== undefined) || (b.hx !== undefined && b.hy !== undefined);
}

/**
 * The commands a pen path makes, in WORLD space.
 *
 * A segment is a LINE when neither end has a handle and a CUBIC otherwise — emitting a cubic
 * for every segment would be equivalent to draw but would turn a plain polygon into an
 * un-editable soup of coincident control points.
 */
export function penCommands(points: readonly PenPoint[], closed: boolean): PathCommand[] {
    if (points.length === 0) return [];
    const out: PathCommand[] = [{ c: "M", x: points[0].x, y: points[0].y }];

    const segment = (a: PenPoint, b: PenPoint): void => {
        if (!isCurved(a, b)) {
            out.push({ c: "L", x: b.x, y: b.y });
            return;
        }
        const c1 = outHandle(a);
        const c2 = inHandle(b);
        out.push({ c: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: b.x, y: b.y });
    };

    for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i]);
    if (closed && points.length > 1) {
        segment(points[points.length - 1], points[0]);
        out.push({ c: "Z" });
    }
    return out;
}

/**
 * Where on a curve one axis turns around: the roots of its derivative inside (0,1).
 *
 * A cubic's derivative is the quadratic `at² + bt + c` with `a = A − 2B + C`, `b = 2(B − A)`,
 * `c = A` for the successive differences `A = p1−p0`, `B = p2−p1`, `C = p3−p2`. `a ≈ 0` is the
 * degenerate case where the derivative is LINEAR (evenly spaced control points), which the
 * quadratic formula would answer by dividing by zero.
 */
function cubicRoots(p0: number, p1: number, p2: number, p3: number): number[] {
    const A = p1 - p0, B = p2 - p1, C = p3 - p2;
    const a = A - 2 * B + C, b = 2 * (B - A), c = A;
    const inRange = (t: number): boolean => t > 0 && t < 1;
    if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b].filter(inRange);
    const disc = b * b - 4 * a * c;
    if (disc < 0) return [];                       // no turn: the axis is monotonic across the segment
    const s = Math.sqrt(disc);
    return [(-b + s) / (2 * a), (-b - s) / (2 * a)].filter(inRange);
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** A quadratic's single turning point, or null when it has none inside (0,1). */
function quadRoot(p0: number, p1: number, p2: number): number | null {
    const den = p0 - 2 * p1 + p2;
    if (den === 0) return null;            // the derivative is constant: no turn
    const t = (p0 - p1) / den;
    return t > 0 && t < 1 ? t : null;
}

function quadAt(p0: number, p1: number, p2: number, t: number): number {
    const u = 1 - t;
    return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/**
 * The box a set of commands occupies — the TIGHT one, around the ink itself.
 *
 * A curve's control points routinely sit outside the curve they shape, so the control hull
 * (which this used to return) draws a box with empty margins on the curved sides: the selection
 * frame stops matching the shape, and every consumer of bounds — snapping, culling, alignment,
 * the marquee — works from a rectangle bigger than anything visible. The exact answer is the
 * segment endpoints plus each axis's turning points, which is what a bezier's derivative gives
 * in closed form. A quadratic has the single root `(p0−p1)/(p0−2p1+p2)`.
 */
export function pathBounds(commands: readonly PathCommand[]): Rect {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const see = (x: number, y: number): void => {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    };
    // The bounds of a curve need the point it STARTS from, so the walk carries the current
    // point — the one thing a per-command scan cannot see.
    let cx = 0, cy = 0;
    let started = false;
    for (const cmd of commands) {
        if (cmd.c === "Z") continue;
        // Each root is seen as a WHOLE point on the curve: the axis that turns contributes its
        // extremum, and the other axis contributes a coordinate that is genuinely on the ink,
        // so it can never widen the box past the curve.
        if (cmd.c === "C" && started) {
            const ts = [...cubicRoots(cx, cmd.x1, cmd.x2, cmd.x), ...cubicRoots(cy, cmd.y1, cmd.y2, cmd.y)];
            for (const t of ts) see(cubicAt(cx, cmd.x1, cmd.x2, cmd.x, t), cubicAt(cy, cmd.y1, cmd.y2, cmd.y, t));
        } else if (cmd.c === "Q" && started) {
            for (const t of [quadRoot(cx, cmd.x1, cmd.x), quadRoot(cy, cmd.y1, cmd.y)]) {
                if (t !== null) see(quadAt(cx, cmd.x1, cmd.x, t), quadAt(cy, cmd.y1, cmd.y, t));
            }
        }
        see(cmd.x, cmd.y);
        cx = cmd.x; cy = cmd.y;
        started = true;
    }
    if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Every coordinate shifted — used to re-base world commands onto their own box. */
export function translatePath(commands: readonly PathCommand[], dx: number, dy: number): PathCommand[] {
    return commands.map(cmd => {
        if (cmd.c === "Z") return { c: "Z" } as PathCommand;
        if (cmd.c === "C") return { c: "C", x1: cmd.x1 + dx, y1: cmd.y1 + dy, x2: cmd.x2 + dx, y2: cmd.y2 + dy, x: cmd.x + dx, y: cmd.y + dy };
        if (cmd.c === "Q") return { c: "Q", x1: cmd.x1 + dx, y1: cmd.y1 + dy, x: cmd.x + dx, y: cmd.y + dy };
        return { c: cmd.c, x: cmd.x + dx, y: cmd.y + dy };
    });
}

/**
 * The node a finished pen stroke becomes: its BOX in world space, and its commands re-based to
 * be local to that box. Null when the points cannot make a path the document would accept.
 *
 * The refusals are `dimensionError`'s rules for `core.path`, applied before an action is built
 * rather than after it fails: fewer than two points is not a path, and a box with no extent on
 * EITHER axis is a degenerate point. A single-axis collapse — a perfectly horizontal stroke —
 * is legal, which is exactly why the check is "both", not "either".
 */
export function penNodeFrom(points: readonly PenPoint[], closed: boolean): { geometry: Rect; path: PathCommand[] } | null {
    const world = penCommands(points, closed);
    const box = pathBounds(world);
    // ONE check, not two: no points and a single point both produce a zero-extent box, so
    // a separate length guard would only restate this one. A single-axis collapse — a
    // perfectly horizontal stroke — is legal for a path, which is why this is "and".
    if (box.width === 0 && box.height === 0) return null;
    return { geometry: box, path: translatePath(world, -box.x, -box.y) };
}

/**
 * The index of a final drawing command that lands back ON the start point, or -1.
 *
 * `Z` closes a subpath with an implicit straight line, so `[M, L, L, Z]` has THREE distinct
 * points. A pen that closes by drawing back to the start produces `[M, L, L, L(start), Z]`,
 * where the last command stores the start point a SECOND time. Only that second form has a
 * duplicate — assuming every closed path has one drops a real vertex from the triangle a `Z`
 * closes, which is precisely the wrong answer in the more common case.
 */
function duplicateClosingIndex(commands: readonly PathCommand[]): number {
    if (commands.length < 3) return -1;
    if (commands[commands.length - 1].c !== "Z") return -1;
    const start = commands[0];
    const last = commands[commands.length - 2];
    if (start.c === "Z" || last.c === "Z") return -1;
    return start.x === last.x && start.y === last.y ? commands.length - 2 : -1;
}

/** One on-curve point of a path, and which command carries it. */
export interface PathVertex {
    /** Index into the command array. */
    index: number;
    x: number;
    y: number;
}

/**
 * The ON-CURVE points of a path, in LOCAL space — what a vertex editor shows as handles.
 *
 * `Z` carries no point: it closes back to the start, which is already listed. Showing a handle
 * there would put two draggable dots on one position, and dragging the phantom would do nothing.
 */
export function pathVertices(commands: readonly PathCommand[]): PathVertex[] {
    // A final command that lands back ON the start stores that point twice; listing both puts
    // two draggable dots on one position, and `movePathVertex` moves the pair together, so the
    // duplicate would look like a handle that does nothing while its twin works. A path closed
    // by `Z` ALONE has no duplicate — `Z` carries no point.
    const duplicate = duplicateClosingIndex(commands);
    const out: PathVertex[] = [];
    commands.forEach((cmd, index) => {
        if (cmd.c === "Z" || index === duplicate) return;
        out.push({ index, x: cmd.x, y: cmd.y });
    });
    return out;
}

/**
 * Move one on-curve point, carrying the control handles that belong to it.
 *
 * A cubic's `x2,y2` is the IN handle of its own endpoint, and the NEXT command's `x1,y1` is the
 * OUT handle of that same point. Moving the point without them would leave the curve anchored
 * to where the point used to be, so the shape would warp rather than translate — the single
 * most obvious way for a vertex editor to feel broken.
 *
 * A closed path's `M` and its final `L`/`C` back to the start are the SAME point, so moving the
 * first vertex moves the closing command's endpoint too; otherwise closing the shape would tear
 * it open.
 */
export function movePathVertex(commands: readonly PathCommand[], index: number, dx: number, dy: number): PathCommand[] {
    const target = commands[index];
    if (!target || target.c === "Z") return [...commands];
    const closed = commands.length > 0 && commands[commands.length - 1].c === "Z";
    const isFirst = index === 0;
    // When the path closes by drawing back to the start, that point is stored twice and the
    // first vertex has a TWIN; moving only one would tear the shape open. A path closed by `Z`
    // alone has no twin, and moving its start must not drag an unrelated last point with it.
    const twin = duplicateClosingIndex(commands);

    return commands.map((cmd, i) => {
        const movesPoint = i === index || (isFirst && i === twin);
        // The FOLLOWING command's first control point is the OUT handle of the moved point.
        const follows = i === index + 1 || (isFirst && closed && i === 1);
        const px = movesPoint ? dx : 0;
        const py = movesPoint ? dy : 0;

        switch (cmd.c) {
            case "Z":
                return { c: "Z" };
            case "M":
            case "L":
                return { c: cmd.c, x: cmd.x + px, y: cmd.y + py };
            case "Q":
                return {
                    c: "Q",
                    x1: cmd.x1 + (follows ? dx : 0), y1: cmd.y1 + (follows ? dy : 0),
                    x: cmd.x + px, y: cmd.y + py
                };
            case "C":
                return {
                    c: "C",
                    // x1/y1 is the OUT handle of the PREVIOUS point; x2/y2 the IN handle of this one.
                    x1: cmd.x1 + (follows ? dx : 0), y1: cmd.y1 + (follows ? dy : 0),
                    x2: cmd.x2 + px, y2: cmd.y2 + py,
                    x: cmd.x + px, y: cmd.y + py
                };
        }
    });
}


/**
 * Re-normalize a path node after an edit: commands back onto a (0,0) origin, with the box moved
 * to match, so the node's geometry still describes where its ink is.
 *
 * Dragging a vertex outward otherwise leaves commands with negative coordinates inside a box
 * that no longer contains them — the node would still DRAW correctly (the commands are placed
 * by the world matrix) but its bounds would be wrong, and bounds are what selection, snapping,
 * culling and hit-testing all read.
 */
export function normalizePathNode(geometry: Rect, commands: readonly PathCommand[]): { geometry: Rect; path: PathCommand[] } {
    const box = pathBounds(commands);
    return {
        geometry: { x: geometry.x + box.x, y: geometry.y + box.y, width: box.width, height: box.height },
        path: translatePath(commands, -box.x, -box.y)
    };
}
