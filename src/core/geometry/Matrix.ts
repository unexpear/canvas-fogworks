/**
 * @module Matrix
 * @description 2D affine transforms — the primitive Milestone 1 is built on.
 *
 * A `Mat2D` is the standard 6-value affine matrix, laid out the same way SVG and
 * Canvas expect it (`matrix(a b c d e f)`), so a computed matrix can be handed to a
 * renderer without conversion:
 *
 *     | a  c  e |     x' = a·x + c·y + e
 *     | b  d  f |     y' = b·x + d·y + f
 *     | 0  0  1 |
 *
 * Pure and allocation-light: every function returns a new value and mutates nothing,
 * so a computed matrix can be cached and shared without the aliasing hazard that bit
 * the history layer.
 */

export interface Mat2D {
    a: number; b: number; c: number; d: number; e: number; f: number;
}

export const IDENTITY: Mat2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** A rectangle in some coordinate space. */
export interface Rect { x: number; y: number; width: number; height: number; }

/**
 * `outer ∘ inner` — apply `inner` first, then `outer`.
 *
 * Order matters and is the classic source of transform bugs, so it is fixed by the
 * name: composing a child into its parent is `multiply(parentWorld, childLocal)`.
 */
export function multiply(outer: Mat2D, inner: Mat2D): Mat2D {
    return {
        a: outer.a * inner.a + outer.c * inner.b,
        b: outer.b * inner.a + outer.d * inner.b,
        c: outer.a * inner.c + outer.c * inner.d,
        d: outer.b * inner.c + outer.d * inner.d,
        e: outer.a * inner.e + outer.c * inner.f + outer.e,
        f: outer.b * inner.e + outer.d * inner.f + outer.f
    };
}

export function translation(tx: number, ty: number): Mat2D {
    return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

/**
 * Local transform for a node: translate to its position, then rotate/scale about a
 * pivot expressed in the node's own box.
 *
 * @param rotation radians
 * @param pivotX/pivotY the pivot in LOCAL coordinates (i.e. already resolved from the
 *   node's normalized origin and its size), so this function stays geometry-agnostic.
 */
export function compose(
    x: number, y: number,
    rotation: number,
    scaleX: number, scaleY: number,
    pivotX: number, pivotY: number
): Mat2D {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    // T(x,y) · T(pivot) · R · S · T(-pivot)
    const a = cos * scaleX;
    const b = sin * scaleX;
    const c = -sin * scaleY;
    const d = cos * scaleY;
    return {
        a, b, c, d,
        e: x + pivotX - (a * pivotX + c * pivotY),
        f: y + pivotY - (b * pivotX + d * pivotY)
    };
}

/**
 * Inverse transform, or `null` when the matrix is singular (a zero scale collapses
 * the space and cannot be undone). Callers must handle null rather than receive a
 * matrix full of Infinity — the whole point of the world→local direction is
 * hit-testing and drag maths, where a silent Infinity would be poison.
 */
export function invert(m: Mat2D): Mat2D | null {
    const det = m.a * m.d - m.b * m.c;
    if (!Number.isFinite(det) || det === 0) return null;
    const inv = 1 / det;
    const r: Mat2D = {
        a: m.d * inv,
        b: -m.b * inv,
        c: -m.c * inv,
        d: m.a * inv,
        e: (m.c * m.f - m.d * m.e) * inv,
        f: (m.b * m.e - m.a * m.f) * inv
    };
    // The determinant guard alone is not enough to honor the contract above: a
    // non-finite translation (e/f) passes it, and a subnormal `det` makes `1/det`
    // overflow to Infinity. Reject any non-finite result so callers get null, never
    // a poisoned matrix.
    if (!Number.isFinite(r.a) || !Number.isFinite(r.b) || !Number.isFinite(r.c) ||
        !Number.isFinite(r.d) || !Number.isFinite(r.e) || !Number.isFinite(r.f)) return null;
    return r;
}

export function applyToPoint(m: Mat2D, x: number, y: number): { x: number; y: number } {
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/**
 * Axis-aligned bounding box of a rectangle after transforming it. All four corners
 * are transformed — taking only two would be wrong under rotation.
 */
export function transformRectToAABB(m: Mat2D, rect: Rect): Rect {
    const corners = [
        applyToPoint(m, rect.x, rect.y),
        applyToPoint(m, rect.x + rect.width, rect.y),
        applyToPoint(m, rect.x, rect.y + rect.height),
        applyToPoint(m, rect.x + rect.width, rect.y + rect.height)
    ];
    const xs = corners.map(p => p.x);
    const ys = corners.map(p => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** Smallest rectangle containing both. */
export function unionRect(a: Rect, b: Rect): Rect {
    const minX = Math.min(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxX = Math.max(a.x + a.width, b.x + b.width);
    const maxY = Math.max(a.y + a.height, b.y + b.height);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** SVG/Canvas-ready serialization. */
export function toMatrixString(m: Mat2D): string {
    return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
}

/** True when the matrix is a pure translation — lets the renderer skip transform emission. */
export function isTranslationOnly(m: Mat2D): boolean {
    return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
}
