/** @module desktopMain @description Dedicated unsigned player executable entry; loads only its bundled game, never the editor. */
const { app, dialog } = require("electron");
const path = require("path");
const { createGameWindow } = require("./desktopWindow");
const smoke = process.env.FOGWORKS_PLAYER_SMOKE === "1";
if (smoke) {
    const profile = require("fs").mkdtempSync(path.join(require("os").tmpdir(), "fogworks-player-startup-"));
    app.setPath("userData", profile);
}
app.whenReady().then(async () => {
    const win = await createGameWindow(path.join(__dirname, "game.html"), { show: !smoke });
    if (!smoke) return;
    win.webContents.setBackgroundThrottling(false);
    const ready = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 15000;
        const check = () => {
            const status = document.getElementById('status');
            if (status.dataset.state === 'error') return reject(new Error(status.textContent));
            if (document.getElementById('scene').dataset.presented === 'true') {
                if (typeof require !== 'undefined' || window.electronAPI) return reject(new Error('Unexpected player authority'));
                document.getElementById('stop').click();
                if (status.dataset.state !== 'stopped') return reject(new Error('Stop failed'));
                return resolve(true);
            }
            if (performance.now() > deadline) return reject(new Error('Player startup timed out'));
            setTimeout(check, 30);
        }; check();
    })`);
    if (!ready) throw new Error("Player startup failed");
    console.log("FOGWORKS_PLAYER_STARTUP_READY"); app.exit(0);
}).catch(error => {
    if (smoke) console.error(error.message); else dialog.showErrorBox("Cannot start game", error.message);
    app.exit(1);
});
app.on("window-all-closed", () => app.quit());
