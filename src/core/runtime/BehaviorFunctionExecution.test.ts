/** @module BehaviorFunctionExecution.test @description Nested function stepping, isolated locals, repeats and scheduler-owned waits/effects. */
import {BehaviorFunction,FunctionCall} from "../document/BehaviorFunctions";
import {GameplayVariable} from "../document/GameplayData";
import {emptyGameplayData,readGameplayValue} from "./GameplayDataState";
import {startFunctionExecution,stepFunctionExecution,FunctionStepContext} from "./BehaviorFunctionExecution";
const variables:GameplayVariable[]=[{id:"health",scope:"entity",type:"number",initial:100}];
const child:BehaviorFunction={id:"child",name:"Child",inputs:[{id:"amount",type:"number"}],outputs:[{id:"result",type:"number"}],locals:[{id:"sum",type:"number"}],entry:"repeat",nodes:[
    {id:"repeat",kind:"repeat",count:2,body:"wait",next:"return"},
    {id:"wait",kind:"delay",seconds:.1,next:"add"},
    {id:"add",kind:"local",variable:"sum",operation:"add",value:{kind:"input",id:"amount"},next:null},
    {id:"return",kind:"return",values:[{id:"result",value:{kind:"local",id:"sum"}}]}]};
const parent:BehaviorFunction={id:"parent",name:"Parent",inputs:[],outputs:[{id:"result",type:"number"}],locals:[{id:"answer",type:"number"}],entry:"call",nodes:[
    {id:"call",kind:"call",functionId:"child",inputs:[{id:"amount",value:{kind:"literal",value:25}}],outputs:[{id:"result",target:{kind:"local",id:"answer"}}],next:"return"},
    {id:"return",kind:"return",values:[{id:"result",value:{kind:"local",id:"answer"}}]}]};
const call:FunctionCall={id:"root",kind:"call",functionId:"parent",inputs:[],outputs:[{id:"result",target:{kind:"variable",scope:"entity",id:"health"}}],next:null};
function initial():FunctionStepContext{const data=emptyGameplayData();return {call,execution:startFunctionExecution(call,[parent,child],data,variables,"a"),data,variables,owner:"a",other:null,controlled:null,tallies:new Map()};}
test("nested functions resume individual instructions around waits and return through isolated caller locals",()=>{
    let context=initial();const original=JSON.stringify(context.execution),waits:number[]=[],nodes:string[]=[];
    for(let i=0;i<20;i++){
        const prior=context.execution,snapshot=JSON.stringify(prior),result=stepFunctionExecution(context);
        expect(JSON.stringify(prior)).toBe(snapshot);nodes.push(result.functionId+"/"+result.nodeId);
        if(result.effect.wait!==undefined)waits.push(result.effect.wait);
        context={...context,data:result.data,execution:result.execution};if(result.done)break;
    }
    expect(context.execution.frames).toHaveLength(0);expect(waits).toEqual([.1,.1]);
    expect(nodes).toEqual(["parent/call","child/repeat","child/wait","child/add","child/wait","child/add","child/return","parent/return"]);
    expect(readGameplayValue(context.data,variables,"a","entity","health")).toBe(50);
    expect(readGameplayValue(context.data,variables,"b","entity","health")).toBe(100);
    expect(JSON.stringify(initial().execution)).toBe(original);
});
test("functions that fall off a path fail without pretending to return output",()=>{
    const broken:BehaviorFunction={...parent,entry:"end",nodes:[{id:"end",kind:"delay",seconds:.1,next:null},...parent.nodes]};
    const context=initial();context.execution=startFunctionExecution(call,[broken,child],context.data,variables,"a");
    const waiting=stepFunctionExecution(context);expect(waiting.effect.wait).toBe(.1);
    expect(()=>stepFunctionExecution({...context,execution:waiting.execution})).toThrow("without returning");
    expect(context.data.entities.size).toBe(0);
});
