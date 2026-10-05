/**
 * @module benchmark-budgets.test
 * @description Locks the SCALE-001 budget formula and the soak retention rule.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
    calibrateMs, soakRetainedAccounted, soakTailPlateaued, RECORDED_P95_MS, RELEASE_BUDGETS_MS,
    PRIOR_WINDOWS_IRIS_XE, GPU_IRIS_XE_P95_MS, GPU_HARDWARE_BUDGETS_MS, GPU_ADMISSION_WORKLOADS, FROZEN_CPU_HOSTS, FROZEN_GPU_HOSTS, CI_GATE_ENABLED,
    normalizeHostSample, compareHostSample, previewHardwareAdmission, frozenGpuCohortReport, hardwareAdmissionRoster, mergeHostSamples, loadHostSampleDirectory,
    hostSampleFromAuthoringReport, hostSampleFromGpuReport, hostSampleFromBenchmarkReport
} = require("./benchmark-budgets");

test("frozen release budgets match 1.5× the recorded samples", () => {
    for (const [name, samples] of Object.entries(RECORDED_P95_MS)) {
        assert.equal(RELEASE_BUDGETS_MS[name], calibrateMs(samples), name);
    }
    for (const [name, samples] of Object.entries(GPU_IRIS_XE_P95_MS)) {
        assert.equal(GPU_HARDWARE_BUDGETS_MS[name], calibrateMs(samples), name);
    }
    assert.equal(GPU_HARDWARE_BUDGETS_MS["pixel-workshop"], 3.2);
    assert.equal(GPU_HARDWARE_BUDGETS_MS.relay, 3.5);
    assert.equal(GPU_HARDWARE_BUDGETS_MS["animated-meshes-100"], 2.8);
});

test("release budgets are 1.5× the highest sample, rounded up to 0.1 ms", () => {
    assert.equal(calibrateMs([3.934, 4]), 6);
    assert.equal(calibrateMs([1.12]), 1.7);
    assert.equal(calibrateMs([]), null);
    assert.equal(calibrateMs([Number.NaN, -1]), null);
});

test("frozen cohort is exactly the budget input", () => {
    assert.equal(CI_GATE_ENABLED, false);
    assert.deepEqual(RELEASE_BUDGETS_MS, {
        "animated-meshes-100": 3.9,
        "asset-reload": 2.1,
        "components-500": 6.7,
        "gameplay-100": 6.7,
        "pixel-workshop-frame": 1.7,
        "raster-1024-decode": 5.8,
        "raster-1024-encode": 10.4,
        "raster-2048-noisy-decode": 41.6,
        "raster-2048-noisy-encode": 696.6,
        "rect-1000-frame": 9.4,
        "rect-1000-load": 17.8,
        "rect-250-frame": 5.2,
        "rect-250-load": 6,
        "relay-frame": 0.5,
        "skin-3000": 10.7,
        "textured-billboards-80": 0.6,
        "textured-rasters-frame": 774.9
    });
    const grouped = {};
    for (const host of FROZEN_CPU_HOSTS) {
        for (const [name, value] of Object.entries(host.p95Ms)) {
            grouped[name] = (grouped[name] ?? []).concat(Array.isArray(value) ? value : [value]);
        }
    }
    assert.deepEqual(Object.keys(grouped).sort(), Object.keys(RECORDED_P95_MS).sort());
    for (const [name, samples] of Object.entries(RECORDED_P95_MS)) {
        assert.deepEqual([...grouped[name]].sort((a, b) => a - b), [...samples].sort((a, b) => a - b), name);
    }
    assert.equal(FROZEN_GPU_HOSTS.length, 1);
    assert.deepEqual([...GPU_ADMISSION_WORKLOADS].sort(), Object.keys(GPU_HARDWARE_BUDGETS_MS).sort());
    const gpuGrouped = {};
    for (const host of FROZEN_GPU_HOSTS) {
        assert.equal(host.kind, "gpu");
        assert.equal(host.rendererKind, "hardware");
        for (const [name, value] of Object.entries(host.p95Ms)) {
            gpuGrouped[name] = (gpuGrouped[name] ?? []).concat(Array.isArray(value) ? value : [value]);
        }
    }
    assert.deepEqual(Object.keys(gpuGrouped).sort(), Object.keys(GPU_IRIS_XE_P95_MS).sort());
    for (const [name, samples] of Object.entries(GPU_IRIS_XE_P95_MS)) {
        assert.deepEqual([...gpuGrouped[name]].sort((a, b) => a - b), [...samples].sort((a, b) => a - b), name);
        assert.deepEqual(samples, [FROZEN_GPU_HOSTS[0].p95Ms[name]], name);
    }
    RELEASE_BUDGETS_MS["rect-250-frame"] = 1;
    GPU_HARDWARE_BUDGETS_MS["pixel-workshop"] = 1;
    assert.equal(RELEASE_BUDGETS_MS["rect-250-frame"], 5.2);
    assert.equal(GPU_HARDWARE_BUDGETS_MS["pixel-workshop"], 3.2);
});

test("an additional sample compares without moving frozen budgets", () => {
    const cpuBefore = JSON.stringify(RELEASE_BUDGETS_MS);
    const gpuBefore = JSON.stringify(GPU_HARDWARE_BUDGETS_MS);
    const sample = normalizeHostSample({
        id: "example-faster-cpu",
        recorded: "2026-09-28",
        kind: "cpu",
        rendererKind: "cpu",
        p95Ms: { "rect-250-frame": 10, "rect-1000-frame": 1 }
    });
    const comparison = compareHostSample(sample);
    const slow = comparison.rows.find(row => row.workload === "rect-250-frame");
    const fast = comparison.rows.find(row => row.workload === "rect-1000-frame");
    assert.equal(comparison.movesFrozenBudgets, false);
    assert.equal(comparison.ciGateEnabled, false);
    assert.equal(comparison.admitted, false);
    assert.equal(comparison.excludedFromHardwareBudget, true);
    assert.equal(slow.overFrozenBudget, true);
    assert.equal(slow.admitted, false);
    assert.equal(slow.previewBudgetMs, calibrateMs([3.430, 0.977, 10]));
    assert.equal(fast.overFrozenBudget, false);
    assert.equal(RELEASE_BUDGETS_MS["rect-250-frame"], 5.2);
    const merged = mergeHostSamples([], [sample, sample]);
    assert.equal(merged.samples.length, 1);
    assert.equal(merged.movesFrozenBudgets, false);
    assert.throws(() => mergeHostSamples(merged.samples, [{ ...sample, p95Ms: { "rect-250-frame": 11 } }]), /different contents/);
    assert.throws(() => mergeHostSamples([], [{ ...sample, id: "windows-x64-node-24.15.0-iris-xe-2026-09-07" }]), /frozen cohort/);
    assert.equal(JSON.stringify(RELEASE_BUDGETS_MS), cpuBefore);
    assert.equal(JSON.stringify(GPU_HARDWARE_BUDGETS_MS), gpuBefore);
});

test("software GL is recorded and kept out of the hardware budget", () => {
    assert.throws(() => normalizeHostSample({
        id: "mislabeled-llvmpipe",
        recorded: "2026-09-28",
        kind: "gpu",
        rendererKind: "hardware",
        renderer: "llvmpipe (LLVM 15.0.7, 256 bits)",
        p95Ms: { "pixel-workshop": 40 }
    }), /cannot be hardware/);
    const sample = hostSampleFromGpuReport({
        available: true,
        platform: "linux",
        cpu: "Intel(R) Xeon(R) Processor",
        results: [
            { name: "pixel-workshop", renderer: "llvmpipe (LLVM 15.0.7, 256 bits)", cpuSubmissionP95Ms: 9, gpuP95Ms: 20 },
            { name: "relay-1.vde", renderer: "llvmpipe (LLVM 15.0.7, 256 bits)", cpuSubmissionP95Ms: 2, gpuP95Ms: 8 },
            { name: "relay-2.vde", renderer: "llvmpipe (LLVM 15.0.7, 256 bits)", cpuSubmissionP95Ms: 3, gpuP95Ms: 4 },
            { name: "animated-meshes-100", renderer: "llvmpipe (LLVM 15.0.7, 256 bits)", cpuSubmissionP95Ms: 5, gpuP95Ms: null }
        ]
    }, { id: "linux-llvmpipe-fixture", recorded: "2026-09-28" });
    assert.equal(sample.rendererKind, "software");
    assert.equal(sample.admitsToHardwareBudget, false);
    assert.equal(sample.p95Ms["pixel-workshop"], 20);
    assert.equal(sample.p95Ms.relay, 8);
    assert.equal(sample.p95Ms["animated-meshes-100"], undefined);
    assert.equal(sample.cpuSubmissionP95Ms["animated-meshes-100"], 5);
    assert.equal(sample.stageP95Ms["relay-1.vde"], 8);
    assert.equal(sample.relayAggregation, "max-stage-gpu-p95");
    const comparison = compareHostSample(sample);
    assert.equal(comparison.excludedFromHardwareBudget, true);
    assert.equal(comparison.ciGateEnabled, false);
    const workshop = comparison.rows.find(row => row.workload === "pixel-workshop");
    assert.equal(workshop.measuredMs, 20);
    assert.equal(workshop.frozenBudgetMs, 3.2);
    assert.equal(workshop.admitted, false);
    assert.equal(workshop.previewBudgetMs, calibrateMs([2.076, 20]));
    mergeHostSamples([], [sample]);
    assert.equal(GPU_HARDWARE_BUDGETS_MS["pixel-workshop"], 3.2);
    assert.equal(GPU_HARDWARE_BUDGETS_MS.relay, 3.5);
});

test("hardware timings and missing WebGL do not invent a gate", () => {
    const hardware = hostSampleFromGpuReport({
        available: true,
        results: [{
            name: "pixel-workshop",
            renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
            cpuSubmissionP95Ms: 50,
            gpuP95Ms: 9
        }]
    }, { id: "second-iris-xe", recorded: "2026-09-28" });
    assert.equal(hardware.rendererKind, "hardware");
    const row = compareHostSample(hardware).rows.find(item => item.workload === "pixel-workshop");
    assert.equal(row.measuredMs, 9);
    assert.equal(row.admitted, false);
    assert.equal(compareHostSample(hardware).excludedFromHardwareBudget, false);
    assert.equal(GPU_HARDWARE_BUDGETS_MS["pixel-workshop"], 3.2);
    const missing = hostSampleFromGpuReport({
        available: false,
        reason: "WebGL1 context unavailable",
        results: []
    }, { id: "no-webgl", recorded: "2026-09-28" });
    assert.equal(missing.rendererKind, "unavailable");
    assert.deepEqual(missing.p95Ms, {});
    assert.equal(compareHostSample(missing).rows.length, 0);
    assert.throws(() => normalizeHostSample({
        id: "zero-as-missing",
        recorded: "2026-09-28",
        kind: "gpu",
        rendererKind: "unavailable",
        p95Ms: { "pixel-workshop": 0 }
    }), /cannot carry timings/);
    assert.throws(() => hostSampleFromGpuReport({
        available: true,
        results: [
            { name: "pixel-workshop", renderer: "llvmpipe", gpuP95Ms: 1 },
            { name: "relay", renderer: "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", gpuP95Ms: 1 }
        ]
    }, { id: "mixed", recorded: "2026-09-28" }), /more than one renderer/);
});

test("authoring and gpu reports normalize into recordable samples", () => {
    const authoring = hostSampleFromAuthoringReport({
        platform: "linux",
        arch: "x64",
        cpu: "Intel(R) Xeon(R) Processor",
        cpuCount: 4,
        totalMemMiB: 16000,
        node: "v22.14.0",
        gcControlled: true,
        releaseComparison: {
            "rect-250-frame": { measuredMs: 1.25 },
            "relay-frame": { measuredMs: 0.4 }
        }
    }, { id: "linux-xeon-again-cpu", recorded: "2026-09-28" });
    assert.equal(authoring.kind, "cpu");
    assert.equal(authoring.rendererKind, "cpu");
    assert.equal(authoring.admitsToReleaseBudget, false);
    assert.equal(authoring.p95Ms["rect-250-frame"], 1.25);
    assert.equal(authoring.host.gcControlled, true);
    const reread = hostSampleFromBenchmarkReport(authoring, { id: authoring.id, recorded: authoring.recorded });
    assert.deepEqual(reread, authoring);
});

test("the 2026-09-28 cloud samples keep cpu, unavailable, and software labels", () => {
    const samples = loadHostSampleDirectory(path.join(__dirname, "benchmark-host-samples"));
    const byId = Object.fromEntries(samples.map(sample => [sample.id, sample]));
    const cpu = byId["linux-x64-xeon-cloud-2026-09-28-cpu"];
    const missing = byId["linux-x64-xeon-cloud-2026-09-28-gpu-unavailable"];
    const software = byId["linux-x64-xeon-cloud-2026-09-28-llvmpipe"];
    assert.equal(cpu.rendererKind, "cpu");
    assert.equal(cpu.kind, "cpu");
    assert.equal(cpu.p95Ms["animated-meshes-100"], 17.282);
    assert.equal(cpu.admitsToReleaseBudget, false);
    assert.equal(missing.rendererKind, "unavailable");
    assert.deepEqual(missing.p95Ms, {});
    assert.equal(missing.reason, "WebGL1 context unavailable");
    assert.equal(software.rendererKind, "software");
    assert.match(software.renderer, /llvmpipe/);
    assert.equal(software.p95Ms["pixel-workshop"], 17.535);
    assert.equal(software.p95Ms.relay, 5.247);
    assert.equal(software.cpuSubmissionP95Ms["animated-meshes-100"], 267.1);
    assert.equal(software.admitsToHardwareBudget, false);
    const comparison = compareHostSample(software);
    assert.equal(comparison.excludedFromHardwareBudget, true);
    assert.equal(comparison.ciGateEnabled, false);
    assert.equal(comparison.rows.every(row => row.admitted === false), true);
    assert.equal(RELEASE_BUDGETS_MS["animated-meshes-100"], 3.9);
    assert.equal(GPU_HARDWARE_BUDGETS_MS["pixel-workshop"], 3.2);
});

test("recorded sample files stay outside the frozen cohort", () => {
    const samples = loadHostSampleDirectory(path.join(__dirname, "benchmark-host-samples"));
    const cpuBefore = JSON.stringify(RELEASE_BUDGETS_MS);
    const gpuBefore = JSON.stringify(GPU_HARDWARE_BUDGETS_MS);
    if (samples.length > 0) mergeHostSamples([], samples);
    assert.equal(JSON.stringify(RELEASE_BUDGETS_MS), cpuBefore);
    assert.equal(JSON.stringify(GPU_HARDWARE_BUDGETS_MS), gpuBefore);
    for (const sample of samples) {
        assert.equal(sample.admitsToReleaseBudget, false);
        assert.equal(sample.admitsToHardwareBudget, false);
        const comparison = compareHostSample(sample);
        assert.equal(comparison.movesFrozenBudgets, false);
        assert.equal(comparison.ciGateEnabled, false);
        if (sample.rendererKind !== "hardware") assert.equal(comparison.excludedFromHardwareBudget, true);
    }
});

test("the record command writes a software sample without failing the budget", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-budget-sample-"));
    const report = path.join(directory, "gpu.json");
    fs.writeFileSync(report, JSON.stringify({
        available: true,
        platform: "linux",
        results: [{ name: "pixel-workshop", renderer: "llvmpipe (LLVM 20.1.2, 256 bits)", gpuP95Ms: 80, cpuSubmissionP95Ms: 4 }]
    }));
    const out = path.join(directory, "cloud-llvmpipe-gpu.json");
    const args = [report, "--id", "cloud-llvmpipe-gpu", "--recorded", "2026-09-28", "--out", out];
    const first = spawnSync(process.execPath, [path.join(__dirname, "record-benchmark-sample.js"), ...args], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const printed = JSON.parse(first.stdout);
    assert.equal(printed.ciGateEnabled, false);
    assert.equal(printed.movesFrozenBudgets, false);
    assert.equal(printed.comparison.excludedFromHardwareBudget, true);
    assert.equal(printed.comparison.rows[0].overFrozenBudget, true);
    assert.equal(printed.comparison.rows[0].admitted, false);
    const second = spawnSync(process.execPath, [path.join(__dirname, "record-benchmark-sample.js"), ...args], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    const changed = spawnSync(process.execPath, [path.join(__dirname, "record-benchmark-sample.js"), report, "--id", "cloud-llvmpipe-gpu", "--recorded", "2026-09-29", "--out", out], { encoding: "utf8" });
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /different sample/);
    fs.rmSync(directory, { recursive: true, force: true });
});

function physicalGpuReport(p95) {
    const renderer = "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)";
    return hostSampleFromGpuReport({
        available: true,
        results: [
            { name: "pixel-workshop", renderer, gpuP95Ms: p95.workshop, cpuSubmissionP95Ms: 1 },
            { name: "relay-1.vde", renderer, gpuP95Ms: p95.relay[0] },
            { name: "relay-2.vde", renderer, gpuP95Ms: p95.relay[1] },
            { name: "animated-meshes-100", renderer, gpuP95Ms: p95.meshes },
            { name: "textured-rasters", renderer, gpuP95Ms: 12 }
        ]
    }, { id: "mike-iris-xe-2026-10-02", recorded: "2026-10-02" });
}

test("a hardware GPU preview stays unapplied until the operator attests a physical machine", () => {
    const cpuBefore = JSON.stringify(RELEASE_BUDGETS_MS);
    const gpuBefore = JSON.stringify(GPU_HARDWARE_BUDGETS_MS);
    const sample = physicalGpuReport({ workshop: 4, relay: [1, 3], meshes: 1 });
    const held = previewHardwareAdmission(sample, { physicalGpuAttested: false });
    assert.equal(held.classifiedHardware, true);
    assert.equal(held.readyForOperatorAttestation, true);
    assert.equal(held.eligible, false);
    assert.equal(held.applied, false);
    assert.equal(held.ciGateEnabled, false);
    assert.equal(held.ciGateJustified, false);
    assert.equal(held.cohortEntry, null);
    assert.deepEqual(held.sourceEdit, []);
    assert.equal(held.proposedBudgetsMs["pixel-workshop"], calibrateMs([2.076, 4]));
    assert.equal(held.proposedBudgetsMs.relay, calibrateMs([2.312, 3]));
    assert.equal(held.proposedBudgetsMs["animated-meshes-100"], 2.8);
    assert.deepEqual(held.recordedOnly, ["textured-rasters"]);
    assert.match(held.blockers.join("\n"), /physical GPU/);
    const admitted = previewHardwareAdmission(sample, { physicalGpuAttested: true });
    assert.equal(admitted.eligible, true);
    assert.equal(admitted.applied, false);
    assert.equal(admitted.movesFrozenBudgets, false);
    assert.equal(admitted.ciGateJustified, false);
    assert.equal(admitted.hostsAfterAdmission, FROZEN_GPU_HOSTS.length + 1);
    assert.equal(admitted.cohortEntry.rendererKind, "hardware");
    assert.equal(admitted.cohortEntry.p95Ms["pixel-workshop"], 4);
    assert.equal(admitted.cohortEntry.p95Ms.relay, 3);
    assert.equal(admitted.cohortEntry.p95Ms["textured-rasters"], undefined);
    assert.equal(admitted.sourceEdit.length > 0, true);
    assert.equal(JSON.stringify(RELEASE_BUDGETS_MS), cpuBefore);
    assert.equal(JSON.stringify(GPU_HARDWARE_BUDGETS_MS), gpuBefore);
    assert.equal(GPU_HARDWARE_BUDGETS_MS["pixel-workshop"], 3.2);
});

test("software GL and the stored cloud samples stay out of hardware admission", () => {
    const software = hostSampleFromGpuReport({
        available: true,
        results: [{ name: "pixel-workshop", renderer: "llvmpipe (LLVM 20.1.2, 256 bits)", gpuP95Ms: 80 }]
    }, { id: "cloud-llvmpipe-again", recorded: "2026-09-28" });
    const forced = previewHardwareAdmission(software, { physicalGpuAttested: true });
    assert.equal(forced.eligible, false);
    assert.equal(forced.readyForOperatorAttestation, false);
    assert.equal(forced.proposedBudgetsMs, null);
    assert.equal(forced.cohortEntry, null);
    assert.equal(forced.ciGateEnabled, false);
    assert.match(forced.blockers.join("\n"), /software GL/);
    assert.match(forced.blockers.join("\n"), /cannot reclassify/);
    const missing = hostSampleFromGpuReport({
        available: true,
        results: [{
            name: "pixel-workshop",
            renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
            gpuP95Ms: 4
        }]
    }, { id: "partial-iris", recorded: "2026-10-02" });
    const incomplete = previewHardwareAdmission(missing, { physicalGpuAttested: true });
    assert.equal(incomplete.eligible, false);
    assert.equal(incomplete.proposedBudgetsMs, null);
    assert.match(incomplete.blockers.join("\n"), /missing required workload relay/);
    assert.throws(() => normalizeHostSample({
        ...software,
        physicalGpu: true
    }), /cannot attest/);
    const roster = hardwareAdmissionRoster(loadHostSampleDirectory(path.join(__dirname, "benchmark-host-samples")));
    assert.equal(roster.ciGateEnabled, false);
    assert.equal(roster.ciGateJustified, false);
    assert.equal(roster.admittedByThisCommand, 0);
    assert.equal(roster.readyForOperatorAttestation, 0);
    assert.equal(roster.stored >= 3, true);
    const byId = Object.fromEntries(roster.rows.map(row => [row.id, row]));
    assert.equal(byId["linux-x64-xeon-cloud-2026-09-28-cpu"].classifiedHardware, false);
    assert.match(byId["linux-x64-xeon-cloud-2026-09-28-cpu"].blockers.join("\n"), /cpu sample/);
    assert.match(byId["linux-x64-xeon-cloud-2026-09-28-gpu-unavailable"].blockers.join("\n"), /unavailable WebGL/);
    assert.match(byId["linux-x64-xeon-cloud-2026-09-28-llvmpipe"].blockers.join("\n"), /software GL/);
    for (const row of roster.rows) {
        assert.equal(row.eligible, false);
        assert.equal(row.classifiedHardware, false);
    }
    assert.equal(GPU_HARDWARE_BUDGETS_MS["pixel-workshop"], 3.2);
});

test("the admission preview command exits 0 for software GL and does not edit budgets", () => {
    const source = fs.readFileSync(path.join(__dirname, "preview-hardware-admission.js"), "utf8");
    assert.equal(/writeFile|mkdir|CI_GATE_ENABLED\s*=/.test(source), false);
    const summary = spawnSync(process.execPath, [path.join(__dirname, "preview-hardware-admission.js"), "--summary"], { encoding: "utf8" });
    assert.equal(summary.status, 0, summary.stderr);
    const roster = JSON.parse(summary.stdout);
    assert.equal(roster.readyForOperatorAttestation, 0);
    assert.equal(roster.ciGateEnabled, false);
    assert.equal(roster.admittedByThisCommand, 0);
    assert.equal(roster.frozenGpuCohort.refileable, 0);
    assert.equal(roster.frozenGpuCohort.ciGateJustified, false);
    assert.equal(roster.frozenGpuCohort.hosts[0].rendererRetained, false);
    assert.equal(roster.frozenGpuCohort.hosts[0].eligible, false);
    const software = spawnSync(process.execPath, [
        path.join(__dirname, "preview-hardware-admission.js"),
        path.join(__dirname, "benchmark-host-samples", "linux-x64-xeon-cloud-2026-09-28-llvmpipe.json"),
        "--physical-gpu"
    ], { encoding: "utf8" });
    assert.equal(software.status, 0, software.stderr);
    const printed = JSON.parse(software.stdout);
    assert.equal(printed.preview.eligible, false);
    assert.equal(printed.preview.applied, false);
    assert.equal(printed.movesFrozenBudgets, false);
    assert.equal(printed.ciGateEnabled, false);
    assert.match(printed.preview.blockers.join("\n"), /software GL/);
    const refused = spawnSync(process.execPath, [
        path.join(__dirname, "preview-hardware-admission.js"),
        "--summary",
        "--physical-gpu"
    ], { encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--summary/);
    const apply = spawnSync(process.execPath, [
        path.join(__dirname, "preview-hardware-admission.js"),
        "--id", "linux-x64-xeon-cloud-2026-09-28-llvmpipe",
        "--apply"
    ], { encoding: "utf8" });
    assert.equal(apply.status, 1);
    assert.match(apply.stderr, /unknown argument/);
    assert.equal(GPU_HARDWARE_BUDGETS_MS.relay, 3.5);
});

test("the published Iris Xe GPU cohort is not a second physical host", () => {
    const cpuBefore = JSON.stringify(RELEASE_BUDGETS_MS);
    const gpuBefore = JSON.stringify(GPU_HARDWARE_BUDGETS_MS);
    const host = FROZEN_GPU_HOSTS[0];
    assert.equal(host.id, "windows-x64-iris-xe-gpu-2026-09-07");
    assert.equal(host.renderer, undefined);
    assert.equal(host.p95Ms["pixel-workshop"], 2.076);
    assert.equal(host.p95Ms.relay, 2.312);
    assert.equal(host.p95Ms["animated-meshes-100"], 1.851);
    assert.equal(PRIOR_WINDOWS_IRIS_XE.gpuMs["pixel-workshop"], 2.076);
    assert.equal(PRIOR_WINDOWS_IRIS_XE.gpuMs["relay-ceiling"], 2.312);
    assert.equal(PRIOR_WINDOWS_IRIS_XE.gpuMs["animated-meshes-100"], 1.851);
    assert.throws(() => normalizeHostSample(host), /renderer string/);
    assert.throws(() => previewHardwareAdmission(host), /renderer string/);
    const report = frozenGpuCohortReport();
    assert.equal(report.refileable, 0);
    assert.equal(report.ciGateEnabled, false);
    assert.equal(report.ciGateJustified, false);
    assert.equal(report.hosts.length, 1);
    assert.equal(report.hosts[0].alreadyFrozen, true);
    assert.match(report.hosts[0].blockers.join("\n"), /renderer string was not retained/);
    const prose = "Intel Iris Xe through ANGLE D3D11";
    const { classifyGpuRenderer } = require("./validate-hardware-gpu");
    assert.equal(classifyGpuRenderer(prose).kind, "hardware");
    const replay = previewHardwareAdmission({
        ...host,
        renderer: prose,
        p95Ms: {
            "pixel-workshop": 2.076,
            relay: 2.312,
            "animated-meshes-100": 1.851
        }
    }, { physicalGpuAttested: true });
    assert.equal(replay.classifiedHardware, true);
    assert.equal(replay.eligible, false);
    assert.equal(replay.applied, false);
    assert.equal(replay.movesFrozenBudgets, false);
    assert.equal(replay.ciGateEnabled, false);
    assert.equal(replay.ciGateJustified, false);
    assert.equal(replay.cohortEntry, null);
    assert.deepEqual(replay.sourceEdit, []);
    assert.match(replay.blockers.join("\n"), /already a frozen cohort id/);
    const samples = loadHostSampleDirectory(path.join(__dirname, "benchmark-host-samples"));
    assert.equal(samples.some(sample => sample.rendererKind === "hardware"), false);
    assert.equal(samples.some(sample => String(sample.renderer || "").includes(prose)), false);
    assert.equal(JSON.stringify(RELEASE_BUDGETS_MS), cpuBefore);
    assert.equal(JSON.stringify(GPU_HARDWARE_BUDGETS_MS), gpuBefore);
    assert.equal(GPU_HARDWARE_BUDGETS_MS["pixel-workshop"], 3.2);
    assert.equal(GPU_HARDWARE_BUDGETS_MS.relay, 3.5);
    assert.equal(GPU_HARDWARE_BUDGETS_MS["animated-meshes-100"], 2.8);
    assert.equal(FROZEN_GPU_HOSTS.length, 1);
});

test("accounted soak growth follows new snapshots and allows a trim drop", () => {
    const growing = Array.from({ length: 12 }, (_, i) => ({
        uniqueSnapshots: i + 1,
        serializedUtf8Bytes: (i + 1) * 1000
    }));
    assert.equal(soakRetainedAccounted(growing), true);
    const leaked = growing.map((sample, i) => i === 0 ? sample : { ...sample, serializedUtf8Bytes: sample.serializedUtf8Bytes * 100 });
    assert.equal(soakRetainedAccounted(leaked), false);
    const plateau = Array.from({ length: 8 }, () => ({ uniqueSnapshots: 50, serializedUtf8Bytes: 2_000_000 }));
    const climb = Array.from({ length: 4 }, (_, i) => ({ uniqueSnapshots: 40 + i, serializedUtf8Bytes: 1_600_000 + i * 40_000 }));
    assert.equal(soakRetainedAccounted([...climb, ...plateau]), true);
    assert.equal(soakTailPlateaued([...climb, ...plateau]), true);
    assert.equal(soakTailPlateaued(growing), false);
});
