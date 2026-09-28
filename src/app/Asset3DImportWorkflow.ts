/**
 * @module Asset3DImportWorkflow
 * @description Builds undoable editor Actions for imported 3D assets and environments.
 * Read-only hydration is shared with players through runtime/Asset3DLoader.
 */

import { ReadonlyDocument } from "../core/document/Document";
import { ASSET_3D_ID_MAX, Asset3D } from "../core/document/Spatial3D";
import { Action } from "../core/actions/Action";
import { SetAssets3DAction } from "../core/actions/SetAssets3DAction";
import { AddNodeAction } from "../core/actions/AddNodeAction";
import { SetSpatial3DAction } from "../core/actions/SetSpatial3DAction";

// Compatibility exports keep existing editor callers on the same loader implementation.
export { loadAsset3D, loadEnvironment3D, rehydrateAssets3D, rehydrateEnvironments3D } from "../runtime/Asset3DLoader";
export type { LoadedAsset3D, RehydratedAssets3D, RehydratedEnvironments3D } from "../runtime/Asset3DLoader";
export type { Asset3DReader, ProjectAsset3DReader, Environment3DReader, ProjectEnvironment3DReader } from "../runtime/ProjectReadHost";

export interface Asset3DImportPlan {
    actions: Action[];
    assetId: string;
    materialIds: string[];
    modelId: string;
    cameraId: string | null;
}

export interface Environment3DImportPlan { actions: Action[]; assetId: string; nodeId: string }

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
