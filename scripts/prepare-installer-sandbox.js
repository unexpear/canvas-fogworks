/**
 * @module prepare-installer-sandbox
 * @description Stages only installer-test inputs and generates an offline Windows
 * Sandbox configuration. Does not launch or install anything on the host.
 */
const path = require("node:path");
const { prepareInstallerSandbox } = require("./installerLifecycle");

if (require.main === module) {
    const prepared = prepareInstallerSandbox({ root: path.resolve(__dirname, "..") });
    console.log(JSON.stringify({
        configuration: prepared.configuration,
        results: prepared.results,
        hardwareGpuCommand: prepared.hardwareGpuCommand
    }, null, 2));
}
