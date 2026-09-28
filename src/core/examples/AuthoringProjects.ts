/**
 * @module AuthoringProjects
 * @description Original editable pixel/design workshop, three-level relay game, and owned benchmark scenes used for authoring, portability and performance regression exercises.
 */
import { createEmptyDocument, ProjectDocument } from "../document/Document";
import { Node } from "../document/Node";
import { createPixelBuffer, PixelBuffer } from "../paint/PixelBuffer";
import { encodeSurface } from "../paint/PixelCodec";

const colors = ["#182638", "#243c50", "#58bfa8", "#eebc55", "#e85955", "#d9e6ec"];
function box(id: string, x: number, y: number, width: number, height: number, fill: string): Node {
    return { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width, height },
        style: { fill, opacity: 1 }, layout: {}, name: id.replace(/-/g, " ") };
}
function add(doc: ProjectDocument, node: Node) { doc.nodes.set(node.id, node); doc.rootNodeUuids.push(node.id); }
function label(doc: ProjectDocument, id: string, text: string, x: number, y: number, width: number) {
    add(doc, { ...box(id, x, y, width, 28, colors[5]), type: "core.text", text });
}
function project(name: string, width: number, height: number) {
    const doc = createEmptyDocument(); doc.metadata.project_name = name;
    doc.metadata.date = new Date("2026-09-07T00:00:00Z"); doc.screen = { width, height }; doc.background = colors[0];
    return doc;
}

/** Editable RGBA pixels, generated from geometry rather than external artwork. */
export function workshopPixels(size = 256) {
    const pixels = createPixelBuffer(size, size);
    const palette = [[24,38,56], [36,60,80], [88,191,168], [238,188,85], [232,89,85], [217,230,236]];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const u = Math.floor(x * 256 / size), v = Math.floor(y * 256 / size);
        const cellX = u % 32, cellY = v % 32;
        const edge = cellX < 2 || cellY < 2;
        const gem = Math.abs(cellX - 16) + Math.abs(cellY - 16) < 11;
        const color = palette[edge ? 0 : gem ? 2 + ((Math.floor(u / 32) + Math.floor(v / 32)) % 4) : 1];
        pixels.data.set([...color, 255], (y * size + x) * 4);
    }
    return pixels;
}

/**
 * Deterministic high-frequency pixels for scale measurements.
 * Adjacent pixels differ, so run-length encoding cannot collapse the surface.
 */
export function noisyPixels(size = 256, seed = 1): PixelBuffer {
    const pixels = createPixelBuffer(size, size);
    let state = seed >>> 0;
    if (state === 0) state = 1;
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        data[i] = state & 255;
        data[i + 1] = (state >>> 8) & 255;
        data[i + 2] = (state >>> 16) & 255;
        data[i + 3] = 255;
    }
    return pixels;
}

export function pixelWorkshop() {
    const doc = project("Signal Garden - pixel and component workshop", 1280, 800);
    add(doc, box("artboard", 0, 0, 1280, 800, colors[0]));
    label(doc, "title", "SIGNAL GARDEN / DESIGN WORKSHOP", 32, 24, 900);
    label(doc, "instructions", "Edit pixels, recolor instances, resize panels, then export PNG.", 32, 58, 1000);
    const surface = workshopPixels();
    add(doc, { ...box("editable-pixel-atlas", 32, 128, 512, 512, colors[1]), type: "core.raster", pixelated: true,
        surface: { width: surface.width, height: surface.height, data: encodeSurface(surface).data } });
    label(doc, "atlas-caption", "256 x 256 editable pixels / 64 original diamond tiles", 32, 664, 580);
    label(doc, "palette-caption", "SHARED PALETTE", 600, 108, 400);
    colors.forEach((color, i) => {
        add(doc, box(`swatch-${i}`, 600 + i * 96, 152, 80, 48, color));
        label(doc, `swatch-label-${i}`, color, 600 + i * 96, 210, 96);
    });
    const master = box("status-card", 600, 276, 180, 64, colors[1]); master.children = ["status-dot", "status-label"];
    add(doc, master);
    const dot = { ...box("status-dot", 12, 20, 24, 24, colors[2]), parent: master.id, type: "core.ellipse" as const };
    const text = { ...box("status-label", 48, 20, 120, 24, colors[5]), parent: master.id, type: "core.text" as const, text: "MASTER" };
    doc.nodes.set(dot.id, dot); doc.nodes.set(text.id, text);
    for (let i = 0; i < 15; i++) add(doc, { ...box(`card-${i}`, 600 + (i % 3) * 204, 364 + Math.floor(i / 3) * 76, 180, 64, colors[1]),
        type: "core.instance", componentId: master.id,
        overrides: { "status-dot": { style: { fill: colors[2 + i % 3] } }, "status-label": { text: `SIGNAL ${i + 1}` } } });
    return doc;
}

/** Three independent projects with explicit gates; decorative skyline nodes carry no collision bodies. */
export function relayGameLevels(): Record<string, ProjectDocument> {
    const levels: Record<string, ProjectDocument> = {};
    for (let stage = 0; stage < 3; stage++) {
        const doc = project(`Signal Relay - stage ${stage + 1} of 3`, 960, 540);
        add(doc, box("sky", 0, 0, 960, 540, colors[0]));
        for (let i = 0; i < 24; i++) {
            const height = 48 + ((i * 31 + stage * 47) % 160);
            add(doc, box(`skyline-${i}`, i * 40, 452 - height, 32, height, colors[1]));
            add(doc, box(`window-${i}`, i * 40 + 8, 462 - height, 8, 12, colors[2 + stage]));
        }
        label(doc, "stage-title", `SIGNAL RELAY / STAGE ${stage + 1}`, 32, 24, 720);
        label(doc, "controls", "Move: arrows or A/D. Jump: Space. Run: Shift. Collect signals; reach the gate.", 32, 64, 900);
        const player = box("player", 40, 416, 24, 32, colors[3]);
        player.entity = { body: "dynamic", player: true, rulePolicy: "platformer", respawnAt: "spawn" }; add(doc, player);
        add(doc, box("spawn", 40, 416, 8, 8, colors[2]));
        const floor = box("floor", 0, 480, 960, 60, colors[1]); floor.entity = { body: "static" }; add(doc, floor);
        for (let i = 0; i < 8; i++) {
            const coin = box(`signal-${i}`, 160 + i * 80, 456, 12, 12, colors[3]);
            coin.entity = { rules: [
                { event: "enter", other: "player", target: "self", action: { kind: "score", key: "signals" } },
                { event: "enter", other: "player", target: "self", action: { kind: "despawn" } }
            ] }; add(doc, coin);
        }
        // Optional upper route exercises one-way platforms without blocking the walk-through route.
        for (let i = 0; i < 4; i++) {
            const platform = box(`upper-platform-${i}`, 180 + i * 160, 360 - (i % 2) * 40, 100, 12, colors[2]);
            platform.entity = { body: "oneway" }; add(doc, platform);
        }
        const gate = box("gate", 872, 384, 48, 96, colors[2]);
        gate.className = "level-gate";
        gate.entity = stage < 2 ? { goal: true, transitionTo: `relay-${stage + 2}.vde` }
            : { rules: [{ event: "enter", other: "player", target: "self", action: { kind: "win" } }] };
        add(doc, gate); label(doc, "gate-label", stage < 2 ? "NEXT" : "FINISH", 856, 348, 96);
        levels[`relay-${stage + 1}.vde`] = doc;
    }
    return levels;
}

/**
 * One large noisy raster plus smaller unique rasters. Benchmark-only; not a checked-in example project.
 * Defaults are the SCALE-001 scene: 2048 square plus eight 512-square textures.
 */
export function texturedRasterScene(large = 2048, small = 512, smallCount = 8): ProjectDocument {
    const doc = project("Textured raster benchmark", Math.max(large, small * 4), large + small * Math.ceil(Math.max(smallCount, 1) / 4));
    const place = (id: string, x: number, y: number, size: number, seed: number) => {
        const encoded = encodeSurface(noisyPixels(size, seed));
        add(doc, { ...box(id, x, y, size, size, colors[1]), type: "core.raster", pixelated: true,
            surface: { width: size, height: size, data: encoded.data } });
    };
    place("raster-large", 0, 0, large, 1);
    for (let i = 0; i < smallCount; i++) {
        place(`raster-small-${i}`, (i % 4) * small, large + Math.floor(i / 4) * small, small, 100 + i);
    }
    return doc;
}

/** Image billboards that carry distinct texture ids. Benchmark-only; sources are synthetic ids, not files. */
export function texturedBillboards(count = 80): ProjectDocument {
    const doc = project("Textured billboard benchmark", 1280, 800);
    for (let i = 0; i < count; i++) {
        const id = `billboard-${i}`;
        add(doc, { ...box(id, 0, 0, 64, 64, colors[5]), type: "core.image", pixelated: true,
            src: `benchmark-texture-${i % 4}`,
            spatial3d: {
                transform: {
                    position: { x: (i % 10) * 0.2, y: Math.floor(i / 10) * 0.2, z: 0 },
                    rotation: { x: 0, y: 0, z: 0, w: 1 },
                    scale: { x: 1, y: 1, z: 1 }
                },
                composition2d: { mode: "billboard", pixelsPerUnit: 64, lit: false }
            } });
    }
    return doc;
}
