/**
 * @module smoke-many-lights
 * @description Electron GPU gate for the many-light 3D path. Renders a 20x20 grid lit by 400
 * authored point lights (one Christmas-colored bulb above each cell) through the production
 * emitWebGL3D and reads every cell center back:
 *   1. per-pixel clustered path, 400 separate tile draws;
 *   2. per-pixel clustered path, ONE large quad under all 400 lights;
 *   3. forced per-object fallback (data-lighting="per-object"), 400 tile draws.
 * Each must show every cell lit by its own bulb (case 2 is what per-object shading cannot do).
 * Also compiles the production shader at every light tier in both variants.
 * Pass --show to leave the window open; nothing is timed or benchmarked here.
 */

const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const path = require("path");

const show = process.argv.includes("--show");
const timeout = show ? null : setTimeout(() => { console.error("Many-light smoke timed out."); app.exit(1); }, 30_000);

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show, width: 1300, height: 470, title: "Canvas Fogworks - 400 point lights",
        webPreferences: { sandbox: true } });
    try {
        await win.loadURL("data:text/html,<body style='margin:0;background:black;display:flex'>"
            + "<canvas id='a' style='width:400px;height:400px;margin:20px 10px'></canvas>"
            + "<canvas id='b' style='width:400px;height:400px;margin:20px 10px'></canvas>"
            + "<canvas id='c' data-lighting='per-object' style='width:400px;height:400px;margin:20px 10px'></canvas></body>");
        const bundle = buildSync({
            entryPoints: [path.resolve(__dirname, "../src/renderer/emitWebGL3D.ts")],
            bundle: true, platform: "browser", format: "iife", globalName: "Vde3D", write: false
        }).outputFiles[0].text;
        await win.webContents.executeJavaScript(`${bundle}\nglobalThis.Vde3DModule = Vde3D; undefined;`);
        const result = await win.webContents.executeJavaScript(`(() => {
            try {
            const M = Vde3DModule;
            const probe = document.createElement("canvas").getContext("webgl");
            const tiers = {};
            for (const clustered of [false, true]) for (const tier of [16, 8, 4]) {
                const s = M.webGL3DShaderSources(!!probe.getExtension("OES_standard_derivatives"), tier, clustered);
                const compile = (kind, source) => { const sh = probe.createShader(kind); probe.shaderSource(sh, source);
                    probe.compileShader(sh); return probe.getShaderParameter(sh, probe.COMPILE_STATUS) ? sh : null; };
                const vs = compile(probe.VERTEX_SHADER, s.vertex), fs = compile(probe.FRAGMENT_SHADER, s.fragment);
                const program = probe.createProgram();
                if (vs && fs) { probe.attachShader(program, vs); probe.attachShader(program, fs); probe.linkProgram(program); }
                tiers[(clustered ? "clustered-" : "per-object-") + tier] = !!(vs && fs && probe.getProgramParameter(program, probe.LINK_STATUS));
            }
            const quad = s => ({ positions: new Float32Array([-s,-s,0, s,-s,0, s,s,0, -s,s,0]),
                normals: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]), uvs: null,
                indices: new Uint32Array([0,1,2, 0,2,3]), material: null });
            const tile = quad(0.5), big = quad(10);
            const record = (nodeId, x, y, primitive) => ({ nodeId, model: [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,0,1], primitive,
                color: [0.8,0.8,0.8,1], unlit: false, baseColorTexture: null, metallicRoughnessTexture: null,
                baseColorTextureInfo: null, metallicRoughnessTextureInfo: null, normalTexture: null,
                normalTextureInfo: null, normalScale: 1, emissiveTexture: null, emissiveTextureInfo: null,
                metallic: 0, roughness: 0.8, emissive: [0,0,0], doubleSided: false, alphaMode: "OPAQUE", alphaCutoff: 0.5 });
            const palette = [[1,0.08,0.04], [0.08,1,0.1], [0.1,0.2,1], [1,0.7,0.2]], channel = [0, 1, 2, 0];
            const tiles = [], lights = [], cells = [];
            for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
                const x = -10 + i + 0.5, y = -10 + j + 0.5, colorIndex = (i + j * 3) % 4;
                tiles.push(record("tile-" + i + "-" + j, x, y, tile));
                lights.push({ kind: "point", color: palette[colorIndex], intensity: 0.25, range: 0.9, position: [x, y, 0.35] });
                cells.push({ px: (i + 0.5) * 20, py: (j + 0.5) * 20, channel: channel[colorIndex] });
            }
            const frameOf = draws => ({ view: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-10,1],
                projection: [0.1,0,0,0, 0,0.1,0,0, 0,0,-0.05,0, 0,0,0,1],
                draws, lights, cameraNodeId: null, cameraPosition: [0,0,10], worlds: new Map(), environment: null, shadow: null });
            const read = canvas => { const gl = canvas.getContext("webgl"), w = canvas.width, px = new Uint8Array(w * canvas.height * 4);
                gl.readPixels(0, 0, w, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px); return { w, px }; };
            const run = (id, draws) => {
                const canvas = document.getElementById(id);
                const darkOk = M.emitWebGL3D(canvas, { ...frameOf(draws), lights: [] }, 1), dark = read(canvas);
                const ok = M.emitWebGL3D(canvas, frameOf(draws), 1), lit = read(canvas);
                const gl = canvas.getContext("webgl");
                let litCells = 0;
                for (const c of cells) {
                    const at = (Math.floor(c.py) * lit.w + Math.floor(c.px)) * 4 + c.channel;
                    if (lit.px[at] >= dark.px[at] + 60) litCells++;
                }
                return { ok: darkOk && ok && gl.getError() === gl.NO_ERROR, litCells, lighting: M.webGL3DLighting(canvas),
                    failure: M.lastWebGL3DFailure() };
            };
            const clusteredTiles = run("a", tiles), clusteredBig = run("b", [record("big", 0, 0, big)]), perObject = run("c", tiles);
            return { tiers, clusteredTiles, clusteredBig, perObject, cells: cells.length };
            } catch (error) { return { error: String(error), stack: error && error.stack }; }
        })()`);
        if (result.error) throw new Error(JSON.stringify(result));
        const { tiers, clusteredTiles, clusteredBig, perObject, cells } = result;
        const clusteredAvailable = clusteredTiles.lighting && clusteredTiles.lighting.mode === "clustered";
        const failures = [];
        if (!Object.entries(tiers).every(([name, ok]) => ok || (!clusteredAvailable && name.startsWith("clustered")))) failures.push("tier compile");
        for (const [name, run] of Object.entries({ clusteredTiles, perObject, ...(clusteredAvailable ? { clusteredBig } : {}) })) {
            if (!run.ok || run.litCells !== cells) failures.push(name);
        }
        if (perObject.lighting.mode !== "per-object") failures.push("forced fallback");
        if (failures.length) throw new Error(`Many-light smoke failed (${failures.join(", ")}): ${JSON.stringify(result)}`);
        console.log(`Many-light smoke passed: lighting ${clusteredTiles.lighting.mode}` +
            (clusteredAvailable ? ` (${clusteredTiles.lighting.pointLightsPerPixel}/pixel)` : ` (${clusteredTiles.lighting.note})`) +
            `; 400 lights over ${cells} cells: tiles ${clusteredTiles.litCells}, one big quad ${clusteredBig.litCells}` +
            `, per-object fallback tiles ${perObject.litCells} (${perObject.lighting.pointLightsPerPixel}/draw); all tiers compile.`);
        if (show) return;
        clearTimeout(timeout);
        app.exit(0);
    } catch (error) {
        if (timeout) clearTimeout(timeout);
        console.error(error);
        app.exit(1);
    }
});
app.on("window-all-closed", () => app.exit(0));