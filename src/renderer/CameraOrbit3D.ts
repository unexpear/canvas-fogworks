/**
 * @module CameraOrbit3D
 * @description Pure orbit, pan and dolly math for authored 3D camera transforms.
 */

import { Camera3D, Spatial3D, Vec3 } from "../core/document/Spatial3D";
import { copySpatial3D } from "./Gizmo3D";

const ORBIT_RADIANS_PER_PIXEL = 0.01;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

function normalized(v: Vec3): Vec3 {
    const length = Math.hypot(v.x, v.y, v.z);
    return length > 1e-12 ? { x: v.x / length, y: v.y / length, z: v.z / length } : { x: 0, y: 0, z: -1 };
}

function cross(a: Vec3, b: Vec3): Vec3 {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Quaternion whose local -Z looks from position to target with world +Y as the preferred up. */
export function cameraLookRotation3D(position: Vec3, target: Vec3): Spatial3D["transform"]["rotation"] {
    const forward = normalized({ x: target.x - position.x, y: target.y - position.y, z: target.z - position.z });
    let right = normalized(cross(forward, { x: 0, y: 1, z: 0 }));
    if (Math.abs(forward.y) > 0.9999) right = { x: 1, y: 0, z: 0 };
    const up = cross(right, forward);
    // Rotation matrix columns are local +X, +Y, +Z; camera forward is local -Z.
    const m00 = right.x, m01 = up.x, m02 = -forward.x;
    const m10 = right.y, m11 = up.y, m12 = -forward.y;
    const m20 = right.z, m21 = up.z, m22 = -forward.z;
    const trace = m00 + m11 + m22;
    let x: number, y: number, z: number, w: number;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
    }
    const length = Math.hypot(x, y, z, w) || 1;
    return { x: x / length, y: y / length, z: z / length, w: w / length };
}

export function orbitCamera3D(start: Spatial3D, target: Vec3, dx: number, dy: number): Spatial3D {
    const next = copySpatial3D(start), p = start.transform.position;
    const ox = p.x - target.x, oy = p.y - target.y, oz = p.z - target.z;
    const radius = Math.max(0.001, Math.hypot(ox, oy, oz));
    const azimuth = Math.atan2(ox, oz) - dx * ORBIT_RADIANS_PER_PIXEL;
    const elevation = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT,
        Math.asin(Math.max(-1, Math.min(1, oy / radius))) + dy * ORBIT_RADIANS_PER_PIXEL));
    const horizontal = Math.cos(elevation) * radius;
    next.transform.position = {
        x: target.x + Math.sin(azimuth) * horizontal,
        y: target.y + Math.sin(elevation) * radius,
        z: target.z + Math.cos(azimuth) * horizontal
    };
    next.transform.rotation = cameraLookRotation3D(next.transform.position, target);
    return next;
}

export function panCamera3D(
    start: Spatial3D, target: Vec3, dx: number, dy: number, viewportHeight: number
): { spatial: Spatial3D; target: Vec3 } {
    const next = copySpatial3D(start), p = start.transform.position;
    const distance = Math.max(0.001, Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z));
    const camera = start.camera;
    const verticalSize = camera?.kind === "orthographic" ? camera.verticalSize
        : 2 * distance * Math.tan(((camera?.verticalFovDegrees ?? 60) * Math.PI / 180) / 2);
    const perPixel = verticalSize / Math.max(1, viewportHeight);
    const forward = normalized({ x: target.x - p.x, y: target.y - p.y, z: target.z - p.z });
    const right = normalized(cross(forward, { x: 0, y: 1, z: 0 }));
    const up = cross(right, forward);
    const shift = { x: right.x * -dx * perPixel + up.x * dy * perPixel,
        y: right.y * -dx * perPixel + up.y * dy * perPixel,
        z: right.z * -dx * perPixel + up.z * dy * perPixel };
    next.transform.position = { x: p.x + shift.x, y: p.y + shift.y, z: p.z + shift.z };
    const movedTarget = { x: target.x + shift.x, y: target.y + shift.y, z: target.z + shift.z };
    next.transform.rotation = cameraLookRotation3D(next.transform.position, movedTarget);
    return { spatial: next, target: movedTarget };
}

export function dollyCamera3D(start: Spatial3D, target: Vec3, deltaY: number, camera: Camera3D): Spatial3D {
    const next = copySpatial3D(start), p = start.transform.position;
    if (camera.kind === "orthographic") {
        next.camera = { ...camera, verticalSize: Math.max(0.001, Math.min(1_000_000,
            camera.verticalSize * Math.exp(deltaY * 0.001))) };
        return next;
    }
    const offset = { x: p.x - target.x, y: p.y - target.y, z: p.z - target.z };
    const distance = Math.hypot(offset.x, offset.y, offset.z) || 1;
    const desired = Math.max(camera.near * 2, Math.min(camera.far * 0.8, distance * Math.exp(deltaY * 0.001)));
    const factor = desired / distance;
    next.transform.position = { x: target.x + offset.x * factor, y: target.y + offset.y * factor,
        z: target.z + offset.z * factor };
    next.transform.rotation = cameraLookRotation3D(next.transform.position, target);
    return next;
}
