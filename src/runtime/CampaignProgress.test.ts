/** @module CampaignProgress.test @description Cross-level game values, visited-level restoration and v5/v6 save boundaries. */
import { gameReference } from "../core/examples/ReferenceProjects";
import type { GameplayVariable } from "../core/document/GameplayData";
import type { BehaviorGraph } from "../core/document/BehaviorGraph";
import type { Node } from "../core/document/Node";
import { serializeDocument } from "../core/document/Serializer";
import { assignGameplayValue, emptyGameplayData } from "../core/runtime/GameplayDataState";
import { stepGameplay } from "../core/runtime/GameplaySession";
import { NO_INPUT, applyCommands, worldFrom } from "../core/runtime/World";
import { PlayerSession3D } from "./PlayerSession3D";
import { captureProgress2D, parseProgress, serializeProgress } from "./PlayerProgress";
import { campaignFromProgress, emptyCampaign, openCampaignLevel, rememberLevel, withCampaign } from "./CampaignProgress";

const hash = "a".repeat(64);
const variables: GameplayVariable[] = [
    { id: "health", scope: "entity", type: "number", initial: 100 },
    { id: "keys", scope: "game", type: "number", initial: 0 }
];
const graph = (): BehaviorGraph => ({ version: 4, enabled: true, nodes: [
    { id: "start", kind: "event", event: "start", other: "any", next: "key" },
    { id: "key", kind: "assign", scope: "game", variable: "keys", operation: "add", value: { kind: "literal", value: 1 }, next: "hurt" },
    { id: "hurt", kind: "assign", scope: "entity", variable: "health", operation: "subtract", value: { kind: "literal", value: 25 }, next: null }
] });

function level() {
    const doc = gameReference();
    doc.gameplayVariables = variables.map(variable => ({ ...variable }));
    const player = doc.nodes.get("player")!;
    doc.nodes.set("player", { ...player, entity: { ...player.entity, rules: [
        { event: "start", other: "any", target: "self", action: { kind: "score", key: "visits" } }
    ], behavior: graph() } });
    return doc;
}
function play(doc = level()) {
    return { doc, world: stepGameplay(doc, worldFrom(doc), { controlled: "player", input: NO_INPUT }).world };
}

test("a single level keeps the v5 save even after game values change", () => {
    const { doc, world } = play();
    const saved = JSON.parse(serializeProgress(withCampaign(captureProgress2D(world, hash, "a", "player"), emptyCampaign())));
    expect(saved.version).toBe(5); expect(saved.campaign).toBeUndefined();
    expect(saved.data.game).toEqual([["keys", 1]]);
    expect(doc.gameplayVariables![1].initial).toBe(0);
});

test("returning to a visited level keeps pickups and suspended work without replaying start", () => {
    const first = play();
    let world = applyCommands(first.world, [{ kind: "despawn", bodyId: "goal" }]);
    world = { ...world, behaviorState: { ...world.behaviorState!, data: assignGameplayValue(
        world.behaviorState?.data ?? emptyGameplayData(), variables, "player", "entity", "health", "set", 40) } };
    let campaign = rememberLevel(emptyCampaign(), captureProgress2D(world, hash, "a", "player"));
    const second = level();
    const entered = openCampaignLevel(second, campaign, "b", "2d", hash);
    campaign = entered.campaign;
    let there = stepGameplay(second, entered.world2d, { controlled: "player", input: NO_INPUT }).world;
    expect(there.behaviorState?.data?.game.get("keys")).toBe(2);
    expect(there.behaviorState?.data?.entities.get("player")?.get("health")).toBe(75);
    expect(there.despawned.has("goal")).toBe(false); expect(there.tallies.get("visits")).toBe(1);
    campaign = rememberLevel(campaign, captureProgress2D(there, hash, "b", "player"));
    const returned = openCampaignLevel(first.doc, campaign, "a", "2d", hash);
    const back = returned.world2d;
    expect(back.despawned.has("goal")).toBe(true);
    expect(back.behaviorState?.data?.entities.get("player")?.get("health")).toBe(40);
    expect(back.behaviorState?.data?.game.get("keys")).toBe(2);
    expect(back.tallies.get("visits")).toBe(1); expect(back.time).toBeGreaterThan(0);
    const again = stepGameplay(first.doc, back, { controlled: "player", input: NO_INPUT }).world;
    expect(again.tallies.get("visits")).toBe(1); expect(again.behaviorState?.data?.game.get("keys")).toBe(2);
    const text = serializeProgress(withCampaign(captureProgress2D(again, hash, "a", "player"), returned.campaign));
    const parsed = parseProgress(text, hash, "2d");
    expect(parsed.version).toBe(6); expect(parsed.campaign?.levels.map(item => item.level)).toEqual(["b"]);
    expect(parsed.campaign?.shared).toEqual([["keys", 2]]);
    const restored = openCampaignLevel(second, campaignFromProgress(parsed), "b", "2d", hash).world2d;
    expect(restored.tallies.get("visits")).toBe(1);
    expect(restored.behaviorState?.data?.game.get("keys")).toBe(2);
    expect(restored.time).toBeGreaterThan(0);
});

test("a game value whose type differs on the next level stays stored for levels that declare it", () => {
    const { world } = play();
    const campaign = rememberLevel(emptyCampaign(), captureProgress2D(world, hash, "a", "player"));
    const other = level();
    other.gameplayVariables = [{ id: "keys", scope: "game", type: "string", initial: "none" }];
    const entered = openCampaignLevel(other, campaign, "b", "2d", hash).world2d;
    expect(entered.behaviorState?.data?.game.has("keys")).toBeUndefined();
    const back = openCampaignLevel(level(), rememberLevel(campaign, captureProgress2D(entered, hash, "b", "player")), "a", "2d", hash).world2d;
    expect(back.behaviorState?.data?.game.get("keys")).toBe(1);
});

test("campaign saves reject repeated, nested, oversized and mismatched level records", () => {
    const progress = captureProgress2D(play().world, hash, "a", "player");
    const campaign = rememberLevel(emptyCampaign(), progress);
    const saved = withCampaign({ ...progress, level: "b" }, campaign);
    expect(parseProgress(serializeProgress(saved), hash, "2d").campaign?.levels).toHaveLength(1);
    const value = JSON.parse(serializeProgress(saved));
    for (const broken of [
        { ...value, campaign: { shared: value.campaign.shared } },
        { ...value, campaign: { ...value.campaign, levels: [value.campaign.levels[0], value.campaign.levels[0]] } },
        { ...value, campaign: { ...value.campaign, levels: [{ ...value.campaign.levels[0], version: 6, campaign: { shared: [], levels: [] } }] } },
        { ...value, campaign: { ...value.campaign, levels: [{ ...value.campaign.levels[0], level: "b" }] } },
        { ...value, campaign: { shared: [["keys", null]], levels: [] } },
        { ...value, campaign: { ...value.campaign, extra: true } }
    ]) expect(() => parseProgress(JSON.stringify(broken), hash, "2d")).toThrow();
    let full = emptyCampaign();
    const idle = worldFrom(gameReference());
    for (let i = 0; i < 32; i++) full = rememberLevel(full, captureProgress2D(idle, hash, `level-${i}`, "player"));
    expect(() => rememberLevel(full, captureProgress2D(idle, hash, "overflow", "player"))).toThrow(/limit/);
    const mixed = rememberLevel(emptyCampaign(), captureProgress2D(idle, hash, "a", "player"));
    expect(() => openCampaignLevel(gameReference(), mixed, "a", "3d", hash)).toThrow(/profile/);
});

test("3D transitions carry shared values, restore the previous level once, and restart drops the campaign", async () => {
    const build = (target: string) => {
        const doc = level();
        const behavior = graph();
        behavior.nodes = [...behavior.nodes.map(node => node.id === "hurt" ? { ...node, next: "mark" } : node),
            { id: "mark", kind: "action", target: "self", action: { kind: "score", key: "visits" }, next: null }];
        const hero: Node = { ...doc.nodes.get("player")!, id: "hero", entity: { player: true, body: "dynamic", behavior }, spatial3d: {
            transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            collider: { kind: "box", halfExtents: { x: .5, y: .5, z: .5 } }
        } };
        const camera: Node = { ...hero, id: "camera", entity: undefined, spatial3d: {
            transform: { ...hero.spatial3d!.transform, position: { x: 0, y: 0, z: 5 } },
            camera: { kind: "perspective", near: .1, far: 100, verticalFovDegrees: 60 }
        } };
        const goal: Node = { ...hero, id: "goal", entity: { body: "static", goal: true, transitionTo: target }, spatial3d: {
            transform: { ...hero.spatial3d!.transform, position: { x: 1.05, y: 0, z: 0 } },
            collider: { kind: "box", halfExtents: { x: .5, y: .5, z: .5 } }
        } };
        doc.nodes.clear(); doc.rootNodeUuids = [];
        for (const node of [hero, camera, goal]) { doc.nodes.set(node.id, node); doc.rootNodeUuids.push(node.id); }
        return doc;
    };
    const entry = build("next.vde"), next = build("entry.vde");
    const files = new Map([["package:entry", entry], ["package:next", next]]);
    const host = {
        readEntryFile: jest.fn(async () => ({ filePath: "package:entry", content: serializeDocument(entry) })),
        readLevelFile: jest.fn(async (_current: string, target: string) => {
            const filePath = target === "entry.vde" ? "package:entry" : "package:next";
            return { filePath, content: serializeDocument(files.get(filePath)!) };
        }),
        readProgressLevel: jest.fn(async (key: string) => ({ filePath: key, content: serializeDocument(files.get(key)!) }))
    };
    const session = new PlayerSession3D(host, "main", hash);
    await session.start();
    session.advance(0); session.advance(1000 / 60);
    expect(session.world?.behaviorState?.data?.game.get("keys")).toBe(1);
    expect(session.world?.tallies?.get("visits")).toBe(1);
    session.advance(0); session.advance(1000 / 60, { x: 1, y: 0, z: 0, speed: 6 });
    const pending = session.world;
    host.readLevelFile.mockRejectedValueOnce(new Error("missing level"));
    await expect(session.followTransition()).rejects.toThrow(/missing level/);
    expect(session.world).toBe(pending); expect(session.filePath).toBe("package:entry");
    session.resume();
    expect(await session.followTransition()).toBe(true);
    expect(session.filePath).toBe("package:next");
    expect(session.world?.behaviorState?.data?.game.get("keys")).toBe(1);
    session.advance(0); session.advance(1000 / 60);
    expect(session.world?.behaviorState?.data?.game.get("keys")).toBe(2);
    session.advance(0); session.advance(1000 / 60, { x: 1, y: 0, z: 0, speed: 6 });
    expect(await session.followTransition()).toBe(true);
    expect(session.filePath).toBe("package:entry");
    expect(session.world?.tallies?.get("visits")).toBe(1);
    expect(session.world?.behaviorState?.data?.game.get("keys")).toBe(2);
    expect(session.world?.time).toBeGreaterThan(0);
    const text = session.saveProgress();
    const saved = JSON.parse(text);
    expect(saved.version).toBe(6); expect(saved.campaign.levels.map((item: { level: string }) => item.level)).toEqual(["package:next"]);
    const resumed = new PlayerSession3D(host, "main", hash);
    expect(await resumed.restoreProgress(text)).toBe(true);
    expect(resumed.world?.behaviorState?.data?.game.get("keys")).toBe(2);
    expect(resumed.world?.tallies?.get("visits")).toBe(1);
    expect(await resumed.restart()).toBe(true);
    resumed.advance(0); resumed.advance(1000 / 60);
    expect(resumed.world?.behaviorState?.data?.game.get("keys")).toBe(1);
    expect(JSON.parse(resumed.saveProgress()).version).toBe(5);
});
