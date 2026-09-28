/** @module CompoundContact3D @description Bounded compound-part collision dispatch with exact convex/sphere tests and conservative bounds pruning. */
import type {CollisionShape3D,Contact3D} from "./Collision3D";
import {ConvexHull3D,ContactSphere3D,convexContact3D,sphereConvexContact3D,transformedHull3D} from "./ConvexContact3D";
import {generateBlockout} from "../geometry/Blockout3D";
import {nodeMatrix} from "../import/Gltf";
type V=[number,number,number];
type Bound={min:V;max:V};
type Part={hull:ConvexHull3D;bounds:Bound}|{sphere:ContactSphere3D;bounds:Bound};
const rawBox=generateBlockout({kind:"box",width:2,height:2,depth:2}).parts[0];
const centeredBox={...rawBox,vertices:rawBox.vertices.map(v=>[v[0],v[1]-1,v[2]] as const)};
function bounds(hull:ConvexHull3D):Bound{
    const min:V=[Infinity,Infinity,Infinity],max:V=[-Infinity,-Infinity,-Infinity];
    for(const vertex of hull.vertices)for(let i=0;i<3;i++){min[i]=Math.min(min[i],vertex[i]);max[i]=Math.max(max[i],vertex[i]);}
    return {min,max};
}
function parts(shape:CollisionShape3D):Part[]{
    if(shape.convexParts!==undefined){
        if(shape.convexParts.length>256)throw new Error("Compound contact exceeds 256 convex parts.");
        return shape.convexParts.map(hull=>({hull,bounds:bounds(hull)}));
    }
    const {collider,transform:{position:p,rotation:q,scale:s}}=shape;if(!collider)return [];
    if(collider.kind==="sphere"){
        // Match the established sphere contract: nonuniform scale uses its largest magnitude.
        const radius=collider.radius*Math.max(Math.abs(s.x),Math.abs(s.y),Math.abs(s.z)),center:V=[p.x,p.y,p.z];
        return [{sphere:{center,radius},bounds:{min:center.map(v=>v-radius) as V,max:center.map(v=>v+radius) as V}}];
    }
    const half=collider.halfExtents;
    const hull=transformedHull3D(centeredBox,nodeMatrix({translation:[p.x,p.y,p.z],rotation:[q.x,q.y,q.z,q.w],scale:[s.x*half.x,s.y*half.y,s.z*half.z]}));
    return [{hull,bounds:bounds(hull)}];
}
/** Returns the deepest individual part contact, not a claimed global separating vector for
 * a concave union. Movement must re-query after each correction and retain its iteration cap
 * and last-safe-position fallback when several walls constrain a body simultaneously. */
export function compoundContact3D(a:CollisionShape3D,b:CollisionShape3D):Contact3D|null{
    const aa=parts(a),bb=parts(b);let best:Contact3D|null=null;
    for(const pa of aa)for(const pb of bb){
        if([0,1,2].some(i=>pa.bounds.max[i]<=pb.bounds.min[i]||pb.bounds.max[i]<=pa.bounds.min[i]))continue;
        let hit:Contact3D|null;
        if("hull" in pa&&"hull" in pb)hit=convexContact3D(pa.hull,pb.hull);
        else if("sphere" in pa&&"hull" in pb)hit=sphereConvexContact3D(pa.sphere,pb.hull);
        else if("hull" in pa&&"sphere" in pb){
            const reverse=sphereConvexContact3D(pb.sphere,pa.hull);
            hit=reverse?{depth:reverse.depth,normal:reverse.normal.map(v=>-v) as V}:null;
        }else throw new Error("Compound contact dispatch requires a convex operand.");
        if(hit&&(!best||hit.depth>best.depth))best=hit;
    }
    return best;
}
