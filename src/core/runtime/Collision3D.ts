/**
 * @module Collision3D
 * @description Oriented box, sphere and prepared compound contacts; returns normal and penetration depth for deterministic runtime resolution.
 */
import { Collider3D, Transform3D } from "../document/Spatial3D";
import { nodeMatrix } from "../import/Gltf";
import {compoundContact3D} from "./CompoundContact3D";
import type {ConvexHull3D} from "./ConvexContact3D";
type V = [number, number, number];
export interface CollisionShape3D {
    transform: Transform3D; collider: Collider3D | null;
    /** Transient world-space convex parts, prepared by the runtime projection, never persisted.
     * When present these replace the primitive collider; [] explicitly means no solid volume. */
    convexParts?:readonly ConvexHull3D[];
}
export interface Contact3D { normal: V; depth: number; }
const dot = (a: V, b: V) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub = (a: V, b: V): V => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross = (a: V, b: V): V => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function geometry(body: CollisionShape3D) {
    const t = body.transform, q = t.rotation;
    const m = nodeMatrix({ rotation: [q.x,q.y,q.z,q.w] });
    const axes: V[] = [[m[0],m[1],m[2]],[m[4],m[5],m[6]],[m[8],m[9],m[10]]];
    const center: V = [t.position.x,t.position.y,t.position.z];
    const radius = body.collider?.kind === "sphere" ? body.collider.radius * Math.max(Math.abs(t.scale.x),Math.abs(t.scale.y),Math.abs(t.scale.z)) : 0;
    const half: V = body.collider?.kind === "box" ? [Math.abs(t.scale.x*body.collider.halfExtents.x),Math.abs(t.scale.y*body.collider.halfExtents.y),Math.abs(t.scale.z*body.collider.halfExtents.z)] : [radius,radius,radius];
    return { axes, center, half, radius };
}
/** The normal points from B toward A. Touching alone is not penetration. */
export function contact3D(a: CollisionShape3D, b: CollisionShape3D): Contact3D | null {
    if(a.convexParts!==undefined||b.convexParts!==undefined)return compoundContact3D(a,b);
    if (!a.collider || !b.collider) return null;
    const ga = geometry(a), gb = geometry(b), delta = sub(ga.center,gb.center);
    if (a.collider.kind === "sphere" && b.collider.kind === "sphere") {
        const length = Math.hypot(...delta), depth = ga.radius+gb.radius-length;
        return depth > 1e-9 ? { depth, normal: length > 1e-9 ? delta.map(v=>v/length) as V : [1,0,0] } : null;
    }
    if (a.collider.kind === "box" && b.collider.kind === "sphere") {
        const contact = contact3D(b,a); return contact ? { depth: contact.depth, normal: contact.normal.map(v=>-v) as V } : null;
    }
    if (a.collider.kind === "sphere") {
        const local = gb.axes.map(axis=>dot(delta,axis));
        const nearest = local.map((v,i)=>Math.max(-gb.half[i],Math.min(gb.half[i],v)));
        const offset: V = [0,0,0];
        for (let i=0;i<3;i++) for(let k=0;k<3;k++) offset[k] += gb.axes[i][k]*(local[i]-nearest[i]);
        const distance = Math.hypot(...offset);
        if (distance > 1e-9) return distance < ga.radius ? { normal: offset.map(v=>v/distance) as V, depth: ga.radius-distance } : null;
        let face=0; for(let i=1;i<3;i++) if(gb.half[i]-Math.abs(local[i])<gb.half[face]-Math.abs(local[face])) face=i;
        return { normal: gb.axes[face].map(v=>v*(local[face]<0?-1:1)) as V, depth: ga.radius+gb.half[face]-Math.abs(local[face]) };
    }
    const candidates = [...ga.axes,...gb.axes,...ga.axes.flatMap(aa=>gb.axes.map(bb=>cross(aa,bb)))];
    let best: Contact3D | null = null;
    for(const candidate of candidates) {
        const length=Math.hypot(...candidate); if(length<1e-9) continue;
        const normal=candidate.map(v=>v/length) as V;
        const ra=ga.axes.reduce((sum,axis,i)=>sum+Math.abs(dot(axis,normal))*ga.half[i],0);
        const rb=gb.axes.reduce((sum,axis,i)=>sum+Math.abs(dot(axis,normal))*gb.half[i],0);
        const signed=dot(delta,normal), depth=ra+rb-Math.abs(signed);
        if(depth<=1e-9) return null;
        if(!best || depth<best.depth) best={ depth,normal: normal.map(v=>v*(signed<0?-1:1)) as V };
    }
    return best;
}
