/**
 * @module World3D
 * @description Deterministic transient runtime projection for authored 3D transforms and colliders.
 * The document remains immutable; runtime handles are stable node ids within one run only.
 */

import { ReadonlyDocument } from "../document/Document";
import { dropHidden } from "../document/Components";
import { Collider3D, Transform3D, Vec3 } from "../document/Spatial3D";
import { animateWorld3D } from "./AnimationWorld";
import { bodyContact3D,bodyGeometry3D,localDisplacement3D,worldDisplacement3D,parentMinimumScale3D } from "./BodyContact3D";
import { materializeGameplay3D, stepRules3D, respawnCheckpoint3D } from "./Gameplay3D";

export const FIXED_STEP_3D = 1 / 60;
export const MAX_STEPS_PER_FRAME_3D = 5;

export interface Body3D {
    parentBodyId?: string | null;
    solidParts?: readonly import("../geometry/Blockout3D").BlockoutPart[];
    nodeId: string;
    transform: Transform3D;
    collider: Collider3D | null;
    dynamic: boolean;
    velocity: Vec3;
}

export interface World3DState {
    behaviorState?: import("./BehaviorRuntime").BehaviorState;
    spawns?: readonly import("./Gameplay3D").Spawn3D[];
    despawned?: ReadonlySet<string>;
    tallies?: ReadonlyMap<string, number>;
    checkpoint?: import("./Gameplay3D").Checkpoint;
    gameplayContacts?: readonly [string, string][];
    diagnostics?: readonly string[];
    animations?: import("./AnimationPlayback").AnimationPlayers;
    motionFades?: import("./AnimationPlayback").MotionFades;
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
    doc = dropHidden(doc);
    const bodies = new Map<string, Body3D>(); let cameraNodeId: string | null = null;
    for (const [nodeId, node] of doc.nodes) {
        if (!node.spatial3d) continue;
        if (cameraNodeId === null && node.spatial3d.camera) cameraNodeId = nodeId;
        bodies.set(nodeId, { nodeId, ...bodyGeometry3D(doc,nodeId), transform: copyTransform(node.spatial3d.transform),
            collider: node.spatial3d.collider ?? null,
            dynamic: node.entity?.body === "dynamic", velocity: { x: 0, y: 0, z: 0 } });
    }
    return animateWorld3D(doc, { bodies, time: 0, accumulator: 0, outcome: "running", transitionTo: null, cameraNodeId });
}

function extents(body: Body3D): Vec3 {
    const scale = body.transform.scale;
    if(body.solidParts){
        let minimum=Infinity;
        for(const part of body.solidParts)for(const face of part.faces)for(let i=0;i<face.length;i++){
            const a=part.vertices[face[i]],b=part.vertices[face[(i+1)%face.length]];
            minimum=Math.min(minimum,Math.hypot((a[0]-b[0])*scale.x,(a[1]-b[1])*scale.y,(a[2]-b[2])*scale.z));
        }
        return {x:minimum,y:minimum,z:minimum};
    }
    if (body.collider?.kind === "box") return {
        x: Math.abs(body.collider.halfExtents.x * scale.x),
        y: Math.abs(body.collider.halfExtents.y * scale.y),
        z: Math.abs(body.collider.halfExtents.z * scale.z)
    };
    const radius = body.collider?.kind === "sphere" ? body.collider.radius
        * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)) : 0;
    return { x: radius, y: radius, z: radius };
}

function overlap(bodies:ReadonlyMap<string,Body3D>,a: Body3D, b: Body3D): boolean {
    return bodyContact3D(bodies,a, b) !== null;
}

/** Returns stable node ids touching one collider in the current projected world. */
export function queryCollisions3D(world: World3DState, nodeId: string): string[] {
    const body = world.bodies.get(nodeId);
    if (!body) return [];
    return [...world.bodies.values()].filter(other => other.nodeId !== nodeId && overlap(world.bodies,body, other))
        .map(other => other.nodeId).sort();
}

/** One fixed simulation step. Static colliders reject dynamic movement axis-by-axis. */
export function stepWorld3D(doc: ReadonlyDocument, world: World3DState,
                            inputs: ReadonlyMap<string, Input3D> = new Map()): World3DState {
    if (world.behaviorState?.debug.paused || world.outcome !== "running" || world.transitionTo) return world;
    const authored = doc; doc = materializeGameplay3D(doc, world);
    const bodies = new Map<string, Body3D>();
    const diagnostics: string[] = [];
    for (const [id, source] of world.bodies) bodies.set(id, { ...source, transform: copyTransform(source.transform),
        velocity: { ...source.velocity } });
    const statics = [...bodies.values()].filter(body => {
        const entity = doc.nodes.get(body.nodeId)?.entity;
        return !body.dynamic && (body.collider||body.solidParts?.length) && !entity?.goal && !entity?.deadly;
    });
    for (const body of bodies.values()) {
        if (!body.dynamic) continue;
        const input = inputs.get(body.nodeId), speed = input?.speed ?? 4;
        const entity = doc.nodes.get(body.nodeId)?.entity;
        const rigid = entity?.gravity3d !== undefined || entity?.restitution3d !== undefined;
        body.velocity = input ? { x: input.x * speed,
            y: rigid && input.y === 0 ? body.velocity.y : input.y * speed, z: input.z * speed } : body.velocity;
        const solidContact=!!body.solidParts||statics.some(other=>!!other.solidParts);
        const substeps=()=>{
            const minimum=Math.max(solidContact?Number.MIN_VALUE:.001,Math.min(...[body,...statics].filter(b=>b.collider||b.solidParts?.length)
                .flatMap(b=>Object.values(extents(b)).map(size=>size*(solidContact?parentMinimumScale3D(bodies,b):1)))));
            const velocity=solidContact?worldDisplacement3D(bodies,body,body.velocity):body.velocity;
            return Math.max(1,Math.ceil(Math.hypot(velocity.x,velocity.y,velocity.z)*FIXED_STEP_3D/(minimum*.5)));
        };
        if (rigid) {
            body.velocity.y -= (entity?.gravity3d ?? 0) * FIXED_STEP_3D;
            const required = substeps();
            if (required > 64) diagnostics.push(`${body.nodeId}: movement limited to 64 collision substeps`);
            for (let sub = 0; sub < Math.min(64, required); sub++) {
                const previous = { ...body.transform.position };
                for (const axis of ["x", "y", "z"] as const) body.transform.position[axis] += body.velocity[axis] * FIXED_STEP_3D / required;
                for (let pass = 0; pass < 4; pass++) for (const other of statics) {
                    const contact = bodyContact3D(bodies,body, other); if (!contact) continue;
                    const n = contact.normal;
                    const worldContact=!!(body.solidParts||other.solidParts);
                    const push={x:n[0]*contact.depth,y:n[1]*contact.depth,z:n[2]*contact.depth};
                    const correction=worldContact?localDisplacement3D(bodies,body,push):push;
                    body.transform.position.x += correction.x;
                    body.transform.position.y += correction.y;
                    body.transform.position.z += correction.z;
                    const velocity=worldContact?worldDisplacement3D(bodies,body,body.velocity):{...body.velocity};
                    const toward = velocity.x*n[0] + velocity.y*n[1] + velocity.z*n[2];
                    if (toward < 0) {
                        const impulse = (1 + (entity?.restitution3d ?? 0)) * toward;
                        velocity.x -= impulse*n[0]; velocity.y -= impulse*n[1]; velocity.z -= impulse*n[2];
                        body.velocity=worldContact?localDisplacement3D(bodies,body,velocity):velocity;
                    }
                }
                if (statics.some(other => overlap(bodies,body, other))) {
                    body.transform.position = previous; body.velocity = { x: 0, y: 0, z: 0 };
                    diagnostics.push(`${body.nodeId}: unresolved contact; retained last safe position`); break;
                }
            }
        } else {
          const required=solidContact?substeps():1;
          if(required>64)diagnostics.push(`${body.nodeId}: movement limited to 64 collision substeps`);
          for(let sub=0;sub<Math.min(64,required);sub++)for (const axis of ["x", "y", "z"] as const) {
            const old = body.transform.position[axis];
            body.transform.position[axis] += body.velocity[axis] * FIXED_STEP_3D / required;
            if (statics.some(other => overlap(bodies,body, other))) {
                body.transform.position[axis] = old; body.velocity[axis] = 0;
            }
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
        if (!body.dynamic || (!body.collider&&!body.solidParts?.length)) continue;
        for (const other of bodies.values()) {
            if (body === other || !overlap(bodies,body, other)) continue;
            const entity = doc.nodes.get(other.nodeId)?.entity;
            if (entity?.deadly) outcome = "lost";
            if (entity?.goal) {
                if (entity.transitionTo) transitionTo = entity.transitionTo;
                else outcome = "won";
            }
        }
    }
    const next = stepRules3D(authored, world, { ...world, bodies, time: world.time + FIXED_STEP_3D, outcome, transitionTo, diagnostics });
    return animateWorld3D(materializeGameplay3D(authored, next), next);
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
    if (previous.checkpoint?.playerId === controlled) return respawnCheckpoint3D(previous, doc);
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
    doc = materializeGameplay3D(doc, world);
    const nodes = new Map(doc.nodes);
    for (const [id, body] of world.bodies) {
        const node = nodes.get(id);
        if (!node?.spatial3d) continue;
        nodes.set(id, { ...node, spatial3d: { ...node.spatial3d, transform: copyTransform(body.transform) } });
    }
    return { ...doc, nodes };
}
