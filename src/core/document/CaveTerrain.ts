/**
 * @module CaveTerrain
 * @description A cave, as the QUESTION a tile grid answers — cellular automata over `Tilemap.terrain`.
 *
 * IT WRITES TERRAIN, NOT TILES, which is what makes it four rules and not a renderer. Schema 63 made
 * a layer store WHICH CELLS ARE ROCK and derive the picture through `Autotile`, so a generator has
 * only to answer that question and `resolveTilemaps` draws it — the art, the sixteen masks and the
 * coastline at the map edge are all already somebody else's job.
 *
 * THE RULE IS ONE RULE WITH THREE NAMES, and knowing that is worth more than picking between them.
 * "At least 5 of the 3x3 are rock", "B5678/S45678", and "more than 4 neighbours makes rock, fewer
 * than 4 makes floor, exactly 4 changes nothing" are the SAME function — checked exhaustively over
 * all eighteen (state, neighbour-count) pairs, which is a test in this repo rather than a claim
 * here. Written as `self + neighbours >= 5` because that form makes the next paragraph visible.
 *
 * THE CELL ITSELF IS NOT ONE OF ITS NEIGHBOURS. Counting it and keeping the threshold at 5 gives a
 * rule that is no longer SELF-DUAL, and self-duality is the property that stops the map drifting:
 * a threshold rule `w*self + n >= t` is self-dual exactly when `t = (w+9)/2`, so `w=1, t=5` is and
 * `w=2, t=5` is not — it sits half a step towards rock and grows rock on every pass, ending near
 * 62% rock from a 45% fill. Both misreadings are easy, neither throws, and the only symptom is a
 * cave that is wrong.
 *
 * OFF THE GRID IS ROCK, which is the same decision `dualMask` makes for the same reason: it is what
 * closes the cave at the map's edge instead of letting it open into nothing.
 *
 * A FIXED NUMBER OF PASSES, AND NEVER "UNTIL IT STOPS CHANGING". That loop does not terminate: this
 * rule is a symmetric threshold network under parallel update, so its orbits have period 1 or 2 and
 * nothing longer (Goles & Olivos 1980), and the period-2 ones never settle. Measured here: 11 of
 * 400 seeds cycle forever, typically a handful of cells flipping on a diagonal rock edge. Five
 * passes is not convergence either — the map is still moving at forty — it is where the STRUCTURE
 * stops moving, floor regions falling 474 -> 41 -> 12 -> 7 -> 5 -> 4 against 3 asymptotically.
 */

import { Rng } from "../random/Rng";

/** How the cave is shaped. Every default is a measured number — see the module header. */
export interface CaveOptions {
    /**
     * The chance a cell starts as rock, 0..1.
     *
     * 0.45 SITS BETWEEN TWO COMPUTABLE THRESHOLDS rather than being taste. Below about 0.407 — the
     * square lattice's site-percolation point — the raw noise's floor already spans the map, so the
     * passes have nothing to carve and the result is one open room. Above about 0.49 the rule is
     * approaching the self-dual 0.50 where coarsening has no preferred direction, and the floor
     * shatters into pockets. The window's midpoint is 0.4535.
     */
    fill?: number;
    /** How many passes. See the header: five, and never a convergence test. */
    passes?: number;
    /**
     * How many cells of solid rock to force around the edge. TWO, and this is a fact about the DUAL
     * GRID rather than about caves: the display grid is one larger each way, so its outermost ring
     * has three of its four corners off the terrain and can never read as full rock whatever the
     * terrain says. A margin of 1 therefore leaves a ragged fringe — measured 0 of 56 display cells
     * full at margin 1, and 56 of 56 at margin 2.
     */
    margin?: number;
    /**
     * Whether to fill every pocket but the largest, so the cave is one connected space.
     *
     * FLOOR IS FOUR-CONNECTED HERE while rock is eight-connected, and the asymmetry is deliberate:
     * if both were eight-connected, two floor regions touching only at a diagonal would count as
     * joined while the rock between them also counts as joined, and both cannot be true. Four for
     * the thing that is walked, eight for the thing that blocks.
     */
    connect?: boolean;
}

/** What was generated, and enough about it for a panel to say whether it is any good. */
export interface CaveResult {
    /** `cols * rows` material ids — `material` for rock, 0 for open floor. Ready for `TerrainField.cells`. */
    cells: number[];
    /** How many cells are open floor. */
    floor: number;
    /** How many separate floor regions remain — 1 when `connect` did its job, 0 for a solid map. */
    regions: number;
}

const DEFAULTS = { fill: 0.45, passes: 5, margin: 2, connect: true };

/**
 * A cave's terrain cells.
 *
 * PURE, and reproducible for a given `Rng`: the same seed gives the same cave in this process and
 * the next one, because a generated map that changes when reopened is not a document.
 */
export function caveCells(
    cols: number, rows: number, material: number, rng: Rng, options: CaveOptions = {}
): CaveResult {
    const fill = clamp01(options.fill ?? DEFAULTS.fill);
    const passes = Math.max(0, Math.floor(options.passes ?? DEFAULTS.passes));
    const margin = Math.max(0, Math.floor(options.margin ?? DEFAULTS.margin));
    const connect = options.connect ?? DEFAULTS.connect;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        return { cells: [], floor: 0, regions: 0 };
    }

    // ROCK IS 1 AND FLOOR IS 0 WHILE THE AUTOMATON RUNS, and the material is written in at the end.
    // The rule counts neighbours, and counting "cells equal to 7" reads as arithmetic about 7.
    let cur = new Uint8Array(cols * rows);
    for (let i = 0; i < cur.length; i++) cur[i] = rng.next() < fill ? 1 : 0;
    forceMargin(cur, cols, rows, margin);

    let next = new Uint8Array(cols * rows);
    for (let p = 0; p < passes; p++) {
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let n = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        // THE CELL IS NOT ITS OWN NEIGHBOUR — see the header. Skipping this line is
                        // the misreading that grows rock every pass.
                        if (dr === 0 && dc === 0) continue;
                        const rr = r + dr, cc = c + dc;
                        // OFF THE GRID IS ROCK, which is what closes the cave at the edge.
                        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) { n++; continue; }
                        n += cur[rr * cols + cc];
                    }
                }
                next[r * cols + c] = cur[r * cols + c] + n >= 5 ? 1 : 0;
            }
        }
        const swap = cur; cur = next; next = swap;
    }

    if (connect) keepLargestRegion(cur, cols, rows);

    const cells = new Array<number>(cols * rows);
    let floor = 0;
    for (let i = 0; i < cur.length; i++) {
        if (cur[i] === 0) floor++;
        cells[i] = cur[i] === 1 ? material : 0;
    }
    return { cells, floor, regions: countRegions(cur, cols, rows) };
}

function clamp01(v: number): number {
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULTS.fill;
}

/**
 * Solid rock `margin` cells deep on every side, applied ONCE before the passes.
 *
 * ONCE IS ENOUGH, and only because off the grid counts as rock — that is the whole reason the two
 * rules are written down together. An edge cell has five off-grid neighbours, so it sees six rock
 * with itself and stays rock; the ring behind it sees five and stays too. Re-applying after every
 * pass was the obvious thing to write and it MASKED the other rule: with the border stamped back
 * on each time, making off-grid count as floor changed nothing anybody could observe, and a mutant
 * that did exactly that survived. Removing the redundant stamp is what makes the border a
 * consequence of the rules rather than a cosmetic.
 */
function forceMargin(cells: Uint8Array, cols: number, rows: number, margin: number): void {
    if (margin <= 0) return;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (c < margin || r < margin || c >= cols - margin || r >= rows - margin) cells[r * cols + c] = 1;
        }
    }
}

/** Every four-connected floor region, as a label per cell (-1 for rock) and the sizes. */
function labelFloor(cells: Uint8Array, cols: number, rows: number): { label: Int32Array; sizes: number[] } {
    const label = new Int32Array(cols * rows).fill(-1);
    const sizes: number[] = [];
    const stack: number[] = [];
    for (let start = 0; start < cells.length; start++) {
        if (cells[start] === 1 || label[start] !== -1) continue;
        const id = sizes.length;
        let size = 0;
        // ITERATIVE, with an explicit stack — the same reason `fillRegion` gives: a recursive flood
        // over a large grid is a stack overflow rather than a slow fill.
        stack.push(start);
        label[start] = id;
        while (stack.length > 0) {
            const at = stack.pop()!;
            size++;
            const c = at % cols, r = (at - c) / cols;
            if (c > 0 && cells[at - 1] === 0 && label[at - 1] === -1) { label[at - 1] = id; stack.push(at - 1); }
            if (c < cols - 1 && cells[at + 1] === 0 && label[at + 1] === -1) { label[at + 1] = id; stack.push(at + 1); }
            if (r > 0 && cells[at - cols] === 0 && label[at - cols] === -1) { label[at - cols] = id; stack.push(at - cols); }
            if (r < rows - 1 && cells[at + cols] === 0 && label[at + cols] === -1) { label[at + cols] = id; stack.push(at + cols); }
        }
        sizes.push(size);
    }
    return { label, sizes };
}

/** Fill every floor region but the biggest, so what is left is one connected cave. */
function keepLargestRegion(cells: Uint8Array, cols: number, rows: number): void {
    const { label, sizes } = labelFloor(cells, cols, rows);
    if (sizes.length <= 1) return;
    let best = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
    for (let i = 0; i < cells.length; i++) if (label[i] !== -1 && label[i] !== best) cells[i] = 1;
}

function countRegions(cells: Uint8Array, cols: number, rows: number): number {
    return labelFloor(cells, cols, rows).sizes.length;
}
