/**
 * @module record-benchmark-sample
 * @description Stores one SCALE-001 host sample beside the frozen budgets.
 * Software GL is labeled and excluded from hardware budgets. Over-budget samples still exit 0.
 */
const fs = require("fs");
const path = require("path");
const budgets = require("./benchmark-budgets");

function parseArgs(argv) {
    const args = { _: [] };
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        if (token === "--id" || token === "--recorded" || token === "--out" || token === "--note") {
            const value = argv[index + 1];
            if (value == null || value.startsWith("--")) throw new Error(`${token} requires a value`);
            args[token.slice(2)] = value;
            index++;
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
    if (args._.length !== 1) {
        throw new Error("usage: node scripts/record-benchmark-sample.js <report.json> --id <id> --recorded YYYY-MM-DD [--out <id>.json]");
    }
    if (!args.id || !args.recorded) throw new Error("--id and --recorded are required");
    const report = JSON.parse(fs.readFileSync(path.resolve(args._[0]), "utf8"));
    const sample = budgets.hostSampleFromBenchmarkReport(report, {
        id: args.id,
        recorded: args.recorded,
        note: args.note
    });
    const stored = budgets.mergeHostSamples([], [sample]).samples[0];
    const comparison = budgets.compareHostSample(stored);
    let wrote = null;
    if (args.out) {
        const outPath = path.resolve(args.out);
        if (path.basename(outPath) !== `${stored.id}.json`) {
            throw new Error(`--out basename must be ${stored.id}.json`);
        }
        const body = `${JSON.stringify(stored, null, 2)}\n`;
        if (fs.existsSync(outPath)) {
            const existing = budgets.normalizeHostSample(JSON.parse(fs.readFileSync(outPath, "utf8")));
            if (JSON.stringify(existing) !== JSON.stringify(stored)) {
                throw new Error(`${outPath} already holds a different sample for ${stored.id}`);
            }
        } else {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, body);
        }
        wrote = outPath;
    }
    console.log(JSON.stringify({
        wrote,
        sample: stored,
        comparison,
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
