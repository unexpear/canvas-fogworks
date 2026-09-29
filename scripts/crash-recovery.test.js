/**
 * @module crash-recovery.test
 * @description Kills isolated real writer processes at editing/save checkpoints and restores in a fresh process using the production session and atomic writer.
 * The directory-fsync kill is still a process failure, not a power-loss proof.
 */
const fs = require("fs"), path = require("path"), os = require("os");
const { fork, spawnSync } = require("child_process");
const { atomicWrite } = require("../src/electron/atomicWrite");

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

async function child(mode, dir) {
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
                    if (!directory && mode === "flushed") await pause();
                    if (directory && mode === "directory-synced") await pause();
                }
            };
        },
        rename: async (...args) => {
            if (mode === "before-rename") await pause();
            await fs.promises.rename(...args);
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
