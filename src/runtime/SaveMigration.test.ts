/** @module SaveMigration.test @description Explicit cross-build progress adoption, slot fallback and package-declared predecessor ids. */
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gameplayFixture } from "../core/tests/fixtures/GameplayFixture";
import { gameReference } from "../core/examples/ReferenceProjects";
import { worldFrom, applyCommands } from "../core/runtime/World";
import { serializeDocument } from "../core/document/Serializer";
import { captureProgress2D, restoreProgress2D, serializeProgress } from "./PlayerProgress";
import { emptyCampaign, rememberLevel, withCampaign } from "./CampaignProgress";
import { adoptProgress, SAVE_MIGRATION_LIMIT } from "./SaveMigration";
import { browserProgressStore } from "./ProgressStore";
import { PlayerSession3D } from "./PlayerSession3D";
const { createProgressFile, saveMigrationsFromHtml } = require("../player3d/progressFile");

const prior = "b".repeat(64), current = "c".repeat(64);
const map = [{ fromGameId: prior, versions: [1, 2, 3, 4, 5, 6] as number[] }];

function visited() {
    const doc = gameReference();
    const world = applyCommands(worldFrom(doc), [{ kind: "tally", key: "coins" }]);
    const left = captureProgress2D(world, prior, "entry", "player");
    const campaign = rememberLevel(emptyCampaign(), left);
    const here = captureProgress2D(world, prior, "other", "player");
    return serializeProgress(withCampaign(here, campaign));
}

test("a listed predecessor rewrites the root and visited-level builds, then restores", () => {
    const text = visited();
    const adopted = adoptProgress(text, current, "2d", map);
    expect(adopted.gameId).toBe(current);
    expect(adopted.version).toBe(6);
    expect(adopted.tallies).toEqual([["coins", 1]]);
    expect(adopted.campaign?.levels.map(level => [level.level, level.gameId])).toEqual([["entry", current]]);
    expect(JSON.parse(text).gameId).toBe(prior);
    expect(JSON.parse(text).campaign.levels[0].gameId).toBe(prior);
    const restored = restoreProgress2D(gameReference(), adopted);
    expect(restored.tallies.get("coins")).toBe(1);
    expect(restored.bodies.get("player")?.x).toBe(adopted.position.x);
});

test("v1 saves adopt only for a listed version and keep the same validation", () => {
    const v1 = { format: "canvas-fogworks-progress", version: 1, profile: "2d", gameId: prior, level: "entry", playerId: "player",
        position: { x: 3, y: 4, z: 0 }, spawns: [], despawned: [], tallies: [["coins", 2]], power: 1, cells: [] };
    const adopted = adoptProgress(JSON.stringify(v1), current, "2d", [{ fromGameId: prior, versions: [1] }]);
    expect(adopted).toMatchObject({ version: 1, gameId: current, power: 1, position: { x: 3, y: 4, z: 0 } });
    expect(() => adoptProgress(JSON.stringify(v1), current, "2d", [{ fromGameId: prior, versions: [2] }])).toThrow(/not covered/);
    expect(() => adoptProgress(JSON.stringify({ ...v1, power: 99 }), current, "2d", [{ fromGameId: prior, versions: [1] }])).toThrow(/power/);
    expect(() => adoptProgress(JSON.stringify(v1), current, "3d", [{ fromGameId: prior, versions: [1] }])).toThrow(/profile/);
});

test("unlisted builds, self-maps, mixed campaign builds and bad tables stay refused", () => {
    const text = visited();
    expect(() => adoptProgress(text, current, "2d", [])).toThrow(/different game build/);
    expect(() => adoptProgress(text, current, "2d", [{ fromGameId: "d".repeat(64), versions: [6] }])).toThrow(/different game build/);
    expect(adoptProgress(serializeProgress(captureProgress2D(worldFrom(gameReference()), current, "entry", "player")), current, "2d").gameId).toBe(current);
    expect(() => adoptProgress(text, current, "2d", [{ fromGameId: current, versions: [6] }])).toThrow(/current build/);
    const mixed = JSON.parse(text);
    mixed.campaign.levels[0].gameId = "d".repeat(64);
    expect(() => adoptProgress(JSON.stringify(mixed), current, "2d", map)).toThrow(/snapshot build/);
    expect(() => adoptProgress(text, current, "2d", [{ fromGameId: prior, versions: [6, 6] }])).toThrow(/versions/);
    expect(() => adoptProgress(text, current, "2d", [{ fromGameId: prior, versions: [6], extra: true } as never])).toThrow(/record/);
    const crowded = Array.from({ length: SAVE_MIGRATION_LIMIT + 1 }, (_, index) => ({ fromGameId: (index + 1).toString(16).padStart(64, "0"), versions: [5] }));
    expect(() => adoptProgress(text, current, "2d", crowded)).toThrow(/table/);
    expect(() => adoptProgress("x".repeat(2 * 1024 * 1024 + 1), current, "2d", map)).toThrow(/2MiB/);
});

test("a 3D session adopts a listed build and keeps the world when the map refuses", async () => {
    const content = serializeDocument(gameplayFixture());
    const host = { readEntryFile: async () => ({ filePath: "level0", content }), readLevelFile: async () => { throw new Error("No linked levels."); },
        readProgressLevel: async (key: string) => ({ filePath: key, content }) };
    const session = new PlayerSession3D(host, "level0", current, [{ fromGameId: prior, versions: [5] }]);
    await session.start(); session.interact();
    const foreign = JSON.parse(session.saveProgress());
    foreign.gameId = prior;
    expect(await session.restoreProgress(JSON.stringify(foreign))).toBe(true);
    expect(session.world?.spawns).toHaveLength(1);
    const blocked = new PlayerSession3D(host, "level0", current);
    await blocked.start(); blocked.interact();
    const world = blocked.world;
    await expect(blocked.restoreProgress(JSON.stringify(foreign))).rejects.toThrow(/different game build/);
    expect(blocked.world).toBe(world);
    foreign.spawns[0].templateId = "missing";
    await expect(session.restoreProgress(JSON.stringify(foreign))).rejects.toThrow(/reference/);
    expect(session.world?.spawns).toHaveLength(1);
});

test("the current progress slot wins; an empty slot reads the first listed predecessor and does not rewrite it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fogworks-migrate-"));
    try {
        const older = "old-save", newer = "new-save", other = "e".repeat(64), missing = "f".repeat(64);
        await createProgressFile(dir, prior).write(older);
        await createProgressFile(dir, other).write("not-listed");
        const store = createProgressFile(dir, current, { fromGameIds: [missing, prior] });
        expect(await store.read()).toBe(older);
        await store.write(newer);
        expect(await store.read()).toBe(newer);
        expect(await createProgressFile(dir, prior).read()).toBe(older);
        expect(await createProgressFile(dir, other).read()).toBe("not-listed");
        writeFileSync(join(dir, `${current}.json`), "x".repeat(2 * 1024 * 1024 + 1));
        await expect(store.read()).rejects.toThrow(/2MiB/);
        writeFileSync(join(dir, `${prior}.json`), "x".repeat(2 * 1024 * 1024 + 1));
        await expect(createProgressFile(dir, "d".repeat(64), { fromGameIds: [prior, other] }).read()).rejects.toThrow(/2MiB/);
        expect(() => createProgressFile(dir, current, { fromGameIds: ["../escape"] })).toThrow(/build id/);
        expect(() => createProgressFile(dir, current, { fromGameIds: [current] })).toThrow(/build id/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("browser storage follows the same current-slot rule", async () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    const key = (id: string) => `canvas-fogworks:progress:v1:${id}`;
    storage.setItem(key(prior), "old");
    const store = browserProgressStore(current, map, storage);
    expect(await store.read()).toBe("old");
    await store.write("new");
    expect(await store.read()).toBe("new");
    expect(storage.getItem(key(prior))).toBe("old");
    expect(() => browserProgressStore(current, [{ fromGameId: current, versions: [5] }], storage)).toThrow(/current build/);
});

test("the desktop parser reads migrations from the packaged HTML and refuses a mismatched hash", () => {
    const page = (body: unknown, id = current) => `<script id="game-data" type="application/octet-stream" data-sha256="${id}">${Buffer.from(JSON.stringify(body)).toString("base64")}</script>`;
    expect(saveMigrationsFromHtml(page({ saveMigrations: [{ fromGameId: prior, versions: [5, 6] }] }), current)).toEqual([{ fromGameId: prior, versions: [5, 6] }]);
    expect(saveMigrationsFromHtml(page({ format: "canvas-fogworks-game" }), current)).toEqual([]);
    expect(() => saveMigrationsFromHtml(page({ saveMigrations: [{ fromGameId: prior, versions: [5] }] }), prior)).toThrow(/identity/);
    expect(() => saveMigrationsFromHtml(page({ saveMigrations: [{ fromGameId: current, versions: [5] }] }), current)).toThrow(/current build/);
    expect(() => saveMigrationsFromHtml(page({ saveMigrations: [{ fromGameId: "nope", versions: [5] }] }), current)).toThrow(/build id/);
});
