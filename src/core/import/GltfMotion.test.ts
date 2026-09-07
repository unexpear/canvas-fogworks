/**
 * @module GltfMotion.test
 * @description Original numerical glTF fixtures verify transform sampling, quaternion interpolation, skin deformation, blending and malformed-input refusal.
 */
import { readGltfMotion, sampleGltfMotion } from "./GltfMotion";
import { animatedTriangle as fixture } from "../examples/AnimatedTriangle";

test("linear skinning moves vertices through joint transforms without modifying imported buffers", () => {
    const f = fixture();
    const result = sampleGltfMotion(f.motion, f.instances, .5, { clip: 0 });
    expect(Array.from(result[0].primitive.positions)).toEqual([1,0,0, 2,0,0, 1,1,0]);
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
    expect(() => readGltfMotion(bad.json, bad.buffer, bad.instances)).toThrow("no morph animation");
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
