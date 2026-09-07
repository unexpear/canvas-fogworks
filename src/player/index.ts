/**
 * @module player
 * @description Standalone offline 2D game host: shared simulation, animation, camera and Canvas rendering, with no editor or filesystem bridge.
 */
import { GamePackage } from "../core/export/GameExport";
import { deserializeDocument } from "../core/document/Serializer";
import { playerEntityId } from "../core/document/Entity";
import { applyAnimations } from "../core/runtime/AnimationPlayback";
import { stepGameplay } from "../core/runtime/GameplaySession";
import { worldFrom, stepsFor, NO_INPUT, applyWorld, applySpawns, applyCells, applyFacing, applyTileAnimations, playBounds } from "../core/runtime/World";
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
let controlled = playerEntityId(doc.nodes.values());
let input = { ...NO_INPUT }, running = false, last = performance.now(), accumulator = 0;
let bounds = playBounds(contentBounds(computeGeometry(doc)), doc.screen);
let viewport = { x: bounds?.x ?? 0, y: bounds?.y ?? 0, zoom: 1 };
function load(id: string) {
    if (!game.levels[id]) throw new Error("The requested level was not packaged.");
    audio.stop(); level = id; doc = deserializeDocument(game.levels[id].content); world = worldFrom(doc);
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
    const mapping: Record<string, keyof typeof input> = { ArrowLeft: "left", a: "left", ArrowRight: "right", d: "right", " ": "jump", ArrowUp: "jump", ArrowDown: "down", s: "down", Shift: "run" };
    const field = mapping[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (field) { event.preventDefault(); input[field] = down; }
}
window.addEventListener("keydown", event => key(event, true));
window.addEventListener("keyup", event => key(event, false));
window.addEventListener("blur", () => { input = { ...NO_INPUT }; });
window.addEventListener("pagehide", () => audio.dispose());
function frame(now: number) {
    try {
        const spend = stepsFor(accumulator, running ? (now - last) / 1000 : 0); last = now; accumulator = spend.accumulator;
        for (let i = 0; i < spend.steps && running && world.outcome === "running"; i++) {
            const result = stepGameplay(doc, world, { controlled, input, bounds }); world = result.world;
            for (const sound of result.sounds) void audio.play(sound);
            if (world.transitionTo) { load(game.levels[level].links[world.transitionTo]); break; }
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
