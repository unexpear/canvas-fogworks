/** @module ConvexContact3D @description Convex-polyhedron and sphere separating-axis contacts for derived blockout geometry. */
import {BlockoutPart,Point3D} from "../geometry/Blockout3D";
import type {Contact3D} from "./Collision3D";
type V=[number,number,number];
export interface ConvexHull3D {vertices:V[];normals:V[];edges:readonly [V,V][]}
export interface ContactSphere3D {center:Point3D;radius:number}
const dot=(a:Point3D,b:Point3D)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:Point3D,b:Point3D):V=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a:Point3D,b:Point3D):V=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(a:Point3D):V|null=>{const size=Math.hypot(...a);return size>0?[a[0]/size,a[1]/size,a[2]/size]:null;};

/** Takes a validated generator part and an affine world matrix, including reflected/nonuniform
 * transforms. Computing planes from transformed vertices also supports affine parent shear. */
export function transformedHull3D(part:BlockoutPart,m:readonly number[]):ConvexHull3D{
    if(m.length!==16||m.some(v=>!Number.isFinite(v))||m[3]!==0||m[7]!==0||m[11]!==0||m[15]!==1)throw new Error("Convex contact requires a finite affine matrix.");
    // Normalize columns before the determinant test to avoid underflow at tiny valid scales.
    const columns=[unit([m[0],m[1],m[2]]),unit([m[4],m[5],m[6]]),unit([m[8],m[9],m[10]])];
    if(columns.some(c=>!c)||Math.abs(dot(columns[0]!,cross(columns[1]!,columns[2]!)))<1e-12)throw new Error("Collapsed or numerically singular convex contact transform.");
    const vertices:V[]=part.vertices.map(p=>[m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]]);
    if(vertices.some(v=>v.some(c=>!Number.isFinite(c))))throw new Error("Convex contact transform overflow.");
    const edges:[V,V][]=[],normals:V[]=[],seen=new Set<string>();
    for(const face of part.faces){
        const a=vertices[face[0]],b=vertices[face[1]],c=vertices[face[2]];
        const normal=unit(cross(sub(b,a),sub(c,a)));if(!normal)throw new Error("Collapsed convex contact face.");normals.push(normal);
        for(let i=0;i<face.length;i++){
            const from=face[i],to=face[(i+1)%face.length],key=from<to?`${from}/${to}`:`${to}/${from}`;
            if(!seen.has(key)){seen.add(key);edges.push([vertices[from],vertices[to]]);}
        }
    }
    return {vertices,normals,edges};
}
function projection(hull:ConvexHull3D,axis:V):[number,number]{
    let low=Infinity,high=-Infinity;for(const point of hull.vertices){const p=dot(point,axis);low=Math.min(low,p);high=Math.max(high,p);}return [low,high];
}
/** Select the smaller *exit distance*, not intersection length: containment needs travel to
 * the outside of the containing interval. The returned normal translates A out of B. */
function separation(axes:Iterable<Point3D>,a:(axis:V)=>[number,number],b:(axis:V)=>[number,number]):Contact3D|null{
    let best:Contact3D|null=null;
    for(const candidate of axes){
        const axis=unit(candidate);if(!axis)continue;
        const [amin,amax]=a(axis),[bmin,bmax]=b(axis),positive=bmax-amin,negative=amax-bmin;
        if(positive<=1e-9||negative<=1e-9)return null;
        const depth=Math.min(positive,negative);
        if(!best||depth<best.depth)best={depth,normal:positive<=negative?axis:axis.map(v=>-v) as V};
    }
    return best;
}
/** 3D SAT needs both face normals AND edge cross products; face normals alone miss skew edges. */
export function convexContact3D(a:ConvexHull3D,b:ConvexHull3D):Contact3D|null{
    function* axes(){yield* a.normals;yield* b.normals;for(const [a0,a1] of a.edges)for(const [b0,b1] of b.edges)yield cross(sub(a1,a0),sub(b1,b0));}
    return separation(axes(),axis=>projection(a,axis),axis=>projection(b,axis));
}
/** Candidate closest features are face interiors, edge segments and vertices. Edge directions
 * are built from the sphere center to the clamped nearest segment point, not an infinite line. */
export function sphereConvexContact3D(sphere:ContactSphere3D,hull:ConvexHull3D):Contact3D|null{
    if(!Number.isFinite(sphere.radius)||sphere.radius<=0||sphere.center.some(v=>!Number.isFinite(v)))throw new Error("Invalid contact sphere.");
    function* axes(){
        yield* hull.normals;
        for(const vertex of hull.vertices)yield sub(sphere.center,vertex);
        for(const [a,b] of hull.edges){
            const edge=sub(b,a),length2=dot(edge,edge);if(!length2)continue;
            const t=Math.max(0,Math.min(1,dot(sub(sphere.center,a),edge)/length2));
            yield sub(sphere.center,[a[0]+edge[0]*t,a[1]+edge[1]*t,a[2]+edge[2]*t]);
        }
    }
    return separation(axes(),axis=>{const p=dot(sphere.center,axis);return [p-sphere.radius,p+sphere.radius];},axis=>projection(hull,axis));
}
