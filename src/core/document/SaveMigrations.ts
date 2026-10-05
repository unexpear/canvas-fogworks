/**
 * @module SaveMigrations
 * @description Document-level cross-build save list. The same table the package and runtime already honor.
 */
const { validateSaveMigrationTable, SAVE_MIGRATION_LIMIT } = require("../../runtime/saveMigrationTable") as {
    validateSaveMigrationTable: (migrations: unknown, toGameId?: string) => { fromGameId: string; versions: number[] }[];
    SAVE_MIGRATION_LIMIT: number;
};

export { SAVE_MIGRATION_LIMIT };

/** One previous package-content hash. `versions` are progress format versions, not document schemas. */
export interface DocumentSaveMigration {
    fromGameId: string;
    versions: readonly number[];
}

/** Why `saveMigrations` is not a valid adoption list, or null. Absent and empty both mean none. */
export function saveMigrationsError(value: unknown): string | null {
    if (value === undefined) return null;
    try {
        validateSaveMigrationTable(value);
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : "Invalid save migration table.";
    }
}

/** A validated copy, or absent when the list is empty. Throws on a malformed table. */
export function normalizeSaveMigrations(value: unknown): DocumentSaveMigration[] | undefined {
    if (value === undefined) return undefined;
    const table = validateSaveMigrationTable(value);
    return table.length ? table.map(item => ({ fromGameId: item.fromGameId, versions: [...item.versions] })) : undefined;
}
