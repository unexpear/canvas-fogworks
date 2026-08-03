/**
 * @module RayMarch
 * @description Casting a ray through a HEIGHTFIELD — whether a point can see the light.
 *
 * The lighting so far answers "which way does this surface face" (`normalAt`) and "what does a
 * flat shape throw onto its neighbour" (`CastShadow`). Neither can answer the question a bevel
 * asks: a raised edge should darken the crease BESIDE it, and that is not about the crease's own
 * normal — the crease may face the light squarely and still be in shadow, because something
 * between it and the light is in the way. Finding out means following the ray and looking.
 *
 * This is the "ray casting" half of the lighting, and it is deliberately the SIMPLEST honest form:
 * march fixed steps from the surface point toward the light, and at each step ask whether the
 * surface is above the ray. If it ever is, something occludes the point. That is a sampled answer
 * rather than an exact one — a spike thinner than the step spacing is missed — and the alternative
 * (an exact intersection against every bilinear patch on the way) is a large amount of arithmetic
 * for a difference that only shows on relief finer than the mesh can represent anyway.
 *
 * KNOWING NOTHING about meshes or lights is the point of the signature. `height` is injected, so
 * this module is pure geometry that a mesh, an imported heightmap, or a test's closed-form surface
 * can all drive — the same reason `castShadows` takes an `offsetOf` rather than a `Light`. It also
 * makes the thing testable against surfaces whose shadowing can be worked out on paper.
 *
 * BINARY, not soft. A DIRECTIONAL light is infinitely far away, so every ray is parallel and the
 * occlusion is total or nothing — there is no penumbra to compute. Softening it here would be
 * inventing a gradient the light model does not have, and it would disagree with `lambert` and
 * with `CastShadow`, which are hard-edged for the same reason.
 */

/**
 * Samples taken along the ray.
 *
 * The cost is per FRAGMENT on the GPU, so this is the one number in the lighting that is a real
 * performance decision rather than a correctness one. Sixteen resolves relief at roughly the scale
 * a mesh cell holds, which is the finest detail the surface can carry; more samples buy resolution
 * the heightfield does not have.
 */
export const RAY_STEPS = 16;

/**
 * Is the point at `(x, y)` occluded from a light in direction `toLight`?
 *
 * `toLight` points TOWARD the light and is expected normalised. `maxHeight` is the tallest the
 * surface gets, and it is what bounds the march: once the ray is above everything, nothing further
 * along can occlude it, so the distance to that altitude is the whole of the ray worth walking.
 * Passing a `maxHeight` that is too small silently shortens the ray — which is why it is a
 * parameter rather than a guess, and why the caller that owns the surface supplies it.
 *
 * Answers FALSE immediately for a light at or below the horizon. A ray that never climbs cannot
 * escape the surface, so the march would either run along it forever or report everything
 * shadowed; `lambert` has already darkened those faces to nothing, which is the correct answer and
 * a cheaper one.
 */
export function marchOccluded(
    height: (x: number, y: number) => number,
    x: number, y: number,
    toLight: { x: number; y: number; z: number },
    maxHeight: number,
    steps: number = RAY_STEPS
): boolean {
    // A ray that does not climb never leaves the surface. Not a degenerate-input guard: a light
    // level with the page is an ordinary thing to set, and `lambert` has already taken those
    // faces to zero.
    if (toLight.z <= 0) return false;
    const start = height(x, y);
    // Already above everything? Then nothing can be in the way. This is a COST short-circuit, not
    // a correctness guard, and saying so matters: with `start === maxHeight` the march below runs
    // a zero-length ray and answers false anyway, which a mutation of this line demonstrates. It
    // stays because it is the flat-surface path — most of every document — and it turns sixteen
    // height lookups into one compare.
    if (start >= maxHeight) return false;
    // The ray climbs `toLight.z` per unit travelled, so this is exactly the distance to clear the
    // tallest point — and past it no sample could ever be above the ray. Measuring it from `start`
    // rather than from zero is about RESOLUTION rather than correctness: a longer ray is still
    // correct (nothing above the escape altitude can occlude) but spreads the same sixteen samples
    // over more ground, so it misses thinner things.
    const distance = (maxHeight - start) / toLight.z;
    // From ONE, not zero: step zero is the point itself, where the ray has climbed nothing and the
    // strict comparison below would answer false regardless. Another cost saving stated as one.
    for (let i = 1; i <= steps; i++) {
        const t = (distance * i) / steps;
        const h = height(x + toLight.x * t, y + toLight.y * t);
        // STRICTLY above. A surface exactly level with the ray is the ray grazing it — which is
        // every point of a flat surface lit from any angle, and calling that occluded would put a
        // flat shape entirely in its own shadow.
        if (h > start + toLight.z * t) return true;
    }
    return false;
}
