/** @module packageStream @description Reads declared package chunk files by id, checks length and SHA-256, and refuses any other path. */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const STREAM_KINDS = new Set(["buffer", "image", "hdr"]);
const FILE_LIMIT = 16 * 1024 * 1024;

function streamRecord(file) {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Invalid package stream catalog.");
    const hasData = Object.prototype.hasOwnProperty.call(file, "data");
    const hasHash = Object.prototype.hasOwnProperty.call(file, "sha256");
    if (hasData && hasHash) throw new Error("Invalid package stream catalog.");
    if (hasData) return null;
    if (!hasHash) throw new Error("Invalid package stream catalog.");
    if (typeof file.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(file.id)) throw new Error("Invalid package stream id.");
    if (!STREAM_KINDS.has(file.kind)) throw new Error("Invalid package stream kind.");
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > FILE_LIMIT) throw new Error("Invalid package stream length.");
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid package stream hash.");
    return { id: file.id, bytes: file.bytes, sha256: file.sha256 };
}

function streamCatalogFromSerialized(serialized) {
    const manifest = JSON.parse(serialized);
    if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.files)) throw new Error("Invalid package stream catalog.");
    const catalog = [];
    for (const file of manifest.files) {
        const record = streamRecord(file);
        if (record) catalog.push(record);
    }
    return catalog;
}

function streamCatalogFromHtml(html) {
    const match = String(html).match(/<script id="game-data" type="application\/octet-stream" data-sha256="[a-f0-9]{64}">([A-Za-z0-9+/]*=*)<\/script>/);
    if (!match) throw new Error("Game package payload is missing.");
    const serialized = Buffer.from(match[1], "base64").toString("utf8");
    if (Buffer.from(serialized).toString("base64") !== match[1]) throw new Error("Noncanonical game package payload.");
    return streamCatalogFromSerialized(serialized);
}

function createPackageStreamReader(directory, catalog) {
    if (!Array.isArray(catalog)) throw new Error("Invalid package stream catalog.");
    const byId = new Map();
    for (const item of catalog) {
        const record = streamRecord({ ...item, kind: item.kind ?? "buffer" });
        if (!record) throw new Error("Invalid package stream catalog.");
        if (byId.has(record.id)) throw new Error("Duplicate package stream id.");
        byId.set(record.id, record);
    }
    const root = path.resolve(directory);
    return {
        async read(id) {
            if (typeof id !== "string" || !byId.has(id)) throw new Error("Unknown package stream.");
            const expected = byId.get(id);
            const file = path.resolve(root, `${id}.bin`);
            if (path.relative(root, file) !== `${id}.bin`) throw new Error("Package stream escapes its directory.");
            const handle = await fs.promises.open(file, "r");
            try {
                const before = await handle.stat();
                if (!before.isFile() || before.size !== expected.bytes) throw new Error("Package stream length mismatch.");
                const bytes = Buffer.alloc(before.size);
                let used = 0;
                while (used < bytes.length) {
                    const next = await handle.read(bytes, used, bytes.length - used, used);
                    if (!next.bytesRead) break;
                    used += next.bytesRead;
                }
                const after = await handle.stat();
                if (used !== expected.bytes || after.size !== before.size) throw new Error("Package stream length mismatch.");
                const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
                if (sha256 !== expected.sha256) throw new Error("Package stream hash mismatch.");
                return bytes.toString("base64");
            } finally {
                await handle.close();
            }
        }
    };
}

module.exports = { streamCatalogFromSerialized, streamCatalogFromHtml, createPackageStreamReader };
