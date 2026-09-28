/**
 * @module GltfMotion.test
 * @description Original numerical glTF fixtures verify transform sampling, quaternion interpolation, skin deformation, blending and malformed-input refusal.
 */
import { gpuSkinBounds, linearSkinNormal, readGltfMotion, sampleGltfMotion } from "./GltfMotion";
import { GltfJson } from "./Gltf";
import { animatedTriangle as fixture } from "../examples/AnimatedTriangle";
import { MESH_IDENTITY } from "./MeshData";

test("linear skinning moves vertices through joint transforms without modifying imported buffers", () => {
    const f = fixture();
    const result = sampleGltfMotion(f.motion, f.instances, .5, { clip: 0 });
    expect(Array.from(result[0].primitive.positions)).toEqual([1,0,0, 2,0,0, 1,1,0]);
    expect(result[0].skin).toBeUndefined();
    expect(Array.from(f.instances[0].primitive.positions)).toEqual([0,0,0, 1,0,0, 0,1,0]);
    expect(Array.from(result[0].primitive.normals!)).toEqual([0,0,1, 0,0,1, 0,0,1]);
});
test("unskinned transform tracks, loop/clamp and secondary-pose blending", () => {
    const f = fixture(false);
    expect(sampleGltfMotion(f.motion, f.instances, .5, { clip: 0 })[0].matrix[12]).toBe(1);
    expect(sampleGltfMotion(f.motion, f.instances, 1, { clip: 0 })[0].matrix[12]).toBe(0);
    expect(sampleGltfMotion(f.motion, f.instances, 1, { clip: 0, loop: false })[0].matrix[12]).toBe(2);
    const mixed = sampleGltfMotion(f.motion, f.instances, .5, { clip: 0, secondaryClip: 1, blend: .5 })[0];
    expect(mixed.matrix[12]).toBe(.5); expect(mixed.matrix[13]).toBe(.5);
});
test("STEP holds and cubic Hermite interpolation scales tangents by key interval", () => {
    const step = fixture(true, "STEP"), cubic = fixture(true, "CUBICSPLINE");
    expect(sampleGltfMotion(step.motion, step.instances, .5, { clip: 0 })[0].primitive.positions[0]).toBe(0);
    expect(sampleGltfMotion(cubic.motion, cubic.instances, .5, { clip: 0 })[0].primitive.positions[0]).toBe(1);
});
test("cyclic hierarchies and mismatched channels fail during import", () => {
    const f = fixture(); f.json.nodes![0].children = [1]; f.json.nodes![1].children = [0];
    expect(() => readGltfMotion(f.json, f.buffer, f.instances)).toThrow("cyclic");
    const bad = fixture(); bad.json.animations![0].channels[0].target.path = "weights";
    expect(() => readGltfMotion(bad.json, bad.buffer, bad.instances)).toThrow("morph targets");
});

test("quaternion channels slerp through a normalized ninety-degree midpoint", () => {
    const f = fixture(), output = new Float32Array([0,0,0,1, 0,0,1,0]);
    const buffer = new Uint8Array(f.buffer.length + output.byteLength); buffer.set(f.buffer); buffer.set(new Uint8Array(output.buffer), f.buffer.length);
    f.json.bufferViews!.push({ buffer: 0, byteOffset: f.buffer.length, byteLength: output.byteLength });
    f.json.accessors!.push({ bufferView: f.json.bufferViews!.length - 1, componentType: 5126, count: 2, type: "VEC4" });
    f.json.animations![0].samplers[0].output = f.json.accessors!.length - 1;
    f.json.animations![0].channels[0].target.path = "rotation";
    const motion = readGltfMotion(f.json, buffer, f.instances)!;
    const positions = sampleGltfMotion(motion, f.instances, .5, { clip: 0 })[0].primitive.positions;
    expect(positions[3]).toBeCloseTo(0); expect(positions[4]).toBeCloseTo(1);
});

test("cubic outgoing tangents scale by the two-second key interval", () => {
    const f = fixture(true, "CUBICSPLINE"), channel = f.motion.clips[0].channels[0];
    channel.times[1] = 2; f.motion.clips[0].duration = 2; channel.values[6] = 1;
    expect(sampleGltfMotion(f.motion, f.instances, 1, { clip: 0 })[0].primitive.positions[0]).toBeCloseTo(1.25);
});

function replayPalette(palette: ArrayLike<number>, joints: ArrayLike<number>, weights: ArrayLike<number>, positions: ArrayLike<number>): number[] {
    const out: number[] = [];
    for (let v = 0; v < positions.length / 3; v++) {
        let x = 0, y = 0, z = 0;
        for (let c = 0; c < 4; c++) {
            const weight = weights[v * 4 + c], at = joints[v * 4 + c] * 16;
            const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
            x += weight * (palette[at] * px + palette[at + 4] * py + palette[at + 8] * pz + palette[at + 12]);
            y += weight * (palette[at + 1] * px + palette[at + 5] * py + palette[at + 9] * pz + palette[at + 13]);
            z += weight * (palette[at + 2] * px + palette[at + 6] * py + palette[at + 10] * pz + palette[at + 14]);
        }
        out.push(x, y, z);
    }
    return out;
}

test("gpu skinning keeps bind-pose positions and a palette that replays the cpu bake", () => {
    const f = fixture();
    const cpu = sampleGltfMotion(f.motion, f.instances, .5, { clip: 0 })[0];
    const gpu = sampleGltfMotion(f.motion, f.instances, .5, { clip: 0 }, "gpu")[0];
    expect(Array.from(gpu.primitive.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(gpu.skin!.palette[12]).toBeCloseTo(1);
    expect(replayPalette(gpu.skin!.palette, gpu.skin!.joints, gpu.skin!.weights, gpu.primitive.positions))
        .toEqual(Array.from(cpu.primitive.positions));
    const wide = fixture();
    while (wide.motion.skins[0].joints.length <= 16) {
        wide.motion.skins[0].joints.push(wide.motion.skins[0].joints[0]);
        wide.motion.skins[0].inverseBind.push([...MESH_IDENTITY]);
    }
    const fallback = sampleGltfMotion(wide.motion, wide.instances, .5, { clip: 0 }, "gpu")[0];
    expect(fallback.skin).toBeUndefined();
    expect(Array.from(fallback.primitive.positions)).toEqual(Array.from(cpu.primitive.positions));
});

test("skin normals use the inverse-transpose, including a ninety-degree rotation", () => {
    const scaled = linearSkinNormal([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1], [1, 1, 0]);
    const raw = [0.5, 1 / 3, 0], length = Math.hypot(...raw);
    expect(scaled[0]).toBeCloseTo(raw[0] / length);
    expect(scaled[1]).toBeCloseTo(raw[1] / length);
    expect(scaled[2]).toBeCloseTo(0);
    const turned = linearSkinNormal([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1], [0, 0, 1]);
    expect(turned[0]).toBeCloseTo(0); expect(turned[1]).toBeCloseTo(-1); expect(turned[2]).toBeCloseTo(0);
});

test("joint-transformed rest corners bound a gpu skin", () => {
    const bounds = gpuSkinBounds(new Float32Array([0, 0, 0]), (() => {
        const palette = new Float32Array(16 * 16);
        for (let i = 0; i < 16; i++) palette.set(MESH_IDENTITY, i * 16);
        palette[12] = 5;
        return palette;
    })());
    expect(Array.from(bounds).filter(v => v === 5).length).toBe(8);
});

function appendFloats(json: GltfJson, buffer: Uint8Array, values: number[], type: string, width: number): { buffer: Uint8Array; index: number } {
    const bytes = new Uint8Array(new Float32Array(values).buffer);
    const padded = Math.ceil(bytes.length / 4) * 4;
    const next = new Uint8Array(buffer.length + padded);
    next.set(buffer); next.set(bytes, buffer.length);
    json.bufferViews!.push({ buffer: 0, byteOffset: buffer.length, byteLength: bytes.length });
    json.accessors!.push({ bufferView: json.bufferViews!.length - 1, componentType: 5126, count: values.length / width, type });
    json.buffers![0].byteLength = next.length;
    return { buffer: next, index: json.accessors!.length - 1 };
}

test("morph weights move vertices before skinning and are not renormalized", () => {
    const plain = fixture(false);
    const target = appendFloats(plain.json, plain.buffer, [1, 0, 0, 0, 0, 0, 0, 0, 0], "VEC3", 3);
    const weights = appendFloats(plain.json, target.buffer, [0, 1], "SCALAR", 1);
    const times = appendFloats(plain.json, weights.buffer, [0, 1], "SCALAR", 1);
    plain.json.meshes![0].primitives[0].targets = [{ POSITION: target.index }];
    plain.json.animations = [{ name: "Bulge", samplers: [{ input: times.index, output: weights.index }],
        channels: [{ sampler: 0, target: { node: 0, path: "weights" } }] }];
    const motion = readGltfMotion(plain.json, times.buffer, plain.instances)!;
    expect(sampleGltfMotion(motion, plain.instances, .5, { clip: 0 })[0].primitive.positions[0]).toBeCloseTo(.5);

    const posed = fixture(true);
    const delta = appendFloats(posed.json, posed.buffer, [1, 0, 0, 0, 0, 0, 0, 0, 0], "VEC3", 3);
    posed.json.meshes![0].primitives[0].targets = [{ POSITION: delta.index }];
    posed.json.nodes![0].weights = [1];
    posed.json.nodes![1].scale = [2, 1, 1];
    posed.json.animations = [];
    const skinned = readGltfMotion(posed.json, delta.buffer, posed.instances)!;
    const cpu = sampleGltfMotion(skinned, posed.instances, 0)[0];
    expect(cpu.primitive.positions[0]).toBeCloseTo(2);
    const gpu = sampleGltfMotion(skinned, posed.instances, 0, undefined, "gpu")[0];
    expect(gpu.primitive.positions[0]).toBeCloseTo(1);
    expect(gpu.skin!.palette[0]).toBeCloseTo(2);
});
