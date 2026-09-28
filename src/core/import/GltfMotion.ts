/**
 * @module GltfMotion
 * @description Bounded glTF TRS and morph sampling, four-influence skinning, and a 16-joint GPU palette.
 *
 * Morph deltas are applied before skinning, which is the glTF order. GPU skinning uploads that
 * palette; skins with more than 16 joints stay on the CPU path. Both paths share one vertex formula.
 */
import { GltfJson, GltfNode, readAccessor, nodeMatrix, multiplyMat4 } from "./Gltf";
import { GpuSkin, MeshInstance, MeshPrimitive, MESH_IDENTITY } from "./MeshData";

/** WebGL 1 vertex uniforms cannot hold the CPU joint cap. Sixteen leaves room beside the camera matrices. */
export const GPU_SKIN_JOINTS = 16;
export const MORPH_TARGETS_MAX = 8;

interface Channel { node: number; path: "translation" | "rotation" | "scale" | "weights"; times: Float64Array; values: Float64Array; interpolation: string; width: number; }
interface Clip { name: string; duration: number; channels: Channel[]; }
interface Skin { joints: number[]; inverseBind: number[][]; }
interface Influence { joints: Float64Array; weights: Float64Array; skin: number; }
interface Morph { node: number; targets: { positions: Float32Array; normals: Float32Array | null }[]; base: Float64Array; }
export interface GltfMotion {
    nodes: GltfNode[]; parents: number[]; clips: Clip[]; skins: Skin[]; influences: Map<MeshInstance, Influence>;
    morphs: Map<MeshInstance, Morph>;
}
export interface MotionPlayback { clip: number; secondaryClip?: number; blend?: number; speed?: number; loop?: boolean; }
export type SkinningMode = "cpu" | "gpu";

function required(json: GltfJson, index: number, buffer: Uint8Array, type: string): Float64Array {
    const accessor = json.accessors?.[index];
    if (!accessor || accessor.type !== type || accessor.count > 100000) throw new Error(`Unsupported ${type} animation/skin accessor.`);
    const data = readAccessor(json, index, buffer);
    if (!data || [...data].some(n => !Number.isFinite(n))) throw new Error("Unreadable or nonfinite animation/skin data.");
    return data;
}
function weightVector(values: number[] | undefined, count: number, label: string): Float64Array {
    const out = new Float64Array(count);
    if (!values) return out;
    if (values.length !== count || values.some(v => !Number.isFinite(v) || Math.abs(v) > 1e6)) throw new Error(`Invalid ${label} morph weights.`);
    out.set(values);
    return out;
}
export function readGltfMotion(json: GltfJson, buffer: Uint8Array, instances: readonly MeshInstance[]): GltfMotion | undefined {
    const meshes = json.meshes ?? [];
    const hasMorph = meshes.some(mesh => mesh.primitives?.some(primitive => (primitive.targets?.length ?? 0) > 0));
    if (!json.animations?.length && !json.skins?.length && !hasMorph) return undefined;
    if ((json.buffers?.length ?? 0) > 1) throw new Error("Animated glTF assets must use one buffer.");
    let valuesRead = 0;
    const read = (index: number, type: string) => {
        const data = required(json, index, buffer, type); valuesRead += data.length;
        if (valuesRead > 4_000_000) throw new Error("Animation/skin data exceeds four million scalar values.");
        return data;
    };
    const nodes = json.nodes ?? [], parents = nodes.map(() => -1);
    if (nodes.length > 4096 || (json.animations?.length ?? 0) > 256 || (json.skins?.length ?? 0) > 256) throw new Error("Animation rig exceeds its supported limits.");
    for (const [id, node] of nodes.entries()) for (const child of node.children ?? []) {
        if (!Number.isInteger(child) || !nodes[child] || parents[child] !== -1) throw new Error("Invalid animation node hierarchy.");
        parents[child] = id;
    }
    for (let id = 0; id < nodes.length; id++) {
        let at = id, depth = 0;
        while (at !== -1) { if (++depth > 64) throw new Error("Animation hierarchy is cyclic or too deep."); at = parents[at]; }
    }
    const morphCount = (node: number) => {
        const mesh = nodes[node]?.mesh === undefined ? undefined : meshes[nodes[node].mesh!];
        const counts = (mesh?.primitives ?? []).map(primitive => primitive.targets?.length ?? 0).filter(count => count > 0);
        if (!counts.length) return 0;
        if (counts.some(count => count !== counts[0] || count > MORPH_TARGETS_MAX)) throw new Error(`Morph targets must match across a mesh and stay within ${MORPH_TARGETS_MAX}.`);
        return counts[0];
    };
    const clips = (json.animations ?? []).map((clip, index): Clip => {
        if (!Array.isArray(clip.channels) || clip.channels.length > 1024) throw new Error("Invalid animation channels.");
        const used = new Set<string>();
        const channels = clip.channels.map((channel): Channel => {
            const target = channel.target, sampler = clip.samplers[channel.sampler];
            const path = target?.path;
            if (!target || !nodes[target.node] || nodes[target.node].matrix || !sampler
                || !["translation", "rotation", "scale", "weights"].includes(path ?? "")) throw new Error("Only TRS and morph-weight channels on non-matrix nodes are supported.");
            const key = `${target.node}:${path}`;
            if (used.has(key)) throw new Error("Duplicate animation target channel."); used.add(key);
            const times = read(sampler.input, "SCALAR");
            if (!times.length || times[0] < 0 || times.some((v, i) => i > 0 && v <= times[i - 1])) throw new Error("Animation times must be nonnegative and strictly increasing.");
            const interpolation = sampler.interpolation ?? "LINEAR";
            if (!["STEP", "LINEAR", "CUBICSPLINE"].includes(interpolation)) throw new Error("Unsupported animation interpolation.");
            const width = path === "rotation" ? 4 : path === "weights" ? morphCount(target.node) : 3;
            if (path === "weights" && width < 1) throw new Error("A morph-weight channel needs 1–8 morph targets on its mesh.");
            const values = read(sampler.output, path === "rotation" ? "VEC4" : path === "translation" || path === "scale" ? "VEC3" : "SCALAR");
            if (values.length !== times.length * width * (interpolation === "CUBICSPLINE" ? 3 : 1)) throw new Error("Animation output count does not match input times.");
            return { node: target.node, path: path as Channel["path"], times, values, interpolation, width };
        });
        return { name: clip.name || `Animation ${index + 1}`, duration: Math.max(0, ...channels.map(c => c.times[c.times.length - 1])), channels };
    });
    const skins = (json.skins ?? []).map((skin): Skin => {
        if (!Array.isArray(skin.joints) || !skin.joints.length || skin.joints.length > 128
            || new Set(skin.joints).size !== skin.joints.length || skin.joints.some(id => !Number.isInteger(id) || !nodes[id])) throw new Error("Invalid skin joints (maximum 128).");
        const data = skin.inverseBindMatrices === undefined ? null : read(skin.inverseBindMatrices, "MAT4");
        if (data && data.length !== skin.joints.length * 16) throw new Error("Inverse-bind count must match the joint count.");
        return { joints: skin.joints, inverseBind: skin.joints.map((_, i) => data ? Array.from(data.subarray(i * 16, i * 16 + 16)) : [...MESH_IDENTITY]) };
    });
    const influences = new Map<MeshInstance, Influence>();
    const morphs = new Map<MeshInstance, Morph>();
    let deformed = 0;
    for (const instance of instances) {
        const node = instance.nodeIndex === undefined ? undefined : nodes[instance.nodeIndex];
        const mesh = node?.mesh === undefined ? undefined : meshes[node.mesh];
        const primitive = node?.mesh === undefined ? undefined : mesh?.primitives[instance.primitiveIndex!];
        const targets = primitive?.targets ?? [];
        if (targets.length) {
            const count = instance.primitive.positions.length / 3; deformed += count;
            if (deformed > 100000) throw new Error("Morph/skin vertex limit exceeded (100000).");
            const decoded = targets.map(target => {
                if (target.POSITION === undefined) throw new Error("A morph target needs POSITION deltas.");
                const positions = read(target.POSITION, "VEC3");
                const normals = target.NORMAL === undefined ? null : read(target.NORMAL, "VEC3");
                if (positions.length !== count * 3 || (normals && normals.length !== count * 3)) throw new Error("Morph target vertex count does not match the primitive.");
                return { positions: Float32Array.from(positions), normals: normals ? Float32Array.from(normals) : null };
            });
            const base = weightVector(node!.weights ?? mesh?.weights, targets.length, "default");
            morphs.set(instance, { node: instance.nodeIndex!, targets: decoded, base });
        }
        if (node?.skin === undefined) continue;
        const skin = skins[node.skin];
        if (!skin || !primitive || primitive.attributes.JOINTS_1 !== undefined || primitive.attributes.WEIGHTS_1 !== undefined) throw new Error("Skinning supports exactly one four-influence joint/weight set.");
        const joints = read(primitive.attributes.JOINTS_0, "VEC4"), weights = read(primitive.attributes.WEIGHTS_0, "VEC4");
        const count = instance.primitive.positions.length / 3;
        if (!targets.length) deformed += count;
        if (deformed > 100000 || joints.length !== count * 4 || weights.length !== count * 4
            || joints.some(id => !Number.isInteger(id) || id < 0 || id >= skin.joints.length)
            || weights.some(w => w < 0)) throw new Error("Invalid joint weights or CPU skinning vertex limit exceeded (100000).");
        for (let v = 0; v < count; v++) {
            const sum = weights[v * 4] + weights[v * 4 + 1] + weights[v * 4 + 2] + weights[v * 4 + 3];
            if (!(sum > 0)) throw new Error("A skinned vertex has no positive weights.");
            for (let c = 0; c < 4; c++) weights[v * 4 + c] /= sum;
        }
        influences.set(instance, { joints, weights, skin: node.skin });
    }
    return { nodes, parents, clips, skins, influences, morphs };
}

function normalize(q: number[]): number[] {
    const length = Math.hypot(...q);
    if (!(length > 1e-12)) throw new Error("Animation produced a zero quaternion.");
    return q.map(v => v / length);
}
function mix(a: number[], b: number[], t: number, rotation: boolean): number[] {
    if (!rotation) return a.map((v, i) => v + (b[i] - v) * t);
    a = normalize(a); b = normalize(b);
    let dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
    if (dot < 0) { b = b.map(v => -v); dot = -dot; }
    if (dot > .9995) return normalize(a.map((v, i) => v + (b[i] - v) * t));
    const angle = Math.acos(Math.min(1, dot)), den = Math.sin(angle);
    return a.map((v, i) => (v * Math.sin((1 - t) * angle) + b[i] * Math.sin(t * angle)) / den);
}
function sample(channel: Channel, time: number): number[] {
    const { times, values, interpolation, width } = channel;
    const cubic = interpolation === "CUBICSPLINE", stride = width * (cubic ? 3 : 1);
    let lo = 0, hi = times.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (times[mid] <= time) lo = mid; else hi = mid - 1; }
    const left = lo, right = Math.min(left + 1, times.length - 1);
    const value = (i: number, offset = cubic ? 1 : 0) => Array.from(values.subarray(i * stride + offset * width, i * stride + (offset + 1) * width));
    const a = value(left), b = value(right);
    if (left === right || time <= times[0] || interpolation === "STEP") return channel.path === "rotation" ? normalize(a) : a;
    const duration = times[right] - times[left], t = Math.max(0, Math.min(1, (time - times[left]) / duration));
    if (!cubic) return mix(a, b, t, channel.path === "rotation");
    const out = value(left, 2), incoming = value(right, 0), t2 = t * t, t3 = t2 * t;
    const result = a.map((v, i) => (2 * t3 - 3 * t2 + 1) * v + (t3 - 2 * t2 + t) * duration * out[i]
        + (-2 * t3 + 3 * t2) * b[i] + (t3 - t2) * duration * incoming[i]);
    return channel.path === "rotation" ? normalize(result) : result;
}

/** Inverts an affine transform, including nonuniform scale. */
function inverse(m: readonly number[]): number[] {
    const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) throw new Error("Animation skin transform is singular.");
    const r = [(e*i-f*h)/det,(f*g-d*i)/det,(d*h-e*g)/det,0,(c*h-b*i)/det,(a*i-c*g)/det,(b*g-a*h)/det,0,
        (b*f-c*e)/det,(c*d-a*f)/det,(a*e-b*d)/det,0,0,0,0,1];
    for (let k = 0; k < 3; k++) r[12+k] = -(r[k]*m[12]+r[4+k]*m[13]+r[8+k]*m[14]);
    return r;
}
function transformPoint(m: readonly number[], x: number, y: number, z: number): [number, number, number] {
    return [m[0]*x + m[4]*y + m[8]*z + m[12], m[1]*x + m[5]*y + m[9]*z + m[13], m[2]*x + m[6]*y + m[10]*z + m[14]];
}
/** Inverse-transpose of the linear 3x3, matching the CPU skin normal and the vertex shader. */
export function linearSkinNormal(m: readonly number[], normal: readonly [number, number, number]): [number, number, number] {
    const a00 = m[0], a10 = m[1], a20 = m[2], a01 = m[4], a11 = m[5], a21 = m[6], a02 = m[8], a12 = m[9], a22 = m[10];
    const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
    if (Math.abs(det) < 1e-12) return [...normal];
    const i00 = (a11 * a22 - a12 * a21) / det, i01 = (a02 * a21 - a01 * a22) / det, i02 = (a01 * a12 - a02 * a11) / det;
    const i10 = (a12 * a20 - a10 * a22) / det, i11 = (a00 * a22 - a02 * a20) / det, i12 = (a02 * a10 - a00 * a12) / det;
    const i20 = (a10 * a21 - a11 * a20) / det, i21 = (a01 * a20 - a00 * a21) / det, i22 = (a00 * a11 - a01 * a10) / det;
    const r: [number, number, number] = [
        i00 * normal[0] + i10 * normal[1] + i20 * normal[2],
        i01 * normal[0] + i11 * normal[1] + i21 * normal[2],
        i02 * normal[0] + i12 * normal[1] + i22 * normal[2]
    ];
    const length = Math.hypot(...r) || 1;
    return [r[0] / length, r[1] / length, r[2] / length];
}
function blendMatrix(joints: readonly (readonly number[])[], indices: ArrayLike<number>, weights: ArrayLike<number>, vertex: number): number[] {
    const transform = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) {
        const weight = weights[vertex * 4 + c], joint = joints[indices[vertex * 4 + c]];
        for (let k = 0; k < 16; k++) transform[k] += weight * joint[k];
    }
    return transform;
}
function applyMorph(primitive: MeshPrimitive, morph: Morph, weights: ArrayLike<number>): Pick<MeshPrimitive, "positions" | "normals"> {
    const positions = new Float32Array(primitive.positions), normals = primitive.normals ? new Float32Array(primitive.normals) : null;
    for (let target = 0; target < morph.targets.length; target++) {
        const weight = weights[target] ?? 0;
        if (weight === 0) continue;
        const delta = morph.targets[target];
        for (let i = 0; i < positions.length; i++) positions[i] += weight * delta.positions[i];
        if (normals && delta.normals) for (let i = 0; i < normals.length; i++) normals[i] += weight * delta.normals[i];
    }
    if (normals) for (let i = 0; i < normals.length; i += 3) {
        const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
        if (length > 1e-12) { normals[i] /= length; normals[i + 1] /= length; normals[i + 2] /= length; }
    }
    return { positions, normals: normals ?? primitive.normals };
}

/** Eight corners of the rest bounds, transformed by every joint. A convex skin stays inside that hull. */
export function gpuSkinBounds(positions: ArrayLike<number>, palette: ArrayLike<number>): Float32Array {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]);
    }
    const corners: [number, number, number][] = [];
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
    const out = new Float32Array(corners.length * GPU_SKIN_JOINTS * 3);
    let at = 0;
    for (let joint = 0; joint < GPU_SKIN_JOINTS; joint++) {
        const offset = joint * 16;
        const matrix = palette.length >= offset + 16 ? Array.from(palette).slice(offset, offset + 16) : [...MESH_IDENTITY];
        for (const corner of corners) {
            const point = transformPoint(matrix, corner[0], corner[1], corner[2]);
            out[at++] = point[0]; out[at++] = point[1]; out[at++] = point[2];
        }
    }
    return out;
}

export function sampleGltfMotion(motion: GltfMotion, instances: readonly MeshInstance[], seconds: number, playback?: MotionPlayback, skinning: SkinningMode = "cpu"): MeshInstance[] {
    const pose = (clipIndex: number | undefined) => {
        const nodes = motion.nodes.map(n => ({ ...n })), weights = new Map<number, number[]>();
        const clip = clipIndex === undefined ? undefined : motion.clips[clipIndex];
        if (clip) {
            let time = Math.max(0, seconds * (playback?.speed ?? 1));
            time = playback?.loop !== false && clip.duration > 0 ? time % clip.duration : Math.min(time, clip.duration);
            for (const channel of clip.channels) {
                const value = sample(channel, time);
                if (channel.path === "weights") weights.set(channel.node, value);
                else nodes[channel.node][channel.path] = value;
            }
        }
        return { nodes, weights };
    };
    const primary = pose(playback?.clip);
    const blend = Math.max(0, Math.min(1, playback?.blend ?? 0));
    const secondary = playback?.secondaryClip !== undefined && blend > 0 ? pose(playback.secondaryClip) : undefined;
    if (secondary) {
        for (let id = 0; id < primary.nodes.length; id++) {
            primary.nodes[id].translation = mix(primary.nodes[id].translation ?? [0,0,0], secondary.nodes[id].translation ?? [0,0,0], blend, false);
            primary.nodes[id].scale = mix(primary.nodes[id].scale ?? [1,1,1], secondary.nodes[id].scale ?? [1,1,1], blend, false);
            primary.nodes[id].rotation = mix(primary.nodes[id].rotation ?? [0,0,0,1], secondary.nodes[id].rotation ?? [0,0,0,1], blend, true);
        }
    }
    const worlds: number[][] = [];
    const world = (id: number): number[] => worlds[id] ??= motion.parents[id] === -1 ? nodeMatrix(primary.nodes[id]) : multiplyMat4(world(motion.parents[id]), nodeMatrix(primary.nodes[id]));
    const weightsFor = (morph: Morph) => {
        const from = primary.weights.get(morph.node) ?? Array.from(morph.base);
        if (!secondary) return from;
        const to = secondary.weights.get(morph.node) ?? Array.from(morph.base);
        return mix(from, to, blend, false);
    };
    return instances.map(instance => {
        const matrix = instance.nodeIndex === undefined ? instance.matrix : world(instance.nodeIndex);
        const morph = motion.morphs.get(instance);
        const morphed = morph ? applyMorph(instance.primitive, morph, weightsFor(morph)) : null;
        const base: MeshPrimitive = morphed ? { ...instance.primitive, ...morphed } : instance.primitive;
        const skinData = motion.influences.get(instance);
        if (!skinData) return { ...instance, matrix, primitive: base, skin: undefined };
        const skin = motion.skins[skinData.skin], invMesh = inverse(matrix);
        const joints = skin.joints.map((id, i) => multiplyMat4(invMesh, multiplyMat4(world(id), skin.inverseBind[i])));
        const gpu = skinning === "gpu" && joints.length <= GPU_SKIN_JOINTS;
        if (gpu) {
            const palette = new Float32Array(GPU_SKIN_JOINTS * 16);
            for (let i = 0; i < GPU_SKIN_JOINTS; i++) palette.set(i < joints.length ? joints[i] : MESH_IDENTITY, i * 16);
            const skinPayload: GpuSkin = { joints: Float32Array.from(skinData.joints), weights: Float32Array.from(skinData.weights), palette };
            return { ...instance, matrix, primitive: base, skin: skinPayload };
        }
        const positions = new Float32Array(base.positions.length), normals = base.normals ? new Float32Array(base.normals.length) : null;
        for (let v = 0; v < positions.length / 3; v++) {
            const transform = blendMatrix(joints, skinData.joints, skinData.weights, v);
            const point = transformPoint(transform, base.positions[v * 3], base.positions[v * 3 + 1], base.positions[v * 3 + 2]);
            positions[v * 3] = point[0]; positions[v * 3 + 1] = point[1]; positions[v * 3 + 2] = point[2];
            if (normals && base.normals) {
                const n = linearSkinNormal(transform, [base.normals[v * 3], base.normals[v * 3 + 1], base.normals[v * 3 + 2]]);
                normals[v * 3] = n[0]; normals[v * 3 + 1] = n[1]; normals[v * 3 + 2] = n[2];
            }
        }
        return { ...instance, matrix, primitive: { ...base, positions, normals }, skin: undefined };
    });
}
