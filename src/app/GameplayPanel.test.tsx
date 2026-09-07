/** @jest-environment jsdom */
/** @module GameplayPanel.test @description DOM rule authoring routes through entity Actions, survives save/reopen and undoes. */
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { GameplayPanel } from "./GameplayPanel";
import { gameReference } from "../core/examples/ReferenceProjects";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { UpdateNodeContentAction } from "../core/actions/UpdateNodeContentAction";
import { serializeDocument, deserializeDocument } from "../core/document/Serializer";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
test("add/remove and policy controls persist through Actions and undo", async () => {
    const dispatcher = new ActionDispatcher(gameReference()), host = document.createElement("div"), root = createRoot(host);
    function Harness() {
        const [, render] = useState(0);
        return <GameplayPanel entity={dispatcher.getDocument().nodes.get("player")!.entity!} onChange={entity => {
            expect(dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(), "player", { entity })).success).toBe(true);
            render(n => n + 1);
        }} />;
    }
    try {
        await act(async () => root.render(<Harness />));
        await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Add gameplay rule")!.click());
        expect(deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("player")!.entity!.rules?.[0].event).toBe("enter");
        const policy = host.querySelector<HTMLSelectElement>('[aria-label="Gameplay policy"]')!;
        await act(async () => { policy.value = "platformer"; policy.dispatchEvent(new Event("change", { bubbles: true })); });
        expect(dispatcher.getDocument().nodes.get("player")!.entity!.rulePolicy).toBe("platformer");
        expect(dispatcher.undo()?.nodes.get("player")!.entity!.rulePolicy).toBe("authored");
    } finally { await act(async () => root.unmount()); }
});
