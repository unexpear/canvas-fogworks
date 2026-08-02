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
 * The box a set of commands occupies, INCLUDING control points.
 *
 * Control points can sit outside the curve they shape, so a box drawn from on-curve points
 * alone would clip the ink. Using the control hull is the safe direction — the box is at worst
 * too large, never too small. (A TIGHT box needs bezier extrema, which is the same deferral
 * `pathError`'s doc comment already records for path bounds.)
 */
export function pathBounds(commands: readonly PathCommand[]): Rect {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const see = (x: number, y: number): void => {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    };
    for (const cmd of commands) {
        if (cmd.c === "Z") continue;
        see(cmd.x, cmd.y);
        if (cmd.c === "C") { see(cmd.x1, cmd.y1); see(cmd.x2, cmd.y2); }
        if (cmd.c === "Q") { see(cmd.x1, cmd.y1); }
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
