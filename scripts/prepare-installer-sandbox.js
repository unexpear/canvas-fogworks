/**
 * @module prepare-installer-sandbox
 * @description Stages installer-test inputs, an offline Windows Sandbox configuration,
 * and the operator plan for that staging folder. Does not launch or install anything on the host.
 */
const path = require("node:path");
const { prepareInstallerSandbox } = require("./installerLifecycle");
const { writeInstallerEvidencePlan } = require("./installerEvidence");

if (require.main === module) {
    const prepared = prepareInstallerSandbox({ root: path.resolve(__dirname, "..") });
    const plan = writeInstallerEvidencePlan(prepared.stage, { resultsDir: prepared.results });
    console.log(JSON.stringify({
        configuration: prepared.configuration,
        results: prepared.results,
        evidencePlan: plan.jsonPath,
        operatorInstructions: plan.textPath,
        hardwareGpuCommand: plan.hardwareGpuCommand,
        checkerCommand: plan.checkerCommand
    }, null, 2));
}
