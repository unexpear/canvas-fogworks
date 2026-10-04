/**
 * @module package-signature.test
 * @description A missing certificate or publisher is not a package-signature pass.
 */
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { evaluatePackageSignature, signPackageStatement, runPackageSignatureCheck } = require("./packageSignature");

const HASH = "ab".repeat(32);

function pair(directory, name) {
    const key = path.join(directory, `${name}.key.pem`);
    const cert = path.join(directory, `${name}.cert.pem`);
    const result = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes", "-subj", "/CN=test-only.invalid"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return { key: fs.readFileSync(key, "utf8"), certificate: fs.readFileSync(cert, "utf8") };
}

test("a missing certificate or publisher is not a signature pass", () => {
    const omitted = evaluatePackageSignature({ authenticity: "unsigned", signing: false, publisher: null, certificatePem: null });
    assert.equal(omitted.acceptable, false);
    assert.equal(omitted.productSigned, false);
    assert.equal(omitted.publisherIdentified, false);
    assert.ok(omitted.failures.includes("missing-certificate"));
    assert.ok(omitted.failures.includes("missing-publisher"));
    const publisherOnly = evaluatePackageSignature({ manifestSha256: HASH, publisher: "test-only.invalid", certificatePem: "", signatureBase64: "", trustAnchorPem: "" });
    assert.equal(publisherOnly.acceptable, false);
    assert.ok(publisherOnly.failures.includes("missing-certificate"));
    const blank = evaluatePackageSignature({ manifestSha256: HASH, publisher: "   ", certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n", signatureBase64: "AAAA", trustAnchorPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" });
    assert.equal(blank.acceptable, false);
    assert.ok(blank.failures.includes("missing-publisher"));
    assert.equal(blank.publisherIdentified, false);
});

test("a verifying test key is not a pass without the matching trust anchor", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-signature-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const owned = pair(temporary, "owned");
    const other = pair(temporary, "other");
    const signature = signPackageStatement(HASH, "test-only.invalid", owned.key);
    const unanchored = evaluatePackageSignature({
        manifestSha256: HASH, publisher: "test-only.invalid", certificatePem: owned.certificate, signatureBase64: signature, trustAnchorPem: ""
    });
    assert.equal(unanchored.algorithmValid, true);
    assert.equal(unanchored.acceptable, false);
    assert.equal(unanchored.productSigned, false);
    assert.ok(unanchored.failures.includes("missing-trust-anchor"));
    const mismatched = evaluatePackageSignature({
        manifestSha256: HASH, publisher: "test-only.invalid", certificatePem: owned.certificate, signatureBase64: signature, trustAnchorPem: other.certificate
    });
    assert.equal(mismatched.acceptable, false);
    assert.ok(mismatched.failures.includes("trust-anchor-mismatch"));
    const renamed = evaluatePackageSignature({
        manifestSha256: HASH, publisher: "someone-else.invalid", certificatePem: owned.certificate, signatureBase64: signature, trustAnchorPem: owned.certificate
    });
    assert.equal(renamed.acceptable, false);
    assert.equal(renamed.publisherIdentified, false);
    const verified = evaluatePackageSignature({
        manifestSha256: HASH, publisher: "test-only.invalid", certificatePem: owned.certificate, signatureBase64: signature, trustAnchorPem: owned.certificate
    });
    assert.equal(verified.acceptable, true);
    assert.equal(verified.publisherIdentified, true);
    const missingPublisher = evaluatePackageSignature({
        manifestSha256: HASH, publisher: "", certificatePem: owned.certificate, signatureBase64: signature, trustAnchorPem: owned.certificate
    });
    assert.equal(missingPublisher.acceptable, false);
    assert.equal(missingPublisher.publisherIdentified, false);
    assert.ok(missingPublisher.failures.includes("missing-publisher"));
});

test("the checker leaves EXPORT-001 open when no certificate or publisher is supplied", t => {
    const dry = runPackageSignatureCheck([]);
    assert.equal(dry.exitCode, 2);
    assert.equal(dry.report.export001, "open");
    assert.equal(dry.report.f1Complete, false);
    assert.equal(dry.report.cleanMachineExe, "not-recorded");
    assert.equal(dry.report.signatureAcceptable, false);
    assert.equal(dry.report.publisherIdentified, false);
    assert.equal(dry.report.productSigned, false);
    assert.equal(dry.report.packagedPublisher, null);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-provenance-signature-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const provenance = path.join(temporary, "game.provenance.json");
    fs.writeFileSync(provenance, JSON.stringify({ manifestSha256: HASH, authenticity: "unsigned", publisher: null, signature: null, certificate: null }));
    const fromExport = runPackageSignatureCheck(["--provenance", provenance]);
    assert.equal(fromExport.exitCode, 2);
    assert.equal(fromExport.report.signatureAcceptable, false);
    assert.equal(fromExport.report.publisherIdentified, false);
    assert.equal(fromExport.report.export001, "open");
    assert.match(fromExport.report.note, /not a pass/);
    const publisherOnly = runPackageSignatureCheck(["--publisher", "test-only.invalid", "--manifest-sha256", HASH]);
    assert.equal(publisherOnly.exitCode, 2);
    assert.equal(publisherOnly.report.signatureAcceptable, false);
    assert.ok(publisherOnly.report.failures.includes("missing-certificate"));
});

test("a supplied test anchor can verify without closing EXPORT-001 or the F1 gate", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-signature-cli-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const owned = pair(temporary, "owned");
    const signature = path.join(temporary, "statement.sig");
    fs.writeFileSync(signature, signPackageStatement(HASH, "test-only.invalid", owned.key));
    const cert = path.join(temporary, "owned.cert.pem");
    const verified = runPackageSignatureCheck(["--manifest-sha256", HASH, "--publisher", "test-only.invalid", "--certificate", cert, "--signature", signature, "--trust-anchor", cert]);
    assert.equal(verified.exitCode, 0);
    assert.equal(verified.report.signatureAcceptable, true);
    assert.equal(verified.report.publisherIdentified, true);
    assert.equal(verified.report.productSigned, false);
    assert.equal(verified.report.export001, "open");
    assert.equal(verified.report.f1Complete, false);
    assert.equal(verified.report.cleanMachineExe, "not-recorded");
    assert.equal(verified.report.packagedPublisher, null);
    assert.match(verified.report.note, /did not sign a package/);
    const command = spawnSync(process.execPath, [path.join(__dirname, "check-package-signature.js")], { encoding: "utf8" });
    assert.equal(command.status, 2, command.stderr);
    const report = JSON.parse(command.stdout);
    assert.equal(report.signatureAcceptable, false);
    assert.equal(report.publisherIdentified, false);
    assert.equal(report.f1Complete, false);
    assert.equal(report.cleanMachineExe, "not-recorded");
});
