/** @module WorldPartition.test @description Cell load, cancellation, anchor retention and the residency budget. */
import { createHash } from "crypto";
import { GAME_PACKAGE_LIMITS } from "./GamePackage";
import { createWorldPartitionSession } from "./WorldPartition";
import type { WorldPartitionSource, WorldPartitionTable } from "./WorldPartition";
const { PARTITION_BUDGET_BYTES, validateWorldPartition } = require("./worldPartitionTable") as {
    PARTITION_BUDGET_BYTES: number;
    validateWorldPartition: (value: unknown, files: ReadonlyMap<string, { kind: string; bytes: number; streamed: boolean; sha256: string | null }>) => WorldPartitionTable;
};

const anchorBytes = Uint8Array.from(Buffer.from("anchor"));
const nearBytes = Uint8Array.from(Buffer.from("near-cell"));
const farBytes = Uint8Array.from(Buffer.from("far-cell"));

function digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}
function file(id: string, bytes: Uint8Array) {
    return { kind: "buffer", bytes: bytes.length, streamed: true, sha256: digest(bytes), id };
}
function table(): WorldPartitionTable {
    const files = new Map([
        ["anchor-file", file("anchor-file", anchorBytes)],
        ["near-file", file("near-file", nearBytes)],
        ["far-file", file("far-file", farBytes)]
    ]);
    return validateWorldPartition({
        anchor: "anchor", loadRadius: 10, unloadRadius: 30,
        cells: [
            { id: "anchor", min: [-1, -1, -1], max: [1, 1, 1], file: "anchor-file" },
            { id: "near", min: [5, -1, -1], max: [6, 1, 1], file: "near-file" },
            { id: "far", min: [100, -1, -1], max: [101, 1, 1], file: "far-file" }
        ]
    }, files);
}
function source(payloads: Map<string, Uint8Array>, reads: string[] = [], gate: { id?: string; promise?: Promise<Uint8Array> } = {}): WorldPartitionSource {
    return { async read(id: string) {
        reads.push(id);
        if (gate.id === id && gate.promise) return gate.promise;
        const found = payloads.get(id);
        if (!found) throw new Error(`Missing ${id}.`);
        return found;
    } };
}
const payloads = () => new Map([["anchor-file", anchorBytes], ["near-file", nearBytes], ["far-file", farBytes]]);

test("the cell budget matches the package payload budget", () => {
    expect(PARTITION_BUDGET_BYTES).toBe(GAME_PACKAGE_LIMITS.assetBytes);
    expect(() => createWorldPartitionSession(table(), source(payloads()), { budgetBytes: PARTITION_BUDGET_BYTES + 1 })).toThrow(/payload budget/);
});

test("focus loads the anchor and nearby cells, and a failed neighbor leaves the anchor resident", async () => {
    const reads: string[] = [];
    const session = createWorldPartitionSession(table(), source(payloads(), reads));
    const first = await session.setFocus([0, 0, 0]);
    expect(first.playable).toBe(true);
    expect(first.resident).toEqual(["anchor", "near"]);
    expect(reads).toEqual(["anchor-file", "near-file"]);
    const again = await session.setFocus([0, 0, 0]);
    expect(again.resident).toEqual(["anchor", "near"]);
    expect(reads).toEqual(["anchor-file", "near-file"]);
    const broken = new Map(payloads());
    broken.set("far-file", Uint8Array.from(farBytes.map(byte => byte ^ 0xff)));
    const failing = createWorldPartitionSession(table(), source(broken));
    await failing.setFocus([0, 0, 0]);
    const after = await failing.teleport([100, 0, 0]);
    expect(after.playable).toBe(true);
    expect(after.resident).toEqual(["anchor"]);
    expect(after.statuses.far).toBe("failed");
    expect(after.residentFiles).toEqual(["anchor-file"]);
});

test("a read cancelled by teleport does not become resident, and the anchor is kept", async () => {
    let release: (bytes: Uint8Array) => void = () => {};
    const gate = new Promise<Uint8Array>(resolve => { release = resolve; });
    let opened: () => void = () => {};
    const entered = new Promise<void>(resolve => { opened = resolve; });
    const reads: string[] = [];
    const session = createWorldPartitionSession(table(), { async read(id: string) {
        reads.push(id);
        if (id === "near-file") { opened(); return gate; }
        const found = payloads().get(id);
        if (!found) throw new Error(`Missing ${id}.`);
        return found;
    } });
    const pending = session.setFocus([0, 0, 0]);
    await entered;
    const moved = session.teleport([100, 0, 0]);
    release(nearBytes);
    const first = await pending;
    const second = await moved;
    expect(first.resident).not.toContain("near");
    expect(second.playable).toBe(true);
    expect(second.resident).toEqual(["anchor", "far"]);
    expect(second.statuses.near).toBe("cancelled");
    expect(second.residentFiles).not.toContain("near-file");
    expect(reads.filter(id => id === "near-file")).toEqual(["near-file"]);
});

test("cells outside the unload radius are released and an over-budget cell does not evict the anchor", async () => {
    const session = createWorldPartitionSession(table(), source(payloads()));
    await session.setFocus([0, 0, 0]);
    const held = await session.setFocus([20, 0, 0]);
    expect(held.resident).toEqual(["anchor", "near"]);
    const far = await session.teleport([100, 0, 0]);
    expect(far.resident).toEqual(["anchor", "far"]);
    expect(far.residentFiles).not.toContain("near-file");
    const tight = createWorldPartitionSession(table(), source(payloads()), { budgetBytes: anchorBytes.length });
    const capped = await tight.setFocus([0, 0, 0]);
    expect(capped.playable).toBe(true);
    expect(capped.resident).toEqual(["anchor"]);
    expect(capped.statuses.near).toBe("over-budget");
    expect(capped.payloadBytes).toBe(anchorBytes.length);
    await expect(tight.setFocus([Number.NaN, 0, 0])).rejects.toThrow(/focus/);
    expect(tight.snapshot().resident).toEqual(["anchor"]);
});

test("a shared payload is counted once and an anchor failure does not publish neighbors", async () => {
    const shared = new Map([["anchor-file", file("anchor-file", anchorBytes)]]);
    const joined = validateWorldPartition({
        anchor: "anchor", loadRadius: 10, unloadRadius: 20,
        cells: [
            { id: "anchor", min: [-1, -1, -1], max: [1, 1, 1], file: "anchor-file" },
            { id: "near", min: [2, -1, -1], max: [3, 1, 1], file: "anchor-file" }
        ]
    }, shared);
    const session = createWorldPartitionSession(joined, source(new Map([["anchor-file", anchorBytes]])), { budgetBytes: anchorBytes.length });
    const both = await session.setFocus([0, 0, 0]);
    expect(both.resident).toEqual(["anchor", "near"]);
    expect(both.payloadBytes).toBe(anchorBytes.length);
    const failing = createWorldPartitionSession(table(), { async read() { throw new Error("unavailable"); } });
    const blocked = await failing.setFocus([0, 0, 0]);
    expect(blocked.playable).toBe(false);
    expect(blocked.resident).toEqual([]);
    expect(blocked.statuses.anchor).toBe("failed");
    expect(blocked.statuses.near).toBe("absent");
});
