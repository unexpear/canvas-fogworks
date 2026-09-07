/**
 * @module projectDependencies.test
 * @description Exercises relocated glTF sidecars, ignored-pack exclusion, conflicts and confinement using owned temporary fixtures.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const { copyProjectDependencies } = require("./projectDependencies");

let dir: string, source: string, dest: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fogworks-portable-"));
    source = join(dir, "source"); dest = join(dir, "destination");
    mkdirSync(source); mkdirSync(dest); mkdirSync(join(source, "models"));
    writeFileSync(join(source, "models", "shape.gltf"), JSON.stringify({ asset: { version: "2.0" },
        buffers: [{ uri: "shape.bin" }], images: [{ uri: "../color.png" }] }));
    writeFileSync(join(source, "models", "shape.bin"), "owned mesh");
    writeFileSync(join(source, "color.png"), "owned texture");
    writeFileSync(join(source, "unreferenced.png"), "do not copy");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const content = () => JSON.stringify({ document: { assets3d: [{ kind: "mesh", source: "models/shape.gltf" },
    { kind: "material", source: "models/shape.gltf#material-0" }] } });
const copy = () => copyProjectDependencies(join(source, "project.vde"), join(dest, "copy.vde"), content());

test("copies only referenced sources, buffers and textures; repeat saves accept identical files", async () => {
    await copy(); await copy();
    expect(readFileSync(join(dest, "models", "shape.bin"), "utf8")).toBe("owned mesh");
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("owned texture");
    expect(existsSync(join(dest, "unreferenced.png"))).toBe(false);
    expect(readFileSync(join(source, "color.png"), "utf8")).toBe("owned texture");
});
test("conflicts do not overwrite destination assets", async () => {
    writeFileSync(join(dest, "color.png"), "keep existing");
    await expect(copy()).rejects.toThrow("Dependency conflict");
    expect(readFileSync(join(dest, "color.png"), "utf8")).toBe("keep existing");
    expect(existsSync(join(dest, "models", "shape.gltf"))).toBe(false);
});
test("missing dependencies are detected before copying files", async () => {
    rmSync(join(source, "color.png"));
    await expect(copy()).rejects.toThrow();
    expect(existsSync(join(dest, "models"))).toBe(false);
});
test("source traversal and destination junction escape are refused", async () => {
    const outside = join(dir, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(dest, "models"), "junction");
    await expect(copy()).rejects.toThrow("outside");
    writeFileSync(join(source, "models", "shape.gltf"), JSON.stringify({ buffers: [{ uri: "../../outside/secret.bin" }] }));
    writeFileSync(join(outside, "secret.bin"), "private");
    await expect(copy()).rejects.toThrow("outside");
});
