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
import { Mat2D } from "../core/geometry/Matrix";
import { Ring, commandsToRings } from "../core/geometry/PathBoolean";
import { triangulate } from "../core/geometry/Tessellate";
import { strokeOutline } from "../core/geometry/StrokeOutline";
import { ellipseCommands, rectCommands, transformCommands } from "../core/geometry/ShapeToPath";
import { PathCommand } from "../core/document/Node";

const VERTEX_SHADER = `
attribute vec2 a_pos;
uniform mat3 u_view;
void main() {
    vec3 p = u_view * vec3(a_pos, 1.0);
    gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 u_color;
void main() { gl_FragColor = u_color; }`;

/** Everything a frame needs, built once per canvas and cached on it. */
interface GLState {
    gl: WebGLRenderingContext;
    program: WebGLProgram;
    buffer: WebGLBuffer;
    posLoc: number;
    viewLoc: WebGLUniformLocation | null;
    colorLoc: WebGLUniformLocation | null;
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
    if (!vs || !fs || !program || !buffer) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    return {
        gl, program, buffer,
        posLoc: gl.getAttribLocation(program, "a_pos"),
        viewLoc: gl.getUniformLocation(program, "u_view"),
        colorLoc: gl.getUniformLocation(program, "u_color")
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
        case "rect": return rectCommands(shape.width, shape.height, radius ?? 0).map(c =>
            c.c === "Z" ? c : { ...c, x: c.x + shape.x, y: c.y + shape.y });
        case "ellipse": return ellipseCommands(shape.rx * 2, shape.ry * 2).map(c =>
            c.c === "Z" ? c : { ...c, x: c.x + shape.cx - shape.rx, y: c.y + shape.cy - shape.ry });
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
    color: [number, number, number, number];
}

function draw(rings: Ring[], world: Mat2D | null, css: string, opacity: number | null): Draw | null {
    const color = parseColor(css);
    if (!color) return null;                      // not a colour it can parse: skip, never guess
    const placed = world ? rings.map(r => transformRing(r, world)) : rings;
    const vertices = triangulate(placed);
    if (vertices.length === 0) return null;
    if (opacity !== null) color[3] *= opacity;    // MULTIPLY — one blend, not two
    return { vertices, color };
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
export function itemDraws(item: DrawItem): Draw[] {
    const paint = item.paint;
    const local = shapeToLocalCommands(item.shape, paint.radius);
    if (!local) return [];
    const out: Draw[] = [];
    if (paint.fill !== null) {
        const fill = draw(commandsToRings(local), item.world, paint.fill, paint.opacity);
        if (fill) out.push(fill);
    }
    if (paint.stroke !== null && paint.strokeWidth !== null && paint.strokeWidth > 0) {
        const rings = strokeOutline(local, {
            width: paint.strokeWidth,
            join: paint.strokeJoin, cap: paint.strokeCap, miterLimit: paint.strokeMiterLimit
        });
        const stroke = draw(rings, item.world, paint.stroke, paint.opacity);
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
    const { gl, program, buffer, posLoc, viewLoc, colorLoc } = state;

    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.102, 0.102, 0.180, 1);          // the same #1a1a2e both other backends use
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);
    gl.uniformMatrix3fv(viewLoc, false, viewMatrix(width, height, vp.x * dpr, vp.y * dpr, vp.zoom * dpr));
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Grid, then content, then overlay — the same order the other backends paint in, because the
    // display list's order IS the z-order and a GPU has no depth buffer here to recover it from.
    for (const item of [...list.grid.lines, ...list.content, ...list.overlay]) {
        for (const d of itemDraws(item)) {
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d.vertices), gl.DYNAMIC_DRAW);
            gl.uniform4fv(colorLoc, d.color);
            gl.drawArrays(gl.TRIANGLES, 0, d.vertices.length / 2);
        }
    }
    return true;
}
