/**
 * @module Alignment
 * @description Pure align + distribute maths for a multi-selection — the toolbar row every
 * design tool has, and (by every account of how these tools are actually used) among the
 * highest-leverage controls in one.
 *
 * DOM-free and node-tested, like `GroupTransform` and `Snapping`: the functions take world
 * rects and return the new ORIGIN for each, and the editor turns those into geometry patches.
 * Keeping the maths free of the document is what makes "did it align?" a unit test rather than
 * a screenshot.
 *
 * The reference frame is the selection's own bounding box, not the canvas: aligning left means
 * every box moves to the leftmost edge IN THE SELECTION. That is what every tool does, and it
 * makes align idempotent — running it twice changes nothing the second time.
 */

import { Rect } from "./Matrix";

/** Which edge (or centre line) the selection is aligned to. */
export type AlignEdge = "left" | "center-h" | "right" | "top" | "center-v" | "bottom";
/** Which axis the selection is spread along. */
export type DistributeAxis = "horizontal" | "vertical";

/** A box's new top-left, keyed by its index in the input array. Only MOVED boxes appear. */
export type Placements = Map<number, { x: number; y: number }>;

/** The union of every box — the selection's own bounding box, which alignment references. */
function unionOf(boxes: readonly Rect[]): Rect {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function allFinite(boxes: readonly Rect[]): boolean {
    return boxes.every(b => [b.x, b.y, b.width, b.height].every(Number.isFinite));
}

/**
 * Align every box to one edge (or centre line) of the selection's bounding box.
 *
 * Returns only the boxes that actually MOVE, so a caller can skip a no-op edit entirely rather
 * than push an undo step that changes nothing — aligning an already-aligned selection is a
 * common accidental click.
 */
export function alignBoxes(boxes: readonly Rect[], edge: AlignEdge): Placements {
    const out: Placements = new Map();
    // The `< 2` half states the precondition; it is not load-bearing, since a single box IS its
    // own union and would compute a zero move anyway. The `allFinite` half is load-bearing — a
    // NaN box poisons the union and would move every other box to NaN.
    if (boxes.length < 2 || !allFinite(boxes)) return out;
    const u = unionOf(boxes);

    boxes.forEach((b, i) => {
        let { x, y } = b;
        switch (edge) {
            case "left": x = u.x; break;
            case "center-h": x = u.x + (u.width - b.width) / 2; break;
            case "right": x = u.x + u.width - b.width; break;
            case "top": y = u.y; break;
            case "center-v": y = u.y + (u.height - b.height) / 2; break;
            case "bottom": y = u.y + u.height - b.height; break;
        }
        if (x !== b.x || y !== b.y) out.set(i, { x, y });
    });
    return out;
}

/**
 * Spread the boxes so the GAPS BETWEEN them are equal along one axis. The two extreme boxes
 * stay put and everything between them is repositioned — the convention every design tool
 * uses, and the one that matches the intent ("even this out") rather than equalising centres,
 * which looks wrong whenever the boxes are different sizes.
 *
 * Needs at least THREE boxes: with two there is a single gap, which is already even. An
 * overlapping selection (the boxes are wider than their span) yields a negative gap, which is
 * still deterministic and reversible rather than a special case.
 */
export function distributeBoxes(boxes: readonly Rect[], axis: DistributeAxis): Placements {
    const out: Placements = new Map();
    // As in `alignBoxes`, the COUNT half states the precondition rather than enforcing it —
    // distributing two boxes is arithmetically a no-op (the pair is its own even spacing), so
    // the result would be empty regardless. `allFinite` is the half that actually guards.
    if (boxes.length < 3 || !allFinite(boxes)) return out;
    const horizontal = axis === "horizontal";
    const u = unionOf(boxes);

    // Work in sorted order, but report against the ORIGINAL indices: the caller's array is its
    // selection, and re-ordering that would silently reassign positions to the wrong nodes.
    const order = boxes.map((b, i) => i).sort((a, b) => {
        const pa = horizontal ? boxes[a].x : boxes[a].y;
        const pb = horizontal ? boxes[b].x : boxes[b].y;
        return pa - pb || a - b;   // stable for exact ties, so the result is deterministic
    });

    const extent = (b: Rect) => (horizontal ? b.width : b.height);
    const span = horizontal ? u.width : u.height;
    const used = order.reduce((sum, i) => sum + extent(boxes[i]), 0);
    const gap = (span - used) / (order.length - 1);

    let cursor = horizontal ? u.x : u.y;
    for (const i of order) {
        const b = boxes[i];
        const x = horizontal ? cursor : b.x;
        const y = horizontal ? b.y : cursor;
        if (x !== b.x || y !== b.y) out.set(i, { x, y });
        cursor += extent(b) + gap;
    }
    return out;
}
