/**
 * @module Asset3DImportWorkflowTest
 * @description Pins embedded and external-buffer glTF loading into the transient viewport cache.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { loadAsset3D, rehydrateAssets3D, environment3DImportActions, loadEnvironment3D,
    rehydrateEnvironments3D } from "./Asset3DImportWorkflow";
import { asset3DImportActions } from "./Asset3DImportWorkflow";
import { createEmptyDocument } from "../core/document/Document";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { TransactionAction } from "../core/actions/TransactionAction";

const fixture = readFileSync(resolve(__dirname, "../core/tests/fixtures/triangle.gltf"), "utf8");
const asBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("3D asset import workflow", () => {
    const hdrBase64 = () => Buffer.concat([Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n"),
        Buffer.from([128, 64, 32, 129])]).toString("base64");
    test("authors asset, model and first camera atomically and undoes them together", () => {
        const doc = createEmptyDocument();
        let id = 0;
        const plan = asset3DImportActions(doc, "models/triangle.gltf", "Triangle", () => `3d-${++id}`);
        expect(plan.cameraId).toBe("3d-3");
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new TransactionAction(doc, "import-3d", plan.actions)).success).toBe(true);
        expect(dispatcher.getDocument().assets3d?.[0].id).toBe(plan.assetId);
        expect(dispatcher.getDocument().nodes.get(plan.modelId)?.spatial3d?.renderable?.meshAssetId).toBe(plan.assetId);
        expect(dispatcher.getDocument().nodes.get(plan.cameraId!)?.spatial3d?.camera?.kind).toBe("perspective");
        dispatcher.undo();
        expect(dispatcher.getDocument().assets3d).toBeUndefined();
        expect(dispatcher.getDocument().nodes.size).toBe(0);
    });

    test("authors stable glTF material records and assigns them to primitive slots", () => {
        const doc = createEmptyDocument();
        let id = 0;
        const plan = asset3DImportActions(doc, "models/triangle.gltf", "Triangle", () => `3d-${++id}`,
            [{ name: "Red" }, { name: "" }]);
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new TransactionAction(doc, "import-3d", plan.actions)).success).toBe(true);
        const current = dispatcher.getDocument();
        expect(plan.materialIds).toEqual(["3d-3", "3d-4"]);
        expect(current.assets3d?.slice(1)).toEqual([
            { id: "3d-3", kind: "material", source: "models/triangle.gltf#material-0", name: "Red" },
            { id: "3d-4", kind: "material", source: "models/triangle.gltf#material-1", name: "Material 2" }
        ]);
        expect(current.nodes.get(plan.modelId)?.spatial3d?.renderable?.materialAssetIds).toEqual(plan.materialIds);
    });

    test("authors and rehydrates a project-relative HDR environment without persisting pixels", async () => {
        const doc = createEmptyDocument(); let id = 0;
        const plan = environment3DImportActions(doc, "environment/studio.hdr", "Studio", () => `env-${++id}`);
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new TransactionAction(doc, "environment", plan.actions)).success).toBe(true);
        const current = dispatcher.getDocument();
        expect(current.assets3d).toEqual([{ id: plan.assetId, kind: "texture",
            source: "environment/studio.hdr", name: "Studio" }]);
        expect(current.nodes.get(plan.nodeId)?.spatial3d?.environment).toEqual({
            textureAssetId: plan.assetId, intensity: 1, rotationDegrees: 0 });
        expect(JSON.stringify(current)).not.toContain("128,64,32,129");
        expect((await loadEnvironment3D({ readEnvironmentFile: async () => hdrBase64() }, "folder", "studio.hdr"))
            .rgb[0]).toBe(1);
        const hydrated = await rehydrateEnvironments3D({ readProjectEnvironmentFile: async () => hdrBase64() },
            "scene.vde", current.assets3d ?? []);
        expect(hydrated.environments.get(plan.assetId)?.rgb[1]).toBe(0.5);
        expect(hydrated.failures).toEqual([]);
        const broken = await rehydrateEnvironments3D({ readProjectEnvironmentFile: async () => "AA==" },
            "scene.vde", current.assets3d ?? []);
        expect(broken.environments.size).toBe(0);
        expect(broken.failures[0]).toMatchObject({ assetId: plan.assetId, source: "environment/studio.hdr" });
    });

    test("reuses an existing authored camera", () => {
        const doc = createEmptyDocument();
        let id = 0;
        const first = asset3DImportActions(doc, "a.gltf", "A", () => `first-${++id}`);
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new TransactionAction(doc, "first", first.actions));
        const current = dispatcher.getDocument();
        const second = asset3DImportActions(current, "b.glb", "B", () => `second-${++id}`);
        expect(second.cameraId).toBeNull();
        expect(second.actions).toHaveLength(3);
    });

    test("loads the owned embedded-buffer glTF without requesting a sidecar", async () => {
        const sidecar = jest.fn();
        const loaded = await loadAsset3D({
            read3DFile: async () => asBase64(fixture),
            read3DSidecar: sidecar
        }, "chosen", "triangle.gltf");
        expect(sidecar).not.toHaveBeenCalled();
        expect(loaded.mesh.instances).toHaveLength(1);
        expect(Array.from(loaded.mesh.instances[0].primitive.indices)).toEqual([0, 1, 2]);
        expect(loaded.mesh.materialColors?.[0]).toEqual([1, 1, 1, 1]);
        expect(loaded.mesh.materialUnlit?.[0]).toBe(false);
        expect(loaded.mesh.materials?.[0]).toMatchObject({ metallic: 0, roughness: 1,
            emissive: [0, 0, 0], baseColorTexture: null, metallicRoughnessTexture: null, doubleSided: false });
        expect(loaded.materials).toEqual([{ name: "White" }]);
    });

    test("resolves embedded and confined sidecar base-color textures into transient data URLs", async () => {
        const embedded = JSON.parse(fixture);
        embedded.images = [{ uri: "data:image/png;base64,AQID" }];
        embedded.textures = [{ source: 0 }];
        embedded.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
        embedded.materials[0].pbrMetallicRoughness.metallicRoughnessTexture = { index: 0 };
        embedded.materials[0].normalTexture = { index: 0, scale: 0.4 };
        embedded.materials[0].emissiveTexture = { index: 0 };
        embedded.materials[0].alphaMode = "MASK";
        embedded.materials[0].alphaCutoff = 0.25;
        embedded.samplers = [{ magFilter: 9728, wrapS: 33071 }];
        embedded.textures[0].sampler = 0;
        embedded.materials[0].pbrMetallicRoughness.baseColorTexture.extensions = {
            KHR_texture_transform: { offset: [0.2, 0.3], scale: [2, 2] }
        };
        const loadedEmbedded = await loadAsset3D({
            read3DFile: async () => asBase64(JSON.stringify(embedded)), read3DSidecar: jest.fn()
        }, "chosen", "triangle.gltf");
        expect(loadedEmbedded.mesh.materials?.[0].baseColorTexture).toBe("data:image/png;base64,AQID");
        expect(loadedEmbedded.mesh.materials?.[0].metallicRoughnessTexture).toBe("data:image/png;base64,AQID");
        expect(loadedEmbedded.mesh.materials?.[0]).toMatchObject({
            normalTexture: "data:image/png;base64,AQID", normalScale: 0.4,
            emissiveTexture: "data:image/png;base64,AQID", alphaMode: "MASK", alphaCutoff: 0.25,
            baseColorTextureInfo: { sampler: { magFilter: 9728, wrapS: 33071 },
                transform: { offset: [0.2, 0.3], scale: [2, 2] } }
        });

        embedded.images = [{ uri: "albedo.jpg" }];
        const sidecar = jest.fn(async () => "BAUG");
        const loadedExternal = await loadAsset3D({
            read3DFile: async () => asBase64(JSON.stringify(embedded)), read3DSidecar: sidecar
        }, "chosen", "models/triangle.gltf");
        expect(sidecar).toHaveBeenCalledWith("chosen", "models/triangle.gltf", "albedo.jpg");
        expect(loadedExternal.mesh.materials?.[0].baseColorTexture).toBe("data:image/jpeg;base64,BAUG");
    });

    test("resolves an external buffer through the confined sidecar channel", async () => {
        const json = JSON.parse(fixture);
        const uri = json.buffers[0].uri as string;
        const payload = uri.slice(uri.indexOf(",") + 1);
        json.buffers[0].uri = "mesh.bin";
        const sidecar = jest.fn(async () => payload);
        const loaded = await loadAsset3D({
            read3DFile: async () => asBase64(JSON.stringify(json)),
            read3DSidecar: sidecar
        }, "chosen", "models/triangle.gltf");
        expect(sidecar).toHaveBeenCalledWith("chosen", "models/triangle.gltf", "mesh.bin");
        expect(loaded.mesh.instances[0].matrix.slice(12, 15)).toEqual([1, 2, 3]);
    });

    test("reports malformed JSON without attempting a buffer read", async () => {
        const sidecar = jest.fn();
        await expect(loadAsset3D({ read3DFile: async () => asBase64("{"), read3DSidecar: sidecar },
            "chosen", "broken.gltf")).rejects.toThrow(/Invalid glTF JSON/);
        expect(sidecar).not.toHaveBeenCalled();
    });

    test("rehydrates persisted mesh ids from project-relative sources", async () => {
        const read = jest.fn(async () => asBase64(fixture));
        const sidecar = jest.fn();
        const result = await rehydrateAssets3D({
            readProject3DFile: read,
            readProject3DSidecar: sidecar
        }, "C:\\project\\scene.vde", [
            { id: "mesh-1", kind: "mesh", source: "models/triangle.gltf" },
            { id: "material-1", kind: "material", source: "materials/white.json" }
        ]);
        expect(read).toHaveBeenCalledWith("C:\\project\\scene.vde", "models/triangle.gltf");
        expect(sidecar).not.toHaveBeenCalled();
        expect(result.meshes.get("mesh-1")?.instances).toHaveLength(1);
        expect(result.meshes.has("material-1")).toBe(false);
        expect(result.failures).toEqual([]);
    });

    test("one missing persisted mesh does not prevent the others from rehydrating", async () => {
        const result = await rehydrateAssets3D({
            readProject3DFile: async (_project, source) => {
                if (source === "missing.glb") throw new Error("ENOENT");
                return asBase64(fixture);
            },
            readProject3DSidecar: jest.fn()
        }, "C:\\project\\scene.vde", [
            { id: "missing", kind: "mesh", source: "missing.glb" },
            { id: "present", kind: "mesh", source: "triangle.gltf" }
        ]);
        expect(result.meshes.has("present")).toBe(true);
        expect(result.meshes.has("missing")).toBe(false);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toMatchObject({ assetId: "missing", source: "missing.glb" });
    });
});
