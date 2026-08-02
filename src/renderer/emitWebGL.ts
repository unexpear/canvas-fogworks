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
 * DELIBERATE GAPS, stated rather than discovered later. This backend draws FILLS:
 *   - TEXT and IMAGES are not drawn at all. Both need a texture path (a glyph atlas, an image
 *     upload) that is its own piece of work, and pretending otherwise would mean a document that
 *     silently loses content when the backend is switched.
 *   - STROKES are drawn only for `line` shapes (as a quad). Stroking an arbitrary outline means
 *     offsetting it — a separate algorithm with its own joins and caps — and an approximation
 *     would be visibly wrong at corners.
 *   - EFFECTS (shadow, blur) and dashes are ignored; those are per-fragment work needing render
 *     targets.
 * The app offers this backend as a preview and says so, because a backend that quietly drops
 * content is worse than one that admits what it cannot do.
 */

import { DisplayList, DrawItem, Shape } from "./RenderModel";
import { Mat2D } from "../core/geometry/Matrix";
import { Ring, commandsToRings } from "../core/geometry/PathBoolean";
import { triangulate } from "../core/geometry/Tessellate";
import { ellipseCommands, rectCommands, transformCommands } from "../core/geometry/ShapeToPath";

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
 * A shape as world-space RINGS, or null when this backend does not draw it.
 *
 * Every conversion here is one the engine already owns — an ellipse is `ellipseCommands`, a
 * rectangle is `rectCommands` (rounded corners included), a path is its own commands — so the
 * GPU fills exactly the outline that picking tests and booleans cut. A fourth private idea of
 * "what shape is this" is the drift this codebase keeps designing out.
 */
export function shapeToWorldRings(shape: Shape, world: Mat2D | null, radius: number | null, strokeWidth: number | null): Ring[] | null {
    let commands;
    switch (shape.kind) {
        case "rect": commands = rectCommands(shape.width, shape.height, radius ?? 0).map(c =>
            c.c === "Z" ? c : { ...c, x: c.x + shape.x, y: c.y + shape.y }); break;
        case "ellipse": commands = ellipseCommands(shape.rx * 2, shape.ry * 2).map(c =>
            c.c === "Z" ? c : { ...c, x: c.x + shape.cx - shape.rx, y: c.y + shape.cy - shape.ry }); break;
        case "path": commands = [...shape.commands]; break;
        case "line": {
            // A line has no interior, so its STROKE is the shape: a quad of `strokeWidth` about
            // the segment. Zero-length lines and zero widths produce nothing rather than a
            // degenerate sliver.
            const w = strokeWidth ?? 1;
            const dx = shape.x2 - shape.x1, dy = shape.y2 - shape.y1;
            const len = Math.hypot(dx, dy);
            if (len === 0 || w <= 0) return null;
            const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
            const ring: Ring = [
                { x: shape.x1 + nx, y: shape.y1 + ny }, { x: shape.x2 + nx, y: shape.y2 + ny },
                { x: shape.x2 - nx, y: shape.y2 - ny }, { x: shape.x1 - nx, y: shape.y1 - ny }
            ];
            return [world ? transformRing(ring, world) : ring];
        }
        // Text and images need a texture path this backend does not have; see the module note.
        default: return null;
    }
    const placed = world ? transformCommands(world, commands) : commands;
    return commandsToRings(placed);
}

function transformRing(ring: Ring, m: Mat2D): Ring {
    return ring.map(p => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }));
}

/**
 * The triangles and colour one item contributes, or null when it draws nothing.
 *
 * Pure, and exported for exactly that reason: this is where a shape becomes geometry, so it is
 * the part worth testing in the `node` environment. What is left in `emitWebGL` below is buffer
 * uploads and draw calls, which only a GPU can answer for.
 */
export function itemTriangles(item: DrawItem): { vertices: number[]; color: [number, number, number, number] } | null {
    const paint = item.paint;
    // An OUTLINE item carries `fill: "none"` (the selection frame). It is skipped — with no
    // stroking, filling it would paint a solid block over the shape it is meant to outline —
    // but NOT by a separate test for the string: `parseColor` already refuses anything that is
    // not a hex colour, and a second check for "none" was provably equivalent to nothing.
    const source = item.shape.kind === "line" ? paint.stroke : paint.fill;
    if (source === null) return null;
    const color = parseColor(source);
    if (!color) return null;
    const rings = shapeToWorldRings(item.shape, item.world, paint.radius, paint.strokeWidth);
    if (!rings || rings.length === 0) return null;
    const vertices = triangulate(rings);
    if (vertices.length === 0) return null;
    if (paint.opacity !== null) color[3] *= paint.opacity;
    return { vertices, color };
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
        const tri = itemTriangles(item);
        if (!tri) continue;
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tri.vertices), gl.DYNAMIC_DRAW);
        gl.uniform4fv(colorLoc, tri.color);
        gl.drawArrays(gl.TRIANGLES, 0, tri.vertices.length / 2);
    }
    return true;
}
