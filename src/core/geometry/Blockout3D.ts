/** @module Blockout3D @description Bounded parameterized blockout solids and derived outward-wound meshes in right-handed Y-up space. */
import {MeshPrimitive} from "../import/MeshData";
export type Point3D=readonly [number,number,number];
export type BlockoutShape=
    | {kind:"box"|"wall"|"ramp";width:number;height:number;depth:number}
    | {kind:"stairs";width:number;height:number;depth:number;steps:number}
    | {kind:"room";width:number;height:number;depth:number;thickness:number;ceiling:boolean};
/** Transient convex parts, not a second document/scene representation. Face indices wind outward. */
export interface BlockoutPart {id:string;vertices:Point3D[];faces:number[][]}
export interface BlockoutGeometry {parts:BlockoutPart[];mesh:MeshPrimitive}
export const BLOCKOUT_STEPS_MAX=256;
const subtract=(a:Point3D,b:Point3D):Point3D=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a:Point3D,b:Point3D):Point3D=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:Point3D,b:Point3D)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
function unit(v:Point3D):Point3D{const length=Math.hypot(...v);if(!length)throw new Error("Degenerate blockout face.");return [v[0]/length,v[1]/length,v[2]/length];}
/** Reject unknown fields and unsafe dimensions before allocating generated data. */
export function blockoutError(value:unknown):string|null{
    if(!value||typeof value!=="object"||Array.isArray(value))return "Blockout requires a shape object.";
    const v=value as Record<string,unknown>;
    if(!["box","wall","ramp","stairs","room"].includes(v.kind as string))return "Unknown blockout shape.";
    const keys=["kind","width","height","depth",...(v.kind==="stairs"?["steps"]:v.kind==="room"?["thickness","ceiling"]:[])];
    if(Object.keys(v).some(key=>!keys.includes(key)))return "Unknown blockout parameter.";
    for(const key of ["width","height","depth",...(v.kind==="room"?["thickness"]:[])]){
        const size=v[key];if(typeof size!=="number"||!Number.isFinite(size)||size<.001||size>10000)return `Blockout ${key} must be between 0.001 and 10000.`;
    }
    if(v.kind==="stairs"&&(!Number.isInteger(v.steps)||(v.steps as number)<1||(v.steps as number)>BLOCKOUT_STEPS_MAX))return "Stairs require 1–256 whole steps.";
    if(v.kind==="room"&&typeof v.ceiling!=="boolean")return "Room ceiling must be true or false.";
    return null;
}
function part(id:string,vertices:Point3D[],faces:number[][]):BlockoutPart{
    const mean=(axis:number)=>vertices.reduce((sum,v)=>sum+v[axis],0)/vertices.length;
    const center:Point3D=[mean(0),mean(1),mean(2)];
    return {id,vertices,faces:faces.map(indices=>{
        const [a,b,c]=indices.map(i=>vertices[i]),normal=cross(subtract(b,a),subtract(c,a));
        return dot(normal,subtract(a,center))<0?[...indices].reverse():[...indices];
    })};
}
function box(id:string,x0:number,x1:number,y0:number,y1:number,z0:number,z1:number):BlockoutPart{
    return part(id,[[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]],
        [[0,1,2,3],[4,5,6,7],[0,4,5,1],[3,2,6,7],[0,3,7,4],[1,5,6,2]]);
}
function meshFrom(parts:readonly BlockoutPart[]):MeshPrimitive{
    const positions:number[]=[],normals:number[]=[],uvs:number[]=[],indices:number[]=[];
    for(const solid of parts)for(const face of solid.faces){
        const a=solid.vertices[face[0]],b=solid.vertices[face[1]],c=solid.vertices[face[2]];
        const normal=unit(cross(subtract(b,a),subtract(c,a))),u=unit(subtract(b,a)),v=cross(normal,u),base=positions.length/3;
        for(const index of face){const point=solid.vertices[index],relative=subtract(point,a);positions.push(...point);normals.push(...normal);uvs.push(dot(relative,u),dot(relative,v));}
        for(let i=1;i<face.length-1;i++)indices.push(base,base+i,base+i+1);
    }
    return {positions:new Float32Array(positions),normals:new Float32Array(normals),uvs:new Float32Array(uvs),indices:new Uint32Array(indices),material:null};
}
/** Floor is y=0, width centered on x, depth centered on z; stairs/ramp rise toward +z.
 * Room dimensions describe usable interior space; thickness grows outward. Parts meet without
 * overlapping volumes. Shared internal faces remain until the later solid-union evaluation. */
export function generateBlockout(shape:BlockoutShape):BlockoutGeometry{
    const error=blockoutError(shape);if(error)throw new Error(error);
    const {width:w,height:h,depth:d}=shape,parts:BlockoutPart[]=[];
    if(shape.kind==="room"){
        const t=shape.thickness;
        parts.push(box("floor",-w/2-t,w/2+t,-t,0,-d/2-t,d/2+t));
        parts.push(box("left",-w/2-t,-w/2,0,h,-d/2,d/2),box("right",w/2,w/2+t,0,h,-d/2,d/2));
        parts.push(box("back",-w/2-t,w/2+t,0,h,-d/2-t,-d/2),box("front",-w/2-t,w/2+t,0,h,d/2,d/2+t));
        if(shape.ceiling)parts.push(box("ceiling",-w/2-t,w/2+t,h,h+t,-d/2-t,d/2+t));
    }else if(shape.kind==="stairs"){
        for(let i=0;i<shape.steps;i++)parts.push(box(`step-${i}`,-w/2,w/2,0,h*(i+1)/shape.steps,-d/2+d*i/shape.steps,-d/2+d*(i+1)/shape.steps));
    }else if(shape.kind==="ramp"){
        parts.push(part("ramp",[[-w/2,0,-d/2],[w/2,0,-d/2],[-w/2,0,d/2],[w/2,0,d/2],[-w/2,h,d/2],[w/2,h,d/2]],
            [[0,1,3,2],[2,3,5,4],[0,4,5,1],[0,2,4],[1,5,3]]));
    }else parts.push(box(shape.kind,-w/2,w/2,0,h,-d/2,d/2));
    return {parts,mesh:meshFrom(parts)};
}
