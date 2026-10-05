/** @module BlockoutPersistence.test @description Procedural blockout Action history, schema migration, validation and renderer projection. */
import {gameReference} from "../examples/ReferenceProjects";
import {ActionDispatcher} from "../actions/ActionDispatcher";
import {SetSpatial3DAction} from "../actions/SetSpatial3DAction";
import {deserializeDocument,serializeDocument} from "./Serializer";
import {SCHEMA_VERSION} from "./Document";
import {IDENTITY_TRANSFORM_3D,Spatial3D} from "./Spatial3D";
import {buildFrame3D} from "../../renderer/Scene3D";
import {copySpatial3D} from "../../renderer/Gizmo3D";
const spatial:Spatial3D={transform:IDENTITY_TRANSFORM_3D,blockout:{kind:"stairs",width:4,height:3,depth:5,steps:8}};
test("blockout parameters survive Action undo/redo, serialization and transform copying without derived buffers",()=>{
    const doc=gameReference(),dispatcher=new ActionDispatcher(doc);
    expect(dispatcher.dispatchAction(new SetSpatial3DAction(doc,"goal",spatial)).success).toBe(true);
    const saved=serializeDocument(dispatcher.getDocument()),parsed=JSON.parse(saved);
    expect(parsed.version).toBe(SCHEMA_VERSION);expect(saved).not.toContain("positions");
    const reopened=deserializeDocument(saved);expect(reopened.nodes.get("goal")!.spatial3d).toEqual(spatial);
    const copy=copySpatial3D(reopened.nodes.get("goal")!.spatial3d!);copy.blockout!.width=9;
    expect(reopened.nodes.get("goal")!.spatial3d!.blockout!.width).toBe(4);
    dispatcher.undo();expect(dispatcher.getDocument().nodes.get("goal")!.spatial3d).toBeUndefined();
    dispatcher.redo();expect(dispatcher.getDocument().nodes.get("goal")!.spatial3d).toEqual(spatial);
});
test("schema 85 migrates without changing existing gameplay or inventing geometry",()=>{
    const doc=gameReference(),saved=JSON.parse(serializeDocument(doc));saved.version="85";
    const restored=deserializeDocument(JSON.stringify(saved));
    expect(serializeDocument(restored)).toBe(serializeDocument(doc));
});
test("invalid shapes and ambiguous visual/collision definitions fail without changing the document",()=>{
    const doc=gameReference(),dispatcher=new ActionDispatcher(doc),before=serializeDocument(doc);
    for(const bad of [{...spatial,blockout:{...spatial.blockout!,width:-1}},
        {...spatial,renderable:{meshAssetId:"mesh"}}, {...spatial,collider:{kind:"sphere" as const,radius:4}}]){
        expect(dispatcher.dispatchAction(new SetSpatial3DAction(dispatcher.getDocument(),"goal",bad)).success).toBe(false);
        const saved=JSON.parse(before);saved.document.nodes.goal.spatial3d=bad;
        expect(()=>deserializeDocument(JSON.stringify(saved))).toThrow();
    }
    expect(serializeDocument(dispatcher.getDocument())).toBe(before);
});
test("reopened shapes render without imported assets; stable buffers invalidate on geometry changes",()=>{
    const doc=gameReference();doc.nodes.get("goal")!.spatial3d=copySpatial3D(spatial);
    const reopened=deserializeDocument(serializeDocument(doc)),first=buildFrame3D(reopened,new Map(),320,240);
    const draw=first.draws.find(d=>d.nodeId==="goal")!;expect(draw.primitive.indices.length).toBe(8*36);
    expect(buildFrame3D(reopened,new Map(),320,240).draws.find(d=>d.nodeId==="goal")!.primitive).toBe(draw.primitive);
    reopened.nodes.get("goal")!.spatial3d!.blockout!.height=6;
    const changed=buildFrame3D(reopened,new Map(),320,240).draws.find(d=>d.nodeId==="goal")!;
    expect(changed.primitive).not.toBe(draw.primitive);
    expect(Math.max(...Array.from(changed.primitive.positions).filter((_,i)=>i%3===1))).toBe(6);
    reopened.nodes.get("goal")!.hidden=true;
    expect(buildFrame3D(reopened,new Map(),320,240).draws.some(d=>d.nodeId==="goal")).toBe(false);
});
