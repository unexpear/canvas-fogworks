/** @module Blockout3D.test @description Blockout volume, winding, closed convex parts, dimensions, parameter bounds and isolation. */
import {BlockoutShape,generateBlockout,blockoutError} from "./Blockout3D";
const shapes:BlockoutShape[]=[{kind:"box",width:4,height:3,depth:6},{kind:"wall",width:4,height:3,depth:.2},
    {kind:"ramp",width:4,height:3,depth:6},{kind:"stairs",width:4,height:3,depth:6,steps:8},
    {kind:"room",width:4,height:3,depth:6,thickness:.2,ceiling:true}];
function volume(shape:BlockoutShape){
    const {positions:p,indices:ix}=generateBlockout(shape).mesh;let sum=0;
    for(let i=0;i<ix.length;i+=3){const a=ix[i]*3,b=ix[i+1]*3,c=ix[i+2]*3;
        sum+=(p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])+p[a+1]*(p[b+2]*p[c]-p[b]*p[c+2])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;}
    return sum;
}
test.each(shapes)("$kind produces closed convex parts and outward triangles with unit normals",shape=>{
    const {parts,mesh}=generateBlockout(shape),p=mesh.positions,n=mesh.normals!;
    expect(mesh.uvs!.length).toBe(p.length/3*2);expect(n.length).toBe(p.length);
    for(const part of parts){
        const edges=new Map<string,number>();
        for(const face of part.faces)for(let i=0;i<face.length;i++){
            const a=face[i],b=face[(i+1)%face.length],key=[a,b].sort((x,y)=>x-y).join("/");edges.set(key,(edges.get(key)??0)+1);
        }
        expect([...edges.values()].every(count=>count===2)).toBe(true);
        for(const face of part.faces){
            const [a,b,c]=face.map(i=>part.vertices[i]),u=[0,1,2].map(j=>b[j]-a[j]),v=[0,1,2].map(j=>c[j]-a[j]);
            const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
            // Every vertex lies on or inside every outward face plane: convexity, not merely
            // a mesh whose normals happen to agree with its own triangle winding.
            for(const point of part.vertices)expect(normal.reduce((sum,n,j)=>sum+n*(point[j]-a[j]),0)).toBeLessThanOrEqual(1e-9);
        }
    }
    for(let i=0;i<mesh.indices.length;i+=3){
        const [a,b,c]=[0,1,2].map(j=>mesh.indices[i+j]*3),u=[0,1,2].map(j=>p[b+j]-p[a+j]),v=[0,1,2].map(j=>p[c+j]-p[a+j]);
        const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
        expect(cross.reduce((sum,value,j)=>sum+value*n[a+j],0)).toBeGreaterThan(0);
        expect(Math.hypot(n[a],n[a+1],n[a+2])).toBeCloseTo(1);
    }
    expect(volume(shape)).toBeGreaterThan(0);
});
test("generated volumes match box, wedge, stairs and hollow room specifications",()=>{
    expect(volume(shapes[0])).toBeCloseTo(72);expect(volume(shapes[2])).toBeCloseTo(36);
    expect(volume(shapes[3])).toBeCloseTo(72*9/16);
    expect(volume(shapes[4])).toBeCloseTo(4.4*3.4*6.4-72,4);
    const room=shapes[4] as Extract<BlockoutShape,{kind:"room"}>;
    expect(generateBlockout({...room,ceiling:false}).parts.map(p=>p.id)).not.toContain("ceiling");
});
test("stairs reach the requested height and repeated generation never shares mutable buffers",()=>{
    const first=generateBlockout(shapes[3]),second=generateBlockout(shapes[3]);
    expect(first).toEqual(second);expect(first.parts).toHaveLength(8);
    expect(Math.max(...first.parts[7].vertices.map(v=>v[1]))).toBe(3);
    first.mesh.positions.fill(99);first.parts[0].faces[0].reverse();
    expect(generateBlockout(shapes[3])).toEqual(second);
});
test("bad dimensions, excessive steps, unknown keys and malformed room settings fail before generation",()=>{
    for(const value of [null,{}, {...shapes[0],width:NaN},{...shapes[0],depth:Infinity},{...shapes[0],height:0},
        {...shapes[0],width:10001},{...shapes[0],typo:1},{...shapes[3],steps:257},{...shapes[3],steps:1.5},{...shapes[4],ceiling:"yes"}])expect(blockoutError(value)).not.toBeNull();
    expect(()=>generateBlockout({...shapes[0],width:-1})).toThrow("width");
    expect(generateBlockout({kind:"stairs",width:.001,height:.001,depth:.001,steps:256}).parts).toHaveLength(256);
});
