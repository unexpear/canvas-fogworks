/**
 * @module check-package-signature
 * @description Prints the EXPORT-001 package signature report.
 * Exit 0 means the supplied materials verify. Exit 2 means a certificate or publisher was not supplied.
 */
const { runPackageSignatureCheck } = require("./packageSignature");

if (require.main === module) {
    const outcome = runPackageSignatureCheck(process.argv.slice(2));
    console.log(JSON.stringify(outcome.report, null, 2));
    process.exit(outcome.exitCode);
}
