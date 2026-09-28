/** @module BehaviorDebugPanel @description Runtime-only graph pause, instruction stepping, breakpoints, counter watches and bounded execution traces. */
import React, {useState} from "react";
import {ReadonlyDocument} from "../core/document/Document";
import {resolveBehavior} from "../core/document/BehaviorAssets";
import {BehaviorState,controlBehavior} from "../core/runtime/BehaviorRuntime";
import {readGameplayValue,emptyGameplayData} from "../core/runtime/GameplayDataState";
export function BehaviorDebugPanel({doc,state,time,tallies,onChange,onStep}:{doc:ReadonlyDocument;state?:BehaviorState;time:number;tallies:ReadonlyMap<string,number>;onChange:(state:BehaviorState)=>void;onStep:()=>void}){
    const [owner,setOwner]=useState(""),[node,setNode]=useState("");
    const owners=[...doc.nodes.values()].filter(n=>resolveBehavior(doc,n.entity));
    const selected=owners.find(n=>n.id===owner)??owners[0],graph=resolveBehavior(doc,selected?.entity);
    const points=[...(graph?.nodes.map(n=>n.id)??[]),...(doc.behaviorFunctions??[]).flatMap(f=>f.nodes.map(n=>`${f.id}/${n.id}`))];
    const selectedNode=points.includes(node)?node:points[0];
    const command=(c:Parameters<typeof controlBehavior>[1])=>onChange(controlBehavior(state,c));
    return <details style={{padding:8,maxHeight:250,overflow:"auto"}}><summary>Behavior debugger{state?.debug.paused?" — paused":""} · {state?.jobs.length??0} pending</summary>
        <label><input type="checkbox" aria-label="Enable behavior debugging" checked={state?.debug.enabled??false} onChange={e=>command(e.target.checked?"enable":"disable")}/> Record execution</label>
        <button onClick={()=>command("pause")}>Pause behaviors</button>
        <button onClick={()=>command("continue")}>Continue behaviors</button>
        <button disabled={!state?.debug.paused} onClick={onStep}>Step instruction</button>
        <button onClick={()=>command("clear")}>Clear trace</button>
        <label>Entity <select aria-label="Debug behavior entity" value={selected?.id??""} onChange={e=>{setOwner(e.target.value);setNode("");}}>{owners.map(n=><option key={n.id} value={n.id}>{n.name||n.id}</option>)}</select></label>
        <label>Node <select aria-label="Debug behavior node" value={selectedNode??""} onChange={e=>setNode(e.target.value)}>{points.map(id=><option key={id}>{id}</option>)}</select></label>
        <button disabled={!selected||!selectedNode} onClick={()=>{if(selected&&selectedNode)onChange(controlBehavior(state,"enable",{owner:selected.id,node:selectedNode}));}}>Toggle breakpoint</button>
        <p>Simulation {time.toFixed(3)}s. Step executes one ready instruction without moving actors; Continue advances waiting timers.</p>
        <div aria-label="Behavior breakpoints">{state?.debug.breakpoints.map(p=><div key={p.owner+":"+p.node}>{p.owner} / {p.node}</div>)}</div>
        <div aria-label="Behavior pending jobs">{state?.jobs.map((j,i)=><div key={i}>{j.owner} / {j.cursor??"repeat return"} · wait {Math.max(0,j.due-time).toFixed(3)}s · loops {j.stack.map(f=>f.remaining).join(", ")||"none"}</div>)}</div>
        <div aria-label="Behavior counter watches">{[...tallies].map(([key,value])=><span key={key}>{key}: {value} </span>)}</div>
        <div aria-label="Function frame watches">{state?.jobs.flatMap((j,i)=>j.execution?.frames.map((f,k)=><div key={i+":"+k}>{j.owner} · {f.functionId}/{f.cursor??"loop return"} · inputs {f.inputs.map(([id,value])=>`${id}=${String(value)}`).join(", ")} · locals {f.locals.map(([id,value])=>`${id}=${String(value)}`).join(", ")}</div>)??[])}</div>
        <div aria-label="Typed gameplay watches">{doc.gameplayVariables?.map(v=>{let value:unknown;try{value=readGameplayValue(state?.data??emptyGameplayData(),doc.gameplayVariables??[],selected?.id??"",v.scope,v.id);}catch{value="invalid value";}return <div key={v.scope+":"+v.id}>{v.scope}.{v.id}: {String(value)}</div>;})}</div>
        <ol aria-label="Behavior execution trace">{state?.debug.trace.map((t,i)=><li key={i}>{t.time.toFixed(3)} {t.owner}/{t.node}: {t.detail}</li>)}</ol>
        {state?.errors.map((e,i)=><p role="alert" key={i}>{e}</p>)}
    </details>;
}
