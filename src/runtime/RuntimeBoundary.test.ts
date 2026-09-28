/** @module RuntimeBoundary.test @description Shared loader capability, compatibility and browser dependency regressions. */

import { build } from "esbuild";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createEmptyDocument } from "../core/document/Document";
import { serializeDocument } from "../core/document/Serializer";
import { RuntimeProject, loadLevelTransition } from "./RuntimeProject";
import { loadAsset3D, rehydrateAssets3D, rehydrateEnvironments3D } from "./Asset3DLoader";
import type { RuntimeProjectReader } from "./ProjectReadHost";
import * as editorLevels from "../app/LevelTransitionWorkflow";
import * as editorAssets from "../app/Asset3DImportWorkflow";

test("editor compatibility exports reference the shared implementations, not copies", () => {
    expect(editorLevels.RuntimeProject).toBe(RuntimeProject);
    expect(editorLevels.loadLevelTransition).toBe(loadLevelTransition);
    expect(editorAssets.loadAsset3D).toBe(loadAsset3D);
    expect(editorAssets.rehydrateAssets3D).toBe(rehydrateAssets3D);
    expect(editorAssets.rehydrateEnvironments3D).toBe(rehydrateEnvironments3D);
});

test.each(["RuntimeProject", "PlayerSession3D", "GamePackage", "StandalonePlayer"])("%s bundles for a browser without editor, Actions, React, Electron or external imports", async entry => {
    const root = resolve(__dirname, "../..");
    const result = await build({
        absWorkingDir: root, entryPoints: [entry === "StandalonePlayer" ? "src/player3d/index.ts" : `src/runtime/${entry}.ts`],
        bundle: true, platform: "browser", format: "esm", target: "es2020",
        write: false, metafile: true, logLevel: "silent"
    });
    const inputs = Object.keys(result.metafile!.inputs).map(file => file.replace(/\\/g, "/"));
    expect(inputs).toContain(entry === "GamePackage" ? "src/core/import/Gltf.ts" : "src/runtime/Asset3DLoader.ts");
    expect(inputs).toContain("src/core/document/Serializer.ts");
    expect(inputs.filter(file => /^(src\/(app|editor|electron|core\/actions)\/|node_modules\/react)/.test(file))).toEqual([]);
    expect(Object.values(result.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
    expect(result.outputFiles[0].text).not.toContain("window.electronAPI");
});

function memoryHost(): RuntimeProjectReader {
    const first = createEmptyDocument(), second = createEmptyDocument();
    second.assets3d = [{ id: "mesh", kind: "mesh", source: "triangle.gltf", name: "Owned mesh" }];
    const levels = new Map([["start", serializeDocument(first)], ["next", serializeDocument(second)]]);
    return {
        async readLevelFile(current, target) {
            if (current !== "package:entry" && current !== "package:next") throw new Error("Unknown package key");
            const content = levels.get(target);
            if (!content) throw new Error("Level not packaged");
            return { filePath: target === "start" ? "package:entry" : "package:next", content };
        },
        async readProject3DFile(project, source) {
            if (project !== "package:next" || source !== "triangle.gltf") throw new Error("Asset not packaged");
            return readFileSync(resolve(__dirname, "../core/tests/fixtures/triangle.gltf")).toString("base64");
        },
        async readProject3DSidecar() { throw new Error("Sidecar not packaged"); },
        async readProjectEnvironmentFile() { throw new Error("Environment not packaged"); }
    };
}

test("a read-only non-Electron host can stage levels and a mesh using opaque package keys", async () => {
    const runtime = new RuntimeProject(), host = memoryHost();
    expect(await runtime.transition(host, "package:entry", "start")).toBe(true);
    expect(await runtime.transition(host, null, "next")).toBe(true);
    expect(runtime.filePath).toBe("package:next");
    expect(runtime.meshes.get("mesh")?.instances.length).toBeGreaterThan(0);
    const previous = runtime.document, meshes = runtime.meshes;
    await expect(runtime.transition(host, null, "missing")).rejects.toThrow("Level not packaged");
    expect(runtime.document).toBe(previous);
    expect(runtime.meshes).toBe(meshes);
    runtime.reset();
    expect(runtime.document).toBeNull();
    expect(runtime.meshes.size).toBe(0);
    expect(meshes.size).toBe(1);
});

test("2D-only readers work until a transition needs missing 3D capabilities", async () => {
    const runtime = new RuntimeProject();
    const host: RuntimeProjectReader = { readLevelFile: memoryHost().readLevelFile };
    expect(await runtime.transition(host, "package:entry", "start")).toBe(true);
    const document = runtime.document, filePath = runtime.filePath;
    await expect(runtime.transition(host, null, "next")).rejects.toThrow("cannot load this level's 3D dependencies");
    expect(runtime.document).toBe(document);
    expect(runtime.filePath).toBe(filePath);
});

test("late host failures after reset are discarded without replacing the next run", async () => {
    const runtime = new RuntimeProject();
    let reject!: (error: Error) => void;
    const old = runtime.transition({ readLevelFile: () => new Promise((_done, fail) => { reject = fail; }) },
        "package:entry", "next");
    runtime.reset();
    await runtime.transition(memoryHost(), "package:entry", "start");
    const document = runtime.document;
    reject(new Error("late read failed"));
    expect(await old).toBe(false);
    expect(runtime.document).toBe(document);
    expect(runtime.filePath).toBe("package:entry");
});
