/** @module PlaceActorHierarchyAction @description Atomic independent actor placement with deep hierarchy copies and instance-bound behavior functions. */
import {Action} from "./Action";
import {ReadonlyDocument} from "../document/Document";
import {actorHierarchyIds,copyActorHierarchy} from "../document/ActorHierarchy";
import {captureActorBehaviors,bindActorBehaviors} from "../document/ActorBehaviors";
import {BehaviorFunction} from "../document/BehaviorFunctions";
import {deserializeDocument,serializeDocument} from "../document/Serializer";
import {validateDocumentIntegrity} from "../document/Integrity";
import {IDENTITY_TRANSFORM_3D,Vec3} from "../document/Spatial3D";
import {generateUUID} from "../ids/UUID";
import {applyMutationsToDocument} from "./applyMutations";
import {ActionPayload,MutationResult,NodeDelta,documentDeltaKey} from "./types";

/** The destination is the source's existing parent. Offsets are explicitly in that parent's
 * 2D or 3D units; this action does not silently flatten or reparent transformed hierarchies. */
export class PlaceActorHierarchyAction extends Action {
    private nodeIds:Map<string,string>|null=null;
    private functionIds=new Map<string,string>();
    private error:string|null=null;
    constructor(doc:ReadonlyDocument,private rootId:string,private profile:"2d"|"3d",private offset:Vec3){super(doc);this.offset={...offset};}
    getError(){return this.error;}
    getCreatedRootId(){return this.nodeIds?.get(this.rootId)??null;}
    getCreatedNodeIds(){return [...(this.nodeIds?.values()??[])];}
    private prepare():MutationResult {
        if(!["2d","3d"].includes(this.profile)||[this.offset.x,this.offset.y,this.offset.z].some(v=>!Number.isFinite(v)||Math.abs(v)>10000))throw Error("Actor placement needs finite offsets within ±10000.");
        if(this.profile==="2d"&&this.offset.z!==0)throw Error("2D actor placement cannot apply a Z offset.");
        const owned=actorHierarchyIds(this.document,this.rootId),source=this.document.nodes.get(this.rootId)!;
        if(this.profile==="3d"&&!owned.some(id=>this.document.nodes.get(id)?.spatial3d))throw Error("3D placement needs authored 3D content.");
        this.nodeIds??=new Map(owned.map(id=>[id,generateUUID()]));
        const nodes=copyActorHierarchy(this.document,this.rootId,this.nodeIds,source.parent??null);
        const behaviors=bindActorBehaviors(captureActorBehaviors(this.document,this.rootId),this.nodeIds);
        const occupied=new Set(this.document.behaviorFunctions?.map(f=>f.id));
        for(const fn of behaviors.functions){
            if(!this.functionIds.has(fn.id))this.functionIds.set(fn.id,`actor_${generateUUID().replace(/-/g,"")}`);
            const target=this.functionIds.get(fn.id)!;if(occupied.has(target))throw Error("Actor function identity already exists.");occupied.add(target);
        }
        const functionId=(id:string)=>{const mapped=this.functionIds.get(id);if(!mapped)throw Error("Missing actor function dependency.");return mapped;};
        const functions:BehaviorFunction[]=behaviors.functions.map(fn=>({...fn,id:functionId(fn.id),nodes:fn.nodes.map(n=>n.kind==="call"?{...n,functionId:functionId(n.functionId)}:n)}));
        const deltas=new Map<string,NodeDelta>(),updated=new Set<string>();
        if(functions.length)deltas.set(documentDeltaKey("behaviorFunctions"),{kind:"behaviorFunctions",behaviorFunctions:[...JSON.parse(JSON.stringify(this.document.behaviorFunctions??[])),...functions]});
        for(const node of nodes){
            const graph=behaviors.graphs.get(node.id);
            if(graph){
                node.entity={...node.entity,behavior:{...graph,nodes:graph.nodes.map(n=>n.kind==="call"?{...n,functionId:functionId(n.functionId)}:n)}};
                delete node.entity.behaviorAssetId;
            }
            // Independent copies do not steal player control from the existing authored player.
            if(node.entity?.player)node.entity.player=false;
            if(node.id===this.getCreatedRootId()){
                node.hidden=false;
                if(this.profile==="3d"){
                    node.spatial3d??={transform:JSON.parse(JSON.stringify(IDENTITY_TRANSFORM_3D))};
                    const p=node.spatial3d.transform.position;node.spatial3d.transform.position={x:p.x+this.offset.x,y:p.y+this.offset.y,z:p.z+this.offset.z};
                }else{node.geometry.x+=this.offset.x;node.geometry.y+=this.offset.y;}
            }
            deltas.set(node.id,{kind:"add",node});updated.add(node.id);
        }
        if(source.parent)updated.add(source.parent);
        // Validate the complete proposed document, including library limits and component/asset
        // references, before the live action system sees any delta.
        const staged=deserializeDocument(serializeDocument(this.document));
        applyMutationsToDocument(staged,deltas);validateDocumentIntegrity(staged);
        return {success:true,updatedNodeIds:updated,propertyDeltas:deltas};
    }
    validate():boolean{
        try{this.prepare();this.error=null;return true;}catch(error){this.error=error instanceof Error?error.message:"Actor placement failed.";return false;}
    }
    execute():MutationResult{return this.prepare();}
    serialize():ActionPayload{return {actionId:"PlaceActorHierarchyAction",timestamp:Date.now(),payload:{rootId:this.rootId,profile:this.profile,offset:{...this.offset},nodeIds:[...(this.nodeIds??[])],functionIds:[...this.functionIds]}};}
}
