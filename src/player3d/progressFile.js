/** @module progressFile @description Bounded atomic player-save slot under app-owned data, independent of project save/recovery files. */
const fs = require("fs"), path = require("path");
const { atomicWrite } = require("../electron/atomicWrite");
const MAX = 2 * 1024 * 1024;
function createProgressFile(directory, gameId) {
    if (!/^[a-f0-9]{64}$/.test(gameId)) throw new Error("Invalid game save ID.");
    const target = path.join(directory, `${gameId}.json`); let writes = Promise.resolve();
    return {
        async read() {
            await writes.catch(() => {});
            let handle;
            try {
                handle = await fs.promises.open(target, "r"); const stat = await handle.stat();
                if (!stat.isFile() || stat.size > MAX) throw new Error("Player save exceeds 2MiB.");
                const bytes = Buffer.alloc(stat.size + 1); let used = 0;
                while (used < bytes.length) { const read = await handle.read(bytes,used,bytes.length-used,used); if (!read.bytesRead) break; used += read.bytesRead; }
                if (used !== stat.size) throw new Error("Player save changed while reading.");
                return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0,used));
            } catch (error) { if (error.code === "ENOENT") return null; throw error; }
            finally { if (handle) await handle.close(); }
        },
        write(content) {
            if (typeof content !== "string" || Buffer.byteLength(content) > MAX) return Promise.reject(new Error("Player save exceeds 2MiB."));
            // Semantic validation stays with the runtime; this boundary grants only bounded slot bytes.
            const next = writes.catch(() => {}).then(async () => {
                await fs.promises.mkdir(directory, { recursive: true }); await atomicWrite(target,content);
            }); writes = next; return next;
        }
    };
}
module.exports = { createProgressFile };
