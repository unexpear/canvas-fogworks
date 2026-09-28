/** @module BehaviorAssets @description Named in-project reusable graphs, reference validation and shared entity graph resolution. */
import { BehaviorGraph, behaviorGraphError } from "./BehaviorGraph";
import type { ReadonlyDocument } from "./Document";
import type { Entity } from "./Entity";
export interface BehaviorAsset { id:string; name:string; graph:BehaviorGraph }
export function behaviorAssetsError(value:unknown):string|null {
    if(value===undefined)return null;
    if(!Array.isArray(value)||value.length>128)return "Behavior assets must be an array of at most 128 entries.";
    const ids=new Set<string>();
    for(const a of value){
        if(!a||typeof a!=="object"||Array.isArray(a)||Object.keys(a).some(k=>!["id","name","graph"].includes(k))
            ||typeof a.id!=="string"||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(a.id)||ids.has(a.id)
            ||typeof a.name!=="string"||!a.name.trim()||a.name.length>128||!a.graph)return "Invalid or duplicate behavior asset.";
        const error=behaviorGraphError(a.graph);if(error)return `${a.id}: ${error}`;ids.add(a.id);
    }return null;
}
export function resolveBehavior(doc:Pick<ReadonlyDocument,"behaviorAssets">,entity?:Entity):BehaviorGraph|undefined {
    return entity?.behaviorAssetId ? doc.behaviorAssets?.find(a=>a.id===entity.behaviorAssetId)?.graph : entity?.behavior;
}
