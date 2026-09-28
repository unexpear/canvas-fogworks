/** @module BehaviorRuntime.test @description Timed structured repeats, runtime parity, save continuations, debug controls and reusable asset history. */
import {readFileSync} from "fs";
import {resolve} from "path";
import {BehaviorGraph,behaviorGraphError} from "../document/BehaviorGraph";
import {gameReference} from "../examples/ReferenceProjects";
import {gameplayFixture} from "../tests/fixtures/GameplayFixture";
import {worldFrom,NO_INPUT,applyCommands} from "./World";
import {world3DFrom,stepWorld3D} from "./World3D";
import {stepGameplay,interactGameplay2D,advanceBehaviors2D} from "./GameplaySession";
import {interact3D} from "./Gameplay3D";
import {tickBehaviors,controlBehavior,BehaviorState} from "./BehaviorRuntime";
import {captureProgress2D,captureProgress3D,restoreProgress2D,restoreProgress3D,serializeProgress,parseProgress} from "../../runtime/PlayerProgress";
import {SetBehaviorAssetsAction} from "../actions/SetBehaviorAssetsAction";
import {UpdateNodeContentAction} from "../actions/UpdateNodeContentAction";
import {ActionDispatcher} from "../actions/ActionDispatcher";
import {TransactionAction} from "../actions/TransactionAction";
import {serializeDocument,deserializeDocument} from "../document/Serializer";
const hash="d".repeat(64);
function graph():BehaviorGraph{return {version:2,enabled:true,nodes:[
    {id:"entry",kind:"event",event:"interact",other:"player",next:"repeat"},
    {id:"repeat",kind:"repeat",count:3,body:"delay",next:"done"},
    {id:"delay",kind:"delay",seconds:.1,next:"score"},
    {id:"score",kind:"action",target:"self",action:{kind:"score",key:"ticks"},next:null},
    {id:"done",kind:"action",target:"self",action:{kind:"score",key:"done"},next:null}
]};}
function fixtures(){
    const d2=gameReference(),p=d2.nodes.get("player")!,goal=d2.nodes.get("goal")!,d3=gameplayFixture(),lever=d3.nodes.get("lever")!;
    d2.nodes.set("goal",{...goal,geometry:{...p.geometry,x:p.geometry.x+30},entity:{behaviorAssetId:"shared"}});
    d3.nodes.set("lever",{...lever,entity:{behaviorAssetId:"shared"}});
    d2.behaviorAssets=[{id:"shared",name:"Timed repeat",graph:graph()}];d3.behaviorAssets=d2.behaviorAssets;
    return {d2,d3};
}
test("shared timed repeats run once per iteration in both runtimes and do not recheck interaction distance",()=>{
    const {d2,d3}=fixtures(),before=serializeDocument(d2);
    let w2=interactGameplay2D(d2,worldFrom(d2),"player").world,w3=interact3D(d3,world3DFrom(d3),"player");
    expect(w2.behaviorState?.jobs).toHaveLength(1);expect(w3.behaviorState?.jobs).toHaveLength(1);
    w2=applyCommands(w2,[{kind:"teleport",bodyId:"player",x:3000,y:0}]);
    for(let i=1;i<=18;i++){w2=stepGameplay(d2,w2,{controlled:"player",input:NO_INPUT}).world;w3=stepWorld3D(d3,w3);
        expect(w2.tallies.get("ticks")??0).toBe(Math.floor(i/6));expect(w3.tallies?.get("ticks")??0).toBe(Math.floor(i/6));}
    expect(w2.tallies.get("done")).toBe(1);expect(w3.tallies?.get("done")).toBe(1);
    expect(w2.behaviorState?.jobs).toHaveLength(0);expect(serializeDocument(d2)).toBe(before);
});
test("pending delays and repeat frames survive saved progress in both profiles without debugger state",()=>{
    const {d2,d3}=fixtures();
    let w2=interactGameplay2D(d2,worldFrom(d2),"player").world,w3=interact3D(d3,world3DFrom(d3),"player");
    for(let i=0;i<8;i++){w2=stepGameplay(d2,w2,{controlled:"player",input:NO_INPUT}).world;w3=stepWorld3D(d3,w3);}
    w2={...w2,behaviorState:controlBehavior(w2.behaviorState,"pause")};
    const p2=parseProgress(serializeProgress(captureProgress2D(w2,hash,"entry","player")),hash,"2d");
    const p3=parseProgress(serializeProgress(captureProgress3D(w3,hash,"entry","player")),hash,"3d");
    expect(p2.behaviors?.[0].stack[0].remaining).toBe(2);expect(JSON.stringify(p2)).not.toContain("breakpoints");
    w2=restoreProgress2D(d2,p2);w3=restoreProgress3D(d3,world3DFrom(d3),p3);
    expect(w2.behaviorState?.debug.paused).toBe(false);
    for(let i=0;i<10;i++){w2=stepGameplay(d2,w2,{controlled:"player",input:NO_INPUT}).world;w3=stepWorld3D(d3,w3);}
    expect(w2.tallies.get("ticks")).toBe(3);expect(w3.tallies?.get("ticks")).toBe(3);
    expect(w2.tallies.get("done")).toBe(1);expect(w3.tallies?.get("done")).toBe(1);
    const legacy:any={...p2,version:1};delete legacy.behaviors;delete legacy.lifecycle;delete legacy.data;
    expect(restoreProgress2D(d2,parseProgress(JSON.stringify(legacy),hash,"2d")).behaviorState?.jobs).toEqual([]);
    const bad=JSON.parse(JSON.stringify(p2));bad.behaviors[0].cursor="missing";
    expect(()=>restoreProgress2D(d2,bad)).toThrow("reference");
    bad.behaviors[0].remaining=-1;expect(()=>parseProgress(JSON.stringify(bad),hash,"2d")).toThrow("continuation");
});
test("pause freezes physics/timers; breakpoint and step execute exactly once without authored history",()=>{
    const {d2}=fixtures();let w=worldFrom(d2);
    w={...w,behaviorState:controlBehavior(undefined,"enable",{owner:"goal",node:"repeat"})};
    w=interactGameplay2D(d2,w,"player").world;
    expect(w.behaviorState?.debug.paused).toBe(true);expect(w.behaviorState?.jobs[0].cursor).toBe("repeat");
    expect(stepGameplay(d2,w,{controlled:"player",input:NO_INPUT}).world).toBe(w);
    w=advanceBehaviors2D(d2,w,"player",[],"step").world;
    expect(w.time).toBe(0);expect(w.behaviorState?.jobs[0].cursor).toBe("delay");
    w={...w,behaviorState:controlBehavior(w.behaviorState,"continue")};
    w=advanceBehaviors2D(d2,w,"player").world;
    expect(w.behaviorState?.jobs[0].due).toBe(.1);
    expect(w.behaviorState?.debug.trace.map(t=>t.node)).toEqual(["entry","repeat","delay"]);
    w={...w,behaviorState:controlBehavior(w.behaviorState,"pause")};
    expect(interactGameplay2D(d2,w,"player").world).toBe(w);
});
test("despawn, changed/disabled graphs and fresh runs cancel pending work",()=>{
    const {d2}=fixtures();const w=interactGameplay2D(d2,worldFrom(d2),"player").world;
    const removed=advanceBehaviors2D(d2,applyCommands(w,[{kind:"despawn",bodyId:"goal"}]),"player").world;
    expect(removed.behaviorState?.jobs).toHaveLength(0);expect(worldFrom(d2).behaviorState).toBeUndefined();
    d2.behaviorAssets![0]={...d2.behaviorAssets![0],graph:{...graph(),enabled:false}};
    expect(advanceBehaviors2D(d2,w,"player").world.behaviorState?.jobs).toHaveLength(0);
    d2.behaviorAssets![0]={...d2.behaviorAssets![0],graph:{...graph(),nodes:graph().nodes.slice(0,-1).map(n=>n.kind==="repeat"?{...n,next:null}:n)}};
    expect(advanceBehaviors2D(d2,w,"player").world.behaviorState?.errors[0]).toContain("changed");
});
test("asset promotion/editing is atomic, undoable and rejects missing references",()=>{
    const d=new ActionDispatcher(gameReference()),entity=d.getDocument().nodes.get("goal")!.entity!;
    const action=new SetBehaviorAssetsAction(d.getDocument(),[{id:"shared",name:"Shared",graph:graph()}],{nodeId:"goal",entity:{...entity,behaviorAssetId:"shared"}});
    expect(d.dispatchAction(new TransactionAction(d.getDocument(),"Promote graph",[action])).success).toBe(true);
    const saved=serializeDocument(d.getDocument());expect(deserializeDocument(saved).behaviorAssets?.[0].graph).toEqual(graph());
    expect(d.dispatchAction(new SetBehaviorAssetsAction(d.getDocument(),[])).success).toBe(false);
    expect(d.dispatchAction(new UpdateNodeContentAction(d.getDocument(),"goal",{entity:{behaviorAssetId:"missing"}})).success).toBe(false);
    expect(serializeDocument(d.getDocument())).toBe(saved);
    expect(d.undo()?.behaviorAssets).toBeUndefined();expect(d.getDocument().nodes.get("goal")!.entity!.behaviorAssetId).toBeUndefined();
});
test.each([0,101,1.5,Infinity])("invalid repeat count %s is refused",count=>{
    const g=graph();(g.nodes[1] as any).count=count;expect(behaviorGraphError(g)).not.toBeNull();
});
test.each([0,-1,3601,Infinity])("invalid timer duration %s is refused",seconds=>{
    const g=graph();(g.nodes[2] as any).seconds=seconds;expect(behaviorGraphError(g)).not.toBeNull();
});
test("scheduler bounds event floods, nesting, execution and traces",()=>{
    const {d2}=fixtures(),tick=(state:BehaviorState|undefined,events:any[]=[])=>tickBehaviors({doc:d2,state,time:1,events,controlled:"player",position:()=>({x:0,y:0,z:0}),tallies:new Map(),profile:"2d"});
    const flood=tick(undefined,Array.from({length:300},()=>({owner:"goal",other:"player",event:"interact"})));
    expect(flood.state?.jobs).toHaveLength(256);expect(flood.state?.errors.join()).toContain("queue limit");
    const g=graph();g.nodes=[g.nodes[0],...Array.from({length:3},(_,i)=>({id:i?"r"+i:"repeat",kind:"repeat" as const,count:100,body:i===2?"score":"r"+(i+1),next:null})),g.nodes[3]];
    d2.behaviorAssets![0]={id:"shared",name:"Long",graph:g};
    let result=tick(controlBehavior(undefined,"enable"),[{owner:"goal",other:"player",event:"interact"}]);
    for(let i=0;i<12;i++)result=tick(result.state);
    expect(result.state?.errors.join()).toContain("10000");expect(result.state?.jobs).toHaveLength(0);expect(result.state?.debug.trace).toHaveLength(128);
});
test("owned timer example reopens and completes three timed spawns through its shared asset",()=>{
    const doc=deserializeDocument(readFileSync(resolve(__dirname,"../../..","reference-projects/behavior-timers.vde"),"utf8"));
    let world=interact3D(doc,world3DFrom(doc),"triangle");
    for(let i=0;i<180;i++)world=stepWorld3D(doc,world);
    expect(world.tallies?.get("timedSpawns")).toBe(3);
    expect(world.spawns).toHaveLength(3);expect(world.checkpoint?.playerId).toBe("triangle");
});
