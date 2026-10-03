/**
 * @jest-environment jsdom
 * @module ScriptPanel.test
 * @description SHELL-001 DOM coverage for the extracted script panel.
 */

import React, { useState } from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { AddNodeAction } from "../core/actions/AddNodeAction";
import { createEmptyDocument } from "../core/document/Document";
import { runScript } from "../editor/ScriptRunner";
import { ScriptPanel } from "./ScriptPanel";

jest.mock("../editor/ScriptRunner", () => ({
    runScript: jest.fn()
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockedRun = runScript as jest.MockedFunction<typeof runScript>;

function setText(el: HTMLTextAreaElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("SHELL-001 extracted script panel", () => {
    let host: HTMLDivElement;
    let root: Root;
    let dispatcher: ActionDispatcher;

    beforeEach(() => {
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
        dispatcher = new ActionDispatcher(createEmptyDocument());
        dispatcher.dispatchAction(new AddNodeAction(
            dispatcher.getDocument(), "core.rectangle", 0, 0, 10, 10, "#ffffff", "R"
        ));
        mockedRun.mockReset();
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
    });

    async function render() {
        function Harness() {
            const [, bump] = useState(0);
            return <ScriptPanel dispatcher={dispatcher} refresh={() => bump(n => n + 1)} />;
        }
        await act(async () => root.render(<Harness />));
    }

    function runButton(): HTMLButtonElement {
        const found = [...host.querySelectorAll("button")].find(item => item.textContent?.includes("Run") || item.textContent?.includes("Running"));
        if (!found) throw new Error("Missing run button");
        return found as HTMLButtonElement;
    }

    it("keeps the starter script and applies a compiled edit as one undo", async () => {
        await render();
        const area = host.querySelector("textarea") as HTMLTextAreaElement;
        expect(area.value).toContain("api.style(n.id, { fill: \"#00bfff\" })");
        mockedRun.mockResolvedValue({
            requests: [{ op: "style", id: "R", style: { fill: "#00bfff" } }],
            log: ["painted"],
            error: null
        });

        await act(async () => setText(area, "api.log('painted')"));
        await act(async () => runButton().click());

        expect(mockedRun).toHaveBeenCalledWith("api.log('painted')", expect.objectContaining({
            nodes: expect.arrayContaining([expect.objectContaining({ id: "R" })])
        }));
        expect(dispatcher.getDocument().nodes.get("R")!.style.fill).toBe("#00bfff");
        expect(host.textContent).toContain("painted");
        expect(host.textContent).toContain("applied 1 edit(s) — one undo");
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("R")!.style.fill).toBe("#ffffff");
    });

    it("shows a refusal beside the edits that did apply", async () => {
        await render();
        mockedRun.mockResolvedValue({
            requests: [
                { op: "style", id: "R", style: { fill: "#112233" } },
                { op: "move", id: "missing", x: 1, y: 1 }
            ],
            log: [],
            error: null
        });
        await act(async () => runButton().click());
        expect(dispatcher.getDocument().nodes.get("R")!.style.fill).toBe("#112233");
        expect(host.textContent).toContain("refused #1: no editable node \"missing\"");
        expect(host.textContent).toContain("applied 1 edit(s) — one undo");
    });

    it("reports a sandbox error without claiming there was nothing to apply", async () => {
        await render();
        mockedRun.mockResolvedValue({ requests: [], log: [], error: "the script failed" });
        await act(async () => runButton().click());
        expect(host.textContent).toContain("error: the script failed");
        expect(host.textContent).not.toContain("nothing to apply");
        expect(dispatcher.getDocument().nodes.get("R")!.style.fill).toBe("#ffffff");
    });

    it("says when a clean run asked for nothing, and disables the button while running", async () => {
        await render();
        let finish: (value: { requests: unknown[]; log: string[]; error: string | null }) => void = () => undefined;
        mockedRun.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        await act(async () => { runButton().click(); });
        expect(runButton().disabled).toBe(true);
        expect(runButton().textContent).toBe("Running…");
        await act(async () => { finish({ requests: [], log: [], error: null }); });
        expect(runButton().disabled).toBe(false);
        expect(host.textContent).toContain("nothing to apply");
    });
});
