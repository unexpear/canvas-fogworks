/** @module PlayerProgress @description Versioned, bounded checkpoint progress shared by 2D/3D; no project data, executable code or filesystem paths. */
import type { ReadonlyDocument } from "../core/document/Document";
import type { World3DState } from "../core/runtime/World3D";
import {bodyGeometry3D} from "../core/runtime/BodyContact3D";
import type { WorldState } from "../core/runtime/World";
import { applyCommands, applySpawns, applyWorld, worldFrom } from "../core/runtime/World";
import { materializeGameplay3D, respawnCheckpoint3D } from "../core/runtime/Gameplay3D";
import type { Position } from "../core/runtime/Interaction";
import {SavedBehaviorJob,validateBehaviorProgress,captureBehaviors,restoreBehaviors} from "../core/runtime/BehaviorProgress";
import {emptyBehaviorState} from "../core/runtime/BehaviorRuntime";
import {SavedGameplayData,validateGameplayDataProgress,captureGameplayData,restoreGameplayData} from "../core/runtime/GameplayDataProgress";
export const PROGRESS_MAX_BYTES = 2 * 1024 * 1024;
export interface PlayerProgress {
    format: "canvas-fogworks-progress"; version: 1 | 2 | 3 | 4 | 5; profile: "2d" | "3d";
    gameId: string; level: string; playerId: string; position: Position;
    spawns: { id: string; templateId: string; position: Position }[];
    despawned: string[]; tallies: [string, number][]; power: number;
    cells: [string, number, number, number][];
    behaviors?:SavedBehaviorJob[];
    data?:SavedGameplayData;
    lifecycle?:{spawned:string[];retired:string[]};
}
function fields(value: any, names: string[]) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length
        || names.some(name => !Object.prototype.hasOwnProperty.call(value, name))) throw new Error("Invalid progress record.");
}
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 4096 && !/[\u0000-\u001f]/.test(id);
function point(value: any): void {
    fields(value, ["x", "y", "z"]);
    if (![value.x,value.y,value.z].every(n => Number.isFinite(n) && Math.abs(n) <= 10_000_000)) throw new Error("Invalid saved position.");
}
export function parseProgress(text: string, gameId: string, profile: "2d" | "3d"): PlayerProgress {
    if (typeof text !== "string" || text.length > PROGRESS_MAX_BYTES || new TextEncoder().encode(text).length > PROGRESS_MAX_BYTES) throw new Error("Player save exceeds 2MiB.");
    const value = JSON.parse(text);
    fields(value, ["format","version","profile","gameId","level","playerId","position","spawns","despawned","tallies","power","cells",...(value?.version>=2?["behaviors"]:[]),...(value?.version>=3?["lifecycle"]:[]),...(value?.version>=4?["data"]:[])]);
    if (value.format !== "canvas-fogworks-progress" || ![1,2,3,4,5].includes(value.version) || value.profile !== profile) throw new Error("Unsupported player save format/version/profile.");
    if (!/^[a-f0-9]{64}$/.test(gameId) || value.gameId !== gameId) throw new Error("This save belongs to a different game build.");
    if (!validId(value.level) || !validId(value.playerId)) throw new Error("Invalid saved level/player ID.");
    point(value.position);
    if (!Number.isInteger(value.power) || value.power < 0 || value.power > 1) throw new Error("Invalid saved player power.");
    if (!Array.isArray(value.spawns) || value.spawns.length > 256 || !Array.isArray(value.despawned) || value.despawned.length > 16384
        || !Array.isArray(value.tallies) || value.tallies.length > 256) throw new Error("Player save table limit exceeded.");
    const ids = new Set<string>();
    for (const spawn of value.spawns) {
        fields(spawn,["id","templateId","position"]); point(spawn.position);
        if (!validId(spawn.id) || !validId(spawn.templateId) || ids.has(spawn.id)) throw new Error("Invalid or duplicate saved spawn.");
        ids.add(spawn.id);
    }
    if (value.despawned.some((id: unknown) => !validId(id)) || new Set(value.despawned).size !== value.despawned.length || value.despawned.includes(value.playerId)) throw new Error("Invalid saved despawn list.");
    const tallyIds = new Set<string>();
    if (!Array.isArray(value.cells) || value.cells.length > 65536 || (profile === "3d" && value.cells.length)) throw new Error("Invalid saved cell table.");
    const cellIds = new Set<string>();
    for (const cell of value.cells) {
        if (!Array.isArray(cell) || cell.length !== 4 || !validId(cell[0]) || !cell.slice(1).every(n => Number.isSafeInteger(n) && n >= -1 && n <= 1_000_000)
            || cell[1] < 0 || cell[2] < 0 || cellIds.has(JSON.stringify(cell.slice(0,3)))) throw new Error("Invalid or duplicate saved cell.");
        cellIds.add(JSON.stringify(cell.slice(0,3)));
    }
    for (const pair of value.tallies) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !pair[0].trim() || pair[0].length > 64
            || !Number.isSafeInteger(pair[1]) || pair[1] < 0 || pair[1] > 1_000_000_000 || tallyIds.has(pair[0])) throw new Error("Invalid saved tally.");
        tallyIds.add(pair[0]);
    }
    if(value.version>=2)validateBehaviorProgress(value.behaviors);
    if(value.version<5&&value.behaviors?.some((j:SavedBehaviorJob)=>j.functions!==undefined))throw new Error("Function continuations require player save v5.");
    if(value.version>=3){
        fields(value.lifecycle,["spawned","retired"]);
        for(const key of ["spawned","retired"] as const){
            const list=value.lifecycle[key],allowed=new Set(key==="spawned"?value.spawns.map((s:any)=>s.id):value.despawned);
            if(!Array.isArray(list)||list.length>(key==="spawned"?256:16384)||new Set(list).size!==list.length||list.some(id=>!validId(id)||!allowed.has(id)))throw new Error("Invalid saved lifecycle notifications.");
        }
    }
    if(value.version>=4)validateGameplayDataProgress(value.data);
    return value;
}
export function serializeProgress(progress: PlayerProgress): string {
    const text = JSON.stringify(progress); parseProgress(text, progress.gameId, progress.profile); return text;
}
function base(gameId: string, level: string, playerId: string, position: Position, profile: "2d" | "3d"): PlayerProgress {
    return { format: "canvas-fogworks-progress", version: 5, profile, gameId, level, playerId, position,
        spawns: [], despawned: [], tallies: [], power: 0, cells: [], behaviors:[],lifecycle:{spawned:[],retired:[]},data:{game:[],entities:[]} };
}
export function captureProgress3D(world: World3DState, gameId: string, level: string, playerId: string): PlayerProgress {
    const body = world.bodies.get(playerId); if (!body) throw new Error("No live player to save.");
    const progress = base(gameId,level,playerId,{ ...(world.checkpoint?.position ?? body.transform.position) },"3d");
    progress.data=captureGameplayData(world.behaviorState?.data);
    progress.lifecycle={spawned:[...(world.behaviorState?.spawned??[])],retired:[...(world.behaviorState?.retired??[])]};
    progress.behaviors=captureBehaviors(world.behaviorState,world.time,world.despawned);
    progress.spawns = (world.spawns ?? []).map(spawn => ({ ...spawn, position: { ...(world.bodies.get(spawn.id)?.transform.position ?? spawn.position) } }));
    progress.despawned = [...(world.despawned ?? [])]; progress.tallies = [...(world.tallies ?? [])]; return progress;
}
function validateReferences(doc: ReadonlyDocument, progress: PlayerProgress): void {
    if (!doc.nodes.get(progress.playerId)?.entity?.player) throw new Error("Saved player does not exist in this level.");
    const ids = new Set(doc.nodes.keys());
    for (const [index, spawn] of progress.spawns.entries()) {
        const template = doc.nodes.get(spawn.templateId);
        const expected = progress.profile === "3d" ? `runtime-spawn-${index}` : `${spawn.templateId}#${index}`;
        if (!template || template.children.length || ids.has(spawn.id) || spawn.id !== expected
            || (progress.profile === "3d" ? !template.spatial3d || !!template.spatial3d.camera || !!template.spatial3d.light || !!template.spatial3d.environment : !!template.spatial3d)) throw new Error("Invalid saved template/instance reference.");
        ids.add(spawn.id);
    }
    if (progress.despawned.some(id => !ids.has(id) || !!doc.nodes.get(id)?.spatial3d?.camera)) throw new Error("Unknown or protected saved despawn target.");
    for (const [id,col,row] of progress.cells) {
        const map = doc.nodes.get(id)?.tilemap;
        if (!map || col >= map.cols || row >= map.rows) throw new Error("Saved tile cell is outside its map.");
    }
}
export function restoreProgress3D(doc: ReadonlyDocument, fresh: World3DState, progress: PlayerProgress): World3DState {
    validateReferences(doc, progress);
    const player = fresh.bodies.get(progress.playerId); if (!player?.dynamic) throw new Error("Saved player needs a dynamic body.");
    let world: World3DState = { ...fresh, spawns: progress.spawns, despawned: new Set(progress.despawned), tallies: new Map(progress.tallies),
        checkpoint: { playerId: progress.playerId, position: progress.position } };
    const live = materializeGameplay3D(doc, world), bodies = new Map(fresh.bodies);
    for (const spawn of progress.spawns) {
        const node = live.nodes.get(spawn.id)!;
        bodies.set(spawn.id, { nodeId: spawn.id, ...bodyGeometry3D(live,spawn.id), transform: node.spatial3d!.transform, collider: node.spatial3d!.collider ?? null,
            dynamic: node.entity?.body === "dynamic", velocity: { x: 0, y: 0, z: 0 } });
    }
    for (const id of progress.despawned) bodies.delete(id);
    world = respawnCheckpoint3D({ ...world, bodies });
    // A resumed level must not fire start rules again and duplicate already-saved spawns/counters.
    return { ...world, time: 1 / 60,behaviorState:{data:restoreGameplayData(materializeGameplay3D(doc,world),progress.data),...(restoreBehaviors(materializeGameplay3D(doc,world),progress.behaviors??[],1/60)??emptyBehaviorState()),spawned:progress.lifecycle?.spawned??progress.spawns.map(s=>s.id),retired:progress.lifecycle?.retired??[...progress.despawned]} };
}
export function captureProgress2D(world: WorldState, gameId: string, level: string, playerId: string): PlayerProgress {
    const player = world.bodies.get(playerId); if (!player) throw new Error("No live player to save.");
    const progress = base(gameId,level,playerId,{ ...(world.checkpoint?.position ?? { x: player.x, y: player.y, z: 0 }) },"2d");
    progress.data=captureGameplayData(world.behaviorState?.data);
    progress.lifecycle={spawned:[...(world.behaviorState?.spawned??[])],retired:[...(world.behaviorState?.retired??[])]};
    progress.behaviors=captureBehaviors(world.behaviorState,world.time,world.despawned);
    progress.spawns = world.spawns.map(spawn => ({ id: spawn.id, templateId: spawn.templateId,
        position: { x: world.bodies.get(spawn.id)?.x ?? spawn.x, y: world.bodies.get(spawn.id)?.y ?? spawn.y, z: 0 } }));
    progress.despawned = [...world.despawned]; progress.tallies = [...world.tallies]; progress.power = player.power;
    progress.cells = [...world.cells].map(([key,tile]) => { const [id,col,row] = key.split("\u0000"); return [id,Number(col),Number(row),tile]; }); return progress;
}
export function restoreProgress2D(doc: ReadonlyDocument, progress: PlayerProgress): WorldState {
    validateReferences(doc,progress);
    if (progress.position.z !== 0 || progress.spawns.some(spawn => spawn.position.z !== 0)) throw new Error("2D saves cannot contain 3D positions.");
    let world = worldFrom(doc);
    for (const spawn of progress.spawns) world = applyCommands(world, [{ kind: "spawn", templateId: spawn.templateId, x: spawn.position.x, y: spawn.position.y,
        ...(doc.nodes.get(spawn.templateId)?.entity?.body === "dynamic" ? { body: { vx: 0, vy: 0 } } : {}) }]);
    world = applyCommands(world, progress.despawned.map(bodyId => ({ kind: "despawn", bodyId })));
    world = applyCommands(world, progress.cells.map(([nodeId,col,row,tile]) => ({ kind: "setCell", nodeId,col,row,tile })));
    const player = world.bodies.get(progress.playerId); if (!player) throw new Error("Saved player needs a dynamic body.");
    const bodies = new Map(world.bodies); bodies.set(progress.playerId, { ...player, x: progress.position.x, y: progress.position.y, power: progress.power });
    return { ...world, bodies, time: 1/60, behaviorState:{data:restoreGameplayData(applySpawns(doc,{...world,despawned:new Set()}),progress.data),...(restoreBehaviors(applyWorld(applySpawns(doc,{...world,despawned:new Set()}),world),progress.behaviors??[],1/60)??emptyBehaviorState()),spawned:progress.lifecycle?.spawned??progress.spawns.map(s=>s.id),retired:progress.lifecycle?.retired??[...progress.despawned]}, tallies: new Map(progress.tallies), checkpoint: { playerId: progress.playerId, position: progress.position } };
}
