/**
 * @module PlayerSession3D
 * @description Read-only player lifecycle, staged world adoption and host-driven fixed-step timing.
 * Hosts own input events, frame scheduling and GPU presentation; no editor or IPC authority is required.
 */

import type { ReadonlyDocument } from "../core/document/Document";
import { playerEntityId } from "../core/document/Entity";
import { advanceWorld3D, applyWorld3D, respawnRun3D, world3DFrom } from "../core/runtime/World3D";
import type { Input3D, World3DState } from "../core/runtime/World3D";
import { applyAnimations, applyMotionFades } from "../core/runtime/AnimationPlayback";
import { buildFrame3D } from "../renderer/Scene3D";
import type { Frame3D } from "../renderer/Scene3D";
import type { PlayerProjectReader } from "./ProjectReadHost";
import { RuntimeProject } from "./RuntimeProject";
import { checkpoint3D, interact3D } from "../core/runtime/Gameplay3D";
import { captureProgress3D, parseProgress, restoreProgress3D, serializeProgress } from "./PlayerProgress";

export type PlayerStatus3D = "stopped" | "loading" | "running" | "paused" | "ended";
interface ActivePlayer3D { project: RuntimeProject; world: World3DState; controlled: string | null }

export class PlayerSession3D {
    private active: ActivePlayer3D | null = null;
    private pending: RuntimeProject | null = null;
    private generation = 0;
    private playing = false;
    private lastTimestamp: number | null = null;
    private failure: Error | null = null;

    constructor(private readonly host: PlayerProjectReader, private readonly entryKey: string, private readonly gameId = "") {}

    get status(): PlayerStatus3D {
        if (this.pending) return "loading";
        if (!this.active) return "stopped";
        if (this.active.world.outcome !== "running") return "ended";
        return this.playing ? "running" : "paused";
    }
    get error(): Error | null { return this.failure; }
    get document(): ReadonlyDocument | null { return this.active?.project.document ?? null; }
    get world(): World3DState | null { return this.active?.world ?? null; }
    get filePath(): string | null { return this.active?.project.filePath ?? null; }

    /** Restart always reloads the configured entry, not the last visited level. */
    start(): Promise<boolean> {
        this.playing = true;
        return this.load(staged => staged.open(this.host, this.entryKey));
    }
    restart(): Promise<boolean> { return this.start(); }

    interact(): void {
        if (this.status !== "running" || !this.active?.controlled) return;
        this.active.world = interact3D(this.active.project.document!, this.active.world, this.active.controlled);
    }
    checkpoint(): void {
        if (this.status !== "running" || !this.active?.controlled) throw new Error("Start a level with a live player first.");
        this.active.world = checkpoint3D(this.active.world, this.active.controlled);
    }
    respawn(): void {
        if (!this.active?.controlled || this.pending) throw new Error("No loaded player to respawn.");
        this.active.world = respawnRun3D(this.active.project.document!, this.active.world, this.active.controlled); this.lastTimestamp = null; this.playing = true;
    }
    saveProgress(): string {
        if (!this.active?.controlled || this.pending || this.active.world.transitionTo) throw new Error("Cannot save without a stable playable level.");
        return serializeProgress(captureProgress3D(this.active.world, this.gameId, this.active.project.filePath!, this.active.controlled));
    }
    restoreProgress(serialized: string): Promise<boolean> {
        const progress = parseProgress(serialized, this.gameId, "3d");
        const read = this.host.readProgressLevel;
        if (!read) throw new Error("This host does not support saved-level lookup.");
        this.playing = false;
        return this.load(staged => staged.open({ ...this.host, readEntryFile: key => read.call(this.host, key) }, progress.level),
            (doc, world) => restoreProgress3D(doc, world, progress));
    }

    /** Explicit host action: a failed level is not retried on every animation frame. */
    followTransition(): Promise<boolean> {
        const current = this.active, target = current?.world.transitionTo;
        if (!current || !target || this.pending) return Promise.resolve(false);
        return this.load(staged => staged.transition(this.host, current.project.filePath, target));
    }

    stop(): void {
        this.generation++;
        this.pending?.reset(); this.pending = null;
        this.active?.project.reset(); this.active = null;
        this.playing = false; this.failure = null; this.lastTimestamp = null;
    }
    /** The host must call pause on blur/visibility loss and clear its own pressed-key state. */
    pause(): void { this.playing = false; this.lastTimestamp = null; }
    resume(): void {
        if (this.active || this.pending) this.playing = true;
        this.lastTimestamp = null;
    }

    private async load(read: (staged: RuntimeProject) => Promise<boolean>, restore?: (doc: ReadonlyDocument, world: World3DState) => World3DState): Promise<boolean> {
        const generation = ++this.generation;
        this.pending?.reset();
        const staged = new RuntimeProject(); this.pending = staged;
        this.lastTimestamp = null; this.failure = null;
        try {
            if (!await read(staged) || generation !== this.generation) return false;
            const document = staged.document!;
            if (![...document.nodes.values()].some(node => node.spatial3d?.camera)) {
                throw new Error("The 3D player needs a level with a 3D camera.");
            }
            // Construct the simulation before publishing any part of the new playable state.
            const fresh = world3DFrom(document), world = restore ? restore(document, fresh) : fresh;
            const selected = playerEntityId(document.nodes.values());
            const controlled = selected && world.bodies.get(selected)?.dynamic ? selected : null;
            const previous = this.active;
            this.active = { project: staged, world, controlled };
            previous?.project.reset();
            return true;
        } catch (cause) {
            if (generation !== this.generation) return false;
            this.failure = cause instanceof Error ? cause : new Error(String(cause));
            this.playing = false;
            throw this.failure;
        } finally {
            if (generation === this.generation) {
                this.pending = null;
                // Reads may complete after many host frames: never spend that load time as simulation.
                this.lastTimestamp = null;
            }
            if (this.active?.project !== staged) staged.reset();
        }
    }

    /** Timestamps are milliseconds from one monotonic host clock (e.g. requestAnimationFrame). */
    advance(timestamp: number, input: Input3D = { x: 0, y: 0, z: 0 }): void {
        if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("Invalid player frame timestamp.");
        if (![input.x, input.y, input.z].every(value => Number.isFinite(value) && Math.abs(value) <= 1)
            || (input.speed !== undefined && (!Number.isFinite(input.speed) || input.speed < 0 || input.speed > 1000))) {
            throw new Error("Invalid player movement input.");
        }
        const current = this.active;
        if (!current || !this.playing || this.pending || current.world.transitionTo || current.world.outcome !== "running") {
            this.lastTimestamp = null; return;
        }
        const last = this.lastTimestamp; this.lastTimestamp = timestamp;
        if (last === null || timestamp < last) return;
        const inputs = current.controlled ? new Map([[current.controlled, { ...input }]]) : new Map<string, Input3D>();
        current.world = advanceWorld3D(current.project.document!, current.world, (timestamp - last) / 1000, inputs);
    }

    /** Returns a transient scene; the host owns decoding/upload readiness and GPU lifetime. */
    frame(width: number, height: number): Frame3D | null {
        const current = this.active;
        if (!current) return null;
        if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 16384)) {
            throw new Error("Player viewport dimensions must be integers within 1–16384.");
        }
        const visual = applyMotionFades(applyAnimations(applyWorld3D(current.project.document!, current.world), current.world.animations), current.world.motionFades, current.world.time);
        return buildFrame3D(visual, current.project.meshes, width, height, current.project.environments, current.world.time);
    }
}
