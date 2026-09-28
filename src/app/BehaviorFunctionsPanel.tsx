/** @module BehaviorFunctionsPanel @description Draft-based visual function library authoring with validated atomic Apply and explicit conflict handling. */
import React,{useEffect,useState} from "react";
import {BehaviorFunction,FunctionNode,behaviorFunctionsError} from "../core/document/BehaviorFunctions";
import {GameplayPort,GameplayType,GameplayVariable} from "../core/document/GameplayData";
import {FunctionNodeEditor,draftFunctionCall} from "./FunctionNodeEditor";
import {functionLiteral} from "./FunctionSourceControl";
function links(node:FunctionNode):(string|null)[]{return node.kind==="return"?[]:node.kind==="branch"||node.kind==="compare"?[node.onTrue,node.onFalse]:node.kind==="repeat"?[node.body,node.next]:[node.next];}
export function BehaviorFunctionsPanel({functions,variables,onChange}:{functions:readonly BehaviorFunction[];variables:readonly GameplayVariable[];onChange:(functions:BehaviorFunction[])=>boolean}){
    const [selected,setSelected]=useState(""),[draft,setDraft]=useState<BehaviorFunction|null>(null),[baseline,setBaseline]=useState(""),[nodeId,setNodeId]=useState(""),[error,setError]=useState("");
    const saved=functions.find(f=>f.id===selected)??(selected?undefined:functions[0]);
    const dirty=draft!==null&&JSON.stringify(draft)!==baseline;
    const reset=(value:BehaviorFunction|undefined)=>{setDraft(value??null);setBaseline(value?JSON.stringify(value):"");setNodeId(value?.entry??"");setError("");};
    useEffect(()=>{if(!dirty)reset(saved);},[saved]);
    const save=(next:BehaviorFunction[])=>{
        const invalid=behaviorFunctionsError(next,variables);if(invalid){setError(invalid);return false;}
        if(!onChange(next)){setError("This change would invalidate an existing function or graph call.");return false;}
        setError("");return true;
    };
    const choose=(id:string)=>{if(dirty){setError("Apply or discard the current draft before switching functions.");return;}setSelected(id);reset(functions.find(f=>f.id===id));};
    const add=()=>{
        if(dirty){setError("Apply or discard the current draft before adding a function.");return;}
        let n=1;while(functions.some(f=>f.id==="function"+n))n++;
        const f:BehaviorFunction={id:"function"+n,name:"Function "+n,inputs:[],outputs:[],locals:[],entry:"return",nodes:[{id:"return",kind:"return",values:[]}]};
        if(save([...functions,f])){setSelected(f.id);reset(f);}
    };
    const edit=(next:BehaviorFunction)=>{setDraft(next);setError("");};
    const ports=(kind:"inputs"|"outputs"|"locals")=>{
        if(!draft)return null;
        const update=(next:readonly GameplayPort[])=>edit({...draft,[kind]:next,...(kind==="outputs"?{nodes:draft.nodes.map(n=>n.kind==="return"?{...n,values:next.map(p=>({id:p.id,value:n.values.find(v=>v.id===p.id)?.value??functionLiteral(p.type)}))}:n)}:{})});
        return <fieldset style={{minWidth:0}}><legend>{kind}</legend>
            {draft[kind].map((p,i)=><div key={i}><input aria-label={`Function ${kind} name ${i}`} value={p.id} onChange={e=>update(draft[kind].map((v,j)=>j===i?{...v,id:e.target.value}:v))}/><select aria-label={`Function ${kind} type ${i}`} value={p.type} onChange={e=>update(draft[kind].map((v,j)=>j===i?{...v,type:e.target.value as GameplayType}:v))}><option>number</option><option>boolean</option><option>string</option></select><button onClick={()=>update(draft[kind].filter((_,j)=>j!==i))}>Remove {kind} {p.id}</button></div>)}
            <button disabled={draft[kind].length>=64} onClick={()=>{let i=1;while(draft[kind].some(p=>p.id==="value"+i))i++;update([...draft[kind],{id:"value"+i,type:"number"}]);}}>Add function {kind}</button>
        </fieldset>;
    };
    const addNode=(kind:FunctionNode["kind"])=>{
        if(!draft)return;let i=1;while(draft.nodes.some(n=>n.id===kind+i))i++;const id=kind+i,next=draft.nodes.find(n=>n.kind==="return")?.id??null;
        let node:FunctionNode;
        if(kind==="return")node={id,kind,values:draft.outputs.map(p=>({id:p.id,value:functionLiteral(p.type)}))};
        else if(kind==="local")node={id,kind,variable:draft.locals[0]?.id??"missing",operation:"set",value:functionLiteral(draft.locals[0]?.type),next};
        else if(kind==="assign")node={id,kind,scope:variables[0]?.scope??"entity",variable:variables[0]?.id??"missing",operation:"set",value:functionLiteral(variables[0]?.type),next};
        else if(kind==="compare")node={id,kind,left:functionLiteral(),right:functionLiteral(),operator:"equal",onTrue:next,onFalse:next};
        else if(kind==="branch")node={id,kind,condition:{kind:"player"},onTrue:next,onFalse:next};
        else if(kind==="delay")node={id,kind,seconds:1,next};
        else if(kind==="repeat")node={id,kind,count:2,body:null,next};
        else if(kind==="emit")node={id,kind,name:"signal",target:"self",next};
        else if(kind==="call"){const callee=functions.find(f=>f.id!==draft.id);if(!callee)return;node={...draftFunctionCall(id,callee,draft,variables),next};}
        else node={id,kind:"action",target:"self",action:{kind:"checkpoint"},next};
        edit({...draft,nodes:[...draft.nodes,node]});setNodeId(id);
    };
    const node=draft?.nodes.find(n=>n.id===nodeId)??draft?.nodes[0];
    const removeNode=()=>{
        if(!draft||!node)return;const clear=(id:string|null)=>id===node.id?null:id;
        const nodes=draft.nodes.filter(n=>n.id!==node.id).map(n=>n.kind==="return"?n:n.kind==="branch"||n.kind==="compare"?{...n,onTrue:clear(n.onTrue),onFalse:clear(n.onFalse)}:n.kind==="repeat"?{...n,body:clear(n.body),next:clear(n.next)}:{...n,next:clear(n.next)});
        edit({...draft,entry:draft.entry===node.id?nodes[0]?.id??"":draft.entry,nodes});setNodeId(nodes[0]?.id??"");
    };
    return <details style={{minWidth:0}}><summary>Reusable functions ({functions.length}){dirty?" — unapplied draft":""}</summary>
        <p>Inputs are copied per call. Locals start at zero, false or empty text. Apply validates the whole library and all callers. Apply drafts before changing selected actors or closing the project.</p>
        <select aria-label="Function library selection" value={saved?.id??selected} onChange={e=>choose(e.target.value)}><option value="" disabled>Select function</option>{functions.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select>
        <button disabled={functions.length>=128} onClick={add}>New function</button>
        {draft&&<>
            <p>Stable ID: {draft.id}</p><label>Name <input aria-label="Function name" value={draft.name} onChange={e=>edit({...draft,name:e.target.value})}/></label>
            {ports("inputs")}{ports("outputs")}{ports("locals")}
            <label>Entry <select aria-label="Function entry" value={draft.entry} onChange={e=>edit({...draft,entry:e.target.value})}>{draft.nodes.map(n=><option key={n.id}>{n.id}</option>)}</select></label>
            <div>{(["local","assign","compare","branch","delay","repeat","action","emit","call","return"] as const).map(kind=><button key={kind} disabled={draft.nodes.length>=64||(kind==="local"&&!draft.locals.length)||(kind==="assign"&&!variables.length)||(kind==="call"&&!functions.some(f=>f.id!==draft.id))} onClick={()=>addNode(kind)}>Add function {kind} node</button>)}</div>
            <div style={{maxHeight:420,overflow:"auto"}}><svg aria-label="Function graph connections" viewBox={`0 0 320 ${Math.max(60,draft.nodes.length*54)}`} style={{width:"100%",height:Math.max(60,draft.nodes.length*54)}}>
                {draft.nodes.flatMap((n,i)=>links(n).flatMap((id,k)=>{const j=draft.nodes.findIndex(v=>v.id===id);return j<0?[]:[<path key={n.id+":"+k} d={`M 274 ${i*54+22} H ${286+k*12} V ${j*54+22} H 274`} fill="none" stroke="currentColor" opacity={.5}/>];}))}
                {draft.nodes.map((n,i)=><g key={n.id} role="button" tabIndex={0} aria-label={"Select function node "+n.id} onClick={()=>setNodeId(n.id)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setNodeId(n.id);}}}><rect x={4} y={i*54+4} width={270} height={36} rx={4} fill={n.id===node?.id?"#36485f":"#242830"} stroke="currentColor"/><text x={12} y={i*54+27} fill="currentColor" fontSize={12}>{n.id}: {n.kind}{n.id===draft.entry?" (entry)":""}</text></g>)}
            </svg></div>
            {node&&<><FunctionNodeEditor node={node} definition={draft} functions={functions.map(f=>f.id===draft.id?draft:f)} variables={variables} onChange={next=>edit({...draft,nodes:draft.nodes.map(n=>n.id===next.id?next:n)})}/><button onClick={removeNode}>Remove function node</button></>}
            <button disabled={!dirty} onClick={()=>{if(!saved||JSON.stringify(saved)!==baseline){setError("The saved function changed outside this draft. Discard to reload it before editing.");return;}if(save(functions.map(f=>f.id===draft.id?draft:f)))reset(draft);}}>Apply function draft</button>
            <button onClick={()=>reset(saved)}>Discard function draft</button>
            <button disabled={dirty} onClick={()=>{if(save(functions.filter(f=>f.id!==draft.id))){setSelected("");reset(functions.find(f=>f.id!==draft.id));}}}>Delete function</button>
        </>}
        {error&&<p role="alert">{error}</p>}
    </details>;
}
