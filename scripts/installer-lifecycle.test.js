const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { releaseIdentityViolations } = require("./check-package");
const { assertMigratedHistoricalProject, historicalProjectDocument } = require("../src/electron/historicalMigration");
const { classifyGpuRenderer, hardwareGpuVerdict } = require("./validate-hardware-gpu");
const {
    guestLifecyclePhases, hostHardwareGpuPhase, readSchemaVersion, sandboxConfigurationXml,
    silentInstallArguments, silentUninstallArguments, prepareInstallerSandbox
} = require("./installerLifecycle");

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
    assert.equal(classifyGpuRenderer("WebKit WebGL").kind, "unknown");
    assert.equal(hardwareGpuVerdict(hardware, { drawOk: true }).sandbox, false);
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
    assert.doesNotMatch(guestScript, /validate-hardware-gpu/);
    const host = hostHardwareGpuPhase();
    assert.equal(host.runsInSandbox, false);
    assert.match(host.command, /validate:hardware-gpu/);
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
    assert.equal(prepared.hardwareGpuCommand, "npm run validate:hardware-gpu");
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
