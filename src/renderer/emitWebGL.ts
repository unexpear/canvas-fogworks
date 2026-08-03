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
 *   - TEXT and IMAGES are not drawn at all. Both need a texture path (a glyph atlas, an image
 *     upload) that is its own piece of work, and pretending otherwise would mean a document that
 *     silently loses content when the backend is switched.
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

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec3 a_normal;
attribute float a_shadow;
uniform mat3 u_view;
uniform float u_z;
varying vec3 v_normal;
varying float v_shadow;
void main() {
    vec3 p = u_view * vec3(a_pos, 1.0);
    // The normal is passed through UNTRANSFORMED and UN-NORMALISED. Untransformed because it is a
    // direction in the document's own axes and the view matrix is a pan and a zoom — neither of
    // which turns a surface, so transforming it would only make the lighting swim as you scrolled.
    // Un-normalised because this varying is about to be interpolated, and only the raw vector is
    // affine across a cell; normalising here would bake the faceting back in before the fragment
    // shader ever saw it.
    v_normal = a_normal;
    // Whether this vertex can SEE the key light, marched on the CPU through the mesh's own
    // heightfield. Interpolated, which is honest about what it is: a per-vertex answer to a
    // question that is genuinely discontinuous. Per fragment needs the heightfield in the
    // shader, which needs the texture path this renderer still does not have.
    v_shadow = a_shadow;
    // z comes from the node's DEPTH, not from the draw order — that is what makes the depth
    // buffer do the deciding rather than the sequence of draw calls.
    gl_Position = vec4(p.xy, u_z, 1.0);
}`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 v_normal;
varying float v_shadow;
uniform vec4 u_color;
uniform float u_ambient;
uniform int u_lightCount;
uniform vec3 u_lightDir[4];
uniform vec3 u_lightColor[4];
void main() {
    // PER FRAGMENT, which is the whole reason the vertex stage hands over a raw vector. What
    // arrives here is the interpolation of three un-normalised normals, and inside one cell of the
    // mesh that interpolation is exact — so normalising it now yields the surface's own normal at
    // this pixel rather than a blend of three corner normals that only agrees at the corners.
    vec3 n = normalize(v_normal);
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
        lit += u_lightColor[i] * d * (i == 0 ? v_shadow : 1.0);
    }
    // The colour is MODULATED, never replaced: a lit red shape is a darker or brighter red, and a
    // model that added light instead would wash every hue toward the light's own.
    gl_FragColor = vec4(u_color.rgb * lit, u_color.a);
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
    shadowBuffer: WebGLBuffer;
    posLoc: number;
    viewLoc: WebGLUniformLocation | null;
    colorLoc: WebGLUniformLocation | null;
    zLoc: WebGLUniformLocation | null;
    normalLoc: number;
    shadowLoc: number;
    ambientLoc: WebGLUniformLocation | null;
    lightCountLoc: WebGLUniformLocation | null;
    lightDirLoc: WebGLUniformLocation | null;
    lightColorLoc: WebGLUniformLocation | null;
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
    const shadowBuffer = gl.createBuffer();
    if (!vs || !fs || !program || !buffer || !normalBuffer || !shadowBuffer) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    return {
        gl, program, buffer, normalBuffer, shadowBuffer,
        posLoc: gl.getAttribLocation(program, "a_pos"),
        viewLoc: gl.getUniformLocation(program, "u_view"),
        colorLoc: gl.getUniformLocation(program, "u_color"),
        zLoc: gl.getUniformLocation(program, "u_z"),
        normalLoc: gl.getAttribLocation(program, "a_normal"),
        shadowLoc: gl.getAttribLocation(program, "a_shadow"),
        ambientLoc: gl.getUniformLocation(program, "u_ambient"),
        lightCountLoc: gl.getUniformLocation(program, "u_lightCount"),
        lightDirLoc: gl.getUniformLocation(program, "u_lightDir"),
        lightColorLoc: gl.getUniformLocation(program, "u_lightColor")
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
        // Text and images need a texture path this backend does not have; see the module note.
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
     * One per VERTEX: 1 = this point can see the key light, 0 = something on the surface is in the
     * way. Empty when the item has no surface or the scene has no light — there is nothing to
     * occlude and nothing to be occluded from.
     *
     * The answer a normal cannot give. A crease beside a raised edge may face the light squarely
     * and still be dark, because the edge is between it and the light; see `geometry/RayMarch`.
     */
    shadow: number[];
    color: [number, number, number, number];
}

/**
 * "Can this point see the key light?", for one surface — or null when the answer is always yes.
 *
 * Null rather than a function returning `false` everywhere, because the caller uses it to decide
 * whether to ALLOCATE a per-vertex array at all. The three cases that can cast nothing are worth
 * separating out here rather than paying for a march that is bound to answer no: no light, a
 * surface with no relief, and a light at or below the horizon (whose faces `lambert` has already
 * taken to zero).
 *
 * The march runs on the CPU, once per vertex, using the SAME `warpHeight` that shaped the outline
 * — so what the shadow is cast by and what the shape looks like cannot disagree.
 */
function occluderFor(surface: { mesh: ReadonlyMesh; box: { width: number; height: number } },
                     keyLight: Light | undefined): ((x: number, y: number) => boolean) | null {
    if (!keyLight) return null;
    const dir = normalize(keyLight);
    // `light` stores the direction the light TRAVELS, and the march walks TOWARD the light.
    if (!dir) return null;
    const toLight = { x: -dir.x, y: -dir.y, z: -dir.z };
    if (toLight.z <= 0) return null;
    const { max } = heightRange(surface.mesh);
    if (max <= 0) return null;                    // no relief: nothing stands up to block anything
    const height = (x: number, y: number) => warpHeight(surface.mesh, surface.box, x, y);
    return (x: number, y: number) => marchOccluded(height, x, y, toLight, max);
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
              surface?: {
                  normal: (x: number, y: number) => { x: number; y: number; z: number };
                  cell: number;
                  /** Null when nothing can cast: a flat surface, or a scene with no key light. */
                  occluded: ((x: number, y: number) => boolean) | null;
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
    const march = surface?.occluded ?? null;
    const shadow = march ? new Array<number>(local.length / 2) : [];
    for (let i = 0, n = 0; i < local.length; i += 2, n += 3) {
        const lx = local[i], ly = local[i + 1];
        const nrm = surface ? vertexNormal(surface.normal(lx, ly)) : FLAT_NORMAL;
        normals[n] = nrm.x; normals[n + 1] = nrm.y; normals[n + 2] = nrm.z;
        if (march) shadow[i / 2] = march(lx, ly) ? 0 : 1;
        vertices[i] = world ? world.a * lx + world.c * ly + world.e : lx;
        vertices[i + 1] = world ? world.b * lx + world.d * ly + world.f : ly;
    }
    if (opacity !== null) color[3] *= opacity;    // MULTIPLY — one blend, not two
    return { vertices, normals, shadow, color };
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

export function itemDraws(item: DrawItem, tolerance: number = FLATTEN_TOLERANCE,
                          keyLight?: Light): Draw[] {
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
            occluded: occluderFor(item.surface, keyLight)
        }
        : undefined;
    if (paint.fill !== null) {
        // RESOLVED first, which does two jobs at once. It applies the document's fill rule — the
        // GPU has no `fill-rule` to hand to, unlike the other two backends, so the rule has to
        // become geometry here. And it makes the rings simple, which ear clipping requires: a
        // self-crossing path used to come out as overlapping triangles on this backend and as
        // the right shape on the other two.
        const fill = draw(resolveRings(commandsToRings(local, tolerance), paint.fillRule ?? "nonzero"),
            item.world, paint.fill, paint.opacity, surface);
        if (fill) out.push(fill);
    }
    if (paint.stroke !== null && paint.strokeWidth !== null && paint.strokeWidth > 0) {
        const rings = strokeOutline(local, {
            width: paint.strokeWidth,
            join: paint.strokeJoin, cap: paint.strokeCap, miterLimit: paint.strokeMiterLimit
        }, tolerance);
        const stroke = draw(rings, item.world, paint.stroke, paint.opacity, surface);
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
        for (const d of itemDraws(item, itemTolerance(item, viewScale), list.lights?.[0])) {
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d.vertices), gl.DYNAMIC_DRAW);
            gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
            // Normals ride in their own buffer rather than interleaved: the position buffer is
            // re-uploaded per draw already, and two small uploads are simpler to reason about
            // than one strided one whose layout has to be kept in step by hand.
            gl.bindBuffer(gl.ARRAY_BUFFER, state.normalBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d.normals), gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(state.normalLoc);
            gl.vertexAttribPointer(state.normalLoc, 3, gl.FLOAT, false, 0, 0);
            // The SHADOW term. A draw with no surface ships none, and every vertex is then fully
            // lit — set as a constant attribute rather than uploading a buffer of ones, which is
            // one call instead of one allocation per shape per frame.
            if (d.shadow.length > 0) {
                gl.bindBuffer(gl.ARRAY_BUFFER, state.shadowBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d.shadow), gl.DYNAMIC_DRAW);
                gl.enableVertexAttribArray(state.shadowLoc);
                gl.vertexAttribPointer(state.shadowLoc, 1, gl.FLOAT, false, 0, 0);
            } else {
                gl.disableVertexAttribArray(state.shadowLoc);
                gl.vertexAttrib1f(state.shadowLoc, 1);
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
