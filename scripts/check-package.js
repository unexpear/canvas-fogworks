/**
 * @module check-package
 * @description Verifies packaged application identity, current bundles and the release
 * archive allowlist without extracting files or changing an installed application.
 */
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const BUNDLES = [
    "dist/app/index.html", "dist/app/bundle.js", "dist/app/player.js",
    "dist/electron/main.js", "dist/electron/preload.js"
];
const DIRECTORIES = new Set(["dist", "dist/app", "dist/electron", "node_modules"]);

function checkPackage(root, archive) {
    // ASAR caches headers by path; repeated checks must inspect the current file.
    asar.uncache(archive);
    try {
        const entries = asar.listPackage(archive, {}).map(entry => entry.replace(/\\/g, "/").replace(/^\/+/, ""));
        for (const entry of entries) {
            if (entry.split("/").some(part => part === ".." || part === "." || part === "")) {
                throw new Error(`Invalid packaged path: ${entry}`);
            }
            if (!DIRECTORIES.has(entry) && !BUNDLES.includes(entry)
                && entry !== "package.json" && !entry.startsWith("node_modules/")) {
                throw new Error(`Unexpected packaged path: ${entry}`);
            }
        }
        const read = file => {
            if (!entries.includes(file)) throw new Error(`Missing packaged file: ${file}`);
            const entry = asar.statFile(archive, path.normalize(file), false);
            if (entry.link || entry.unpacked || entry.files) {
                throw new Error(`Required file must be stored inside the archive: ${file}`);
            }
            return asar.extractFile(archive, path.normalize(file));
        };
        const expected = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        const packaged = JSON.parse(read("package.json").toString("utf8"));
        for (const key of ["name", "version", "main"]) {
            if (packaged[key] !== expected[key]) throw new Error(`Packaged ${key} does not match package.json`);
        }
        for (const file of BUNDLES) {
            if (!read(file).equals(fs.readFileSync(path.join(root, file)))) {
                throw new Error(`Stale packaged bundle: ${file}`);
            }
        }
        return { entries: entries.length, bundles: BUNDLES.length, version: packaged.version };
    } finally {
        asar.uncache(archive);
    }
}

if (require.main === module) {
    const root = path.resolve(__dirname, "..");
    const archive = path.resolve(root, process.argv[2] || "release/win-unpacked/resources/app.asar");
    try {
        const result = checkPackage(root, archive);
        console.log(`Package check passed: ${result.bundles} current bundles, ${result.entries} entries, version ${result.version}.`);
    } catch (error) {
        console.error(`Package check failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { checkPackage, BUNDLES };
