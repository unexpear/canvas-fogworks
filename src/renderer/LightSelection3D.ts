/**
 * @module LightSelection3D
 * @description Per-draw light culling and ranking for the WebGL 1 forward 3D renderer. A frame
 * may carry hundreds of authored lights; each draw gets only the strongest few that can reach its
 * world bounding sphere, within a shader light budget sized from the GPU fragment uniform limit.
 *
 * WHY PER DRAW AND NOT PER PIXEL: WebGL 1 has no uniform buffers, no integer textures and no
 * dynamic loop bounds, so a clustered light list would need float data textures plus a fixed
 * worst-case loop. Per-draw nearest-N selection keeps the existing PBR loop, needs nothing beyond
 * core WebGL 1, and matches how scenes of many small lights are authored: a string of bulbs lights
 * the walls and roof pieces next to it. The cost is that one very large mesh sees at most the
 * budget, ranked by contribution at the nearest point of its bounds.
 */

import type { FrameLight3D } from "./Scene3D";
import { gpuSkinBounds } from "../core/import/GltfMotion";
import type { GpuSkin } from "../core/import/MeshData";

/** Authored lights a frame keeps. Later lights in document order are dropped with a diagnostic. */
export const MAX_SCENE_LIGHTS_3D = 1024;
/** Shader light-array sizes, best first. The smallest is the pre-existing fixed limit. */
export const DRAW_LIGHT_TIERS_3D: readonly number[] = [16, 8, 4];
export const MAX_DRAW_LIGHTS_3D = 16;
export const MIN_DRAW_LIGHTS_3D = 4;
/**
 * Fragment uniform vectors the 3D shader spends on everything except the light arrays, rounded
 * up from a count of the declarations in emitWebGL3D (each scalar, bool, int or sampler can occupy
 * a full vec4 slot under the WebGL 1 packing rules).
 */
export const FRAGMENT_UNIFORM_RESERVE_3D = 64;
/** Each light is packed into two vec4 uniforms: position-or-direction plus kind, color plus range. */
export const VECTORS_PER_LIGHT_3D = 2;

/** Largest light tier whose uniforms fit the reported MAX_FRAGMENT_UNIFORM_VECTORS. */
export function drawLightBudget3D(maxFragmentUniformVectors: number): number {
    const available = Number.isFinite(maxFragmentUniformVectors) ? maxFragmentUniformVectors : 0;
    for (const tier of DRAW_LIGHT_TIERS_3D) {
        if (FRAGMENT_UNIFORM_RESERVE_3D + tier * VECTORS_PER_LIGHT_3D <= available) return tier;
    }
    return MIN_DRAW_LIGHTS_3D;
}

export interface Sphere3D { center: readonly [number, number, number]; radius: number }

const localBoundsCache = new WeakMap<ArrayLike<number>, Sphere3D | null>();

function localSphere(positions: ArrayLike<number>): Sphere3D | null {
    if (positions.length < 3) return null;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let at = 0; at + 2 < positions.length; at += 3) for (let axis = 0; axis < 3; axis++) {
        const value = positions[at + axis];
        if (!Number.isFinite(value)) continue;
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
    }
    if (!(min[0] <= max[0] && min[1] <= max[1] && min[2] <= max[2])) return null;
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] as const;
    return { center, radius: Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2]) };
}

/** Conservative world-space sphere around a draw. Null means unknown bounds: nothing is culled. */
export function drawBoundingSphere3D(positions: ArrayLike<number>, model: readonly number[],
                                     skin?: Pick<GpuSkin, "palette">): Sphere3D | null {
    let local: Sphere3D | null;
    if (skin) local = localSphere(gpuSkinBounds(positions, skin.palette));
    else if (typeof positions === "object" && localBoundsCache.has(positions)) local = localBoundsCache.get(positions)!;
    else { local = localSphere(positions); localBoundsCache.set(positions, local); }
    if (!local) return null;
    const [x, y, z] = local.center;
    const center = [model[0] * x + model[4] * y + model[8] * z + model[12],
        model[1] * x + model[5] * y + model[9] * z + model[13],
        model[2] * x + model[6] * y + model[10] * z + model[14]] as const;
    const scale = Math.max(Math.hypot(model[0], model[1], model[2]), Math.hypot(model[4], model[5], model[6]),
        Math.hypot(model[8], model[9], model[10]));
    const radius = local.radius * scale;
    if (!center.every(Number.isFinite) || !Number.isFinite(radius)) return null;
    return { center, radius };
}

export interface DrawLights3D {
    /** Indices into the frame light list, strongest first; directional lights lead. */
    indices: number[];
    /** Slot of the shadow-casting light within indices, or -1. */
    shadowSlot: number;
}

/** Contribution of a point light at the nearest point of the bounds, using the shader falloff. */
function pointScore(light: Extract<FrameLight3D, { kind: "point" }>, gap: number): number {
    const brightness = light.intensity * Math.max(light.color[0], light.color[1], light.color[2]);
    const ratio = gap / light.range;
    const window = Math.max(0, Math.min(1, 1 - ratio ** 4));
    // A light touching or inside the bounds is clamped to a quarter-unit so it ranks by brightness.
    return brightness * window / Math.max(gap * gap, 0.0625);
}

/**
 * Chooses at most budget lights for one draw. Directional lights always qualify (the shadow light
 * first). Point lights whose range cannot reach the sphere, or that carry no energy, are culled;
 * the rest rank by estimated contribution, then distance, then authored order, so the result is
 * deterministic for a given frame.
 */
export function selectDrawLights3D(lights: readonly FrameLight3D[], bounds: Sphere3D | null, budget: number,
                                   shadowLightIndex = -1): DrawLights3D {
    const limit = Math.max(0, Math.floor(budget));
    const ranked: { index: number; group: number; score: number; distance: number }[] = [];
    lights.forEach((light, index) => {
        if (light.kind === "directional") {
            ranked.push({ index, group: index === shadowLightIndex ? 0 : 1, score: Infinity, distance: 0 });
            return;
        }
        if (!(light.intensity > 0) || !(light.range > 0) || Math.max(...light.color) <= 0) return;
        let distance = 0, gap = 0;
        if (bounds) {
            distance = Math.hypot(light.position[0] - bounds.center[0], light.position[1] - bounds.center[1],
                light.position[2] - bounds.center[2]);
            gap = Math.max(0, distance - bounds.radius);
            if (gap >= light.range) return;
        }
        ranked.push({ index, group: 2, score: pointScore(light, gap), distance });
    });
    ranked.sort((a, b) => a.group - b.group || (b.score === a.score ? 0 : b.score - a.score)
        || a.distance - b.distance || a.index - b.index);
    const indices = ranked.slice(0, limit).map(item => item.index);
    return { indices, shadowSlot: shadowLightIndex >= 0 ? indices.indexOf(shadowLightIndex) : -1 };
}

export interface PackedLights3D {
    count: number;
    /** xyz: world position (point) or travel direction (directional); w: 0 directional, 1 point. */
    positions: Float32Array;
    /** rgb: linear color times intensity; w: point range (1 for directional). */
    colors: Float32Array;
}

/** Packs selected lights into the two vec4 arrays the fragment shader reads. */
export function packDrawLights3D(lights: readonly FrameLight3D[], indices: readonly number[], budget: number,
                                 out?: PackedLights3D): PackedLights3D {
    const size = Math.max(1, Math.floor(budget)) * 4;
    const packed = out && out.positions.length === size ? out
        : { count: 0, positions: new Float32Array(size), colors: new Float32Array(size) };
    packed.positions.fill(0); packed.colors.fill(0);
    let count = 0;
    for (const index of indices) {
        const light = lights[index];
        if (!light || count * 4 >= size) continue;
        const at = count * 4;
        if (light.kind === "directional") {
            packed.positions.set([light.direction[0], light.direction[1], light.direction[2], 0], at);
            packed.colors.set([light.color[0] * light.intensity, light.color[1] * light.intensity,
                light.color[2] * light.intensity, 1], at);
        } else {
            packed.positions.set([light.position[0], light.position[1], light.position[2], 1], at);
            packed.colors.set([light.color[0] * light.intensity, light.color[1] * light.intensity,
                light.color[2] * light.intensity, light.range], at);
        }
        count++;
    }
    packed.count = count;
    return packed;
}