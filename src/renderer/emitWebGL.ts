/**
 * @module emitWebGL
 * @description GPU backend for the render model — the third dumb transcriber, and the consumer
 * that makes `Tessellate` worth having.
 *
 * SVG and Canvas both take outlines and rasterize them for us. A GPU takes triangles, so this
 * backend does one extra step the others do not: every filled shape becomes rings (the same
 * `ShapeToPath`/`PathBoolean` conversions picking and booleans already use), those rings are
 * triangulated once, and the triangles are drawn. The arithmetic still lives in the model and in
 * `core/geometry`; this file uploads buffers and issues draw calls.
 *
 * Why bother, when Canvas already works: at design-software scale the per-frame cost of
 * rasterizing thousands of outlines on the CPU is the thing that makes a canvas feel heavy, and
 * triangles are the form that cost disappears in. This is the seam that makes that possible, not
 * the finished optimisation — see the gaps below.
 *
 * STROKES are now geometry too. `geometry/StrokeOutline` turns a border into rings the same way
 * a fill already was, so this backend draws both, with the document's own joins and caps — and
 * the selection frame, which is an outline item and used to be skipped entirely, now appears.
 * The offsetting happens in LOCAL space and the rings are transformed afterwards, because that
 * is where SVG and Canvas apply `stroke-width` too: a node scaled 2x has a border twice as thick
 * on all three backends rather than on two of them.
 *
 * CURVES are cut ADAPTIVELY, to how large the shape is on screen rather than to a fixed number of
 * world units. This backend is the only one that had to care: SVG and Canvas hand an outline to a
 * rasterizer that already knows the resolution, while a GPU must be told how many vertices to
 * take. See `displayTolerance` — the budget is a fifth of a device pixel, quantised to powers of
 * two so a zoom does not re-cut every curve on every frame and make silhouettes shimmer.
 *
 * WHAT IT NOW DRAWS that it once could not, and how each stopped being a gap:
 *   - IMAGES and TEXT. The heightfield gave this backend a texture path, and both are that same
 *     path with a bitmap in it rather than a surface. Text is rasterised through `TextRaster` —
 *     the function the Canvas backend also calls — rather than through a glyph atlas, so the two
 *     cannot break a line in different places. An atlas would be a second typesetter.
 *   - DASHES, cut as GEOMETRY by `geometry/DashPath` before the border is outlined, because a
 *     dash is a piece of the path rather than a property of the ink. The rectangle tool's drag
 *     PREVIEW is the one thing in the app that carries a pattern today, and it used to come out
 *     solid here while the other two backends dashed it.
 *
 *   - EFFECTS. `shadow` and `blur` are per-fragment work over a rendered IMAGE, so this backend
 *     had to grow what it never had: render targets. It keeps a ping-pong pair for the separable
 *     gaussian and a third for a shadow, which is a blurred copy that must land UNDER the item it
 *     belongs to. `effectPlan` replays the CTM's scale onto the magnitudes, the same arithmetic
 *     exception `emitCanvas` makes, because an effect is measured in device space.
 *
 * THIS PARAGRAPH REPLACES ONE THAT SAID EFFECTS WERE IGNORED, and it was wrong for as long as it
 * took somebody to read it — the sentence was written when it was true and nothing brought it back
 * when the render targets landed. A header claiming an ABSENCE is the only kind that rots without
 * anything noticing: the claim and the code share a file, so no timestamp can compare them, and
 * the lint gate only ever asked whether a header EXISTS. A sweep of all 151 headers found this to
 * be the only one, and `npm run header-claims` is what found it — advisory, because the judgement
 * is a read. A sentence describing an ABSENCE has a shelf life; write it expecting to come back.
 *
 * The app still offers this backend as a preview, because a backend that quietly drops content is
 * worse than one that admits what it cannot do — but the effects gap is no longer why.
 */

import { DisplayList, DrawItem, PaintGradient, Shape, layerTransition } from "./RenderModel";
import { gaussianKernel, blurPlan, GAUSSIAN_MAX_RADIUS } from "./Gaussian";
import { Mat2D, translation, multiply, invert, IDENTITY } from "../core/geometry/Matrix";
import { Ring, commandsToRings } from "../core/geometry/PathBoolean";
import { subdivideTriangles, triangulate } from "../core/geometry/Tessellate";
import { strokeOutline } from "../core/geometry/StrokeOutline";
import { dashSubpaths, parseDashArray } from "../core/geometry/DashPath";
import { resolveRings } from "../core/geometry/Resolve";
import { depthToClipZ } from "../core/document/Depth";
import { ReadonlyMesh, heightRange, surfaceNormal, warpHeight } from "../core/document/Mesh";
import { marchOccluded } from "../core/geometry/RayMarch";
import { Light, normalize } from "../core/document/Light";
import { ellipseCommands, rectCommands, transformCommands } from "../core/geometry/ShapeToPath";
import { PathCommand } from "../core/document/Node";
import { FLATTEN_TOLERANCE, displayTolerance, localScaleOf } from "../core/geometry/ShapeHit";
import { imageGeneration, resolveImage, resolveSurface, naturalSize } from "./ImageCache";
import { nineSliceRects } from "../core/geometry/NineSlice";
import { TextShape, drawTextInto, textRasterKey, textRasterScale } from "./TextRaster";

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec3 a_normal;
attribute vec2 a_local;
uniform mat3 u_view;
uniform float u_z;
varying vec3 v_normal;
varying vec2 v_local;
void main() {
    vec3 p = u_view * vec3(a_pos, 1.0);
    // The normal is passed through UNTRANSFORMED and UN-NORMALISED. Untransformed because it is a
    // direction in the document's own axes and the view matrix is a pan and a zoom — neither of
    // which turns a surface, so transforming it would only make the lighting swim as you scrolled.
    // Un-normalised because this varying is about to be interpolated, and only the raw vector is
    // affine across a cell; normalising here would bake the faceting back in before the fragment
    // shader ever saw it.
    v_normal = a_normal;
    // The vertex's position in the shape's OWN units, carried so the fragment stage can march
    // the heightfield from where it actually is. This is what replaced a per-vertex shadow term:
    // interpolating a POSITION is exact (an affine map across a triangle), where interpolating
    // the discontinuous answer computed at three corners was not.
    v_local = a_local;
    // z comes from the node's DEPTH, not from the draw order — that is what makes the depth
    // buffer do the deciding rather than the sequence of draw calls.
    gl_Position = vec4(p.xy, u_z, 1.0);
}`;

/**
 * Taps the blur shader's loop is compiled for — the FULL span at the widest kernel.
 *
 * IT MUST BE A COMPILE-TIME CONSTANT. GLSL ES 1.00 refuses `for (int i = 0; i < u_radius; i++)`
 * outright — "Loop index cannot be compared with non-constant expression" — so the loop runs to a
 * constant and BREAKS on the uniform. Measured in this renderer rather than assumed; the same
 * constraint is why Material Maker's blur loops a fixed -50..50 regardless of its sigma.
 */
const BLUR_MAX_TAPS = GAUSSIAN_MAX_RADIUS * 2 + 1;

/** A full-screen triangle pair in clip space; `v_uv` is the same corner in texture space. */
const BLUR_VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/**
 * One axis of a separable gaussian.
 *
 * PREMULTIPLIED THROUGHOUT. Blurring straight (non-premultiplied) RGBA mixes the colour of fully
 * transparent texels into its neighbours, and a transparent texel's colour is usually black — so
 * every soft edge gains a dark fringe that looks like a bad shadow rather than a bad blend. The
 * target is drawn premultiplied and composited with `ONE, ONE_MINUS_SRC_ALPHA` to match.
 *
 * The weights arrive already normalised, so this sums them without dividing: the division happened
 * once on the CPU rather than per fragment.
 */
const BLUR_FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform vec2 u_dir;
uniform int u_radius;
uniform float u_weights[${BLUR_MAX_TAPS}];
varying vec2 v_uv;
void main() {
    vec4 sum = vec4(0.0);
    for (int i = 0; i < ${BLUR_MAX_TAPS}; i++) {
        if (i > 2 * u_radius) break;
        float off = float(i - u_radius);
        sum += texture2D(u_tex, v_uv + u_dir * u_texel * off) * u_weights[i];
    }
    gl_FragColor = sum;
}`;

/**
 * Draws a finished target onto the screen, optionally offset and tinted.
 *
 * This is what turns a blurred copy into a SHADOW: the alpha is kept, the colour is replaced by
 * the shadow's, and the whole thing is shifted. Tinting in the same pass that composites means the
 * blurred image is read once rather than copied into a third texture first.
 *
 * PREMULTIPLIED. The target was drawn into a transparent-cleared framebuffer with ordinary
 * src-alpha blending, which leaves its RGB already multiplied by its own alpha — so it composites
 * with `ONE, ONE_MINUS_SRC_ALPHA`, and the tint multiplies by alpha here to stay in that space.
 */
const COMPOSITE_FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec4 u_tint;
uniform float u_useTint;
uniform vec2 u_offset;
// A whole-layer FADE, 1 for everything but an opacity group (schema 32). The target is
// PREMULTIPLIED, so scaling the whole vec4 by one number is exactly what fading it means — which
// is the reason a group can be composited at all rather than needing its alpha folded into parts.
uniform float u_fade;
varying vec2 v_uv;
void main() {
    // SUBTRACTED, not added. Moving the sample point back is what moves the IMAGE forward — a
    // shadow with dx of +4 must land four pixels to the right, and adding here would put it four
    // to the left, which reads as a light source on the wrong side rather than a sign error.
    vec4 src = texture2D(u_tex, v_uv - u_offset);
    // A tinted draw keeps only the COVERAGE. Reusing the source's colour would give a shadow the
    // shape's own hue, which looks like a badly-offset duplicate rather than a shadow.
    vec4 tinted = vec4(u_tint.rgb * src.a * u_tint.a, src.a * u_tint.a);
    gl_FragColor = mix(src, tinted, u_useTint) * u_fade;
}`;

/**
 * Stops this backend can carry, and the reason it is not `GRADIENT_MAX_STOPS`.
 *
 * A shader holds its ramp in uniform ARRAYS, and WebGL 1 only guarantees 16 fragment uniform
 * vectors — so the document's cap of 64 would be a promise the hardware need not keep. Sixteen
 * covers the corpus with room to spare: 2,860 of 2,969 measured gradients have exactly two stops
 * and the most any file uses is 11. A ramp with more falls back to `flat`, like every other thing
 * this backend cannot draw, rather than being cut short — a truncated ramp looks like a design
 * decision, and a flat one looks like the gap it is.
 */
export const GPU_MAX_STOPS = 16;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 v_normal;
varying vec2 v_local;
uniform vec4 u_color;
uniform float u_ambient;
uniform int u_lightCount;
uniform vec3 u_lightDir[4];
uniform vec3 u_lightColor[4];
uniform sampler2D u_heightTex;
uniform vec2 u_box;
uniform float u_hMin;
uniform float u_hMax;
uniform float u_hasHeight;
uniform sampler2D u_image;
uniform vec4 u_imgRect;
// The SOURCE sub-rectangle, already normalised into texture coordinates: xy is its origin and zw
// its size. Whole-image draws pass 0,0,1,1, so the arithmetic below is one multiply-add that
// changes nothing for them rather than a branch that has to be kept in step with the other case.
uniform vec4 u_imgUV;
uniform float u_hasImage;
// A GRADIENT (schema 56). 0 = none, 1 = linear, 2 = radial.
uniform int u_gradKind;
// LOCAL space -> the gradient's own space, inverted on the CPU. objectBoundingBox is already
// folded in, so this shader knows nothing about units — the same mapping the canvas handles use,
// undone. (No backticks in here: this is inside a template literal.)
uniform mat3 u_gradInv;
// linear: x1, y1, x2, y2. radial: cx, cy, r, unused.
uniform vec4 u_gradAxis;
uniform vec2 u_gradFocus;
uniform int u_gradStops;
uniform float u_gradOffset[${GPU_MAX_STOPS}];
uniform vec4 u_gradColor[${GPU_MAX_STOPS}];

// The heightfield at a point in LOCAL units. The texture holds 16 bits packed across two
// channels; these constants are that packing undone, written so every intermediate stays near 1
// rather than reaching 65535 — mediump is only guaranteed to ±16384, so the obvious
// naive 'r * 255.0 * 256.0' decode overflows it on exactly the hardware that needs the care.
float sampleHeight(vec2 p) {
    vec4 t = texture2D(u_heightTex, clamp(p / u_box, 0.0, 1.0));
    return u_hMin + (t.r * 0.99610895 + t.g * 0.0038910506) * (u_hMax - u_hMin);
}

// A TRANSCRIPTION of geometry/RayMarch.marchOccluded, which is where this is specified and
// tested. Same steps, same bound, same strict comparison — a shader cannot call TypeScript, so
// the arithmetic is stated twice and only one of the two can be checked. Kept line-for-line
// alongside it for that reason, exactly as this shader's Lambert term mirrors lambert().
float visibility(vec2 p) {
    if (u_hasHeight < 0.5 || u_lightCount == 0) return 1.0;
    vec3 toLight = -u_lightDir[0];
    if (toLight.z <= 0.0) return 1.0;
    float start = sampleHeight(p);
    if (start >= u_hMax) return 1.0;
    float dist = (u_hMax - start) / toLight.z;
    for (int i = 1; i <= 16; i++) {
        float t = dist * float(i) / 16.0;
        if (sampleHeight(p + toLight.xy * t) > start + toLight.z * t) return 0.0;
    }
    return 1.0;
}

/**
 * Where along the ramp this point falls, 0..1.
 *
 * The RADIAL case is SVG's focal formula, not a plain distance: the colour at a point is how far
 * along the ray FROM THE FOCUS through that point it sits, as a fraction of where that ray leaves
 * the end circle. Solving |f + s(p - f) - c|^2 = r^2 for the positive root gives that crossing, and
 * t is its reciprocal. With the focus at the centre it collapses to |p - c| / r, which is why a
 * fixture that never moves the focus cannot tell the two apart.
 *
 * PADDED at both ends, which is SVG's default spread and the only one any measured file states.
 */
float rampT(vec2 g) {
    if (u_gradKind == 1) {
        vec2 d = u_gradAxis.zw - u_gradAxis.xy;
        float len2 = dot(d, d);
        return len2 > 0.0 ? dot(g - u_gradAxis.xy, d) / len2 : 0.0;
    }
    vec2 d = g - u_gradFocus;
    float a = dot(d, d);
    float r = u_gradAxis.z;
    if (a <= 0.0 || r <= 0.0) return 1.0;
    vec2 fc = u_gradFocus - u_gradAxis.xy;
    float b = dot(d, fc);
    float disc = b * b - a * (dot(fc, fc) - r * r);
    float sHit = (-b + sqrt(max(disc, 0.0))) / a;
    return sHit > 0.0 ? 1.0 / sHit : 1.0;
}

/**
 * The ramp's colour at a point in LOCAL units.
 *
 * THE LOOP IS BOUNDED BY A CONSTANT and leaves early on the real stop count: GLSL ES 1.00 cannot
 * size a loop from a uniform, so i < u_gradStops does not compile at all. The break is what makes
 * the constant bound cost nothing for the two-stop ramp that is 96% of the corpus.
 */
vec4 rampColor(vec2 p) {
    float t = clamp(rampT((u_gradInv * vec3(p, 1.0)).xy), 0.0, 1.0);
    vec4 c = u_gradColor[0];
    for (int i = 1; i < ${GPU_MAX_STOPS}; i++) {
        if (i >= u_gradStops) break;
        float a0 = u_gradOffset[i - 1];
        float a1 = u_gradOffset[i];
        if (t <= a0) break;
        c = u_gradColor[i];
        if (t <= a1) {
            // A ZERO SPAN is two stops at one offset — a hard colour break, not a division. The
            // far side wins, which is what makes the break visible at all.
            if (a1 > a0) c = mix(u_gradColor[i - 1], u_gradColor[i], (t - a0) / (a1 - a0));
            break;
        }
    }
    return c;
}

void main() {
    // PER FRAGMENT, which is the whole reason the vertex stage hands over a raw vector. What
    // arrives here is the interpolation of three un-normalised normals, and inside one cell of the
    // mesh that interpolation is exact — so normalising it now yields the surface's own normal at
    // this pixel rather than a blend of three corner normals that only agrees at the corners.
    vec3 n = normalize(v_normal);
    // PER FRAGMENT. The occlusion is recomputed at this pixel rather than blended from three
    // corner answers, which is what makes the shadow's edge an edge: it is discontinuous, and no
    // amount of interpolation between vertices produces a discontinuity.
    float vis = visibility(v_local);
    // AMBIENT is a floor, not a light: it is what a surface shows when nothing reaches it, and
    // without it an unlit face goes to pure black, which is never what a designer means.
    vec3 lit = vec3(u_ambient);
    for (int i = 0; i < 4; i++) {
        if (i >= u_lightCount) break;
        // LAMBERT, clamped at zero. A face pointing away receives no light rather than negative
        // light — unclamped, a second light could make a shape DARKER, which is the least
        // explicable thing a lighting model can do.
        float d = max(dot(n, -u_lightDir[i]), 0.0);
        // CAST occlusion applies to the KEY light only. The march is one attribute per vertex, so
        // four lights would be four attributes and four CPU marches per frame; the first light is
        // the one the drop shadow already privileges, so the scene stays consistent about which
        // light throws shadows.
        lit += u_lightColor[i] * d * (i == 0 ? vis : 1.0);
    }
    // An IMAGE supplies the colour; everything else about the fragment is unchanged, so a picture
    // is lit and shadowed by exactly the arithmetic a fill is. The rect is a uniform rather than a
    // second attribute because the local position is already interpolated for the heightfield.
    vec4 base = u_color;
    // A GRADIENT supplies the colour, and u_color then carries only the item's OPACITY — the
    // same arrangement an image uses, and for the same reason: neither has a fill colour of its
    // own, and folding the opacity in twice would darken every translucent gradient.
    if (u_gradKind > 0) {
        base = rampColor(v_local);
        base.a *= u_color.a;
    }
    if (u_hasImage > 0.5) {
        vec2 uv01 = (v_local - u_imgRect.xy) / u_imgRect.zw;
        base = texture2D(u_image, u_imgUV.xy + uv01 * u_imgUV.zw);
        // The image's own alpha, times the item's opacity — which is what u_color.a carries for an
        // image item, since an image has no fill colour of its own.
        base.a *= u_color.a;
    }
    // The colour is MODULATED, never replaced: a lit red shape is a darker or brighter red, and a
    // model that added light instead would wash every hue toward the light's own.
    gl_FragColor = vec4(base.rgb * lit, base.a);
}`;

/**
 * Everything a frame needs, built once per canvas and cached on it.
 *
 * EXPORTED because two documented functions traffic in it — `initGL` returns it and `setLighting`
 * takes it — and a documented signature whose type cannot be named is a contract nobody outside
 * this file can hold. It was private until the API pin tried to state the contract and could not.
 */
/**
 * One offscreen colour target: a texture and the framebuffer that draws into it.
 *
 * Two are needed, not one. A separable blur reads the whole of one image while writing another, so
 * the horizontal pass cannot write into what it is still sampling — the passes PING-PONG between a
 * pair. Sampling and writing the same texture is undefined in GL and, worse, usually looks almost
 * right.
 */
export interface BlurTarget {
    framebuffer: WebGLFramebuffer;
    texture: WebGLTexture;
    width: number;
    height: number;
}

/** The second program: a full-screen pass that spends the weights `Gaussian` computed. */
export interface BlurState {
    program: WebGLProgram;
    /** A clip-space quad. The blur never uses the scene's geometry — it filters an IMAGE. */
    quad: WebGLBuffer;
    posLoc: number;
    texLoc: WebGLUniformLocation | null;
    texelLoc: WebGLUniformLocation | null;
    dirLoc: WebGLUniformLocation | null;
    radiusLoc: WebGLUniformLocation | null;
    weightsLoc: WebGLUniformLocation | null;
    /** The composite program — the same quad, drawn with an optional tint and offset. */
    composite: WebGLProgram;
    compositePosLoc: number;
    compositeTexLoc: WebGLUniformLocation | null;
    compositeTintLoc: WebGLUniformLocation | null;
    compositeUseTintLoc: WebGLUniformLocation | null;
    compositeOffsetLoc: WebGLUniformLocation | null;
    compositeFadeLoc: WebGLUniformLocation | null;
    /**
     * THREE targets, not two.
     *
     * Two would do for a blur alone — a separable pass ping-pongs between a pair. A SHADOW needs a
     * third, because the shadow is a blurred copy of the item that must be drawn UNDER the item
     * which is still needed sharp. Blurring in place would consume the very thing being shadowed.
     */
    targets: [BlurTarget | null, BlurTarget | null, BlurTarget | null];
}

export interface GLState {
    gl: WebGLRenderingContext;
    /**
     * One render target per OPEN opacity-group layer (schema 32), indexed by nesting depth.
     *
     * SEPARATE from the blur's three scratch targets, because an item INSIDE a group may have an
     * effect: the detour would then be filtering into the very target the group is being drawn on.
     * Kept across frames and grown on demand, like every other target here — a document with three
     * levels of translucent group allocates three and reuses them.
     */
    layerTargets: (BlurTarget | null)[];
    program: WebGLProgram;
    buffer: WebGLBuffer;
    normalBuffer: WebGLBuffer;
    localBuffer: WebGLBuffer;
    heightTex: WebGLTexture;
    imageTex: WebGLTexture;
    imgUVLoc: WebGLUniformLocation | null;
    /** What currently lives in `imageTex` — an image's href+generation, or a text raster's key. */
    imageKey: string | null;
    /**
     * The effects pass, or null when it could not be built.
     *
     * NULL IS A REAL ANSWER: a context that cannot link a second program or allocate a render
     * target still draws every shape correctly, just without shadow or blur — which is exactly
     * what this backend did before. Failing the whole frame over an effect would be worse.
     *
     * BUILT EAGERLY, and that is a live cost rather than a dormant one: `initGL` runs on the first
     * frame, so the second program is compiled and linked for every context even though nothing
     * spends it until compositing lands. One shader link per canvas is worth not carrying a lazy
     * path — but it is a cost being paid now, not later, and `blurPass`/`ensureTarget` are the
     * parts that are genuinely uncalled.
     */
    blur: BlurState | null;
    posLoc: number;
    viewLoc: WebGLUniformLocation | null;
    colorLoc: WebGLUniformLocation | null;
    zLoc: WebGLUniformLocation | null;
    normalLoc: number;
    localLoc: number;
    ambientLoc: WebGLUniformLocation | null;
    lightCountLoc: WebGLUniformLocation | null;
    lightDirLoc: WebGLUniformLocation | null;
    lightColorLoc: WebGLUniformLocation | null;
    heightTexLoc: WebGLUniformLocation | null;
    boxLoc: WebGLUniformLocation | null;
    hMinLoc: WebGLUniformLocation | null;
    hMaxLoc: WebGLUniformLocation | null;
    hasHeightLoc: WebGLUniformLocation | null;
    imageLoc: WebGLUniformLocation | null;
    imgRectLoc: WebGLUniformLocation | null;
    hasImageLoc: WebGLUniformLocation | null;
    /** Gradient uniforms (schema 56) — a ramp walked per fragment. */
    gradKindLoc: WebGLUniformLocation | null;
    gradInvLoc: WebGLUniformLocation | null;
    gradAxisLoc: WebGLUniformLocation | null;
    gradFocusLoc: WebGLUniformLocation | null;
    gradStopsLoc: WebGLUniformLocation | null;
    gradOffsetLoc: WebGLUniformLocation | null;
    gradColorLoc: WebGLUniformLocation | null;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    // A shader that fails to compile is a programming error, not a document error — but this is a
    // renderer, so it reports null and lets the caller fall back rather than throwing into a frame.
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/** Build the program and buffer, or null when WebGL is unavailable (a headless test, an old GPU). */
/**
 * The blur program and its quad, or null if this context will not have it.
 *
 * Returning null rather than failing `initGL` is deliberate: every shape still draws, and the
 * backend loses only what it never had.
 */
export function initBlur(gl: WebGLRenderingContext): BlurState | null {
    const vs = compile(gl, gl.VERTEX_SHADER, BLUR_VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, BLUR_FRAGMENT_SHADER);
    const cfs = compile(gl, gl.FRAGMENT_SHADER, COMPOSITE_FRAGMENT_SHADER);
    const program = gl.createProgram();
    const composite = gl.createProgram();
    const quad = gl.createBuffer();
    if (!vs || !fs || !cfs || !program || !composite || !quad) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    // The composite shares the blur's vertex shader — both draw the same full-screen quad, and
    // one source for that means the two cannot disagree about which corner is which texel.
    gl.attachShader(composite, vs);
    gl.attachShader(composite, cfs);
    gl.linkProgram(composite);
    if (!gl.getProgramParameter(composite, gl.LINK_STATUS)) return null;
    // TWO TRIANGLES covering clip space. `v_uv` is derived from the position rather than sent as a
    // second attribute, so the quad is four numbers per corner and nothing can disagree about
    // which corner maps to which texel.
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    // UNBOUND before returning. An init function that leaves a global binding behind is safe only
    // while its one caller happens to rebind before drawing — which `emitWebGL` does, twenty lines
    // later, by coincidence rather than by contract. Left as it was, moving that rebind or calling
    // `initGL` from anywhere else would draw this quad's two triangles as scene geometry.
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return {
        program, quad,
        posLoc: gl.getAttribLocation(program, "a_pos"),
        texLoc: gl.getUniformLocation(program, "u_tex"),
        texelLoc: gl.getUniformLocation(program, "u_texel"),
        dirLoc: gl.getUniformLocation(program, "u_dir"),
        radiusLoc: gl.getUniformLocation(program, "u_radius"),
        // AN ARRAY UNIFORM IS ADDRESSED BY ITS FIRST ELEMENT. `getUniformLocation(p, "u_weights")`
        // returns null on some drivers and the whole kernel would silently upload nothing.
        weightsLoc: gl.getUniformLocation(program, "u_weights[0]"),
        composite,
        compositePosLoc: gl.getAttribLocation(composite, "a_pos"),
        compositeTexLoc: gl.getUniformLocation(composite, "u_tex"),
        compositeTintLoc: gl.getUniformLocation(composite, "u_tint"),
        compositeUseTintLoc: gl.getUniformLocation(composite, "u_useTint"),
        compositeOffsetLoc: gl.getUniformLocation(composite, "u_offset"),
        compositeFadeLoc: gl.getUniformLocation(composite, "u_fade"),
        targets: [null, null, null]
    };
}

/**
 * `from` redrawn into `into` at whatever size `into` is — a resample.
 *
 * THIS IS HOW A WIDE BLUR BECOMES AFFORDABLE. `blurPlan` says to halve the resolution N times
 * before blurring, and each halving is one of these. The composite program already samples `v_uv`
 * across the WHOLE source texture, so drawing its quad into a smaller target IS the downscale; the
 * LINEAR filter does the averaging.
 *
 * REPLACE, NOT BLEND. The destination is about to be overwritten entirely, and blending a
 * premultiplied image onto stale contents would leave the previous item's ghost in the margins.
 */
export function resampleTo(
    gl: WebGLRenderingContext, blur: BlurState, from: BlurTarget, into: BlurTarget
): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
    gl.viewport(0, 0, into.width, into.height);
    gl.useProgram(blur.composite);
    gl.bindBuffer(gl.ARRAY_BUFFER, blur.quad);
    gl.enableVertexAttribArray(blur.compositePosLoc);
    gl.vertexAttribPointer(blur.compositePosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.texture);
    gl.uniform1i(blur.compositeTexLoc, 0);
    gl.uniform1f(blur.compositeUseTintLoc, 0);
    gl.uniform2f(blur.compositeOffsetLoc, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * A finished target drawn onto whatever framebuffer is bound.
 *
 * `offsetX`/`offsetY` are in DEVICE PIXELS **in the document's axes — y grows DOWNWARD**, like
 * `Shadow.dy` and like every other coordinate in this engine. They move the TEXTURE READ rather
 * than the quad, so the quad stays exactly the screen and nothing has to be clipped.
 *
 * THE Y IS NEGATED HERE because a GL framebuffer's y grows UPWARD. Measured, not reasoned: a raw
 * `+4` moved a probe texel from row 8 to row 12 of `readPixels`, whose row 0 is the BOTTOM — so a
 * shadow with `dy: +4` would have risen four pixels instead of falling four. That is a light
 * source on the wrong side of the scene, which reads as a design choice rather than a sign error.
 */
export function compositeTarget(
    gl: WebGLRenderingContext, blur: BlurState, from: BlurTarget,
    offsetX: number, offsetY: number, tint: [number, number, number, number] | null,
    fade: number = 1
): void {
    gl.useProgram(blur.composite);
    gl.bindBuffer(gl.ARRAY_BUFFER, blur.quad);
    gl.enableVertexAttribArray(blur.compositePosLoc);
    gl.vertexAttribPointer(blur.compositePosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.texture);
    gl.uniform1i(blur.compositeTexLoc, 0);
    gl.uniform4f(blur.compositeTintLoc, tint ? tint[0] : 0, tint ? tint[1] : 0,
        tint ? tint[2] : 0, tint ? tint[3] : 1);
    gl.uniform1f(blur.compositeUseTintLoc, tint ? 1 : 0);
    // DEVICE pixels to UV, using the target's own size — the target is grown-not-shrunk, so it is
    // often larger than the canvas and dividing by the canvas would drift as the window resized.
    gl.uniform2f(blur.compositeOffsetLoc, offsetX / from.width, -offsetY / from.height);
    gl.uniform1f(blur.compositeFadeLoc, fade);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    // PREMULTIPLIED source: the target's RGB is already scaled by its alpha.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
}

/**
 * A render target of EXACTLY `width` x `height`, reusing the one already there when it matches.
 *
 * EXACT, NOT GROWN. A target larger than the canvas would be a quiet scaling bug: the composite
 * samples `v_uv` across the whole texture, so content drawn into a corner of an oversized target
 * comes back stretched over the screen. Reallocating on resize is rare and cheap; being subtly the
 * wrong size every frame after a window narrows is neither.
 */
export function ensureTarget(
    gl: WebGLRenderingContext, held: BlurTarget | null, width: number, height: number
): BlurTarget | null {
    if (held && held.width === width && held.height === height) return held;
    const w = width, h = height;
    if (held) { gl.deleteFramebuffer(held.framebuffer); gl.deleteTexture(held.texture); }
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // LINEAR so a half-texel offset does not alias, CLAMP so a tap past the edge repeats the edge
    // rather than wrapping the far side of the image into the blur.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture); return null; }
    return { framebuffer, texture, width: w, height: h };
}

/**
 * One axis of the blur: `from`'s texture filtered into `into`'s framebuffer.
 *
 * `sigma` is in DEVICE PIXELS — the caller has already multiplied the world-unit `blur` by `z·dpr`,
 * the same one arithmetic exception `emitCanvas` makes for `ctx.filter`.
 *
 * Returns false when the kernel is the identity, so a caller can skip the pass entirely rather than
 * spend a full-screen draw copying an image to itself.
 */
export function blurPass(
    gl: WebGLRenderingContext, blur: BlurState, from: BlurTarget, into: BlurTarget,
    sigma: number, horizontal: boolean
): boolean {
    const kernel = gaussianKernel(sigma);
    if (kernel.radius === 0) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
    gl.viewport(0, 0, into.width, into.height);
    gl.useProgram(blur.program);
    gl.disable(gl.DEPTH_TEST);
    // The pass REPLACES rather than blends: it is filtering an image, not compositing one.
    gl.disable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, blur.quad);
    gl.enableVertexAttribArray(blur.posLoc);
    gl.vertexAttribPointer(blur.posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.texture);
    gl.uniform1i(blur.texLoc, 0);
    gl.uniform2f(blur.texelLoc, 1 / from.width, 1 / from.height);
    gl.uniform2f(blur.dirLoc, horizontal ? 1 : 0, horizontal ? 0 : 1);
    gl.uniform1i(blur.radiusLoc, kernel.radius);
    // PADDED to the compiled span. The shader breaks at `2*radius`, so the tail is never read —
    // but uploading a short array leaves whatever the last frame put there in the slots past it,
    // which a driver that ignores the break would then sample.
    const padded = new Float32Array(BLUR_MAX_TAPS);
    padded.set(kernel.weights);
    gl.uniform1fv(blur.weightsLoc, padded);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
}

/** What an item's effects come to in DEVICE pixels, or null when it needs no offscreen pass. */
export interface EffectPlan {
    /** Sigma for the shape's own blur, 0 when it has none. */
    blurSigma: number;
    /** The shadow, already in device pixels, or null. */
    shadow: { dx: number; dy: number; sigma: number; color: [number, number, number, number] } | null;
}

/**
 * The effects an item needs, with every world-unit value already scaled.
 *
 * `scale` is `zoom * dpr` — the SAME one arithmetic exception `emitCanvas` makes for `shadow*` and
 * `ctx.filter`, and for the same reason: effect magnitudes are device-space, so the backend that
 * owns the CTM has to replay its scale onto them.
 *
 * Null means "draw this the ordinary way". A shadow whose colour will not parse is dropped rather
 * than drawn black — an invented colour looks deliberate.
 */
export function effectPlan(paint: DrawItem["paint"], scale: number): EffectPlan | null {
    const blurSigma = paint.blur !== null && paint.blur > 0 ? paint.blur * scale : 0;
    let shadow: EffectPlan["shadow"] = null;
    if (paint.shadow !== null) {
        const color = parseColor(paint.shadow.color);
        if (color) {
            shadow = {
                dx: paint.shadow.dx * scale,
                dy: paint.shadow.dy * scale,
                sigma: Math.max(0, paint.shadow.blur) * scale,
                color
            };
        }
    }
    return blurSigma > 0 || shadow ? { blurSigma, shadow } : null;
}

export function initGL(canvas: HTMLCanvasElement): GLState | null {
    const gl = (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    const normalBuffer = gl.createBuffer();
    const localBuffer = gl.createBuffer();
    const heightTex = gl.createTexture();
    const imageTex = gl.createTexture();
    if (!vs || !fs || !program || !buffer || !normalBuffer || !localBuffer || !heightTex || !imageTex) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    return {
        gl, program, buffer, normalBuffer, localBuffer, heightTex, imageTex,
        imageKey: null,
        blur: initBlur(gl),
        posLoc: gl.getAttribLocation(program, "a_pos"),
        viewLoc: gl.getUniformLocation(program, "u_view"),
        colorLoc: gl.getUniformLocation(program, "u_color"),
        zLoc: gl.getUniformLocation(program, "u_z"),
        normalLoc: gl.getAttribLocation(program, "a_normal"),
        localLoc: gl.getAttribLocation(program, "a_local"),
        ambientLoc: gl.getUniformLocation(program, "u_ambient"),
        lightCountLoc: gl.getUniformLocation(program, "u_lightCount"),
        lightDirLoc: gl.getUniformLocation(program, "u_lightDir"),
        lightColorLoc: gl.getUniformLocation(program, "u_lightColor"),
        heightTexLoc: gl.getUniformLocation(program, "u_heightTex"),
        boxLoc: gl.getUniformLocation(program, "u_box"),
        hMinLoc: gl.getUniformLocation(program, "u_hMin"),
        hMaxLoc: gl.getUniformLocation(program, "u_hMax"),
        hasHeightLoc: gl.getUniformLocation(program, "u_hasHeight"),
        imageLoc: gl.getUniformLocation(program, "u_image"),
        imgRectLoc: gl.getUniformLocation(program, "u_imgRect"),
        imgUVLoc: gl.getUniformLocation(program, "u_imgUV"),
        hasImageLoc: gl.getUniformLocation(program, "u_hasImage"),
        gradKindLoc: gl.getUniformLocation(program, "u_gradKind"),
        gradInvLoc: gl.getUniformLocation(program, "u_gradInv"),
        gradAxisLoc: gl.getUniformLocation(program, "u_gradAxis"),
        gradFocusLoc: gl.getUniformLocation(program, "u_gradFocus"),
        gradStopsLoc: gl.getUniformLocation(program, "u_gradStops"),
        // AN ARRAY UNIFORM IS ADDRESSED BY ITS FIRST ELEMENT — the same trap the blur weights
        // carry a note about: `getUniformLocation(p, "u_gradOffset")` returns null on some drivers.
        gradOffsetLoc: gl.getUniformLocation(program, "u_gradOffset[0]"),
        gradColorLoc: gl.getUniformLocation(program, "u_gradColor[0]"),
        layerTargets: []
    };
}

/**
 * A CSS colour as GPU components. Understands the forms this codebase's model actually emits —
 * `#rgb`, `#rrggbb`, `#rrggbbaa` — and answers null for anything else so the caller can skip the
 * shape instead of drawing it in a wrong colour.
 */
export function parseColor(css: string): [number, number, number, number] | null {
    const s = css.trim();
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
    if (!m) return null;
    const h = m[1];
    const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
    const n = (i: number): number => parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
    return [n(0), n(1), n(2), full.length === 8 ? n(3) : 1];
}

/**
 * A shape as PathCommands in its OWN local space, or null when this backend does not draw it.
 *
 * Every conversion here is one the engine already owns — an ellipse is `ellipseCommands`, a
 * rectangle is `rectCommands` (rounded corners included), a path is its own commands, a line is
 * the two-point path it has always been — so the GPU works on exactly the outline picking tests
 * and booleans cut. A fourth private idea of "what shape is this" is the drift this codebase
 * keeps designing out.
 *
 * LOCAL, not world, because a stroke is offset by a width and the width means local units: SVG
 * puts the element inside a transform and Canvas strokes under the CTM, so both thicken a scaled
 * node's border. Offsetting after the transform would keep it a constant world width and this
 * backend alone would disagree.
 */
export function shapeToLocalCommands(shape: Shape, radius: number | null): PathCommand[] | null {
    switch (shape.kind) {
        // TRANSLATED by the shared `transformCommands`, not by a hand-written map over x and y.
        // The hand-written one moved each command's ENDPOINT and left its CONTROL POINTS behind
        // at the origin, so any curve offset away from the origin stretched back to it. It hid
        // for a long time because the two shapes that go through here are usually offset by
        // nothing: a content rect has `shape.x = 0`, and a content ellipse has `cx - rx = 0`. The
        // rotate KNOB is neither — a small circle a long way from the origin — and it drew a
        // spike from the shape to the origin on the GPU, on every selection.
        case "rect": return transformCommands(translation(shape.x, shape.y),
            rectCommands(shape.width, shape.height, radius ?? 0));
        case "ellipse": return transformCommands(translation(shape.cx - shape.rx, shape.cy - shape.ry),
            ellipseCommands(shape.rx * 2, shape.ry * 2));
        case "path": return [...shape.commands];
        // A line is an OPEN two-point path. It has no interior, so only its stroke ever draws —
        // which is now the same code path as every other shape's stroke, caps included, rather
        // than a hand-rolled quad that could only ever be butt-capped.
        case "line": return [{ c: "M", x: shape.x1, y: shape.y1 }, { c: "L", x: shape.x2, y: shape.y2 }];
        // An IMAGE is the rect it occupies; what makes it a picture is the texture the fragment
        // stage samples, not its outline. It went through here as `null` — silently dropped — for
        // as long as this backend had no way to upload one.
        case "image": return transformCommands(translation(shape.x, shape.y),
            rectCommands(shape.width, shape.height, radius ?? 0));
        // TEXT is the rect it occupies too. What makes it readable is the bitmap `TextRaster`
        // draws — the same function the Canvas backend uses, so the two typeset identically
        // instead of each having an opinion about where a line breaks.
        case "text": return transformCommands(translation(shape.x, shape.y),
            rectCommands(shape.width, shape.height, 0));
        default: return null;
    }
}

function transformRing(ring: Ring, m: Mat2D): Ring {
    return ring.map(p => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }));
}

/** One draw: the triangles and the colour they are filled with. */
export interface Draw {
    vertices: number[];
    /**
     * One normal per VERTEX, three floats each — so `normals.length` is always
     * `vertices.length / 2 * 3`.
     *
     * Per vertex rather than per draw because that is the whole point: a mesh whose middle is
     * raised faces a different way there than at its edges, and a single normal for the shape
     * would light a dome exactly like a flat card.
     *
     * NOT unit vectors, deliberately — `surfaceNormal`'s raw length is what makes them survive the
     * GPU's linear interpolation, and the fragment shader normalises what arrives. See the note on
     * `surfaceNormal`: the raw vector is affine across a cell and a unit one is not, which is the
     * difference between a smooth dome and a faceted one.
     */
    normals: number[];
    /**
     * Each vertex's position in the shape's OWN units, two floats each — what the fragment stage
     * marches the heightfield from.
     *
     * A POSITION rather than an answer, and that is the whole change from the per-vertex term this
     * replaced: interpolating a position across a triangle is exact, where interpolating occlusion
     * computed at three corners smeared a discontinuity into a gradient.
     */
    locals: number[];
    /** The surface's heights as a texture, or null when there is no relief to march through. */
    height: HeightTexture | null;
    /**
     * The picture to sample, and the rect in LOCAL units it fills — null for an ordinary shape.
     *
     * The href rather than a bitmap, because this is the PURE half: resolving an href to decoded
     * pixels is asynchronous and stateful, and belongs with the draw calls.
     */
    image: {
        href: string; x: number; y: number; width: number; height: number;
        /** The SOURCE sub-rectangle in the image's own pixels, or null for the whole image. */
        source: { x: number; y: number; width: number; height: number } | null;
        pixelated: boolean;
        /**
         * A `core.raster`'s run-length payload, or null for a `core.image` (schema 55).
         *
         * CARRIED, BECAUSE THE HREF IS ONLY A KEY. A raster's href is
         * `raster:<id>:<w>x<h>:<len>:<sum>` — an identity, not a URL — so `resolveImage` has
         * nothing to fetch and this backend drew NOTHING for a painted canvas while the other two
         * drew it correctly. The same reference the display list already holds, not a copy; the
         * cache decodes it lazily on a miss.
         */
        surface: { data: string; width: number; height: number } | null;
    } | null;
    /**
     * The text to RASTERISE into this draw's triangles, or null.
     *
     * The shape itself rather than a bitmap, for the same reason `image` is an href: turning it
     * into pixels needs a 2D context and a cache, which is the impure half. What makes this a
     * rasterised quad rather than a glyph atlas is in `TextRaster` — the GPU shows what Canvas
     * shows because the same function draws both.
     */
    text: TextShape | null;
    color: [number, number, number, number];
    /**
     * The ramp this draw is filled with, or null for a flat colour (schema 56).
     *
     * ALREADY INVERTED and already flattened to numbers, because a shader takes uniforms and not
     * objects — and because inverting per frame in the draw loop would put the one piece of
     * arithmetic here that a `node` test cannot reach. `inv` maps LOCAL units to the gradient's own
     * space with `objectBoundingBox` folded in, so the shader knows nothing about units.
     */
    gradient: {
        kind: 1 | 2;
        inv: Mat2D;
        /** linear: x1, y1, x2, y2. radial: cx, cy, r, 0. */
        axis: [number, number, number, number];
        focus: [number, number];
        offsets: number[];
        /** Four floats per stop, its `stop-opacity` already folded into the alpha. */
        colors: number[];
    } | null;
}

/** Side of the square heightfield texture. 64 covers the finest grid a mesh may declare. */
export const HEIGHT_TEX_SIZE = 64;

/** A surface's heights as bytes the GPU can sample, plus the range they were packed against. */
export interface HeightTexture {
    /** RGBA, `size * size * 4` bytes. Height is 16 bits split across R (high) and G (low). */
    data: Uint8Array;
    size: number;
    min: number;
    max: number;
}

/**
 * A height read back out of the two bytes it was packed into.
 *
 * Exported and tested because the FRAGMENT SHADER contains this same arithmetic and cannot be
 * tested — pinning the round trip here is the only way the packing has a checked definition. An
 * off-by-one in the decode is not a crash; it is a surface subtly the wrong height, which looks
 * like a lighting bug forever.
 */
export function decodeHeight(rByte: number, gByte: number, min: number, max: number): number {
    return min + ((rByte * 256 + gByte) / 65535) * (max - min);
}

/**
 * A mesh's heightfield as a texture — the thing this renderer has never had, and what lets the
 * ray march run per FRAGMENT instead of per vertex.
 *
 * SIXTEEN BITS, split across two channels, rather than the obvious eight. Eight bits over a
 * 260-unit relief quantises to about one unit, and the march compares a sampled height against a
 * ray climbing continuously — so the steps in the surface become steps in the shadow's edge,
 * which is precisely the artifact this replaced a per-vertex term to remove.
 *
 * Packed against the surface's OWN range rather than an absolute scale, so all sixteen bits are
 * spent on the relief that exists. A FLAT surface has no range to pack against and returns null:
 * there is nothing to occlude with, the shader is told so, and the march never runs.
 *
 * Sampled at TEXEL CENTRES — `(i + 0.5) / size` — because that is where `texture2D` reads them.
 * Aligning the samples to the box's edges instead would put every value half a texel from where
 * the GPU looks for it, which reads as the whole surface sliding under its own lighting.
 */
export function heightTexture(mesh: ReadonlyMesh, box: { width: number; height: number },
                              size: number = HEIGHT_TEX_SIZE): HeightTexture | null {
    const { min, max } = heightRange(mesh);
    if (max <= min) return null;                  // flat: nothing stands up, and no range to pack
    const span = max - min;
    const data = new Uint8Array(size * size * 4);
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            const x = ((col + 0.5) / size) * box.width;
            const y = ((row + 0.5) / size) * box.height;
            const n = (warpHeight(mesh, box, x, y) - min) / span;
            // The clamp is DEFENSIVE and provably unreachable, which a mutation of it shows:
            // `warpHeight` clamps its parameters and then blends four control-point heights, so
            // its result is a convex combination of values inside [min, max] and `n` cannot leave
            // [0, 1] — not even by rounding, since one ulp of 1.0 is ten orders below the 7.6e-6
            // it would take to reach the next code. It stays because the failure it prevents is a
            // WRAP: `n` a hair above 1 gives 65536, whose high byte is 256, which a `Uint8Array`
            // stores as 0 — turning the tallest point on the surface into the lowest.
            const v = Math.round(Math.max(0, Math.min(1, n)) * 65535);
            const i = (row * size + col) * 4;
            data[i] = v >> 8;
            data[i + 1] = v & 255;
            data[i + 3] = 255;
        }
    }
    return { data, size, min, max };
}

/**
 * Rasterised text, keyed by everything that changes its pixels.
 *
 * BOUNDED and evicted oldest-first. A design document has tens of text nodes, but the key includes
 * the raster SCALE, so zooming through the range mints a few bitmaps per node — and a cache with
 * no bound is a leak that only shows up after a long session, which is the worst time to find one.
 */
const TEXT_CACHE_MAX = 64;
const textCache = new Map<string, HTMLCanvasElement>();

/**
 * One text shape as a bitmap, drawn by the SAME function the Canvas backend uses.
 *
 * Null with no DOM (the node tests) and for a degenerate box, which is why the caller treats a
 * missing raster as "skip this draw" rather than as an error.
 */
function rasterizeText(shape: TextShape, paint: DrawItem["paint"], scale: number, key: string): HTMLCanvasElement | null {
    const hit = textCache.get(key);
    if (hit) {
        // Re-inserted so eviction is least-recently-USED rather than oldest-created: the text a
        // person is looking at is the text that would otherwise be thrown away first.
        textCache.delete(key);
        textCache.set(key, hit);
        return hit;
    }
    if (typeof document === "undefined") return null;
    const w = Math.round(shape.width * scale), h = Math.round(shape.height * scale);
    if (w <= 0 || h <= 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // The shape is drawn at its OWN coordinates, so the context is moved to put the box's origin
    // at the bitmap's. Translating rather than rewriting the coordinates is what keeps
    // `drawTextInto` identical to the version the Canvas backend calls.
    ctx.scale(scale, scale);
    ctx.translate(-shape.x, -shape.y);
    drawTextInto(ctx, shape, paint);
    if (textCache.size >= TEXT_CACHE_MAX) {
        const oldest = textCache.keys().next();
        if (!oldest.done) textCache.delete(oldest.value);
    }
    textCache.set(key, canvas);
    return canvas;
}

/** Straight at the viewer — what an unlit, unmeshed surface faces. */
const FLAT_NORMAL = { x: 0, y: 0, z: 1 };

/**
 * The vector to hand a vertex: the surface's own, or flat where the surface has collapsed.
 *
 * A cell whose control points have been dragged onto each other has no tangents and so no normal,
 * and `surfaceNormal` says so by answering zero. The shader normalises what it is given, and
 * normalising zero is NaN — which does not draw a dark shape, it draws nothing, on hardware that
 * discards the fragment and a black hole on hardware that does not. Substituted here rather than
 * inside `surfaceNormal` because "there is no surface here" is the true answer, and only this
 * caller has a reason to prefer a lie the GPU can multiply.
 */
function vertexNormal(n: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    return (n.x === 0 && n.y === 0 && n.z === 0) ? FLAT_NORMAL : n;
}

/**
 * A resolved ramp as the numbers a shader takes, or null when this backend cannot draw it.
 *
 * NULL IS A REAL ANSWER and the caller falls back to the flat colour, which is the rule this
 * backend already follows for a colour it cannot parse: skip, never guess. Three things reach it —
 * more stops than the uniform arrays hold, a stop colour that is not a hex this engine can take
 * apart, and a mapping with no inverse (a shape scaled to nothing, a zero gradientTransform).
 *
 * INVERTED HERE, not in the draw loop. `inv` maps a fragment's LOCAL position into the gradient's
 * own space, which is the direction a shader needs and the opposite of the one the document
 * stores; doing it per frame per draw would also put the arithmetic where no `node` test can see
 * it. `objectBoundingBox` is folded in first, so the shader never learns what units are.
 */
export function gpuGradient(g: PaintGradient, box: { width: number; height: number } | undefined): Draw["gradient"] {
    if (g.stops.length === 0 || g.stops.length > GPU_MAX_STOPS) return null;
    const fold: Mat2D = g.units === "objectBoundingBox" && box
        ? { a: box.width, b: 0, c: 0, d: box.height, e: 0, f: 0 }
        : IDENTITY;
    const inv = invert(multiply(fold, g.transform));
    if (!inv) return null;
    const offsets: number[] = [];
    const colors: number[] = [];
    for (const stop of g.stops) {
        const c = parseColor(stop.color);
        if (!c) return null;
        offsets.push(stop.offset);
        // The stop's own alpha TIMES its `stop-opacity` — SVG keeps the two apart and a shader
        // has one alpha per stop, the same fold the canvas backend does into an rgba() string.
        colors.push(c[0], c[1], c[2], c[3] * stop.opacity);
    }
    return {
        kind: g.kind === "linear" ? 1 : 2,
        inv,
        axis: g.kind === "linear" ? [g.x1, g.y1, g.x2, g.y2] : [g.cx, g.cy, g.r, 0],
        focus: [g.fx, g.fy],
        offsets, colors
    };
}

function draw(rings: Ring[], world: Mat2D | null, css: string, opacity: number | null,
              image?: Draw["image"],
              text?: TextShape | null,
              surface?: {
                  normal: (x: number, y: number) => { x: number; y: number; z: number };
                  cell: number;
                  /** Null when there is no relief; the shader is then told to skip the march. */
                  height: HeightTexture | null;
              },
              gradient?: Draw["gradient"]): Draw | null {
    const color = parseColor(css);
    if (!color) return null;                      // not a colour it can parse: skip, never guess
    // Tessellated in LOCAL space, then each vertex transformed — the reverse of what this used to
    // do, and necessary rather than tidier: a normal is sampled from the mesh, the mesh is in
    // local units, and a world-space triangle has no way back to the coordinate that produced it.
    // The triangles are the same either way, the transform being affine.
    // SUBDIVIDED when there is a surface to shade. A value sampled per vertex can only vary where
    // there are vertices, and ear clipping puts them only on the outline — which is why a dome
    // came out flat: a rectangle's four vertices all sit on the rim, where its gradient is zero.
    // One mesh cell is the right target, because that is the finest detail the surface can hold.
    const local = surface ? subdivideTriangles(triangulate(rings), surface.cell) : triangulate(rings);
    if (local.length === 0) return null;
    const vertices = new Array<number>(local.length);
    // Presized, not bounded: JS arrays grow on assignment, so this is an allocation hint and
    // nothing else — a wrong size here changes no output, which is why no test can kill it.
    const normals = new Array<number>((local.length / 2) * 3);
    const locals = new Array<number>(local.length);
    for (let i = 0, n = 0; i < local.length; i += 2, n += 3) {
        const lx = local[i], ly = local[i + 1];
        const nrm = surface ? vertexNormal(surface.normal(lx, ly)) : FLAT_NORMAL;
        normals[n] = nrm.x; normals[n + 1] = nrm.y; normals[n + 2] = nrm.z;
        locals[i] = lx; locals[i + 1] = ly;
        vertices[i] = world ? world.a * lx + world.c * ly + world.e : lx;
        vertices[i + 1] = world ? world.b * lx + world.d * ly + world.f : ly;
    }
    if (opacity !== null) color[3] *= opacity;    // MULTIPLY — one blend, not two
    return { vertices, normals, locals, height: surface?.height ?? null, image: image ?? null,
        text: text ?? null, color, gradient: gradient ?? null };
}

/**
 * Everything one item contributes: its fill, its stroke, or both, in paint order.
 *
 * Pure, and exported for exactly that reason: this is where a shape becomes geometry, so it is
 * the part worth testing in the `node` environment. What is left in `emitWebGL` below is buffer
 * uploads and draw calls, which only a GPU can answer for.
 *
 * A list rather than one draw, because a bordered shape is two of them and always was — the
 * other two backends fill and then stroke the same element. Returning only the fill was why the
 * selection frame could not appear on this backend at all.
 */
/**
 * How finely to cut THIS item's curves, given the view scale in device pixels per world unit.
 *
 * Pure, and exported for the same reason `itemDraws` is: it is a decision, and a decision that
 * lives inside the draw loop can only be checked by running a GPU. The item's own matrix scales
 * the view — flattening happens in local space, so a node scaled 10x needs a tolerance ten times
 * finer — and an item without one is drawn at the view scale alone (the grid, which is already in
 * world units).
 */
export function itemTolerance(item: DrawItem, viewScale: number): number {
    return displayTolerance(item.world ? localScaleOf(item.world, viewScale) : viewScale);
}

/**
 * How big a bitmap really is, for the one caller that cannot know: nine-slice.
 *
 * INJECTED RATHER THAN IMPORTED, so `itemDraws` stays pure and stays testable in the `node`
 * environment. The size lives in a cache full of decoded images and belongs to the draw loop; a
 * direct import would drag that into the one part of this backend a test can reach.
 */
export type NaturalSizeOf = (href: string) => { width: number; height: number } | null;

export function itemDraws(
    item: DrawItem, tolerance: number = FLATTEN_TOLERANCE, naturalOf?: NaturalSizeOf
): Draw[] {
    const paint = item.paint;
    const local = shapeToLocalCommands(item.shape, paint.radius);
    if (!local) return [];
    const out: Draw[] = [];
    // The lighting SURFACE, when the item carries one. It is passed separately from the shape
    // because `resolveMeshes` has already turned a meshed node into a path and dropped its mesh —
    // the bend is in the commands by then, and the thing a light needs is the surface that caused
    // it, which only the unresolved document still has.
    const surface = item.surface
        ? {
            normal: (x: number, y: number) => surfaceNormal(item.surface!.mesh, item.surface!.box, x, y),
            // One CELL of the grid, on its shorter axis: finer than that samples the same bilinear
            // patch twice and buys nothing, coarser leaves the surface's own detail unreachable.
            cell: Math.max(1e-6, Math.min(item.surface.box.width / item.surface.mesh.cols,
                                          item.surface.box.height / item.surface.mesh.rows)),
            height: heightTexture(item.surface.mesh, item.surface.box)
        }
        : undefined;
    // An IMAGE and TEXT are both drawn from a BITMAP instead of their fill, never as well.
    //
    // For an image, Canvas returns before it fills for the same reason: a colour under a picture
    // shows through every transparent pixel, which is the kind of divergence that only appears on
    // somebody's PNG with a soft edge. For text it is not a subtlety at all — `paint.fill` on a
    // text node is the GLYPH colour, so filling its box would paint a solid rectangle over
    // whatever is behind it.
    const isRaster = item.shape.kind === "image" || item.shape.kind === "text";
    if (paint.fill !== null && !isRaster) {
        // RESOLVED first, which does two jobs at once. It applies the document's fill rule — the
        // GPU has no `fill-rule` to hand to, unlike the other two backends, so the rule has to
        // become geometry here. And it makes the rings simple, which ear clipping requires: a
        // self-crossing path used to come out as overlapping triangles on this backend and as
        // the right shape on the other two.
        // A GRADIENT (schema 56) is walked PER FRAGMENT by the shader. `gpuGradient` returns null
        // for a ramp this backend cannot carry — too many stops, an unparsable stop colour, a
        // mapping with no inverse — and then the flat colour is what paints, which is the same
        // answer the other two backends' fallbacks show.
        const ramp = typeof paint.fill === "string" ? null : gpuGradient(paint.fill, item.localBox);
        // WHITE, not the flat colour, when a ramp is carried: the shader takes only the ALPHA of
        // this uniform for a gradient, exactly as it does for an image, and a coloured one here
        // would be a second tint nothing asked for. When there is no ramp it IS the fill.
        const fillCss = typeof paint.fill === "string" ? paint.fill : ramp ? "#ffffff" : paint.fill.flat;
        const fill = draw(resolveRings(commandsToRings(local, tolerance), paint.fillRule ?? "nonzero"),
            item.world, fillCss, paint.opacity, null, null, surface, ramp);
        if (fill) out.push(fill);
    }
    // AN IMAGE has no fill and is drawn from its own pixels. Its rect is already the geometry that
    // `shapeToLocalCommands` produced, so this is the same triangles with a texture over them —
    // and it is lit and shadowed by the same arithmetic as everything else, which is the point of
    // putting it through the fragment shader rather than blitting it.
    if (isRaster && item.shape.kind === "image" && item.shape.href !== null) {
        const rect = item.shape;
        // NINE-SLICE (schema 57) is NINE DRAWS, each one exactly the single-image draw this
        // backend already makes: its own quad, its own source rect. Nothing new reaches the
        // shader — which is the point of keeping the pieces as geometry rather than teaching the
        // fragment stage a piecewise remap it would then own alone.
        //
        // A RASTER KNOWS ITS OWN SIZE; an image's comes from the injected resolver, and without
        // one (a `node` test, an undecoded bitmap) the slice cannot be cut — so it draws whole,
        // which is the same picture the other two backends show while a file is still loading.
        const natural = rect.surface
            ? { width: rect.surface.width, height: rect.surface.height }
            : (rect.href !== null ? naturalOf?.(rect.href) ?? null : null);
        if (rect.nineSlice && natural) {
            const region = rect.source ?? { x: 0, y: 0, width: natural.width, height: natural.height };
            const dest = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            for (const piece of nineSliceRects(region, dest, rect.nineSlice)) {
                // The quad through `rectCommands` + `transformCommands`, the same two functions
                // every other rectangle in this engine goes through — a fifth private idea of
                // what a rectangle is would be one more thing to keep in step.
                const quad = transformCommands(translation(piece.dst.x, piece.dst.y),
                    rectCommands(piece.dst.width, piece.dst.height));
                const part = draw(resolveRings(commandsToRings(quad, tolerance), "nonzero"),
                    item.world, "#ffffff", paint.opacity,
                    { href: rect.href!, x: piece.dst.x, y: piece.dst.y,
                      width: piece.dst.width, height: piece.dst.height,
                      source: piece.src, pixelated: rect.pixelated, surface: rect.surface },
                    null, surface);
                if (part) out.push(part);
            }
        } else {
            const picture = draw(resolveRings(commandsToRings(local, tolerance), "nonzero"),
                item.world, "#ffffff", paint.opacity,
                { href: rect.href!, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                  source: rect.source, pixelated: rect.pixelated, surface: rect.surface }, null, surface);
            if (picture) out.push(picture);
        }
    }
    // TEXT is its box, with the typeset result painted over it. The geometry is a rectangle
    // because that is what a bitmap goes on; everything that makes it text happened in
    // `TextRaster`, which the Canvas backend runs too — so a line breaks in the same place on
    // both, which a second typesetter in here could never promise.
    if (isRaster && item.shape.kind === "text" && item.shape.text.length > 0) {
        const typeset = draw(resolveRings(commandsToRings(local, tolerance), "nonzero"),
            item.world, "#ffffff", null, null, item.shape, surface);
        if (typeset) out.push(typeset);
    }
    if (paint.stroke !== null && paint.strokeWidth !== null && paint.strokeWidth > 0) {
        const style = {
            width: paint.strokeWidth,
            join: paint.strokeJoin, cap: paint.strokeCap, miterLimit: paint.strokeMiterLimit
        };
        // DASHES are cut before the border is outlined, because a dash is a piece of the path and
        // not a property of the ink. SVG and Canvas take the pattern as an instruction and do the
        // cutting themselves; a GPU has to be handed the pieces. Every run is outlined separately
        // so each gets the stroke's own caps — which is what makes a dashed line look dashed
        // rather than merely gappy.
        const pattern = paint.strokeDash !== null ? parseDashArray(paint.strokeDash) : null;
        const runs = pattern ? dashSubpaths(local, pattern, 0, tolerance) : [local];
        const rings = runs.flatMap(run => strokeOutline(run, style, tolerance));
        const stroke = draw(rings, item.world, paint.stroke, paint.opacity, null, null, surface);
        if (stroke) out.push(stroke);
    }
    return out;
}

/** The viewport matrix as the 3x3 the shader takes: world → clip space, column-major. */
export function viewMatrix(width: number, height: number, vpX: number, vpY: number, zoom: number): number[] {
    // screen = z·world − vp, then screen → clip is (2x/w − 1, 1 − 2y/h). Composed once here so
    // the shader is two multiplies and the CPU does no per-vertex work.
    const sx = (2 * zoom) / width, sy = (-2 * zoom) / height;
    return [sx, 0, 0, 0, sy, 0, (-2 * vpX) / width - 1, (2 * vpY) / height + 1, 1];
}

/** Draw a frame. Returns false when WebGL could not be used, so the caller can fall back. */
export function emitWebGL(canvas: HTMLCanvasElement, list: DisplayList, vp: { x: number; y: number; zoom: number }, dpr: number = 1): boolean {
    const cached = (canvas as HTMLCanvasElement & { __vdeGL?: GLState | null });
    if (cached.__vdeGL === undefined) cached.__vdeGL = initGL(canvas);
    const state = cached.__vdeGL;
    if (!state) return false;
    const { gl, program, buffer, posLoc, viewLoc, colorLoc, zLoc } = state;

    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.102, 0.102, 0.180, 1);          // the same #1a1a2e both other backends use
    // THE Z-BUFFER (schema 40). The model has already sorted far-to-near, so this is braces
    // rather than belt — but it is the half that does not depend on anybody sorting correctly:
    // a fragment nearer the viewer wins whatever order its draw call arrived in. LEQUAL rather
    // than LESS so that equal depths still paint in the order they were issued, which is what
    // keeps a document with no depth at all drawing exactly as it did before.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // SEPARATE, and the alpha channel is the reason. `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`
    // applies SRC_ALPHA to the ALPHA channel too, so a half-transparent fill over an opaque
    // background leaves dst.a = 0.5·0.5 + 1·0.5 = 0.75 — the colour is right and the surface is no
    // longer opaque. The canvas is then composited over the page with that alpha, so the shape
    // comes out wrong by however dark the page behind it is.
    //
    // Found by comparing pixels with the other two backends, which is the only way it could be:
    // the RGB is correct, `gl.getError()` is 0, and on a dark page the result looks plausible. It
    // predates gradients — any translucent fill hit it — and a ramp fading to transparent is just
    // the first thing that made a whole shape wrong instead of one shade off.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);
    gl.uniformMatrix3fv(viewLoc, false, viewMatrix(width, height, vp.x * dpr, vp.y * dpr, vp.zoom * dpr));
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    // THE SCENE'S LIGHTING (schema 42), set once per frame — it is a property of the document, so
    // it cannot change between two shapes in the same picture.
    setLighting(gl, state, list.lights, list.ambient);

    // Grid, then content, then overlay — the same order the other backends paint in, because the
    // display list's order IS the z-order and a GPU has no depth buffer here to recover it from.
    // ADAPTIVE: how finely to cut a curve is decided per item, from how large it is ON SCREEN.
    // `vp.zoom * dpr` is device pixels per world unit; the item's own matrix scales that again.
    // The other two backends never needed this — they hand outlines to a rasterizer that knows
    // the resolution — which is why a fixed world tolerance went unnoticed until a backend had to
    // commit to a vertex count.
    const viewScale = vp.zoom * dpr;
    /** Puts the scene's program, buffer and blend state back after an effects detour. */
    const restoreSceneState = (): void => {
        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        gl.enable(gl.BLEND);
        // The same separate blend the frame set up — this restores state after an offscreen
        // detour, so it has to restore the SAME state or an item with an effect would composite
        // differently from one without.
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
    };

    /**
     * OPACITY GROUPS (schema 32) as a stack of render targets.
     *
     * A group composites as ONE and is then faded, so its items go into a target of their own and
     * the target is drawn back under the group's alpha. Ignoring `list.groups` — which this backend
     * did until a cross-backend pixel comparison put it 137 channels from SVG — draws a translucent
     * group fully opaque.
     *
     * `destination` is where the CURRENT item belongs, and every composite in this loop has to
     * respect it. The effect detour used to bind `null` and put a shadowed item straight on the
     * screen, which would jump it out of its own group.
     */
    const groupAlpha = new Map(list.groups.map(gr => [gr.id, gr.opacity]));
    const layerStack: { target: BlurTarget; parent: WebGLFramebuffer | null; opacity: number }[] = [];
    let destination: WebGLFramebuffer | null = null;

    /**
     * DEPTH IS OFF INSIDE A LAYER, and that is correct rather than a compromise: a layer target has
     * no depth attachment, and `content` was already sorted far-to-near by the model, so painter's
     * order inside the group produces exactly what the depth test would have.
     *
     * NOT MUTATION-KILLABLE, and deliberately kept. GL says a depth test against a framebuffer with
     * no depth buffer always passes, so leaving the test enabled changes nothing here and forcing
     * it on survives the pixel sweep. It is written out for the reason the effect detour gives for
     * its own `disable`: the alternative is code whose correctness depends on an attachment nobody
     * asked for, and that is a worse thing to rely on than one redundant call per layer.
     */
    const applyDepth = (): void => {
        if (layerStack.length > 0) gl.disable(gl.DEPTH_TEST); else gl.enable(gl.DEPTH_TEST);
    };

    const openLayer = (opacity: number): void => {
        const depth = layerStack.length;
        const t = ensureTarget(gl, state.layerTargets[depth] ?? null, width, height);
        state.layerTargets[depth] = t;
        // No target: the group is drawn WITHOUT its fade rather than not at all. Losing the alpha
        // is visible; losing the subtree is not — the same choice the canvas backend makes.
        if (!t) return;
        layerStack.push({ target: t, parent: destination, opacity });
        destination = t.framebuffer;
        gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
        gl.viewport(0, 0, t.width, t.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        // THE FEEDBACK LOOP AGAIN. This target's own texture is still bound to unit 0 from the
        // composite that closed it last frame, and the scene program samples unit 0 — so drawing
        // into it now would be discarded with INVALID_OPERATION and the group would come out
        // empty. The same unbinding the effect detour does, for the same reason.
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        restoreSceneState();
        applyDepth();
    };

    const closeLayer = (): void => {
        const top = layerStack.pop();
        if (!top || !state.blur) return;
        destination = top.parent;
        gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
        gl.viewport(0, 0, width, height);
        // Untinted and unmoved — only faded. The target is premultiplied, so the fade is one
        // multiply in the composite shader.
        compositeTarget(gl, state.blur, top.target, 0, 0, null, top.opacity);
        restoreSceneState();
        applyDepth();
    };

    let openPath: readonly string[] = [];
    for (const item of [...list.grid.lines, ...list.content, ...list.overlay]) {
        const nextPath = item.groups ?? [];
        const step = layerTransition(openPath, nextPath);
        for (let i = 0; i < step.close; i++) closeLayer();
        for (const id of step.open) openLayer(groupAlpha.get(id) ?? 1);
        openPath = nextPath;
        // EFFECTS ARE AN OFFSCREEN DETOUR. An item with a shadow or a blur is drawn into a target
        // first, filtered, and composited back — because both are per-fragment work over a
        // RENDERED IMAGE and there is no such image while the item is still being drawn.
        const plan = state.blur ? effectPlan(item.paint, viewScale) : null;
        let target: BlurTarget | null = null;
        if (plan && state.blur) {
            target = ensureTarget(gl, state.blur.targets[0], width, height);
            state.blur.targets[0] = target;
            if (target) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
                gl.viewport(0, 0, target.width, target.height);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                // NO DEPTH while filling the target: it has no depth attachment, and one item's
                // fill and stroke share a depth anyway. Leaving the test on would make the result
                // depend on whether the driver gave us a depth buffer we never asked for.
                gl.disable(gl.DEPTH_TEST);
                restoreSceneState();
                gl.disable(gl.DEPTH_TEST);
                // THE FEEDBACK LOOP, and the whole reason a blurred shape came out as a HOLE.
                //
                // The blur and composite passes bind their SOURCE texture to unit 0, and the scene
                // program samples the height field on unit 0 too. So the moment an item is drawn
                // into `targets[0]` while `targets[0]`'s own texture is still bound to unit 0 —
                // which it is, left over from the previous item's blur — the active program
                // references a texture attached to the bound framebuffer. WebGL calls that a
                // feedback loop and DISCARDS THE DRAW with INVALID_OPERATION.
                //
                // Nothing reached the target, so the blur filtered an empty image and composited
                // nothing back: a hole exactly the size of the shape. Every piece measured
                // correctly on its own because every piece WAS correct.
                //
                // Unbinding is enough: a draw that actually needs the height or image texture
                // binds it immediately before drawing, a few lines below. A sampler left pointing
                // at no texture reads as opaque black and raises nothing, which is why this is
                // safe for the shapes that sample neither.
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, null);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, null);
            }
        }
        for (const d of itemDraws(item, itemTolerance(item, viewScale), naturalSize)) {
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d.vertices), gl.DYNAMIC_DRAW);
            gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
            // Normals ride in their own buffer rather than interleaved: the position buffer is
            // re-uploaded per draw already, and two small uploads are simpler to reason about
            // than one strided one whose layout has to be kept in step by hand.
            gl.bindBuffer(gl.ARRAY_BUFFER, state.normalBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d.normals), gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(state.normalLoc);
            gl.vertexAttribPointer(state.normalLoc, 3, gl.FLOAT, false, 0, 0);
            // LOCAL coordinates, so the fragment stage knows where on the surface it is.
            gl.bindBuffer(gl.ARRAY_BUFFER, state.localBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d.locals), gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(state.localLoc);
            gl.vertexAttribPointer(state.localLoc, 2, gl.FLOAT, false, 0, 0);
            // THE HEIGHTFIELD. Re-uploaded per draw rather than cached per node: the mesh is the
            // thing a person is dragging when this matters, so a cache keyed on it would be
            // invalidated on exactly the frames it would have paid for. One 64x64 RGBA upload is
            // 16 KB, which is smaller than the vertex buffer beside it.
            if (d.height) {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, state.heightTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, d.height.size, d.height.size, 0,
                    gl.RGBA, gl.UNSIGNED_BYTE, d.height.data);
                // LINEAR + CLAMP_TO_EDGE, set every upload because they belong to the image and
                // this texture object is shared between shapes. Linear so the march reads the same
                // bilinear surface `warpHeight` describes rather than 64 flat steps; clamped so a
                // ray leaving the box reads the edge instead of wrapping to the far side, which
                // would have a shape shadowed by its own opposite corner.
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.uniform1i(state.heightTexLoc, 0);
                gl.uniform2f(state.boxLoc, item.surface!.box.width, item.surface!.box.height);
                gl.uniform1f(state.hMinLoc, d.height.min);
                gl.uniform1f(state.hMaxLoc, d.height.max);
                gl.uniform1f(state.hasHeightLoc, 1);
            } else {
                gl.uniform1f(state.hasHeightLoc, 0);
            }
            // THE PICTURE, or the TYPESET TEXT — one texture unit, because both are a bitmap
            // stretched over the same rectangle. Uploaded only when the key changes: a texture is
            // a copy, so re-uploading per frame would re-encode every image on screen, and never
            // re-uploading would keep the blank bitmap that existed before a load finished. The
            // key carries the decode generation for an image and the raster parameters for text,
            // so both cases are one comparison.
            let source: TexImageSource | null = null;
            let texKey: string | null = null;
            let rect: { x: number; y: number; width: number; height: number } | null = null;
            if (d.image?.surface) {
                // A RASTER's pixels belong to the document, so there is nothing to fetch — the
                // shared cache turns the payload into a canvas synchronously, which is a
                // `TexImageSource` like any bitmap.
                const painted = resolveSurface(d.image.href, d.image.surface);
                if (!painted) continue;
                source = painted;
                // NO GENERATION in the key. An image's href is stable while its bitmap loads, so
                // that path needs the generation to notice the arrival; a surface decodes at once
                // and its href already carries the payload's size, length and checksum — the href
                // changing IS the pixels changing.
                texKey = `sur:${d.image.href}`;
                rect = d.image;
            } else if (d.image) {
                const bitmap = resolveImage(d.image.href);
                // A shape whose image has not decoded yet is SKIPPED rather than drawn white: a
                // placeholder rectangle is a worse lie than nothing.
                if (!bitmap) continue;
                source = bitmap;
                texKey = `img:${d.image.href}:${imageGeneration()}`;
                rect = d.image;
            } else if (d.text) {
                const scale = textRasterScale(viewScale);
                const key = textRasterKey(d.text, item.paint, scale);
                const raster = rasterizeText(d.text, item.paint, scale, key);
                if (!raster) continue;
                source = raster;
                texKey = `txt:${key}`;
                rect = d.text;
            }
            if (source && texKey && rect) {
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, state.imageTex);
                if (state.imageKey !== texKey) {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
                    // NPOT-safe: clamped wrapping needs no mipmaps, which a non-power-of-two
                    // texture cannot have in WebGL 1. No Y flip — texel row 0 is the source's top
                    // row, and `v_local` counts down from the rect's top too, so the two agree.
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    state.imageKey = texKey;
                }
                // THE FILTER IS SET PER DRAW, OUTSIDE the upload check, and that is the whole
                // difference between this working and not. One texture OBJECT is shared by every
                // raster in the frame, so a parameter set only when the pixels change belongs to
                // whichever item last uploaded — fine while the filter was a constant, wrong the
                // moment one item wants nearest and the next wants linear. The wrap modes stay
                // inside because they genuinely never vary.
                const filter = d.image?.pixelated ? gl.NEAREST : gl.LINEAR;
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
                gl.uniform1i(state.imageLoc, 1);
                gl.uniform4f(state.imgRectLoc, rect.x, rect.y, rect.width, rect.height);
                // THE SOURCE REGION, normalised here because this is the only place that knows the
                // texture's real pixel size — the document stores source pixels and cannot know it.
                // Text and whole images pass the identity, so they take the same path.
                //
                // BOTH KINDS OF SOURCE, and that was a real hole. A decoded image is an
                // `HTMLImageElement` and a painted RASTER is a canvas, and this asked only about
                // the first — so a raster with a source region silently sampled the whole surface.
                // Nothing had ever given a raster one until nine-slice gave every piece of one,
                // and then every slice of every painted panel showed the entire button. Found by
                // comparing pixels with the other two backends, which put it 240 channels out.
                const texW = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
                const texH = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
                const uv = d.image?.source
                    ? normalisedUV(d.image.source, texW, texH)
                    : { x: 0, y: 0, width: 1, height: 1 };
                gl.uniform4f(state.imgUVLoc, uv.x, uv.y, uv.width, uv.height);
                gl.uniform1f(state.hasImageLoc, 1);
            } else {
                gl.uniform1f(state.hasImageLoc, 0);
            }
            // THE RAMP, or an explicit zero. `u_gradKind` is sticky uniform state like every
            // other one here, so a draw that says nothing inherits the previous shape's gradient —
            // the exact shape of the `setLineDash` bug the canvas backend already carries a note
            // about, and it would paint the last gradient over every plain-coloured shape after it.
            if (d.gradient) {
                const g = d.gradient;
                gl.uniform1i(state.gradKindLoc, g.kind);
                // Column-major, like `u_view`: a Mat2D is the top two ROWS of a 3x3.
                gl.uniformMatrix3fv(state.gradInvLoc, false,
                    [g.inv.a, g.inv.b, 0, g.inv.c, g.inv.d, 0, g.inv.e, g.inv.f, 1]);
                gl.uniform4f(state.gradAxisLoc, g.axis[0], g.axis[1], g.axis[2], g.axis[3]);
                gl.uniform2f(state.gradFocusLoc, g.focus[0], g.focus[1]);
                gl.uniform1i(state.gradStopsLoc, g.offsets.length);
                gl.uniform1fv(state.gradOffsetLoc, g.offsets);
                gl.uniform4fv(state.gradColorLoc, g.colors);
            } else {
                gl.uniform1i(state.gradKindLoc, 0);
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.uniform1f(zLoc, depthToClipZ(item.depth ?? 0));
            gl.uniform4fv(colorLoc, d.color);
            gl.drawArrays(gl.TRIANGLES, 0, d.vertices.length / 2);
        }

        if (plan && target && state.blur) {
            const b = state.blur;
            /**
             * One blur, done at whatever resolution `blurPlan` says it should be.
             *
             * The plan halves the resolution until the sigma fits a 64-tap kernel, and each
             * halving is a resample. Without this the kernel CLAMPS, which is a collapse rather
             * than a taper: past sigma 21.3 every blur comes out the same width, and far sharper
             * than SVG and Canvas draw the same document.
             *
             * Returns the target holding the result — which may be smaller than the screen. The
             * composite stretches it back, since it samples across the whole texture.
             */
            const runBlur = (source: BlurTarget, sigma: number): BlurTarget | null => {
                const plan = blurPlan(sigma);
                if (plan.sigma <= 0) return source;
                const w = Math.max(1, width >> plan.levels);
                const h = Math.max(1, height >> plan.levels);
                const a = ensureTarget(gl, b.targets[1], w, h);
                const c = ensureTarget(gl, b.targets[2], w, h);
                b.targets[1] = a;
                b.targets[2] = c;
                if (!a || !c) return null;
                // DOWN FIRST, in one step rather than one per level: the composite's LINEAR filter
                // averages whatever ratio it is given, and repeated halvings would cost a pass
                // each to arrive at the same place.
                let src = source;
                if (plan.levels > 0) { resampleTo(gl, b, source, a); src = a; }
                // Then the separable pair, ping-ponging at that size.
                const first = src === a ? c : a;
                const second = src === a ? a : c;
                blurPass(gl, b, src, first, plan.sigma, true);
                blurPass(gl, b, first, second, plan.sigma, false);
                return second;
            };

            // THE SHAPE'S OWN BLUR FIRST, so what follows sees the blurred look — the order
            // SVG's filter chain uses, where `feDropShadow` consumes `feGaussianBlur`'s output.
            let look: BlurTarget | null = target;
            if (plan.blurSigma > 0) {
                const blurred = runBlur(target, plan.blurSigma);
                if (blurred && plan.shadow) {
                    // BOTH EFFECTS: the blurred look is living in a scratch target that the
                    // shadow's own blur is about to overwrite, so it is copied back to the item's
                    // target first. Without this the shape would be composited from pixels the
                    // shadow pass had already replaced — the shape wearing its own shadow.
                    resampleTo(gl, b, blurred, target);
                    look = target;
                } else if (blurred) {
                    look = blurred;
                }
            }

            if (look) {
                if (plan.shadow) {
                    // A ZERO-blur shadow is a hard offset copy, not an absent one.
                    const shadowSrc = plan.shadow.sigma > 0 ? runBlur(look, plan.shadow.sigma) : look;
                    gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
                    gl.viewport(0, 0, width, height);
                    if (shadowSrc) {
                        compositeTarget(gl, b, shadowSrc,
                            plan.shadow.dx, plan.shadow.dy, plan.shadow.color);
                    }
                }
                gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
                gl.viewport(0, 0, width, height);
                // The shape itself, over its own shadow, untinted and unmoved.
                compositeTarget(gl, b, look, 0, 0, null);
            } else {
                // Scratch targets would not allocate. The item is composited PLAINLY rather than
                // lost — no effect is better than no shape.
                gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
                gl.viewport(0, 0, width, height);
                compositeTarget(gl, b, target, 0, 0, null);
            }
            restoreSceneState();
            applyDepth();
        }
    }
    // Anything still open at the end of the frame is composited now — an overlay closes the
    // content's groups on the way past, but a document that ends inside one would otherwise leave
    // its last group on a target nobody ever drew.
    while (layerStack.length > 0) closeLayer();
    return true;
}

/**
 * A source rectangle in image pixels, as texture coordinates.
 *
 * Pure and exported for the reason every decision in this file is pulled out of the draw loop: the
 * loop needs a GPU and this does not, so the arithmetic that can be wrong lives where a test can
 * reach it. A rect reaching outside the image is NOT clamped — clamped wrapping already makes the
 * sampler read the edge, and silently resizing an author's region would hide the mistake rather
 * than show it.
 */
export function normalisedUV(
    source: { x: number; y: number; width: number; height: number },
    textureWidth: number,
    textureHeight: number
): { x: number; y: number; width: number; height: number } {
    // A texture with no size is not something to divide by. It cannot happen for a decoded bitmap,
    // and a NaN here would put the whole picture nowhere rather than in the wrong place.
    if (!(textureWidth > 0) || !(textureHeight > 0)) return { x: 0, y: 0, width: 1, height: 1 };
    return {
        x: source.x / textureWidth,
        y: source.y / textureHeight,
        width: source.width / textureWidth,
        height: source.height / textureHeight
    };
}

/**
 * The scene's lighting, as the shader's uniforms.
 *
 * An UNLIT document sets ambient to 1 and no lights at all, which multiplies every colour by one
 * — so a document that has never heard of lighting draws byte-identically to how it did before
 * this existed. That is the property that lets the shader carry the lighting term unconditionally
 * rather than compiling two programs.
 *
 * A light whose colour cannot be parsed is SKIPPED rather than defaulted to white: an unreadable
 * colour is not a reason to add a light nobody asked for.
 */
export function setLighting(gl: WebGLRenderingContext, state: GLState,
                            lights: readonly Light[] | undefined, ambient: number | undefined): void {
    const dirs: number[] = [];
    const colors: number[] = [];
    for (const light of lights ?? []) {
        const dir = normalize(light);
        const rgb = parseColor(light.color);
        if (!dir || !rgb) continue;
        dirs.push(dir.x, dir.y, dir.z);
        colors.push(rgb[0] * light.intensity, rgb[1] * light.intensity, rgb[2] * light.intensity);
    }
    const count = dirs.length / 3;
    gl.uniform1f(state.ambientLoc, count === 0 ? 1 : (ambient ?? 0));
    gl.uniform1i(state.lightCountLoc, count);
    if (count > 0) {
        gl.uniform3fv(state.lightDirLoc, new Float32Array(dirs));
        gl.uniform3fv(state.lightColorLoc, new Float32Array(colors));
    }
}
