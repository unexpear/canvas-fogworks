/**
 * @module player-exe-evidence.test
 * @description The EXPORT-001 checker scores a recorded file and stays open when none is supplied.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
    REQUIRED_CHECKS, readJsonFile, evaluatePlayerExeEvidence, runPlayerExeEvidenceCheck, writePlayerExeEvidencePlan
} = require("./playerExeEvidence");

function passingResult() {
    return {
        evidenceKind: "windows-clean-machine-player-exe",
        status: "passed",
        signing: false,
        publisherMetadata: false,
        authenticity: "unsigned",
        cleanMachine: true,
        hostDevSmoke: false,
        platform: "win32",
        profile: "spatial3d-v1",
        executable: "Canvas Fogworks Game.exe",
        checks: [...REQUIRED_CHECKS]
    };
}

test("a development-host or signed record cannot close the clean-machine gate", () => {
    assert.equal(evaluatePlayerExeEvidence(passingResult()).acceptable, true);
    const signed = { ...passingResult(), signing: true };
    assert.match(evaluatePlayerExeEvidence(signed).failures.join("\n"), /signing must be false/);
    const publisher = { ...passingResult(), publisher: "Example Studio" };
    assert.match(evaluatePlayerExeEvidence(publisher).failures.join("\n"), /exactly/);
    const hostSmoke = { ...passingResult(), hostDevSmoke: true };
    assert.match(evaluatePlayerExeEvidence(hostSmoke).failures.join("\n"), /development-host smoke/);
    const partial = { ...passingResult(), checks: REQUIRED_CHECKS.filter(check => check !== "streamed-payload") };
    assert.match(evaluatePlayerExeEvidence(partial).failures.join("\n"), /streamed-payload/);
});

test("the checker leaves EXPORT-001 open when no EXE evidence is supplied", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-player-exe-plan-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const dryRun = runPlayerExeEvidenceCheck(["--plan-out", temporary]);
    assert.equal(dryRun.exitCode, 2);
    assert.equal(dryRun.report.export001, "open");
    assert.equal(dryRun.report.evidenceAcceptable, false);
    assert.equal(dryRun.report.executedOnThisHost, false);
    assert.equal(dryRun.report.playerExeEvidence, "not-supplied");
    assert.equal(dryRun.report.cleanMachinePassRecorded, false);
    const operator = fs.readFileSync(path.join(temporary, "OPERATOR.txt"), "utf8");
    assert.match(operator, /not a clean-machine EXE pass/);
    assert.match(operator, /--stream/);
    assert.match(operator, /check:player-exe-evidence/);
    assert.match(operator, /Signing: omitted/);
    assert.match(operator, /streamed-payload/);
    const quoted = writePlayerExeEvidencePlan(temporary);
    assert.match(quoted.checkerCommand, /--result /);
    const bom = path.join(temporary, "bom.json");
    fs.writeFileSync(bom, `\uFEFF${JSON.stringify({ ok: true })}`);
    assert.deepEqual(readJsonFile(bom), { ok: true });
});

test("acceptable evidence still leaves the backlog gate open", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-player-exe-result-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const result = path.join(temporary, "result.json");
    fs.writeFileSync(result, JSON.stringify(passingResult()));
    const accepted = runPlayerExeEvidenceCheck(["--result", result]);
    assert.equal(accepted.exitCode, 0);
    assert.equal(accepted.report.evidenceAcceptable, true);
    assert.equal(accepted.report.export001, "open");
    assert.equal(accepted.report.executedOnThisHost, false);
    assert.match(accepted.report.note, /did not launch an executable/);
    fs.writeFileSync(result, JSON.stringify({ ...passingResult(), signing: true }));
    const rejected = runPlayerExeEvidenceCheck(["--result", result]);
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.report.export001, "open");
    assert.equal(rejected.report.evidenceAcceptable, false);
    assert.equal(runPlayerExeEvidenceCheck(["--mystery"]).exitCode, 1);
});

test("check-player-exe-evidence without a file exits 2", () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, "check-player-exe-evidence.js")], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.export001, "open");
    assert.equal(report.evidenceAcceptable, false);
    assert.equal(report.executedOnThisHost, false);
    assert.equal(report.playerExeEvidence, "not-supplied");
    assert.match(report.note, /not a clean-machine EXE pass/);
});
