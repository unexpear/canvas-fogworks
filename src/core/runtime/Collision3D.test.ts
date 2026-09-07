/**
 * @module Collision3D.test
 * @description Rotation-sensitive contacts, exact sphere corners, and deterministic opt-in gravity/restitution with owned geometry.
 */
import { contact3D, CollisionShape3D } from "./Collision3D";
import { createEmptyDocument } from "../document/Document";
import { advanceWorld3D, world3DFrom } from "./World3D";
const box = (x: number, y: number, angle = 0): CollisionShape3D => ({ transform: {
    position: { x,y,z:0 }, scale:{x:1,y:1,z:1}, rotation:{x:0,y:0,z:Math.sin(angle/2),w:Math.cos(angle/2)}
}, collider:{kind:"box",halfExtents:{x:2,y:.1,z:.1}} });
test("rotated thin boxes contact where axis-aligned bounds would miss", () => {
    expect(contact3D(box(0,0), box(0,1,Math.PI/2))).not.toBeNull();
    expect(contact3D(box(0,0), box(0,1))).toBeNull();
});
test("sphere/box corners use distance rather than an expanded bounding box", () => {
    const b = box(0,0); b.collider={kind:"box",halfExtents:{x:1,y:1,z:1}};
    const sphere=box(1.8,1.8); sphere.collider={kind:"sphere",radius:1};
    expect(contact3D(sphere,b)).toBeNull();
    sphere.transform.position={x:1.5,y:1.5,z:0};
    expect(contact3D(sphere,b)?.depth).toBeCloseTo(1-Math.sqrt(.5));
});
test("opt-in gravity and restitution bounce on static ground without changing authored transforms", () => {
    const doc=createEmptyDocument();
    const ball=box(0,2); ball.collider={kind:"sphere",radius:.5};
    const floor=box(0,0); floor.collider={kind:"box",halfExtents:{x:5,y:.1,z:5}};
    for(const [id,shape] of [["ball",ball],["floor",floor]] as const) doc.nodes.set(id, { id,type:"core.rectangle",parent:null,children:[],geometry:{x:0,y:0,width:10,height:10},style:{fill:"red",opacity:1},layout:{},
        entity:id==="ball"?{body:"dynamic",gravity3d:9.81,restitution3d:.8}:{body:"static"},spatial3d:{transform:shape.transform,collider:shape.collider!} });
    doc.rootNodeUuids=["ball","floor"];
    let world=world3DFrom(doc), bounced=false;
    for(let i=0;i<120;i++) { world=advanceWorld3D(doc,world,1/60); if(world.bodies.get("ball")!.velocity.y>1) bounced=true; }
    expect(bounced).toBe(true); expect(world.bodies.get("ball")!.transform.position.y).toBeGreaterThanOrEqual(.6-1e-6);
    expect(doc.nodes.get("ball")!.spatial3d!.transform.position.y).toBe(2);
});
