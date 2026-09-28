/** @module ActorPlacementPanel @description Explicit independent actor-copy placement through validated document Actions. */
import React,{useState} from "react";
import {ActionDispatcher} from "../core/actions/ActionDispatcher";
import {PlaceActorHierarchyAction} from "../core/actions/PlaceActorHierarchyAction";

export function ActorPlacementPanel({nodeId,dispatcher,onPlaced}:{nodeId:string;dispatcher:ActionDispatcher;onPlaced:()=>void}){
    const [profile,setProfile]=useState<"2d"|"3d">(dispatcher.getDocument().nodes.get(nodeId)?.spatial3d?"3d":"2d");
    const [offset,setOffset]=useState({x:"0",y:"0",z:"0"});
    const [error,setError]=useState<string|null>(null);
    const [placed,setPlaced]=useState(false);
    const place=()=>{
        setPlaced(false);
        const axes=profile==="3d"?["x","y","z"] as const:["x","y"] as const;
        if(axes.some(axis=>offset[axis].trim()==="")){setError("Enter each placement offset.");return;}
        const action=new PlaceActorHierarchyAction(dispatcher.getDocument(),nodeId,profile,{x:Number(offset.x),y:Number(offset.y),z:profile==="3d"?Number(offset.z):0});
        const result=dispatcher.dispatchAction(action);
        if(!result.success){setError(action.getError()??"Actor placement failed. The document was not changed.");return;}
        setError(null);setPlaced(true);onPlaced();
    };
    return <fieldset><legend>Actor placement</legend>
        <p>Copy this actor and its children independently. This is not a linked prefab. Offsets use the existing parent’s local units; changing dimensions does not convert content.</p>
        <label>Placement dimensions<select aria-label="Actor placement dimensions" value={profile} onChange={e=>setProfile(e.target.value as "2d"|"3d")}>
            <option value="2d">2D</option><option value="3d">3D</option>
        </select></label>
        {(["x","y","z"] as const).filter(axis=>profile==="3d"||axis!=="z").map(axis=><label key={axis} style={{display:"block"}}>Offset {axis}
            <input aria-label={`Actor offset ${axis}`} type="number" step="any" value={offset[axis]} onChange={e=>setOffset({...offset,[axis]:e.target.value})}/>
        </label>)}
        <p>Copied actors do not take over player control. Referenced behavior functions are copied with instance-specific node references.</p>
        <button type="button" onClick={place}>Place independent actor copy</button>
        {error&&<p role="alert">{error}</p>}{placed&&<p role="status">Actor copy placed. Undo removes the entire copy.</p>}
    </fieldset>;
}
