/**
 * @module ChristmasHouse3D
 * @description Procedural night demo for the many-light renderer: a stylized house (walls, gables,
 * roof, chimney, windows, door, porch), a tiered tree, snowy ground, a moon and stars, with strings
 * of multicolored bulbs along the eaves, rakes, ridge, corners, windows, door frame and a spiral
 * around the tree. Every bulb is a real point light plus an emissive sphere, so it glows even when
 * nothing lights it.
 *
 * The glow halo is a FAKE: a camera-facing, alpha-blended quad per bulb textured with a radial
 * gradient supplied by the caller. It is not bloom and does not read the frame. Geometry is merged
 * per material, so the whole scene is a few dozen draws however many bulbs it carries.
 */

import type { Draw3D, Frame3D, FrameLight3D, Mat4 } from "./Scene3D";
import { directionalShadowFrame3D, invertMat4, projectionMatrix3D } from "./Scene3D";
import type { MeshPrimitive } from "../core/import/MeshData";

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

class MeshBuilder {
    positions: number[] = []; normals: number[] = []; uvs: number[] = []; indices: number[] = [];
    private vertex(p: V3, n: V3, u: number, v: number): number {
        this.positions.push(...p); this.normals.push(...n); this.uvs.push(u, v);
        return this.positions.length / 3 - 1;
    }
    /** Counter-clockwise seen from the front. */
    quad(a: V3, b: V3, c: V3, d: V3): this {
        const n = norm(cross(sub(b, a), sub(d, a)));
        const i = [this.vertex(a, n, 0, 1), this.vertex(b, n, 1, 1), this.vertex(c, n, 1, 0), this.vertex(d, n, 0, 0)];
        this.indices.push(i[0], i[1], i[2], i[0], i[2], i[3]);
        return this;
    }
    tri(a: V3, b: V3, c: V3): this {
        const n = norm(cross(sub(b, a), sub(c, a)));
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
    sphere(center: V3, radius: number, segments = 8, rings = 5): this {
        const start = this.positions.length / 3;
        for (let r = 0; r <= rings; r++) for (let s = 0; s <= segments; s++) {
            const theta = r / rings * Math.PI, phi = s / segments * Math.PI * 2;
            const n: V3 = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
            this.vertex(add(center, scale(n, radius)), n, s / segments, r / rings);
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
    primitive(): MeshPrimitive {
        return { positions: new Float32Array(this.positions), normals: new Float32Array(this.normals),
            uvs: new Float32Array(this.uvs), indices: new Uint32Array(this.indices), material: null };
    }
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function draw(nodeId: string, primitive: MeshPrimitive, color: readonly [number, number, number, number],
              options: Partial<Draw3D> = {}): Draw3D {
    return { nodeId, model: [...IDENTITY], primitive, color, unlit: false, baseColorTexture: null,
        metallicRoughnessTexture: null, baseColorTextureInfo: null, metallicRoughnessTextureInfo: null,
        normalTexture: null, normalTextureInfo: null, normalScale: 1, emissiveTexture: null, emissiveTextureInfo: null,
        metallic: 0, roughness: 0.85, emissive: [0, 0, 0], doubleSided: true, alphaMode: "OPAQUE", alphaCutoff: 0.5,
        ...options };
}

/** Classic multicolor string: red, green, blue, amber, magenta. Linear RGB. */
export const BULB_COLORS_3D: readonly V3[] = [[1, 0.04, 0.02], [0.05, 1, 0.08], [0.08, 0.2, 1], [1, 0.55, 0.04], [0.9, 0.08, 0.75]];
export const BULB_INTENSITY_3D = 0.1;
export const BULB_RANGE_3D = 1.4;

export interface Bulb3D { position: V3; color: number }

function along(points: readonly V3[], spacing: number, out: V3[]): void {
    for (let s = 0; s + 1 < points.length; s++) {
        const a = points[s], b = points[s + 1], length = Math.hypot(...sub(b, a));
        const count = Math.max(1, Math.round(length / spacing));
        for (let i = 0; i < count; i++) out.push(add(a, scale(sub(b, a), i / count)));
    }
    if (points.length > 1 && !(points[0] === points[points.length - 1])) out.push(points[points.length - 1]);
}

function bulbPositions(): V3[] {
    const p: V3[] = [];
    const eave = 2.74, ridge = 5.48, front = 3.58, back = -3.58, side = 4.56;
    along([[-side, eave, front], [side, eave, front]], 0.3, p);
    along([[-side, eave, back], [side, eave, back]], 0.3, p);
    along([[-side, eave + 0.08, front], [0, ridge, front], [side, eave + 0.08, front]], 0.3, p);
    along([[-side, eave + 0.08, back], [0, ridge, back], [side, eave + 0.08, back]], 0.3, p);
    along([[0, ridge + 0.04, back + 0.25], [0, ridge + 0.04, front - 0.25]], 0.3, p);
    for (const [x, z] of [[-4.1, 3.1], [4.1, 3.1], [-4.1, -3.1], [4.1, -3.1]] as const) along([[x, 0.25, z], [x, 2.6, z]], 0.3, p);
    const frame = (x0: number, x1: number, y0: number, y1: number, z: number) =>
        along([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [x0, y0, z]], 0.2, p);
    frame(-3.35, -1.45, 1.05, 2.55, 3.12); frame(1.45, 3.35, 1.05, 2.55, 3.12);
    for (let i = 0; i <= 20; i++) { const t = i / 20; p.push([4.12, 1.05 + 1.5 * (t < 0.5 ? 0 : 1), -1.1 + 2.2 * t]); }
    along([[-0.78, 0.15, 3.14], [-0.78, 2.38, 3.14], [0.78, 2.38, 3.14], [0.78, 0.15, 3.14]], 0.2, p);
    const tree: V3 = [7.2, 0, 1.6], turns = 5, steps = 110;
    for (let i = 0; i < steps; i++) {
        const t = i / steps, y = 0.9 + t * 4.4, radius = 1.75 * (1 - t) + 0.18;
        const a = t * turns * Math.PI * 2;
        p.push([tree[0] + Math.cos(a) * radius, y, tree[2] + Math.sin(a) * radius]);
    }
    for (let i = 0; i < 7; i++) { p.push([-0.95, 0.3, 4.2 + i * 1.1]); p.push([0.95, 0.3, 4.2 + i * 1.1]); }
    return p;
}

export interface ChristmasHouseScene3D {
    /** Opaque and emissive geometry; halos are added per camera by christmasHouseFrame3D. */
    draws: Draw3D[];
    lights: FrameLight3D[];
    bulbs: Bulb3D[];
}

/** Camera-independent scene: geometry, every bulb light, and the moonlight shadow caster. */
export function christmasHouseScene3D(): ChristmasHouseScene3D {
    const bulbs: Bulb3D[] = bulbPositions().map((position, index) => ({ position, color: index % BULB_COLORS_3D.length }));
    const ground = new MeshBuilder().quad([-30, 0, 30], [30, 0, 30], [30, 0, -30], [-30, 0, -30]);
    const walls = new MeshBuilder().box([-4, 0, -3], [4, 3, 3])
        .tri([-4, 3, 3], [4, 3, 3], [0, 5.2, 3]).tri([4, 3, -3], [-4, 3, -3], [0, 5.2, -3]);
    const roof = new MeshBuilder()
        .quad([-4.5, 2.8, 3.5], [0, 5.4, 3.5], [0, 5.4, -3.5], [-4.5, 2.8, -3.5])
        .quad([4.5, 2.8, -3.5], [0, 5.4, -3.5], [0, 5.4, 3.5], [4.5, 2.8, 3.5]);
    const snowCap = new MeshBuilder()
        .quad([-3.0, 3.69, 3.5], [0, 5.43, 3.5], [0, 5.43, -3.5], [-3.0, 3.69, -3.5])
        .quad([3.0, 3.69, -3.5], [0, 5.43, -3.5], [0, 5.43, 3.5], [3.0, 3.69, 3.5]);
    const trim = new MeshBuilder()
        .box([-3.4, 1.0, 3.0], [-1.4, 1.1, 3.1]).box([-3.4, 2.5, 3.0], [-1.4, 2.6, 3.1])
        .box([1.4, 1.0, 3.0], [3.4, 1.1, 3.1]).box([1.4, 2.5, 3.0], [3.4, 2.6, 3.1])
        .box([-2.45, 1.1, 3.0], [-2.35, 2.5, 3.08]).box([2.35, 1.1, 3.0], [2.45, 2.5, 3.08])
        .box([-0.8, 0, 3.0], [-0.7, 2.4, 3.1]).box([0.7, 0, 3.0], [0.8, 2.4, 3.1]).box([-0.8, 2.3, 3.0], [0.8, 2.4, 3.1])
        .box([-1.2, 0, 3.0], [1.2, 0.18, 3.9]);
    const glass = new MeshBuilder()
        .quad([-3.3, 1.1, 3.02], [-1.5, 1.1, 3.02], [-1.5, 2.5, 3.02], [-3.3, 2.5, 3.02])
        .quad([1.5, 1.1, 3.02], [3.3, 1.1, 3.02], [3.3, 2.5, 3.02], [1.5, 2.5, 3.02])
        .quad([4.02, 1.1, 1.0], [4.02, 1.1, -1.0], [4.02, 2.5, -1.0], [4.02, 2.5, 1.0]);
    const door = new MeshBuilder().box([-0.7, 0, 2.98], [0.7, 2.3, 3.06]);
    const chimney = new MeshBuilder().box([2.0, 3.6, -1.6], [2.8, 6.2, -0.8]);
    const trunk = new MeshBuilder().box([7.0, 0, 1.4], [7.4, 0.9, 1.8]);
    const tree = new MeshBuilder().cone([7.2, 0.8, 1.6], 1.9, 2.2).cone([7.2, 2.2, 1.6], 1.45, 1.9).cone([7.2, 3.5, 1.6], 0.95, 1.8);
    const star = new MeshBuilder().sphere([7.2, 5.45, 1.6], 0.22, 8, 5);
    const moon = new MeshBuilder().sphere([-22, 26, -55], 3.2, 16, 10);
    const stars = new MeshBuilder();
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 260; i++) {
        const azimuth = random() * Math.PI * 2, elevation = 0.12 + random() * 1.3;
        const d: V3 = [Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation)];
        stars.sphere(scale(d, 90), 0.12 + random() * 0.18, 4, 2);
    }
    const draws: Draw3D[] = [
        draw("snow", ground.primitive(), [0.86, 0.9, 0.98, 1], { roughness: 0.95 }),
        draw("walls", walls.primitive(), [0.72, 0.6, 0.46, 1]),
        draw("roof", roof.primitive(), [0.32, 0.09, 0.08, 1], { roughness: 0.7 }),
        draw("roof-snow", snowCap.primitive(), [0.9, 0.93, 1, 1], { roughness: 0.95 }),
        draw("trim", trim.primitive(), [0.92, 0.9, 0.86, 1]),
        draw("windows", glass.primitive(), [0.05, 0.04, 0.02, 1], { emissive: [0.9, 0.55, 0.18], roughness: 0.2 }),
        draw("door", door.primitive(), [0.05, 0.22, 0.1, 1], { roughness: 0.5 }),
        draw("chimney", chimney.primitive(), [0.42, 0.14, 0.1, 1]),
        draw("trunk", trunk.primitive(), [0.25, 0.14, 0.07, 1]),
        draw("tree", tree.primitive(), [0.04, 0.28, 0.1, 1], { roughness: 0.9 }),
        draw("tree-star", star.primitive(), [0.1, 0.08, 0, 1], { emissive: [1, 0.85, 0.2] }),
        draw("moon", moon.primitive(), [0.92, 0.94, 1, 1], { unlit: true }),
        draw("stars", stars.primitive(), [0.85, 0.88, 1, 1], { unlit: true })
    ];
    BULB_COLORS_3D.forEach((color, index) => {
        const glass = new MeshBuilder();
        for (const bulb of bulbs) if (bulb.color === index) glass.sphere(bulb.position, 0.065, 6, 4);
        draws.push(draw(`bulbs-${index}`, glass.primitive(), [0.02, 0.02, 0.02, 1],
            { emissive: [color[0], color[1], color[2]], roughness: 0.3 }));
    });
    const lights: FrameLight3D[] = [
        { kind: "directional", color: [0.45, 0.55, 0.9], intensity: 0.22, direction: norm([0.35, -0.55, 0.75]) },
        ...bulbs.map((bulb): FrameLight3D => ({ kind: "point", color: BULB_COLORS_3D[bulb.color], intensity: BULB_INTENSITY_3D,
            range: BULB_RANGE_3D, position: bulb.position }))
    ];
    return { draws, lights, bulbs };
}

/** Camera-facing fake glow quads, one merged draw per bulb color. */
export function bulbHalos3D(bulbs: readonly Bulb3D[], eye: V3, haloTexture: string, size = 0.42): Draw3D[] {
    return BULB_COLORS_3D.map((color, index) => {
        const quads = new MeshBuilder();
        for (const bulb of bulbs) {
            if (bulb.color !== index) continue;
            const forward = norm(sub(bulb.position, eye));
            const right = norm(cross(forward, [0, 1, 0])), up = cross(right, forward);
            const r = scale(right, size), u = scale(up, size), c = bulb.position;
            quads.quad(sub(sub(c, r), u), sub(add(c, r), u), add(add(c, r), u), add(sub(c, r), u));
        }
        return draw(`halo-${index}`, quads.primitive(), [color[0], color[1], color[2], 0.55], {
            unlit: true, alphaMode: "BLEND", baseColorTexture: haloTexture,
            baseColorTextureInfo: { texCoord: 0, transform: { offset: [0, 0], scale: [1, 1], rotation: 0 },
                sampler: { magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 } } });
    });
}

export interface ChristmasHouseView3D { eye: V3; target: V3; fovDegrees: number }
export const CHRISTMAS_HOUSE_VIEWS_3D: Readonly<Record<"front" | "corner", ChristmasHouseView3D>> = {
    front: { eye: [1.8, 3.4, 17.5], target: [1.6, 2.7, 0], fovDegrees: 48 },
    corner: { eye: [10.5, 2.3, 9.2], target: [1.8, 2.9, 1.2], fovDegrees: 46 }
};

/** A ready Frame3D for one view; haloTexture null leaves out the fake glow. */
export function christmasHouseFrame3D(scene: ChristmasHouseScene3D, view: ChristmasHouseView3D, aspect: number,
                                      haloTexture: string | null): Frame3D {
    const back = norm(sub(view.eye, view.target)), right = norm(cross([0, 1, 0], back)), up = cross(back, right);
    const cameraWorld = [...right, 0, ...up, 0, ...back, 0, ...view.eye, 1];
    const casters = scene.draws.filter(d => d.nodeId !== "moon" && d.nodeId !== "stars" && !d.nodeId.startsWith("bulbs-"));
    const fitted = casters.map(d => d.nodeId === "snow"
        ? { ...d, primitive: new MeshBuilder().quad([-12, 0, 12], [12, 0, 12], [12, 0, -12], [-12, 0, -12]).primitive() } : d);
    return {
        view: invertMat4(cameraWorld)!, diagnostics: [],
        projection: projectionMatrix3D({ kind: "perspective", near: 0.1, far: 200, verticalFovDegrees: view.fovDegrees }, aspect),
        draws: [...scene.draws, ...(haloTexture ? bulbHalos3D(scene.bulbs, view.eye, haloTexture) : [])],
        lights: scene.lights, cameraNodeId: null, cameraPosition: view.eye, worlds: new Map(), environment: null,
        shadow: directionalShadowFrame3D(fitted, scene.lights)
    };
}