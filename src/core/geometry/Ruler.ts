/**
 * @module Ruler
 * @description Pure tick computation for the editor's rulers. Given a visible WORLD range and the
 * zoom, it returns evenly-spaced ticks at a "nice" step (1/2/5 × 10ᵏ) chosen so they land roughly
 * `targetPx` apart on screen. DOM-free and node-tested; the app maps `world` → screen and draws the
 * bars. The ruler is screen-fixed chrome (it shows the current view's coordinates), not document
 * content, so it lives outside the render model.
 */

export interface RulerTick {
    /** Tick position in WORLD units. */
    world: number;
    /** Coordinate label (integer when the step is ≥ 1, else with just enough decimals). */
    label: string;
    /** Every 5th tick — a candidate for a longer mark / emphasised label. */
    major: boolean;
}

/** A "nice" step (1/2/5 × 10ᵏ) ≥ the world span that maps to one target-pixel budget. */
export function niceStep(worldPerTarget: number): number {
    if (!(worldPerTarget > 0) || !Number.isFinite(worldPerTarget)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(worldPerTarget)));
    const frac = worldPerTarget / pow;
    const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    return nice * pow;
}

function formatTick(world: number, step: number): string {
    // Snap a near-integer to kill float noise (e.g. 99.99999999 → "100").
    const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
    const s = world.toFixed(decimals);
    // `-0` reads oddly on a ruler.
    return s === `-${(0).toFixed(decimals)}` ? (0).toFixed(decimals) : s;
}

/**
 * Ticks covering `[worldStart, worldEnd]` at a zoom-adaptive nice step. Empty for a non-positive or
 * non-finite range; the count is capped defensively so a pathological range can't explode.
 * @param targetPx desired on-screen spacing between ticks (world step = niceStep(targetPx / zoom)).
 */
export function rulerTicks(worldStart: number, worldEnd: number, zoom: number, targetPx = 80): RulerTick[] {
    const z = Math.max(0.01, zoom);
    if (!Number.isFinite(worldStart) || !Number.isFinite(worldEnd) || !(worldEnd > worldStart)) return [];
    const step = niceStep(targetPx / z);
    const firstIndex = Math.ceil(worldStart / step);
    const lastIndex = Math.floor(worldEnd / step);
    if (!Number.isFinite(firstIndex) || !Number.isFinite(lastIndex) || lastIndex - firstIndex > 1000) return [];

    const ticks: RulerTick[] = [];
    for (let i = firstIndex; i <= lastIndex; i++) {
        const world = i * step;
        ticks.push({ world, label: formatTick(world, step), major: i % 5 === 0 });
    }
    return ticks;
}
