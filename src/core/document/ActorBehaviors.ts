/** @module ActorBehaviors @description Isolated actor behavior dependency snapshots and instance-local node-reference binding. */
import {ReadonlyDocument} from "./Document";
import {actorHierarchyIds,remapActorAction} from "./ActorHierarchy";
import {BehaviorGraph,behaviorGraphError} from "./BehaviorGraph";
import {BehaviorFunction,behaviorFunctionsError} from "./BehaviorFunctions";
import {behaviorAssetsError,resolveBehavior} from "./BehaviorAssets";
import {behaviorDataBindingsError} from "./BehaviorDataBindings";
import {nodeIdError} from "./Node";

/** Kept separate from the project library: function IDs remain stable within this actor's context. */
export interface ActorBehaviors {
    nodeIds:string[];
    graphs:Map<string,BehaviorGraph>;
    functions:BehaviorFunction[];
}
type BehaviorDocument=Pick<ReadonlyDocument,"nodes"|"behaviorAssets"|"behaviorFunctions"|"gameplayVariables">;
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;

/** Capture only functions referenced by the actor's graphs, including transitive nested calls.
 * Disabled graphs and disconnected authored calls still count: enabling/connecting later must
 * not discover that their definitions were silently discarded. No source objects are retained. */
export function captureActorBehaviors(doc:BehaviorDocument,rootId:string):ActorBehaviors {
    const ids=actorHierarchyIds(doc,rootId);
    const variables=clone(doc.gameplayVariables??[]),functions=clone(doc.behaviorFunctions??[]);
    const libraryError=behaviorAssetsError(doc.behaviorAssets)??behaviorFunctionsError(functions,variables);
    if(libraryError)throw new Error(libraryError);
    const graphs=new Map<string,BehaviorGraph>(),pending:string[]=[],needed=new Set<string>();
    for(const id of ids){
        const entity=doc.nodes.get(id)!.entity;
        if(entity?.behavior&&entity.behaviorAssetId)throw new Error("Actor cannot have both inline and shared behavior.");
        const resolved=resolveBehavior(doc,entity);
        if(entity?.behaviorAssetId&&!resolved)throw new Error("Missing actor behavior asset.");
        if(!resolved)continue;
        const graph=clone(resolved);
        const error=behaviorGraphError(graph)??behaviorDataBindingsError(graph,variables,[],functions);
        if(error)throw new Error(error);
        graphs.set(id,graph);
        for(const node of graph.nodes)if(node.kind==="call")pending.push(node.functionId);
    }
    const byId=new Map(functions.map(f=>[f.id,f]));
    while(pending.length){
        const id=pending.pop()!;if(needed.has(id))continue;
        const definition=byId.get(id);if(!definition)throw new Error("Missing actor behavior function.");
        needed.add(id);
        for(const node of definition.nodes)if(node.kind==="call")pending.push(node.functionId);
    }
    // Keep authored library order, independent of traversal order, for stable persistence later.
    return {nodeIds:ids,graphs,functions:functions.filter(f=>needed.has(f.id))};
}

/** Bind snapshots to one copied hierarchy. The result is an actor-local execution context,
 * NOT a replacement project library: two actors may share function IDs but bind different nodes.
 * Placement/save integration must retain that distinction. IDs for functions, graph nodes,
 * variable names and literal values never pass through the scene-node mapping. */
export function bindActorBehaviors(source:ActorBehaviors,ids:ReadonlyMap<string,string>):ActorBehaviors {
    if(ids.size!==source.nodeIds.length||source.nodeIds.some(id=>!ids.has(id)))throw new Error("Every actor node must be mapped exactly once.");
    const nodeIds=source.nodeIds.map(id=>ids.get(id)!);
    if(new Set(nodeIds).size!==nodeIds.length||nodeIds.some(id=>typeof id!=="string"||!id||id.length>4096||/[\u0000-\u001f]/.test(id)||nodeIdError(id)))throw new Error("Actor nodes require distinct valid mapped IDs.");
    const graphs=new Map<string,BehaviorGraph>();
    for(const [owner,graph] of source.graphs){
        const target=ids.get(owner);
        if(!target||graphs.has(target))throw new Error("Actor behavior owners require distinct mapped nodes.");
        const copy=clone(graph);
        graphs.set(target,{...copy,nodes:copy.nodes.map(node=>node.kind==="action"?{...node,action:remapActorAction(node.action,ids)}:node)});
    }
    const functions=clone(source.functions).map(f=>({...f,nodes:f.nodes.map(node=>node.kind==="action"?{...node,action:remapActorAction(node.action,ids)}:node)}));
    return {nodeIds,graphs,functions};
}
