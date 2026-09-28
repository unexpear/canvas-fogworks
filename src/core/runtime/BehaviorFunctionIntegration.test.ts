/** @module BehaviorFunctionIntegration.test @description Root calls through both runtimes, saved nested waits, validation, history and bounded debugger stepping. */
import {BehaviorFunction} from "../document/BehaviorFunctions";
import {BehaviorGraph} from "../document/BehaviorGraph";
import {GameplayVariable} from "../document/GameplayData";
import {gameReference} from "../examples/ReferenceProjects";
import {gameplayFixture} from "../tests/fixtures/GameplayFixture";
import {worldFrom,NO_INPUT} from "./World";
import {world3DFrom,stepWorld3D} from "./World3D";
import {stepGameplay,advanceBehaviors2D} from "./GameplaySession";
import {controlBehavior,tickBehaviors,BehaviorState} from "./BehaviorRuntime";
import {captureProgress2D,captureProgress3D,restoreProgress2D,restoreProgress3D,parseProgress,serializeProgress} from "../../runtime/PlayerProgress";
import {ActionDispatcher} from "../actions/ActionDispatcher";
import {SetBehaviorFunctionsAction} from "../actions/SetBehaviorFunctionsAction";
import {UpdateNodeContentAction} from "../actions/UpdateNodeContentAction";
import {serializeDocument,deserializeDocument} from "../document/Serializer";
const hash="f".repeat(64),variables:GameplayVariable[]=[{id:"health",scope:"entity",type:"number",initial:100}];
const child:BehaviorFunction={id:"child",name:"Child",inputs:[{id:"amount",type:"number"}],outputs:[{id:"result",type:"number"}],locals:[{id:"sum",type:"number"}],entry:"repeat",nodes:[
    {id:"repeat",kind:"repeat",count:2,body:"wait",next:"return"},
    {id:"wait",kind:"delay",seconds:.1,next:"add"},
    {id:"add",kind:"local",variable:"sum",operation:"add",value:{kind:"input",id:"amount"},next:null},
    {id:"return",kind:"return",values:[{id:"result",value:{kind:"local",id:"sum"}}]}]};
const parent:BehaviorFunction={id:"parent",name:"Parent",inputs:[],outputs:[{id:"result",type:"number"}],locals:[{id:"answer",type:"number"}],entry:"call",nodes:[
    {id:"call",kind:"call",functionId:"child",inputs:[{id:"amount",value:{kind:"literal",value:25}}],outputs:[{id:"result",target:{kind:"local",id:"answer"}}],next:"return"},
    {id:"return",kind:"return",values:[{id:"result",value:{kind:"local",id:"answer"}}]}]};
const graph:BehaviorGraph={version:5,enabled:true,nodes:[
    {id:"start",kind:"event",event:"start",other:"any",next:"call"},
    {id:"call",kind:"call",functionId:"parent",inputs:[],outputs:[{id:"result",target:{kind:"variable",scope:"entity",id:"health"}}],next:"check"},
    {id:"check",kind:"compare",left:{kind:"variable",scope:"entity",id:"health"},right:{kind:"literal",value:50},operator:"equal",onTrue:"score",onFalse:null},
    {id:"score",kind:"action",target:"self",action:{kind:"score",key:"finished"},next:null}]};
function fixture(profile:"2d"|"3d"){
    const doc=profile==="2d"?gameReference():gameplayFixture(),owner=profile==="2d"?"goal":"lever",node=doc.nodes.get(owner)!;
    doc.gameplayVariables=variables;doc.behaviorFunctions=[parent,child];doc.nodes.set(owner,{...node,entity:{behavior:graph}});return {doc,owner};
}
test.each(["2d","3d"] as const)("%s saves nested waiting calls and returns once without embedding function definitions",profile=>{
    const {doc,owner}=fixture(profile);
    if(profile==="2d"){
        let world=stepGameplay(doc,worldFrom(doc),{controlled:"player",input:NO_INPUT}).world;
        const saved=captureProgress2D(world,hash,"entry","player"),text=serializeProgress(saved);
        expect(saved.behaviors?.[0].functions).toHaveLength(2);expect(text).not.toContain('"definitions"');expect(text).not.toContain('"nodes"');
        world=restoreProgress2D(doc,parseProgress(text,hash,profile));
        for(let i=0;i<20;i++)world=stepGameplay(doc,world,{controlled:"player",input:NO_INPUT}).world;
        expect(world.tallies.get("finished")).toBe(1);expect(world.behaviorState?.jobs).toHaveLength(0);expect(world.behaviorState?.errors).toEqual([]);
        expect(world.behaviorState?.data?.entities.get(owner)?.get("health")).toBe(50);
    }else{
        let world=stepWorld3D(doc,world3DFrom(doc));const saved=captureProgress3D(world,hash,"entry","player");
        expect(saved.behaviors?.[0].functions).toHaveLength(2);
        world=restoreProgress3D(doc,world3DFrom(doc),parseProgress(serializeProgress(saved),hash,profile));
        for(let i=0;i<20;i++)world=stepWorld3D(doc,world);
        expect(world.tallies?.get("finished")).toBe(1);expect(world.behaviorState?.jobs).toHaveLength(0);expect(world.behaviorState?.errors).toEqual([]);
        expect(world.behaviorState?.data?.entities.get(owner)?.get("health")).toBe(50);
    }
});
test("saved call stacks reject wrong types, call sites, repeat references and older save versions",()=>{
    const {doc}=fixture("2d"),world=stepGameplay(doc,worldFrom(doc),{controlled:"player",input:NO_INPUT}).world;
    const text=serializeProgress(captureProgress2D(world,hash,"entry","player"));
    const mutate=(change:(save:any)=>void)=>{const save=JSON.parse(text);change(save);return save;};
    expect(()=>parseProgress(JSON.stringify(mutate(s=>s.version=4)),hash,"2d")).toThrow("v5");
    expect(()=>parseProgress(JSON.stringify(mutate(s=>s.behaviors[0].functions[1].inputs.push(["amount",2]))),hash,"2d")).toThrow("duplicate");
    for(const change of [
        (s:any)=>s.behaviors[0].functions[1].inputs[0][1]="wrong",
        (s:any)=>s.behaviors[0].functions[1].callId="missing",
        (s:any)=>s.behaviors[0].functions[0].cursor="return",
        (s:any)=>s.behaviors[0].functions[1].loops[0].remaining=99,
        (s:any)=>s.behaviors[0].functions[1].cursor="missing"
    ])expect(()=>restoreProgress2D(doc,parseProgress(JSON.stringify(mutate(change)),hash,"2d"))).toThrow();
    expect(world.behaviorState?.jobs[0].execution?.frames[1].inputs).toEqual([["amount",25]]);
});
test("root call bindings validate on load/edit and referenced library removal is refused",()=>{
    const {doc,owner}=fixture("2d"),dispatcher=new ActionDispatcher(doc),before=serializeDocument(doc);
    expect(deserializeDocument(before).nodes.get(owner)?.entity?.behavior?.version).toBe(5);
    expect(dispatcher.dispatchAction(new SetBehaviorFunctionsAction(doc,[])).success).toBe(false);
    const bad:BehaviorGraph={...graph,nodes:graph.nodes.map(n=>n.kind==="call"?{...n,functionId:"missing"}:n)};
    expect(dispatcher.dispatchAction(new UpdateNodeContentAction(doc,owner,{entity:{behavior:bad}})).success).toBe(false);
    expect(serializeDocument(dispatcher.getDocument())).toBe(before);
    const corrupted=JSON.parse(before);corrupted.document.behaviorFunctions=[];
    expect(()=>deserializeDocument(JSON.stringify(corrupted))).toThrow("Missing");
});
test("pause/step advances one function instruction without re-triggering the root breakpoint",()=>{
    const {doc}=fixture("2d");let world=worldFrom(doc);
    world={...world,behaviorState:controlBehavior(undefined,"enable",{owner:"goal",node:"call"})};
    world=stepGameplay(doc,world,{controlled:"player",input:NO_INPUT}).world;
    expect(world.behaviorState?.debug.paused).toBe(true);expect(world.behaviorState?.jobs[0].execution).toBeUndefined();
    world=advanceBehaviors2D(doc,world,"player",[],"step").world;
    expect(world.behaviorState?.jobs[0].execution?.frames).toHaveLength(1);
    const snapshot=world;
    world=advanceBehaviors2D(doc,world,"player",[],"step").world;
    expect(world.behaviorState?.jobs[0].execution?.frames).toHaveLength(2);
    expect(snapshot.behaviorState?.jobs[0].execution?.frames).toHaveLength(1);
    world={...world,behaviorState:controlBehavior(world.behaviorState,"continue")};
    world=advanceBehaviors2D(doc,world,"player").world;
    expect(world.behaviorState?.debug.paused).toBe(false);expect(world.behaviorState?.jobs[0].due).toBeGreaterThan(world.time);
    expect(world.behaviorState?.debug.trace.some(t=>t.node==="child/wait")).toBe(true);
});

test("function breakpoints are reached again after loop return and library edits cancel waiting calls",()=>{
    const {doc}=fixture("2d");let world=worldFrom(doc);
    world={...world,behaviorState:controlBehavior(undefined,"enable",{owner:"goal",node:"child/wait"})};
    world=stepGameplay(doc,world,{controlled:"player",input:NO_INPUT}).world;
    expect(world.behaviorState?.debug.skip?.node).toBe("child/wait");
    world={...world,behaviorState:controlBehavior(world.behaviorState,"continue")};
    world=advanceBehaviors2D(doc,world,"player").world;
    for(let i=0;i<7;i++)world=stepGameplay(doc,world,{controlled:"player",input:NO_INPUT}).world;
    expect(world.behaviorState?.debug.paused).toBe(true);expect(world.behaviorState?.jobs[0].execution?.frames[1].loops[0].remaining).toBe(1);
    expect(world.behaviorState?.jobs[0].execution?.frames[1].locals).toEqual([["sum",25]]);
    doc.behaviorFunctions=[parent,{...child,name:"Edited"}];
    world={...world,behaviorState:controlBehavior(world.behaviorState,"continue")};
    world=advanceBehaviors2D(doc,world,"player").world;
    expect(world.behaviorState?.jobs).toHaveLength(0);expect(world.behaviorState?.errors.join()).toContain("library changed");
});

test("nested function work consumes the shared per-job instruction limit",()=>{
    const {doc}=fixture("2d");doc.behaviorFunctions=[parent,{...child,entry:"outer",nodes:[
        {id:"outer",kind:"repeat",count:100,body:"inner",next:"return"},
        {id:"inner",kind:"repeat",count:100,body:"add",next:null},
        {id:"add",kind:"local",variable:"sum",operation:"add",value:{kind:"literal",value:1},next:null},
        {id:"return",kind:"return",values:[{id:"result",value:{kind:"local",id:"sum"}}]}
    ]}];
    let state:BehaviorState|undefined;
    for(let i=0;i<12;i++){
        const result=tickBehaviors({doc,state,time:i/60,events:i?[]:[{owner:"goal",other:null,event:"start"}],controlled:null,position:()=>undefined,tallies:new Map(),profile:"2d"});
        state=result.state;expect(result.requests).toHaveLength(0);
        expect((state?.jobs[0]?.steps??0)).toBeLessThanOrEqual(10000);
    }
    expect(state?.jobs).toHaveLength(0);expect(state?.errors.join()).toContain("10000 steps");
    expect(state?.data?.entities.get("goal")?.get("health")).toBeUndefined();
});

test.each(["2d","3d"] as const)("%s actors share function definitions without sharing waiting locals",profile=>{
    const {doc,owner}=fixture(profile),original=doc.nodes.get(owner)!;
    doc.nodes.set("second",{...original,id:"second"});doc.rootNodeUuids.push("second");
    if(profile==="2d"){
        let world=worldFrom(doc);for(let i=0;i<20;i++)world=stepGameplay(doc,world,{controlled:"player",input:NO_INPUT}).world;
        expect(world.tallies.get("finished")).toBe(2);
        expect(world.behaviorState?.data?.entities.get(owner)?.get("health")).toBe(50);
        expect(world.behaviorState?.data?.entities.get("second")?.get("health")).toBe(50);
        expect(world.behaviorState?.errors).toEqual([]);
    }else{
        let world=world3DFrom(doc);for(let i=0;i<20;i++)world=stepWorld3D(doc,world);
        expect(world.tallies?.get("finished")).toBe(2);
        expect(world.behaviorState?.data?.entities.get(owner)?.get("health")).toBe(50);
        expect(world.behaviorState?.data?.entities.get("second")?.get("health")).toBe(50);
        expect(world.behaviorState?.errors).toEqual([]);
    }
});
