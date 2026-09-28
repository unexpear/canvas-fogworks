/** @module PlaceActorHierarchyAction.test @description Independent actor placement, instance-bound functions, both-runtime execution and atomic persistence/history. */
import {PlaceActorHierarchyAction} from "./PlaceActorHierarchyAction";
import {ActionDispatcher} from "./ActionDispatcher";
import {gameplayFixture} from "../tests/fixtures/GameplayFixture";
import {serializeDocument,deserializeDocument} from "../document/Serializer";
import {world3DFrom,stepWorld3D} from "../runtime/World3D";
import {worldFrom,NO_INPUT} from "../runtime/World";
import {stepGameplay} from "../runtime/GameplaySession";
import {captureProgress3D,restoreProgress3D} from "../../runtime/PlayerProgress";
function fixture(){
    const doc=gameplayFixture(),owner=doc.nodes.get("lever")!,child=JSON.parse(JSON.stringify(doc.nodes.get("template")));
    child.id="owned";child.parent="lever";child.hidden=true;doc.nodes.set(child.id,child);owner.children=[child.id];owner.hidden=true;
    owner.entity={behaviorAssetId:"shared"};
    doc.behaviorAssets=[{id:"shared",name:"Spawn owned child",graph:{version:5,enabled:true,nodes:[
        {id:"start",kind:"event",event:"start",other:"any",next:"call"},
        {id:"call",kind:"call",functionId:"outer",inputs:[],outputs:[],next:null}]}}];
    doc.behaviorFunctions=[
        {id:"outer",name:"Outer",inputs:[],outputs:[],locals:[],entry:"call",nodes:[
            {id:"call",kind:"call",functionId:"inner",inputs:[],outputs:[],next:"return"},{id:"return",kind:"return",values:[]}]},
        {id:"inner",name:"Inner",inputs:[],outputs:[],locals:[],entry:"spawn",nodes:[
            {id:"spawn",kind:"action",target:"self",action:{kind:"spawn",templateId:"owned"},next:"return"},{id:"return",kind:"return",values:[]}]}];
    return doc;
}
test.each(["2d","3d"] as const)("%s placed actor functions spawn their own copied templates, not the original or another instance",profile=>{
    const doc=fixture();
    // The 2D runtime deliberately refuses spatial3d spawn templates. Exercise a genuinely
    // 2D hierarchy rather than treating the placement profile as a content conversion.
    if(profile==="2d")for(const node of doc.nodes.values())delete node.spatial3d;
    const originalFunctions=JSON.stringify(doc.behaviorFunctions),dispatcher=new ActionDispatcher(doc);
    const a=new PlaceActorHierarchyAction(doc,"lever",profile,{x:3,y:0,z:0}),b=new PlaceActorHierarchyAction(doc,"lever",profile,{x:7,y:0,z:0});
    expect(dispatcher.dispatchAction(a).success).toBe(true);expect(dispatcher.dispatchAction(b).success).toBe(true);
    const reopened=deserializeDocument(serializeDocument(dispatcher.getDocument()));
    const roots=[a.getCreatedRootId()!,b.getCreatedRootId()!],templates=roots.map(id=>reopened.nodes.get(id)!.children[0]);
    expect(JSON.stringify(reopened.behaviorFunctions!.slice(0,2))).toBe(originalFunctions);
    expect(reopened.behaviorFunctions).toHaveLength(6);
    for(const root of roots){expect(reopened.nodes.get(root)!.hidden).toBe(false);expect(reopened.nodes.get(root)!.entity!.behaviorAssetId).toBeUndefined();}
    if(profile==="3d"){
        let world=world3DFrom(reopened);for(let i=0;i<10;i++)world=stepWorld3D(reopened,world);
        expect(new Set(world.spawns?.map(s=>s.templateId))).toEqual(new Set(templates));
        const progress=captureProgress3D(world,"f".repeat(64),"level","player"),restored=restoreProgress3D(reopened,world3DFrom(reopened),progress);
        expect(restored.spawns).toEqual(world.spawns);
    }else{
        let world=worldFrom(reopened);for(let i=0;i<10;i++)world=stepGameplay(reopened,world,{controlled:"player",input:NO_INPUT}).world;
        expect(new Set(world.spawns?.map(s=>s.templateId))).toEqual(new Set(templates));
    }
});
test("placement is one undoable revision with local root offset and independent descendant values",()=>{
    const doc=fixture(),before=serializeDocument(doc),dispatcher=new ActionDispatcher(doc),action=new PlaceActorHierarchyAction(doc,"lever","3d",{x:3,y:2,z:1});
    expect(dispatcher.dispatchAction(action).success).toBe(true);
    const root=dispatcher.getDocument().nodes.get(action.getCreatedRootId()!)!;
    expect(root.spatial3d!.transform.position).toEqual({x:4,y:2,z:1});
    expect(dispatcher.getDocument().nodes.get(root.children[0])!.spatial3d!.transform.position.x).toBe(100);
    const saved=serializeDocument(dispatcher.getDocument());dispatcher.undo();expect(serializeDocument(dispatcher.getDocument())).toBe(before);
    dispatcher.redo();expect(serializeDocument(dispatcher.getDocument())).toBe(saved);
    expect(dispatcher.dispatchAction(action).success).toBe(false);expect(serializeDocument(dispatcher.getDocument())).toBe(saved);
});
test("invalid offsets, missing functions and exhausted function capacity cannot partially place an actor",()=>{
    for(const mode of ["offset","missing","capacity"]){
        const doc=fixture();
        if(mode==="missing")doc.behaviorFunctions=doc.behaviorFunctions!.filter(f=>f.id!=="inner");
        if(mode==="capacity")for(let i=0;i<126;i++)doc.behaviorFunctions!.push({id:`extra${i}`,name:"Extra",inputs:[],outputs:[],locals:[],entry:"return",nodes:[{id:"return",kind:"return",values:[]}]});
        const before=serializeDocument(doc),dispatcher=new ActionDispatcher(doc),action=new PlaceActorHierarchyAction(doc,"lever","3d",{x:mode==="offset"?Infinity:1,y:0,z:0});
        expect(dispatcher.dispatchAction(action).success).toBe(false);expect(action.getError()).toBeTruthy();expect(serializeDocument(dispatcher.getDocument())).toBe(before);
    }
});
