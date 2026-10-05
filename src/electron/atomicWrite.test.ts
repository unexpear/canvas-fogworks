/**
 * @module atomicWrite.test
 * @description Verifies replacement, durability ordering and cleanup without loading Electron.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { promises as fsPromises } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { atomicWrite } = require("./atomicWrite");

function deadPid(): number {
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    if (!exited.pid) throw new Error("Could not obtain an exited process id.");
    return exited.pid;
}

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

    test("flushes the parent directory after rename when this platform allows it", async () => {
        const target = join(dir, "project.vde");
        writeFileSync(target, "old");
        const events: string[] = [];
        const io = {
            ...fsPromises,
            rename: async (from: string, to: string) => {
                events.push("rename");
                return fsPromises.rename(from, to);
            },
            open: async (file: string, flags: string, mode?: number) => {
                const handle = await fsPromises.open(file, flags, mode);
                return {
                    writeFile: async (data: string) => {
                        events.push("write");
                        return handle.writeFile(data);
                    },
                    sync: async () => {
                        events.push(file === dir ? "sync-dir" : "sync-file");
                        return handle.sync();
                    },
                    close: () => handle.close()
                };
            }
        };
        await expect(atomicWrite(target, "new", io)).resolves.toEqual({ directorySynced: true });
        expect(events).toEqual([
            "write", "sync-file", "sync-dir",
            "write", "sync-file", "sync-dir",
            "rename", "sync-dir", "sync-dir"
        ]);
        expect(readFileSync(target, "utf8")).toBe("new");
        expect(readdirSync(dir)).toEqual(["project.vde"]);
    });

    test("a platform that refuses directory flush still keeps the replaced bytes", async () => {
        const target = join(dir, "project.vde");
        writeFileSync(target, "old");
        const io = {
            ...fsPromises,
            open: async (file: string, flags: string, mode?: number) => {
                if (file === dir) throw Object.assign(new Error("refused"), { code: "EPERM" });
                const handle = await fsPromises.open(file, flags, mode);
                return {
                    writeFile: (data: string) => handle.writeFile(data),
                    sync: () => handle.sync(),
                    close: () => handle.close()
                };
            }
        };
        await expect(atomicWrite(target, "new", io)).resolves.toEqual({ directorySynced: false });
        expect(readFileSync(target, "utf8")).toBe("new");
        expect(readdirSync(dir)).toEqual(["project.vde"]);
    });

    test("a directory flush error after rename keeps the new bytes and reports the checkpoint failure", async () => {
        const target = join(dir, "project.vde");
        writeFileSync(target, "old");
        let renamed = false;
        const io = {
            ...fsPromises,
            rename: async (from: string, to: string) => {
                renamed = true;
                return fsPromises.rename(from, to);
            },
            open: async (file: string, flags: string, mode?: number) => {
                if (file === dir) {
                    return {
                        writeFile: async () => undefined,
                        sync: async () => {
                            if (renamed) throw Object.assign(new Error("disk error"), { code: "EIO" });
                        },
                        close: async () => undefined
                    };
                }
                const handle = await fsPromises.open(file, flags, mode);
                return {
                    writeFile: (data: string | Buffer) => handle.writeFile(data),
                    sync: () => handle.sync(),
                    close: () => handle.close()
                };
            }
        };
        await expect(atomicWrite(target, "new", io)).rejects.toThrow(/could not flush its directory/);
        expect(readFileSync(target, "utf8")).toBe("new");
        expect(readdirSync(dir).includes("project.vde")).toBe(true);
    });

    test("the next replacement removes stale temps and keeps a live writer's temp", async () => {
        const target = join(dir, "project.vde");
        writeFileSync(target, "old");
        const own = join(dir, `.project.vde.${process.pid}.1.1.tmp`);
        const dead = join(dir, `.project.vde.${deadPid()}.2.1.tmp`);
        const live = join(dir, ".project.vde.1.3.1.tmp");
        writeFileSync(own, "partial");
        writeFileSync(dead, "partial");
        writeFileSync(live, "in progress");
        writeFileSync(join(dir, "notes.tmp"), "keep");
        await atomicWrite(target, "new");
        expect(readFileSync(target, "utf8")).toBe("new");
        expect(readdirSync(dir).sort()).toEqual([".project.vde.1.3.1.tmp", "notes.tmp", "project.vde"]);
        expect(readFileSync(live, "utf8")).toBe("in progress");
    });

    test("a second replacement does not delete an in-flight temp for the same file", async () => {
        const target = join(dir, "project.vde");
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        let entered = () => {};
        const ready = new Promise<void>(resolve => { entered = resolve; });
        let gated = false;
        const io = {
            ...fsPromises,
            open: async (file: string, flags: string, mode?: number) => {
                const handle = await fsPromises.open(file, flags, mode);
                return {
                    writeFile: async (data: string) => {
                        if (!gated && String(file).endsWith(".tmp")) {
                            gated = true;
                            entered();
                            await gate;
                        }
                        return handle.writeFile(data);
                    },
                    sync: () => handle.sync(),
                    close: () => handle.close()
                };
            }
        };
        const pending = atomicWrite(target, "one", io);
        try {
            await ready;
            const tempName = readdirSync(dir).find(name => name.endsWith(".tmp"));
            expect(tempName).toBeTruthy();
            await atomicWrite(target, "two");
            expect(readdirSync(dir)).toContain(tempName);
        } finally {
            release();
        }
        await pending;
        expect(readFileSync(target, "utf8")).toBe("one");
        expect(readdirSync(dir)).toEqual(["project.vde"]);
    });
});

describe("atomicWrite power-loss model", () => {
    let dir = "";
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vde-power-")); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    function snapshot(): Map<string, Buffer> {
        return new Map(readdirSync(dir).map(name => [name, readFileSync(join(dir, name))]));
    }

    function restore(saved: Map<string, Buffer>) {
        for (const name of readdirSync(dir)) {
            if (!saved.has(name)) rmSync(join(dir, name));
        }
        for (const [name, bytes] of saved) writeFileSync(join(dir, name), bytes);
    }

    test("after the commit marker directory flush, a crash before the replacement flush keeps the new bytes", async () => {
        const target = join(dir, "project.vde");
        writeFileSync(target, "previous");
        let renamed = false;
        let durable: Map<string, Buffer> | null = null;
        let armed = true;
        const io = {
            ...fsPromises,
            rename: async (from: string, to: string) => {
                await fsPromises.rename(from, to);
                renamed = true;
            },
            open: async (file: string, flags: string, mode?: number) => {
                const handle = await fsPromises.open(file, flags, mode);
                const directory = file === dir;
                return {
                    writeFile: (data: string | Buffer) => handle.writeFile(data),
                    sync: async () => {
                        // Directory operations since the last returned flush are discarded.
                        // This is not an unplugged disk; the bytes stay on this machine.
                        if (directory && renamed && armed && durable) {
                            armed = false;
                            restore(durable);
                            throw new Error("crash before directory fsync returns");
                        }
                        await handle.sync();
                        if (directory) durable = snapshot();
                    },
                    close: () => handle.close(),
                    stat: () => handle.stat()
                };
            }
        };
        await expect(atomicWrite(target, "published", io)).rejects.toThrow(/directory fsync returns/);
        expect(readFileSync(target, "utf8")).toBe("previous");
        expect(readdirSync(dir).some(name => name.endsWith(".commit"))).toBe(true);
        expect(readdirSync(dir).some(name => name.endsWith(".tmp"))).toBe(true);
        const failNextTemp: typeof io = {
            ...fsPromises,
            open: async (file: string, flags: string, mode?: number) => {
                if (String(flags).includes("w") && String(file).endsWith(".tmp")) {
                    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
                }
                return fsPromises.open(file, flags, mode);
            }
        };
        await expect(atomicWrite(target, "later", failNextTemp)).rejects.toThrow(/disk full/);
        expect(readFileSync(target, "utf8")).toBe("published");
    });

    test("a crash before the commit marker directory flush still drops the new name", async () => {
        const target = join(dir, "project.vde");
        writeFileSync(target, "previous");
        let directoryFlushes = 0;
        let durable: Map<string, Buffer> | null = null;
        let crashedImage: Map<string, Buffer> | null = null;
        const io = {
            ...fsPromises,
            open: async (file: string, flags: string, mode?: number) => {
                const handle = await fsPromises.open(file, flags, mode);
                const directory = file === dir;
                return {
                    writeFile: (data: string | Buffer) => handle.writeFile(data),
                    sync: async () => {
                        if (directory) {
                            directoryFlushes += 1;
                            if (directoryFlushes === 2 && durable) {
                                crashedImage = new Map(durable);
                                restore(durable);
                                throw new Error("crash before directory fsync returns");
                            }
                        }
                        await handle.sync();
                        if (directory) durable = snapshot();
                    },
                    close: () => handle.close(),
                    stat: () => handle.stat()
                };
            }
        };
        await expect(atomicWrite(target, "unpublished", io)).rejects.toThrow(/directory fsync returns/);
        expect(crashedImage).toBeTruthy();
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir);
        for (const [name, bytes] of crashedImage!) writeFileSync(join(dir, name), bytes);
        expect(readFileSync(target, "utf8")).toBe("previous");
        expect([...crashedImage!.keys()].some(name => name.endsWith(".commit"))).toBe(false);
        await atomicWrite(target, "later");
        expect(readFileSync(target, "utf8")).toBe("later");
        expect(readdirSync(dir)).toEqual(["project.vde"]);
    });

    test("a commit marker is not installed over a different newer explicit save", async () => {
        const target = join(dir, "project.vde");
        writeFileSync(target, "previous");
        let renamed = false;
        let durable: Map<string, Buffer> | null = null;
        const publishing = {
            ...fsPromises,
            rename: async (from: string, to: string) => {
                await fsPromises.rename(from, to);
                renamed = true;
            },
            open: async (file: string, flags: string, mode?: number) => {
                const handle = await fsPromises.open(file, flags, mode);
                const directory = file === dir;
                return {
                    writeFile: (data: string | Buffer) => handle.writeFile(data),
                    sync: async () => {
                        if (directory && renamed && durable) {
                            restore(durable);
                            throw new Error("crash before directory fsync returns");
                        }
                        await handle.sync();
                        if (directory) durable = snapshot();
                    },
                    close: () => handle.close(),
                    stat: () => handle.stat()
                };
            }
        };
        await expect(atomicWrite(target, "crashed-save", publishing)).rejects.toThrow(/directory fsync returns/);
        writeFileSync(target, "explicit-newer");
        const failNextTemp = {
            ...fsPromises,
            open: async (file: string, flags: string, mode?: number) => {
                if (String(flags).includes("w") && String(file).endsWith(".tmp")) {
                    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
                }
                return fsPromises.open(file, flags, mode);
            }
        };
        await expect(atomicWrite(target, "later", failNextTemp)).rejects.toThrow(/disk full/);
        expect(readFileSync(target, "utf8")).toBe("explicit-newer");
        expect(readdirSync(dir).some(name => name.endsWith(".commit") || name.endsWith(".tmp"))).toBe(false);
    });
});
