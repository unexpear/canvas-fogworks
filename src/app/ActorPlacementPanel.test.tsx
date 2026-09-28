/**
 * @jest-environment jsdom
 * @module ActorPlacementPanel.test
 * @description Real placement controls preserve history, saved hierarchy and failed drafts.
 */
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {ActorPlacementPanel} from "./ActorPlacementPanel";
import {ActionDispatcher} from "../core/actions/ActionDispatcher";
import {gameplayFixture} from "../core/tests/fixtures/GameplayFixture";
import {serializeDocument,deserializeDocument} from "../core/document/Serializer";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

test("placement controls save an independent actor and undo atomically; invalid offsets retain the source",async()=>{
    const doc=gameplayFixture(),before=serializeDocument(doc),sourceIds=new Set(doc.nodes.keys()),dispatcher=new ActionDispatcher(doc),refresh=jest.fn();
    const host=document.createElement("div");document.body.appendChild(host);const root=createRoot(host);
    try{
        await act(async()=>root.render(<ActorPlacementPanel nodeId="lever" dispatcher={dispatcher} onPlaced={refresh}/>));
        const input=host.querySelector<HTMLInputElement>('[aria-label="Actor offset x"]')!;
        const set=(value:string)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));};
        await act(async()=>set("5"));
        await act(async()=>host.querySelector<HTMLButtonElement>("button")!.click());
        expect(refresh).toHaveBeenCalledTimes(1);expect(host.querySelector('[role="status"]')).not.toBeNull();
        const reopened=deserializeDocument(serializeDocument(dispatcher.getDocument()));
        const placed=[...reopened.nodes.values()].find(n=>!sourceIds.has(n.id))!;
        expect(placed.spatial3d!.transform.position.x).toBe(6);
        dispatcher.undo();expect(serializeDocument(dispatcher.getDocument())).toBe(before);
        await act(async()=>set("10001"));await act(async()=>host.querySelector<HTMLButtonElement>("button")!.click());
        expect(host.querySelector('[role="alert"]')!.textContent).toContain("finite offsets");
        expect(serializeDocument(dispatcher.getDocument())).toBe(before);expect(refresh).toHaveBeenCalledTimes(1);
        await act(async()=>set(""));await act(async()=>host.querySelector<HTMLButtonElement>("button")!.click());
        expect(host.querySelector('[role="alert"]')!.textContent).toContain("Enter each");
    }finally{await act(async()=>root.unmount());host.remove();}
});
