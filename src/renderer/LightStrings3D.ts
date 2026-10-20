/**
 * @module LightStrings3D
 * @description Turns an authored LightString3D into real geometry and lights: a thin tube wire that
 * sags parabolically between attachment clips, a clip at every attachment point, and a socket plus
 * lathed C9, C7 or mini bulb at even arc-length spacing, each tilted alternately and backed by one
 * point light. Geometry is merged per material: one wire draw, one emissive draw per bulb color.
 *
 * Paths are local to the strand node; authors (or the demo) snap them to real surfaces. Bulbs hang
 * along bulbAim from the wire, never across the clip line, so snapped paths keep bulbs off geometry.
 */

import type { LightString3D } from "../core/document/Effects3D";
import { LIGHT_STRING_BULBS_MAX } from "../core/document/Effects3D";

type DeepReadonly<T> = { readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K] };
import type { Draw3D, FrameLight3D } from "./Scene3D";
import { add3, cross3, dot3, length3, meshDraw3D, MeshBuilder3D, norm3, perpendicular3, rotateAround3, scale3, sub3, type V3 } from "./MeshBuilder3D";

/** Bulb outline as [radius, distance from the socket mouth] in metres, slightly larger than life. */
const BULB_PROFILES: Readonly<Record<LightString3D["bulbStyle"], { socket: [number, number]; glass: readonly (readonly [number, number])[] }>> = {
    c9: { socket: [0.011, 0.028], glass: [[0.009, 0], [0.016, 0.01], [0.022, 0.026], [0.021, 0.044], [0.015, 0.062], [0.007, 0.075], [0, 0.08]] },
    c7: { socket: [0.008, 0.02], glass: [[0.0065, 0], [0.011, 0.007], [0.0155, 0.018], [0.015, 0.031], [0.0105, 0.044], [0.005, 0.053], [0, 0.056]] },
    mini: { socket: [0.0045, 0.012], glass: [[0.0035, 0], [0.0055, 0.006], [0.0062, 0.016], [0.0052, 0.026], [0.0025, 0.033], [0, 0.035]] }
};

export interface LightStringBulb3D { position: V3; color: number; socket: V3; axis: V3 }

export interface LightStringBuild3D {
    draws: Draw3D[];
    lights: FrameLight3D[];
    bulbs: LightStringBulb3D[];
    /** World clip positions (the attachment points). */
    clips: V3[];
    /** World wire polyline including sag samples. */
    wire: V3[];
    truncated: boolean;
}

const point = (m: readonly number[], p: { x: number; y: number; z: number }): V3 =>
    [m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12], m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13], m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]];
const direction = (m: readonly number[], x: number, y: number, z: number): V3 =>
    norm3([m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z]);

/** Wire polyline: straight at clips, parabolic drop of sag * span * sin(angle from vertical) mid-span. */
export function lightStringWire3D(clips: readonly V3[], sag: number, sampleSpacing = 0.06): V3[] {
    const out: V3[] = clips.length ? [clips[0]] : [];
    for (let k = 0; k + 1 < clips.length; k++) {
        const a = clips[k], b = clips[k + 1], span = sub3(b, a), length = length3(span);
        if (length < 1e-6) continue;
        const along = scale3(span, 1 / length);
        const hang = sub3([0, -1, 0], scale3(along, -along[1]));
        const horizontal = length3(hang), down = horizontal > 1e-6 ? scale3(hang, 1 / horizontal) : [0, -1, 0] as V3;
        const drop = sag * length * horizontal;
        const samples = Math.max(2, Math.ceil(length / sampleSpacing));
        for (let s = 1; s <= samples; s++) {
            const t = s / samples;
            out.push(add3(add3(a, scale3(span, t)), scale3(down, drop * 4 * t * (1 - t))));
        }
    }
    return out;
}

export function buildLightString3D(strand: Readonly<LightString3D> | DeepReadonly<LightString3D>, model: readonly number[], nodeId: string,
                                   maxBulbs = LIGHT_STRING_BULBS_MAX): LightStringBuild3D {
    const clips = strand.points.map(p => point(model, p));
    const path = strand.closed && clips.length > 2 ? [...clips, clips[0]] : clips;
    const wire = lightStringWire3D(path, strand.sag);
    const profile = BULB_PROFILES[strand.bulbStyle];
    const unit = Math.max(1e-6, Math.cbrt(Math.abs(model[0] * (model[5] * model[10] - model[6] * model[9])
        - model[4] * (model[1] * model[10] - model[2] * model[9]) + model[8] * (model[1] * model[6] - model[2] * model[5]))));
    const wireRadius = (strand.bulbStyle === "mini" ? 0.0035 : 0.005) * unit;
    const axisOrigin: V3 = [model[12], model[13], model[14]], axisUp = direction(model, 0, 1, 0);
    const aimFixed: V3 | null = strand.bulbAim === "down" ? direction(model, 0, -1, 0)
        : strand.bulbAim === "up" ? direction(model, 0, 1, 0) : strand.bulbAim === "out" ? direction(model, 0, 0, 1) : null;

    const lengths = [0];
    for (let i = 1; i < wire.length; i++) lengths.push(lengths[i - 1] + length3(sub3(wire[i], wire[i - 1])));
    const total = lengths[lengths.length - 1];
    const spacing = strand.bulbSpacing * unit;
    const wanted = Math.max(0, Math.floor(total / spacing + 1e-6));
    const count = Math.min(wanted, maxBulbs);
    const bulbs: LightStringBulb3D[] = [];
    const dark = new MeshBuilder3D();
    const glass = strand.colors.map(() => new MeshBuilder3D());
    let segment = 1;
    for (let b = 0; b < count; b++) {
        const s = (b + 0.5) * spacing;
        while (segment < wire.length - 1 && lengths[segment] < s) segment++;
        const a = wire[segment - 1], c = wire[segment], span = Math.max(1e-9, lengths[segment] - lengths[segment - 1]);
        const at = add3(a, scale3(sub3(c, a), (s - lengths[segment - 1]) / span));
        const tangent = norm3(sub3(c, a));
        let aim: V3 = aimFixed ?? (() => {
            const rel = sub3(at, axisOrigin);
            return sub3(rel, scale3(axisUp, dot3(rel, axisUp)));
        })();
        aim = sub3(aim, scale3(tangent, dot3(aim, tangent)));
        if (length3(aim) < 1e-6) aim = perpendicular3(tangent);
        aim = norm3(aim);
        aim = rotateAround3(aim, tangent, (b % 2 === 0 ? 1 : -1) * strand.tilt * Math.PI / 180);
        const socketTop = add3(at, scale3(aim, wireRadius * 0.5));
        const [socketRadius, socketLength] = profile.socket;
        dark.lathe(socketTop, aim, [[0, 0], [socketRadius * unit * 0.85, 0], [socketRadius * unit, socketLength * unit * 0.4],
            [socketRadius * unit, socketLength * unit], [0, socketLength * unit]], 6);
        const mouth = add3(socketTop, scale3(aim, socketLength * unit));
        const color = b % strand.colors.length;
        glass[color].lathe(mouth, aim, profile.glass.map(([r, h]) => [r * unit, h * unit] as const), 8);
        const glassLength = profile.glass[profile.glass.length - 1][1] * unit;
        bulbs.push({ position: add3(mouth, scale3(aim, glassLength * 0.45)), color, socket: socketTop, axis: aim });
    }
    dark.tube(wire, wireRadius, 4);
    const clipSize = Math.max(wireRadius * 3, 0.012 * unit);
    for (let k = 0; k < clips.length; k++) {
        const prev = clips[Math.max(0, k - 1)], next = clips[Math.min(clips.length - 1, k + 1)];
        const along = length3(sub3(next, prev)) > 1e-6 ? norm3(sub3(next, prev)) : [1, 0, 0] as V3;
        const half = scale3(along, clipSize * 0.6);
        let up = cross3(along, perpendicular3(along));
        if (Math.abs(along[1]) < 0.9) up = [0, 1, 0];
        dark.beam(sub3(clips[k], half), add3(clips[k], half), clipSize, clipSize * 1.4, up);
    }
    const wc = strand.wireColor;
    const draws: Draw3D[] = [meshDraw3D(nodeId, dark.primitive(), [wc.x, wc.y, wc.z, 1], { roughness: 0.55 })];
    strand.colors.forEach((c, i) => {
        if (glass[i].indices.length === 0) return;
        draws.push(meshDraw3D(nodeId, glass[i].primitive(), [c.x * 0.3, c.y * 0.3, c.z * 0.3, 1],
            { emissive: [c.x, c.y, c.z], roughness: 0.25 }));
    });
    const lights: FrameLight3D[] = bulbs.map(bulb => {
        const c = strand.colors[bulb.color];
        return { kind: "point", color: [c.x, c.y, c.z], intensity: strand.intensity, range: strand.range * unit, position: bulb.position };
    });
    return { draws, lights, bulbs, clips, wire, truncated: count < wanted };
}