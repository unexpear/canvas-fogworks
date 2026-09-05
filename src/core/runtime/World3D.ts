/**
 * @module World3D
 * @description Deterministic transient runtime projection for authored 3D transforms and colliders.
 * The document remains immutable; runtime handles are stable node ids within one run only.
 */

import { ReadonlyDocument } from "../document/Document";
import { Collider3D, Transform3D, Vec3 } from "../document/Spatial3D";
import { animateWorld3D } from "./AnimationWorld";

export const FIXED_STEP_3D = 1 / 60;
export const MAX_STEPS_PER_FRAME_3D = 5;

export interface Body3D {
    nodeId: string;
    transform: Transform3D;
    collider: Collider3D | null;
    dynamic: boolean;
    velocity: Vec3;
}

export interface World3DState {
    animations?: import("./AnimationPlayback").AnimationPlayers;
    bodies: ReadonlyMap<string, Body3D>;
    time: number;
    accumulator: number;
    outcome: "running" | "lost" | "won";
    transitionTo: string | null;
    cameraNodeId: string | null;
}

export interface Input3D { x: number; y: number; z: number; speed?: number }

function copyTransform(transform: Transform3D): Transform3D {
    return { position: { ...transform.position }, rotation: { ...transform.rotation }, scale: { ...transform.scale } };
}

/** Projects authored components into a fresh transient world. */
export function world3DFrom(doc: ReadonlyDocument): World3DState {
    const bodies = new Map<string, Body3D>(); let cameraNodeId: string | null = null;
    for (const [nodeId, node] of doc.nodes) {
        if (!node.spatial3d) continue;
        if (cameraNodeId === null && node.spatial3d.camera) cameraNodeId = nodeId;
        bodies.set(nodeId, { nodeId, transform: copyTransform(node.spatial3d.transform),
            collider: node.spatial3d.collider ?? null,
            dynamic: node.entity?.body === "dynamic", velocity: { x: 0, y: 0, z: 0 } });
    }
    return animateWorld3D(doc, { bodies, time: 0, accumulator: 0, outcome: "running", transitionTo: null, cameraNodeId });
}

function extents(body: Body3D): Vec3 {
    const scale = body.transform.scale;
    if (body.collider?.kind === "box") return {
        x: Math.abs(body.collider.halfExtents.x * scale.x),
        y: Math.abs(body.collider.halfExtents.y * scale.y),
        z: Math.abs(body.collider.halfExtents.z * scale.z)
    };
    const radius = body.collider?.kind === "sphere" ? body.collider.radius
        * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)) : 0;
    return { x: radius, y: radius, z: radius };
}

function overlap(a: Body3D, b: Body3D): boolean {
    if (!a.collider || !b.collider) return false;
    const ae = extents(a), be = extents(b), ap = a.transform.position, bp = b.transform.position;
    if (a.collider.kind === "box" && b.collider.kind === "box") {
        return Math.abs(ap.x - bp.x) <= ae.x + be.x && Math.abs(ap.y - bp.y) <= ae.y + be.y
            && Math.abs(ap.z - bp.z) <= ae.z + be.z;
    }
    if (a.collider.kind === "sphere" && b.collider.kind === "sphere") {
        return Math.hypot(ap.x - bp.x, ap.y - bp.y, ap.z - bp.z) <= ae.x + be.x;
    }
    const sphere = a.collider.kind === "sphere" ? a : b, box = sphere === a ? b : a;
    const radius = extents(sphere).x, boxExtent = extents(box), sp = sphere.transform.position, bp2 = box.transform.position;
    const closest = (value: number, center: number, extent: number) => Math.max(center - extent,
        Math.min(center + extent, value));
    return Math.hypot(sp.x - closest(sp.x, bp2.x, boxExtent.x), sp.y - closest(sp.y, bp2.y, boxExtent.y),
        sp.z - closest(sp.z, bp2.z, boxExtent.z)) <= radius;
}

/** Returns stable node ids touching one collider in the current projected world. */
export function queryCollisions3D(world: World3DState, nodeId: string): string[] {
    const body = world.bodies.get(nodeId);
    if (!body) return [];
    return [...world.bodies.values()].filter(other => other.nodeId !== nodeId && overlap(body, other))
        .map(other => other.nodeId).sort();
}

/** One fixed simulation step. Static colliders reject dynamic movement axis-by-axis. */
export function stepWorld3D(doc: ReadonlyDocument, world: World3DState,
                            inputs: ReadonlyMap<string, Input3D> = new Map()): World3DState {
    if (world.outcome !== "running" || world.transitionTo) return world;
    const bodies = new Map<string, Body3D>();
    for (const [id, source] of world.bodies) bodies.set(id, { ...source, transform: copyTransform(source.transform),
        velocity: { ...source.velocity } });
    const statics = [...bodies.values()].filter(body => {
        const entity = doc.nodes.get(body.nodeId)?.entity;
        return !body.dynamic && body.collider && !entity?.goal && !entity?.deadly;
    });
    for (const body of bodies.values()) {
        if (!body.dynamic) continue;
        const input = inputs.get(body.nodeId), speed = input?.speed ?? 4;
        body.velocity = input ? { x: input.x * speed, y: input.y * speed, z: input.z * speed } : body.velocity;
        for (const axis of ["x", "y", "z"] as const) {
            const old = body.transform.position[axis];
            body.transform.position[axis] += body.velocity[axis] * FIXED_STEP_3D;
            if (statics.some(other => overlap(body, other))) {
                body.transform.position[axis] = old; body.velocity[axis] = 0;
            }
        }
        const camera = world.cameraNodeId ? bodies.get(world.cameraNodeId) : undefined;
        const before = world.bodies.get(body.nodeId)?.transform.position;
        if (camera && camera !== body && inputs.has(body.nodeId) && before) {
            camera.transform.position.x += body.transform.position.x - before.x;
            camera.transform.position.y += body.transform.position.y - before.y;
            camera.transform.position.z += body.transform.position.z - before.z;
        }
    }
    let outcome: World3DState["outcome"] = world.outcome, transitionTo = world.transitionTo;
    for (const body of bodies.values()) {
        if (!body.dynamic || !body.collider) continue;
        for (const other of bodies.values()) {
            if (body === other || !overlap(body, other)) continue;
            const entity = doc.nodes.get(other.nodeId)?.entity;
            if (entity?.deadly) outcome = "lost";
            if (entity?.goal) {
                if (entity.transitionTo) transitionTo = entity.transitionTo;
                else outcome = "won";
            }
        }
    }
    return animateWorld3D(doc, { ...world, bodies, time: world.time + FIXED_STEP_3D, outcome, transitionTo });
}

/** Runs a bounded fixed-step accumulator, preventing a stalled frame from spiralling. */
export function advanceWorld3D(doc: ReadonlyDocument, world: World3DState, elapsedSeconds: number,
                               inputs: ReadonlyMap<string, Input3D> = new Map()): World3DState {
    let accumulator = Math.min(MAX_STEPS_PER_FRAME_3D * FIXED_STEP_3D,
        world.accumulator + Math.max(0, elapsedSeconds));
    let next = world, count = 0;
    while (accumulator + 1e-12 >= FIXED_STEP_3D && count++ < MAX_STEPS_PER_FRAME_3D) {
        next = stepWorld3D(doc, next, inputs); accumulator -= FIXED_STEP_3D;
    }
    return { ...next, accumulator: Math.max(0, accumulator) };
}

export function restartRun3D(doc: ReadonlyDocument): World3DState { return world3DFrom(doc); }

export function respawnRun3D(doc: ReadonlyDocument, previous: World3DState, controlled: string): World3DState {
    const fresh = world3DFrom(doc), body = fresh.bodies.get(controlled), old = previous.bodies.get(controlled);
    if (!body) return fresh;
    const anchorId = doc.nodes.get(controlled)?.entity?.respawnAt;
    const anchor = anchorId ? fresh.bodies.get(anchorId) : undefined;
    const bodies = new Map(fresh.bodies);
    bodies.set(controlled, { ...body, transform: { ...body.transform,
        position: anchor ? { ...anchor.transform.position } : { ...body.transform.position } },
        velocity: old ? { x: 0, y: 0, z: 0 } : body.velocity });
    return { ...fresh, bodies };
}

/** Stable text digest for replay/equivalence tests. */
export function digestWorld3D(world: World3DState): string {
    const round = (value: number) => Math.round(value * 1e6) / 1e6;
    return JSON.stringify({ time: round(world.time), outcome: world.outcome, transitionTo: world.transitionTo,
        bodies: [...world.bodies.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(body => ({
            id: body.nodeId, p: [round(body.transform.position.x), round(body.transform.position.y),
                round(body.transform.position.z)], v: [round(body.velocity.x), round(body.velocity.y),
                round(body.velocity.z)]
        })) });
}

/** Applies transient transforms to a derived render document without mutating authored state. */
export function applyWorld3D(doc: ReadonlyDocument, world: World3DState): ReadonlyDocument {
    const nodes = new Map(doc.nodes);
    for (const [id, body] of world.bodies) {
        const node = nodes.get(id);
        if (!node?.spatial3d) continue;
        nodes.set(id, { ...node, spatial3d: { ...node.spatial3d, transform: copyTransform(body.transform) } });
    }
    return { ...doc, nodes };
}
