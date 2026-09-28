/** @jest-environment jsdom */
/** @module BehaviorGraphPanel.test @description Reachable graph editing, invalid-link refusal, persistence and undo through real entity Actions. */
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { SetBehaviorAssetsAction } from "../core/actions/SetBehaviorAssetsAction";
import { GameplayPanel } from "./GameplayPanel";
import { gameReference } from "../core/examples/ReferenceProjects";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { UpdateNodeContentAction } from "../core/actions/UpdateNodeContentAction";
import { deserializeDocument, serializeDocument } from "../core/document/Serializer";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
test("visual graph edits use Actions, refuse cycles, reconnect safely, save/reopen and undo",async()=>{
    const dispatcher=new ActionDispatcher(gameReference()),host=document.createElement("div"),root=createRoot(host);
    function Harness(){const [,render]=useState(0);return <GameplayPanel assets={dispatcher.getDocument().behaviorAssets} onAssetsChange={(assets,entity)=>{expect(dispatcher.dispatchAction(new SetBehaviorAssetsAction(dispatcher.getDocument(),assets,entity?{nodeId:"goal",entity}:undefined)).success).toBe(true);render(n=>n+1);}} entity={dispatcher.getDocument().nodes.get("goal")!.entity!} onChange={entity=>{
        expect(dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(),"goal",{entity})).success).toBe(true);render(n=>n+1);
    }}/>;}
    const click=async(label:string)=>act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent===label)!.click();});
    const selectNode=async(id:string)=>act(async()=>{host.querySelector(`[aria-label="Select behavior node ${id}"]`)!.dispatchEvent(new MouseEvent("click",{bubbles:true}));});
    const change=async(label:string,value:string)=>act(async()=>{const control=host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;control.value=value;control.dispatchEvent(new Event("change",{bubbles:true}));});
    try{
        await act(async()=>root.render(<Harness/>));await click("Add behavior graph");
        expect(host.querySelector('[aria-label="Behavior graph connections"]')).not.toBeNull();
        const initial=serializeDocument(dispatcher.getDocument());
        await selectNode("check");await change("Behavior true","count");
        expect(host.querySelector('[role="alert"]')?.textContent).toContain("cycles");expect(serializeDocument(dispatcher.getDocument())).toBe(initial);
        await change("Behavior false","win");
        expect(host.querySelector('[role="alert"]')).toBeNull();
        const saved=deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("goal")!.entity!.behavior!;
        expect(saved.nodes.find(n=>n.id==="check")).toMatchObject({onFalse:"win"});
        await selectNode("win");await change("Behavior action","spawn");
        expect(host.querySelector('[aria-label="Behavior template ID"]')).not.toBeNull();
        expect(dispatcher.getDocument().nodes.get("goal")!.entity!.behavior!.nodes.find(n=>n.id==="win")).toMatchObject({action:{kind:"spawn",templateId:"template"}});
        await selectNode("count");await click("Remove selected behavior node");
        expect(dispatcher.getDocument().nodes.get("goal")!.entity!.behavior!.nodes.find(n=>n.id==="interact")).toMatchObject({next:null});
        expect(dispatcher.undo()?.nodes.get("goal")!.entity!.behavior!.nodes.some(n=>n.id==="count")).toBe(true);
        await act(async()=>root.render(<Harness/>));await click("Remove behavior graph");
        expect(dispatcher.getDocument().nodes.get("goal")!.entity!.behavior).toBeUndefined();
        expect(dispatcher.getDocument().nodes.get("goal")!.entity!.rules).toHaveLength(1);
        expect(dispatcher.undo()?.nodes.get("goal")!.entity!.behavior).toBeDefined();
        await act(async()=>root.render(<Harness/>));await click("Add delay node");await click("Add repeat node");
        expect(dispatcher.getDocument().nodes.get("goal")!.entity!.behavior!.version).toBe(2);
        await change("Behavior body","delay1");
        await click("Save as reusable graph");
        expect(dispatcher.getDocument().nodes.get("goal")!.entity!.behavior).toBeUndefined();
        expect(dispatcher.getDocument().behaviorAssets?.[0].graph.nodes.find(n=>n.id==="repeat1")).toMatchObject({body:"delay1"});
        await click("Detach local copy");
        expect(dispatcher.getDocument().nodes.get("goal")!.entity!.behaviorAssetId).toBeUndefined();
        expect(dispatcher.getDocument().nodes.get("goal")!.entity!.behavior!.version).toBe(2);
        await selectNode("interact");await change("Behavior event","update");
        expect(dispatcher.getDocument().nodes.get("goal")!.entity!.behavior!.version).toBe(3);
        await click("Add emit node");expect(host.querySelector('[aria-label="Behavior send name"]')).not.toBeNull();
        const lifecycle=deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("goal")!.entity!.behavior!;
        expect(lifecycle.nodes.find(n=>n.id==="interact")).toMatchObject({event:"update",other:"any"});
        expect(lifecycle.nodes.find(n=>n.id==="emit1")).toMatchObject({kind:"emit",name:"signal"});
    }finally{await act(async()=>root.unmount());}
});
