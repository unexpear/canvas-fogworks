/**
 * @module Fog3D
 * @description Distance fog (linear, exp, exp2) plus exponential height fog: the CPU math and the
 * GLSL that the WebGL forward and particle shaders share, so tests pin the GPU semantics.
 *
 * Amounts combine as 1 - (1 - distance)(1 - height) and mix toward the fog color in linear light
 * before sRGB encoding. The background is pulled toward the fog color by skyBlend. Light "scatter"
 * is not simulated: the renderer adds fake additive halo sprites around point lights (lightGlow).
 */

import type { Fog3D } from "../core/document/Effects3D";

export const FOG_MODE_CODE_3D: Readonly<Record<Fog3D["mode"], number>> = { linear: 1, exp: 2, exp2: 3 };
/** Exponent clamp shared with the shaders, safe for mediump floats. */
const EXP_CLAMP = 10;
const clampExp = (x: number): number => Math.exp(Math.max(-EXP_CLAMP, Math.min(EXP_CLAMP, x)));

export function distanceFog3D(fog: Fog3D, distance: number): number {
    if (fog.mode === "linear") return Math.max(0, Math.min(1, (distance - fog.start) / Math.max(fog.end - fog.start, 1e-4)));
    if (fog.mode === "exp") return 1 - Math.exp(-fog.density * distance);
    return 1 - Math.exp(-((fog.density * distance) ** 2));
}

/** Exact integral of heightDensity * exp(-falloff * (y - base)) along the camera-to-point segment. */
export function heightFog3D(fog: Fog3D, eye: readonly [number, number, number], point: readonly [number, number, number]): number {
    if (fog.heightDensity <= 0) return 0;
    const d = Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]);
    const t = fog.heightFalloff * (point[1] - eye[1]);
    const integral = Math.abs(t) > 1e-3 ? (1 - clampExp(-t)) / t : 1;
    return 1 - Math.exp(-fog.heightDensity * d * clampExp(-fog.heightFalloff * (eye[1] - fog.heightBase)) * integral);
}

export function fogAmount3D(fog: Fog3D | null | undefined, eye: readonly [number, number, number], point: readonly [number, number, number]): number {
    if (!fog) return 0;
    const d = Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]);
    return 1 - (1 - distanceFog3D(fog, d)) * (1 - heightFog3D(fog, eye, point));
}

/** Linear-light mix toward the fog color. */
export function applyFog3D(color: readonly [number, number, number], fog: Fog3D, amount: number): [number, number, number] {
    return [color[0] + (fog.color.x - color[0]) * amount, color[1] + (fog.color.y - color[1]) * amount,
        color[2] + (fog.color.z - color[2]) * amount];
}

const srgb = (v: number): number => {
    const c = Math.max(0, Math.min(1, v));
    return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
};

/** sRGB clear color pulled toward the sRGB fog color by skyBlend. */
export function fogBackground3D(clear: readonly [number, number, number, number], fog: Fog3D | null | undefined): [number, number, number, number] {
    if (!fog) return [clear[0], clear[1], clear[2], clear[3]];
    const target = [srgb(fog.color.x), srgb(fog.color.y), srgb(fog.color.z)];
    return [clear[0] + (target[0] - clear[0]) * fog.skyBlend, clear[1] + (target[1] - clear[1]) * fog.skyBlend,
        clear[2] + (target[2] - clear[2]) * fog.skyBlend, clear[3]];
}

/**
 * GLSL ES 1.00 uniforms and fogAmount(world) for any fragment shader that also declares
 * u_cameraPosition. u_fogMode 0 disables fog. params: density, start, end. height: density, base, falloff.
 */
export const FOG_GLSL_3D = `
uniform float u_fogMode;
uniform vec3 u_fogColor;
uniform vec3 u_fogParams;
uniform vec3 u_fogHeight;
float fogAmount(vec3 worldPosition) {
  if (u_fogMode < 0.5) return 0.0;
  vec3 ray = worldPosition - u_cameraPosition;
  float d = length(ray);
  float distanceFog;
  if (u_fogMode < 1.5) distanceFog = clamp((d - u_fogParams.y) / max(u_fogParams.z - u_fogParams.y, 0.0001), 0.0, 1.0);
  else if (u_fogMode < 2.5) distanceFog = 1.0 - exp(-u_fogParams.x * d);
  else distanceFog = 1.0 - exp(-(u_fogParams.x * d) * (u_fogParams.x * d));
  float heightFog = 0.0;
  if (u_fogHeight.x > 0.0) {
    float t = u_fogHeight.z * ray.y;
    float integral = abs(t) > 0.001 ? (1.0 - exp(clamp(-t, -10.0, 10.0))) / t : 1.0;
    float start = exp(clamp(-u_fogHeight.z * (u_cameraPosition.y - u_fogHeight.y), -10.0, 10.0));
    heightFog = 1.0 - exp(-u_fogHeight.x * d * start * integral);
  }
  return 1.0 - (1.0 - distanceFog) * (1.0 - heightFog);
}
vec3 applyFog(vec3 color, vec3 worldPosition) {
  return mix(color, u_fogColor, clamp(fogAmount(worldPosition), 0.0, 1.0));
}
`;