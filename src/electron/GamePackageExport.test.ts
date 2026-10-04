/** @module GamePackageExport.test @description Owned filesystem export graphs, path escapes, size limits and artifact safety. */
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync, truncateSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { createHash } from "crypto";
import { attachWorldPartition, collectGamePackage, externalizePackageStreams, fontPayloadsFromJson, game3DHtml, gameProvenance } from "./GamePackageExport";
const { ownedTestFont } = require("../../scripts/owned-test-font");
import { createPackageReader, GAME_PACKAGE_LIMITS } from "../runtime/GamePackage";
import { PlayerSession3D } from "../runtime/PlayerSession3D";
let temp: string, project: string, raw: any;
beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "fogworks-game-export-")); project = join(temp, "entry.vde");
    const fixtures = resolve(__dirname, "../../reference-projects");
    raw = JSON.parse(readFileSync(join(fixtures, "animated-3d.vde"), "utf8"));
    for (const file of ["triangle.gltf", "triangle.bin"]) copyFileSync(join(fixtures, file), join(temp, file));
    writeFileSync(project, JSON.stringify(raw));
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));
const collect = () => collectGamePackage(project, JSON.stringify(raw));

test("asset-free blockout export retains solid parameters and rebuilds collision after progress restore",async()=>{
    raw.version="87";raw.document.assets3d=[];
    const hero=raw.document.nodes.triangle;
    hero.entity={player:true,body:"dynamic"};
    hero.spatial3d={transform:hero.spatial3d.transform,blockout:{kind:"box",width:.4,height:.4,depth:.4},blockoutCollision:true};
    hero.spatial3d.transform.position={x:0,y:0,z:0};
    const room=JSON.parse(JSON.stringify(hero));room.id="room";room.entity={body:"static"};
    room.spatial3d.blockout={kind:"room",width:4,height:3,depth:4,thickness:.2,ceiling:false};
    room.spatial3d.transform.position={x:0,y:-1,z:0};
    raw.document.nodes.room=room;raw.document.rootNodeUuids.push("room");
    const serialized=await collect(),manifest=JSON.parse(serialized);
    expect(manifest.files).toEqual([]);expect(manifest.levels[0].resources).toEqual([]);
    expect(JSON.parse(manifest.levels[0].content).document.nodes.room.spatial3d.blockoutCollision).toBe(true);
    const gameId=createHash("sha256").update(serialized).digest("hex");
    const host=createPackageReader(serialized),session=new PlayerSession3D(host,host.entryKey,gameId);
    await session.start();session.advance(0);
    for(let i=1;i<=120;i++)session.advance(i*1000/60,{x:1,y:0,z:0});
    const x=session.world!.bodies.get("triangle")!.transform.position.x;
    expect(x).toBeGreaterThan(1.7);expect(x).toBeLessThanOrEqual(1.8+1e-9);
    expect(session.frame(320,240)!.draws.find(d=>d.nodeId==="room")!.primitive.indices).toHaveLength(180);
    const progress=session.saveProgress(),restored=new PlayerSession3D(host,host.entryKey,gameId);
    expect(await restored.restoreProgress(progress)).toBe(true);
    expect(restored.world!.bodies.get("room")!.solidParts).toHaveLength(5);
    expect(restored.world!.bodies.get("triangle")!.transform.position.x).toBe(x);
    expect(progress).not.toContain('"vertices"');
});

test("current edits, cyclic links and shared dependencies survive without unreferenced files", async () => {
    raw.document.nodes.triangle.entity = { goal: true, transitionTo: "second.vde" };
    const second = JSON.parse(JSON.stringify(raw)); second.document.nodes.triangle.entity.transitionTo = process.platform === "win32" ? "ENTRY.vde" : "entry.vde";
    writeFileSync(join(temp, "second.vde"), JSON.stringify(second));
    writeFileSync(join(temp, "unreferenced-secret.txt"), "NEVER INCLUDE");
    const serialized = await collect(), manifest = JSON.parse(serialized), host = createPackageReader(serialized);
    expect(manifest.levels).toHaveLength(2); expect(manifest.files).toHaveLength(2);
    expect(serialized).not.toContain("NEVER INCLUDE"); expect(serialized).not.toContain(temp);
    const first = await host.readEntryFile(host.entryKey), next = await host.readLevelFile(first.filePath, "second.vde");
    expect((await host.readLevelFile(next.filePath, "entry.vde")).content).toBe(first.content);
    expect(JSON.parse(first.content).document.nodes.triangle.entity.transitionTo).toBe("second.vde");
    expect(JSON.parse(readFileSync(project, "utf8")).document.nodes.triangle.entity).toBeUndefined();
    const session = new PlayerSession3D(host, host.entryKey); await session.start();
    expect(session.frame(400, 300)!.draws).toHaveLength(1);
});

test("nested, URI-encoded sidecars and embedded ordinary images remain portable", async () => {
    mkdirSync(join(temp, "models"));
    const gltf = JSON.parse(readFileSync(join(temp, "triangle.gltf"), "utf8"));
    gltf.buffers[0].uri = "../shared%20buffer.bin";
    writeFileSync(join(temp, "models", "model.gltf"), JSON.stringify(gltf));
    copyFileSync(join(temp, "triangle.bin"), join(temp, "shared buffer.bin"));
    raw.document.assets3d[0].source = "models/model.gltf";
    raw.document.nodes.badge = { id: "badge", type: "core.image", parent: null, children: [], geometry: { x: 0, y: 0, width: 1, height: 1 }, style: { fill: "#ffffff", opacity: 1 }, layout: {}, src: "badge.png" };
    raw.document.rootNodeUuids.push("badge"); writeFileSync(join(temp, "badge.png"), Buffer.from([1,2,3]));
    const manifest = JSON.parse(await collect());
    expect(manifest.levels[0].resources.map((item: any) => item.path)).toEqual(["models/model.gltf", "shared buffer.bin"]);
    expect(JSON.parse(manifest.levels[0].content).document.nodes.badge.src).toBe("data:image/png;base64,AQID");
});

test.each(["../outside.gltf", "https://example.com/model.gltf", "models\\model.gltf", "con.gltf"])("unsafe source %s is refused", async source => {
    raw.document.assets3d[0].source = source; await expect(collect()).rejects.toThrow();
});
test("an existing junction escape is refused before its model is read", async () => {
    const source = join(temp, "source"), outside = join(temp, "outside"); mkdirSync(source); mkdirSync(outside);
    symlinkSync(outside, join(source, "alias"), process.platform === "win32" ? "junction" : "dir");
    copyFileSync(join(temp, "triangle.gltf"), join(outside, "model.gltf"));
    project = join(source, "entry.vde"); writeFileSync(project, JSON.stringify(raw));
    raw.document.assets3d[0].source = "alias/model.gltf";
    await expect(collect()).rejects.toThrow("outside");
});
test("missing sidecars and oversize files fail without changing the project", async () => {
    const before = readFileSync(project, "utf8");
    rmSync(join(temp, "triangle.bin")); await expect(collect()).rejects.toThrow();
    writeFileSync(join(temp, "triangle.bin"), ""); truncateSync(join(temp, "triangle.bin"), GAME_PACKAGE_LIMITS.fileBytes + 1);
    await expect(collect()).rejects.toThrow("file limit"); expect(readFileSync(project, "utf8")).toBe(before);
});
test("level graph bound applies before reading a 33rd project", async () => {
    for (let index = 1; index <= 32; index++) {
        const next = JSON.parse(JSON.stringify(raw)); next.document.nodes.triangle.entity = { goal: true, transitionTo: `level${index+1}.vde` };
        writeFileSync(join(temp, `level${index}.vde`), JSON.stringify(next));
    }
    raw.document.nodes.triangle.entity = { goal: true, transitionTo: "level1.vde" };
    await expect(collect()).rejects.toThrow("32 levels");
});
test("a camera-less level fails before artifact creation", async () => {
    delete raw.document.nodes.camera.spatial3d.camera; await expect(collect()).rejects.toThrow("camera");
});
test("external ordinary image URLs are refused without fetching them", async () => {
    raw.document.nodes.badge = { ...raw.document.nodes.triangle, id: "badge", type: "core.image", spatial3d: undefined, src: "https://example.com/image.png" };
    raw.document.rootNodeUuids.push("badge");
    await expect(collect()).rejects.toThrow("path");
});
test("the packaging command refuses an existing output directory without altering its contents", async () => {
    const { packageGame } = require("../../scripts/package-game");
    const before = readFileSync(project, "utf8");
    await expect(packageGame(project, temp)).rejects.toThrow();
    expect(readFileSync(project, "utf8")).toBe(before);
});
test("custom fonts are packaged from a directory or payload and provenance omits host paths", async () => {
    const fonts = join(temp, "fonts"); mkdirSync(fonts);
    writeFileSync(join(fonts, "owned.ttf"), ownedTestFont("Owned Face"));
    writeFileSync(join(fonts, "unused.ttf"), ownedTestFont("Unused Face"));
    raw.document.nodes.label = { id: "label", type: "core.text", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 120, height: 24 }, style: { fill: "#ffffff", opacity: 1, fontFamily: "Owned Face, sans-serif" },
        layout: {}, text: "Hello" };
    raw.document.rootNodeUuids.push("label");
    raw.document.nodes.triangle.entity = { rules: [{ event: "start", other: "any", target: "self",
        action: { kind: "sound", source: "data:audio/wav;base64,AAAA", volume: 1 } }] };
    const serialized = await collectGamePackage(project, JSON.stringify(raw), { fontsDirectory: fonts });
    const manifest = JSON.parse(serialized), reader = createPackageReader(serialized);
    expect(manifest.fonts.map((font: { family: string }) => font.family)).toEqual(["Owned Face"]);
    expect(manifest.files.some((file: { kind: string }) => file.kind === "font")).toBe(true);
    expect(serialized).not.toContain("Unused Face"); expect(serialized).not.toContain(temp);
    expect(reader.fonts[0].family).toBe("Owned Face");
    expect(reader.warnings.map(warning => warning.code)).toEqual([]);
    const provenance = gameProvenance(serialized, { appVersion: "0.0.5", sourceRevision: null });
    expect(provenance.authenticity).toBe("unsigned");
    expect(provenance.publisher).toBeNull();
    expect(provenance.signature).toBeNull();
    expect(provenance.certificate).toBeNull();
    expect(provenance.manifestSha256).toBe(createHash("sha256").update(serialized).digest("hex"));
    expect(provenance.fonts[0].sha256).toHaveLength(64);
    expect(JSON.stringify(provenance)).not.toContain(temp);
    const html = game3DHtml(serialized, Buffer.from("/* owned player */"), provenance);
    expect(html).toContain("font-src data: blob:"); expect(html).toContain('id="diagnostics"');
    expect(html).toContain('id="input-settings"'); expect(html).toContain('id="input-summary"');
    expect(html).toContain(provenance.manifestSha256);
    expect(() => game3DHtml(serialized, Buffer.from("/* owned player */"), { ...provenance, manifestSha256: "a".repeat(64) })).toThrow("Provenance");
    const payload = fontPayloadsFromJson([{ data: Buffer.from(ownedTestFont("Owned Face")).toString("base64") }]);
    const fromPayload = JSON.parse(await collectGamePackage(project, JSON.stringify(raw), { fontPayloads: payload }));
    expect(fromPayload.fonts).toHaveLength(1);
    await expect(collectGamePackage(project, JSON.stringify(raw))).rejects.toThrow(/custom font "Owned Face"/);
});
test("export stamps a non-empty save migration table and the packaged HTML exposes it", async () => {
    const migrations = [{ fromGameId: "b".repeat(64), versions: [5, 6] }];
    const serialized = await collectGamePackage(project, JSON.stringify(raw), { saveMigrations: migrations });
    const digest = createHash("sha256").update(serialized).digest("hex");
    expect(JSON.parse(serialized).saveMigrations).toEqual(migrations);
    expect(createPackageReader(serialized).saveMigrations).toEqual(migrations);
    const { saveMigrationsFromHtml } = require("../player3d/progressFile");
    expect(saveMigrationsFromHtml(game3DHtml(serialized, Buffer.from("/* owned player */")), digest)).toEqual(migrations);
    expect(JSON.parse(await collect()).saveMigrations).toBeUndefined();
    await expect(collectGamePackage(project, JSON.stringify(raw), { saveMigrations: [{ fromGameId: "nope", versions: [5] }] })).rejects.toThrow(/build id/);
});
test("buffer image and hdr chunks leave the manifest while fonts and models stay inline", async () => {
    const fonts = join(temp, "fonts"); mkdirSync(fonts);
    writeFileSync(join(fonts, "owned.ttf"), ownedTestFont("Owned Face"));
    raw.document.nodes.label = { id: "label", type: "core.text", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 120, height: 24 }, style: { fill: "#ffffff", opacity: 1, fontFamily: "Owned Face, sans-serif" },
        layout: {}, text: "Hello" };
    raw.document.rootNodeUuids.push("label");
    const serialized = await collectGamePackage(project, JSON.stringify(raw), { fontsDirectory: fonts });
    const split = externalizePackageStreams(serialized);
    const manifest = JSON.parse(split.serialized);
    const font = manifest.files.find((file: { kind: string }) => file.kind === "font");
    const model = manifest.files.find((file: { kind: string }) => file.kind === "gltf" || file.kind === "glb");
    const buffer = manifest.files.find((file: { kind: string }) => file.kind === "buffer");
    expect(typeof font.data).toBe("string");
    expect(typeof model.data).toBe("string");
    expect(buffer.data).toBeUndefined();
    expect(buffer.sha256).toHaveLength(64);
    expect(split.chunks.map(chunk => chunk.id).sort()).toEqual(manifest.files.filter((file: { sha256?: string }) => file.sha256).map((file: { id: string }) => file.id).sort());
    expect(split.serialized).not.toContain(Buffer.from(split.chunks[0].bytes).toString("base64"));
    const streams = join(temp, "streams"); mkdirSync(streams);
    for (const chunk of split.chunks) writeFileSync(join(streams, `${chunk.id}.bin`), chunk.bytes);
    const html = game3DHtml(split.serialized, Buffer.from("/* owned player */"));
    const { createPackageStreamReader, streamCatalogFromHtml } = require("../player3d/packageStream");
    const disk = createPackageStreamReader(streams, streamCatalogFromHtml(html));
    const host = createPackageReader(split.serialized, { async read(id: string) {
        return Uint8Array.from(Buffer.from(await disk.read(id), "base64"));
    } });
    const session = new PlayerSession3D(host, host.entryKey);
    await session.start();
    expect(session.frame(320, 240)!.draws.length).toBeGreaterThan(0);
    expect(host.fonts.map(face => face.family)).toEqual(["Owned Face"]);
    const provenance = gameProvenance(split.serialized, { appVersion: "0.0.5", sourceRevision: null });
    expect(provenance.authenticity).toBe("unsigned");
    expect(provenance.files.find(file => file.id === buffer.id)!.placement).toBe("stream");
    expect(provenance.files.find(file => file.id === font.id)!.placement).toBe("inline");
    expect(JSON.stringify(provenance)).not.toContain(temp);
    expect(html).toContain(buffer.sha256);
}, 60000);
test("package:game --stream writes chunk files beside the player without signing", async () => {
    const { packageGame } = require("../../scripts/package-game");
    const destination = join(temp, "streamed-game");
    await packageGame(project, destination, { stream: true });
    const manifest = JSON.parse(readFileSync(join(destination, "game.cfgame.json"), "utf8"));
    const buffer = manifest.files.find((file: { kind: string }) => file.kind === "buffer");
    const chunk = readFileSync(join(destination, "app", "streams", `${buffer.id}.bin`));
    expect(buffer.data).toBeUndefined();
    expect(createHash("sha256").update(chunk).digest("hex")).toBe(buffer.sha256);
    const html = readFileSync(join(destination, "app", "game.html"), "utf8");
    expect(html).not.toContain(chunk.toString("base64"));
    const provenance = JSON.parse(readFileSync(join(destination, "game.provenance.json"), "utf8"));
    expect(provenance.authenticity).toBe("unsigned");
    expect(provenance.publisher).toBeNull();
    expect(provenance.signature).toBeNull();
    expect(provenance.certificate).toBeNull();
    expect(provenance.files.find((file: { id: string }) => file.id === buffer.id).placement).toBe("stream");
    const present = ["app/game.html", "app/main.cjs", "app/package.json", "app/progressPreload.js", "game.cfgame.json", "game.provenance.json",
        ...manifest.files.filter((file: { sha256?: string }) => file.sha256).map((file: { id: string }) => `app/streams/${file.id}.bin`)];
    const found: string[] = [];
    const walk = (directory: string) => {
        for (const entry of require("fs").readdirSync(directory, { withFileTypes: true })) {
            const full = join(directory, entry.name);
            if (entry.isDirectory()) walk(full);
            else found.push(full.slice(destination.length + 1).replace(/\\/g, "/"));
        }
    };
    walk(destination);
    expect(found.sort()).toEqual(present.sort());
}, 60000);
test("a publisher or signature cannot be stamped, and cells attach only to streamed payloads", async () => {
    const serialized = await collect();
    const provenance = gameProvenance(serialized, { appVersion: "0.0.5", sourceRevision: null });
    const forged = { ...provenance, publisher: "Pat Example", authenticity: "signed" as const };
    expect(() => game3DHtml(serialized, Buffer.from("/* owned player */"), forged as unknown as typeof provenance)).toThrow(/no publisher or signature/);
    const split = externalizePackageStreams(serialized);
    const buffer = JSON.parse(split.serialized).files.find((file: { kind: string }) => file.kind === "buffer");
    const partition = { anchor: "home", loadRadius: 4, unloadRadius: 8, cells: [{ id: "home", min: [-1, -1, -1], max: [1, 1, 1], file: buffer.id }] };
    expect(() => attachWorldPartition(serialized, partition)).toThrow(/streamed buffer, image or hdr/);
    const attached = attachWorldPartition(split.serialized, partition);
    expect(JSON.parse(attached).worldPartition.cells[0].file).toBe(buffer.id);
    expect(createPackageReader(attached, { async read() { throw new Error("not loaded"); } }).worldPartition?.anchor).toBe("home");
    expect(() => attachWorldPartition(attached, partition)).toThrow(/already declared/);
    const { packageGame } = require("../../scripts/package-game");
    await expect(packageGame(project, join(temp, "partition-without-stream"), { worldPartition: partition })).rejects.toThrow(/require --stream/);
    expect(require("fs").existsSync(join(temp, "partition-without-stream"))).toBe(false);
});
test("package:game writes a supplied world partition without a publisher or signature", async () => {
    const { packageGame } = require("../../scripts/package-game");
    const destination = join(temp, "partitioned-game");
    await packageGame(project, destination, { stream: true, worldPartition: {
        anchor: "home", loadRadius: 4, unloadRadius: 8,
        cells: [{ id: "home", min: [-1, -1, -1], max: [1, 1, 1], file: "file1" }]
    } });
    const manifest = JSON.parse(readFileSync(join(destination, "game.cfgame.json"), "utf8"));
    const buffer = manifest.files.find((file: { id: string }) => file.id === "file1");
    expect(buffer.kind).toBe("buffer");
    expect(buffer.data).toBeUndefined();
    expect(buffer.sha256).toHaveLength(64);
    expect(manifest.worldPartition.anchor).toBe("home");
    expect(manifest.worldPartition.cells[0].file).toBe("file1");
    const provenance = JSON.parse(readFileSync(join(destination, "game.provenance.json"), "utf8"));
    expect(provenance.authenticity).toBe("unsigned");
    expect(provenance.publisher).toBeNull();
    expect(provenance.signature).toBeNull();
    expect(provenance.certificate).toBeNull();
    expect(JSON.stringify(provenance)).not.toContain(temp);
}, 60000);
test("HTML keeps untrusted document text out of markup and binds the UTF8 payload digest", async () => {
    raw.document.nodes.triangle.userData = { note: { type: "string", value: "</script><script>alert('bad')</script> café" } };
    const serialized = await collect(), html = game3DHtml(serialized, Buffer.from("/* owned player */"));
    expect(html).not.toContain("alert('bad')"); expect(html).toContain("connect-src 'none'");
    expect(html).toContain(createHash("sha256").update(serialized).digest("hex"));
    const payload = html.match(/data-sha256="[a-f0-9]+">([^<]+)<\/script>/)![1];
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe(serialized);
    expect(() => game3DHtml(serialized, Buffer.alloc(0))).toThrow("bundle");
});
