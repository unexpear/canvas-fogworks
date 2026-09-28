/**
 * @module benchmark-budgets.test
 * @description Locks the SCALE-001 budget formula and the soak retention rule.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { calibrateMs, soakRetainedAccounted, soakTailPlateaued, RECORDED_P95_MS, RELEASE_BUDGETS_MS, GPU_IRIS_XE_P95_MS, GPU_HARDWARE_BUDGETS_MS } = require("./benchmark-budgets");

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
