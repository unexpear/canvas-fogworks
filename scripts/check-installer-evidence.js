/**
 * @module check-installer-evidence
 * @description Prints the RELEASE-001 evidence report.
 * Exit 0 means the supplied files match the contract. Exit 2 means no files were supplied.
 */
const { runInstallerEvidenceCheck } = require("./installerEvidence");

if (require.main === module) {
    const outcome = runInstallerEvidenceCheck(process.argv.slice(2));
    console.log(JSON.stringify(outcome.report, null, 2));
    process.exit(outcome.exitCode);
}
