/** @module BehaviorGraph @description Versioned graphs with validated delay/repeat nodes, bounded structured execution and typed commands. */
import { GameplayAction, GameplayRule, gameplayRulesError } from "./Gameplay";

import { BehaviorEventKind, isLifecycleEvent, customEventNameError } from "./BehaviorEvents";
import {GameplaySource,GameplayScope,gameplaySourceError,gameplayIdOK} from "./GameplayData";
import type {FunctionCall} from "./BehaviorFunctions";
export type BehaviorAction = Exclude<GameplayAction, { kind: "sound" }>;
export type BehaviorCondition = { kind: "player" } | { kind: "counter"; key: string; atLeast: number };
export type BehaviorNode =
    | FunctionCall
    | { id: string; kind: "event"; event: BehaviorEventKind; name?:string; other: GameplayRule["other"]; range?: number; next: string | null }
    | { id: string; kind: "branch"; condition: BehaviorCondition; onTrue: string | null; onFalse: string | null }
    | { id: string; kind: "action"; target: GameplayRule["target"]; action: BehaviorAction; next: string | null }
    | { id: string; kind: "delay"; seconds: number; next: string | null }
    | {id:string;kind:"assign";scope:GameplayScope;variable:string;operation:"set"|"add"|"subtract"|"multiply"|"divide";value:GameplaySource;next:string|null}
    | {id:string;kind:"compare";left:GameplaySource;right:GameplaySource;operator:"equal"|"notEqual"|"less"|"lessEqual"|"greater"|"greaterEqual";onTrue:string|null;onFalse:string|null}
    | { id:string;kind:"emit";name:string;target:"self"|"other";next:string|null }
    | { id: string; kind: "repeat"; count: number; body: string | null; next: string | null };
export interface BehaviorGraph { version: 1 | 2 | 3 | 4 | 5; enabled: boolean; nodes: readonly BehaviorNode[] }
export const BEHAVIOR_NODE_LIMIT = 64;
export const BEHAVIOR_EVENT_LIMIT = 16;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const only = (v: Record<string, any>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const idOK = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(v);
export function behaviorLinks(node: BehaviorNode): readonly (string | null)[] {
    return node.kind === "branch" || node.kind === "compare" ? [node.onTrue, node.onFalse] : node.kind === "repeat" ? [node.body,node.next] : [node.next];
}
export function behaviorEvents(graph?: BehaviorGraph) {
    return graph?.enabled ? graph.nodes.filter((n): n is Extract<BehaviorNode, { kind: "event" }> => n.kind === "event") : [];
}
export function behaviorGraphError(value: unknown): string | null {
    if (value === undefined) return null;
    if (!record(value) || !only(value,["version","enabled","nodes"]) || ![1,2,3,4,5].includes(value.version) || typeof value.enabled !== "boolean"
        || !Array.isArray(value.nodes) || value.nodes.length > BEHAVIOR_NODE_LIMIT) return "Behavior graph requires version 1–5, enabled and at most 64 nodes.";
    const nodes = new Map<string, BehaviorNode>(); let entries = 0;
    for (const node of value.nodes) {
        if (!record(node) || !idOK(node.id) || nodes.has(node.id)) return "Behavior node IDs must be unique letters/digits/underscores/hyphens (1–64 characters, starting with a letter).";
        if (node.kind === "event") {
            if (++entries > BEHAVIOR_EVENT_LIMIT) return "Behavior graph supports at most 16 event entries.";
            if (!only(node,["id","kind","event","other","range","next","name"])) return "Unknown behavior event field.";
            if(isLifecycleEvent(node.event)) {
                if(value.version<3)return "Lifecycle events require graph v3.";
                if(node.event!=="custom"&&node.other!=="any")return "Lifecycle events have no other actor.";
                if(node.range!==undefined)return "Only interaction events have a lifecycle range.";
                if(node.event==="custom"){const error=customEventNameError(node.name);if(error)return error;}
            }
            if(node.name!==undefined&&node.event!=="custom")return "Only custom events have names.";
            const error = gameplayRulesError([{ event: isLifecycleEvent(node.event) ? "enter" : node.event, other: node.other, range: node.range, target: "self", action: {kind:"checkpoint"} }]);
            if (error) return error;
        } else if (node.kind === "action") {
            if (!only(node,["id","kind","target","action","next"]) || !record(node.action) || node.action.kind === "sound") return "Invalid behavior action; sound nodes are not supported.";
            const error = gameplayRulesError([{event:"interact",other:"any",target:node.target,action:node.action}]);
            if (error) return error;
            const keys = node.action.kind === "spawn" ? ["kind","templateId"] : node.action.kind === "score" ? ["kind","key"]
                : node.action.kind === "velocity" ? ["kind","x","y"] : ["kind"];
            if (!only(node.action,keys)) return "Unknown behavior action field.";
        } else if(node.kind==="call"){
            if(value.version<5||!only(node,["id","kind","functionId","inputs","outputs","next"])||!idOK(node.functionId)||!Array.isArray(node.inputs)||node.inputs.length>64||!Array.isArray(node.outputs)||node.outputs.length>64)return "Invalid graph-v5 function call.";
            for(const input of node.inputs)if(!record(input)||!only(input,["id","value"])||!idOK(input.id)||gameplaySourceError(input.value))return "Invalid function argument source.";
            for(const output of node.outputs)if(!record(output)||!only(output,["id","target"])||!idOK(output.id)||!record(output.target)||!only(output.target,["kind","scope","id"])||output.target.kind!=="variable"||!["entity","game"].includes(output.target.scope)||!idOK(output.target.id))return "Invalid root function output binding.";
        } else if(node.kind==="assign"){
            if(value.version<4||!only(node,["id","kind","scope","variable","operation","value","next"])||!["entity","game"].includes(node.scope)||!gameplayIdOK(node.variable)||!["set","add","subtract","multiply","divide"].includes(node.operation))return "Invalid graph-v4 assignment.";
            const error=gameplaySourceError(node.value);if(error)return error;
        } else if(node.kind==="compare"){
            if(value.version<4||!only(node,["id","kind","left","right","operator","onTrue","onFalse"])||!["equal","notEqual","less","lessEqual","greater","greaterEqual"].includes(node.operator))return "Invalid graph-v4 comparison.";
            const error=gameplaySourceError(node.left)??gameplaySourceError(node.right);if(error)return error;
        } else if (node.kind === "emit") {
            if(value.version<3||!only(node,["id","kind","name","target","next"])||!["self","other"].includes(node.target))return "Custom event emission requires graph v3 and a self/other target.";
            const error=customEventNameError(node.name);if(error)return error;
        } else if (node.kind === "delay") {
            if(value.version<2 || !only(node,["id","kind","seconds","next"]) || !Number.isFinite(node.seconds) || node.seconds<1/60 || node.seconds>3600) return "Delay requires graph v2 or later and 1/60–3600 simulation seconds.";
        } else if (node.kind === "repeat") {
            if(value.version<2 || !only(node,["id","kind","count","body","next"]) || !Number.isSafeInteger(node.count) || node.count<1 || node.count>100) return "Repeat requires graph v2 or later and an integer count of 1–100.";
        } else if (node.kind === "branch") {
            if (!only(node,["id","kind","condition","onTrue","onFalse"]) || !record(node.condition)) return "Invalid behavior branch.";
            const c = node.condition;
            if (c.kind === "player") { if (!only(c,["kind"])) return "Unknown player condition field."; }
            else if (c.kind !== "counter" || !only(c,["kind","key","atLeast"]) || typeof c.key !== "string" || !c.key.trim() || c.key.length > 64
                || !Number.isSafeInteger(c.atLeast) || c.atLeast < 0 || c.atLeast > 1_000_000_000) return "Counter condition requires a key and an integer threshold from 0 to 1000000000.";
        } else return "Unknown behavior node kind.";
        nodes.set(node.id,node as BehaviorNode);
    }
    for (const node of nodes.values()) for (const link of behaviorLinks(node)) {
        if (link === null) continue;
        if (!idOK(link) || !nodes.has(link)) return `Behavior link from ${node.id} has a missing destination.`;
        if (nodes.get(link)!.kind === "event") return "Behavior links cannot enter event nodes.";
    }
    const active = new Set<string>(), done = new Set<string>();
    const visit = (id: string): boolean => {
        if (active.has(id)) return false; if (done.has(id)) return true;
        active.add(id);
        for (const link of behaviorLinks(nodes.get(id)!)) if (link !== null && !visit(link)) return false;
        active.delete(id); done.add(id); return true;
    };
    for (const id of nodes.keys()) if (!visit(id)) return "Behavior graphs cannot contain cycles. End the path or start a new event.";
    return null;
}
/** A small editable example: interact increments uses, then checkpoints until the third use wins. */
export function starterBehaviorGraph(): BehaviorGraph {
    return { version:1, enabled:true, nodes:[
        {id:"interact",kind:"event",event:"interact",other:"player",next:"count"},
        {id:"count",kind:"action",target:"self",action:{kind:"score",key:"uses"},next:"check"},
        {id:"check",kind:"branch",condition:{kind:"counter",key:"uses",atLeast:3},onTrue:"win",onFalse:"checkpoint"},
        {id:"win",kind:"action",target:"self",action:{kind:"win"},next:null},
        {id:"checkpoint",kind:"action",target:"self",action:{kind:"checkpoint"},next:null}
    ] };
}
