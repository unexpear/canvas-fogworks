/**
 * @module smoke-many-lights
 * @description Electron GPU gate for the many-light 3D path: renders a 20x20 grid of tiles lit by
 * 400 authored point lights (one Christmas-colored bulb above each tile) through the production
 * emitWebGL3D, then reads every tile center back and requires each one to show its own bulb color.
 * Under the old fixed four-light frame only four tiles could ever light up.
 *
 * Also compiles the production shader at every light tier, so the weak-GPU fallback is exercised.
 * Pass --show to leave the window open and look at the scene; nothing is timed or benchmarked.
 */

const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const path = require("path");

const show = process.argv.includes("--show");
const timeout = show ? null : setTimeout(() => { console.error("Many-light smoke timed out."); app.exit(1); }, 20_000);

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show, width: 440, height: 470, title: "Canvas Fogworks - 400 point lights",
        webPreferences: { sandbox: true } });
    try {
        await win.loadURL("data:text/html,<body style='margin:0;background:black'><canvas id='c' style='width:400px;height:400px;display:block;margin:20px'></canvas></body>");
        const bundle = buildSync({
            entryPoints: [path.resolve(__dirname, "../src/renderer/emitWebGL3D.ts")],
            bundle: true, platform: "browser", format: "iife", globalName: "Vde3D", write: false
        }).outputFiles[0].text;
        await win.webContents.executeJavaScript(`${bundle}\nglobalThis.Vde3DModule = Vde3D; undefined;`);
        const result = await win.webContents.executeJavaScript(`(() => {
            try {
            const M = Vde3DModule, canvas = document.getElementById("c");
            const probe = document.createElement("canvas").getContext("webgl");
            const tiers = {};
            for (const tier of [16, 8, 4]) {
                const s = M.webGL3DShaderSources(!!probe.getExtension("OES_standard_derivatives"), tier);
                const compile = (kind, source) => { const sh = probe.createShader(kind); probe.shaderSource(sh, source);
                    probe.compileShader(sh); return probe.getShaderParameter(sh, probe.COMPILE_STATUS) ? sh : null; };
                const vs = compile(probe.VERTEX_SHADER, s.vertex), fs = compile(probe.FRAGMENT_SHADER, s.fragment);
                const program = probe.createProgram();
                if (vs && fs) { probe.attachShader(program, vs); probe.attachShader(program, fs); probe.linkProgram(program); }
                tiers[tier] = !!(vs && fs && probe.getProgramParameter(program, probe.LINK_STATUS));
            }
            const quad = { positions: new Float32Array([-.5,-.5,0, .5,-.5,0, .5,.5,0, -.5,.5,0]),
                normals: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]), uvs: null,
                indices: new Uint32Array([0,1,2, 0,2,3]), material: null };
            const palette = [[1,0.08,0.04], [0.08,1,0.1], [0.1,0.2,1], [1,0.7,0.2]];
            const channel = [0, 1, 2, 0];
            const draws = [], lights = [], tiles = [];
            for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
                const x = -10 + i + 0.5, y = -10 + j + 0.5, colorIndex = (i + j * 3) % 4;
                draws.push({ nodeId: "tile-" + i + "-" + j, model: [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,0,1], primitive: quad,
                    color: [0.8,0.8,0.8,1], unlit: false, baseColorTexture: null, metallicRoughnessTexture: null,
                    baseColorTextureInfo: null, metallicRoughnessTextureInfo: null, normalTexture: null,
                    normalTextureInfo: null, normalScale: 1, emissiveTexture: null, emissiveTextureInfo: null,
                    metallic: 0, roughness: 0.8, emissive: [0,0,0], doubleSided: false, alphaMode: "OPAQUE", alphaCutoff: 0.5 });
                lights.push({ kind: "point", color: palette[colorIndex], intensity: 0.25, range: 0.9, position: [x, y, 0.35] });
                tiles.push({ px: (i + 0.5) * 20, py: (j + 0.5) * 20, channel: channel[colorIndex] });
            }
            const frame = { view: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-10,1],
                projection: [0.1,0,0,0, 0,0.1,0,0, 0,0,-0.05,0, 0,0,0,1],
                draws, lights, cameraNodeId: null, cameraPosition: [0,0,10], worlds: new Map(),
                environment: null, shadow: null };
            const read = () => { const w = canvas.width, h = canvas.height, px = new Uint8Array(w * h * 4);
                const gl = canvas.getContext("webgl"); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return { w, px }; };
            const darkOk = M.emitWebGL3D(canvas, { ...frame, lights: [] }, 1);
            const dark = read();
            const emitted = M.emitWebGL3D(canvas, frame, 1);
            const lit = read();
            const gl = canvas.getContext("webgl");
            let litTiles = 0; const misses = [];
            for (const t of tiles) {
                const at = (Math.floor(t.py) * lit.w + Math.floor(t.px)) * 4 + t.channel;
                if (lit.px[at] >= dark.px[at] + 60) litTiles++; else if (misses.length < 5) misses.push({ t, lit: lit.px[at], dark: dark.px[at] });
            }
            return { ok: darkOk && emitted && gl.getError() === gl.NO_ERROR, litTiles, tiles: tiles.length, misses, tiers,
                budget: M.webGL3DLightBudget(canvas), maxFragmentVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
                failure: M.lastWebGL3DFailure(), width: canvas.width };
            } catch (error) { return { ok: false, error: String(error), stack: error && error.stack }; }
        })()`);
        const tiersOk = result.tiers && Object.values(result.tiers).every(Boolean);
        if (!result.ok || !tiersOk || result.litTiles !== result.tiles || result.width !== 400) {
            throw new Error(`Many-light smoke ${JSON.stringify(result)}; expected all ${result.tiles} tiles lit by their own bulb and every tier to compile.`);
        }
        console.log(`Many-light smoke passed: ${result.litTiles}/${result.tiles} tiles lit by 400 point lights; ` +
            `per-draw budget ${result.budget} (MAX_FRAGMENT_UNIFORM_VECTORS ${result.maxFragmentVectors}); tiers 16/8/4 compile.`);
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