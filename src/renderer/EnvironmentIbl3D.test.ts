/** @module EnvironmentIbl3D.test @description Deterministic IBL prefilter coverage. */

import { prefilterEnvironment3D, sampleEnvironment3D } from "./EnvironmentIbl3D";

describe("3D environment prefilter", () => {
    const constant = { width: 4, height: 2, rgb: new Float32Array(24).fill(2) };

    test("bilinear equirectangular sampling wraps and preserves a constant field", () => {
        expect(sampleEnvironment3D(constant, [1, 0, 0])).toEqual([2, 2, 2]);
        expect(sampleEnvironment3D(constant, [-1, 1, 0])).toEqual([2, 2, 2]);
    });

    test("builds bounded diffuse and ordered GGX roughness levels", () => {
        const ibl = prefilterEnvironment3D(constant, { diffuseWidth: 4, specularWidth: 8,
            specularLevels: 3, samples: 8 });
        expect([ibl.diffuse.width, ibl.diffuse.height]).toEqual([4, 2]);
        expect(ibl.specular.map(level => [level.width, level.height])).toEqual([[8, 4], [4, 2], [4, 2]]);
        for (const map of [ibl.diffuse, ...ibl.specular]) {
            expect(Array.from(map.rgb).every(value => Math.abs(value - 2) < 1e-6)).toBe(true);
        }
    });
});
