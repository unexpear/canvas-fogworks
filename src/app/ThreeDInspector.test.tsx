/**
 * @jest-environment jsdom
 * @module ThreeDInspector.test
 * @description SHELL-001 DOM coverage for extracted 3D inspector authoring controls.
 */

import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Node } from "../core/document/Node";
import { IDENTITY_TRANSFORM_3D, Spatial3D } from "../core/document/Spatial3D";
import { ThreeDInspector } from "./ThreeDInspector";
import { animatedTriangle } from "../core/examples/AnimatedTriangle";
import { gameReference } from "../core/examples/ReferenceProjects";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { SetSpatial3DAction } from "../core/actions/SetSpatial3DAction";
import { serializeDocument, deserializeDocument } from "../core/document/Serializer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setInputValue(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SHELL-001 extracted 3D inspector DOM", () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
    });

    it("edits blockout dimensions through Actions and reopens the edited shape", async () => {
        const doc=gameReference();doc.nodes.get("goal")!.spatial3d={transform:IDENTITY_TRANSFORM_3D,blockout:{kind:"room",width:4,height:3,depth:5,thickness:.2,ceiling:false}};
        const dispatcher=new ActionDispatcher(doc);
        const render=()=>root.render(<ThreeDInspector node={dispatcher.getDocument().nodes.get("goal") as Node} assets={[]} meshes={new Map()} onChange={next=>{
            expect(dispatcher.dispatchAction(new SetSpatial3DAction(dispatcher.getDocument(),"goal",next)).success).toBe(true);render();
        }}/>);
        await act(async()=>render());
        await act(async()=>setInputValue(host.querySelector<HTMLInputElement>('[aria-label="Blockout width"]')!,"8"));
        expect(deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("goal")!.spatial3d!.blockout!.width).toBe(8);
        await act(async()=>setInputValue(host.querySelector<HTMLInputElement>('[aria-label="Blockout width"]')!,"-2"));
        expect(dispatcher.getDocument().nodes.get("goal")!.spatial3d!.blockout!.width).toBe(8);
        dispatcher.undo();expect(dispatcher.getDocument().nodes.get("goal")!.spatial3d!.blockout!.width).toBe(4);
        expect(host.textContent).toContain("Visual blockout only");
        await act(async()=>render());
        await act(async()=>host.querySelector<HTMLInputElement>('[aria-label="Blockout solid collision"]')!.click());
        expect(deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("goal")!.spatial3d!.blockoutCollision).toBe(true);
        expect(host.textContent).toContain("Solid collision follows the generated shape");
        dispatcher.undo();expect(dispatcher.getDocument().nodes.get("goal")!.spatial3d!.blockoutCollision).toBeUndefined();
        dispatcher.redo();expect(dispatcher.getDocument().nodes.get("goal")!.spatial3d!.blockoutCollision).toBe(true);
    });

    it("authors light kind and clamps numeric light values", async () => {
        const spatial: Spatial3D = {
            transform: IDENTITY_TRANSFORM_3D,
            light: { kind: "directional", color: { x: 1, y: 1, z: 1 }, intensity: 2 }
        };
        const changes: Spatial3D[] = [];
        const node = { spatial3d: spatial } as Node;
        await act(async () => root.render(<ThreeDInspector node={node} assets={[]} meshes={new Map()}
            onChange={next => changes.push(next)} />));

        const kind = host.querySelector<HTMLSelectElement>("[data-light-kind-3d]")!;
        await act(async () => {
            kind.value = "point";
            kind.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(changes[changes.length - 1]?.light).toEqual({
            kind: "point", color: { x: 1, y: 1, z: 1 }, intensity: 2, range: 10
        });

        const intensity = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="number"]'))
            .find(input => input.value === "2")!;
        await act(async () => {
            setInputValue(intensity, "-4");
        });
        expect(changes[changes.length - 1]?.light?.intensity).toBe(0);
    });

    it("authors nested solid cuts, transforms and safe failure through undoable saved Actions",async()=>{
        const doc=gameReference();doc.nodes.get("goal")!.spatial3d={transform:IDENTITY_TRANSFORM_3D,blockout:{kind:"wall",width:4,height:3,depth:.4},blockoutCollision:true};
        const dispatcher=new ActionDispatcher(doc);
        const render=()=>root.render(<ThreeDInspector node={dispatcher.getDocument().nodes.get("goal") as Node} assets={[]} meshes={new Map()} onChange={next=>{
            expect(dispatcher.dispatchAction(new SetSpatial3DAction(dispatcher.getDocument(),"goal",next)).success).toBe(true);render();
        }}/>);
        const click=async(text:string)=>act(async()=>{const button=Array.from(host.querySelectorAll("button")).find(b=>b.textContent===text);expect(button).toBeDefined();button!.click();});
        await act(async()=>render());await click("Edit solid operations");await click("subtract operand base");
        let tree=dispatcher.getDocument().nodes.get("goal")!.spatial3d!.solidTree!;
        expect(tree.kind).toBe("operation");
        await act(async()=>setInputValue(host.querySelector<HTMLInputElement>('[aria-label="Solid solid-2 position x"]')!,"0.4"));
        const saved=serializeDocument(dispatcher.getDocument()),reopened=deserializeDocument(saved);
        tree=reopened.nodes.get("goal")!.spatial3d!.solidTree!;
        expect(tree.kind==="operation"&&tree.right.kind==="shape"&&tree.right.position[0]).toBe(.4);
        await act(async()=>setInputValue(host.querySelector<HTMLInputElement>('[aria-label="Solid solid-2 width"]')!,"-1"));
        expect(host.querySelector('[role="alert"]')!.textContent).toContain("Previous solid retained");
        expect(serializeDocument(dispatcher.getDocument())).toBe(saved);
        await click("add operand solid-2");
        tree=dispatcher.getDocument().nodes.get("goal")!.spatial3d!.solidTree!;
        expect(tree.kind==="operation"&&tree.right.kind).toBe("operation");
        dispatcher.undo();expect(serializeDocument(dispatcher.getDocument())).toBe(saved);
        dispatcher.redo();await act(async()=>render());await click("Keep left solid-3");
        expect(dispatcher.getDocument().nodes.get("goal")!.spatial3d!.blockoutCollision).toBe(true);
        expect(serializeDocument(dispatcher.getDocument())).toBe(saved);
    });

    it("selects an imported animation through an Action and preserves playback across save/reopen and undo", async () => {
        const doc = gameReference(), fixture = animatedTriangle();
        doc.assets3d = [{ id: "mesh", kind: "mesh", source: "animated.gltf" }];
        doc.nodes.get("player")!.spatial3d = { transform: IDENTITY_TRANSFORM_3D, renderable: { meshAssetId: "mesh" } };
        const dispatcher = new ActionDispatcher(doc);
        await act(async () => root.render(<ThreeDInspector node={doc.nodes.get("player")!} assets={doc.assets3d!}
            meshes={new Map([["mesh", { instances: fixture.instances, motion: fixture.motion }]])}
            onChange={next => { expect(dispatcher.dispatchAction(new SetSpatial3DAction(dispatcher.getDocument(), "player", next)).success).toBe(true); }} />));
        const clip = host.querySelector<HTMLSelectElement>('[aria-label="3D animation clip"]')!;
        await act(async () => { clip.value = "0"; clip.dispatchEvent(new Event("change", { bubbles: true })); });
        expect(deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("player")!.spatial3d!.animation)
            .toEqual({ clip: 0, speed: 1, loop: true });
        expect(dispatcher.undo()?.nodes.get("player")!.spatial3d!.animation).toBeUndefined();
    });

    it("stores an optional 3D clip crossfade and treats zero as off", async () => {
        const doc = gameReference(), fixture = animatedTriangle();
        doc.assets3d = [{ id: "mesh", kind: "mesh", source: "animated.gltf" }];
        doc.nodes.get("player")!.spatial3d = { transform: IDENTITY_TRANSFORM_3D, renderable: { meshAssetId: "mesh" } };
        const dispatcher = new ActionDispatcher(doc);
        const render = () => root.render(<ThreeDInspector node={dispatcher.getDocument().nodes.get("player") as Node} assets={doc.assets3d!}
            meshes={new Map([["mesh", { instances: fixture.instances, motion: fixture.motion }]])}
            onChange={next => {
                expect(dispatcher.dispatchAction(new SetSpatial3DAction(dispatcher.getDocument(), "player", next)).success).toBe(true);
                render();
            }} />);
        await act(async () => render());
        const clip = host.querySelector<HTMLSelectElement>('[aria-label="3D animation clip"]')!;
        await act(async () => { clip.value = "0"; clip.dispatchEvent(new Event("change", { bubbles: true })); });
        const fade = [...host.querySelectorAll("label")].find(label => label.textContent?.includes("Crossfade seconds"))?.nextElementSibling as HTMLInputElement;
        expect(fade.value).toBe("0");
        await act(async () => setInputValue(fade, "0.4"));
        expect(dispatcher.getDocument().nodes.get("player")!.spatial3d!.animation?.fade).toBe(0.4);
        const again = [...host.querySelectorAll("label")].find(label => label.textContent?.includes("Crossfade seconds"))?.nextElementSibling as HTMLInputElement;
        await act(async () => setInputValue(again, "0"));
        expect(dispatcher.getDocument().nodes.get("player")!.spatial3d!.animation?.fade).toBeUndefined();
        const clamped = [...host.querySelectorAll("label")].find(label => label.textContent?.includes("Crossfade seconds"))?.nextElementSibling as HTMLInputElement;
        await act(async () => setInputValue(clamped, "5"));
        expect(deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("player")!.spatial3d!.animation?.fade).toBe(1);
    });

    it("authors billboard composition and lit state", async () => {
        const spatial: Spatial3D = {
            transform: IDENTITY_TRANSFORM_3D,
            composition2d: { mode: "plane", pixelsPerUnit: 100, lit: true }
        };
        const changes: Spatial3D[] = [];
        await act(async () => root.render(<ThreeDInspector node={{ spatial3d: spatial } as Node}
            assets={[]} meshes={new Map()} onChange={next => changes.push(next)} />));

        const facing = host.querySelector<HTMLSelectElement>("[data-composition-2d-mode]")!;
        await act(async () => {
            facing.value = "billboard";
            facing.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(changes[changes.length - 1]?.composition2d?.mode).toBe("billboard");

        const lit = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        await act(async () => lit.click());
        expect(changes[changes.length - 1]?.composition2d?.lit).toBe(false);
    });
});
