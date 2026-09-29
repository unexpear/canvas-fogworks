/**
 * @jest-environment jsdom
 * @module LayersPanel.test
 * @description SHELL-001 DOM coverage for the extracted layers panel.
 */

import React, { useState } from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { AddNodeAction } from "../core/actions/AddNodeAction";
import { contentActionFor } from "../core/actions/nodeEdit";
import { SetNodeFlagsAction } from "../core/actions/SetNodeFlagsAction";
import { createEmptyDocument } from "../core/document/Document";
import { LayersPanel, LayersPanelProps } from "./LayersPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function scene() {
    const dispatcher = new ActionDispatcher(createEmptyDocument());
    const add = (id: string, parent?: string) => {
        const ok = dispatcher.dispatchAction(new AddNodeAction(
            dispatcher.getDocument(), "core.rectangle", 0, 0, 10, 10, "#ffffff", id, parent ?? null
        )).success;
        if (!ok) throw new Error(`Could not add ${id}`);
    };
    const name = (id: string, value: string) => {
        const action = contentActionFor(dispatcher.getDocument(), id, { name: value });
        if (!action || !dispatcher.dispatchAction(action).success) throw new Error(`Could not name ${id}`);
    };
    return { dispatcher, add, name };
}

function setInput(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

function fireDrag(el: Element, type: string) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { effectAllowed: "" } });
    Object.defineProperty(event, "clientY", { value: 0 });
    el.dispatchEvent(event);
}

describe("SHELL-001 extracted layers panel", () => {
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

    async function render(props: LayersPanelProps) {
        await act(async () => root.render(<LayersPanel {...props} />));
    }

    it("shows an empty tree and filters, collapses and selects the rows it renders", async () => {
        const built = scene();
        built.add("folder");
        built.add("child", "folder");
        built.add("other");
        built.name("folder", "Folder");
        built.name("child", "Hero");
        built.name("other", "Sky");
        const selected: string[][] = [];
        const flags: { id: string; hidden?: boolean; locked?: boolean }[] = [];

        function Harness() {
            const [ids, setIds] = useState<string[]>([]);
            return <LayersPanel
                getDocument={() => built.dispatcher.getDocument()}
                selectedIds={ids}
                onSelect={next => { selected.push(next); setIds(next); }}
                onFlags={(id, next) => flags.push({ id, ...next })}
                onReparent={() => undefined}
                onOpacity={() => undefined}
                onRename={() => undefined}
                onRefresh={() => undefined}
            />;
        }
        await act(async () => root.render(<Harness />));

        expect(host.textContent).toContain("Layers");
        expect(host.textContent).toContain("Folder");
        expect(host.textContent).toContain("Hero");
        expect(host.querySelectorAll("[data-layer-node-id]")).toHaveLength(3);

        const search = host.querySelector("input") as HTMLInputElement;
        await act(async () => setInput(search, "hero"));
        const visible = [...host.querySelectorAll("[data-layer-node-id]")].map(row => row.getAttribute("data-layer-node-id"));
        expect(visible).toEqual(["folder", "child"]);

        await act(async () => {
            search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(host.querySelectorAll("[data-layer-node-id]")).toHaveLength(3);

        const toggleFolder = () => host.querySelector('[data-layer-node-id="folder"]')!.querySelector("span")!;
        await act(async () => toggleFolder().dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(host.querySelector('[data-layer-node-id="child"]')).toBeNull();
        await act(async () => toggleFolder().dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(host.querySelector('[data-layer-node-id="child"]')).not.toBeNull();

        await act(async () => host.querySelector('[data-layer-node-id="folder"]')!.dispatchEvent(
            new MouseEvent("click", { bubbles: true })));
        await act(async () => host.querySelector('[data-layer-node-id="other"]')!.dispatchEvent(
            new MouseEvent("click", { bubbles: true, shiftKey: true })));
        expect(selected).toEqual([["folder"], ["folder", "child", "other"]]);

        const hero = host.querySelector('[data-layer-node-id="child"]')!;
        const hide = [...hero.querySelectorAll("span")].find(span => span.getAttribute("title") === "Hide");
        await act(async () => hide!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(flags).toEqual([{ id: "child", hidden: true }]);
    });

    it("renames on commit, keeps the old name on Escape, and ignores an inherited hide", async () => {
        const built = scene();
        built.add("parent");
        built.add("child", "parent");
        built.name("parent", "Parent");
        built.name("child", "Child");
        if (!built.dispatcher.dispatchAction(new SetNodeFlagsAction(built.dispatcher.getDocument(), "parent", { hidden: true })).success) {
            throw new Error("Could not hide the parent");
        }
        const names: string[] = [];
        const flags: string[] = [];
        await render({
            getDocument: () => built.dispatcher.getDocument(),
            selectedIds: [],
            onSelect: () => undefined,
            onFlags: id => flags.push(id),
            onReparent: () => undefined,
            onOpacity: () => undefined,
            onRename: (_id, name) => names.push(name),
            onRefresh: () => undefined
        });

        const child = host.querySelector('[data-layer-node-id="child"]')!;
        const inherited = [...child.querySelectorAll("span")].find(span => span.getAttribute("title") === "Hidden by a parent");
        await act(async () => inherited!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(flags).toEqual([]);

        const label = [...host.querySelector('[data-layer-node-id="parent"]')!.querySelectorAll("span")]
            .find(span => span.textContent === "Parent")!;
        await act(async () => label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
        const editor = host.querySelector('[data-layer-node-id="parent"] input') as HTMLInputElement;
        await act(async () => {
            editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(names).toEqual([]);
        expect(host.textContent).toContain("Parent");

        const labelAgain = [...host.querySelector('[data-layer-node-id="parent"]')!.querySelectorAll("span")]
            .find(span => span.textContent === "Parent")!;
        await act(async () => labelAgain.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
        const editorAgain = host.querySelector('[data-layer-node-id="parent"] input') as HTMLInputElement;
        await act(async () => {
            setInput(editorAgain, "Renamed");
            editorAgain.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        });
        expect(names).toEqual(["Renamed"]);
    });

    it("reparents a row dropped inside another and refreshes a refused drop", async () => {
        const built = scene();
        built.add("alpha");
        built.add("beta");
        built.name("alpha", "Alpha");
        built.name("beta", "Beta");
        const moves: { id: string; parent: string | null; index: number }[] = [];
        let refreshes = 0;
        await render({
            getDocument: () => built.dispatcher.getDocument(),
            selectedIds: [],
            onSelect: () => undefined,
            onFlags: () => undefined,
            onReparent: (id, parent, index) => moves.push({ id, parent, index }),
            onOpacity: () => undefined,
            onRename: () => undefined,
            onRefresh: () => { refreshes += 1; }
        });

        const alpha = host.querySelector('[data-layer-node-id="alpha"]')!;
        const beta = host.querySelector('[data-layer-node-id="beta"]')!;
        await act(async () => fireDrag(alpha, "dragstart"));
        await act(async () => fireDrag(beta, "dragover"));
        await act(async () => fireDrag(beta, "drop"));
        expect(moves).toEqual([{ id: "alpha", parent: "beta", index: 0 }]);

        await act(async () => fireDrag(beta, "dragstart"));
        await act(async () => fireDrag(beta, "dragover"));
        await act(async () => fireDrag(beta, "drop"));
        expect(moves).toHaveLength(1);
        expect(refreshes).toBe(1);
    });
});
