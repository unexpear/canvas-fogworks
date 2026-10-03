/**
 * @module SaveMigration
 * @description Adopts a player save onto the current build only when an explicit compatibility map names that previous build and version.
 */
import { parseProgress, PlayerProgress, PROGRESS_MAX_BYTES } from "./PlayerProgress";

const { validateSaveMigrationTable, SAVE_MIGRATION_LIMIT } = require("./saveMigrationTable") as {
    validateSaveMigrationTable: (migrations: unknown, toGameId?: string) => SaveBuildMigration[];
    SAVE_MIGRATION_LIMIT: number;
};

export { SAVE_MIGRATION_LIMIT };

/** One previous package-content hash. `versions` are progress format versions, not document schemas. */
export interface SaveBuildMigration {
    fromGameId: string;
    versions: readonly number[];
}

export function saveMigrationTable(migrations: unknown, toGameId?: string): SaveBuildMigration[] {
    return validateSaveMigrationTable(migrations, toGameId).map(item => ({ fromGameId: item.fromGameId, versions: [...item.versions] }));
}

function rewritten(text: string, toGameId: string): string {
    const value = JSON.parse(text) as { gameId?: unknown; version?: unknown; campaign?: { levels?: { gameId?: unknown }[] } };
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.gameId !== "string") {
        throw new Error("This save belongs to a different game build.");
    }
    const fromGameId = value.gameId;
    if (typeof value.version === "number" && value.version >= 6 && value.campaign && Array.isArray(value.campaign.levels)) {
        for (const level of value.campaign.levels) {
            if (!level || typeof level !== "object" || level.gameId !== fromGameId) throw new Error("Campaign snapshot build does not match its save.");
            level.gameId = toGameId;
        }
    }
    value.gameId = toGameId;
    return JSON.stringify(value);
}

/**
 * Same-build saves parse unchanged. A listed previous build is rewritten to `toGameId` and then
 * passes the same validator. Any other build is refused. Progress v1–v6 acceptance is not a
 * cross-build migration.
 */
export function adoptProgress(text: string, toGameId: string, profile: "2d" | "3d", migrations: readonly SaveBuildMigration[] = []): PlayerProgress {
    if (typeof text !== "string" || text.length > PROGRESS_MAX_BYTES || new TextEncoder().encode(text).length > PROGRESS_MAX_BYTES) throw new Error("Player save exceeds 2MiB.");
    const table = saveMigrationTable(migrations, /^[a-f0-9]{64}$/.test(toGameId) ? toGameId : undefined);
    if (!/^[a-f0-9]{64}$/.test(toGameId)) throw new Error("This save belongs to a different game build.");
    let value: { gameId?: unknown; version?: unknown };
    try { value = JSON.parse(text); } catch { throw new Error("Invalid progress record."); }
    if (value && typeof value === "object" && !Array.isArray(value) && value.gameId === toGameId) return parseProgress(text, toGameId, profile);
    const fromGameId = value && typeof value === "object" && !Array.isArray(value) ? value.gameId : undefined;
    const migration = table.find(item => item.fromGameId === fromGameId);
    if (!migration) throw new Error("This save belongs to a different game build.");
    if (!migration.versions.includes(value.version as number)) throw new Error("This save version is not covered by the build migration.");
    return parseProgress(rewritten(text, toGameId), toGameId, profile);
}
