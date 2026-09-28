const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isolateSmokeProfile } = require("../src/electron/smokeProfile");

test("normal launches never consult or change profile paths", () => {
    assert.equal(isolateSmokeProfile({}, false), null);
});

test("refuses late isolation", () => {
    assert.throws(() => isolateSmokeProfile({ isReady: () => true }, true), /before Electron is ready/);
});

test("smokes use separate existing temporary profiles for recovery and Chromium", t => {
    const profiles = [];
    t.after(() => {
        for (const profile of profiles) {
            assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
            assert.ok(path.basename(profile).startsWith("fogworks-smoke-profile-"));
            fs.rmSync(profile, { recursive: true, force: true });
        }
    });
    for (let i = 0; i < 2; i++) {
        const calls = [];
        const profile = isolateSmokeProfile({ isReady: () => false, setPath: (name, value) => {
            assert.ok(fs.statSync(value).isDirectory());
            calls.push([name, value]);
        } }, true);
        profiles.push(profile);
        assert.deepEqual(calls, [["userData", profile], ["sessionData", profile]]);
        assert.equal(fs.existsSync(path.join(profile, "project-recovery.json")), false);
    }
    assert.notEqual(profiles[0], profiles[1]);
});

test("an explicit smoke profile is reused instead of allocated", t => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-smoke-explicit-"));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const calls = [];
    const isolated = isolateSmokeProfile({ isReady: () => false, setPath: (name, value) => calls.push([name, value]) }, true, profile);
    assert.equal(isolated, path.resolve(profile));
    assert.deepEqual(calls, [["userData", path.resolve(profile)], ["sessionData", path.resolve(profile)]]);
    assert.equal(isolateSmokeProfile({ isReady: () => false, setPath: () => { throw new Error("normal launch"); } }, false, profile), null);
});
