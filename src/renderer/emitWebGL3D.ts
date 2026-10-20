/**
 * @module emitWebGL3D
 * @description WebGL 1 viewport proof for indexed 3D meshes, depth buffering and
 * framebuffer color-id picking. Scene construction remains in Scene3D.
 */

import { ENVIRONMENT_COLOR_3D, ENVIRONMENT_INTENSITY_3D, Frame3D, invertMat4,
    multiplyMat4, TextureInfo3D } from "./Scene3D";
import { DRAW_LIGHT_TIERS_3D, drawBoundingSphere3D, drawLightBudget3D, MAX_DRAW_LIGHTS_3D, MIN_DRAW_LIGHTS_3D,
    packDrawLights3D, PackedLights3D, selectDrawLights3D } from "./LightSelection3D";
import { buildLightClusters3D, LightClusters3D, lightSignature3D, MAX_CLUSTER_CELLS_3D,
    MAX_CLUSTER_LIGHTS_3D } from "./LightClusters3D";
import { preparedEnvironment3D } from "./EnvironmentIbl3D";
import { GPU_SKIN_JOINTS } from "../core/import/GltfMotion";
import { FOG_GLSL_3D, FOG_MODE_CODE_3D, fogBackground3D } from "./Fog3D";
import { fogGlowBatch3D, type ParticleBatch3D } from "./Particles3D";

/** Constant-index joint lookup. WebGL 1 rejects a dynamic index into a uniform array. */
function skinShaderSource(): { declarations: string; functions: string } {
    const choose = Array.from({ length: GPU_SKIN_JOINTS }, (_, joint) => joint === GPU_SKIN_JOINTS - 1
        ? `  return u_joints[${joint}];`
        : `  if (index < ${joint}.5) return u_joints[${joint}];`).join("\n");
    return {
        declarations: `
attribute vec4 a_joints;
attribute vec4 a_weights;
uniform float u_skinned;
uniform mat4 u_joints[${GPU_SKIN_JOINTS}];`,
        functions: `
mat4 skinJoint(float index) {
${choose}
}
mat4 skinMatrix() {
  return skinJoint(a_joints.x) * a_weights.x + skinJoint(a_joints.y) * a_weights.y
    + skinJoint(a_joints.z) * a_weights.z + skinJoint(a_joints.w) * a_weights.w;
}
vec4 skinPoint(vec4 local) {
  if (u_skinned < 0.5) return local;
  return skinMatrix() * local;
}
vec3 skinNormal(vec3 n) {
  if (u_skinned < 0.5) return n;
  mat4 m = skinMatrix();
  float a00 = m[0][0], a10 = m[0][1], a20 = m[0][2];
  float a01 = m[1][0], a11 = m[1][1], a21 = m[1][2];
  float a02 = m[2][0], a12 = m[2][1], a22 = m[2][2];
  float det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  if (abs(det) < 0.000000001) return n;
  float i00 = (a11 * a22 - a12 * a21) / det, i01 = (a02 * a21 - a01 * a22) / det, i02 = (a01 * a12 - a02 * a11) / det;
  float i10 = (a12 * a20 - a10 * a22) / det, i11 = (a00 * a22 - a02 * a20) / det, i12 = (a02 * a10 - a00 * a12) / det;
  float i20 = (a10 * a21 - a11 * a20) / det, i21 = (a01 * a20 - a00 * a21) / det, i22 = (a00 * a11 - a01 * a10) / det;
  vec3 r = vec3(i00 * n.x + i10 * n.y + i20 * n.z, i01 * n.x + i11 * n.y + i21 * n.z, i02 * n.x + i12 * n.y + i22 * n.z);
  float len = length(r);
  return len > 0.000000001 ? r / len : n;
}`
    };
}
const SKIN_SHADER = skinShaderSource();

const VERTEX = `
attribute vec3 a_position;
attribute vec3 a_normal;
attribute vec2 a_uv;
attribute vec2 a_uv1;
uniform mat4 u_mvp;
uniform mat4 u_model;
uniform mat3 u_normalMatrix;
uniform mat4 u_lightViewProjection;
${SKIN_SHADER.declarations}
varying vec3 v_worldPosition;
varying vec3 v_worldNormal;
varying vec4 v_shadowPosition;
varying vec2 v_uv;
varying vec2 v_uv1;
${SKIN_SHADER.functions}
void main() {
    vec4 local = skinPoint(vec4(a_position, 1.0));
    vec4 world = u_model * local;
    v_worldPosition = world.xyz;
    v_worldNormal = normalize(u_normalMatrix * skinNormal(a_normal));
    v_shadowPosition = u_lightViewProjection * world;
    v_uv = a_uv;
    v_uv1 = a_uv1;
    gl_Position = u_mvp * local;
}
`;
function fragmentSource(derivatives: boolean, lights: number, clustered: boolean): string { return `${derivatives ? "#extension GL_OES_standard_derivatives : enable" : ""}
#define HAS_DERIVATIVES ${derivatives ? 1 : 0}
#define CLUSTERED ${clustered ? 1 : 0}
#define CLUSTER_LIGHTS ${MAX_CLUSTER_LIGHTS_3D}
precision ${clustered ? "highp" : "mediump"} float;
uniform vec4 u_color;
uniform bool u_picking;
uniform bool u_unlit;
uniform bool u_hasBaseColorTexture;
uniform sampler2D u_baseColorTexture;
uniform bool u_hasMetallicRoughnessTexture;
uniform sampler2D u_metallicRoughnessTexture;
uniform bool u_hasNormalTexture;
uniform sampler2D u_normalTexture;
uniform float u_normalScale;
uniform bool u_hasEmissiveTexture;
uniform sampler2D u_emissiveTexture;
uniform vec4 u_baseColorOffsetScale;
uniform vec4 u_metallicRoughnessOffsetScale;
uniform vec4 u_normalOffsetScale;
uniform vec4 u_emissiveOffsetScale;
uniform float u_baseColorRotation;
uniform float u_metallicRoughnessRotation;
uniform float u_normalRotation;
uniform float u_emissiveRotation;
uniform int u_baseColorUvSet;
uniform int u_metallicRoughnessUvSet;
uniform int u_normalUvSet;
uniform int u_emissiveUvSet;
uniform int u_alphaMode;
uniform float u_alphaCutoff;
uniform bool u_hasEnvironment;
uniform sampler2D u_environmentDiffuse;
uniform sampler2D u_environmentSpecular0;
uniform sampler2D u_environmentSpecular1;
uniform float u_environmentIntensity;
uniform float u_environmentRotation;
uniform float u_metallic;
uniform float u_roughness;
uniform vec3 u_emissive;
uniform vec3 u_cameraPosition;
uniform bool u_hasShadow;
uniform int u_shadowLightIndex;
uniform sampler2D u_shadowTexture;
uniform vec2 u_shadowTexel;
uniform int u_lightCount;
uniform vec4 u_lightPosition[${lights}];
uniform vec4 u_lightColorRange[${lights}];
#if CLUSTERED
uniform bool u_hasClusters;
uniform sampler2D u_clusterLights;
uniform vec3 u_clusterOrigin;
uniform vec3 u_clusterDims;
uniform float u_clusterCellSize;
uniform vec2 u_clusterTextureSize;
#endif
varying vec3 v_worldPosition;
varying vec3 v_worldNormal;
varying vec4 v_shadowPosition;
varying vec2 v_uv;
varying vec2 v_uv1;
const float PI = 3.141592653589793;
vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
${FOG_GLSL_3D}
vec3 fresnelSchlick(float cosTheta, vec3 f0) {
    return f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0);
}
vec2 environmentUv(vec3 direction) {
    direction = normalize(direction);
    return vec2(fract(atan(direction.z, direction.x) / (2.0 * PI) + 0.5
        + u_environmentRotation / (2.0 * PI)), acos(clamp(direction.y, -1.0, 1.0)) / PI);
}
float distributionGgx(vec3 n, vec3 h, float roughness) {
    float a = max(roughness * roughness, 0.0025);
    float a2 = a * a;
    float nh = max(dot(n, h), 0.0);
    float denominator = nh * nh * (a2 - 1.0) + 1.0;
    return a2 / max(PI * denominator * denominator, 0.0001);
}
float geometrySchlick(float nv, float roughness) {
    float r = roughness + 1.0;
    float k = r * r / 8.0;
    return nv / max(nv * (1.0 - k) + k, 0.0001);
}
float unpackDepth(vec4 packedDepth) {
    return dot(packedDepth, vec4(1.0 / 16777216.0, 1.0 / 65536.0, 1.0 / 256.0, 1.0));
}
float shadowVisibility() {
    if (!u_hasShadow) return 1.0;
    vec3 p = v_shadowPosition.xyz / v_shadowPosition.w * 0.5 + 0.5;
    if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0 || p.z <= 0.0 || p.z >= 1.0) return 1.0;
    float visible = 0.0;
    for (int y = -1; y <= 0; y++) for (int x = -1; x <= 0; x++) {
        float stored = unpackDepth(texture2D(u_shadowTexture, p.xy + vec2(float(x), float(y)) * u_shadowTexel));
        visible += p.z - 0.0015 <= stored ? 0.25 : 0.0;
    }
    return visible;
}
float pointAttenuation(float distanceToLight, float range) {
    float ratio = distanceToLight / range;
    return max(min(1.0 - pow(ratio, 4.0), 1.0), 0.0) / max(distanceToLight * distanceToLight, 0.0001);
}
vec3 shadeLight(vec3 normal, vec3 view, float nv, vec3 f0, vec3 baseColor, float metallic, float roughness,
                vec3 toLight, vec3 radiance) {
    float nl = max(dot(normal, toLight), 0.0);
    vec3 halfVector = normalize(view + toLight);
    vec3 fresnel = fresnelSchlick(max(dot(halfVector, view), 0.0), f0);
    float distribution = distributionGgx(normal, halfVector, roughness);
    float geometry = geometrySchlick(nv, roughness) * geometrySchlick(nl, roughness);
    vec3 specular = distribution * geometry * fresnel / max(4.0 * nv * nl, 0.0001);
    vec3 diffuse = (vec3(1.0) - fresnel) * (1.0 - metallic) * baseColor / PI;
    return (diffuse + specular) * radiance * nl;
}
vec2 materialUv(vec4 os, float rotation, int uvSet) {
    vec2 uv = uvSet == 1 ? v_uv1 : v_uv;
    float c = cos(rotation), s = sin(rotation);
    vec2 scaled = uv * os.zw;
    return vec2(c * scaled.x - s * scaled.y, s * scaled.x + c * scaled.y) + os.xy;
}
void main() {
    vec4 base = u_color;
    if (u_hasBaseColorTexture) {
        vec4 texel = texture2D(u_baseColorTexture,
            materialUv(u_baseColorOffsetScale, u_baseColorRotation, u_baseColorUvSet));
        base *= vec4(srgbToLinear(texel.rgb), texel.a);
    }
    if (u_alphaMode == 0) base.a = 1.0;
    if (u_alphaMode == 1 && base.a < u_alphaCutoff) discard;
    if (u_picking) { if (base.a <= 0.001) discard; gl_FragColor = u_color; return; }
    float metallic = u_metallic;
    float roughness = u_roughness;
    if (u_hasMetallicRoughnessTexture) {
        vec4 metallicRoughness = texture2D(u_metallicRoughnessTexture,
            materialUv(u_metallicRoughnessOffsetScale, u_metallicRoughnessRotation, u_metallicRoughnessUvSet));
        roughness *= metallicRoughness.g;
        metallic *= metallicRoughness.b;
    }
    if (u_unlit) { gl_FragColor = vec4(linearToSrgb(applyFog(base.rgb, v_worldPosition)), base.a); return; }
    vec3 normal = normalize(v_worldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
#if HAS_DERIVATIVES
    if (u_hasNormalTexture) {
        vec2 normalUv = materialUv(u_normalOffsetScale, u_normalRotation, u_normalUvSet);
        vec3 mapped = texture2D(u_normalTexture, normalUv).xyz * 2.0 - 1.0;
        mapped.xy *= u_normalScale;
        vec3 dpdx = dFdx(v_worldPosition), dpdy = dFdy(v_worldPosition);
        vec2 duvdx = dFdx(normalUv), duvdy = dFdy(normalUv);
        vec3 tangentRaw = dpdx * duvdy.y - dpdy * duvdx.y;
        vec3 bitangentRaw = -dpdx * duvdy.x + dpdy * duvdx.x;
        if (length(tangentRaw) > 0.00001 && length(bitangentRaw) > 0.00001) {
            normal = normalize(mat3(normalize(tangentRaw), normalize(bitangentRaw), normal) * mapped);
        }
    }
#endif
    vec3 view = normalize(u_cameraPosition - v_worldPosition);
    float nv = max(dot(normal, view), 0.0001);
    vec3 f0 = mix(vec3(0.04), base.rgb, metallic);
    vec3 reflected = vec3(0.0);
    for (int i = 0; i < ${lights}; i++) {
        if (i < u_lightCount) {
            vec4 lightPosition = u_lightPosition[i];
            vec4 lightColorRange = u_lightColorRange[i];
            vec3 toLight;
            float attenuation = 1.0;
            if (lightPosition.w < 0.5) {
                toLight = -lightPosition.xyz;
            } else {
                vec3 offset = lightPosition.xyz - v_worldPosition;
                float distanceToLight = length(offset);
                toLight = offset / max(distanceToLight, 0.0001);
                attenuation = pointAttenuation(distanceToLight, lightColorRange.w);
            }
            if (dot(normal, toLight) <= 0.0 || attenuation <= 0.0) continue;
            float visibility = i == u_shadowLightIndex ? shadowVisibility() : 1.0;
            reflected += shadeLight(normal, view, nv, f0, base.rgb, metallic, roughness, toLight,
                lightColorRange.rgb * attenuation * visibility);
        }
    }
#if CLUSTERED
    // Per-pixel point lights: this fragment's world cell is one texture row of packed lights.
    if (u_hasClusters) {
        vec3 cell = floor((v_worldPosition - u_clusterOrigin) / u_clusterCellSize);
        if (cell.x >= 0.0 && cell.y >= 0.0 && cell.z >= 0.0
            && cell.x < u_clusterDims.x && cell.y < u_clusterDims.y && cell.z < u_clusterDims.z) {
            float row = cell.x + u_clusterDims.x * (cell.y + u_clusterDims.y * cell.z);
            float rowV = (row + 0.5) / u_clusterTextureSize.y;
            for (int i = 0; i < CLUSTER_LIGHTS; i++) {
                vec4 clusterPosition = texture2D(u_clusterLights, vec2((float(i) * 2.0 + 0.5) / u_clusterTextureSize.x, rowV));
                if (clusterPosition.w <= 0.0) break;
                vec3 offset = clusterPosition.xyz - v_worldPosition;
                float distanceToLight = length(offset);
                float attenuation = pointAttenuation(distanceToLight, clusterPosition.w);
                vec3 toLight = offset / max(distanceToLight, 0.0001);
                if (attenuation <= 0.0 || dot(normal, toLight) <= 0.0) continue;
                vec4 clusterColor = texture2D(u_clusterLights, vec2((float(i) * 2.0 + 1.5) / u_clusterTextureSize.x, rowV));
                reflected += shadeLight(normal, view, nv, f0, base.rgb, metallic, roughness, toLight,
                    clusterColor.rgb * attenuation);
            }
        }
    }
#endif
    float sky = mix(0.55, 1.0, normal.y * 0.5 + 0.5);
    vec3 envFresnel = f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(1.0 - nv, 5.0);
    vec3 environment = (${ENVIRONMENT_INTENSITY_3D.toFixed(4)} * sky) * vec3(
        ${ENVIRONMENT_COLOR_3D[0]}, ${ENVIRONMENT_COLOR_3D[1]}, ${ENVIRONMENT_COLOR_3D[2]})
        * ((vec3(1.0) - envFresnel) * (1.0 - metallic) * base.rgb
            + envFresnel * (1.0 - 0.6 * roughness));
    if (u_hasEnvironment) {
        vec3 diffuseEnvironment = texture2D(u_environmentDiffuse, environmentUv(normal)).rgb
            * u_environmentIntensity;
        vec2 reflectedUv = environmentUv(reflect(-view, normal));
        vec3 specularA = texture2D(u_environmentSpecular0, reflectedUv).rgb;
        vec3 specularB = texture2D(u_environmentSpecular1, reflectedUv).rgb;
        vec3 specularEnvironment = mix(specularA, specularB, roughness) * u_environmentIntensity;
        environment = (vec3(1.0) - envFresnel) * (1.0 - metallic) * base.rgb * diffuseEnvironment
            + envFresnel * mix(specularEnvironment, diffuseEnvironment, roughness * roughness);
    }
    vec3 emissive = u_emissive;
    if (u_hasEmissiveTexture) emissive *= srgbToLinear(texture2D(u_emissiveTexture,
        materialUv(u_emissiveOffsetScale, u_emissiveRotation, u_emissiveUvSet)).rgb);
    gl_FragColor = vec4(linearToSrgb(applyFog(reflected + environment + emissive, v_worldPosition)), base.a);
}
`; }

const SHADOW_VERTEX = `
attribute vec3 a_position;
uniform mat4 u_mvp;
${SKIN_SHADER.declarations}
${SKIN_SHADER.functions}
void main() { gl_Position = u_mvp * skinPoint(vec4(a_position, 1.0)); }
`;
const SHADOW_FRAGMENT = `
precision mediump float;
vec4 packDepth(float depth) {
    vec4 encoded = fract(depth * vec4(16777216.0, 65536.0, 256.0, 1.0));
    encoded -= encoded.xxyz * vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
    return encoded;
}
void main() { gl_FragColor = packDepth(gl_FragCoord.z); }
`;

const PARTICLE_VERTEX = `
attribute vec3 a_center;
attribute vec2 a_corner;
attribute float a_size;
attribute vec4 a_color;
uniform mat4 u_viewProjection;
uniform vec3 u_cameraRight;
uniform vec3 u_cameraUp;
varying vec2 v_corner;
varying vec4 v_color;
varying vec3 v_worldPosition;
void main() {
    vec3 world = a_center + (u_cameraRight * a_corner.x + u_cameraUp * a_corner.y) * (a_size * 0.5);
    v_corner = a_corner; v_color = a_color; v_worldPosition = world;
    gl_Position = u_viewProjection * vec4(world, 1.0);
}
`;
const PARTICLE_FRAGMENT = `
precision mediump float;
uniform vec3 u_cameraPosition;
uniform bool u_additive;
uniform bool u_sparkle;
varying vec2 v_corner;
varying vec4 v_color;
varying vec3 v_worldPosition;
${FOG_GLSL_3D}
vec3 linearToSrgb(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
    float r = length(v_corner);
    if (r >= 1.0) discard;
    float shape = (1.0 - r) * (1.0 - r);
    if (u_sparkle) {
        float flare = max(0.0, 1.0 - abs(v_corner.x) * 10.0) * (1.0 - abs(v_corner.y))
            + max(0.0, 1.0 - abs(v_corner.y) * 10.0) * (1.0 - abs(v_corner.x));
        shape = clamp(exp(-r * r * 9.0) + flare * 0.7, 0.0, 1.0);
    }
    float fog = clamp(fogAmount(v_worldPosition), 0.0, 1.0);
    float alpha = v_color.a * shape;
    if (u_additive) gl_FragColor = vec4(linearToSrgb(v_color.rgb * alpha * (1.0 - fog)), 1.0);
    else gl_FragColor = vec4(linearToSrgb(mix(v_color.rgb, u_fogColor, fog)), alpha);
}
`;

/** Particle program sources, exported so the Electron gate can compile them too. */
export function webGL3DParticleShaderSources(): { vertex: string; fragment: string } {
    return { vertex: PARTICLE_VERTEX, fragment: PARTICLE_FRAGMENT };
}

/** Largest particle batch per draw call in vertices; 16-bit indices cover four per particle. */
export const PARTICLE_BATCH_MAX_3D = 16384;

/**
 * Exact production sources, exported so the Electron gate compiles what the viewport executes.
 * lights sizes the per-draw light arrays; the viewport picks it with drawLightBudget3D.
 */
export function webGL3DShaderSources(derivatives: boolean, lights = MAX_DRAW_LIGHTS_3D,
                                     clustered = false): { vertex: string; fragment: string } {
    const size = Math.max(1, Math.floor(Number.isFinite(lights) ? lights : MIN_DRAW_LIGHTS_3D));
    return { vertex: VERTEX, fragment: fragmentSource(derivatives, size, clustered) };
}

/** "clustered" shades point lights per pixel; "per-object" is the uniform-array fallback. */
export type LightingMode3D = "clustered" | "per-object";
const CLUSTER_TEXTURE_UNIT_3D = 8;

/** Why the per-pixel path is unavailable on this context, or null when it can be tried. */
export function clusteredLightingUnsupported3D(gl: WebGLRenderingContext): string | null {
    if (!gl.getExtension("OES_texture_float")) return "OES_texture_float is unavailable";
    const high = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (!high || high.precision <= 0) return "fragment shaders have no highp float";
    if ((gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number) <= CLUSTER_TEXTURE_UNIT_3D) return "fewer than nine texture units";
    if ((gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) < MAX_CLUSTER_LIGHTS_3D * 2) return "MAX_TEXTURE_SIZE is too small";
    return null;
}

interface State3D {
    gl: WebGLRenderingContext;
    program: WebGLProgram;
    position: WebGLBuffer;
    normal: WebGLBuffer;
    uv: WebGLBuffer;
    uv1: WebGLBuffer;
    indices: WebGLBuffer;
    joints: WebGLBuffer;
    weights: WebGLBuffer;
    positionLoc: number;
    jointsLoc: number;
    weightsLoc: number;
    skinnedLoc: WebGLUniformLocation | null;
    jointPaletteLoc: WebGLUniformLocation | null;
    normalLoc: number;
    uvLoc: number;
    uv1Loc: number;
    mvpLoc: WebGLUniformLocation | null;
    modelLoc: WebGLUniformLocation | null;
    normalMatrixLoc: WebGLUniformLocation | null;
    lightViewProjectionLoc: WebGLUniformLocation | null;
    colorLoc: WebGLUniformLocation | null;
    pickingLoc: WebGLUniformLocation | null;
    unlitLoc: WebGLUniformLocation | null;
    lightCountLoc: WebGLUniformLocation | null;
    lightPositionLoc: WebGLUniformLocation | null;
    lightColorRangeLoc: WebGLUniformLocation | null;
    /** Light-array size the main program was compiled with. */
    lightBudget: number;
    packedLights: PackedLights3D | undefined;
    lightingMode: LightingMode3D;
    lightingNote: string | null;
    hasClustersLoc: WebGLUniformLocation | null;
    clusterLightsLoc: WebGLUniformLocation | null;
    clusterOriginLoc: WebGLUniformLocation | null;
    clusterDimsLoc: WebGLUniformLocation | null;
    clusterCellSizeLoc: WebGLUniformLocation | null;
    clusterTextureSizeLoc: WebGLUniformLocation | null;
    clusterTexture: WebGLTexture | null;
    clusterSignature: number | null;
    clusters: LightClusters3D | null;
    hasTextureLoc: WebGLUniformLocation | null;
    textureLoc: WebGLUniformLocation | null;
    hasMetallicRoughnessTextureLoc: WebGLUniformLocation | null;
    metallicRoughnessTextureLoc: WebGLUniformLocation | null;
    hasNormalTextureLoc: WebGLUniformLocation | null;
    normalTextureLoc: WebGLUniformLocation | null;
    normalScaleLoc: WebGLUniformLocation | null;
    hasEmissiveTextureLoc: WebGLUniformLocation | null;
    emissiveTextureLoc: WebGLUniformLocation | null;
    textureOffsetScaleLocs: (WebGLUniformLocation | null)[];
    textureRotationLocs: (WebGLUniformLocation | null)[];
    textureUvSetLocs: (WebGLUniformLocation | null)[];
    alphaModeLoc: WebGLUniformLocation | null;
    alphaCutoffLoc: WebGLUniformLocation | null;
    hasEnvironmentLoc: WebGLUniformLocation | null;
    environmentTextureLocs: (WebGLUniformLocation | null)[];
    environmentIntensityLoc: WebGLUniformLocation | null;
    environmentRotationLoc: WebGLUniformLocation | null;
    metallicLoc: WebGLUniformLocation | null;
    roughnessLoc: WebGLUniformLocation | null;
    emissiveLoc: WebGLUniformLocation | null;
    cameraPositionLoc: WebGLUniformLocation | null;
    hasShadowLoc: WebGLUniformLocation | null;
    shadowLightIndexLoc: WebGLUniformLocation | null;
    shadowTextureLoc: WebGLUniformLocation | null;
    shadowTexelLoc: WebGLUniformLocation | null;
    shadowProgram: WebGLProgram;
    shadowPositionLoc: number;
    shadowJointsLoc: number;
    shadowWeightsLoc: number;
    shadowSkinnedLoc: WebGLUniformLocation | null;
    shadowJointPaletteLoc: WebGLUniformLocation | null;
    shadowMvpLoc: WebGLUniformLocation | null;
    shadowFramebuffer: WebGLFramebuffer;
    shadowTexture: WebGLTexture;
    shadowDepth: WebGLRenderbuffer;
    shadowSize: number;
    textures: Map<string, WebGLTexture>;
    textureSizes: Map<string, { width: number; height: number }>;
    readyTextures: Set<string>;
    environmentTextures: Map<string, { image: object; texture: WebGLTexture }>;
    redraw: (() => void) | null;
    pickFramebuffer: WebGLFramebuffer;
    pickTexture: WebGLTexture;
    pickDepth: WebGLRenderbuffer;
    pickIds: (string | null)[];
    width: number;
    height: number;
    uintIndices: OES_element_index_uint | null;
    uploads: (() => void)[];
    uploadScheduled: boolean;
    disposed: boolean;
    fogLocs: (WebGLUniformLocation | null)[];
    /** undefined until first needed; null when the particle program was rejected (particles are skipped). */
    particles?: ParticleGL3D | null;
    particleNote: string | null;
}

interface ParticleGL3D {
    program: WebGLProgram; vertices: WebGLBuffer; indices: WebGLBuffer;
    centerLoc: number; cornerLoc: number; sizeLoc: number; colorLoc: number;
    viewProjectionLoc: WebGLUniformLocation | null; rightLoc: WebGLUniformLocation | null; upLoc: WebGLUniformLocation | null;
    cameraPositionLoc: WebGLUniformLocation | null; additiveLoc: WebGLUniformLocation | null; sparkleLoc: WebGLUniformLocation | null;
    fogLocs: (WebGLUniformLocation | null)[];
}

type Canvas3D = HTMLCanvasElement & { __vde3D?: State3D | null; __vde3DContextHandlers?: boolean;
    __vde3DLastFrame?: { frame: Frame3D; dpr: number } };
export const MAX_UPLOAD_QUEUE_3D = 32;
let failure: string | null = null;
export function lastWebGL3DFailure(): string | null { return failure; }

function shader(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader | null {
    const out = gl.createShader(kind);
    if (!out) return null;
    gl.shaderSource(out, source); gl.compileShader(out);
    if (!gl.getShaderParameter(out, gl.COMPILE_STATUS)) {
        failure = `3D shader did not compile: ${gl.getShaderInfoLog(out) ?? "no driver log"}`;
        gl.deleteShader(out); return null;
    }
    return out;
}

function mainProgram(gl: WebGLRenderingContext, derivatives: boolean, lights: number, clustered = false): WebGLProgram | null {
    const sources = webGL3DShaderSources(derivatives, lights, clustered);
    const vs = shader(gl, gl.VERTEX_SHADER, sources.vertex), fs = shader(gl, gl.FRAGMENT_SHADER, sources.fragment);
    const program = vs && fs ? gl.createProgram() : null;
    if (!vs || !fs || !program) {
        if (vs) gl.deleteShader(vs);
        if (fs) gl.deleteShader(fs);
        return null;
    }
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        failure = `3D program did not link: ${gl.getProgramInfoLog(program) ?? "no driver log"}`;
        gl.deleteProgram(program); return null;
    }
    return program;
}

function init(canvas: HTMLCanvasElement): State3D | null {
    failure = null;
    const gl = canvas.getContext("webgl", { alpha: false, depth: true, antialias: true });
    if (!gl) { failure = "the browser would not provide a WebGL context for the 3D viewport"; return null; }
    const derivatives = !!gl.getExtension("OES_standard_derivatives");
    // Size the light arrays from the reported uniform limit, then step down a tier if a driver
    // still refuses the program, so a weak GPU gets fewer lights per draw instead of no viewport.
    let lightBudget = drawLightBudget3D(gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) as number);
    // Per-pixel clustered lighting first; any missing capability or a rejected program falls back
    // to the per-object uniform path. A canvas with data-lighting="per-object" forces the fallback.
    const forced = canvas.dataset?.lighting === "per-object" ? "per-object lighting was requested" : null;
    let lightingNote = forced ?? clusteredLightingUnsupported3D(gl);
    let lightingMode: LightingMode3D = "per-object";
    let program: WebGLProgram | null = null;
    if (!lightingNote) {
        program = mainProgram(gl, derivatives, lightBudget, true);
        if (program) lightingMode = "clustered";
        else { lightingNote = failure ?? "the clustered program was rejected"; failure = null; }
    }
    if (!program) program = mainProgram(gl, derivatives, lightBudget);
    for (const tier of DRAW_LIGHT_TIERS_3D) {
        if (program) break;
        if (tier >= lightBudget) continue;
        lightBudget = tier; failure = null;
        program = mainProgram(gl, derivatives, lightBudget);
    }
    const position = gl.createBuffer(), normal = gl.createBuffer(),
        uv = gl.createBuffer(), uv1 = gl.createBuffer(), indices = gl.createBuffer(),
        joints = gl.createBuffer(), weights = gl.createBuffer();
    const pickFramebuffer = gl.createFramebuffer(), pickTexture = gl.createTexture(), pickDepth = gl.createRenderbuffer();
    const shadowVs = shader(gl, gl.VERTEX_SHADER, SHADOW_VERTEX), shadowFs = shader(gl, gl.FRAGMENT_SHADER, SHADOW_FRAGMENT);
    const shadowProgram = gl.createProgram(), shadowFramebuffer = gl.createFramebuffer(), shadowTexture = gl.createTexture(),
        shadowDepth = gl.createRenderbuffer();
    if (!program || !position || !normal || !uv || !uv1 || !indices || !joints || !weights || !pickFramebuffer || !pickTexture || !pickDepth
        || !shadowVs || !shadowFs || !shadowProgram || !shadowFramebuffer || !shadowTexture || !shadowDepth) {
        failure = failure ?? "the 3D viewport could not allocate its WebGL resources"; return null;
    }
    gl.attachShader(shadowProgram, shadowVs); gl.attachShader(shadowProgram, shadowFs); gl.linkProgram(shadowProgram);
    if (!gl.getProgramParameter(shadowProgram, gl.LINK_STATUS)) {
        failure = `3D shadow program did not link: ${gl.getProgramInfoLog(shadowProgram) ?? "no driver log"}`; return null;
    }
    gl.deleteShader(shadowVs); gl.deleteShader(shadowFs);
    const state: State3D = { gl, program, position, normal, uv, uv1, indices, joints, weights,
        positionLoc: gl.getAttribLocation(program, "a_position"),
        jointsLoc: gl.getAttribLocation(program, "a_joints"),
        weightsLoc: gl.getAttribLocation(program, "a_weights"),
        skinnedLoc: gl.getUniformLocation(program, "u_skinned"),
        jointPaletteLoc: gl.getUniformLocation(program, "u_joints[0]"),
        normalLoc: gl.getAttribLocation(program, "a_normal"),
        uvLoc: gl.getAttribLocation(program, "a_uv"),
        uv1Loc: gl.getAttribLocation(program, "a_uv1"),
        mvpLoc: gl.getUniformLocation(program, "u_mvp"), modelLoc: gl.getUniformLocation(program, "u_model"),
        normalMatrixLoc: gl.getUniformLocation(program, "u_normalMatrix"),
        lightViewProjectionLoc: gl.getUniformLocation(program, "u_lightViewProjection"),
        colorLoc: gl.getUniformLocation(program, "u_color"),
        pickingLoc: gl.getUniformLocation(program, "u_picking"), unlitLoc: gl.getUniformLocation(program, "u_unlit"),
        lightCountLoc: gl.getUniformLocation(program, "u_lightCount"),
        lightPositionLoc: gl.getUniformLocation(program, "u_lightPosition[0]"),
        lightColorRangeLoc: gl.getUniformLocation(program, "u_lightColorRange[0]"),
        lightBudget, packedLights: undefined, lightingMode, lightingNote,
        hasClustersLoc: gl.getUniformLocation(program, "u_hasClusters"),
        clusterLightsLoc: gl.getUniformLocation(program, "u_clusterLights"),
        clusterOriginLoc: gl.getUniformLocation(program, "u_clusterOrigin"),
        clusterDimsLoc: gl.getUniformLocation(program, "u_clusterDims"),
        clusterCellSizeLoc: gl.getUniformLocation(program, "u_clusterCellSize"),
        clusterTextureSizeLoc: gl.getUniformLocation(program, "u_clusterTextureSize"),
        clusterTexture: lightingMode === "clustered" ? gl.createTexture() : null,
        clusterSignature: null, clusters: null,
        hasTextureLoc: gl.getUniformLocation(program, "u_hasBaseColorTexture"),
        textureLoc: gl.getUniformLocation(program, "u_baseColorTexture"),
        hasMetallicRoughnessTextureLoc: gl.getUniformLocation(program, "u_hasMetallicRoughnessTexture"),
        metallicRoughnessTextureLoc: gl.getUniformLocation(program, "u_metallicRoughnessTexture"),
        hasNormalTextureLoc: gl.getUniformLocation(program, "u_hasNormalTexture"),
        normalTextureLoc: gl.getUniformLocation(program, "u_normalTexture"),
        normalScaleLoc: gl.getUniformLocation(program, "u_normalScale"),
        hasEmissiveTextureLoc: gl.getUniformLocation(program, "u_hasEmissiveTexture"),
        emissiveTextureLoc: gl.getUniformLocation(program, "u_emissiveTexture"),
        textureOffsetScaleLocs: ["baseColor", "metallicRoughness", "normal", "emissive"]
            .map(name => gl.getUniformLocation(program, `u_${name}OffsetScale`)),
        textureRotationLocs: ["baseColor", "metallicRoughness", "normal", "emissive"]
            .map(name => gl.getUniformLocation(program, `u_${name}Rotation`)),
        textureUvSetLocs: ["baseColor", "metallicRoughness", "normal", "emissive"]
            .map(name => gl.getUniformLocation(program, `u_${name}UvSet`)),
        alphaModeLoc: gl.getUniformLocation(program, "u_alphaMode"),
        alphaCutoffLoc: gl.getUniformLocation(program, "u_alphaCutoff"),
        hasEnvironmentLoc: gl.getUniformLocation(program, "u_hasEnvironment"),
        environmentTextureLocs: ["Diffuse", "Specular0", "Specular1"]
            .map(name => gl.getUniformLocation(program, `u_environment${name}`)),
        environmentIntensityLoc: gl.getUniformLocation(program, "u_environmentIntensity"),
        environmentRotationLoc: gl.getUniformLocation(program, "u_environmentRotation"),
        metallicLoc: gl.getUniformLocation(program, "u_metallic"),
        roughnessLoc: gl.getUniformLocation(program, "u_roughness"),
        emissiveLoc: gl.getUniformLocation(program, "u_emissive"),
        cameraPositionLoc: gl.getUniformLocation(program, "u_cameraPosition"),
        hasShadowLoc: gl.getUniformLocation(program, "u_hasShadow"),
        shadowLightIndexLoc: gl.getUniformLocation(program, "u_shadowLightIndex"),
        shadowTextureLoc: gl.getUniformLocation(program, "u_shadowTexture"),
        shadowTexelLoc: gl.getUniformLocation(program, "u_shadowTexel"), shadowProgram,
        shadowPositionLoc: gl.getAttribLocation(shadowProgram, "a_position"),
        shadowJointsLoc: gl.getAttribLocation(shadowProgram, "a_joints"),
        shadowWeightsLoc: gl.getAttribLocation(shadowProgram, "a_weights"),
        shadowSkinnedLoc: gl.getUniformLocation(shadowProgram, "u_skinned"),
        shadowJointPaletteLoc: gl.getUniformLocation(shadowProgram, "u_joints[0]"),
        shadowMvpLoc: gl.getUniformLocation(shadowProgram, "u_mvp"), shadowFramebuffer, shadowTexture, shadowDepth,
        shadowSize: 0,
        textures: new Map(),
        textureSizes: new Map(),
        environmentTextures: new Map(),
        readyTextures: new Set(), redraw: null,
        pickFramebuffer, pickTexture, pickDepth, pickIds: [null], width: 0, height: 0,
        uintIndices: gl.getExtension("OES_element_index_uint"), uploads: [], uploadScheduled: false, disposed: false,
        fogLocs: ["u_fogMode", "u_fogColor", "u_fogParams", "u_fogHeight"].map(name => gl.getUniformLocation(program, name)),
        particleNote: null };
    const owned = canvas as Canvas3D;
    if (!owned.__vde3DContextHandlers) {
        owned.__vde3DContextHandlers = true;
        canvas.addEventListener("webglcontextlost", event => {
            event.preventDefault();
            const current = owned.__vde3D;
            if (current) { current.disposed = true; current.uploads.length = 0; }
            owned.__vde3D = null;
            failure = "the 3D WebGL context was lost; waiting for the device to restore it";
        });
        canvas.addEventListener("webglcontextrestored", () => {
            owned.__vde3D = undefined;
            const last = owned.__vde3DLastFrame;
            if (last) requestAnimationFrame(() => emitWebGL3D(canvas, last.frame, last.dpr));
        });
    }
    return state;
}

function enqueueUpload(state: State3D, upload: () => void): void {
    if (state.disposed || state.uploads.length >= MAX_UPLOAD_QUEUE_3D) return;
    state.uploads.push(upload);
    scheduleUploads(state);
}

function scheduleUploads(state: State3D): void {
    if (state.uploadScheduled) return;
    state.uploadScheduled = true;
    requestAnimationFrame(() => {
        state.uploadScheduled = false;
        if (state.disposed) { state.uploads.length = 0; return; }
        // At most two potentially flushing texImage uploads per frame.
        for (let count = 0; count < 2; count++) state.uploads.shift()?.();
        if (state.uploads.length) scheduleUploads(state);
        state.redraw?.();
    });
}

function environmentTextureFor(state: State3D, key: string, image: { width: number; height: number;
                              rgb: Float32Array }): WebGLTexture | null {
    if (!state.gl.getExtension("OES_texture_float")) return null;
    const cached = state.environmentTextures.get(key);
    if (cached?.image === image) return cached.texture;
    const { gl } = state, texture = cached?.texture ?? gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const linear = !!gl.getExtension("OES_texture_float_linear");
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, image.width, image.height, 0,
        gl.RGB, gl.FLOAT, image.rgb);
    state.environmentTextures.set(key, { image, texture });
    return texture;
}

export function normalizeTextureSampler3D(info: TextureInfo3D | null): TextureInfo3D["sampler"] {
    const source = info?.sampler;
    const min = new Set([9728, 9729, 9984, 9985, 9986, 9987]);
    const wrap = new Set([33071, 33648, 10497]);
    return {
        magFilter: source?.magFilter === 9728 ? 9728 : 9729,
        minFilter: source && min.has(source.minFilter) ? source.minFilter : 9987,
        wrapS: source && wrap.has(source.wrapS) ? source.wrapS : 10497,
        wrapT: source && wrap.has(source.wrapT) ? source.wrapT : 10497
    };
}

function textureFor(state: State3D, source: string, info: TextureInfo3D | null): WebGLTexture | null {
    const sampler = normalizeTextureSampler3D(info);
    const key = `${source}\n${sampler.magFilter},${sampler.minFilter},${sampler.wrapS},${sampler.wrapT}`;
    const cached = state.textures.get(key);
    if (cached) return cached;
    const { gl } = state, texture = gl.createTexture();
    if (!texture) return null;
    state.textures.set(key, texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampler.magFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([255, 255, 255, 255]));
    const image = new Image();
    image.onload = () => enqueueUpload(state, () => {
        if (state.disposed || state.textures.get(key) !== texture) return;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        const needsPowerOfTwo = sampler.wrapS !== 33071 || sampler.wrapT !== 33071 || sampler.minFilter >= 9984;
        const powerOfTwo = (value: number) => value > 0 && (value & (value - 1)) === 0;
        let upload: TexImageSource = image;
        if (needsPowerOfTwo && (!powerOfTwo(image.width) || !powerOfTwo(image.height))) {
            const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
            const next = (value: number) => Math.min(limit, 2 ** Math.ceil(Math.log2(Math.max(1, value))));
            const canvas = document.createElement("canvas");
            canvas.width = next(image.width); canvas.height = next(image.height);
            const context = canvas.getContext("2d");
            if (context) { context.drawImage(image, 0, 0, canvas.width, canvas.height); upload = canvas; }
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, upload);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampler.magFilter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, sampler.wrapS);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, sampler.wrapT);
        if (sampler.minFilter >= 9984) gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sampler.minFilter);
        state.readyTextures.add(key);
        state.textureSizes.set(source, { width: image.width, height: image.height });
    });
    // Keep the initialized white texel on decode failure. Deleting the cache entry would make
    // every subsequent frame retry the same broken image and churn GPU objects forever.
    image.onerror = () => { /* stable white fallback */ };
    image.src = source;
    return texture;
}

function generatedNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const normals = new Float32Array(positions.length);
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
        const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1];
        const abz = positions[b + 2] - positions[a + 2], acx = positions[c] - positions[a];
        const acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
        const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
        for (const at of [a, b, c]) { normals[at] += nx; normals[at + 1] += ny; normals[at + 2] += nz; }
    }
    for (let i = 0; i < normals.length; i += 3) {
        const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
        normals[i] /= length; normals[i + 1] /= length; normals[i + 2] /= length;
    }
    return normals;
}

function normalMatrix(model: readonly number[]): Float32Array {
    const inverse = invertMat4(model);
    if (!inverse) return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    return new Float32Array([inverse[0], inverse[4], inverse[8], inverse[1], inverse[5], inverse[9],
        inverse[2], inverse[6], inverse[10]]);
}

function sizePickTarget(state: State3D, width: number, height: number): boolean {
    if (state.width === width && state.height === height) return true;
    const { gl } = state;
    gl.bindTexture(gl.TEXTURE_2D, state.pickTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, state.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.pickFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.pickTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, state.pickDepth);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Sampling from a texture while it is attached to the active framebuffer is a WebGL feedback
    // loop and makes drawElements INVALID_OPERATION even when the shader branch skips the sample.
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (!complete) { failure = "the 3D picking framebuffer is incomplete"; return false; }
    state.width = width; state.height = height; return true;
}

export function pickColor3D(index: number): readonly [number, number, number, number] {
    return [(index & 255) / 255, ((index >>> 8) & 255) / 255, ((index >>> 16) & 255) / 255, 1];
}

export function pickIndex3D(pixel: ArrayLike<number>): number {
    return (pixel[0] ?? 0) | ((pixel[1] ?? 0) << 8) | ((pixel[2] ?? 0) << 16);
}

function bindSkin(gl: WebGLRenderingContext, draw: Frame3D["draws"][number], buffer: { joints: WebGLBuffer; weights: WebGLBuffer },
    jointsLoc: number, weightsLoc: number, skinnedLoc: WebGLUniformLocation | null, paletteLoc: WebGLUniformLocation | null): void {
    const skin = draw.skin;
    gl.uniform1f(skinnedLoc, skin ? 1 : 0);
    if (skin && jointsLoc >= 0 && weightsLoc >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer.joints);
        gl.bufferData(gl.ARRAY_BUFFER, skin.joints, gl.STREAM_DRAW);
        gl.enableVertexAttribArray(jointsLoc);
        gl.vertexAttribPointer(jointsLoc, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer.weights);
        gl.bufferData(gl.ARRAY_BUFFER, skin.weights, gl.STREAM_DRAW);
        gl.enableVertexAttribArray(weightsLoc);
        gl.vertexAttribPointer(weightsLoc, 4, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(paletteLoc, false, skin.palette);
        return;
    }
    if (jointsLoc >= 0) { gl.disableVertexAttribArray(jointsLoc); gl.vertexAttrib4f(jointsLoc, 0, 0, 0, 0); }
    if (weightsLoc >= 0) { gl.disableVertexAttribArray(weightsLoc); gl.vertexAttrib4f(weightsLoc, 0, 0, 0, 0); }
}

function renderDirectionalShadow(state: State3D, frame: Frame3D): boolean {
    if (!frame.shadow) return false;
    const { gl } = state, size = Math.min(1024, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, null);
    if (state.shadowSize !== size) {
        gl.bindTexture(gl.TEXTURE_2D, state.shadowTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, state.shadowDepth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, size, size);
        gl.bindFramebuffer(gl.FRAMEBUFFER, state.shadowFramebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.shadowTexture, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, state.shadowDepth);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null); failure = "the 3D shadow framebuffer is incomplete"; return false;
        }
        state.shadowSize = size;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.shadowFramebuffer); gl.viewport(0, 0, size, size);
    gl.clearColor(1, 1, 1, 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(state.shadowProgram); gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT); gl.disable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.position); gl.enableVertexAttribArray(state.shadowPositionLoc);
    gl.vertexAttribPointer(state.shadowPositionLoc, 3, gl.FLOAT, false, 0, 0);
    for (const draw of frame.draws) {
        if (draw.alphaMode === "BLEND") continue;
        const max = draw.primitive.indices.reduce((a, b) => Math.max(a, b), 0);
        if (max > 65535 && !state.uintIndices) continue;
        const indices = max > 65535 ? draw.primitive.indices : Uint16Array.from(draw.primitive.indices);
        gl.bindBuffer(gl.ARRAY_BUFFER, state.position); gl.bufferData(gl.ARRAY_BUFFER, draw.primitive.positions, gl.STREAM_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.indices); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STREAM_DRAW);
        bindSkin(gl, draw, state, state.shadowJointsLoc, state.shadowWeightsLoc, state.shadowSkinnedLoc, state.shadowJointPaletteLoc);
        gl.uniformMatrix4fv(state.shadowMvpLoc, false,
            multiplyMat4(frame.shadow.lightViewProjection, draw.model));
        gl.drawElements(gl.TRIANGLES, indices.length, max > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    }
    gl.cullFace(gl.BACK); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
}

/** Rebins and uploads the light grid only when the frame's lights changed. */
function bindClusters(state: State3D, frame: Frame3D): LightClusters3D | null {
    const { gl } = state;
    if (state.lightingMode !== "clustered" || !state.clusterTexture) return null;
    const signature = lightSignature3D(frame.lights);
    if (signature !== state.clusterSignature) {
        const maxRows = Math.min(MAX_CLUSTER_CELLS_3D, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
        state.clusters = buildLightClusters3D(frame.lights, MAX_CLUSTER_LIGHTS_3D, maxRows);
        state.clusterSignature = signature;
        if (state.clusters) {
            gl.activeTexture(gl.TEXTURE0 + CLUSTER_TEXTURE_UNIT_3D);
            gl.bindTexture(gl.TEXTURE_2D, state.clusterTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, state.clusters.width, state.clusters.height, 0,
                gl.RGBA, gl.FLOAT, state.clusters.data);
        }
    }
    const clusters = state.clusters;
    gl.uniform1i(state.hasClustersLoc, clusters ? 1 : 0);
    gl.uniform1i(state.clusterLightsLoc, CLUSTER_TEXTURE_UNIT_3D);
    gl.activeTexture(gl.TEXTURE0 + CLUSTER_TEXTURE_UNIT_3D);
    gl.bindTexture(gl.TEXTURE_2D, state.clusterTexture);
    if (clusters) {
        gl.uniform3fv(state.clusterOriginLoc, clusters.origin);
        gl.uniform3fv(state.clusterDimsLoc, clusters.dims);
        gl.uniform1f(state.clusterCellSizeLoc, clusters.cellSize);
        gl.uniform2f(state.clusterTextureSizeLoc, clusters.width, clusters.height);
    }
    return clusters;
}

function drawFrame(state: State3D, frame: Frame3D, picking: boolean, hasShadow = false): void {
    const { gl } = state;
    const pv = multiplyMat4(frame.projection, frame.view);
    state.pickIds = [null];
    gl.useProgram(state.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.position);
    gl.enableVertexAttribArray(state.positionLoc);
    gl.vertexAttribPointer(state.positionLoc, 3, gl.FLOAT, false, 0, 0);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE); gl.frontFace(gl.CCW); gl.cullFace(gl.BACK);
    gl.uniform1i(state.pickingLoc, picking ? 1 : 0);
    gl.uniform1i(state.lightCountLoc, 0);
    const clustered = !picking && !!bindClusters(state, frame);
    if (picking && state.hasClustersLoc) gl.uniform1i(state.hasClustersLoc, 0);
    gl.uniform3fv(state.cameraPositionLoc, frame.cameraPosition);
    setFogUniforms(gl, state.fogLocs, picking ? null : frame.fog);
    gl.uniformMatrix4fv(state.lightViewProjectionLoc, false,
        frame.shadow?.lightViewProjection ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    gl.uniform1i(state.hasShadowLoc, !picking && hasShadow ? 1 : 0);
    gl.uniform1i(state.shadowLightIndexLoc, -1);
    gl.uniform1i(state.shadowTextureLoc, 7); gl.uniform2f(state.shadowTexelLoc,
        1 / Math.max(1, state.shadowSize), 1 / Math.max(1, state.shadowSize));
    gl.activeTexture(gl.TEXTURE7);
    if (hasShadow) gl.bindTexture(gl.TEXTURE_2D, state.shadowTexture);
    gl.uniform1i(state.textureLoc, 0); gl.uniform1i(state.metallicRoughnessTextureLoc, 1);
    gl.uniform1i(state.normalTextureLoc, 2); gl.uniform1i(state.emissiveTextureLoc, 3);
    const ibl = frame.environment ? (frame.environment.ibl ?? preparedEnvironment3D(frame.environment.image)) : null;
    const environmentImages = ibl ? [ibl.diffuse, ibl.specular[0], ibl.specular[ibl.specular.length - 1]] : [];
    const environmentTextures = environmentImages.map((image, index) => {
        gl.uniform1i(state.environmentTextureLocs[index], 4 + index);
        gl.activeTexture(gl.TEXTURE0 + 4 + index);
        return !picking && frame.environment && image
            ? environmentTextureFor(state, `${frame.environment.assetId}:${index}`, image) : null;
    });
    gl.uniform1i(state.hasEnvironmentLoc, environmentTextures.length === 3 && environmentTextures.every(Boolean) ? 1 : 0);
    gl.uniform1f(state.environmentIntensityLoc, frame.environment?.intensity ?? 0);
    gl.uniform1f(state.environmentRotationLoc, frame.environment?.rotationRadians ?? 0);
    environmentTextures.forEach((texture, index) => {
        if (texture) { gl.activeTexture(gl.TEXTURE0 + 4 + index); gl.bindTexture(gl.TEXTURE_2D, texture); }
    });
    const distanceSquared = (draw: Frame3D["draws"][number]) => {
        const dx = draw.model[12] - frame.cameraPosition[0], dy = draw.model[13] - frame.cameraPosition[1];
        const dz = draw.model[14] - frame.cameraPosition[2];
        return dx * dx + dy * dy + dz * dz;
    };
    const draws = picking ? frame.draws : [
        ...frame.draws.filter(draw => draw.alphaMode !== "BLEND"),
        ...frame.draws.filter(draw => draw.alphaMode === "BLEND").sort((a, b) => distanceSquared(b) - distanceSquared(a))
    ];
    for (const draw of draws) {
        if (draw.doubleSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
        if (!picking && draw.alphaMode === "BLEND") {
            gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
        } else { gl.disable(gl.BLEND); gl.depthMask(true); }
        const max = draw.primitive.indices.reduce((a, b) => Math.max(a, b), 0);
        if (max > 65535 && !state.uintIndices) continue;
        const indexData = max > 65535 ? draw.primitive.indices : Uint16Array.from(draw.primitive.indices);
        // Every previous draw leaves ARRAY_BUFFER on UV1. Rebind position per draw or the second
        // primitive uploads positions into the UV buffer and reuses the first primitive's geometry.
        gl.bindBuffer(gl.ARRAY_BUFFER, state.position);
        gl.bufferData(gl.ARRAY_BUFFER, draw.primitive.positions, gl.STREAM_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, state.normal);
        gl.enableVertexAttribArray(state.normalLoc);
        gl.vertexAttribPointer(state.normalLoc, 3, gl.FLOAT, false, 0, 0);
        gl.bufferData(gl.ARRAY_BUFFER, draw.primitive.normals ??
            generatedNormals(draw.primitive.positions, draw.primitive.indices), gl.STREAM_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, state.uv);
        gl.enableVertexAttribArray(state.uvLoc);
        gl.vertexAttribPointer(state.uvLoc, 2, gl.FLOAT, false, 0, 0);
        gl.bufferData(gl.ARRAY_BUFFER, draw.primitive.uvs ??
            new Float32Array(draw.primitive.positions.length / 3 * 2), gl.STREAM_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, state.uv1);
        gl.enableVertexAttribArray(state.uv1Loc);
        gl.vertexAttribPointer(state.uv1Loc, 2, gl.FLOAT, false, 0, 0);
        gl.bufferData(gl.ARRAY_BUFFER, draw.primitive.uvs1 ?? draw.primitive.uvs ??
            new Float32Array(draw.primitive.positions.length / 3 * 2), gl.STREAM_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.indices);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STREAM_DRAW);
        bindSkin(gl, draw, state, state.jointsLoc, state.weightsLoc, state.skinnedLoc, state.jointPaletteLoc);
        gl.uniformMatrix4fv(state.mvpLoc, false, multiplyMat4(pv, draw.model));
        gl.uniformMatrix4fv(state.modelLoc, false, draw.model);
        gl.uniformMatrix3fv(state.normalMatrixLoc, false, normalMatrix(draw.model));
        gl.uniform1i(state.unlitLoc, draw.unlit ? 1 : 0);
        if (!picking && !draw.unlit) {
            // Per-draw light list: the strongest lights that can reach this draw's bounds.
            const selection = selectDrawLights3D(frame.lights,
                clustered ? null : drawBoundingSphere3D(draw.primitive.positions, draw.model, draw.skin), state.lightBudget,
                frame.shadow?.lightIndex ?? -1, clustered);
            const packed = state.packedLights = packDrawLights3D(frame.lights, selection.indices,
                state.lightBudget, state.packedLights);
            gl.uniform1i(state.lightCountLoc, packed.count);
            gl.uniform4fv(state.lightPositionLoc, packed.positions);
            gl.uniform4fv(state.lightColorRangeLoc, packed.colors);
            gl.uniform1i(state.shadowLightIndexLoc, selection.shadowSlot);
        }
        gl.uniform1f(state.metallicLoc, draw.metallic);
        gl.uniform1f(state.roughnessLoc, draw.roughness);
        gl.uniform3fv(state.emissiveLoc, draw.emissive);
        gl.uniform1f(state.normalScaleLoc, draw.normalScale);
        gl.uniform1i(state.alphaModeLoc, draw.alphaMode === "MASK" ? 1 : draw.alphaMode === "BLEND" ? 2 : 0);
        gl.uniform1f(state.alphaCutoffLoc, draw.alphaCutoff);
        const infos = [draw.baseColorTextureInfo, draw.metallicRoughnessTextureInfo,
            draw.normalTextureInfo, draw.emissiveTextureInfo];
        const offsetScale = new Float32Array(16), rotations = new Float32Array(4), uvSets = new Int32Array(4);
        infos.forEach((info, index) => {
            const transform = info?.transform;
            offsetScale.set([transform?.offset[0] ?? 0, transform?.offset[1] ?? 0,
                transform?.scale[0] ?? 1, transform?.scale[1] ?? 1], index * 4);
            const size = draw.baseColorTexture && state.textureSizes.get(draw.baseColorTexture);
            const crop = draw.baseColorSourceRect;
            if (index === 0 && crop && size) {
                offsetScale.set([crop.x / size.width, crop.y / size.height,
                    crop.width / size.width, crop.height / size.height], 0);
            }
            rotations[index] = transform?.rotation ?? 0;
            uvSets[index] = info?.texCoord === 1 ? 1 : 0;
        });
        for (let i = 0; i < 4; i++) {
            gl.uniform4fv(state.textureOffsetScaleLocs[i], offsetScale.subarray(i * 4, i * 4 + 4));
            gl.uniform1f(state.textureRotationLocs[i], rotations[i]);
            gl.uniform1i(state.textureUvSetLocs[i], uvSets[i]);
        }
        gl.activeTexture(gl.TEXTURE0);
        const texture = draw.baseColorTexture ? textureFor(state, draw.baseColorTexture, draw.baseColorTextureInfo) : null;
        gl.uniform1i(state.hasTextureLoc, texture ? 1 : 0);
        if (texture) gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.activeTexture(gl.TEXTURE1);
        const metallicRoughnessTexture = !picking && draw.metallicRoughnessTexture
            ? textureFor(state, draw.metallicRoughnessTexture, draw.metallicRoughnessTextureInfo) : null;
        gl.uniform1i(state.hasMetallicRoughnessTextureLoc, metallicRoughnessTexture ? 1 : 0);
        if (metallicRoughnessTexture) gl.bindTexture(gl.TEXTURE_2D, metallicRoughnessTexture);
        gl.activeTexture(gl.TEXTURE2);
        const normalTexture = !picking && draw.normalTexture
            ? textureFor(state, draw.normalTexture, draw.normalTextureInfo) : null;
        gl.uniform1i(state.hasNormalTextureLoc, normalTexture ? 1 : 0);
        if (normalTexture) gl.bindTexture(gl.TEXTURE_2D, normalTexture);
        gl.activeTexture(gl.TEXTURE3);
        const emissiveTexture = !picking && draw.emissiveTexture
            ? textureFor(state, draw.emissiveTexture, draw.emissiveTextureInfo) : null;
        gl.uniform1i(state.hasEmissiveTextureLoc, emissiveTexture ? 1 : 0);
        if (emissiveTexture) gl.bindTexture(gl.TEXTURE_2D, emissiveTexture);
        let color = draw.color;
        if (picking) {
            let index = state.pickIds.indexOf(draw.nodeId);
            if (index < 0) { index = state.pickIds.length; state.pickIds.push(draw.nodeId); }
            color = pickColor3D(index);
        }
        gl.uniform4fv(state.colorLoc, color);
        gl.drawElements(gl.TRIANGLES, indexData.length, max > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    }
    gl.disable(gl.BLEND); gl.depthMask(true);
}

const CLEAR_COLOR_3D = [0.055, 0.063, 0.09, 1] as const;

function setFogUniforms(gl: WebGLRenderingContext, locs: readonly (WebGLUniformLocation | null)[], fog: Frame3D["fog"]): void {
    gl.uniform1f(locs[0], fog ? FOG_MODE_CODE_3D[fog.mode] : 0);
    gl.uniform3f(locs[1], fog?.color.x ?? 0, fog?.color.y ?? 0, fog?.color.z ?? 0);
    gl.uniform3f(locs[2], fog?.density ?? 0, fog?.start ?? 0, fog?.end ?? 1);
    gl.uniform3f(locs[3], fog?.heightDensity ?? 0, fog?.heightBase ?? 0, fog?.heightFalloff ?? 1);
}

function particleGL(state: State3D): ParticleGL3D | null {
    if (state.particles !== undefined) return state.particles;
    const { gl } = state;
    const saved = failure;
    const vs = shader(gl, gl.VERTEX_SHADER, PARTICLE_VERTEX), fs = shader(gl, gl.FRAGMENT_SHADER, PARTICLE_FRAGMENT);
    const program = vs && fs ? gl.createProgram() : null;
    const vertices = gl.createBuffer(), indices = gl.createBuffer();
    if (program && vs && fs) { gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program); }
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (!program || !vertices || !indices || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
        state.particleNote = `particles disabled: ${failure ?? (program ? gl.getProgramInfoLog(program) : null) ?? "the particle program was rejected"}`;
        failure = saved;
        if (program) gl.deleteProgram(program);
        if (vertices) gl.deleteBuffer(vertices);
        if (indices) gl.deleteBuffer(indices);
        state.particles = null;
        return null;
    }
    const quads = new Uint16Array(PARTICLE_BATCH_MAX_3D / 4 * 6);
    for (let q = 0; q < PARTICLE_BATCH_MAX_3D / 4; q++) quads.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quads, gl.STATIC_DRAW);
    state.particles = { program, vertices, indices,
        centerLoc: gl.getAttribLocation(program, "a_center"), cornerLoc: gl.getAttribLocation(program, "a_corner"),
        sizeLoc: gl.getAttribLocation(program, "a_size"), colorLoc: gl.getAttribLocation(program, "a_color"),
        viewProjectionLoc: gl.getUniformLocation(program, "u_viewProjection"),
        rightLoc: gl.getUniformLocation(program, "u_cameraRight"), upLoc: gl.getUniformLocation(program, "u_cameraUp"),
        cameraPositionLoc: gl.getUniformLocation(program, "u_cameraPosition"),
        additiveLoc: gl.getUniformLocation(program, "u_additive"), sparkleLoc: gl.getUniformLocation(program, "u_sparkle"),
        fogLocs: ["u_fogMode", "u_fogColor", "u_fogParams", "u_fogHeight"].map(name => gl.getUniformLocation(program, name)) };
    return state.particles;
}

const CORNERS_3D = [-1, -1, 1, -1, 1, 1, -1, 1];
const PARTICLE_FLOATS_3D = 10;

/**
 * Billboard pass after the lit scene: depth-tested against it without writing depth, alpha
 * batches sorted back to front, additive batches unsorted. Fake fog glow rides the same path.
 * There is no soft-particle depth fade (WebGL 1 cannot read the depth buffer it is testing).
 */
function drawParticles(state: State3D, frame: Frame3D): void {
    const glow = fogGlowBatch3D(frame.lights, frame.fog);
    const batches = [...(frame.particles ?? []), ...(glow ? [glow] : [])].filter(b => b.count > 0);
    if (batches.length === 0) return;
    const gl2 = particleGL(state);
    if (!gl2) return;
    const { gl } = state;
    const view = frame.view;
    const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]];
    const forward = [-view[2], -view[6], -view[10]], eye = frame.cameraPosition;
    gl.useProgram(gl2.program);
    gl.uniformMatrix4fv(gl2.viewProjectionLoc, false, multiplyMat4(frame.projection, frame.view));
    gl.uniform3fv(gl2.rightLoc, right); gl.uniform3fv(gl2.upLoc, up);
    gl.uniform3fv(gl2.cameraPositionLoc, eye);
    setFogUniforms(gl, gl2.fogLocs, frame.fog);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
    gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl2.vertices);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl2.indices);
    // The main program's extra attribute arrays must not leak into this program's slots.
    for (let index = 0; index < 8; index++) gl.disableVertexAttribArray(index);
    const stride = PARTICLE_FLOATS_3D * 4;
    for (const [loc, size, offset] of [[gl2.centerLoc, 3, 0], [gl2.cornerLoc, 2, 3], [gl2.sizeLoc, 1, 5], [gl2.colorLoc, 4, 6]] as const) {
        if (loc < 0) continue;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
    }
    const ordered = [...batches.filter(b => b.blend === "alpha"), ...batches.filter(b => b.blend === "additive")];
    for (const batch of ordered) {
        const count = Math.min(batch.count, PARTICLE_BATCH_MAX_3D / 4);
        let order = Array.from({ length: count }, (_, i) => i);
        if (batch.blend === "alpha") {
            const depth = order.map(i => (batch.centers[i * 3] - eye[0]) * forward[0] + (batch.centers[i * 3 + 1] - eye[1]) * forward[1]
                + (batch.centers[i * 3 + 2] - eye[2]) * forward[2]);
            order = order.sort((a, b) => depth[b] - depth[a]);
        }
        const data = new Float32Array(count * 4 * PARTICLE_FLOATS_3D);
        let o = 0;
        for (const i of order) for (let c = 0; c < 4; c++) {
            data[o++] = batch.centers[i * 3]; data[o++] = batch.centers[i * 3 + 1]; data[o++] = batch.centers[i * 3 + 2];
            data[o++] = CORNERS_3D[c * 2]; data[o++] = CORNERS_3D[c * 2 + 1]; data[o++] = batch.sizes[i];
            data[o++] = batch.colors[i * 4]; data[o++] = batch.colors[i * 4 + 1]; data[o++] = batch.colors[i * 4 + 2]; data[o++] = batch.colors[i * 4 + 3];
        }
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
        if (batch.blend === "additive") gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1i(gl2.additiveLoc, batch.blend === "additive" ? 1 : 0);
        gl.uniform1i(gl2.sparkleLoc, batch.shape === "sparkle" ? 1 : 0);
        gl.drawElements(gl.TRIANGLES, count * 6, gl.UNSIGNED_SHORT, 0);
    }
    for (const loc of [gl2.centerLoc, gl2.cornerLoc, gl2.sizeLoc, gl2.colorLoc]) if (loc >= 0) gl.disableVertexAttribArray(loc);
    gl.disable(gl.BLEND); gl.depthMask(true);
    gl.useProgram(state.program);
}

/** Why particles are not drawn on this canvas, or null when they are (or have not been needed yet). */
export function webGL3DParticleNote(canvas: HTMLCanvasElement): string | null {
    return (canvas as Canvas3D).__vde3D?.particleNote ?? null;
}
/** Draws both the visible frame and a retained offscreen id frame for synchronous picking. */
export function emitWebGL3D(canvas: HTMLCanvasElement, frame: Frame3D, dpr = 1): boolean {
    const cached = canvas as Canvas3D;
    cached.__vde3DLastFrame = { frame, dpr };
    if (cached.__vde3D === undefined) cached.__vde3D = init(canvas);
    const state = cached.__vde3D;
    if (!state) return false;
    state.redraw = () => { emitWebGL3D(canvas, frame, dpr); };
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    if (!sizePickTarget(state, width, height)) return false;
    const { gl } = state;
    const hasShadow = renderDirectionalShadow(state, frame);
    gl.viewport(0, 0, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const clear = fogBackground3D(CLEAR_COLOR_3D, frame.fog);
    gl.clearColor(clear[0], clear[1], clear[2], clear[3]); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawFrame(state, frame, false, hasShadow);
    drawParticles(state, frame);
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.pickFramebuffer);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawFrame(state, frame, true, false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
}

/** Eagerly releases every resource owned by a 3D canvas. Safe to call more than once. */
export function disposeWebGL3D(canvas: HTMLCanvasElement): void {
    const owned = canvas as Canvas3D, state = owned.__vde3D;
    if (!state) { owned.__vde3D = undefined; return; }
    state.disposed = true; state.uploads.length = 0;
    const { gl } = state;
    for (const texture of state.textures.values()) gl.deleteTexture(texture);
    for (const entry of state.environmentTextures.values()) gl.deleteTexture(entry.texture);
    gl.deleteTexture(state.pickTexture); gl.deleteRenderbuffer(state.pickDepth);
    gl.deleteFramebuffer(state.pickFramebuffer);
    if (state.clusterTexture) gl.deleteTexture(state.clusterTexture);
    gl.deleteTexture(state.shadowTexture); gl.deleteRenderbuffer(state.shadowDepth);
    gl.deleteFramebuffer(state.shadowFramebuffer);
    for (const buffer of [state.position, state.normal, state.uv, state.uv1, state.indices, state.joints, state.weights]) gl.deleteBuffer(buffer);
    gl.deleteProgram(state.program); gl.deleteProgram(state.shadowProgram);
    if (state.particles) {
        gl.deleteProgram(state.particles.program); gl.deleteBuffer(state.particles.vertices); gl.deleteBuffer(state.particles.indices);
    }
    owned.__vde3D = undefined; owned.__vde3DLastFrame = undefined;
}

/** Invalidates source-backed textures so hot reload has the same result as a clean renderer. */
export function invalidateWebGL3DSource(canvas: HTMLCanvasElement, sourceOrAssetId: string): void {
    const state = (canvas as Canvas3D).__vde3D;
    if (!state) return;
    state.textureSizes.delete(sourceOrAssetId);
    for (const [key, texture] of [...state.textures]) if (key.startsWith(`${sourceOrAssetId}\n`)) {
        state.gl.deleteTexture(texture); state.textures.delete(key); state.readyTextures.delete(key);
    }
    for (const [key, environment] of [...state.environmentTextures]) if (key.startsWith(`${sourceOrAssetId}:`)) {
        state.gl.deleteTexture(environment.texture); state.environmentTextures.delete(key);
    }
}

/** Rebuilds programs and all GPU caches from the retained frame; used by shader/material hot reload. */
export function reloadWebGL3D(canvas: HTMLCanvasElement): boolean {
    const owned = canvas as Canvas3D, last = owned.__vde3DLastFrame;
    disposeWebGL3D(canvas); owned.__vde3DLastFrame = last;
    return last ? emitWebGL3D(canvas, last.frame, last.dpr) : true;
}

export function webGL3DCapabilities(canvas: HTMLCanvasElement): {
    available: boolean; floatTextures: boolean; floatLinear: boolean; uintIndices: boolean; maxTextureSize: number;
} {
    const gl = (canvas as Canvas3D).__vde3D?.gl ?? canvas.getContext("webgl");
    if (!gl) return { available: false, floatTextures: false, floatLinear: false, uintIndices: false, maxTextureSize: 0 };
    return { available: true, floatTextures: !!gl.getExtension("OES_texture_float"),
        floatLinear: !!gl.getExtension("OES_texture_float_linear"),
        uintIndices: !!gl.getExtension("OES_element_index_uint"), maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number };
}

/** Live lighting path and, for the fallback, why per-pixel shading was not used. */
export function webGL3DLighting(canvas: HTMLCanvasElement): { mode: LightingMode3D; note: string | null;
    pointLightsPerPixel: number; cells: number; overflowCells: number; maxCellLights: number } | null {
    const state = (canvas as Canvas3D).__vde3D;
    if (!state) return null;
    const clusters = state.clusters;
    return { mode: state.lightingMode, note: state.lightingNote,
        pointLightsPerPixel: state.lightingMode === "clustered" ? MAX_CLUSTER_LIGHTS_3D : state.lightBudget,
        cells: clusters?.height ?? 0, overflowCells: clusters?.overflowCells ?? 0, maxCellLights: clusters?.maxCellLights ?? 0 };
}

/** Lights per draw the live program was compiled with, or null before the first successful init. */
export function webGL3DLightBudget(canvas: HTMLCanvasElement): number | null {
    return (canvas as Canvas3D).__vde3D?.lightBudget ?? null;
}

export function pickWebGL3D(canvas: HTMLCanvasElement, cssX: number, cssY: number, dpr = 1): string | null {
    const state = (canvas as Canvas3D).__vde3D;
    if (!state) return null;
    const x = Math.floor(cssX * dpr), y = state.height - 1 - Math.floor(cssY * dpr);
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
    const pixel = new Uint8Array(4), { gl } = state;
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.pickFramebuffer);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return state.pickIds[pickIndex3D(pixel)] ?? null;
}
