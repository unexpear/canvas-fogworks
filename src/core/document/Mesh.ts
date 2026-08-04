/**
 * @module Mesh
 * @description Bending a shape — a grid of control points, and the outline that follows them.
 *
 * Every shape in this engine has been rigid until now. A rectangle is a rectangle wherever you put
 * it; the only things that could change it were its own numbers. A MESH is the tool that makes a
 * shape bend: a grid laid over its box, whose points you drag, with the outline following. It is
 * the envelope/warp every serious vector editor has, and it is the thing normals and lighting will
 * later hang off — a flat shape has nothing to light.
 *
 * The deformation is BILINEAR per cell. Each cell of the grid is a quad with four control points,
 * and a point inside it is placed by blending those four by how far across and down it sits. The
 * alternatives are smoother — a Coons patch, a bicubic — and every one of them is a larger amount
 * of arithmetic to get a difference that only shows on a coarse grid, which is the case a user
 * fixes by adding a row. Bilinear is exact AT the control points, which is the property a person
 * dragging one actually checks.
 *
 * CONTROL POINTS ARE FRACTIONS OF THE BOX (schema 43), not local units. `{x: 0.5, y: 1}` is the
 * middle of the bottom edge whatever size the node is. That is not a storage detail — it is what
 * makes a mesh survive a RESIZE. Stored in absolute units, as they were, the points said where the
 * grid sat when it was made while the rest positions were still implied by the CURRENT box, so the
 * two disagreed the moment the box changed: an untouched mesh stopped being the identity and
 * pinned the shape to its old size, and resizing a warped node did nothing to the drawing at all.
 *
 * Rescaling the points inside the resize action would not have fixed it, and that is worth saying
 * because it is the obvious alternative. A node's size is COMPUTED in several paths that are not
 * actions — auto-layout, hug sizing, constraints — so there is no single place to hook. A mesh
 * defined relative to its box needs no hook.
 *
 * HEIGHT (`z`) stays ABSOLUTE, in the same units as `depth`: it is a distance above the page
 * rather than a fraction of anything, and a page has no width to be a fraction of.
 *
 * A warped shape becomes an ordinary `core.path`, resolved at the display seam like a boolean or
 * an instance. That is the whole reason this costs so little: picking, marquee selection,
 * snapping, tessellation, the decomposition and all three backends see a path and need to know
 * nothing about meshes. It also means a warp is CLICKABLE where it is drawn, which a deformation
 * applied in a renderer could never be.
 *
 * CURVES are flattened first, and that is a real loss stated rather than hidden: a cubic pushed
 * through a bilinear warp is not a cubic, so preserving it would mean re-fitting curves to the
 * warped points — a larger piece of work whose error is harder to state than the flattener's,
 * which is a stated tolerance. The same trade the booleans and the stroke outliner already make.
 */

import { PathCommand } from "./Node";

/** Grid size a mesh may declare. Bounded: the point count is the product, and it is hand-editable. */
export const MESH_MAX_DIVISIONS = 64;

/**
 * The READ-ONLY view of a mesh.
 *
 * The derivations run on a `DeepReadonly` document, so every function here that only READS a mesh
 * takes this rather than `Mesh` — otherwise each call site would need a cast, and a cast at a
 * boundary is how a readonly guarantee stops meaning anything.
 */
export interface ReadonlyMesh {
    readonly cols: number;
    readonly rows: number;
    readonly points: readonly { readonly x: number; readonly y: number; readonly z?: number }[];
}

export interface Mesh {
    /** Cells across and down. A 1x1 mesh is four corner points — the simplest warp there is. */
    cols: number;
    rows: number;
    /**
     * Control points as FRACTIONS OF THE BOX, row-major, `(cols + 1) * (rows + 1)` of them.
     *
     * They hold the DEFORMED positions, and a point may sit outside `[0, 1]` — dragging a corner
     * beyond the box is an ordinary thing to do. The undeformed grid is `col/cols, row/rows`
     * whatever the box is, so an untouched mesh is the identity at EVERY size and is detected as
     * one rather than applied. That is the property absolute units could not have.
     *
     * `z` is HEIGHT, absent = 0, and it is what turns this grid into a SURFACE. A warp alone is
     * in-plane, so it tilts nothing and every normal it could produce would point straight at the
     * viewer — there would be nothing for a light to find. Raising a control point gives the mesh
     * somewhere to face, and the outline is unaffected: `warpPoint` still reads only x and y, so
     * a heightfield changes how a shape is LIT without changing what it covers.
     */
    points: { x: number; y: number; z?: number }[];
}

export function meshError(mesh: unknown): string | null {
    if (mesh === undefined) return null;
    if (typeof mesh !== "object" || mesh === null || Array.isArray(mesh)) return "mesh must be an object";
    const m = mesh as Partial<Mesh>;
    for (const [name, value] of [["cols", m.cols], ["rows", m.rows]] as const) {
        if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MESH_MAX_DIVISIONS) {
            return `mesh.${name} must be a whole number within [1, ${MESH_MAX_DIVISIONS}]`;
        }
    }
    if (!Array.isArray(m.points)) return "mesh.points must be an array";
    const expected = ((m.cols as number) + 1) * ((m.rows as number) + 1);
    // The count is DERIVED from the grid, so a mismatch is not a detail — every lookup below
    // indexes by row and column, and a short array would read undefined as a coordinate.
    if (m.points.length !== expected) return `mesh.points must hold exactly ${expected} points for a ${m.cols}x${m.rows} mesh`;
    for (const p of m.points) {
        if (typeof p !== "object" || p === null || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            return "mesh.points must all be finite {x, y} points";
        }
        if (p.z !== undefined && !Number.isFinite(p.z)) return "mesh.points z must be finite when present";
    }
    return null;
}

/** Where a control point sits when nothing has been dragged — the grid the box implies. */
export function restPoint(mesh: { cols: number; rows: number }, col: number, row: number): { x: number; y: number } {
    return { x: col / mesh.cols, y: row / mesh.rows };
}

/** Is every point still at rest? Then the mesh is the identity and applying it would be a no-op. */
export function isIdentityMesh(mesh: ReadonlyMesh): boolean {
    const EPS = 1e-9;
    for (let row = 0; row <= mesh.rows; row++) {
        for (let col = 0; col <= mesh.cols; col++) {
            const p = mesh.points[row * (mesh.cols + 1) + col];
            const rest = restPoint(mesh, col, row);
            if (Math.abs(p.x - rest.x) > EPS || Math.abs(p.y - rest.y) > EPS) return false;
        }
    }
    return true;
}

/**
 * Where a local-space point lands once the mesh has bent the shape.
 *
 * Points OUTSIDE the box are clamped to its edge cells rather than extrapolated. A shape's own
 * outline can stray outside its box — a stroke does, and a path's ink is not obliged to fit —
 * and extrapolating a bilinear patch beyond its corners diverges fast, so a slightly overhanging
 * outline would be flung across the canvas instead of following the edge it is near.
 */
export function warpPoint(mesh: ReadonlyMesh, box: { width: number; height: number }, x: number, y: number): { x: number; y: number } {
    const u = box.width === 0 ? 0 : Math.max(0, Math.min(1, x / box.width));
    const v = box.height === 0 ? 0 : Math.max(0, Math.min(1, y / box.height));
    // The cell this point is in, and how far across it sits. `min` keeps u = 1 inside the LAST
    // cell rather than indexing one past the end of the grid.
    const col = Math.min(mesh.cols - 1, Math.floor(u * mesh.cols));
    const row = Math.min(mesh.rows - 1, Math.floor(v * mesh.rows));
    const fu = u * mesh.cols - col;
    const fv = v * mesh.rows - row;
    const at = (c: number, r: number) => mesh.points[r * (mesh.cols + 1) + c];
    const p00 = at(col, row), p10 = at(col + 1, row), p01 = at(col, row + 1), p11 = at(col + 1, row + 1);
    const top = { x: p00.x + (p10.x - p00.x) * fu, y: p00.y + (p10.y - p00.y) * fu };
    const bottom = { x: p01.x + (p11.x - p01.x) * fu, y: p01.y + (p11.y - p01.y) * fu };
    // Back into LOCAL units. The points are FRACTIONS of the box (schema 43), so the box enters
    // here and only here — which is what makes a resize carry the warp with it.
    return { x: (top.x + (bottom.x - top.x) * fv) * box.width,
             y: (top.y + (bottom.y - top.y) * fv) * box.height };
}

/**
 * A rest-grid mesh for a box — what a user starts from before dragging anything.
 *
 * Exported because the editor needs to CREATE one, and a mesh built by hand somewhere else would
 * be a second definition of where the grid starts.
 */
export function restMesh(cols: number, rows: number): Mesh {
    const points: { x: number; y: number }[] = [];
    for (let row = 0; row <= rows; row++) {
        for (let col = 0; col <= cols; col++) points.push(restPoint({ cols, rows }, col, row));
    }
    return { cols, rows, points };
}

/**
 * Path commands with every point warped — the flattened outline the mesh has bent.
 *
 * Straight `L` segments are SUBDIVIDED before warping, because a warp bends the space between two
 * points and a segment that kept its ends would cut the corner off the bend. The subdivision is
 * the grid's own resolution: a segment crossing three cells is cut at least three times, since
 * that is exactly where the bilinear patch changes and no more detail than that can exist.
 */
export function warpCommands(commands: readonly PathCommand[], box: { width: number; height: number },
                             mesh: ReadonlyMesh, flatten: (c: readonly PathCommand[]) => { points: { x: number; y: number }[]; closed: boolean }[]): PathCommand[] {
    const out: PathCommand[] = [];
    const divisions = Math.max(mesh.cols, mesh.rows);
    for (const sub of flatten(commands)) {
        const pts = sub.points;
        if (pts.length === 0) continue;
        const warped: { x: number; y: number }[] = [];
        const last = sub.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < last; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            // Cut each segment at the grid's resolution, so a straight edge crossing a bend
            // follows it instead of chording across it.
            for (let s = 0; s < divisions; s++) {
                const t = s / divisions;
                warped.push(warpPoint(mesh, box, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
            }
        }
        if (!sub.closed) warped.push(warpPoint(mesh, box, pts[pts.length - 1].x, pts[pts.length - 1].y));
        if (warped.length < 2) continue;
        out.push({ c: "M", x: warped[0].x, y: warped[0].y });
        for (let i = 1; i < warped.length; i++) out.push({ c: "L", x: warped[i].x, y: warped[i].y });
        if (sub.closed) out.push({ c: "Z" });
    }
    return out;
}

/** A control point's height. Absent = 0, the plane of the shape. */
export function heightOf(p: { z?: number }): number {
    return p.z ?? 0;
}

/**
 * The surface normal at a local-space point, UN-NORMALISED — the raw cross product of the two
 * tangents, kept at whatever length the surface gives it.
 *
 * The length is not laziness, it is the entire reason this is separate from `normalAt`. Between
 * two vertices a GPU interpolates LINEARLY, so a value survives that trip intact only if it is
 * affine over the triangle. Inside one cell the patch is `P = A + Bu + Cv + Duv`, so its tangents
 * are `∂u = B + Dv` and `∂v = C + Du`, and their cross product is
 *
 *     (B + Dv) × (C + Du) = B×C + u(B×D) + v(D×C)
 *
 * — the `uv` term cancels against itself, leaving something AFFINE in `u` and `v`. Interpolating
 * that and normalising per fragment reproduces the surface's own normal exactly. Normalising first
 * does not: scaling each vertex's vector to length 1 is a nonlinear step, and what interpolates
 * afterwards is a different function that meets the truth only at the corners. That gap is the
 * faceting you can see along triangle edges on a smoothly domed shape.
 *
 * The tangents are DIVIDED BY THEIR STEP for the same reason. The samples are clamped inside the
 * box, so at an edge the step is half what it is inland; leaving that in would make the vector's
 * length depend on where it was sampled rather than on the surface, and the affine argument above
 * would hold everywhere except the rim, which is where shapes mostly are.
 *
 * Zero length is possible and is left as zero: two control points dragged onto each other collapse
 * a cell, and there genuinely is no surface there to face anywhere. Callers say what to do about
 * it — `normalAt` answers straight at the viewer, the GPU path substitutes a flat normal rather
 * than asking a shader to normalise a zero vector into NaN.
 */
export function surfaceNormal(mesh: ReadonlyMesh, box: { width: number; height: number }, x: number, y: number): { x: number; y: number; z: number } {
    // A step small enough to stay inside one cell of any grid this bounds allows, and large
    // enough that the difference is not lost to rounding. Inside a cell the patch is bilinear, so
    // a difference over this span is not an approximation of the tangent — it is the tangent.
    const du = Math.max(box.width, 1) / (mesh.cols * 512);
    const dv = Math.max(box.height, 1) / (mesh.rows * 512);
    const at = (px: number, py: number) => {
        const p = warpPoint(mesh, box, px, py);
        return { x: p.x, y: p.y, z: warpHeight(mesh, box, px, py) };
    };
    // CENTRED differences, with the samples clamped INSIDE the box. A one-sided step is wrong
    // exactly where it matters most: at the box edge it lands outside, `warpPoint` clamps it back
    // to the same place, and the tangent collapses to zero — so every CORNER of a shape reported
    // itself flat, which is most of the vertices a rectangle has.
    const x0 = Math.max(0, x - du), x1 = Math.min(box.width, x + du);
    const y0 = Math.max(0, y - dv), y1 = Math.min(box.height, y + dv);
    const sx = x1 - x0, sy = y1 - y0;
    if (sx === 0 || sy === 0) return { x: 0, y: 0, z: 0 };   // a box with no width or no height
    const ax = at(x1, y), bx = at(x0, y);
    const ay = at(x, y1), by = at(x, y0);
    const t1 = { x: (ax.x - bx.x) / sx, y: (ax.y - bx.y) / sx, z: (ax.z - bx.z) / sx };
    const t2 = { x: (ay.x - by.x) / sy, y: (ay.y - by.y) / sy, z: (ay.z - by.z) / sy };
    const n = {
        x: t1.y * t2.z - t1.z * t2.y,
        y: t1.z * t2.x - t1.x * t2.z,
        z: t1.x * t2.y - t1.y * t2.x
    };
    // Always toward the VIEWER. The cross product's sign follows the winding of the parameter
    // grid, and a normal that flipped with it would light half the shapes from behind.
    return n.z < 0 ? { x: -n.x, y: -n.y, z: -n.z } : n;
}

/**
 * The surface normal at a local-space point, as a UNIT vector.
 *
 * The grid gives a surface `P(u, v) = (x, y, z)`, and a normal is the cross product of its two
 * tangents. Both tangents come from the same bilinear patch `warpPoint` uses, so the direction a
 * light sees and the outline a click tests are two readings of ONE surface rather than two
 * descriptions that could disagree.
 *
 * A FLAT mesh returns exactly (0, 0, 1) — straight at the viewer — which is what an unlit-looking
 * shape needs, and it is exact rather than nearly so, because a lighting term multiplied by a
 * normal that was almost normalised is how a flat fill acquires a faint gradient nobody asked for.
 */
export function normalAt(mesh: ReadonlyMesh, box: { width: number; height: number }, x: number, y: number): { x: number; y: number; z: number } {
    const n = surfaceNormal(mesh, box, x, y);
    const len = Math.hypot(n.x, n.y, n.z);
    if (len === 0) return { x: 0, y: 0, z: 1 };
    return { x: n.x / len, y: n.y / len, z: n.z / len };
}

/** Height at a local-space point — the same bilinear blend `warpPoint` does, on z. */
export function warpHeight(mesh: ReadonlyMesh, box: { width: number; height: number }, x: number, y: number): number {
    const u = box.width === 0 ? 0 : Math.max(0, Math.min(1, x / box.width));
    const v = box.height === 0 ? 0 : Math.max(0, Math.min(1, y / box.height));
    const col = Math.min(mesh.cols - 1, Math.floor(u * mesh.cols));
    const row = Math.min(mesh.rows - 1, Math.floor(v * mesh.rows));
    const fu = u * mesh.cols - col;
    const fv = v * mesh.rows - row;
    const at = (c: number, r: number) => heightOf(mesh.points[r * (mesh.cols + 1) + c]);
    const top = at(col, row) + (at(col + 1, row) - at(col, row)) * fu;
    const bottom = at(col, row + 1) + (at(col + 1, row + 1) - at(col, row + 1)) * fu;
    return top + (bottom - top) * fv;
}

/**
 * The tallest and lowest the surface gets.
 *
 * Read off the CONTROL POINTS rather than by sampling, and that is exact rather than approximate:
 * a bilinear patch is a blend of its four corners, so no point inside a cell is higher than the
 * highest of them. What bounds the ray march is therefore the grid itself.
 */
export function heightRange(mesh: ReadonlyMesh): { min: number; max: number } {
    let min = Infinity, max = -Infinity;
    for (const p of mesh.points) {
        const h = heightOf(p);
        if (h < min) min = h;
        if (h > max) max = h;
    }
    return mesh.points.length === 0 ? { min: 0, max: 0 } : { min, max };
}

/** Is every height still zero? Then the mesh is flat and lighting it would find nothing. */
export function isFlatMesh(mesh: ReadonlyMesh): boolean {
    return mesh.points.every(p => heightOf(p) === 0);
}
