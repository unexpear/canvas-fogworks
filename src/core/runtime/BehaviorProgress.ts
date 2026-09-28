/** @module BehaviorProgress @description Bounded saved graph continuations; graph definitions and debugger state never enter player saves. */
import {customEventNameError} from "../document/BehaviorEvents";
import {ReadonlyDocument} from "../document/Document";
import {resolveBehavior} from "../document/BehaviorAssets";
import {behaviorGraphError} from "../document/BehaviorGraph";
import {dropHidden} from "../document/Components";
import {BehaviorJob,BehaviorState,emptyBehaviorState} from "./BehaviorRuntime";
import {FunctionExecutionFrame,cloneFunctionExecution} from "./BehaviorFunctionExecution";
import {validateFunctionProgress,restoreFunctionProgress} from "./BehaviorFunctionProgress";
export type SavedBehaviorJob=Omit<BehaviorJob,"graph"|"due"|"execution"> & {remaining:number;functions?:FunctionExecutionFrame[]};
const id=(v:unknown):v is string=>typeof v==="string"&&v.length>0&&v.length<=4096&&!/[\u0000-\u001f]/.test(v);
const fields=(v:any,keys:string[])=>v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));
export function validateBehaviorProgress(value:unknown):asserts value is SavedBehaviorJob[]{
    if(!Array.isArray(value)||value.length>256)throw new Error("Invalid saved behavior queue.");
    for(const j of value){
        if(!fields(j,["owner","other","event","cursor","stack","steps","remaining",...(j?.name!==undefined?["name"]:[]),...(j?.signalDepth!==undefined?["signalDepth"]:[]),...(j?.functions!==undefined?["functions"]:[])])||!id(j.owner)||(j.other!==null&&!id(j.other))
            ||!["start","interact","enter","leave","contact","separate","spawn","update","despawn","custom"].includes(j.event)||(j.cursor!==null&&!id(j.cursor))
            ||!Number.isFinite(j.remaining)||j.remaining<0||j.remaining>3600||!Number.isInteger(j.steps)||j.steps<0||j.steps>10000
            ||!Array.isArray(j.stack)||j.stack.length>8||(j.cursor===null&&!j.stack.length))throw new Error("Invalid saved behavior continuation.");
        if(j.signalDepth!==undefined&&(!Number.isInteger(j.signalDepth)||j.signalDepth<0||j.signalDepth>32))throw new Error("Invalid saved custom event depth.");
        if(j.event==="custom" ? customEventNameError(j.name)!==null : j.name!==undefined)throw new Error("Invalid saved custom event.");
        if(j.functions!==undefined)validateFunctionProgress(j.functions);
        for(const f of j.stack)if(!fields(f,["nodeId","remaining"])||!id(f.nodeId)||!Number.isInteger(f.remaining)||f.remaining<1||f.remaining>100)throw new Error("Invalid saved behavior repeat.");
    }
}
export function captureBehaviors(state:BehaviorState|undefined,time:number,despawned:ReadonlySet<string>=new Set()):SavedBehaviorJob[]{
    return (state?.jobs??[]).filter(j=>(j.event==="despawn"||!despawned.has(j.owner))&&(j.other===null||!despawned.has(j.other))).map(({graph,due,execution,...job})=>({...job,stack:job.stack.map(f=>({...f})),remaining:Math.max(0,due-time),...(execution?{functions:cloneFunctionExecution(execution).frames}:{})}));
}
export function restoreBehaviors(doc:ReadonlyDocument,saved:SavedBehaviorJob[],time:number):BehaviorState|undefined{
    validateBehaviorProgress(saved);if(!saved.length)return undefined;
    const authored=doc;doc=dropHidden(doc);const state=emptyBehaviorState();
    state.jobs=saved.map(({remaining,functions,...job})=>{
        const source=job.event==="despawn"?authored:doc;
        const graph=resolveBehavior(source,source.nodes.get(job.owner)?.entity);
        if(!graph?.enabled||behaviorGraphError(graph)||(job.other!==null&&!doc.nodes.has(job.other)))throw new Error("Invalid saved behavior owner/actor.");
        const nodes=new Map(graph.nodes.map(n=>[n.id,n]));
        if((job.cursor!==null&&!nodes.has(job.cursor))||job.stack.some(f=>{const n=nodes.get(f.nodeId);return n?.kind!=="repeat"||f.remaining>n.count;}))throw new Error("Invalid saved behavior node/repeat reference.");
        const call=job.cursor===null?undefined:nodes.get(job.cursor);
        if(functions&&call?.kind!=="call")throw new Error("Saved function requires a call node.");
        const execution=functions&&call?.kind==="call"?restoreFunctionProgress(call,functions,doc.behaviorFunctions??[],doc.gameplayVariables??[]):undefined;
        return {...job,stack:job.stack.map(f=>({...f})),graph,due:time+remaining,...(execution?{execution}:{})};
    });return state;
}
