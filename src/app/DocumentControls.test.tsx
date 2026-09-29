/**
 * @jest-environment jsdom
 * @module DocumentControls.test
 * @description SHELL-001 DOM coverage for the extracted document toolbar controls.
 */

import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { AddNodeAction } from "../core/actions/AddNodeAction";
import { SetNodeStateAction } from "../core/actions/StateActions";
import { SetActiveStateAction } from "../core/actions/StateActions";
import { SetTimelineAction } from "../core/actions/SetTimelineAction";
import { SetLightingAction } from "../core/actions/SetLightingAction";
import { SetBackgroundAction } from "../core/actions/SetBackgroundAction";
import { SetScreenAction } from "../core/actions/SetScreenAction";
import { SetClipsAction } from "../core/actions/SetClipsAction";
import { createEmptyDocument, ReadonlyDocument } from "../core/document/Document";
import { DocumentControls } from "./DocumentControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setInput(input: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

function buttonText(host: HTMLElement, label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
    if (!found) throw new Error(`Missing button ${label}`);
    return found as HTMLButtonElement;
}

describe("SHELL-001 extracted document controls", () => {
    let host: HTMLDivElement;
    let root: Root;
    let dispatcher: ActionDispatcher;

    beforeEach(() => {
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
        dispatcher = new ActionDispatcher(createEmptyDocument());
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
    });

    async function render(playing = false, document?: ReadonlyDocument) {
        const calls = {
            theme: 0,
            state: [] as (string | null)[],
            timeline: 0,
            lighting: 0,
            background: [] as (string | undefined)[],
            screen: [] as { axis: "width" | "height"; value: number }[],
            clearScreen: 0
        };
        await act(async () => root.render(<DocumentControls
            document={document ?? dispatcher.getDocument()}
            playing={playing}
            onToggleTheme={() => { calls.theme += 1; }}
            onSetActiveState={state => calls.state.push(state)}
            onToggleTimeline={() => { calls.timeline += 1; }}
            onToggleLighting={() => { calls.lighting += 1; }}
            onSetBackground={color => calls.background.push(color)}
            onCommitScreen={(axis, value) => calls.screen.push({ axis, value })}
            onClearScreen={() => { calls.clearScreen += 1; }}
        />));
        return calls;
    }

    it("toggles theme, lighting and timeline, and hides state until one exists", async () => {
        const calls = await render();
        expect(host.textContent).toContain("Theme: Light");
        expect(host.querySelector("select")).toBeNull();
        expect(buttonText(host, "⏱ Timeline").disabled).toBe(false);
        expect(host.querySelector("[data-doc-background-clear]")).toBeNull();
        expect(host.querySelector("[data-doc-screen-clear]")).toBeNull();

        await act(async () => buttonText(host, "Theme: Light").click());
        await act(async () => buttonText(host, "☀ Light").click());
        await act(async () => buttonText(host, "⏱ Timeline").click());
        expect(calls).toMatchObject({ theme: 1, lighting: 1, timeline: 1 });

        dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", 0, 0, 10, 10, "#fff", "n"));
        dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), "n", "hover", { style: { fill: "#333" } }));
        dispatcher.dispatchAction(new SetActiveStateAction(dispatcher.getDocument(), "hover"));
        dispatcher.dispatchAction(new SetTimelineAction(dispatcher.getDocument(), { frames: 24, fps: 12 }));
        dispatcher.dispatchAction(new SetLightingAction(dispatcher.getDocument(),
            [{ x: 0.6, y: 0.6, z: -0.5, color: "#ffffff", intensity: 1 }], 0.35));
        const shown = await render(true);
        const select = host.querySelector("select") as HTMLSelectElement;
        expect(select.value).toBe("hover");
        expect([...select.options].map(option => option.value)).toEqual(["", "hover"]);
        expect(buttonText(host, "⏱ Timeline").disabled).toBe(true);
        expect(buttonText(host, "⏱ Timeline").style.color).toBe("rgb(77, 163, 255)");
        expect(buttonText(host, "☀ Light").style.color).toBe("rgb(77, 163, 255)");

        await act(async () => setInput(select, ""));
        expect(shown.state).toEqual([null]);
    });

    it("commits background and screen size, and blocks the timeline while clips exist", async () => {
        dispatcher.dispatchAction(new SetBackgroundAction(dispatcher.getDocument(), "#112233"));
        dispatcher.dispatchAction(new SetScreenAction(dispatcher.getDocument(), { width: 320, height: 180 }));
        dispatcher.dispatchAction(new SetTimelineAction(dispatcher.getDocument(), { frames: 8, fps: 12 }));
        dispatcher.dispatchAction(new SetClipsAction(dispatcher.getDocument(), [{ name: "idle", from: 0, to: 3 }]));
        const calls = await render();

        expect(buttonText(host, "⏱ Timeline").disabled).toBe(true);
        expect(buttonText(host, "⏱ Timeline").title).toContain("Remove named clips");
        expect(host.querySelector<HTMLInputElement>("[data-doc-background]")!.value).toBe("#112233");
        expect(host.querySelector<HTMLInputElement>('[data-doc-screen="w"]')!.value).toBe("320");

        await act(async () => buttonText(host, "✕").click());
        const clearButtons = [...host.querySelectorAll("button")].filter(item => item.textContent === "✕");
        await act(async () => (clearButtons[1] as HTMLButtonElement).click());
        expect(calls.background).toEqual([undefined]);
        expect(calls.clearScreen).toBe(1);

        const width = host.querySelector<HTMLInputElement>('[data-doc-screen="w"]')!;
        await act(async () => setInput(width, "0"));
        await act(async () => setInput(width, "640"));
        const height = host.querySelector<HTMLInputElement>('[data-doc-screen="h"]')!;
        await act(async () => setInput(height, "360"));
        expect(calls.screen).toEqual([
            { axis: "width", value: 640 },
            { axis: "height", value: 360 }
        ]);

        await act(async () => setInput(host.querySelector<HTMLInputElement>("[data-doc-background]")!, "#abcdef"));
        expect(calls.background).toEqual([undefined, "#abcdef"]);
    });
});
