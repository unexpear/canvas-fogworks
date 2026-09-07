/**
 * @module smokeProfile
 * @description Isolates startup and project smoke recovery/storage from the user's
 * normal profile before Electron becomes ready; normal launches are unchanged.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function isolateSmokeProfile(app, enabled) {
    if (!enabled) return null;
    if (app.isReady()) throw new Error("Smoke profile must be configured before Electron is ready.");
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-smoke-profile-"));
    app.setPath("userData", profile);
    app.setPath("sessionData", profile);
    return profile;
}

module.exports = { isolateSmokeProfile };
