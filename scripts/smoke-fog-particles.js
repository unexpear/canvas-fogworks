/**
 * @module smoke-fog-particles
 * @description Electron GPU gate for schema 91 effects. Builds documents (the same
 * buildFrame3D -> emitWebGL3D path the editor viewport and the exported player use) and reads back:
 *   1. fog: a far wall and the sky are pulled toward the fog color; a near wall barely is;
 *   2. particles: an additive sparkle emitter and an alpha snow emitter both change pixels;
 *   3. light string: the strand's wire, sockets and emissive bulbs draw and light the wall;
 *   4. the particle program compiles, nothing reports a GL error or a renderer failure.
 * Pass --show to leave the window open; nothing is timed here.
 */

const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const path = require("path");

const show = process.argv.includes("--show");
const timeout = show ? null : setTimeout(() => { console.error("Fog/particles smoke timed out."); app.exit(1); }, 30_000);

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show, width: 700, height: 420, title: "Canvas Fogworks - fog and particles",
        webPreferences: { sandbox: true } });
    try {
        await win.loadURL("data:text/html,<body style='margin:0;background:black'><canvas id='c' style='width:320px;height:240px'></canvas></body>");
        const root = path.resolve(__dirname, "..");
        const bundle = buildSync({ stdin: { resolveDir: root, contents: [
            "export * from './src/renderer/emitWebGL3D';", "export * from './src/renderer/Scene3D';",
            "export * from './src/core/document/Effects3D';", "export { createEmptyDocument } from './src/core/document/Document';"].join("\n") },
            bundle: true, platform: "browser", format: "iife", globalName: "Fx3D", write: false }).outputFiles[0].text;
        await win.webContents.executeJavaScript(`${bundle}\nglobalThis.M = Fx3D; undefined;`);
        const result = await win.webContents.executeJavaScript(`(() => {
            try {
            const canvas = document.getElementById("c");
            const node = (id, x, y, z) => ({ id, type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 1, height: 1 },
                style: { fill: "none", opacity: 1 }, layout: {},
                spatial3d: { transform: { position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } } });
            const quad = (w, h) => ({ positions: new Float32Array([-w,-h,0, w,-h,0, w,h,0, -w,h,0]), normals: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]),
                uvs: null, indices: new Uint32Array([0,1,2, 0,2,3]), material: null });
            const meshes = new Map([["near", { instances: [{ name: "near", matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], primitive: quad(0.6, 0.6) }] }],
                ["far", { instances: [{ name: "far", matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], primitive: quad(6, 2.5) }] }]]);
            const build = ({ fog = false, sparkles = false, snow = false, strand = false } = {}) => {
                const doc = M.createEmptyDocument();
                const camera = node("camera", 0, 0, 5);
                camera.spatial3d.camera = { kind: "perspective", near: 0.1, far: 200, verticalFovDegrees: 50 };
                const far = node("far", 0, 0, -40); far.spatial3d.renderable = { meshAssetId: "far" };
                const near = node("near", -1.4, -0.6, 1); near.spatial3d.renderable = { meshAssetId: "near" };
                const nodes = [camera, far, near];
                if (fog) { const f = node("fog", 0, 0, 0); f.spatial3d.fog = { ...M.defaultFog3D(), mode: "exp", density: 0.05, heightDensity: 0,
                    color: { x: 0.6, y: 0.05, z: 0.05 }, skyBlend: 1, lightGlow: 0 }; nodes.push(f); }
                if (sparkles) { const s = node("sparkles", 1.4, 0.8, 1); s.spatial3d.particles = { ...M.particlePreset3D("sparkles"), rate: 300, lifetime: 1.5 }; nodes.push(s); }
                if (snow) { const s = node("snow", 0, 3, 0); s.spatial3d.particles = { ...M.particlePreset3D("snowfall"), boxHalfExtents: { x: 3, y: 0.2, z: 2 }, sizeStart: 0.12, sizeEnd: 0.12 }; nodes.push(s); }
                if (strand) { const s = node("strand", 0, -1.2, 1); s.spatial3d.lightString = { ...M.defaultLightString3D(), intensity: 0.4 }; nodes.push(s); }
                for (const n of nodes) { doc.nodes.set(n.id, n); doc.rootNodeUuids.push(n.id); }
                return M.buildFrame3D(doc, meshes, 320, 240, new Map(), 5);
            };
            const draw = options => {
                const frame = build(options);
                const ok = M.emitWebGL3D(canvas, frame, 1);
                const gl = canvas.getContext("webgl"), w = canvas.width, h = canvas.height, px = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
                return { ok: ok && gl.getError() === gl.NO_ERROR, w, h, px, frame };
            };
            const at = (shot, x, y) => { const i = ((shot.h - 1 - y) * shot.w + x) * 4; return [shot.px[i], shot.px[i + 1], shot.px[i + 2]]; };
            const changed = (a, b) => { let n = 0; for (let i = 0; i < a.px.length; i += 4)
                if (Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2]) > 24) n++; return n; };
            const base = draw(), fogged = draw({ fog: true }), sparkles = draw({ sparkles: true }), snow = draw({ snow: true }), strand = draw({ strand: true });
            const pick = (shot) => ({ far: at(shot, 160, 125), near: at(shot, 75, 165), sky: at(shot, 160, 5) });
            const gl = canvas.getContext("webgl");
            const particleSources = M.webGL3DParticleShaderSources();
            const compile = (kind, source) => { const sh = gl.createShader(kind); gl.shaderSource(sh, source); gl.compileShader(sh);
                return gl.getShaderParameter(sh, gl.COMPILE_STATUS); };
            return { ok: [base, fogged, sparkles, snow, strand].every(s => s.ok), base: pick(base), fogged: pick(fogged),
                sparkles: changed(base, sparkles), snow: changed(base, snow), strand: changed(base, strand),
                strandLights: strand.frame.lights.length, particleCounts: [sparkles.frame.particles[0].count, snow.frame.particles[0].count],
                particleCompile: compile(gl.VERTEX_SHADER, particleSources.vertex) && compile(gl.FRAGMENT_SHADER, particleSources.fragment),
                particleNote: M.webGL3DParticleNote(canvas), failure: M.lastWebGL3DFailure(), lighting: M.webGL3DLighting(canvas).mode };
            } catch (error) { return { error: String(error), stack: error && error.stack }; }
        })()`);
        if (result.error) throw new Error(JSON.stringify(result));
        const failures = [];
        const { base, fogged } = result;
        const toward = (a, b) => b[0] - b[1] > a[0] - a[1] + 40;
        if (!result.ok) failures.push("emit/GL error");
        if (Math.abs(base.far[0] - base.sky[0]) + Math.abs(base.far[2] - base.sky[2]) < 30) failures.push("far wall not drawn");
        if (!toward(base.far, fogged.far)) failures.push("far wall not fogged");
        if (!toward(base.sky, fogged.sky)) failures.push("sky not blended");
        if (Math.abs(fogged.near[1] - base.near[1]) > 40) failures.push("near wall over-fogged");
        if (result.sparkles < 50) failures.push("sparkles invisible");
        if (result.snow < 50) failures.push("snow invisible");
        if (result.strand < 50 || result.strandLights < 5) failures.push("light string missing");
        if (!result.particleCompile || result.particleNote || result.failure) failures.push("particle program");
        if (failures.length) throw new Error(`Fog/particles smoke failed (${failures.join(", ")}): ${JSON.stringify(result)}`);
        console.log(`Fog/particles smoke passed (${result.lighting}): far wall ${base.far} -> ${fogged.far}, sky ${base.sky} -> ${fogged.sky},` +
            ` near wall ${base.near} -> ${fogged.near}; sparkles ${result.particleCounts[0]} changed ${result.sparkles} px, snow ${result.particleCounts[1]}` +
            ` changed ${result.snow} px; strand ${result.strandLights} bulb lights changed ${result.strand} px.`);
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