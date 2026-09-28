/** @module BehaviorFunctionFrames.test @description Independent function invocation storage, typed arithmetic and all-or-nothing return adoption. */
import {BehaviorFunction,FunctionCall} from "../document/BehaviorFunctions";
import {GameplayVariable} from "../document/GameplayData";
import {assignFunctionLocal,enterFunction,resolveFunctionSource,returnFunction} from "./BehaviorFunctionFrames";
import {emptyGameplayData,readGameplayValue} from "./GameplayDataState";
const variables:GameplayVariable[]=[{id:"health",scope:"entity",type:"number",initial:100},{id:"ready",scope:"game",type:"boolean",initial:false}];
const definition:BehaviorFunction={id:"damage",name:"Damage",inputs:[{id:"amount",type:"number"}],outputs:[{id:"remaining",type:"number"}],locals:[{id:"result",type:"number"}],entry:"return",nodes:[
    {id:"return",kind:"return",values:[{id:"remaining",value:{kind:"local",id:"result"}}]}]};
const call:FunctionCall={id:"call",kind:"call",functionId:"damage",inputs:[{id:"amount",value:{kind:"literal",value:25}}],outputs:[{id:"remaining",target:{kind:"variable",scope:"entity",id:"health"}}],next:null};
test("two invocations snapshot inputs and retain independent, immutable local frames",()=>{
    const data=emptyGameplayData(),a=enterFunction(call,[definition],data,variables,"a"),b=enterFunction(call,[definition],data,variables,"b");
    expect(a).toEqual(b);expect(a.inputs).not.toBe(b.inputs);expect(a.locals).not.toBe(b.locals);
    const initialized=assignFunctionLocal(definition,a,"result","set",100);
    const changed=assignFunctionLocal(definition,initialized,"result","subtract",resolveFunctionSource({kind:"input",id:"amount"},data,variables,"a",{definition,frame:a}));
    expect(changed.locals).toEqual([["result",75]]);expect(a.locals).toEqual([["result",0]]);expect(b.locals).toEqual([["result",0]]);
    const returned=returnFunction(definition,changed,"return",call,[definition],data,variables,"a");
    expect(readGameplayValue(returned.data,variables,"a","entity","health")).toBe(75);
    expect(readGameplayValue(returned.data,variables,"b","entity","health")).toBe(100);
    expect(data.entities.size).toBe(0);
    expect(JSON.parse(JSON.stringify(changed))).toEqual(changed);
});
test("local arithmetic rejects wrong types, zero division and overflow without changing frames",()=>{
    const frame=enterFunction(call,[definition],emptyGameplayData(),variables,"a");
    expect(()=>assignFunctionLocal(definition,frame,"result","set","wrong")).toThrow("type");
    expect(()=>assignFunctionLocal(definition,frame,"result","divide",0)).toThrow("zero");
    expect(()=>assignFunctionLocal(definition,frame,"result","set",Infinity)).toThrow("finite");
    expect(()=>assignFunctionLocal(definition,frame,"missing","set",1)).toThrow("local");
    expect(frame.locals).toEqual([["result",0]]);
});
test("nested return writes only a new caller-local frame",()=>{
    const parent:BehaviorFunction={id:"parent",name:"Parent",inputs:[],outputs:[],locals:[{id:"answer",type:"number"}],entry:"return",nodes:[{id:"return",kind:"return",values:[]}]};
    const functions=[parent,definition],data=emptyGameplayData();
    const parentFrame=enterFunction({...call,functionId:"parent",inputs:[],outputs:[]},functions,data,variables,"a");
    const nested:FunctionCall={...call,outputs:[{id:"remaining",target:{kind:"local",id:"answer"}}]};
    const frame=assignFunctionLocal(definition,enterFunction(nested,functions,data,variables,"a",{definition:parent,frame:parentFrame}),"result","set",75);
    const result=returnFunction(definition,frame,"return",nested,functions,data,variables,"a",{definition:parent,frame:parentFrame});
    expect(result.data).toBe(data);expect(result.caller?.locals).toEqual([["answer",75]]);expect(parentFrame.locals).toEqual([["answer",0]]);
});
test("a bad later output cannot partially adopt earlier returned values",()=>{
    const two:BehaviorFunction={...definition,outputs:[...definition.outputs,{id:"ready",type:"boolean"}],nodes:[{id:"return",kind:"return",values:[
        {id:"remaining",value:{kind:"literal",value:75}},{id:"ready",value:{kind:"local",id:"missing"}}]}]};
    const binding:FunctionCall={...call,outputs:[...call.outputs,{id:"ready",target:{kind:"variable",scope:"game",id:"ready"}}]};
    const data=emptyGameplayData(),frame=enterFunction(binding,[two],data,variables,"a");
    expect(()=>returnFunction(two,frame,"return",binding,[two],data,variables,"a")).toThrow("local");
    expect(data.entities.size).toBe(0);expect(data.game.size).toBe(0);
    expect(()=>returnFunction(two,{...frame,functionId:"wrong"},"return",binding,[two],data,variables,"a")).toThrow("frame");
});
