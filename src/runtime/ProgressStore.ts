/** @module ProgressStore @description Narrow save-slot capability; browser storage failures are reported, never silently replaced with an in-memory save. */
import { PROGRESS_MAX_BYTES } from "./PlayerProgress";
import { SaveBuildMigration, saveMigrationTable } from "./SaveMigration";
export interface ProgressStore { read(): Promise<string | null>; write(content: string): Promise<void> }
interface ProgressStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function browserProgressStore(gameId: string, migrations: readonly SaveBuildMigration[] = [], storage?: ProgressStorage): ProgressStore {
    if (!/^[a-f0-9]{64}$/.test(gameId)) throw new Error("Invalid progress namespace.");
    const sources = saveMigrationTable(migrations, gameId).map(item => item.fromGameId);
    const slot = storage ?? window.localStorage;
    const key = (id: string) => `canvas-fogworks:progress:v1:${id}`;
    return {
        async read() {
            const current = slot.getItem(key(gameId));
            if (current !== null) { checkSize(current); return current; }
            for (const id of sources) {
                const prior = slot.getItem(key(id));
                if (prior === null) continue;
                checkSize(prior); return prior;
            }
            return null;
        },
        async write(content) { checkSize(content); slot.setItem(key(gameId), content); }
    };
}
function checkSize(content: string | null) {
    if (content !== null && (typeof content !== "string" || content.length > PROGRESS_MAX_BYTES || new TextEncoder().encode(content).length > PROGRESS_MAX_BYTES)) throw new Error("Player save exceeds 2MiB.");
}
