/** @module AuthoringProjects.test @description Validates editable original fixtures, all three game levels and deterministic play-through without mutating authoring documents. */
import { noisyPixels, pixelWorkshop, relayGameLevels, texturedBillboards, texturedRasterScene } from "./AuthoringProjects";
import { buildFrame3D } from "../../renderer/Scene3D";
import { buildRenderModel } from "../../renderer/RenderModel";
import { deserializeDocument, serializeDocument } from "../document/Serializer";
import { decodeSurface, encodeSurface } from "../paint/PixelCodec";
import { computeGeometry } from "../geometry/GeometryEngine";
import { stepGameplay } from "../runtime/GameplaySession";
import { NO_INPUT, worldFrom } from "../runtime/World";
import { gameDocumentTargets } from "../export/GameExport";
import { readFileSync } from "fs";
import { resolve } from "path";

test("checked-in examples match the generators", () => {
    for (const [name, doc] of Object.entries({ "pixel-workshop.vde": pixelWorkshop(), ...relayGameLevels() })) {
        const stored = readFileSync(resolve(__dirname, "../../../reference-projects/authoring-v1", name), "utf8");
        expect(JSON.parse(stored)).toEqual(JSON.parse(serializeDocument(doc)));
    }
});

test("pixel workshop round-trips raster pixels and component instances", () => {
    const doc = deserializeDocument(serializeDocument(pixelWorkshop()));
    const surface = doc.nodes.get("editable-pixel-atlas")!.surface!;
    expect(decodeSurface(surface.data, surface.width, surface.height)?.data.length).toBe(256 * 256 * 4);
    expect([...doc.nodes.values()].filter(n => n.type === "core.instance")).toHaveLength(15);
    expect(computeGeometry(doc).nodes.size).toBeGreaterThan(doc.nodes.size);
});

test("relay graph packages and all three stages can be completed with original files unchanged", () => {
    const levels = relayGameLevels();
    for (const [file, authored] of Object.entries(levels)) {
        const bytes = serializeDocument(authored), doc = deserializeDocument(bytes);
        for (const target of gameDocumentTargets(bytes)) expect(levels[target]).toBeDefined();
        let world = worldFrom(doc);
        for (let step = 0; step < 1200 && !world.transitionTo && world.outcome === "running"; step++) {
            world = stepGameplay(doc, world, { controlled: "player", input: { ...NO_INPUT, right: true, run: true } }).world;
        }
        if (file === "relay-3.vde") expect(world.outcome).toBe("won");
        else expect(levels[world.transitionTo!]).toBeDefined();
        expect(world.tallies.get("signals")).toBe(8);
        expect(serializeDocument(authored)).toBe(bytes);
    }
});

test("noisy pixels are deterministic and do not collapse to one run", () => {
    const first = noisyPixels(4, 1);
    expect(noisyPixels(4, 1).data).toEqual(first.data);
    expect(noisyPixels(4, 2).data).not.toEqual(first.data);
    const encoded = encodeSurface(first);
    expect(encoded.packedBytes).toBeGreaterThan(6);
    expect(decodeSurface(encoded.data, 4, 4)?.data).toEqual(first.data);
});

test("textured raster scenes keep unique payloads and stay renderable", () => {
    const doc = texturedRasterScene(8, 4, 2);
    expect(doc.nodes.size).toBe(3);
    const payloads = [...doc.nodes.values()].map(node => node.surface?.data);
    expect(new Set(payloads).size).toBe(3);
    const computed = computeGeometry(doc);
    expect(buildRenderModel({ width: 32, height: 32 }, doc, {
        computed, selectedNodeIds: [], hoveredNodeId: null, viewport: { x: 0, y: 0, zoom: 1 }
    }).content.length).toBeGreaterThan(0);
});

test("textured billboards become texture-bearing draws", () => {
    const frame = buildFrame3D(texturedBillboards(8), new Map(), 320, 200, new Map(), 0);
    expect(frame.draws).toHaveLength(8);
    expect(new Set(frame.draws.map(draw => draw.baseColorTexture)).size).toBe(4);
});
