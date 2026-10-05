/**
 * @module progress-crash.test
 * @description Kills the gameplay progress writer at atomic-replace checkpoints and reads the slot in a fresh process.
 * A directory-fsync kill is still a process failure, not a power-loss proof or an Electron renderer crash.
 */
const fs = require("fs"), path = require("path"), os = require("os");
const { fork, spawnSync } = require("child_process");
const hash = "a".repeat(64);

function progress(x) {
    return JSON.stringify({ format: "canvas-fogworks-progress", version: 1, profile: "2d", gameId: hash, level: "level0",
        playerId: "player", position: { x, y: 0, z: 0 }, spawns: [], despawned: [], tallies: [], power: 0, cells: [] });
}

function parser() {
    const Module = require("module"), esbuild = require("esbuild");
    const bundle = esbuild.buildSync({ stdin: { resolveDir: path.join(__dirname, ".."), contents: `
        export { parseProgress } from "./src/runtime/PlayerProgress";` }, bundle: true, platform: "node", format: "cjs", write: false });
    const loaded = new Module(__filename, module); loaded._compile(bundle.outputFiles[0].text, __filename);
    return loaded.exports.parseProgress;
}

async function child(mode, dir) {
    const { createProgressFile } = require("../src/player3d/progressFile");
    if (mode === "read") {
        const text = await createProgressFile(dir, hash).read();
        const saved = parser()(text, hash, "2d");
        console.log(JSON.stringify({ x: saved.position.x, names: fs.readdirSync(dir).sort() }));
        return;
    }
    if (mode === "replace") {
        await createProgressFile(dir, hash).write(progress(2));
        const text = await createProgressFile(dir, hash).read();
        console.log(JSON.stringify({ x: parser()(text, hash, "2d").position.x, names: fs.readdirSync(dir).sort() }));
        return;
    }
    await createProgressFile(dir, hash).write(progress(1));
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
    await createProgressFile(dir, hash, { io }).write(progress(2));
    throw new Error("Crash checkpoint was not reached");
}

if (process.argv[2] === "--child") {
    child(process.argv[3], process.argv[4]).catch(error => { console.error(error); process.exitCode = 1; });
} else {
    const test = require("node:test"), assert = require("node:assert/strict");
    async function killAt(phase) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-progress-crash-"));
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
    for (const phase of ["partial-write", "flushed", "before-rename", "after-rename", "directory-synced"]) {
        test(`gameplay save survives forced process exit: ${phase}`, { timeout: 30000 }, async () => {
            const dir = await killAt(phase);
            try {
                const restored = spawnSync(process.execPath, [__filename, "--child", "read", dir], { encoding: "utf8", timeout: 20000, windowsHide: true });
                assert.equal(restored.status, 0, restored.stderr);
                assert.equal(JSON.parse(restored.stdout).x, renamed.has(phase) ? 2 : 1);
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        });
    }
    test("a fresh progress writer removes a temp left by a killed gameplay save", { timeout: 30000 }, async () => {
        const dir = await killAt("partial-write");
        try {
            const replaced = spawnSync(process.execPath, [__filename, "--child", "replace", dir], { encoding: "utf8", timeout: 20000, windowsHide: true });
            assert.equal(replaced.status, 0, replaced.stderr);
            assert.deepEqual(JSON.parse(replaced.stdout), { x: 2, names: [`${hash}.json`] });
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
}
