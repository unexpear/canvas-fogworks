/** @module smoke-player-startup @description Launches an actual packaged game executable and checks its isolated renderer/GPU startup sentinel. */
const { spawn } = require("child_process"), fs = require("fs"), path = require("path");
const target = process.argv[2] && path.resolve(process.argv[2]);
if (!target || !fs.statSync(target).isFile() || !/\.exe$/i.test(target)) {
    throw new Error('Usage: node scripts/smoke-player-startup.js "path/to/Canvas Fogworks Game.exe"');
}
let output = "", timedOut = false;
const child = spawn(target, [], { windowsHide: true, env: { ...process.env, FOGWORKS_PLAYER_SMOKE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
const capture = data => { output = (output + data.toString()).slice(-32768); };
child.stdout.on("data", capture); child.stderr.on("data", capture);
child.on("error", error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.on("close", code => {
    clearTimeout(timer);
    if (timedOut || code !== 0 || !output.includes("FOGWORKS_PLAYER_STARTUP_READY")) {
        console.error(`Packaged player failed (exit=${code}, timeout=${timedOut}): ${output}`); process.exitCode = 1;
    } else console.log("Packaged player startup passed: standalone executable, sandboxed renderer, WebGL presentation and Stop.");
});
