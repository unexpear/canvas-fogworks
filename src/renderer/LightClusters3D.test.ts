/**
 * @module LightClusters3DTest
 * @description Grid sizing, completeness, overflow, texture layout and per-pixel CPU shading for the
 * clustered many-light path, plus the Christmas house demo's light budget.
 */

import { createEmptyDocument } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { MeshPrimitive, MESH_IDENTITY } from "../core/import/MeshData";
import { buildFrame3D, captureFrame3D, FrameLight3D, MeshLibrary3D } from "./Scene3D";
import { buildLightClusters3D, clusterLightsAt3D, clusterRow3D, lightSignature3D, MAX_CLUSTER_AXIS_3D,
    MAX_CLUSTER_CELLS_3D, MAX_CLUSTER_LIGHTS_3D } from "./LightClusters3D";
import { webGL3DShaderSources } from "./emitWebGL3D";
import { christmasHouseFrame3D, christmasHouseScene3D, CHRISTMAS_HOUSE_VIEWS_3D } from "./ChristmasHouse3D";

const point = (x: number, y: number, z: number, intensity = 1, range = 1): FrameLight3D =>
    ({ kind: "point", color: [1, 0.2, 0.1], intensity, range, position: [x, y, z] });

describe("light clusters", () => {
    test("no point lights means no grid", () => {
        expect(buildLightClusters3D([])).toBeNull();
        expect(buildLightClusters3D([{ kind: "directional", color: [1, 1, 1], intensity: 1, direction: [0, -1, 0] },
            point(0, 0, 0, 0)])).toBeNull();
    });

    test("grid stays inside its axis and cell caps for a wide scene", () => {
        const lights = Array.from({ length: 900 }, (_, i) => point((i % 30) * 3, Math.floor(i / 300), Math.floor(i / 30) % 10 * 3, 1, 1.2));
        const clusters = buildLightClusters3D(lights)!;
        expect(clusters.dims.every(d => d >= 1 && d <= MAX_CLUSTER_AXIS_3D)).toBe(true);
        expect(clusters.height).toBe(clusters.dims[0] * clusters.dims[1] * clusters.dims[2]);
        expect(clusters.height).toBeLessThanOrEqual(MAX_CLUSTER_CELLS_3D);
        expect(clusters.width).toBe(MAX_CLUSTER_LIGHTS_3D * 2);
        expect(clusters.pointLights).toBe(900);
        expect(buildLightClusters3D(lights, 32, 100)!.height).toBeLessThanOrEqual(100);
    });

    test("every point inside a light's range finds that light in its cell", () => {
        const lights = Array.from({ length: 200 }, (_, i) => point(Math.sin(i) * 8, Math.cos(i * 1.3) * 3, (i % 17) - 8, 1, 1.5));
        const clusters = buildLightClusters3D(lights)!;
        expect(clusters.overflowCells).toBe(0);
        lights.forEach((light, index) => {
            const p = (light as Extract<FrameLight3D, { kind: "point" }>).position;
            for (const offset of [[0, 0, 0], [1.2, 0, 0], [0, -1.1, 0.5], [-0.7, 0.7, -0.7]]) {
                const sample: [number, number, number] = [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
                expect(clusterLightsAt3D(clusters, sample)).toContain(index);
            }
        });
        expect(clusterRow3D(clusters, [1000, 0, 0])).toBe(-1);
    });

    test("an overflowing cell keeps the strongest lights and counts the rest", () => {
        const lights = Array.from({ length: 40 }, (_, i) => point(0.01 * i, 0, 0, 1 + i, 2));
        const clusters = buildLightClusters3D(lights, 8)!;
        expect(clusters.overflowCells).toBeGreaterThan(0);
        expect(clusters.maxCellLights).toBe(40);
        const kept = clusterLightsAt3D(clusters, [0.2, 0, 0]);
        expect(kept).toHaveLength(8);
        expect(Math.min(...kept)).toBeGreaterThanOrEqual(30);
    });

    test("texture rows pack position+range then premultiplied color and end with a zero range", () => {
        const clusters = buildLightClusters3D([point(0, 0, 0, 2, 1)], 4)!;
        const row = clusterRow3D(clusters, [0, 0, 0]), at = row * clusters.width * 4;
        expect(Array.from(clusters.data.slice(at, at + 8))).toEqual([0, 0, 0, 1, 2, Math.fround(0.4), Math.fround(0.2), 0]);
        expect(clusters.data[at + 8 + 3]).toBe(0);
    });

    test("the signature changes with any light field and not otherwise", () => {
        const a = [point(0, 0, 0)], b = [point(0, 0, 0)], c = [point(0, 0, 0.001)];
        expect(lightSignature3D(a)).toBe(lightSignature3D(b));
        expect(lightSignature3D(a)).not.toBe(lightSignature3D(c));
        expect(lightSignature3D(a)).not.toBe(lightSignature3D([point(0, 0, 0, 2)]));
    });

    test("the clustered shader variant samples the light grid with a constant loop bound", () => {
        const clustered = webGL3DShaderSources(true, 16, true).fragment;
        expect(clustered).toContain("#define CLUSTERED 1");
        expect(clustered).toContain(`#define CLUSTER_LIGHTS ${MAX_CLUSTER_LIGHTS_3D}`);
        expect(clustered).toContain("precision highp float;");
        expect(clustered).toContain("uniform sampler2D u_clusterLights;");
        expect(clustered).toContain("for (int i = 0; i < CLUSTER_LIGHTS; i++)");
        const fallback = webGL3DShaderSources(true, 16).fragment;
        expect(fallback).toContain("#define CLUSTERED 0");
        expect(fallback).toContain("precision mediump float;");
    });
});

describe("per-pixel lighting on one large mesh", () => {
    test("a single subdivided plane is lit under each of 100 lights, far beyond a per-object budget", () => {
        const n = 40, positions: number[] = [], normals: number[] = [], indices: number[] = [];
        for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) { positions.push(-10 + 20 * x / n, -10 + 20 * y / n, 0); normals.push(0, 0, 1); }
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            const a = y * (n + 1) + x; indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
        }
        const plane: MeshPrimitive = { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: null,
            indices: new Uint32Array(indices), material: null };
        const doc = createEmptyDocument();
        const base = (id: string, x: number, y: number, z: number): Node => ({ id, type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 1, height: 1 }, style: { fill: "none", opacity: 1 }, layout: {},
            spatial3d: { transform: { position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } } });
        const camera = base("camera", 0, 0, 10);
        camera.spatial3d!.camera = { kind: "orthographic", near: 0.1, far: 50, verticalSize: 20 };
        const wall = base("wall", 0, 0, 0); wall.spatial3d!.renderable = { meshAssetId: "wall" };
        for (const node of [camera, wall]) { doc.nodes.set(node.id, node); doc.rootNodeUuids.push(node.id); }
        const spots: [number, number][] = [];
        for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) {
            const x = -9 + i * 2, y = -9 + j * 2, bulb = base(`bulb-${i}-${j}`, x, y, 0.3);
            bulb.spatial3d!.light = { kind: "point", color: { x: 1, y: 0.2, z: 0.1 }, intensity: 0.2, range: 0.8 };
            doc.nodes.set(bulb.id, bulb); doc.rootNodeUuids.push(bulb.id); spots.push([x, y]);
        }
        const meshes: MeshLibrary3D = new Map([["wall", { instances: [{ name: "wall", matrix: [...MESH_IDENTITY], primitive: plane }] }]]);
        const frame = buildFrame3D(doc, meshes, 80, 80);
        expect(frame.draws).toHaveLength(1);
        expect(frame.lights).toHaveLength(100);
        const capture = captureFrame3D(frame, 80, 80);
        const red = (x: number, y: number) => capture.rgba[(Math.floor((10 - y) / 20 * 80) * 80 + Math.floor((x + 10) / 20 * 80)) * 4];
        const dark = red(-10 + 0.25, -10 + 0.25);
        const lit = spots.filter(([x, y]) => red(x, y) > dark + 40).length;
        expect(lit).toBe(100);
    });
});

describe("Christmas house demo", () => {
    test("carries several hundred bulb lights, emissive bulbs and a moonlight shadow", () => {
        const scene = christmasHouseScene3D();
        const points = scene.lights.filter(light => light.kind === "point");
        expect(points.length).toBeGreaterThanOrEqual(300);
        expect(scene.bulbs).toHaveLength(points.length);
        const bulbDraws = scene.draws.filter(d => d.nodeId.startsWith("bulbs-"));
        expect(bulbDraws).toHaveLength(5);
        for (const d of bulbDraws) expect(Math.max(...d.emissive)).toBeGreaterThan(0.5);
        const frame = christmasHouseFrame3D(scene, CHRISTMAS_HOUSE_VIEWS_3D.front, 16 / 9, "data:image/png;base64,AA==");
        expect(frame.shadow).not.toBeNull();
        expect(frame.draws.filter(d => d.nodeId.startsWith("halo-") && d.alphaMode === "BLEND")).toHaveLength(5);
        const clusters = buildLightClusters3D(frame.lights)!;
        expect(clusters.pointLights).toBe(points.length);
        expect(clusters.height).toBeLessThanOrEqual(MAX_CLUSTER_CELLS_3D);
        expect(christmasHouseFrame3D(scene, CHRISTMAS_HOUSE_VIEWS_3D.corner, 1, null).draws).toHaveLength(scene.draws.length);
    });
});