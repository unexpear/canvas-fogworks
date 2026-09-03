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
