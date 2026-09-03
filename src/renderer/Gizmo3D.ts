/**
 * @module Gizmo3D
 * @description Pure projected-axis model and drag arithmetic for 3D translation gizmos.
 * The same screen segments drive drawing and hit-testing; persisted writes remain Actions.
 */

import { DeepReadonly, ReadonlyDocument } from "../core/document/Document";
import { Quaternion, Spatial3D } from "../core/document/Spatial3D";
import { Frame3D, invertMat4, MAT4_IDENTITY, multiplyMat4, transformPoint4 } from "./Scene3D";

export type GizmoAxis3D = "x" | "y" | "z";
export type GizmoSpace3D = "world" | "local";
export type GizmoMode3D = "translate" | "rotate" | "scale";

export interface TranslateHandle3D {
    axis: GizmoAxis3D;
    color: string;
    origin: { x: number; y: number };
    end: { x: number; y: number };
    screenDirection: { x: number; y: number };
    /** Parent-local position delta produced by one CSS pixel along screenDirection. */
    localDeltaPerPixel: { x: number; y: number; z: number };
}

export interface TranslateGizmo3D {
    nodeId: string;
    handles: TranslateHandle3D[];
}

export interface RotateHandle3D {
    axis: GizmoAxis3D;
    color: string;
    center: { x: number; y: number };
    radius: number;
    /** Rotation axis expressed in the node parent's coordinate system. */
    parentAxis: { x: number; y: number; z: number };
    space: GizmoSpace3D;
}

export interface RotateGizmo3D { nodeId: string; handles: RotateHandle3D[] }

const AXES: readonly { axis: GizmoAxis3D; color: string; vector: readonly [number, number, number] }[] = [
    { axis: "x", color: "#ff5c5c", vector: [1, 0, 0] },
    { axis: "y", color: "#61d66f", vector: [0, 1, 0] },
    { axis: "z", color: "#55a7ff", vector: [0, 0, 1] }
];
export const GIZMO_AXIS_LENGTH_PX = 64;
export const GIZMO_HIT_RADIUS_PX = 8;
export const GIZMO_ROTATE_RADII_PX = [38, 49, 60] as const;

/** Copy the document's deep-readonly component into the mutable value an Action accepts. */
export function copySpatial3D(s: DeepReadonly<Spatial3D>): Spatial3D {
    return {
        transform: {
            position: { ...s.transform.position }, rotation: { ...s.transform.rotation }, scale: { ...s.transform.scale }
        },
        ...(s.camera ? { camera: { ...s.camera } } : {}),
        ...(s.light ? { light: { ...s.light, color: { ...s.light.color } } } : {}),
        ...(s.renderable ? { renderable: {
            meshAssetId: s.renderable.meshAssetId,
            ...(s.renderable.materialAssetIds ? { materialAssetIds: [...s.renderable.materialAssetIds] } : {})
        } } : {}),
        ...(s.collider ? { collider: s.collider.kind === "box"
            ? { kind: "box" as const, halfExtents: { ...s.collider.halfExtents } }
            : { kind: "sphere" as const, radius: s.collider.radius } } : {}),
        ...(s.environment ? { environment: { ...s.environment } } : {}),
        ...(s.composition2d ? { composition2d: { ...s.composition2d } } : {})
    };
}

function normalized(x: number, y: number, z: number): [number, number, number] | null {
    const n = Math.hypot(x, y, z);
    return Number.isFinite(n) && n > 1e-9 ? [x / n, y / n, z / n] : null;
}

function projected(frame: Frame3D, width: number, height: number,
                   p: readonly [number, number, number]): { x: number; y: number } | null {
    const clip = transformPoint4(multiplyMat4(frame.projection, frame.view), p[0], p[1], p[2]);
    if (!Number.isFinite(clip[3]) || clip[3] <= 1e-9) return null;
    const x = clip[0] / clip[3], y = clip[1] / clip[3];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: (x * 0.5 + 0.5) * width, y: (1 - (y * 0.5 + 0.5)) * height };
}

/** Build fixed-screen-length axes at the selected node's authored world origin. */
export function buildTranslateGizmo3D(
    doc: ReadonlyDocument, frame: Frame3D, nodeId: string, width: number, height: number,
    space: GizmoSpace3D
): TranslateGizmo3D | null {
    const node = doc.nodes.get(nodeId), world = frame.worlds.get(nodeId);
    if (!node?.spatial3d || !world || width <= 0 || height <= 0) return null;
    const originWorld: [number, number, number] = [world[12], world[13], world[14]];
    const origin = projected(frame, width, height, originWorld);
    if (!origin) return null;
    const parentWorld = node.parent ? frame.worlds.get(node.parent) : undefined;
    const inverseParent = invertMat4(parentWorld ?? MAT4_IDENTITY);
    if (!inverseParent) return null;

    const candidates: {
        def: typeof AXES[number];
        direction: readonly [number, number, number];
        screen: { x: number; y: number } | null;
        pixelsPerWorldUnit: number;
        local: [number, number, number, number];
    }[] = [];
    for (let i = 0; i < AXES.length; i++) {
        const def = AXES[i];
        const direction = space === "world"
            ? def.vector
            : normalized(world[i * 4], world[i * 4 + 1], world[i * 4 + 2]);
        if (!direction) continue;
        const unitEnd = projected(frame, width, height, [
            originWorld[0] + direction[0], originWorld[1] + direction[1], originWorld[2] + direction[2]
        ]);
        const sx = unitEnd ? unitEnd.x - origin.x : 0, sy = unitEnd ? unitEnd.y - origin.y : 0;
        const pixelsPerWorldUnit = Math.hypot(sx, sy);
        const local = transformPoint4(inverseParent, direction[0], direction[1], direction[2], 0);
        candidates.push({ def, direction, screen: unitEnd, pixelsPerWorldUnit, local });
    }
    const visibleScales = candidates.map(c => c.pixelsPerWorldUnit).filter(n => Number.isFinite(n) && n >= 1e-4);
    const fallbackScale = visibleScales.length > 0
        ? visibleScales.reduce((sum, n) => sum + n, 0) / visibleScales.length
        : 1;
    const handles: TranslateHandle3D[] = [];
    for (const candidate of candidates) {
        const { def, local } = candidate;
        // A camera-parallel axis has no projection. A diagonal handle keeps depth authorable until
        // orbit controls exist; its world scale is inferred from the axes that do project.
        const projectedLength = candidate.pixelsPerWorldUnit;
        const screenDirection = projectedLength >= 1e-4 && candidate.screen
            ? { x: (candidate.screen.x - origin.x) / projectedLength,
                y: (candidate.screen.y - origin.y) / projectedLength }
            : { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
        const pixelsPerWorldUnit = projectedLength >= 1e-4 ? projectedLength : fallbackScale;
        handles.push({
            axis: def.axis,
            color: def.color,
            origin,
            end: {
                x: origin.x + screenDirection.x * GIZMO_AXIS_LENGTH_PX,
                y: origin.y + screenDirection.y * GIZMO_AXIS_LENGTH_PX
            },
            screenDirection,
            localDeltaPerPixel: {
                x: local[0] / pixelsPerWorldUnit,
                y: local[1] / pixelsPerWorldUnit,
                z: local[2] / pixelsPerWorldUnit
            }
        });
    }
    return { nodeId, handles };
}

/** Nearest projected axis segment, excluding the shared origin where axis intent is ambiguous. */
export function hitTranslateGizmo3D(gizmo: TranslateGizmo3D, x: number, y: number): TranslateHandle3D | null {
    let best: { handle: TranslateHandle3D; distance: number } | null = null;
    for (const handle of gizmo.handles) {
        const vx = handle.end.x - handle.origin.x, vy = handle.end.y - handle.origin.y;
        const length2 = vx * vx + vy * vy;
        const t = length2 > 0 ? ((x - handle.origin.x) * vx + (y - handle.origin.y) * vy) / length2 : -1;
        if (t < 0.12 || t > 1.15) continue;
        const cx = handle.origin.x + Math.max(0, Math.min(1, t)) * vx;
        const cy = handle.origin.y + Math.max(0, Math.min(1, t)) * vy;
        const distance = Math.hypot(x - cx, y - cy);
        if (distance <= GIZMO_HIT_RADIUS_PX && (!best || distance < best.distance)) best = { handle, distance };
    }
    return best?.handle ?? null;
}

/** Three fixed-screen rings. Their radii distinguish overlapping camera projections unambiguously. */
export function buildRotateGizmo3D(
    doc: ReadonlyDocument, frame: Frame3D, nodeId: string, width: number, height: number,
    space: GizmoSpace3D
): RotateGizmo3D | null {
    const node = doc.nodes.get(nodeId), world = frame.worlds.get(nodeId);
    if (!node?.spatial3d || !world || width <= 0 || height <= 0) return null;
    const center = projected(frame, width, height, [world[12], world[13], world[14]]);
    if (!center) return null;
    const parentWorld = node.parent ? frame.worlds.get(node.parent) : undefined;
    const inverseParent = invertMat4(parentWorld ?? MAT4_IDENTITY);
    if (!inverseParent) return null;
    const handles: RotateHandle3D[] = [];
    for (let i = 0; i < AXES.length; i++) {
        const def = AXES[i];
        const worldAxis = space === "world"
            ? def.vector
            : normalized(world[i * 4], world[i * 4 + 1], world[i * 4 + 2]);
        if (!worldAxis) continue;
        const local = transformPoint4(inverseParent, worldAxis[0], worldAxis[1], worldAxis[2], 0);
        const parentAxis = normalized(local[0], local[1], local[2]);
        if (!parentAxis) continue;
        handles.push({ axis: def.axis, color: def.color, center, radius: GIZMO_ROTATE_RADII_PX[i],
            parentAxis: { x: parentAxis[0], y: parentAxis[1], z: parentAxis[2] }, space });
    }
    return { nodeId, handles };
}

export function hitRotateGizmo3D(gizmo: RotateGizmo3D, x: number, y: number): RotateHandle3D | null {
    let best: { handle: RotateHandle3D; distance: number } | null = null;
    for (const handle of gizmo.handles) {
        const distance = Math.abs(Math.hypot(x - handle.center.x, y - handle.center.y) - handle.radius);
        if (distance <= GIZMO_HIT_RADIUS_PX && (!best || distance < best.distance)) best = { handle, distance };
    }
    return best?.handle ?? null;
}

function quaternionMultiply(a: Quaternion, b: Quaternion): Quaternion {
    return {
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
    };
}

function unitQuaternion(q: Quaternion): Quaternion {
    const n = Math.hypot(q.x, q.y, q.z, q.w);
    return !Number.isFinite(n) || n < 1e-12
        ? { x: 0, y: 0, z: 0, w: 1 }
        : { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

/** Rotate by the signed angle swept around the selected ring. */
export function rotatedSpatial3D(
    start: Spatial3D, handle: RotateHandle3D,
    startX: number, startY: number, currentX: number, currentY: number
): Spatial3D {
    const a0 = Math.atan2(startY - handle.center.y, startX - handle.center.x);
    const a1 = Math.atan2(currentY - handle.center.y, currentX - handle.center.x);
    let angle = a1 - a0;
    if (angle > Math.PI) angle -= Math.PI * 2;
    if (angle < -Math.PI) angle += Math.PI * 2;
    const half = angle / 2, s = Math.sin(half), axis = handle.parentAxis;
    const delta = { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
    const rotation = unitQuaternion(handle.space === "local"
        ? quaternionMultiply(start.transform.rotation, delta)
        : quaternionMultiply(delta, start.transform.rotation));
    const out = copySpatial3D(start);
    out.transform.rotation = rotation;
    return out;
}

/** Scale one authored local component. A positive floor preserves schema validity during a drag. */
export function scaledSpatial3D(
    start: Spatial3D, handle: TranslateHandle3D, screenDx: number, screenDy: number
): Spatial3D {
    const pixels = screenDx * handle.screenDirection.x + screenDy * handle.screenDirection.y;
    const factor = Math.max(0.01, 1 + pixels / 100);
    const out = copySpatial3D(start), axis = handle.axis;
    out.transform.scale[axis] = start.transform.scale[axis] * factor;
    return out;
}

/** Apply a screen drag to the captured starting component; callers dispatch the returned value. */
export function translatedSpatial3D(
    start: Spatial3D, handle: TranslateHandle3D, screenDx: number, screenDy: number
): Spatial3D {
    const pixels = screenDx * handle.screenDirection.x + screenDy * handle.screenDirection.y;
    const d = handle.localDeltaPerPixel, p = start.transform.position;
    return {
        ...start,
        transform: {
            position: { x: p.x + d.x * pixels, y: p.y + d.y * pixels, z: p.z + d.z * pixels },
            rotation: { ...start.transform.rotation },
            scale: { ...start.transform.scale }
        }
    };
}
