/**
 * @module CameraOrbit3DTest
 * @description Pins authored camera orbit, pan, look rotation and bounded dolly behavior.
 */

import { Spatial3D } from "../core/document/Spatial3D";
import { cameraLookRotation3D, dollyCamera3D, orbitCamera3D, panCamera3D } from "./CameraOrbit3D";
import { transformMatrix3D, transformPoint4 } from "./Scene3D";

const camera: Spatial3D = {
    transform: { position: { x: 0, y: 0, z: 5 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 } },
    camera: { kind: "perspective", near: 0.1, far: 100, verticalFovDegrees: 60 }
};

describe("3D camera navigation", () => {
    test("look rotation points local -Z at the orbit target", () => {
        const rotation = cameraLookRotation3D({ x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        const matrix = transformMatrix3D({ ...camera.transform, position: { x: 0, y: 0, z: 0 }, rotation });
        const forward = transformPoint4(matrix, 0, 0, -1, 0);
        expect(forward[0]).toBeCloseTo(-1); expect(forward[1]).toBeCloseTo(0); expect(forward[2]).toBeCloseTo(0);
    });

    test("orbit preserves radius and writes a unit look quaternion", () => {
        const next = orbitCamera3D(camera, { x: 0, y: 0, z: 0 }, 50, -20);
        expect(Math.hypot(next.transform.position.x, next.transform.position.y, next.transform.position.z)).toBeCloseTo(5);
        expect(Math.hypot(next.transform.rotation.x, next.transform.rotation.y,
            next.transform.rotation.z, next.transform.rotation.w)).toBeCloseTo(1);
    });

    test("pan moves camera and target together while dolly respects clipping bounds", () => {
        const panned = panCamera3D(camera, { x: 0, y: 0, z: 0 }, 100, 50, 500);
        expect(panned.spatial.transform.position.x).toBeCloseTo(panned.target.x);
        expect(panned.spatial.transform.position.y).toBeCloseTo(panned.target.y);
        const near = dollyCamera3D(camera, { x: 0, y: 0, z: 0 }, -100000, camera.camera!);
        expect(near.transform.position.z).toBeCloseTo(0.2);
    });
});
