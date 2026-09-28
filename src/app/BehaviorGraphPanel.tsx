/** @module BehaviorGraphPanel @description Visual entity graph authoring with validated connections and existing entity Action ownership. */
import React, { useId, useState } from "react";
import { Entity } from "../core/document/Entity";
import { BehaviorAction, BehaviorGraph, BehaviorNode, behaviorGraphError, behaviorLinks, starterBehaviorGraph } from "../core/document/BehaviorGraph";
import {BehaviorEventKind,isLifecycleEvent} from "../core/document/BehaviorEvents";

import { BehaviorAsset } from "../core/document/BehaviorAssets";
import {GameplayVariable,gameplaySourceType} from "../core/document/GameplayData";
import {GameplaySourceEditor} from "./GameplaySourceEditor";
import {behaviorDataBindingsError} from "../core/document/BehaviorDataBindings";
import {BehaviorFunction} from "../core/document/BehaviorFunctions";
import {FunctionCallEditor,defaultFunctionCall} from "./FunctionCallEditor";
export interface BehaviorAssetProps { functions?:readonly BehaviorFunction[]; variables?:readonly GameplayVariable[]; assets?:readonly BehaviorAsset[]; onAssetsChange?:(assets:BehaviorAsset[],binding?:Entity)=>void; }
function caption(node: BehaviorNode): string {
    if (node.kind === "event") return `On ${node.event} (${node.other})`;
    if (node.kind === "branch") return node.condition.kind === "player" ? "Other actor is Player?" : `${node.condition.key} ≥ ${node.condition.atLeast}?`;
    if(node.kind==="assign")return `${node.scope}.${node.variable} ${node.operation}`;
    if(node.kind==="compare")return `Compare ${node.operator}`;
    if(node.kind==="emit")return `Send ${node.name} → ${node.target}`;
    if(node.kind==="delay")return `Wait ${node.seconds}s`;
    if(node.kind==="repeat")return `Repeat ${node.count} times`;
    if(node.kind==="call")return `Call ${node.functionId}`;
    return `${node.action.kind} → ${node.target}`;
}
export function BehaviorGraphPanel({entity,onChange,assets=[],onAssetsChange,variables=[],functions=[]}:{entity:Entity;onChange:(entity:Entity)=>void}&BehaviorAssetProps) {
    const [selected,setSelected] = useState(""), [error,setError] = useState("");
    const arrowId = useId();
    const asset=assets.find(a=>a.id===entity.behaviorAssetId);
    const graph = asset?.graph ?? entity.behavior;
    const assetPicker=onAssetsChange && <label>Reusable graph <select aria-label="Reusable behavior graph" value={entity.behaviorAssetId??""} onChange={e=>{const {behavior,behaviorAssetId,...rest}=entity;onChange(e.target.value?{...rest,behaviorAssetId:e.target.value}:{...rest,behavior:graph});}}><option value="">Local graph</option>{assets.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>;
    const save = (next: BehaviorGraph) => {
        if(next.nodes.some(n=>(n.kind==="event"&&isLifecycleEvent(n.event))||n.kind==="emit"))next={...next,version:3};
        if(next.nodes.some(n=>n.kind==="assign"||n.kind==="compare")||graph?.version===4)next={...next,version:4};
        if(next.nodes.some(n=>n.kind==="call")||graph?.version===5)next={...next,version:5};
        const error = behaviorGraphError(next)??behaviorDataBindingsError(next,variables,[],functions); setError(error ?? "");
        if (!error) { if(asset && onAssetsChange)onAssetsChange(assets.map(a=>a.id===asset.id?{...a,graph:next}:a)); else {const {behaviorAssetId,...rest}=entity;onChange({...rest,behavior:next});} }
    };
    if (!graph) return <fieldset style={{minWidth:0}}><legend>Behavior graph</legend>
        {assetPicker}
        <p>Connect events, conditions and actions. The starter counts interactions and wins on the third.</p>
        <button onClick={()=>{save(starterBehaviorGraph());setSelected("interact");}}>Add behavior graph</button>
    </fieldset>;
    const node = graph.nodes.find(n=>n.id===selected) ?? graph.nodes[0];
    const replace = (next: BehaviorNode) => save({...graph,nodes:graph.nodes.map(n=>n.id===next.id?next:n)});
    const add = (kind: BehaviorNode["kind"]) => {
        let index=1; while(graph.nodes.some(n=>n.id===`${kind}${index}`))index++;
        const id=`${kind}${index}`;
        if(kind==="call"){
            const next=functions.map(f=>defaultFunctionCall(id,f,variables)).find(c=>c!==null);
            if(next){save({...graph,version:5,nodes:[...graph.nodes,next]});setSelected(id);}return;
        }
        const next:BehaviorNode = kind === "event" ? {id,kind,event:"enter",other:"player",next:null}
            : kind === "branch" ? {id,kind,condition:{kind:"player"},onTrue:null,onFalse:null}
            : kind === "assign" ? {id,kind,scope:variables[0]?.scope??"entity",variable:variables[0]?.id??"health",operation:"set",value:{kind:"literal",value:variables[0]?.initial??0},next:null}
            : kind === "compare" ? {id,kind,left:{kind:"literal",value:0},right:{kind:"literal",value:0},operator:"equal",onTrue:null,onFalse:null}
            : kind === "emit" ? {id,kind,name:"signal",target:"self",next:null}
            : kind === "delay" ? {id,kind,seconds:1,next:null}
            : kind === "repeat" ? {id,kind,count:3,body:null,next:null}
            : {id,kind,target:"self",action:{kind:"checkpoint"},next:null};
        save({...graph,version:(kind==="delay"||kind==="repeat")&&graph.version===1?2:graph.version,nodes:[...graph.nodes,next]});setSelected(id);
    };
    const linkControl = (label:string,value:string|null,change:(id:string|null)=>void) => <label>{label} <select aria-label={label} value={value??""} onChange={e=>change(e.target.value||null)}>
        <option value="">End</option>{graph.nodes.filter(n=>n.kind!=="event"&&n.id!==node?.id).map(n=><option key={n.id} value={n.id}>{n.id}: {caption(n)}</option>)}
    </select></label>;
    const remove = () => {
        const clear = (id:string|null) => id===node.id?null:id;
        save({...graph,nodes:graph.nodes.filter(n=>n.id!==node.id).map(n=>(n.kind==="branch"||n.kind==="compare")
            ? {...n,onTrue:clear(n.onTrue),onFalse:clear(n.onFalse)} : n.kind==="repeat" ? {...n,body:clear(n.body),next:clear(n.next)} : {...n,next:clear(n.next)})});setSelected("");
    };
    const setAction = (action:BehaviorAction) => { if(node?.kind==="action")replace({...node,action}); };
    const indexes = new Map(graph.nodes.map((n,i)=>[n.id,i]));
    return <fieldset className="fogworks-behavior-panel" style={{marginTop:8,padding:6,minWidth:0}}><legend>Behavior graph</legend>
        <style>{`.fogworks-behavior-panel label{display:block}.fogworks-behavior-panel select,.fogworks-behavior-panel input,.fogworks-behavior-panel button{max-width:100%;margin:3px 0}.fogworks-behavior-panel fieldset{min-width:0}`}</style>
        {assetPicker}
        {onAssetsChange && (asset ? <><p>Shared: edits affect every entity using this asset.</p><label>Asset name <input aria-label="Behavior asset name" value={asset.name} onChange={e=>{if(e.target.value.trim())onAssetsChange(assets.map(a=>a.id===asset.id?{...a,name:e.target.value}:a));}}/></label><button onClick={()=>{const {behaviorAssetId,...rest}=entity;onChange({...rest,behavior:JSON.parse(JSON.stringify(graph))});}}>Detach local copy</button></> : <button disabled={assets.length>=128} onClick={()=>{let i=1;while(assets.some(a=>a.id===`graph${i}`))i++;const id=`graph${i}`,{behavior,...rest}=entity;onAssetsChange([...assets,{id,name:`Graph ${i}`,graph}],{...rest,behaviorAssetId:id});}}>Save as reusable graph</button>)}
        <label><input aria-label="Enable behavior graph" type="checkbox" checked={graph.enabled} onChange={e=>save({...graph,enabled:e.target.checked})}/> Enabled</label>
        <button onClick={()=>{const {behavior,behaviorAssetId,...rest}=entity;onChange(rest);setError("");setSelected("");}}>Remove behavior graph</button>
        <div style={{maxHeight:340,overflow:"auto",background:"#171d27",margin:"8px 0"}}>
            <svg viewBox={`0 0 520 ${Math.max(80,graph.nodes.length*78+12)}`} width="100%" aria-label="Behavior graph connections">
                <defs><marker id={arrowId} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" fill="#b8d2f3"/></marker></defs>
                {graph.nodes.flatMap((n,i)=>behaviorLinks(n).map((link,port)=>link && indexes.has(link) ? <path key={`${n.id}-${port}`}
                    d={`M 110 ${i*78+36} C ${20+port*30} ${i*78+36}, ${20+port*30} ${indexes.get(link)!*78+36}, 110 ${indexes.get(link)!*78+36}`}
                    fill="none" markerEnd={`url(#${arrowId})`} stroke={n.kind==="branch"?(port===0?"#76ce9a":"#e5a079"):"#8bb5ec"} strokeWidth="2"/>:null))}
                {graph.nodes.map((n,i)=><g key={n.id} role="button" tabIndex={0} aria-label={`Select behavior node ${n.id}`} aria-pressed={node?.id===n.id}
                    onClick={()=>setSelected(n.id)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelected(n.id);}}} style={{cursor:"pointer"}}>
                    <rect x="110" y={i*78+8} width="394" height="58" rx="7" fill={n.kind==="event"?"#274968":n.kind==="branch"?"#574c2b":"#304e42"}
                        stroke={node?.id===n.id?"#ffffff":"#718096"} strokeWidth={node?.id===n.id?3:1}/>
                    <text x="124" y={i*78+30} fill="white" fontSize="14">{n.id}</text>
                    <text x="124" y={i*78+51} fill="#e0e7ef" fontSize="13">{caption(n).slice(0,48)}</text>
                </g>)}
            </svg>
        </div>
        <p>Green branch link: true. Orange: false. Select a node to edit its connections.</p>
        {(["event","branch","action","delay","repeat","emit","assign","compare","call"] as const).map(kind=><button key={kind} disabled={(kind==="call"&&!functions.some(f=>defaultFunctionCall("call",f,variables)))||(kind==="assign"&&!variables.length)||graph.nodes.length>=64||(kind==="event"&&graph.nodes.filter(n=>n.kind==="event").length>=16)} onClick={()=>add(kind)}>Add {kind} node</button>)}
        {node && <fieldset><legend>{node.id}</legend>
            {node.kind==="call"&&<><FunctionCallEditor value={node} functions={functions} variables={variables} onChange={replace}/>{linkControl("Behavior next",node.next,next=>replace({...node,next}))}</>}
            {node.kind==="event" && <>
                <label>Event <select aria-label="Behavior event" value={node.event} onChange={e=>replace({...node,event:e.target.value as BehaviorEventKind,name:e.target.value==="custom"?"signal":undefined,range:undefined,...(e.target.value==="start"||isLifecycleEvent(e.target.value)?{other:"any" as const}:{})})}>
                    {["start","enter","leave","contact","separate","interact","spawn","update","despawn","custom"].map(v=><option key={v}>{v}</option>)}
                </select></label>
                <label>Actor <select aria-label="Behavior actor" value={node.other} disabled={node.event==="start"||["spawn","update","despawn"].includes(node.event)} onChange={e=>replace({...node,other:e.target.value as "any"|"player"})}><option value="any">Any</option><option value="player">Player</option></select></label>
                {node.event==="custom" && <label>Event name <input aria-label="Behavior custom event name" value={node.name??""} onChange={e=>replace({...node,name:e.target.value})}/></label>}
                {node.event==="interact" && <label>Range <input aria-label="Behavior interaction range" type="number" min="0.01" max="10000" value={node.range??""} placeholder="96 in 2D / 2 in 3D" onChange={e=>replace({...node,range:e.target.value===""?undefined:Number(e.target.value)})}/></label>}
                {linkControl("Behavior next",node.next,next=>replace({...node,next}))}
            </>}
            {node.kind==="branch" && <>
                <select aria-label="Behavior condition" value={node.condition.kind} onChange={e=>replace({...node,condition:e.target.value==="player"?{kind:"player"}:{kind:"counter",key:"uses",atLeast:3}})}><option value="player">Other actor is Player</option><option value="counter">Counter at least</option></select>
                {node.condition.kind==="counter" && <>
                    <input aria-label="Behavior counter key" value={node.condition.key} onChange={e=>replace({...node,condition:{...node.condition,kind:"counter",key:e.target.value,atLeast:node.condition.kind==="counter"?node.condition.atLeast:0}})}/>
                    <input aria-label="Behavior counter threshold" type="number" min="0" max="1000000000" step="1" value={node.condition.atLeast} onChange={e=>replace({...node,condition:{kind:"counter",key:node.condition.kind==="counter"?node.condition.key:"uses",atLeast:Number(e.target.value)}})}/>
                </>}
                {linkControl("Behavior true",node.onTrue,onTrue=>replace({...node,onTrue}))}
                {linkControl("Behavior false",node.onFalse,onFalse=>replace({...node,onFalse}))}
            </>}
            {node.kind==="action" && <>
                <select aria-label="Behavior action" value={node.action.kind} onChange={e=>{const kind=e.target.value as BehaviorAction["kind"];setAction(kind==="score"?{kind,key:"uses"}:kind==="spawn"?{kind,templateId:"template"}:kind==="velocity"?{kind,x:0,y:0}:{kind});}}>
                    {["checkpoint","score","spawn","despawn","velocity","win","lose"].map(v=><option key={v}>{v}</option>)}
                </select>
                <select aria-label="Behavior target" value={node.target} onChange={e=>replace({...node,target:e.target.value as "self"|"other"})}><option>self</option><option>other</option></select>
                {node.action.kind==="score" && <input aria-label="Behavior score key" value={node.action.key} onChange={e=>setAction({kind:"score",key:e.target.value})}/>}
                {node.action.kind==="spawn" && <input aria-label="Behavior template ID" value={node.action.templateId} onChange={e=>setAction({kind:"spawn",templateId:e.target.value})}/>}
                {node.action.kind==="velocity" && (["x","y"] as const).map(axis=><input key={axis} aria-label={`Behavior velocity ${axis}`} type="number" value={node.action.kind==="velocity"?node.action[axis]:0}
                    onChange={e=>{if(node.action.kind==="velocity")setAction({...node.action,[axis]:Number(e.target.value)});}}/>)}
                {linkControl("Behavior next",node.next,next=>replace({...node,next}))}
            </>}
            {node.kind==="assign" && <><select aria-label="Assignment variable" value={node.scope+":"+node.variable} onChange={e=>{const v=variables.find(v=>v.scope+":"+v.id===e.target.value);if(v)replace({...node,scope:v.scope,variable:v.id,operation:"set",value:{kind:"literal",value:v.initial}});}}>{variables.map(v=><option key={v.scope+":"+v.id} value={v.scope+":"+v.id}>{v.scope}.{v.id}</option>)}</select><select aria-label="Assignment operation" value={node.operation} onChange={e=>replace({...node,operation:e.target.value as typeof node.operation})}>{["set","add","subtract","multiply","divide"].map(v=><option key={v} disabled={v!=="set"&&variables.find(d=>d.id===node.variable&&d.scope===node.scope)?.type!=="number"}>{v}</option>)}</select><GameplaySourceEditor label="Assignment" value={node.value} variables={variables} type={variables.find(v=>v.id===node.variable&&v.scope===node.scope)?.type} onChange={value=>replace({...node,value})}/>{linkControl("Behavior next",node.next,next=>replace({...node,next}))}</>}
            {node.kind==="compare" && <><GameplaySourceEditor label="Left operand" value={node.left} variables={variables} onChange={left=>{const type=gameplaySourceType(left,variables),same=type===gameplaySourceType(node.right,variables);replace({...node,left,right:same?node.right:{kind:"literal",value:type==="number"?0:type==="boolean"?false:""},operator:type==="number"?node.operator:"equal"});}}/><GameplaySourceEditor label="Right operand" value={node.right} variables={variables} type={gameplaySourceType(node.left,variables)} onChange={right=>replace({...node,right})}/><select aria-label="Comparison operator" value={node.operator} onChange={e=>replace({...node,operator:e.target.value as typeof node.operator})}>{["equal","notEqual","less","lessEqual","greater","greaterEqual"].map(v=><option key={v}>{v}</option>)}</select>{linkControl("Behavior true",node.onTrue,onTrue=>replace({...node,onTrue}))}{linkControl("Behavior false",node.onFalse,onFalse=>replace({...node,onFalse}))}</>}
            {node.kind==="emit" && <><label>Send event <input aria-label="Behavior send name" value={node.name} onChange={e=>replace({...node,name:e.target.value})}/></label><select aria-label="Behavior send target" value={node.target} onChange={e=>replace({...node,target:e.target.value as "self"|"other"})}><option>self</option><option>other</option></select>{linkControl("Behavior next",node.next,next=>replace({...node,next}))}</>}
            {node.kind==="delay" && <><label>Delay seconds <input aria-label="Behavior delay seconds" type="number" min={1/60} max={3600} step="any" value={node.seconds} onChange={e=>replace({...node,seconds:Number(e.target.value)})}/></label>{linkControl("Behavior next",node.next,next=>replace({...node,next}))}</>}
            {node.kind==="repeat" && <><label>Repeat count <input aria-label="Behavior repeat count" type="number" min={1} max={100} value={node.count} onChange={e=>replace({...node,count:Number(e.target.value)})}/></label>{linkControl("Behavior body",node.body,body=>replace({...node,body}))}{linkControl("Behavior next",node.next,next=>replace({...node,next}))}<p>Body ends return to this repeat. Next runs after all iterations.</p></>}
            <button onClick={remove}>Remove selected behavior node</button>
        </fieldset>}
        <p>Unconnected nodes stay available for editing. Graphs run after existing rules; cycles are refused. Scores earlier in a graph are visible to its later branches.</p>
        {error && <p role="alert">{error}</p>}
    </fieldset>;
}
