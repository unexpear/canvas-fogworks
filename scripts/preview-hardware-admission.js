/**
 * @module preview-hardware-admission
 * @description Prints a SCALE-001 physical-GPU admission preview for a stored host sample.
 * The summary also reports that the frozen Iris Xe GPU entry is not a refileable sample.
 * Software GL stays ineligible. The command leaves the frozen budgets and CI gate unchanged.
 */
const fs = require("fs");
const path = require("path");
const budgets = require("./benchmark-budgets");

function parseArgs(argv) {
    const args = { _: [], physicalGpu: false, summary: false };
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        if (token === "--id" || token === "--dir") {
            const value = argv[index + 1];
            if (value == null || value.startsWith("--")) throw new Error(`${token} requires a value`);
            args[token.slice(2)] = value;
            index++;
        } else if (token === "--physical-gpu") {
            args.physicalGpu = true;
        } else if (token === "--summary") {
            args.summary = true;
        } else if (token.startsWith("-")) {
            throw new Error(`unknown argument ${token}`);
        } else {
            args._.push(token);
        }
    }
    return args;
}

function main(argv) {
    const args = parseArgs(argv);
    const directory = path.resolve(args.dir || path.join(__dirname, "benchmark-host-samples"));
    if (args.summary) {
        if (args.physicalGpu || args.id || args._.length > 0) {
            throw new Error("--summary does not take a sample or --physical-gpu");
        }
        const samples = budgets.loadHostSampleDirectory(directory);
        console.log(JSON.stringify(budgets.hardwareAdmissionRoster(samples), null, 2));
        return 0;
    }
    if (args._.length > 1 || (args._.length === 1 && args.id)) {
        throw new Error("pass a sample file or --id, not both");
    }
    let file = null;
    if (args.id) file = path.join(directory, `${args.id}.json`);
    else if (args._.length === 1) file = path.resolve(args._[0]);
    else {
        throw new Error("usage: node scripts/preview-hardware-admission.js (--summary | <sample.json> | --id <id>) [--physical-gpu]");
    }
    if (!fs.existsSync(file)) throw new Error(`no sample file at ${file}`);
    let sample;
    try {
        sample = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        throw new Error(`${file} is not valid JSON: ${error.message}`);
    }
    if (args.id && sample.id !== args.id) throw new Error(`${file} id is ${sample.id}, not ${args.id}`);
    const preview = budgets.previewHardwareAdmission(sample, { physicalGpuAttested: args.physicalGpu });
    console.log(JSON.stringify({
        preview,
        movesFrozenBudgets: false,
        ciGateEnabled: budgets.CI_GATE_ENABLED
    }, null, 2));
    return 0;
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { main, parseArgs };
