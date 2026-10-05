/**
 * @module packageSignature
 * @description Verifies a detached package signature against a supplied certificate.
 * A missing certificate, publisher, signature or trust anchor is a failure, not a pass.
 * This module does not create a key, a certificate or a publisher identity.
 */
const crypto = require("crypto");
const fs = require("fs");

const STATEMENT_PREFIX = "canvas-fogworks-package-signature-v1\n";
const PUBLISHER_MAX = 128;
const CERT_LIMIT = 64 * 1024;
const SIGNATURE_LIMIT = 8 * 1024;

function canonicalStatement(manifestSha256, publisher) {
    return Buffer.from(`${STATEMENT_PREFIX}manifest:${manifestSha256}\npublisher:${publisher}\n`, "utf8");
}

function normalizePublisher(value) {
    if (typeof value !== "string") return null;
    const publisher = value.normalize("NFC").trim();
    if (!publisher || publisher.length > PUBLISHER_MAX || /[\u0000-\u001f\u007f]/.test(publisher)) return null;
    return publisher;
}

function readCertificate(pem) {
    if (typeof pem !== "string" || !pem.includes("BEGIN CERTIFICATE")) return null;
    try { return new crypto.X509Certificate(pem); } catch { return null; }
}

function decodeSignature(value) {
    if (typeof value !== "string") return null;
    const compact = value.replace(/\s+/g, "");
    if (!compact || compact.length > SIGNATURE_LIMIT || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
    const bytes = Buffer.from(compact, "base64");
    if (!bytes.length || bytes.toString("base64") !== compact) return null;
    return bytes;
}

/**
 * @param {object} input
 * @param {string} [input.manifestSha256]
 * @param {string} [input.publisher]
 * @param {string} [input.certificatePem]
 * @param {string} [input.signatureBase64]
 * @param {string} [input.trustAnchorPem]
 * The certificate subject is never used as a publisher. Unsigned provenance is not a pass.
 */
function evaluatePackageSignature(input) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const failures = [];
    const manifestSha256 = typeof source.manifestSha256 === "string" ? source.manifestSha256 : "";
    if (!/^[a-f0-9]{64}$/.test(manifestSha256)) failures.push("missing-manifest-hash");
    const publisher = normalizePublisher(source.publisher);
    if (!publisher) failures.push("missing-publisher");
    const certificateText = typeof source.certificatePem === "string" ? source.certificatePem : "";
    if (!certificateText.trim()) failures.push("missing-certificate");
    const certificate = certificateText.trim() ? readCertificate(certificateText) : null;
    if (certificateText.trim() && !certificate) failures.push("invalid-certificate");
    const signatureText = typeof source.signatureBase64 === "string" ? source.signatureBase64 : "";
    if (!signatureText.trim()) failures.push("missing-signature");
    const signature = signatureText.trim() ? decodeSignature(signatureText) : null;
    if (signatureText.trim() && !signature) failures.push("invalid-signature");
    const trustText = typeof source.trustAnchorPem === "string" ? source.trustAnchorPem : "";
    if (!trustText.trim()) failures.push("missing-trust-anchor");
    const trust = trustText.trim() ? readCertificate(trustText) : null;
    if (trustText.trim() && !trust) failures.push("invalid-trust-anchor");
    let algorithmValid = false;
    if (certificate && publisher && signature && /^[a-f0-9]{64}$/.test(manifestSha256)) {
        algorithmValid = crypto.verify("sha256", canonicalStatement(manifestSha256, publisher), certificate.publicKey, signature);
        if (!algorithmValid) failures.push("signature-mismatch");
    }
    let trustMatch = false;
    if (certificate && trust) {
        trustMatch = trust.raw.equals(certificate.raw);
        if (!trustMatch) failures.push("trust-anchor-mismatch");
    }
    const acceptable = failures.length === 0 && algorithmValid && trustMatch;
    return {
        acceptable,
        algorithmValid: algorithmValid && failures.every(failure => failure !== "signature-mismatch"),
        publisherIdentified: Boolean(publisher) && acceptable,
        productSigned: acceptable,
        failures
    };
}

function signPackageStatement(manifestSha256, publisher, privateKeyPem) {
    const normalized = normalizePublisher(publisher);
    if (!normalized || !/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error("Refusing to sign without a manifest hash and publisher.");
    return crypto.sign("sha256", canonicalStatement(manifestSha256, normalized), privateKeyPem).toString("base64");
}

function readText(file, max) {
    const text = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(text) > max) throw new Error(`Refusing an oversized signature input: ${file}`);
    return text;
}

function omittedReport() {
    return {
        export001: "open",
        f1Complete: false,
        cleanMachineExe: "not-recorded",
        signatureAcceptable: false,
        publisherIdentified: false,
        productSigned: false,
        packagedPublisher: null,
        packagedSignature: null,
        certificate: "absent",
        publisher: "absent",
        trustAnchor: "absent",
        failures: ["missing-certificate", "missing-publisher", "missing-signature", "missing-trust-anchor"],
        note: "No certificate or publisher was supplied. Exit 2 is not a signature pass and not a publisher identity. This command does not sign a package or complete the F1 gate."
    };
}

function parseSignatureArgs(argv) {
    const args = { provenance: null, manifestSha256: null, publisher: null, certificate: null, signature: null, trustAnchor: null };
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        const next = argv[index + 1];
        const named = {
            "--provenance": "provenance",
            "--manifest-sha256": "manifestSha256",
            "--publisher": "publisher",
            "--certificate": "certificate",
            "--signature": "signature",
            "--trust-anchor": "trustAnchor"
        }[token];
        if (!named) throw new Error(`Unknown argument: ${token}`);
        if (!next || next.startsWith("--")) throw new Error(`${token} needs a value.`);
        index += 1;
        args[named] = next;
    }
    return args;
}

function runPackageSignatureCheck(argv) {
    let args;
    try { args = parseSignatureArgs(argv); }
    catch (error) { return { exitCode: 1, report: { ...omittedReport(), failures: [error.message], note: "The signature check rejected its arguments. EXPORT-001 stays open." } }; }
    const supplied = args.provenance || args.manifestSha256 || args.publisher || args.certificate || args.signature || args.trustAnchor;
    if (!supplied) return { exitCode: 2, report: omittedReport() };
    try {
        let manifestSha256 = args.manifestSha256;
        let publisher = args.publisher;
        let certificatePem = args.certificate ? readText(args.certificate, CERT_LIMIT) : "";
        let signatureBase64 = args.signature ? readText(args.signature, SIGNATURE_LIMIT) : "";
        let trustAnchorPem = args.trustAnchor ? readText(args.trustAnchor, CERT_LIMIT) : "";
        if (args.provenance) {
            const provenance = JSON.parse(readText(args.provenance, 1024 * 1024));
            manifestSha256 = manifestSha256 ?? provenance.manifestSha256;
            if (publisher === null) publisher = typeof provenance.publisher === "string" ? provenance.publisher : "";
            if (!args.certificate) certificatePem = typeof provenance.certificate === "string" ? provenance.certificate : "";
            if (!args.signature) signatureBase64 = typeof provenance.signature === "string" ? provenance.signature : "";
        }
        const evaluation = evaluatePackageSignature({ manifestSha256, publisher, certificatePem, signatureBase64, trustAnchorPem });
        const missing = evaluation.failures.some(failure => failure.startsWith("missing-"));
        return {
            exitCode: evaluation.acceptable ? 0 : missing ? 2 : 1,
            report: {
                export001: "open",
                f1Complete: false,
                cleanMachineExe: "not-recorded",
                signatureAcceptable: evaluation.acceptable,
                publisherIdentified: evaluation.publisherIdentified,
                productSigned: false,
                packagedPublisher: null,
                packagedSignature: null,
                algorithmValid: evaluation.algorithmValid,
                failures: evaluation.failures,
                note: evaluation.acceptable
                    ? "The supplied certificate, publisher, signature and trust anchor match. This command did not sign a package, record a publisher in the repo, or complete the F1 gate. The exporter still ships unsigned."
                    : "Signature materials were rejected. A missing certificate or publisher is not a pass. EXPORT-001 stays open."
            }
        };
    } catch (error) {
        return {
            exitCode: 1,
            report: { ...omittedReport(), signatureAcceptable: false, failures: [error.message], note: "Signature materials could not be read. EXPORT-001 stays open." }
        };
    }
}

module.exports = {
    STATEMENT_PREFIX, canonicalStatement, evaluatePackageSignature, signPackageStatement, runPackageSignatureCheck
};
