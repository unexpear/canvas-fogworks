/** @module ActorBehaviors.test @description Actor dependency closure, isolated reference binding and actual nested function effects. */
import {captureActorBehaviors,bindActorBehaviors} from "./ActorBehaviors";
import {BehaviorFunction,FunctionCall} from "./BehaviorFunctions";
import {BehaviorGraph} from "./BehaviorGraph";
import {gameReference} from "../examples/ReferenceProjects";
import {emptyGameplayData} from "../runtime/GameplayDataState";
import {startFunctionExecution,stepFunctionExecution,FunctionStepContext} from "../runtime/BehaviorFunctionExecution";
const call:FunctionCall={id:"call",kind:"call",functionId:"outer",inputs:[],outputs:[],next:null};
const graph:BehaviorGraph={version:5,enabled:true,nodes:[
    {id:"start",kind:"event",event:"spawn",other:"any",next:"call"},call]};
function fixture(){
    const doc=gameReference(),root=doc.nodes.get("goal")!;
    doc.nodes.set("goal",{...root,children:["child"],entity:{behaviorAssetId:"shared"}});
    doc.nodes.set("child",{...root,id:"child",parent:"goal",children:[],entity:{behavior:graph}});
    doc.behaviorAssets=[{id:"shared",name:"Shared",graph}];
    const inner:BehaviorFunction={id:"child",name:"Spawn child",inputs:[],outputs:[],locals:[],entry:"spawn",nodes:[
        {id:"spawn",kind:"action",target:"self",action:{kind:"spawn",templateId:"child"},next:"score"},
        {id:"score",kind:"action",target:"self",action:{kind:"score",key:"child"},next:"return"},
        {id:"return",kind:"return",values:[]}]};
    doc.behaviorFunctions=[{...inner,id:"unused"},{...inner,id:"outer",name:"Outer",entry:"call",nodes:[
        {...call,functionId:"child",next:"return"},{id:"return",kind:"return",values:[]}]},inner];
    return doc;
}
test("captures shared and inline graphs with only their transitive function dependencies",()=>{
    const doc=fixture(),before=JSON.stringify([...doc.nodes]);
    const source=captureActorBehaviors(doc,"goal");
    expect([...source.graphs.keys()]).toEqual(["goal","child"]);
    expect(source.functions.map(f=>f.id)).toEqual(["outer","child"]);
    expect(source.graphs.get("goal")).not.toBe(doc.behaviorAssets![0].graph);
    source.graphs.get("goal")!.enabled=false;source.functions[0].name="Changed";
    expect(doc.behaviorAssets![0].graph.enabled).toBe(true);expect(doc.behaviorFunctions![1].name).toBe("Outer");
    expect(JSON.stringify([...doc.nodes])).toBe(before);
});
test("two bound actors execute nested calls against their own children without changing the shared library",()=>{
    const doc=fixture(),before=JSON.stringify(doc.behaviorFunctions),source=captureActorBehaviors(doc,"goal");
    for(const suffix of ["A","B"]){
        const bound=bindActorBehaviors(source,new Map([["goal","goal"+suffix],["child","child"+suffix]]));
        expect([...bound.graphs.keys()]).toEqual(["goal"+suffix,"child"+suffix]);
        const data=emptyGameplayData();
        let context:FunctionStepContext={call,execution:startFunctionExecution(call,bound.functions,data,[],"goal"+suffix),data,variables:[],owner:"goal"+suffix,other:null,controlled:null,tallies:new Map()};
        const effects=[];
        for(let i=0;i<8;i++){
            const result=stepFunctionExecution(context);
            if(result.effect.action)effects.push(result.effect.action.action);
            context={...context,execution:result.execution,data:result.data};if(result.done)break;
        }
        expect(context.execution.frames).toHaveLength(0);
        expect(effects).toEqual([{kind:"spawn",templateId:"child"+suffix},{kind:"score",key:"child"}]);
    }
    expect(JSON.stringify(doc.behaviorFunctions)).toBe(before);
    expect(source.functions[1].nodes[0]).toMatchObject({action:{templateId:"child"}});
});
test("disabled graphs retain dependencies and external scene references are not rewritten",()=>{
    const doc=fixture();doc.behaviorAssets![0].graph={...graph,enabled:false};
    const f=doc.behaviorFunctions![2];doc.behaviorFunctions![2]={...f,nodes:f.nodes.map(n=>n.kind==="action"&&n.action.kind==="spawn"?{...n,action:{...n.action,templateId:"external"}}:n)};
    const bound=bindActorBehaviors(captureActorBehaviors(doc,"goal"),new Map([["goal","copy"],["child","copyChild"]]));
    expect(bound.graphs.get("copy")!.enabled).toBe(false);
    expect(bound.functions[1].nodes[0]).toMatchObject({action:{templateId:"external"}});
});
test("missing assets/functions and ambiguous owners fail without altering source data",()=>{
    const doc=fixture();doc.behaviorAssets=[];
    expect(()=>captureActorBehaviors(doc,"goal")).toThrow("Missing actor behavior asset");
    const missing=fixture();missing.behaviorFunctions=missing.behaviorFunctions!.filter(f=>f.id!=="child");
    expect(()=>captureActorBehaviors(missing,"goal")).toThrow();
    const both=fixture();both.nodes.get("goal")!.entity!.behavior=graph;
    expect(()=>captureActorBehaviors(both,"goal")).toThrow("both");
    const source=captureActorBehaviors(fixture(),"goal");
    expect(()=>bindActorBehaviors(source,new Map([["goal","same"],["child","same"]]))).toThrow("distinct");
    expect(()=>bindActorBehaviors(source,new Map([["goal","copy"]]))).toThrow("mapped");
    const silent=fixture();silent.nodes.get("child")!.entity=undefined;
    expect(()=>bindActorBehaviors(captureActorBehaviors(silent,"goal"),new Map([["goal","copy"]]))).toThrow("mapped");
    expect(()=>bindActorBehaviors(source,new Map([["goal","copy"],["child","bad::id"]]))).toThrow("valid");
});
