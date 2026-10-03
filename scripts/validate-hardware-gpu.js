/**
 * @module validate-hardware-gpu
 * @description Classifies a WebGL renderer and, when launched under Electron, draws one
 * frame so a host can record hardware-GPU evidence outside the software-rendered installer sandbox.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SOFTWARE_RENDERER_PATTERNS = [
    /swiftshader/i,
    /llvmpipe/i,
    /softpipe/i,
    /lavapipe/i,
    /microsoft basic render/i,
    /gdi generic/i,
    /software rasterizer/i,
    /mesa offscreen/i,
    /virgl/i
];

function classifyGpuRenderer(renderer) {
    const text = String(renderer ?? "").trim();
    if (!text) return { kind: "unknown", reason: "empty renderer string" };
    for (const pattern of SOFTWARE_RENDERER_PATTERNS) {
        if (pattern.test(text)) return { kind: "software", reason: pattern.source };
    }
    if (/angle/i.test(text) || /direct3d|d3d1[12]|metal|vulkan|opengl/i.test(text)) {
        return { kind: "hardware", reason: "gpu api without a software renderer token" };
    }
    if (/\b(nvidia|geforce|quadro)\b/i.test(text)
        || /\bradeon\b/i.test(text)
        || (/\bamd\b/i.test(text) && /\brx\b/i.test(text))
        || (/\bintel\b/i.test(text) && /\b(iris|uhd|hd graphics|arc)\b/i.test(text))) {
        return { kind: "hardware", reason: "named hardware adapter without a software renderer token" };
    }
    return { kind: "unknown", reason: "renderer is not a recognized hardware or software adapter" };
}

function hardwareGpuVerdict(renderer, options = {}) {
    const classification = classifyGpuRenderer(renderer);
    const drawOk = options.drawOk === true;
    return {
        evidenceKind: "host-hardware-gpu",
        renderer: renderer == null ? "" : String(renderer),
        classification: classification.kind,
        reason: classification.reason,
        drawOk,
        certifiesHardware: classification.kind === "hardware" && drawOk,
        sandbox: false,
        virtualGpu: "not-used"
    };
}

function writeHardwareGpuFile(file, verdict) {
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(verdict, null, 2)}\n`);
    return target;
}

module.exports = { classifyGpuRenderer, hardwareGpuVerdict, writeHardwareGpuFile, SOFTWARE_RENDERER_PATTERNS };

if (require.main === module) {
    const { app, BrowserWindow } = require("electron");
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-hardware-gpu-"));
    app.setPath("userData", profile);
    app.setPath("sessionData", profile);
    const timeout = setTimeout(() => { console.error("Hardware GPU validation timed out"); app.exit(1); }, 30000);
    app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: { sandbox: true } });
        try {
            await win.loadURL("data:text/html,<html><body></body></html>");
            const sample = await win.webContents.executeJavaScript(`(() => {
                const canvas = document.createElement('canvas');
                canvas.width = 64; canvas.height = 64;
                const gl = canvas.getContext('webgl');
                if (!gl || gl.isContextLost()) return { drawOk: false, renderer: '' };
                gl.clearColor(0.1, 0.2, 0.3, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
                const debug = gl.getExtension('WEBGL_debug_renderer_info');
                const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
                const vendor = debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
                return { drawOk: gl.getError() === gl.NO_ERROR, renderer: String(renderer || ''), vendor: String(vendor || '') };
            })()`);
            const verdict = {
                ...hardwareGpuVerdict(sample.renderer, { drawOk: sample.drawOk }),
                vendor: sample.vendor,
                recordedAt: new Date().toISOString()
            };
            const outAt = process.argv.indexOf("--out");
            const body = JSON.stringify(verdict, null, 2);
            if (outAt >= 0 && process.argv[outAt + 1]) writeHardwareGpuFile(process.argv[outAt + 1], verdict);
            console.log(body);
            clearTimeout(timeout);
            win.destroy();
            app.exit(verdict.certifiesHardware ? 0 : 2);
        } catch (error) {
            console.error(error);
            clearTimeout(timeout);
            app.exit(1);
        }
    });
    app.on("quit", () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still hold its disposable profile. */ } });
}
