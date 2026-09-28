/** @module BehaviorFunctions.test @description Function signatures, local frames, typed call/return bindings and bounded nonrecursive call graphs. */
import {BehaviorFunction,FunctionCall,behaviorFunctionsError,functionCallError,functionSourceType} from "./BehaviorFunctions";
import {GameplayVariable} from "./GameplayData";
import {gameReference} from "../examples/ReferenceProjects";
import {ActionDispatcher} from "../actions/ActionDispatcher";
import {SetBehaviorFunctionsAction} from "../actions/SetBehaviorFunctionsAction";
import {SetGameplayVariablesAction} from "../actions/SetGameplayVariablesAction";
import {TransactionAction} from "../actions/TransactionAction";
import {serializeDocument,deserializeDocument} from "./Serializer";
const variables:GameplayVariable[]=[{id:"health",scope:"entity",type:"number",initial:100},{id:"ready",scope:"game",type:"boolean",initial:false}];
function subtract():BehaviorFunction{return {id:"subtract",name:"Apply damage",inputs:[{id:"amount",type:"number"}],outputs:[{id:"remaining",type:"number"}],locals:[{id:"result",type:"number"}],entry:"copy",nodes:[
    {id:"copy",kind:"local",variable:"result",operation:"set",value:{kind:"variable",scope:"entity",id:"health"},next:"subtract"},
    {id:"subtract",kind:"local",variable:"result",operation:"subtract",value:{kind:"input",id:"amount"},next:"wait"},
    {id:"wait",kind:"delay",seconds:.1,next:"return"},
    {id:"return",kind:"return",values:[{id:"remaining",value:{kind:"local",id:"result"}}]}
]};}
function call():FunctionCall{return {id:"call",kind:"call",functionId:"subtract",inputs:[{id:"amount",value:{kind:"literal",value:25}}],outputs:[{id:"remaining",target:{kind:"variable",scope:"entity",id:"health"}}],next:null};}
test("function contracts support typed inputs, independent local values, waiting and explicit output bindings",()=>{
    const functions=[subtract()];
    expect(behaviorFunctionsError(functions,variables)).toBeNull();
    expect(functionCallError(call(),functions,variables)).toBeNull();
    expect(functionSourceType({kind:"local",id:"result"},variables,functions[0])).toBe("number");
    expect(functionSourceType({kind:"input",id:"amount"},variables,functions[0])).toBe("number");
    expect(()=>functionSourceType({kind:"local",id:"result"},variables)).toThrow("local");
});
test("missing, duplicate, unknown or mistyped function ports and call bindings are refused",()=>{
    for(const patch of [
        {id:""},{extra:true},{inputs:[{id:"amount",type:"object"}]},
        {inputs:[{id:"amount",type:"number"},{id:"amount",type:"number"}]},
        {locals:[{id:"result",type:"boolean"}]},{outputs:[{id:"remaining",type:"boolean"}]},
        {entry:"missing"},{nodes:[]}
    ])expect(behaviorFunctionsError([{...subtract(),...patch}],variables)).not.toBeNull();
    expect(behaviorFunctionsError([subtract(),subtract()],variables)).toContain("duplicate");
    for(const patch of [
        {functionId:"missing"},{inputs:[]},{outputs:[]},{extra:true},
        {inputs:[{id:"amount",value:{kind:"literal",value:"25"}}]},
        {inputs:[{id:"amount",value:{kind:"input",id:"amount"}}]},
        {inputs:[{id:"amount",value:{kind:"local",id:"result"}}]},
        {outputs:[{id:"remaining",target:{kind:"variable",scope:"game",id:"ready"}}]},
        {outputs:[{id:"remaining",target:{kind:"local",id:"result"}}]}
    ])expect(functionCallError({...call(),...patch} as FunctionCall,[subtract()],variables)).not.toBeNull();
});
test("function bodies reuse ordinary graph validation without accepting events or malformed local nodes",()=>{
    const f=subtract();
    const badNodes:unknown[]=[
        {...f.nodes[0],extra:true}, {...f.nodes[0],operation:"unknown"},
        {...f.nodes[0],value:{kind:"local",id:"result",extra:true}},
        {...f.nodes[0],next:"missing"}, {...f.nodes[0],next:"copy"},
        {id:"copy",kind:"event",event:"start",other:"any",next:"subtract"},
        {id:"copy",kind:"unknown",next:null}
    ];
    for(const node of badNodes)expect(behaviorFunctionsError([{...f,nodes:[node,...f.nodes.slice(1)]}],variables)).not.toBeNull();
    expect(behaviorFunctionsError([{...f,nodes:f.nodes.slice(0,-1).map(n=>n.id==="wait"?{...n,next:null}:n)}],variables)).toContain("return");
    expect(behaviorFunctionsError([{...f,nodes:[...f.nodes,{id:"bad",kind:"return",values:[{id:"remaining",value:{kind:"literal",value:false}}]}]}],variables)).toContain("type");
});
function wrapper(id:string,callee:string):BehaviorFunction{return {id,name:id,inputs:[],outputs:[],locals:[],entry:"call",nodes:[
    {id:"call",kind:"call",functionId:callee,inputs:[],outputs:[],next:"return"},
    {id:"return",kind:"return",values:[]}]};}
test("forward calls resolve but direct/indirect recursion and excessive depth are refused",()=>{
    const leaf:BehaviorFunction={id:"leaf",name:"Leaf",inputs:[],outputs:[],locals:[],entry:"return",nodes:[{id:"return",kind:"return",values:[]}]};
    expect(behaviorFunctionsError([wrapper("outer","leaf"),leaf])).toBeNull();
    expect(behaviorFunctionsError([wrapper("outer","outer")])).toContain("Recursive");
    expect(behaviorFunctionsError([wrapper("a","b"),wrapper("b","a")])).toContain("Recursive");
    expect(behaviorFunctionsError([wrapper("outer","missing")])).toContain("Missing");
    const chain=[leaf];for(let i=0;i<15;i++)chain.push(wrapper("f"+i,i?"f"+(i-1):"leaf"));
    expect(behaviorFunctionsError(chain)).toBeNull();
    expect(behaviorFunctionsError([...chain,wrapper("tooDeep","f14")])).toContain("depth");
});
test("nested calls bind outputs to caller-local values without aliasing input or gameplay fields",()=>{
    const inner=subtract(),outer:BehaviorFunction={id:"outer",name:"Outer",inputs:[{id:"amount",type:"number"}],outputs:[{id:"answer",type:"number"}],locals:[{id:"result",type:"number"}],entry:"call",nodes:[
        {...call(),inputs:[{id:"amount",value:{kind:"input",id:"amount"}}],outputs:[{id:"remaining",target:{kind:"local",id:"result"}}],next:"return"},
        {id:"return",kind:"return",values:[{id:"answer",value:{kind:"local",id:"result"}}]}]};
    expect(behaviorFunctionsError([outer,inner],variables)).toBeNull();
    const duplicateOutputs={...inner,outputs:[...inner.outputs,{id:"other",type:"number" as const}]};
    expect(functionCallError({...call(),outputs:[...call().outputs,{id:"other",target:{kind:"variable",scope:"entity",id:"health"}}]},[duplicateOutputs],variables)).toContain("same target");
});

test("function library edits serialize, reopen, undo and redo as one transaction",()=>{
    const dispatcher=new ActionDispatcher(gameReference()),doc=dispatcher.getDocument(),before=serializeDocument(doc);
    expect(dispatcher.dispatchAction(new TransactionAction(doc,"Define gameplay function",[
        new SetGameplayVariablesAction(doc,variables),new SetBehaviorFunctionsAction(doc,[subtract()])
    ])).success).toBe(true);
    const saved=serializeDocument(dispatcher.getDocument());
    expect(deserializeDocument(saved).behaviorFunctions).toEqual([subtract()]);
    expect(dispatcher.dispatchAction(new SetGameplayVariablesAction(dispatcher.getDocument(),[])).success).toBe(false);
    expect(serializeDocument(dispatcher.getDocument())).toBe(saved);
    dispatcher.undo();expect(serializeDocument(dispatcher.getDocument())).toBe(before);
    dispatcher.redo();expect(serializeDocument(dispatcher.getDocument())).toBe(saved);
});

test("library load and edits reject missing nested functions without damaging current history",()=>{
    const dispatcher=new ActionDispatcher(gameReference()),doc=dispatcher.getDocument();
    const leaf:BehaviorFunction={id:"leaf",name:"Leaf",inputs:[],outputs:[],locals:[],entry:"return",nodes:[{id:"return",kind:"return",values:[]}]};
    expect(dispatcher.dispatchAction(new SetBehaviorFunctionsAction(doc,[wrapper("outer","leaf"),leaf])).success).toBe(true);
    const saved=serializeDocument(dispatcher.getDocument());
    expect(dispatcher.dispatchAction(new SetBehaviorFunctionsAction(dispatcher.getDocument(),[wrapper("outer","leaf")])).success).toBe(false);
    expect(serializeDocument(dispatcher.getDocument())).toBe(saved);
    const corrupt=JSON.parse(saved);corrupt.document.behaviorFunctions.pop();
    expect(()=>deserializeDocument(JSON.stringify(corrupt))).toThrow("Missing");
    const old=JSON.parse(serializeDocument(gameReference()));old.version="83";
    expect(deserializeDocument(JSON.stringify(old)).behaviorFunctions).toBeUndefined();
    expect(dispatcher.dispatchAction(new SetBehaviorFunctionsAction(dispatcher.getDocument(),undefined)).success).toBe(true);
    expect(deserializeDocument(serializeDocument(dispatcher.getDocument())).behaviorFunctions).toBeUndefined();
});
