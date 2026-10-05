/**
 * @module check-world-partition
 * @description Prints the EXPORT-001 world-partition report.
 * Exit 2 means no partition table was supplied. That exit is not a pass.
 */
const fs = require("fs");
const { evaluateWorldPartitionClaim } = require("../src/runtime/worldPartitionTable");

function absentReport(note) {
    return {
        export001: "open",
        f1Complete: false,
        cleanMachineExe: "not-recorded",
        worldPartition: "absent",
        acceptable: false,
        streamed: false,
        reason: "missing-partition",
        note
    };
}

function runWorldPartitionCheck(argv) {
    let manifestPath = null;
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        if (token !== "--manifest") return { exitCode: 1, report: absentReport(`Unknown argument: ${token}. EXPORT-001 stays open.`) };
        const next = argv[++index];
        if (!next || next.startsWith("--")) return { exitCode: 1, report: absentReport("--manifest needs a path. EXPORT-001 stays open.") };
        manifestPath = next;
    }
    if (!manifestPath) {
        return { exitCode: 2, report: absentReport("No world-partition table was supplied. Exit 2 is not a pass. Chunk files beside a manifest are not a world partition, and this command does not complete the F1 gate.") };
    }
    if (!fs.existsSync(manifestPath)) {
        return { exitCode: 2, report: absentReport("No world-partition manifest file exists at that path. Exit 2 is not a pass.") };
    }
    let manifest;
    try {
        const text = fs.readFileSync(manifestPath, "utf8");
        if (text.charCodeAt(0) === 0xFEFF) manifest = JSON.parse(text.slice(1));
        else manifest = JSON.parse(text);
    } catch (error) {
        return { exitCode: 1, report: { ...absentReport("The manifest could not be read. EXPORT-001 stays open."), reason: error.message, worldPartition: "unreadable" } };
    }
    const claim = evaluateWorldPartitionClaim(manifest);
    if (!claim.acceptable && claim.reason === "missing-partition") {
        return { exitCode: 2, report: absentReport("The package has no world-partition block. Exit 2 is not a pass. EXPORT-001 stays open.") };
    }
    return {
        exitCode: claim.acceptable ? 0 : 1,
        report: {
            export001: "open",
            f1Complete: false,
            cleanMachineExe: "not-recorded",
            worldPartition: claim.acceptable ? "declared" : "rejected",
            acceptable: claim.acceptable,
            streamed: claim.streamed,
            reason: claim.reason,
            anchor: claim.anchor ?? null,
            cells: claim.cells ?? 0,
            note: claim.acceptable
                ? "The package names streamed world-partition cells. This command did not launch an executable, record a clean-machine EXE, or complete the F1 gate. Terrain and camera-driven paging remain open."
                : "The world-partition block was rejected. EXPORT-001 stays open."
        }
    };
}

if (require.main === module) {
    const outcome = runWorldPartitionCheck(process.argv.slice(2));
    console.log(JSON.stringify(outcome.report, null, 2));
    process.exit(outcome.exitCode);
}

module.exports = { runWorldPartitionCheck };
