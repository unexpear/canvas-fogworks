/**
 * @module Scene3DTest
 * @description Camera, hierarchy, depth, winding and object-id checks for the 3D viewport proof.
 */

import { createEmptyDocument } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { MeshPrimitive, MESH_IDENTITY } from "../core/import/MeshData";
import { buildFrame3D, captureFrame3D, litColor3D, MAT4_IDENTITY, MeshLibrary3D, multiplyMat4,
    pickCapture3D, projectionMatrix3D, transformMatrix3D } from "./Scene3D";
import { pickColor3D, pickIndex3D } from "./emitWebGL3D";

const primitive: MeshPrimitive = {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: null,
    indices: new Uint32Array([0, 1, 2]),
    material: null
};

function node(id: string, z: number, camera = false): Node {
    return {
        id, type: "core.rectangle", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 1, height: 1 }, style: { fill: "none", opacity: 1 }, layout: {},
        spatial3d: {
            transform: { position: { x: 0, y: 0, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            ...(camera ? { camera: { kind: "perspective" as const, near: 0.1, far: 100, verticalFovDegrees: 60 } }
                : { renderable: { meshAssetId: id } })
        }
    };
}

describe("3D viewport frame", () => {
    test("composes parent and imported instance transforms without touching 2D geometry", () => {
        const doc = createEmptyDocument();
        const parent = node("parent", 0); delete parent.spatial3d!.renderable;
        parent.spatial3d!.transform.position.x = 2; parent.children = ["mesh"];
        const child = node("mesh", 0); child.parent = "parent";
        doc.nodes.set(parent.id, parent); doc.nodes.set(child.id, child); doc.rootNodeUuids = [parent.id];
        const instance = [...MESH_IDENTITY]; instance[13] = 3;
        const meshes: MeshLibrary3D = new Map([["mesh", { instances: [{ name: "triangle", matrix: instance, primitive }] }]]);
        const frame = buildFrame3D(doc, meshes, 100, 100);
        expect(frame.draws[0].model.slice(12, 15)).toEqual([2, 3, 0]);
        expect(child.geometry).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    });

    test("perspective and orthographic projections preserve their distinct scaling", () => {
        const perspective = projectionMatrix3D({ kind: "perspective", near: 0.1, far: 100, verticalFovDegrees: 90 }, 2);
        const orthographic = projectionMatrix3D({ kind: "orthographic", near: 0.1, far: 100, verticalSize: 4 }, 2);
        expect(perspective[0]).toBeCloseTo(0.5);
        expect(perspective[5]).toBeCloseTo(1);
        expect(perspective[11]).toBe(-1);
        expect(orthographic[0]).toBeCloseTo(0.25);
        expect(orthographic[5]).toBeCloseTo(0.5);
        expect(orthographic[15]).toBe(1);
    });

    test("camera transform is inverted into the view matrix", () => {
        const transform = transformMatrix3D({ position: { x: 2, y: 3, z: 4 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } });
        const product = multiplyMat4(transform, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, -3, -4, 1]);
        product.forEach((v, i) => expect(v).toBeCloseTo(MAT4_IDENTITY[i]));
    });

    test("reference pixel capture uses winding, depth and node picking", () => {
        const doc = createEmptyDocument();
        const far = node("far", 0), near = node("near", 1), camera = node("camera", 5, true);
        doc.nodes.set(far.id, far); doc.nodes.set(near.id, near); doc.nodes.set(camera.id, camera);
        doc.rootNodeUuids = [far.id, near.id, camera.id];
        const colored = { ...primitive, material: 0 };
        const meshes: MeshLibrary3D = new Map([
            ["far", { instances: [{ name: "far", matrix: [...MESH_IDENTITY], primitive: colored }], materialColors: [[1, 0, 0, 1]] }],
            ["near", { instances: [{ name: "near", matrix: [...MESH_IDENTITY], primitive: colored }], materialColors: [[0, 1, 0, 1]] }]
        ]);
        const capture = captureFrame3D(buildFrame3D(doc, meshes, 32, 32), 32, 32);
        expect(pickCapture3D(capture, 16, 16)).toBe("near");
        expect(Array.from(capture.rgba.slice((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4))).toEqual([0, 255, 0, 255]);

        const reversed = { ...primitive, indices: new Uint32Array([0, 2, 1]) };
        const backOnly: MeshLibrary3D = new Map([["far", { instances: [{ name: "back", matrix: [...MESH_IDENTITY], primitive: reversed }] }]]);
        expect(captureFrame3D(buildFrame3D(doc, backOnly, 32, 32), 32, 32).nodeIds.every(id => id === null)).toBe(true);
        const doubleSided: MeshLibrary3D = new Map([["far", { instances: [{ name: "back", matrix: [...MESH_IDENTITY], primitive: { ...reversed, material: 0 } }],
            materials: [{ baseColor: [1, 1, 1, 1], baseColorTexture: null, metallicRoughnessTexture: null,
                metallic: 0, roughness: 1, emissive: [0, 0, 0], unlit: true, doubleSided: true }] }]]);
        expect(captureFrame3D(buildFrame3D(doc, doubleSided, 32, 32), 32, 32).nodeIds).toContain("far");
    });

    test("material slot assignments resolve stable source fragments across imported meshes", () => {
        const doc = createEmptyDocument();
        const model = node("model", 0), camera = node("camera", 5, true);
        model.spatial3d!.renderable = { meshAssetId: "mesh-a", materialAssetIds: ["mat-b"] };
        doc.nodes.set(model.id, model); doc.nodes.set(camera.id, camera);
        doc.rootNodeUuids = [model.id, camera.id];
        doc.assets3d = [
            { id: "mesh-a", kind: "mesh", source: "models/a.gltf" },
            { id: "mesh-b", kind: "mesh", source: "models/b.gltf" },
            { id: "mat-b", kind: "material", source: "models/b.gltf#material-0", name: "Green" }
        ];
        const colored = { ...primitive, material: 0 };
        const meshes: MeshLibrary3D = new Map([
            ["mesh-a", { instances: [{ name: "a", matrix: [...MESH_IDENTITY], primitive: colored }], materialColors: [[1, 0, 0, 1]] }],
            ["mesh-b", { instances: [], materialColors: [[0, 1, 0, 1]], materials: [{
                baseColor: [0, 1, 0, 1], baseColorTexture: "data:image/png;base64,AQID",
                metallicRoughnessTexture: "data:image/png;base64,BAUG",
                metallic: 0.75, roughness: 0.25, emissive: [0.1, 0.2, 0.3], unlit: false,
                doubleSided: true
            }] }]
        ]);
        expect(buildFrame3D(doc, meshes, 32, 32).draws[0]).toMatchObject({ color: [0, 1, 0, 1],
            baseColorTexture: "data:image/png;base64,AQID", metallic: 0.75, roughness: 0.25,
            metallicRoughnessTexture: "data:image/png;base64,BAUG",
            emissive: [0.1, 0.2, 0.3], doubleSided: true });
    });

    test("builds directional and point lights from authored world transforms", () => {
        const doc = createEmptyDocument();
        const directional = node("sun", 0), point = node("lamp", 2);
        delete directional.spatial3d!.renderable; delete point.spatial3d!.renderable;
        directional.spatial3d!.light = { kind: "directional", color: { x: 1, y: 0.5, z: 0.25 }, intensity: 2 };
        point.spatial3d!.light = { kind: "point", color: { x: 0.25, y: 0.5, z: 1 }, intensity: 10, range: 8 };
        point.spatial3d!.transform.position.x = 3;
        doc.nodes.set(directional.id, directional); doc.nodes.set(point.id, point);
        doc.rootNodeUuids = [directional.id, point.id];
        expect(buildFrame3D(doc, new Map(), 100, 100).lights).toEqual([
            { kind: "directional", color: [1, 0.5, 0.25], intensity: 2, direction: [0, 0, -1] },
            { kind: "point", color: [0.25, 0.5, 1], intensity: 10, range: 8, position: [3, 0, 2] }
        ]);
    });

    test("fits a finite directional shadow camera around visible geometry", () => {
        const doc = createEmptyDocument(), model = node("model", 0), sun = node("sun", 0);
        delete sun.spatial3d!.renderable;
        sun.spatial3d!.light = { kind: "directional", color: { x: 1, y: 1, z: 1 }, intensity: 1 };
        doc.nodes.set(model.id, model); doc.nodes.set(sun.id, sun); doc.rootNodeUuids = [model.id, sun.id];
        const frame = buildFrame3D(doc, new Map([["model", { instances: [{ name: "model",
            matrix: [...MESH_IDENTITY], primitive }] }]]), 100, 100);
        expect(frame.shadow).not.toBeNull();
        expect(frame.shadow!.lightViewProjection).toHaveLength(16);
        expect(frame.shadow!.lightViewProjection.every(Number.isFinite)).toBe(true);
    });

    test("resolves an authored HDR environment through its stable texture asset id", () => {
        const doc = createEmptyDocument(), environment = node("environment", 0);
        delete environment.spatial3d!.renderable;
        environment.spatial3d!.environment = { textureAssetId: "hdr", intensity: 2, rotationDegrees: 90 };
        doc.nodes.set(environment.id, environment); doc.rootNodeUuids = [environment.id];
        doc.assets3d = [{ id: "hdr", kind: "texture", source: "environment/studio.hdr" }];
        const image = { width: 1, height: 1, rgb: new Float32Array([2, 1, 0.5]) };
        expect(buildFrame3D(doc, new Map(), 100, 100, new Map([["hdr", image]])).environment)
            .toMatchObject({ assetId: "hdr", image, intensity: 2, rotationRadians: Math.PI / 2 });
    });

    test("explicitly composes 2D nodes as camera-facing or transform-following 3D surfaces", () => {
        const doc = createEmptyDocument(), plane = node("plane", 0), billboard = node("billboard", 1);
        delete plane.spatial3d!.renderable; delete billboard.spatial3d!.renderable;
        plane.geometry = { x: 0, y: 0, width: 200, height: 100 };
        plane.style = { fill: "#ff000080", opacity: 0.5 };
        plane.spatial3d!.composition2d = { mode: "plane", pixelsPerUnit: 100, lit: true };
        billboard.spatial3d!.composition2d = { mode: "billboard", pixelsPerUnit: 100, lit: false };
        doc.nodes.set(plane.id, plane); doc.nodes.set(billboard.id, billboard); doc.rootNodeUuids = [plane.id, billboard.id];
        const frame = buildFrame3D(doc, new Map(), 100, 100);
        expect(frame.draws).toHaveLength(2);
        expect(frame.draws[0]).toMatchObject({ nodeId: "plane", unlit: false, doubleSided: true, alphaMode: "BLEND" });
        expect(frame.draws[0].model[0]).toBeCloseTo(2);
        expect(frame.draws[0].model[5]).toBeCloseTo(1);
        expect(frame.draws[1]).toMatchObject({ nodeId: "billboard", unlit: true });
    });

    test("diffuse lighting preserves unlit materials and applies range-limited inverse-square point light", () => {
        const base = [0.5, 0.5, 0.5, 1] as const;
        const point = { kind: "point" as const, color: [1, 1, 1] as const, intensity: 4, range: 10,
            position: [0, 0, 2] as const };
        const lit = litColor3D(base, [point], { position: [0, 0, 0], normal: [0, 0, 1] });
        expect(lit[0]).toBeGreaterThan(0.55);
        expect(lit[0]).toBeLessThan(0.57);
        expect(litColor3D(base, [point], { position: [0, 0, -20], normal: [0, 0, 1] })[0]).toBeCloseTo(0.06);
        expect(litColor3D(base, [point], { position: [0, 0, 0], normal: [0, 0, 1] }, true)).toEqual(base);
    });

    test("24-bit pick colors round-trip and reserve black for no object", () => {
        expect(pickIndex3D([0, 0, 0, 0])).toBe(0);
        for (const id of [1, 255, 256, 65535, 0xabcdef]) {
            expect(pickIndex3D(pickColor3D(id).map(v => Math.round(v * 255)))).toBe(id);
        }
    });
});
