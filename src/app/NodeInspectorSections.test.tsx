/**
 * @jest-environment jsdom
 * @module NodeInspectorSections.test
 * @description SHELL-001 DOM coverage for states, slots, variants and metadata.
 */

import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { AddNodeAction } from "../core/actions/AddNodeAction";
import { geometryActionFor } from "../core/actions/nodeEdit";
import { UpdateNodeTransformAction } from "../core/actions/UpdateNodeTransformAction";
import { createEmptyDocument } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { NodeInspectorSections } from "./NodeInspectorSections";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setValue(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
    const proto = input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

function pressEnter(input: HTMLInputElement) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function checkbox(host: HTMLElement, label: string): HTMLInputElement {
    const found = [...host.querySelectorAll("label")].find(item => item.textContent?.includes(label));
    const input = found?.querySelector('input[type="checkbox"]');
    if (!(input instanceof HTMLInputElement)) throw new Error(`Missing checkbox ${label}`);
    return input;
}

function controlAfter(host: HTMLElement, label: string): HTMLElement {
    const found = [...host.querySelectorAll("label")].find(item => item.textContent === label);
    const next = found?.nextElementSibling;
    if (!(next instanceof HTMLElement)) throw new Error(`Missing control after ${label}`);
    return next;
}

function box(id: string, extra: Partial<Node> = {}): Node {
    return {
        id, type: "core.rectangle", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 40, height: 20 },
        style: { fill: "#ffffff", opacity: 1 }, layout: {},
        ...extra
    };
}

describe("SHELL-001 extracted node inspector sections", () => {
    let host: HTMLDivElement;
    let root: Root;
    let alert: jest.SpyInstance;

    beforeEach(() => {
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
        alert = jest.spyOn(window, "alert").mockImplementation(() => undefined);
    });

    afterEach(async () => {
        alert.mockRestore();
        await act(async () => root.unmount());
        host.remove();
    });

    async function mount(dispatcher: ActionDispatcher, id: string) {
        const render = () => {
            root.render(<NodeInspectorSections
                node={dispatcher.getDocument().nodes.get(id) as Node}
                dispatcher={dispatcher}
                refresh={() => render()}
            />);
        };
        await act(async () => render());
    }

    it("captures, replaces and removes a named look, and refuses a reserved state name", async () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        expect(dispatcher.dispatchAction(new AddNodeAction(
            dispatcher.getDocument(), "core.rectangle", 10, 20, 30, 40, "#ff0000", "A"
        )).success).toBe(true);
        expect(dispatcher.dispatchAction(new UpdateNodeTransformAction(
            dispatcher.getDocument(), "A", { rotation: 1 }
        )).success).toBe(true);
        await mount(dispatcher, "A");

        const capture = host.querySelector<HTMLInputElement>('input[placeholder="capture as… (e.g. hover)"]')!;
        await act(async () => {
            setValue(capture, "__proto__");
            pressEnter(capture);
        });
        expect(alert).toHaveBeenCalled();
        expect(dispatcher.getDocument().nodes.get("A")!.states).toBeUndefined();

        await act(async () => {
            setValue(capture, "hover");
            pressEnter(capture);
        });
        expect(dispatcher.getDocument().nodes.get("A")!.states!.hover).toMatchObject({
            geometry: { x: 10, y: 20, width: 30, height: 40 },
            transform: { rotation: 1 }
        });

        const moved = geometryActionFor(dispatcher.getDocument(), "A", { x: 80 });
        expect(moved && dispatcher.dispatchAction(moved).success).toBe(true);
        await mount(dispatcher, "A");
        const recapture = [...host.querySelectorAll("button")].find(button =>
            button.getAttribute("title") === 'Re-capture this node\'s current look as "hover"')!;
        await act(async () => { recapture.click(); });
        expect(dispatcher.getDocument().nodes.get("A")!.states!.hover.geometry!.x).toBe(80);

        const remove = [...host.querySelectorAll("button")].find(button =>
            button.getAttribute("title") === 'Remove the "hover" state from this node')!;
        await act(async () => { remove.click(); });
        expect(dispatcher.getDocument().nodes.get("A")!.states).toBeUndefined();
    });

    it("tags a master into a set and fills a slot name", async () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        expect(dispatcher.dispatchAction(new AddNodeAction(
            dispatcher.getDocument(), "core.rectangle", 0, 0, 10, 10, "#ffffff", "A"
        )).success).toBe(true);
        await mount(dispatcher, "A");

        await act(async () => { checkbox(host, "In a variant set").click(); });
        expect(dispatcher.getDocument().nodes.get("A")!.variant).toEqual({ set: "Set", values: {} });
        const setName = controlAfter(host, "Set name") as HTMLInputElement;
        await act(async () => { setValue(setName, "Button"); });
        const property = host.querySelector<HTMLInputElement>('input[placeholder="add property (e.g. size)"]')!;
        await act(async () => {
            setValue(property, "size");
            pressEnter(property);
        });
        expect(dispatcher.getDocument().nodes.get("A")!.variant).toEqual({
            set: "Button", values: { size: "default" }
        });

        await act(async () => { checkbox(host, "Is a slot").click(); });
        expect(dispatcher.getDocument().nodes.get("A")!.slot).toBe("content");
        const slotName = controlAfter(host, "Slot name") as HTMLInputElement;
        await act(async () => { setValue(slotName, "body"); });
        expect(dispatcher.getDocument().nodes.get("A")!.slot).toBe("body");
    });

    it("switches an instance between masters of its set", async () => {
        const doc = createEmptyDocument();
        doc.nodes.set("sm", box("sm", { name: "Small", variant: { set: "Button", values: { size: "small" } } }));
        doc.nodes.set("lg", box("lg", { name: "Large", variant: { set: "Button", values: { size: "large" } } }));
        doc.nodes.set("I", box("I", { type: "core.instance", componentId: "sm", style: { fill: "none", opacity: 1 } }));
        doc.rootNodeUuids = ["sm", "lg", "I"];
        const dispatcher = new ActionDispatcher(doc);
        await mount(dispatcher, "I");

        const size = controlAfter(host, "size") as HTMLSelectElement;
        expect([...size.options].map(option => option.value)).toEqual(["large", "small"]);
        await act(async () => { setValue(size, "large"); });
        expect(dispatcher.getDocument().nodes.get("I")!.variants).toEqual({ size: "large" });
        expect(host.textContent).toContain("Drawing");
        expect(host.textContent).toContain("Large");
    });

    it("fills a slot the master exposes", async () => {
        const doc = createEmptyDocument();
        doc.nodes.set("CM", box("CM", { children: ["SLOT"] }));
        doc.nodes.set("SLOT", box("SLOT", { parent: "CM", slot: "body" }));
        doc.nodes.set("PHOTO", box("PHOTO", { name: "Photo" }));
        doc.nodes.set("C1", box("C1", { type: "core.instance", componentId: "CM", style: { fill: "none", opacity: 1 } }));
        doc.rootNodeUuids = ["CM", "PHOTO", "C1"];
        const dispatcher = new ActionDispatcher(doc);
        await mount(dispatcher, "C1");

        const fill = controlAfter(host, "body") as HTMLSelectElement;
        expect([...fill.options].map(option => option.value)).toEqual(["", "CM", "PHOTO"]);
        await act(async () => { setValue(fill, "PHOTO"); });
        expect(dispatcher.getDocument().nodes.get("C1")!.slotContent).toEqual({ body: "PHOTO" });
    });

    it("edits class, entity fields and a custom property", async () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        expect(dispatcher.dispatchAction(new AddNodeAction(
            dispatcher.getDocument(), "core.rectangle", 0, 0, 10, 10, "#ffffff", "A"
        )).success).toBe(true);
        await mount(dispatcher, "A");

        const className = controlAfter(host, "Class") as HTMLInputElement;
        await act(async () => { setValue(className, "enemy"); });
        expect(dispatcher.getDocument().nodes.get("A")!.className).toBe("enemy");
        await act(async () => { setValue(className, ""); });
        expect(dispatcher.getDocument().nodes.get("A")!.className).toBeUndefined();

        const body = controlAfter(host, "Body") as HTMLSelectElement;
        await act(async () => { setValue(body, "dynamic"); });
        await act(async () => { checkbox(host, "Player").click(); });
        expect(dispatcher.getDocument().nodes.get("A")!.entity).toMatchObject({ body: "dynamic", player: true });

        const name = host.querySelector<HTMLInputElement>('input[placeholder="new property name"]')!;
        await act(async () => { setValue(name, "note"); });
        const add = [...host.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Add property")!;
        await act(async () => { add.click(); });
        expect(dispatcher.getDocument().nodes.get("A")!.userData).toEqual({ note: { type: "string", value: "" } });
        const remove = [...host.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Remove property note")!;
        await act(async () => { remove.click(); });
        expect(dispatcher.getDocument().nodes.get("A")!.userData).toBeUndefined();
    });
});
