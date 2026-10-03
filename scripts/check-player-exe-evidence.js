/**
 * @module check-player-exe-evidence
 * @description Prints the EXPORT-001 player EXE evidence report.
 * Exit 0 means the supplied file matches the contract. Exit 2 means no file was supplied.
 */
const { runPlayerExeEvidenceCheck } = require("./playerExeEvidence");

if (require.main === module) {
    const outcome = runPlayerExeEvidenceCheck(process.argv.slice(2));
    console.log(JSON.stringify(outcome.report, null, 2));
    process.exit(outcome.exitCode);
}
