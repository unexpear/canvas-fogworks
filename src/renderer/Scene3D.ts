/**
 * @module Scene3D
 * @description Backend-neutral 3D frame construction, camera math and deterministic
 * reference rasterization for the 3D viewport proof.
 *
 * Imported mesh bytes live in a transient library keyed by persisted Asset3D ids. The
 * document remains authoritative for identity and transforms; GPU/CPU buffers are derived.
 */

import { ReadonlyDocument } from "../core/document/Document";
import { applyFrame } from "../core/document/Timeline";
import { dropHidden } from "../core/document/Components";
import { Camera3D, Transform3D } from "../core/document/Spatial3D";
import { GpuSkin, MeshInstance, MeshPrimitive } from "../core/import/MeshData";
import { gpuSkinBounds, GltfMotion, sampleGltfMotion } from "../core/import/GltfMotion";
import { HdrEnvironmentImage } from "./HdrEnvironment";
import { EnvironmentIbl3D, preparedEnvironment3D } from "./EnvironmentIbl3D";
import {generateBlockout,BlockoutShape} from "../core/geometry/Blockout3D";
import {solidTreeGeometry3D} from "../core/geometry/SolidTree3D";
import { drawBoundingSphere3D, MAX_DRAW_LIGHTS_3D, MAX_SCENE_LIGHTS_3D, selectDrawLights3D } from "./LightSelection3D";

export type Mat4 = number[];

// Bounded value cache keeps stable GPU buffer identity across immutable document snapshots.
const blockoutMeshes=new Map<string,MeshPrimitive>();
function blockoutMesh(shape:BlockoutShape):MeshPrimitive{
    const key=JSON.stringify(shape),cached=blockoutMeshes.get(key);
    if(cached){blockoutMeshes.delete(key);blockoutMeshes.set(key,cached);return cached;}
    const mesh=generateBlockout(shape).mesh;blockoutMeshes.set(key,mesh);
    if(blockoutMeshes.size>32)blockoutMeshes.delete(blockoutMeshes.keys().next().value!);
    return mesh;
}

export interface MeshAsset3D {
    motion?: GltfMotion;
    instances: readonly MeshInstance[];
    /** Linear RGBA per source material slot. Missing slots use the viewport default. */
    materialColors?: readonly (readonly [number, number, number, number])[];
    /** KHR_materials_unlit flags per source material slot. */
    materialUnlit?: readonly boolean[];
    materials?: readonly Material3D[];
}

export interface Material3D {
    baseColor: readonly [number, number, number, number];
    baseColorTexture: string | null;
    metallicRoughnessTexture: string | null;
    baseColorTextureInfo?: TextureInfo3D | null;
    metallicRoughnessTextureInfo?: TextureInfo3D | null;
    normalTexture?: string | null;
    normalTextureInfo?: TextureInfo3D | null;
    normalScale?: number;
    emissiveTexture?: string | null;
    emissiveTextureInfo?: TextureInfo3D | null;
    metallic: number;
    roughness: number;
    emissive: readonly [number, number, number];
    unlit: boolean;
    doubleSided: boolean;
    alphaMode?: "OPAQUE" | "MASK" | "BLEND";
    alphaCutoff?: number;
}

export interface TextureInfo3D {
    texCoord: number;
    sampler: { magFilter: number; minFilter: number; wrapS: number; wrapT: number };
    transform: { offset: readonly [number, number]; rotation: number; scale: readonly [number, number] };
}

export type MeshLibrary3D = ReadonlyMap<string, MeshAsset3D>;
export type EnvironmentLibrary3D = ReadonlyMap<string, HdrEnvironmentImage>;

export interface Draw3D {
    /** Pixel-space crop for an animated 2D image; normalized after image decoding. */
    baseColorSourceRect?: import("../core/document/Node").SourceRect;
    nodeId: string;
    model: Mat4;
    primitive: MeshPrimitive;
    color: readonly [number, number, number, number];
    unlit: boolean;
    baseColorTexture: string | null;
    metallicRoughnessTexture: string | null;
    baseColorTextureInfo: TextureInfo3D | null;
    metallicRoughnessTextureInfo: TextureInfo3D | null;
    normalTexture: string | null;
    normalTextureInfo: TextureInfo3D | null;
    normalScale: number;
    emissiveTexture: string | null;
    emissiveTextureInfo: TextureInfo3D | null;
    metallic: number;
    roughness: number;
    emissive: readonly [number, number, number];
    doubleSided: boolean;
    alphaMode: "OPAQUE" | "MASK" | "BLEND";
    alphaCutoff: number;
    /** Rest-pose positions are skinned from this palette. Absent draws the positions as stored. */
    skin?: GpuSkin;
}

export type FrameLight3D =
    | { kind: "directional"; color: readonly [number, number, number]; intensity: number;
        direction: readonly [number, number, number] }
    | { kind: "point"; color: readonly [number, number, number]; intensity: number; range: number;
        position: readonly [number, number, number] };

/**
 * Lights one draw is shaded with (the largest shader tier). A frame itself keeps up to
 * MAX_SCENE_LIGHTS_3D; LightSelection3D picks each draw's strongest reachable subset.
 */
export const MAX_FRAME_LIGHTS_3D = MAX_DRAW_LIGHTS_3D;
export const AMBIENT_LIGHT_3D = 0.12;
export const ENVIRONMENT_COLOR_3D = [0.18, 0.22, 0.3] as const;
export const ENVIRONMENT_INTENSITY_3D = 0.35;

export interface LitSample3D {
    position: readonly [number, number, number];
    normal: readonly [number, number, number];
}

export interface Frame3D {
    diagnostics?: string[];
    view: Mat4;
    projection: Mat4;
    draws: Draw3D[];
    lights: FrameLight3D[];
    cameraNodeId: string | null;
    cameraPosition: readonly [number, number, number];
    /** Authored node world matrices, shared with projected gizmos and other viewport overlays. */
    worlds: ReadonlyMap<string, Mat4>;
    environment: { assetId: string; image: HdrEnvironmentImage; ibl: EnvironmentIbl3D;
        intensity: number; rotationRadians: number } | null;
    /** First directional light's fitted world-to-clip transform, or null when nothing can cast. */
    shadow: { lightViewProjection: Mat4; direction: readonly [number, number, number]; lightIndex: number } | null;
}

export const MAT4_IDENTITY: readonly number[] =
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const VIEWPORT_3D_COLOR = [0.31, 0.66, 0.96, 1] as const;

function normalized3(x: number, y: number, z: number): [number, number, number] {
    const length = Math.hypot(x, y, z);
    if (length <= 1e-12) return [0, 0, 0];
    const clean = (value: number) => value === 0 ? 0 : value;
    return [clean(x / length), clean(y / length), clean(z / length)];
}

/**
 * Shared CPU reference for the WebGL diffuse-light equation. Callers with many lights pass the
 * per-draw selection from selectDrawLights3D; at most MAX_FRAME_LIGHTS_3D are applied.
 */
export function litColor3D(
    base: readonly [number, number, number, number], lights: readonly FrameLight3D[],
    sample: LitSample3D, unlit = false
): [number, number, number, number] {
    if (unlit || lights.length === 0) return [...base];
    const n = normalized3(sample.normal[0], sample.normal[1], sample.normal[2]);
    const amount = [AMBIENT_LIGHT_3D, AMBIENT_LIGHT_3D, AMBIENT_LIGHT_3D];
    for (const light of lights.slice(0, MAX_FRAME_LIGHTS_3D)) {
        let direction: [number, number, number], attenuation = 1;
        if (light.kind === "directional") {
            direction = [-light.direction[0], -light.direction[1], -light.direction[2]];
        } else {
            const dx = light.position[0] - sample.position[0];
            const dy = light.position[1] - sample.position[1];
            const dz = light.position[2] - sample.position[2];
            const distance = Math.hypot(dx, dy, dz);
            if (distance >= light.range) continue;
            direction = normalized3(dx, dy, dz);
            const ratio = distance / light.range;
            attenuation = Math.max(0, Math.min(1, 1 - ratio ** 4)) / Math.max(distance ** 2, 0.0001);
        }
        const lambert = Math.max(0, n[0] * direction[0] + n[1] * direction[1] + n[2] * direction[2]);
        for (let channel = 0; channel < 3; channel++) {
            amount[channel] += light.color[channel] * light.intensity * lambert * attenuation;
        }
    }
    return [Math.min(1, base[0] * amount[0]), Math.min(1, base[1] * amount[1]),
        Math.min(1, base[2] * amount[2]), base[3]];
}

function materialSourceSlot(source: string): { meshSource: string; slot: number } | null {
    const match = source.match(/^(.*)#material-(\d+)$/);
    if (!match) return null;
    const slot = Number(match[2]);
    return Number.isSafeInteger(slot) ? { meshSource: match[1], slot } : null;
}

export function multiplyMat4(a: readonly number[], b: readonly number[]): Mat4 {
    const out = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    }
    return out;
}

export function transformMatrix3D(t: Transform3D): Mat4 {
    const { x, y, z, w } = t.rotation;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const { x: sx, y: sy, z: sz } = t.scale;
    return [
        (1 - yy - zz) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - xx - zz) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - xx - yy) * sz, 0,
        t.position.x, t.position.y, t.position.z, 1
    ];
}

/** General 4x4 inverse. Null means the camera transform is singular. */
export function invertMat4(a: readonly number[]): Mat4 | null {
    const out = new Array<number>(16);
    const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4];
    const b02 = a[0] * a[7] - a[3] * a[4], b03 = a[1] * a[6] - a[2] * a[5];
    const b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
    const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12];
    const b08 = a[8] * a[15] - a[11] * a[12], b09 = a[9] * a[14] - a[10] * a[13];
    const b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    det = 1 / det;
    out[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det;
    out[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
    out[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det;
    out[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
    out[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det;
    out[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
    out[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det;
    out[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
    out[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det;
    out[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
    out[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det;
    out[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
    out[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det;
    out[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
    out[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det;
    out[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
    return out;
}

export function projectionMatrix3D(camera: Camera3D, aspect: number): Mat4 {
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    if (camera.kind === "perspective") {
        const f = 1 / Math.tan(camera.verticalFovDegrees * Math.PI / 360);
        const nf = 1 / (camera.near - camera.far);
        return [f / safeAspect, 0, 0, 0, 0, f, 0, 0, 0, 0,
            (camera.far + camera.near) * nf, -1, 0, 0, 2 * camera.far * camera.near * nf, 0];
    }
    const h = camera.verticalSize, w = h * safeAspect;
    return [2 / w, 0, 0, 0, 0, 2 / h, 0, 0, 0, 0, -2 / (camera.far - camera.near), 0,
        0, 0, -(camera.far + camera.near) / (camera.far - camera.near), 1];
}

const DEFAULT_CAMERA: Camera3D = { kind: "perspective", near: 0.1, far: 1000, verticalFovDegrees: 60 };
const DEFAULT_CAMERA_WORLD = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1];

export function buildFrame3D(doc: ReadonlyDocument, meshes: MeshLibrary3D, width: number, height: number,
                             environments: EnvironmentLibrary3D = new Map(), animationSeconds = (doc.frame ?? 0) / (doc.timeline?.fps ?? 24)): Frame3D {
    doc = dropHidden(applyFrame(doc, doc.frame));
    const diagnostics: string[] = [];
    const worlds = new Map<string, Mat4>();
    const visit = (id: string, parent: readonly number[]): void => {
        const node = doc.nodes.get(id);
        if (!node) return;
        const local = node.spatial3d ? transformMatrix3D(node.spatial3d.transform) : MAT4_IDENTITY;
        const world = multiplyMat4(parent, local);
        worlds.set(id, world);
        for (const child of node.children) visit(child, world);
    };
    for (const id of doc.rootNodeUuids) visit(id, MAT4_IDENTITY);

    let camera: Camera3D = DEFAULT_CAMERA;
    let cameraWorld: readonly number[] = DEFAULT_CAMERA_WORLD;
    let cameraNodeId: string | null = null;
    for (const [id, node] of doc.nodes) {
        if (!node.spatial3d?.camera) continue;
        camera = node.spatial3d.camera;
        cameraWorld = worlds.get(id) ?? transformMatrix3D(node.spatial3d.transform);
        cameraNodeId = id;
        break;
    }

    const assetRecords = new Map((doc.assets3d ?? []).map(asset => [asset.id, asset]));
    let environment: Frame3D["environment"] = null;
    for (const node of doc.nodes.values()) {
        const authored = node.spatial3d?.environment;
        const asset = authored && assetRecords.get(authored.textureAssetId);
        const image = asset?.kind === "texture" ? environments.get(asset.id) : undefined;
        if (authored && image) {
            environment = { assetId: asset!.id, image, ibl: preparedEnvironment3D(image), intensity: authored.intensity,
                rotationRadians: authored.rotationDegrees * Math.PI / 180 };
            break;
        }
    }
    const meshBySource = new Map<string, MeshAsset3D>();
    for (const asset of doc.assets3d ?? []) {
        if (asset.kind === "mesh") {
            const mesh = meshes.get(asset.id);
            if (mesh) meshBySource.set(asset.source, mesh);
        }
    }
    const materialSource = (id: string | undefined): { mesh: MeshAsset3D; slot: number } | undefined => {
        if (!id) return undefined;
        const asset = assetRecords.get(id);
        if (asset?.kind !== "material") return undefined;
        const sourceSlot = materialSourceSlot(asset.source);
        const mesh = sourceSlot ? meshBySource.get(sourceSlot.meshSource) : undefined;
        return sourceSlot && mesh ? { mesh, slot: sourceSlot.slot } : undefined;
    };

    const lights: FrameLight3D[] = [];
    let droppedLights = 0;
    for (const [id, node] of doc.nodes) {
        const light = node.spatial3d?.light;
        const world = worlds.get(id);
        if (!light || !world) continue;
        if (lights.length >= MAX_SCENE_LIGHTS_3D) { droppedLights++; continue; }
        const color = [light.color.x, light.color.y, light.color.z] as const;
        if (light.kind === "directional") {
            lights.push({ kind: "directional", color, intensity: light.intensity,
                direction: normalized3(-world[8], -world[9], -world[10]) });
        } else {
            lights.push({ kind: "point", color, intensity: light.intensity, range: light.range,
                position: [world[12], world[13], world[14]] });
        }
    }
    if (droppedLights > 0) {
        diagnostics.push(`${droppedLights} light(s) beyond the ${MAX_SCENE_LIGHTS_3D}-light scene limit were ignored.`);
    }

    const draws: Draw3D[] = [];
    for (const [id, node] of doc.nodes) {
        const renderable = node.spatial3d?.renderable;
        const composition = node.spatial3d?.composition2d;
        if (!renderable && composition) {
            const width3d = node.geometry.width / composition.pixelsPerUnit;
            const height3d = node.geometry.height / composition.pixelsPerUnit;
            const sourceWorld = worlds.get(id) ?? transformMatrix3D(node.spatial3d!.transform);
            let model: Mat4;
            if (composition.mode === "billboard") {
                model = [cameraWorld[0] * width3d, cameraWorld[1] * width3d, cameraWorld[2] * width3d, 0,
                    cameraWorld[4] * height3d, cameraWorld[5] * height3d, cameraWorld[6] * height3d, 0,
                    cameraWorld[8], cameraWorld[9], cameraWorld[10], 0,
                    sourceWorld[12], sourceWorld[13], sourceWorld[14], 1];
            } else {
                model = multiplyMat4(sourceWorld, [width3d, 0, 0, 0, 0, height3d, 0, 0,
                    0, 0, 1, 0, 0, 0, 0, 1]);
            }
            const hex = typeof node.style.fill === "string" ? node.style.fill.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i) : null;
            const color = hex ? [Number.parseInt(hex[1].slice(0, 2), 16) / 255,
                Number.parseInt(hex[1].slice(2, 4), 16) / 255, Number.parseInt(hex[1].slice(4, 6), 16) / 255,
                (hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1) * node.style.opacity] as const
                : [1, 1, 1, node.style.opacity] as const;
            const primitive: MeshPrimitive = { positions: new Float32Array([-.5, -.5, 0, .5, -.5, 0,
                .5, .5, 0, -.5, .5, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
                uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
                material: null };
            draws.push({ nodeId: id, model, primitive, color, unlit: !composition.lit,
                baseColorTexture: node.type === "core.image" ? node.src ?? null : null,
                ...(node.type === "core.image" && node.sourceRect ? { baseColorSourceRect: node.sourceRect } : {}),
                metallicRoughnessTexture: null, baseColorTextureInfo: {
                    texCoord: 0, transform: { offset: [0, 0], scale: [1, 1], rotation: 0 },
                    sampler: { magFilter: node.pixelated ? 9728 : 9729, minFilter: node.pixelated ? 9728 : 9729, wrapS: 33071, wrapT: 33071 }
                }, metallicRoughnessTextureInfo: null,
                normalTexture: null, normalTextureInfo: null, normalScale: 1, emissiveTexture: null,
                emissiveTextureInfo: null, metallic: 0, roughness: 1, emissive: [0, 0, 0], doubleSided: true,
                alphaMode: color[3] < 1 || node.type === "core.image" ? "BLEND" : "OPAQUE", alphaCutoff: 0.5 });
            continue;
        }
        const blockout=node.spatial3d?.blockout;
        const solidTree=node.spatial3d?.solidTree;
        if (!renderable&&!blockout&&!solidTree) continue;
        const asset:MeshAsset3D|undefined = solidTree
            ? {instances:[{name:"solid",matrix:[...MAT4_IDENTITY],primitive:solidTreeGeometry3D(solidTree).mesh}]}
            : blockout
            ? {instances:[{name:blockout.kind,matrix:[...MAT4_IDENTITY],primitive:blockoutMesh(blockout)}]}
            : meshes.get(renderable!.meshAssetId);
        if (!asset) continue;
        const nodeWorld = worlds.get(id) ?? transformMatrix3D(node.spatial3d!.transform);
        let instances = asset.instances;
        try {
            if (asset.motion) instances = sampleGltfMotion(asset.motion, asset.instances, animationSeconds, node.spatial3d?.animation, "gpu");
        } catch (error) { diagnostics.push(`${id}: animation failed; showing imported mesh. ${String(error)}`); }
        for (const instance of instances) {
            const slot = typeof instance.primitive.material === "number" ? instance.primitive.material : -1;
            const assigned = materialSource(renderable?.materialAssetIds?.[slot]);
            const material = assigned?.mesh.materials?.[assigned.slot] ?? asset.materials?.[slot];
            draws.push({ nodeId: id, model: multiplyMat4(nodeWorld, instance.matrix), primitive: instance.primitive,
                color: material?.baseColor ?? assigned?.mesh.materialColors?.[assigned.slot] ??
                    asset.materialColors?.[slot] ?? VIEWPORT_3D_COLOR,
                unlit: material?.unlit ?? assigned?.mesh.materialUnlit?.[assigned.slot] ??
                    asset.materialUnlit?.[slot] ?? false,
                baseColorTexture: material?.baseColorTexture ?? null,
                metallicRoughnessTexture: material?.metallicRoughnessTexture ?? null,
                baseColorTextureInfo: material?.baseColorTextureInfo ?? null,
                metallicRoughnessTextureInfo: material?.metallicRoughnessTextureInfo ?? null,
                normalTexture: material?.normalTexture ?? null,
                normalTextureInfo: material?.normalTextureInfo ?? null,
                normalScale: material?.normalScale ?? 1,
                emissiveTexture: material?.emissiveTexture ?? null,
                emissiveTextureInfo: material?.emissiveTextureInfo ?? null,
                metallic: material?.metallic ?? 0,
                roughness: material?.roughness ?? 1,
                emissive: material?.emissive ?? [0, 0, 0],
                doubleSided: material?.doubleSided ?? false,
                alphaMode: material?.alphaMode ?? "OPAQUE",
                alphaCutoff: material?.alphaCutoff ?? 0.5,
                ...(instance.skin ? { skin: instance.skin } : {}) });
        }
    }
    return {
        view: invertMat4(cameraWorld) ?? [...MAT4_IDENTITY],
        diagnostics,
        projection: projectionMatrix3D(camera, Math.max(1, width) / Math.max(1, height)),
        draws,
        lights,
        cameraNodeId,
        cameraPosition: [cameraWorld[12], cameraWorld[13], cameraWorld[14]],
        worlds,
        environment,
        shadow: directionalShadowFrame3D(draws, lights)
    };
}

function directionalShadowFrame3D(draws: readonly Draw3D[], lights: readonly FrameLight3D[]): Frame3D["shadow"] {
    const lightIndex = lights.findIndex(item => item.kind === "directional");
    const light = lights[lightIndex] as Extract<FrameLight3D, { kind: "directional" }> | undefined;
    if (!light || draws.length === 0) return null;
    const points: [number, number, number][] = [];
    for (const draw of draws) {
        const positions = draw.skin ? gpuSkinBounds(draw.primitive.positions, draw.skin.palette) : draw.primitive.positions;
        for (let at = 0; at < positions.length; at += 3) {
            const p = transformPoint4(draw.model, positions[at], positions[at + 1], positions[at + 2]);
            points.push([p[0], p[1], p[2]]);
        }
    }
    if (points.length === 0) return null;
    const center: [number, number, number] = [0, 1, 2].map(axis =>
        points.reduce((sum, point) => sum + point[axis], 0) / points.length) as [number, number, number];
    const radius = Math.max(1, ...points.map(point => Math.hypot(point[0] - center[0], point[1] - center[1],
        point[2] - center[2])));
    const eye: [number, number, number] = [center[0] - light.direction[0] * radius * 2,
        center[1] - light.direction[1] * radius * 2, center[2] - light.direction[2] * radius * 2];
    const z = normalized3(eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]);
    const up = Math.abs(z[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
    const x = normalized3(up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2],
        up[0] * z[1] - up[1] * z[0]);
    const y = normalized3(z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2],
        z[0] * x[1] - z[1] * x[0]);
    const view = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
        -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
        -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
        -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1];
    const projected = points.map(point => transformPoint4(view, point[0], point[1], point[2]));
    const values = (axis: number) => projected.map(point => point[axis]);
    const padding = Math.max(0.05, radius * 0.02);
    const left = Math.min(...values(0)) - padding, right = Math.max(...values(0)) + padding;
    const bottom = Math.min(...values(1)) - padding, top = Math.max(...values(1)) + padding;
    const near = Math.max(0.01, Math.min(...values(2).map(value => -value)) - padding);
    const far = Math.max(near + 0.01, Math.max(...values(2).map(value => -value)) + padding);
    const projection = [2 / (right - left), 0, 0, 0, 0, 2 / (top - bottom), 0, 0,
        0, 0, -2 / (far - near), 0, -(right + left) / (right - left),
        -(top + bottom) / (top - bottom), -(far + near) / (far - near), 1];
    return { lightViewProjection: multiplyMat4(projection, view), direction: light.direction, lightIndex };
}

export function transformPoint4(m: readonly number[], x: number, y: number, z: number, w = 1): [number, number, number, number] {
    return [m[0] * x + m[4] * y + m[8] * z + m[12] * w,
        m[1] * x + m[5] * y + m[9] * z + m[13] * w,
        m[2] * x + m[6] * y + m[10] * z + m[14] * w,
        m[3] * x + m[7] * y + m[11] * z + m[15] * w];
}

export interface Capture3D { width: number; height: number; rgba: Uint8Array; nodeIds: (string | null)[] }

/** Deterministic triangle reference used by pixel tests and non-GPU diagnostics. */
export function captureFrame3D(frame: Frame3D, width: number, height: number): Capture3D {
    width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
    const rgba = new Uint8Array(width * height * 4);
    const depth = new Float64Array(width * height); depth.fill(Infinity);
    const nodeIds: (string | null)[] = new Array(width * height).fill(null);
    const pv = multiplyMat4(frame.projection, frame.view);
    const edge = (ax: number, ay: number, bx: number, by: number, px: number, py: number) =>
        (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    for (const draw of frame.draws) {
        const mvp = multiplyMat4(pv, draw.model), p = draw.primitive.positions, ix = draw.primitive.indices;
        const drawLights = selectDrawLights3D(frame.lights, drawBoundingSphere3D(p, draw.model, draw.skin),
            MAX_DRAW_LIGHTS_3D, frame.shadow?.lightIndex ?? -1).indices.map(index => frame.lights[index]);
        for (let i = 0; i + 2 < ix.length; i += 3) {
            const v = [ix[i], ix[i + 1], ix[i + 2]].map(n => transformPoint4(mvp, p[n * 3], p[n * 3 + 1], p[n * 3 + 2]));
            if (v.some(q => !Number.isFinite(q[3]) || q[3] <= 0)) continue;
            const s = v.map(q => ({ x: (q[0] / q[3] * 0.5 + 0.5) * width,
                y: (1 - (q[1] / q[3] * 0.5 + 0.5)) * height, z: q[2] / q[3] * 0.5 + 0.5 }));
            const area = edge(s[0].x, s[0].y, s[1].x, s[1].y, s[2].x, s[2].y);
            // WebGL's default front face is CCW in clip space; Y flips when mapped to pixels.
            const backFacing = area >= -1e-12;
            if (backFacing && !draw.doubleSided) continue;
            const minX = Math.max(0, Math.floor(Math.min(...s.map(q => q.x))));
            const maxX = Math.min(width - 1, Math.ceil(Math.max(...s.map(q => q.x))));
            const minY = Math.max(0, Math.floor(Math.min(...s.map(q => q.y))));
            const maxY = Math.min(height - 1, Math.ceil(Math.max(...s.map(q => q.y))));
            const world = [ix[i], ix[i + 1], ix[i + 2]].map(n =>
                transformPoint4(draw.model, p[n * 3], p[n * 3 + 1], p[n * 3 + 2]));
            const ab = [world[1][0] - world[0][0], world[1][1] - world[0][1], world[1][2] - world[0][2]];
            const ac = [world[2][0] - world[0][0], world[2][1] - world[0][1], world[2][2] - world[0][2]];
            const color = litColor3D(draw.color, drawLights, {
                position: [(world[0][0] + world[1][0] + world[2][0]) / 3,
                    (world[0][1] + world[1][1] + world[2][1]) / 3,
                    (world[0][2] + world[1][2] + world[2][2]) / 3],
                normal: [(ab[1] * ac[2] - ab[2] * ac[1]) * (backFacing ? -1 : 1),
                    (ab[2] * ac[0] - ab[0] * ac[2]) * (backFacing ? -1 : 1),
                    (ab[0] * ac[1] - ab[1] * ac[0]) * (backFacing ? -1 : 1)]
            }, draw.unlit);
            for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
                const px = x + 0.5, py = y + 0.5;
                const w0 = edge(s[1].x, s[1].y, s[2].x, s[2].y, px, py) / area;
                const w1 = edge(s[2].x, s[2].y, s[0].x, s[0].y, px, py) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const z = w0 * s[0].z + w1 * s[1].z + w2 * s[2].z, at = y * width + x;
                if (z > depth[at]) continue;
                depth[at] = z; nodeIds[at] = draw.nodeId;
                rgba[at * 4] = Math.round(color[0] * 255);
                rgba[at * 4 + 1] = Math.round(color[1] * 255);
                rgba[at * 4 + 2] = Math.round(color[2] * 255);
                rgba[at * 4 + 3] = Math.round(color[3] * 255);
            }
        }
    }
    return { width, height, rgba, nodeIds };
}

export function pickCapture3D(capture: Capture3D, x: number, y: number): string | null {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= capture.width || iy >= capture.height) return null;
    return capture.nodeIds[iy * capture.width + ix];
}
