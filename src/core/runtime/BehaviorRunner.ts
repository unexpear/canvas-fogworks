/** @module BehaviorRunner @description Pure bounded graph evaluation into existing gameplay requests; no host APIs, timers or authored mutation. */
import { BehaviorGraph, behaviorEvents, behaviorGraphError } from "../document/BehaviorGraph";
import { GameplayRule } from "../document/Gameplay";
export interface BehaviorContext {
    event: GameplayRule["event"];
    otherIsPlayer: boolean;
    distance?: number;
    defaultRange: number;
    tallies: ReadonlyMap<string, number>;
    /** The 3D host caps counter keys at 256; the existing 2D host does not. */
    counterKeyLimit?: number;
}
export interface BehaviorResult { rules: GameplayRule[]; visited: string[]; error: string | null }
export function evaluateBehavior(graph: BehaviorGraph | undefined, context: BehaviorContext): BehaviorResult {
    const result: BehaviorResult = {rules:[],visited:[],error:null};
    if (!graph) return result;
    const error = behaviorGraphError(graph); if (error) return {...result,error};
    if (!graph.enabled) return result;
    if(graph.nodes.some(n=>n.kind==="delay"||n.kind==="repeat"||n.kind==="emit"||n.kind==="assign"||n.kind==="compare"||n.kind==="call"))return {...result,error:"Timed/repeated/custom-send graphs require the resumable BehaviorRuntime scheduler."};
    const nodes = new Map(graph.nodes.map(n => [n.id,n])), tallies = new Map(context.tallies);
    let remaining = 1024;
    for (const entry of behaviorEvents(graph)) {
        if (entry.event !== context.event || (entry.other === "player" && !context.otherIsPlayer)) continue;
        if (entry.event === "interact" && (!(context.distance! >= 0) || context.distance! > (entry.range ?? context.defaultRange))) continue;
        let id = entry.next; result.visited.push(entry.id);
        while (id !== null) {
            if (--remaining < 0) return {rules:[],visited:result.visited,error:"Behavior execution limit exceeded."};
            const node = nodes.get(id)!; result.visited.push(id);
            if (node.kind === "branch") {
                const pass = node.condition.kind === "player" ? context.otherIsPlayer : (tallies.get(node.condition.key) ?? 0) >= node.condition.atLeast;
                id = pass ? node.onTrue : node.onFalse;
            } else if (node.kind === "action") {
                result.rules.push({event:entry.event,other:"any",target:node.target,range:entry.range,action:node.action});
                // Later branches observe earlier score requests in this dispatch, using the 3D tally bounds.
                if (node.action.kind === "score" && (tallies.has(node.action.key) || tallies.size < (context.counterKeyLimit ?? Infinity))) {
                    tallies.set(node.action.key,Math.min(1_000_000_000,(tallies.get(node.action.key) ?? 0)+1));
                }
                id = node.next;
            } else return {rules:[],visited:result.visited,error:"Behavior execution reached an event node."};
        }
    }
    return result;
}
