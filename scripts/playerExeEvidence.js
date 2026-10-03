/**
 * @module playerExeEvidence
 * @description Scores a recorded clean-machine player EXE file and writes the operator plan.
 * Reading that file does not launch an executable or apply a signature.
 */
const fs = require("fs");
const path = require("path");

const EVIDENCE_KIND = "windows-clean-machine-player-exe";
const REQUIRED_CHECKS = Object.freeze([
    "webgl-presented",
    "stop",
    "packaged-font",
    "overlay-text",
    "embedded-sound",
    "provenance-path-free",
    "level-transition",
    "streamed-payload"
]);
const RESULT_FIELDS = Object.freeze([
    "evidenceKind", "status", "signing", "publisherMetadata", "authenticity",
    "cleanMachine", "hostDevSmoke", "platform", "profile", "executable", "checks"
]);

function readJsonFile(file) {
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
}

function evaluatePlayerExeEvidence(result) {
    const failures = [];
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        return { acceptable: false, failures: ["Player EXE evidence is not an object."] };
    }
    const keys = Object.keys(result);
    const extra = keys.filter(key => !RESULT_FIELDS.includes(key));
    const missing = RESULT_FIELDS.filter(key => !Object.prototype.hasOwnProperty.call(result, key));
    if (extra.length || missing.length) {
        failures.push(`Result fields must be exactly ${RESULT_FIELDS.join(", ")}.`);
    }
    if (result.evidenceKind !== EVIDENCE_KIND) failures.push(`evidenceKind must be ${EVIDENCE_KIND}.`);
    if (result.status !== "passed") failures.push(`status is ${JSON.stringify(result.status ?? null)}, expected "passed".`);
    if (result.signing !== false) failures.push("signing must be false. This gate has no signing key.");
    if (result.publisherMetadata !== false) failures.push("publisherMetadata must be false.");
    if (result.authenticity !== "unsigned") failures.push('authenticity must be "unsigned".');
    if (result.cleanMachine !== true) failures.push("cleanMachine must be true.");
    if (result.hostDevSmoke !== false) failures.push("hostDevSmoke must be false. A development-host smoke is not clean-machine certification.");
    if (result.platform !== "win32") failures.push('platform must be "win32".');
    if (result.profile !== "spatial3d-v1") failures.push('profile must be "spatial3d-v1".');
    if (result.executable !== "Canvas Fogworks Game.exe") failures.push('executable must be "Canvas Fogworks Game.exe".');
    const checks = Array.isArray(result.checks) ? result.checks.map(item => String(item)) : [];
    const sameOrder = checks.length === REQUIRED_CHECKS.length && REQUIRED_CHECKS.every((check, index) => checks[index] === check);
    if (!sameOrder) failures.push(`checks must list ${REQUIRED_CHECKS.join(", ")} in that order.`);
    return { acceptable: failures.length === 0, failures };
}

function shellQuote(value) {
    const text = String(value);
    if (!/[\s&|<>^"]/.test(text)) return text;
    return `"${text.replace(/"/g, '\\"')}"`;
}

function playerExeEvidencePlan(options = {}) {
    const results = options.resultsDir || "PLAYER_EXE_RESULTS";
    const resultPath = options.resultsDir ? path.join(options.resultsDir, "result.json") : `${results}\\result.json`;
    return {
        gate: "EXPORT-001",
        status: "open",
        export001: "open",
        executedOnThisHost: false,
        evidenceAcceptable: false,
        cleanMachinePassRecorded: false,
        signing: false,
        publisherMetadata: false,
        reason: "This plan does not launch the unpacked player or sign it.",
        commands: [
            { step: 1, host: "windows", command: 'npm run package:game -- "entry.vde" "NEW-DIRECTORY" --desktop --stream --fonts "FONT-DIRECTORY"' },
            { step: 2, host: "windows", command: "Copy the entire desktop\\win-unpacked directory to a Windows machine that does not contain this repository or a code-signing certificate." },
            { step: 3, host: "windows", command: "Launch Canvas Fogworks Game.exe from that copy. Record WebGL, Stop, the packaged font, overlay text, the embedded cue, path-free provenance, a level transition and a streamed payload read." },
            { step: 4, host: "any", command: `npm run check:player-exe-evidence -- --result ${shellQuote(resultPath)}` }
        ],
        evidenceFiles: [
            {
                file: "result.json",
                pass: 'status "passed"; signing false; publisherMetadata false; authenticity "unsigned"; cleanMachine true; hostDevSmoke false; checks list the eight runtime observations in order',
                fail: 'a signature or publisher claim, a development-host smoke marked as certification, a missing runtime check, or any file other than this record'
            }
        ],
        checks: [...REQUIRED_CHECKS],
        manualGate: "EXPORT-001 stays open until a clean Windows machine records result.json and check:player-exe-evidence exits 0. Exit 2 means no evidence file was supplied. That exit is not a pass. Signing keys and publisher identity stay omitted."
    };
}

function operatorText(plan) {
    const lines = [
        "Canvas Fogworks EXPORT-001 player EXE evidence plan",
        "This file is not a clean-machine EXE pass and not a signature.",
        "",
        `Gate: ${plan.gate} (${plan.status})`,
        "Signing: omitted",
        "Publisher metadata: omitted",
        "",
        "Commands:"
    ];
    for (const command of plan.commands) lines.push(`${command.step}. [${command.host}] ${command.command}`);
    lines.push("", "Pass/fail:");
    for (const file of plan.evidenceFiles) {
        lines.push(`- ${file.file}`);
        lines.push(`  Pass: ${file.pass}`);
        lines.push(`  Fail: ${file.fail}`);
    }
    lines.push("", "checks, in order:");
    for (const check of plan.checks) lines.push(`- ${check}`);
    lines.push("", plan.manualGate, "");
    return `${lines.join("\n")}\n`;
}

function writePlayerExeEvidencePlan(directory) {
    const plan = playerExeEvidencePlan();
    fs.mkdirSync(directory, { recursive: true });
    const jsonPath = path.join(directory, "evidence-plan.json");
    const textPath = path.join(directory, "OPERATOR.txt");
    fs.writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`);
    fs.writeFileSync(textPath, operatorText(plan));
    return { jsonPath, textPath, checkerCommand: plan.commands[3].command, plan };
}

function assertHarnessContract(files = {}) {
    const failures = [];
    const root = path.join(__dirname, "..");
    const packageGame = files.packageGame ?? fs.readFileSync(path.join(__dirname, "package-game.js"), "utf8");
    const preload = files.preload ?? fs.readFileSync(path.join(root, "src/player3d/progressPreload.js"), "utf8");
    const stream = files.stream ?? fs.readFileSync(path.join(root, "src/player3d/packageStream.js"), "utf8");
    if (!packageGame.includes('arg === "--stream"')) failures.push("package:game must accept --stream.");
    if (!packageGame.includes("signAndEditExecutable: false")) failures.push("Desktop packaging must leave the executable unsigned.");
    if (!packageGame.includes("forceCodeSigning: false")) failures.push("Desktop packaging must not require a signing certificate.");
    if (!preload.includes('exposeInMainWorld("playerStreams"')) failures.push("The player preload must expose declared stream reads.");
    if (!preload.includes('exposeInMainWorld("playerProgress"')) failures.push("The player preload must keep the progress slot.");
    if (!stream.includes("function createPackageStreamReader")) failures.push("Package stream reads must check chunk bytes before returning them.");
    if (!stream.includes("Unknown package stream.")) failures.push("Package stream reads must refuse an id that the catalog does not name.");
    return { ok: failures.length === 0, failures };
}

function parseEvidenceArgs(argv) {
    const args = { result: null, planOut: null };
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        const next = argv[index + 1];
        if (token === "--result" || token === "--plan-out") {
            if (!next || next.startsWith("--")) throw new Error(`${token} needs a path.`);
            index += 1;
            if (token === "--result") args.result = next;
            else args.planOut = next;
        } else {
            throw new Error(`Unknown argument: ${token}`);
        }
    }
    return args;
}

function openReport(extra = {}) {
    return { export001: "open", executedOnThisHost: false, evidenceAcceptable: false, ...extra };
}

function runPlayerExeEvidenceCheck(argv) {
    let args;
    try {
        args = parseEvidenceArgs(argv);
    } catch (error) {
        return { exitCode: 1, report: openReport({ failures: [error.message] }) };
    }
    const contract = assertHarnessContract();
    if (!contract.ok) {
        return { exitCode: 1, report: openReport({ contractOk: false, failures: contract.failures }) };
    }
    if (args.planOut) writePlayerExeEvidencePlan(args.planOut, args);
    if (!args.result) {
        return {
            exitCode: 2,
            report: {
                ...playerExeEvidencePlan(),
                contractOk: true,
                playerExeEvidence: "not-supplied",
                note: "No evidence file was supplied. Exit 2 is the open manual gate, not a clean-machine EXE pass."
            }
        };
    }
    let evaluation = null;
    const failures = [];
    try {
        evaluation = evaluatePlayerExeEvidence(readJsonFile(args.result));
    } catch (error) {
        failures.push(`Could not read player EXE evidence: ${error.message}`);
    }
    if (evaluation && !evaluation.acceptable) failures.push(...evaluation.failures);
    const acceptable = failures.length === 0;
    return {
        exitCode: acceptable ? 0 : 1,
        report: openReport({
            evidenceAcceptable: acceptable,
            playerExeEvidence: evaluation ? (evaluation.acceptable ? "acceptable" : "rejected") : "unreadable",
            failures,
            note: acceptable
                ? "The file matches the clean-machine contract. EXPORT-001 stays open until a person reviews that file and updates the backlog. This command did not launch an executable or sign one."
                : "Evidence rejected. EXPORT-001 stays open."
        })
    };
}

module.exports = {
    EVIDENCE_KIND, REQUIRED_CHECKS, readJsonFile, evaluatePlayerExeEvidence,
    playerExeEvidencePlan, operatorText, writePlayerExeEvidencePlan, assertHarnessContract,
    runPlayerExeEvidenceCheck
};
