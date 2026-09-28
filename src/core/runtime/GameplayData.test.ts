/** @module GameplayData.test @description Typed gameplay declarations, immutable runtime data, history, graph bindings and 2D/3D saved execution. */
import {GameplayVariable,gameplayVariablesError,gameplayPortsError,gameplaySourceType} from "../document/GameplayData";
import {emptyGameplayData,assignGameplayValue,readGameplayValue} from "./GameplayDataState";
import {behaviorDataBindingsError} from "../document/BehaviorDataBindings";
import {tickBehaviors,controlBehavior} from "./BehaviorRuntime";
import {validateGameplayDataProgress,restoreGameplayData} from "./GameplayDataProgress";
import {BehaviorGraph} from "../document/BehaviorGraph";
import {gameReference} from "../examples/ReferenceProjects";
import {gameplayFixture} from "../tests/fixtures/GameplayFixture";
import {ActionDispatcher} from "../actions/ActionDispatcher";
import {SetGameplayVariablesAction} from "../actions/SetGameplayVariablesAction";
import {UpdateNodeContentAction} from "../actions/UpdateNodeContentAction";
import {TransactionAction} from "../actions/TransactionAction";
import {serializeDocument,deserializeDocument} from "../document/Serializer";
import {worldFrom,NO_INPUT} from "./World";
import {world3DFrom,stepWorld3D} from "./World3D";
import {stepGameplay} from "./GameplaySession";
import {captureProgress2D,captureProgress3D,serializeProgress,parseProgress,restoreProgress2D,restoreProgress3D} from "../../runtime/PlayerProgress";
const variables:GameplayVariable[]=[
    {id:"health",scope:"entity",type:"number",initial:100},
    {id:"keys",scope:"game",type:"number",initial:0},
    {id:"doorOpen",scope:"game",type:"boolean",initial:false},
    {id:"label",scope:"entity",type:"string",initial:"ready"}];
const graph=():BehaviorGraph=>({version:4,enabled:true,nodes:[
    {id:"start",kind:"event",event:"start",other:"any",next:"hurt"},
    {id:"hurt",kind:"assign",scope:"entity",variable:"health",operation:"subtract",value:{kind:"literal",value:25},next:"key"},
    {id:"key",kind:"assign",scope:"game",variable:"keys",operation:"add",value:{kind:"literal",value:1},next:"wait"},
    {id:"wait",kind:"delay",seconds:.1,next:"check"},
    {id:"check",kind:"compare",left:{kind:"variable",scope:"entity",id:"health"},right:{kind:"literal",value:75},operator:"lessEqual",onTrue:"count",onFalse:null},
    {id:"count",kind:"action",target:"self",action:{kind:"score",key:"checked"},next:null}]});
test("scalar declarations and function port contracts refuse duplicate IDs, wrong defaults and hostile values",()=>{
    expect(gameplayVariablesError(variables)).toBeNull();
    for(const patch of [{initial:"100"},{initial:Infinity},{type:"object"},{extra:true},{id:""}])
        expect(gameplayVariablesError([{...variables[0],...patch}])).not.toBeNull();
    expect(gameplayVariablesError([...variables,variables[0]])).toContain("Duplicate");
    expect(gameplayPortsError([{id:"amount",type:"number"},{id:"amount",type:"string"}])).toContain("duplicate");
    expect(gameplaySourceType({kind:"input",id:"amount"},variables,[{id:"amount",type:"number"}])).toBe("number");
    expect(()=>gameplaySourceType({kind:"variable",scope:"game",id:"missing"},variables)).toThrow("Missing");
});
test("actor values are isolated, game values shared and invalid arithmetic never mutates input",()=>{
    const original=emptyGameplayData();
    let state=assignGameplayValue(original,variables,"a","entity","health","subtract",25);
    state=assignGameplayValue(state,variables,"a","game","keys","add",2);
    expect(readGameplayValue(state,variables,"a","entity","health")).toBe(75);
    expect(readGameplayValue(state,variables,"b","entity","health")).toBe(100);
    expect(readGameplayValue(state,variables,"b","game","keys")).toBe(2);
    expect(original.entities.size).toBe(0);expect(original.game.size).toBe(0);
    for(const [op,value]of [["set","wrong"],["divide",0],["multiply",1e9]] as const)
        expect(()=>assignGameplayValue(state,variables,"a","entity","health",op,value)).toThrow();
    expect(()=>assignGameplayValue(state,variables,"a","game","doorOpen","add",true)).toThrow("numeric");
    expect(readGameplayValue(state,variables,"a","entity","health")).toBe(75);
});
test("declarations and graphs edit atomically, reopen and undo; bound types cannot be silently deleted",()=>{
    const d=new ActionDispatcher(gameReference()),doc=d.getDocument();
    const result=d.dispatchAction(new TransactionAction(doc,"Typed graph",[
        new SetGameplayVariablesAction(doc,variables),
        new UpdateNodeContentAction(doc,"goal",{entity:{behavior:graph()}})]));
    expect(result.success).toBe(true);
    const saved=serializeDocument(d.getDocument());
    expect(deserializeDocument(saved).gameplayVariables).toEqual(variables);
    expect(d.dispatchAction(new SetGameplayVariablesAction(d.getDocument(),[])).success).toBe(false);
    expect(serializeDocument(d.getDocument())).toBe(saved);
    expect(d.undo()?.gameplayVariables).toBeUndefined();
    expect(behaviorDataBindingsError(graph(),[])).toContain("undeclared");
});
test("both runtimes preserve assigned values through a delayed comparison and saved progress",()=>{
    const d2=gameReference(),d3=gameplayFixture(),goal=d2.nodes.get("goal")!,lever=d3.nodes.get("lever")!;
    d2.gameplayVariables=variables;d3.gameplayVariables=variables;
    d2.nodes.set("goal",{...goal,entity:{behavior:graph()}});
    d3.nodes.set("lever",{...lever,entity:{behavior:graph()}});
    let w2=stepGameplay(d2,worldFrom(d2),{controlled:"player",input:NO_INPUT}).world,w3=stepWorld3D(d3,world3DFrom(d3));
    expect(w2.behaviorState?.data?.entities.get("goal")?.get("health")).toBe(75);
    expect(w3.behaviorState?.data?.game.get("keys")).toBe(1);
    const hash="a".repeat(64);
    const saved2=parseProgress(serializeProgress(captureProgress2D(w2,hash,"entry","player")),hash,"2d");
    const saved3=parseProgress(serializeProgress(captureProgress3D(w3,hash,"entry","player")),hash,"3d");
    w2=restoreProgress2D(d2,saved2);w3=restoreProgress3D(d3,world3DFrom(d3),saved3);
    for(let i=0;i<8;i++){w2=stepGameplay(d2,w2,{controlled:"player",input:NO_INPUT}).world;w3=stepWorld3D(d3,w3);}
    expect(w2.tallies.get("checked")).toBe(1);expect(w3.tallies?.get("checked")).toBe(1);
    expect(w2.behaviorState?.data?.game.get("keys")).toBe(1);
    expect(d2.gameplayVariables[0].initial).toBe(100);
    const bad=JSON.parse(JSON.stringify(saved2));bad.data.entities[0][1][0][1]="wrong";
    expect(()=>restoreProgress2D(d2,bad)).toThrow("type");
});

test("invalid arithmetic cancels only its graph job and retains prior valid values",()=>{
    const doc=gameReference(),owner=doc.nodes.get("goal")!;
    doc.gameplayVariables=variables;
    doc.nodes.set(owner.id,{...owner,entity:{behavior:{version:4,enabled:true,nodes:[
        {id:"start",kind:"event",event:"start",other:"any",next:"valid"},
        {id:"valid",kind:"assign",scope:"entity",variable:"health",operation:"subtract",value:{kind:"literal",value:25},next:"invalid"},
        {id:"invalid",kind:"assign",scope:"entity",variable:"health",operation:"divide",value:{kind:"literal",value:0},next:"unreachable"},
        {id:"unreachable",kind:"action",target:"self",action:{kind:"score",key:"bad"},next:null},
        {id:"independent",kind:"event",event:"start",other:"any",next:"good"},
        {id:"good",kind:"action",target:"self",action:{kind:"score",key:"good"},next:null}
    ]}}});
    const result=tickBehaviors({doc,time:0,events:[{owner:owner.id,other:null,event:"start"}],controlled:null,position:()=>undefined,tallies:new Map(),profile:"2d"});
    expect(result.state?.errors.join()).toContain("division by zero");
    expect(result.state?.data?.entities.get(owner.id)?.get("health")).toBe(75);
    expect(result.state?.jobs).toHaveLength(0);
    expect(result.requests.map(r=>r.rule.action)).toEqual([{kind:"score",key:"good"}]);
});

test("breakpoint and single-step update typed watches once without mutating the paused snapshot",()=>{
    const doc=gameReference(),owner=doc.nodes.get("goal")!;doc.gameplayVariables=variables;
    doc.nodes.set(owner.id,{...owner,entity:{behavior:graph()}});
    const options={doc,time:0,controlled:null,position:()=>undefined,tallies:new Map<string,number>(),profile:"2d" as const};
    const paused=tickBehaviors({...options,state:controlBehavior(undefined,"enable",{owner:owner.id,node:"hurt"}),events:[{owner:owner.id,other:null,event:"start"}]}).state!;
    expect(paused.debug.paused).toBe(true);expect(paused.data).toBeUndefined();
    const stepped=tickBehaviors({...options,state:paused,events:[],mode:"step"}).state!;
    expect(stepped.data?.entities.get(owner.id)?.get("health")).toBe(75);
    expect(stepped.jobs[0].cursor).toBe("key");expect(paused.data).toBeUndefined();expect(paused.jobs[0].cursor).toBe("hurt");
    expect(tickBehaviors({...options,state:stepped,events:[]}).state).toBe(stepped);
});

test("saved typed tables reject duplicate, undeclared, malformed and oversized data before adoption",()=>{
    const doc=gameReference();doc.gameplayVariables=variables;
    for(const bad of [
        {game:[["keys",1],["keys",2]],entities:[]},
        {game:[],entities:[["goal",[]],["goal",[]]]},
        {game:[["keys",Infinity]],entities:[]},
        {game:[],entities:[["bad\nowner",[]]]},
        {game:[],entities:[],extra:true},
        {game:Array.from({length:257},(_,i)=>["key"+i,1]),entities:[]},
        {game:[["text","x".repeat(4097)]],entities:[]}
    ])expect(()=>validateGameplayDataProgress(bad)).toThrow();
    expect(()=>restoreGameplayData(doc,{game:[["unknown",1]],entities:[]})).toThrow("Undeclared");
    expect(()=>restoreGameplayData(doc,{game:[],entities:[["missing",[]]]})).toThrow("owner");
    expect(()=>restoreGameplayData(doc,{game:[["keys",false]],entities:[]})).toThrow("type");
    expect(restoreGameplayData(doc,undefined)).toEqual(emptyGameplayData());
});
