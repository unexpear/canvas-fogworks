/**
 * @module smoke-startup
 * @description Launches the built Electron app, waits for its renderer-ready sentinel, and fails
 * if startup crashes, loads no UI, or hangs. Accepts `--packaged <exe>` for the unpacked app that
 * electron-builder creates alongside the NSIS installer, and `--historical-migration` for a
 * legacy project opened and saved by that same executable.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const packagedAt = process.argv.indexOf("--packaged");
const packaged = packagedAt >= 0;
const projectOpen = process.argv.includes("--project-open");
const historicalAt = process.argv.indexOf("--historical-migration");
const historical = historicalAt >= 0 ? path.resolve(process.argv[historicalAt + 1] || "") : "";
const schemaAt = process.argv.indexOf("--historical-schema");
const historicalSchema = schemaAt >= 0 ? process.argv[schemaAt + 1] || "" : "";
const target = packaged
    ? path.resolve(ROOT, process.argv[packagedAt + 1] || "")
    : require("electron");
const args = packaged ? [] : [path.join(ROOT, "dist", "electron", "main.js")];
const TIMEOUT_MS = 45_000;
const READY = historical
    ? `VDE_HISTORICAL_MIGRATION_READY ${historicalSchema}`
    : projectOpen ? "VDE_PROJECT_FILE_SMOKE_READY" : "VDE_STARTUP_SMOKE_READY";
const smokeProject = path.join(ROOT, "dist", "project-open-smoke.vde");
const smokeModel = path.join(ROOT, "dist", "project-open-smoke.gltf");

if (historical && projectOpen) {
    console.error("Historical migration smoke cannot be combined with --project-open.");
    process.exit(2);
}
if ((historical && !/^\d+$/.test(historicalSchema)) || (!historical && schemaAt >= 0)) {
    console.error("Historical migration smoke requires --historical-migration <file> and a numeric --historical-schema.");
    process.exit(2);
}
if (historical && !fs.existsSync(historical)) {
    console.error(`Historical project does not exist: ${historical}`);
    process.exit(2);
}
if (!fs.existsSync(target)) {
    console.error(`Startup smoke target does not exist: ${target}`);
    process.exit(2);
}
if (!packaged && !fs.existsSync(args[0])) {
    console.error(`Built Electron main process does not exist: ${args[0]}; run npm run build first.`);
    process.exit(2);
}

let output = "";
let settled = false;
if (projectOpen) {
    fs.copyFileSync(path.join(ROOT, "src", "core", "tests", "fixtures", "triangle.gltf"), smokeModel);
    const texturedModel = JSON.parse(fs.readFileSync(smokeModel, "utf8"));
    texturedModel.images = [{ uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nkwAAAAASUVORK5CYII=" }];
    texturedModel.textures = [{ source: 0 }];
    texturedModel.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
    texturedModel.materials[0].pbrMetallicRoughness.metallicFactor = 0.4;
    texturedModel.materials[0].pbrMetallicRoughness.roughnessFactor = 0.6;
    fs.writeFileSync(smokeModel, JSON.stringify(texturedModel));
    fs.writeFileSync(smokeProject, JSON.stringify({
        version: "74",
        document: {
            metadata: { project_name: "Project open smoke", created_by: "smoke", date: "2026-09-02T00:00:00.000Z" },
            nodes: {
                model: {
                    id: "model", type: "core.rectangle", parent: null, children: [],
                    geometry: { x: 0, y: 0, width: 1, height: 1 },
                    style: { fill: "none", opacity: 1 }, layout: {},
                    spatial3d: {
                        transform: { position: { x: -1, y: -2, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
                        renderable: { meshAssetId: "smoke-mesh", materialAssetIds: ["smoke-material"] }
                    }
                },
                camera: {
                    id: "camera", type: "core.rectangle", parent: null, children: [],
                    geometry: { x: 0, y: 0, width: 1, height: 1 },
                    style: { fill: "none", opacity: 1 }, layout: {},
                    spatial3d: {
                        transform: { position: { x: 0, y: 0, z: 5 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
                        camera: { kind: "perspective", near: 0.1, far: 100, verticalFovDegrees: 60 }
                    }
                },
                sun: {
                    id: "sun", type: "core.rectangle", parent: null, children: [],
                    geometry: { x: 0, y: 0, width: 1, height: 1 },
                    style: { fill: "none", opacity: 1 }, layout: {},
                    spatial3d: {
                        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
                        light: { kind: "directional", color: { x: 1, y: 1, z: 1 }, intensity: 1 }
                    }
                },
                card: {
                    id: "card", type: "core.rectangle", parent: null, children: [],
                    geometry: { x: 0, y: 0, width: 200, height: 100 },
                    style: { fill: "#ff8040", opacity: 1 }, layout: {}
                }
            },
            rootNodeUuids: ["model", "camera", "sun", "card"], variables: {}, activeTheme: "light",
            assets3d: [
                { id: "smoke-mesh", kind: "mesh", source: "project-open-smoke.gltf", name: "Smoke triangle" },
                { id: "smoke-material", kind: "material", source: "project-open-smoke.gltf#material-0", name: "White" }
            ]
        }
    }));
}
const child = spawn(target, args, {
    cwd: ROOT,
    env: historical
        ? { ...process.env, VDE_HISTORICAL_MIGRATION_SMOKE: historical, VDE_HISTORICAL_MIGRATION_SCHEMA: historicalSchema }
        : projectOpen
        ? { ...process.env, VDE_PROJECT_OPEN_SMOKE: smokeProject }
        : { ...process.env, VDE_STARTUP_SMOKE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
});

const capture = chunk => { output += chunk.toString(); };
child.stdout.on("data", capture);
child.stderr.on("data", capture);

const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    console.error(`Startup smoke timed out after ${TIMEOUT_MS / 1000}s.\n${output}`);
    process.exitCode = 1;
}, TIMEOUT_MS);

child.on("error", error => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    console.error(`Startup smoke could not launch: ${error.message}`);
    process.exitCode = 1;
});

child.on("exit", code => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (projectOpen) {
        try { fs.unlinkSync(smokeProject); } catch { /* best-effort smoke cleanup */ }
        try { fs.unlinkSync(smokeModel); } catch { /* best-effort smoke cleanup */ }
    }
    if (code === 0 && output.includes(READY)) {
        const label = historical ? "Historical migration" : projectOpen ? "Open-edit-save" : "Startup";
        console.log(`${label} smoke passed (${packaged ? "packaged app" : "built Electron app"}).`);
        return;
    }
    console.error(`Startup smoke failed with exit code ${code}; ready sentinel was ${output.includes(READY) ? "present" : "absent"}.\n${output}`);
    process.exitCode = 1;
});
