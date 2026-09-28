/** @module SolidTreePanel @description Immutable numeric authoring of bounded solid trees with evaluated errors before document adoption. */
import React,{useState} from "react";
import {BlockoutShape,Point3D} from "../core/geometry/Blockout3D";
import {SolidOperation3D} from "../core/geometry/SolidBoolean3D";
import {SolidTree3D,solidLeaf3D,solidTreeError} from "../core/geometry/SolidTree3D";
export function SolidTreePanel({tree,onChange}:{tree:SolidTree3D;onChange:(tree:SolidTree3D)=>void}){
    const [error,setError]=useState<string|null>(null);
    const commit=(next:SolidTree3D)=>{const error=solidTreeError(next);setError(error);if(!error)onChange(next);};
    const freshIds=()=>{
        const ids=new Set<string>();const visit=(n:SolidTree3D)=>{ids.add(n.id);if(n.kind==="operation"){visit(n.left);visit(n.right);}};visit(tree);
        return ()=>{let i=1;while(ids.has(`solid-${i}`))i++;const id=`solid-${i}`;ids.add(id);return id;};
    };
    const number=(label:string,value:number,change:(value:number)=>void)=><label style={{display:"block"}}>{label}<input aria-label={label} type="number" step="any" value={value}
        onChange={e=>{if(e.target.value!==""){const value=Number(e.target.value);if(Number.isFinite(value))change(value);}}}/></label>;
    const branch=(node:SolidTree3D,change:(node:SolidTree3D)=>void):React.ReactNode=>{
        const wrap=(operation:SolidOperation3D)=>{const id=freshIds();change({id:id(),kind:"operation",operation,left:node,right:solidLeaf3D(id(),{kind:"box",width:1,height:2,depth:1})});};
        return <fieldset key={node.id} style={{minWidth:0,padding:6}}><legend>Solid {node.id}</legend>
            {node.kind==="operation"?<>
                <label>Operation<select aria-label={`Solid ${node.id} operation`} value={node.operation} onChange={e=>change({...node,operation:e.target.value as SolidOperation3D})}>
                    <option value="add">Add</option><option value="subtract">Subtract</option><option value="intersect">Intersect</option>
                </select></label>
                <button type="button" onClick={()=>change({...node,left:node.right,right:node.left})}>Swap operands {node.id}</button>
                <button type="button" onClick={()=>change(node.left)}>Keep left {node.id}</button>
                <button type="button" onClick={()=>change(node.right)}>Keep right {node.id}</button>
                {branch(node.left,left=>change({...node,left}))}{branch(node.right,right=>change({...node,right}))}
            </>:<>
                <label>Shape<select aria-label={`Solid ${node.id} shape`} value={node.shape.kind} onChange={e=>{
                    const kind=e.target.value as BlockoutShape["kind"],{width,height,depth}=node.shape;
                    const shape:BlockoutShape=kind==="room"?{kind,width,height,depth,thickness:.2,ceiling:false}:kind==="stairs"?{kind,width,height,depth,steps:4}:{kind,width,height,depth};change({...node,shape});
                }}>{["box","wall","room","ramp","stairs"].map(kind=><option key={kind} value={kind}>{kind}</option>)}</select></label>
                {["width","height","depth",...(node.shape.kind==="room"?["thickness"]:[]),...(node.shape.kind==="stairs"?["steps"]:[])].map(key=><React.Fragment key={key}>
                    {number(`Solid ${node.id} ${key}`,(node.shape as unknown as Record<string,number>)[key],value=>change({...node,shape:{...node.shape,[key]:value} as BlockoutShape}))}
                </React.Fragment>)}
                {node.shape.kind==="room"&&<label><input aria-label={`Solid ${node.id} ceiling`} type="checkbox" checked={node.shape.ceiling}
                    onChange={e=>change({...node,shape:{...node.shape,ceiling:e.target.checked} as BlockoutShape})}/>Ceiling</label>}
                {(["position","rotation","scale"] as const).map(field=><div key={field}>{["x","y","z"].map((axis,index)=><React.Fragment key={axis}>
                    {number(`Solid ${node.id} ${field} ${axis}`,node[field][index],value=>change({...node,[field]:node[field].map((v,i)=>i===index?value:v) as unknown as Point3D}))}
                </React.Fragment>)}</div>)}
            </>}
            {(["add","subtract","intersect"] as const).map(operation=><button type="button" key={operation} onClick={()=>wrap(operation)}>{operation} operand {node.id}</button>)}
        </fieldset>;
    };
    return <section aria-label="Solid operations"><p>Operand rotations use degrees, applied X then Y then Z. Solid collision uses the same evaluated shape.</p>
        {error&&<p role="alert">{error} Previous solid retained.</p>}{branch(tree,commit)}</section>;
}
