/**
 * @module progressFile
 * @description Bounded atomic player-save slot under app-owned data, independent of project save/recovery files.
 */
const fs = require("fs"), path = require("path");
const { atomicWrite } = require("../electron/atomicWrite");
const { validateSaveMigrationTable } = require("../runtime/saveMigrationTable");
const MAX = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

function assertSourceIds(gameId, fromGameIds) {
    if (!Array.isArray(fromGameIds) || fromGameIds.length > 8) throw new Error("Invalid save migration table.");
    const seen = new Set();
    for (const id of fromGameIds) {
        if (typeof id !== "string" || !HASH.test(id) || id === gameId || seen.has(id)) throw new Error("Invalid save migration build id.");
        seen.add(id);
    }
}

async function readSlot(target) {
    let handle;
    try {
        handle = await fs.promises.open(target, "r"); const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX) throw new Error("Player save exceeds 2MiB.");
        const bytes = Buffer.alloc(stat.size + 1); let used = 0;
        while (used < bytes.length) { const read = await handle.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
        if (used !== stat.size) throw new Error("Player save changed while reading.");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    finally { if (handle) await handle.close(); }
}

function createProgressFile(directory, gameId, options = {}) {
    if (!HASH.test(gameId)) throw new Error("Invalid game save ID.");
    const fromGameIds = options.fromGameIds ?? [];
    assertSourceIds(gameId, fromGameIds);
    const io = options.io;
    const targetFor = id => path.join(directory, `${id}.json`);
    let writes = Promise.resolve();
    return {
        async read() {
            await writes.catch(() => {});
            const current = await readSlot(targetFor(gameId));
            if (current !== null) return current;
            for (const prior of fromGameIds) {
                const text = await readSlot(targetFor(prior));
                if (text !== null) return text;
            }
            return null;
        },
        write(content) {
            if (typeof content !== "string" || Buffer.byteLength(content) > MAX) return Promise.reject(new Error("Player save exceeds 2MiB."));
            // Semantic validation stays with the runtime; this boundary grants only bounded slot bytes.
            const next = writes.catch(() => {}).then(async () => {
                await fs.promises.mkdir(directory, { recursive: true });
                await atomicWrite(targetFor(gameId), content, io);
            });
            writes = next; return next;
        }
    };
}

/** Predecessor ids come from the package embedded in this HTML, never from the renderer. */
function saveMigrationsFromHtml(html, gameId) {
    if (typeof html !== "string" || !HASH.test(gameId)) throw new Error("Game package identity is missing.");
    const match = html.match(/<script id="game-data"([^>]*)>([A-Za-z0-9+/=]*)<\/script>/);
    if (!match) throw new Error("Game package identity is missing.");
    const declared = match[1].match(/data-sha256="([a-f0-9]{64})"/);
    if (!declared || declared[1] !== gameId) throw new Error("Game package identity is missing.");
    let manifest;
    try { manifest = JSON.parse(Buffer.from(match[2], "base64").toString("utf8")); }
    catch { throw new Error("Invalid game package."); }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid game package.");
    if (!Object.prototype.hasOwnProperty.call(manifest, "saveMigrations")) return [];
    return validateSaveMigrationTable(manifest.saveMigrations, gameId);
}

module.exports = { createProgressFile, saveMigrationsFromHtml };
