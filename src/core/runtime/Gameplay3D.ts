/** @module Gameplay3D @description Transient 3D authored commands, bounded template instances, interaction, checkpoint respawn and embedded sound cues. */
import type { ReadonlyDocument } from "../document/Document";
import type { Node } from "../document/Node";
import type { GameplayRule } from "../document/Gameplay";
import { playerEntityId } from "../document/Entity";
import type { Body3D, World3DState } from "./World3D";
import { bodyContact3D,bodyGeometry3D } from "./BodyContact3D";
import { interactionTarget, Position } from "./Interaction";
import { tickBehaviors, BehaviorEvent } from "./BehaviorRuntime";
import { resolveBehavior } from "../document/BehaviorAssets";
import { behaviorEvents } from "../document/BehaviorGraph";
export interface Spawn3D { id: string; templateId: string; position: Position }
export interface Checkpoint { playerId: string; position: Position }
export const MAX_GAMEPLAY_SPAWNS = 256;
/** Cues retained from one rules pass. The host plays them; the next step does not. */
export const MAX_RULE_SOUNDS = 32;

export function materializeGameplay3D(doc: ReadonlyDocument, world: World3DState): ReadonlyDocument {
    if (!world.spawns?.length && !world.despawned?.size) return doc;
    const nodes = new Map(doc.nodes), roots = [...doc.rootNodeUuids];
    for (const spawn of world.spawns ?? []) {
        const template = doc.nodes.get(spawn.templateId);
        if (!template?.spatial3d || nodes.has(spawn.id)) continue;
        nodes.set(spawn.id, { ...template, id: spawn.id, parent: null, children: [], hidden: false,
            entity: { ...template.entity, player: false }, spatial3d: { ...template.spatial3d,
                transform: { ...template.spatial3d.transform, position: { ...spawn.position } } } } as Node);
        roots.push(spawn.id);
    }
    for (const id of world.despawned ?? []) { const node = nodes.get(id); if (node) nodes.set(id, { ...node, hidden: true }); }
    return { ...doc, nodes, rootNodeUuids: roots };
}

export function applyRules3D(doc: ReadonlyDocument, initial: World3DState,
    events: readonly { self: string; other: string | null; event: GameplayRule["event"]; rules?:readonly GameplayRule[];allowRemoved?:boolean }[], commandsOnly=false,lifecycle=false): World3DState {
    const controlled = playerEntityId(doc.nodes.values()); let world = initial;
    const live = materializeGameplay3D(doc, initial), diagnostics = [...(initial.diagnostics ?? [])];
    const sounds: { source: string; volume: number }[] = [...(initial.sounds ?? [])];
    for (const event of events.slice(0, 4096)) {
        if (world.despawned?.has(event.self)&&!event.allowRemoved) continue;
        const entity = live.nodes.get(event.self)?.entity;
        for (const rule of event.rules ?? entity?.rules ?? []) {
            if (rule.event !== event.event || (rule.other === "player" && event.other !== controlled)) continue;
            const id = rule.target === "self" ? event.self : event.other;
            const target = id ? world.bodies.get(id) : undefined, action = rule.action;
            if (event.event === "interact") {
                const a = world.bodies.get(event.self), b = event.other ? world.bodies.get(event.other) : undefined;
                if (!a || !b || Math.hypot(a.transform.position.x-b.transform.position.x, a.transform.position.y-b.transform.position.y,
                    a.transform.position.z-b.transform.position.z) > (rule.range ?? 2)) continue;
            }
            if (action.kind === "win" || action.kind === "lose") {
                if (world.outcome === "running") world = { ...world, outcome: action.kind === "win" ? "won" : "lost" };
            } else if (action.kind === "score") {
                const tallies = new Map(world.tallies); if (!tallies.has(action.key) && tallies.size >= 256) continue;
                tallies.set(action.key, Math.min(1_000_000_000, (tallies.get(action.key) ?? 0) + 1)); world = { ...world, tallies };
            } else if (action.kind === "checkpoint") {
                const player = controlled ? world.bodies.get(controlled) : undefined;
                if (player) world = { ...world, checkpoint: { playerId: controlled!, position: { ...player.transform.position } } };
            } else if (action.kind === "spawn") {
                const template = doc.nodes.get(action.templateId), spawns = [...(world.spawns ?? [])];
                if (!target || !template?.spatial3d || template.children.length || template.spatial3d.camera || template.spatial3d.light || template.spatial3d.environment) {
                    diagnostics.push("Spawn requires a leaf 3D template and a live target."); continue;
                }
                const spawnId = `runtime-spawn-${spawns.length}`;
                if (spawns.length >= MAX_GAMEPLAY_SPAWNS || live.nodes.has(spawnId) || world.bodies.has(spawnId)) { diagnostics.push("3D spawn limit or ID conflict."); continue; }
                const position = { ...target.transform.position };
                const body: Body3D = { nodeId: spawnId, ...bodyGeometry3D(doc,template.id),parentBodyId:null, transform: { ...template.spatial3d.transform, position },
                    collider: template.spatial3d.collider ?? null, dynamic: template.entity?.body === "dynamic", velocity: { x: 0, y: 0, z: 0 } };
                const bodies = new Map(world.bodies); bodies.set(spawnId, body); spawns.push({ id: spawnId, templateId: template.id, position });
                world = { ...world, bodies, spawns };
            } else if (action.kind === "despawn" && id && target) {
                const removed = new Set<string>(), pending = [id];
                while (pending.length) { const child = pending.pop()!; if (removed.has(child)) continue;
                    removed.add(child); pending.push(...(live.nodes.get(child)?.children ?? [])); }
                if (world.cameraNodeId && removed.has(world.cameraNodeId)) { diagnostics.push("Cannot despawn the active camera."); continue; }
                const bodies = new Map(world.bodies), despawned = new Set(world.despawned);
                for (const child of removed) { bodies.delete(child); despawned.add(child); } world = { ...world, bodies, despawned };
            } else if (action.kind === "velocity" && id && target) {
                const bodies = new Map(world.bodies); bodies.set(id, { ...target, velocity: { x: action.x, y: action.y, z: target.velocity.z } }); world = { ...world, bodies };
            } else if (action.kind === "sound") {
                if (sounds.length < MAX_RULE_SOUNDS) sounds.push({ source: action.source, volume: action.volume });
            }
        }
    }
    world = diagnostics.length ? { ...world, diagnostics: diagnostics.slice(0, 64) } : world;
    if (sounds.length) world = { ...world, sounds: sounds.slice(0, MAX_RULE_SOUNDS) };
    else if (world.sounds) { const cleared = { ...world }; delete cleared.sounds; world = cleared; }
    return commandsOnly ? world : advanceBehaviors3D(doc,world,events.map(e=>({owner:e.self,other:e.other,event:e.event})),undefined,lifecycle);
}

export function stepRules3D(doc: ReadonlyDocument, previous: World3DState, world: World3DState): World3DState {
    const contacts: [string, string][] = [], events: { self: string; other: string | null; event: GameplayRule["event"] }[] = [];
    const old = new Set((previous.gameplayContacts ?? []).map(pair => JSON.stringify(pair)));
    const live = materializeGameplay3D(doc, world);
    if (previous.time === 0) for (const node of live.nodes.values()) if (!node.hidden && world.bodies.has(node.id)) events.push({ self: node.id, other: null, event: "start" });
    for (const [self, a] of world.bodies) {
        const entity = live.nodes.get(self)?.entity;
        if (!entity?.rules?.length && !behaviorEvents(resolveBehavior(live,entity)).length) continue;
        for (const [other, b] of world.bodies) {
            if (contacts.length >= 4096) break;
            if (self === other || !b.dynamic || !bodyContact3D(world.bodies,a, b)) continue;
            contacts.push([self, other]); events.push({ self, other, event: "contact" });
            if (!old.has(JSON.stringify([self, other]))) events.push({ self, other, event: "enter" });
        }
    }
    const current = new Set(contacts.map(pair => JSON.stringify(pair)));
    for (const [self, other] of previous.gameplayContacts ?? []) if (!current.has(JSON.stringify([self, other]))) {
        events.push({ self, other, event: "leave" }, { self, other, event: "separate" });
    }
    return applyRules3D(doc, { ...world, gameplayContacts: contacts }, events,false,true);
}
export function interact3D(doc: ReadonlyDocument, world: World3DState, controlled: string): World3DState {
    if (world.behaviorState?.debug.paused || world.outcome !== "running" || world.transitionTo) return world;
    const live = materializeGameplay3D(doc, world);
    const target = interactionTarget(live, controlled, id => world.bodies.get(id)?.transform.position, 2);
    return target ? applyRules3D(doc, world, [{ self: target, other: controlled, event: "interact" }]) : world;
}
export function checkpoint3D(world: World3DState, playerId: string): World3DState {
    const body = world.bodies.get(playerId); if (!body) throw new Error("No live player to checkpoint.");
    return { ...world, checkpoint: { playerId, position: { ...body.transform.position } } };
}
export function respawnCheckpoint3D(world: World3DState, doc?: ReadonlyDocument): World3DState {
    const checkpoint = world.checkpoint, node = checkpoint && doc?.nodes.get(checkpoint.playerId);
    const body = checkpoint && (world.bodies.get(checkpoint.playerId) ?? (node?.spatial3d ? { nodeId: node.id, ...bodyGeometry3D(doc!,node.id), transform: node.spatial3d.transform,
        collider: node.spatial3d.collider ?? null, dynamic: node.entity?.body === "dynamic", velocity: { x: 0,y: 0,z: 0 } } : undefined));
    if (!checkpoint || !body) throw new Error("No checkpoint with a live player.");
    const bodies = new Map(world.bodies), camera = world.cameraNodeId ? bodies.get(world.cameraNodeId) : undefined;
    if (camera && camera !== body) bodies.set(camera.nodeId, { ...camera, transform: { ...camera.transform, position: {
        x: camera.transform.position.x + checkpoint.position.x - body.transform.position.x,
        y: camera.transform.position.y + checkpoint.position.y - body.transform.position.y,
        z: camera.transform.position.z + checkpoint.position.z - body.transform.position.z } } });
    bodies.set(checkpoint.playerId, { ...body, transform: { ...body.transform, position: { ...checkpoint.position } }, velocity: { x: 0, y: 0, z: 0 } });
    const despawned = new Set(world.despawned); despawned.delete(checkpoint.playerId);
    return { ...world, bodies, despawned, outcome: "running", transitionTo: null, accumulator: 0, gameplayContacts: [] };
}

/** Shared scheduler, also used by the editor instruction-step control. */
export function advanceBehaviors3D(doc:ReadonlyDocument,world:World3DState,events:readonly BehaviorEvent[]=[],mode?:"step",lifecycle=false):World3DState {
    if(world.outcome!=="running"||world.transitionTo)return world;
    const live=materializeGameplay3D(doc,world);
    const all=materializeGameplay3D(doc,{...world,despawned:new Set()});
    const retired=new Map([...(world.despawned??[])].flatMap(id=>{const node=all.nodes.get(id),graph=resolveBehavior(all,node?.entity);return node&&!node.hidden&&graph?[[id,graph] as const]:[];}));
    const result=tickBehaviors({doc:live,state:world.behaviorState,time:world.time,events,controlled:playerEntityId(live.nodes.values()),
        position:id=>world.bodies.get(id)?.transform.position,tallies:world.tallies??new Map(),profile:"3d",mode,...(lifecycle?{lifecycle:{spawned:(world.spawns??[]).map(s=>s.id),retired}}:{})});
    return applyRules3D(doc,{...world,behaviorState:result.state},result.requests.map(r=>({self:r.owner,other:r.other,event:"start",rules:[r.rule],allowRemoved:r.retired})),true);
}
