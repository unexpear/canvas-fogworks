/**
 * @module smoke-lighting
 * @description Verifies that the production Electron Chromium applies the URL-backed sRGB component-transfer filter used by Canvas lighting.
 */

const { app, BrowserWindow } = require("electron");

const timeout = setTimeout(() => {
    console.error("Lighting smoke timed out.");
    app.exit(1);
}, 15_000);

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
        await win.loadURL("data:text/html,<canvas id='c' width='1' height='1'></canvas>");
        const pixel = await win.webContents.executeJavaScript(`(async () => {
            const canvas = document.getElementById("c");
            const ctx = canvas.getContext("2d");
            const xml = '<svg xmlns="http://www.w3.org/2000/svg"><filter id="f" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="0.75"/><feFuncG type="linear" slope="0.25"/><feFuncB type="linear" slope="0.25"/></feComponentTransfer></filter></svg>';
            ctx.filter = 'url("data:image/svg+xml,' + encodeURIComponent(xml) + '#f")';
            await new Promise(resolve => setTimeout(resolve, 50));
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, 1, 1);
            return Array.from(ctx.getImageData(0, 0, 1, 1).data);
        })()`);
        const close = (actual, expected) => Math.abs(actual - expected) <= 2;
        if (!close(pixel[0], 191) || !close(pixel[1], 64) || !close(pixel[2], 64) || pixel[3] !== 255) {
            throw new Error(`Canvas lighting filter produced [${pixel.join(", ")}], expected approximately [191, 64, 64, 255].`);
        }
        clearTimeout(timeout);
        console.log("Lighting parity smoke passed (Electron Chromium Canvas filter).");
        app.exit(0);
    } catch (error) {
        clearTimeout(timeout);
        console.error(error);
        app.exit(1);
    }
});
