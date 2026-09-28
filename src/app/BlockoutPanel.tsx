/** @module BlockoutPanel @description Validated numeric editing of procedural 3D shapes; document writes remain owned by the parent. */
import React from "react";
import {BlockoutShape,blockoutError} from "../core/geometry/Blockout3D";
export function BlockoutPanel({shape,solid,onSolidChange,onChange}:{shape:BlockoutShape;solid:boolean;onSolidChange:(solid:boolean)=>void;onChange:(shape:BlockoutShape)=>void}){
    const change=(patch:Partial<BlockoutShape>)=>{const next={...shape,...patch} as BlockoutShape;if(!blockoutError(next))onChange(next);};
    return <fieldset style={{minWidth:0,padding:6}}><legend>3D blockout: {shape.kind}</legend>
        {["width","height","depth",...(shape.kind==="room"?["thickness"]:[]),...(shape.kind==="stairs"?["steps"]:[])].map(key=>
            <label key={key} style={{display:"block"}}>{key}<input aria-label={`Blockout ${key}`} type="number" step={key==="steps"?1:"any"}
                min={key==="steps"?1:.001} max={key==="steps"?256:10000} style={{width:"100%",boxSizing:"border-box"}}
                value={(shape as unknown as Record<string,number>)[key]}
                onChange={event=>{if(event.target.value!=="")change({[key]:Number(event.target.value)});}}/></label>)}
        {shape.kind==="room"&&<label><input type="checkbox" checked={shape.ceiling} onChange={event=>change({ceiling:event.target.checked})}/>Ceiling</label>}
        <label><input aria-label="Blockout solid collision" type="checkbox" checked={solid} onChange={event=>onSolidChange(event.target.checked)}/>Solid collision</label>
        <p>{solid?"Solid collision follows the generated shape. Use gravity for slope response.":"Visual blockout only: enable Solid collision to block movement."} Use Edit solid operations for editable cuts.</p>
    </fieldset>;
}
