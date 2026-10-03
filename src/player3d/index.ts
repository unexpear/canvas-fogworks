/** @module player3d @description Verifies the embedded payload digest and boots the standalone browser player without editor authority. */
import { createPackageReader, GAME_PACKAGE_LIMITS } from "../runtime/GamePackage";
import { PlayerSession3D } from "../runtime/PlayerSession3D";
import { mountPlayer3D } from "./PlayerHost3D";
import { installPackagedFonts } from "./packageFonts";
import { browserProgressStore, ProgressStore } from "../runtime/ProgressStore";

async function boot() {
    const element = document.getElementById("game-data");
    const data = element?.textContent ?? "", expected = element?.dataset.sha256 ?? "";
    if (!/^[a-f0-9]{64}$/.test(expected) || data.length > 4 * Math.ceil(GAME_PACKAGE_LIMITS.jsonBytes / 3)) throw new Error("Invalid embedded package.");
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    if ([...digest].map(byte => byte.toString(16).padStart(2, "0")).join("") !== expected) throw new Error("Package integrity check failed.");
    const host = createPackageReader(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    await installPackagedFonts(host.fonts);
    const diagnostics = document.getElementById("diagnostics");
    if (diagnostics && host.warnings.length) {
        diagnostics.hidden = false;
        diagnostics.dataset.count = String(host.warnings.length);
        diagnostics.textContent = host.warnings.map(warning => warning.detail).join("\n");
    }
    const fonts = document.getElementById("fonts");
    if (fonts) fonts.dataset.loaded = host.fonts.map(font => font.family).join("\n");
    const bridge = (window as Window & { playerProgress?: ProgressStore }).playerProgress;
    mountPlayer3D(new PlayerSession3D(host, host.entryKey, expected, host.saveMigrations), bridge ?? browserProgressStore(expected, host.saveMigrations));
}
void boot().catch(error => {
    const status = document.getElementById("status")!; status.dataset.state = "error";
    status.textContent = `Cannot start game: ${error instanceof Error ? error.message : String(error)}`;
    for (const button of document.querySelectorAll("button")) button.disabled = true;
});
