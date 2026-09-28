/** @module BehaviorRuntime @description Simulation-time graph fibers, bounded structured repeats, reusable asset resolution and opt-in breakpoint/step traces. */
import { BehaviorGraph, behaviorEvents, behaviorGraphError } from "../document/BehaviorGraph";
import { resolveBehavior } from "../document/BehaviorAssets";
import type { ReadonlyDocument } from "../document/Document";
import type { GameplayRule } from "../document/Gameplay";
import { dropHidden } from "../document/Components";
import type { Position } from "./Interaction";
import type { BehaviorEventKind } from "../document/BehaviorEvents";
import {GameplayDataState,emptyGameplayData,assignGameplayValue,resolveGameplaySource} from "./GameplayDataState";
import {behaviorDataBindingsError} from "../document/BehaviorDataBindings";
import {FunctionExecution,startFunctionExecution,stepFunctionExecution,prepareFunctionExecution} from "./BehaviorFunctionExecution";
export interface BehaviorEvent {owner:string;other:string|null;event:BehaviorEventKind;name?:string;signalDepth?:number}
export interface LoopFrame {nodeId:string;remaining:number}
export interface BehaviorJob extends BehaviorEvent {
    graph:BehaviorGraph; cursor:string|null; stack:LoopFrame[]; due:number; steps:number; execution?:FunctionExecution;
}
export interface BehaviorTrace {owner:string;node:string;time:number;detail:string}
export interface BehaviorDebug {
    enabled:boolean; paused:boolean; breakpoints:{owner:string;node:string}[];
    skip?:{owner:string;node:string}; trace:BehaviorTrace[];
}
export interface BehaviorState {data?:GameplayDataState;spawned?:readonly string[]; retired?:readonly string[]; jobs:BehaviorJob[]; errors:string[]; debug:BehaviorDebug}
export interface BehaviorRequest {owner:string;other:string|null;rule:GameplayRule;retired?:boolean}
export const emptyBehaviorState=():BehaviorState=>({jobs:[],errors:[],debug:{enabled:false,paused:false,breakpoints:[],trace:[]}});
export interface BehaviorTick {
    doc:ReadonlyDocument; state?:BehaviorState; time:number; events:readonly BehaviorEvent[];
    controlled:string|null; position:(id:string)=>Position|undefined;
    lifecycle?:{spawned:readonly string[];retired?:ReadonlyMap<string,BehaviorGraph>};
    tallies:ReadonlyMap<string,number>; profile:"2d"|"3d"; mode?:"step";
}
export function tickBehaviors(input:BehaviorTick):{state:BehaviorState|undefined;requests:BehaviorRequest[]} {
    const {time,controlled,position,profile}=input, prior=input.state;
    if(prior?.debug.paused&&input.mode!=="step")return {state:prior,requests:[]};
    const doc=dropHidden(input.doc), requests:BehaviorRequest[]=[], state:BehaviorState={
        data:prior?.data,spawned:prior?.spawned,retired:prior?.retired,jobs:[],errors:[...(prior?.errors??[])],debug:{...(prior?.debug??emptyBehaviorState().debug),trace:[...(prior?.debug.trace??[])]}};
    const fail=(message:string)=>{state.errors=[...state.errors,message].slice(-8);};
    const jobs=(prior?.jobs??[]).map(job=>({...job,stack:job.stack.map(f=>({...f}))}));
    let touched=!!prior;
    const incoming:BehaviorEvent[]=[...input.events];
    if(input.lifecycle){
        const removed=new Set(prior?.retired??[]);
        for(const owner of input.lifecycle.retired?.keys()??[])if(!removed.has(owner))incoming.push({owner,other:null,event:"despawn"});
        state.retired=[...(input.lifecycle.retired?.keys()??[])].slice(0,16384);
        const seen=new Set(prior?.spawned??[]);
        for(const owner of input.lifecycle.spawned)if(!seen.has(owner))incoming.push({owner,other:null,event:"spawn"});
        state.spawned=[...input.lifecycle.spawned].slice(0,256);
        for(const node of doc.nodes.values())if(behaviorEvents(resolveBehavior(doc,node.entity)).some(n=>n.event==="update")
            && !jobs.some(j=>j.owner===node.id&&j.event==="update"))incoming.push({owner:node.id,other:null,event:"update"});
        if(state.spawned.length||state.retired.length)touched=true;
    }
    const enqueue=(event:BehaviorEvent)=>{
        if((event.signalDepth??0)>32){fail("Custom event chain exceeds 32 sends; event refused.");return;}
        const graph=event.event==="despawn"?input.lifecycle?.retired?.get(event.owner):resolveBehavior(doc,doc.nodes.get(event.owner)?.entity);if(!graph?.enabled)return;touched=true;
        const error=behaviorGraphError(graph)??behaviorDataBindingsError(graph,doc.gameplayVariables,[],doc.behaviorFunctions);if(error){fail(`${event.owner}: ${error}`);return;}
        for(const entry of behaviorEvents(graph)){
            if(entry.event!==event.event||(entry.event==="custom"&&entry.name!==event.name)||(entry.other==="player"&&(event.other===null||event.other!==controlled)))continue;
            if(entry.event==="interact"){
                const a=position(event.owner),b=event.other?position(event.other):undefined;
                if(!a||!b||Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>(entry.range??(profile==="3d"?2:96)))continue;
            }
            if(jobs.length>=256){fail("Behavior queue limit (256) reached; event refused.");break;}
            jobs.push({...event,graph,cursor:entry.id,stack:[],due:time,steps:0});
        }
    }
    for(const event of incoming.slice(0,4096))enqueue(event);
    const counters=new Map(input.tallies);let budget=input.mode==="step"?1:1024, halted=false;
    for(const job of jobs){
        const graph=job.event==="despawn"?job.graph:resolveBehavior(doc,doc.nodes.get(job.owner)?.entity);
        if(!graph?.enabled||(job.event!=="despawn"&&!doc.nodes.has(job.owner))||(job.other!==null&&!doc.nodes.has(job.other)))continue;
        if(graph!==job.graph&&JSON.stringify(graph)!==JSON.stringify(job.graph)){fail(`${job.owner}: graph changed; pending execution cancelled.`);continue;}
        if(job.execution&&job.execution.definitions!==doc.behaviorFunctions&&JSON.stringify(job.execution.definitions)!==JSON.stringify(doc.behaviorFunctions??[])){fail(`${job.owner}: function library changed; pending execution cancelled.`);continue;}
        if(halted||job.due>time+1e-9){state.jobs.push(job);continue;}
        const nodes=new Map(graph.nodes.map(n=>[n.id,n]));let waiting=false,failed=false;
        const unwind=()=>{
            while(job.cursor===null&&job.stack.length){
                const frame=job.stack[job.stack.length-1],repeat=nodes.get(frame.nodeId);
                if(repeat?.kind!=="repeat"){failed=true;fail(`${job.owner}: invalid repeat frame.`);return;}
                if(--frame.remaining>0){job.cursor=repeat.body;}else{job.stack.pop();job.cursor=repeat.next;}
            }
        };
        unwind();
        while(job.cursor!==null&&!failed){
            const node=nodes.get(job.cursor);if(!node){failed=true;fail(`${job.owner}: missing execution node.`);break;}
            if(job.execution){try{job.execution=prepareFunctionExecution(job.execution);}catch(error){failed=true;fail(`${job.owner}: ${error instanceof Error?error.message:"Invalid function frame."}`);break;}}
            const activeFrame=job.execution?.frames[job.execution.frames.length-1];
            const point=activeFrame?`${activeFrame.functionId}/${activeFrame.cursor??"end"}`:node.id;
            const skip=state.debug.skip?.owner===job.owner&&state.debug.skip.node===point;
            if(state.debug.enabled&&input.mode!=="step"&&!skip&&state.debug.breakpoints.some(b=>b.owner===job.owner&&b.node===point)){
                state.debug.paused=true;state.debug.skip={owner:job.owner,node:point};halted=true;break;
            }
            if(budget<=0){halted=true;break;}budget--;state.debug.skip=undefined;
            if(++job.steps>10000){failed=true;fail(`${job.owner}: execution exceeded 10000 steps and was cancelled.`);break;}
            let detail:string=node.kind,traceNode=node.id;
            if(node.kind==="event")job.cursor=node.next;
            else if(node.kind==="call"){
                try{
                    const data=state.data??emptyGameplayData(),variables=doc.gameplayVariables??[];
                    if(!job.execution){job.execution=startFunctionExecution(node,doc.behaviorFunctions??[],data,variables,job.owner);detail=`call ${node.functionId}`;}
                    else{
                        const result=stepFunctionExecution({call:node,execution:job.execution,data,variables,owner:job.owner,other:job.other,controlled,tallies:counters});
                        state.data=result.data;job.execution=result.done?undefined:result.execution;traceNode=`${result.functionId}/${result.nodeId}`;detail=`function ${traceNode}`;
                        if(result.done)job.cursor=node.next;
                        const action=result.effect.action;
                        if(action){
                            if(job.event==="despawn"&&["spawn","velocity","despawn"].includes(action.action.kind))fail(`${job.owner}: removed actors cannot execute body-targeting commands.`);
                            else{
                                requests.push({owner:job.owner,other:job.other,...(job.event==="despawn"?{retired:true}:{}),rule:{event:"start",other:"any",target:action.target,action:action.action}});
                                if(action.action.kind==="score"&&(profile==="2d"||counters.has(action.action.key)||counters.size<256))counters.set(action.action.key,Math.min(1e9,(counters.get(action.action.key)??0)+1));
                            }
                        }
                        const signal=result.effect.signal;
                        if(signal){const owner=signal.target==="self"?job.owner:job.other;if(owner)enqueue({owner,other:job.owner,event:"custom",name:signal.name,signalDepth:(job.signalDepth??0)+1});}
                        if(result.effect.wait!==undefined){job.due=time+result.effect.wait;waiting=true;detail+=` wait ${result.effect.wait}s`;}
                    }
                }catch(error){failed=true;fail(`${job.owner}: ${error instanceof Error?error.message:"Invalid function execution."}`);break;}
            }
            else if(node.kind==="branch"){
                const pass=node.condition.kind==="player"?job.other!==null&&job.other===controlled:(counters.get(node.condition.key)??0)>=node.condition.atLeast;
                detail=`branch ${pass?"true":"false"}`;job.cursor=pass?node.onTrue:node.onFalse;
            }else if(node.kind==="action"){
                if(job.event==="despawn"&&["spawn","velocity","despawn"].includes(node.action.kind)){
                    fail(`${job.owner}: removed actors cannot execute body-targeting commands.`);job.cursor=node.next;unwind();continue;
                }
                requests.push({owner:job.owner,other:job.other,...(job.event==="despawn"?{retired:true}:{}),rule:{event:"start",other:"any",target:node.target,action:node.action}});
                if(node.action.kind==="score"&&(profile==="2d"||counters.has(node.action.key)||counters.size<256))counters.set(node.action.key,Math.min(1e9,(counters.get(node.action.key)??0)+1));
                detail=node.action.kind;job.cursor=node.next;
            }else if(node.kind==="assign"||node.kind==="compare"){
                try{
                    const data=state.data??emptyGameplayData(),variables=doc.gameplayVariables??[];
                    if(node.kind==="assign"){
                        const value=resolveGameplaySource(node.value,data,variables,job.owner);
                        state.data=assignGameplayValue(data,variables,job.owner,node.scope,node.variable,node.operation,value);
                        detail=`${node.scope}.${node.variable} ${node.operation}`;job.cursor=node.next;
                    }else{
                        const left=resolveGameplaySource(node.left,data,variables,job.owner),right=resolveGameplaySource(node.right,data,variables,job.owner);
                        const pass=node.operator==="equal"?left===right:node.operator==="notEqual"?left!==right:node.operator==="less"?left<right:node.operator==="lessEqual"?left<=right:node.operator==="greater"?left>right:left>=right;
                        detail=`compare ${pass}`;job.cursor=pass?node.onTrue:node.onFalse;
                    }
                }catch(error){failed=true;fail(`${job.owner}: ${error instanceof Error?error.message:"Invalid gameplay value."}`);break;}
            }else if(node.kind==="emit"){
                const owner=node.target==="self"?job.owner:job.other;
                if(owner)enqueue({owner,other:job.owner,event:"custom",name:node.name,signalDepth:(job.signalDepth??0)+1});
                detail=`send ${node.name}`;job.cursor=node.next;
            }else if(node.kind==="delay"){
                job.cursor=node.next;job.due=time+node.seconds;waiting=true;detail=`wait ${node.seconds}s`;
            }else{
                if(job.stack.length>=8){failed=true;fail(`${job.owner}: repeat nesting exceeds 8.`);break;}
                job.stack.push({nodeId:node.id,remaining:node.count});job.cursor=node.body;detail=`repeat ${node.count}`;
            }
            if(state.debug.enabled)state.debug.trace=[...state.debug.trace,{owner:job.owner,node:traceNode,time,detail}].slice(-128);
            if(waiting)break;
            unwind();
            if(input.mode==="step"){halted=true;break;}
        }
        if(!failed&&(job.cursor!==null||job.stack.length))state.jobs.push(job);
    }
    if(input.mode==="step")state.debug.paused=true;
    return {state:touched?state:undefined,requests};
}
/** Debug settings are runtime-only. Continue skips only the breakpoint that actually stopped execution. */
export function controlBehavior(state:BehaviorState|undefined,command:"enable"|"disable"|"pause"|"continue"|"clear",point?:{owner:string;node:string}):BehaviorState{
    const next=state??emptyBehaviorState();let debug={...next.debug,trace:[...next.debug.trace],breakpoints:[...next.debug.breakpoints]};
    if(point){const exists=debug.breakpoints.some(b=>b.owner===point.owner&&b.node===point.node);debug.breakpoints=exists?debug.breakpoints.filter(b=>b.owner!==point.owner||b.node!==point.node):[...debug.breakpoints,point].slice(-64);debug.enabled=true;}
    else if(command==="enable")debug.enabled=true;
    else if(command==="disable")debug={...debug,enabled:false,paused:false,skip:undefined};
    else if(command==="pause")debug={...debug,enabled:true,paused:true};
    else if(command==="continue")debug.paused=false;
    else debug.trace=[];
    return {...next,debug};
}
