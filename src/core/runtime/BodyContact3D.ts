/** @module BodyContact3D @description Runtime collision projection from local solid parts and current parent transforms. */
import type {Body3D} from "./World3D";
import type {ReadonlyDocument} from "../document/Document";
import {Transform3D,Vec3,IDENTITY_TRANSFORM_3D} from "../document/Spatial3D";
import {generateBlockout} from "../geometry/Blockout3D";
import {solidTreeGeometry3D} from "../geometry/SolidTree3D";
import {nodeMatrix,multiplyMat4} from "../import/Gltf";
import {transformedHull3D} from "./ConvexContact3D";
import {CollisionShape3D,contact3D} from "./Collision3D";

const identity=nodeMatrix({});
const unitBox=generateBlockout({kind:"box",width:2,height:2,depth:2}).parts[0];
const centeredBox={...unitBox,vertices:unitBox.vertices.map(v=>[v[0],v[1]-1,v[2]] as const)};
function matrix(t:Transform3D):number[]{
    const {position:p,rotation:q,scale:s}=t;
    return nodeMatrix({translation:[p.x,p.y,p.z],rotation:[q.x,q.y,q.z,q.w],scale:[s.x,s.y,s.z]});
}
/** Copies authored collision into transient local parts; no derived buffers enter saved progress. */
export function bodyGeometry3D(doc:ReadonlyDocument,id:string):Pick<Body3D,"parentBodyId"|"solidParts">{
    const node=doc.nodes.get(id);let parent=node?.parent;const seen=new Set<string>([id]);
    while(parent){
        if(seen.has(parent))throw new Error("Cyclic 3D collision hierarchy.");seen.add(parent);
        const ancestor=doc.nodes.get(parent);if(!ancestor)throw new Error("Missing 3D collision ancestor.");
        if(ancestor.spatial3d)break;parent=ancestor.parent;
    }
    const spatial=node?.spatial3d;
    return {parentBodyId:parent??null,...(spatial?.blockoutCollision&&(spatial.blockout||spatial.solidTree)?
        {solidParts:spatial.solidTree?solidTreeGeometry3D(spatial.solidTree).parts:generateBlockout(spatial.blockout!).parts}:{})};
}
export function bodyWorldMatrix3D(bodies:ReadonlyMap<string,Body3D>,body:Body3D):number[]{
    let result=matrix(body.transform),parent=body.parentBodyId;const seen=new Set([body.nodeId]);
    while(parent){
        if(seen.has(parent))throw new Error("Cyclic runtime collision hierarchy.");seen.add(parent);
        const ancestor=bodies.get(parent);if(!ancestor)throw new Error("Missing runtime collision ancestor.");
        result=multiplyMat4(matrix(ancestor.transform),result);parent=ancestor.parentBodyId;
    }
    return result;
}
function parentMatrix(bodies:ReadonlyMap<string,Body3D>,body:Body3D):number[]{
    if(!body.parentBodyId)return identity;
    const parent=bodies.get(body.parentBodyId);if(!parent)throw new Error("Missing runtime collision ancestor.");
    return bodyWorldMatrix3D(bodies,parent);
}
/** Lower bound on length scaling, including shear produced by composed TRS ancestors. */
export function parentMinimumScale3D(bodies:ReadonlyMap<string,Body3D>,body:Body3D):number{
    let scale=1,parent=body.parentBodyId;const seen=new Set([body.nodeId]);
    while(parent){
        if(seen.has(parent))throw new Error("Cyclic runtime collision hierarchy.");seen.add(parent);
        const ancestor=bodies.get(parent);if(!ancestor)throw new Error("Missing runtime collision ancestor.");
        const s=ancestor.transform.scale;scale*=Math.min(Math.abs(s.x),Math.abs(s.y),Math.abs(s.z));parent=ancestor.parentBodyId;
    }
    return scale;
}
/** Converts a world displacement (not a point) back through the parent's linear transform. */
export function localDisplacement3D(bodies:ReadonlyMap<string,Body3D>,body:Body3D,v:Vec3):Vec3{
    const m=parentMatrix(bodies,body),a=m[0],b=m[4],c=m[8],d=m[1],e=m[5],f=m[9],g=m[2],h=m[6],i=m[10];
    const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
    if(!Number.isFinite(det)||det===0)throw new Error("Singular collision parent transform.");
    return {x:((e*i-f*h)*v.x+(c*h-b*i)*v.y+(b*f-c*e)*v.z)/det,
        y:((f*g-d*i)*v.x+(a*i-c*g)*v.y+(c*d-a*f)*v.z)/det,
        z:((d*h-e*g)*v.x+(b*g-a*h)*v.y+(a*e-b*d)*v.z)/det};
}
export function worldDisplacement3D(bodies:ReadonlyMap<string,Body3D>,body:Body3D,v:Vec3):Vec3{
    const m=parentMatrix(bodies,body);
    return {x:m[0]*v.x+m[4]*v.y+m[8]*v.z,y:m[1]*v.x+m[5]*v.y+m[9]*v.z,z:m[2]*v.x+m[6]*v.y+m[10]*v.z};
}
function worldShape(bodies:ReadonlyMap<string,Body3D>,body:Body3D):CollisionShape3D{
    const m=bodyWorldMatrix3D(bodies,body);
    if(body.solidParts)return {...body,convexParts:body.solidParts.map(p=>transformedHull3D(p,m))};
    if(body.collider?.kind==="box"){
        const h=body.collider.halfExtents,scaled=multiplyMat4(m,nodeMatrix({scale:[h.x,h.y,h.z]}));
        return {...body,convexParts:[transformedHull3D(centeredBox,scaled)]};
    }
    // A sphere stays spherical. The product of ancestor maximum scales is a conservative
    // radius under parent shear, preserving the established nonuniform-sphere convention.
    let radius=body.collider?.kind==="sphere"?body.collider.radius:0,current:Body3D|undefined=body;
    while(current){const s=current.transform.scale;radius*=Math.max(Math.abs(s.x),Math.abs(s.y),Math.abs(s.z));current=current.parentBodyId?bodies.get(current.parentBodyId):undefined;}
    return {transform:{...IDENTITY_TRANSFORM_3D,position:{x:m[12],y:m[13],z:m[14]}},collider:body.collider?{kind:"sphere",radius}:null};
}
/** Legacy primitive pairs keep their existing local-space semantics. Solid pairs use world
 * contacts; callers must convert corrections and velocities through the moving body's parent. */
export function bodyContact3D(bodies:ReadonlyMap<string,Body3D>,a:Body3D,b:Body3D){
    return a.solidParts||b.solidParts?contact3D(worldShape(bodies,a),worldShape(bodies,b)):contact3D(a,b);
}
