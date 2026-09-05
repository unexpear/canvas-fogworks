/**
 * @module AnimationWorld
 * @description Adapts settled 2D/3D simulation facts to shared animation conditions.
 */
import { ReadonlyDocument } from "../document/Document";
import { AnimationCondition } from "../document/AnimationController";
import { stepAnimations } from "./AnimationPlayback";
import type { WorldState } from "./World";
import type { World3DState } from "./World3D";

/** Call after gameplay commands, once per fixed step, so short-lived events cannot be skipped. */
export function animateWorld2D(doc: ReadonlyDocument, world: WorldState): WorldState {
    const animations = stepAnimations(doc, world.animations, world.time, id => {
        const active = new Set<AnimationCondition>();
        const body = world.bodies.get(id);
        if (body) {
            active.add(Math.abs(body.vx) > 0.01 ? "moving" : "idle");
            active.add(body.onGround ? "grounded" : "airborne");
            if (!body.onGround && body.vy < -0.01) active.add("rising");
            if (!body.onGround && body.vy > 0.01) active.add("falling");
        }
        for (const event of world.events) if (event.bodyId === id) active.add(event.kind);
        if (world.outcome !== "running") active.add(world.outcome);
        return active;
    });
    return animations || world.animations ? { ...world, animations } : world;
}

/** 3D currently exposes movement and outcome, but has no grounded/contact-event contract. */
export function animateWorld3D(doc: ReadonlyDocument, world: World3DState): World3DState {
    const animations = stepAnimations(doc, world.animations, world.time, id => {
        const active = new Set<AnimationCondition>();
        const body = world.bodies.get(id);
        if (body) active.add(Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z) > 0.01 ? "moving" : "idle");
        if (world.outcome !== "running") active.add(world.outcome);
        return active;
    });
    return animations || world.animations ? { ...world, animations } : world;
}
