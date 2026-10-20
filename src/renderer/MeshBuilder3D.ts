/**
 * @module MeshBuilder3D
 * @description Small procedural mesh builder (quads, boxes, beams, spheres, cones, lathes and
 * tubes) plus a Draw3D factory, shared by generated 3D content such as light strings and demos.
 */

import type { Draw3D, Mat4 } from "./Scene3D";
import type { MeshPrimitive } from "../core/import/MeshData";

export type V3 = [number, number, number];
export const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: V3): V3 => { const l = length3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Any unit vector perpendicular to a. */
export function perpendicular3(a: V3): V3 {
    return norm3(Math.abs(a[1]) < 0.9 ? cross3(a, [0, 1, 0]) : cross3(a, [1, 0, 0]));
}

/** Rotates v around unit axis by radians (Rodrigues). */
export function rotateAround3(v: V3, axis: V3, radians: number): V3 {
    const c = Math.cos(radians), s = Math.sin(radians), d = dot3(axis, v), x = cross3(axis, v);
    return [v[0] * c + x[0] * s + axis[0] * d * (1 - c), v[1] * c + x[1] * s + axis[1] * d * (1 - c),
        v[2] * c + x[2] * s + axis[2] * d * (1 - c)];
}

export class MeshBuilder3D {
    positions: number[] = []; normals: number[] = []; uvs: number[] = []; indices: number[] = [];
    get vertexCount(): number { return this.positions.length / 3; }
    vertex(p: V3, n: V3, u = 0, v = 0): number {
        this.positions.push(p[0], p[1], p[2]); this.normals.push(n[0], n[1], n[2]); this.uvs.push(u, v);
        return this.positions.length / 3 - 1;
    }
    /** Counter-clockwise seen from the front. */
    quad(a: V3, b: V3, c: V3, d: V3): this {
        const n = norm3(cross3(sub3(b, a), sub3(d, a)));
        const i = [this.vertex(a, n, 0, 1), this.vertex(b, n, 1, 1), this.vertex(c, n, 1, 0), this.vertex(d, n, 0, 0)];
        this.indices.push(i[0], i[1], i[2], i[0], i[2], i[3]);
        return this;
    }
    tri(a: V3, b: V3, c: V3): this {
        const n = norm3(cross3(sub3(b, a), sub3(c, a)));
        this.indices.push(this.vertex(a, n, 0, 1), this.vertex(b, n, 1, 1), this.vertex(c, n, 0.5, 0));
        return this;
    }
    box(min: V3, max: V3): this {
        const [x0, y0, z0] = min, [x1, y1, z1] = max;
        return this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
            .quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0])
            .quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1])
            .quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0])
            .quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0])
            .quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    }
    /** Box from a to b with the given cross-section, its height axis as close to up as possible. */
    beam(a: V3, b: V3, width: number, height: number, up: V3 = [0, 1, 0]): this {
        const axis = norm3(sub3(b, a));
        let side = cross3(axis, up);
        side = length3(side) < 1e-6 ? perpendicular3(axis) : norm3(side);
        const top = norm3(cross3(side, axis)), w = scale3(side, width / 2), h = scale3(top, height / 2);
        const corner = (p: V3, sw: number, sh: number): V3 => add3(add3(p, scale3(w, sw)), scale3(h, sh));
        const a00 = corner(a, -1, -1), a10 = corner(a, 1, -1), a11 = corner(a, 1, 1), a01 = corner(a, -1, 1);
        const b00 = corner(b, -1, -1), b10 = corner(b, 1, -1), b11 = corner(b, 1, 1), b01 = corner(b, -1, 1);
        return this.quad(a01, a11, b11, b01).quad(b00, b10, a10, a00).quad(a10, b10, b11, a11)
            .quad(b00, a00, a01, b01).quad(a00, a10, a11, a01).quad(b10, b00, b01, b11);
    }
    sphere(center: V3, radius: number, segments = 8, rings = 5): this {
        const start = this.vertexCount;
        for (let r = 0; r <= rings; r++) for (let s = 0; s <= segments; s++) {
            const theta = r / rings * Math.PI, phi = s / segments * Math.PI * 2;
            const n: V3 = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
            this.vertex(add3(center, scale3(n, radius)), n, s / segments, r / rings);
        }
        for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
            const a = start + r * (segments + 1) + s, b = a + segments + 1;
            this.indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
        return this;
    }
    cone(base: V3, radius: number, height: number, segments = 14): this {
        const apex: V3 = [base[0], base[1] + height, base[2]];
        for (let s = 0; s < segments; s++) {
            const a0 = s / segments * Math.PI * 2, a1 = (s + 1) / segments * Math.PI * 2;
            const p0: V3 = [base[0] + Math.cos(a0) * radius, base[1], base[2] + Math.sin(a0) * radius];
            const p1: V3 = [base[0] + Math.cos(a1) * radius, base[1], base[2] + Math.sin(a1) * radius];
            this.tri(p1, p0, apex);
            this.tri(p0, p1, base);
        }
        return this;
    }
    /**
     * Surface of revolution around axis from origin: profile is [radius, distance along axis] pairs.
     * Smooth normals; the first and last radius may be zero to close the ends.
     */
    lathe(origin: V3, axis: V3, profile: readonly (readonly [number, number])[], segments = 8): this {
        const u = perpendicular3(axis), v = cross3(axis, u), start = this.vertexCount;
        for (let k = 0; k < profile.length; k++) {
            const [r, h] = profile[k];
            const prev = profile[Math.max(0, k - 1)], next = profile[Math.min(profile.length - 1, k + 1)];
            const dr = next[0] - prev[0], dh = next[1] - prev[1];
            for (let s = 0; s <= segments; s++) {
                const a = s / segments * Math.PI * 2, radial = add3(scale3(u, Math.cos(a)), scale3(v, Math.sin(a)));
                const n = norm3(add3(scale3(radial, dh), scale3(axis, -dr)));
                this.vertex(add3(add3(origin, scale3(axis, h)), scale3(radial, r)), n, s / segments, k / (profile.length - 1));
            }
        }
        for (let k = 0; k + 1 < profile.length; k++) for (let s = 0; s < segments; s++) {
            const a = start + k * (segments + 1) + s, b = a + segments + 1;
            this.indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
        return this;
    }
    /** Thin tube along a polyline. */
    tube(points: readonly V3[], radius: number, sides = 4): this {
        if (points.length < 2) return this;
        const start = this.vertexCount;
        let side = perpendicular3(norm3(sub3(points[1], points[0])));
        for (let k = 0; k < points.length; k++) {
            const tangent = norm3(sub3(points[Math.min(points.length - 1, k + 1)], points[Math.max(0, k - 1)]));
            side = norm3(sub3(side, scale3(tangent, dot3(side, tangent))));
            if (length3(side) < 1e-6 || !side.every(Number.isFinite)) side = perpendicular3(tangent);
            const other = cross3(tangent, side);
            for (let s = 0; s <= sides; s++) {
                const a = s / sides * Math.PI * 2, n = add3(scale3(side, Math.cos(a)), scale3(other, Math.sin(a)));
                this.vertex(add3(points[k], scale3(n, radius)), n, s / sides, k / (points.length - 1));
            }
        }
        for (let k = 0; k + 1 < points.length; k++) for (let s = 0; s < sides; s++) {
            const a = start + k * (sides + 1) + s, b = a + sides + 1;
            this.indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
        return this;
    }
    primitive(): MeshPrimitive {
        return { positions: new Float32Array(this.positions), normals: new Float32Array(this.normals),
            uvs: new Float32Array(this.uvs), indices: new Uint32Array(this.indices), material: null };
    }
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A world-space generated draw with sensible PBR defaults. */
export function meshDraw3D(nodeId: string, primitive: MeshPrimitive, color: readonly [number, number, number, number],
                           options: Partial<Draw3D> = {}): Draw3D {
    return { nodeId, model: [...IDENTITY], primitive, color, unlit: false, baseColorTexture: null,
        metallicRoughnessTexture: null, baseColorTextureInfo: null, metallicRoughnessTextureInfo: null,
        normalTexture: null, normalTextureInfo: null, normalScale: 1, emissiveTexture: null, emissiveTextureInfo: null,
        metallic: 0, roughness: 0.85, emissive: [0, 0, 0], doubleSided: true, alphaMode: "OPAQUE", alphaCutoff: 0.5,
        ...options };
}