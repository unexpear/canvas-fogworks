/**
 * @module LightClusters3D
 * @description World-space light grid for per-pixel many-light shading in the WebGL 1 3D renderer.
 *
 * Point lights are binned into a uniform grid of cubic cells over their combined range bounds. Each
 * cell keeps up to MAX_CLUSTER_LIGHTS_3D lights (the strongest at the cell when it overflows), and
 * the lists are packed straight into an RGBA float texture: one row per cell, two texels per slot
 * (position plus range, then premultiplied color). A fragment finds its cell from its world
 * position and loops that row until a zero-range terminator, so one large mesh is lit by every
 * bulb near each of its pixels rather than by a per-draw subset.
 *
 * World cells rather than screen tiles because the grid only changes when lights change, so the
 * texture is uploaded once for a static scene; the CPU reference rasterizer shares the same cells.
 * The GPU path needs OES_texture_float, highp fragment floats and a ninth texture unit; without
 * them emitWebGL3D falls back to the per-draw LightSelection3D path.
 */

import type { FrameLight3D } from "./Scene3D";

/** Point lights one pixel can be shaded by (the fragment loop bound). */
export const MAX_CLUSTER_LIGHTS_3D = 32;
/** Cell budget; also bounded by MAX_TEXTURE_SIZE because each cell is one texture row. */
export const MAX_CLUSTER_CELLS_3D = 4096;
export const MAX_CLUSTER_AXIS_3D = 32;

type PointLight3D = Extract<FrameLight3D, { kind: "point" }>;

export interface LightClusters3D {
    origin: [number, number, number];
    cellSize: number;
    dims: [number, number, number];
    /** Frame light indices per cell, strongest first when the cell overflowed. */
    cells: number[][];
    slots: number;
    /** RGBA float texture: width = 2 * slots, height = cell count. */
    width: number;
    height: number;
    data: Float32Array;
    pointLights: number;
    overflowCells: number;
    /** Lights dropped from overflowing cells, summed over cells. */
    droppedAssignments: number;
    maxCellLights: number;
}

function energetic(light: FrameLight3D): light is PointLight3D {
    return light.kind === "point" && light.intensity > 0 && light.range > 0
        && Math.max(light.color[0], light.color[1], light.color[2]) > 0
        && light.position.every(Number.isFinite) && Number.isFinite(light.range);
}

/** Bins point lights into the grid. Null when the frame has no point light with energy. */
export function buildLightClusters3D(lights: readonly FrameLight3D[], slots = MAX_CLUSTER_LIGHTS_3D,
                                     maxCells = MAX_CLUSTER_CELLS_3D): LightClusters3D | null {
    const points: number[] = [];
    lights.forEach((light, index) => { if (energetic(light)) points.push(index); });
    if (points.length === 0) return null;
    slots = Math.max(1, Math.floor(slots));
    maxCells = Math.max(1, Math.floor(maxCells));
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const index of points) {
        const light = lights[index] as PointLight3D;
        for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], light.position[axis] - light.range);
            max[axis] = Math.max(max[axis], light.position[axis] + light.range);
        }
    }
    const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let cellSize = Math.max(1e-3, Math.max(...extent) / MAX_CLUSTER_AXIS_3D);
    const dimsFor = (size: number) => extent.map(e => Math.max(1, Math.ceil(e / size))) as [number, number, number];
    let dims = dimsFor(cellSize);
    while (dims[0] * dims[1] * dims[2] > maxCells) { cellSize *= 1.08; dims = dimsFor(cellSize); }
    const origin: [number, number, number] = [min[0], min[1], min[2]];
    const cellCount = dims[0] * dims[1] * dims[2];
    const candidates: { index: number; score: number }[][] = Array.from({ length: cellCount }, () => []);
    for (const index of points) {
        const light = lights[index] as PointLight3D;
        const lo = [0, 1, 2].map(a => Math.max(0, Math.floor((light.position[a] - light.range - origin[a]) / cellSize)));
        const hi = [0, 1, 2].map(a => Math.min(dims[a] - 1, Math.floor((light.position[a] + light.range - origin[a]) / cellSize)));
        const brightness = light.intensity * Math.max(light.color[0], light.color[1], light.color[2]);
        for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
            const cell = [x, y, z];
            let gap2 = 0, center2 = 0;
            for (let a = 0; a < 3; a++) {
                const low = origin[a] + cell[a] * cellSize, high = low + cellSize, p = light.position[a];
                const outside = p < low ? low - p : p > high ? p - high : 0;
                gap2 += outside * outside;
                const mid = p - (low + high) / 2; center2 += mid * mid;
            }
            if (gap2 >= light.range * light.range) continue;
            candidates[x + dims[0] * (y + dims[1] * z)].push({ index,
                score: brightness / Math.max(center2, 0.0625) });
        }
    }
    const width = slots * 2, data = new Float32Array(width * cellCount * 4);
    let overflowCells = 0, droppedAssignments = 0, maxCellLights = 0;
    const cells = candidates.map((list, row) => {
        if (list.length > slots) {
            overflowCells++; droppedAssignments += list.length - slots;
            list.sort((a, b) => b.score - a.score || a.index - b.index);
        }
        const kept = list.slice(0, slots).map(item => item.index);
        maxCellLights = Math.max(maxCellLights, list.length);
        kept.forEach((index, slot) => {
            const light = lights[index] as PointLight3D, at = (row * width + slot * 2) * 4;
            data.set([light.position[0], light.position[1], light.position[2], light.range,
                light.color[0] * light.intensity, light.color[1] * light.intensity, light.color[2] * light.intensity, 0], at);
        });
        return kept;
    });
    return { origin, cellSize, dims, cells, slots, width, height: cellCount, data, pointLights: points.length,
        overflowCells, droppedAssignments, maxCellLights };
}

/** Cell row for a world position, or -1 outside the grid. Mirrors the fragment shader. */
export function clusterRow3D(clusters: LightClusters3D, position: readonly [number, number, number]): number {
    const cell = [0, 1, 2].map(a => Math.floor((position[a] - clusters.origin[a]) / clusters.cellSize));
    if (cell.some((value, a) => !(value >= 0 && value < clusters.dims[a]))) return -1;
    return cell[0] + clusters.dims[0] * (cell[1] + clusters.dims[1] * cell[2]);
}

/** Frame light indices shading a world position under the per-pixel path. */
export function clusterLightsAt3D(clusters: LightClusters3D | null, position: readonly [number, number, number]): readonly number[] {
    if (!clusters) return [];
    const row = clusterRow3D(clusters, position);
    return row < 0 ? [] : clusters.cells[row];
}

/** Order-sensitive hash of every light field, so an unchanged light set skips re-binning and upload. */
export function lightSignature3D(lights: readonly FrameLight3D[]): number {
    const scratch = new Float32Array(1), bits = new Uint32Array(scratch.buffer);
    let hash = 2166136261 ^ lights.length;
    const mix = (value: number) => { scratch[0] = value; hash = Math.imul(hash ^ bits[0], 16777619); };
    for (const light of lights) {
        mix(light.kind === "point" ? 1 : 0); mix(light.intensity);
        for (const c of light.color) mix(c);
        if (light.kind === "point") { for (const p of light.position) mix(p); mix(light.range); }
        else for (const d of light.direction) mix(d);
    }
    return hash >>> 0;
}