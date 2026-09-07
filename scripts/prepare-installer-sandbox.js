/**
 * @module prepare-installer-sandbox
 * @description Stages only installer-test inputs and generates an offline Windows
 * Sandbox configuration. Does not launch or install anything on the host.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const installer = path.join(root, "release", `${pkg.build.productName} Setup ${pkg.version}.exe`);
const baseline = path.join(root, "release/installer-test-baseline/TEST-ONLY-baseline-0.0.4.exe");
const copies = [
    [installer, "current.exe"], [baseline, "baseline.exe"], [process.execPath, "node.exe"],
    [path.join(__dirname, "test-installer-sandbox.ps1"), "test-installer-sandbox.ps1"],
    [path.join(__dirname, "smoke-startup.js"), "scripts/smoke-startup.js"],
    [path.join(root, "src/core/tests/fixtures/triangle.gltf"), "src/core/tests/fixtures/triangle.gltf"],
    [path.join(root, "reference-projects/visual.vde"), "owned-example.vde"]
];
for (const [source] of copies) {
    if (!fs.statSync(source).isFile()) throw new Error(`Required input is not a file: ${source}`);
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-installer-sandbox-"));
const input = path.join(stage, "input");
const output = path.join(stage, "results");
fs.mkdirSync(output);
for (const [source, relative] of copies) {
    const target = path.join(input, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
fs.writeFileSync(path.join(input, "manifest.json"), JSON.stringify({
    version: pkg.version, baselineVersion: "0.0.4", syntheticBaseline: true,
    installerSha256: hash(installer), baselineSha256: hash(baseline),
    archiveSha256: hash(path.join(root, "release/win-unpacked/resources/app.asar"))
}, null, 2));
const xml = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
fs.writeFileSync(path.join(stage, "installer-test.wsb"), `<Configuration>
  <vGPU>Disable</vGPU>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <MemoryInMB>4096</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>${xml(input)}</HostFolder><SandboxFolder>C:\\FogworksInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${xml(output)}</HostFolder><SandboxFolder>C:\\FogworksResults</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\FogworksInput\\test-installer-sandbox.ps1</Command></LogonCommand>
</Configuration>
`);
console.log(JSON.stringify({ configuration: path.join(stage, "installer-test.wsb"), results: output }, null, 2));
