/**
 * @module atomicWrite
 * @description Crash-resistant replacement for project and export files: write and flush a
 * sibling temporary file, flush the parent directory when the platform allows it, record a
 * checksummed commit marker and flush that directory again, then rename over the destination
 * and flush the directory. The next replacement installs that marker when the destination is
 * still the previous version, and it does not install it over different newer bytes. It also
 * removes a stale temporary file that has no commit marker. A returned write is not a power-loss
 * proof: a crash before the commit marker's directory flush returns can still drop the new name,
 * a disk that ignores flush can still lose bytes that sync reported, and a refused directory
 * flush can still drop the new name. appendFileSynced extends an existing file and flushes
 * those bytes; it does not publish a new directory name.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let sequence = 0;
/** Temps this process has created and not yet renamed or removed. */
const inFlightTemps = new Set();
/** Opening or flushing a directory is unsupported on some platforms. That is not a disk failure. */
const DIRECTORY_SYNC_REFUSED = new Set(["EISDIR", "EPERM", "ENOTSUP", "EINVAL", "ENOTDIR"]);
const SHA256 = /^[a-f0-9]{64}$/;

function escapedBase(base) {
    return base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function atomicTempPattern(base) {
    return new RegExp(`^\\.${escapedBase(base)}\\.(\\d+)\\.(\\d+)\\.(\\d+)\\.tmp$`);
}

function commitMarkerPattern(base) {
    return new RegExp(`^\\.${escapedBase(base)}\\.(\\d+)\\.(\\d+)\\.(\\d+)\\.commit$`);
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

function ioReadDir(io) {
    return io.readdir ? io.readdir.bind(io) : fs.promises.readdir;
}

function ioReadFile(io) {
    return io.readFile ? io.readFile.bind(io) : fs.promises.readFile;
}

function ioUnlink(io) {
    return io.unlink ? io.unlink.bind(io) : fs.promises.unlink;
}

async function unlinkQuiet(file, io) {
    try {
        await ioUnlink(io)(file);
    } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
    }
}

async function fileDigest(file, io) {
    try {
        const data = await ioReadFile(io)(file);
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        return {
            sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length
        };
    } catch (err) {
        if (err && err.code === "ENOENT") return null;
        throw err;
    }
}

function parseCommitMarker(raw) {
    let record;
    try {
        record = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    } catch {
        return null;
    }
    if (!record || record.version !== 1) return null;
    if (typeof record.temp !== "string" || record.temp === "" || record.temp !== path.basename(record.temp)) return null;
    if (record.temp.includes("..")) return null;
    if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256)) return null;
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) return null;
    if (record.previous !== null && (typeof record.previous !== "string" || !SHA256.test(record.previous))) return null;
    return record;
}

/**
 * Remove sibling temps whose writer has exited. A live writer's temp, an in-flight temp, and
 * every other name in the directory stay. Unlink does not follow a symlink.
 */
async function reapStaleAtomicTemps(target, io = fs.promises) {
    if (!target || typeof target !== "string") throw new Error("Invalid write target.");
    const dir = path.dirname(target);
    const pattern = atomicTempPattern(path.basename(target));
    const readdir = ioReadDir(io);
    let names;
    try {
        names = await readdir(dir);
    } catch (err) {
        if (err && err.code === "ENOENT") return;
        throw err;
    }
    if (!Array.isArray(names)) return;
    for (const name of names) {
        if (typeof name !== "string") continue;
        const match = pattern.exec(name);
        if (!match) continue;
        const full = path.join(dir, name);
        if (inFlightTemps.has(full)) continue;
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || tempOwnerIsLive(pid)) continue;
        await unlinkQuiet(full, io);
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
 * Append bytes to an existing file and flush them. On a flush failure the file is truncated
 * back to its previous size when the handle allows it. This does not create a directory name.
 */
async function appendFileSynced(target, data, io = fs.promises) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const handle = await io.open(target, "r+");
    let start = 0;
    try {
        start = (await handle.stat()).size;
        let offset = 0;
        while (offset < buf.length) {
            const { bytesWritten } = await handle.write(buf, offset, buf.length - offset, start + offset);
            if (!bytesWritten) throw new Error("Short write while appending flushed bytes.");
            offset += bytesWritten;
        }
        await handle.sync();
    } catch (error) {
        if (typeof handle.truncate === "function") {
            try { await handle.truncate(start); } catch { /* retain the original failure */ }
        }
        throw error;
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
 * Install a commit marker whose directory flush already returned, when the destination is still
 * the previous bytes. Different bytes are left in place: that is a newer explicit save.
 * A live writer's marker is left alone.
 */
async function reconcileDurableReplacement(target, io = fs.promises) {
    if (!target || typeof target !== "string") throw new Error("Invalid write target.");
    const dir = path.dirname(target);
    const pattern = commitMarkerPattern(path.basename(target));
    let names;
    try {
        names = await ioReadDir(io)(dir);
    } catch (err) {
        if (err && err.code === "ENOENT") return;
        throw err;
    }
    if (!Array.isArray(names)) return;
    const found = [];
    let writerLive = false;
    for (const name of names) {
        if (typeof name !== "string") continue;
        const match = pattern.exec(name);
        if (!match) continue;
        const pid = Number(match[1]);
        const tempName = `${name.slice(0, -"commit".length)}tmp`;
        const tempPath = path.join(dir, tempName);
        if (inFlightTemps.has(tempPath) || tempOwnerIsLive(pid)) {
            writerLive = true;
            continue;
        }
        found.push({
            name,
            time: Number(match[2]),
            seq: Number(match[3]),
            markerPath: path.join(dir, name),
            tempPath,
            tempName
        });
    }
    // A writer still publishing this target owns the directory. Do not install under it.
    if (writerLive) return;
    found.sort((left, right) => left.time - right.time || left.seq - right.seq);
    const newest = found.pop();
    for (const older of found) {
        await unlinkQuiet(older.markerPath, io);
        await unlinkQuiet(older.tempPath, io);
    }
    if (!newest) return;
    let raw = null;
    try {
        raw = await ioReadFile(io)(newest.markerPath);
    } catch (err) {
        if (err && err.code === "ENOENT") return;
        throw err;
    }
    const record = parseCommitMarker(raw);
    if (!record || record.temp !== newest.tempName) {
        await unlinkQuiet(newest.markerPath, io);
        return;
    }
    const tempDigest = await fileDigest(newest.tempPath, io);
    const targetDigest = await fileDigest(target, io);
    const tempOk = tempDigest && tempDigest.sha256 === record.sha256 && tempDigest.bytes === record.bytes;
    const targetIsNew = targetDigest && targetDigest.sha256 === record.sha256 && targetDigest.bytes === record.bytes;
    const targetIsPrevious = record.previous === null
        ? targetDigest === null
        : Boolean(targetDigest && targetDigest.sha256 === record.previous);
    if (targetIsNew) {
        await unlinkQuiet(newest.markerPath, io);
        if (tempDigest) await unlinkQuiet(newest.tempPath, io);
        return;
    }
    if (tempOk && targetIsPrevious) {
        await io.rename(newest.tempPath, target);
        let synced = false;
        try { synced = await syncDirectory(dir, io); } catch { synced = false; }
        // The marker stays until this directory flush returns. A crash before that still has
        // the temporary file and the marker under the model that discards unsynced renames.
        if (synced) {
            await unlinkQuiet(newest.markerPath, io);
            try { await syncDirectory(dir, io); } catch { /* the next pass removes a marker whose bytes are already in place */ }
        }
        return;
    }
    // The destination matches neither the previous version nor this marker. Leave those bytes.
    await unlinkQuiet(newest.markerPath, io);
    if (tempDigest) await unlinkQuiet(newest.tempPath, io);
}

/**
 * Replace one file without exposing a partially-written destination. `io` is injectable only so
 * failure cleanup can be tested; production uses `fs.promises`. The returned `directorySynced`
 * flag is true only after the parent directory flush that follows the rename succeeded.
 */
async function atomicWrite(target, data, io = fs.promises) {
    if (!target || typeof target !== "string") throw new Error("Invalid write target.");
    const dir = path.dirname(target);
    const base = path.basename(target);
    await reconcileDurableReplacement(target, io);
    await reapStaleAtomicTemps(target, io);
    const stamp = Date.now();
    const id = sequence++;
    const temp = path.join(dir, `.${base}.${process.pid}.${stamp}.${id}.tmp`);
    const marker = path.join(dir, `.${base}.${process.pid}.${stamp}.${id}.commit`);
    inFlightTemps.add(temp);
    let handle = null;
    let renamed = false;
    let markerDurable = false;
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
        const tempNameDurable = await syncDirectory(dir, io);
        if (tempNameDurable) {
            const previous = await fileDigest(target, io);
            const hashed = await fileDigest(temp, io);
            if (!hashed) throw new Error(`Temporary file for ${base} disappeared before its commit marker.`);
            const record = Buffer.from(JSON.stringify({
                version: 1,
                temp: path.basename(temp),
                bytes: hashed.bytes,
                sha256: hashed.sha256,
                previous: previous ? previous.sha256 : null
            }));
            handle = await io.open(marker, "wx", 0o666);
            await handle.writeFile(record);
            await handle.sync();
            await handle.close();
            handle = null;
            markerDurable = await syncDirectory(dir, io);
            if (!markerDurable) await unlinkQuiet(marker, io);
        }
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
        if (markerDurable) {
            await unlinkQuiet(marker, io);
            try {
                const markerCleared = await syncDirectory(dir, io);
                directorySynced = directorySynced && markerCleared;
            } catch (err) {
                const failure = new Error(`Replaced ${base} but could not flush its directory: ${err && err.message ? err.message : err}`);
                if (err && err.code) failure.code = err.code;
                throw failure;
            }
        }
        return { directorySynced };
    } catch (err) {
        if (handle) {
            try { await handle.close(); } catch { /* retain the original failure */ }
        }
        // A durable commit marker must keep its temporary file. The next replacement installs it
        // when the destination is still the previous version.
        if (!renamed && !markerDurable) {
            await unlinkQuiet(temp, io);
            await unlinkQuiet(marker, io);
        }
        throw err;
    } finally {
        inFlightTemps.delete(temp);
    }
}

module.exports = {
    atomicWrite,
    syncFile,
    syncDirectory,
    appendFileSynced,
    reapStaleAtomicTemps,
    reconcileDurableReplacement
};
