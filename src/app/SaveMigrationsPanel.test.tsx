/** @jest-environment jsdom */
/**
 * @module SaveMigrationsPanel.test
 * @description The inspector authors the document list that packaging and the runtime honor, and loading does not write the new slot.
 */
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { TextDecoder, TextEncoder } from "util";
const globals = globalThis as typeof globalThis & { TextEncoder?: typeof TextEncoder; TextDecoder?: typeof TextDecoder };
if (!globals.TextEncoder) globals.TextEncoder = TextEncoder;
if (!globals.TextDecoder) globals.TextDecoder = TextDecoder;
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { SaveMigrationsPanel } from "./SaveMigrationsPanel";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { SetSaveMigrationsAction } from "../core/actions/SetSaveMigrationsAction";
import { gameReference } from "../core/examples/ReferenceProjects";
import { SCHEMA_VERSION } from "../core/document/Document";
import { deserializeDocument, serializeDocument } from "../core/document/Serializer";
import { gameHtml } from "../core/export/GameExport";
import { worldFrom } from "../core/runtime/World";
import { gameplayFixture } from "../core/tests/fixtures/GameplayFixture";
import { captureProgress2D, serializeProgress } from "../runtime/PlayerProgress";
import { emptyCampaign, rememberLevel, withCampaign } from "../runtime/CampaignProgress";
import { adoptProgress } from "../runtime/SaveMigration";
import { browserProgressStore } from "../runtime/ProgressStore";
import { PlayerSession3D } from "../runtime/PlayerSession3D";
import { collectGamePackage, game3DHtml } from "../electron/GamePackageExport";
import { createPackageReader } from "../runtime/GamePackage";
const { saveMigrationsFromDocument, saveMigrationsFromHtml } = (() => {
    const table = require("../runtime/saveMigrationTable");
    const progress = require("../player3d/progressFile");
    return { saveMigrationsFromDocument: table.saveMigrationsFromDocument as (content: string) => { fromGameId: string; versions: number[] }[], saveMigrationsFromHtml: progress.saveMigrationsFromHtml as (html: string, gameId: string) => { fromGameId: string; versions: number[] }[] };
})();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prior = "b".repeat(64), other = "d".repeat(64);

function setInput(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("the authored list is what the package and runtime honor, and loading does not write the new slot", async () => {
    const dispatcher = new ActionDispatcher(gameReference());
    expect(dispatcher.dispatchAction(new SetSaveMigrationsAction(dispatcher.getDocument(), [{ fromGameId: "nope", versions: [6] }])).success).toBe(false);
    expect(dispatcher.getDocument().saveMigrations).toBeUndefined();
    const host = document.createElement("div"), root = createRoot(host);
    function Harness() {
        const [, refresh] = useState(0);
        return <SaveMigrationsPanel migrations={dispatcher.getDocument().saveMigrations} onChange={next => {
            const result = dispatcher.dispatchAction(new SetSaveMigrationsAction(dispatcher.getDocument(), next));
            refresh(count => count + 1);
            return result.success;
        }} />;
    }
    const click = async (text: string) => act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === text)!.click(); });
    try {
        await act(async () => root.render(<Harness />));
        await click("Add save migration");
        const hash = host.querySelector<HTMLInputElement>('[aria-label="Save migration build 1"]')!;
        await act(async () => setInput(hash, "zz"));
        expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/64 lowercase hex/);
        expect(dispatcher.getDocument().saveMigrations?.[0].fromGameId).not.toBe("zz");
        await act(async () => setInput(hash, prior));
        for (const version of [1, 2, 3, 4]) {
            await act(async () => host.querySelector<HTMLInputElement>(`[aria-label="Save migration 1 version ${version}"]`)!.click());
        }
        const saved = deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(saved.version).toBe(SCHEMA_VERSION);
        expect(saved.saveMigrations).toEqual([{ fromGameId: prior, versions: [5, 6] }]);
        const serialized = serializeDocument(dispatcher.getDocument());
        const table = saveMigrationsFromDocument(serialized);
        expect(table).toEqual([{ fromGameId: prior, versions: [5, 6] }]);
        const game = { entry: "first", levels: { first: { content: serialized, links: {} } }, saveMigrations: table };
        const html = gameHtml(game, "AA==");
        const embedded = JSON.parse(html.match(/id="project">([\s\S]*?)<\/script>/)![1]);
        expect(embedded.saveMigrations).toEqual(table);
        const current = createHash("sha256").update(JSON.stringify(game)).digest("hex");
        const world = worldFrom(gameReference());
        const visited = serializeProgress(withCampaign(captureProgress2D(world, prior, "other", "player"), rememberLevel(emptyCampaign(), captureProgress2D(world, prior, "entry", "player"))));
        expect(JSON.parse(visited).version).toBe(6);
        const adopted = adoptProgress(visited, current, "2d", embedded.saveMigrations);
        expect(adopted.gameId).toBe(current);
        expect(adopted.version).toBe(6);
        const v1 = { format: "canvas-fogworks-progress", version: 1, profile: "2d", gameId: prior, level: "entry", playerId: "player",
            position: { x: 1, y: 2, z: 0 }, spawns: [], despawned: [], tallies: [], power: 0, cells: [] };
        expect(() => adoptProgress(JSON.stringify(v1), current, "2d", embedded.saveMigrations)).toThrow(/not covered/);
        expect(() => adoptProgress(JSON.stringify({ ...JSON.parse(visited), gameId: other }), current, "2d", embedded.saveMigrations)).toThrow(/different game build/);
        const memory = new Map<string, string>();
        const writes: string[] = [];
        const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { writes.push(key); memory.set(key, value); } };
        const slot = (id: string) => `canvas-fogworks:progress:v1:${id}`;
        storage.setItem(slot(prior), visited);
        writes.length = 0;
        const store = browserProgressStore(current, embedded.saveMigrations, storage);
        expect(await store.read()).toBe(visited);
        expect(writes).toEqual([]);
        expect(memory.has(slot(current))).toBe(false);
        const level = serializeDocument(gameplayFixture());
        const sessionHost = { readEntryFile: async () => ({ filePath: "level0", content: level }), readLevelFile: async () => { throw new Error("No linked levels."); },
            readProgressLevel: async (key: string) => ({ filePath: key, content: level }) };
        const session = new PlayerSession3D(sessionHost, "level0", current, embedded.saveMigrations);
        await session.start();
        const foreign = JSON.parse(session.saveProgress());
        foreign.gameId = prior;
        expect(await session.restoreProgress(JSON.stringify(foreign))).toBe(true);
        expect(writes).toEqual([]);
        expect(memory.has(slot(current))).toBe(false);
        expect(await store.read()).toBe(visited);
        const temp = mkdtempSync(join(tmpdir(), "fogworks-authored-migrations-"));
        try {
            const project = join(temp, "entry.vde");
            const raw = JSON.parse(readFileSync(resolve(__dirname, "../../reference-projects/animated-3d.vde"), "utf8"));
            for (const file of ["triangle.gltf", "triangle.bin"]) copyFileSync(resolve(__dirname, "../../reference-projects", file), join(temp, file));
            raw.document.saveMigrations = table;
            const entry = JSON.stringify(raw);
            writeFileSync(project, entry);
            const stamped = saveMigrationsFromDocument(entry);
            const packaged = await collectGamePackage(project, entry, { saveMigrations: stamped });
            const digest = createHash("sha256").update(packaged).digest("hex");
            expect(JSON.parse(packaged).saveMigrations).toEqual(table);
            expect(createPackageReader(packaged).saveMigrations).toEqual(table);
            expect(saveMigrationsFromHtml(game3DHtml(packaged, Buffer.from("/* owned player */")), digest)).toEqual(table);
            const plain = await collectGamePackage(project, JSON.stringify({ ...raw, document: { ...raw.document, saveMigrations: undefined } }), {});
            expect(JSON.parse(plain).saveMigrations).toBeUndefined();
        } finally { rmSync(temp, { recursive: true, force: true }); }
        while (dispatcher.getDocument().saveMigrations) dispatcher.undo();
        expect(serializeDocument(dispatcher.getDocument())).not.toContain("saveMigrations");
        const legacy = JSON.parse(serializeDocument(gameReference()));
        legacy.version = "89";
        const migrated = deserializeDocument(JSON.stringify(legacy));
        expect(migrated.version).toBe("90");
        expect(migrated.saveMigrations).toBeUndefined();
        const broken = JSON.parse(serializeDocument(gameReference()));
        broken.document.saveMigrations = [{ fromGameId: "nope", versions: [6] }];
        expect(() => deserializeDocument(JSON.stringify(broken))).toThrow(/build id/);
    } finally { await act(async () => root.unmount()); }
});
