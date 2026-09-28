/** @module PlayerProgress.test @description Build-bound checkpoint saves, hostile input, staged restore and native slot failure behavior. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gameplayFixture } from "../core/tests/fixtures/GameplayFixture";
import { gameReference } from "../core/examples/ReferenceProjects";
import { world3DFrom } from "../core/runtime/World3D";
import { interact3D, checkpoint3D } from "../core/runtime/Gameplay3D";
import { worldFrom, applyCommands } from "../core/runtime/World";
import { captureProgress3D, captureProgress2D, parseProgress, serializeProgress, restoreProgress3D, restoreProgress2D, PROGRESS_MAX_BYTES } from "./PlayerProgress";
import { PlayerSession3D } from "./PlayerSession3D";
import { serializeDocument } from "../core/document/Serializer";
const hash="a".repeat(64);
function saved() { const doc=gameplayFixture();return captureProgress3D(interact3D(doc,world3DFrom(doc),"player"),hash,"level0","player"); }
test("session respawn uses the authored anchor before a checkpoint, then preserves checkpoint mutations", async () => {
    const doc = gameplayFixture(), player = doc.nodes.get("player")!;
    doc.nodes.set("player", { ...player, entity: { ...player.entity, respawnAt: "lever" } });
    const host = { readEntryFile: async () => ({ content: serializeDocument(doc), filePath: "level0" }),
        readLevelFile: async () => { throw new Error("No linked levels in this fixture."); } };
    const session = new PlayerSession3D(host, "level0", hash); await session.start();
    session.respawn(); expect(session.world?.bodies.get("player")?.transform.position.x).toBe(1);
    session.interact(); session.respawn();
    expect(session.world?.spawns).toHaveLength(1); expect(session.world?.tallies?.get("uses")).toBe(1);
    expect(session.world?.bodies.get("player")?.transform.position.x).toBe(1);
});
test("3D checkpoint progress retains spawned nodes and counters in a fresh simulation", () => {
    const doc=gameplayFixture(), progress=parseProgress(serializeProgress(saved()),hash,"3d");
    const restored=restoreProgress3D(doc,world3DFrom(doc),progress);
    expect(restored.spawns).toHaveLength(1);expect(restored.bodies.has("runtime-spawn-0")).toBe(true);
    expect(restored.tallies?.get("uses")).toBe(1);expect(restored.time).toBeGreaterThan(0);expect(restored.checkpoint?.position.x).toBe(0);
});
test.each([null, {spawns:null}, {version:6}, {gameId:"b".repeat(64)}, {profile:"2d"}, {playerId:""}, {power:99}, {position:{x:Infinity,y:0,z:0}}, {unknown:true}])("malformed or incompatible save %j is refused", patch => {
    const value=patch===null ? null : {...saved(),...patch};expect(()=>parseProgress(JSON.stringify(value),hash,"3d")).toThrow();
});
test("byte bounds, duplicate IDs and invalid references fail before restoring", () => {
    expect(()=>parseProgress("x".repeat(PROGRESS_MAX_BYTES+1),hash,"3d")).toThrow("2MiB");
    const progress=saved();progress.spawns.push({...progress.spawns[0]});expect(()=>serializeProgress(progress)).toThrow("duplicate");
    const bad=saved();bad.spawns[0].templateId="not-present";expect(()=>restoreProgress3D(gameplayFixture(),world3DFrom(gameplayFixture()),bad)).toThrow("reference");
    const removed=saved();removed.despawned=["camera"];expect(()=>restoreProgress3D(gameplayFixture(),world3DFrom(gameplayFixture()),removed)).toThrow("protected");
});
test("2D checkpoint saves restore player power, despawns, counters and spent tile cells", () => {
    const doc=gameReference();let world=worldFrom(doc);
    doc.nodes.set("tiles", { ...doc.nodes.get("floor")!, id:"tiles", type:"core.tilemap", tilemap:{cols:1,rows:1,tileWidth:16,tileHeight:16,tilesetId:"",tiles:[0]} });
    doc.rootNodeUuids.push("tiles");
    world=applyCommands(world,[{kind:"checkpoint",playerId:"player"},{kind:"tally",key:"coins"},{kind:"setPower",bodyId:"player",power:1}]);
    world=applyCommands(world,[{kind:"setCell",nodeId:"tiles",col:0,row:0,tile:-1},{kind:"despawn",bodyId:"goal"}]);
    const progress=captureProgress2D(world,hash,"entry","player");
    const restored=restoreProgress2D(doc,parseProgress(serializeProgress(progress),hash,"2d"));
    expect(restored.bodies.get("player")?.power).toBe(1);expect(restored.tallies.get("coins")).toBe(1);
    expect(restored.checkpoint).toEqual(world.checkpoint);expect(restored.time).toBeGreaterThan(0);
    expect(restored.cells).toEqual(world.cells);expect(restored.despawned.has("goal")).toBe(true);
});
test("session restores an allowed saved level while paused; bad restore preserves prior world", async () => {
    const content=serializeDocument(gameplayFixture());
    const host={readEntryFile:async()=>({filePath:"level0",content}),readLevelFile:async()=>({filePath:"level1",content}),
        readProgressLevel:jest.fn(async(key:string)=>{if(key!=="level1")throw new Error("Unknown level");return {filePath:key,content};})};
    const session=new PlayerSession3D(host,"level0",hash);await session.start();session.interact();session.checkpoint();
    const save=JSON.parse(session.saveProgress());save.level="level1";await session.restoreProgress(JSON.stringify(save));
    expect(session.filePath).toBe("level1");expect(session.status).toBe("paused");expect(session.world?.spawns).toHaveLength(1);
    const prior=session.world;save.spawns[0].templateId="missing";
    await expect(session.restoreProgress(JSON.stringify(save))).rejects.toThrow();expect(session.world).toBe(prior);
});
test("Stop and restart invalidate an in-flight saved-level read", async () => {
    const content=serializeDocument(gameplayFixture());let resolve!: (value:{filePath:string;content:string})=>void;
    const host={readEntryFile:async()=>({filePath:"level0",content}),readLevelFile:async()=>({filePath:"level1",content}),
        readProgressLevel:()=>new Promise<{filePath:string;content:string}>(done=>{resolve=done;})};
    const session=new PlayerSession3D(host,"level0",hash);await session.start();const text=session.saveProgress();
    const restoring=session.restoreProgress(text);session.stop();await session.restart();const current=session.world;
    resolve({filePath:"level1",content});expect(await restoring).toBe(false);expect(session.world).toBe(current);expect(session.filePath).toBe("level0");
});
test("native progress store survives a fresh instance and rejects oversized writes without replacing saved data", async () => {
    const {createProgressFile}=require("../player3d/progressFile");
    const dir=mkdtempSync(join(tmpdir(),"fogworks-progress-"));
    try {
        const first=createProgressFile(dir,hash), text=serializeProgress(saved());expect(await first.read()).toBeNull();
        await first.write(text);expect(await createProgressFile(dir,hash).read()).toBe(text);
        await expect(first.write("x".repeat(PROGRESS_MAX_BYTES+1))).rejects.toThrow("2MiB");expect(await first.read()).toBe(text);
        expect(()=>createProgressFile(dir,"../escape")).toThrow();
        const writes=[first.write("first"),first.write("second")];await Promise.all(writes);expect(await first.read()).toBe("second");
        writeFileSync(join(dir,hash+".json"),"x".repeat(PROGRESS_MAX_BYTES+1));await expect(first.read()).rejects.toThrow("2MiB");
    } finally {rmSync(dir,{recursive:true,force:true});}
});
