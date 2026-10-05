/**
 * @module benchmark-budgets
 * @description Informational SCALE-001 release budgets. Additional host samples compare
 * against the frozen cohort and do not change it. Comparisons do not fail CI.
 * previewHardwareAdmission prints a physical-GPU cohort edit and leaves the files unchanged.
 * frozenGpuCohortReport records that the published Iris Xe GPU entry is already frozen.
 * Without a retained renderer string it is not another host sample.
 *
 * Interactive frame work still aims at 16.67 ms. A release budget is 1.5× the highest
 * p95 in the frozen cohort for that workload, rounded up to 0.1 ms. One hardware GPU
 * host does not make a hardware-independent gate. History trimming stays at its 128 MiB
 * estimate ceiling.
 */
const { classifyGpuRenderer } = require("./validate-hardware-gpu");
const INTERACTIVE_FRAME_MS = 16.67;
const DESERIALIZE_GOAL_MS = 100;
const HISTORY_TRIM_BYTES = 128 * 1024 * 1024;
const HISTORY_MIN_ENTRIES = 50;
const HEADROOM = 1.5;

/** September 7, 2026 Windows x64 / Node 24.15.0 / Intel Iris Xe sample. Ranges use the recorded ceiling. */
const PRIOR_WINDOWS_IRIS_XE = {
    id: "windows-x64-node-24.15.0-iris-xe-2026-09-07",
    frameCpuMs: {
        "rect-250": 3.430,
        "rect-1000": 6.247,
        "pixel-workshop": 1.120,
        "relay-ceiling": 0.218,
        "components-500": 3.559,
        "animated-meshes-100": 1.239
    },
    loadMs: { "rect-250": 3.934, "rect-1000": 11.818 },
    gameplay100Ms: 3.651,
    skin3000Ms: 7.074,
    raster1024: { encodeMs: 6.889, decodeMs: 3.267 },
    assetReloadMs: 1.399,
    gpuMs: {
        "pixel-workshop": 2.076,
        "relay-ceiling": 2.312,
        "animated-meshes-100": 1.851
    },
    historyHeapDeltaMiB: { "rect-250": 4.32, "rect-1000": 12.13 }
};

/**
 * Release budget in milliseconds: 1.5× the highest finite sample, rounded up to 0.1 ms.
 * Returns null when no sample was recorded.
 */
function calibrateMs(values) {
    const finite = values.filter(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (finite.length === 0) return null;
    return Math.ceil(Math.max(...finite) * HEADROOM * 10) / 10;
}

/**
 * True when serialized retention grows only with new snapshots, and stops growing once the
 * snapshot count stops growing. A trim may drop both the count and the byte total.
 */
function soakRetainedAccounted(samples) {
    if (!Array.isArray(samples) || samples.length < 8) return false;
    for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1];
        const next = samples[i];
        const added = next.uniqueSnapshots - prev.uniqueSnapshots;
        const delta = next.serializedUtf8Bytes - prev.serializedUtf8Bytes;
        if (added > 0) {
            const per = prev.serializedUtf8Bytes / Math.max(1, prev.uniqueSnapshots);
            if (delta > added * per * 3 + 65536) return false;
            if (delta < 0) return false;
        } else if (delta > Math.max(4096, prev.serializedUtf8Bytes * 0.05)) {
            return false;
        }
    }
    return true;
}

/** True when the last quarter holds a stable snapshot count (a ceiling may hover by one or two) and a stable byte total. */
function soakTailPlateaued(samples) {
    if (!Array.isArray(samples) || samples.length < 8) return false;
    const tail = samples.slice(Math.floor(samples.length * 0.75));
    const counts = tail.map(sample => sample.uniqueSnapshots);
    if (Math.max(...counts) - Math.min(...counts) > 1) return false;
    const bytes = tail.map(sample => sample.serializedUtf8Bytes).sort((a, b) => a - b);
    const median = bytes[Math.floor(bytes.length / 2)];
    const end = tail[tail.length - 1].serializedUtf8Bytes;
    return end <= median * 1.1 && end >= median * 0.9;
}

/**
 * p95 samples behind the frozen release budgets.
 * Windows figures are the September 7 Iris Xe ceilings. Linux figures are the
 * 2026-09-28 calibration run (Node 22.14.0, 4 vCPU Intel Xeon, 16 GiB).
 * Workloads with one number were not measured on Windows.
 */
const RECORDED_P95_MS = {
    "rect-250-frame": [3.430, 0.977],
    "rect-1000-frame": [6.247, 2.087],
    "rect-250-load": [3.934, 1.487],
    "rect-1000-load": [11.818, 3.481],
    "pixel-workshop-frame": [1.120, 0.979],
    "relay-frame": [0.218, 0.166, 0.273, 0.171],
    "components-500": [3.559, 4.441],
    "animated-meshes-100": [1.239, 2.581],
    "gameplay-100": [3.651, 0.901, 4.401],
    "skin-3000": [7.074, 4.919],
    "raster-1024-encode": [6.889, 4.766],
    "raster-1024-decode": [3.267, 3.811],
    "asset-reload": [1.399, 1.034],
    "raster-2048-noisy-encode": [464.389],
    "raster-2048-noisy-decode": [27.667],
    "textured-rasters-frame": [516.552],
    "textured-billboards-80": [0.358]
};

const RELEASE_BUDGETS_MS = Object.fromEntries(
    Object.entries(RECORDED_P95_MS).map(([name, samples]) => [name, calibrateMs(samples)])
);

/** Hardware GPU p95 from the September Iris Xe sample only. Software GL is not included. */
const GPU_IRIS_XE_P95_MS = {
    "pixel-workshop": [2.076],
    "relay": [2.312],
    "animated-meshes-100": [1.851]
};

const GPU_HARDWARE_BUDGETS_MS = Object.fromEntries(
    Object.entries(GPU_IRIS_XE_P95_MS).map(([name, samples]) => [name, calibrateMs(samples)])
);

/** Workloads a later physical GPU host must include before it can join the frozen GPU cohort. */
const GPU_ADMISSION_WORKLOADS = Object.freeze(["pixel-workshop", "relay", "animated-meshes-100"]);

/**
 * Named attribution for RECORDED_P95_MS. The arrays above stay the budget input.
 * A test checks that these hosts are the same multiset, so editing one without the
 * other cannot quietly change a frozen budget.
 */
const FROZEN_CPU_HOSTS = [
    {
        id: "windows-x64-node-24.15.0-iris-xe-2026-09-07",
        recorded: "2026-09-07",
        kind: "cpu",
        rendererKind: "cpu",
        note: "September 7, 2026 Windows x64 / Node 24.15.0 / Intel Iris Xe CPU ceilings.",
        p95Ms: {
            "rect-250-frame": 3.430,
            "rect-1000-frame": 6.247,
            "rect-250-load": 3.934,
            "rect-1000-load": 11.818,
            "pixel-workshop-frame": 1.120,
            "relay-frame": 0.218,
            "components-500": 3.559,
            "animated-meshes-100": 1.239,
            "gameplay-100": 3.651,
            "skin-3000": 7.074,
            "raster-1024-encode": 6.889,
            "raster-1024-decode": 3.267,
            "asset-reload": 1.399
        }
    },
    {
        id: "linux-x64-node-22.14.0-xeon-2026-09-28",
        recorded: "2026-09-28",
        kind: "cpu",
        rendererKind: "cpu",
        note: "2026-09-28 Linux x64, Node 22.14.0, 4 vCPU Intel Xeon, 16 GiB. No hardware WebGL. relay-frame lists the three stage p95s; gameplay-100 lists the reference scene and the slowest relay stage.",
        p95Ms: {
            "rect-250-frame": 0.977,
            "rect-1000-frame": 2.087,
            "rect-250-load": 1.487,
            "rect-1000-load": 3.481,
            "pixel-workshop-frame": 0.979,
            "relay-frame": [0.166, 0.273, 0.171],
            "components-500": 4.441,
            "animated-meshes-100": 2.581,
            "gameplay-100": [0.901, 4.401],
            "skin-3000": 4.919,
            "raster-1024-encode": 4.766,
            "raster-1024-decode": 3.811,
            "asset-reload": 1.034,
            "raster-2048-noisy-encode": 464.389,
            "raster-2048-noisy-decode": 27.667,
            "textured-rasters-frame": 516.552,
            "textured-billboards-80": 0.358
        }
    }
];

/** Iris Xe GPU p95 only. The unmasked renderer string was not retained with this sample. */
const FROZEN_GPU_HOSTS = [
    {
        id: "windows-x64-iris-xe-gpu-2026-09-07",
        recorded: "2026-09-07",
        kind: "gpu",
        rendererKind: "hardware",
        note: "September Iris Xe GPU p95. Software GL is not part of this cohort.",
        p95Ms: {
            "pixel-workshop": 2.076,
            relay: 2.312,
            "animated-meshes-100": 1.851
        }
    }
];

const FROZEN_SAMPLE_IDS = new Set([
    ...FROZEN_CPU_HOSTS.map(host => host.id),
    ...FROZEN_GPU_HOSTS.map(host => host.id)
]);

/** SCALE-001 has no hardware-independent CI gate. Recording a sample does not enable one. */
const CI_GATE_ENABLED = false;
const HOST_SAMPLE_SCHEMA = 1;
const RELAY_AGGREGATION = "max-stage-gpu-p95";
const SAMPLE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const WORKLOAD_NAME = SAMPLE_ID;

function freezeSampleTable(table) {
    for (const value of Object.values(table)) {
        if (Array.isArray(value)) Object.freeze(value);
    }
    return Object.freeze(table);
}
freezeSampleTable(RECORDED_P95_MS);
freezeSampleTable(GPU_IRIS_XE_P95_MS);
Object.freeze(RELEASE_BUDGETS_MS);
Object.freeze(GPU_HARDWARE_BUDGETS_MS);

function sortedObject(source) {
    return Object.fromEntries(Object.entries(source).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function finiteMilliseconds(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a finite non-negative number of milliseconds`);
    }
    return value;
}

function normalizeP95Map(map, label) {
    if (map == null) return {};
    if (typeof map !== "object" || Array.isArray(map)) throw new Error(`${label} must be an object`);
    const out = {};
    for (const [name, value] of Object.entries(map)) {
        if (!WORKLOAD_NAME.test(name)) throw new Error(`${label} workload name is invalid: ${name}`);
        if (value == null) continue;
        if (Array.isArray(value)) {
            if (value.length === 0) continue;
            if (value.some(item => item == null)) throw new Error(`${label}.${name} cannot contain null`);
            out[name] = value.map((item, index) => finiteMilliseconds(item, `${label}.${name}[${index}]`));
        } else {
            out[name] = finiteMilliseconds(value, `${label}.${name}`);
        }
    }
    return sortedObject(out);
}

function normalizeHost(host) {
    const source = host && typeof host === "object" && !Array.isArray(host) ? host : {};
    const out = {};
    for (const key of ["platform", "arch", "cpu", "node", "electron", "chromium"]) {
        if (source[key] != null && source[key] !== "") out[key] = String(source[key]);
    }
    for (const key of ["cpuCount", "totalMemMiB"]) {
        if (source[key] == null || source[key] === "") continue;
        if (typeof source[key] !== "number" || !Number.isInteger(source[key]) || source[key] < 0) {
            throw new Error(`host.${key} must be a non-negative integer`);
        }
        out[key] = source[key];
    }
    if (source.gcControlled != null) {
        if (typeof source.gcControlled !== "boolean") throw new Error("host.gcControlled must be a boolean");
        out.gcControlled = source.gcControlled;
    }
    return out;
}

/**
 * Canonical host sample. Admission flags are forced off: a file cannot opt itself
 * into the frozen cohort. Null timings are omitted rather than stored as zero.
 */
function normalizeHostSample(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("host sample must be an object");
    if (input.schemaVersion != null && input.schemaVersion !== HOST_SAMPLE_SCHEMA) {
        throw new Error(`host sample schemaVersion must be ${HOST_SAMPLE_SCHEMA}`);
    }
    const id = input.id == null || input.id === "" ? null : String(input.id);
    if (id != null && !SAMPLE_ID.test(id)) throw new Error(`host sample id must be lowercase letters, digits, dots, and hyphens: ${id}`);
    const recorded = input.recorded == null || input.recorded === "" ? null : String(input.recorded);
    if (recorded != null && !/^\d{4}-\d{2}-\d{2}$/.test(recorded)) {
        throw new Error(`host sample recorded must be YYYY-MM-DD: ${recorded}`);
    }
    if (input.kind !== "cpu" && input.kind !== "gpu") throw new Error("host sample kind must be cpu or gpu");
    if (input.admitsToReleaseBudget === true || input.admitsToHardwareBudget === true || input.frozen === true) {
        throw new Error("a recorded host sample cannot admit itself into a frozen budget");
    }
    if (input.physicalGpu === true || input.physicalGpuAttested === true) {
        throw new Error("a recorded host sample cannot attest that it is a physical GPU");
    }
    const renderer = input.renderer == null || String(input.renderer).trim() === "" ? null : String(input.renderer).trim();
    let rendererKind = input.rendererKind == null ? null : String(input.rendererKind);
    if (renderer) {
        const classified = classifyGpuRenderer(renderer).kind;
        if (rendererKind == null) rendererKind = classified;
        if ((classified === "hardware" || classified === "software") && rendererKind !== classified) {
            throw new Error(`renderer is ${classified}, so rendererKind cannot be ${rendererKind}`);
        }
        if ((rendererKind === "cpu" || rendererKind === "unavailable") && classified !== "unknown") {
            throw new Error(`rendererKind ${rendererKind} disagrees with renderer ${renderer}`);
        }
    }
    const allowed = input.kind === "cpu"
        ? new Set(["cpu"])
        : new Set(["hardware", "software", "unavailable", "unknown"]);
    if (!allowed.has(rendererKind)) throw new Error(`rendererKind ${rendererKind} is not valid for a ${input.kind} sample`);
    if ((rendererKind === "hardware" || rendererKind === "software") && !renderer) {
        throw new Error(`${rendererKind} samples require a renderer string`);
    }
    if (input.kind === "cpu" && renderer) throw new Error("a cpu sample cannot carry a GL renderer");
    const p95Ms = normalizeP95Map(input.p95Ms, "p95Ms");
    const cpuSubmissionP95Ms = normalizeP95Map(input.cpuSubmissionP95Ms, "cpuSubmissionP95Ms");
    const stageP95Ms = normalizeP95Map(input.stageP95Ms, "stageP95Ms");
    if (input.kind === "cpu" && (Object.keys(cpuSubmissionP95Ms).length > 0 || Object.keys(stageP95Ms).length > 0)) {
        throw new Error("cpu samples record p95Ms only");
    }
    if (rendererKind === "unavailable" && (Object.keys(p95Ms).length > 0 || Object.keys(cpuSubmissionP95Ms).length > 0 || Object.keys(stageP95Ms).length > 0)) {
        throw new Error("unavailable WebGL cannot carry timings");
    }
    if (input.relayAggregation != null && input.relayAggregation !== RELAY_AGGREGATION) {
        throw new Error(`relayAggregation must be ${RELAY_AGGREGATION}`);
    }
    const sample = {
        schemaVersion: HOST_SAMPLE_SCHEMA,
        id,
        recorded,
        kind: input.kind,
        rendererKind,
        renderer,
        admitsToReleaseBudget: false,
        admitsToHardwareBudget: false,
        host: normalizeHost(input.host),
        p95Ms
    };
    if (input.kind === "gpu") sample.cpuSubmissionP95Ms = cpuSubmissionP95Ms;
    if (Object.keys(stageP95Ms).length > 0) sample.stageP95Ms = stageP95Ms;
    if (input.relayAggregation) sample.relayAggregation = RELAY_AGGREGATION;
    if (input.reason != null && input.reason !== "") sample.reason = String(input.reason);
    if (input.note != null && input.note !== "") sample.note = String(input.note);
    return sample;
}

function assertRecordable(sample) {
    const normalized = normalizeHostSample(sample);
    if (!normalized.id) throw new Error("recorded host sample requires an id");
    if (!normalized.recorded) throw new Error("recorded host sample requires a recorded date");
    if (FROZEN_SAMPLE_IDS.has(normalized.id)) {
        throw new Error(`${normalized.id} is a frozen cohort id and cannot be stored as an additional sample`);
    }
    return normalized;
}

function measuredValues(value) {
    return Array.isArray(value) ? value : [value];
}

/**
 * Compare one sample to the frozen budgets. previewBudgetMs is the 1.5× figure that
 * would result if a later edit admitted the sample. This function does not admit it.
 */
function compareHostSample(sample) {
    const normalized = normalizeHostSample(sample);
    const gpu = normalized.kind === "gpu";
    const budgetTable = gpu ? GPU_HARDWARE_BUDGETS_MS : RELEASE_BUDGETS_MS;
    const frozenSamples = gpu ? GPU_IRIS_XE_P95_MS : RECORDED_P95_MS;
    const rows = Object.entries(normalized.p95Ms).map(([workload, value]) => {
        const measured = measuredValues(value);
        const worstMs = Math.max(...measured);
        const frozenList = frozenSamples[workload] ?? [];
        const hasFrozenBudget = Object.prototype.hasOwnProperty.call(budgetTable, workload);
        const frozenBudgetMs = hasFrozenBudget ? budgetTable[workload] : null;
        return {
            workload,
            measuredMs: measured.length === 1 ? measured[0] : measured.slice(),
            worstMs,
            frozenBudgetMs,
            overFrozenBudget: frozenBudgetMs == null ? null : worstMs > frozenBudgetMs,
            previewBudgetMs: calibrateMs(frozenList.concat(measured)),
            admitted: false
        };
    });
    return {
        id: normalized.id,
        kind: normalized.kind,
        rendererKind: normalized.rendererKind,
        movesFrozenBudgets: false,
        ciGateEnabled: CI_GATE_ENABLED,
        excludedFromHardwareBudget: !(gpu && normalized.rendererKind === "hardware"),
        admitted: false,
        rows
    };
}

/**
 * Preview appending one GPU sample to the frozen hardware cohort.
 * The sample file cannot attest a physical machine. Software GL stays ineligible.
 * This function does not edit FROZEN_GPU_HOSTS, GPU_IRIS_XE_P95_MS, or CI_GATE_ENABLED.
 * One eligible host still leaves the CI gate off.
 */
function previewHardwareAdmission(sample, options = {}) {
    if (options.physicalGpuAttested != null && typeof options.physicalGpuAttested !== "boolean") {
        throw new Error("physicalGpuAttested must be a boolean");
    }
    const attested = options.physicalGpuAttested === true;
    const normalized = normalizeHostSample(sample);
    const blockers = [];
    const classifiedHardware = normalized.kind === "gpu" && normalized.rendererKind === "hardware";
    if (normalized.kind !== "gpu") blockers.push("a cpu sample is not a hardware GPU measurement");
    else if (normalized.rendererKind === "software") blockers.push("software GL is excluded from the hardware GPU cohort");
    else if (normalized.rendererKind === "unavailable") blockers.push("unavailable WebGL has no timings to admit");
    else if (!classifiedHardware) blockers.push("renderer is not classified as hardware");
    if (normalized.id && FROZEN_SAMPLE_IDS.has(normalized.id)) {
        blockers.push(`${normalized.id} is already a frozen cohort id`);
    }
    const measured = {};
    if (classifiedHardware) {
        for (const name of GPU_ADMISSION_WORKLOADS) {
            const value = normalized.p95Ms[name];
            if (value == null) blockers.push(`missing required workload ${name}`);
            else if (Array.isArray(value)) blockers.push(`${name} must be one p95, not a list`);
            else measured[name] = value;
        }
        if (!normalized.id || !normalized.recorded) {
            blockers.push("a stored sample needs an id and a YYYY-MM-DD recorded date before admission");
        }
    }
    const readyForOperatorAttestation = classifiedHardware && blockers.length === 0;
    if (readyForOperatorAttestation && !attested) {
        blockers.push("pass --physical-gpu only for a machine you know is a physical GPU; a renderer string is not that attestation");
    }
    if (attested && !classifiedHardware) {
        blockers.push("attestation cannot reclassify this sample as a physical GPU");
    }
    const eligible = readyForOperatorAttestation && attested;
    const proposedBudgetsMs = readyForOperatorAttestation
        ? Object.fromEntries(GPU_ADMISSION_WORKLOADS.map(name => [
            name,
            calibrateMs(GPU_IRIS_XE_P95_MS[name].concat([measured[name]]))
        ]))
        : null;
    const recordedOnly = Object.keys(normalized.p95Ms)
        .filter(name => !GPU_ADMISSION_WORKLOADS.includes(name))
        .sort();
    const cohortEntry = eligible ? {
        id: normalized.id,
        recorded: normalized.recorded,
        kind: "gpu",
        rendererKind: "hardware",
        renderer: normalized.renderer,
        note: normalized.note || "Physical GPU sample. Append by a source edit; this preview does not apply it.",
        p95Ms: Object.fromEntries(GPU_ADMISSION_WORKLOADS.map(name => [name, measured[name]]))
    } : null;
    return {
        id: normalized.id,
        recorded: normalized.recorded,
        kind: normalized.kind,
        rendererKind: normalized.rendererKind,
        renderer: normalized.renderer,
        classifiedHardware,
        physicalGpuAttested: attested,
        readyForOperatorAttestation,
        eligible,
        applied: false,
        movesFrozenBudgets: false,
        ciGateEnabled: CI_GATE_ENABLED,
        ciGateJustified: false,
        excludedFromHardwareBudget: !(normalized.kind === "gpu" && normalized.rendererKind === "hardware"),
        blockers,
        requiredWorkloads: GPU_ADMISSION_WORKLOADS.slice(),
        currentBudgetsMs: { ...GPU_HARDWARE_BUDGETS_MS },
        proposedBudgetsMs,
        measuredMs: readyForOperatorAttestation ? { ...measured } : null,
        recordedOnly,
        frozenGpuHostIds: FROZEN_GPU_HOSTS.map(host => host.id),
        hostsAfterAdmission: eligible ? FROZEN_GPU_HOSTS.length + 1 : null,
        cohortEntry,
        sourceEdit: eligible ? [
            "Append cohortEntry to FROZEN_GPU_HOSTS in scripts/benchmark-budgets.js.",
            "Append each measured p95 to the matching array in GPU_IRIS_XE_P95_MS.",
            "Update the GPU table in docs/PRODUCTION-WORK.md.",
            "Leave CI_GATE_ENABLED false. One added host does not justify a CI gate."
        ] : [],
        note: "This preview does not edit FROZEN_GPU_HOSTS, GPU_IRIS_XE_P95_MS, or CI_GATE_ENABLED. One added physical GPU host does not enable a CI gate."
    };
}

/**
 * The frozen GPU cohort is already admitted. A missing renderer string means the
 * published p95 values are not a host-sample file and cannot be admitted again.
 * This does not move budgets or enable the CI gate.
 */
function frozenGpuCohortReport() {
    const hosts = FROZEN_GPU_HOSTS.map(host => {
        const renderer = host.renderer == null || String(host.renderer).trim() === "" ? null : String(host.renderer).trim();
        return {
            id: host.id,
            recorded: host.recorded,
            rendererKind: host.rendererKind,
            rendererRetained: renderer != null,
            alreadyFrozen: true,
            refileable: false,
            eligible: false,
            blockers: renderer == null
                ? ["the unmasked renderer string was not retained, so this frozen entry is not a host sample"]
                : [`${host.id} is already a frozen cohort id`]
        };
    });
    return {
        hosts,
        refileable: 0,
        ciGateEnabled: CI_GATE_ENABLED,
        ciGateJustified: false,
        note: "Published Iris Xe p95 values are this cohort. They are not a second physical GPU host. A later sample still needs a retained renderer string, the three admission workloads, and --physical-gpu from someone who knows the machine. One added host does not enable a CI gate."
    };
}

/** Directory view. Every stored row is unattested, so none of them are eligible. The frozen cohort is reported beside them and is not refiled. */
function hardwareAdmissionRoster(samples) {
    if (!Array.isArray(samples)) throw new Error("sample list must be an array");
    const rows = samples.map(sample => {
        const preview = previewHardwareAdmission(sample, { physicalGpuAttested: false });
        return {
            id: preview.id,
            kind: preview.kind,
            rendererKind: preview.rendererKind,
            classifiedHardware: preview.classifiedHardware,
            readyForOperatorAttestation: preview.readyForOperatorAttestation,
            eligible: false,
            blockers: preview.blockers
        };
    });
    return {
        ciGateEnabled: CI_GATE_ENABLED,
        ciGateJustified: false,
        frozenGpuHostIds: FROZEN_GPU_HOSTS.map(host => host.id),
        stored: rows.length,
        readyForOperatorAttestation: rows.filter(row => row.readyForOperatorAttestation).length,
        admittedByThisCommand: 0,
        frozenGpuCohort: frozenGpuCohortReport(),
        rows
    };
}

/** Append samples without editing frozen budgets. The same id and body is idempotent. */
function mergeHostSamples(registry, incoming) {
    if (!Array.isArray(registry)) throw new Error("sample registry must be an array");
    const frozenBefore = JSON.stringify({ cpu: RELEASE_BUDGETS_MS, gpu: GPU_HARDWARE_BUDGETS_MS });
    const samples = [];
    const byId = new Map();
    const take = item => {
        const sample = assertRecordable(item);
        const body = JSON.stringify(sample);
        const existing = byId.get(sample.id);
        if (existing != null) {
            if (existing !== body) throw new Error(`host sample ${sample.id} already exists with different contents`);
            return;
        }
        byId.set(sample.id, body);
        samples.push(sample);
    };
    for (const item of registry) take(item);
    const additions = Array.isArray(incoming) ? incoming : [incoming];
    const comparisonSource = [];
    for (const item of additions) {
        const sample = assertRecordable(item);
        comparisonSource.push(sample);
        take(sample);
    }
    const frozenAfter = JSON.stringify({ cpu: RELEASE_BUDGETS_MS, gpu: GPU_HARDWARE_BUDGETS_MS });
    if (frozenBefore !== frozenAfter) throw new Error("merge changed a frozen budget");
    return {
        samples,
        movesFrozenBudgets: false,
        ciGateEnabled: CI_GATE_ENABLED,
        comparisons: comparisonSource.map(compareHostSample)
    };
}

function loadHostSampleDirectory(directory) {
    const fs = require("fs");
    const path = require("path");
    if (!fs.existsSync(directory)) return [];
    const names = fs.readdirSync(directory).filter(name => name.endsWith(".json")).sort();
    const loaded = names.map(name => {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        } catch (error) {
            throw new Error(`${name} is not valid JSON: ${error.message}`);
        }
        const sample = assertRecordable(parsed);
        if (`${sample.id}.json` !== name) throw new Error(`${name} must be named ${sample.id}.json`);
        return sample;
    });
    return mergeHostSamples([], loaded).samples;
}

function hostMeta(report, meta) {
    return {
        id: meta.id ?? null,
        recorded: meta.recorded ?? null,
        note: meta.note,
        host: {
            platform: report.platform,
            arch: report.arch,
            cpu: report.cpu,
            cpuCount: report.cpuCount,
            totalMemMiB: report.totalMemMiB,
            node: report.node,
            electron: report.electron,
            chromium: report.chromium,
            gcControlled: report.gcControlled
        }
    };
}

function hostSampleFromAuthoringReport(report, meta = {}) {
    if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("authoring report must be an object");
    if (!report.releaseComparison || typeof report.releaseComparison !== "object") {
        throw new Error("authoring report has no releaseComparison");
    }
    const p95Ms = {};
    for (const [name, row] of Object.entries(report.releaseComparison)) {
        if (!row || row.measuredMs == null) continue;
        p95Ms[name] = row.measuredMs;
    }
    const stamped = hostMeta(report, meta);
    return normalizeHostSample({
        schemaVersion: HOST_SAMPLE_SCHEMA,
        id: stamped.id,
        recorded: stamped.recorded,
        kind: "cpu",
        rendererKind: "cpu",
        host: stamped.host,
        p95Ms,
        note: meta.note ?? "CPU sample recorded beside the frozen release budgets. It does not move them."
    });
}

function hostSampleFromGpuReport(report, meta = {}) {
    if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("gpu report must be an object");
    const stamped = hostMeta(report, meta);
    if (report.available === false) {
        if (Array.isArray(report.results) && report.results.length > 0) {
            throw new Error("an unavailable GPU report cannot include timings");
        }
        return normalizeHostSample({
            schemaVersion: HOST_SAMPLE_SCHEMA,
            id: stamped.id,
            recorded: stamped.recorded,
            kind: "gpu",
            rendererKind: "unavailable",
            host: stamped.host,
            p95Ms: {},
            reason: report.reason || "WebGL unavailable",
            note: meta.note ?? "No WebGL timings. A missing context is unavailable, not zero."
        });
    }
    if (!Array.isArray(report.results) || report.results.length === 0) throw new Error("gpu report has no results");
    const renderers = report.results.map(result => result && result.renderer != null ? String(result.renderer).trim() : "");
    if (new Set(renderers).size !== 1) throw new Error("gpu report contains more than one renderer");
    const renderer = renderers[0] || null;
    const rendererKind = classifyGpuRenderer(renderer).kind;
    const p95Ms = {};
    const cpuSubmissionP95Ms = {};
    const stageP95Ms = {};
    let explicitRelay = null;
    for (const result of report.results) {
        if (!result || typeof result.name !== "string" || !WORKLOAD_NAME.test(result.name)) {
            throw new Error("gpu result name is missing or invalid");
        }
        if (result.cpuSubmissionP95Ms != null) cpuSubmissionP95Ms[result.name] = result.cpuSubmissionP95Ms;
        if (result.gpuP95Ms == null) continue;
        if (result.name.startsWith("relay-")) stageP95Ms[result.name] = result.gpuP95Ms;
        else if (result.name === "relay") explicitRelay = result.gpuP95Ms;
        else p95Ms[result.name] = result.gpuP95Ms;
    }
    let relayAggregation = null;
    const stageValues = Object.values(stageP95Ms);
    if (stageValues.length > 0) {
        if (explicitRelay != null) throw new Error("gpu report contains both relay and per-stage relay timings");
        p95Ms.relay = Math.max(...stageValues);
        relayAggregation = RELAY_AGGREGATION;
    } else if (explicitRelay != null) {
        p95Ms.relay = explicitRelay;
    }
    const software = rendererKind === "software";
    const hardware = rendererKind === "hardware";
    return normalizeHostSample({
        schemaVersion: HOST_SAMPLE_SCHEMA,
        id: stamped.id,
        recorded: stamped.recorded,
        kind: "gpu",
        rendererKind,
        renderer,
        host: stamped.host,
        p95Ms,
        cpuSubmissionP95Ms,
        stageP95Ms,
        relayAggregation,
        note: meta.note ?? (software
            ? "Software GL. Excluded from hardware GPU budgets."
            : hardware
                ? "Hardware GPU sample. Recorded only; frozen hardware budgets stay the Iris Xe cohort."
                : "Renderer is not classified as hardware. Excluded from hardware GPU budgets.")
    });
}

function hostSampleFromBenchmarkReport(report, meta = {}) {
    if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("benchmark report must be an object");
    if (report.available === false || Array.isArray(report.results)) return hostSampleFromGpuReport(report, meta);
    if (report.releaseComparison) return hostSampleFromAuthoringReport(report, meta);
    return normalizeHostSample({
        ...report,
        ...(meta.id != null ? { id: meta.id } : {}),
        ...(meta.recorded != null ? { recorded: meta.recorded } : {}),
        ...(meta.note != null ? { note: meta.note } : {})
    });
}

module.exports = {
    INTERACTIVE_FRAME_MS,
    DESERIALIZE_GOAL_MS,
    HISTORY_TRIM_BYTES,
    HISTORY_MIN_ENTRIES,
    HEADROOM,
    PRIOR_WINDOWS_IRIS_XE,
    calibrateMs,
    soakRetainedAccounted,
    soakTailPlateaued,
    RECORDED_P95_MS,
    RELEASE_BUDGETS_MS,
    GPU_IRIS_XE_P95_MS,
    GPU_HARDWARE_BUDGETS_MS,
    GPU_ADMISSION_WORKLOADS,
    FROZEN_CPU_HOSTS,
    FROZEN_GPU_HOSTS,
    FROZEN_SAMPLE_IDS,
    CI_GATE_ENABLED,
    HOST_SAMPLE_SCHEMA,
    RELAY_AGGREGATION,
    normalizeHostSample,
    compareHostSample,
    previewHardwareAdmission,
    frozenGpuCohortReport,
    hardwareAdmissionRoster,
    mergeHostSamples,
    loadHostSampleDirectory,
    hostSampleFromAuthoringReport,
    hostSampleFromGpuReport,
    hostSampleFromBenchmarkReport
};
