/**
 * @module Lighting.test
 * @description Pins the shared SVG/Canvas Lambert factors to the WebGL lighting contract.
 */

import { canvasLightingFilter, lightingFactors, lightingFilterId } from "./Lighting";

describe("renderer lighting parity", () => {
    test("combines ambient and coloured directional lights per channel", () => {
        const factors = lightingFactors([
            { x: 0, y: 0, z: -2, color: "#ff0000", intensity: 0.5 },
            { x: 0, y: 0, z: -1, color: "#0080ff", intensity: 0.25 }
        ], 0.1);
        expect(factors).not.toBeNull();
        expect(factors![0]).toBeCloseTo(0.6, 6);
        expect(factors![1]).toBeCloseTo(0.1 + (128 / 255) * 0.25, 6);
        expect(factors![2]).toBeCloseTo(0.35, 6);
    });

    test("matches WebGL's unlit fallback when no valid light reaches the shader", () => {
        expect(lightingFactors(undefined, 0.2)).toBeNull();
        expect(lightingFactors([], 0.2)).toBeNull();
        expect(lightingFactors([{ x: 0, y: 0, z: -1, color: "red", intensity: 1 }], 0.2)).toBeNull();
    });

    test("emits stable, self-contained sRGB component-transfer filters", () => {
        const factors = [0.25, 1, 1.5] as const;
        expect(lightingFilterId(factors)).toBe("lighting_0p25_1_1p5");
        const filter = canvasLightingFilter(factors);
        expect(filter).toContain("data:image/svg+xml,");
        expect(decodeURIComponent(filter)).toContain('color-interpolation-filters="sRGB"');
        expect(decodeURIComponent(filter)).toContain('feFuncB type="linear" slope="1.5"');
        expect(filter.endsWith('#vde-light\")')).toBe(true);
    });
});
