/**
 * @module normalize-guest-result
 * @description Turns the guest's field list into canonical result.json.
 * A status of passed is written only when the guest half of the evidence checker
 * already accepts that file, including when --require-acceptable is omitted.
 * It does not launch Windows Sandbox or sample a GPU.
 */
const fs = require("node:fs");
const path = require("node:path");
const { evaluateGuestLifecycleResult, fieldsToGuestResult, readJsonFile, writeGuestResultFile } = require("./installerEvidence");

function removeStalePassedResult(file) {
    const target = path.resolve(file);
    if (!fs.existsSync(target)) return;
    let keep = false;
    try {
        const existing = readJsonFile(target);
        keep = !existing || existing.status !== "passed";
    } catch {
        keep = false;
    }
    if (!keep) fs.unlinkSync(target);
}

function parseArgs(argv) {
    const args = { fields: null, out: null, requireAcceptable: false };
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        if (token === "--require-acceptable") {
            args.requireAcceptable = true;
            continue;
        }
        const next = argv[index + 1];
        if (token === "--fields" || token === "--out") {
            if (!next || next.startsWith("--")) throw new Error(`${token} needs a path.`);
            index += 1;
            if (token === "--fields") args.fields = next;
            else args.out = next;
        } else {
            throw new Error(`Unknown argument: ${token}`);
        }
    }
    if (!args.fields || !args.out) throw new Error("Pass --fields and --out.");
    return args;
}

function runNormalizeGuestResult(argv) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (error) {
        return { exitCode: 1, errors: [error.message], wrote: false };
    }
    let result;
    try {
        const text = fs.readFileSync(args.fields, "utf8").replace(/^\uFEFF/, "");
        result = fieldsToGuestResult(text);
    } catch (error) {
        return { exitCode: 1, errors: [`Could not read guest fields: ${error.message}`], wrote: false };
    }
    const mustAccept = args.requireAcceptable || result.status === "passed";
    const resultsDir = path.dirname(path.resolve(args.out));
    if (mustAccept) {
        const evaluation = evaluateGuestLifecycleResult(result, { resultsDir });
        if (!evaluation.acceptable) {
            removeStalePassedResult(args.out);
            return { exitCode: 1, errors: evaluation.failures, wrote: false };
        }
    }
    writeGuestResultFile(result, args.out);
    if (result.status === "passed") {
        let reread;
        try {
            reread = evaluateGuestLifecycleResult(readJsonFile(args.out), { resultsDir });
        } catch (error) {
            try { fs.unlinkSync(path.resolve(args.out)); } catch { /* a pass that cannot be re-read must not remain */ }
            return { exitCode: 1, errors: [`Could not re-read guest result: ${error.message}`], wrote: false };
        }
        if (!reread.acceptable) {
            try { fs.unlinkSync(path.resolve(args.out)); } catch { /* a pass the checker rejects must not remain */ }
            return { exitCode: 1, errors: reread.failures, wrote: false };
        }
    }
    return { exitCode: 0, errors: [], wrote: true };
}

if (require.main === module) {
    const outcome = runNormalizeGuestResult(process.argv.slice(2));
    if (outcome.errors.length) console.error(outcome.errors.join("\n"));
    process.exit(outcome.exitCode);
}

module.exports = { parseArgs, runNormalizeGuestResult };
