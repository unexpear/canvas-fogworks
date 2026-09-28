/** @module SetBehaviorAssetsAction @description Atomic reusable-graph table edits and optional entity binding through validated document history. */
import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { BehaviorAsset, behaviorAssetsError } from "../document/BehaviorAssets";
import { Entity, entityError } from "../document/Entity";
import { ActionPayload, documentDeltaKey, MutationResult, NodeDelta } from "./types";
import {behaviorDataBindingsError} from "../document/BehaviorDataBindings";
export class SetBehaviorAssetsAction extends Action {
    constructor(doc:ReadonlyDocument,private assets:BehaviorAsset[]|undefined,private binding?:{nodeId:string;entity:Entity}){super(doc);}
    validate():boolean {
        if(behaviorAssetsError(this.assets)|| (this.binding&&(!this.document.nodes.has(this.binding.nodeId)||entityError(this.binding.entity))))return false;
        if(this.assets?.some(a=>behaviorDataBindingsError(a.graph,this.document.gameplayVariables,[],this.document.behaviorFunctions))||behaviorDataBindingsError(this.binding?.entity.behavior,this.document.gameplayVariables,[],this.document.behaviorFunctions))return false;
        const ids=new Set(this.assets?.map(a=>a.id));
        for(const node of this.document.nodes.values()){
            const entity=node.id===this.binding?.nodeId?this.binding.entity:node.entity;
            if(entity?.behaviorAssetId&&!ids.has(entity.behaviorAssetId))return false;
        }return true;
    }
    execute():MutationResult{
        if(!this.validate())throw new Error("Invalid behavior assets or referenced asset removal.");
        const deltas=new Map<string,NodeDelta>([[documentDeltaKey("behaviorAssets"),{kind:"behaviorAssets",behaviorAssets:this.assets}]]);
        if(this.binding)deltas.set(this.binding.nodeId,{kind:"patch",entity:this.binding.entity});
        return {success:true,propertyDeltas:deltas,updatedNodeIds:new Set(this.binding?[this.binding.nodeId]:[])};
    }
    serialize():ActionPayload{return {actionId:"SetBehaviorAssetsAction",payload:{assets:this.assets,binding:this.binding},timestamp:Date.now()};}
}
