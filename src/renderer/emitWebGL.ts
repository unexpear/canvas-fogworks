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
 * DELIBERATE GAPS, stated rather than discovered later:
 *   - EFFECTS and dashes, below. TEXT and IMAGES used to be listed here and are now DRAWN: the
 *     heightfield gave this backend a texture path, and both are that same path with a bitmap in
 *     it instead of a surface. Text is rasterised through `TextRaster` — the function the Canvas
 *     backend also calls — rather than through a glyph atlas, so the two cannot break a line in
 *     different places. An atlas would be a second typesetter and a second set of answers.
 *   - EFFECTS (shadow, blur) and dashes are ignored; those are per-fragment work needing render
 *     targets.
 * The app offers this backend as a preview and says so, because a backend that quietly drops
 * content is worse than one that admits what it cannot do.
 */

import { DisplayList, DrawItem, Shape } from "./RenderModel";
import { Mat2D, translation } from "../core/geometry/Matrix";
import { Ring, commandsToRings } from "../core/geometry/PathBoolean";
import { subdivideTriangles, triangulate } from "../core/geometry/Tessellate";
import { strokeOutline } from "../core/geometry/StrokeOutline";
import { resolveRings } from "../core/geometry/Resolve";
import { depthToClipZ } from "../core/document/Depth";
import { ReadonlyMesh, heightRange, surfaceNormal, warpHeight } from "../core/document/Mesh";
import { marchOccluded } from "../core/geometry/RayMarch";
import { Light, normalize } from "../core/document/Light";
import { ellipseCommands, rectCommands, transformCommands } from "../core/geometry/ShapeToPath";
import { PathCommand } from "../core/document/Node";
import { FLATTEN_TOLERANCE, displayTolerance, localScaleOf } from "../core/geometry/ShapeHit";
import { imageGeneration, resolveImage } from "./ImageCache";
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
uniform float u_hasImage;

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
    if (u_hasImage > 0.5) {
        base = texture2D(u_image, (v_local - u_imgRect.xy) / u_imgRect.zw);
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
export interface GLState {
    gl: WebGLRenderingContext;
    program: WebGLProgram;
    buffer: WebGLBuffer;
    normalBuffer: WebGLBuffer;
    localBuffer: WebGLBuffer;
    heightTex: WebGLTexture;
    imageTex: WebGLTexture;
    /** What currently lives in `imageTex` — an image's href+generation, or a text raster's key. */
    imageKey: string | null;
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
        hasImageLoc: gl.getUniformLocation(program, "u_hasImage")
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
    image: { href: string; x: number; y: number; width: number; height: number } | null;
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

function draw(rings: Ring[], world: Mat2D | null, css: string, opacity: number | null,
              image?: { href: string; x: number; y: number; width: number; height: number } | null,
              text?: TextShape | null,
              surface?: {
                  normal: (x: number, y: number) => { x: number; y: number; z: number };
                  cell: number;
                  /** Null when there is no relief; the shader is then told to skip the march. */
                  height: HeightTexture | null;
              }): Draw | null {
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
    return { vertices, normals, locals, height: surface?.height ?? null, image: image ?? null, text: text ?? null, color };
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

export function itemDraws(item: DrawItem, tolerance: number = FLATTEN_TOLERANCE): Draw[] {
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
        const fill = draw(resolveRings(commandsToRings(local, tolerance), paint.fillRule ?? "nonzero"),
            item.world, paint.fill, paint.opacity, null, null, surface);
        if (fill) out.push(fill);
    }
    // AN IMAGE has no fill and is drawn from its own pixels. Its rect is already the geometry that
    // `shapeToLocalCommands` produced, so this is the same triangles with a texture over them —
    // and it is lit and shadowed by the same arithmetic as everything else, which is the point of
    // putting it through the fragment shader rather than blitting it.
    if (isRaster && item.shape.kind === "image" && item.shape.href !== null) {
        const rect = item.shape;
        const picture = draw(resolveRings(commandsToRings(local, tolerance), "nonzero"),
            item.world, "#ffffff", paint.opacity,
            { href: rect.href!, x: rect.x, y: rect.y, width: rect.width, height: rect.height }, null, surface);
        if (picture) out.push(picture);
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
        const rings = strokeOutline(local, {
            width: paint.strokeWidth,
            join: paint.strokeJoin, cap: paint.strokeCap, miterLimit: paint.strokeMiterLimit
        }, tolerance);
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
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
    for (const item of [...list.grid.lines, ...list.content, ...list.overlay]) {
        for (const d of itemDraws(item, itemTolerance(item, viewScale))) {
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
            if (d.image) {
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
                    // NPOT-safe: linear filtering with clamped wrapping needs no mipmaps, which a
                    // non-power-of-two texture cannot have in WebGL 1. No Y flip — texel row 0 is
                    // the source's top row, and `v_local` counts down from the rect's top too, so
                    // the two already agree.
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    state.imageKey = texKey;
                }
                gl.uniform1i(state.imageLoc, 1);
                gl.uniform4f(state.imgRectLoc, rect.x, rect.y, rect.width, rect.height);
                gl.uniform1f(state.hasImageLoc, 1);
            } else {
                gl.uniform1f(state.hasImageLoc, 0);
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.uniform1f(zLoc, depthToClipZ(item.depth ?? 0));
            gl.uniform4fv(colorLoc, d.color);
            gl.drawArrays(gl.TRIANGLES, 0, d.vertices.length / 2);
        }
    }
    return true;
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
