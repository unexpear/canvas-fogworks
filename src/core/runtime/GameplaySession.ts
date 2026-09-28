/**
 * @module GameplaySession
 * @description Shared fixed-step gameplay execution for editor and exported games, with transient commands and audio requests.
 */
import { ReadonlyDocument } from "../document/Document";
import { GameplayRule } from "../document/Gameplay";
import { applyCells, applySpawns, applyCommands, stepWorld, WorldState, RuntimeCommand } from "./World";
import { marioRules, RuleContext } from "./Rules";
import { animateWorld2D } from "./AnimationWorld";
import { interactionTarget } from "./Interaction";
import { worldOffsetOf } from "./World";
import { tickBehaviors, BehaviorEvent, BehaviorRequest } from "./BehaviorRuntime";
import { resolveBehavior } from "../document/BehaviorAssets";


export interface SoundRequest { source: string; volume: number; }
export function authoredCommands(doc: ReadonlyDocument, world: WorldState, controlled: string | null, start: boolean, interaction?: string, requests?: readonly BehaviorRequest[]) {
    const commands: RuntimeCommand[] = [], sounds: SoundRequest[] = [];
    const run = (rule: GameplayRule, self: string, other: string | null) => {
        if (rule.other === "player" && other !== controlled) return;
        const bodyId = rule.target === "self" ? self : other;
        const action = rule.action;
        switch (action.kind) {
            case "win": commands.push({ kind: "endRun", outcome: "won" }); break;
            case "lose": commands.push({ kind: "endRun", outcome: "lost" }); break;
            case "score": commands.push({ kind: "tally", key: action.key }); break;
            case "despawn": if (bodyId) commands.push({ kind: "despawn", bodyId }); break;
            case "velocity": if (bodyId) commands.push({ kind: "setVelocity", bodyId, vx: action.x, vy: action.y }); break;
            case "sound": sounds.push({ source: action.source, volume: action.volume }); break;
            case "checkpoint": if (controlled) commands.push({ kind: "checkpoint", playerId: controlled }); break;
            case "spawn": {
                const template = doc.nodes.get(action.templateId), target = bodyId ? doc.nodes.get(bodyId) : undefined;
                const offset = bodyId ? worldOffsetOf(doc, bodyId) : null;
                const body = bodyId ? world.bodies.get(bodyId) : undefined;
                if (template && !template.children.length && !template.spatial3d && target && offset
                    && world.spawns.length + commands.filter(c => c.kind === "spawn").length < 256
                    && !doc.nodes.has(`${template.id}#${world.spawns.length + commands.filter(c => c.kind === "spawn").length}`)) {
                    commands.push({ kind: "spawn", templateId: template.id, x: body?.x ?? target.geometry.x + offset.dx,
                        y: body?.y ?? target.geometry.y + offset.dy, ...(template.entity?.body === "dynamic" ? { body: { vx: 0, vy: 0 } } : {}) });
                }
                break;
            }
        }
    };
    if (world.outcome !== "running") return { commands, sounds };
    if (requests) { for (const request of requests) run(request.rule, request.owner, request.other); return {commands,sounds}; }
    const eventsByOwner = new Map<string, typeof world.events[number][]>();
    for (const event of world.events) {
        const events = eventsByOwner.get(event.nodeId) ?? []; events.push(event); eventsByOwner.set(event.nodeId, events);
    }
    for (const node of doc.nodes.values()) {
        if (world.despawned.has(node.id)) continue;
        for (const rule of node.entity?.rules ?? []) {
            if (interaction) {
                if (node.id === interaction && rule.event === "interact" && controlled) {
                    const origin = position2D(doc, world, controlled), target = position2D(doc, world, node.id);
                    if (origin && target && Math.hypot(origin.x-target.x, origin.y-target.y) <= (rule.range ?? 96)) run(rule, node.id, controlled);
                }
                continue;
            }
            if (rule.event === "start") { if (start) run(rule, node.id, null); continue; }
            for (const event of eventsByOwner.get(node.id) ?? []) {
                if (event.nodeId === node.id && event.kind === rule.event) run(rule, node.id, event.bodyId);
            }
        }

    }
    return { commands, sounds };
}

function position2D(doc: ReadonlyDocument, world: WorldState, id: string) {
    if (world.despawned.has(id)) return undefined;
    const node = doc.nodes.get(id), offset = worldOffsetOf(doc, id), body = world.bodies.get(id);
    return node && offset ? { x: (body?.x ?? node.geometry.x + offset.dx) + node.geometry.width / 2,
        y: (body?.y ?? node.geometry.y + offset.dy) + node.geometry.height / 2, z: 0 } : undefined;
}
export function interactGameplay2D(doc: ReadonlyDocument, world: WorldState, controlled: string | null) {
    if (world.behaviorState?.debug.paused || !controlled || world.outcome !== "running" || world.transitionTo) return { world, sounds: [] as SoundRequest[] };
    const live = applyCells(applySpawns(doc, world), world);
    const target = interactionTarget(live, controlled, id => position2D(live, world, id), 96);
    if (!target) return { world, sounds: [] as SoundRequest[] };
    const result = authoredCommands(live, world, controlled, false, target);
    const graph = advanceBehaviors2D(doc, applyCommands(world, result.commands), controlled, [{owner:target,other:controlled,event:"interact"}]);
    return { world:graph.world, sounds:[...result.sounds,...graph.sounds] };
}

/** Physics, authored commands, compatibility platformer policy, then animation—once per fixed step. */
export function stepGameplay(doc: ReadonlyDocument, previous: WorldState, context: RuleContext) {
    if (previous.behaviorState?.debug.paused) return {world:previous,commands:[],sounds:[]};
    const live = applyCells(applySpawns(doc, previous), previous);
    let world = stepWorld(live, previous, { input: context.input, controlled: context.controlled });
    const authored = authoredCommands(live, world, context.controlled, previous.time === 0);
    const policy = context.controlled ? live.nodes.get(context.controlled)?.entity?.rulePolicy : undefined;
    const commands = [...authored.commands, ...(policy === "authored" ? [] : marioRules(live, world, context))];
    world = animateWorld2D(live, applyCommands(world, commands));
    const events: BehaviorEvent[] = world.events.flatMap(e=>e.kind==="bump"?[]:[{owner:e.nodeId,other:e.bodyId,event:e.kind}]);
    if(previous.time===0) events.unshift(...[...live.nodes.values()].filter(node=>resolveBehavior(live,node.entity)?.enabled).map(node=>({owner:node.id,other:null,event:"start" as const})));
    const graph = advanceBehaviors2D(doc,world,context.controlled,events,undefined,true);
    return {world:graph.world,commands:[...commands,...graph.commands],sounds:[...authored.sounds,...graph.sounds]};
}

/** Resume graph fibers without advancing physics; step mode executes one instruction. */
export function advanceBehaviors2D(doc:ReadonlyDocument,world:WorldState,controlled:string|null,events:readonly BehaviorEvent[]=[],mode?:"step",lifecycle=false) {
    if(world.outcome!=="running"||world.transitionTo) return {world,commands:[] as RuntimeCommand[],sounds:[] as SoundRequest[]};
    const live=applyCells(applySpawns(doc,world),world), nodes=new Map(live.nodes);
    for(const id of world.despawned){const node=nodes.get(id);if(node)nodes.set(id,{...node,hidden:true});}
    const all=applySpawns(doc,{...world,despawned:new Set()});
    const retired=new Map([...world.despawned].flatMap(id=>{const node=all.nodes.get(id),graph=resolveBehavior(all,node?.entity);return node&&!node.hidden&&graph?[[id,graph] as const]:[];}));
    const result=tickBehaviors({doc:{...live,nodes},state:world.behaviorState,time:world.time,events,controlled,
        position:id=>position2D(live,world,id),tallies:world.tallies,profile:"2d",mode,...(lifecycle?{lifecycle:{spawned:world.spawns.map(s=>s.id),retired}}:{})});
    const authored=authoredCommands(live,world,controlled,false,undefined,result.requests);
    return {world:applyCommands({...world,behaviorState:result.state},authored.commands),...authored};
}
