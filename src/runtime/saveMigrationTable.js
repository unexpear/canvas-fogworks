/**
 * @module saveMigrationTable
 * @description Validates the explicit previous-build list shared by documents, packaged games and progress slots.
 */
const SAVE_MIGRATION_LIMIT = 8;
const HASH = /^[a-f0-9]{64}$/;

function validateSaveMigrationTable(migrations, toGameId) {
    if (migrations === undefined) return [];
    if (!Array.isArray(migrations) || migrations.length > SAVE_MIGRATION_LIMIT) throw new Error("Invalid save migration table.");
    const seen = new Set(), result = [];
    for (const item of migrations) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid save migration record.");
        const keys = Object.keys(item);
        if (keys.length !== 2 || !Object.prototype.hasOwnProperty.call(item, "fromGameId") || !Object.prototype.hasOwnProperty.call(item, "versions")) {
            throw new Error("Invalid save migration record.");
        }
        if (typeof item.fromGameId !== "string" || !HASH.test(item.fromGameId)) throw new Error("Invalid save migration build id.");
        if (toGameId !== undefined && item.fromGameId === toGameId) throw new Error("A save migration cannot name the current build.");
        if (seen.has(item.fromGameId)) throw new Error("Duplicate save migration build.");
        seen.add(item.fromGameId);
        if (!Array.isArray(item.versions) || item.versions.length < 1 || item.versions.length > 6) throw new Error("Invalid save migration versions.");
        const versions = [], versionSeen = new Set();
        for (const version of item.versions) {
            if (!Number.isInteger(version) || version < 1 || version > 6 || versionSeen.has(version)) throw new Error("Invalid save migration versions.");
            versionSeen.add(version); versions.push(version);
        }
        result.push({ fromGameId: item.fromGameId, versions });
    }
    return result;
}

function saveMigrationsFromDocument(content) {
    if (typeof content !== "string") throw new Error("Invalid document.");
    let raw;
    try { raw = JSON.parse(content); } catch { throw new Error("Invalid document."); }
    const document = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.document : undefined;
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid document.");
    if (!Object.prototype.hasOwnProperty.call(document, "saveMigrations")) return [];
    return validateSaveMigrationTable(document.saveMigrations);
}

module.exports = { SAVE_MIGRATION_LIMIT, validateSaveMigrationTable, saveMigrationsFromDocument };
