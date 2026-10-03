/**
 * @jest-environment jsdom
 * @module TokensPanel.test
 * @description SHELL-001 DOM coverage for the extracted token panel and colour picker.
 */

import React, { useState } from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { createEmptyDocument } from "../core/document/Document";
import { VariableStore } from "../core/document/Variables";
import { TokenSelect, TokensPanel } from "./TokensPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setInput(input: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

function pressEnter(input: HTMLInputElement) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

describe("SHELL-001 extracted tokens panel", () => {
    let host: HTMLDivElement;
    let root: Root;
    let dispatcher: ActionDispatcher;

    beforeEach(() => {
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
        dispatcher = new ActionDispatcher(createEmptyDocument());
        jest.spyOn(window, "alert").mockImplementation(() => undefined);
    });

    afterEach(async () => {
        (window.alert as jest.Mock).mockRestore();
        await act(async () => root.unmount());
        host.remove();
    });

    async function renderPanel() {
        function Harness() {
            const [, bump] = useState(0);
            return <TokensPanel dispatcher={dispatcher} refresh={() => bump(n => n + 1)} />;
        }
        await act(async () => root.render(<Harness />));
    }

    it("authors a colour or number token, themes it, and deletes it", async () => {
        await renderPanel();
        expect(host.textContent).toContain("active theme (light)");
        expect(host.textContent).toContain("No tokens yet");

        const name = host.querySelector("input") as HTMLInputElement;
        await act(async () => setInput(name, "color/brand"));
        await act(async () => pressEnter(name));
        const store = () => dispatcher.getDocument().variables as VariableStore;
        expect(store()["color/brand"]).toEqual({ type: "color", value: "#4a90d9" });
        expect(host.textContent).toContain("$color/brand");
        expect(host.textContent).not.toContain("No tokens yet");

        const colors = () => [...host.querySelectorAll("input[type=color]")] as HTMLInputElement[];
        expect(colors()).toHaveLength(2);
        await act(async () => setInput(colors()[0], "#112233"));
        expect(store()["color/brand"].value).toBe("#112233");
        await act(async () => setInput(colors()[1], "#abcdef"));
        expect(store()["color/brand"].modes).toEqual({ light: "#abcdef" });
        dispatcher.undo();
        expect(store()["color/brand"].modes).toBeUndefined();

        await act(async () => setInput(name, "spacing/gap"));
        await act(async () => pressEnter(name));
        expect(store()["spacing/gap"]).toEqual({ type: "spacing", value: 8 });
        const gap = [...host.querySelectorAll("input[type=number]")][0] as HTMLInputElement;
        await act(async () => setInput(gap, "24"));
        expect(store()["spacing/gap"].value).toBe(24);

        const remove = host.querySelector("[title^='Delete this token']") as HTMLButtonElement;
        await act(async () => remove.click());
        expect(store()["color/brand"]).toBeUndefined();
        expect(store()["spacing/gap"]).toBeDefined();
    });

    it("refuses a reserved name through the shared key check and ignores a blank one", async () => {
        await renderPanel();
        const name = host.querySelector("input") as HTMLInputElement;
        await act(async () => setInput(name, "  "));
        await act(async () => pressEnter(name));
        expect(window.alert).not.toHaveBeenCalled();
        expect(Object.keys(dispatcher.getDocument().variables)).toHaveLength(0);

        await act(async () => setInput(name, "__proto__"));
        await act(async () => pressEnter(name));
        expect(window.alert).toHaveBeenCalledWith(expect.stringMatching(/reserved/));
        expect(Object.keys(dispatcher.getDocument().variables)).toHaveLength(0);
        expect(host.textContent).toContain("No tokens yet");
    });

    it("offers only colour tokens and writes a $reference", async () => {
        const picked: string[] = [];
        await act(async () => root.render(<TokenSelect store={{}} value="#ffffff" onPick={v => picked.push(v)} />));
        expect(host.querySelector("select")).toBeNull();

        const store: VariableStore = {
            "spacing/gap": { type: "spacing", value: 8 },
            "color/brand": { type: "color", value: "#4a90d9" }
        };
        await act(async () => root.render(<TokenSelect store={store} value="$color/brand" onPick={v => picked.push(v)} />));
        const select = host.querySelector("select") as HTMLSelectElement;
        expect(select.value).toBe("color/brand");
        expect([...select.options].map(option => option.value)).toEqual(["", "color/brand"]);
        await act(async () => setInput(select, ""));
        expect(picked).toEqual([""]);

        await act(async () => root.render(<TokenSelect store={store} value="#ff00aa" onPick={v => picked.push(v)} />));
        const fixed = host.querySelector("select") as HTMLSelectElement;
        expect(fixed.value).toBe("");
        await act(async () => setInput(fixed, "color/brand"));
        expect(picked).toEqual(["", "$color/brand"]);
    });
});
