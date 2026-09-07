/**
 * @module AnimatedTriangle
 * @description Original glTF animated/skinned fixture shared by numerical tests, rendering smoke and benchmarks; no third-party artwork.
 */
import { GltfJson, parseGltf } from "../import/Gltf";
import { readGltfMotion } from "../import/GltfMotion";

export function animatedTriangle(skinned = true, interpolation = "LINEAR") {
    const chunks: Uint8Array[] = [], views: NonNullable<GltfJson["bufferViews"]> = [], accessors: NonNullable<GltfJson["accessors"]> = [];
    let length = 0;
    const add = (values: number[], type: string, width: number, joints = false) => {
        const bytes = new Uint8Array((joints ? new Uint16Array(values) : new Float32Array(values)).buffer);
        const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4); padded.set(bytes); chunks.push(padded);
        views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length }); length += padded.length;
        accessors.push({ bufferView: views.length - 1, componentType: joints ? 5123 : 5126, count: values.length / width, type });
        return accessors.length - 1;
    };
    const POSITION = add([0,0,0, 1,0,0, 0,1,0], "VEC3", 3), NORMAL = add([0,0,1, 0,0,1, 0,0,1], "VEC3", 3);
    const JOINTS_0 = add(new Array(12).fill(0), "VEC4", 4, true), WEIGHTS_0 = add([1,0,0,0, 1,0,0,0, 1,0,0,0], "VEC4", 4);
    const input = add([0,1], "SCALAR", 1);
    const output = add(interpolation === "CUBICSPLINE" ? [0,0,0, 0,0,0, 0,0,0, 0,0,0, 2,0,0, 0,0,0] : [0,0,0, 2,0,0], "VEC3", 3);
    const second = add([0,0,0, 0,2,0], "VEC3", 3);
    const json: GltfJson = { asset: { version: "2.0" }, buffers: [{ byteLength: length }], bufferViews: views, accessors,
        nodes: [{ mesh: 0, ...(skinned ? { skin: 0 } : {}) }, {}], scenes: [{ nodes: [0,1] }], scene: 0,
        meshes: [{ primitives: [{ attributes: { POSITION, NORMAL, ...(skinned ? { JOINTS_0, WEIGHTS_0 } : {}) } }] }],
        ...(skinned ? { skins: [{ joints: [1] }] } : {}),
        animations: [{ name: "Right", samplers: [{ input, output, interpolation }], channels: [{ sampler: 0, target: { node: skinned ? 1 : 0, path: "translation" } }] },
            { name: "Up", samplers: [{ input, output: second }], channels: [{ sampler: 0, target: { node: skinned ? 1 : 0, path: "translation" } }] }] };
    const buffer = new Uint8Array(length); let at = 0; for (const chunk of chunks) { buffer.set(chunk, at); at += chunk.length; }
    const instances = parseGltf(json, buffer).instances, motion = readGltfMotion(json, buffer, instances)!;
    return { json, buffer, instances, motion };
}
