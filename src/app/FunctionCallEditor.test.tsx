/** @jest-environment jsdom */
/** @module FunctionCallEditor.test @description Inspector call authoring through real Actions, typed arguments, output destinations and project reopen. */
import React,{act,useState} from "react";
import {createRoot} from "react-dom/client";
import {GameplayPanel} from "./GameplayPanel";
import {gameReference} from "../core/examples/ReferenceProjects";
import {ActionDispatcher} from "../core/actions/ActionDispatcher";
import {UpdateNodeContentAction} from "../core/actions/UpdateNodeContentAction";
import {serializeDocument,deserializeDocument} from "../core/document/Serializer";
import {defaultFunctionCall} from "./FunctionCallEditor";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
test("inspector adds typed calls and preserves bindings through save/reopen and undo",async()=>{
    const doc=gameReference();doc.gameplayVariables=[{id:"health",scope:"entity",type:"number",initial:100}];
    doc.behaviorFunctions=[{id:"echo",name:"Echo",inputs:[{id:"amount",type:"number"}],outputs:[{id:"value",type:"number"}],locals:[],entry:"return",nodes:[{id:"return",kind:"return",values:[{id:"value",value:{kind:"input",id:"amount"}}]}]}];
    expect(defaultFunctionCall("call",doc.behaviorFunctions[0],[])).toBeNull();
    const dispatcher=new ActionDispatcher(doc),host=document.createElement("div"),root=createRoot(host);
    function Harness(){const [,refresh]=useState(0),current=dispatcher.getDocument();return <GameplayPanel entity={current.nodes.get("goal")!.entity!} variables={current.gameplayVariables} functions={current.behaviorFunctions} onChange={entity=>{expect(dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(),"goal",{entity})).success).toBe(true);refresh(n=>n+1);}}/>;}
    const click=async(text:string)=>act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent===text)!.click();});
    try{
        await act(async()=>root.render(<Harness/>));await click("Add behavior graph");await click("Add call node");
        expect(host.querySelector<HTMLSelectElement>('[aria-label="Called function"]')?.value).toBe("echo");
        await act(async()=>{const input=host.querySelector<HTMLInputElement>('[aria-label="Function input amount value"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"25");input.dispatchEvent(new Event("input",{bubbles:true}));});
        const saved=deserializeDocument(serializeDocument(dispatcher.getDocument())),graph=saved.nodes.get("goal")!.entity!.behavior!;
        expect(graph.version).toBe(5);expect(graph.nodes.find(n=>n.kind==="call")).toMatchObject({functionId:"echo",inputs:[{id:"amount",value:{kind:"literal",value:25}}],outputs:[{id:"value",target:{kind:"variable",scope:"entity",id:"health"}}]});
        dispatcher.undo();expect(dispatcher.getDocument().nodes.get("goal")!.entity!.behavior!.nodes.find(n=>n.kind==="call")).toMatchObject({inputs:[{value:{value:0}}]});
    }finally{await act(async()=>root.unmount());}
});
