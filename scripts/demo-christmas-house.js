/**
 * @module demo-christmas-house
 * @description Renders the procedural Christmas house night scene (ChristmasHouse3D) through the
 * production WebGL renderer in Electron, saves PNG screenshots of the front and corner views, and
 * reports the GPU renderer string, lighting path and a rough frame time.
 *
 *   npm run demo:christmas-house -- --show            leave a window open, slowly orbiting
 *   npm run demo:christmas-house -- --out <dir>       write front.png and corner.png there
 *
 * FRAME TIME IS ROUGH: each sample is one emitWebGL3D call (shadow pass, visible pass and the
 * picking pass) followed by gl.finish and a one-pixel read, timed with performance.now. It is
 * wall-clock including CPU submission, not a GPU timer query.
 */

const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const show = args.includes("--show");
const outAt = args.indexOf("--out");
const outDir = outAt >= 0 ? path.resolve(args[outAt + 1]) : null;
const WIDTH = 1280, HEIGHT = 720;

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show, useContentSize: true, width: WIDTH, height: HEIGHT,
        title: "Canvas Fogworks - Christmas house", backgroundColor: "#000000",
        webPreferences: { sandbox: true, backgroundThrottling: false } });
    try {
        await win.loadURL(`data:text/html,<body style='margin:0;background:black;overflow:hidden'><canvas id='c' style='width:${WIDTH}px;height:${HEIGHT}px;display:block'></canvas></body>`);
        const root = path.resolve(__dirname, "..");
        const bundle = buildSync({ stdin: { resolveDir: root, contents:
            "export * from './src/renderer/emitWebGL3D'; export * from './src/renderer/ChristmasHouse3D';" },
            bundle: true, platform: "browser", format: "iife", globalName: "House3D", write: false }).outputFiles[0].text;
        await win.webContents.executeJavaScript(`${bundle}\nglobalThis.H = House3D; undefined;`);
        const result = await win.webContents.executeJavaScript(`(async () => {
            const canvas = document.getElementById("c"), gl = canvas.getContext("webgl", { alpha: false, depth: true, antialias: true });
            const halo = document.createElement("canvas"); halo.width = halo.height = 64;
            const g = halo.getContext("2d"), gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
            gradient.addColorStop(0, "rgba(255,255,255,1)"); gradient.addColorStop(0.25, "rgba(255,255,255,0.55)");
            gradient.addColorStop(0.6, "rgba(255,255,255,0.12)"); gradient.addColorStop(1, "rgba(255,255,255,0)");
            g.fillStyle = gradient; g.fillRect(0, 0, 64, 64);
            const haloUrl = halo.toDataURL();
            const scene = H.christmasHouseScene3D();
            const frame = name => H.christmasHouseFrame3D(scene, H.CHRISTMAS_HOUSE_VIEWS_3D[name], ${WIDTH} / ${HEIGHT}, haloUrl);
            // A never-shown window runs requestAnimationFrame at about 1 Hz, so warm-up waits on timers.
            const nextFrame = (ms = 100) => new Promise(resolve => ${show} ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, ms));
            const shots = {};
            for (const name of ["front", "corner"]) {
                const f = frame(name);
                for (let i = 0; i < 20; i++) { H.emitWebGL3D(canvas, f, 1); await nextFrame(); }
                H.emitWebGL3D(canvas, f, 1);
                shots[name] = canvas.toDataURL("image/png");
            }
            const pixel = new Uint8Array(4), samples = [];
            const timed = frame("front");
            for (let i = 0; i < 70; i++) {
                const start = performance.now();
                H.emitWebGL3D(canvas, timed, 1); gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                if (i >= 10) samples.push(performance.now() - start);
                await nextFrame();
            }
            samples.sort((a, b) => a - b);
            const info = gl.getExtension("WEBGL_debug_renderer_info");
            return { shots, renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
                lighting: H.webGL3DLighting(canvas), failure: H.lastWebGL3DFailure(),
                pointLights: scene.lights.filter(l => l.kind === "point").length, lights: scene.lights.length,
                draws: timed.draws.length, glError: gl.getError(),
                medianMs: samples[Math.floor(samples.length / 2)], p90Ms: samples[Math.floor(samples.length * 0.9)],
                width: canvas.width, height: canvas.height };
        })()`);
        const { shots, ...report } = result;
        if (outDir) {
            fs.mkdirSync(outDir, { recursive: true });
            for (const [name, url] of Object.entries(shots)) {
                const file = path.join(outDir, `${name}.png`);
                fs.writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
                report[`${name}Png`] = file;
            }
        }
        console.log(JSON.stringify(report, null, 2));
        if (!report.lighting || report.glError !== 0) throw new Error("Christmas house render failed.");
        if (!show) { app.exit(0); return; }
        await win.webContents.executeJavaScript(`(() => {
            const canvas = document.getElementById("c"), scene = H.christmasHouseScene3D(), halo = document.createElement("canvas");
            halo.width = halo.height = 64; const g = halo.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
            gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.25, "rgba(255,255,255,0.55)");
            gr.addColorStop(0.6, "rgba(255,255,255,0.12)"); gr.addColorStop(1, "rgba(255,255,255,0)");
            g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const url = halo.toDataURL(), t0 = performance.now();
            const tick = () => {
                const a = (performance.now() - t0) / 9000 * Math.PI * 2;
                const eye = [1.5 + Math.sin(a) * 16, 3.2, 1.2 + Math.cos(a) * 16];
                H.emitWebGL3D(canvas, H.christmasHouseFrame3D(scene, { eye, target: [1.5, 2.6, 0.5], fovDegrees: 48 }, ${WIDTH} / ${HEIGHT}, url), 1);
                requestAnimationFrame(tick);
            };
            tick();
        })()`);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
app.on("window-all-closed", () => app.exit(0));