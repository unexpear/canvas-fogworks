/** @jest-environment jsdom */
import React, { act, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { AnimationPanel } from "./AnimationPanel";
import { createEmptyDocument } from "../core/document/Document";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { SetAnimationControllerAction } from "../core/actions/SetAnimationControllerAction";
import { SetClipsAction } from "../core/actions/SetClipsAction";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("animation panel authoring", () => {
    let host: HTMLDivElement, root: Root, dispatcher: ActionDispatcher;
    beforeEach(async () => {
        const doc = createEmptyDocument(); doc.timeline = { frames: 24, fps: 12 };
        doc.clips = [{ name: "idle", from: 0, to: 11 }, { name: "walk", from: 12, to: 23 }];
        doc.nodes.set("hero", { id: "hero", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#ff0000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["hero"]; dispatcher = new ActionDispatcher(doc);
        host = document.createElement("div"); document.body.append(host); root = createRoot(host);
        function Harness() {
            const [selected, select] = useState("idle"), [, refresh] = useState(0);
            return <AnimationPanel document={dispatcher.getDocument()} nodeId="hero" selectedClip={selected} disabled={false}
                onSelectClip={select} onClipsChange={clips => {
                    const result = dispatcher.dispatchAction(new SetClipsAction(dispatcher.getDocument(), clips)); refresh(n => n + 1); return result.success;
                }} onControllerChange={controller => {
                    const result = dispatcher.dispatchAction(new SetAnimationControllerAction(dispatcher.getDocument(), "hero", controller)); refresh(n => n + 1); return result.success;
                }} />;
        }
        await act(async () => root.render(<Harness />));
    });
    afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
    async function click(text: string) {
        const button = [...host.querySelectorAll("button")].find(b => b.textContent === text)!;
        expect(button).toBeDefined(); await act(async () => button.click());
    }
    async function input(label: string, value: string) {
        const el = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
        });
    }
    async function select(label: string, value: string) {
        const el = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
        await act(async () => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); });
    }
    test("builds a two-state controller and ordered transition through real controls", async () => {
        await click("Add controller");
        await select("Preview clip", "walk");
        await input("New state name", "walk"); await click("Add state");
        await click("Add transition"); await select("Condition transition 1", "moving");
        expect(dispatcher.getDocument().nodes.get("hero")?.animation).toEqual({ initial: "idle",
            states: [{ name: "idle", clip: "idle" }, { name: "walk", clip: "walk" }],
            transitions: [{ from: "idle", to: "walk", when: "moving" }] });
        const before = dispatcher.getHistoryCheckpoint();
        await select("Preview clip", "idle");
        expect(dispatcher.getHistoryCheckpoint()).toBe(before);
        expect(dispatcher.undo()?.nodes.get("hero")?.animation?.transitions[0].when).toBe("finished");
    });
    test("refuses invalid ranges and protects clips used by controllers", async () => {
        await input("Clip to", "99"); await click("Save clip");
        expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/past the timeline/);
        expect(dispatcher.getDocument().clips?.[0].to).toBe(11);
        await click("Add controller"); await click("Delete clip");
        expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/used by a controller/);
        await input("Clip name", "renamed"); await click("Save clip");
        expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Reassign/);
        expect(dispatcher.getDocument().clips?.[0].name).toBe("idle");
    });
    test("deleting a state repairs its initial and transition references atomically", async () => {
        await click("Add controller"); await select("Preview clip", "walk");
        await input("New state name", "walk"); await click("Add state"); await click("Add transition");
        await click("Remove idle");
        expect(dispatcher.getDocument().nodes.get("hero")?.animation).toEqual({ initial: "walk", states: [{ name: "walk", clip: "walk" }], transitions: [] });
        expect(dispatcher.undo()?.nodes.get("hero")?.animation?.states.length).toBe(2);
    });
});
