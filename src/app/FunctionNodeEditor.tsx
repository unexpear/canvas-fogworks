/** @module FunctionNodeEditor @description Structured function-node parameters and connections, including nested typed call bindings. */
import React from "react";
import {BehaviorFunction,FunctionNode,FunctionCall,FunctionTarget} from "../core/document/BehaviorFunctions";
import {GameplayVariable,GameplayType} from "../core/document/GameplayData";
import {BehaviorAction} from "../core/document/BehaviorGraph";
import {FunctionSourceControl,functionLiteral} from "./FunctionSourceControl";
export function draftFunctionCall(id:string,callee:BehaviorFunction,context:BehaviorFunction,variables:readonly GameplayVariable[]):FunctionCall{
    const used=new Set<string>();
    return {id,kind:"call",functionId:callee.id,next:null,inputs:callee.inputs.map(p=>({id:p.id,value:functionLiteral(p.type)})),outputs:callee.outputs.map(p=>{
        const local=context.locals.find(v=>v.type===p.type&&!used.has("local:"+v.id)),variable=variables.find(v=>v.type===p.type&&!used.has(v.scope+":"+v.id));
        const target:FunctionTarget=local?{kind:"local",id:local.id}:variable?{kind:"variable",scope:variable.scope,id:variable.id}:{kind:"local",id:"missing"};
        used.add(target.kind==="local"?"local:"+target.id:target.scope+":"+target.id);return {id:p.id,target};
    })};
}
export function FunctionNodeEditor({node,definition,functions,variables,onChange}:{node:FunctionNode;definition:BehaviorFunction;functions:readonly BehaviorFunction[];variables:readonly GameplayVariable[];onChange:(node:FunctionNode)=>void}){
    const link=(label:string,value:string|null,change:(value:string|null)=>void)=><label>{label} <select aria-label={label} value={value??""} onChange={e=>change(e.target.value||null)}><option value="">End / loop return</option>{definition.nodes.filter(n=>n.id!==node.id).map(n=><option key={n.id}>{n.id}</option>)}</select></label>;
    const source=(label:string,value:Parameters<typeof FunctionSourceControl>[0]["value"],change:Parameters<typeof FunctionSourceControl>[0]["onChange"],type?:GameplayType)=><FunctionSourceControl key={label} label={label} value={value} onChange={change} type={type} definition={definition} variables={variables}/>;
    const callee=node.kind==="call"?functions.find(f=>f.id===node.functionId):undefined;
    return <fieldset style={{minWidth:0}}><legend>{node.id}: {node.kind}</legend>
        {node.kind==="return"&&definition.outputs.map(p=>source("Return "+p.id,node.values.find(v=>v.id===p.id)?.value??functionLiteral(p.type),value=>onChange({...node,values:definition.outputs.map(port=>({id:port.id,value:port.id===p.id?value:node.values.find(v=>v.id===port.id)?.value??functionLiteral(port.type)}))}),p.type))}
        {(node.kind==="assign"||node.kind==="local")&&<>
            <select aria-label="Function assignment field" value={node.kind==="local"?node.variable:node.scope+":"+node.variable} onChange={e=>{if(node.kind==="local")onChange({...node,variable:e.target.value});else{const v=variables.find(v=>v.scope+":"+v.id===e.target.value);if(v)onChange({...node,scope:v.scope,variable:v.id});}}}>{node.kind==="local"?definition.locals.map(p=><option key={p.id}>{p.id}</option>):variables.map(p=><option key={p.scope+":"+p.id} value={p.scope+":"+p.id}>{p.scope}.{p.id}</option>)}</select>
            <select aria-label="Function assignment operation" value={node.operation} onChange={e=>onChange({...node,operation:e.target.value as typeof node.operation})}>{["set","add","subtract","multiply","divide"].map(op=><option key={op}>{op}</option>)}</select>
            {source("Function assignment",node.value,value=>onChange({...node,value}),node.kind==="local"?definition.locals.find(p=>p.id===node.variable)?.type:variables.find(p=>p.id===node.variable&&p.scope===node.scope)?.type)}
        </>}
        {node.kind==="compare"&&<>{source("Function left",node.left,left=>onChange({...node,left}))}{source("Function right",node.right,right=>onChange({...node,right}))}<select aria-label="Function comparison" value={node.operator} onChange={e=>onChange({...node,operator:e.target.value as typeof node.operator})}>{["equal","notEqual","less","lessEqual","greater","greaterEqual"].map(op=><option key={op}>{op}</option>)}</select></>}
        {node.kind==="branch"&&<><select aria-label="Function condition" value={node.condition.kind} onChange={e=>onChange({...node,condition:e.target.value==="player"?{kind:"player"}:{kind:"counter",key:"count",atLeast:1}})}><option>player</option><option>counter</option></select>{node.condition.kind==="counter"&&<><input aria-label="Function counter key" value={node.condition.key} onChange={e=>{if(node.condition.kind==="counter")onChange({...node,condition:{...node.condition,key:e.target.value}});}}/><input aria-label="Function counter threshold" type="number" value={node.condition.atLeast} onChange={e=>{if(node.condition.kind==="counter")onChange({...node,condition:{...node.condition,atLeast:Number(e.target.value)}});}}/></>}</>}
        {(node.kind==="compare"||node.kind==="branch")&&<>{link("Function true",node.onTrue,onTrue=>onChange({...node,onTrue}))}{link("Function false",node.onFalse,onFalse=>onChange({...node,onFalse}))}</>}
        {node.kind==="delay"&&<label>Seconds <input aria-label="Function delay seconds" type="number" step="any" min={1/60} max={3600} value={node.seconds} onChange={e=>onChange({...node,seconds:Number(e.target.value)})}/></label>}
        {node.kind==="repeat"&&<><label>Count <input aria-label="Function repeat count" type="number" min={1} max={100} value={node.count} onChange={e=>onChange({...node,count:Number(e.target.value)})}/></label>{link("Function body",node.body,body=>onChange({...node,body}))}</>}
        {node.kind==="emit"&&<><input aria-label="Function signal name" value={node.name} onChange={e=>onChange({...node,name:e.target.value})}/><select aria-label="Function signal target" value={node.target} onChange={e=>onChange({...node,target:e.target.value as "self"|"other"})}><option>self</option><option>other</option></select></>}
        {node.kind==="action"&&<>
            <select aria-label="Function action" value={node.action.kind} onChange={e=>{const kind=e.target.value as BehaviorAction["kind"];const action:BehaviorAction=kind==="score"?{kind,key:"count"}:kind==="spawn"?{kind,templateId:"template"}:kind==="velocity"?{kind,x:0,y:0}:{kind};onChange({...node,action});}}>{["score","spawn","despawn","velocity","checkpoint","win","lose"].map(kind=><option key={kind}>{kind}</option>)}</select>
            <select aria-label="Function action target" value={node.target} onChange={e=>onChange({...node,target:e.target.value as "self"|"other"})}><option>self</option><option>other</option></select>
            {node.action.kind==="score"&&<input aria-label="Function score key" value={node.action.key} onChange={e=>onChange({...node,action:{kind:"score",key:e.target.value}})}/>}
            {node.action.kind==="spawn"&&<input aria-label="Function spawn template" value={node.action.templateId} onChange={e=>onChange({...node,action:{kind:"spawn",templateId:e.target.value}})}/>}
            {node.action.kind==="velocity"&&(["x","y"] as const).map(axis=><input key={axis} aria-label={"Function velocity "+axis} type="number" step="any" value={node.action.kind==="velocity"?node.action[axis]:0} onChange={e=>{if(node.action.kind==="velocity")onChange({...node,action:{...node.action,[axis]:Number(e.target.value)}});}}/>)}
        </>}
        {node.kind==="call"&&<>
            <select aria-label="Nested called function" value={node.functionId} onChange={e=>{const f=functions.find(f=>f.id===e.target.value);if(f)onChange({...draftFunctionCall(node.id,f,definition,variables),next:node.next});}}>{functions.filter(f=>f.id!==definition.id).map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select>
            {!callee&&<p>Choose a valid function.</p>}
            {callee?.inputs.map(p=>source("Nested input "+p.id,node.inputs.find(v=>v.id===p.id)?.value??functionLiteral(p.type),value=>onChange({...node,inputs:callee.inputs.map(port=>({id:port.id,value:port.id===p.id?value:node.inputs.find(v=>v.id===port.id)?.value??functionLiteral(port.type)}))}),p.type))}
            {callee?.outputs.map(p=>{const target=node.outputs.find(v=>v.id===p.id)?.target;return <label key={p.id}>{p.id} → <select aria-label={"Nested output "+p.id} value={target?.kind==="local"?"local:"+target.id:target?.kind==="variable"?target.scope+":"+target.id:""} onChange={e=>{const [scope,id]=e.target.value.split(":");const next:FunctionTarget=scope==="local"?{kind:"local",id}:{kind:"variable",scope:scope as "entity"|"game",id};onChange({...node,outputs:callee.outputs.map(port=>({id:port.id,target:port.id===p.id?next:node.outputs.find(v=>v.id===port.id)?.target??{kind:"local",id:"missing"}}))});}}><option value="" disabled>Select destination</option>{definition.locals.filter(v=>v.type===p.type).map(v=><option key={"local:"+v.id} value={"local:"+v.id}>local.{v.id}</option>)}{variables.filter(v=>v.type===p.type).map(v=><option key={v.scope+":"+v.id} value={v.scope+":"+v.id}>{v.scope}.{v.id}</option>)}</select></label>;})}
        </>}
        {node.kind!=="return"&&node.kind!=="branch"&&node.kind!=="compare"&&link("Function next",node.next,next=>onChange({...node,next}))}
    </fieldset>;
}
