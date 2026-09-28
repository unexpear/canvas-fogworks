/** @module BehaviorFunctionExecution @description One-instruction function stepping with bounded nested frames, loops and explicit scheduled effects. */
import {BehaviorAction} from "../document/BehaviorGraph";
import {BehaviorFunction,FunctionCall,FUNCTION_DEPTH_LIMIT,behaviorFunctionsError} from "../document/BehaviorFunctions";
import {GameplayVariable} from "../document/GameplayData";
import {FunctionFrame,enterFunction,assignFunctionLocal,resolveFunctionSource,returnFunction} from "./BehaviorFunctionFrames";
import {GameplayDataState,assignGameplayValue} from "./GameplayDataState";
export interface FunctionExecutionFrame extends FunctionFrame {callId:string}
export interface FunctionExecution {
    /** Runtime-only definition snapshot; saved continuations must resolve the project library. */
    definitions:readonly BehaviorFunction[];
    frames:FunctionExecutionFrame[];
}
export interface FunctionEffect {
    action?:{target:"self"|"other";action:BehaviorAction};
    signal?:{target:"self"|"other";name:string};
    wait?:number;
}
export interface FunctionStepContext {
    call:FunctionCall;execution:FunctionExecution;data:GameplayDataState;variables:readonly GameplayVariable[];
    owner:string;other:string|null;controlled:string|null;tallies:ReadonlyMap<string,number>;
}
export function startFunctionExecution(call:FunctionCall,definitions:readonly BehaviorFunction[],data:GameplayDataState,variables:readonly GameplayVariable[],owner:string):FunctionExecution{
    const error=behaviorFunctionsError(definitions,variables);if(error)throw new Error(error);
    return {definitions,frames:[{...enterFunction(call,definitions,data,variables,owner),callId:call.id}]};
}
export function cloneFunctionExecution(execution:FunctionExecution):FunctionExecution{
    return {...execution,frames:execution.frames.map(f=>({...f,loops:f.loops.map(loop=>({...loop})),inputs:f.inputs.map(([id,value])=>[id,value]),locals:f.locals.map(([id,value])=>[id,value])}))};
}
/** Resolve loop returns before breakpoint lookup, without executing an instruction. */
export function prepareFunctionExecution(source:FunctionExecution):FunctionExecution{
    const execution=cloneFunctionExecution(source),frames=execution.frames;
    if(!frames.length||frames.length>FUNCTION_DEPTH_LIMIT)throw new Error("Invalid function execution depth.");
    const frame=frames[frames.length-1];
    const definition=execution.definitions.find(f=>f.id===frame.functionId);if(!definition)throw new Error("Missing executing function.");
    const nodes=new Map(definition.nodes.map(n=>[n.id,n]));
    while(frame.cursor===null&&frame.loops.length){
        const loop=frame.loops[frame.loops.length-1],repeat=nodes.get(loop.nodeId);
        if(repeat?.kind!=="repeat")throw new Error("Invalid function repeat frame.");
        if(--loop.remaining>0)frame.cursor=repeat.body;else{frame.loops.pop();frame.cursor=repeat.next;}
    }
    if(frame.cursor===null)throw new Error("Function reached its end without returning outputs.");
    return execution;
}
/** A caller supplies the global instruction budget and simulation clock; no host recursion/timers. */
export function stepFunctionExecution(context:FunctionStepContext):{execution:FunctionExecution;data:GameplayDataState;effect:FunctionEffect;functionId:string;nodeId:string;done:boolean}{
    const {call,owner,variables}=context,execution=prepareFunctionExecution(context.execution),frames=execution.frames;
    let frame=frames[frames.length-1],data=context.data;
    const definition=execution.definitions.find(f=>f.id===frame.functionId)!;
    const nodes=new Map(definition.nodes.map(n=>[n.id,n]));
    const node=nodes.get(frame.cursor!);if(!node)throw new Error("Missing executing function node.");
    const effect:FunctionEffect={},resolve=(source:Parameters<typeof resolveFunctionSource>[0])=>resolveFunctionSource(source,data,variables,owner,{definition,frame});
    if(node.kind==="call"){
        if(frames.length>=FUNCTION_DEPTH_LIMIT)throw new Error("Function call depth exceeds 16.");
        frames.push({...enterFunction(node,execution.definitions,data,variables,owner,{definition,frame}),callId:node.id});
    }else if(node.kind==="return"){
        const parent=frames[frames.length-2],parentDefinition=parent&&execution.definitions.find(f=>f.id===parent.functionId);
        const invocation=parentDefinition?.nodes.find(n=>n.id===frame.callId)??call;
        if(invocation.kind!=="call")throw new Error("Invalid function return call site.");
        const returned=returnFunction(definition,frame,node.id,invocation,execution.definitions,data,variables,owner,parent&&parentDefinition?{definition:parentDefinition,frame:parent}:undefined);
        data=returned.data;frames.pop();
        if(parent){if(!returned.caller)throw new Error("Missing function caller frame.");frames[frames.length-1]={...returned.caller,callId:parent.callId,cursor:invocation.next};}
    }else if(node.kind==="local"){
        frame={...assignFunctionLocal(definition,frame,node.variable,node.operation,resolve(node.value)),callId:frame.callId,cursor:node.next};frames[frames.length-1]=frame;
    }else if(node.kind==="assign"){
        data=assignGameplayValue(data,variables,owner,node.scope,node.variable,node.operation,resolve(node.value));frame.cursor=node.next;
    }else if(node.kind==="compare"){
        const left=resolve(node.left),right=resolve(node.right);
        const pass=node.operator==="equal"?left===right:node.operator==="notEqual"?left!==right:node.operator==="less"?left<right:node.operator==="lessEqual"?left<=right:node.operator==="greater"?left>right:left>=right;
        frame.cursor=pass?node.onTrue:node.onFalse;
    }else if(node.kind==="branch"){
        const pass=node.condition.kind==="player"?context.other!==null&&context.other===context.controlled:(context.tallies.get(node.condition.key)??0)>=node.condition.atLeast;
        frame.cursor=pass?node.onTrue:node.onFalse;
    }else if(node.kind==="delay"){
        effect.wait=node.seconds;frame.cursor=node.next;
    }else if(node.kind==="repeat"){
        if(frame.loops.length>=8)throw new Error("Function repeat nesting exceeds 8.");
        frame.loops.push({nodeId:node.id,remaining:node.count});frame.cursor=node.body;
    }else if(node.kind==="emit"){
        effect.signal={target:node.target,name:node.name};frame.cursor=node.next;
    }else{
        effect.action={target:node.target,action:node.action};frame.cursor=node.next;
    }
    return {execution,data,effect,functionId:definition.id,nodeId:node.id,done:frames.length===0};
}
