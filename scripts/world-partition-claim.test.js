/**
 * @module world-partition-claim.test
 * @description A package without a world-partition block is not a streaming pass.
 */
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { PARTITION_BUDGET_BYTES, evaluateWorldPartitionClaim } = require("../src/runtime/worldPartitionTable");
const { runWorldPartitionCheck } = require("./check-world-partition");

const bytes = Buffer.from("cell");
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

function manifest(partition) {
    const value = {
        files: [
            { id: "model", kind: "gltf", bytes: 2, data: "e30=" },
            { id: "chunk", kind: "buffer", bytes: bytes.length, sha256 }
        ]
    };
    if (partition !== undefined) value.worldPartition = partition;
    return value;
}

const cell = { id: "anchor", min: [-1, -1, -1], max: [1, 1, 1], file: "chunk" };
const table = { anchor: "anchor", loadRadius: 10, unloadRadius: 20, cells: [cell] };

test("the payload budget stays 32 MiB and a missing table is not streamed", () => {
    assert.equal(PARTITION_BUDGET_BYTES, 32 * 1024 * 1024);
    const absent = evaluateWorldPartitionClaim(manifest(undefined));
    assert.equal(absent.acceptable, false);
    assert.equal(absent.streamed, false);
    assert.equal(absent.reason, "missing-partition");
    const inline = manifest({ ...table, cells: [{ ...cell, file: "model" }] });
    const refused = evaluateWorldPartitionClaim(inline);
    assert.equal(refused.acceptable, false);
    assert.equal(refused.streamed, false);
    assert.match(refused.reason, /streamed buffer, image or hdr/);
    const declared = evaluateWorldPartitionClaim(manifest(table));
    assert.equal(declared.acceptable, true);
    assert.equal(declared.streamed, true);
    assert.equal(declared.anchor, "anchor");
});

test("the checker leaves EXPORT-001 open when no partition is supplied", t => {
    const dry = runWorldPartitionCheck([]);
    assert.equal(dry.exitCode, 2);
    assert.equal(dry.report.acceptable, false);
    assert.equal(dry.report.streamed, false);
    assert.equal(dry.report.export001, "open");
    assert.equal(dry.report.f1Complete, false);
    assert.equal(dry.report.cleanMachineExe, "not-recorded");
    assert.match(dry.report.note, /not a pass/);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-partition-claim-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const plain = path.join(temporary, "game.cfgame.json");
    fs.writeFileSync(plain, JSON.stringify(manifest(undefined)));
    const omitted = runWorldPartitionCheck(["--manifest", plain]);
    assert.equal(omitted.exitCode, 2);
    assert.equal(omitted.report.worldPartition, "absent");
    assert.equal(omitted.report.f1Complete, false);
    const invalid = path.join(temporary, "invalid.json");
    fs.writeFileSync(invalid, JSON.stringify(manifest({ ...table, cells: [{ ...cell, file: "model" }] })));
    const rejected = runWorldPartitionCheck(["--manifest", invalid]);
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.report.acceptable, false);
    assert.equal(rejected.report.export001, "open");
    const declared = path.join(temporary, "declared.json");
    fs.writeFileSync(declared, JSON.stringify(manifest(table)));
    const accepted = runWorldPartitionCheck(["--manifest", declared]);
    assert.equal(accepted.exitCode, 0);
    assert.equal(accepted.report.acceptable, true);
    assert.equal(accepted.report.export001, "open");
    assert.equal(accepted.report.f1Complete, false);
    assert.equal(accepted.report.cleanMachineExe, "not-recorded");
    assert.match(accepted.report.note, /complete the F1 gate/);
    const command = spawnSync(process.execPath, [path.join(__dirname, "check-world-partition.js")], { encoding: "utf8" });
    assert.equal(command.status, 2, command.stderr);
    const report = JSON.parse(command.stdout);
    assert.equal(report.acceptable, false);
    assert.equal(report.f1Complete, false);
});
