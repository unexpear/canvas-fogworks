/**
 * @module RunFlow
 * @description Pure restart and respawn lifecycle operations for a running document.
 */

import { ReadonlyDocument } from "../document/Document";
import { worldOffsetOf, WorldState, worldFrom } from "./World";

/** A completely fresh run: all level mutations, counters, power and clocks are reset. */
export function restartRun(doc: ReadonlyDocument): WorldState {
    return worldFrom(doc);
}

/**
 * A runtime checkpoint retains current-level mutations; otherwise respawn in a fresh level with
 * tallies and power retained. `entity.respawnAt` names a fallback anchor; absent/dangling anchors use the authored start.
 */
export function respawnRun(doc: ReadonlyDocument, previous: WorldState, controlled: string): WorldState {
    const checkpoint = previous.checkpoint, current = previous.bodies.get(controlled) ?? worldFrom(doc).bodies.get(controlled);
    if (checkpoint?.playerId === controlled && current) {
        const bodies = new Map(previous.bodies), despawned = new Set(previous.despawned); despawned.delete(controlled);
        bodies.set(controlled, { ...current, x: checkpoint.position.x, y: checkpoint.position.y, vx: 0, vy: 0, onGround: false });
        return { ...previous, bodies, despawned, outcome: "running", transitionTo: null, contacts: new Set(), overlaps: new Set(), events: [], jumpWas: false, jumpCut: false };
    }
    const fresh = worldFrom(doc);
    const body = fresh.bodies.get(controlled);
    if (!body) return fresh;
    const player = doc.nodes.get(controlled);
    const anchorId = player?.entity?.respawnAt;
    const anchor = anchorId ? doc.nodes.get(anchorId) : undefined;
    const offset = anchorId ? worldOffsetOf(doc, anchorId) : null;
    const prior = previous.bodies.get(controlled);
    const moved = new Map(fresh.bodies);
    moved.set(controlled, {
        ...body,
        ...(anchor && offset && player ? {
            x: offset.dx + anchor.geometry.x + (anchor.geometry.width - player.geometry.width) / 2,
            y: offset.dy + anchor.geometry.y - player.geometry.height
        } : {}),
        power: prior?.power ?? body.power
    });
    return { ...fresh, bodies: moved, tallies: new Map(previous.tallies) };
}
