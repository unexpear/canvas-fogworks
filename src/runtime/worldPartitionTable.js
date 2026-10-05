/**
 * @module worldPartitionTable
 * @description Validates an optional world-partition cell table. Inline models and fonts cannot be cells.
 * A missing table is not streamed. The payload budget stays 32 MiB.
 */
const CELL_LIMIT = 64;
const RADIUS_LIMIT = 1_000_000;
const PARTITION_BUDGET_BYTES = 32 * 1024 * 1024;
const STREAM_KINDS = new Set(["buffer", "image", "hdr"]);
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function record(value, fields, message) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
    const keys = Object.keys(value);
    if (keys.length !== fields.length || fields.some(field => !Object.prototype.hasOwnProperty.call(value, field))) throw new Error(message);
    return value;
}

function bounds(value) {
    if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== "number" || !Number.isFinite(item))) {
        throw new Error("Invalid world-partition bounds.");
    }
    return Object.freeze([value[0], value[1], value[2]]);
}

function validateWorldPartition(value, files) {
    const table = record(value, ["anchor", "loadRadius", "unloadRadius", "cells"], "Invalid world-partition fields.");
    if (!Array.isArray(table.cells) || table.cells.length < 1 || table.cells.length > CELL_LIMIT) throw new Error("World partition exceeds 64 cells.");
    if (typeof table.loadRadius !== "number" || typeof table.unloadRadius !== "number"
        || !Number.isFinite(table.loadRadius) || !Number.isFinite(table.unloadRadius)
        || table.loadRadius <= 0 || table.loadRadius > RADIUS_LIMIT || table.unloadRadius > RADIUS_LIMIT) {
        throw new Error("Invalid world-partition radius.");
    }
    if (table.unloadRadius < table.loadRadius) throw new Error("World-partition unload radius is inside the load radius.");
    if (typeof table.anchor !== "string" || !ID.test(table.anchor)) throw new Error("Missing world-partition anchor.");
    const cells = [];
    const seen = new Set();
    for (const item of table.cells) {
        const cell = record(item, ["id", "min", "max", "file"], "Invalid world-partition cell.");
        if (typeof cell.id !== "string" || !ID.test(cell.id) || seen.has(cell.id)) throw new Error("Duplicate world-partition cell.");
        seen.add(cell.id);
        const min = bounds(cell.min), max = bounds(cell.max);
        if (min.some((item, index) => item >= max[index])) throw new Error("Invalid world-partition bounds.");
        if (typeof cell.file !== "string" || !ID.test(cell.file)) throw new Error("Missing world-partition file.");
        const file = files.get(cell.file);
        if (!file) throw new Error("Missing world-partition file.");
        if (!file.streamed || !STREAM_KINDS.has(file.kind) || typeof file.sha256 !== "string") {
            throw new Error("World-partition cells must reference streamed buffer, image or hdr payloads.");
        }
        if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > PARTITION_BUDGET_BYTES) {
            throw new Error("World-partition cell byte count does not match its file.");
        }
        cells.push(Object.freeze({ id: cell.id, min, max, file: cell.file, bytes: file.bytes, sha256: file.sha256 }));
    }
    if (!seen.has(table.anchor)) throw new Error("Missing world-partition anchor.");
    return Object.freeze({
        anchor: table.anchor,
        loadRadius: table.loadRadius,
        unloadRadius: table.unloadRadius,
        budgetBytes: PARTITION_BUDGET_BYTES,
        cells: Object.freeze(cells)
    });
}

function describePackageFiles(files) {
    const described = new Map();
    if (!Array.isArray(files)) throw new Error("Invalid world-partition package.");
    for (const file of files) {
        if (!file || typeof file !== "object" || Array.isArray(file) || typeof file.id !== "string") throw new Error("Invalid world-partition package.");
        const streamed = typeof file.sha256 === "string" && !Object.prototype.hasOwnProperty.call(file, "data");
        described.set(file.id, { kind: file.kind, bytes: file.bytes, streamed, sha256: streamed ? file.sha256 : null });
    }
    return described;
}

function evaluateWorldPartitionClaim(manifest) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !Object.prototype.hasOwnProperty.call(manifest, "worldPartition")) {
        return { acceptable: false, streamed: false, reason: "missing-partition" };
    }
    try {
        const table = validateWorldPartition(manifest.worldPartition, describePackageFiles(manifest.files));
        return { acceptable: true, streamed: true, reason: null, anchor: table.anchor, cells: table.cells.length };
    } catch (error) {
        return { acceptable: false, streamed: false, reason: error.message };
    }
}

module.exports = { CELL_LIMIT, PARTITION_BUDGET_BYTES, validateWorldPartition, evaluateWorldPartitionClaim };
