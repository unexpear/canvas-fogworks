/**
 * @module projectDependencies.test
 * @description Exercises relocated glTF sidecars, ignored-pack exclusion, conflicts and confinement using owned temporary fixtures.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, promises } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { basename, join } from "path";
const { copyProjectDependencies, rollbackDependencyJournal, readDependencyJournal, DEPENDENCY_JOURNAL_NAME } = require("./projectDependencies");

let dir: string, source: string, dest: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fogworks-portable-"));
    source = join(dir, "source"); dest = join(dir, "destination");
    mkdirSync(source); mkdirSync(dest); mkdirSync(join(source, "models"));
    writeFileSync(join(source, "models", "shape.gltf"), JSON.stringify({ asset: { version: "2.0" },
        buffers: [{ uri: "shape.bin" }], images: [{ uri: "../color.png" }] }));
    writeFileSync(join(source, "models", "shape.bin"), "owned mesh");
    writeFileSync(join(source, "color.png"), "owned texture");
    writeFileSync(join(source, "unreferenced.png"), "do not copy");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const content = () => JSON.stringify({ document: { assets3d: [{ kind: "mesh", source: "models/shape.gltf" },
    { kind: "material", source: "models/shape.gltf#material-0" }] } });
const copy = () => copyProjectDependencies(join(source, "project.vde"), join(dest, "copy.vde"), content());
const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest("case-aliased return links target the renamed live entry, never an old disk copy", async () => {
    const saved = JSON.stringify({ document: { marker: "old disk version", nodes: {} } });
    writeFileSync(join(source, "entry.vde"), saved);
    const second = JSON.stringify({ document: { nodes: { gate: { entity: { transitionTo: "ENTRY.vde" } } } } });
    writeFileSync(join(source, "second.vde"), second);
    const live = JSON.stringify({ document: { marker: "current unsaved version", nodes: {
        gate: { entity: { transitionTo: "second.vde" } } } } });
    // The opened path can itself have a different spelling from the on-disk entry.
    for (const entryName of ["entry.vde", "ENTRY.vde"]) {
        await copyProjectDependencies(join(source, entryName), join(dest, "renamed.vde"), live);
        expect(JSON.parse(readFileSync(join(dest, "second.vde"), "utf8")).document.nodes.gate.entity.transitionTo).toBe("renamed.vde");
        expect(readdirSync(dest)).toEqual(["second.vde"]);
    }
    expect(readFileSync(join(source, "entry.vde"), "utf8")).toBe(saved);
    expect(readFileSync(join(source, "second.vde"), "utf8")).toBe(second);
});

windowsTest("case aliases shared by images and glTF sidecars copy successfully and repeat safely", async () => {
    const raw = JSON.stringify({ document: { ...JSON.parse(content()).document,
        nodes: { image: { src: "COLOR.png" } } } });
    await copyProjectDependencies(join(source, "entry.vde"), join(dest, "copy.vde"), raw);
    await copyProjectDependencies(join(source, "entry.vde"), join(dest, "copy.vde"), raw);
    expect(readFileSync(join(dest, "COLOR.png"), "utf8")).toBe("owned texture");
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
    expect(readdirSync(dest).filter(name => name.toLowerCase() === "color.png")).toHaveLength(1);
});

windowsTest("a differently cased existing asset conflict is refused before any files are copied", async () => {
    writeFileSync(join(dest, "COLOR.png"), "keep existing");
    await expect(copy()).rejects.toThrow("Dependency conflict");
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("keep existing");
    expect(existsSync(join(dest, "models"))).toBe(false);
});

windowsTest("a dependency cannot occupy a differently cased destination entry filename", async () => {
    writeFileSync(join(source, "second.vde"), JSON.stringify({ document: { nodes: {} } }));
    const raw = JSON.stringify({ document: { nodes: { gate: { entity: { transitionTo: "second.vde" } } } } });
    await expect(copyProjectDependencies(join(source, "entry.vde"), join(dest, "SECOND.vde"), raw)).rejects.toThrow(/conflicts with the project filename/);
    expect(readdirSync(dest)).toEqual([]);
});

test("distinct logical paths through an internal directory junction remain portable", async () => {
    symlinkSync(join(source, "models"), join(source, "model-alias"), "junction");
    const raw = JSON.stringify({ document: { assets3d: [{ kind: "mesh", source: "models/shape.gltf" },
        { kind: "mesh", source: "model-alias/shape.gltf" }] } });
    await copyProjectDependencies(join(source, "entry.vde"), join(dest, "copy.vde"), raw);
    expect(readFileSync(join(dest, "models", "shape.bin"), "utf8")).toBe("owned mesh");
    expect(readFileSync(join(dest, "model-alias", "shape.bin"), "utf8")).toBe("owned mesh");
});

test("a conflicting file appearing after preflight is never overwritten or accepted", async () => {
    const raw = JSON.stringify({ document: { nodes: { image: { src: "color.png" } } } });
    const write = promises.writeFile.bind(promises);
    const spy = jest.spyOn(promises, "writeFile").mockImplementationOnce(async (file, data, options) => {
        writeFileSync(file as string, "concurrent file", { flag: "wx" });
        return write(file, data, options);
    });
    try {
        await expect(copyProjectDependencies(join(source, "entry.vde"), join(dest, "copy.vde"), raw)).rejects.toThrow("Dependency conflict");
        expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("concurrent file");
    } finally { spy.mockRestore(); }
});

test("copies only referenced sources, buffers and textures; repeat saves accept identical files", async () => {
    await copy(); await copy();
    expect(readFileSync(join(dest, "models", "shape.bin"), "utf8")).toBe("owned mesh");
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
    expect(existsSync(join(dest, "unreferenced.png"))).toBe(false);
    expect(readFileSync(join(source, "color.png"), "utf8")).toBe("owned texture");
});
test("conflicts do not overwrite destination assets", async () => {
    writeFileSync(join(dest, "color.png"), "keep existing");
    await expect(copy()).rejects.toThrow("Dependency conflict");
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("keep existing");
    expect(existsSync(join(dest, "models"))).toBe(false);
    expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
});
test("missing dependencies are detected before copying files", async () => {
    rmSync(join(source, "color.png"));
    await expect(copy()).rejects.toThrow();
    expect(existsSync(join(dest, "models"))).toBe(false);
});
test("source traversal and destination junction escape are refused", async () => {
    const outside = join(dir, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(dest, "models"), "junction");
    await expect(copy()).rejects.toThrow("outside");
    writeFileSync(join(source, "models", "shape.gltf"), JSON.stringify({ buffers: [{ uri: "../../outside/secret.bin" }] }));
    writeFileSync(join(outside, "secret.bin"), "private");
    await expect(copy()).rejects.toThrow("outside");
});

test("copies a cyclic level graph and rewrites return links to the renamed entry", async () => {
    const level = { document: { nodes: { gate: { entity: { transitionTo: "project.vde" } },
        image: { src: "color.png" } }, assets3d: [{ kind: "mesh", source: "models/shape.gltf" }] } };
    writeFileSync(join(source, "second.vde"), JSON.stringify(level));
    const entry = JSON.stringify({ document: { nodes: { gate: { entity: { transitionTo: "second.vde" } } } } });
    await copyProjectDependencies(join(source, "project.vde"), join(dest, "copy.vde"), entry);
    const relocated = JSON.parse(readFileSync(join(dest, "second.vde"), "utf8"));
    expect(relocated.document.nodes.gate.entity.transitionTo).toBe("copy.vde");
    expect(JSON.parse(readFileSync(join(source, "second.vde"), "utf8"))).toEqual(level);
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
    expect(existsSync(join(dest, "models", "shape.bin"))).toBe(true);
    expect(existsSync(join(dest, "unreferenced.png"))).toBe(false);
});

test("missing linked assets, external images, and renamed self-links fail without copied files", async () => {
    for (const nodes of [{ image: { src: "missing.png" } }, { image: { src: "https://example.test/image.png" } },
        { gate: { entity: { transitionTo: "project.vde" } } }]) {
        await expect(copyProjectDependencies(join(source, "project.vde"), join(dest, "copy.vde"),
            JSON.stringify({ document: { nodes } }))).rejects.toThrow();
        expect(existsSync(join(dest, "models"))).toBe(false);
    }
});

test("image embedding covers overrides and tilesets, skips user data, and confines reads", async () => {
    const { embedProjectImages } = require("./projectImages");
    const raw = JSON.stringify({ document: { nodes: { image: { src: "color.png", overrides: { child: { src: "color.png" } },
        userData: { src: "private.txt" } } }, tilesets: [{ src: "color.png" }] } });
    const embedded = JSON.parse(await embedProjectImages(join(source, "project.vde"), raw));
    expect(embedded.document.nodes.image.src).toBe("data:image/png;base64," + Buffer.from("owned texture").toString("base64"));
    expect(embedded.document.nodes.image.overrides.child.src).toBe(embedded.document.tilesets[0].src);
    expect(embedded.document.nodes.image.userData.src).toBe("private.txt");
    await expect(embedProjectImages(join(source, "project.vde"), JSON.stringify({ document: {
        nodes: { bad: { src: "../outside.png" } } } }))).rejects.toThrow(/outside/);
});

test("self-links with a relative dot retain their meaning when the entry filename is preserved", async () => {
    await expect(copyProjectDependencies(join(source, "project.vde"), join(dest, "project.vde"),
        JSON.stringify({ document: { nodes: { gate: { entity: { transitionTo: "./project.vde" } } } } }))).resolves.toBeUndefined();
});

test("a failed dependency write rolls back created files and directories", async () => {
    writeFileSync(join(dest, "notes.txt"), "keep");
    const write = promises.writeFile.bind(promises);
    const spy = jest.spyOn(promises, "writeFile").mockImplementation(async (file, data, options) => {
        if (String(file).endsWith(`${join("models", "shape.bin")}`)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return write(file, data, options);
    });
    try {
        await expect(copy()).rejects.toThrow("disk full");
        expect(existsSync(join(dest, "models"))).toBe(false);
        expect(existsSync(join(dest, "color.png"))).toBe(false);
        expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
        expect(readFileSync(join(dest, "notes.txt"), "utf8")).toBe("keep");
        expect(readFileSync(join(source, "color.png"), "utf8")).toBe("owned texture");
    } finally { spy.mockRestore(); }
});

test("a crashed copy's journal is removed on the next relocation without deleting unrelated files", async () => {
    writeFileSync(join(dest, "notes.txt"), "keep");
    mkdirSync(join(dest, "models"));
    writeFileSync(join(dest, "models", "shape.gltf"), "partial");
    writeFileSync(join(dest, "color.png"), "partial texture");
    writeFileSync(join(dest, DEPENDENCY_JOURNAL_NAME), JSON.stringify({
        version: 1, directories: ["models"], files: ["models/shape.gltf", "color.png"]
    }));
    await copy();
    expect(readFileSync(join(dest, "notes.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(dest, "models", "shape.bin"), "utf8")).toBe("owned mesh");
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
    expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
});

test("a rollback journal cannot delete outside the destination", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "safe");
    writeFileSync(join(dest, DEPENDENCY_JOURNAL_NAME), JSON.stringify({
        version: 1, directories: [], files: ["../outside/secret"]
    }));
    await expect(rollbackDependencyJournal(dest)).rejects.toThrow(/journal/);
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("safe");
    expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(true);
    await expect(copy()).rejects.toThrow(/journal/);
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("safe");
    expect(existsSync(join(dest, "models"))).toBe(false);
});

function deadPid(): number {
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    if (!exited.pid) throw new Error("Could not obtain an exited process id.");
    return exited.pid;
}

test("an unclean journal temp is removed and a live writer's temp is kept", async () => {
    writeFileSync(join(dest, "notes.txt"), "keep");
    const exited = deadPid();
    const stale = `.${DEPENDENCY_JOURNAL_NAME}.${exited}.10.0.tmp`;
    const linked = `.${DEPENDENCY_JOURNAL_NAME}.${deadPid()}.12.0.tmp`;
    const live = `.${DEPENDENCY_JOURNAL_NAME}.1.11.0.tmp`;
    writeFileSync(join(dest, stale), "partial journal");
    writeFileSync(join(dest, live), "live writer");
    const outside = join(dir, "secret");
    writeFileSync(outside, "safe");
    symlinkSync(outside, join(dest, linked));
    await copy();
    expect(readFileSync(join(dest, "notes.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(dest, live), "utf8")).toBe("live writer");
    expect(readFileSync(outside, "utf8")).toBe("safe");
    expect(existsSync(join(dest, stale))).toBe(false);
    expect(existsSync(join(dest, linked))).toBe(false);
    expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
});

test("created dependency bytes are flushed before the journal is removed", async () => {
    const atomic = require("./atomicWrite");
    const events: string[] = [];
    const realSyncFile = atomic.syncFile.bind(atomic);
    const realSyncDirectory = atomic.syncDirectory.bind(atomic);
    const realUnlink = promises.unlink.bind(promises);
    const fileSpy = jest.spyOn(atomic, "syncFile").mockImplementation(async (file: unknown) => {
        events.push(`sync:${basename(String(file))}`);
        return realSyncFile(file);
    });
    const dirSpy = jest.spyOn(atomic, "syncDirectory").mockImplementation(async (directory: unknown) => {
        events.push(`syncdir:${basename(String(directory))}`);
        return realSyncDirectory(directory);
    });
    const unlinkSpy = jest.spyOn(promises, "unlink").mockImplementation(async (file) => {
        events.push(`unlink:${basename(String(file))}`);
        return realUnlink(file);
    });
    try {
        await copy();
        const unlinkAt = events.indexOf(`unlink:${DEPENDENCY_JOURNAL_NAME}`);
        expect(unlinkAt).toBeGreaterThan(-1);
        for (const name of ["shape.gltf", "shape.bin", "color.png"]) {
            const synced = events.indexOf(`sync:${name}`);
            expect(synced).toBeGreaterThanOrEqual(0);
            expect(synced).toBeLessThan(unlinkAt);
        }
        expect(events.slice(0, unlinkAt).some(event => event.startsWith("syncdir:"))).toBe(true);
        expect(events.slice(unlinkAt + 1).some(event => event.startsWith("syncdir:"))).toBe(true);
        expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
    } finally {
        fileSpy.mockRestore();
        dirSpy.mockRestore();
        unlinkSpy.mockRestore();
    }
});

test("a failed payload flush rolls the created files back", async () => {
    writeFileSync(join(dest, "notes.txt"), "keep");
    const atomic = require("./atomicWrite");
    const realSyncFile = atomic.syncFile.bind(atomic);
    const spy = jest.spyOn(atomic, "syncFile").mockImplementation(async (file: unknown) => {
        if (String(file).endsWith(join("models", "shape.bin"))) throw Object.assign(new Error("flush failed"), { code: "EIO" });
        return realSyncFile(file);
    });
    try {
        await expect(copy()).rejects.toThrow("flush failed");
        expect(existsSync(join(dest, "models"))).toBe(false);
        expect(existsSync(join(dest, "color.png"))).toBe(false);
        expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
        expect(readFileSync(join(dest, "notes.txt"), "utf8")).toBe("keep");
    } finally { spy.mockRestore(); }
});

test("a filesSynced journal keeps the copied files and removes only itself", async () => {
    writeFileSync(join(dest, "notes.txt"), "keep");
    mkdirSync(join(dest, "models"));
    writeFileSync(join(dest, "models", "shape.bin"), "owned mesh");
    writeFileSync(join(dest, "color.png"), "owned texture");
    writeFileSync(join(dest, DEPENDENCY_JOURNAL_NAME), JSON.stringify({
        version: 1, directories: ["models"], files: ["models/shape.bin", "color.png"], filesSynced: true
    }));
    expect(await rollbackDependencyJournal(dest)).toBe(true);
    expect(readFileSync(join(dest, "notes.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(dest, "models", "shape.bin"), "utf8")).toBe("owned mesh");
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
    expect(existsSync(join(dest, "models"))).toBe(true);
    expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
});

test("a filesSynced journal still cannot name a path outside the destination", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "safe");
    writeFileSync(join(dest, "color.png"), "owned texture");
    writeFileSync(join(dest, DEPENDENCY_JOURNAL_NAME), JSON.stringify({
        version: 1, directories: [], files: ["../outside/secret"], filesSynced: true
    }));
    await expect(rollbackDependencyJournal(dest)).rejects.toThrow(/journal/);
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("safe");
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
    expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(true);
});

test("a journal with an invalid filesSynced flag is refused before any delete", async () => {
    writeFileSync(join(dest, "color.png"), "keep");
    writeFileSync(join(dest, DEPENDENCY_JOURNAL_NAME), JSON.stringify({
        version: 1, directories: [], files: ["color.png"], filesSynced: false
    }));
    await expect(rollbackDependencyJournal(dest)).rejects.toThrow(/journal/);
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("keep");
    expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(true);
});

test("payload file flushes finish before the filesSynced record is appended", async () => {
    const atomic = require("./atomicWrite");
    const events: string[] = [];
    const realSyncFile = atomic.syncFile.bind(atomic);
    const realAtomicWrite = atomic.atomicWrite.bind(atomic);
    const realAppend = atomic.appendFileSynced.bind(atomic);
    const realUnlink = promises.unlink.bind(promises);
    const fileSpy = jest.spyOn(atomic, "syncFile").mockImplementation(async (file: unknown) => {
        events.push(`sync:${basename(String(file))}`);
        return realSyncFile(file);
    });
    const writeSpy = jest.spyOn(atomic, "atomicWrite").mockImplementation(async (target: unknown, data: unknown, io: unknown) => {
        events.push(String(data).includes('"filesSynced":true') ? "journal:filesSynced" : "journal:progress");
        return realAtomicWrite(target, data, io);
    });
    const appendSpy = jest.spyOn(atomic, "appendFileSynced").mockImplementation(async (target: unknown, data: unknown, io: unknown) => {
        events.push(String(data).includes('"filesSynced":true') ? "journal:filesSynced" : "journal:append");
        return realAppend(target, data, io);
    });
    const unlinkSpy = jest.spyOn(promises, "unlink").mockImplementation(async (file) => {
        if (basename(String(file)) === DEPENDENCY_JOURNAL_NAME) events.push("unlink:journal");
        return realUnlink(file);
    });
    try {
        await copy();
        const progress = events.indexOf("journal:progress");
        const synced = events.indexOf("journal:filesSynced");
        const unlinkAt = events.indexOf("unlink:journal");
        expect(progress).toBeGreaterThanOrEqual(0);
        expect(synced).toBeGreaterThan(progress);
        expect(events.filter(event => event === "journal:filesSynced")).toEqual(["journal:filesSynced"]);
        expect(unlinkAt).toBeGreaterThan(synced);
        for (const name of ["shape.gltf", "shape.bin", "color.png"]) {
            const at = events.indexOf(`sync:${name}`);
            expect(at).toBeGreaterThanOrEqual(0);
            expect(at).toBeLessThan(synced);
        }
        expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
        expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
    } finally {
        fileSpy.mockRestore();
        writeSpy.mockRestore();
        appendSpy.mockRestore();
        unlinkSpy.mockRestore();
    }
});

test("a failure after the filesSynced record is on disk does not delete the copied files", async () => {
    writeFileSync(join(dest, "notes.txt"), "keep");
    const atomic = require("./atomicWrite");
    const real = atomic.appendFileSynced.bind(atomic);
    const spy = jest.spyOn(atomic, "appendFileSynced").mockImplementation(async (target: unknown, data: unknown, io: unknown) => {
        const result = await real(target, data, io);
        if (String(data).includes('"filesSynced":true')) throw new Error("commit checkpoint failed");
        return result;
    });
    try {
        await expect(copy()).rejects.toThrow("commit checkpoint failed");
        expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
        expect(readFileSync(join(dest, "models", "shape.bin"), "utf8")).toBe("owned mesh");
        expect(readFileSync(join(dest, "notes.txt"), "utf8")).toBe("keep");
        expect(existsSync(join(dest, "models"))).toBe(true);
        expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
    } finally { spy.mockRestore(); }
});

test("discarding the journal unlink before directory flush returns keeps the filesSynced record", async () => {
    writeFileSync(join(dest, "notes.txt"), "keep");
    const atomic = require("./atomicWrite");
    const realAppend = atomic.appendFileSynced.bind(atomic);
    const realSyncDirectory = atomic.syncDirectory.bind(atomic);
    let filesSyncedBytes: Buffer | null = null;
    let injected = false;
    const appendSpy = jest.spyOn(atomic, "appendFileSynced").mockImplementation(async (file: unknown, data: unknown, io: unknown) => {
        const result = await realAppend(file, data, io);
        if (String(data).includes('"filesSynced":true')) filesSyncedBytes = readFileSync(String(file));
        return result;
    });
    const dirSpy = jest.spyOn(atomic, "syncDirectory").mockImplementation(async (directory: unknown, io: unknown) => {
        const journal = join(dest, DEPENDENCY_JOURNAL_NAME);
        if (!injected && filesSyncedBytes && !existsSync(journal)) {
            injected = true;
            writeFileSync(journal, filesSyncedBytes);
            expect(readDependencyJournal(readFileSync(journal)).filesSynced).toBe(true);
            throw new Error("crash before directory fsync returns");
        }
        return realSyncDirectory(directory, io);
    });
    try {
        await expect(copy()).rejects.toThrow(/directory fsync returns/);
        expect(injected).toBe(true);
        expect(readFileSync(join(dest, "notes.txt"), "utf8")).toBe("keep");
        expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
        expect(readFileSync(join(dest, "models", "shape.bin"), "utf8")).toBe("owned mesh");
        expect(existsSync(journalPathSafe())).toBe(false);
    } finally {
        appendSpy.mockRestore();
        dirSpy.mockRestore();
    }
});

function journalPathSafe(): string {
    return join(dest, DEPENDENCY_JOURNAL_NAME);
}

test("a crash before the filesSynced file flush still shows the in-progress record", async () => {
    writeFileSync(join(dest, "notes.txt"), "keep");
    const atomic = require("./atomicWrite");
    const realAppend = atomic.appendFileSynced.bind(atomic);
    const spy = jest.spyOn(atomic, "appendFileSynced").mockImplementation(async (file: unknown, data: unknown, io: unknown) => {
        if (String(data).includes('"filesSynced":true')) {
            const torn = Buffer.from(data as Buffer).subarray(0, 16);
            const handle = await promises.open(String(file), "r+");
            try {
                const size = (await handle.stat()).size;
                await handle.write(torn, 0, torn.length, size);
            } finally {
                await handle.close();
            }
            throw new Error("crash before file sync returns");
        }
        return realAppend(file, data, io);
    });
    try {
        await expect(copy()).rejects.toThrow(/file sync returns/);
        expect(readFileSync(join(dest, "notes.txt"), "utf8")).toBe("keep");
        expect(existsSync(join(dest, "color.png"))).toBe(false);
        expect(existsSync(join(dest, "models"))).toBe(false);
        expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
    } finally { spy.mockRestore(); }
});

test("a refused directory flush still finishes the copy without claiming that checkpoint", async () => {
    const atomic = require("./atomicWrite");
    const spy = jest.spyOn(atomic, "syncDirectory").mockResolvedValue(false);
    try {
        await copy();
        expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
        expect(existsSync(join(dest, DEPENDENCY_JOURNAL_NAME))).toBe(false);
    } finally { spy.mockRestore(); }
});

test("the 32-level cap stops graph discovery before writing destination files", async () => {
    for (let i = 1; i <= 32; i++) writeFileSync(join(source, `level-${i}.vde`), JSON.stringify({ document: {
        nodes: i < 32 ? { gate: { entity: { transitionTo: `level-${i + 1}.vde` } } } : {} } }));
    await expect(copyProjectDependencies(join(source, "project.vde"), join(dest, "copy.vde"),
        JSON.stringify({ document: { nodes: { gate: { entity: { transitionTo: "level-1.vde" } } } } }))).rejects.toThrow(/32 linked levels/);
    expect(existsSync(join(dest, "level-1.vde"))).toBe(false);
});
