/**
 * @module crash-recovery.test
 * @description Kills isolated real writer processes at editing/save and dependency-copy checkpoints, then restores in a fresh process using the production session, atomic writer and dependency copier.
 * The directory-fsync kill is still a process failure, not a power-loss proof. Planting a filesSynced journal after its name was removed is not a power-loss proof either.
 * A crash before the commit marker's directory flush can still drop a new name. Jest covers that model.
 */
const fs = require("fs"), path = require("path"), os = require("os");
const { fork, spawnSync } = require("child_process");
const { atomicWrite } = require("../src/electron/atomicWrite");
const { copyProjectDependencies, readDependencyJournal, DEPENDENCY_JOURNAL_NAME } = require("../src/electron/projectDependencies");

function sessionApi() {
    const Module = require("module"), esbuild = require("esbuild");
    const bundle = esbuild.buildSync({ stdin: { resolveDir: path.join(__dirname, ".."), contents: `
        export { ProjectSession } from './src/app/ProjectSession';
        export { createEmptyDocument } from './src/core/document/Document';
        export { serializeDocument, deserializeDocument } from './src/core/document/Serializer';`
    }, bundle: true, platform: "node", format: "cjs", write: false });
    const loaded = new Module(__filename, module); loaded._compile(bundle.outputFiles[0].text, __filename);
    return loaded.exports;
}

const dependencyContent = JSON.stringify({ document: { assets3d: [{ kind: "mesh", source: "models/shape.gltf" },
    { kind: "material", source: "models/shape.gltf#material-0" }] } });

async function dependencyCheckpoint(mode, dir) {
    const source = path.join(dir, "source"), dest = path.join(dir, "destination");
    const pause = async () => {
        process.send({ ready: true });
        await new Promise(() => { setInterval(() => {}, 1000); });
    };
    if (mode !== "dep-repair") {
        fs.mkdirSync(path.join(source, "models"), { recursive: true });
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(source, "models", "shape.gltf"), JSON.stringify({ asset: { version: "2.0" },
            buffers: [{ uri: "shape.bin" }], images: [{ uri: "../color.png" }] }));
        fs.writeFileSync(path.join(source, "models", "shape.bin"), "owned mesh");
        fs.writeFileSync(path.join(source, "color.png"), "owned texture");
        fs.writeFileSync(path.join(dest, "notes.txt"), "keep");
        const atomic = require("../src/electron/atomicWrite");
        if (mode === "dep-partial") {
            const writeFile = fs.promises.writeFile.bind(fs.promises);
            fs.promises.writeFile = async (file, data, options) => {
                if (path.basename(String(file)) === "color.png") {
                    await writeFile(file, Buffer.from("PARTIAL"), options);
                    await pause();
                }
                return writeFile(file, data, options);
            };
        } else if (mode === "dep-commit-before-dirsync") {
            const realAppend = atomic.appendFileSynced.bind(atomic);
            atomic.appendFileSynced = async (target, data, io) => {
                const result = await realAppend(target, data, io);
                if (String(data).includes('"filesSynced":true')) await pause();
                return result;
            };
        } else if (mode === "dep-commit-dirsynced") {
            const realAppend = atomic.appendFileSynced.bind(atomic);
            const realSync = atomic.syncDirectory.bind(atomic);
            let armed = false;
            atomic.appendFileSynced = async (target, data, io) => {
                const result = await realAppend(target, data, io);
                if (String(data).includes('"filesSynced":true')) armed = true;
                return result;
            };
            atomic.syncDirectory = async (directory, io) => {
                const result = await realSync(directory, io);
                if (armed) await pause();
                return result;
            };
        } else if (mode === "dep-unlinked") {
            const unlink = fs.promises.unlink.bind(fs.promises);
            fs.promises.unlink = async (file, ...args) => {
                const result = await unlink(file, ...args);
                if (path.basename(String(file)) === DEPENDENCY_JOURNAL_NAME) await pause();
                return result;
            };
        }
    }
    await copyProjectDependencies(path.join(source, "project.vde"), path.join(dest, "copy.vde"), dependencyContent);
    if (mode !== "dep-repair") throw new Error("Crash checkpoint was not reached");
}

async function child(mode, dir) {
    if (mode.startsWith("dep-")) return dependencyCheckpoint(mode, dir);
    const { ProjectSession, createEmptyDocument, serializeDocument, deserializeDocument } = sessionApi();
    const project = path.join(dir, "project.vde"), recovery = path.join(dir, "project-recovery.json");
    if (mode === "replace") {
        await atomicWrite(project, "replaced-after-unclean");
        console.log(JSON.stringify({ names: fs.readdirSync(dir).sort(), body: fs.readFileSync(project, "utf8") }));
        return;
    }
    if (mode === "restore") {
        const saved = fs.readFileSync(project, "utf8"), snapshot = JSON.parse(fs.readFileSync(recovery, "utf8"));
        deserializeDocument(saved); deserializeDocument(snapshot.content); deserializeDocument(snapshot.savedContent);
        const session = new ProjectSession({ serialize: () => snapshot.content, path: { current: snapshot.filePath },
            write: async () => true, recover: async () => {}, status: () => {} });
        session.adopt(snapshot.savedContent);
        console.log(JSON.stringify({ saved: deserializeDocument(saved).metadata.project_name,
            savedBytes: saved === snapshot.savedContent ? "before" : saved === snapshot.content ? "after" : "unexpected",
            recovered: deserializeDocument(snapshot.content).metadata.project_name, dirty: session.dirty }));
        return;
    }
    const doc = createEmptyDocument(); doc.metadata.project_name = "last saved";
    let content = serializeDocument(doc);
    await atomicWrite(project, content);
    const pause = async () => {
        process.send({ ready: true });
        await new Promise(() => { setInterval(() => {}, 1000); });
    };
    let renamed = false;
    const io = { ...fs.promises,
        open: async (file, ...args) => {
            const handle = await fs.promises.open(file, ...args);
            const directory = file === dir;
            return { close: () => handle.close(),
                writeFile: async data => {
                    if (!directory && mode === "partial-write") { await handle.writeFile(data.slice(0, 19)); await pause(); }
                    await handle.writeFile(data);
                },
                sync: async () => {
                    await handle.sync();
                    if (!directory && mode === "flushed" && !renamed) await pause();
                    if (directory && mode === "directory-synced" && renamed) await pause();
                }
            };
        },
        rename: async (...args) => {
            if (mode === "before-rename") await pause();
            await fs.promises.rename(...args);
            renamed = true;
            if (mode === "after-rename") await pause();
        }
    };
    const session = new ProjectSession({ serialize: () => content, path: { current: project },
        write: async (file, bytes) => { await atomicWrite(file, bytes, io); return true; },
        recover: snapshot => atomicWrite(recovery, JSON.stringify(snapshot)), status: () => {} });
    doc.metadata.project_name = "recoverable edit"; content = serializeDocument(doc);
    await session.checkpoint();
    if (mode === "editing") await pause();
    await session.save(project);
    throw new Error("Crash checkpoint was not reached");
}

if (process.argv[2] === "--child") {
    child(process.argv[3], process.argv[4]).catch(error => { console.error(error); process.exitCode = 1; });
} else {
    const test = require("node:test"), assert = require("node:assert/strict");
    async function killAt(phase) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-crash-"));
        const worker = fork(__filename, ["--child", phase, dir], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
        let stderr = ""; worker.stderr.on("data", chunk => { stderr += chunk; });
        const exited = new Promise(resolve => worker.once("exit", resolve));
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Crash checkpoint timed out: " + stderr)), 10000);
                worker.once("message", message => { clearTimeout(timer); message.ready ? resolve() : reject(new Error("Unexpected checkpoint")); });
                worker.once("error", error => { clearTimeout(timer); reject(error); });
                worker.once("exit", () => { clearTimeout(timer); reject(new Error("Writer exited before kill: " + stderr)); });
            });
            assert.equal(worker.kill("SIGKILL"), true); await exited;
            return dir;
        } catch (error) {
            if (worker.exitCode === null && worker.signalCode === null) { worker.kill("SIGKILL"); await exited; }
            fs.rmSync(dir, { recursive: true, force: true });
            throw error;
        }
    }
    const renamed = new Set(["after-rename", "directory-synced"]);
    for (const phase of ["editing", "partial-write", "flushed", "before-rename", "after-rename", "directory-synced"]) {
        test(`forced process exit: ${phase}`, { timeout: 20000 }, async () => {
            const dir = await killAt(phase);
            try {
                const restored = spawnSync(process.execPath, [__filename, "--child", "restore", dir], { encoding: "utf8", timeout: 10000, windowsHide: true });
                assert.equal(restored.status, 0, restored.stderr);
                assert.deepEqual(JSON.parse(restored.stdout), { saved: renamed.has(phase) ? "recoverable edit" : "last saved",
                    savedBytes: renamed.has(phase) ? "after" : "before",
                    recovered: "recoverable edit", dirty: true });
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    }
    for (const phase of ["dep-partial", "dep-commit-before-dirsync", "dep-commit-dirsynced", "dep-unlinked"]) {
        test(`forced process exit: ${phase}`, { timeout: 20000 }, async () => {
            const dir = await killAt(phase);
            const dest = path.join(dir, "destination");
            const journal = path.join(dest, DEPENDENCY_JOURNAL_NAME);
            try {
                if (phase === "dep-partial") {
                    const parsed = readDependencyJournal(fs.readFileSync(journal));
                    assert.notEqual(parsed.filesSynced, true);
                    assert.equal(fs.readFileSync(path.join(dest, "color.png"), "utf8"), "PARTIAL");
                } else if (phase === "dep-unlinked" || phase === "dep-commit-dirsynced") {
                    assert.equal(fs.existsSync(journal), false);
                    assert.equal(fs.readFileSync(path.join(dest, "color.png"), "utf8"), "owned texture");
                    if (phase === "dep-unlinked") {
                        // The name is gone in this process. Putting the flushed record back simulates a
                        // directory entry that returned; it does not unplug the disk.
                        fs.writeFileSync(journal, JSON.stringify({
                            version: 1, directories: ["models"],
                            files: ["models/shape.gltf", "models/shape.bin", "color.png"], filesSynced: true
                        }));
                    }
                } else {
                    const parsed = readDependencyJournal(fs.readFileSync(journal));
                    assert.equal(parsed.filesSynced, true);
                    assert.equal(fs.readFileSync(path.join(dest, "color.png"), "utf8"), "owned texture");
                    assert.equal(fs.readFileSync(path.join(dest, "models", "shape.bin"), "utf8"), "owned mesh");
                }
                assert.equal(fs.readFileSync(path.join(dest, "notes.txt"), "utf8"), "keep");
                const repaired = spawnSync(process.execPath, [__filename, "--child", "dep-repair", dir], { encoding: "utf8", timeout: 10000, windowsHide: true });
                assert.equal(repaired.status, 0, repaired.stderr);
                assert.equal(fs.readFileSync(path.join(dest, "notes.txt"), "utf8"), "keep");
                assert.equal(fs.readFileSync(path.join(dest, "color.png"), "utf8"), "owned texture");
                assert.equal(fs.readFileSync(path.join(dest, "models", "shape.bin"), "utf8"), "owned mesh");
                assert.equal(fs.readFileSync(path.join(dest, "models", "shape.gltf"), "utf8").includes('"shape.bin"'), true);
                assert.equal(fs.existsSync(journal), false);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    }
    test("unclean shutdown temp is removed by the next replacement", { timeout: 20000 }, async () => {
        const dir = await killAt("partial-write");
        try {
            const replaced = spawnSync(process.execPath, [__filename, "--child", "replace", dir], { encoding: "utf8", timeout: 10000, windowsHide: true });
            assert.equal(replaced.status, 0, replaced.stderr);
            assert.deepEqual(JSON.parse(replaced.stdout), {
                names: ["project-recovery.json", "project.vde"],
                body: "replaced-after-unclean"
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}
