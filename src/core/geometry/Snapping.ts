/**
 * @module Snapping
 * @description Alignment snapping for a moving node — the pure geometry behind M4's smart
 * guides. Given the moving node's proposed WORLD bounds and the other nodes' world bounds, it
 * returns the small (dx, dy) that lands the moving node's edges/centre onto a nearby target's
 * edges/centre, plus the guide lines to draw at every resulting alignment. Pure and DOM-free
 * (node-tested like `hitTest`/`nodesInRect`); the tool applies dx/dy and the renderer draws
 * the guides. Each axis exposes three snap lines — min edge, centre, max edge — and snaps to
 * the target line with the SMALLEST in-threshold delta.
 */

import { Rect } from "./Matrix";

/** A smart-guide line: "x" = a VERTICAL line at world x=`pos`; "y" = a HORIZONTAL line at world y=`pos`. */
export interface SnapGuide {
    axis: "x" | "y";
    pos: number;
    /** Span of the guide along the PERPENDICULAR axis (world units, start ≤ end). */
    start: number;
    end: number;
}

export interface SnapResult {
    dx: number;
    dy: number;
    guides: SnapGuide[];
}

/** Coincidence tolerance when building guides after the snap (well under a pixel). */
const GUIDE_EPS = 0.1;

/** The three snap lines of a rect on the x axis: left edge, centre, right edge. */
function linesX(r: Rect): [number, number, number] {
    return [r.x, r.x + r.width / 2, r.x + r.width];
}
/** The three snap lines of a rect on the y axis: top edge, centre, bottom edge. */
function linesY(r: Rect): [number, number, number] {
    return [r.y, r.y + r.height / 2, r.y + r.height];
}

/**
 * Smallest signed delta that lands one of `moving`'s lines on one of a target's lines, within
 * `threshold` — 0 when nothing is close enough (no snap). Ties keep the first (smallest-index)
 * candidate, so the result is deterministic.
 */
function bestDelta(moving: readonly number[], targetLines: readonly (readonly number[])[], threshold: number): number {
    let best = 0;
    let bestAbs = Infinity;
    for (const t of targetLines) {
        for (const m of moving) {
            for (const tl of t) {
                const delta = tl - m;
                const abs = Math.abs(delta);
                if (abs <= threshold && abs < bestAbs) {
                    bestAbs = abs;
                    best = delta;
                }
            }
        }
    }
    return best;
}

/**
 * @param moving the moving node's proposed WORLD bounds (pre-snap).
 * @param targets other nodes' WORLD bounds (the moving node's own subtree must be excluded by the caller).
 * @param threshold snap distance in WORLD units (a screen-px budget ÷ zoom).
 */
export function computeSnap(moving: Rect, targets: readonly Rect[], threshold: number): SnapResult {
    const targetX = targets.map(linesX);
    const targetY = targets.map(linesY);
    const dx = bestDelta(linesX(moving), targetX, threshold);
    const dy = bestDelta(linesY(moving), targetY, threshold);
    const snapped: Rect = { x: moving.x + dx, y: moving.y + dy, width: moving.width, height: moving.height };
    return { dx, dy, guides: collectGuides(snapped, targets) };
}

/** Every alignment that holds for the SNAPPED rect, one guide per aligned coordinate (spans merged across targets). */
function collectGuides(snapped: Rect, targets: readonly Rect[]): SnapGuide[] {
    const byKey = new Map<string, SnapGuide>();
    const add = (axis: "x" | "y", pos: number, a: number, b: number) => {
        const key = `${axis}:${Math.round(pos * 100)}`;
        const existing = byKey.get(key);
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        if (existing) {
            existing.start = Math.min(existing.start, start);
            existing.end = Math.max(existing.end, end);
        } else {
            byKey.set(key, { axis, pos, start, end });
        }
    };
    const mx = linesX(snapped);
    const my = linesY(snapped);
    for (const t of targets) {
        const tx = linesX(t);
        const ty = linesY(t);
        // Vertical guide (aligned X): span the y-extent of both the moving node and the target.
        for (const m of mx) for (const tl of tx) if (Math.abs(m - tl) < GUIDE_EPS) {
            add("x", tl, Math.min(snapped.y, t.y), Math.max(snapped.y + snapped.height, t.y + t.height));
        }
        // Horizontal guide (aligned Y): span the x-extent of both.
        for (const m of my) for (const tl of ty) if (Math.abs(m - tl) < GUIDE_EPS) {
            add("y", tl, Math.min(snapped.x, t.x), Math.max(snapped.x + snapped.width, t.x + t.width));
        }
    }
    return [...byKey.values()];
}
