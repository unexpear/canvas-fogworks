/** @module GameplayVariablesPanel @description Undoable project gameplay declarations with explicit scope, scalar type and default. */
import React,{useState} from "react";
import {GameplayVariable,GameplayType,gameplayVariablesError} from "../core/document/GameplayData";
export function GameplayVariablesPanel({variables,onChange}:{variables:readonly GameplayVariable[];onChange:(variables:GameplayVariable[])=>boolean}){
    const [error,setError]=useState("");
    const save=(next:GameplayVariable[])=>{const invalid=gameplayVariablesError(next);setError(invalid??"");if(!invalid&&!onChange(next))setError("This edit would invalidate an existing gameplay graph.");};
    const change=(index:number,next:GameplayVariable)=>save(variables.map((v,i)=>i===index?next:v));
    return <fieldset style={{minWidth:0}}><legend>Project gameplay variables</legend>
        <p>Entity values are independent per actor. Game values are shared. These are not design tokens.</p>
        <button disabled={variables.length>=256} onClick={()=>{let i=1;while(variables.some(v=>v.id==="value"+i))i++;save([...variables,{id:"value"+i,scope:"entity",type:"number",initial:0}]);}}>Add gameplay variable</button>
        {variables.map((v,i)=><fieldset key={i} style={{minWidth:0}}>
            <input aria-label={"Gameplay variable name "+i} value={v.id} onChange={e=>change(i,{...v,id:e.target.value})}/>
            <select aria-label={"Gameplay variable scope "+i} value={v.scope} onChange={e=>change(i,{...v,scope:e.target.value as "entity"|"game"})}><option>entity</option><option>game</option></select>
            <select aria-label={"Gameplay variable type "+i} value={v.type} onChange={e=>{const type=e.target.value as GameplayType;change(i,type==="number"?{...v,type,initial:0}:type==="boolean"?{...v,type,initial:false}:{...v,type,initial:""});}}><option>number</option><option>boolean</option><option>string</option></select>
            {v.type==="boolean"?<input aria-label={"Gameplay default "+i} type="checkbox" checked={v.initial} onChange={e=>change(i,{...v,initial:e.target.checked})}/>:v.type==="number"?<input aria-label={"Gameplay default "+i} type="number" step="any" value={v.initial} onChange={e=>change(i,{...v,initial:Number(e.target.value)})}/>:<input aria-label={"Gameplay default "+i} value={v.initial} onChange={e=>change(i,{...v,initial:e.target.value})}/>}
            <button onClick={()=>save(variables.filter((_,j)=>j!==i))}>Remove gameplay variable {v.id}</button>
        </fieldset>)}
        {error&&<p role="alert">{error}</p>}
    </fieldset>;
}
