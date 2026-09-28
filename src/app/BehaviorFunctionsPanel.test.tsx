/** @jest-environment jsdom */
/** @module BehaviorFunctionsPanel.test @description Visual function definitions, draft safety, Actions/history and authored execution without JSON editing. */
import React,{act,useState} from "react";
import {createRoot} from "react-dom/client";
import {GameplayPanel} from "./GameplayPanel";
import {ActionDispatcher} from "../core/actions/ActionDispatcher";
import {SetBehaviorFunctionsAction} from "../core/actions/SetBehaviorFunctionsAction";
import {UpdateNodeContentAction} from "../core/actions/UpdateNodeContentAction";
import {gameReference} from "../core/examples/ReferenceProjects";
import {serializeDocument,deserializeDocument} from "../core/document/Serializer";
import {worldFrom,NO_INPUT} from "../core/runtime/World";
import {stepGameplay} from "../core/runtime/GameplaySession";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
async function harness(){
    const doc=gameReference();doc.gameplayVariables=[{id:"health",scope:"entity",type:"number",initial:100}];
    const dispatcher=new ActionDispatcher(doc),host=document.createElement("div"),root=createRoot(host);
    let rerender=()=>{};
    function Harness(){const [,refresh]=useState(0);rerender=()=>refresh(n=>n+1);const current=dispatcher.getDocument();return <GameplayPanel entity={current.nodes.get("goal")!.entity!} variables={current.gameplayVariables} functions={current.behaviorFunctions}
        onFunctionsChange={functions=>{const result=dispatcher.dispatchAction(new SetBehaviorFunctionsAction(dispatcher.getDocument(),functions));rerender();return result.success;}}
        onChange={entity=>{expect(dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(),"goal",{entity})).success).toBe(true);rerender();}}/>;}
    await act(async()=>root.render(<Harness/>));
    const click=async(text:string)=>act(async()=>{const button=[...host.querySelectorAll("button")].find(b=>b.textContent===text);expect(button).toBeDefined();button!.click();});
    const select=async(label:string,value:string)=>act(async()=>{const input=host.querySelector<HTMLSelectElement>('[aria-label="'+label+'"]')!;expect(input).not.toBeNull();input.value=value;input.dispatchEvent(new Event("change",{bubbles:true}));});
    const input=async(label:string,value:string)=>act(async()=>{const element=host.querySelector<HTMLInputElement>('[aria-label="'+label+'"]')!;expect(element).not.toBeNull();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(element,value);element.dispatchEvent(new Event("input",{bubbles:true}));});
    const node=async(id:string)=>act(async()=>host.querySelector('[aria-label="Select function node '+id+'"]')!.dispatchEvent(new MouseEvent("click",{bubbles:true})));
    return {dispatcher,host,root,click,select,input,node,refresh:async()=>act(async()=>rerender()),close:async()=>act(async()=>root.unmount())};
}
test("create a typed waiting function visually, apply atomically, call it and reopen/undo",async()=>{
    const h=await harness();try{
        await h.click("New function");const empty=serializeDocument(h.dispatcher.getDocument());
        await h.input("Function name","Echo after wait");await h.click("Add function inputs");await h.click("Add function outputs");
        expect(serializeDocument(h.dispatcher.getDocument())).toBe(empty);
        await h.select("Return value1 source","input");await h.click("Add function delay node");await h.input("Function delay seconds","0.1");await h.select("Function entry","delay1");
        await h.click("Apply function draft");
        const doc=h.dispatcher.getDocument(),fn=doc.behaviorFunctions![0];
        expect(fn.name).toBe("Echo after wait");expect(fn.entry).toBe("delay1");expect(fn.nodes.find(n=>n.kind==="return")).toMatchObject({values:[{id:"value1",value:{kind:"input",id:"value1"}}]});
        expect(h.host.querySelector('[role="alert"]')).toBeNull();
        await h.click("Add behavior graph");await h.click("Add call node");await h.input("Function input value1 value","25");
        expect([...h.host.querySelectorAll("summary")].find(s=>s.textContent?.startsWith("Reusable functions"))?.textContent).not.toContain("unapplied");
        const withCall=h.dispatcher.getDocument(),graph=withCall.nodes.get("goal")!.entity!.behavior!;
        expect(h.dispatcher.dispatchAction(new UpdateNodeContentAction(withCall,"goal",{entity:{behavior:{...graph,nodes:graph.nodes.map(n=>n.kind==="event"?{...n,event:"start",other:"any",next:"call1"}:n)}}})).success).toBe(true);
        const reopened=deserializeDocument(serializeDocument(h.dispatcher.getDocument()));let world=worldFrom(reopened);
        for(let i=0;i<10;i++)world=stepGameplay(reopened,world,{controlled:"player",input:NO_INPUT}).world;
        expect(world.behaviorState?.data?.entities.get("goal")?.get("health")).toBe(25);expect(world.behaviorState?.errors).toEqual([]);
        await h.refresh();await h.click("Delete function");expect(h.host.querySelector('[role="alert"]')?.textContent).toContain("invalidate");
        expect(h.dispatcher.getDocument().behaviorFunctions).toHaveLength(1);
        for(let i=0;i<5;i++)h.dispatcher.undo();
        expect(serializeDocument(h.dispatcher.getDocument())).toBe(empty);
    }finally{await h.close();}
});
test("cyclic drafts and switching do not replace the saved function; discard restores its body",async()=>{
    const h=await harness();try{
        await h.click("New function");const before=serializeDocument(h.dispatcher.getDocument());
        await h.click("Add function delay node");await h.click("Add function repeat node");await h.select("Function body","delay1");
        await h.node("delay1");await h.select("Function next","repeat1");await h.click("Apply function draft");
        expect(h.host.querySelector('[role="alert"]')?.textContent).toContain("cycles");expect(serializeDocument(h.dispatcher.getDocument())).toBe(before);
        await h.click("New function");expect(h.host.querySelector('[role="alert"]')?.textContent).toContain("discard");
        await h.click("Discard function draft");expect(h.host.querySelector('[aria-label="Select function node delay1"]')).toBeNull();
        await h.click("Add function outputs");await h.select("Function outputs type 0","boolean");await h.click("Use boolean default");await h.click("Apply function draft");
        expect(h.dispatcher.getDocument().behaviorFunctions![0].nodes[0]).toMatchObject({values:[{value:{kind:"literal",value:false}}]});
    }finally{await h.close();}
});
test("external function changes do not overwrite an unapplied draft",async()=>{
    const h=await harness();try{
        await h.click("New function");await h.input("Function name","My draft");
        const functions=h.dispatcher.getDocument().behaviorFunctions!.map(f=>({...f,name:"External edit"}));
        expect(h.dispatcher.dispatchAction(new SetBehaviorFunctionsAction(h.dispatcher.getDocument(),functions)).success).toBe(true);await h.refresh();
        expect(h.host.querySelector<HTMLInputElement>('[aria-label="Function name"]')!.value).toBe("My draft");
        await h.click("Apply function draft");expect(h.host.querySelector('[role="alert"]')?.textContent).toContain("outside this draft");
        expect(h.dispatcher.getDocument().behaviorFunctions![0].name).toBe("External edit");await h.click("Discard function draft");
        expect(h.host.querySelector<HTMLInputElement>('[aria-label="Function name"]')!.value).toBe("External edit");
    }finally{await h.close();}
});

test("visual nested calls use caller locals and support arithmetic before returning",async()=>{
    const h=await harness();try{
        await h.click("New function");await h.click("Add function inputs");await h.click("Add function outputs");await h.select("Return value1 source","input");await h.click("Apply function draft");
        await h.click("New function");await h.click("Add function outputs");await h.click("Add function locals");await h.select("Return value1 source","local");
        await h.click("Add function call node");await h.input("Nested input value1 value","25");
        expect(h.host.querySelector<HTMLSelectElement>('[aria-label="Nested output value1"]')?.value).toBe("local:value1");
        await h.select("Function entry","call1");await h.click("Add function local node");await h.select("Function assignment operation","add");await h.input("Function assignment value","25");
        await h.node("call1");await h.select("Function next","local1");await h.click("Apply function draft");expect(h.host.querySelector('[role="alert"]')).toBeNull();
        await h.click("Add behavior graph");await h.click("Add call node");await h.select("Called function","function2");
        const doc=h.dispatcher.getDocument(),graph=doc.nodes.get("goal")!.entity!.behavior!;
        expect(h.dispatcher.dispatchAction(new UpdateNodeContentAction(doc,"goal",{entity:{behavior:{...graph,nodes:graph.nodes.map(n=>n.kind==="event"?{...n,event:"start",other:"any",next:"call1"}:n)}}})).success).toBe(true);
        const reopened=deserializeDocument(serializeDocument(h.dispatcher.getDocument()));const world=stepGameplay(reopened,worldFrom(reopened),{controlled:"player",input:NO_INPUT}).world;
        expect(world.behaviorState?.errors).toEqual([]);expect(world.behaviorState?.data?.entities.get("goal")?.get("health")).toBe(50);
    }finally{await h.close();}
});
