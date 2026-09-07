/**
 * @module GameplaySession
 * @description Shared fixed-step gameplay execution for editor and exported games, with transient commands and audio requests.
 */
import { ReadonlyDocument } from "../document/Document";
import { GameplayRule } from "../document/Gameplay";
import { applyCells, applySpawns, applyCommands, stepWorld, WorldState, RuntimeCommand } from "./World";
import { marioRules, RuleContext } from "./Rules";
import { animateWorld2D } from "./AnimationWorld";

export interface SoundRequest { source: string; volume: number; }
export function authoredCommands(doc: ReadonlyDocument, world: WorldState, controlled: string | null, start: boolean) {
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
        }
    };
    if (world.outcome !== "running") return { commands, sounds };
    const eventsByOwner = new Map<string, typeof world.events[number][]>();
    for (const event of world.events) {
        const events = eventsByOwner.get(event.nodeId) ?? []; events.push(event); eventsByOwner.set(event.nodeId, events);
    }
    for (const node of doc.nodes.values()) {
        for (const rule of node.entity?.rules ?? []) {
            if (rule.event === "start") { if (start) run(rule, node.id, null); continue; }
            for (const event of eventsByOwner.get(node.id) ?? []) {
                if (event.nodeId === node.id && event.kind === rule.event) run(rule, node.id, event.bodyId);
            }
        }
    }
    return { commands, sounds };
}

/** Physics, authored commands, compatibility platformer policy, then animation—once per fixed step. */
export function stepGameplay(doc: ReadonlyDocument, previous: WorldState, context: RuleContext) {
    const live = applyCells(applySpawns(doc, previous), previous);
    let world = stepWorld(live, previous, { input: context.input, controlled: context.controlled });
    const authored = authoredCommands(live, world, context.controlled, previous.time === 0);
    const policy = context.controlled ? live.nodes.get(context.controlled)?.entity?.rulePolicy : undefined;
    const commands = [...authored.commands, ...(policy === "authored" ? [] : marioRules(live, world, context))];
    world = animateWorld2D(live, applyCommands(world, commands));
    return { world, commands, sounds: authored.sounds };
}
