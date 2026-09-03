/**
 * @module EditorGrid.test
 * @description Pins visible-grid coarsening and nearest-line threshold behavior.
 */

import { gridSnapDelta, visibleGridSize } from "./EditorGrid";
import { computeSnapWithGrid, snapPointWithGrid } from "./Snapping";

test("the tool sees the same coarsened grid a large low-zoom viewport renders", () => {
    expect(visibleGridSize(800, 600, 1)).toBe(20);
    expect(visibleGridSize(800, 600, 0.1)).toBe(40);
    expect(visibleGridSize(2400, 1200, 0.05)).toBe(160);
});

test("grid snapping is nearest-line, signed, thresholded and total", () => {
    expect(gridSnapDelta(38, 20, 6)).toBe(2);
    expect(gridSnapDelta(43, 20, 6)).toBe(-3);
    expect(gridSnapDelta(47, 20, 6)).toBeNull();
    expect(gridSnapDelta(40, 20, 0)).toBe(0);
    expect(gridSnapDelta(4, 0, 6)).toBeNull();
});

test("box snapping composes grid and smart guides by nearest distance", () => {
    const moving = { x: 38, y: 43, width: 10, height: 10 };
    expect(computeSnapWithGrid(moving, [], 6, 20)).toMatchObject({ dx: 2, dy: -3, guides: [] });

    // Smart x is one unit away while the grid is two; grid y remains nearer.
    const target = { x: 39, y: 100, width: 10, height: 10 };
    expect(computeSnapWithGrid(moving, [target], 6, 20)).toMatchObject({ dx: 1, dy: -3 });
});

test("resize point snapping uses the same smart-guide and grid precedence", () => {
    const target = { x: 39, y: 100, width: 10, height: 10 };
    expect(snapPointWithGrid(38, 43, [target], 6, 20)).toEqual({ dx: 1, dy: -3 });
    // Exact tie goes to the smart target, deterministically.
    expect(snapPointWithGrid(38, 43, [{ x: 36, y: 100, width: 0, height: 1 }], 6, 20).dx).toBe(-2);
});
