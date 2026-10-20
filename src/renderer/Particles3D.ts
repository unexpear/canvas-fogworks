/**
 * @module Particles3D
 * @description Stateless, deterministic particle emitters for the WebGL 1 renderer.
 *
 * Each emitter has a fixed ring of slots; slot i spawns at phase i * interval and respawns every
 * slots * interval seconds with fresh hashed randomness, so any time t is sampled directly with no
 * stored state (scrubbing, the player and tests all agree, and the system is always prewarmed).
 * Motion is closed form: p0 + (v + wind) * age + gravity * age^2 / 2 plus a bounded sway.
 * The CPU evaluates positions; the GPU only expands one camera-facing quad per particle.
 */

import type { ParticleEmitter3D } from "../core/document/Effects3D";
import { PARTICLES_PER_EMITTER_MAX, SCENE_PARTICLES_MAX } from "../core/document/Effects3D";
import type { FrameLight3D, Mat4 } from "./Scene3D";
import type { Fog3D } from "../core/document/Effects3D";

export interface ParticleBatch3D {
    nodeId: string;
    blend: "additive" | "alpha";
    shape: "soft" | "sparkle";
    count: number;
    /** xyz per particle, world space. */
    centers: Float32Array;
    /** World-space quad width per particle. */
    sizes: Float32Array;
    /** Linear rgba per particle. */
    colors: Float32Array;
}

export function particleCapacity3D(e: ParticleEmitter3D): number {
    return Math.max(1, Math.min(PARTICLES_PER_EMITTER_MAX, e.maxParticles ?? Math.ceil(e.rate * e.lifetime)));
}

/** Seconds between slot spawns; capping slots stretches it, which lowers the effective rate. */
export function particleInterval3D(e: ParticleEmitter3D): number {
    return Math.max(1 / e.rate, e.lifetime / particleCapacity3D(e));
}

/** Uniform [0, 1) from integers. */
export function hash3D(seed: number, slot: number, cycle: number, k: number): number {
    let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(slot + 0x632be5ab, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x27d4eb2f) ^ Math.imul(cycle + 0x165667b1, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 13), 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

export interface ParticleState3D { position: [number, number, number]; age: number; size: number; color: [number, number, number, number] }

/** One slot at time t, or null while it waits to respawn. */
export function particleSlot3D(e: ParticleEmitter3D, model: readonly number[], time: number, slot: number): ParticleState3D | null {
    const interval = particleInterval3D(e), period = particleCapacity3D(e) * interval;
    const since = time - slot * interval;
    const cycle = Math.floor(since / period);
    const age = since - cycle * period;
    if (!(age >= 0) || age >= e.lifetime) return null;
    const r = (k: number) => hash3D(e.seed, slot, cycle, k);
    const lx = (r(0) * 2 - 1) * e.boxHalfExtents.x, ly = (r(1) * 2 - 1) * e.boxHalfExtents.y, lz = (r(2) * 2 - 1) * e.boxHalfExtents.z;
    const m = model;
    const p0 = [m[0] * lx + m[4] * ly + m[8] * lz + m[12], m[1] * lx + m[5] * ly + m[9] * lz + m[13], m[2] * lx + m[6] * ly + m[10] * lz + m[14]];
    // Uniform direction in a ball of radius spread.
    const z = r(3) * 2 - 1, a = r(4) * Math.PI * 2, rad = Math.sqrt(1 - z * z) * e.spread * Math.cbrt(r(5));
    const jitter = [Math.cos(a) * rad, z * e.spread * Math.cbrt(r(5)), Math.sin(a) * rad];
    const phaseX = r(6) * Math.PI * 2, phaseZ = r(7) * Math.PI * 2, swayRate = 0.8 + r(8) * 0.8;
    const half = 0.5 * age * age;
    const position: [number, number, number] = [
        p0[0] + (e.velocity.x + jitter[0] + e.wind.x) * age + e.gravity.x * half + e.turbulence * (Math.sin(age * swayRate + phaseX) - Math.sin(phaseX)),
        p0[1] + (e.velocity.y + jitter[1] + e.wind.y) * age + e.gravity.y * half,
        p0[2] + (e.velocity.z + jitter[2] + e.wind.z) * age + e.gravity.z * half + e.turbulence * (Math.cos(age * swayRate * 0.9 + phaseZ) - Math.cos(phaseZ))
    ];
    const f = age / e.lifetime, fadeIn = Math.min(1, age / Math.max(1e-3, Math.min(0.3, e.lifetime * 0.1)));
    const mix = (x: number, y: number) => x + (y - x) * f;
    return { position, age, size: mix(e.sizeStart, e.sizeEnd) * (0.75 + r(9) * 0.5),
        color: [mix(e.colorStart.x, e.colorEnd.x), mix(e.colorStart.y, e.colorEnd.y), mix(e.colorStart.z, e.colorEnd.z),
            Math.max(0, Math.min(1, mix(e.alphaStart, e.alphaEnd) * fadeIn))] };
}

/** Every live particle of an emitter at time t, at most budget of them. */
export function sampleParticles3D(e: ParticleEmitter3D, model: Mat4 | readonly number[], time: number, nodeId: string,
                                  budget = SCENE_PARTICLES_MAX): ParticleBatch3D {
    const slots = Math.min(particleCapacity3D(e), Math.max(0, budget));
    const centers = new Float32Array(slots * 3), sizes = new Float32Array(slots), colors = new Float32Array(slots * 4);
    let count = 0;
    for (let i = 0; i < slots; i++) {
        const p = particleSlot3D(e, model, time, i);
        if (!p || p.color[3] <= 0.002) continue;
        centers.set(p.position, count * 3); sizes[count] = p.size; colors.set(p.color, count * 4);
        count++;
    }
    return { nodeId, blend: e.blend, shape: e.shape, count, centers, sizes, colors };
}

/**
 * FAKE in-fog light scatter: one additive soft sprite per point light, sized from its range and
 * scaled by fog.lightGlow. It does not march the fog or read the frame.
 */
export function fogGlowBatch3D(lights: readonly FrameLight3D[], fog: Fog3D | null | undefined, cap = 4096): ParticleBatch3D | null {
    if (!fog || fog.lightGlow <= 0) return null;
    const points = lights.filter((l): l is Extract<FrameLight3D, { kind: "point" }> => l.kind === "point").slice(0, cap);
    if (points.length === 0) return null;
    const centers = new Float32Array(points.length * 3), sizes = new Float32Array(points.length), colors = new Float32Array(points.length * 4);
    points.forEach((light, i) => {
        centers.set(light.position, i * 3);
        sizes[i] = Math.min(2.5, Math.max(0.15, light.range * 0.4));
        const k = Math.min(0.25, light.intensity * 0.9) * fog.lightGlow;
        colors.set([light.color[0] * k, light.color[1] * k, light.color[2] * k, 1], i * 4);
    });
    return { nodeId: "fog-glow", blend: "additive", shape: "soft", count: points.length, centers, sizes, colors };
}