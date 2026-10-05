/**
 * @module installerEvidence
 * @description Checks recorded installer-lifecycle files and writes the Windows operator plan.
 * Reading those files does not launch Windows Sandbox or sample a GPU.
 */
const fs = require("node:fs");
const path = require("node:path");
const { guestLifecyclePhases, hostHardwareGpuPhase, quoteCommandArg, sandboxConfigurationXml } = require("./installerLifecycle");
const { hardwareGpuVerdict } = require("./validate-hardware-gpu");

const GUEST_EVIDENCE_KIND = "windows-sandbox-installer-lifecycle";
const GUEST_HARDWARE_CLAIM = "not-certified-by-software-sandbox";
const HOST_GPU_EVIDENCE_KIND = "host-hardware-gpu";
const REQUIRED_WINDOWS_HOST = "DESKTOP-2SB8IKI";
const SMOKE_PASS_MARK = "smoke passed";

function expectedGuestSmokeLogs(phases = guestLifecyclePhases()) {
    const logs = [];
    for (const phase of phases) {
        if (phase.kind !== "smoke") continue;
        const stem = phase.smoke === "startup" ? `${phase.id}-startup` : phase.id;
        logs.push(`${stem}.stdout.log`, `${stem}.stderr.log`);
    }
    return logs;
}

function phaseList(value) {
    // Windows PowerShell 5.1 ConvertTo-Json unwraps a one-element array into a string.
    if (Array.isArray(value)) return value.map(item => String(item));
    if (typeof value === "string" && value.trim()) return [value];
    return [];
}

function readJsonFile(file) {
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
}

function evaluateGuestLifecycleResult(result, options = {}) {
    const failures = [];
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        return { acceptable: false, certifiesHardwareGpu: false, failures: ["Guest result is not an object."] };
    }
    if (result.evidenceKind !== GUEST_EVIDENCE_KIND) failures.push(`evidenceKind must be ${GUEST_EVIDENCE_KIND}.`);
    if (result.status !== "passed") failures.push(`status is ${JSON.stringify(result.status ?? null)}, expected "passed".`);
    if (result.error != null && result.error !== "") failures.push(`error is set: ${result.error}`);
    if (result.hardwareGpuValidation !== GUEST_HARDWARE_CLAIM) {
        failures.push(`hardwareGpuValidation must stay ${GUEST_HARDWARE_CLAIM}.`);
    }
    if (result.virtualGpu !== "disabled") failures.push('virtualGpu must be "disabled".');
    if (result.syntheticBaseline !== true) failures.push("syntheticBaseline must be true.");
    if (result.historicalReleaseInstaller !== false) failures.push("historicalReleaseInstaller must be false.");
    if (result.publisherMetadata !== false) failures.push("publisherMetadata must be false.");
    if (result.signing !== false) failures.push("signing must be false.");
    if (result.certifiesHardware === true || result.hardwareCertified === true) {
        failures.push("A software sandbox result cannot certify a hardware GPU.");
    }
    if (!/^[0-9A-Fa-f]{64}$/.test(String(result.installerSha256 ?? ""))) {
        failures.push("installerSha256 must be the 64-character hex hash of the current installer.");
    }
    const required = guestLifecyclePhases().map(phase => phase.id);
    const completed = phaseList(result.completedPhases);
    const sameOrder = completed.length === required.length && required.every((id, index) => completed[index] === id);
    if (!sameOrder) {
        const missing = required.filter(id => !completed.includes(id));
        failures.push(missing.length
            ? `Missing completed phases: ${missing.join(", ")}.`
            : "completedPhases must list every extended lifecycle phase in order.");
    }
    if (!options.resultsDir) {
        failures.push("Guest result directory is required so smoke logs can be checked.");
    } else {
        const names = expectedGuestSmokeLogs();
        const missingLogs = names.filter(name => !fs.existsSync(path.join(options.resultsDir, name)));
        if (missingLogs.length) failures.push(`Missing smoke logs: ${missingLogs.join(", ")}.`);
        const weakLogs = names.filter(name => {
            if (!name.endsWith(".stdout.log")) return false;
            const full = path.join(options.resultsDir, name);
            return fs.existsSync(full) && !fs.readFileSync(full, "utf8").includes(SMOKE_PASS_MARK);
        });
        if (weakLogs.length) failures.push(`Smoke stdout logs must contain "${SMOKE_PASS_MARK}": ${weakLogs.join(", ")}.`);
    }
    return { acceptable: failures.length === 0, certifiesHardwareGpu: false, failures };
}

function evaluateHardwareGpuEvidence(record) {
    const failures = [];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
        return { acceptable: false, hostname: "", failures: ["Hardware GPU evidence is not an object."] };
    }
    const hostname = typeof record.hostname === "string" ? record.hostname.trim() : "";
    if (record.evidenceKind !== HOST_GPU_EVIDENCE_KIND) failures.push(`evidenceKind must be ${HOST_GPU_EVIDENCE_KIND}.`);
    if (record.sandbox !== false) failures.push("sandbox must be false. The software-rendered guest cannot certify a hardware GPU.");
    if (record.virtualGpu !== "not-used") failures.push('virtualGpu must be "not-used". Host hardware evidence is collected outside Sandbox.');
    if (!hostname) failures.push("hostname must name the Windows host that drew the frame.");
    if (typeof record.recordedAt !== "string" || Number.isNaN(Date.parse(record.recordedAt))) {
        failures.push("recordedAt must be an ISO timestamp from the host draw.");
    }
    const recomputed = hardwareGpuVerdict(record.renderer, { drawOk: record.drawOk === true });
    if (record.classification !== recomputed.classification) {
        failures.push(`classification ${JSON.stringify(record.classification ?? null)} does not match the renderer string (${recomputed.classification}).`);
    }
    if (record.certifiesHardware !== recomputed.certifiesHardware) {
        failures.push("certifiesHardware does not match the recomputed verdict.");
    }
    if (!recomputed.certifiesHardware) {
        failures.push(`Renderer does not certify hardware (${recomputed.classification}: ${recomputed.reason}).`);
    }
    if (record.certifiesHardware !== true) failures.push("certifiesHardware must be true.");
    if (record.classification !== "hardware") failures.push("classification must be hardware.");
    if (record.drawOk !== true) failures.push("drawOk must be true.");
    return { acceptable: failures.length === 0, hostname, failures };
}

function installerEvidencePlan(options = {}) {
    const results = options.resultsDir || "SANDBOX_RESULTS";
    const guestResult = options.resultsDir ? path.join(options.resultsDir, "result.json") : `${results}\\result.json`;
    const gpuResult = options.resultsDir ? path.join(options.resultsDir, "hardware-gpu.json") : `${results}\\hardware-gpu.json`;
    const quotedGuest = quoteCommandArg(guestResult);
    const hardwareGpu = hostHardwareGpuPhase(gpuResult);
    return {
        gate: "RELEASE-001",
        status: "open",
        release001: "open",
        executedOnThisHost: false,
        evidenceAcceptable: false,
        sandboxPassRecorded: false,
        hardwareGpuPassRecorded: false,
        virtualGpu: "disabled",
        publisherMetadata: false,
        signing: false,
        requiredHost: REQUIRED_WINDOWS_HOST,
        reason: "This plan does not launch Windows Sandbox or sample a hardware GPU. Exit 2 with no files is the open manual gate, not a pass.",
        commands: [
            { step: 1, host: REQUIRED_WINDOWS_HOST, command: "npm run build:installer-test-baseline" },
            { step: 2, host: REQUIRED_WINDOWS_HOST, command: "npm run prepare:installer-sandbox" },
            { step: 3, host: REQUIRED_WINDOWS_HOST, command: "Open the generated installer-test.wsb in Windows Sandbox. Leave virtual GPU disabled. Approve the User Account Control prompt." },
            { step: 4, host: REQUIRED_WINDOWS_HOST, command: hardwareGpu.command },
            { step: 5, host: "any", command: `npm run check:installer-evidence -- --guest ${quotedGuest} --gpu ${quoteCommandArg(gpuResult)}` }
        ],
        evidenceFiles: [
            {
                file: "result.json",
                pass: 'status "passed"; completedPhases lists every extended phase in order; installerSha256 is 64 hex characters; hardwareGpuValidation "not-certified-by-software-sandbox"; virtualGpu "disabled"; each smoke stdout log contains "smoke passed"',
                fail: 'status "failed", a missing or reordered phase, a missing installer hash, a hardware-certification claim, or a smoke stdout log that does not contain "smoke passed"'
            },
            {
                file: "hardware-gpu.json",
                pass: "evidenceKind host-hardware-gpu, sandbox false, virtualGpu not-used, drawOk true, hostname and recordedAt from the host draw, and a hardware classification recomputed from the renderer string. validate:hardware-gpu exits 0 only after that file is re-read and accepted.",
                fail: "software renderer, lost WebGL context, sandbox true, virtualGpu other than not-used, or certifiesHardware false. Exit 2 from validate:hardware-gpu means the file was written and does not certify hardware. Exit 1 means no evidence file (missing --out, timeout, crash, or a certifying verdict the writer refused)."
            }
        ],
        smokeLogs: expectedGuestSmokeLogs(),
        filesToProduce: [
            "result.json in the staging results folder, written by the Sandbox guest through the staged Node writer, with status passed",
            'one stdout and stderr log per smoke phase beside result.json; each stdout log contains "smoke passed"',
            `hardware-gpu.json beside result.json, written by the step 4 command on ${REQUIRED_WINDOWS_HOST} outside Sandbox. The hostname field should read ${REQUIRED_WINDOWS_HOST}.`
        ],
        manualGate: `RELEASE-001 stays open until ${REQUIRED_WINDOWS_HOST} records both files and check:installer-evidence exits 0. Exit 2 means no evidence files were supplied. That exit is not a pass. Do not hand-write result.json or hardware-gpu.json.`,
        guestWriter: "The guest writes result.json with the staged Node writer. It sets status to passed only when that file already satisfies the guest half of the checker, including the current installer SHA-256 and every smoke log. A rejected pass removes a previous status passed file. That rewrite does not sample a GPU and does not close RELEASE-001."
    };
}

function operatorText(plan) {
    const lines = [
        "Canvas Fogworks RELEASE-001 evidence plan",
        "This file is not a Windows Sandbox pass and not a hardware-GPU certification.",
        "",
        `Gate: ${plan.gate} (${plan.status})`,
        `Required Windows host: ${plan.requiredHost}`,
        "Run the commands on that host. This plan does not record a pass.",
        "Virtual GPU: disabled",
        "Publisher metadata: omitted",
        "Signing: omitted",
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
    lines.push("", "Files that host must produce:");
    for (const file of plan.filesToProduce) lines.push(`- ${file}`);
    lines.push("", "Smoke logs that must sit beside result.json:");
    for (const name of plan.smokeLogs) lines.push(`- ${name}`);
    lines.push(
        "",
        "Startup phases use <phase-id>-startup.stdout.log and <phase-id>-startup.stderr.log.",
        "Workflow and historical-migration phases use <phase-id>.stdout.log and <phase-id>.stderr.log.",
        "",
        plan.guestWriter,
        "result.fields.txt and the evidence-writer logs beside result.json are scratch files. They are not evidence.",
        "Approve the User Account Control prompt if it appears before the per-machine phases. Declining still leaves RELEASE-001 open.",
        "Close Windows Sandbox after result.json shows status passed. Then run the hardware-GPU command on the host, outside Sandbox, and then the checker.",
        "",
        plan.manualGate,
        ""
    );
    return `${lines.join("\n")}\n`;
}

function writeInstallerEvidencePlan(directory, options = {}) {
    const plan = installerEvidencePlan(options);
    fs.mkdirSync(directory, { recursive: true });
    const jsonPath = path.join(directory, "evidence-plan.json");
    const textPath = path.join(directory, "OPERATOR.txt");
    fs.writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`);
    fs.writeFileSync(textPath, operatorText(plan));
    return {
        jsonPath,
        textPath,
        hardwareGpuCommand: plan.commands[3].command,
        checkerCommand: plan.commands[4].command,
        plan
    };
}

const SMOKE_KIND_BY_CALL = { Startup: "startup", Workflow: "workflow", Historical: "historical-migration" };

function guestSmokeInvocations(scriptText) {
    const calls = [];
    const pattern = /Smoke-(Startup|Workflow|Historical) '([^']+)'/g;
    let match;
    while ((match = pattern.exec(scriptText))) calls.push({ kind: match[1], id: match[2] });
    return calls;
}

function smokeLogNamesFromInvocations(calls) {
    const logs = [];
    for (const call of calls) {
        const stem = call.kind === "Startup" ? `${call.id}-startup` : call.id;
        logs.push(`${stem}.stdout.log`, `${stem}.stderr.log`);
    }
    return logs;
}

function guestSmokeContractFailures(scriptText) {
    const failures = [];
    const calls = guestSmokeInvocations(scriptText);
    const expected = guestLifecyclePhases().filter(phase => phase.kind === "smoke");
    if (calls.length !== expected.length) {
        failures.push(`Guest script invokes ${calls.length} smokes; the phase list has ${expected.length}.`);
    }
    const limit = Math.min(calls.length, expected.length);
    for (let index = 0; index < limit; index++) {
        const phase = expected[index];
        const call = calls[index];
        if (call.id !== phase.id) failures.push(`Smoke call '${call.id}' does not match phase '${phase.id}'.`);
        if (SMOKE_KIND_BY_CALL[call.kind] !== phase.smoke) {
            failures.push(`Phase ${phase.id} is a ${phase.smoke} smoke but the guest calls Smoke-${call.kind}.`);
        }
    }
    const derived = smokeLogNamesFromInvocations(calls);
    const required = expectedGuestSmokeLogs();
    if (derived.join("\n") !== required.join("\n")) {
        failures.push("Smoke log names derived from the guest script do not match the checker.");
    }
    return failures;
}

function decodeField(token) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(token) || token.length % 4 !== 0) {
        throw new Error("Evidence field value is not base64.");
    }
    return Buffer.from(token, "base64").toString("utf8");
}

function fieldsToGuestResult(text) {
    const result = {
        status: null,
        evidenceKind: null,
        virtualGpu: null,
        completedPhases: [],
        steps: [],
        error: null,
        syntheticBaseline: null,
        historicalReleaseInstaller: null,
        hardwareGpuValidation: null,
        publisherMetadata: null,
        signing: null
    };
    const booleans = new Set(["syntheticBaseline", "historicalReleaseInstaller", "publisherMetadata", "signing"]);
    const strings = new Set(["status", "evidenceKind", "virtualGpu", "hardwareGpuValidation", "installerSha256"]);
    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const space = line.indexOf(" ");
        if (space < 0) throw new Error(`Evidence field line is missing a value: ${line}`);
        const name = line.slice(0, space);
        const token = line.slice(space + 1);
        if (name === "completed") result.completedPhases.push(decodeField(token));
        else if (name === "step") result.steps.push(decodeField(token));
        else if (name === "error" && token === "~") result.error = null;
        else if (name === "error") result.error = decodeField(token);
        else if (booleans.has(name)) {
            if (token !== "true" && token !== "false") throw new Error(`${name} must be true or false.`);
            result[name] = token === "true";
        } else if (strings.has(name)) result[name] = decodeField(token);
        else throw new Error(`Unknown evidence field: ${name}`);
    }
    if (!result.installerSha256) delete result.installerSha256;
    return result;
}

function writeGuestResultFile(result, file) {
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
    return target;
}

function assertHarnessContract(files = {}) {
    const failures = [];
    const guestScript = files.guestScript ?? fs.readFileSync(path.join(__dirname, "test-installer-sandbox.ps1"), "utf8");
    const sandboxXml = files.sandboxXml ?? sandboxConfigurationXml({ input: "D:\\FogworksInput", results: "D:\\FogworksResults" });
    if (!guestScript.includes("function Complete-Phase")) failures.push("Guest script must record completedPhases through Complete-Phase.");
    if (!guestScript.includes("evidenceKind = 'windows-sandbox-installer-lifecycle'")) failures.push("Guest result must name the sandbox lifecycle evidence kind.");
    if (!guestScript.includes("virtualGpu = 'disabled'")) failures.push("Guest result must record virtual GPU disabled.");
    if (!guestScript.includes(`hardwareGpuValidation = '${GUEST_HARDWARE_CLAIM}'`)) failures.push("Guest result must refuse hardware certification.");
    if (!guestScript.includes("Complete-Phase 'unsigned-anonymous'")) failures.push("Guest script must complete unsigned-anonymous.");
    if (!guestScript.includes("${label}-startup.stdout.log") || !guestScript.includes("${label}.stdout.log")) {
        failures.push("Guest smoke logs must be named from the phase id.");
    }
    if (!guestScript.includes("normalize-guest-result.js")) failures.push("Guest script must write result.json through the staged Node writer.");
    if (!guestScript.includes("--require-acceptable")) failures.push("Guest script must refuse status passed unless the checker would accept the guest file.");
    if (!guestScript.includes("Guest evidence writer exited 0 without status passed")) {
        failures.push("Guest script must reject a writer exit 0 that did not leave status passed.");
    }
    if (!guestScript.includes("C:\\FogworksInput\\scripts\\validate-hardware-gpu.js")) {
        failures.push("Guest script must find the staged hardware-GPU classifier. The guest writer loads it and must not run it.");
    }
    if (/hardware-gpu\.json/.test(guestScript) || /validate:hardware-gpu/.test(guestScript)) {
        failures.push("Guest script must not write hardware-gpu.json or run validate:hardware-gpu.");
    }
    if (!guestScript.includes("SelectionItemPattern") || !guestScript.includes("InvokePattern")) {
        failures.push("Assisted installs must click through UI Automation invoke or selection before a raw button message.");
    }
    if (!guestScript.includes("WDAGUtilityAccount")) failures.push("Guest script must keep the Sandbox account guard.");
    if (!/<vGPU>Disable<\/vGPU>/.test(sandboxXml) || /<vGPU>\s*Enable/i.test(sandboxXml)) {
        failures.push("Sandbox configuration must keep virtual GPU disabled.");
    }
    failures.push(...guestSmokeContractFailures(guestScript));
    for (const phase of guestLifecyclePhases()) {
        if (!guestScript.includes(`'${phase.id}'`)) failures.push(`Guest script does not name phase ${phase.id}.`);
    }
    return { ok: failures.length === 0, failures };
}

function parseEvidenceArgs(argv) {
    const args = { guest: null, gpu: null, planOut: null };
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        const next = argv[index + 1];
        if (token === "--guest" || token === "--gpu" || token === "--plan-out") {
            if (!next || next.startsWith("--")) throw new Error(`${token} needs a path.`);
            index += 1;
            if (token === "--guest") args.guest = next;
            else if (token === "--gpu") args.gpu = next;
            else args.planOut = next;
        } else {
            throw new Error(`Unknown argument: ${token}`);
        }
    }
    return args;
}

function openReport(extra = {}) {
    return {
        release001: "open",
        executedOnThisHost: false,
        evidenceAcceptable: false,
        ...extra
    };
}

function runInstallerEvidenceCheck(argv) {
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
    if (args.planOut) writeInstallerEvidencePlan(args.planOut);
    if (!args.guest && !args.gpu) {
        return {
            exitCode: 2,
            report: {
                ...installerEvidencePlan(),
                contractOk: true,
                guestEvidence: "not-supplied",
                hardwareGpuEvidence: "not-supplied",
                note: `No evidence files were supplied. Exit 2 is the open manual gate, not a Windows Sandbox pass. Produce both files on ${REQUIRED_WINDOWS_HOST}, then pass them to this checker.`
            }
        };
    }
    if (!args.guest || !args.gpu) {
        return {
            exitCode: 1,
            report: openReport({
                failures: ["Pass both --guest result.json and --gpu hardware-gpu.json. One file cannot close the manual gate."]
            })
        };
    }
    const failures = [];
    let guestEval = null;
    let gpuEval = null;
    try {
        guestEval = evaluateGuestLifecycleResult(readJsonFile(args.guest), { resultsDir: path.dirname(path.resolve(args.guest)) });
    } catch (error) {
        failures.push(`Could not read guest result: ${error.message}`);
    }
    try {
        gpuEval = evaluateHardwareGpuEvidence(readJsonFile(args.gpu));
    } catch (error) {
        failures.push(`Could not read hardware GPU evidence: ${error.message}`);
    }
    if (guestEval && !guestEval.acceptable) failures.push(...guestEval.failures);
    if (gpuEval && !gpuEval.acceptable) failures.push(...gpuEval.failures);
    const acceptable = failures.length === 0;
    return {
        exitCode: acceptable ? 0 : 1,
        report: openReport({
            evidenceAcceptable: acceptable,
            guestEvidence: guestEval ? (guestEval.acceptable ? "acceptable" : "rejected") : "unreadable",
            hardwareGpuEvidence: gpuEval ? (gpuEval.acceptable ? "acceptable" : "rejected") : "unreadable",
            observedHostname: gpuEval ? gpuEval.hostname : "",
            failures,
            note: acceptable
                ? `Both files match the extended lifecycle contract. RELEASE-001 stays open until a person reviews those files, confirms hardware-gpu.json hostname is ${REQUIRED_WINDOWS_HOST}, and updates the backlog. This command did not launch Windows Sandbox or draw on a GPU.`
                : "Evidence rejected. RELEASE-001 stays open."
        })
    };
}

module.exports = {
    GUEST_EVIDENCE_KIND, GUEST_HARDWARE_CLAIM, HOST_GPU_EVIDENCE_KIND, REQUIRED_WINDOWS_HOST, SMOKE_PASS_MARK,
    expectedGuestSmokeLogs, readJsonFile, evaluateGuestLifecycleResult, evaluateHardwareGpuEvidence,
    guestSmokeInvocations, smokeLogNamesFromInvocations, guestSmokeContractFailures,
    fieldsToGuestResult, writeGuestResultFile,
    installerEvidencePlan, operatorText, writeInstallerEvidencePlan, assertHarnessContract,
    runInstallerEvidenceCheck
};
