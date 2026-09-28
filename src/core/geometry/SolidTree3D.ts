/** @module SolidTree3D @description Persistable bounded solid-operation trees and shared derived rendering/collision geometry. */
import {BlockoutShape,Point3D,blockoutError,generateBlockout} from "./Blockout3D";
import {SolidCell3D,SolidOperation3D,solidBoolean3D,solidCells3D} from "./SolidBoolean3D";
import {SolidSurfaceMesh3D,solidSurfaceMesh3D} from "./SolidSurface3D";
import {multiplyMat4,nodeMatrix} from "../import/Gltf";
export type SolidTree3D=
    |{id:string;kind:"shape";shape:BlockoutShape;position:Point3D;rotation:Point3D;scale:Point3D}
    |{id:string;kind:"operation";operation:SolidOperation3D;left:SolidTree3D;right:SolidTree3D};
export interface SolidTreeGeometry3D extends SolidSurfaceMesh3D {parts:SolidCell3D[]}
/** Rotations are degrees, applied X then Y then Z; translation follows rotation and scale. */
export function solidLeaf3D(id:string,shape:BlockoutShape):SolidTree3D{
    return {id,kind:"shape",shape:{...shape},position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]};
}
function structureError(value:unknown):string|null{
    const seen=new Set<unknown>(),ids=new Set<string>();let count=0;
    const visit=(item:unknown,depth:number):string|null=>{
        if(!item||typeof item!=="object"||Array.isArray(item))return "Solid tree requires an object.";
        if(++count>31||depth>8)return "Solid tree exceeds 31 nodes or depth 8.";
        if(seen.has(item))return "Solid tree cannot contain cycles or shared branches.";seen.add(item);
        const node=item as Record<string,unknown>;
        if(typeof node.id!=="string"||!/^[A-Za-z0-9_-]{1,64}$/.test(node.id)||ids.has(node.id))return "Solid tree IDs must be unique safe names up to 64 characters.";ids.add(node.id);
        const keys=node.kind==="shape"?["id","kind","shape","position","rotation","scale"]:["id","kind","operation","left","right"];
        if(Object.keys(node).some(key=>!keys.includes(key)))return "Unknown solid tree field.";
        if(node.kind==="shape"){
            const error=blockoutError(node.shape);if(error)return error;
            for(const key of ["position","rotation","scale"]){
                const values=node[key],limit=key==="rotation"?36000:key==="scale"?1000:10000;
                if(!Array.isArray(values)||values.length!==3||values.some(v=>typeof v!=="number"||!Number.isFinite(v)||Math.abs(v)>limit||(key==="scale"&&Math.abs(v)<.001)))return `Invalid solid operand ${key}.`;
            }return null;
        }
        if(node.kind!=="operation"||!["add","subtract","intersect"].includes(node.operation as string))return "Unknown solid tree operation.";
        return visit(node.left,depth+1)??visit(node.right,depth+1);
    };return visit(value,1);
}
function evaluate(node:SolidTree3D):SolidCell3D[]{
    if(node.kind==="operation")return solidBoolean3D(node.operation,evaluate(node.left),evaluate(node.right));
    const [x,y,z]=node.rotation.map(degrees=>degrees*Math.PI/360);
    const rx=nodeMatrix({rotation:[Math.sin(x),0,0,Math.cos(x)]}),ry=nodeMatrix({rotation:[0,Math.sin(y),0,Math.cos(y)]}),rz=nodeMatrix({rotation:[0,0,Math.sin(z),Math.cos(z)]});
    const m=multiplyMat4(nodeMatrix({translation:[...node.position]}),multiplyMat4(rz,multiplyMat4(ry,multiplyMat4(rx,nodeMatrix({scale:[...node.scale]})))));
    const reflected=node.scale[0]*node.scale[1]*node.scale[2]<0;
    return solidCells3D(generateBlockout(node.shape).parts,node.id).map(part=>({...part,
        vertices:part.vertices.map(p=>[m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]] as Point3D),
        faces:reflected?part.faces.map(face=>[...face].reverse()):part.faces}));
}
/** Cache entries are transient, shared read-only results; never persist or mutate their buffers. */
const cache=new Map<string,SolidTreeGeometry3D>();
export function solidTreeGeometry3D(tree:SolidTree3D):SolidTreeGeometry3D{
    const error=structureError(tree);if(error)throw Error(error);
    const key=JSON.stringify(tree),cached=cache.get(key);
    if(cached){cache.delete(key);cache.set(key,cached);return cached;}
    const parts=solidBoolean3D("add",evaluate(tree),[]),result={parts,...solidSurfaceMesh3D(parts)};
    cache.set(key,result);if(cache.size>16)cache.delete(cache.keys().next().value!);return result;
}
/** Includes bounded evaluation so an invalid edit is refused before replacing the saved solid. */
export function solidTreeError(value:unknown):string|null{
    const error=structureError(value);if(error)return error;
    try{solidTreeGeometry3D(value as SolidTree3D);return null;}catch(cause){return cause instanceof Error?cause.message:"Solid evaluation failed.";}
}
