/** @module BehaviorFunctions @description Typed reusable function contracts, local value bindings and acyclic bounded call-graph validation. */
import {BehaviorGraph,BehaviorNode,behaviorGraphError} from "./BehaviorGraph";
import {GameplayPort,GameplaySource,GameplayType,GameplayVariable,gameplayIdOK,gameplayPortsError,gameplaySourceError,gameplaySourceType} from "./GameplayData";

export type FunctionSource=GameplaySource|{kind:"local";id:string};
export type FunctionTarget={kind:"local";id:string}|{kind:"variable";scope:"entity"|"game";id:string};
export interface FunctionArgument {id:string;value:FunctionSource}
export interface FunctionBinding {id:string;target:FunctionTarget}
export interface FunctionCall {id:string;kind:"call";functionId:string;inputs:readonly FunctionArgument[];outputs:readonly FunctionBinding[];next:string|null}
export type FunctionNode=Exclude<BehaviorNode,{kind:"event"|"assign"|"compare"|"call"}>
    | (Omit<Extract<BehaviorNode,{kind:"assign"}>,"value">&{value:FunctionSource})
    | (Omit<Extract<BehaviorNode,{kind:"compare"}>,"left"|"right">&{left:FunctionSource;right:FunctionSource})
    | {id:string;kind:"local";variable:string;operation:"set"|"add"|"subtract"|"multiply"|"divide";value:FunctionSource;next:string|null}
    | FunctionCall
    | {id:string;kind:"return";values:readonly FunctionArgument[]};
export interface BehaviorFunction {
    id:string;name:string;inputs:readonly GameplayPort[];outputs:readonly GameplayPort[];
    /** Per-invocation values start at their scalar zero (0, false or empty string). */
    locals:readonly GameplayPort[];entry:string;nodes:readonly FunctionNode[];
}
export const FUNCTION_LIMIT=128;
export const FUNCTION_DEPTH_LIMIT=16;
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));
export function functionSourceError(source:unknown):string|null{
    if(record(source)&&source.kind==="local")return exact(source,["kind","id"])&&gameplayIdOK(source.id)?null:"Invalid function local source.";
    return gameplaySourceError(source);
}
export function functionSourceType(source:FunctionSource,variables:readonly GameplayVariable[],context?:Pick<BehaviorFunction,"inputs"|"locals">):GameplayType{
    const error=functionSourceError(source);if(error)throw new Error(error);
    if(source.kind!=="local")return gameplaySourceType(source,variables,context?.inputs);
    const local=context?.locals.find(p=>p.id===source.id);if(!local)throw new Error("Missing function local.");return local.type;
}
export function functionTargetType(target:FunctionTarget,variables:readonly GameplayVariable[],context?:Pick<BehaviorFunction,"locals">):GameplayType{
    if(!record(target)||!gameplayIdOK(target.id))throw new Error("Invalid function output target.");
    if(target.kind==="local"&&exact(target,["kind","id"])){
        const local=context?.locals.find(p=>p.id===target.id);if(local)return local.type;
    }else if(target.kind==="variable"&&exact(target,["kind","scope","id"])&&["entity","game"].includes(target.scope)){
        const variable=variables.find(v=>v.scope===target.scope&&v.id===target.id);if(variable)return variable.type;
    }
    throw new Error("Missing or invalid function output target.");
}
function argumentsError(values:unknown,ports:readonly GameplayPort[],variables:readonly GameplayVariable[],context?:Pick<BehaviorFunction,"inputs"|"locals">):string|null{
    if(!Array.isArray(values)||values.length!==ports.length)return "Function arguments must exactly match the signature.";
    const seen=new Set<string>();
    for(const value of values){
        if(!exact(value,["id","value"])||!gameplayIdOK(value.id)||seen.has(value.id))return "Invalid or duplicate function argument.";
        seen.add(value.id);const port=ports.find(p=>p.id===value.id);
        if(!port||functionSourceType(value.value,variables,context)!==port.type)return "Function argument type mismatch.";
    }return null;
}
/** Also used by root graph calls, which have no input or local frame. */
export function functionCallError(call:FunctionCall,functions:readonly BehaviorFunction[],variables:readonly GameplayVariable[],context?:BehaviorFunction):string|null{
    try{
        if(!exact(call,["id","kind","functionId","inputs","outputs","next"])||call.kind!=="call"||!gameplayIdOK(call.id)||!gameplayIdOK(call.functionId)||(call.next!==null&&!gameplayIdOK(call.next)))return "Invalid function call node.";
        const definition=functions.find(f=>f.id===call.functionId);if(!definition)return "Missing called function.";
        const error=argumentsError(call.inputs,definition.inputs,variables,context);if(error)return error;
        if(!Array.isArray(call.outputs)||call.outputs.length!==definition.outputs.length)return "Function output bindings must exactly match the signature.";
        const seen=new Set<string>(),targets=new Set<string>();
        for(const binding of call.outputs){
            if(!exact(binding,["id","target"])||!gameplayIdOK(binding.id)||seen.has(binding.id))return "Invalid or duplicate function output binding.";
            const port=definition.outputs.find(p=>p.id===binding.id),type=functionTargetType(binding.target,variables,context);
            if(!port||port.type!==type)return "Function output type mismatch.";
            const target=binding.target,key=target.kind==="local"?"local/"+target.id:target.scope+"/"+target.id;
            if(targets.has(key))return "Function outputs cannot overwrite the same target.";
            targets.add(key);seen.add(binding.id);
        }return null;
    }catch(error){return error instanceof Error?error.message:"Invalid function call.";}
}
export function behaviorFunctionsError(value:unknown,variables:readonly GameplayVariable[]=[]):string|null{
    if(value===undefined)return null;
    if(!Array.isArray(value)||value.length>FUNCTION_LIMIT)return "At most 128 behavior functions are allowed.";
    const ids=new Set<string>();
    // Validate every signature before resolving calls, including forward references.
    for(const f of value){
        if(!exact(f,["id","name","inputs","outputs","locals","entry","nodes"])||!gameplayIdOK(f.id)||ids.has(f.id)||typeof f.name!=="string"||!f.name.trim()||f.name.length>128||!gameplayIdOK(f.entry)||!Array.isArray(f.nodes)||!f.nodes.length||f.nodes.length>64)return "Invalid or duplicate behavior function.";
        const error=gameplayPortsError(f.inputs)??gameplayPortsError(f.outputs)??gameplayPortsError(f.locals);if(error)return error;
        ids.add(f.id);
    }
    const functions=value as BehaviorFunction[];
    try{
        for(const f of functions){
            const projected:BehaviorNode[]=[];
            const source=(v:FunctionSource):GameplaySource=>{
                const error=functionSourceError(v);if(error)throw new Error(error);
                return v.kind==="local"?{kind:"input",id:v.id}:v;
            };
            for(const node of f.nodes){
                if(!record(node)||!gameplayIdOK(node.id))return "Invalid function node.";
                if(node.kind==="call"){
                    const error=functionCallError(node,functions,variables,f);if(error)return `${f.id}: ${error}`;
                    projected.push({id:node.id,kind:"action",target:"self",action:{kind:"checkpoint"},next:node.next});
                }else if(node.kind==="return"){
                    if(!exact(node,["id","kind","values"]))return "Invalid function return node.";
                    const error=argumentsError(node.values,f.outputs,variables,f);if(error)return `${f.id}: ${error}`;
                    projected.push({id:node.id,kind:"action",target:"self",action:{kind:"checkpoint"},next:null});
                }else if(node.kind==="local"||node.kind==="assign"){
                    if(node.kind==="local"&&!exact(node,["id","kind","variable","operation","value","next"]))return "Invalid function local assignment.";
                    const type=node.kind==="local"?f.locals.find(p=>p.id===node.variable)?.type:variables.find(v=>v.scope===node.scope&&v.id===node.variable)?.type;
                    if(!type||type!==functionSourceType(node.value,variables,f))return "Function assignment type mismatch.";
                    if(node.operation!=="set"&&type!=="number")return "Function arithmetic requires numbers.";
                    projected.push(node.kind==="assign"?{...node,value:source(node.value)}:{id:node.id,kind:"assign",scope:"entity",variable:node.variable,operation:node.operation,value:source(node.value),next:node.next});
                }else if(node.kind==="compare"){
                    const left=functionSourceType(node.left,variables,f),right=functionSourceType(node.right,variables,f);
                    if(left!==right||(!["equal","notEqual"].includes(node.operator)&&left!=="number"))return "Function comparison type mismatch.";
                    projected.push({...node,left:source(node.left),right:source(node.right)});
                }else{
                    if((node as {kind:string}).kind==="event")return "Function bodies cannot contain event entries.";
                    projected.push(node);
                }
            }
            // Reuse the ordinary node/edge/cycle validator. Call/local/return projections are
            // validation-only flow equivalents; they are never executed or serialized.
            const graph:BehaviorGraph={version:4,enabled:true,nodes:projected},error=behaviorGraphError(graph);
            if(error)return `${f.id}: ${error}`;
            if(!f.nodes.some(n=>n.id===f.entry))return "Missing function entry.";
            if(!f.nodes.some(n=>n.kind==="return"))return "Function requires an explicit return.";
        }
        const active=new Set<string>(),depths=new Map<string,number>();
        const visit=(id:string):number=>{
            if(active.has(id))throw new Error("Recursive function calls are not allowed.");
            const known=depths.get(id);if(known!==undefined)return known;
            active.add(id);let depth=1;
            for(const node of functions.find(f=>f.id===id)!.nodes)if(node.kind==="call")depth=Math.max(depth,1+visit(node.functionId));
            active.delete(id);if(depth>FUNCTION_DEPTH_LIMIT)throw new Error("Function call depth exceeds 16.");depths.set(id,depth);return depth;
        };
        for(const f of functions)visit(f.id);
        return null;
    }catch(error){return error instanceof Error?error.message:"Invalid behavior functions.";}
}
