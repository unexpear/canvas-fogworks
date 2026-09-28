/** @module SetBehaviorFunctionsAction @description Validated reusable function library edits through atomic document history. */
import {Action} from "./Action";
import {ReadonlyDocument} from "../document/Document";
import {BehaviorFunction,behaviorFunctionsError} from "../document/BehaviorFunctions";
import {ActionPayload,MutationResult,documentDeltaKey} from "./types";
import {behaviorDataBindingsError} from "../document/BehaviorDataBindings";
export class SetBehaviorFunctionsAction extends Action {
    constructor(doc:ReadonlyDocument,private functions:BehaviorFunction[]|undefined){super(doc);}
    validate():boolean{return !behaviorFunctionsError(this.functions,this.document.gameplayVariables)&&[...(this.document.behaviorAssets??[]).map(a=>a.graph),...[...this.document.nodes.values()].map(n=>n.entity?.behavior)].every(g=>!behaviorDataBindingsError(g,this.document.gameplayVariables,[],this.functions));}
    execute():MutationResult{
        if(!this.validate())throw new Error("Invalid behavior function library.");
        return {success:true,updatedNodeIds:new Set(),propertyDeltas:new Map([[documentDeltaKey("behaviorFunctions"),{kind:"behaviorFunctions",behaviorFunctions:this.functions}]])};
    }
    serialize():ActionPayload{return {actionId:"SetBehaviorFunctionsAction",payload:{functions:this.functions},timestamp:Date.now()};}
}
