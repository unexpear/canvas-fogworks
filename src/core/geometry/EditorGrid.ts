/**
 * @module EditorGrid
 * @description Shared visible-grid spacing and nearest-line arithmetic for rendering and tools.
 */

export const GRID_BASE = 20;
export const GRID_MAX_LINES_PER_AXIS = 300;

/** The grid step actually visible for this canvas and zoom, including density coarsening. */
export function visibleGridSize(width: number, height: number, zoom: number): number {
    const z = Math.max(0.01, zoom);
    const worldWidth = Math.max(0, width) / z;
    const worldHeight = Math.max(0, height) / z;
    let step = GRID_BASE;
    while (worldWidth / step > GRID_MAX_LINES_PER_AXIS
        || worldHeight / step > GRID_MAX_LINES_PER_AXIS) step *= 2;
    return step;
}

/** Signed delta to the nearest grid line, or null when it lies outside the snap budget. */
export function gridSnapDelta(value: number, step: number, threshold: number): number | null {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0
        || !Number.isFinite(threshold) || threshold < 0) return null;
    const delta = Math.round(value / step) * step - value;
    return Math.abs(delta) <= threshold ? delta : null;
}

