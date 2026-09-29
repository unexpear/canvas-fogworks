/** @module PlayerSession3D.test @description Entry/restart, staged adoption, cancellation and fixed-step player regressions. */

import { readFileSync } from "fs";
import { resolve } from "path";
import { createEmptyDocument } from "../core/document/Document";
import type { Node } from "../core/document/Node";
import { serializeDocument } from "../core/document/Serializer";
import { advanceWorld3D, digestWorld3D, world3DFrom } from "../core/runtime/World3D";
import { PlayerSession3D } from "./PlayerSession3D";
import { RuntimeProject } from "./RuntimeProject";

function level(next = false) {
    const doc = createEmptyDocument();
    const hero: Node = { id: "hero", type: "core.rectangle", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#ffffff", opacity: 1 }, layout: {},
        entity: { player: true, body: "dynamic" }, spatial3d: {
            transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            collider: { kind: "box", halfExtents: { x: .5, y: .5, z: .5 } }, renderable: { meshAssetId: "mesh" }
        } };
    const camera: Node = { ...hero, id: "camera", entity: undefined, spatial3d: {
        transform: { ...hero.spatial3d!.transform, position: { x: 0, y: 0, z: 5 } },
        camera: { kind: "perspective", near: .1, far: 100, verticalFovDegrees: 60 }
    } };
    doc.nodes.set(hero.id, hero); doc.nodes.set(camera.id, camera);
    if (next) doc.nodes.set("goal", { ...hero, id: "goal", entity: { body: "static", goal: true, transitionTo: "next.vde" },
        spatial3d: { transform: { ...hero.spatial3d!.transform, position: { x: 1.05, y: 0, z: 0 } },
            collider: { kind: "box", halfExtents: { x: .5, y: .5, z: .5 } } } });
    doc.rootNodeUuids = [...doc.nodes.keys()];
    doc.assets3d = [{ id: "mesh", kind: "mesh", source: "triangle.gltf" }];
    return doc;
}
const triangle = readFileSync(resolve(__dirname, "../core/tests/fixtures/triangle.gltf")).toString("base64");
function host() {
    return {
        readEntryFile: jest.fn(async (_entry: string) => ({ filePath: "package:entry", content: serializeDocument(level(true)) })),
        readLevelFile: jest.fn(async (_current: string, _target: string) => ({ filePath: "package:next", content: serializeDocument(level()) })),
        readProject3DFile: jest.fn(async (_current: string, _source: string) => triangle),
        readProject3DSidecar: jest.fn(async () => { throw new Error("Sidecar not packaged"); }),
        readProjectEnvironmentFile: jest.fn(async () => { throw new Error("HDR not packaged"); })
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
const right = { x: 1, y: 0, z: 0, speed: 6 };
function reachGoal(session: PlayerSession3D) { session.advance(0); session.advance(1000 / 60, right); }

test("a packaged start cue is delivered once and is not kept on the world", async () => {
    const doc = level();
    const source = "data:audio/wav;base64,AAAA";
    const hero = doc.nodes.get("hero")!;
    hero.entity = { ...hero.entity!, rules: [{ event: "start", other: "any", target: "self", action: { kind: "sound", source, volume: 0.4 } }] };
    const api = host();
    api.readEntryFile.mockImplementation(async () => ({ filePath: "package:entry", content: serializeDocument(doc) }));
    const session = new PlayerSession3D(api, "main-game");
    await session.start();
    session.advance(0); session.advance(1000 / 60);
    expect(session.takeSounds()).toEqual([{ source, volume: 0.4 }]);
    expect(session.world!.sounds).toBeUndefined();
    expect(session.world!.diagnostics ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/sound/)]));
    session.advance(2000 / 60);
    expect(session.takeSounds()).toEqual([]);
});

test("entry loads directly and creates a renderable fresh world without an editor save path", async () => {
    const api = host(), session = new PlayerSession3D(api, "main-game");
    expect(session.status).toBe("stopped"); expect(session.frame(400, 300)).toBeNull();
    expect(await session.start()).toBe(true);
    expect(api.readEntryFile).toHaveBeenCalledWith("main-game");
    expect(api.readLevelFile).not.toHaveBeenCalled();
    expect(api.readProject3DFile).toHaveBeenCalledWith("package:entry", "triangle.gltf");
    expect(session.status).toBe("running"); expect(session.world!.time).toBe(0);
    expect(session.frame(400, 300)!.draws.length).toBe(1);
    expect(session.error).toBeNull();
});

test("restart reloads the original entry after transitioning, never the last level", async () => {
    const api = host(), session = new PlayerSession3D(api, "main-game");
    await session.start(); reachGoal(session);
    expect(session.world!.transitionTo).toBe("next.vde");
    expect(await session.followTransition()).toBe(true);
    expect(api.readLevelFile).toHaveBeenCalledWith("package:entry", "next.vde");
    expect(session.filePath).toBe("package:next");
    session.advance(90000); session.advance(90020, right);
    expect(await session.restart()).toBe(true);
    expect(api.readEntryFile).toHaveBeenCalledTimes(2);
    expect(session.filePath).toBe("package:entry"); expect(session.world!.time).toBe(0);
    expect(session.world!.bodies.get("hero")!.transform.position.x).toBe(0);
});

test("failed restart preserves the published document, world and frame and pauses for recovery", async () => {
    const api = host(), session = new PlayerSession3D(api, "game");
    await session.start();
    const doc = session.document, world = session.world, frame = session.frame(400, 300);
    api.readProject3DFile.mockRejectedValueOnce(new Error("missing model"));
    await expect(session.restart()).rejects.toThrow("missing model");
    expect(session.document).toBe(doc); expect(session.world).toBe(world);
    expect(session.filePath).toBe("package:entry"); expect(session.frame(400, 300)).toEqual(frame);
    expect(session.status).toBe("paused"); expect(session.error!.message).toContain("missing model");
    session.advance(10000, right); expect(session.world).toBe(world);
    expect(await session.restart()).toBe(true); expect(session.error).toBeNull();
});

test.each(["{", serializeDocument(createEmptyDocument())])("invalid entry is not published (%#)", async content => {
    const api = host(), session = new PlayerSession3D(api, "game");
    api.readEntryFile.mockResolvedValueOnce({ filePath: "bad", content });
    await expect(session.start()).rejects.toThrow();
    expect(session.status).toBe("stopped"); expect(session.document).toBeNull(); expect(session.world).toBeNull();
    expect(session.error).not.toBeNull();
});

test.each([false, true])("Stop discards a late entry read (failure=%s)", async fail => {
    const api = host(), session = new PlayerSession3D(api, "game");
    const late = deferred<{ filePath: string; content: string }>();
    api.readEntryFile.mockReturnValueOnce(late.promise);
    const pending = session.start(); expect(session.status).toBe("loading"); session.stop();
    if (fail) late.reject(new Error("late failure"));
    else late.resolve({ filePath: "late", content: serializeDocument(level()) });
    expect(await pending).toBe(false); expect(session.status).toBe("stopped"); expect(session.error).toBeNull();
    expect(api.readProject3DFile).not.toHaveBeenCalled();
});

test("Stop during asset hydration cannot revive a new run", async () => {
    const api = host(), session = new PlayerSession3D(api, "game"), late = deferred<string>();
    const entered = deferred<void>();
    api.readProject3DFile.mockImplementationOnce(() => { entered.resolve(); return late.promise; });
    const old = session.start(); await entered.promise;
    session.stop(); await session.start(); const world = session.world;
    late.resolve(triangle); expect(await old).toBe(false);
    expect(session.world).toBe(world); expect(session.status).toBe("running");
});

test("a newer failed restart invalidates older success without losing the prior game", async () => {
    const api = host(), session = new PlayerSession3D(api, "game");
    await session.start(); const world = session.world;
    const late = deferred<{ filePath: string; content: string }>();
    api.readEntryFile.mockReturnValueOnce(late.promise).mockRejectedValueOnce(new Error("new failure"));
    const old = session.restart();
    await expect(session.restart()).rejects.toThrow("new failure");
    late.resolve({ filePath: "stale", content: serializeDocument(level()) });
    expect(await old).toBe(false); expect(session.world).toBe(world);
    expect(session.error!.message).toBe("new failure"); expect(session.status).toBe("paused");
});

test("pause during load persists and resume does not spend background time", async () => {
    const api = host(), session = new PlayerSession3D(api, "game");
    const loading = session.start(); session.pause(); await loading;
    expect(session.status).toBe("paused"); session.advance(10000, right); expect(session.world!.time).toBe(0);
    session.resume(); session.advance(20000); expect(session.world!.time).toBe(0);
    session.advance(20000 + 1000 / 60); expect(session.world!.time).toBeCloseTo(1 / 60);
    session.pause(); session.resume(); session.advance(1e6); expect(session.world!.time).toBeCloseTo(1 / 60);
});

test("host timing and input use the existing fixed-step solver without changing authored transforms", async () => {
    const api = host(); api.readEntryFile.mockResolvedValue({ filePath: "entry", content: serializeDocument(level()) });
    const session = new PlayerSession3D(api, "game"); await session.start();
    const doc = session.document!, serialized = serializeDocument(doc);
    session.advance(0); session.advance(1000 / 30, right);
    const expected = advanceWorld3D(doc, world3DFrom(doc), 1 / 30, new Map([["hero", right]]));
    expect(digestWorld3D(session.world!)).toBe(digestWorld3D(expected));
    expect(serializeDocument(doc)).toBe(serialized);
    const position = session.world!.bodies.get("hero")!.transform.position.x;
    session.advance(1000 / 20); // no input must stop controlled movement, not retain its last velocity
    expect(session.world!.bodies.get("hero")!.transform.position.x).toBe(position);
    const before = session.world!.time; session.advance(1e6);
    expect(session.world!.time - before).toBeCloseTo(5 / 60);
    session.advance(1); expect(session.world!.time - before).toBeCloseTo(5 / 60);
    const world = session.world;
    expect(() => session.advance(NaN)).toThrow("timestamp");
    expect(() => session.advance(100, { ...right, x: Infinity })).toThrow("input");
    expect(() => session.frame(0, 300)).toThrow("dimensions"); expect(session.world).toBe(world);
});

test("pending or failed level transitions freeze simulation and require an explicit retry", async () => {
    const api = host(), session = new PlayerSession3D(api, "game"); await session.start(); reachGoal(session);
    const previous = session.world;
    const late = deferred<{ filePath: string; content: string }>(); api.readLevelFile.mockReturnValueOnce(late.promise);
    const pending = session.followTransition(); expect(await session.followTransition()).toBe(false);
    session.advance(20000, right); expect(session.world).toBe(previous);
    late.reject(new Error("destination missing")); await expect(pending).rejects.toThrow("destination missing");
    session.advance(30000); session.advance(40000);
    expect(api.readLevelFile).toHaveBeenCalledTimes(1); expect(session.world).toBe(previous);
    expect(await session.followTransition()).toBe(true); expect(session.status).toBe("paused");
    session.resume(); session.advance(50000); expect(session.world!.time).toBe(0);
});

test("direct runtime entry and transition requests share one cancellation generation", async () => {
    const api = host(), runtime = new RuntimeProject(), late = deferred<{ filePath: string; content: string }>();
    api.readEntryFile.mockReturnValueOnce(late.promise);
    const pending = runtime.open(api, "game");
    await runtime.transition(api, "other-entry", "next.vde");
    late.resolve({ filePath: "stale", content: serializeDocument(level()) });
    expect(await pending).toBe(false); expect(runtime.filePath).toBe("package:next");
});
