/**
 * @module Lighting
 * @description Shared CPU-side scene-light calculation for SVG and Canvas renderer parity.
 */

import { Light, normalize } from "../core/document/Light";
import { parseColor } from "./Color";

export type LightingFactors = readonly [number, number, number];

/**
 * The WebGL fragment shader's Lambert sum for one surface normal.
 *
 * `null` means unlit. In particular, an empty list or a list containing only colours the GPU
 * cannot parse is unlit even when `ambient` is present: this mirrors `setLighting`, which sets
 * ambient to one when its valid light count is zero.
 */
export function lightingFactors(
    lights: readonly Light[] | undefined,
    ambient: number | undefined,
    normal: { x: number; y: number; z: number } = { x: 0, y: 0, z: 1 }
): LightingFactors | null {
    const valid: { light: Light; dir: { x: number; y: number; z: number }; color: [number, number, number, number] }[] = [];
    for (const light of lights ?? []) {
        const dir = normalize(light);
        const color = parseColor(light.color);
        if (dir && color) valid.push({ light, dir, color });
    }
    if (valid.length === 0) return null;

    let r = ambient ?? 0, g = ambient ?? 0, b = ambient ?? 0;
    for (const { light, dir, color } of valid) {
        const lambert = Math.max(normal.x * -dir.x + normal.y * -dir.y + normal.z * -dir.z, 0)
            * light.intensity;
        r += color[0] * lambert;
        g += color[1] * lambert;
        b += color[2] * lambert;
    }
    return [r, g, b];
}

/** Stable SVG-filter id for factors that may contain decimals or values above one. */
export function lightingFilterId(factors: LightingFactors): string {
    const token = (n: number): string => String(n).replace(/-/g, "n").replace(/\./g, "p").replace(/\+/g, "P");
    return `lighting_${token(factors[0])}_${token(factors[1])}_${token(factors[2])}`;
}

/**
 * A self-contained SVG component-transfer filter accepted by CanvasRenderingContext2D.filter.
 * Explicit sRGB is required: SVG filter primitives otherwise default to linearRGB while WebGL
 * multiplies the stored sRGB channel values directly.
 */
export function canvasLightingFilter(factors: LightingFactors): string {
    const xml = `<svg xmlns="http://www.w3.org/2000/svg"><filter id="vde-light" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="${factors[0]}"/><feFuncG type="linear" slope="${factors[1]}"/><feFuncB type="linear" slope="${factors[2]}"/></feComponentTransfer></filter></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(xml)}#vde-light")`;
}
