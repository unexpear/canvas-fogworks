/**
 * @module projectDependencies
 * @description Relocates bounded linked-level graphs, relative images and 3D sidecars without copying unreferenced packs or overwriting conflicting files.
 * An incomplete copy deletes only the destination files and directories that copy created. A killed copy leaves a journal the next cross-folder Save As rolls back.
 * The journal is a checksummed append-only log. After payload file syncs return, a filesSynced record is appended and that file sync returns before the journal name is removed, so discarding later unsynced directory operations still shows filesSynced. A crash before that file sync returns can still show the previous record. filesSynced means those file sync calls returned; it is not a directory-fsync, ignored-flush, or power-loss proof. A journal that still says filesSynced keeps those copies and removes only itself. An unclean journal write's temporary file is removed on the next rollback.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveConfined } = require("./confine");
const atomic = require("./atomicWrite");

const DEPENDENCY_JOURNAL_NAME = ".fogworks-dependency-journal.json";
const JOURNAL_MAGIC = Buffer.from("FWJ1\n");
const JOURNAL_CHECKSUM_BYTES = 8;
const JOURNAL_HEADER_BYTES = 4 + JOURNAL_CHECKSUM_BYTES;
const JOURNAL_RECORD_LIMIT = 8 * 1024 * 1024;

function journalPath(destinationRoot) {
    return path.join(destinationRoot, DEPENDENCY_JOURNAL_NAME);
}

function assertJournalRelative(relative) {
    if (typeof relative !== "string" || relative === "" || relative === "."
        || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
        throw new Error("Invalid dependency rollback journal.");
    }
    const parts = relative.split(/[\\/]+/);
    if (parts.some(part => part === "" || part === "." || part === "..")) {
        throw new Error("Invalid dependency rollback journal.");
    }
}

function assertJournalShape(journal) {
    if (!journal || journal.version !== 1 || !Array.isArray(journal.directories) || !Array.isArray(journal.files)
        || (journal.filesSynced !== undefined && journal.filesSynced !== true)) {
        throw new Error("Invalid dependency rollback journal.");
    }
}

function journalChecksum(body) {
    return crypto.createHash("sha256").update(body).digest().subarray(0, JOURNAL_CHECKSUM_BYTES);
}

function encodeJournalRecord(journal) {
    const body = Buffer.from(JSON.stringify(journal), "utf8");
    if (body.length === 0 || body.length > JOURNAL_RECORD_LIMIT) throw new Error("Invalid dependency rollback journal.");
    const header = Buffer.alloc(JOURNAL_HEADER_BYTES);
    header.writeUInt32BE(body.length, 0);
    journalChecksum(body).copy(header, 4);
    return Buffer.concat([header, body]);
}

function encodeJournalLog(journal) {
    return Buffer.concat([JOURNAL_MAGIC, encodeJournalRecord(journal)]);
}

/**
 * The last valid record in an append-only journal. A torn tail is ignored. A legacy single
 * JSON object is still accepted. Invalid JSON and an empty log are refused.
 */
function readDependencyJournal(raw) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    if (buf.length === 0) throw new Error("Invalid dependency rollback journal.");
    if (buf[0] === 0x7b) {
        let journal;
        try { journal = JSON.parse(buf.toString("utf8")); }
        catch { throw new Error("Invalid dependency rollback journal."); }
        assertJournalShape(journal);
        return journal;
    }
    if (buf.length < JOURNAL_MAGIC.length || !buf.subarray(0, JOURNAL_MAGIC.length).equals(JOURNAL_MAGIC)) {
        throw new Error("Invalid dependency rollback journal.");
    }
    let offset = JOURNAL_MAGIC.length;
    let last = null;
    while (offset + JOURNAL_HEADER_BYTES <= buf.length) {
        const length = buf.readUInt32BE(offset);
        if (!Number.isInteger(length) || length <= 0 || length > JOURNAL_RECORD_LIMIT) break;
        const start = offset + JOURNAL_HEADER_BYTES;
        const end = start + length;
        if (end > buf.length) break;
        const body = buf.subarray(start, end);
        if (!journalChecksum(body).equals(buf.subarray(offset + 4, offset + JOURNAL_HEADER_BYTES))) break;
        let journal;
        try { journal = JSON.parse(body.toString("utf8")); }
        catch { break; }
        try { assertJournalShape(journal); }
        catch { break; }
        last = journal;
        offset = end;
    }
    if (!last) throw new Error("Invalid dependency rollback journal.");
    return last;
}

/**
 * Remove a crashed copy's created files and directories, then the journal.
 * A filesSynced journal keeps those copies and removes only itself. Missing pieces are already gone.
 * A path that leaves the destination is refused before any delete.
 */
async function rollbackDependencyJournal(destinationRoot) {
    const journalFile = journalPath(destinationRoot);
    await atomic.reapStaleAtomicTemps(journalFile);
    let raw;
    try { raw = await fs.promises.readFile(journalFile); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    const journal = readDependencyJournal(raw);
    for (const relative of journal.files) assertJournalRelative(relative);
    for (const relative of journal.directories) assertJournalRelative(relative);
    // The flag is written only after payload file sync() returned. Deleting those copies would
    // turn a journal that came back after the name was removed into data loss. Absence of the
    // flag is still an in-progress copy. The flag does not prove the directory entry stuck.
    if (journal.filesSynced !== true) {
        for (const relative of [...journal.files].reverse()) {
            const parent = path.dirname(path.join(destinationRoot, relative));
            if (!fs.existsSync(parent)) continue;
            const target = resolveConfined(destinationRoot, destinationRoot, relative, "a rolled-back dependency");
            await fs.promises.unlink(target).catch(error => { if (error.code !== "ENOENT") throw error; });
        }
        for (const relative of [...journal.directories].reverse()) {
            const parent = path.dirname(path.join(destinationRoot, relative));
            if (!fs.existsSync(parent)) continue;
            const target = resolveConfined(destinationRoot, destinationRoot, relative, "a rolled-back directory");
            await fs.promises.rmdir(target).catch(error => {
                if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
            });
        }
    }
    await fs.promises.unlink(journalFile);
    // The names are gone from this process. A refused directory flush is not a power-loss checkpoint.
    await atomic.syncDirectory(destinationRoot);
    return true;
}

/** Flush bytes we created, then their directory entries, before the journal may be removed. */
async function flushCreatedDependencies(destinationRoot, journal) {
    for (const relative of journal.files) {
        const target = resolveConfined(destinationRoot, destinationRoot, relative, "a destination dependency");
        await atomic.syncFile(target);
    }
    const directories = new Set([destinationRoot]);
    for (const relative of journal.directories) {
        directories.add(resolveConfined(destinationRoot, destinationRoot, relative, "a destination directory"));
    }
    for (const relative of journal.files) {
        directories.add(path.dirname(resolveConfined(destinationRoot, destinationRoot, relative, "a destination dependency")));
    }
    const ordered = [...directories].sort((left, right) => right.length - left.length);
    for (const directory of ordered) await atomic.syncDirectory(directory);
}

/** Discover all dependencies before creating destination directories or files. */
async function copyProjectDependencies(sourceProject, destinationProject, content) {
    const sourceRoot = path.dirname(sourceProject), destinationRoot = path.dirname(destinationProject);
    if (fs.realpathSync.native(sourceRoot) === fs.realpathSync.native(destinationRoot)) return;
    await rollbackDependencyJournal(destinationRoot);
    // The opened spelling need not match the directory entry's spelling on Windows.
    // Resolve identity without lowercasing source paths: case-sensitive folders can contain both.
    const sourceEntry = resolveConfined(sourceRoot, sourceRoot, path.basename(sourceProject), "the source project");
    const destinationEntry = resolveConfined(destinationRoot, destinationRoot, path.basename(destinationProject), "the destination project");
    const files = new Map();
    const projects = new Set([path.resolve(sourceProject)]);
    let total = 0;
    async function add(base, relative) {
        if (typeof relative !== "string" || path.isAbsolute(relative) || /(^[a-z][a-z0-9+.-]*:|[?#])/i.test(relative)) {
            throw new Error("Only local relative project dependencies can be relocated.");
        }
        const logical = path.resolve(base, relative);
        const within = path.relative(path.resolve(sourceRoot), logical);
        if (within.startsWith(`..${path.sep}`) || within === ".." || path.isAbsolute(within)) throw new Error("Dependency outside the chosen folder.");
        const file = resolveConfined(sourceRoot, base, relative, "a project dependency");
        if (files.has(logical)) return files.get(logical).data;
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Invalid or oversized project dependency.");
        if (total + stat.size > 256 * 1024 * 1024 || files.size >= 4096) throw new Error("Project dependency copy exceeds its bounded batch.");
        const data = await fs.promises.readFile(file);
        total += data.length;
        if (data.length > 64 * 1024 * 1024 || total > 256 * 1024 * 1024) throw new Error("Project dependency changed beyond its bounded batch.");
        files.set(logical, { file, data });
        return data;
    }
    async function visit(project, raw) {
      const base = path.dirname(project), parsed = JSON.parse(raw), doc = parsed?.document;
      if (!doc || typeof doc !== "object") throw new Error("Invalid linked project document.");
      const assets = doc.assets3d ?? [];
      if (!Array.isArray(assets) || assets.length > 4096) throw new Error("Invalid project asset table.");
      // Image fields also occur in animation states, instance overrides and tilesets.
      const pending = [doc.nodes, doc.tilesets];
      while (pending.length) {
          const value = pending.pop();
          if (!value || typeof value !== "object") continue;
          for (const [key, child] of Object.entries(value)) {
              if (key === "userData") continue;
              if (key === "src" && typeof child === "string") {
                  if (/^data:image\//i.test(child)) continue;
                  await add(base, decodeURIComponent(child));
              } else if (child && typeof child === "object") pending.push(child);
          }
      }
      for (const asset of assets) {
        const source = asset?.kind === "material" && typeof asset.source === "string"
            ? asset.source.replace(/#material-\d+$/, "") : asset?.source;
        if (typeof source !== "string" || !/\.(gltf|glb|hdr)$/i.test(source)) {
            throw new Error("Save As cannot relocate this asset source format.");
        }
        const file = path.resolve(base, source);
        const data = await add(base, source);
        let json;
        if (/\.gltf$/i.test(file)) json = JSON.parse(data.toString("utf8"));
        if (/\.glb$/i.test(file)) {
            if (data.length < 20 || data.readUInt32LE(0) !== 0x46546c67 || data.readUInt32LE(4) !== 2
                || data.readUInt32LE(8) !== data.length || data.readUInt32LE(16) !== 0x4e4f534a
                || 20 + data.readUInt32LE(12) > data.length) throw new Error("Invalid GLB dependency container.");
            json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString("utf8").trim());
        }
        if (json) for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
            if (entry.uri === undefined || /^data:/i.test(entry.uri)) continue;
            if (typeof entry.uri !== "string" || /(^[a-z][a-z0-9+.-]*:|^[\\/]|[?#])/i.test(entry.uri)) {
                throw new Error("Only local relative glTF dependencies can be relocated.");
            }
            await add(path.dirname(file), decodeURIComponent(entry.uri));
        }
      }
      let changed = false;
      for (const node of Object.values(doc.nodes ?? {})) {
          const target = node?.entity?.transitionTo;
          if (target === undefined) continue;
          if (typeof target !== "string" || path.isAbsolute(target) || !/\.(vde|json)$/i.test(target)) throw new Error("Invalid relative level target.");
          // Match the runtime's per-level confinement rather than packaging unreachable levels.
          const targetFile = resolveConfined(base, base, target, "a level project");
          const logical = path.resolve(base, target);
          if (targetFile === sourceEntry) {
              if (project === path.resolve(sourceProject)) {
                  if (path.basename(sourceProject) !== path.basename(destinationProject)) {
                      throw new Error("A self-linked entry level must retain its filename during Save As.");
                  }
                  continue;
              }
              const replacement = path.relative(base, path.join(sourceRoot, path.basename(destinationProject))).split(path.sep).join("/");
              if (replacement !== target) { node.entity.transitionTo = replacement; changed = true; }
              continue;
          }
          if (projects.has(logical)) continue;
          if (projects.size >= 32) throw new Error("A portable project is limited to 32 linked levels.");
          projects.add(logical);
          const bytes = await add(base, target);
          if (bytes.length > 20_000_000) throw new Error("The level project is larger than 20 MB.");
          await visit(logical, bytes.toString("utf8"));
      }
      if (changed) files.get(project).data = Buffer.from(JSON.stringify(parsed));
    }
    await visit(path.resolve(sourceProject), content);
    const planned = [];
    const directories = [];
    const seenDirs = new Set();
    const conflictsWithEntry = confined => confined === destinationEntry || (process.platform === "win32"
        && confined.toLowerCase() === destinationEntry.toLowerCase());
    for (const [logical, { data }] of files) {
        const relative = path.relative(path.resolve(sourceRoot), logical);
        if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
            throw new Error("Dependency outside the chosen folder.");
        }
        if (path.basename(relative) === DEPENDENCY_JOURNAL_NAME) throw new Error("A dependency conflicts with the copy journal.");
        const parts = path.dirname(relative).split(path.sep).filter(part => part && part !== ".");
        let parent = destinationRoot;
        let relativeDir = "";
        let missingParent = false;
        for (const part of parts) {
            relativeDir = relativeDir ? path.join(relativeDir, part) : part;
            if (missingParent) {
                if (!seenDirs.has(relativeDir)) { seenDirs.add(relativeDir); directories.push(relativeDir); }
                continue;
            }
            if (!fs.existsSync(path.join(parent, part))) {
                missingParent = true;
                if (!seenDirs.has(relativeDir)) { seenDirs.add(relativeDir); directories.push(relativeDir); }
                continue;
            }
            // Enter an existing directory only after resolving junctions, one level at a time.
            parent = resolveConfined(destinationRoot, parent, part, "a destination directory");
        }
        if (missingParent) {
            planned.push({ data, relative });
            continue;
        }
        const confined = resolveConfined(destinationRoot, destinationRoot, relative, "a destination dependency");
        // Reserve the entry's spelling and Windows case aliases even while the entry is absent.
        // Conservatively refuse ambiguous entry names on Windows case-sensitive folders too.
        if (conflictsWithEntry(confined)) throw new Error("A dependency conflicts with the project filename.");
        try {
            if (!(await fs.promises.readFile(confined)).equals(data)) throw new Error(`Dependency conflict: ${relative}. Choose an empty project folder.`);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            planned.push({ data, relative });
        }
    }
    if (directories.length === 0 && planned.length === 0) return;
    const journal = { version: 1, directories: [...directories], files: planned.map(item => item.relative) };
    let journalPublished = false;
    const persistJournal = async () => {
        const file = journalPath(destinationRoot);
        if (!journalPublished) {
            // The first record publishes the journal name. Later records append into that file
            // and flush those bytes, so a crash before a later directory flush cannot restore
            // an older record once this append's file sync has returned.
            await atomic.atomicWrite(file, encodeJournalLog(journal));
            journalPublished = true;
            return;
        }
        await atomic.appendFileSynced(file, encodeJournalRecord(journal));
    };
    try {
        await persistJournal();
        for (const relative of [...directories]) {
            const parentRelative = path.dirname(relative);
            const parent = parentRelative === "."
                ? destinationRoot
                : resolveConfined(destinationRoot, destinationRoot, parentRelative, "a destination directory");
            const next = resolveConfined(destinationRoot, parent, path.basename(relative), "a destination directory");
            try { await fs.promises.mkdir(next); }
            catch (error) {
                if (error.code !== "EEXIST") throw error;
                // A directory that already existed is not ours to remove if a later step fails.
                journal.directories = journal.directories.filter(entry => entry !== relative);
                await persistJournal();
            }
        }
        for (const item of planned) {
            const confined = resolveConfined(destinationRoot, destinationRoot, item.relative, "a destination dependency");
            if (conflictsWithEntry(confined)) throw new Error("A dependency conflicts with the project filename.");
            // Write the bytes actually validated, not a source that may have changed since discovery.
            try {
                await fs.promises.writeFile(confined, item.data, { flag: "wx" });
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
                // Two logical spellings may name one destination file. Keep both placements for
                // case-sensitive filesystems/junction aliases; let exclusive creation detect aliases.
                // The existing file is not ours, so a later failure must not delete it.
                journal.files = journal.files.filter(entry => entry !== item.relative);
                await persistJournal();
                const existing = resolveConfined(destinationRoot, destinationRoot, item.relative, "a destination dependency");
                if (!(await fs.promises.readFile(existing)).equals(item.data)) {
                    throw new Error(`Dependency conflict: ${item.relative}. Choose an empty project folder.`);
                }
            }
        }
        await flushCreatedDependencies(destinationRoot, journal);
        // Append filesSynced only after those file syncs returned. Rollback of a record that
        // still says filesSynced must not delete the copies. The append is file-flushed before
        // the name is removed. A crash before that file sync returns can still show the previous
        // record. A later directory flush is not what publishes these bytes.
        journal.filesSynced = true;
        await persistJournal();
        await fs.promises.unlink(journalPath(destinationRoot));
        await atomic.syncDirectory(destinationRoot);
    } catch (error) {
        try { await rollbackDependencyJournal(destinationRoot); }
        catch (rollbackError) {
            error.message += ` Rollback failed: ${rollbackError.message}`;
        }
        throw error;
    }
}
module.exports = {
    copyProjectDependencies,
    rollbackDependencyJournal,
    readDependencyJournal,
    DEPENDENCY_JOURNAL_NAME
};
