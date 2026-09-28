/** @jest-environment jsdom */
/** @module BehaviorDebugPanel.test @description Real debugger controls operate transient worlds without document history. */
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {BehaviorDebugPanel} from "./BehaviorDebugPanel";
import {gameReference} from "../core/examples/ReferenceProjects";
import {starterBehaviorGraph} from "../core/document/BehaviorGraph";
import {worldFrom} from "../core/runtime/World";
import {interactGameplay2D,advanceBehaviors2D} from "../core/runtime/GameplaySession";
import {serializeDocument} from "../core/document/Serializer";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
test("breakpoint pauses before execution, step changes the watched counter, continue completes and clear removes traces",async()=>{
    const doc=gameReference(),p=doc.nodes.get("player")!,goal=doc.nodes.get("goal")!;
    doc.nodes.set("goal",{...goal,geometry:{...p.geometry,x:p.geometry.x+20},entity:{behavior:starterBehaviorGraph()}});
    const before=serializeDocument(doc),host=document.createElement("div"),root=createRoot(host);let world=worldFrom(doc);
    const render=()=>root.render(<BehaviorDebugPanel doc={doc} state={world.behaviorState} time={world.time} tallies={world.tallies}
        onChange={behaviorState=>{world={...world,behaviorState};render();}} onStep={()=>{world=advanceBehaviors2D(doc,world,"player",[],"step").world;render();}}/>);
    const click=async(text:string)=>act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent===text)!.click();});
    try{
        await act(async()=>render());
        await act(async()=>{const node=host.querySelector<HTMLSelectElement>('[aria-label="Debug behavior node"]')!;node.value="count";node.dispatchEvent(new Event("change",{bubbles:true}));});
        await click("Toggle breakpoint");
        await act(async()=>{world=interactGameplay2D(doc,world,"player").world;render();});
        expect(host.querySelector("summary")!.textContent).toContain("paused");expect(world.tallies.get("uses")).toBeUndefined();
        await click("Step instruction");expect(world.tallies.get("uses")).toBe(1);
        expect(host.querySelector('[aria-label="Behavior counter watches"]')!.textContent).toContain("uses: 1");
        await click("Continue behaviors");
        await act(async()=>{world=advanceBehaviors2D(doc,world,"player").world;render();});
        expect(world.checkpoint?.playerId).toBe("player");expect(world.behaviorState?.jobs).toHaveLength(0);
        await click("Clear trace");expect(host.querySelectorAll('[aria-label="Behavior execution trace"] li')).toHaveLength(0);
        expect(serializeDocument(doc)).toBe(before);
    }finally{await act(async()=>root.unmount());}
});
