/** @module BehaviorDataBindings @description Static gameplay variable/source type checking against a graph's declaration context. */
import type {BehaviorGraph} from "./BehaviorGraph";
import {GameplayVariable,GameplayPort,gameplaySourceType} from "./GameplayData";
import {BehaviorFunction,functionCallError} from "./BehaviorFunctions";
export function behaviorDataBindingsError(graph:BehaviorGraph|undefined,variables:readonly GameplayVariable[]=[],inputs:readonly GameplayPort[]=[],functions:readonly BehaviorFunction[]=[]):string|null{
    if(!graph)return null;
    try{
        for(const node of graph.nodes){
            if(node.kind==="call"){
                const error=functionCallError(node,functions,variables);if(error)return error;
            }else if(node.kind==="assign"){
                const variable=variables.find(v=>v.id===node.variable&&v.scope===node.scope);
                if(!variable)throw new Error("Assignment names an undeclared gameplay variable.");
                const type=gameplaySourceType(node.value,variables,inputs);
                if(type!==variable.type)throw new Error("Gameplay assignment type mismatch.");
                if(node.operation!=="set"&&type!=="number")throw new Error("Gameplay arithmetic requires numbers.");
            }else if(node.kind==="compare"){
                const left=gameplaySourceType(node.left,variables,inputs),right=gameplaySourceType(node.right,variables,inputs);
                if(left!==right)throw new Error("Gameplay comparisons require matching types.");
                if(!["equal","notEqual"].includes(node.operator)&&left!=="number")throw new Error("Ordered comparisons require numbers.");
            }
        }return null;
    }catch(error){return error instanceof Error?error.message:"Invalid gameplay data binding.";}
}
