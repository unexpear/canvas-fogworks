/** @module BehaviorLifecycle.test @description Graph-v3 lifecycle validation, bounded named dispatch and fixed-step runtime parity. */
import {BehaviorGraph,behaviorGraphError} from "../document/BehaviorGraph";
import {tickBehaviors} from "./BehaviorRuntime";
import {gameReference} from "../examples/ReferenceProjects";
import {gameplayFixture} from "../tests/fixtures/GameplayFixture";
import {worldFrom,applyCommands,NO_INPUT} from "./World";
import {world3DFrom,stepWorld3D} from "./World3D";
import {interact3D,applyRules3D} from "./Gameplay3D";
import {stepGameplay} from "./GameplaySession";
import {captureProgress2D,restoreProgress2D,serializeProgress,parseProgress,captureProgress3D,restoreProgress3D} from "../../runtime/PlayerProgress";
function lifecycle():BehaviorGraph{return {version:3,enabled:true,nodes:[
    {id:"born",kind:"event",event:"spawn",other:"any",next:"birth"},
    {id:"birth",kind:"action",target:"self",action:{kind:"score",key:"births"},next:null},
    {id:"update",kind:"event",event:"update",other:"any",next:"wait"},
    {id:"wait",kind:"delay",seconds:.1,next:"beat"},
    {id:"beat",kind:"action",target:"self",action:{kind:"score",key:"beats"},next:null}
]};}
test("lifecycle declarations require v3, custom names and actor-less lifecycle entries",()=>{
    expect(behaviorGraphError(lifecycle())).toBeNull();
    expect(behaviorGraphError({...lifecycle(),version:2})).toContain("v3");
    const graph:BehaviorGraph={version:3,enabled:true,nodes:[{id:"custom",kind:"event",event:"custom",name:"signal",other:"any",next:null}]};
    expect(behaviorGraphError(graph)).toBeNull();
    expect(behaviorGraphError({...graph,nodes:[{...graph.nodes[0],name:""}]})).toContain("Custom event");
    expect(behaviorGraphError({...lifecycle(),nodes:[{...lifecycle().nodes[0],other:"player"}]})).toContain("no other actor");
});
test("spawn notifications fire once and suspended update paths coalesce in both runtimes",()=>{
    const d2=gameReference(),template=d2.nodes.get("goal")!;
    d2.nodes.set("goal",{...template,entity:{},hidden:true});
    d2.nodes.set("template",{...template,id:"template",hidden:true,entity:{behavior:lifecycle()}});
    d2.rootNodeUuids.push("template");
    let w2=applyCommands(worldFrom(d2),[{kind:"spawn",templateId:"template",x:300,y:0}]);
    const d3=gameplayFixture(),t3=d3.nodes.get("template")!;
    d3.nodes.set("template",{...t3,entity:{...t3.entity,behavior:lifecycle()}});
    let w3=interact3D(d3,world3DFrom(d3),"player");
    for(let i=0;i<20;i++){
        w2=stepGameplay(d2,w2,{controlled:"player",input:NO_INPUT}).world;w3=stepWorld3D(d3,w3);
        expect(w2.behaviorState?.jobs.filter(j=>j.event==="update").length).toBeLessThanOrEqual(1);
        expect(w3.behaviorState?.jobs.filter(j=>j.event==="update").length).toBeLessThanOrEqual(1);
    }
    expect(w2.tallies.get("births")).toBe(1);expect(w3.tallies?.get("births")).toBe(1);
    expect(w2.tallies.get("beats")).toBeGreaterThan(0);expect(w2.tallies.get("beats")).toBe(w3.tallies?.get("beats"));
    const restored=restoreProgress2D(d2,captureProgress2D(w2,"a".repeat(64),"level0","player"));
    expect(stepGameplay(d2,restored,{controlled:"player",input:NO_INPUT}).world.tallies.get("births")).toBe(1);
});
test("named sends run in a bounded queue and recursive signal chains are stopped",()=>{
    const doc=gameReference(),node=doc.nodes.get("goal")!;
    const graph:BehaviorGraph={version:3,enabled:true,nodes:[
        {id:"start",kind:"event",event:"start",other:"any",next:"send"},
        {id:"send",kind:"emit",name:"ping",target:"self",next:null},
        {id:"ping",kind:"event",event:"custom",name:"ping",other:"any",next:"score"},
        {id:"score",kind:"action",target:"self",action:{kind:"score",key:"signals"},next:"send"}
    ]};
    expect(behaviorGraphError(graph)).toBeNull();doc.nodes.set(node.id,{...node,entity:{behavior:graph}});
    const result=tickBehaviors({doc,time:0,events:[{owner:node.id,other:null,event:"start"}],controlled:"player",position:()=>undefined,tallies:new Map(),profile:"2d"});
    expect(result.requests).toHaveLength(32);expect(result.state?.errors.join()).toContain("32 sends");
    expect(result.state?.jobs).toHaveLength(0);
    const wrong=tickBehaviors({doc,time:0,events:[{owner:node.id,other:null,event:"custom",name:"different"}],controlled:null,position:()=>undefined,tallies:new Map(),profile:"2d"});
    expect(wrong.requests).toHaveLength(0);
});
test("despawn handlers survive a wait and fire once after removal in both runtimes",()=>{
    const death:BehaviorGraph={version:3,enabled:true,nodes:[
        {id:"removed",kind:"event",event:"despawn",other:"any",next:"wait"},
        {id:"wait",kind:"delay",seconds:.1,next:"score"},
        {id:"score",kind:"action",target:"self",action:{kind:"score",key:"removed"},next:null}]};
    const d2=gameReference(),goal=d2.nodes.get("goal")!;d2.nodes.set("goal",{...goal,entity:{behavior:death}});
    let w2=applyCommands(worldFrom(d2),[{kind:"despawn",bodyId:"goal"}]);
    const d3=gameplayFixture(),lever=d3.nodes.get("lever")!;d3.nodes.set("lever",{...lever,entity:{behavior:death}});
    let w3=applyRules3D(d3,world3DFrom(d3),[{self:"lever",other:null,event:"start",rules:[{event:"start",other:"any",target:"self",action:{kind:"despawn"}}]}],true);
    w2=stepGameplay(d2,w2,{controlled:"player",input:NO_INPUT}).world;w3=stepWorld3D(d3,w3);
    const hash="b".repeat(64);
    w2=restoreProgress2D(d2,parseProgress(serializeProgress(captureProgress2D(w2,hash,"level0","player")),hash,"2d"));
    w3=restoreProgress3D(d3,world3DFrom(d3),parseProgress(serializeProgress(captureProgress3D(w3,hash,"level0","player")),hash,"3d"));
    for(let i=0;i<15;i++){w2=stepGameplay(d2,w2,{controlled:"player",input:NO_INPUT}).world;w3=stepWorld3D(d3,w3);}
    expect(w2.tallies.get("removed")).toBe(1);expect(w3.tallies?.get("removed")).toBe(1);
    expect(w2.despawned.has("goal")).toBe(true);expect(w3.bodies.has("lever")).toBe(false);
});
test("saving before a spawned actor's first tick preserves its pending birth notification",()=>{
    const doc=gameReference(),template=doc.nodes.get("goal")!;
    doc.nodes.set("template",{...template,id:"template",hidden:true,entity:{behavior:lifecycle()}});doc.rootNodeUuids.push("template");
    const world=applyCommands(worldFrom(doc),[{kind:"spawn",templateId:"template",x:300,y:0}]);
    const hash="c".repeat(64),saved=parseProgress(serializeProgress(captureProgress2D(world,hash,"level0","player")),hash,"2d");
    const loaded=restoreProgress2D(doc,saved);
    expect(stepGameplay(doc,loaded,{controlled:"player",input:NO_INPUT}).world.tallies.get("births")).toBe(1);
    const old:any={...saved,version:2};delete old.lifecycle;delete old.data;
    expect(parseProgress(JSON.stringify(old),hash,"2d").version).toBe(2);
});

test.each(["2d","3d"] as const)("%s callback spawning/removal preserves typed teardown state without reviving actors",profile=>{
    const child:BehaviorGraph={version:3,enabled:true,nodes:[
        {id:"born",kind:"event",event:"spawn",other:"any",next:"count"},
        {id:"count",kind:"action",target:"self",action:{kind:"score",key:"childBirths"},next:null}]};
    const parent:BehaviorGraph={version:4,enabled:true,nodes:[
        {id:"born",kind:"event",event:"spawn",other:"any",next:"remember"},
        {id:"remember",kind:"assign",scope:"entity",variable:"health",operation:"set",value:{kind:"literal",value:75},next:"child"},
        {id:"child",kind:"action",target:"self",action:{kind:"spawn",templateId:"childTemplate"},next:"remove"},
        {id:"remove",kind:"action",target:"self",action:{kind:"despawn"},next:null},
        {id:"removed",kind:"event",event:"despawn",other:"any",next:"wait"},
        {id:"wait",kind:"delay",seconds:.1,next:"refused"},
        {id:"refused",kind:"action",target:"self",action:{kind:"spawn",templateId:"childTemplate"},next:"check"},
        {id:"check",kind:"compare",left:{kind:"variable",scope:"entity",id:"health"},right:{kind:"literal",value:75},operator:"equal",onTrue:"count",onFalse:null},
        {id:"count",kind:"action",target:"self",action:{kind:"score",key:"parentDeaths"},next:null}]};
    const doc=profile==="2d"?gameReference():gameplayFixture(),template=doc.nodes.get(profile==="2d"?"goal":"template")!;
    doc.gameplayVariables=[{id:"health",scope:"entity",type:"number",initial:100}];
    doc.nodes.set("template",{...template,id:"template",hidden:true,entity:{behavior:parent}});
    doc.nodes.set("childTemplate",{...template,id:"childTemplate",hidden:true,entity:{behavior:child}});
    if(!doc.rootNodeUuids.includes("template"))doc.rootNodeUuids.push("template");doc.rootNodeUuids.push("childTemplate");
    const hash="e".repeat(64);
    if(profile==="2d"){
        let world=applyCommands(worldFrom(doc),[{kind:"spawn",templateId:"template",x:300,y:0}]);
        for(let i=0;i<2;i++)world=stepGameplay(doc,world,{controlled:"player",input:NO_INPUT}).world;
        expect(world.spawns).toHaveLength(2);expect(world.tallies.get("childBirths")).toBe(1);
        world=restoreProgress2D(doc,parseProgress(serializeProgress(captureProgress2D(world,hash,"level0","player")),hash,"2d"));
        for(let i=0;i<20;i++)world=stepGameplay(doc,world,{controlled:"player",input:NO_INPUT}).world;
        expect(world.spawns).toHaveLength(2);expect(world.despawned.has(world.spawns[0].id)).toBe(true);
        expect(world.tallies.get("parentDeaths")).toBe(1);expect(world.tallies.get("childBirths")).toBe(1);
        expect(world.behaviorState?.errors.join()).toContain("body-targeting");
    }else{
        let world=interact3D(doc,world3DFrom(doc),"player");
        for(let i=0;i<2;i++)world=stepWorld3D(doc,world);
        expect(world.spawns).toHaveLength(2);expect(world.tallies?.get("childBirths")).toBe(1);
        world=restoreProgress3D(doc,world3DFrom(doc),parseProgress(serializeProgress(captureProgress3D(world,hash,"level0","player")),hash,"3d"));
        for(let i=0;i<20;i++)world=stepWorld3D(doc,world);
        expect(world.spawns).toHaveLength(2);expect(world.bodies.has(world.spawns![0].id)).toBe(false);
        expect(world.tallies?.get("parentDeaths")).toBe(1);expect(world.tallies?.get("childBirths")).toBe(1);
        expect(world.behaviorState?.errors.join()).toContain("body-targeting");
    }
});
