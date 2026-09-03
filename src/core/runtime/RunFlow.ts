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
 * Respawn the controlled body in a fresh copy of the level while retaining run-wide tallies and
 * power. `entity.respawnAt` names an anchor node; absent/dangling anchors use the authored start.
 */
export function respawnRun(doc: ReadonlyDocument, previous: WorldState, controlled: string): WorldState {
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
