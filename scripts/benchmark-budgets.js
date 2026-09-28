/**
 * @module benchmark-budgets
 * @description Informational SCALE-001 release budgets. Comparisons never fail CI.
 *
 * Interactive frame work still aims at 16.67 ms. A release budget is 1.5× the highest
 * recorded p95 for that workload, rounded up to 0.1 ms. One host does not make a
 * hardware-independent gate. History trimming stays at its 128 MiB estimate ceiling.
 */
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
    GPU_HARDWARE_BUDGETS_MS
};
