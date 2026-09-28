/** @module LevelTransitionWorkflow.test @description All-or-nothing level project loading coverage. */

import { createEmptyDocument } from "../core/document/Document";
import { serializeDocument } from "../core/document/Serializer";
import { loadLevelTransition, RuntimeProject } from "./LevelTransitionWorkflow";
import { readFileSync } from "fs";
import { resolve } from "path";

test("a level is deserialized before adoption and reports its resolved path", async () => {
    const content = serializeDocument(createEmptyDocument());
    const readLevelFile = jest.fn(async () => ({ filePath: "C:/game/level-2.vde", content }));
    const loaded = await loadLevelTransition({ readLevelFile }, "C:/game/level-1.vde", "level-2.vde");
    expect(readLevelFile).toHaveBeenCalledWith("C:/game/level-1.vde", "level-2.vde");
    expect(loaded.filePath).toBe("C:/game/level-2.vde");
});

test("unsaved projects and malformed destinations fail without a partial document", async () => {
    const readLevelFile = jest.fn();
    await expect(loadLevelTransition({ readLevelFile }, null, "level-2.vde")).rejects.toThrow(/Save this project/);
    expect(readLevelFile).not.toHaveBeenCalled();
    await expect(loadLevelTransition({ readLevelFile: async () => ({ filePath: "x", content: "{" }) },
        "C:/game/level-1.vde", "level-2.vde")).rejects.toThrow(/Invalid JSON/);
});

test("runtime transitions use their own path and discard late reads after Stop", async () => {
    const session = new RuntimeProject();
    const content = serializeDocument(createEmptyDocument());
    const readLevelFile = jest.fn(async () => ({ filePath: "C:/game/sub/second.vde", content }));
    expect(await session.transition({ readLevelFile }, "C:/game/first.vde", "sub/second.vde")).toBe(true);
    await session.transition({ readLevelFile }, "C:/game/first.vde", "third.vde");
    expect(readLevelFile).toHaveBeenLastCalledWith("C:/game/sub/second.vde", "third.vde");
    let resolve!: (value: { filePath: string; content: string }) => void;
    const pending = session.transition({ readLevelFile: () => new Promise(done => { resolve = done; }) }, null, "last.vde");
    session.reset(); resolve({ filePath: "late.vde", content });
    expect(await pending).toBe(false);
    expect(session.document).toBeNull(); expect(session.filePath).toBeNull();
});

function assetLevel() {
    const doc = createEmptyDocument();
    doc.assets3d = [{ id: "mesh", kind: "mesh", source: "triangle.gltf", name: "Mesh" },
        { id: "sky", kind: "texture", source: "sky.hdr", name: "Sky" }];
    const fixture = JSON.parse(readFileSync(resolve(__dirname, "../core/tests/fixtures/triangle.gltf"), "utf8"));
    fixture.images = [{ uri: "color.png" }]; fixture.textures = [{ source: 0 }];
    fixture.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
    return {
        readLevelFile: async () => ({ filePath: "C:/game/second.vde", content: serializeDocument(doc) }),
        readProject3DFile: jest.fn(async () => Buffer.from(JSON.stringify(fixture)).toString("base64")),
        readProject3DSidecar: jest.fn(async () => "b3duZWQ="),
        readProjectEnvironmentFile: jest.fn(async () => Buffer.concat([
            Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n"), Buffer.from([128,64,32,129])]).toString("base64"))
    };
}

test("destination mesh, material texture and environment publish together and reset discards only runtime caches", async () => {
    const runtime = new RuntimeProject(), api = assetLevel();
    expect(await runtime.transition(api, "C:/game/first.vde", "second.vde")).toBe(true);
    expect(api.readProject3DFile).toHaveBeenCalledWith("C:/game/second.vde", "triangle.gltf");
    expect(api.readProject3DSidecar).toHaveBeenCalledWith("C:/game/second.vde", "triangle.gltf", "color.png");
    expect(runtime.meshes.get("mesh")?.materials?.[0].baseColorTexture).toBeDefined();
    expect(runtime.environments.get("sky")?.width).toBe(1);
    const prior = runtime.document, meshes = runtime.meshes;
    api.readProjectEnvironmentFile.mockRejectedValueOnce(new Error("missing HDR"));
    await expect(runtime.transition(api, null, "third.vde")).rejects.toThrow(/missing HDR/);
    expect(runtime.document).toBe(prior); expect(runtime.meshes).toBe(meshes);
    runtime.reset(); expect(runtime.meshes.size).toBe(0); expect(runtime.environments.size).toBe(0);
    expect(meshes.size).toBe(1);
});

test("Stop during hydration and superseded transitions cannot publish stale libraries", async () => {
    const runtime = new RuntimeProject(), api = assetLevel();
    let finish!: (value: string) => void;
    api.readProjectEnvironmentFile.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const pending = runtime.transition(api, "C:/game/first.vde", "second.vde");
    while (!finish) await Promise.resolve();
    runtime.reset(); finish("invalid"); expect(await pending).toBe(false);
    expect(runtime.document).toBeNull(); expect(runtime.meshes.size).toBe(0);
    const first = runtime.transition(api, "C:/game/first.vde", "second.vde");
    const second = runtime.transition(api, "C:/game/first.vde", "second.vde");
    expect(await first).toBe(false); expect(await second).toBe(true);
});
