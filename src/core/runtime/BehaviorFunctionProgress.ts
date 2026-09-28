/** @module BehaviorFunctionProgress @description Bounded plain-data function continuations resolved against validated project definitions and call sites. */
import {BehaviorFunction,FunctionCall,behaviorFunctionsError,functionCallError,FUNCTION_DEPTH_LIMIT} from "../document/BehaviorFunctions";
import {GameplayVariable,GameplayPort,gameplayIdOK,gameplayValueError} from "../document/GameplayData";
import {FunctionExecution,FunctionExecutionFrame,cloneFunctionExecution} from "./BehaviorFunctionExecution";
const fields=(v:any,keys:string[])=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));
export function validateFunctionProgress(value:unknown):asserts value is FunctionExecutionFrame[]{
    if(!Array.isArray(value)||!value.length||value.length>FUNCTION_DEPTH_LIMIT)throw new Error("Invalid saved function depth.");
    const table=(rows:unknown)=>{
        if(!Array.isArray(rows)||rows.length>64)throw new Error("Invalid saved function values.");
        const seen=new Set<string>();for(const row of rows){
            if(!Array.isArray(row)||row.length!==2||!gameplayIdOK(row[0])||seen.has(row[0])||gameplayValueError(row[1]))throw new Error("Invalid or duplicate saved function value.");seen.add(row[0]);
        }
    };
    for(const f of value){
        if(!fields(f,["functionId","callId","cursor","loops","inputs","locals"])||!gameplayIdOK(f.functionId)||!gameplayIdOK(f.callId)||(f.cursor!==null&&!gameplayIdOK(f.cursor))||!Array.isArray(f.loops)||f.loops.length>8)throw new Error("Invalid saved function frame.");
        const loops=new Set<string>();for(const loop of f.loops){if(!fields(loop,["nodeId","remaining"])||!gameplayIdOK(loop.nodeId)||loops.has(loop.nodeId)||!Number.isInteger(loop.remaining)||loop.remaining<1||loop.remaining>100)throw new Error("Invalid saved function repeat.");loops.add(loop.nodeId);}
        table(f.inputs);table(f.locals);
    }
}
export function restoreFunctionProgress(call:FunctionCall,frames:FunctionExecutionFrame[],definitions:readonly BehaviorFunction[],variables:readonly GameplayVariable[]):FunctionExecution{
    validateFunctionProgress(frames);const error=behaviorFunctionsError(definitions,variables);if(error)throw new Error(error);
    const typed=(rows:FunctionExecutionFrame["inputs"],ports:readonly GameplayPort[])=>{
        if(rows.length!==ports.length||ports.some(port=>{const row=rows.find(([id])=>id===port.id);return !row||gameplayValueError(row[1],port.type);}))throw new Error("Saved function values do not match the signature.");
    };
    for(let i=0;i<frames.length;i++){
        const frame=frames[i],definition=definitions.find(f=>f.id===frame.functionId),parent=i?frames[i-1]:undefined;
        const parentDefinition=parent&&definitions.find(f=>f.id===parent.functionId);
        const invocation=parentDefinition?.nodes.find(n=>n.id===parent!.cursor)??(i===0?call:undefined);
        if(!definition||invocation?.kind!=="call"||invocation.id!==frame.callId||invocation.functionId!==frame.functionId||functionCallError(invocation,definitions,variables,parentDefinition))throw new Error("Invalid saved function call site.");
        typed(frame.inputs,definition.inputs);typed(frame.locals,definition.locals);
        if((frame.cursor!==null&&!definition.nodes.some(n=>n.id===frame.cursor))||frame.loops.some(loop=>{const n=definition.nodes.find(n=>n.id===loop.nodeId);return n?.kind!=="repeat"||loop.remaining>n.count;}))throw new Error("Invalid saved function node/repeat reference.");
    }
    return cloneFunctionExecution({definitions,frames});
}
