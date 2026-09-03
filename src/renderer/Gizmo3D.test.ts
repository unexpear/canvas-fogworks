/**
 * @module Gizmo3DTest
 * @description Pins shared drawing/hit geometry and parent-correct world/local translation math.
 */

import { createEmptyDocument } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { buildFrame3D } from "./Scene3D";
import { buildRotateGizmo3D, buildTranslateGizmo3D, hitRotateGizmo3D, hitTranslateGizmo3D,
    copySpatial3D, rotatedSpatial3D, scaledSpatial3D, translatedSpatial3D } from "./Gizmo3D";

function node(id: string, parent: string | null = null): Node {
    return {
        id, type: "core.rectangle", parent, children: [],
        geometry: { x: 0, y: 0, width: 1, height: 1 }, style: { fill: "none", opacity: 1 }, layout: {},
        spatial3d: {
            transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }
        }
    };
}

describe("3D translate gizmo", () => {
    test("the same projected segment is visible and hittable", () => {
        const doc = createEmptyDocument(), model = node("model"), camera = node("camera");
        camera.spatial3d!.transform.position.z = 5;
        camera.spatial3d!.camera = { kind: "perspective", near: 0.1, far: 100, verticalFovDegrees: 60 };
        doc.nodes.set(model.id, model); doc.nodes.set(camera.id, camera); doc.rootNodeUuids = [model.id, camera.id];
        const gizmo = buildTranslateGizmo3D(doc, buildFrame3D(doc, new Map(), 200, 200), "model", 200, 200, "world")!;
        const x = gizmo.handles.find(h => h.axis === "x")!;
        const z = gizmo.handles.find(h => h.axis === "z")!;
        expect(gizmo.handles).toHaveLength(3);
        expect(x.origin).toEqual({ x: 100, y: 100 });
        expect(x.end.x).toBeCloseTo(164);
        expect(hitTranslateGizmo3D(gizmo, x.end.x - 10, x.end.y)?.axis).toBe("x");
        expect(hitTranslateGizmo3D(gizmo, x.origin.x, x.origin.y)).toBeNull();
        expect(z.screenDirection).toEqual({ x: Math.SQRT1_2, y: -Math.SQRT1_2 });
        const depth = translatedSpatial3D(model.spatial3d!, z,
            z.screenDirection.x * 20, z.screenDirection.y * 20);
        expect(depth.transform.position.z).toBeGreaterThan(0);
    });

    test("world drag is converted through a scaled parent's inverse", () => {
        const doc = createEmptyDocument(), parent = node("parent"), child = node("child", "parent"), camera = node("camera");
        parent.children = [child.id]; parent.spatial3d!.transform.scale.x = 2;
        camera.spatial3d!.transform.position.z = 5;
        camera.spatial3d!.camera = { kind: "perspective", near: 0.1, far: 100, verticalFovDegrees: 60 };
        doc.nodes.set(parent.id, parent); doc.nodes.set(child.id, child); doc.nodes.set(camera.id, camera);
        doc.rootNodeUuids = [parent.id, camera.id];
        const gizmo = buildTranslateGizmo3D(doc, buildFrame3D(doc, new Map(), 200, 200), "child", 200, 200, "world")!;
        const x = gizmo.handles.find(h => h.axis === "x")!;
        const moved = translatedSpatial3D(child.spatial3d!, x, x.screenDirection.x * 40, x.screenDirection.y * 40);
        // One world unit is ~34.64px here; the parent's x2 scale halves the stored local delta.
        expect(moved.transform.position.x).toBeCloseTo((40 / (20 * Math.sqrt(3))) / 2, 5);
        expect(moved.transform.position.y).toBeCloseTo(0);
    });

    test("local axes follow authored rotation while world axes do not", () => {
        const doc = createEmptyDocument(), model = node("model"), camera = node("camera");
        const s = Math.sqrt(0.5);
        model.spatial3d!.transform.rotation = { x: 0, y: 0, z: s, w: s };
        camera.spatial3d!.transform.position.z = 5;
        camera.spatial3d!.camera = { kind: "perspective", near: 0.1, far: 100, verticalFovDegrees: 60 };
        doc.nodes.set(model.id, model); doc.nodes.set(camera.id, camera); doc.rootNodeUuids = [model.id, camera.id];
        const frame = buildFrame3D(doc, new Map(), 200, 200);
        const worldX = buildTranslateGizmo3D(doc, frame, "model", 200, 200, "world")!.handles.find(h => h.axis === "x")!;
        const localX = buildTranslateGizmo3D(doc, frame, "model", 200, 200, "local")!.handles.find(h => h.axis === "x")!;
        expect(worldX.screenDirection.x).toBeCloseTo(1);
        expect(localX.screenDirection.x).toBeCloseTo(0);
        expect(localX.screenDirection.y).toBeCloseTo(-1);
    });

    test("rotation rings share hit geometry and keep unit quaternions", () => {
        const doc = createEmptyDocument(), model = node("model"), camera = node("camera");
        camera.spatial3d!.transform.position.z = 5;
        camera.spatial3d!.camera = { kind: "perspective", near: 0.1, far: 100, verticalFovDegrees: 60 };
        doc.nodes.set(model.id, model); doc.nodes.set(camera.id, camera); doc.rootNodeUuids = [model.id, camera.id];
        const gizmo = buildRotateGizmo3D(doc, buildFrame3D(doc, new Map(), 200, 200), "model", 200, 200, "world")!;
        const z = gizmo.handles.find(h => h.axis === "z")!;
        expect(hitRotateGizmo3D(gizmo, z.center.x + z.radius, z.center.y)?.axis).toBe("z");
        const rotated = rotatedSpatial3D(model.spatial3d!, z,
            z.center.x + z.radius, z.center.y, z.center.x, z.center.y + z.radius);
        expect(rotated.transform.rotation.z).toBeCloseTo(Math.SQRT1_2);
        expect(rotated.transform.rotation.w).toBeCloseTo(Math.SQRT1_2);
        expect(Math.hypot(...Object.values(rotated.transform.rotation))).toBeCloseTo(1);
    });

    test("scale drag changes one local component and never reaches zero", () => {
        const doc = createEmptyDocument(), model = node("model"), camera = node("camera");
        camera.spatial3d!.transform.position.z = 5;
        camera.spatial3d!.camera = { kind: "perspective", near: 0.1, far: 100, verticalFovDegrees: 60 };
        doc.nodes.set(model.id, model); doc.nodes.set(camera.id, camera); doc.rootNodeUuids = [model.id, camera.id];
        const x = buildTranslateGizmo3D(doc, buildFrame3D(doc, new Map(), 200, 200),
            "model", 200, 200, "local")!.handles.find(h => h.axis === "x")!;
        const doubled = scaledSpatial3D(model.spatial3d!, x, x.screenDirection.x * 100, x.screenDirection.y * 100);
        expect(doubled.transform.scale).toEqual({ x: 2, y: 1, z: 1 });
        const floored = scaledSpatial3D(model.spatial3d!, x, x.screenDirection.x * -1000, x.screenDirection.y * -1000);
        expect(floored.transform.scale.x).toBeCloseTo(0.01);
    });

    test("copying transform state preserves an authored environment", () => {
        const spatial = node("environment").spatial3d!;
        spatial.environment = { textureAssetId: "hdr", intensity: 2, rotationDegrees: 30 };
        expect(copySpatial3D(spatial).environment).toEqual(spatial.environment);
    });
});
