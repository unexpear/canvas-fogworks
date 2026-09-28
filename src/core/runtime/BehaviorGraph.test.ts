/** @module BehaviorGraph.test @description Graph validation, event dispatch, 2D/3D integration, save restore and authored history regression tests. */
import { BehaviorGraph, behaviorGraphError, starterBehaviorGraph } from "../document/BehaviorGraph";
import { evaluateBehavior, BehaviorContext } from "./BehaviorRunner";
import { gameplayFixture } from "../tests/fixtures/GameplayFixture";
import { gameReference } from "../examples/ReferenceProjects";
import { serializeDocument, deserializeDocument } from "../document/Serializer";
import { SCHEMA_VERSION } from "../document/Document";
import { ActionDispatcher } from "../actions/ActionDispatcher";
import { UpdateNodeContentAction } from "../actions/UpdateNodeContentAction";
import { worldFrom, NO_INPUT } from "./World";
import { world3DFrom, stepWorld3D } from "./World3D";
import { interact3D } from "./Gameplay3D";
import { interactGameplay2D, stepGameplay } from "./GameplaySession";
import { captureProgress3D, restoreProgress3D, serializeProgress, parseProgress } from "../../runtime/PlayerProgress";
const context: BehaviorContext = {event:"interact",otherIsPlayer:true,distance:1,defaultRange:2,tallies:new Map()};
function eventGraph(event: "start" | "enter"): BehaviorGraph {
    return {version:1,enabled:true,nodes:[{id:"event",kind:"event",event,other:event==="start"?"any":"player",next:"score"},
        {id:"score",kind:"action",target:"self",action:{kind:"score",key:"visits"},next:null}]};
}
test("branches observe earlier score requests; traces are deterministic and input state stays immutable",()=>{
    const graph=starterBehaviorGraph(), before=JSON.stringify(graph), tallies=new Map([["uses",2]]);
    const result=evaluateBehavior(graph,{...context,tallies});
    expect(result.rules.map(r=>r.action.kind)).toEqual(["score","win"]);
    expect(result.visited).toEqual(["interact","count","check","win"]);
    expect(evaluateBehavior(graph,context).rules.map(r=>r.action.kind)).toEqual(["score","checkpoint"]);
    expect(tallies.get("uses")).toBe(2);expect(JSON.stringify(graph)).toBe(before);
});
test.each([
    ["unsupported version",(g:any)=>{g.version=6;}],
    ["unknown graph field",(g:any)=>{g.script="eval()";}],
    ["duplicate ID",(g:any)=>{g.nodes.push(g.nodes[0]);}],
    ["missing link",(g:any)=>{g.nodes[0].next="missing";}],
    ["omitted link",(g:any)=>{delete g.nodes[0].next;}],
    ["cycle",(g:any)=>{g.nodes[2].onTrue="count";}],
    ["event reentry",(g:any)=>{g.nodes[1].next="interact";}],
    ["infinite threshold",(g:any)=>{g.nodes[2].condition.atLeast=Infinity;}],
    ["unknown command",(g:any)=>{g.nodes[1].action={kind:"eval"};}],
    ["unknown command payload",(g:any)=>{g.nodes[1].action.source="file:///private";}],
    ["invalid range",(g:any)=>{g.nodes[0].range=0;}],
    ["node cap",(g:any)=>{g.nodes=Array.from({length:65},(_,i)=>({id:`n${i}`,kind:"action",target:"self",action:{kind:"win"},next:null}));}],
    ["entry cap",(g:any)=>{g.nodes=Array.from({length:17},(_,i)=>({id:`e${i}`,kind:"event",event:"start",other:"any",next:null}));}]
])("%s fails closed before any command",(_name,mutate)=>{
    const graph=JSON.parse(JSON.stringify(starterBehaviorGraph()));(mutate as (g:any)=>void)(graph);
    expect(behaviorGraphError(graph)).not.toBeNull();
    expect(evaluateBehavior(graph,context)).toMatchObject({rules:[],error:expect.any(String)});
});
test("disabled, wrong actor/event and out-of-range entries do nothing",()=>{
    const graph=starterBehaviorGraph();
    expect(evaluateBehavior({...graph,enabled:false},context).rules).toEqual([]);
    for(const patch of [{otherIsPlayer:false},{event:"contact" as const},{distance:3},{distance:undefined}])expect(evaluateBehavior(graph,{...context,...patch}).rules).toEqual([]);
});
test("player branch uses the event actor and unconnected nodes never execute",()=>{
    const graph:BehaviorGraph={version:1,enabled:true,nodes:[
        {id:"enter",kind:"event",event:"enter",other:"any",next:"player"},
        {id:"player",kind:"branch",condition:{kind:"player"},onTrue:"yes",onFalse:"no"},
        {id:"yes",kind:"action",target:"self",action:{kind:"win"},next:null},
        {id:"no",kind:"action",target:"other",action:{kind:"despawn"},next:null},
        {id:"unused",kind:"action",target:"self",action:{kind:"lose"},next:null}]};
    expect(evaluateBehavior(graph,{...context,event:"enter"}).rules.map(r=>r.action.kind)).toEqual(["win"]);
    expect(evaluateBehavior(graph,{...context,event:"enter",otherIsPlayer:false}).rules).toMatchObject([{target:"other",action:{kind:"despawn"}}]);
});
test("graph edits round-trip through entity Actions and undo; invalid replacement keeps the prior graph",()=>{
    const d=new ActionDispatcher(gameReference()), entity=d.getDocument().nodes.get("goal")!.entity!;
    expect(d.dispatchAction(new UpdateNodeContentAction(d.getDocument(),"goal",{entity:{...entity,behavior:starterBehaviorGraph()}})).success).toBe(true);
    const before=serializeDocument(d.getDocument());expect(deserializeDocument(before).nodes.get("goal")!.entity!.behavior).toEqual(starterBehaviorGraph());
    const bad=starterBehaviorGraph(); (bad.nodes[0] as any).next="missing";
    expect(d.dispatchAction(new UpdateNodeContentAction(d.getDocument(),"goal",{entity:{...entity,behavior:bad}})).success).toBe(false);
    expect(serializeDocument(d.getDocument())).toBe(before);expect(d.undo()?.nodes.get("goal")!.entity!.behavior).toBeUndefined();
    const old=JSON.parse(serializeDocument(gameReference()));old.version="79";
    const loaded=deserializeDocument(JSON.stringify(old));expect(loaded.version).toBe(SCHEMA_VERSION);expect(loaded.nodes.get("player")!.entity!.behavior).toBeUndefined();
    old.document.nodes.goal.entity.behavior=bad;expect(()=>deserializeDocument(JSON.stringify(old))).toThrow();
});
test("graph-only interactions reach the same checkpoint/counter/win result in 2D and 3D",()=>{
    const doc2=gameReference(), goal=doc2.nodes.get("goal")!, player=doc2.nodes.get("player")!;
    doc2.nodes.set("goal",{...goal,geometry:{...player.geometry,x:player.geometry.x+30},entity:{behavior:starterBehaviorGraph()}});
    const doc3=gameplayFixture(), lever=doc3.nodes.get("lever")!;
    doc3.nodes.set("lever",{...lever,entity:{behavior:starterBehaviorGraph()}});
    const before2=serializeDocument(doc2),before3=serializeDocument(doc3);
    let w2=worldFrom(doc2),w3=world3DFrom(doc3);
    for(let i=1;i<=3;i++){
        w2=interactGameplay2D(doc2,w2,"player").world;w3=interact3D(doc3,w3,"player");
        expect(w2.tallies.get("uses")).toBe(i);expect(w3.tallies?.get("uses")).toBe(i);
        expect(w2.outcome).toBe(i===3?"won":"running");expect(w3.outcome).toBe(w2.outcome);
    }
    expect(w2.checkpoint?.playerId).toBe("player");expect(w3.checkpoint?.playerId).toBe("player");
    expect(serializeDocument(doc2)).toBe(before2);expect(serializeDocument(doc3)).toBe(before3);
});
test("graph-only enter triggers are discovered by both physics event paths",()=>{
    const doc2=gameReference(),goal=doc2.nodes.get("goal")!,player=doc2.nodes.get("player")!;
    doc2.nodes.set("goal",{...goal,geometry:{...player.geometry,width:100,height:100},entity:{behavior:eventGraph("enter")}});
    let w2=stepGameplay(doc2,worldFrom(doc2),{controlled:"player",input:NO_INPUT}).world;
    expect(w2.tallies.get("visits")).toBe(1);
    w2=stepGameplay(doc2,w2,{controlled:"player",input:NO_INPUT}).world;expect(w2.tallies.get("visits")).toBe(1);
    const doc3=gameplayFixture(),lever=doc3.nodes.get("lever")!;
    doc3.nodes.set("lever",{...lever,entity:{behavior:eventGraph("enter")},spatial3d:{...lever.spatial3d!,
        transform:{...lever.spatial3d!.transform,position:{x:0,y:0,z:0}},collider:{kind:"box",halfExtents:{x:1,y:1,z:1}}}});
    let w3=stepWorld3D(doc3,world3DFrom(doc3));expect(w3.tallies?.get("visits")).toBe(1);
    w3=stepWorld3D(doc3,w3);expect(w3.tallies?.get("visits")).toBe(1);
});
test("start graph runs once per level run; progress restores counters used by later branches",()=>{
    const doc=gameplayFixture(),player=doc.nodes.get("player")!,lever=doc.nodes.get("lever")!;
    doc.nodes.set("player",{...player,entity:{...player.entity,behavior:eventGraph("start")}});
    doc.nodes.set("lever",{...lever,entity:{behavior:starterBehaviorGraph()}});
    let world=stepWorld3D(doc,world3DFrom(doc));world=stepWorld3D(doc,world);
    expect(world.tallies?.get("visits")).toBe(1);
    world=interact3D(doc,interact3D(doc,world,"player"),"player");
    const hash="b".repeat(64), saved=parseProgress(serializeProgress(captureProgress3D(world,hash,"level0","player")),hash,"3d");
    const restored=stepWorld3D(doc,restoreProgress3D(doc,world3DFrom(doc),saved));
    expect(restored.tallies?.get("visits")).toBe(1);expect(interact3D(doc,restored,"player").outcome).toBe("won");
});
