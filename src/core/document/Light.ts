/**
 * @module Light
 * @description What the document is lit by — and the honest limits of lighting a drawing.
 *
 * A light here is DIRECTIONAL: a direction it comes from, a colour, and a strength. Not a point
 * light with a position and a falloff, and that is a decision rather than a shortcut. A design
 * document has no scale — a rectangle is 200 units wide and nobody has said whether that is a
 * button or a building — so a light with a radius would need a distance the document cannot
 * supply, and every scene would need its intensity retuned when somebody scaled it. A direction
 * needs no scale, which is why it is what a design tool can actually offer.
 *
 * AMBIENT is separate and per-document, because it is not a light: it is the floor below which
 * nothing gets darker. Without it an unlit face goes to pure black, which is never what a
 * designer means and is the first thing anybody reaches for a slider to fix.
 *
 * WHAT THIS DOES NOT DO, stated plainly: shapes do not cast shadows ON EACH OTHER. That needs a
 * shadow map — a second render pass from the light's point of view, and a depth texture to sample
 * — which is its own piece of work and needs the texture path this renderer has never had. What
 * IS here is SELF-shading: a surface tilted away from a light is darker, which is what makes a
 * bevel look like a bevel, and a shadow OFFSET derived from the light and the node's depth, which
 * is what a 2D tool has always meant by "drop shadow" and now gets to compute rather than be told.
 */

/** Lights one document may declare — bounded because each costs a uniform in the shader. */
export const LIGHTS_MAX = 4;

export interface Light {
    /**
     * Direction the light TRAVELS, in the document's own axes with `z` toward the viewer.
     *
     * Stored un-normalised and normalised where it is used: a designer dragging a widget produces
     * whatever length the widget produces, and refusing a valid direction because its length was
     * not 1 would be a rule about arithmetic rather than about light.
     */
    x: number;
    y: number;
    z: number;
    /** Hex, like every other colour in the document. */
    color: string;
    /** 0 = off, 1 = full. Above 1 is allowed: over-bright is a real look, not an error. */
    intensity: number;
}

export function lightsError(lights: unknown): string | null {
    if (lights === undefined) return null;
    if (!Array.isArray(lights)) return "lights must be an array";
    if (lights.length > LIGHTS_MAX) return `lights must hold at most ${LIGHTS_MAX} lights`;
    for (const l of lights as Light[]) {
        if (typeof l !== "object" || l === null || Array.isArray(l)) return "light must be an object";
        if (!Number.isFinite(l.x) || !Number.isFinite(l.y) || !Number.isFinite(l.z)) return "light direction must be finite";
        // A ZERO direction is refused rather than normalised to something arbitrary: it is not a
        // light pointing nowhere, it is a light nobody has aimed yet, and guessing an axis for it
        // would put a highlight somewhere the author never chose.
        if (l.x === 0 && l.y === 0 && l.z === 0) return "light direction must not be zero";
        if (typeof l.color !== "string") return "light.color must be a string";
        if (!Number.isFinite(l.intensity) || l.intensity < 0) return "light.intensity must be a finite number >= 0";
    }
    return null;
}

export function ambientError(ambient: unknown): string | null {
    if (ambient === undefined) return null;
    if (typeof ambient !== "number" || !Number.isFinite(ambient) || ambient < 0 || ambient > 1) {
        return "ambient must be a number within [0, 1]";
    }
    return null;
}

/** A direction as a unit vector, or null when it has no length to speak of. */
export function normalize(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null {
    const len = Math.hypot(v.x, v.y, v.z);
    return len === 0 ? null : { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * How much light a surface facing `normal` receives — LAMBERT, clamped at zero.
 *
 * The dot product of the normal with the direction back TOWARD the light. Clamped because a face
 * pointing away from a light receives none of it rather than negative light, and a negative term
 * summed with another light's would eat it — which shows up as a second light making a shape
 * darker, the least explicable bug a lighting model can have.
 */
export function lambert(normal: { x: number; y: number; z: number }, light: Light): number {
    const dir = normalize(light);
    if (!dir) return 0;
    // `-dir` because `light` stores the direction the light TRAVELS, and the surface is lit by
    // what arrives at it.
    const d = normal.x * -dir.x + normal.y * -dir.y + normal.z * -dir.z;
    return d > 0 ? d * light.intensity : 0;
}

/**
 * How far a shape at `depth` stands ABOVE the page — the quantity a shadow is thrown by.
 *
 * The negation is the whole function, and it is here rather than inlined because getting it
 * backwards is silent: `depth` counts AWAY from the viewer (positive lags the pan, draws first,
 * takes a larger clip z — all three of `Depth`'s consumers agree), so height counts the other
 * way. A shape at depth −10 floats ten units in front of the page; one at +10 is sunk ten units
 * behind it.
 *
 * A SUNK shape has height zero rather than a negative one. It is below the page plane, so there
 * is nothing between it and the page for it to cast onto, and its shadow would fall on whatever
 * is further back still — which is a shadow this model does not claim to draw. Zero is the honest
 * answer; a negative height would throw the shadow backwards INTO the light, which is the
 * defect this function was written with and shipped for two commits.
 */
export function heightAbovePage(depth: number): number {
    return depth < 0 ? -depth : 0;
}

/**
 * The drop-shadow OFFSET a light and a depth imply, in world units.
 *
 * The one kind of shadow a renderer without a depth texture can honestly cast by itself: a shape
 * floating above the page throws its outline away from the light, and further the higher it is.
 * That is what a 2D tool has always meant by a drop shadow — the difference is that it is now
 * DERIVED from the scene's own light rather than typed in per shape, so moving the light moves
 * every shadow and they cannot disagree with each other.
 *
 * Zero at depth 0 and at any depth behind the page: a shape lying on the page, or sunk below it,
 * has nothing to cast onto.
 */
export function shadowOffset(light: Light, depth: number): { x: number; y: number } {
    const dir = normalize(light);
    const height = heightAbovePage(depth);
    // The zero short-circuit is not decoration: a negative direction times zero is `-0`, which
    // differs under `Object.is` and would make "has this shadow moved?" answer wrongly. The same
    // trap `parallaxOffset` has.
    if (!dir || height === 0) return { x: 0, y: 0 };
    return { x: dir.x * height, y: dir.y * height };
}
