/**
 * @module smoke-crash-relaunch
 * @description Kills the real Electron editor after a recovery checkpoint, then relaunches it to restore and to discard.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const electron = require("electron");
const mainJs = path.join(ROOT, "dist", "electron", "main.js");

if (!fs.existsSync(electron)) {
    console.error(`Crash relaunch smoke could not find Electron: ${electron}`);
    process.exit(2);
}
if (!fs.existsSync(mainJs)) {
    console.error(`Built Electron main process does not exist: ${mainJs}; run npm run build first.`);
    process.exit(2);
}

function projectFixture() {
    const esbuild = require("esbuild");
    const bundle = esbuild.buildSync({
        stdin: {
            resolveDir: ROOT,
            contents: `
                export { createEmptyDocument } from "./src/core/document/Document";
                export { serializeDocument } from "./src/core/document/Serializer";`
        },
        bundle: true, platform: "node", format: "cjs", write: false
    });
    const loaded = new Module(__filename, module);
    loaded._compile(bundle.outputFiles[0].text, __filename);
    const doc = loaded.exports.createEmptyDocument();
    doc.metadata.project_name = "Crash relaunch";
    return loaded.exports.serializeDocument(doc);
}

function clearLocks(profile) {
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        fs.rmSync(path.join(profile, name), { force: true });
    }
}

function launch(phase, profile, project) {
    const env = {
        ...process.env,
        VDE_CRASH_RELAUNCH_SMOKE: phase,
        VDE_SMOKE_PROFILE: profile,
        VDE_CRASH_PROJECT: project
    };
    if (phase === "restore" || phase === "discard") env.VDE_RECOVERY_DECISION = phase;
    const output = { text: "" };
    const child = spawn(electron, [mainJs], {
        cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    const capture = chunk => { output.text += chunk.toString(); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    return { child, output };
}

function exited(child) {
    return new Promise(resolve => child.once("exit", code => resolve(code)));
}

async function waitFor(check, timeout, label, output, child) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (check()) return;
        if (child.exitCode !== null || child.signalCode) {
            throw new Error(`${label} exited early (${child.exitCode ?? child.signalCode}).\n${output.text}`);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${label} timed out.\n${output.text}`);
}

function waitExit(child, timeout, output) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`Relaunch timed out.\n${output.text}`));
        }, timeout);
        child.once("exit", code => { clearTimeout(timer); resolve(code); });
    });
}

function recoveryReady(profile) {
    try {
        const snapshot = JSON.parse(fs.readFileSync(path.join(profile, "project-recovery.json"), "utf8"));
        return !!snapshot && typeof snapshot.content === "string" && snapshot.content.includes('"timeline"')
            && typeof snapshot.savedContent === "string" && !snapshot.savedContent.includes('"timeline"');
    } catch { return false; }
}

async function runPhase(phase, profile, project, sentinel) {
    clearLocks(profile);
    const session = launch(phase, profile, project);
    const code = await waitExit(session.child, 40000, session.output);
    if (code !== 0 || !session.output.text.includes(sentinel)) {
        throw new Error(`${phase} failed with exit ${code}.\n${session.output.text}`);
    }
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-crash-relaunch-"));
    const project = path.join(root, "project.vde");
    const original = projectFixture();
    fs.writeFileSync(project, original);
    const profile = path.join(root, "profile");
    const discardProfile = path.join(root, "profile-discard");
    fs.mkdirSync(profile);
    let edit;
    try {
        clearLocks(profile);
        edit = launch("edit", profile, project);
        const editExit = exited(edit.child);
        await waitFor(
            () => edit.output.text.includes("VDE_CRASH_EDIT_READY") && recoveryReady(profile),
            30000, "recovery checkpoint", edit.output, edit.child);
        if (fs.readFileSync(project, "utf8") !== original) throw new Error("The explicit save changed before the crash.");
        if (edit.child.kill("SIGKILL") !== true) throw new Error("Could not kill the editor.");
        await editExit;
        fs.cpSync(profile, discardProfile, { recursive: true });
        await runPhase("restore", profile, project, "VDE_CRASH_RECOVERY_RESTORED");
        if (fs.readFileSync(project, "utf8") !== original) throw new Error("Restore overwrote the explicit save.");
        await runPhase("discard", discardProfile, project, "VDE_CRASH_RECOVERY_DISCARDED");
        if (fs.readFileSync(project, "utf8") !== original) throw new Error("Discard overwrote the explicit save.");
        const kept = JSON.parse(fs.readFileSync(path.join(discardProfile, "project-recovery.json"), "utf8"));
        if (!kept.content.includes('"timeline"')) throw new Error("Discard deleted the recovery snapshot.");
        console.log("Desktop crash/relaunch smoke passed (restore and discard).");
    } finally {
        if (edit && edit.child.exitCode === null && edit.child.signalCode === null) edit.child.kill("SIGKILL");
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
