/** @module GamePackage.test @description Inline package validation, confinement, graph and player integration regressions. */

import { readFileSync } from "fs";
import { resolve } from "path";
import { createPackageReader, GAME_PACKAGE_LIMITS } from "./GamePackage";
import { fontStackFamilies } from "./PackageProfile";
const { ownedTestFont } = require("../../scripts/owned-test-font");
import type { GamePackageManifest } from "./GamePackage";
import { PlayerSession3D } from "./PlayerSession3D";

function fixture(): GamePackageManifest {
    const content = JSON.parse(readFileSync(resolve(__dirname, "../../reference-projects/animated-3d.vde"), "utf8"));
    const gltf = readFileSync(resolve(__dirname, "../../reference-projects/triangle.gltf"));
    const buffer = readFileSync(resolve(__dirname, "../../reference-projects/triangle.bin"));
    // This model refers to triangle.bin beside its own source file.
    content.document.assets3d.find((asset: { kind: string }) => asset.kind === "mesh").source = "models/triangle.gltf";
    content.document.nodes.triangle.entity = { goal: true, transitionTo: "second.vde" };
    const resources = [{ path: "models/triangle.gltf", file: "model" }, { path: "models/triangle.bin", file: "buffer" }];
    const first = JSON.stringify(content);
    content.document.nodes.triangle.entity.transitionTo = "ENTRY.vde";
    return { format: "canvas-fogworks-game", version: 1, entry: "entry", requiredCapabilities: ["spatial3d-v1"],
        levels: [{ id: "entry", content: first, links: [{ target: "second.vde", level: "second" }], resources },
            { id: "second", content: JSON.stringify(content), links: [{ target: "entry.vde", level: "entry" }],
                resources: resources.map(resource => ({ ...resource })) }],
        files: [{ id: "model", kind: "gltf", bytes: gltf.length, data: gltf.toString("base64") },
            { id: "buffer", kind: "buffer", bytes: buffer.length, data: buffer.toString("base64") }] };
}
function load(manifest = fixture()) { return createPackageReader(JSON.stringify(manifest)); }

test("owned cyclic package loads, resolves aliases, animates, restarts and performs no external reads", async () => {
    const manifest = fixture(), reader = load(manifest);
    expect(reader.entryKey).toBe("entry"); expect(Object.isFrozen(reader)).toBe(true);
    expect((await reader.readEntryFile("entry")).filePath).toBe("entry");
    expect((await reader.readLevelFile("entry", "SECOND.vde")).filePath).toBe("second");
    expect((await reader.readLevelFile("second", "ENTRY.vde")).filePath).toBe("entry");
    expect(await reader.readProject3DSidecar!("entry", "models/triangle.gltf", "triangle.bin")).toBe(manifest.files[1].data);
    const session = new PlayerSession3D(reader, reader.entryKey);
    await session.start(); session.advance(0); session.advance(20);
    expect(session.world!.time).toBeGreaterThan(0); expect(session.frame(400, 300)!.draws).toHaveLength(1);
    await session.restart(); expect(session.world!.time).toBe(0);
    session.stop(); expect(session.frame(400, 300)).toBeNull();
});

test("parsed content is independent of the caller's original mutable manifest", async () => {
    const manifest = fixture(), reader = load(manifest), expected = manifest.levels[0].content;
    manifest.levels[0].content = "{"; manifest.files[0].data = ""; manifest.levels[0].links[0].level = "missing";
    expect((await reader.readEntryFile("entry")).content).toBe(expected);
    expect((await reader.readLevelFile("entry", "second.vde")).filePath).toBe("second");
});

test.each([0, 2, "1", null])("unsupported version %s fails", version => {
    const manifest = { ...fixture(), version }; expect(() => createPackageReader(JSON.stringify(manifest))).toThrow("format/version");
});
test.each([[], ["unknown"], ["spatial3d-v1", "ray-tracing"]].map(value => [value]))("unsupported capabilities %j fail", requiredCapabilities => {
    expect(() => createPackageReader(JSON.stringify({ ...fixture(), requiredCapabilities }))).toThrow("capabilities");
});
test("unknown fields and malformed JSON fail rather than being ignored", () => {
    expect(() => createPackageReader("{")).toThrow();
    expect(() => createPackageReader(JSON.stringify({ ...fixture(), remoteBaseUrl: "https://example.com" }))).toThrow("fields");
});

test.each(["../secret.bin", "/secret.bin", "C:/secret.bin", "\\\\server\\secret", "https://example.com/a", "asset?x", "asset#x", "a\u0000b", "con.bin", "a.", "a//b", "%2e%2e/secret"])("unsafe declared path %s fails", path => {
    const manifest = fixture(); manifest.levels[0].resources[0].path = path;
    expect(() => load(manifest)).toThrow(/path/i);
});

test.each(["../../secret", "%2e%2e/%2e%2e/secret", "%252e%252e/secret", "http%3A%2F%2Fexample.com", "%5csecret", "%", "/asset", "other.bin"])("unsafe or undeclared sidecar %s is refused", async uri => {
    await expect(load().readProject3DSidecar!("entry", "models/triangle.gltf", uri)).rejects.toThrow();
});
test("bounded parent sidecars and percent-encoded filenames resolve within the level namespace", async () => {
    const manifest = fixture();
    const json = JSON.parse(Buffer.from(manifest.files[0].data, "base64").toString());
    json.buffers[0].uri = "../shared%20buffer.bin";
    const data = Buffer.from(JSON.stringify(json)); manifest.files[0].data = data.toString("base64"); manifest.files[0].bytes = data.length;
    for (const level of manifest.levels) level.resources[1].path = "shared buffer.bin";
    const reader = load(manifest);
    expect(await reader.readProject3DSidecar!("entry", "models/triangle.gltf", "../shared%20buffer.bin")).toBe(manifest.files[1].data);
});

test("missing source, missing file and wrong kind fail before entry publication", () => {
    for (const mutate of [(m: GamePackageManifest) => { m.files.pop(); },
        (m: GamePackageManifest) => { m.levels[0].resources.pop(); },
        (m: GamePackageManifest) => { m.files[1].kind = "image"; }]) {
        const manifest = fixture(); mutate(manifest); expect(() => load(manifest)).toThrow(/Missing|wrong-kind/);
    }
});
test("an omitted model sidecar is discovered at package validation, not at first render", () => {
    const manifest = fixture(); for (const level of manifest.levels) level.resources.pop(); manifest.files.pop();
    expect(() => load(manifest)).toThrow("models/triangle.bin");
});
test("unknown current/entry keys, undeclared targets, wrong read kinds and model keys are refused", async () => {
    const reader = load();
    await expect(reader.readEntryFile("second")).rejects.toThrow("entry");
    await expect(reader.readLevelFile("constructor", "second.vde")).rejects.toThrow("key");
    await expect(reader.readLevelFile("entry", "unlisted.vde")).rejects.toThrow("not allowed");
    await expect(reader.readProjectEnvironmentFile!("entry", "models/triangle.gltf")).rejects.toThrow("not allowed");
    await expect(reader.readProject3DSidecar!("entry", "other.gltf", "models/triangle.bin")).rejects.toThrow("Model");
});
test("case-aliased resources, duplicate IDs and link aliases fail", () => {
    const mutations = [(m: GamePackageManifest) => { m.levels[0].resources.push({ path: "MODELS/TRIANGLE.GLTF", file: "model" }); },
        (m: GamePackageManifest) => { m.levels[0].links.push({ target: "SECOND.vde", level: "second" }); },
        (m: GamePackageManifest) => { m.levels.push(m.levels[0]); },
        (m: GamePackageManifest) => { m.files.push(m.files[0]); }];
    for (const mutate of mutations) { const manifest = fixture(); mutate(manifest); expect(() => load(manifest)).toThrow(/Duplicate/); }
});
test("missing, dangling and unused links are rejected while cycles remain valid", () => {
    const manifest = fixture(); manifest.levels[0].links[0].level = "missing";
    expect(() => load(manifest)).toThrow("linked");
    manifest.levels[0].links = []; expect(() => load(manifest)).toThrow("Unpackaged");
    manifest.levels[0].links = [{ target: "second.vde", level: "second" }, { target: "unused.vde", level: "entry" }];
    expect(() => load(manifest)).toThrow("Unused");
});
test("unreachable levels, unreferenced files/resources and missing entry fail", () => {
    const manifest = fixture(); manifest.levels.push({ ...manifest.levels[1], id: "orphan" });
    expect(() => load(manifest)).toThrow("Unreachable");
    manifest.levels.pop(); manifest.files.push({ id: "orphan", kind: "buffer", bytes: 0, data: "" });
    expect(() => load(manifest)).toThrow("Unused package file");
    manifest.levels[0].resources.push({ path: "orphan.bin", file: "orphan" });
    expect(() => load(manifest)).toThrow("Unused package resource");
    manifest.levels[0].resources.pop(); manifest.files.pop(); manifest.entry = "missing";
    expect(() => load(manifest)).toThrow("entry");
});
test.each(["a", "!!!!", "Zg", "Zg==\n", "Zh==", "____"])("invalid/noncanonical base64 %s fails", data => {
    const manifest = fixture(); manifest.files[1].data = data; expect(() => load(manifest)).toThrow("base64");
});
test("byte mismatches, per-file/table/serialized limits and Unicode byte limits are enforced", () => {
    const manifest = fixture(); manifest.files[1].bytes++; expect(() => load(manifest)).toThrow("byte count");
    manifest.files[1].bytes = GAME_PACKAGE_LIMITS.fileBytes + 1; expect(() => load(manifest)).toThrow("byte limit");
    manifest.files[1].bytes = fixture().files[1].bytes;
    manifest.levels = Array(33).fill(manifest.levels[0]); expect(() => load(manifest)).toThrow("table");
    expect(() => createPackageReader(" ".repeat(GAME_PACKAGE_LIMITS.jsonBytes + 1))).toThrow("text");
    const unicode = fixture(); unicode.levels[0].content = "€".repeat(Math.ceil(GAME_PACKAGE_LIMITS.levelBytes / 3));
    expect(() => load(unicode)).toThrow("text");
});
test("external scene images cannot silently cause network reads", () => {
    const manifest = fixture(), doc = JSON.parse(manifest.levels[0].content);
    doc.document.nodes.triangle.type = "core.image"; doc.document.nodes.triangle.src = "https://example.com/image.png";
    manifest.levels[0].content = JSON.stringify(doc);
    expect(() => load(manifest)).toThrow(/embedded|image/i);
});

test("aggregate asset bytes are bounded independently of the per-file bound", () => {
    const manifest = fixture(), data = Buffer.alloc(GAME_PACKAGE_LIMITS.fileBytes).toString("base64");
    manifest.files = [{ id: "large-a", kind: "buffer", bytes: GAME_PACKAGE_LIMITS.fileBytes, data },
        { id: "large-b", kind: "buffer", bytes: GAME_PACKAGE_LIMITS.fileBytes, data },
        { id: "extra", kind: "buffer", bytes: 1, data: "AA==" }];
    expect(() => load(manifest)).toThrow("asset byte limit");
});

test("file and resource table bounds are checked before traversal", () => {
    const manifest = fixture(); manifest.files = Array(GAME_PACKAGE_LIMITS.files + 1).fill(manifest.files[0]);
    expect(() => load(manifest)).toThrow("table");
    const resources = fixture(); resources.levels[0].resources = Array(GAME_PACKAGE_LIMITS.resources + 1).fill(resources.levels[0].resources[0]);
    expect(() => load(resources)).toThrow("table");
});

test("GLB with an embedded binary chunk loads through the same package player", async () => {
    const manifest = fixture();
    const json = JSON.parse(Buffer.from(manifest.files[0].data, "base64").toString("utf8"));
    delete json.buffers[0].uri;
    const encoded = Buffer.from(JSON.stringify(json)), raw = Buffer.from(manifest.files[1].data, "base64");
    const jsonLength = Math.ceil(encoded.length / 4) * 4, binLength = Math.ceil(raw.length / 4) * 4;
    const glb = Buffer.alloc(28 + jsonLength + binLength);
    glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(jsonLength, 12); glb.writeUInt32LE(0x4e4f534a, 16);
    glb.fill(32, 20, 20 + jsonLength); encoded.copy(glb, 20);
    glb.writeUInt32LE(binLength, 20 + jsonLength); glb.writeUInt32LE(0x004e4942, 24 + jsonLength); raw.copy(glb, 28 + jsonLength);
    manifest.files = [{ id: "model", kind: "glb", bytes: glb.length, data: glb.toString("base64") }];
    for (const level of manifest.levels) {
        level.resources = [{ path: "models/triangle.glb", file: "model" }];
        level.content = level.content.replace(/models\/triangle\.gltf/g, "models/triangle.glb");
    }
    const reader = load(manifest), session = new PlayerSession3D(reader, reader.entryKey);
    await session.start(); expect(session.frame(400, 300)!.draws).toHaveLength(1);
    manifest.files[0].data = "AAAA"; manifest.files[0].bytes = 3;
    expect(() => load(manifest)).toThrow("GLB");
});

function withLabel(manifest: GamePackageManifest, family: string) {
    const doc = JSON.parse(manifest.levels[0].content);
    doc.document.nodes.label = { id: "label", type: "core.text", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 120, height: 24 }, style: { fill: "#ffffff", opacity: 1, fontFamily: `"${family}", sans-serif` },
        layout: {}, text: "Hello" };
    doc.document.rootNodeUuids.push("label");
    manifest.levels[0].content = JSON.stringify(doc);
    return manifest;
}
function attachFont(manifest: GamePackageManifest, family = "Owned Face") {
    const bytes = Buffer.from(ownedTestFont(family));
    manifest.files = [...manifest.files, { id: "face", kind: "font", bytes: bytes.length, data: bytes.toString("base64") }];
    manifest.fonts = [{ family, weight: 400, italic: false, file: "face" }];
    return manifest;
}
test("quoted font stacks keep commas inside a family name", () => {
    expect(fontStackFamilies('"Owned Face", sans-serif')).toEqual(["Owned Face", "sans-serif"]);
    expect(fontStackFamilies("'Name, With Comma', serif")).toEqual(["Name, With Comma", "serif"]);
});
test("a packaged custom face is retained and a missing one is named", () => {
    const reader = load(attachFont(withLabel(fixture(), "Owned Face")));
    expect(reader.fonts.map(font => font.family)).toEqual(["Owned Face"]);
    expect(reader.warnings.map(warning => warning.code)).not.toContain("undrawn-text");
    expect(() => load(withLabel(fixture(), "Owned Face"))).toThrow(/custom font "Owned Face" on label/);
    const mismatch = attachFont(withLabel(fixture(), "Owned Face"));
    mismatch.fonts![0].family = "Other Face";
    expect(() => load(mismatch)).toThrow(/does not match|not Other Face|font bytes/);
});
test("generic families need no face, and unused or duplicate faces are refused", () => {
    const generic = fixture(), doc = JSON.parse(generic.levels[0].content);
    doc.document.nodes.label = { id: "label", type: "core.text", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 120, height: 24 }, style: { fill: "#ffffff", opacity: 1, fontFamily: "sans-serif" },
        layout: {}, text: "Hello" };
    doc.document.rootNodeUuids.push("label");
    generic.levels[0].content = JSON.stringify(doc);
    expect(load(generic).fonts).toEqual([]);
    const extra = attachFont(fixture());
    expect(() => load(extra)).toThrow(/Unused packaged font/);
    const duplicated = attachFont(withLabel(fixture(), "Owned Face"));
    duplicated.fonts!.push({ ...duplicated.fonts![0] });
    expect(() => load(duplicated)).toThrow(/Duplicate packaged font/);
});
test("sound cues, morph targets and unsupported glTF requirements are diagnosed", () => {
    const sound = fixture(), doc = JSON.parse(sound.levels[0].content);
    doc.document.nodes.triangle.entity = { ...doc.document.nodes.triangle.entity, rules: [{ event: "start", other: "any", target: "self",
        action: { kind: "sound", source: "data:audio/wav;base64,AAAA", volume: 1 } }] };
    sound.levels[0].content = JSON.stringify(doc);
    const reader = load(sound);
    expect(reader.warnings.map(warning => warning.code)).not.toContain("sound-cue");
    const projected = withLabel(fixture(), "Owned Face");
    const projectedDoc = JSON.parse(projected.levels[0].content);
    projectedDoc.document.nodes.label.spatial3d = { transform: projectedDoc.document.nodes.triangle.spatial3d.transform };
    projected.levels[0].content = JSON.stringify(projectedDoc);
    const projectedReader = load(attachFont(projected));
    expect(projectedReader.warnings.map(warning => warning.code)).toContain("spatial-text");
    expect(projectedReader.warnings.find(warning => warning.code === "spatial-text")!.detail).toContain("label");
    const morph = fixture(), json = JSON.parse(Buffer.from(morph.files[0].data, "base64").toString("utf8"));
    json.meshes[0].primitives[0].targets = [{}];
    const encoded = Buffer.from(JSON.stringify(json));
    morph.files[0].data = encoded.toString("base64"); morph.files[0].bytes = encoded.length;
    expect(load(morph).warnings.map(warning => warning.code)).toContain("morph-target");
    json.extensionsRequired = ["KHR_draco_mesh_compression"];
    const refused = Buffer.from(JSON.stringify(json));
    morph.files[0].data = refused.toString("base64"); morph.files[0].bytes = refused.length;
    expect(() => load(morph)).toThrow(/KHR_draco_mesh_compression/);
});
test("embedded SVG scene images are refused by name", () => {
    const manifest = fixture(), doc = JSON.parse(manifest.levels[0].content);
    doc.document.nodes.badge = { ...doc.document.nodes.triangle, id: "badge", type: "core.image", spatial3d: undefined,
        src: "data:image/svg+xml;base64,PHN2Zz4=" };
    doc.document.rootNodeUuids.push("badge");
    manifest.levels[0].content = JSON.stringify(doc);
    expect(() => load(manifest)).toThrow(/SVG image payloads are not packaged/);
});

test("network and missing image dependencies in model JSON are refused eagerly", () => {
    for (const uri of ["https://example.com/image.png", "missing.png", "data:image/svg+xml;base64,PHN2Zz4="]) {
        const manifest = fixture(), json = JSON.parse(Buffer.from(manifest.files[0].data, "base64").toString("utf8"));
        json.images = [{ uri }]; const encoded = Buffer.from(JSON.stringify(json));
        manifest.files[0].data = encoded.toString("base64"); manifest.files[0].bytes = encoded.length;
        expect(() => load(manifest)).toThrow(/Unsafe|Missing|Unsupported/);
    }
});
