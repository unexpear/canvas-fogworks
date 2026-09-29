/**
 * @module PlayerHost3D
 * @description Browser event/frame owner for a read-only 3D session, with explicit error retry and teardown.
 */
import { PlayerSession3D } from "../runtime/PlayerSession3D";
import { disposeWebGL3D, emitWebGL3D, lastWebGL3DFailure } from "../renderer/emitWebGL3D";
import { ActionBindings, InputActions, PLAYER_ACTIONS } from "../core/runtime/InputActions";
import { browserInputStorage, eventCode, inputBindingsInclude, inputSettingsSummary, readInputSettings, spatialInput, writeInputSettings } from "../core/runtime/InputSettings";
import { mountInputSettings } from "../core/runtime/InputSettingsView";
import type { ProgressStore } from "../runtime/ProgressStore";

export function playerInput3D(keys: ReadonlySet<string>, bindings: ActionBindings = PLAYER_ACTIONS) {
    const actions = new InputActions(bindings); keys.forEach(key => actions.setKey(key,true)); return spatialInput(actions);
}

export function mountPlayer3D(session: PlayerSession3D, store?: ProgressStore): () => void {
    const canvas = document.getElementById("scene") as HTMLCanvasElement;
    const status = document.getElementById("status")!;
    const start = document.getElementById("start") as HTMLButtonElement;
    const pause = document.getElementById("pause") as HTMLButtonElement;
    const stop = document.getElementById("stop") as HTMLButtonElement;
    const retry = document.getElementById("retry") as HTMLButtonElement;
    let bindings = readInputSettings(browserInputStorage());
    const keys = new InputActions(bindings); let disposed = false, scheduled = 0, renderError: string | null = null, epoch = 0, saving = false;
    const publishInputSummary = () => {
        const summary = document.getElementById("input-summary");
        if (summary) summary.textContent = `${inputSettingsSummary(bindings)} Focus loss pauses; use Resume to continue.`;
    };
    publishInputSummary();
    const listeners: (() => void)[] = [];
    function on(target: EventTarget, type: string, handler: (event: any) => void) {
        target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type, handler));
    }
    function update() {
        if (disposed) return;
        const error = renderError ?? session.error?.message;
        status.textContent = error ? `Player error: ${error}` : `${session.status} · ${session.filePath ?? "no level"}${session.status === "ended" ? ` · ${session.world?.outcome}` : ""}`;
        status.dataset.state = error ? "error" : session.status;
        pause.textContent = session.status === "running" ? "Pause" : "Resume";
        pause.disabled = !!renderError || !["running", "paused"].includes(session.status) || !!session.error;
        retry.hidden = !session.error || !session.world?.transitionTo;
        start.textContent = session.status === "stopped" ? "Start" : "Restart";
    }
    function loseFocus() { keys.clear(); session.pause(); update(); }
    async function load(action: () => Promise<boolean>) {
        keys.clear();
        try { const pending = action(); update(); await pending; }
        catch { /* Session retains its load error and last good frame; only explicit retry tries again. */ }
        update();
    }
    on(start, "click", () => { epoch++; renderError = null; disposeWebGL3D(canvas); void load(() => session.restart()); });
    on(pause, "click", () => { keys.clear(); if (session.status === "running") session.pause(); else session.resume(); update(); });
    on(stop, "click", () => {
        epoch++; keys.clear(); session.stop(); renderError = null; disposeWebGL3D(canvas); canvas.width = canvas.width; update();
    });
    on(retry, "click", () => { void load(() => { session.resume(); return session.followTransition(); }); });
    const inputButton = document.getElementById("input-settings");
    const inputPanel = document.getElementById("input-settings-panel");
    if (inputButton && inputPanel) {
        on(inputButton, "click", () => {
            const open = inputPanel.hidden;
            inputPanel.hidden = !open;
            inputButton.setAttribute("aria-expanded", String(open));
        });
        const settings = mountInputSettings(inputPanel, { bindings, onChange(next) {
            const storage = browserInputStorage();
            if (!storage) throw new Error("This browser cannot store control settings.");
            writeInputSettings(storage, next);
            bindings = next; keys.rebind(next); publishInputSummary();
        } });
        listeners.push(() => settings.dispose());
    }
    on(window, "keydown", (event: KeyboardEvent) => {
        if (document.body.dataset.inputCapturing === "1" || session.status !== "running") return;
        if ((event.target as HTMLElement)?.closest?.("input,select,textarea,[contenteditable=true]")) return;
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        const code = eventCode(event);
        if (!code || !inputBindingsInclude(bindings, code)) return;
        event.preventDefault(); keys.setKey(code, true);
        if (keys.pressed("interact")) session.interact();
    });
    on(window, "keyup", (event: KeyboardEvent) => { const code = eventCode(event); if (code) keys.setKey(code, false); });
    for (const id of ["checkpoint","respawn","save-progress","load-progress"]) {
        const button = document.getElementById(id) as HTMLButtonElement | null; if (!button) continue;
        on(button,"click", async () => {
            if (saving) return;
            const generation = epoch, note = document.getElementById("progress-note");
            const say = (text: string) => { if (note && !disposed && generation === epoch) note.textContent = text; };
            keys.clear();
            try {
                if (id === "checkpoint") { session.checkpoint(); say("Checkpoint set."); }
                else if (id === "respawn") { session.respawn(); say("Respawned."); }
                else {
                    if (!store) throw new Error("This host has no progress storage.");
                    saving = true; session.pause();
                    if (id === "save-progress") { const content = session.saveProgress(); await store.write(content); say("Progress saved. Resume when ready."); }
                    else {
                        const content = await store.read(); if (generation !== epoch || disposed) return;
                        if (content === null) throw new Error("No saved progress for this game build.");
                        await session.restoreProgress(content); say("Progress restored. Resume when ready.");
                    }
                }
            } catch (error) { say(`Progress error: ${error instanceof Error ? error.message : String(error)}`); }
            finally { saving = false; update(); }
        });
    }
    on(window, "blur", loseFocus);
    on(document, "visibilitychange", () => { if (document.hidden) loseFocus(); });
    on(canvas, "webglcontextlost", (event: Event) => { event.preventDefault(); loseFocus(); });
    function frame(timestamp: number) {
        if (disposed) return;
        try {
            if (!renderError) {
                session.advance(timestamp, spatialInput(keys));
                if (session.status === "running" && session.world?.transitionTo && !session.error) {
                    void load(() => session.followTransition());
                }
                const width = Math.max(1, Math.min(8192, Math.floor(canvas.clientWidth)));
                const height = Math.max(1, Math.min(8192, Math.floor(canvas.clientHeight)));
                const scene = session.frame(width, height);
                if (scene && !emitWebGL3D(canvas, scene, Math.min(2, window.devicePixelRatio || 1))) {
                    throw new Error(lastWebGL3DFailure() ?? "WebGL rendering is unavailable.");
                }
                if (scene) canvas.dataset.presented = "true";
            }
        } catch (cause) { renderError = cause instanceof Error ? cause.message : String(cause); loseFocus(); }
        update(); scheduled = requestAnimationFrame(frame);
    }
    function dispose() {
        if (disposed) return;
        disposed = true; epoch++; cancelAnimationFrame(scheduled); listeners.forEach(remove => remove());
        keys.clear(); session.stop(); disposeWebGL3D(canvas);
    }
    on(window, "pagehide", dispose);
    scheduled = requestAnimationFrame(frame);
    void load(() => { const pending = session.start(); if (document.hidden) session.pause(); return pending; });
    return dispose;
}
