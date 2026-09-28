/** @module ActorHierarchy @description Bounded actor hierarchy copying with explicit internal node-reference remapping and isolated authored values. */
import {ReadonlyDocument} from "./Document";
import {Node,nodeIdError} from "./Node";
import {GameplayAction} from "./Gameplay";
export const ACTOR_NODE_LIMIT=256;
const validId=(id:unknown):id is string=>typeof id==="string"&&id.length>0&&id.length<=4096&&!/[\u0000-\u001f]/.test(id)&&!nodeIdError(id);
/** Includes owned children only: referenced component masters and shared assets remain dependencies. */
export function actorHierarchyIds(doc:Pick<ReadonlyDocument,"nodes">,rootId:string):string[]{
    const result:string[]=[],seen=new Set<string>(),pending:[string,string|null][]=[[rootId,null]];
    while(pending.length){
        const [id,parent]=pending.pop()!,node=doc.nodes.get(id);
        if(!validId(id)||!node||node.id!==id)throw new Error("Actor hierarchy has a missing or invalid node.");
        if(seen.has(id))throw new Error("Actor hierarchy contains a cycle or shared child.");
        if(parent!==null&&node.parent!==parent)throw new Error("Actor child/parent links disagree.");
        if(result.length>=ACTOR_NODE_LIMIT)throw new Error("Actor hierarchy exceeds 256 nodes.");
        seen.add(id);result.push(id);
        if(!Array.isArray(node.children))throw new Error("Actor children must be an array.");
        for(let i=node.children.length-1;i>=0;i--)pending.push([node.children[i],id]);
    }
    return result;
}
/** Only spawn names a node. Counter keys, function IDs and level paths are different namespaces. */
export function remapActorAction<T extends GameplayAction>(action:T,ids:ReadonlyMap<string,string>):T{
    return action.kind==="spawn"?{...action,templateId:ids.get(action.templateId)??action.templateId}:action;
}
function remapPath(path:string,ids:ReadonlyMap<string,string>):string{
    return path.split("::").map(id=>ids.get(id)??id).join("::");
}
/** Pure copy; placement/transform conversion belongs to the placement Action, not this helper. */
export function copyActorHierarchy(doc:Pick<ReadonlyDocument,"nodes">,rootId:string,ids:ReadonlyMap<string,string>,parentId:string|null=null):Node[]{
    const order=actorHierarchyIds(doc,rootId),targets=new Set<string>();
    if(ids.size!==order.length||order.some(id=>!ids.has(id)))throw new Error("Actor ID mapping must exactly cover the hierarchy.");
    if(parentId!==null&&(!validId(parentId)||!doc.nodes.has(parentId)))throw new Error("Missing actor destination parent.");
    for(const id of order){
        const target=ids.get(id);
        if(!validId(target)||targets.has(target)||doc.nodes.has(target))throw new Error("Actor copy IDs must be valid, unique and unused.");targets.add(target);
    }
    const reference=(id:string)=>ids.get(id)??id;
    return order.map(id=>{
        // Authored Node data is JSON-shaped. Copy all nested state/animation/raster/material data,
        // not only geometry/style, so no later instance edit can mutate its source template.
        const copy=JSON.parse(JSON.stringify(doc.nodes.get(id))) as Node;
        copy.id=ids.get(id)!;copy.parent=id===rootId?parentId:ids.get(copy.parent!)!;
        copy.children=copy.children.map(reference);
        if(copy.componentId!==undefined)copy.componentId=reference(copy.componentId);
        if(copy.overrides){
            const entries=Object.entries(copy.overrides).map(([key,value])=>[remapPath(key,ids),value] as const);
            if(new Set(entries.map(([key])=>key)).size!==entries.length)throw new Error("Actor reference remapping would collide with an override path.");
            copy.overrides=Object.fromEntries(entries);
        }
        if(copy.interactions)copy.interactions=copy.interactions.map(i=>i.target===undefined?i:{...i,target:remapPath(i.target,ids)});
        if(copy.animation?.driver!==undefined)copy.animation.driver=reference(copy.animation.driver);
        if(copy.entity){
            if(copy.entity.respawnAt!==undefined)copy.entity.respawnAt=reference(copy.entity.respawnAt);
            if(copy.entity.warpsTo!==undefined)copy.entity.warpsTo=reference(copy.entity.warpsTo);
            if(copy.entity.rules)copy.entity.rules=copy.entity.rules.map(r=>({...r,action:remapActorAction(r.action,ids)}));
            if(copy.entity.behavior)copy.entity.behavior={...copy.entity.behavior,nodes:copy.entity.behavior.nodes.map(n=>n.kind==="action"?{...n,action:remapActorAction(n.action,ids)}:n)};
        }
        // The compatibility runtime reads this one documented legacy node-reference property.
        const warp=copy.userData?.["vde.warpsTo"];
        if(warp&&typeof warp.value==="string")copy.userData!["vde.warpsTo"]={...warp,value:reference(warp.value)};
        return copy;
    });
}
