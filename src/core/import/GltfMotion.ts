/**
 * @module GltfMotion
 * @description Bounded glTF transform animation and four-influence CPU skinning with STEP/LINEAR/CUBICSPLINE sampling and pose blending.
 */
import { GltfJson, GltfNode, readAccessor, nodeMatrix, multiplyMat4 } from "./Gltf";
import { MeshInstance, MESH_IDENTITY } from "./MeshData";

interface Channel { node: number; path: "translation" | "rotation" | "scale"; times: Float64Array; values: Float64Array; interpolation: string; }
interface Clip { name: string; duration: number; channels: Channel[]; }
interface Skin { joints: number[]; inverseBind: number[][]; }
interface Influence { joints: Float64Array; weights: Float64Array; skin: number; }
export interface GltfMotion {
    nodes: GltfNode[]; parents: number[]; clips: Clip[]; skins: Skin[]; influences: Map<MeshInstance, Influence>;
}
export interface MotionPlayback { clip: number; secondaryClip?: number; blend?: number; speed?: number; loop?: boolean; }

function required(json: GltfJson, index: number, buffer: Uint8Array, type: string): Float64Array {
    const accessor = json.accessors?.[index];
    if (!accessor || accessor.type !== type || accessor.count > 100000) throw new Error(`Unsupported ${type} animation/skin accessor.`);
    const data = readAccessor(json, index, buffer);
    if (!data || [...data].some(n => !Number.isFinite(n))) throw new Error("Unreadable or nonfinite animation/skin data.");
    return data;
}
export function readGltfMotion(json: GltfJson, buffer: Uint8Array, instances: readonly MeshInstance[]): GltfMotion | undefined {
    if (!json.animations?.length && !json.skins?.length) return undefined;
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
    const clips = (json.animations ?? []).map((clip, index): Clip => {
        if (!Array.isArray(clip.channels) || clip.channels.length > 1024) throw new Error("Invalid animation channels.");
        const used = new Set<string>();
        const channels = clip.channels.map((channel): Channel => {
            const target = channel.target, sampler = clip.samplers[channel.sampler];
            if (!target || !nodes[target.node] || nodes[target.node].matrix || !["translation", "rotation", "scale"].includes(target.path)
                || !sampler) throw new Error("Only TRS animation channels on non-matrix nodes are supported (no morph animation).");
            const key = `${target.node}:${target.path}`;
            if (used.has(key)) throw new Error("Duplicate animation target channel."); used.add(key);
            const times = read(sampler.input, "SCALAR");
            if (!times.length || times[0] < 0 || times.some((v, i) => i > 0 && v <= times[i - 1])) throw new Error("Animation times must be nonnegative and strictly increasing.");
            const interpolation = sampler.interpolation ?? "LINEAR";
            if (!["STEP", "LINEAR", "CUBICSPLINE"].includes(interpolation)) throw new Error("Unsupported animation interpolation.");
            const values = read(sampler.output, target.path === "rotation" ? "VEC4" : "VEC3");
            if (values.length !== times.length * (target.path === "rotation" ? 4 : 3) * (interpolation === "CUBICSPLINE" ? 3 : 1)) throw new Error("Animation output count does not match input times.");
            return { node: target.node, path: target.path as Channel["path"], times, values, interpolation };
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
    let skinnedVertices = 0;
    for (const instance of instances) {
        const node = nodes[instance.nodeIndex!];
        if (node?.skin === undefined) continue;
        const skin = skins[node.skin], primitive = json.meshes?.[node.mesh!]?.primitives[instance.primitiveIndex!];
        if (!skin || !primitive || primitive.attributes.JOINTS_1 !== undefined || primitive.attributes.WEIGHTS_1 !== undefined) throw new Error("Skinning supports exactly one four-influence joint/weight set.");
        const joints = read(primitive.attributes.JOINTS_0, "VEC4"), weights = read(primitive.attributes.WEIGHTS_0, "VEC4");
        const count = instance.primitive.positions.length / 3; skinnedVertices += count;
        if (skinnedVertices > 100000 || joints.length !== count * 4 || weights.length !== count * 4
            || joints.some(id => !Number.isInteger(id) || id < 0 || id >= skin.joints.length)
            || weights.some(w => w < 0)) throw new Error("Invalid joint weights or CPU skinning vertex limit exceeded (100000).");
        for (let v = 0; v < count; v++) {
            const sum = weights[v * 4] + weights[v * 4 + 1] + weights[v * 4 + 2] + weights[v * 4 + 3];
            if (!(sum > 0)) throw new Error("A skinned vertex has no positive weights.");
            for (let c = 0; c < 4; c++) weights[v * 4 + c] /= sum;
        }
        influences.set(instance, { joints, weights, skin: node.skin });
    }
    return { nodes, parents, clips, skins, influences };
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
    const { times, values, interpolation } = channel, width = channel.path === "rotation" ? 4 : 3;
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
export function sampleGltfMotion(motion: GltfMotion, instances: readonly MeshInstance[], seconds: number, playback?: MotionPlayback): MeshInstance[] {
    const pose = (clipIndex: number | undefined) => {
        const nodes = motion.nodes.map(n => ({ ...n })), clip = clipIndex === undefined ? undefined : motion.clips[clipIndex];
        if (clip) {
            let time = Math.max(0, seconds * (playback?.speed ?? 1));
            time = playback?.loop !== false && clip.duration > 0 ? time % clip.duration : Math.min(time, clip.duration);
            for (const channel of clip.channels) nodes[channel.node][channel.path] = sample(channel, time);
        }
        return nodes;
    };
    const nodes = pose(playback?.clip);
    if (playback?.secondaryClip !== undefined && (playback.blend ?? 0) > 0) {
        const secondary = pose(playback.secondaryClip), t = Math.max(0, Math.min(1, playback.blend ?? 0));
        for (let id = 0; id < nodes.length; id++) {
            nodes[id].translation = mix(nodes[id].translation ?? [0,0,0], secondary[id].translation ?? [0,0,0], t, false);
            nodes[id].scale = mix(nodes[id].scale ?? [1,1,1], secondary[id].scale ?? [1,1,1], t, false);
            nodes[id].rotation = mix(nodes[id].rotation ?? [0,0,0,1], secondary[id].rotation ?? [0,0,0,1], t, true);
        }
    }
    const worlds: number[][] = [];
    const world = (id: number): number[] => worlds[id] ??= motion.parents[id] === -1 ? nodeMatrix(nodes[id]) : multiplyMat4(world(motion.parents[id]), nodeMatrix(nodes[id]));
    return instances.map(instance => {
        const matrix = instance.nodeIndex === undefined ? instance.matrix : world(instance.nodeIndex);
        const skinData = motion.influences.get(instance);
        if (!skinData) return { ...instance, matrix };
        const skin = motion.skins[skinData.skin], invMesh = inverse(matrix);
        const joints = skin.joints.map((id, i) => multiplyMat4(invMesh, multiplyMat4(world(id), skin.inverseBind[i])));
        const original = instance.primitive, positions = new Float32Array(original.positions.length), normals = original.normals ? new Float32Array(original.normals.length) : null;
        for (let v = 0; v < positions.length / 3; v++) {
            const transform = new Array(16).fill(0);
            for (let c = 0; c < 4; c++) {
                const weight = skinData.weights[v * 4 + c], joint = joints[skinData.joints[v * 4 + c]];
                for (let k = 0; k < 16; k++) transform[k] += weight * joint[k];
            }
            for (let k = 0; k < 3; k++) positions[v*3+k] = transform[k]*original.positions[v*3] + transform[4+k]*original.positions[v*3+1] + transform[8+k]*original.positions[v*3+2] + transform[12+k];
            if (normals && original.normals) {
                const inv = inverse(transform), n = [0,1,2].map(k => inv[k*4]*original.normals![v*3] + inv[k*4+1]*original.normals![v*3+1] + inv[k*4+2]*original.normals![v*3+2]);
                const length = Math.hypot(...n) || 1; for (let k = 0; k < 3; k++) normals[v*3+k] = n[k] / length;
            }
        }
        return { ...instance, matrix, primitive: { ...original, positions, normals } };
    });
}
