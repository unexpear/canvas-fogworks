/**
 * @module AnimationPlayback
 * @description Deterministic clip clocks, state transitions and derived per-node playheads.
 */
import { ReadonlyDocument } from "../document/Document";
import { AnimationCondition } from "../document/AnimationController";
import { Clip, clipFrameAt, clipLength, findClip } from "../document/Clips";

export interface AnimationPlayback { state: string; enteredAt: number; frame: number; signature: string }
export type AnimationPlayers = ReadonlyMap<string, AnimationPlayback>;
export type AnimationSignals = ReadonlySet<AnimationCondition>;

/** Shared preview/runtime sampling. Non-finite or negative elapsed time starts at frame zero. */
export function sampleClip(clip: Clip, elapsedSeconds: number, fps: number, speed = 1): { frame: number; finished: boolean } {
    const elapsed = Number.isFinite(elapsedSeconds) && Number.isFinite(fps) && Number.isFinite(speed)
        ? Math.max(0, elapsedSeconds * fps * speed) : 0;
    // Fixed-step sums can sit a few ulps below an exact frame boundary.
    const frames = Math.floor(elapsed + 1e-9);
    return { frame: clipFrameAt(clip, frames), finished: clip.loop === false && frames >= clipLength(clip) };
}

/** Missing clips stay inert and can be repaired in the editor without preventing a project load. */
export function stepAnimations(doc: ReadonlyDocument, previous: AnimationPlayers | undefined, time: number,
    signals: (driverId: string) => AnimationSignals = () => new Set()): AnimationPlayers | undefined {
    if (!doc.timeline || !Number.isFinite(time) || time < 0) return undefined;
    const players = new Map<string, AnimationPlayback>();
    for (const [id, node] of doc.nodes) {
        const controller = node.animation;
        if (!controller) continue;
        const signature = JSON.stringify([controller, doc.clips, doc.timeline]);
        const prior = previous?.get(id);
        const validPrior = prior?.signature === signature && time >= prior.enteredAt ? prior : undefined;
        let state = controller.states.find(s => s.name === (validPrior?.state ?? controller.initial));
        if (!state) continue;
        let clip = findClip(doc.clips, state.clip);
        if (!clip) continue;
        let enteredAt = validPrior?.enteredAt ?? time;
        let sample = sampleClip(clip, time - enteredAt, doc.timeline.fps, state.speed);
        // Creation/reset displays the entry frame before any outgoing transition is evaluated.
        if (validPrior) {
            const active = signals(controller.driver ?? id);
            const transition = controller.transitions.find(t => t.from === state!.name
                && (t.when === "finished" ? sample.finished : active.has(t.when)));
            if (transition) {
                const target = controller.states.find(s => s.name === transition.to);
                const targetClip = target && findClip(doc.clips, target.clip);
                if (target && targetClip) {
                    state = target; clip = targetClip; enteredAt = time;
                    sample = sampleClip(clip, 0, doc.timeline.fps, state.speed);
                }
            }
        }
        players.set(id, { state: state.name, enteredAt, frame: sample.frame, signature });
    }
    return players.size ? players : undefined;
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
                if (player) nodes.set(id, { ...node, frame: player.frame });
                break;
            }
            current = ancestor?.parent ?? null;
        }
    }
    return { ...doc, nodes };
}
