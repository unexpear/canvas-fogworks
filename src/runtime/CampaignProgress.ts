/** @module CampaignProgress @description Visited-level snapshots and game-scoped values carried across level transitions. */
import type { GameplayValue } from "../core/document/GameplayData";
import { gameplayValueError } from "../core/document/GameplayData";
import type { ReadonlyDocument } from "../core/document/Document";
import { emptyGameplayData } from "../core/runtime/GameplayDataState";
import { emptyBehaviorState, type BehaviorState } from "../core/runtime/BehaviorRuntime";
import { worldFrom, type WorldState } from "../core/runtime/World";
import { world3DFrom, type World3DState } from "../core/runtime/World3D";
import { restartRun } from "../core/runtime/RunFlow";
import {
    PlayerProgress, captureProgress2D, captureProgress3D, restoreProgress2D, restoreProgress3D
} from "./PlayerProgress";

/** One more than the suspended-level cap: the level being left is recorded before the destination is removed. */
export const CAMPAIGN_LEVEL_LIMIT = 32;
/** Editor play is not a packaged build. This id never selects a desktop save slot. */
export const EDITOR_CAMPAIGN_GAME_ID = "0".repeat(64);

export interface CampaignState {
    shared: ReadonlyMap<string, GameplayValue>;
    levels: ReadonlyMap<string, PlayerProgress>;
}
export function emptyCampaign(): CampaignState {
    return { shared: new Map(), levels: new Map() };
}

/** Game-scoped numbers travel in `shared`. The level record keeps entity values, actors and waiting graphs. */
function snapshot(progress: PlayerProgress): PlayerProgress {
    const copy = JSON.parse(JSON.stringify(progress)) as PlayerProgress;
    delete copy.campaign;
    if (copy.version !== 5 || !copy.data || !copy.behaviors || !copy.lifecycle) {
        throw new Error("Campaign snapshots require a complete current-level progress record.");
    }
    copy.data = { ...copy.data, game: [] };
    return copy;
}

export function rememberLevel(campaign: CampaignState, progress: PlayerProgress): CampaignState {
    if (campaign.levels.size >= CAMPAIGN_LEVEL_LIMIT && !campaign.levels.has(progress.level)) {
        throw new Error("Campaign level limit exceeded.");
    }
    const shared = new Map(campaign.shared);
    for (const [id, value] of progress.data?.game ?? []) shared.set(id, value);
    const levels = new Map(campaign.levels);
    levels.set(progress.level, snapshot(progress));
    return { shared, levels };
}

/** Copies matching declarations only. A name that is absent or a different type on this level stays in the campaign. */
export function installSharedGame<T extends { behaviorState?: BehaviorState }>(
    doc: ReadonlyDocument, world: T, shared: ReadonlyMap<string, GameplayValue>
): T {
    const game = new Map<string, GameplayValue>();
    for (const variable of doc.gameplayVariables ?? []) {
        if (variable.scope !== "game" || !shared.has(variable.id)) continue;
        const value = shared.get(variable.id)!;
        if (gameplayValueError(value, variable.type)) continue;
        game.set(variable.id, value);
    }
    const prior = world.behaviorState;
    if (game.size === 0 && !prior?.data) return world;
    const data = prior?.data ?? emptyGameplayData();
    return { ...world, behaviorState: { ...(prior ?? emptyBehaviorState()), data: { ...data, game } } };
}

export function openCampaignLevel(
    doc: ReadonlyDocument, campaign: CampaignState, levelKey: string, profile: "2d" | "3d", gameId: string
): { campaign: CampaignState; world2d: WorldState; world3d: World3DState | null } {
    const levels = new Map(campaign.levels);
    const stored = levels.get(levelKey);
    levels.delete(levelKey);
    const next: CampaignState = { shared: campaign.shared, levels };
    if (stored && stored.profile !== profile) throw new Error("Saved campaign level uses a different player profile.");
    if (stored) {
        const progress: PlayerProgress = { ...stored, gameId, level: levelKey };
        if (profile === "2d") {
            return { campaign: next, world2d: installSharedGame(doc, restoreProgress2D(doc, progress), next.shared), world3d: null };
        }
        return {
            campaign: next, world2d: restartRun(doc),
            world3d: installSharedGame(doc, restoreProgress3D(doc, world3DFrom(doc), progress), next.shared)
        };
    }
    if (profile === "2d") return { campaign: next, world2d: installSharedGame(doc, worldFrom(doc), next.shared), world3d: null };
    return { campaign: next, world2d: restartRun(doc), world3d: installSharedGame(doc, world3DFrom(doc), next.shared) };
}

export function rememberLeavingLevel(
    campaign: CampaignState, profile: "2d" | "3d", world: WorldState | World3DState,
    gameId: string, level: string | null, playerId: string | null
): CampaignState {
    if (!level || !playerId || !world.bodies.has(playerId)) return campaign;
    const progress = profile === "3d"
        ? captureProgress3D(world as World3DState, gameId, level, playerId)
        : captureProgress2D(world as WorldState, gameId, level, playerId);
    return rememberLevel(campaign, progress);
}

function samePairs(shared: ReadonlyMap<string, GameplayValue>, current: readonly [string, GameplayValue][]): boolean {
    return shared.size === current.length && current.every(([id, value]) => shared.get(id) === value);
}

/** A level that has never been left still serializes as v5. Visited levels and values they introduced require v6. */
export function withCampaign(progress: PlayerProgress, campaign: CampaignState): PlayerProgress {
    const shared = new Map(campaign.shared);
    for (const [id, value] of progress.data?.game ?? []) shared.set(id, value);
    const levels = [...campaign.levels.values()].filter(level => level.level !== progress.level).map(level => {
        const copy = snapshot(level);
        copy.gameId = progress.gameId; copy.profile = progress.profile;
        return copy;
    });
    if (levels.length === 0 && samePairs(shared, progress.data?.game ?? [])) return progress;
    return { ...progress, version: 6, campaign: { shared: [...shared.entries()], levels } };
}

export function campaignFromProgress(progress: PlayerProgress): CampaignState {
    const shared = new Map<string, GameplayValue>();
    for (const [id, value] of progress.campaign?.shared ?? []) shared.set(id, value);
    for (const [id, value] of progress.data?.game ?? []) shared.set(id, value);
    const levels = new Map<string, PlayerProgress>();
    for (const level of progress.campaign?.levels ?? []) levels.set(level.level, level);
    levels.delete(progress.level);
    return { shared, levels };
}
