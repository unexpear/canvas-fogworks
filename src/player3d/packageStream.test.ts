/** @module packageStream.test @description Chunk path confinement, hash checks and HTML catalog extraction. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
const { createPackageStreamReader, streamCatalogFromHtml, streamCatalogFromSerialized } = require("./packageStream");

const bytes = Buffer.from("owned-chunk");
const sha256 = createHash("sha256").update(bytes).digest("hex");
function catalog() {
    return streamCatalogFromSerialized(JSON.stringify({ files: [
        { id: "file0", kind: "buffer", bytes: bytes.length, sha256 },
        { id: "face", kind: "font", bytes: 4, data: "AAAA" }
    ] }));
}
let temp: string;
beforeEach(() => { temp = mkdtempSync(join(tmpdir(), "fogworks-stream-")); });
afterEach(() => rmSync(temp, { recursive: true, force: true }));

test("a declared chunk is returned only when its bytes and hash match", async () => {
    const directory = join(temp, "streams"); mkdirSync(directory);
    writeFileSync(join(directory, "file0.bin"), bytes);
    const reader = createPackageStreamReader(directory, catalog());
    expect(await reader.read("file0")).toBe(bytes.toString("base64"));
    await expect(reader.read("../file0")).rejects.toThrow(/Unknown package stream/);
    await expect(reader.read("face")).rejects.toThrow(/Unknown package stream/);
    writeFileSync(join(directory, "file0.bin"), Buffer.from("owned-chunX"));
    await expect(reader.read("file0")).rejects.toThrow(/hash mismatch/);
});

test("the HTML catalog ignores inline files and refuses an unsafe id", () => {
    const serialized = JSON.stringify({ files: [{ id: "file0", kind: "hdr", bytes: bytes.length, sha256 }, { id: "model", kind: "gltf", bytes: 2, data: "e30=" }] });
    const html = `<script id="game-data" type="application/octet-stream" data-sha256="${"ab".repeat(32)}">${Buffer.from(serialized).toString("base64")}</script>`;
    expect(streamCatalogFromHtml(html)).toEqual([{ id: "file0", bytes: bytes.length, sha256 }]);
    expect(streamCatalogFromHtml(`<script id="game-data" type="application/octet-stream" data-sha256="${"cd".repeat(32)}">${Buffer.from(JSON.stringify({ files: [{ id: "model", kind: "gltf", bytes: 2, data: "e30=" }] })).toString("base64")}</script>`)).toEqual([]);
    expect(() => streamCatalogFromSerialized(JSON.stringify({ files: [{ id: "../secret", kind: "buffer", bytes: 1, sha256 }] }))).toThrow(/stream id/);
    expect(() => streamCatalogFromHtml("<html></html>")).toThrow(/payload is missing/);
});
