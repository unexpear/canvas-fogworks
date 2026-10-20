/**
 * @jest-environment jsdom
 * @module Effects3DInspector.test
 * @description Fog, particle preset and light string inspector controls author valid schema 91
 * data through SetSpatial3DAction, and the edits survive a save round trip.
 */

import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Node } from "../core/document/Node";
import { IDENTITY_TRANSFORM_3D } from "../core/document/Spatial3D";
import { ThreeDInspector } from "./ThreeDInspector";
import { parseStrandPoints3D } from "./Effects3DInspector";
import { gameReference } from "../core/examples/ReferenceProjects";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { SetSpatial3DAction } from "../core/actions/SetSpatial3DAction";
import { serializeDocument, deserializeDocument } from "../core/document/Serializer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setValue(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("3D effects inspector", () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
    afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

    it("adds fog, a snowfall emitter and a light string, edits them, and saves them", async () => {
        const doc = gameReference();
        doc.nodes.get("goal")!.spatial3d = { transform: IDENTITY_TRANSFORM_3D };
        const dispatcher = new ActionDispatcher(doc);
        const render = () => root.render(<ThreeDInspector node={dispatcher.getDocument().nodes.get("goal") as Node} assets={[]} meshes={new Map()}
            onChange={next => { expect(dispatcher.dispatchAction(new SetSpatial3DAction(dispatcher.getDocument(), "goal", next)).success).toBe(true); render(); }} />);
        await act(async () => render());
        const q = <T extends Element>(name: string) => host.querySelector(`[aria-label="${name}"]`) as unknown as T;
        await act(async () => q<HTMLInputElement>("Scene fog").click());
        await act(async () => setValue(q<HTMLSelectElement>("Fog mode"), "linear"));
        await act(async () => setValue(q<HTMLInputElement>("Fog end"), "45"));
        await act(async () => setValue(q<HTMLInputElement>("Sky blend"), "7"));
        await act(async () => setValue(q<HTMLSelectElement>("Particle preset"), "snowfall"));
        await act(async () => setValue(q<HTMLInputElement>("Rate per second"), "120"));
        await act(async () => q<HTMLInputElement>("Light string").click());
        await act(async () => setValue(q<HTMLSelectElement>("Bulb style"), "c7"));
        await act(async () => setValue(q<HTMLTextAreaElement>("Clip points"), "0 0 0; 1 0.2 0; 2 0 0"));
        await act(async () => setValue(q<HTMLTextAreaElement>("Clip points"), "0 0"));
        const spatial = dispatcher.getDocument().nodes.get("goal")!.spatial3d!;
        expect(spatial.fog).toMatchObject({ mode: "linear", end: 45, skyBlend: 1 });
        expect(spatial.particles).toMatchObject({ rate: 120, blend: "alpha" });
        expect(spatial.lightString).toMatchObject({ bulbStyle: "c7", points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0.2, z: 0 }, { x: 2, y: 0, z: 0 }] });
        const back = deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("goal")!.spatial3d!;
        expect(back.fog).toEqual(spatial.fog);
        expect(back.lightString).toEqual(spatial.lightString);
        await act(async () => q<HTMLInputElement>("Scene fog").click());
        expect(dispatcher.getDocument().nodes.get("goal")!.spatial3d!.fog).toBeUndefined();
    });

    it("parses strand points strictly", () => {
        expect(parseStrandPoints3D("0 0 0; 1,2,3")).toEqual([{ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 3 }]);
        expect(parseStrandPoints3D("0 0 0")).toBeNull();
        expect(parseStrandPoints3D("0 0 0; 1 x 2")).toBeNull();
    });
});