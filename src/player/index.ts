/**
 * @module player
 * @description Standalone offline 2D game host: shared simulation, animation, camera and Canvas rendering, with no editor or filesystem bridge.
 */
import { GamePackage } from "../core/export/GameExport";
import { deserializeDocument } from "../core/document/Serializer";
import { playerEntityId } from "../core/document/Entity";
import { applyAnimations } from "../core/runtime/AnimationPlayback";
import { stepGameplay, interactGameplay2D } from "../core/runtime/GameplaySession";
import { InputActions } from "../core/runtime/InputActions";
import { browserInputStorage, eventCode, inputSettingsSummary, platformerInput, readInputSettings, writeInputSettings } from "../core/runtime/InputSettings";
import { mountInputSettings } from "../core/runtime/InputSettingsView";
import { captureProgress2D, restoreProgress2D, serializeProgress } from "../runtime/PlayerProgress";
import { adoptProgress } from "../runtime/SaveMigration";
import { CampaignState, EDITOR_CAMPAIGN_GAME_ID, campaignFromProgress, emptyCampaign, openCampaignLevel, rememberLeavingLevel, withCampaign } from "../runtime/CampaignProgress";
import { browserProgressStore } from "../runtime/ProgressStore";
import { worldFrom, stepsFor, NO_INPUT, applyWorld, applySpawns, applyCells, applyFacing, applyTileAnimations, playBounds, type WorldState } from "../core/runtime/World";
import { respawnRun } from "../core/runtime/RunFlow";
import { computeGeometry, contentBounds } from "../core/geometry/GeometryEngine";
import { followCamera } from "../core/runtime/Camera";
import { buildRenderModel } from "../renderer/RenderModel";
import { emitCanvas } from "../renderer/emitCanvas";
import { RuntimeAudio } from "../app/RuntimeAudio";

const game: GamePackage = JSON.parse(document.getElementById("project")!.textContent!);
const canvas = document.getElementById("game") as HTMLCanvasElement;
const status = document.getElementById("status")!;
const audio = new RuntimeAudio(message => { status.textContent = message; });
let level = game.entry, doc = deserializeDocument(game.levels[level].content), world = worldFrom(doc);
let campaign: CampaignState = emptyCampaign();
let controlled = playerEntityId(doc.nodes.values());
let input = { ...NO_INPUT }, running = false, last = performance.now(), accumulator = 0;
let bindings = readInputSettings(browserInputStorage());
const actions = new InputActions(bindings); let generation = 0;
function publishInputSummary() {
    const summary = document.getElementById("input-summary");
    if (summary) summary.textContent = inputSettingsSummary(bindings);
}
publishInputSummary();
const inputButton = document.getElementById("input-settings");
const inputPanel = document.getElementById("input-settings-panel");
if (inputButton && inputPanel) {
    inputButton.addEventListener("click", () => {
        const open = inputPanel.hidden;
        inputPanel.hidden = !open;
        inputButton.setAttribute("aria-expanded", String(open));
    });
    mountInputSettings(inputPanel, { bindings, onChange(next) {
        const storage = browserInputStorage();
        if (!storage) throw new Error("This browser cannot store control settings.");
        writeInputSettings(storage, next);
        bindings = next; actions.rebind(next); input = platformerInput(actions); publishInputSummary();
    } });
}
const gameId = (async () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(game))))()
    .then(bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,"0")).join(""));
// Attach a rejection handler immediately; a storage action still reports the original error.
void gameId.catch(() => {});
let bounds = playBounds(contentBounds(computeGeometry(doc)), doc.screen);
let viewport = { x: bounds?.x ?? 0, y: bounds?.y ?? 0, zoom: 1 };
function load(id: string, mode: "fresh" | "transition" | "restore" = "fresh", restored?: WorldState) {
    if (!game.levels[id]) throw new Error("The requested level was not packaged.");
    const nextCampaign = mode === "fresh" ? emptyCampaign()
        : mode === "transition" ? rememberLeavingLevel(campaign, "2d", world, EDITOR_CAMPAIGN_GAME_ID, level, controlled)
        : campaign;
    const nextDoc = deserializeDocument(game.levels[id].content);
    let adopted = nextCampaign, nextWorld: WorldState;
    if (mode === "restore") {
        if (!restored) throw new Error("Missing restored level.");
        const levels = new Map(adopted.levels); levels.delete(id);
        adopted = { shared: adopted.shared, levels }; nextWorld = restored;
    } else {
        const opened = openCampaignLevel(nextDoc, nextCampaign, id, "2d", EDITOR_CAMPAIGN_GAME_ID);
        adopted = opened.campaign; nextWorld = opened.world2d;
    }
    generation++; actions.clear(); audio.stop(); level = id; doc = nextDoc; world = nextWorld; campaign = adopted;
    controlled = playerEntityId(doc.nodes.values()); input = { ...NO_INPUT }; accumulator = 0;
    bounds = playBounds(contentBounds(computeGeometry(doc)), doc.screen);
    viewport = { x: bounds?.x ?? 0, y: bounds?.y ?? 0, zoom: 1 };
}
document.getElementById("start")!.addEventListener("click", () => {
    audio.unlock(); load(game.entry); running = true; last = performance.now(); status.textContent = "Running";
});
document.getElementById("respawn")!.addEventListener("click", () => {
    if (!controlled) return;
    audio.unlock(); audio.stop(); world = respawnRun(doc, world, controlled); running = true; accumulator = 0; last = performance.now();
});
function key(event: KeyboardEvent, down: boolean) {
    if (document.body.dataset.inputCapturing === "1") return;
    const code = eventCode(event);
    if (!code || !actions.setKey(code, down)) return;
    input = platformerInput(actions);
    if (running && down && actions.pressed("interact")) {
        const result = interactGameplay2D(doc,world,controlled); world = result.world;
        result.sounds.forEach(sound => { void audio.play(sound); });
    }
    event.preventDefault();
}
window.addEventListener("keydown", event => key(event, true));
window.addEventListener("keyup", event => key(event, false));
window.addEventListener("blur", () => { actions.clear(); input = { ...NO_INPUT }; });
for (const id of ["checkpoint","save-progress","load-progress"]) document.getElementById(id)?.addEventListener("click", async () => {
    const token = generation, note = document.getElementById("progress-note")!;
    try {
        if (!controlled) throw new Error("No player in this level.");
        if (id === "checkpoint") {
            const body = world.bodies.get(controlled); if (!body) throw new Error("No live player.");
            world = { ...world, checkpoint: { playerId: controlled, position: { x: body.x,y: body.y,z: 0 } } }; note.textContent = "Checkpoint set."; return;
        }
        const hash = await gameId; if (token !== generation) return;
        const store = browserProgressStore(hash, game.saveMigrations ?? []);
        if (id === "save-progress") { await store.write(serializeProgress(withCampaign(captureProgress2D(world,hash,level,controlled), campaign))); note.textContent = "Progress saved."; }
        else {
            const content = await store.read(); if (token !== generation) return;
            if (!content) throw new Error("No saved progress for this game build.");
            const progress = adoptProgress(content,hash,"2d", game.saveMigrations ?? []), savedLevel = game.levels[progress.level];
            if (!savedLevel) throw new Error("Saved level is not packaged.");
            const restoredDoc = deserializeDocument(savedLevel.content), restored = restoreProgress2D(restoredDoc,progress);
            campaign = campaignFromProgress(progress);
            load(progress.level, "restore", restored); running = true; last = performance.now(); note.textContent = "Progress restored.";
        }
    } catch (error) { if (token === generation) note.textContent = `Progress error: ${String(error)}`; }
});
window.addEventListener("pagehide", () => audio.dispose());
function frame(now: number) {
    try {
        const spend = stepsFor(accumulator, running ? (now - last) / 1000 : 0); last = now; accumulator = spend.accumulator;
        for (let i = 0; i < spend.steps && running && world.outcome === "running"; i++) {
            const result = stepGameplay(doc, world, { controlled, input, bounds }); world = result.world;
            for (const sound of result.sounds) void audio.play(sound);
            if (world.transitionTo) { load(game.levels[level].links[world.transitionTo], "transition"); break; }
        }
        const width = Math.max(1, Math.min(4096, canvas.clientWidth)), height = Math.max(1, Math.min(4096, canvas.clientHeight));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const body = controlled ? world.bodies.get(controlled) : undefined, node = controlled ? doc.nodes.get(controlled) : undefined;
        if (body && node) viewport = followCamera(viewport, { width: canvas.width, height: canvas.height },
            { x: body.x, y: body.y, width: node.geometry.width, height: node.geometry.height }, bounds, spend.steps);
        const visual = applyAnimations(applyFacing(applyTileAnimations(applyWorld(applyCells(applySpawns(doc, world), world), world), world.time), world), world.animations ?? new Map());
        const model = buildRenderModel({ width: canvas.width, height: canvas.height }, visual,
            { computed: computeGeometry(visual), selectedNodeIds: [], hoveredNodeId: null, viewport });
        emitCanvas(canvas.getContext("2d")!, { ...model, grid: { ...model.grid, lines: [] }, overlay: [] });
        canvas.dataset.time = String(world.time); canvas.dataset.outcome = world.outcome;
        if (running && world.outcome !== "running") { status.textContent = `${world.outcome}. Restart or respawn to play again.`; running = false; }
    } catch (error) { running = false; status.textContent = `Game stopped: ${String(error)}`; }
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
