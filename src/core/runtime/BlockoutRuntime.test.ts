/** @module BlockoutRuntime.test @description Saved blockout solid activation, live movement, hierarchy and restored spawned collision. */
import {gameplayFixture} from "../tests/fixtures/GameplayFixture";
import {world3DFrom,stepWorld3D,queryCollisions3D} from "./World3D";
import {applyRules3D} from "./Gameplay3D";
import {bodyContact3D,bodyWorldMatrix3D,localDisplacement3D,worldDisplacement3D} from "./BodyContact3D";
import {deserializeDocument,serializeDocument} from "../document/Serializer";
import {captureProgress3D,restoreProgress3D} from "../../runtime/PlayerProgress";
function roomFixture(){
    const doc=gameplayFixture(),room=doc.nodes.get("lever")!;
    room.entity={body:"static"};room.spatial3d!.transform.position={x:0,y:0,z:0};
    room.spatial3d!.blockout={kind:"room",width:4,height:3,depth:4,thickness:.2,ceiling:false};
    room.spatial3d!.blockoutCollision=true;
    doc.nodes.get("player")!.spatial3d!.transform.position={x:0,y:1,z:0};return doc;
}
test("reopened opt-in rooms preserve empty interiors, stop movement and leave authored state untouched",()=>{
    const doc=deserializeDocument(serializeDocument(roomFixture())),before=serializeDocument(doc);
    let world=world3DFrom(doc);expect(queryCollisions3D(world,"player")).toEqual([]);
    for(let i=0;i<90;i++)world=stepWorld3D(doc,world,new Map([["player",{x:1,y:0,z:0}]]));
    expect(world.bodies.get("player")!.transform.position.x).toBeGreaterThan(1.4);
    expect(world.bodies.get("player")!.transform.position.x).toBeLessThanOrEqual(1.5);
    expect(serializeDocument(doc)).toBe(before);
    doc.nodes.get("lever")!.spatial3d!.blockoutCollision=false;
    world=world3DFrom(doc);for(let i=0;i<90;i++)world=stepWorld3D(doc,world,new Map([["player",{x:1,y:0,z:0}]]));
    expect(world.bodies.get("player")!.transform.position.x).toBeCloseTo(6);
});
test("gravity resolves against the actual ramp slope, not its bounding box",()=>{
    const doc=roomFixture(),ramp=doc.nodes.get("lever")!;
    ramp.spatial3d!.blockout={kind:"ramp",width:4,height:2,depth:4};
    const player=doc.nodes.get("player")!;player.entity!.gravity3d=9.8;
    player.spatial3d!.collider={kind:"sphere",radius:.2};player.spatial3d!.transform.position={x:0,y:1.5,z:0};
    let world=world3DFrom(doc);expect(queryCollisions3D(world,"player")).toEqual([]);
    for(let i=0;i<20;i++)world=stepWorld3D(doc,world);
    const body=world.bodies.get("player")!;
    expect(body.transform.position.y).toBeLessThan(1.3);expect(body.transform.position.y).toBeGreaterThan(1);
    expect(queryCollisions3D(world,"player")).toEqual([]);
});
test("nested reflected/scaled solids and moving parents use live world coordinates",()=>{
    const doc=roomFixture(),parent=doc.nodes.get("camera")!,room=doc.nodes.get("lever")!;
    parent.spatial3d!.transform.position={x:10,y:0,z:0};parent.spatial3d!.transform.scale={x:-2,y:1,z:1};
    parent.children=[room.id];room.parent=parent.id;doc.rootNodeUuids=doc.rootNodeUuids.filter(id=>id!==room.id);
    doc.nodes.get("player")!.spatial3d!.transform.position={x:6.1,y:1,z:0};
    const world=world3DFrom(doc);expect(queryCollisions3D(world,"player")).toEqual([room.id]);
    const body=world.bodies.get(room.id)!,m=bodyWorldMatrix3D(world.bodies,body);expect(m[12]).toBe(10);expect(m[0]).toBe(-2);
    const v={x:1,y:2,z:3};expect(localDisplacement3D(world.bodies,body,worldDisplacement3D(world.bodies,body,v))).toEqual(v);
    world.bodies.get(parent.id)!.transform.position.x=20;
    expect(queryCollisions3D(world,"player")).toEqual([]);
});
test("spawn and saved-progress restore derive fresh solids without persisting hull buffers",()=>{
    const doc=roomFixture(),template=doc.nodes.get("template")!;
    template.entity={body:"static"};template.spatial3d!.blockout={kind:"box",width:1,height:1,depth:1};template.spatial3d!.blockoutCollision=true;
    const world=applyRules3D(doc,world3DFrom(doc),[{self:"player",other:null,event:"start",rules:[{event:"start",other:"any",target:"self",action:{kind:"spawn",templateId:"template"}}]}],true);
    const spawned=world.bodies.get("runtime-spawn-0")!;expect(spawned.solidParts).toHaveLength(1);
    expect(bodyContact3D(world.bodies,world.bodies.get("player")!,spawned)).not.toBeNull();
    const progress=captureProgress3D(world,"game","level.vde","player");expect(JSON.stringify(progress)).not.toContain("vertices");
    const reopened=deserializeDocument(serializeDocument(doc)),restored=restoreProgress3D(reopened,world3DFrom(reopened),progress);
    expect(queryCollisions3D(restored,"player")).toContain("runtime-spawn-0");
    expect(restored.bodies.get("runtime-spawn-0")!.solidParts).not.toBe(spawned.solidParts);
});
test("old documents do not acquire solid collision and malformed opt-ins are rejected",()=>{
    const doc=roomFixture();delete doc.nodes.get("lever")!.spatial3d!.blockoutCollision;
    const saved=JSON.parse(serializeDocument(doc));saved.version="86";
    const old=deserializeDocument(JSON.stringify(saved));expect(world3DFrom(old).bodies.get("lever")!.solidParts).toBeUndefined();
    saved.document.nodes.lever.spatial3d.blockoutCollision="yes";
    expect(()=>deserializeDocument(JSON.stringify(saved))).toThrow();
});
test("fast non-gravity movement cannot skip a thin room wall",()=>{
    const doc=roomFixture(),world=stepWorld3D(doc,world3DFrom(doc),new Map([["player",{x:1,y:0,z:0,speed:1000}]]));
    expect(world.bodies.get("player")!.transform.position.x).toBeLessThanOrEqual(1.5);
    expect(world.diagnostics?.some(d=>d.includes("64 collision substeps"))).toBe(true);
});
test("gravity correction for a scaled child is converted back to its local position",()=>{
    const doc=roomFixture(),parent=doc.nodes.get("camera")!,player=doc.nodes.get("player")!;
    parent.spatial3d!.transform.position={x:0,y:0,z:0};parent.spatial3d!.transform.scale={x:2,y:2,z:2};
    parent.children=[player.id];player.parent=parent.id;doc.rootNodeUuids=doc.rootNodeUuids.filter(id=>id!==player.id);
    player.entity!.gravity3d=9.8;player.spatial3d!.transform.position={x:0,y:.55,z:0};
    let world=world3DFrom(doc);for(let i=0;i<20;i++)world=stepWorld3D(doc,world);
    expect(world.bodies.get("player")!.transform.position.y).toBeCloseTo(.5);
    expect(queryCollisions3D(world,"player")).toEqual([]);
});
