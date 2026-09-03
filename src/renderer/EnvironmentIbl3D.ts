/**
 * @module EnvironmentIbl3D
 * @description Deterministic offline diffuse-irradiance and GGX specular prefiltering for
 * authored Radiance environments. Results are transient renderer assets, never document data.
 */

import { HdrEnvironmentImage } from "./HdrEnvironment";

export interface EnvironmentIbl3D {
    source: HdrEnvironmentImage;
    diffuse: HdrEnvironmentImage;
    /** Increasing roughness, from mirror-like to fully rough. */
    specular: readonly HdrEnvironmentImage[];
}

export interface EnvironmentIblOptions3D {
    diffuseWidth?: number;
    specularWidth?: number;
    specularLevels?: number;
    samples?: number;
}

const TAU = Math.PI * 2;

function radicalInverse(bits: number): number {
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    return bits * 2.3283064365386963e-10;
}

function directionAt(x: number, y: number, width: number, height: number): [number, number, number] {
    const phi = ((x + 0.5) / width - 0.5) * TAU;
    const theta = (y + 0.5) / height * Math.PI;
    const sinTheta = Math.sin(theta);
    return [Math.cos(phi) * sinTheta, Math.cos(theta), Math.sin(phi) * sinTheta];
}

function basis(n: readonly number[]): [[number, number, number], [number, number, number]] {
    const up: [number, number, number] = Math.abs(n[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
    const tx = up[1] * n[2] - up[2] * n[1], ty = up[2] * n[0] - up[0] * n[2];
    const tz = up[0] * n[1] - up[1] * n[0], length = Math.hypot(tx, ty, tz) || 1;
    const t: [number, number, number] = [tx / length, ty / length, tz / length];
    return [t, [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]]];
}

/** Bilinear equirectangular lookup: horizontal wraps and poles clamp. */
export function sampleEnvironment3D(image: HdrEnvironmentImage, direction: readonly number[]): [number, number, number] {
    const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    const x = direction[0] / length, y = direction[1] / length, z = direction[2] / length;
    const u = ((Math.atan2(z, x) / TAU + 0.5) % 1 + 1) % 1;
    const v = Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI;
    const fx = u * image.width - 0.5, fy = v * image.height - 0.5;
    const x0 = Math.floor(fx), y0 = Math.max(0, Math.min(image.height - 1, Math.floor(fy)));
    const x1 = x0 + 1, y1 = Math.max(0, Math.min(image.height - 1, y0 + 1));
    const tx = fx - x0, ty = Math.max(0, Math.min(1, fy - Math.floor(fy)));
    const read = (px: number, py: number, channel: number) =>
        image.rgb[(py * image.width + ((px % image.width) + image.width) % image.width) * 3 + channel];
    return [0, 1, 2].map(channel => {
        const a = read(x0, y0, channel) * (1 - tx) + read(x1, y0, channel) * tx;
        const b = read(x0, y1, channel) * (1 - tx) + read(x1, y1, channel) * tx;
        return a * (1 - ty) + b * ty;
    }) as [number, number, number];
}

function convolve(image: HdrEnvironmentImage, width: number, samples: number, roughness: number,
                  diffuse: boolean): HdrEnvironmentImage {
    const height = Math.max(1, Math.floor(width / 2)), rgb = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const n = directionAt(x, y, width, height), [t, b] = basis(n);
        const sum = [0, 0, 0]; let weight = 0;
        for (let i = 0; i < samples; i++) {
            const u = (i + 0.5) / samples, v = radicalInverse(i);
            let cosTheta: number;
            if (diffuse) cosTheta = Math.sqrt(1 - u);
            else {
                const a = Math.max(0.025, roughness * roughness);
                cosTheta = Math.sqrt((1 - u) / Math.max(1e-8, 1 + (a * a - 1) * u));
            }
            const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta)), phi = TAU * v;
            const lx = Math.cos(phi) * sinTheta, ly = Math.sin(phi) * sinTheta, lz = cosTheta;
            const hemisphere = [t[0] * lx + b[0] * ly + n[0] * lz,
                t[1] * lx + b[1] * ly + n[1] * lz, t[2] * lx + b[2] * ly + n[2] * lz];
            // Diffuse samples L directly. GGX importance-samples the half vector H and reflects
            // V=N around it to obtain L, weighted by N·L as the split-sum prefilter requires.
            const direction = diffuse ? hemisphere : [2 * cosTheta * hemisphere[0] - n[0],
                2 * cosTheta * hemisphere[1] - n[1], 2 * cosTheta * hemisphere[2] - n[2]];
            const color = sampleEnvironment3D(image, direction);
            const w = diffuse ? 1 : Math.max(0, n[0] * direction[0] + n[1] * direction[1] + n[2] * direction[2]);
            for (let c = 0; c < 3; c++) sum[c] += color[c] * w;
            weight += w;
        }
        const at = (y * width + x) * 3;
        for (let c = 0; c < 3; c++) rgb[at + c] = sum[c] / Math.max(weight, 1e-8);
    }
    return { width, height, rgb };
}

/** Generates bounded renderer-ready IBL maps. Defaults favor editor responsiveness. */
export function prefilterEnvironment3D(image: HdrEnvironmentImage,
                                       options: EnvironmentIblOptions3D = {}): EnvironmentIbl3D {
    const diffuseWidth = Math.max(4, Math.min(64, Math.floor(options.diffuseWidth ?? 16)));
    const specularWidth = Math.max(4, Math.min(256, Math.floor(options.specularWidth ?? 32)));
    const levels = Math.max(2, Math.min(6, Math.floor(options.specularLevels ?? 4)));
    const samples = Math.max(8, Math.min(512, Math.floor(options.samples ?? 32)));
    return {
        source: image,
        diffuse: convolve(image, diffuseWidth, samples, 1, true),
        specular: Array.from({ length: levels }, (_, level) =>
            convolve(image, Math.max(4, specularWidth >> level), samples,
                level / Math.max(1, levels - 1), false))
    };
}

const CACHE = new WeakMap<object, EnvironmentIbl3D>();

/** Shared lazy cache: viewport rebuilds reuse the same offline result until source identity changes. */
export function preparedEnvironment3D(image: HdrEnvironmentImage): EnvironmentIbl3D {
    const cached = CACHE.get(image);
    if (cached) return cached;
    const prepared = prefilterEnvironment3D(image);
    CACHE.set(image, prepared);
    return prepared;
}
