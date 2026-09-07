const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");
const { checkPackage, BUNDLES } = require("./check-package");

async function fixture(t, change = () => {}, options = {}) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-package-test-"));
    t.after(() => {
        const resolved = path.resolve(temporaryRoot);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith("fogworks-package-test-"));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const root = path.join(temporaryRoot, "build");
    const source = path.join(temporaryRoot, "archive-source");
    const archive = path.join(temporaryRoot, "app.asar");
    const write = (base, file, contents) => {
        const target = path.join(base, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    };
    const metadata = { name: "canvas-fogworks", version: "0.0.5", main: "dist/electron/main.js" };
    for (const base of [root, source]) {
        write(base, "package.json", JSON.stringify(metadata));
        for (const file of BUNDLES) write(base, file, `fixture contents for ${file}`);
    }
    await change({ root, source, write, metadata });
    await asar.createPackageWithOptions(source, archive, options);
    return { root, archive };
}

test("accepts current bundles and packaged runtime dependencies", async t => {
    const { root, archive } = await fixture(t, ({ source, write }) => write(source, "node_modules/uuid/package.json", "{}"));
    assert.equal(checkPackage(root, archive).bundles, 5);
});

for (const file of BUNDLES) {
    test(`rejects missing ${file}`, async t => {
        const { root, archive } = await fixture(t, ({ source }) => fs.unlinkSync(path.join(source, file)));
        assert.throws(() => checkPackage(root, archive), /Missing packaged file/);
    });
}

test("rejects stale offline player bytes", async t => {
    const { root, archive } = await fixture(t, ({ source, write }) => write(source, "dist/app/player.js", "old build"));
    assert.throws(() => checkPackage(root, archive), /Stale packaged bundle: dist\/app\/player.js/);
});

for (const folder of ["freeassets", "possable tools", "legacy", "reference-projects", "test-fixtures", "src", "dist/app/freeassets"]) {
    test(`rejects accidental ${folder} content`, async t => {
        const { root, archive } = await fixture(t, ({ source, write }) => write(source, `${folder}/example.txt`, "local-only"));
        assert.throws(() => checkPackage(root, archive), /Unexpected packaged path/);
    });
}

for (const key of ["name", "version", "main"]) {
    test(`rejects mismatched ${key}`, async t => {
        const { root, archive } = await fixture(t, ({ source, write, metadata }) =>
            write(source, "package.json", JSON.stringify({ ...metadata, [key]: "wrong" })));
        assert.throws(() => checkPackage(root, archive), new RegExp(`Packaged ${key} does not match`));
    });
}

test("rejects a required bundle stored outside the archive", async t => {
    const { root, archive } = await fixture(t, undefined, { unpack: "**/player.js" });
    assert.throws(() => checkPackage(root, archive), /must be stored inside the archive/);
});

test("rejects corrupt archives", async t => {
    const { root, archive } = await fixture(t);
    fs.writeFileSync(archive, "not an archive");
    assert.throws(() => checkPackage(root, archive));
});
