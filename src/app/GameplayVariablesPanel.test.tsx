/** @jest-environment jsdom */
/** @module GameplayVariablesPanel.test @description Reachable typed declarations, assignments, comparisons and invalidating-edit refusal. */
import React,{act,useState} from "react";
import {createRoot} from "react-dom/client";
import {GameplayPanel} from "./GameplayPanel";
import {ActionDispatcher} from "../core/actions/ActionDispatcher";
import {SetGameplayVariablesAction} from "../core/actions/SetGameplayVariablesAction";
import {UpdateNodeContentAction} from "../core/actions/UpdateNodeContentAction";
import {gameReference} from "../core/examples/ReferenceProjects";
import {serializeDocument,deserializeDocument} from "../core/document/Serializer";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
test("inspector declares a typed field, authors graph data nodes and refuses removing a referenced declaration",async()=>{
    const dispatcher=new ActionDispatcher(gameReference()),host=document.createElement("div"),root=createRoot(host);
    function Harness(){const [,refresh]=useState(0),doc=dispatcher.getDocument();return <GameplayPanel entity={doc.nodes.get("goal")!.entity!} variables={doc.gameplayVariables}
        onVariablesChange={variables=>{const result=dispatcher.dispatchAction(new SetGameplayVariablesAction(dispatcher.getDocument(),variables));refresh(n=>n+1);return result.success;}}
        onChange={entity=>{expect(dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(),"goal",{entity})).success).toBe(true);refresh(n=>n+1);}}/>;}
    const click=async(text:string)=>act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent===text)!.click();});
    const select=async(label:string,value:string)=>act(async()=>{const input=host.querySelector<HTMLSelectElement>('[aria-label="'+label+'"]')!;input.value=value;input.dispatchEvent(new Event("change",{bubbles:true}));});
    try{
        await act(async()=>root.render(<Harness/>));
        await click("Add gameplay variable");await click("Add behavior graph");await click("Add assign node");
        await select("Assignment operation","subtract");
        await act(async()=>{const input=host.querySelector<HTMLInputElement>('[aria-label="Assignment value"]')!;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"25");input.dispatchEvent(new Event("input",{bubbles:true}));});
        let doc=deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(doc.nodes.get("goal")!.entity!.behavior!.nodes.find(n=>n.kind==="assign")).toMatchObject({operation:"subtract",value:{kind:"literal",value:25}});
        await click("Remove gameplay variable value1");expect(host.querySelector('[role="alert"]')?.textContent).toContain("invalidate");
        expect(dispatcher.getDocument().gameplayVariables).toHaveLength(1);
        await click("Add compare node");await select("Left operand type","boolean");
        doc=deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(doc.nodes.get("goal")!.entity!.behavior!.nodes.find(n=>n.kind==="compare")).toMatchObject({left:{value:false},right:{value:false}});
        expect(doc.nodes.get("goal")!.entity!.behavior!.version).toBe(4);
    }finally{await act(async()=>root.unmount());}
});
