/** @module World3D.test @description 3D projection, fixed-step, collision and lifecycle coverage. */

import { createEmptyDocument } from "../document/Document";
import { Node } from "../document/Node";
import { advanceWorld3D, applyWorld3D, digestWorld3D, queryCollisions3D, respawnRun3D, restartRun3D, takeWorldSounds } from "./World3D";

function node(id: string, x: number, dynamic = false): Node {
    return { id, type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 },
        style: { fill: "#fff", opacity: 1 }, layout: {}, entity: { body: dynamic ? "dynamic" : "static" },
        spatial3d: { transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 } }, collider: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } } };
}

describe("3D runtime world", () => {
    test("projects authored bodies and advances by deterministic bounded fixed steps", () => {
        const doc = createEmptyDocument(), hero = node("hero", 0, true);
        doc.nodes.set(hero.id, hero); doc.rootNodeUuids = [hero.id];
        const input = new Map([["hero", { x: 1, y: 0, z: 0, speed: 6 }]]);
        const one = advanceWorld3D(doc, restartRun3D(doc), 1 / 30, input);
        const two = advanceWorld3D(doc, advanceWorld3D(doc, restartRun3D(doc), 1 / 60, input), 1 / 60, input);
        expect(digestWorld3D(one)).toBe(digestWorld3D(two));
        expect(one.bodies.get("hero")!.transform.position.x).toBeCloseTo(0.2);
        expect(applyWorld3D(doc, one).nodes.get("hero")!.spatial3d!.transform.position.x).toBeCloseTo(0.2);
        expect(doc.nodes.get("hero")!.spatial3d!.transform.position.x).toBe(0);
    });

    test("static colliders block movement and typed goals request transitions", () => {
        const doc = createEmptyDocument(), hero = node("hero", 0, true), wall = node("wall", 1.05);
        const goal = node("goal", -1.05); goal.entity = { body: "static", goal: true, transitionTo: "next.vde" };
        doc.nodes.set(hero.id, hero); doc.nodes.set(wall.id, wall); doc.nodes.set(goal.id, goal);
        doc.rootNodeUuids = [hero.id, wall.id, goal.id];
        const right = new Map([["hero", { x: 1, y: 0, z: 0, speed: 6 }]]);
        expect(advanceWorld3D(doc, restartRun3D(doc), 1 / 60, right).bodies.get("hero")!.transform.position.x).toBe(0);
        const left = new Map([["hero", { x: -1, y: 0, z: 0, speed: 6 }]]);
        expect(advanceWorld3D(doc, restartRun3D(doc), 1 / 60, left).transitionTo).toBe("next.vde");
    });

    test("restart and respawn restore authored transforms and use a typed anchor", () => {
        const doc = createEmptyDocument(), hero = node("hero", 0, true), checkpoint = node("checkpoint", 8);
        hero.entity = { body: "dynamic", player: true, respawnAt: "checkpoint" };
        doc.nodes.set(hero.id, hero); doc.nodes.set(checkpoint.id, checkpoint); doc.rootNodeUuids = [hero.id, checkpoint.id];
        const moved = advanceWorld3D(doc, restartRun3D(doc), 1 / 60,
            new Map([["hero", { x: 1, y: 0, z: 0, speed: 6 }]]));
        expect(respawnRun3D(doc, moved, "hero").bodies.get("hero")!.transform.position.x).toBe(8);
        expect(restartRun3D(doc).bodies.get("hero")!.transform.position.x).toBe(0);
    });

    test("queries typed colliders and moves the runtime camera with its controlled body", () => {
        const doc = createEmptyDocument(), hero = node("hero", 0, true), trigger = node("trigger", 0.5);
        const camera = node("camera", 5); delete camera.spatial3d!.collider;
        camera.spatial3d!.camera = { kind: "perspective", near: 0.1, far: 100, verticalFovDegrees: 60 };
        doc.nodes.set(hero.id, hero); doc.nodes.set(trigger.id, trigger); doc.nodes.set(camera.id, camera);
        doc.rootNodeUuids = [hero.id, trigger.id, camera.id];
        const start = restartRun3D(doc);
        expect(queryCollisions3D(start, "hero")).toEqual(["trigger"]);
        const moved = advanceWorld3D(doc, start, 1 / 60,
            new Map([["hero", { x: 1, y: 0, z: 0, speed: 6 }]]));
        // Trigger is a static obstacle here, so swap it out to prove camera following separately.
        const clearDoc = createEmptyDocument(); clearDoc.nodes.set(hero.id, hero); clearDoc.nodes.set(camera.id, camera);
        clearDoc.rootNodeUuids = [hero.id, camera.id];
        const followed = advanceWorld3D(clearDoc, restartRun3D(clearDoc), 1 / 60,
            new Map([["hero", { x: 1, y: 0, z: 0, speed: 6 }]]));
        expect(followed.bodies.get("camera")!.transform.position.x).toBeCloseTo(5.1);
        expect(moved.bodies.get("hero")!.transform.position.x).toBe(0);
    });

    test("an embedded start cue is emitted once and then leaves the world", () => {
        const doc = createEmptyDocument(), hero = node("hero", 0, true);
        const source = "data:audio/wav;base64,AAAA";
        hero.entity = { body: "dynamic", player: true, rules: [{ event: "start", other: "any", target: "self",
            action: { kind: "sound", source, volume: 0.4 } }] };
        doc.nodes.set(hero.id, hero); doc.rootNodeUuids = [hero.id];
        const first = advanceWorld3D(doc, restartRun3D(doc), 1 / 60);
        expect(first.sounds).toEqual([{ source, volume: 0.4 }]);
        expect(first.diagnostics ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/sound/)]));
        const taken = takeWorldSounds(first);
        expect(taken.world.sounds).toBeUndefined();
        expect(advanceWorld3D(doc, taken.world, 1 / 60).sounds).toBeUndefined();
    });
});
