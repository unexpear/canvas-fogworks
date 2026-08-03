/**
 * @module CastShadow
 * @description Shadows that LAND ON THINGS — one shape darkening another, as geometry.
 *
 * "Shapes do not cast shadows on each other" has been the stated gap in this engine's lighting
 * since it existed, and the reason given each time was a shadow map: a second render pass from
 * the light's point of view, a depth texture to sample, and a texture path this renderer has
 * never had. That reasoning was about the wrong technique. A shadow map is what you reach for
 * when the occluder is arbitrary 3D geometry. Here every occluder is a FLAT shape at a known
 * height above a plane, lit by a DIRECTIONAL light — and the shadow such a thing casts is not an
 * approximation problem at all. It is its own outline, translated, intersected with whatever it
 * lands on. Both operations already exist and are hardened: `shadowOffset` gives the translation,
 * `resolveBoolean(…, "intersect")` gives the landing.
 *
 * Doing it as geometry rather than as a pass buys three things a shadow map would not:
 *   - ALL THREE BACKENDS get it. SVG and Canvas cannot sample a depth texture; they can fill a
 *     path. A shadow that only appeared on the GPU preview would be a fourth thing the backends
 *     disagree about, which is the drift this codebase keeps designing out.
 *   - It is DETERMINISTIC and node-testable. A shadow map's output is pixels, and pixels can only
 *     be checked by running a GPU; a ring can be checked by its area.
 *   - It is RESOLUTION-INDEPENDENT. Zoom in and the shadow edge stays an edge rather than
 *     becoming the shadow map's texels.
 *
 * WHAT IT COSTS, stated rather than discovered: the shadow is HARD-EDGED and UNIFORM. A real
 * penumbra widens with the gap between caster and receiver, and a directional light has no
 * penumbra to begin with — see the note on `SHADOW_ALPHA`. Softening is a blur on the drawn item
 * and belongs to the backends that have one.
 *
 * WHAT IT STILL DOES NOT DO: a shadow does not fall on the SURFACE RELIEF of what it lands on. It
 * lands on the receiver's outline as if the receiver were flat, so a shadow crossing a domed
 * shape does not bend over the dome. That genuinely does need the height field in the fragment
 * shader, and it is the one part of this the geometry answer cannot reach.
 */

import { Ring } from "./PathBoolean";
import { resolveBoolean } from "./Resolve";

/**
 * How dark a cast shadow is, as an alpha over the receiver.
 *
 * ONE value rather than a falloff, and that is a property of the light rather than a shortcut: a
 * DIRECTIONAL light is infinitely far away, so every ray is parallel, so the occlusion is total
 * or nothing and the umbra has no gradient. A falloff here would be inventing a penumbra the
 * light model does not have — and it would disagree with `lambert`, which is clamped for the same
 * reason. The value matches the drop shadow's `#00000059` so a shape's own shadow and the shadow
 * it throws on a neighbour are the same black.
 */
export const SHADOW_ALPHA = "#00000059";

/**
 * Pairs considered per frame. Bounded because this is quadratic in the number of RAISED shapes.
 *
 * The bound is on pairs rather than on shapes so it degrades by dropping the last few shadows
 * rather than by refusing to draw any, and it is generous relative to what a document reaches:
 * raised shapes are a handful in practice, because raising everything is the same as raising
 * nothing. `castShadows` reports what it dropped rather than truncating silently.
 */
export const CAST_SHADOW_MAX_PAIRS = 400;

/** A shape that can throw a shadow or receive one. Rings in WORLD space, plus where it sits. */
export interface ShadowShape {
    id: string;
    rings: readonly Ring[];
    /** Away from the viewer, the document's own sign. See `Depth`. */
    depth: number;
}

/** One shadow to draw: the patch, and the shape it lands on (so it can be drawn just above it). */
export interface CastShadowPatch {
    /** The receiver, so the patch can be inserted directly after it in paint order. */
    receiverId: string;
    casterId: string;
    rings: Ring[];
}

function translateRings(rings: readonly Ring[], dx: number, dy: number): Ring[] {
    return rings.map(r => r.map(p => ({ x: p.x + dx, y: p.y + dy })));
}

/**
 * The patch of `receiver` that `caster`'s shadow falls on, or `[]` when it misses.
 *
 * The caster's outline moved by the light, then intersected with the receiver. Exported on its
 * own because it is the whole idea, and because a caller with two rings and an offset should not
 * have to assemble a scene to ask the question.
 */
export function shadowPatch(caster: readonly Ring[], receiver: readonly Ring[],
                            offset: { x: number; y: number }): Ring[] {
    if (caster.length === 0 || receiver.length === 0) return [];
    // A zero offset means the caster is ON the page (or sunk below it), and a shape's shadow
    // directly under itself is hidden by the shape — computing it would be a boolean per pair
    // per frame whose result is never visible.
    if (offset.x === 0 && offset.y === 0) return [];
    return resolveBoolean(translateRings(caster, offset.x, offset.y), receiver, "intersect");
}

/**
 * Every shadow the scene's shapes throw on each other.
 *
 * A shape casts onto another when it is NEARER THE VIEWER — strictly nearer, because two shapes
 * at the same depth are in the same plane and neither is above the other. `offsetOf` is passed in
 * rather than computed here so this module needs to know nothing about lights: the caller already
 * has the scene's light, and a geometry module that imported one would be reaching across a seam
 * for a single multiplication.
 *
 * Returns `[]` — the SAME empty array, so the caller can compare — when no shape is raised at
 * all, which is every document that has never used depth. That is the common case and it must
 * cost nothing: this runs per frame, and the alternative is a quadratic scan to discover there
 * was nothing to do.
 */
export function castShadows(shapes: readonly ShadowShape[],
                            offsetOf: (casterDepth: number, receiverDepth: number) => { x: number; y: number },
                            maxPairs: number = CAST_SHADOW_MAX_PAIRS): CastShadowPatch[] {
    // A PAIR at a time, because the throw depends on both: the gap the light crosses is between
    // the caster and what it lands on, so one shape's shadow is a different length on the page
    // than it is on another raised shape. Pre-computing an offset per caster — which this did
    // once — makes every shadow in a scene the same length whatever it falls on.
    const casters = shapes.filter(s => {
        // Anything with SOMEWHERE below it to cast onto. Cheap, and it keeps the common case (a
        // document that never touched depth) at one pass with no pairs considered at all.
        const onPage = offsetOf(s.depth, 0);
        return onPage.x !== 0 || onPage.y !== 0;
    });
    if (casters.length === 0) return [];

    const out: CastShadowPatch[] = [];
    let pairs = 0;
    for (const caster of casters) {
        for (const receiver of shapes) {
            // STRICTLY nearer. At equal depth neither shape is above the other, and a `<=` here
            // would have every raised shape in a stack shadow every other one in the same plane.
            //
            // This is also what stops a shape shadowing ITSELF, so there is no separate identity
            // test: a shape's depth is never strictly less than its own. One was written, and a
            // mutation of it changed nothing — it could only ever have fired on two DIFFERENT
            // shapes that shared an id, where it would have wrongly skipped a real pair.
            if (caster.depth >= receiver.depth) continue;
            if (pairs >= maxPairs) return out;
            pairs++;
            const rings = shadowPatch(caster.rings, receiver.rings, offsetOf(caster.depth, receiver.depth));
            if (rings.length > 0) out.push({ receiverId: receiver.id, casterId: caster.id, rings });
        }
    }
    return out;
}
