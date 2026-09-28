/** @module BehaviorFunctionFrames @description Immutable per-invocation inputs/locals and atomic typed output adoption for scheduled graph functions. */
import {BehaviorFunction,FunctionCall,FunctionSource,functionCallError,functionSourceType,functionTargetType} from "../document/BehaviorFunctions";
import {GameplayValue,GameplayVariable,gameplayValueError} from "../document/GameplayData";
import {GameplayDataState,GameplayOperation,gameplayArithmetic,resolveGameplaySource,writeGameplayValue} from "./GameplayDataState";

/** Plain scalar tuples are intentionally serializable; frames never hold executable definitions. */
export interface FunctionFrame {
    functionId:string;cursor:string|null;loops:{nodeId:string;remaining:number}[];
    inputs:[string,GameplayValue][];locals:[string,GameplayValue][];
}
export function resolveFunctionSource(source:FunctionSource,data:GameplayDataState,variables:readonly GameplayVariable[],owner:string,context?:{definition:BehaviorFunction;frame:FunctionFrame}):GameplayValue{
    if(context&&context.definition.id!==context.frame.functionId)throw new Error("Function source frame does not match its definition.");
    const type=functionSourceType(source,variables,context?.definition);
    const value=source.kind==="local"?context?.frame.locals.find(([id])=>id===source.id)?.[1]
        :resolveGameplaySource(source,data,variables,owner,new Map(context?.frame.inputs));
    const error=gameplayValueError(value,type);if(error)throw new Error(error);return value as GameplayValue;
}
export function enterFunction(call:FunctionCall,functions:readonly BehaviorFunction[],data:GameplayDataState,variables:readonly GameplayVariable[],owner:string,caller?:{definition:BehaviorFunction;frame:FunctionFrame}):FunctionFrame{
    const error=functionCallError(call,functions,variables,caller?.definition);if(error)throw new Error(error);
    const definition=functions.find(f=>f.id===call.functionId)!;
    const inputs=definition.inputs.map(port=>[port.id,resolveFunctionSource(call.inputs.find(a=>a.id===port.id)!.value,data,variables,owner,caller)] as [string,GameplayValue]);
    return {functionId:definition.id,cursor:definition.entry,loops:[],inputs,
        locals:definition.locals.map(port=>[port.id,port.type==="number"?0:port.type==="boolean"?false:""])};
}
export function assignFunctionLocal(definition:BehaviorFunction,frame:FunctionFrame,id:string,operation:GameplayOperation,value:GameplayValue):FunctionFrame{
    if(definition.id!==frame.functionId)throw new Error("Function local frame does not match its definition.");
    const port=definition.locals.find(p=>p.id===id),current=frame.locals.find(([key])=>key===id);
    if(!port||!current)throw new Error("Missing function local.");
    const next=operation==="set"?value:gameplayArithmetic(current[1],operation,value),error=gameplayValueError(next,port.type);if(error)throw new Error(error);
    return {...frame,locals:frame.locals.map(([key,old])=>[key,key===id?next:old])};
}
/** Evaluate every return first, then stage every write. Failed returns adopt no partial output. */
export function returnFunction(definition:BehaviorFunction,frame:FunctionFrame,returnNodeId:string,call:FunctionCall,functions:readonly BehaviorFunction[],data:GameplayDataState,variables:readonly GameplayVariable[],owner:string,caller?:{definition:BehaviorFunction;frame:FunctionFrame}):{data:GameplayDataState;caller?:FunctionFrame}{
    const error=functionCallError(call,functions,variables,caller?.definition);if(error)throw new Error(error);
    if(call.functionId!==definition.id||frame.functionId!==definition.id)throw new Error("Function return frame does not match its call.");
    const node=definition.nodes.find(n=>n.id===returnNodeId);if(node?.kind!=="return")throw new Error("Missing function return node.");
    const values=definition.outputs.map(port=>{
        const source=node.values.find(v=>v.id===port.id);if(!source)throw new Error("Missing function return value.");
        const value=resolveFunctionSource(source.value,data,variables,owner,{definition,frame}),invalid=gameplayValueError(value,port.type);if(invalid)throw new Error(invalid);
        return {id:port.id,value};
    });
    let stagedData=data,stagedCaller=caller?.frame;
    for(const output of values){
        const target=call.outputs.find(b=>b.id===output.id)!.target;
        const type=functionTargetType(target,variables,caller?.definition),invalid=gameplayValueError(output.value,type);if(invalid)throw new Error(invalid);
        if(target.kind==="local"){
            if(!caller||!stagedCaller)throw new Error("Function output needs a caller local frame.");
            stagedCaller=assignFunctionLocal(caller.definition,stagedCaller,target.id,"set",output.value);
        }else stagedData=writeGameplayValue(stagedData,variables,owner,target.scope,target.id,output.value);
    }
    return {data:stagedData,...(stagedCaller?{caller:stagedCaller}:{})};
}
