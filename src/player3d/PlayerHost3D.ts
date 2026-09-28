/**
 * @module PlayerHost3D
 * @description Browser event/frame owner for a read-only 3D session, with explicit error retry and teardown.
 */
import { PlayerSession3D } from "../runtime/PlayerSession3D";
import { disposeWebGL3D, emitWebGL3D, lastWebGL3DFailure } from "../renderer/emitWebGL3D";
import { InputActions, PLAYER_ACTIONS } from "../core/runtime/InputActions";
import type { ProgressStore } from "../runtime/ProgressStore";

const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
export function playerInput3D(keys: ReadonlySet<string>) {
    const actions = new InputActions(PLAYER_ACTIONS); keys.forEach(key => actions.setKey(key,true)); return actionInput3D(actions);
}
function actionInput3D(actions: InputActions) { return { x: actions.axis("left","right"), y: actions.axis("down","up"),
    z: actions.axis("forward","back"), speed: actions.held("run") ? 7 : 4 }; }

export function mountPlayer3D(session: PlayerSession3D, store?: ProgressStore): () => void {
    const canvas = document.getElementById("scene") as HTMLCanvasElement;
    const status = document.getElementById("status")!;
    const start = document.getElementById("start") as HTMLButtonElement;
    const pause = document.getElementById("pause") as HTMLButtonElement;
    const stop = document.getElementById("stop") as HTMLButtonElement;
    const retry = document.getElementById("retry") as HTMLButtonElement;
    const keys = new InputActions(PLAYER_ACTIONS); let disposed = false, scheduled = 0, renderError: string | null = null, epoch = 0, saving = false;
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
    on(window, "keydown", (event: KeyboardEvent) => {
        if ((!movementKeys.has(event.code) && event.code !== "KeyF") || session.status !== "running") return;
        if ((event.target as HTMLElement)?.closest?.("input,select,textarea,[contenteditable=true]")) return;
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        event.preventDefault(); keys.setKey(event.code,true);
        if (keys.pressed("interact")) session.interact();
    });
    on(window, "keyup", (event: KeyboardEvent) => { keys.setKey(event.code,false); });
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
                session.advance(timestamp, actionInput3D(keys));
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
