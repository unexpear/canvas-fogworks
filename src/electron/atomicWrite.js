/**
 * @module atomicWrite
 * @description Crash-resistant replacement for project and export files: write and flush a
 * sibling temporary file, then rename it over the destination in one filesystem operation.
 */

const fs = require("fs");
const path = require("path");

let sequence = 0;

/**
 * Replace one file without exposing a partially-written destination. `io` is injectable only so
 * failure cleanup can be tested; production uses `fs.promises`.
 */
async function atomicWrite(target, data, io = fs.promises) {
    if (!target || typeof target !== "string") throw new Error("Invalid write target.");
    const dir = path.dirname(target);
    const base = path.basename(target);
    const temp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${sequence++}.tmp`);
    let handle = null;
    try {
        let mode = 0o666;
        try {
            mode = (await io.stat(target)).mode & 0o777;
        } catch (err) {
            if (!err || err.code !== "ENOENT") throw err;
        }
        // `wx` refuses a collision rather than truncating somebody else's temporary file.
        handle = await io.open(temp, "wx", mode);
        await handle.writeFile(data);
        // Node documents `sync()` as requesting that buffered file data reach the storage device.
        await handle.sync();
        await handle.close();
        handle = null;
        await io.rename(temp, target);
    } catch (err) {
        if (handle) {
            try { await handle.close(); } catch { /* retain the original failure */ }
        }
        try { await io.unlink(temp); } catch { /* absent or already renamed */ }
        throw err;
    }
}

module.exports = { atomicWrite };
