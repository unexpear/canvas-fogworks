/**
 * @module WorldPartition
 * @description Loads and releases streamed world-partition cells around a focus point.
 * The anchor stays resident when a neighbor fails or is cancelled. Residency cannot exceed the 32 MiB payload budget.
 */
const { PARTITION_BUDGET_BYTES } = require("./worldPartitionTable") as { PARTITION_BUDGET_BYTES: number };

export interface WorldPartitionCell {
    readonly id: string;
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
}
export interface WorldPartitionTable {
    readonly anchor: string;
    readonly loadRadius: number;
    readonly unloadRadius: number;
    readonly budgetBytes: number;
    readonly cells: readonly WorldPartitionCell[];
}
export interface WorldPartitionSource { read(fileId: string): Promise<Uint8Array> }
export type WorldPartitionCellStatus = "absent" | "loading" | "resident" | "failed" | "cancelled" | "over-budget";
export interface WorldPartitionSnapshot {
    readonly playable: boolean;
    readonly resident: readonly string[];
    readonly residentFiles: readonly string[];
    readonly payloadBytes: number;
    readonly statuses: Readonly<Record<string, WorldPartitionCellStatus>>;
}

type Focus = [number, number, number];

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
    let hex = "";
    for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
    return hex;
}

function distance(point: Focus, cell: WorldPartitionCell): number {
    let sum = 0;
    for (let index = 0; index < 3; index++) {
        const value = point[index];
        const delta = value < cell.min[index] ? cell.min[index] - value : value > cell.max[index] ? value - cell.max[index] : 0;
        sum += delta * delta;
    }
    return Math.sqrt(sum);
}

function focusOf(value: readonly number[]): Focus {
    if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== "number" || !Number.isFinite(item))) {
        throw new Error("Invalid world-partition focus.");
    }
    return [value[0], value[1], value[2]];
}

/** Caller-driven cell residency. The packaged player does not feed this a camera position. */
export function createWorldPartitionSession(table: WorldPartitionTable, source: WorldPartitionSource, options: { budgetBytes?: number } = {}) {
    if (!table || !Array.isArray(table.cells) || !table.cells.some(cell => cell.id === table.anchor)) {
        throw new Error("World partition table is not validated.");
    }
    if (typeof source?.read !== "function") throw new Error("World partition stream source is required.");
    const budget = options.budgetBytes ?? table.budgetBytes ?? PARTITION_BUDGET_BYTES;
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > PARTITION_BUDGET_BYTES) {
        throw new Error("World-partition residency cannot exceed the payload budget.");
    }
    const cells = new Map(table.cells.map(cell => [cell.id, cell]));
    const anchor = cells.get(table.anchor)!;
    const resident = new Set<string>();
    const payloads = new Map<string, Uint8Array>();
    const inflight = new Map<string, Promise<void>>();
    const statuses = new Map<string, WorldPartitionCellStatus>(table.cells.map(cell => [cell.id, "absent"]));
    let focus: Focus | null = null;
    let epoch = 0;
    let skipped = new Set<string>();

    const wanted = (cell: WorldPartitionCell) => focus !== null && (cell.id === anchor.id || distance(focus, cell) <= table.loadRadius);
    const payloadBytes = () => [...payloads.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    const snapshot = (): WorldPartitionSnapshot => Object.freeze({
        playable: resident.has(anchor.id),
        resident: Object.freeze([...resident].sort()),
        residentFiles: Object.freeze([...payloads.keys()].sort()),
        payloadBytes: payloadBytes(),
        statuses: Object.freeze(Object.fromEntries(statuses))
    });

    function release(cell: WorldPartitionCell): void {
        resident.delete(cell.id);
        if (![...resident].some(id => cells.get(id)!.file === cell.file)) payloads.delete(cell.file);
        if (statuses.get(cell.id) === "resident") statuses.set(cell.id, "absent");
    }

    function evict(): void {
        if (!resident.has(anchor.id) || !focus) return;
        for (const id of [...resident]) {
            const cell = cells.get(id)!;
            if (cell.id !== anchor.id && distance(focus, cell) > table.unloadRadius) release(cell);
        }
    }

    function refuse(cell: WorldPartitionCell, status: WorldPartitionCellStatus): void {
        statuses.set(cell.id, wanted(cell) ? status : "cancelled");
        if (wanted(cell)) skipped.add(cell.id);
    }
    function start(cell: WorldPartitionCell): Promise<void> {
        const pending = inflight.get(cell.id);
        if (pending) return pending;
        let finish = () => {};
        const job = new Promise<void>(resolve => { finish = resolve; });
        inflight.set(cell.id, job);
        void (async () => {
            statuses.set(cell.id, "loading");
            try {
                const bytes = await source.read(cell.file);
                if (!wanted(cell)) { statuses.set(cell.id, "cancelled"); return; }
                if (!(bytes instanceof Uint8Array) || bytes.length !== cell.bytes || await sha256Hex(bytes) !== cell.sha256 || !wanted(cell)) {
                    if (!wanted(cell)) statuses.set(cell.id, "cancelled");
                    else refuse(cell, "failed");
                    return;
                }
                if (cell.id !== anchor.id && !resident.has(anchor.id)) { refuse(cell, "failed"); return; }
                const extra = payloads.has(cell.file) ? 0 : bytes.length;
                if (payloadBytes() + extra > budget) { refuse(cell, "over-budget"); return; }
                payloads.set(cell.file, new Uint8Array(bytes));
                resident.add(cell.id);
                statuses.set(cell.id, "resident");
            } catch {
                refuse(cell, "failed");
            } finally {
                inflight.delete(cell.id);
                finish();
            }
        })();
        return job;
    }

    async function pump(generation: number): Promise<void> {
        for (;;) {
            if (generation !== epoch) return;
            if (!resident.has(anchor.id)) {
                if (skipped.has(anchor.id)) return;
                await start(anchor);
                if (generation !== epoch || !resident.has(anchor.id)) return;
            }
            const pending: Promise<void>[] = [];
            for (const cell of cells.values()) {
                if (cell.id === anchor.id || !wanted(cell) || resident.has(cell.id) || skipped.has(cell.id)) continue;
                pending.push(start(cell));
            }
            if (!pending.length) return;
            await Promise.all(pending);
        }
    }

    async function place(point: readonly number[]): Promise<WorldPartitionSnapshot> {
        focus = focusOf(point);
        const generation = ++epoch;
        skipped = new Set();
        await pump(generation);
        if (generation === epoch) evict();
        return snapshot();
    }

    return Object.freeze({
        setFocus: place,
        /** A teleport cancels in-flight cells that the new focus no longer wants and keeps a resident anchor. */
        teleport: place,
        snapshot
    });
}
