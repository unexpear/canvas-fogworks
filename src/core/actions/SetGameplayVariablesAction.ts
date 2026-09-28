/** @module SetGameplayVariablesAction @description Validated whole-table gameplay declarations through document history. */
import {Action} from "./Action";
import {ReadonlyDocument} from "../document/Document";
import {GameplayVariable,gameplayVariablesError} from "../document/GameplayData";
import {ActionPayload,MutationResult,documentDeltaKey} from "./types";
import {behaviorDataBindingsError} from "../document/BehaviorDataBindings";
import {behaviorFunctionsError} from "../document/BehaviorFunctions";
export class SetGameplayVariablesAction extends Action {
    constructor(doc:ReadonlyDocument,private variables:GameplayVariable[]|undefined){super(doc);}
    validate():boolean{
        return gameplayVariablesError(this.variables)===null&&!behaviorFunctionsError(this.document.behaviorFunctions,this.variables)&&[...(this.document.behaviorAssets??[]).map(a=>a.graph),...[...this.document.nodes.values()].map(n=>n.entity?.behavior)].every(g=>!behaviorDataBindingsError(g,this.variables,[],this.document.behaviorFunctions));
    }
    execute():MutationResult{
        if(!this.validate())throw new Error("Invalid gameplay variable declarations.");
        return {success:true,updatedNodeIds:new Set(),propertyDeltas:new Map([[documentDeltaKey("gameplayVariables"),{kind:"gameplayVariables",gameplayVariables:this.variables}]])};
    }
    serialize():ActionPayload{return {actionId:"SetGameplayVariablesAction",payload:{variables:this.variables},timestamp:Date.now()};}
}
