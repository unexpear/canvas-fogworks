/**
 * @module Spatial3D
 * @description Persisted 3D authoring contracts: transforms and typed scene components,
 * plus stable records for imported mesh, material and texture assets (schema 74) and authored
 * environment references (schema 75) and explicit 2D-in-3D composition (schema 76).
 *
 * These types deliberately do not reuse Node.transform or Node.mesh. Those are 2D
 * authoring concepts; changing their meaning would corrupt existing documents. Asset ids
 * are authored identity, while source paths are relocatable project metadata.
 */

export interface Vec3 { x: number; y: number; z: number }
/** Quaternion component order matches glTF: x, y, z, w. */
export interface Quaternion { x: number; y: number; z: number; w: number }

export interface Transform3D {
    position: Vec3;
    rotation: Quaternion;
    scale: Vec3;
}

export type Camera3D =
    | { kind: "perspective"; near: number; far: number; verticalFovDegrees: number }
    | { kind: "orthographic"; near: number; far: number; verticalSize: number };

export type Light3D =
    | { kind: "directional"; color: Vec3; intensity: number }
    | { kind: "point"; color: Vec3; intensity: number; range: number };

export interface Environment3D {
    textureAssetId: string;
    intensity: number;
    /** Horizontal equirectangular rotation in degrees. */
    rotationDegrees: number;
}

/** Explicitly projects this node's ordinary 2D visual as a 3D surface. */
export interface Composition2DIn3D {
    /** Plane follows Transform3D rotation; billboard faces the active camera. */
    mode: "plane" | "billboard";
    /** Conversion from the node's authored 2D pixels to one 3D world unit. */
    pixelsPerUnit: number;
    /** Lit surfaces join PBR lighting; false preserves authored 2D color. */
    lit: boolean;
}

export interface Renderable3D {
    meshAssetId: string;
    /** Material ids correspond to the imported mesh's primitive slots. */
    materialAssetIds?: string[];
}

export type Collider3D =
    | { kind: "box"; halfExtents: Vec3 }
    | { kind: "sphere"; radius: number };

export interface Spatial3D {
    transform: Transform3D;
    camera?: Camera3D;
    light?: Light3D;
    renderable?: Renderable3D;
    collider?: Collider3D;
    environment?: Environment3D;
    composition2d?: Composition2DIn3D;
}

export type Asset3DKind = "mesh" | "material" | "texture";

export interface Asset3D {
    /** Stable authored identity. Reimporting or moving the source keeps this id. */
    id: string;
    kind: Asset3DKind;
    /** Project-relative source path. Never used as identity. */
    source: string;
    name?: string;
}

export const ASSETS_3D_MAX = 4096;
export const ASSET_3D_ID_MAX = 200;
export const ASSET_3D_SOURCE_MAX = 4096;
export const MATERIAL_SLOTS_MAX = 64;
export const SPATIAL_3D_VALUE_MAX = 1_000_000_000;
export const QUATERNION_UNIT_EPSILON = 0.001;

export const IDENTITY_TRANSFORM_3D: Transform3D = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 }
};

const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ASSET_KINDS = new Set<Asset3DKind>(["mesh", "material", "texture"]);

function finite(name: string, value: unknown, min = -SPATIAL_3D_VALUE_MAX): string | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > SPATIAL_3D_VALUE_MAX) {
        return `${name} must be a finite number from ${min} to ${SPATIAL_3D_VALUE_MAX}`;
    }
    return null;
}

function vec3Error(name: string, value: unknown, min = -SPATIAL_3D_VALUE_MAX): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${name} must be {x, y, z}`;
    const v = value as Partial<Vec3>;
    return finite(`${name}.x`, v.x, min) ?? finite(`${name}.y`, v.y, min) ?? finite(`${name}.z`, v.z, min);
}

export function asset3DIdError(id: unknown): string | null {
    if (typeof id !== "string" || id.trim() === "") return "3D asset id must be a non-empty string";
    if (id.length > ASSET_3D_ID_MAX) return `3D asset id exceeds ${ASSET_3D_ID_MAX} characters`;
    if (RESERVED_KEYS.has(id)) return `3D asset id "${id}" is reserved`;
    return null;
}

export function asset3DSourceError(source: unknown): string | null {
    if (typeof source !== "string" || source.trim() === "") return "3D asset source must be a non-empty project-relative path";
    if (source.length > ASSET_3D_SOURCE_MAX) return `3D asset source exceeds ${ASSET_3D_SOURCE_MAX} characters`;
    const path = source.replace(/\\/g, "/");
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
        return "3D asset source must be project-relative";
    }
    if (path.split("/").some(part => part === "" || part === "." || part === "..")) {
        return "3D asset source must be a normalized project-relative path";
    }
    return null;
}

export function assets3DError(assets: unknown): string | null {
    if (assets === undefined) return null;
    if (!Array.isArray(assets)) return "assets3d must be an array or absent";
    if (assets.length > ASSETS_3D_MAX) return `assets3d exceeds ${ASSETS_3D_MAX} records`;
    const ids = new Set<string>();
    for (let i = 0; i < assets.length; i++) {
        const asset = assets[i] as Partial<Asset3D> | null;
        if (!asset || typeof asset !== "object" || Array.isArray(asset)) return `assets3d[${i}] must be an object`;
        const idErr = asset3DIdError(asset.id);
        if (idErr) return `assets3d[${i}] ${idErr}`;
        if (ids.has(asset.id!)) return `assets3d contains duplicate id "${asset.id}"`;
        ids.add(asset.id!);
        if (!ASSET_KINDS.has(asset.kind as Asset3DKind)) return `assets3d[${i}].kind must be mesh, material or texture`;
        const sourceErr = asset3DSourceError(asset.source);
        if (sourceErr) return `assets3d[${i}] ${sourceErr}`;
        if (asset.name !== undefined && (typeof asset.name !== "string" || asset.name.trim() === "" || asset.name.length > ASSET_3D_ID_MAX)) {
            return `assets3d[${i}].name must be a non-empty string up to ${ASSET_3D_ID_MAX} characters or absent`;
        }
    }
    return null;
}

export function spatial3DError(spatial: unknown): string | null {
    if (spatial === undefined) return null;
    if (!spatial || typeof spatial !== "object" || Array.isArray(spatial)) return "spatial3d must be an object or absent";
    const s = spatial as Partial<Spatial3D>;
    if (!s.transform || typeof s.transform !== "object" || Array.isArray(s.transform)) return "spatial3d.transform must be an object";
    const transform = s.transform as Partial<Transform3D>;
    const positionErr = vec3Error("spatial3d.transform.position", transform.position);
    if (positionErr) return positionErr;
    const scaleErr = vec3Error("spatial3d.transform.scale", transform.scale);
    if (scaleErr) return scaleErr;
    const scale = transform.scale!;
    if (scale.x === 0 || scale.y === 0 || scale.z === 0) return "spatial3d.transform.scale components must be non-zero";
    const q = transform.rotation as Partial<Quaternion> | undefined;
    if (!q || typeof q !== "object" || Array.isArray(q)) return "spatial3d.transform.rotation must be {x, y, z, w}";
    const qErr = finite("spatial3d.transform.rotation.x", q.x) ?? finite("spatial3d.transform.rotation.y", q.y) ??
        finite("spatial3d.transform.rotation.z", q.z) ?? finite("spatial3d.transform.rotation.w", q.w);
    if (qErr) return qErr;
    const norm = Math.hypot(q.x!, q.y!, q.z!, q.w!);
    if (Math.abs(norm - 1) > QUATERNION_UNIT_EPSILON) return "spatial3d.transform.rotation must be a unit quaternion";

    if (s.camera !== undefined) {
        const c = s.camera as Partial<Camera3D>;
        if (!c || typeof c !== "object" || (c.kind !== "perspective" && c.kind !== "orthographic")) return "spatial3d.camera.kind must be perspective or orthographic";
        const nearErr = finite("spatial3d.camera.near", c.near, Number.MIN_VALUE);
        const farErr = finite("spatial3d.camera.far", c.far, Number.MIN_VALUE);
        if (nearErr ?? farErr) return nearErr ?? farErr;
        if (c.far! <= c.near!) return "spatial3d.camera.far must be greater than near";
        if (c.kind === "perspective") {
            if (typeof c.verticalFovDegrees !== "number" || !Number.isFinite(c.verticalFovDegrees) || c.verticalFovDegrees <= 0 || c.verticalFovDegrees >= 180) return "spatial3d.camera.verticalFovDegrees must be between 0 and 180";
        } else if (finite("spatial3d.camera.verticalSize", (c as { verticalSize?: unknown }).verticalSize, Number.MIN_VALUE)) {
            return "spatial3d.camera.verticalSize must be a positive finite number";
        }
    }

    if (s.light !== undefined) {
        const light = s.light as Partial<Light3D>;
        if (!light || typeof light !== "object" || (light.kind !== "directional" && light.kind !== "point")) return "spatial3d.light.kind must be directional or point";
        const colorErr = vec3Error("spatial3d.light.color", light.color, 0);
        if (colorErr) return colorErr;
        const intensityErr = finite("spatial3d.light.intensity", light.intensity, 0);
        if (intensityErr) return intensityErr;
        if (light.kind === "point" && finite("spatial3d.light.range", light.range, Number.MIN_VALUE)) return "spatial3d.light.range must be a positive finite number";
    }

    if (s.environment !== undefined) {
        const environment = s.environment as Partial<Environment3D>;
        if (!environment || typeof environment !== "object") return "spatial3d.environment must be an object";
        const assetErr = asset3DIdError(environment.textureAssetId);
        if (assetErr) return `spatial3d.environment ${assetErr}`;
        const intensityErr = finite("spatial3d.environment.intensity", environment.intensity, 0);
        if (intensityErr) return intensityErr;
        const rotationErr = finite("spatial3d.environment.rotationDegrees", environment.rotationDegrees);
        if (rotationErr) return rotationErr;
    }

    if (s.composition2d !== undefined) {
        const composition = s.composition2d as Partial<Composition2DIn3D>;
        if (!composition || typeof composition !== "object"
            || (composition.mode !== "plane" && composition.mode !== "billboard")) {
            return "spatial3d.composition2d.mode must be plane or billboard";
        }
        const scaleErr = finite("spatial3d.composition2d.pixelsPerUnit", composition.pixelsPerUnit,
            Number.MIN_VALUE);
        if (scaleErr) return scaleErr;
        if (typeof composition.lit !== "boolean") return "spatial3d.composition2d.lit must be a boolean";
        if (s.renderable !== undefined) return "spatial3d.composition2d and renderable are mutually exclusive";
    }

    if (s.renderable !== undefined) {
        const renderable = s.renderable as Partial<Renderable3D>;
        if (!renderable || typeof renderable !== "object") return "spatial3d.renderable must be an object";
        const meshErr = asset3DIdError(renderable.meshAssetId);
        if (meshErr) return `spatial3d.renderable ${meshErr}`;
        if (renderable.materialAssetIds !== undefined) {
            if (!Array.isArray(renderable.materialAssetIds) || renderable.materialAssetIds.length > MATERIAL_SLOTS_MAX) return `spatial3d.renderable.materialAssetIds must contain at most ${MATERIAL_SLOTS_MAX} ids`;
            for (const id of renderable.materialAssetIds) {
                const idErr = asset3DIdError(id);
                if (idErr) return `spatial3d.renderable material ${idErr}`;
            }
        }
    }

    if (s.collider !== undefined) {
        const collider = s.collider as Partial<Collider3D>;
        if (!collider || typeof collider !== "object" || (collider.kind !== "box" && collider.kind !== "sphere")) return "spatial3d.collider.kind must be box or sphere";
        if (collider.kind === "box") {
            const extentsErr = vec3Error("spatial3d.collider.halfExtents", collider.halfExtents, Number.MIN_VALUE);
            if (extentsErr) return extentsErr;
        } else if (finite("spatial3d.collider.radius", (collider as { radius?: unknown }).radius, Number.MIN_VALUE)) {
            return "spatial3d.collider.radius must be a positive finite number";
        }
    }
    return null;
}
