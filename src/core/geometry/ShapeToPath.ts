/**
 * @module ShapeToPath
 * @description Any node's outline as drawing commands — "convert to path", and the input side
 * of every boolean operation.
 *
 * A boolean is defined on outlines, not on node types, so a rectangle and an ellipse have to be
 * expressible as one before they can take part. The conversions mirror what `buildRenderModel`
 * emits for each type, exactly as `ShapeHit` does — the three now agree on what a node's outline
 * IS, which is what lets a boolean, a hit test and the drawing all describe the same shape.
 *
 * Commands come out in the node's LOCAL space (its box at the origin); `transformCommands` lifts
 * them to world when a caller needs to combine shapes that live under different matrices.
 */

import { PathCommand } from "../document/Node";
import { Mat2D, applyToPoint } from "./Matrix";
import { HitShape } from "./ShapeHit";

/**
 * Circular-arc control-point ratio: the distance along each tangent that makes a cubic match a
 * quarter circle to within ~0.02% of the radius. The standard 4·(√2−1)/3 — an approximation
 * because a cubic cannot BE a circular arc, and the best one available in this representation.
 */
const KAPPA = 0.5522847498307936;

/** An ellipse filling `width × height`, as four cubics — the same shape the renderer draws. */
export function ellipseCommands(width: number, height: number): PathCommand[] {
    const rx = width / 2, ry = height / 2;
    const cx = rx, cy = ry;
    const ox = rx * KAPPA, oy = ry * KAPPA;
    return [
        { c: "M", x: cx, y: cy - ry },
        { c: "C", x1: cx + ox, y1: cy - ry, x2: cx + rx, y2: cy - oy, x: cx + rx, y: cy },
        { c: "C", x1: cx + rx, y1: cy + oy, x2: cx + ox, y2: cy + ry, x: cx, y: cy + ry },
        { c: "C", x1: cx - ox, y1: cy + ry, x2: cx - rx, y2: cy + oy, x: cx - rx, y: cy },
        { c: "C", x1: cx - rx, y1: cy - oy, x2: cx - ox, y2: cy - ry, x: cx, y: cy - ry },
        { c: "Z" }
    ];
}

/**
 * A rectangle, rounded when `radius > 0`. The radius is clamped to half the shorter side, the
 * same clamp picking and drawing use — past that a rectangle IS a stadium, and three different
 * answers about where its edge lies would be three different shapes.
 *
 * A zero radius emits the plain four-line rect rather than four degenerate curves: the corner
 * cubics would collapse onto their endpoints, which is a valid path but a wasteful and confusing
 * one to hand to a boolean or to a person reading the file.
 */
export function rectCommands(width: number, height: number, radius: number = 0): PathCommand[] {
    const r = Math.min(radius, width / 2, height / 2);
    if (!(r > 0)) {
        return [
            { c: "M", x: 0, y: 0 },
            { c: "L", x: width, y: 0 },
            { c: "L", x: width, y: height },
            { c: "L", x: 0, y: height },
            { c: "Z" }
        ];
    }
    const o = r * KAPPA;
    return [
        { c: "M", x: r, y: 0 },
        { c: "L", x: width - r, y: 0 },
        { c: "C", x1: width - r + o, y1: 0, x2: width, y2: r - o, x: width, y: r },
        { c: "L", x: width, y: height - r },
        { c: "C", x1: width, y1: height - r + o, x2: width - r + o, y2: height, x: width - r, y: height },
        { c: "L", x: r, y: height },
        { c: "C", x1: r - o, y1: height, x2: 0, y2: height - r + o, x: 0, y: height - r },
        { c: "L", x: 0, y: r },
        { c: "C", x1: 0, y1: r - o, x2: r - o, y2: 0, x: r, y: 0 },
        { c: "Z" }
    ];
}

/**
 * A node's outline as commands in its LOCAL box space, or null when it has no outline to convert.
 *
 * A `core.line` is null on purpose: it is a stroke with no interior, so there is no region for a
 * boolean to operate on and no honest way to invent one. Refusing is better than returning a
 * zero-area sliver that silently annihilates whatever it is combined with.
 */
export function shapeToCommands(shape: HitShape, width: number, height: number): PathCommand[] | null {
    switch (shape.kind) {
        case "ellipse": return ellipseCommands(width, height);
        case "box": return rectCommands(width, height, shape.radius);
        case "path": return shape.commands.length > 0 ? [...shape.commands] : null;
        case "line": return null;
    }
}

/** Commands with every coordinate — control points included — pushed through a matrix. */
export function transformCommands(m: Mat2D, commands: readonly PathCommand[]): PathCommand[] {
    const at = (x: number, y: number): { x: number; y: number } => applyToPoint(m, x, y);
    return commands.map(cmd => {
        if (cmd.c === "Z") return { c: "Z" } as PathCommand;
        const p = at(cmd.x, cmd.y);
        if (cmd.c === "C") {
            const c1 = at(cmd.x1, cmd.y1), c2 = at(cmd.x2, cmd.y2);
            return { c: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y };
        }
        if (cmd.c === "Q") {
            const c1 = at(cmd.x1, cmd.y1);
            return { c: "Q", x1: c1.x, y1: c1.y, x: p.x, y: p.y };
        }
        return { c: cmd.c, x: p.x, y: p.y };
    });
}
