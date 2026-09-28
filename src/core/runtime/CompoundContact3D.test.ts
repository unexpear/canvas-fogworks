/** @module CompoundContact3D.test @description Shared collision dispatch for hollow rooms, ramp contacts, compound unions and primitive compatibility. */
import {contact3D,CollisionShape3D} from "./Collision3D";
import {generateBlockout,BlockoutShape} from "../geometry/Blockout3D";
import {transformedHull3D} from "./ConvexContact3D";
import {nodeMatrix} from "../import/Gltf";
const transform={position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0,w:1},scale:{x:1,y:1,z:1}};
const compound=(shape:BlockoutShape):CollisionShape3D=>({transform,collider:null,convexParts:generateBlockout(shape).parts.map(p=>transformedHull3D(p,nodeMatrix({})))});
const ball=(x:number,y:number,z:number):CollisionShape3D=>({transform:{...transform,position:{x,y,z}},collider:{kind:"sphere",radius:.2}});
test("shared contact entry point preserves hollow space and reverses sphere contact normals",()=>{
    const room=compound({kind:"room",width:4,height:3,depth:6,thickness:.2,ceiling:true});
    expect(contact3D(ball(0,1,0),room)).toBeNull();
    const a=contact3D(ball(1.9,1,0),room)!,b=contact3D(room,ball(1.9,1,0))!;
    expect(a.depth).toBeCloseTo(.1);expect(b.depth).toBeCloseTo(a.depth);
    a.normal.forEach((v,i)=>expect(b.normal[i]).toBeCloseTo(-v));
    expect(a.normal[0]).toBeCloseTo(-1);
});
test("box and compound operands both hit the ramp slope, not its enclosing box",()=>{
    const ramp=compound({kind:"ramp",width:4,height:2,depth:4});
    const box:CollisionShape3D={...ball(0,1.1,0),collider:{kind:"box",halfExtents:{x:.1,y:.1,z:.1}}};
    expect(contact3D(box,ramp)).not.toBeNull();
    box.transform={...box.transform,position:{x:0,y:1.8,z:0}};
    expect(contact3D(box,ramp)).toBeNull();
    const tiny=compound({kind:"box",width:.2,height:.2,depth:.2});
    tiny.convexParts=generateBlockout({kind:"box",width:.2,height:.2,depth:.2}).parts.map(p=>transformedHull3D(p,nodeMatrix({translation:[0,.95,0]})));
    expect(contact3D(tiny,ramp)).not.toBeNull();
});
test("empty unions replace primitive fallbacks, missing shapes do not collide, and part budget is enforced",()=>{
    const sphere=ball(0,0,0),room=compound({kind:"room",width:4,height:3,depth:6,thickness:.2,ceiling:false});
    expect(contact3D({...sphere,convexParts:[]},room)).toBeNull();
    expect(contact3D({transform,collider:null},room)).toBeNull();
    expect(()=>contact3D({...room,convexParts:Array(257).fill(room.convexParts![0])},sphere)).toThrow("256");
});
test("compound correction is immutable and requery separates from an individual floor",()=>{
    const room=compound({kind:"room",width:4,height:3,depth:6,thickness:.2,ceiling:false}),sphere=ball(0,.1,0),before=JSON.stringify(room);
    const hit=contact3D(sphere,room)!;
    const p=sphere.transform.position;
    const corrected={...sphere,transform:{...sphere.transform,position:{x:p.x+hit.normal[0]*hit.depth,y:p.y+hit.normal[1]*hit.depth,z:p.z+hit.normal[2]*hit.depth}}};
    expect(contact3D(corrected,room)).toBeNull();expect(JSON.stringify(room)).toBe(before);
});
