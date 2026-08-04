/**
 * @module DashPath
 * @description A dashed line as GEOMETRY — the pieces, not a rendering flag.
 *
 * SVG and Canvas both take a dash pattern as an instruction (`stroke-dasharray`, `setLineDash`)
 * and do the cutting themselves. A GPU takes triangles, so this backend has to know where the gaps
 * actually are — which is the same shape of problem `StrokeOutline` solved for the border itself,
 * and it gets the same answer: cut the path into the runs that are drawn, and let the existing
 * outliner turn each into rings.
 *
 * That the GPU is the only caller does not make this a GPU concern. The pieces are a property of
 * the path and the pattern, computable without a screen, so they belong here where they can be
 * checked by length — and a future exporter that has to emit dashes for a format without them
 * needs exactly this.
 *
 * SVG's own semantics, because agreeing with the other two backends is the whole point:
 *   - An ODD-length pattern REPEATS to become even. `4` is `4 4`; `1 2 3` is `1 2 3 1 2 3`. This
 *     is not a nicety — without it, `1 2 3` would end a cycle on a gap and start the next on a
 *     dash, and the pattern would alternate its meaning every lap.
 *   - The offset shifts where in the pattern the path STARTS, and it is taken modulo the cycle so
 *     a large one behaves like the small one it is equivalent to.
 *   - The pattern runs CONTINUOUSLY along a subpath and RESTARTS at the next, so two separate
 *     contours each begin with a dash rather than the second inheriting the first's phase.
 *
 * A pattern that is invalid or draws nothing — empty, negative, all zeros — comes back as a SOLID
 * line rather than as an empty one, which is what SVG does with the same input. Refusing to draw
 * because a dash spec was malformed would hide the shape entirely; drawing it solid shows the
 * geometry with the wrong texture, which is visible and recoverable.
 */

import { PathCommand } from "../document/Node";
import { FLATTEN_TOLERANCE, flattenPath } from "./ShapeHit";

/**
 * A dash spec as numbers, or null when it does not describe a dash.
 *
 * Null for anything SVG treats as "draw it solid": no numbers, a negative one, or a pattern whose
 * lengths are all zero. That last is the one worth naming — it parses, it is not negative, and it
 * would put the walk below into a loop that advances by nothing forever.
 */
export function parseDashArray(spec: string): number[] | null {
    const parts = spec.trim().split(/[\s,]+/).filter(p => p.length > 0).map(Number);
    if (parts.length === 0) return null;
    if (parts.some(n => !Number.isFinite(n) || n < 0)) return null;
    if (parts.every(n => n === 0)) return null;
    // ODD patterns repeat to become even; see the module note.
    return parts.length % 2 === 0 ? parts : [...parts, ...parts];
}

/** Distance between two points — hoisted because the walk below does nothing else as often. */
function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * The drawn RUNS of a dashed path, each an open polyline of `M`/`L` commands.
 *
 * Curves are FLATTENED first, and that is the one real approximation here: a dash's length is
 * measured along the polyline rather than along the curve, so a coarse tolerance makes dashes on a
 * tight curve slightly short. It is the same trade every other consumer of `flattenPath` makes,
 * against the same stated tolerance, and the alternative — arc-length parameterising a cubic — is
 * a numeric integration per segment for an error the flattener already bounds.
 *
 * Each run is OPEN even when the source contour was closed, which is not a detail: a dash has two
 * ends, and they take the stroke's CAP. A closed ring handed to the outliner would instead be
 * joined back to itself, which is exactly the seam a dash is supposed to leave.
 */
export function dashSubpaths(commands: readonly PathCommand[], pattern: readonly number[],
                             offset: number = 0, tolerance: number = FLATTEN_TOLERANCE): PathCommand[][] {
    const cycle = pattern.reduce((a, b) => a + b, 0);
    if (cycle <= 0) return [];
    const out: PathCommand[][] = [];

    for (const sub of flattenPath(commands, tolerance)) {
        const points = sub.closed && sub.points.length > 1 ? [...sub.points, sub.points[0]] : sub.points;
        if (points.length < 2) continue;

        // Where in the pattern this subpath begins. Taken modulo the cycle, and made positive, so
        // a negative or huge offset lands where the equivalent small one would. The pattern
        // RESTARTS here rather than continuing from the previous subpath — see the module note.
        let phase = ((offset % cycle) + cycle) % cycle;
        let index = 0;
        while (phase >= pattern[index]) {
            phase -= pattern[index];
            index = (index + 1) % pattern.length;
        }
        let on = index % 2 === 0;
        let remaining = pattern[index] - phase;

        let run: PathCommand[] = on ? [{ c: "M", x: points[0].x, y: points[0].y }] : [];
        for (let i = 0; i + 1 < points.length; i++) {
            const a = points[i], b = points[i + 1];
            let travelled = 0;
            const segment = dist(a, b);
            // A zero-length segment would otherwise spin here: it can never consume `remaining`,
            // so the loop below would never advance. Flattening can emit one wherever a curve's
            // control points coincide.
            if (segment === 0) continue;
            while (travelled + remaining < segment) {
                travelled += remaining;
                const t = travelled / segment;
                const cut = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
                if (on) {
                    // No length check: `on` means a run was opened with an `M` below, and this
                    // adds an `L`, so it is always at least two commands. A guard here was
                    // provably equivalent to nothing, which a mutation of it demonstrated — the
                    // check at the END of the subpath is the one that earns its place, where a
                    // dash opening exactly at the last point leaves a lone `M`.
                    run.push({ c: "L", x: cut.x, y: cut.y });
                    out.push(run);
                    run = [];
                }
                // Advance through the pattern, STEPPING OVER zero-length entries — `5 0` is a
                // legal spec (a solid line drawn as abutting dashes) and a zero entry advances
                // nothing, so stopping on one would cut at the same point forever.
                do {
                    on = !on;
                    index = (index + 1) % pattern.length;
                    remaining = pattern[index];
                } while (remaining === 0);
                // A new dash starts HERE, whatever the walk stepped over to get here. This has to
                // come after the loop rather than inside the branch above: skipping a zero-length
                // gap lands back on a dash, and an earlier version flipped the flag without
                // opening a run — so every run after the first began with an `L` and no `M`.
                if (on) run = [{ c: "M", x: cut.x, y: cut.y }];
            }
            remaining -= segment - travelled;
            if (on) run.push({ c: "L", x: b.x, y: b.y });
        }
        // The last run reaches the end of the subpath rather than being dropped: a path whose
        // length is not a whole number of cycles ends mid-dash, and that partial dash is drawn.
        if (on && run.length > 1) out.push(run);
    }
    return out;
}
