/**
 * @module Effects3D
 * @description Persisted 3D atmosphere and effect components (schema 91): scene fog, particle
 * emitters and Christmas-style light strings, with their validators, hard caps and presets.
 *
 * Each is an optional Spatial3D field. Fog is a scene setting; the first node carrying it wins,
 * like an environment. Emitters and light strings take their node's world transform. Buffers,
 * particle states and generated bulb lights are derived every frame and never stored.
 */

import type { Vec3 } from "./Spatial3D";

export type FogMode3D = "linear" | "exp" | "exp2";

export interface Fog3D {
    mode: FogMode3D;
    /** Linear RGB. */
    color: Vec3;
    /** exp/exp2 density per world unit. */
    density: number;
    /** Linear fog starts and ends at these camera distances. */
    start: number;
    end: number;
    /** Exponential height fog; 0 disables it. Densest at heightBase, thinning upward. */
    heightDensity: number;
    heightBase: number;
    heightFalloff: number;
    /** How far the background (clear color) is pulled toward the fog color, 0..1. */
    skyBlend: number;
    /** Strength of the fake in-scatter halos drawn around point lights, 0..4. 0 disables them. */
    lightGlow: number;
}

export interface ParticleEmitter3D {
    /** Particles per second. */
    rate: number;
    /** Seconds each particle lives. */
    lifetime: number;
    /** Local spawn box half extents; zero is a point emitter. */
    boxHalfExtents: Vec3;
    /** World-space initial velocity, plus a random offset of up to spread units/s in any direction. */
    velocity: Vec3;
    spread: number;
    /** World acceleration (gravity, buoyancy) and a constant world drift (wind). */
    gravity: Vec3;
    wind: Vec3;
    /** Horizontal sway amplitude in world units. */
    turbulence: number;
    sizeStart: number;
    sizeEnd: number;
    /** Linear RGB over life. */
    colorStart: Vec3;
    colorEnd: Vec3;
    alphaStart: number;
    alphaEnd: number;
    blend: "additive" | "alpha";
    shape: "soft" | "sparkle";
    seed: number;
    /** Live-particle cap; absent uses rate times lifetime, always at most PARTICLES_PER_EMITTER_MAX. */
    maxParticles?: number;
}

export type BulbStyle3D = "c9" | "c7" | "mini";
/** Bulb axis in the strand node's local space; radial points away from the local Y axis. */
export type BulbAim3D = "down" | "up" | "out" | "radial";

export interface LightString3D {
    /** Local-space attachment points. A clip is drawn at each; the wire sags only between them. */
    points: Vec3[];
    /** Wire returns from the last point to the first. */
    closed?: boolean;
    /** Arc-length distance between bulbs along the wire. */
    bulbSpacing: number;
    /** Mid-span drop as a fraction of span length (horizontal spans sag most, vertical not at all). */
    sag: number;
    /** Linear RGB pattern cycled along the strand. */
    colors: Vec3[];
    bulbStyle: BulbStyle3D;
    bulbAim: BulbAim3D;
    /** Alternating bulb tilt in degrees. */
    tilt: number;
    /** Each bulb's point light. */
    intensity: number;
    range: number;
    /** Linear RGB of wire, sockets and clips. */
    wireColor: Vec3;
}

export const PARTICLES_PER_EMITTER_MAX = 4096;
export const SCENE_PARTICLES_MAX = 16384;
export const LIGHT_STRING_POINTS_MAX = 256;
export const LIGHT_STRING_COLORS_MAX = 16;
export const LIGHT_STRING_BULBS_MAX = 2048;

function num(name: string, value: unknown, min: number, max: number): string | null {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
        ? null : `${name} must be a finite number from ${min} to ${max}`;
}
function vec(name: string, value: unknown, min = -1e6, max = 1e6): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${name} must be {x, y, z}`;
    const v = value as Partial<Vec3>;
    return num(`${name}.x`, v.x, min, max) ?? num(`${name}.y`, v.y, min, max) ?? num(`${name}.z`, v.z, min, max);
}
function object(name: string, value: unknown): string | null {
    return value && typeof value === "object" && !Array.isArray(value) ? null : `${name} must be an object`;
}

export function fog3DError(value: unknown): string | null {
    const e = object("spatial3d.fog", value);
    if (e) return e;
    const f = value as Partial<Fog3D>;
    if (f.mode !== "linear" && f.mode !== "exp" && f.mode !== "exp2") return "spatial3d.fog.mode must be linear, exp or exp2";
    return vec("spatial3d.fog.color", f.color, 0, 100)
        ?? num("spatial3d.fog.density", f.density, 0, 10)
        ?? num("spatial3d.fog.start", f.start, 0, 1e6)
        ?? num("spatial3d.fog.end", f.end, 0, 1e6)
        ?? (f.end! > f.start! ? null : "spatial3d.fog.end must be greater than start")
        ?? num("spatial3d.fog.heightDensity", f.heightDensity, 0, 10)
        ?? num("spatial3d.fog.heightBase", f.heightBase, -1e6, 1e6)
        ?? num("spatial3d.fog.heightFalloff", f.heightFalloff, 0.001, 100)
        ?? num("spatial3d.fog.skyBlend", f.skyBlend, 0, 1)
        ?? num("spatial3d.fog.lightGlow", f.lightGlow, 0, 4);
}

export function particles3DError(value: unknown): string | null {
    const e = object("spatial3d.particles", value);
    if (e) return e;
    const p = value as Partial<ParticleEmitter3D>;
    if (p.blend !== "additive" && p.blend !== "alpha") return "spatial3d.particles.blend must be additive or alpha";
    if (p.shape !== "soft" && p.shape !== "sparkle") return "spatial3d.particles.shape must be soft or sparkle";
    if (!Number.isInteger(p.seed) || p.seed! < 0 || p.seed! > 2147483647) return "spatial3d.particles.seed must be an integer from 0 to 2147483647";
    if (p.maxParticles !== undefined && (!Number.isInteger(p.maxParticles) || p.maxParticles < 1 || p.maxParticles > PARTICLES_PER_EMITTER_MAX)) {
        return `spatial3d.particles.maxParticles must be an integer from 1 to ${PARTICLES_PER_EMITTER_MAX}`;
    }
    return num("spatial3d.particles.rate", p.rate, 0.001, 2000)
        ?? num("spatial3d.particles.lifetime", p.lifetime, 0.05, 60)
        ?? vec("spatial3d.particles.boxHalfExtents", p.boxHalfExtents, 0)
        ?? vec("spatial3d.particles.velocity", p.velocity)
        ?? num("spatial3d.particles.spread", p.spread, 0, 1000)
        ?? vec("spatial3d.particles.gravity", p.gravity)
        ?? vec("spatial3d.particles.wind", p.wind)
        ?? num("spatial3d.particles.turbulence", p.turbulence, 0, 100)
        ?? num("spatial3d.particles.sizeStart", p.sizeStart, 0.0001, 1000)
        ?? num("spatial3d.particles.sizeEnd", p.sizeEnd, 0.0001, 1000)
        ?? vec("spatial3d.particles.colorStart", p.colorStart, 0, 100)
        ?? vec("spatial3d.particles.colorEnd", p.colorEnd, 0, 100)
        ?? num("spatial3d.particles.alphaStart", p.alphaStart, 0, 1)
        ?? num("spatial3d.particles.alphaEnd", p.alphaEnd, 0, 1);
}

export function lightString3DError(value: unknown): string | null {
    const e = object("spatial3d.lightString", value);
    if (e) return e;
    const s = value as Partial<LightString3D>;
    if (!Array.isArray(s.points) || s.points.length < 2 || s.points.length > LIGHT_STRING_POINTS_MAX) {
        return `spatial3d.lightString.points must hold 2 to ${LIGHT_STRING_POINTS_MAX} points`;
    }
    for (let i = 0; i < s.points.length; i++) {
        const err = vec(`spatial3d.lightString.points[${i}]`, s.points[i]);
        if (err) return err;
    }
    if (s.closed !== undefined && typeof s.closed !== "boolean") return "spatial3d.lightString.closed must be a boolean or absent";
    if (!Array.isArray(s.colors) || s.colors.length < 1 || s.colors.length > LIGHT_STRING_COLORS_MAX) {
        return `spatial3d.lightString.colors must hold 1 to ${LIGHT_STRING_COLORS_MAX} colors`;
    }
    for (let i = 0; i < s.colors.length; i++) {
        const err = vec(`spatial3d.lightString.colors[${i}]`, s.colors[i], 0, 100);
        if (err) return err;
    }
    if (s.bulbStyle !== "c9" && s.bulbStyle !== "c7" && s.bulbStyle !== "mini") return "spatial3d.lightString.bulbStyle must be c9, c7 or mini";
    if (s.bulbAim !== "down" && s.bulbAim !== "up" && s.bulbAim !== "out" && s.bulbAim !== "radial") {
        return "spatial3d.lightString.bulbAim must be down, up, out or radial";
    }
    return num("spatial3d.lightString.bulbSpacing", s.bulbSpacing, 0.02, 100)
        ?? num("spatial3d.lightString.sag", s.sag, 0, 0.5)
        ?? num("spatial3d.lightString.tilt", s.tilt, 0, 45)
        ?? num("spatial3d.lightString.intensity", s.intensity, 0, 1e6)
        ?? num("spatial3d.lightString.range", s.range, 0.001, 1e6)
        ?? vec("spatial3d.lightString.wireColor", s.wireColor, 0, 100);
}

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export function defaultFog3D(): Fog3D {
    return { mode: "exp2", color: v3(0.035, 0.045, 0.08), density: 0.03, start: 5, end: 60,
        heightDensity: 0.12, heightBase: 0, heightFalloff: 0.6, skyBlend: 0.6, lightGlow: 1 };
}

export type ParticlePreset3D = "snowfall" | "chimney-smoke" | "sparkles";
export const PARTICLE_PRESETS_3D: readonly ParticlePreset3D[] = ["snowfall", "chimney-smoke", "sparkles"];

/** Ready emitters. Snowfall expects its node a little above the area it should cover. */
export function particlePreset3D(preset: ParticlePreset3D): ParticleEmitter3D {
    if (preset === "snowfall") return { rate: 260, lifetime: 9, boxHalfExtents: v3(16, 0.5, 14), velocity: v3(0, -1.1, 0),
        spread: 0.25, gravity: v3(0, 0, 0), wind: v3(0.25, 0, 0.1), turbulence: 0.35, sizeStart: 0.06, sizeEnd: 0.05,
        colorStart: v3(0.9, 0.93, 1), colorEnd: v3(0.9, 0.93, 1), alphaStart: 0.9, alphaEnd: 0.85,
        blend: "alpha", shape: "soft", seed: 11 };
    if (preset === "chimney-smoke") return { rate: 9, lifetime: 7, boxHalfExtents: v3(0.15, 0.05, 0.15), velocity: v3(0, 0.55, 0),
        spread: 0.12, gravity: v3(0, 0.03, 0), wind: v3(0.35, 0, 0.12), turbulence: 0.25, sizeStart: 0.35, sizeEnd: 2.2,
        colorStart: v3(0.32, 0.32, 0.36), colorEnd: v3(0.2, 0.21, 0.26), alphaStart: 0.45, alphaEnd: 0,
        blend: "alpha", shape: "soft", seed: 23 };
    return { rate: 30, lifetime: 1.6, boxHalfExtents: v3(0.6, 0.6, 0.6), velocity: v3(0, 0.15, 0),
        spread: 0.2, gravity: v3(0, -0.05, 0), wind: v3(0, 0, 0), turbulence: 0.05, sizeStart: 0.16, sizeEnd: 0.02,
        colorStart: v3(1, 0.85, 0.4), colorEnd: v3(1, 0.4, 0.8), alphaStart: 1, alphaEnd: 0,
        blend: "additive", shape: "sparkle", seed: 37 };
}

export const CLASSIC_BULB_COLORS_3D: readonly Vec3[] = [v3(1, 0.04, 0.02), v3(0.05, 1, 0.08), v3(0.08, 0.2, 1), v3(1, 0.55, 0.04), v3(0.9, 0.08, 0.75)];

export function defaultLightString3D(): LightString3D {
    return { points: [v3(-1, 0, 0), v3(0, 0, 0), v3(1, 0, 0)], bulbSpacing: 0.25, sag: 0.06,
        colors: CLASSIC_BULB_COLORS_3D.map(c => ({ ...c })), bulbStyle: "c9", bulbAim: "down", tilt: 12,
        intensity: 0.1, range: 1.4, wireColor: v3(0.02, 0.06, 0.03) };
}

export function copyEffects3D<T extends Fog3D | ParticleEmitter3D | LightString3D>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}