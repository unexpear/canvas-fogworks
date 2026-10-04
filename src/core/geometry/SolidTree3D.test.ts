/** @module SolidTree3D.test @description Saved editable solid trees, validation, history, shared renderer/collision evaluation and operand transforms. */
import {solidLeaf3D,solidTreeGeometry3D,solidTreeError,SolidTree3D} from "./SolidTree3D";
import {gameplayFixture} from "../tests/fixtures/GameplayFixture";
import {ActionDispatcher} from "../actions/ActionDispatcher";
import {SetSpatial3DAction} from "../actions/SetSpatial3DAction";
import {serializeDocument,deserializeDocument} from "../document/Serializer";
import {SCHEMA_VERSION} from "../document/Document";
import {world3DFrom,stepWorld3D} from "../runtime/World3D";
import {buildFrame3D} from "../../renderer/Scene3D";
import {copySpatial3D} from "../../renderer/Gizmo3D";
const doorway=():SolidTree3D=>({id:"cut",kind:"operation",operation:"subtract",
    left:solidLeaf3D("wall",{kind:"wall",width:4,height:3,depth:.4}),right:solidLeaf3D("door",{kind:"box",width:1,height:2,depth:1})});
test("solid tree Actions preserve editable operands, undo/redo, schema migration and independent gizmo copies",()=>{
    const doc=gameplayFixture(),original=doc.nodes.get("lever")!.spatial3d!,dispatcher=new ActionDispatcher(doc);
    const spatial={...original,solidTree:doorway(),blockoutCollision:true};
    expect(dispatcher.dispatchAction(new SetSpatial3DAction(doc,"lever",spatial)).success).toBe(true);
    const saved=serializeDocument(dispatcher.getDocument());expect(JSON.parse(saved).version).toBe(SCHEMA_VERSION);expect(saved).not.toContain('"vertices"');
    const reopened=deserializeDocument(saved);expect(reopened.nodes.get("lever")!.spatial3d!.solidTree).toEqual(spatial.solidTree);
    const copied=copySpatial3D(reopened.nodes.get("lever")!.spatial3d!);copied.solidTree!.id="changed";
    expect(reopened.nodes.get("lever")!.spatial3d!.solidTree!.id).toBe("cut");
    dispatcher.undo();expect(dispatcher.getDocument().nodes.get("lever")!.spatial3d).toEqual(original);
    dispatcher.redo();expect(dispatcher.getDocument().nodes.get("lever")!.spatial3d!.solidTree).toEqual(spatial.solidTree);
    const old=JSON.parse(serializeDocument(gameplayFixture()));old.version="87";
    expect(deserializeDocument(JSON.stringify(old)).nodes.get("lever")!.spatial3d!.solidTree).toBeUndefined();
});
test("reopened doorway has shared exterior buffers and matching traversable collision",()=>{
    const source=gameplayFixture(),wall=source.nodes.get("lever")!;wall.entity={body:"static"};
    wall.spatial3d={...wall.spatial3d!,transform:{...wall.spatial3d!.transform,position:{x:0,y:0,z:0}},solidTree:doorway(),blockoutCollision:true};
    const player=source.nodes.get("player")!;player.spatial3d!.collider={kind:"sphere",radius:.2};player.spatial3d!.transform.position={x:0,y:1,z:-1};
    const doc=deserializeDocument(serializeDocument(source)),frame=buildFrame3D(doc,new Map(),128,128);
    const geometry=solidTreeGeometry3D(wall.spatial3d.solidTree!);
    expect(frame.draws.find(d=>d.nodeId==="lever")!.primitive).toBe(geometry.mesh);
    expect(world3DFrom(doc).bodies.get("lever")!.solidParts).toBe(geometry.parts);
    let world=world3DFrom(doc);for(let i=0;i<40;i++)world=stepWorld3D(doc,world,new Map([["player",{x:0,y:0,z:1}]]));
    expect(world.bodies.get("player")!.transform.position.z).toBeGreaterThan(1);
    doc.nodes.get("player")!.spatial3d!.transform.position.x=1;
    world=world3DFrom(doc);for(let i=0;i<40;i++)world=stepWorld3D(doc,world,new Map([["player",{x:0,y:0,z:1}]]));
    expect(world.bodies.get("player")!.transform.position.z).toBeLessThanOrEqual(-.4+1e-8);
});
test("operand transform edits change derived geometry and reflected winding remains valid",()=>{
    const tree=doorway(),initial=solidTreeGeometry3D(tree);expect(solidTreeGeometry3D(tree)).toBe(initial);
    if(tree.kind!=="operation"||tree.right.kind!=="shape")throw Error("fixture");
    tree.right.position=[1,0,0];tree.right.rotation=[0,25,0];tree.right.scale=[-1,1,1];
    const changed=solidTreeGeometry3D(tree);expect(changed).not.toBe(initial);expect(changed.mesh.indices.length).toBeGreaterThan(0);
    expect(solidTreeError(tree)).toBeNull();
});
test("invalid, cyclic, oversized or incompatible tree edits retain the original document",()=>{
    const tree=doorway();if(tree.kind!=="operation")throw Error("fixture");
    expect(solidTreeError({...tree,right:tree.left})).toMatch(/shared|unique/);
    expect(solidTreeError({...tree,typo:true})).toContain("Unknown");
    const cyclic={...tree};cyclic.left=cyclic;expect(solidTreeError(cyclic)).toContain("cycles");
    let deep:SolidTree3D=solidLeaf3D("leaf",{kind:"box",width:1,height:1,depth:1});
    for(let i=0;i<9;i++)deep={id:`op${i}`,kind:"operation",operation:"add",left:deep,right:solidLeaf3D(`box${i}`,{kind:"box",width:1,height:1,depth:1})};
    expect(solidTreeError(deep)).toMatch(/depth/);
    const doc=gameplayFixture(),dispatcher=new ActionDispatcher(doc),before=serializeDocument(doc);
    expect(dispatcher.dispatchAction(new SetSpatial3DAction(doc,"player",{...doc.nodes.get("player")!.spatial3d!,solidTree:tree})).success).toBe(false);
    expect(serializeDocument(dispatcher.getDocument())).toBe(before);
});
