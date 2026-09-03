/**
 * @module atomicWrite.test
 * @description Verifies replacement, durability ordering and cleanup without loading Electron.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { promises as fsPromises } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { atomicWrite } = require("./atomicWrite");

describe("atomicWrite", () => {
    let dir = "";
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vde-write-")); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    test("replaces an existing file and leaves no sibling temporary file", async () => {
        const target = join(dir, "project.vde");
        writeFileSync(target, "old");
        await atomicWrite(target, "new");
        expect(readFileSync(target, "utf8")).toBe("new");
        expect(readdirSync(dir)).toEqual(["project.vde"]);
    });

    test("a failed temporary write preserves the last good destination and cleans up", async () => {
        const target = join(dir, "map.tmx");
        writeFileSync(target, "last-good");
        const io = {
            stat: fsPromises.stat.bind(fsPromises),
            rename: jest.fn(fsPromises.rename.bind(fsPromises)),
            unlink: fsPromises.unlink.bind(fsPromises),
            open: async (file: string, flags: string, mode: number) => {
                const handle = await fsPromises.open(file, flags, mode);
                return {
                    writeFile: async () => { throw new Error("disk full"); },
                    sync: handle.sync.bind(handle),
                    close: handle.close.bind(handle)
                };
            }
        };
        await expect(atomicWrite(target, "new", io)).rejects.toThrow("disk full");
        expect(io.rename).not.toHaveBeenCalled();
        expect(readFileSync(target, "utf8")).toBe("last-good");
        expect(readdirSync(dir)).toEqual(["map.tmx"]);
    });
});
