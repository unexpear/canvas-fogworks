/** @module SolidSurface3D @description Exterior-only drawable surfaces from convex solid cells, with bounded clipping and retained material-face identities. */
import {Point3D} from "./Blockout3D";
import {SolidCell3D,solidBoolean3D,SOLID_EPSILON_3D} from "./SolidBoolean3D";
import {MeshPrimitive} from "../import/MeshData";
export interface SolidSurface3D {points:Point3D[];normal:Point3D;surfaceId:string}
export interface SolidSurfaceMesh3D {mesh:MeshPrimitive;surfaces:SolidSurface3D[];triangleSurfaceIds:string[]}
const EPS=SOLID_EPSILON_3D;
const sub=(a:Point3D,b:Point3D):Point3D=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot=(a:Point3D,b:Point3D)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:Point3D,b:Point3D):Point3D=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function unit(v:Point3D):Point3D{const length=Math.hypot(...v);if(!length)throw Error("Degenerate solid surface.");return [v[0]/length,v[1]/length,v[2]/length];}
function normal(points:readonly Point3D[]):Point3D{
    let best:Point3D=[0,0,0];for(let i=1;i<points.length-1;i++){
        const n=cross(sub(points[i],points[0]),sub(points[i+1],points[0]));if(Math.hypot(...n)>Math.hypot(...best))best=n;
    }return unit(best);
}
type Plane={origin:Point3D;normal:Point3D};
const distance=(p:Point3D,plane:Plane)=>dot(sub(p,plane.origin),plane.normal);
function clean(points:Point3D[]):Point3D[]{
    const result=points.filter((p,i)=>Math.hypot(...sub(p,points[(i+points.length-1)%points.length]))>EPS);
    let changed=true;
    while(changed&&result.length>=3){changed=false;for(let i=0;i<result.length;i++){
        const a=result[(i+result.length-1)%result.length],b=result[i],c=result[(i+1)%result.length],ac=sub(c,a),ab=sub(b,a);
        if(Math.hypot(...cross(ac,ab))<=EPS*Math.hypot(...ac)&&dot(ab,sub(b,c))<=0){result.splice(i,1);changed=true;break;}
    }}return result.length>=3?result:[];
}
function half(points:readonly Point3D[],distances:readonly number[],sign:number):Point3D[]{
    const result:Point3D[]=[];
    for(let i=0;i<points.length;i++){
        const j=(i+1)%points.length,a=points[i],b=points[j],da=distances[i]*sign,db=distances[j]*sign;
        if(da<=0)result.push(a);
        if((da<0&&db>0)||(da>0&&db<0)){const t=da/(da-db);result.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]);}
    }return clean(result);
}
/** Remove the region covered by a convex neighbor. Coplanar faces count as inside for coverage,
 * unlike full-volume clipping where a plane-only result is empty. */
function uncovered(points:Point3D[],planes:readonly Plane[],spend:(n:number)=>void):Point3D[][]{
    let inside=points;const outside:Point3D[][]=[];
    for(const plane of planes){
        if(!inside.length)break;spend(inside.length);
        const ds=inside.map(p=>{const d=distance(p,plane);return Math.abs(d)<=EPS?0:d;});
        if(ds.every(d=>d<=0))continue;
        if(ds.every(d=>d>=0)){outside.push(inside);inside=[];break;}
        const piece=half(inside,ds,-1);if(piece.length)outside.push(piece);
        inside=half(inside,ds,1);
    }return outside;
}
/** Validates/normalizes cells before boundary extraction. Shared faces, including partial
 * coplanar overlaps, are removed on both sides. Output is a render triangle soup, not a welded
 * manifold mesh; positional T-junction welding remains a separate export concern. */
export function solidSurfaceMesh3D(input:readonly SolidCell3D[]):SolidSurfaceMesh3D{
    const cells=solidBoolean3D("add",input,[]);
    const cellPlanes=cells.map(cell=>cell.faces.map(face=>{const points=face.map(i=>cell.vertices[i]);return {origin:points[0],normal:normal(points)};}));
    let work=0;const spend=(count:number)=>{work+=count;if(work>1_000_000)throw Error("Solid surface extraction exceeds its work budget.");};
    const surfaces:SolidSurface3D[]=[];
    for(let c=0;c<cells.length;c++)for(let f=0;f<cells[c].faces.length;f++){
        const source=cells[c],plane=cellPlanes[c][f];let pieces=[source.faces[f].map(i=>source.vertices[i])];
        for(let other=0;other<cells.length&&pieces.length;other++){
            if(other===c)continue;spend(cells[other].vertices.length);
            // A neighbor entirely behind this outward face cannot cover its exterior side.
            if(!cells[other].vertices.some(p=>distance(p,plane)>EPS))continue;
            const next:Point3D[][]=[];
            for(const polygon of pieces){next.push(...uncovered(polygon,cellPlanes[other],spend));if(next.length>16384)throw Error("Solid surface fragmentation exceeds 16384 polygons.");}
            pieces=next;
        }
        for(const points of pieces){
            if(surfaces.length>=16384)throw Error("Solid surface fragmentation exceeds 16384 polygons.");
            surfaces.push({points:points.map(p=>[...p] as Point3D),normal:[...plane.normal] as Point3D,surfaceId:source.surfaceIds[f]});
        }
    }
    const positions:number[]=[],normals:number[]=[],uvs:number[]=[],indices:number[]=[],triangleSurfaceIds:string[]=[];
    for(const surface of surfaces){
        const n=surface.normal,axis=n.map(Math.abs).indexOf(Math.min(...n.map(Math.abs)));
        const seed:Point3D=axis===0?[1,0,0]:axis===1?[0,1,0]:[0,0,1],u=unit(cross(seed,n)),v=cross(n,u),base=positions.length/3;
        for(const p of surface.points){positions.push(...p);normals.push(...n);uvs.push(dot(p,u),dot(p,v));}
        for(let i=1;i<surface.points.length-1;i++){indices.push(base,base+i,base+i+1);triangleSurfaceIds.push(surface.surfaceId);}
    }
    const mesh:MeshPrimitive={positions:new Float32Array(positions),normals:new Float32Array(normals),uvs:new Float32Array(uvs),indices:new Uint32Array(indices),material:null};
    // A double-precision valid sliver can collapse when converted into GPU float buffers.
    // Refuse the result rather than render geometry that no longer matches collision.
    for(let i=0;i<indices.length;i+=3){
        const points=[0,1,2].map(j=>{const at=indices[i+j]*3;return [mesh.positions[at],mesh.positions[at+1],mesh.positions[at+2]] as Point3D;});
        const at=indices[i]*3,n:Point3D=[mesh.normals![at],mesh.normals![at+1],mesh.normals![at+2]];
        if(dot(cross(sub(points[1],points[0]),sub(points[2],points[0])),n)<=0)throw Error("Solid surface loses precision in GPU coordinates.");
    }
    return {mesh,surfaces,triangleSurfaceIds};
}
