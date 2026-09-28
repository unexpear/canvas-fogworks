/**
 * @module AnimationPlayback
 * @description Deterministic clip clocks, crossfades, state transitions and per-instance playheads.
 */
import { ReadonlyDocument } from "../document/Document";
import { AnimationCondition, AnimationController } from "../document/AnimationController";
import { Clip, clipFrameAt, clipLength, findClip } from "../document/Clips";
import { resolveVariantMaster, virtualId } from "../document/Components";
import { Node } from "../document/Node";

export interface AnimationPlayback {
    state: string; enteredAt: number; frame: number; signature: string;
    /** Outgoing clip while a crossfade is running. */
    from?: { state: string; enteredAt: number; frame: number };
    /** Crossfade length in seconds. Absent means the switch already completed. */
    fade?: number;
    /** 0 is the outgoing clip; 1 is the incoming clip. */
    blend?: number;
}
export type AnimationPlayers = ReadonlyMap<string, AnimationPlayback>;
export type AnimationSignals = ReadonlySet<AnimationCondition>;
export interface MotionFade { clip: number; fromClip?: number; startedAt: number; fade: number }
export type MotionFades = ReadonlyMap<string, MotionFade>;

/** Shared preview/runtime sampling. Non-finite or negative elapsed time starts at frame zero. */
export function sampleClip(clip: Clip, elapsedSeconds: number, fps: number, speed = 1): { frame: number; finished: boolean } {
    const elapsed = Number.isFinite(elapsedSeconds) && Number.isFinite(fps) && Number.isFinite(speed)
        ? Math.max(0, elapsedSeconds * fps * speed) : 0;
    // Fixed-step sums can sit a few ulps below an exact frame boundary.
    const frames = Math.floor(elapsed + 1e-9);
    return { frame: clipFrameAt(clip, frames), finished: clip.loop === false && frames >= clipLength(clip) };
}

interface Host { id: string; controller: AnimationController; signalId: string }

function signalFor(hostId: string, controller: AnimationController, doc: ReadonlyDocument): string {
    const driver = controller.driver;
    if (!driver) return hostId.includes("::") ? hostId.split("::")[0] : hostId;
    if (doc.nodes.has(driver)) return driver;
    if (hostId.includes("::")) return virtualId(hostId.slice(0, hostId.lastIndexOf("::")), driver);
    return driver;
}

/** Stored controllers plus one independent player for each expanded copy of a mastered controller. */
function animationHosts(doc: ReadonlyDocument): Host[] {
    const hosts: Host[] = [];
    for (const [id, node] of doc.nodes) if (node.animation) hosts.push({ id, controller: node.animation as AnimationController, signalId: signalFor(id, node.animation as AnimationController, doc) });
    const walk = (masterId: string, instancePath: string, depth: number, chain: ReadonlySet<string>) => {
        if (depth > 64) return;
        const master = doc.nodes.get(masterId);
        if (!master) return;
        const id = virtualId(instancePath, masterId);
        if (master.animation) hosts.push({ id, controller: master.animation as AnimationController, signalId: signalFor(id, master.animation as AnimationController, doc) });
        if (master.type === "core.instance") {
            const nested = resolveVariantMaster(doc, master);
            if (nested && !chain.has(nested)) walk(nested, id, depth + 1, new Set(chain).add(nested));
        }
        for (const child of master.children) walk(child, instancePath, depth + 1, chain);
    };
    for (const [id, node] of doc.nodes) {
        if (node.type !== "core.instance") continue;
        const masterId = resolveVariantMaster(doc, node);
        if (masterId) walk(masterId, id, 0, new Set([masterId]));
    }
    return hosts;
}

/** Missing clips stay inert and can be repaired in the editor without preventing a project load. */
export function stepAnimations(doc: ReadonlyDocument, previous: AnimationPlayers | undefined, time: number,
    signals: (driverId: string) => AnimationSignals = () => new Set()): AnimationPlayers | undefined {
    if (!doc.timeline || !Number.isFinite(time) || time < 0) return undefined;
    const players = new Map<string, AnimationPlayback>();
    for (const host of animationHosts(doc)) {
        const { id, controller } = host;
        const signature = JSON.stringify([controller, doc.clips, doc.timeline]);
        const prior = previous?.get(id);
        const validPrior = prior?.signature === signature && time >= prior.enteredAt ? prior : undefined;
        let state = controller.states.find(s => s.name === (validPrior?.state ?? controller.initial));
        if (!state) continue;
        let clip = findClip(doc.clips, state.clip);
        if (!clip) continue;
        let enteredAt = validPrior?.enteredAt ?? time;
        // A fade runs to completion before another rule can interrupt it.
        if (validPrior?.from && validPrior.fade && validPrior.fade > 0) {
            const fromState = controller.states.find(s => s.name === validPrior.from!.state);
            const fromClip = fromState && findClip(doc.clips, fromState.clip);
            const blend = Math.min(1, (time - validPrior.enteredAt) / validPrior.fade);
            if (fromState && fromClip && blend < 1) {
                const fromSample = sampleClip(fromClip, time - validPrior.from.enteredAt, doc.timeline.fps, fromState.speed);
                const toSample = sampleClip(clip, time - enteredAt, doc.timeline.fps, state.speed);
                players.set(id, { state: state.name, enteredAt, frame: toSample.frame, signature, fade: validPrior.fade, blend,
                    from: { state: fromState.name, enteredAt: validPrior.from.enteredAt, frame: fromSample.frame } });
                continue;
            }
        }
        let sample = sampleClip(clip, time - enteredAt, doc.timeline.fps, state.speed);
        // Creation/reset displays the entry frame before any outgoing transition is evaluated.
        if (validPrior) {
            const active = signals(host.signalId);
            const transition = controller.transitions.find(t => t.from === state!.name
                && (t.when === "finished" ? sample.finished : active.has(t.when)));
            if (transition) {
                const target = controller.states.find(s => s.name === transition.to);
                const targetClip = target && findClip(doc.clips, target.clip);
                if (target && targetClip) {
                    const previousState = state, previousEntered = enteredAt, previousFrame = sample.frame;
                    state = target; clip = targetClip; enteredAt = time;
                    sample = sampleClip(clip, 0, doc.timeline.fps, state.speed);
                    if (transition.fade && transition.fade > 0 && !(previousState.name === state.name && previousEntered === time)) {
                        players.set(id, { state: state.name, enteredAt, frame: sample.frame, signature, fade: transition.fade, blend: 0,
                            from: { state: previousState.name, enteredAt: previousEntered, frame: previousFrame } });
                        continue;
                    }
                }
            }
        }
        players.set(id, { state: state.name, enteredAt, frame: sample.frame, signature });
    }
    return players.size ? players : undefined;
}

function stampFor(player: AnimationPlayback): { frame: number; fromFrame?: number; frameBlend?: number } {
    return player.from && player.blend !== undefined && player.blend < 1
        ? { frame: player.frame, fromFrame: player.from.frame, frameBlend: player.blend }
        : { frame: player.frame };
}

/** A controller drives its subtree; an authored child controller establishes its own scope. */
export function applyAnimations(doc: ReadonlyDocument, players: AnimationPlayers | undefined): ReadonlyDocument {
    if (!players?.size) return doc;
    const nodes = new Map(doc.nodes);
    for (const [id, node] of doc.nodes) {
        let current: string | null = id;
        const visited = new Set<string>();
        while (current && !visited.has(current)) {
            visited.add(current);
            const ancestor = doc.nodes.get(current);
            if (ancestor?.animation) {
                const player = players.get(current);
                if (player) nodes.set(id, { ...node, ...stampFor(player) });
                break;
            }
            current = ancestor?.parent ?? null;
        }
    }
    const byOwner = new Map<string, Record<string, { frame: number; fromFrame?: number; frameBlend?: number }>>();
    for (const [id, player] of players) {
        if (!id.includes("::")) continue;
        const owner = id.split("::")[0];
        const record = byOwner.get(owner) ?? {};
        record[id] = stampFor(player);
        byOwner.set(owner, record);
    }
    for (const [owner, frames] of byOwner) {
        const node = nodes.get(owner);
        if (node) nodes.set(owner, { ...(node as Node), playbackFrames: frames });
    }
    return { ...doc, nodes };
}

/**
 * When a mesh clip changes during a run, blend from the clip that was playing.
 * Manual secondary clips stay in effect once the fade completes.
 */
export function stepMotionFades(doc: ReadonlyDocument, previous: MotionFades | undefined, time: number): MotionFades | undefined {
    if (!Number.isFinite(time) || time < 0) return undefined;
    const fades = new Map<string, MotionFade>();
    for (const [id, node] of doc.nodes) {
        const playback = node.spatial3d?.animation;
        const fade = playback?.fade;
        if (!playback || fade === undefined || !(fade > 0)) continue;
        const prior = previous?.get(id);
        if (prior && prior.clip === playback.clip && prior.fade === fade && time >= prior.startedAt) fades.set(id, prior);
        else fades.set(id, { clip: playback.clip, fromClip: prior && prior.clip !== playback.clip ? prior.clip : undefined, startedAt: time, fade });
    }
    return fades.size ? fades : undefined;
}

export function applyMotionFades(doc: ReadonlyDocument, fades: MotionFades | undefined, time: number): ReadonlyDocument {
    if (!fades?.size || !Number.isFinite(time)) return doc;
    let nodes: Map<string, Node> | null = null;
    for (const [id, fade] of fades) {
        if (fade.fromClip === undefined) continue;
        const progress = Math.max(0, Math.min(1, (time - fade.startedAt) / fade.fade));
        if (progress >= 1) continue;
        const node = doc.nodes.get(id);
        const animation = node?.spatial3d?.animation;
        if (!node?.spatial3d || !animation) continue;
        if (!nodes) nodes = new Map(doc.nodes as ReadonlyMap<string, Node>);
        nodes.set(id, { ...node, spatial3d: { ...node.spatial3d, animation: { ...animation, clip: fade.clip, secondaryClip: fade.fromClip, blend: 1 - progress } } } as Node);
    }
    return nodes ? { ...doc, nodes } : doc;
}
