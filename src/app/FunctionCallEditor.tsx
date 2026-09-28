/** @module FunctionCallEditor @description Typed root graph function call inputs and gameplay output destinations. */
import React from "react";
import {BehaviorFunction,FunctionCall,FunctionBinding} from "../core/document/BehaviorFunctions";
import {GameplayVariable} from "../core/document/GameplayData";
import {GameplaySourceEditor} from "./GameplaySourceEditor";
export function defaultFunctionCall(id:string,definition:BehaviorFunction,variables:readonly GameplayVariable[]):FunctionCall|null{
    const used=new Set<string>(),outputs:FunctionBinding[]=[];
    for(const port of definition.outputs){
        const variable=variables.find(v=>v.type===port.type&&!used.has(v.scope+"/"+v.id));if(!variable)return null;
        used.add(variable.scope+"/"+variable.id);outputs.push({id:port.id,target:{kind:"variable",scope:variable.scope,id:variable.id}});
    }
    return {id,kind:"call",functionId:definition.id,inputs:definition.inputs.map(p=>({id:p.id,value:{kind:"literal",value:p.type==="number"?0:p.type==="boolean"?false:""}})),outputs,next:null};
}
export function FunctionCallEditor({value,functions,variables,onChange}:{value:FunctionCall;functions:readonly BehaviorFunction[];variables:readonly GameplayVariable[];onChange:(value:FunctionCall)=>void}){
    const definition=functions.find(f=>f.id===value.functionId);
    return <fieldset><legend>Function call</legend>
        <select aria-label="Called function" value={value.functionId} onChange={e=>{const f=functions.find(f=>f.id===e.target.value),next=f&&defaultFunctionCall(value.id,f,variables);if(next)onChange({...next,next:value.next});}}>{functions.map(f=><option key={f.id} value={f.id} disabled={!defaultFunctionCall(value.id,f,variables)}>{f.name}</option>)}</select>
        {!definition&&<p role="alert">Missing function definition.</p>}
        {definition?.inputs.map(port=>{const input=value.inputs.find(v=>v.id===port.id);return input&&input.value.kind!=="local"?<GameplaySourceEditor key={port.id} label={"Function input "+port.id} value={input.value} variables={variables} type={port.type} onChange={source=>onChange({...value,inputs:value.inputs.map(v=>v.id===port.id?{...v,value:source}:v)})}/>:null;})}
        {definition?.outputs.map(port=>{const binding=value.outputs.find(v=>v.id===port.id),target=binding?.target;return <label key={port.id}>{port.id} → <select aria-label={"Function output "+port.id} value={target?.kind==="variable"?target.scope+":"+target.id:""} onChange={e=>{const variable=variables.find(v=>v.scope+":"+v.id===e.target.value);if(variable)onChange({...value,outputs:value.outputs.map(v=>v.id===port.id?{...v,target:{kind:"variable",scope:variable.scope,id:variable.id}}:v)});}}>{variables.filter(v=>v.type===port.type).map(v=><option key={v.scope+":"+v.id} value={v.scope+":"+v.id}>{v.scope}.{v.id}</option>)}</select></label>;})}
        <p>Outputs are assigned when the function returns. Each output needs its own matching gameplay field.</p>
    </fieldset>;
}
