/** @module GameplaySourceEditor @description Typed literal and declared-variable sources for graph assignments and comparisons. */
import React from "react";
import {GameplaySource,GameplayVariable,GameplayType} from "../core/document/GameplayData";
export function GameplaySourceEditor({label,value,variables,type,onChange}:{label:string;value:GameplaySource;variables:readonly GameplayVariable[];type?:GameplayType;onChange:(value:GameplaySource)=>void}){
    const allowed=variables.filter(v=>!type||v.type===type);
    const literal=(kind:GameplayType):GameplaySource=>({kind:"literal",value:kind==="number"?0:kind==="boolean"?false:""});
    return <fieldset><legend>{label}</legend>
        <select aria-label={label+" source"} value={value.kind} onChange={e=>{const v=allowed[0];onChange(e.target.value==="variable"&&v?{kind:"variable",scope:v.scope,id:v.id}:literal(type??"number"));}}>
            <option value="literal">Literal</option><option value="variable" disabled={!allowed.length}>Variable</option>
            {value.kind==="input"&&<option value="input">Function input</option>}
        </select>
        {value.kind==="variable"&&<select aria-label={label+" variable"} value={value.scope+":"+value.id} onChange={e=>{const v=allowed.find(v=>v.scope+":"+v.id===e.target.value);if(v)onChange({kind:"variable",scope:v.scope,id:v.id});}}>{allowed.map(v=><option key={v.scope+":"+v.id} value={v.scope+":"+v.id}>{v.scope}.{v.id}</option>)}</select>}
        {value.kind==="literal"&&<>
            {!type&&<select aria-label={label+" type"} value={typeof value.value} onChange={e=>onChange(literal(e.target.value as GameplayType))}><option>number</option><option>boolean</option><option>string</option></select>}
            {typeof value.value==="boolean"?<input aria-label={label+" value"} type="checkbox" checked={value.value} onChange={e=>onChange({kind:"literal",value:e.target.checked})}/>:<input aria-label={label+" value"} type={typeof value.value==="number"?"number":"text"} step="any" value={value.value} onChange={e=>onChange({kind:"literal",value:typeof value.value==="number"?Number(e.target.value):e.target.value})}/>}
        </>}
    </fieldset>;
}
