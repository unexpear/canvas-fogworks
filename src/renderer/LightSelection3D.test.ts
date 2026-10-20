/**
 * @module LightSelection3DTest
 * @description Budget tiers, culling, ranking, packing and frame-level limits for many-light 3D scenes.
 */

import { createEmptyDocument } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { MeshPrimitive, MESH_IDENTITY } from "../core/import/MeshData";
import { buildFrame3D, captureFrame3D, FrameLight3D, MAX_FRAME_LIGHTS_3D, MeshLibrary3D } from "./Scene3D";
import { drawBoundingSphere3D, drawLightBudget3D, FRAGMENT_UNIFORM_RESERVE_3D, MAX_DRAW_LIGHTS_3D,
    MAX_SCENE_LIGHTS_3D, MIN_DRAW_LIGHTS_3D, packDrawLights3D, selectDrawLights3D } from "./LightSelection3D";
import { webGL3DShaderSources } from "./emitWebGL3D";

const point = (x: number, y: number, z: number, intensity = 1, range = 2): FrameLight3D =>
    ({ kind: "point", color: [1, 1, 1], intensity, range, position: [x, y, z] });
const sun = (intensity = 1): FrameLight3D => ({ kind: "directional", color: [1, 1, 1], intensity, direction: [0, -1, 0] });
const unitSphere = { center: [0, 0, 0] as const, radius: 1 };

const triangle: MeshPrimitive = {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: null, indices: new Uint32Array([0, 1, 2]), material: null
};

function lightNode(id: string, x: number, y: number, z: number, intensity: number, range: number): Node {
    return { id, type: "core.rectangle", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 1, height: 1 }, style: { fill: "none", opacity: 1 }, layout: {},
        spatial3d: { transform: { position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            light: { kind: "point", color: { x: 1, y: 1, z: 1 }, intensity, range } } };
}

function meshNode(id: string): Node {
    return { id, type: "core.rectangle", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 1, height: 1 }, style: { fill: "none", opacity: 1 }, layout: {},
        spatial3d: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            renderable: { meshAssetId: id } } };
}

describe("3D light budget", () => {
    test("picks the largest tier that fits the fragment uniform limit and never drops below the old four", () => {
        expect(drawLightBudget3D(1024)).toBe(16);
        expect(drawLightBudget3D(FRAGMENT_UNIFORM_RESERVE_3D + 32)).toBe(16);
        expect(drawLightBudget3D(FRAGMENT_UNIFORM_RESERVE_3D + 31)).toBe(8);
        expect(drawLightBudget3D(FRAGMENT_UNIFORM_RESERVE_3D + 16)).toBe(8);
        expect(drawLightBudget3D(FRAGMENT_UNIFORM_RESERVE_3D + 15)).toBe(4);
        expect(drawLightBudget3D(16)).toBe(MIN_DRAW_LIGHTS_3D);
        expect(drawLightBudget3D(Number.NaN)).toBe(MIN_DRAW_LIGHTS_3D);
        expect(MAX_FRAME_LIGHTS_3D).toBe(MAX_DRAW_LIGHTS_3D);
    });

    test("shader light arrays follow the compiled budget and stay packed in two vec4 arrays", () => {
        for (const budget of [16, 8, 4]) {
            const fragment = webGL3DShaderSources(true, budget).fragment;
            expect(fragment).toContain(`uniform vec4 u_lightPosition[${budget}];`);
            expect(fragment).toContain(`uniform vec4 u_lightColorRange[${budget}];`);
            expect(fragment).toContain(`for (int i = 0; i < ${budget}; i++)`);
            expect(fragment).not.toContain("u_lightKind");
        }
        expect(webGL3DShaderSources(false).fragment).toContain(`u_lightPosition[${MAX_DRAW_LIGHTS_3D}]`);
    });
});

describe("per-draw light selection", () => {
    test("culls point lights whose range cannot reach the bounds and keeps those that touch it", () => {
        const lights = [point(2.9, 0, 0, 1, 2), point(3.1, 0, 0, 1, 2), point(0, 0, 0, 1, 0.1)];
        expect(selectDrawLights3D(lights, unitSphere, 16).indices).toEqual([2, 0]);
    });

    test("drops lights that carry no energy", () => {
        const dark: FrameLight3D = { kind: "point", color: [0, 0, 0], intensity: 5, range: 5, position: [0, 0, 0] };
        expect(selectDrawLights3D([point(0, 0, 0, 0), dark, point(0, 0, 0)], unitSphere, 16).indices).toEqual([2]);
    });

    test("directional lights lead with the shadow caster first and report its slot", () => {
        const lights = [point(0, 0, 0, 100), sun(), point(0.5, 0, 0), sun()];
        const selection = selectDrawLights3D(lights, unitSphere, 3, 3);
        expect(selection.indices).toEqual([3, 1, 0]);
        expect(selection.shadowSlot).toBe(0);
        expect(selectDrawLights3D(lights, unitSphere, 3, -1).shadowSlot).toBe(-1);
    });

    test("ranks by contribution then distance then authored order", () => {
        const lights = [point(1.5, 0, 0, 1, 4), point(1.2, 0, 0, 1, 4), point(1.5, 0, 0, 6, 4), point(-1.5, 0, 0, 1, 4)];
        expect(selectDrawLights3D(lights, unitSphere, 4).indices).toEqual([2, 1, 0, 3]);
        const inside = [point(0.5, 0, 0), point(0.1, 0, 0), point(0.1, 0, 0)];
        expect(selectDrawLights3D(inside, unitSphere, 3).indices).toEqual([1, 2, 0]);
    });

    test("hundreds of bulbs: each draw keeps only nearby lights, capped at the budget", () => {
        const lights: FrameLight3D[] = [];
        for (let x = 0; x < 30; x++) for (let z = 0; z < 20; z++) lights.push(point(x, 3, z, 0.5, 1.5));
        expect(lights).toHaveLength(600);
        const roof = { center: [10, 2.5, 10] as const, radius: 1 };
        const selection = selectDrawLights3D(lights, roof, 16);
        expect(selection.indices.length).toBeGreaterThan(4);
        expect(selection.indices.length).toBeLessThanOrEqual(16);
        for (const index of selection.indices) {
            const light = lights[index] as Extract<FrameLight3D, { kind: "point" }>;
            const gap = Math.hypot(light.position[0] - 10, light.position[1] - 2.5, light.position[2] - 10) - 1;
            expect(gap).toBeLessThan(light.range);
        }
        expect(selection.indices[0]).toBe(10 * 20 + 10);
        const far = { center: [500, 0, 500] as const, radius: 1 };
        expect(selectDrawLights3D(lights, far, 16).indices).toEqual([]);
        const weak = selectDrawLights3D(lights, roof, 4).indices;
        expect(weak).toEqual(selection.indices.slice(0, 4));
    });

    test("unknown bounds cull nothing but still respect the budget", () => {
        const lights = Array.from({ length: 40 }, (_, i) => point(i * 100, 0, 0, 1 + i, 1));
        const indices = selectDrawLights3D(lights, null, 8).indices;
        expect(indices).toEqual([39, 38, 37, 36, 35, 34, 33, 32]);
    });
});

describe("draw bounds", () => {
    test("transforms a cached local sphere by translation and the largest axis scale", () => {
        const model = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
        const sphere = drawBoundingSphere3D(triangle.positions, model)!;
        expect(sphere.center).toEqual([5, 6, 7]);
        expect(sphere.radius).toBeCloseTo(Math.SQRT2 * 3);
        expect(drawBoundingSphere3D(triangle.positions, model)).toEqual(sphere);
        expect(drawBoundingSphere3D(new Float32Array(), model)).toBeNull();
    });
});

describe("light packing", () => {
    test("premultiplies intensity and stores kind and range in w", () => {
        const lights: FrameLight3D[] = [sun(2), { kind: "point", color: [1, 0.5, 0.25], intensity: 4, range: 9, position: [1, 2, 3] }];
        const packed = packDrawLights3D(lights, [1, 0], 4);
        expect(packed.count).toBe(2);
        expect(Array.from(packed.positions.slice(0, 8))).toEqual([1, 2, 3, 1, 0, -1, 0, 0]);
        expect(Array.from(packed.colors.slice(0, 8))).toEqual([4, 2, 1, 9, 2, 2, 2, 1]);
        expect(packed.positions).toHaveLength(16);
        const reused = packDrawLights3D(lights, [0], 4, packed);
        expect(reused).toBe(packed);
        expect(reused.count).toBe(1);
        expect(Array.from(reused.colors.slice(4, 8))).toEqual([0, 0, 0, 0]);
        expect(packDrawLights3D(lights, [0, 1, 0, 1, 0], 2).count).toBe(2);
    });
});

describe("many-light frames", () => {
    test("keeps far more than four authored lights and caps the scene with a diagnostic", () => {
        const doc = createEmptyDocument();
        for (let i = 0; i < MAX_SCENE_LIGHTS_3D + 6; i++) {
            const n = lightNode(`bulb-${i}`, i % 40, 2, Math.floor(i / 40), 0.2, 1);
            doc.nodes.set(n.id, n); doc.rootNodeUuids.push(n.id);
        }
        const frame = buildFrame3D(doc, new Map(), 64, 64);
        expect(frame.lights).toHaveLength(MAX_SCENE_LIGHTS_3D);
        expect(frame.diagnostics?.some(line => line.includes("6 light(s)"))).toBe(true);
    });

    test("the CPU reference shades with more than four lights per draw", () => {
        const render = (bulbs: number): number => {
            const doc = createEmptyDocument(), mesh = meshNode("wall");
            doc.nodes.set(mesh.id, mesh); doc.rootNodeUuids.push(mesh.id);
            for (let i = 0; i < bulbs; i++) {
                const angle = i / bulbs * Math.PI * 2;
                const n = lightNode(`bulb-${i}`, Math.cos(angle) * 0.4, Math.sin(angle) * 0.4, 1, 0.05, 3);
                doc.nodes.set(n.id, n); doc.rootNodeUuids.push(n.id);
            }
            const meshes: MeshLibrary3D = new Map([["wall", { instances: [{ name: "wall", matrix: [...MESH_IDENTITY], primitive: triangle }] }]]);
            const capture = captureFrame3D(buildFrame3D(doc, meshes, 32, 32), 32, 32);
            return capture.rgba[(16 * 32 + 16) * 4];
        };
        const four = render(4), twelve = render(12), forty = render(40);
        expect(twelve).toBeGreaterThan(four);
        expect(forty).toBeGreaterThan(twelve);
    });
});