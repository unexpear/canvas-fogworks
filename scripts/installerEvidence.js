/**
 * @module installerEvidence
 * @description Checks recorded installer-lifecycle files and writes the Windows operator plan.
 * Reading those files does not launch Windows Sandbox or sample a GPU.
 */
const fs = require("node:fs");
const path = require("node:path");
const { guestLifecyclePhases, sandboxConfigurationXml } = require("./installerLifecycle");
const { hardwareGpuVerdict } = require("./validate-hardware-gpu");

const GUEST_EVIDENCE_KIND = "windows-sandbox-installer-lifecycle";
const GUEST_HARDWARE_CLAIM = "not-certified-by-software-sandbox";
const HOST_GPU_EVIDENCE_KIND = "host-hardware-gpu";

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
    const required = guestLifecyclePhases().map(phase => phase.id);
    const completed = phaseList(result.completedPhases);
    const sameOrder = completed.length === required.length && required.every((id, index) => completed[index] === id);
    if (!sameOrder) {
        const missing = required.filter(id => !completed.includes(id));
        failures.push(missing.length
            ? `Missing completed phases: ${missing.join(", ")}.`
            : "completedPhases must list every extended lifecycle phase in order.");
    }
    if (options.resultsDir) {
        const missingLogs = expectedGuestSmokeLogs().filter(name => !fs.existsSync(path.join(options.resultsDir, name)));
        if (missingLogs.length) failures.push(`Missing smoke logs: ${missingLogs.join(", ")}.`);
    }
    return { acceptable: failures.length === 0, certifiesHardwareGpu: false, failures };
}

function evaluateHardwareGpuEvidence(record) {
    const failures = [];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
        return { acceptable: false, failures: ["Hardware GPU evidence is not an object."] };
    }
    if (record.evidenceKind !== HOST_GPU_EVIDENCE_KIND) failures.push(`evidenceKind must be ${HOST_GPU_EVIDENCE_KIND}.`);
    if (record.sandbox !== false) failures.push("sandbox must be false. The software-rendered guest cannot certify a hardware GPU.");
    if (record.virtualGpu === "enabled") failures.push("virtualGpu must stay unused for host hardware evidence.");
    const recomputed = hardwareGpuVerdict(record.renderer, { drawOk: record.drawOk === true });
    if (!recomputed.certifiesHardware) {
        failures.push(`Renderer does not certify hardware (${recomputed.classification}: ${recomputed.reason}).`);
    }
    if (record.certifiesHardware !== true) failures.push("certifiesHardware must be true.");
    if (record.classification !== "hardware") failures.push("classification must be hardware.");
    if (record.drawOk !== true) failures.push("drawOk must be true.");
    return { acceptable: failures.length === 0, failures };
}

function shellQuote(value) {
    const text = String(value);
    if (!/[\s&|<>^"]/.test(text)) return text;
    return `"${text.replace(/"/g, '\\"')}"`;
}

function installerEvidencePlan(options = {}) {
    const results = options.resultsDir || "SANDBOX_RESULTS";
    const guestResult = options.resultsDir ? path.join(options.resultsDir, "result.json") : `${results}\\result.json`;
    const gpuResult = options.resultsDir ? path.join(options.resultsDir, "hardware-gpu.json") : `${results}\\hardware-gpu.json`;
    const quotedGuest = shellQuote(guestResult);
    const quotedGpu = shellQuote(gpuResult);
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
        reason: "This plan does not launch Windows Sandbox or sample a hardware GPU.",
        commands: [
            { step: 1, host: "windows", command: "npm run build:installer-test-baseline" },
            { step: 2, host: "windows", command: "npm run prepare:installer-sandbox" },
            { step: 3, host: "windows", command: "Open the generated installer-test.wsb in Windows Sandbox. Leave virtual GPU disabled." },
            { step: 4, host: "windows", command: `npm run validate:hardware-gpu -- --out ${quotedGpu}` },
            { step: 5, host: "any", command: `npm run check:installer-evidence -- --guest ${quotedGuest} --gpu ${quotedGpu}` }
        ],
        evidenceFiles: [
            {
                file: "result.json",
                pass: 'status "passed"; completedPhases lists every extended phase in order; hardwareGpuValidation "not-certified-by-software-sandbox"; virtualGpu "disabled"',
                fail: 'status "failed", a missing or reordered phase, a hardware-certification claim, or a missing smoke log'
            },
            {
                file: "hardware-gpu.json",
                pass: "evidenceKind host-hardware-gpu, sandbox false, drawOk true, and a hardware classification recomputed from the renderer string",
                fail: "software renderer, lost WebGL context, sandbox true, or certifiesHardware false. Exit 2 from validate:hardware-gpu is this failure. Exit 1 is a timeout or crash."
            }
        ],
        smokeLogs: expectedGuestSmokeLogs(),
        manualGate: "RELEASE-001 stays open until a Windows host records both files and check:installer-evidence exits 0. Exit 2 means no evidence files were supplied. That exit is not a pass."
    };
}

function operatorText(plan) {
    const lines = [
        "Canvas Fogworks RELEASE-001 evidence plan",
        "This file is not a Windows Sandbox pass and not a hardware-GPU certification.",
        "",
        `Gate: ${plan.gate} (${plan.status})`,
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
    lines.push("", "Smoke logs that must sit beside result.json:");
    for (const name of plan.smokeLogs) lines.push(`- ${name}`);
    lines.push(
        "",
        "Startup phases use <phase-id>-startup.stdout.log and <phase-id>-startup.stderr.log.",
        "Workflow and historical-migration phases use <phase-id>.stdout.log and <phase-id>.stderr.log.",
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

function assertHarnessContract(files = {}) {
    const failures = [];
    const guestScript = files.guestScript ?? fs.readFileSync(path.join(__dirname, "test-installer-sandbox.ps1"), "utf8");
    const sandboxXml = files.sandboxXml ?? sandboxConfigurationXml({ input: "D:\\FogworksInput", results: "D:\\FogworksResults" });
    if (!guestScript.includes("function Complete-Phase")) failures.push("Guest script must record completedPhases through Complete-Phase.");
    if (!guestScript.includes("evidenceKind = 'windows-sandbox-installer-lifecycle'")) failures.push("Guest result must name the sandbox lifecycle evidence kind.");
    if (!guestScript.includes("virtualGpu = 'disabled'")) failures.push("Guest result must record virtual GPU disabled.");
    if (!guestScript.includes(`hardwareGpuValidation = '${GUEST_HARDWARE_CLAIM}'`)) failures.push("Guest result must refuse hardware certification.");
    if (!guestScript.includes("Complete-Phase 'unsigned-anonymous'")) failures.push("Guest script must complete unsigned-anonymous.");
    if (!guestScript.includes("$label-startup.stdout.log") || !guestScript.includes("$label.stdout.log")) {
        failures.push("Guest smoke logs must be named from the phase id.");
    }
    if (!guestScript.includes("WDAGUtilityAccount")) failures.push("Guest script must keep the Sandbox account guard.");
    if (!/<vGPU>Disable<\/vGPU>/.test(sandboxXml) || /<vGPU>\s*Enable/i.test(sandboxXml)) {
        failures.push("Sandbox configuration must keep virtual GPU disabled.");
    }
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
                note: "No evidence files were supplied. Exit 2 is the open manual gate, not a Windows Sandbox pass."
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
            failures,
            note: acceptable
                ? "Both files match the extended lifecycle contract. RELEASE-001 stays open until a person reviews those files and updates the backlog. This command did not launch Windows Sandbox or draw on a GPU."
                : "Evidence rejected. RELEASE-001 stays open."
        })
    };
}

module.exports = {
    GUEST_EVIDENCE_KIND, GUEST_HARDWARE_CLAIM, HOST_GPU_EVIDENCE_KIND,
    expectedGuestSmokeLogs, readJsonFile, evaluateGuestLifecycleResult, evaluateHardwareGpuEvidence,
    installerEvidencePlan, operatorText, writeInstallerEvidencePlan, assertHarnessContract,
    runInstallerEvidenceCheck
};
