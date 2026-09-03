/**
 * @jest-environment jsdom
 * @module AppShellControls.test
 * @description PROD-002 DOM coverage for workspace, 3D transform and runtime shell controls.
 */

import React, { useState } from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RuntimeControls, Workspace, WorkspaceControls } from "./AppShellControls";
import { GizmoMode3D, GizmoSpace3D } from "../renderer/Gizmo3D";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PROD-002 app shell DOM", () => {
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

    it("switches workspaces and exposes 3D-only controls with accessible state", async () => {
        const lights: string[] = [];
        function Harness() {
            const [workspace, setWorkspace] = useState<Workspace>("design");
            const [mode, setMode] = useState<GizmoMode3D>("translate");
            const [space, setSpace] = useState<GizmoSpace3D>("world");
            return <WorkspaceControls workspace={workspace} gizmoMode={mode} gizmoSpace={space}
                canCompose2D={false} onWorkspaceChange={setWorkspace}
                onGizmoModeChange={next => {
                    setMode(next);
                    if (next === "scale") setSpace("local");
                }} onGizmoSpaceChange={setSpace} onAddLight={kind => lights.push(kind)}
                onCompose2D={() => undefined} />;
        }
        await act(async () => root.render(<Harness />));

        const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        expect(tabs).toHaveLength(5);
        expect(host.querySelector('[aria-label="3D transform controls"]')).toBeNull();
        expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain("Design");

        await act(async () => tabs[4].click());
        expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain("3D");
        expect(host.querySelector('[aria-label="3D transform controls"]')).not.toBeNull();
        expect(host.querySelector<HTMLButtonElement>("[data-compose-2d-3d]")?.disabled).toBe(true);

        await act(async () => host.querySelector<HTMLButtonElement>('[data-gizmo-mode="scale"]')!.click());
        expect(host.querySelector('[data-gizmo-mode="scale"]')?.getAttribute("aria-pressed")).toBe("true");
        expect(host.querySelector("[data-gizmo-space]")).toBeNull();

        await act(async () => host.querySelector<HTMLButtonElement>('[data-add-light-3d="point"]')!.click());
        expect(lights).toEqual(["point"]);
    });

    it("routes play, restart and respawn without exposing unavailable actions", async () => {
        const calls: string[] = [];
        const render = async (playing: boolean, canRestart: boolean, canRespawn: boolean) => {
            await act(async () => root.render(<RuntimeControls playing={playing}
                canRestart={canRestart} canRespawn={canRespawn}
                onTogglePlay={() => calls.push("toggle")} onRestart={() => calls.push("restart")}
                onRespawn={() => calls.push("respawn")} />));
        };
        await render(false, false, false);
        expect(host.textContent).toContain("Play");
        expect(host.textContent).not.toContain("Restart");

        await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
        expect(calls).toEqual(["toggle"]);

        await render(true, true, true);
        expect(host.textContent).toContain("Stop");
        const buttons = Array.from(host.querySelectorAll("button"));
        await act(async () => buttons.find(button => button.textContent?.includes("Restart"))!.click());
        await act(async () => buttons.find(button => button.textContent?.includes("Respawn"))!.click());
        expect(calls).toEqual(["toggle", "restart", "respawn"]);
    });
});
