/**
 * @module installerLifecycle
 * @description Plans the offline Sandbox installer lifecycle and stages its inputs.
 * The guest stays software-rendered. Hardware-GPU evidence is a separate host command.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const HISTORICAL_PROJECT_FILE = "historical-release-0.0.4.vde";
const SYNTHETIC_BASELINE_VERSION = "0.0.4";

const GUEST_PHASES = [
    { id: "unsigned-anonymous", kind: "identity" },
    { id: "fresh-per-user", kind: "silent-install", scope: "currentuser", installer: "current" },
    { id: "fresh-startup-smoke", kind: "smoke", smoke: "startup" },
    { id: "fresh-workflow-smoke", kind: "smoke", smoke: "workflow" },
    { id: "fresh-historical-migration", kind: "smoke", smoke: "historical-migration" },
    { id: "fresh-uninstall", kind: "uninstall", scope: "currentuser" },
    { id: "synthetic-baseline", kind: "silent-install", scope: "currentuser", installer: "baseline" },
    { id: "upgrade-per-user", kind: "silent-install", scope: "currentuser", installer: "current" },
    { id: "upgraded-startup-smoke", kind: "smoke", smoke: "startup" },
    { id: "upgraded-workflow-smoke", kind: "smoke", smoke: "workflow" },
    { id: "upgraded-historical-migration", kind: "smoke", smoke: "historical-migration" },
    { id: "upgraded-uninstall", kind: "uninstall", scope: "currentuser" },
    { id: "per-machine-silent", kind: "silent-install", scope: "allusers", installer: "current" },
    { id: "per-machine-startup-smoke", kind: "smoke", smoke: "startup" },
    { id: "per-machine-historical-migration", kind: "smoke", smoke: "historical-migration" },
    { id: "per-machine-uninstall", kind: "uninstall", scope: "allusers" },
    { id: "gui-per-user", kind: "gui-install", scope: "currentuser", installer: "current" },
    { id: "gui-per-user-startup-smoke", kind: "smoke", smoke: "startup" },
    { id: "gui-per-user-historical-migration", kind: "smoke", smoke: "historical-migration" },
    { id: "gui-per-user-uninstall", kind: "uninstall", scope: "currentuser" },
    { id: "gui-per-machine", kind: "gui-install", scope: "allusers", installer: "current" },
    { id: "gui-per-machine-startup-smoke", kind: "smoke", smoke: "startup" },
    { id: "gui-per-machine-historical-migration", kind: "smoke", smoke: "historical-migration" },
    { id: "gui-per-machine-uninstall", kind: "uninstall", scope: "allusers" }
];

function guestLifecyclePhases() {
    return GUEST_PHASES.map(phase => ({ ...phase }));
}

function quoteCommandArg(value) {
    const text = String(value);
    if (!/[\s&|<>^"]/.test(text)) return text;
    return `"${text.replace(/"/g, '\\"')}"`;
}

function hostHardwareGpuPhase(resultsFile) {
    const target = resultsFile || "SANDBOX_RESULTS\\hardware-gpu.json";
    return {
        id: "host-hardware-gpu",
        runsInSandbox: false,
        command: `npm run validate:hardware-gpu -- --out ${quoteCommandArg(target)}`,
        reason: "Virtual GPU stays disabled because it crashed Desktop Window Manager. Hardware evidence is collected on the host, outside Sandbox, and written to hardware-gpu.json."
    };
}

function readSchemaVersion(sourceText) {
    const match = String(sourceText).match(/export const SCHEMA_VERSION = "(\d+)";/);
    if (!match) throw new Error("SCHEMA_VERSION was not found in the document source.");
    return match[1];
}

function sha256File(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

function xmlEscape(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sandboxConfigurationXml({ input, results }) {
    if (!input || !results) throw new Error("Sandbox configuration needs input and results folders.");
    return `<Configuration>
  <vGPU>Disable</vGPU>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <MemoryInMB>4096</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>${xmlEscape(input)}</HostFolder><SandboxFolder>C:\\FogworksInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${xmlEscape(results)}</HostFolder><SandboxFolder>C:\\FogworksResults</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\FogworksInput\\test-installer-sandbox.ps1</Command></LogonCommand>
</Configuration>
`;
}

function silentInstallArguments(scope, destination) {
    if (scope !== "currentuser" && scope !== "allusers") throw new Error(`Unknown install scope: ${scope}`);
    if (!destination || /["\r\n]/.test(destination)) throw new Error("Installation path is not a single NSIS /D= argument.");
    return `/S /${scope} /D=${destination}`;
}

function silentUninstallArguments(scope, destination) {
    if (scope !== "currentuser" && scope !== "allusers") throw new Error(`Unknown install scope: ${scope}`);
    if (!destination || /["\r\n]/.test(destination)) throw new Error("Installation path is not a single NSIS _?= argument.");
    return `/S /${scope} _?=${destination}`;
}

function defaultInputs(root, pkg, nodePath) {
    const installer = path.join(root, "release", `${pkg.build.productName} Setup ${pkg.version}.exe`);
    const baseline = path.join(root, "release/installer-test-baseline", `TEST-ONLY-baseline-${SYNTHETIC_BASELINE_VERSION}.exe`);
    return [
        [installer, "current.exe"],
        [baseline, "baseline.exe"],
        [nodePath, "node.exe"],
        [path.join(root, "scripts/test-installer-sandbox.ps1"), "test-installer-sandbox.ps1"],
        [path.join(root, "scripts/normalize-guest-result.js"), "scripts/normalize-guest-result.js"],
        [path.join(root, "scripts/installerEvidence.js"), "scripts/installerEvidence.js"],
        [path.join(root, "scripts/installerLifecycle.js"), "scripts/installerLifecycle.js"],
        [path.join(root, "scripts/validate-hardware-gpu.js"), "scripts/validate-hardware-gpu.js"],
        [path.join(root, "scripts/smoke-startup.js"), "scripts/smoke-startup.js"],
        [path.join(root, "src/core/tests/fixtures/triangle.gltf"), "src/core/tests/fixtures/triangle.gltf"],
        [path.join(root, "reference-projects/visual.vde"), "owned-example.vde"]
    ];
}

function prepareInstallerSandbox(options = {}) {
    const { releaseIdentityViolations } = require("./check-package");
    const { historicalProjectDocument, HISTORICAL_SOURCE_VERSION, HISTORICAL_NODE_ID } = require("../src/electron/historicalMigration");
    const root = options.root ?? path.resolve(__dirname, "..");
    const pkg = options.packageJson ?? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const violations = releaseIdentityViolations(pkg);
    if (violations.length) throw new Error(`Refusing to stage installer inputs: ${violations.join(", ")}`);
    const expectedSchema = options.expectedSchema ?? readSchemaVersion(fs.readFileSync(path.join(root, "src/core/document/Document.ts"), "utf8"));
    if (!/^\d+$/.test(expectedSchema)) throw new Error(`Expected schema is not numeric: ${expectedSchema}`);
    const inputs = options.inputs ?? defaultInputs(root, pkg, options.nodePath ?? process.execPath);
    const archive = options.archive ?? path.join(root, "release/win-unpacked/resources/app.asar");
    for (const [source] of inputs) {
        if (!fs.statSync(source).isFile()) throw new Error(`Required input is not a file: ${source}`);
    }
    if (!fs.statSync(archive).isFile()) throw new Error(`Required input is not a file: ${archive}`);
    const stageParent = options.stageParent ?? os.tmpdir();
    const stage = fs.mkdtempSync(path.join(stageParent, "fogworks-installer-sandbox-"));
    const input = path.join(stage, "input");
    const results = path.join(stage, "results");
    fs.mkdirSync(results);
    for (const [source, relative] of inputs) {
        const target = path.join(input, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
    const historical = historicalProjectDocument();
    const historicalPath = path.join(input, HISTORICAL_PROJECT_FILE);
    fs.writeFileSync(historicalPath, `${JSON.stringify(historical, null, 2)}\n`, { flag: "wx" });
    const byRelative = new Map(inputs.map(([source, relative]) => [relative, source]));
    for (const name of ["current.exe", "baseline.exe"]) {
        if (!byRelative.has(name)) throw new Error(`Installer staging inputs must include ${name}`);
    }
    const hardwareGpu = hostHardwareGpuPhase(path.join(results, "hardware-gpu.json"));
    const manifest = {
        version: pkg.version,
        baselineVersion: SYNTHETIC_BASELINE_VERSION,
        syntheticBaseline: true,
        historicalReleaseInstaller: false,
        publisherMetadata: false,
        signing: false,
        installerSha256: sha256File(byRelative.get("current.exe")),
        baselineSha256: sha256File(byRelative.get("baseline.exe")),
        archiveSha256: sha256File(archive),
        historical: {
            file: HISTORICAL_PROJECT_FILE,
            sourceVersion: historical.version,
            expectedSchema,
            nodeId: HISTORICAL_NODE_ID,
            sha256: sha256File(historicalPath)
        },
        phases: guestLifecyclePhases(),
        hardwareGpu: {
            certifiedByThisSandbox: false,
            command: hardwareGpu.command,
            reason: hardwareGpu.reason
        }
    };
    if (manifest.historical.sourceVersion !== HISTORICAL_SOURCE_VERSION) {
        throw new Error("Historical fixture drifted from the 0.0.4 project format.");
    }
    fs.writeFileSync(path.join(input, "manifest.json"), JSON.stringify(manifest, null, 2));
    const configuration = path.join(stage, "installer-test.wsb");
    const xml = sandboxConfigurationXml({ input, results });
    if (!xml.includes("<vGPU>Disable</vGPU>") || /<vGPU>\s*Enable\s*<\/vGPU>/i.test(xml)) {
        throw new Error("Installer sandbox must keep virtual GPU disabled.");
    }
    fs.writeFileSync(configuration, xml);
    return { configuration, results, stage, input, manifest, hardwareGpuCommand: hardwareGpu.command };
}

module.exports = {
    GUEST_PHASES, HISTORICAL_PROJECT_FILE, SYNTHETIC_BASELINE_VERSION,
    guestLifecyclePhases, hostHardwareGpuPhase, quoteCommandArg, readSchemaVersion, sandboxConfigurationXml,
    silentInstallArguments, silentUninstallArguments, defaultInputs, prepareInstallerSandbox
};
