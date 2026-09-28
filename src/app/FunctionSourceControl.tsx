/** @module FunctionSourceControl @description Typed literal, gameplay, input and invocation-local source controls for function drafts. */
import React from "react";
import {BehaviorFunction,FunctionSource} from "../core/document/BehaviorFunctions";
import {GameplayType,GameplayVariable} from "../core/document/GameplayData";
export const functionLiteral=(type:GameplayType="number"):FunctionSource=>({kind:"literal",value:type==="number"?0:type==="boolean"?false:""});
export function FunctionSourceControl({label,value,definition,variables,type,onChange}:{label:string;value:FunctionSource;definition:BehaviorFunction;variables:readonly GameplayVariable[];type?:GameplayType;onChange:(v:FunctionSource)=>void}){
    const inputs=definition.inputs.filter(p=>!type||p.type===type),locals=definition.locals.filter(p=>!type||p.type===type),fields=variables.filter(p=>!type||p.type===type);
    return <fieldset style={{minWidth:0}}><legend>{label}</legend>
        <select aria-label={label+" source"} value={value.kind} onChange={e=>{const kind=e.target.value;if(kind==="input"&&inputs[0])onChange({kind,id:inputs[0].id});else if(kind==="local"&&locals[0])onChange({kind,id:locals[0].id});else if(kind==="variable"&&fields[0])onChange({kind,scope:fields[0].scope,id:fields[0].id});else onChange(functionLiteral(type));}}>
            <option value="literal">Literal</option><option value="variable" disabled={!fields.length}>Gameplay field</option><option value="input" disabled={!inputs.length}>Function input</option><option value="local" disabled={!locals.length}>Local value</option>
        </select>
        {(value.kind==="input"||value.kind==="local")&&<select aria-label={label+" reference"} value={value.id} onChange={e=>onChange({...value,id:e.target.value})}><option value="" disabled>Select field</option>{(value.kind==="input"?inputs:locals).map(p=><option key={p.id}>{p.id}</option>)}</select>}
        {value.kind==="variable"&&<select aria-label={label+" reference"} value={value.scope+":"+value.id} onChange={e=>{const field=fields.find(p=>p.scope+":"+p.id===e.target.value);if(field)onChange({kind:"variable",scope:field.scope,id:field.id});}}>{fields.map(p=><option key={p.scope+":"+p.id} value={p.scope+":"+p.id}>{p.scope}.{p.id}</option>)}</select>}
        {value.kind==="literal"&&<>
            {type&&typeof value.value!==type&&<button onClick={()=>onChange(functionLiteral(type))}>Use {type} default</button>}
            {!type&&<select aria-label={label+" type"} value={typeof value.value} onChange={e=>onChange(functionLiteral(e.target.value as GameplayType))}><option>number</option><option>boolean</option><option>string</option></select>}
            {typeof value.value==="boolean"?<input aria-label={label+" value"} type="checkbox" checked={value.value} onChange={e=>onChange({kind:"literal",value:e.target.checked})}/>:<input aria-label={label+" value"} type={typeof value.value==="number"?"number":"text"} step="any" value={value.value} onChange={e=>onChange({kind:"literal",value:typeof value.value==="number"?Number(e.target.value):e.target.value})}/>}
        </>}
    </fieldset>;
}
