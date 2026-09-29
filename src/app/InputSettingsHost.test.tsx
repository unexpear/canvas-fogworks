/** @jest-environment jsdom */
/** @module InputSettingsHost.test @description Editor controls persist named bindings and report them to Play. */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { InputSettingsHost } from "./InputSettingsHost";
import { INPUT_SETTINGS_STORAGE_KEY } from "../core/runtime/InputSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("a captured key is stored and handed to the play binding", async () => {
    localStorage.clear();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const seen: string[][] = [];
    try {
        await act(async () => { root.render(<InputSettingsHost onChange={bindings => seen.push([...bindings.interact])} />); });
        await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add a key for Interact"]')!.click(); });
        await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyG", bubbles: true, cancelable: true })); });
        expect(seen).toEqual([["KeyF", "KeyG"]]);
        expect(JSON.parse(localStorage.getItem(INPUT_SETTINGS_STORAGE_KEY)!).bindings.interact).toEqual(["KeyF", "KeyG"]);
    } finally {
        await act(async () => { root.unmount(); });
        host.remove();
        localStorage.clear();
    }
});
