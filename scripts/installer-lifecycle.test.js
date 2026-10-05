const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { releaseIdentityViolations } = require("./check-package");
const { assertMigratedHistoricalProject, historicalProjectDocument } = require("../src/electron/historicalMigration");
const { classifyGpuRenderer, finishHardwareGpuEvidence, hardwareGpuVerdict, writeHardwareGpuFile } = require("./validate-hardware-gpu");
const {
    guestLifecyclePhases, hostHardwareGpuPhase, readSchemaVersion, sandboxConfigurationXml,
    silentInstallArguments, silentUninstallArguments, defaultInputs, prepareInstallerSandbox
} = require("./installerLifecycle");
const {
    assertHarnessContract, evaluateGuestLifecycleResult, evaluateHardwareGpuEvidence,
    expectedGuestSmokeLogs, fieldsToGuestResult, readJsonFile, runInstallerEvidenceCheck, writeInstallerEvidencePlan
} = require("./installerEvidence");
const { runNormalizeGuestResult } = require("./normalize-guest-result");

const guestScript = fs.readFileSync(path.join(__dirname, "test-installer-sandbox.ps1"), "utf8");

test("repository package stays anonymous and unsigned", () => {
    assert.deepEqual(releaseIdentityViolations(require("../package.json")), []);
});

test("schema version is read from the document source", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/core/document/Document.ts"), "utf8");
    assert.match(readSchemaVersion(source), /^\d+$/);
    assert.throws(() => readSchemaVersion("export const SCHEMA_VERSION = 88;"), /SCHEMA_VERSION/);
});

test("historical save check rejects an unmigrated 0.0.4 project", () => {
    const raw = historicalProjectDocument();
    assert.equal(raw.version, "0.0.4");
    assert.throws(() => assertMigratedHistoricalProject(JSON.stringify(raw), "88"), /not migrated/);
    const migrated = JSON.parse(JSON.stringify(raw));
    migrated.version = "88";
    assert.deepEqual(assertMigratedHistoricalProject(JSON.stringify(migrated), "88"), {
        schema: "88", nodeId: "legacy-rect"
    });
    migrated.document.nodes["legacy-rect"].geometry.width = 11;
    assert.throws(() => assertMigratedHistoricalProject(JSON.stringify(migrated), "88"), /width/);
});

test("software renderers cannot certify hardware", () => {
    const hardware = "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)";
    assert.equal(classifyGpuRenderer(hardware).kind, "hardware");
    assert.equal(hardwareGpuVerdict(hardware, { drawOk: true }).certifiesHardware, true);
    assert.equal(hardwareGpuVerdict(hardware, { drawOk: false }).certifiesHardware, false);
    for (const renderer of [
        "Google SwiftShader",
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
        "llvmpipe (LLVM 15.0.7, 256 bits)",
        "Microsoft Basic Render Driver",
        ""
    ]) {
        assert.equal(hardwareGpuVerdict(renderer, { drawOk: true }).certifiesHardware, false, renderer);
    }
    for (const renderer of [
        "NVIDIA GeForce RTX 3060/PCIe/SSE2",
        "AMD Radeon RX 6800",
        "AMD RX 6800",
        "Intel(R) UHD Graphics 620",
        "Intel(R) Iris(R) Xe Graphics"
    ]) {
        assert.equal(classifyGpuRenderer(renderer).kind, "hardware", renderer);
    }
    assert.equal(classifyGpuRenderer("WebKit WebGL").kind, "unknown");
    assert.equal(hardwareGpuVerdict(hardware, { drawOk: true }).sandbox, false);
    assert.equal(hardwareGpuVerdict(hardware, { drawOk: true }).evidenceKind, "host-hardware-gpu");
    assert.equal(hardwareGpuVerdict(hardware, { drawOk: true }).virtualGpu, "not-used");
});

test("silent NSIS arguments keep scope flags and an unquoted final directory", () => {
    assert.equal(silentInstallArguments("allusers", "C:\\Fogworks\\PerMachine"), "/S /allusers /D=C:\\Fogworks\\PerMachine");
    assert.equal(silentUninstallArguments("currentuser", "C:\\Fogworks\\App"), "/S /currentuser _?=C:\\Fogworks\\App");
    assert.throws(() => silentInstallArguments("machine", "C:\\Fogworks"), /Unknown install scope/);
    assert.throws(() => silentInstallArguments("currentuser", 'C:\\Has"Quote'), /single NSIS/);
});

test("sandbox configuration keeps virtual GPU disabled and escapes mapped paths", () => {
    const xml = sandboxConfigurationXml({ input: "D:\\a&b", results: "D:\\c<d>" });
    assert.match(xml, /<vGPU>Disable<\/vGPU>/);
    assert.doesNotMatch(xml, /<vGPU>\s*Enable\s*<\/vGPU>/i);
    assert.match(xml, /D:\\a&amp;b/);
    assert.match(xml, /D:\\c&lt;d/);
    assert.match(xml, /<ReadOnly>true<\/ReadOnly>/);
    assert.match(xml, /<ReadOnly>false<\/ReadOnly>/);
    assert.match(xml, /test-installer-sandbox\.ps1/);
    assert.throws(() => sandboxConfigurationXml({ input: "", results: "D:\\out" }), /input and results/);
});

test("guest phases cover migration, assisted GUI and per-machine install, and the script names each one", () => {
    const phases = guestLifecyclePhases();
    const ids = phases.map(phase => phase.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(phases.some(phase => phase.smoke === "historical-migration"));
    assert.ok(phases.some(phase => phase.kind === "gui-install" && phase.scope === "currentuser"));
    assert.ok(phases.some(phase => phase.kind === "gui-install" && phase.scope === "allusers"));
    assert.ok(phases.some(phase => phase.kind === "silent-install" && phase.scope === "allusers"));
    assert.equal(phases.some(phase => phase.kind === "hardware"), false);
    for (const id of ids) assert.match(guestScript, new RegExp(id));
    assert.match(guestScript, /WDAGUtilityAccount/);
    assert.match(guestScript, /\/allusers/);
    assert.match(guestScript, /\/currentuser/);
    assert.match(guestScript, /\/S \$flag \/D=\$destination/);
    assert.match(guestScript, /\/S \$flag _\?=\$root/);
    assert.match(guestScript, /Only for/);
    assert.match(guestScript, /all users/);
    assert.match(guestScript, /CompanyName must stay blank/);
    assert.match(guestScript, /NotSigned/);
    assert.match(guestScript, /function Complete-Phase/);
    assert.match(guestScript, /evidenceKind = 'windows-sandbox-installer-lifecycle'/);
    assert.match(guestScript, /virtualGpu = 'disabled'/);
    assert.match(guestScript, /Complete-Phase 'unsigned-anonymous'/);
    assert.match(guestScript, /\$\{label\}-startup\.stdout\.log/);
    assert.match(guestScript, /normalize-guest-result\.js/);
    assert.match(guestScript, /--require-acceptable/);
    assert.match(guestScript, /SelectionItemPattern/);
    assert.match(guestScript, /This file is not a pass/);
    assert.match(guestScript, /scripts\\validate-hardware-gpu\.js/);
    assert.match(guestScript, /Guest evidence writer exited 0 without status passed/);
    assert.doesNotMatch(guestScript, /validate:hardware-gpu/);
    assert.doesNotMatch(guestScript, /hardware-gpu\.json/);
    const host = hostHardwareGpuPhase();
    assert.equal(host.runsInSandbox, false);
    assert.match(host.command, /validate:hardware-gpu -- --out /);
    assert.match(host.command, /hardware-gpu\.json/);
});

test("staging writes the historical project, the phase manifest and a software-rendered sandbox", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-lifecycle-test-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const file = name => {
        const target = path.join(temporary, name);
        fs.writeFileSync(target, `bytes-for-${name}`);
        return target;
    };
    const prepared = prepareInstallerSandbox({
        stageParent: temporary,
        expectedSchema: "88",
        packageJson: { name: "canvas-fogworks", version: "0.0.5", main: "dist/electron/main.js", build: { productName: "Canvas Fogworks" } },
        archive: file("archive.asar"),
        inputs: [
            [file("current.exe"), "current.exe"],
            [file("baseline.exe"), "baseline.exe"],
            [file("node.exe"), "node.exe"],
            [file("harness.ps1"), "test-installer-sandbox.ps1"],
            [file("smoke.js"), "scripts/smoke-startup.js"],
            [file("triangle.gltf"), "src/core/tests/fixtures/triangle.gltf"],
            [file("owned.vde"), "owned-example.vde"]
        ]
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(prepared.input, "manifest.json"), "utf8"));
    assert.equal(manifest.syntheticBaseline, true);
    assert.equal(manifest.historicalReleaseInstaller, false);
    assert.equal(manifest.publisherMetadata, false);
    assert.equal(manifest.signing, false);
    assert.equal(manifest.hardwareGpu.certifiedByThisSandbox, false);
    assert.equal(manifest.historical.sourceVersion, "0.0.4");
    assert.equal(manifest.historical.expectedSchema, "88");
    assert.deepEqual(manifest.phases.map(phase => phase.id), guestLifecyclePhases().map(phase => phase.id));
    const historical = JSON.parse(fs.readFileSync(path.join(prepared.input, manifest.historical.file), "utf8"));
    assert.equal(historical.version, "0.0.4");
    const xml = fs.readFileSync(prepared.configuration, "utf8");
    assert.match(xml, /<vGPU>Disable<\/vGPU>/);
    assert.doesNotMatch(xml, /Enable/);
    assert.match(prepared.hardwareGpuCommand, /npm run validate:hardware-gpu -- --out /);
    assert.match(prepared.hardwareGpuCommand, /hardware-gpu\.json/);
    assert.match(manifest.hardwareGpu.command, /--out /);
    assert.equal(manifest.hardwareGpu.certifiedByThisSandbox, false);
});

test("default staging inputs include the guest evidence writer", () => {
    const relative = defaultInputs("/repo", { build: { productName: "Canvas Fogworks" }, version: "0.0.5" }, "node.exe")
        .map(([, name]) => name);
    for (const name of [
        "scripts/normalize-guest-result.js",
        "scripts/installerEvidence.js",
        "scripts/installerLifecycle.js",
        "scripts/validate-hardware-gpu.js"
    ]) assert.ok(relative.includes(name), name);
});

test("staging refuses publisher metadata before copying installers", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-lifecycle-identity-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const file = name => {
        const target = path.join(temporary, name);
        fs.writeFileSync(target, "x");
        return target;
    };
    assert.throws(() => prepareInstallerSandbox({
        stageParent: temporary,
        expectedSchema: "88",
        packageJson: { name: "canvas-fogworks", version: "0.0.5", author: "Pat Example", build: { productName: "Canvas Fogworks" } },
        archive: file("archive.asar"),
        inputs: [[file("current.exe"), "current.exe"], [file("baseline.exe"), "baseline.exe"]]
    }), /author/);
});

function passingGuestResult() {
    return {
        status: "passed",
        evidenceKind: "windows-sandbox-installer-lifecycle",
        virtualGpu: "disabled",
        completedPhases: guestLifecyclePhases().map(phase => phase.id),
        hardwareGpuValidation: "not-certified-by-software-sandbox",
        syntheticBaseline: true,
        historicalReleaseInstaller: false,
        publisherMetadata: false,
        signing: false,
        installerSha256: "A".repeat(64),
        error: null
    };
}

function passingGpuRecord() {
    return {
        ...hardwareGpuVerdict("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", { drawOk: true }),
        hostname: "test-host",
        recordedAt: "2026-10-05T17:00:00.000Z"
    };
}

function writeSmokeLogs(directory) {
    for (const name of expectedGuestSmokeLogs()) {
        const body = name.endsWith(".stdout.log") ? "Startup smoke passed (packaged app).\n" : "";
        fs.writeFileSync(path.join(directory, name), body);
    }
}

test("harness contract matches the guest script and keeps virtual GPU disabled", () => {
    assert.equal(assertHarnessContract().ok, true);
    const broken = assertHarnessContract({ guestScript: "no phases here", sandboxXml: "<vGPU>Enable</vGPU>" });
    assert.equal(broken.ok, false);
    assert.ok(broken.failures.length >= 2);
});

test("guest evidence accepts a complete software-sandbox result and rejects hardware claims", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-evidence-guest-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    writeSmokeLogs(temporary);
    const passed = passingGuestResult();
    assert.equal(evaluateGuestLifecycleResult(passed, { resultsDir: temporary }).acceptable, true);
    assert.equal(evaluateGuestLifecycleResult(passed, { resultsDir: temporary }).certifiesHardwareGpu, false);
    const missingLog = fs.mkdtempSync(path.join(temporary, "empty-"));
    assert.match(evaluateGuestLifecycleResult(passed, { resultsDir: missingLog }).failures.join("\n"), /Missing smoke logs/);
    const claimed = { ...passed, hardwareGpuValidation: "certified", certifiesHardware: true };
    const claim = evaluateGuestLifecycleResult(claimed, { resultsDir: temporary });
    assert.equal(claim.acceptable, false);
    assert.match(claim.failures.join("\n"), /not-certified-by-software-sandbox/);
    assert.match(claim.failures.join("\n"), /cannot certify a hardware GPU/);
    const partial = { ...passed, completedPhases: "unsigned-anonymous", status: "failed", error: "GUI timed out" };
    const incomplete = evaluateGuestLifecycleResult(partial);
    assert.equal(incomplete.acceptable, false);
    assert.match(incomplete.failures.join("\n"), /fresh-per-user/);
    assert.match(incomplete.failures.join("\n"), /GUI timed out/);
});

test("hardware evidence is recomputed from the renderer string", () => {
    assert.equal(evaluateHardwareGpuEvidence(passingGpuRecord()).acceptable, true);
    const forged = { ...passingGpuRecord(), renderer: "Google SwiftShader", certifiesHardware: true, classification: "hardware" };
    const rejected = evaluateHardwareGpuEvidence(forged);
    assert.equal(rejected.acceptable, false);
    assert.match(rejected.failures.join("\n"), /does not certify hardware/);
    const sandbox = { ...passingGpuRecord(), sandbox: true };
    assert.match(evaluateHardwareGpuEvidence(sandbox).failures.join("\n"), /sandbox must be false/);
    const guestClaim = { ...passingGpuRecord(), virtualGpu: "disabled" };
    assert.match(evaluateHardwareGpuEvidence(guestClaim).failures.join("\n"), /not-used/);
    const undated = { ...passingGpuRecord() };
    delete undated.recordedAt;
    assert.match(evaluateHardwareGpuEvidence(undated).failures.join("\n"), /recordedAt/);
});

test("evidence checker leaves RELEASE-001 open when no Sandbox files are supplied", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-evidence-plan-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const dryRun = runInstallerEvidenceCheck(["--plan-out", temporary]);
    assert.equal(dryRun.exitCode, 2);
    assert.equal(dryRun.report.release001, "open");
    assert.equal(dryRun.report.evidenceAcceptable, false);
    assert.equal(dryRun.report.executedOnThisHost, false);
    assert.equal(dryRun.report.guestEvidence, "not-supplied");
    assert.equal(dryRun.report.sandboxPassRecorded, false);
    const operator = fs.readFileSync(path.join(temporary, "OPERATOR.txt"), "utf8");
    assert.match(operator, /not a Windows Sandbox pass/);
    assert.match(operator, /npm run check:installer-evidence --/);
    assert.match(operator, /validate:hardware-gpu -- --out /);
    assert.match(operator, /<vGPU>|virtual GPU: disabled/i);
    assert.match(operator, /staged Node writer/);
    assert.match(operator, /result\.fields\.txt/);
    assert.match(operator, /not evidence/);
    assert.match(operator, /User Account Control/);
    assert.match(operator, /Close Windows Sandbox after result\.json shows status passed/);
    assert.match(operator, /DESKTOP-2SB8IKI/);
    assert.match(operator, /Do not hand-write result\.json or hardware-gpu\.json/);
    assert.match(operator, /smoke passed/);
    assert.equal(dryRun.report.requiredHost, "DESKTOP-2SB8IKI");
    assert.equal(dryRun.report.hardwareGpuPassRecorded, false);
    const withSpace = writeInstallerEvidencePlan(temporary, { resultsDir: path.join(temporary, "results folder") });
    assert.match(withSpace.checkerCommand, /--guest "[^"]*results folder[/\\]result\.json"/);
    const bom = path.join(temporary, "bom.json");
    fs.writeFileSync(bom, `\uFEFF${JSON.stringify({ ok: true })}`);
    assert.deepEqual(readJsonFile(bom), { ok: true });
});

test("evidence checker accepts only a paired guest result and host GPU file", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-evidence-pair-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const guest = path.join(temporary, "result.json");
    const gpu = path.join(temporary, "hardware-gpu.json");
    writeSmokeLogs(temporary);
    fs.writeFileSync(guest, JSON.stringify(passingGuestResult()));
    fs.writeFileSync(gpu, JSON.stringify(passingGpuRecord()));
    const accepted = runInstallerEvidenceCheck(["--guest", guest, "--gpu", gpu]);
    assert.equal(accepted.exitCode, 0);
    assert.equal(accepted.report.evidenceAcceptable, true);
    assert.equal(accepted.report.release001, "open");
    assert.equal(accepted.report.executedOnThisHost, false);
    assert.match(accepted.report.note, /did not launch Windows Sandbox/);
    fs.writeFileSync(gpu, JSON.stringify({ ...passingGpuRecord(), renderer: "llvmpipe (LLVM 15.0.7, 256 bits)", certifiesHardware: true }));
    const rejected = runInstallerEvidenceCheck(["--guest", guest, "--gpu", gpu]);
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.report.release001, "open");
    assert.equal(rejected.report.evidenceAcceptable, false);
    assert.equal(runInstallerEvidenceCheck(["--guest", guest]).exitCode, 1);
    assert.equal(runInstallerEvidenceCheck(["--mystery"]).exitCode, 1);
});

test("check-installer-evidence without files exits 2", () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, "check-installer-evidence.js")], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.release001, "open");
    assert.equal(report.evidenceAcceptable, false);
    assert.equal(report.executedOnThisHost, false);
    assert.equal(report.guestEvidence, "not-supplied");
    assert.equal(report.hardwareGpuEvidence, "not-supplied");
    assert.equal(report.requiredHost, "DESKTOP-2SB8IKI");
    assert.equal(report.sandboxPassRecorded, false);
    assert.equal(report.hardwareGpuPassRecorded, false);
    assert.match(report.note, /not a Windows Sandbox pass/);
    assert.match(report.note, /DESKTOP-2SB8IKI/);
});

function evidenceField(name, value) {
    return `${name} ${Buffer.from(String(value), "utf8").toString("base64")}`;
}

function passingGuestFields() {
    return [
        evidenceField("status", "passed"),
        evidenceField("evidenceKind", "windows-sandbox-installer-lifecycle"),
        evidenceField("virtualGpu", "disabled"),
        evidenceField("hardwareGpuValidation", "not-certified-by-software-sandbox"),
        "syntheticBaseline true",
        "historicalReleaseInstaller false",
        "publisherMetadata false",
        "signing false",
        evidenceField("installerSha256", "A".repeat(64)),
        ...guestLifecyclePhases().map(phase => evidenceField("completed", phase.id)),
        evidenceField("step", "done \"quoted\"\nand wrapped"),
        "error ~",
        ""
    ].join("\n");
}

test("guest field writer emits checker-accepted JSON and does not publish a rejected pass", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-guest-fields-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const fields = path.join(temporary, "result.fields.txt");
    const guest = path.join(temporary, "result.json");
    fs.writeFileSync(fields, passingGuestFields());
    writeSmokeLogs(temporary);
    const accepted = runNormalizeGuestResult(["--fields", fields, "--out", guest, "--require-acceptable"]);
    assert.equal(accepted.exitCode, 0, accepted.errors.join("\n"));
    assert.equal(accepted.wrote, true);
    const written = readJsonFile(guest);
    assert.equal(evaluateGuestLifecycleResult(written, { resultsDir: temporary }).acceptable, true);
    assert.equal(written.certifiesHardware, undefined);
    assert.deepEqual(written.steps, ["done \"quoted\"\nand wrapped"]);
    const onePhase = path.join(temporary, "one.fields.txt");
    fs.writeFileSync(onePhase, [
        evidenceField("status", "passed"),
        evidenceField("evidenceKind", "windows-sandbox-installer-lifecycle"),
        evidenceField("virtualGpu", "disabled"),
        evidenceField("hardwareGpuValidation", "not-certified-by-software-sandbox"),
        "syntheticBaseline true",
        "historicalReleaseInstaller false",
        "publisherMetadata false",
        "signing false",
        evidenceField("completed", "unsigned-anonymous"),
        "error ~"
    ].join("\n"));
    const unwrapped = fieldsToGuestResult(fs.readFileSync(onePhase, "utf8"));
    assert.deepEqual(unwrapped.completedPhases, ["unsigned-anonymous"]);
    const rejectedOut = path.join(temporary, "rejected.json");
    const rejected = runNormalizeGuestResult(["--fields", onePhase, "--out", rejectedOut, "--require-acceptable"]);
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.wrote, false);
    assert.equal(fs.existsSync(rejectedOut), false);
    assert.match(rejected.errors.join("\n"), /Missing completed phases|completedPhases/);
    const stale = path.join(temporary, "stale.json");
    fs.writeFileSync(stale, JSON.stringify({ status: "passed", evidenceKind: "forged" }));
    const removed = runNormalizeGuestResult(["--fields", onePhase, "--out", stale]);
    assert.equal(removed.exitCode, 1);
    assert.equal(removed.wrote, false);
    assert.equal(fs.existsSync(stale), false);
    const omittedSigning = path.join(temporary, "unsigned-fields.txt");
    fs.writeFileSync(omittedSigning, passingGuestFields().replace("signing false\n", ""));
    const omittedOut = path.join(temporary, "omitted.json");
    const omitted = runNormalizeGuestResult(["--fields", omittedSigning, "--out", omittedOut]);
    assert.equal(omitted.exitCode, 1);
    assert.equal(omitted.wrote, false);
    assert.equal(fs.existsSync(omittedOut), false);
    assert.match(omitted.errors.join("\n"), /signing/);
    const withoutFlag = path.join(temporary, "without-flag.json");
    const unguarded = runNormalizeGuestResult(["--fields", fields, "--out", withoutFlag]);
    assert.equal(unguarded.exitCode, 0, unguarded.errors.join("\n"));
    assert.equal(unguarded.wrote, true);
    assert.equal(readJsonFile(withoutFlag).status, "passed");
});

test("loading the guest evidence writer does not load the archive checker", () => {
    const probe = spawnSync(process.execPath, ["-e", `
        require(${JSON.stringify(path.join(__dirname, "installerEvidence.js"))});
        const asarId = require.resolve("@electron/asar");
        if (require.cache[asarId]) process.exit(2);
    `], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
});

test("hardware GPU evidence file is created under a new directory", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-gpu-out-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const target = path.join(temporary, "nested", "hardware-gpu.json");
    writeHardwareGpuFile(target, passingGpuRecord());
    assert.equal(readJsonFile(target).evidenceKind, "host-hardware-gpu");
});

test("hardware GPU writer exits 0 only after the written file passes the host half", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-gpu-finish-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const deps = { readJsonFile, evaluate: evaluateHardwareGpuEvidence };
    const missing = finishHardwareGpuEvidence(passingGpuRecord(), "", deps);
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.wrote, false);
    const target = path.join(temporary, "hardware-gpu.json");
    const accepted = finishHardwareGpuEvidence(passingGpuRecord(), target, deps);
    assert.equal(accepted.exitCode, 0, accepted.errors.join("\n"));
    assert.equal(accepted.wrote, true);
    assert.equal(evaluateHardwareGpuEvidence(readJsonFile(target)).acceptable, true);
    const software = hardwareGpuVerdict("Google SwiftShader", { drawOk: true });
    const softwareFile = path.join(temporary, "software.json");
    const negative = finishHardwareGpuEvidence(software, softwareFile, deps);
    assert.equal(negative.exitCode, 2);
    assert.equal(negative.wrote, true);
    assert.equal(fs.existsSync(softwareFile), true);
    assert.equal(evaluateHardwareGpuEvidence(readJsonFile(softwareFile)).acceptable, false);
    const forged = path.join(temporary, "forged.json");
    const forgedVerdict = { ...passingGpuRecord(), renderer: "Google SwiftShader", certifiesHardware: true, classification: "hardware" };
    assert.throws(() => writeHardwareGpuFile(forged, forgedVerdict), /does not certify hardware/);
    assert.equal(fs.existsSync(forged), false);
    const weak = path.join(temporary, "weak-stdout");
    fs.mkdirSync(weak);
    writeSmokeLogs(weak);
    const stdout = expectedGuestSmokeLogs().find(name => name.endsWith(".stdout.log"));
    fs.writeFileSync(path.join(weak, stdout), "still running\n");
    assert.match(evaluateGuestLifecycleResult(passingGuestResult(), { resultsDir: weak }).failures.join("\n"), /smoke passed/);
});
