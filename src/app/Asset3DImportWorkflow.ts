/**
 * @module Asset3DImportWorkflow
 * @description Loads one user-selected glTF/GLB file through the confined Electron bridge and
 * converts it into the transient mesh-library entry consumed by the 3D viewport.
 */

import { gltfMaterials, GltfImageSource, GltfJson, GltfTextureBinding, parseGlb, parseGltf } from "../core/import/Gltf";
import { Material3D, MeshAsset3D } from "../renderer/Scene3D";
import { ReadonlyDocument } from "../core/document/Document";
import { ASSET_3D_ID_MAX, Asset3D } from "../core/document/Spatial3D";
import { Action } from "../core/actions/Action";
import { SetAssets3DAction } from "../core/actions/SetAssets3DAction";
import { AddNodeAction } from "../core/actions/AddNodeAction";
import { SetSpatial3DAction } from "../core/actions/SetSpatial3DAction";
import { decodeRadianceHdr, HdrEnvironmentImage } from "../renderer/HdrEnvironment";

export interface Asset3DReader {
    read3DFile(folder: string, filePath: string): Promise<string>;
    read3DSidecar(folder: string, modelPath: string, relative: string): Promise<string>;
}

export interface ProjectAsset3DReader {
    readProject3DFile(projectFilePath: string, source: string): Promise<string>;
    readProject3DSidecar(projectFilePath: string, modelSource: string, relative: string): Promise<string>;
}

export interface Environment3DReader {
    readEnvironmentFile(folder: string, filePath: string): Promise<string>;
}

export interface ProjectEnvironment3DReader {
    readProjectEnvironmentFile(projectFilePath: string, source: string): Promise<string>;
}

export interface LoadedAsset3D {
    mesh: MeshAsset3D;
    materials: readonly { name: string }[];
    notes: string[];
}

export interface RehydratedAssets3D {
    meshes: Map<string, MeshAsset3D>;
    failures: { assetId: string; source: string; error: Error }[];
}

export interface Asset3DImportPlan {
    actions: Action[];
    assetId: string;
    materialIds: string[];
    modelId: string;
    cameraId: string | null;
}

export interface Environment3DImportPlan { actions: Action[]; assetId: string; nodeId: string }
export interface RehydratedEnvironments3D {
    environments: Map<string, HdrEnvironmentImage>;
    failures: { assetId: string; source: string; error: Error }[];
}

export function environment3DImportActions(doc: ReadonlyDocument, relative: string, name: string,
                                           newId: () => string): Environment3DImportPlan {
    const assetId = newId();
    const existing = [...doc.nodes.values()].find(node => node.spatial3d?.environment);
    const nodeId = existing?.id ?? newId();
    const asset: Asset3D = { id: assetId, kind: "texture", source: relative, name };
    const previous = existing?.spatial3d;
    const spatial: import("../core/document/Spatial3D").Spatial3D = previous
        ? { transform: { position: { ...previous.transform.position }, rotation: { ...previous.transform.rotation },
            scale: { ...previous.transform.scale } },
            ...(previous.camera ? { camera: { ...previous.camera } } : {}),
            ...(previous.light ? { light: { ...previous.light, color: { ...previous.light.color } } } : {}),
            ...(previous.renderable ? { renderable: { meshAssetId: previous.renderable.meshAssetId,
                ...(previous.renderable.materialAssetIds
                    ? { materialAssetIds: [...previous.renderable.materialAssetIds] } : {}) } } : {}),
            ...(previous.collider ? { collider: previous.collider.kind === "box"
                ? { kind: "box" as const, halfExtents: { ...previous.collider.halfExtents } }
                : { ...previous.collider } } : {}),
            environment: { textureAssetId: assetId, intensity: previous.environment!.intensity,
                rotationDegrees: previous.environment!.rotationDegrees } }
        : { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 } },
            environment: { textureAssetId: assetId, intensity: 1, rotationDegrees: 0 } };
    const actions: Action[] = [new SetAssets3DAction(doc, [...(doc.assets3d ?? []) as Asset3D[], asset])];
    if (!existing) actions.push(new AddNodeAction(doc, "core.rectangle", 0, 0, 1, 1, "none", nodeId));
    actions.push(new SetSpatial3DAction(doc, nodeId, spatial));
    return { actions, assetId, nodeId };
}

export async function loadEnvironment3D(reader: Environment3DReader, folder: string,
                                        filePath: string): Promise<HdrEnvironmentImage> {
    return decodeRadianceHdr(bytes(await reader.readEnvironmentFile(folder, filePath)));
}

export async function rehydrateEnvironments3D(reader: ProjectEnvironment3DReader, projectFilePath: string,
                                              assets: readonly Asset3D[]): Promise<RehydratedEnvironments3D> {
    const environments = new Map<string, HdrEnvironmentImage>();
    const failures: RehydratedEnvironments3D["failures"] = [];
    for (const asset of assets) {
        if (asset.kind !== "texture" || !/\.hdr$/i.test(asset.source)) continue;
        try {
            environments.set(asset.id, decodeRadianceHdr(bytes(
                await reader.readProjectEnvironmentFile(projectFilePath, asset.source))));
        } catch (cause) {
            failures.push({ assetId: asset.id, source: asset.source,
                error: cause instanceof Error ? cause : new Error(String(cause)) });
        }
    }
    return { environments, failures };
}

export function materialAssetSource(meshSource: string, slot: number): string {
    return `${meshSource}#material-${slot}`;
}

export function asset3DImportActions(
    doc: ReadonlyDocument, relative: string, name: string, newId: () => string,
    materials: readonly { name: string }[] = []
): Asset3DImportPlan {
    const assetId = newId(), modelId = newId();
    const asset: Asset3D = { id: assetId, kind: "mesh", source: relative, name };
    const materialAssets: Asset3D[] = materials.map((material, slot) => ({
        id: newId(), kind: "material", source: materialAssetSource(relative, slot),
        name: (material.name.trim() || `Material ${slot + 1}`).slice(0, ASSET_3D_ID_MAX)
    }));
    const materialIds = materialAssets.map(material => material.id);
    const actions: Action[] = [
        new SetAssets3DAction(doc, [...(doc.assets3d ?? []) as Asset3D[], asset, ...materialAssets]),
        new AddNodeAction(doc, "core.rectangle", 0, 0, 1, 1, "none", modelId),
        new SetSpatial3DAction(doc, modelId, {
            transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            renderable: { meshAssetId: assetId, ...(materialIds.length ? { materialAssetIds: materialIds } : {}) }
        })
    ];
    let cameraId: string | null = null;
    if (![...doc.nodes.values()].some(n => n.spatial3d?.camera)) {
        cameraId = newId();
        actions.push(new AddNodeAction(doc, "core.rectangle", 0, 0, 1, 1, "none", cameraId));
        actions.push(new SetSpatial3DAction(doc, cameraId, {
            transform: { position: { x: 0, y: 0, z: 5 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            camera: { kind: "perspective", near: 0.1, far: 1000, verticalFovDegrees: 60 }
        }));
    }
    return { actions, assetId, materialIds, modelId, cameraId };
}

function bytes(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function dataUri(uri: string): Uint8Array | null {
    const match = uri.match(/^data:[^,]*;base64,(.*)$/s);
    return match ? bytes(match[1]) : null;
}

function base64(data: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < data.length; offset += 0x8000) {
        binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function imageMime(source: GltfImageSource, data?: Uint8Array): string {
    if (source.mimeType?.startsWith("image/")) return source.mimeType;
    if (data && data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e
        && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
        return "image/png";
    }
    if (data && data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
    if (source.kind === "uri") {
        if (/\.jpe?g(?:$|[?#])/i.test(source.uri)) return "image/jpeg";
        if (/\.webp(?:$|[?#])/i.test(source.uri)) return "image/webp";
    }
    return "image/png";
}

async function imageDataUrl(
    source: GltfImageSource | null, reader: Asset3DReader, folder: string, filePath: string,
    buffer: Uint8Array
): Promise<string | null> {
    if (!source) return null;
    if (source.kind === "buffer") {
        const end = source.offset + source.length;
        if (source.offset < 0 || end > buffer.length) return null;
        const image = buffer.subarray(source.offset, end);
        return `data:${imageMime(source, image)};base64,${base64(image)}`;
    }
    if (/^data:/i.test(source.uri)) return source.uri;
    const payload = await reader.read3DSidecar(folder, filePath, source.uri);
    return `data:${imageMime(source)};base64,${payload}`;
}

export async function loadAsset3D(reader: Asset3DReader, folder: string, filePath: string): Promise<LoadedAsset3D> {
    const source = bytes(await reader.read3DFile(folder, filePath));
    let json: GltfJson, buffer: Uint8Array;
    if (/\.glb$/i.test(filePath)) {
        const glb = parseGlb(source);
        json = glb.json; buffer = glb.bin ?? new Uint8Array();
    } else {
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder().decode(source)); }
        catch (error) { throw new Error(`Invalid glTF JSON: ${String(error)}`); }
        json = parsed as GltfJson;
        const uri = json.buffers?.[0]?.uri;
        if (!uri) buffer = new Uint8Array();
        else buffer = dataUri(uri) ?? bytes(await reader.read3DSidecar(folder, filePath, uri));
    }
    const result = parseGltf(json, buffer);
    const materials = gltfMaterials(json);
    const resolvedMaterials: Material3D[] = [];
    const imageCache = new Map<string, Promise<string | null>>();
    const resolveImage = (source: GltfImageSource | null): Promise<string | null> => {
        if (!source) return Promise.resolve(null);
        const key = JSON.stringify(source);
        let pending = imageCache.get(key);
        if (!pending) {
            pending = imageDataUrl(source, reader, folder, filePath, buffer);
            imageCache.set(key, pending);
        }
        return pending;
    };
    const resolveTexture = async (binding: GltfTextureBinding | null) => ({
        source: await resolveImage(binding?.image ?? null),
        info: binding ? { texCoord: binding.texCoord, sampler: binding.sampler, transform: binding.transform } : null
    });
    // Sequential avoids an unbounded image-read burst for material-heavy models.
    for (const material of materials) {
        const baseColor = await resolveTexture(material.baseColorTexture);
        const metallicRoughness = await resolveTexture(material.metallicRoughnessTexture);
        const normal = await resolveTexture(material.normalTexture);
        const emissive = await resolveTexture(material.emissiveTexture);
        resolvedMaterials.push({
            baseColor: material.baseColor,
            baseColorTexture: baseColor.source,
            baseColorTextureInfo: baseColor.info,
            metallicRoughnessTexture: metallicRoughness.source,
            metallicRoughnessTextureInfo: metallicRoughness.info,
            normalTexture: normal.source,
            normalTextureInfo: normal.info,
            normalScale: material.normalScale,
            emissiveTexture: emissive.source,
            emissiveTextureInfo: emissive.info,
            metallic: material.metallic,
            roughness: material.roughness,
            emissive: material.emissive,
            unlit: material.unlit,
            doubleSided: material.doubleSided,
            alphaMode: material.alphaMode === "MASK" || material.alphaMode === "BLEND" ? material.alphaMode : "OPAQUE",
            alphaCutoff: material.alphaCutoff
        });
    }
    return {
        mesh: {
            instances: result.instances,
            materialColors: materials.map(m => m.baseColor),
            materialUnlit: materials.map(m => m.unlit),
            materials: resolvedMaterials
        },
        materials: materials.map((material, slot) => ({ name: material.name?.trim() || `Material ${slot + 1}` })),
        notes: result.notes
    };
}

/** Reload persisted project-relative mesh sources without putting decoded arrays in the document. */
export async function rehydrateAssets3D(
    reader: ProjectAsset3DReader, projectFilePath: string, assets: readonly Asset3D[]
): Promise<RehydratedAssets3D> {
    const meshes = new Map<string, MeshAsset3D>();
    const failures: RehydratedAssets3D["failures"] = [];
    // Sequential by design: opening a project must not schedule an unbounded burst of large reads.
    for (const asset of assets) {
        if (asset.kind !== "mesh") continue;
        try {
            const loaded = await loadAsset3D({
                read3DFile: (_folder, source) => reader.readProject3DFile(projectFilePath, source),
                read3DSidecar: (_folder, modelSource, relative) =>
                    reader.readProject3DSidecar(projectFilePath, modelSource, relative)
            }, projectFilePath, asset.source);
            meshes.set(asset.id, loaded.mesh);
        } catch (cause) {
            failures.push({
                assetId: asset.id,
                source: asset.source,
                error: cause instanceof Error ? cause : new Error(String(cause))
            });
        }
    }
    return { meshes, failures };
}
