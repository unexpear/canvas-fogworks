/**
 * @module smoke-player-acceptance
 * @description Clean-profile acceptance for a packaged 3D game: source and font files are removed before launch.
 */
const { app } = require("electron");
// Host GPUs are often blocklisted in this environment. SwiftShader keeps presentation
// independent of that blocklist; it is not a hardware-GPU certification.
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { packageGame } = require("./package-game");
const { createGameWindow } = require("../src/player3d/desktopWindow");
const { ownedTestFont } = require("./owned-test-font");
const root = path.resolve(__dirname, ".."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-player-acceptance-"));
app.setPath("userData", path.join(temp, "profile"));
app.on("window-all-closed", () => {});
const timeout = setTimeout(() => { console.error("Standalone acceptance timed out"); app.exit(1); }, 90000);
app.on("quit", () => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* locked disposable profile may remain */ } });
function ownedToneWav() {
    const samples = 16, data = Buffer.alloc(44 + samples);
    data.write("RIFF", 0); data.writeUInt32LE(36 + samples, 4); data.write("WAVE", 8);
    data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(8000, 24); data.writeUInt32LE(8000, 28); data.writeUInt16LE(1, 32); data.writeUInt16LE(8, 34);
    data.write("data", 36); data.writeUInt32LE(samples, 40);
    for (let i = 0; i < samples; i++) data[44 + i] = i % 2 ? 200 : 40;
    return `data:audio/wav;base64,${data.toString("base64")}`;
}
function filesUnder(directory) {
    const out = [];
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.push(path.relative(directory, full).replace(/\\/g, "/"));
        }
    };
    walk(directory);
    return out.sort();
}
async function until(win, expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (await win.webContents.executeJavaScript(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 80));
    }
    const diagnostic = await win.webContents.executeJavaScript('document.getElementById("status")?.textContent');
    throw new Error(`Acceptance condition timed out: ${expression}; ${diagnostic}`);
}
app.whenReady().then(async () => {
    const source = path.join(temp, "source"), fonts = path.join(temp, "fonts");
    fs.mkdirSync(source); fs.mkdirSync(fonts);
    const doc = JSON.parse(fs.readFileSync(path.join(root, "reference-projects/animated-3d.vde"), "utf8"));
    doc.document.nodes.label = { id: "label", type: "core.text", parent: null, children: [],
        geometry: { x: 8, y: 8, width: 80, height: 64 },
        style: { fill: "#ffffff", opacity: 1, fontFamily: "\"Owned Face\", sans-serif", fontSize: 48 }, layout: {}, text: "A" };
    doc.document.nodes.triangle.entity = { rules: [{ event: "start", other: "any", target: "self",
        action: { kind: "sound", source: ownedToneWav(), volume: 0.4 } }] };
    doc.document.rootNodeUuids.push("label");
    const project = path.join(source, "entry.vde");
    fs.writeFileSync(project, JSON.stringify(doc));
    fs.writeFileSync(path.join(fonts, "OwnedFace.ttf"), ownedTestFont("Owned Face"));
    for (const name of ["triangle.gltf", "triangle.bin"]) fs.copyFileSync(path.join(root, "reference-projects", name), path.join(source, name));
    const output = await packageGame(project, path.join(temp, "export"), { fontsDirectory: fonts });
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(fonts, { recursive: true, force: true });
    const expected = ["app/game.html", "app/main.cjs", "app/package.json", "app/progressPreload.js", "game.cfgame.json", "game.provenance.json"];
    const present = filesUnder(output);
    if (JSON.stringify(present) !== JSON.stringify(expected)) throw new Error(`Unexpected package files: ${present.join(", ")}`);
    const manifest = fs.readFileSync(path.join(output, "game.cfgame.json"), "utf8");
    const provenance = JSON.parse(fs.readFileSync(path.join(output, "game.provenance.json"), "utf8"));
    const html = fs.readFileSync(path.join(output, "app/game.html"), "utf8");
    const embedded = JSON.parse(html.match(/<script id="game-provenance" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    if (JSON.stringify(embedded) !== JSON.stringify(provenance)) throw new Error("Embedded provenance does not match the sidecar");
    if (provenance.authenticity !== "unsigned" || provenance.profile !== "spatial3d-v1") throw new Error("Provenance identity is wrong");
    if (provenance.manifestSha256 !== crypto.createHash("sha256").update(manifest).digest("hex")) throw new Error("Provenance manifest hash mismatch");
    if (provenance.sourceRevision !== null && !/^[0-9a-f]{7,64}$/.test(provenance.sourceRevision)) throw new Error("Provenance revision is not a commit id");
    if (!provenance.fonts.some(font => font.family === "Owned Face" && /^[0-9a-f]{64}$/.test(font.sha256))) throw new Error("Packaged font is missing from provenance");
    const codes = provenance.warnings.map(warning => warning.code);
    if (codes.length) throw new Error(`Unexpected diagnostics: ${codes.join(", ")}`);
    for (const blob of [manifest, html, JSON.stringify(provenance)]) {
        if (blob.includes(temp) || blob.includes(source) || blob.includes(root)) throw new Error("Package leaked a host path");
    }
    const win = await createGameWindow(path.join(output, "app/game.html"), { show: false });
    win.webContents.setBackgroundThrottling(false);
    await until(win, 'document.getElementById("scene").dataset.presented === "true" && document.getElementById("text").dataset.presented === "true"');
    await win.webContents.executeJavaScript('document.getElementById("pause").click()');
    await until(win, 'Number(document.getElementById("audio").dataset.played || "0") >= 1');
    const report = await win.webContents.executeJavaScript(`({
        authority: typeof window.electronAPI === "undefined" && typeof require === "undefined",
        fonts: document.getElementById("fonts").dataset.loaded,
        diagnostics: document.getElementById("diagnostics").textContent,
        hidden: document.getElementById("diagnostics").hidden,
        played: document.getElementById("audio").dataset.played,
        text: document.getElementById("text").dataset.text,
        overlayFont: document.getElementById("text").dataset.font,
        loaded: [...document.fonts].some(face => face.family.replaceAll('"', "") === "Owned Face" && face.status === "loaded"),
        ink: (() => {
            const canvas = document.getElementById("text"), ctx = canvas.getContext("2d");
            const pixels = ctx.getImageData(0, 0, Math.min(canvas.width, 160), Math.min(canvas.height, 120)).data;
            let ink = 0;
            for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) ink++;
            return ink;
        })()
    })`);
    if (!report.authority) throw new Error("Editor or Node authority leaked into the player");
    if (report.fonts !== "Owned Face" || !report.loaded) throw new Error(`Packaged font was not registered: ${JSON.stringify(report)}`);
    if (!report.hidden || report.diagnostics) throw new Error(`Unexpected player diagnostics: ${JSON.stringify(report)}`);
    if (report.text !== "A" || !report.overlayFont.includes("Owned Face") || report.ink < 1) {
        throw new Error(`Screen-space text was not drawn: ${JSON.stringify(report)}`);
    }
    if (Number(report.played) < 1) throw new Error(`Embedded sound was not played: ${JSON.stringify(report)}`);
    win.destroy();
    clearTimeout(timeout);
    console.log("Standalone 3D acceptance passed.");
    app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
