/**
 * @module atomicWrite
 * @description Crash-resistant replacement for project and export files: write and flush a
 * sibling temporary file, rename it over the destination, then flush the parent directory
 * when the platform allows it. The next replacement removes a stale sibling temporary file
 * left by an unclean shutdown. A returned write is not a power-loss proof: a crash before
 * the directory flush finishes, a disk that ignores flush, or a refused directory flush can
 * still drop the new name.
 */

const fs = require("fs");
const path = require("path");

let sequence = 0;
/** Temps this process has created and not yet renamed or removed. */
const inFlightTemps = new Set();
/** Opening or flushing a directory is unsupported on some platforms. That is not a disk failure. */
const DIRECTORY_SYNC_REFUSED = new Set(["EISDIR", "EPERM", "ENOTSUP", "EINVAL", "ENOTDIR"]);

function atomicTempPattern(base) {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\.${escaped}\\.(\\d+)\\.(\\d+)\\.(\\d+)\\.tmp$`);
}

function tempOwnerIsLive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    // A leftover from this process is stale: the in-flight set holds any temp still being written.
    if (pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return !err || err.code !== "ESRCH";
    }
}

/**
 * Remove sibling temps whose writer has exited. A live writer's temp, an in-flight temp, and
 * every other name in the directory stay. Unlink does not follow a symlink.
 */
async function reapStaleAtomicTemps(target, io = fs.promises) {
    if (!target || typeof target !== "string") throw new Error("Invalid write target.");
    const dir = path.dirname(target);
    const pattern = atomicTempPattern(path.basename(target));
    const readdir = io.readdir ? io.readdir.bind(io) : fs.promises.readdir;
    let names;
    try {
        names = await readdir(dir);
    } catch (err) {
        if (err && err.code === "ENOENT") return;
        throw err;
    }
    if (!Array.isArray(names)) return;
    const unlink = io.unlink ? io.unlink.bind(io) : fs.promises.unlink;
    for (const name of names) {
        if (typeof name !== "string") continue;
        const match = pattern.exec(name);
        if (!match) continue;
        const full = path.join(dir, name);
        if (inFlightTemps.has(full)) continue;
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || tempOwnerIsLive(pid)) continue;
        try {
            await unlink(full);
        } catch (err) {
            if (!err || err.code !== "ENOENT") throw err;
        }
    }
}

/** Flush one file's bytes. Callers flush the parent directory separately before dropping a journal. */
async function syncFile(target, io = fs.promises) {
    const handle = await io.open(target, "r+");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/**
 * Flush a directory's entries. Returns false when this platform refuses to flush a directory,
 * and throws for other I/O failures. False is not a successful power-loss checkpoint.
 */
async function syncDirectory(directory, io = fs.promises) {
    let handle = null;
    try {
        handle = await io.open(directory, "r");
        await handle.sync();
        return true;
    } catch (err) {
        if (err && DIRECTORY_SYNC_REFUSED.has(err.code)) return false;
        throw err;
    } finally {
        if (handle) {
            try { await handle.close(); } catch { /* retain the original failure */ }
        }
    }
}

/**
 * Replace one file without exposing a partially-written destination. `io` is injectable only so
 * failure cleanup can be tested; production uses `fs.promises`. The returned `directorySynced`
 * flag is true only after the parent directory flush succeeded.
 */
async function atomicWrite(target, data, io = fs.promises) {
    if (!target || typeof target !== "string") throw new Error("Invalid write target.");
    const dir = path.dirname(target);
    const base = path.basename(target);
    await reapStaleAtomicTemps(target, io);
    const temp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${sequence++}.tmp`);
    inFlightTemps.add(temp);
    let handle = null;
    let renamed = false;
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
        renamed = true;
        let directorySynced = false;
        try {
            directorySynced = await syncDirectory(dir, io);
        } catch (err) {
            const failure = new Error(`Replaced ${base} but could not flush its directory: ${err && err.message ? err.message : err}`);
            if (err && err.code) failure.code = err.code;
            throw failure;
        }
        return { directorySynced };
    } catch (err) {
        if (handle) {
            try { await handle.close(); } catch { /* retain the original failure */ }
        }
        if (!renamed) {
            try { await io.unlink(temp); } catch { /* absent or already renamed */ }
        }
        throw err;
    } finally {
        inFlightTemps.delete(temp);
    }
}

module.exports = { atomicWrite, syncFile, syncDirectory, reapStaleAtomicTemps };
