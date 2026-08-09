/**
 * @module Eyedropper
 * @description The colour under a point — asked of the DOCUMENT, not of the screen.
 *
 * The obvious way to build an eyedropper is to read the framebuffer, and it is the wrong way here.
 * The SVG backend has no pixels to read at all, Canvas and the GPU read them differently, and all
 * three would answer with whatever the display did to the colour on its way out — the zoom's
 * resampling, the device pixel ratio, a dark-mode filter. Three implementations, three answers, and
 * the one thing none of them can tell you is what the document actually SAYS.
 *
 * So this asks the document. `hitTest` finds what is under the point — which already respects
 * clipping, so a pick over hidden content passes through to whatever is really visible — and then
 * the node's own fill is evaluated AT THAT POINT: a token resolved, a gradient sampled along its
 * ramp, a painted surface sampled at its pixel. The answer is exact, it is the same on every
 * backend, and it can be tested without a browser.
 *
 * THE PRICE OF ASKING THE DOCUMENT is that it answers with the SOURCE colour of the topmost shape,
 * not with the composited pixel. Over a shape with `blendMode: "multiply"` or an opacity of 0.5 the
 * answer is that shape's own fill, which is not the colour on screen — most tools read the
 * framebuffer and would say the blend. For the cases that dominate, a solid fill, a gradient and a
 * painted texel, the two agree exactly and this one is exact where a framebuffer read would have
 * been resampled by the zoom. Compositing the stack instead would mean a second renderer, in the
 * core, that could disagree with the three real ones. Stated so the limit is a decision.
 *
 * WHAT IT CANNOT ANSWER is a `core.image`: the pixels live in a file the pure core never decodes,
 * so there is no colour here to report. It says so by returning null rather than guessing at an
 * average or falling through to the shape behind, either of which would hand back a colour that is
 * not the one under the cursor.
 */

import { ComputedState, hitTest } from "./GeometryEngine";
import { ReadonlyDocument } from "../document/Document";
import { Gradient } from "../document/Gradient";
import { colorAt } from "../document/GradientEdit";
import { resolveColor } from "../document/Variables";
import { gradientPointOf } from "./SelectionHandles";
import { decodeSurface } from "../paint/PixelCodec";
import { getPixel } from "../paint/PixelBuffer";
import { worldToSurface } from "../paint/SurfaceSpace";

/**
 * Where along a ramp a point in GRADIENT space falls, before clamping.
 *
 * THE SAME RULE THE GPU'S `rampT` STATES, in the other language. SVG and Canvas never need it —
 * they hand a gradient object to the browser and it does this internally — so there is no third
 * copy, and the two that exist cannot be merged because one of them is GLSL. What can be done is
 * to check this one by hand against numbers the shader's own comment works through, which the
 * tests do.
 *
 * Linear is the projection onto the axis. Radial is the ray from the FOCUS through the point,
 * asking where it crosses the end circle; `t` is the reciprocal of that crossing, which collapses
 * to the plain distance ratio when the focus sits at the centre.
 */
export function rampT(gradient: Gradient, gx: number, gy: number): number {
    if (gradient.kind === "linear") {
        const dx = gradient.x2 - gradient.x1, dy = gradient.y2 - gradient.y1;
        const len2 = dx * dx + dy * dy;
        return len2 > 0 ? ((gx - gradient.x1) * dx + (gy - gradient.y1) * dy) / len2 : 0;
    }
    const fx = gradient.fx ?? gradient.cx, fy = gradient.fy ?? gradient.cy;
    const dx = gx - fx, dy = gy - fy;
    const a = dx * dx + dy * dy;
    const r = gradient.r;
    if (a <= 0 || r <= 0) return 1;
    const cfx = fx - gradient.cx, cfy = fy - gradient.cy;
    const b = dx * cfx + dy * cfy;
    const disc = b * b - a * (cfx * cfx + cfy * cfy - r * r);
    const hit = (-b + Math.sqrt(Math.max(disc, 0))) / a;
    return hit > 0 ? 1 / hit : 1;
}

/** A pixel as `#rrggbb`, or null when it is fully transparent — nothing to pick. */
function hexOf(rgba: readonly [number, number, number, number]): string | null {
    if (rgba[3] === 0) return null;
    const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${h(rgba[0])}${h(rgba[1])}${h(rgba[2])}`;
}

/**
 * The colour at a world point, or null when there is nothing to pick.
 *
 * Null is returned for a genuinely empty spot, a fill of `none`, a transparent surface pixel and a
 * `core.image` — and the caller is expected to do NOTHING in each case rather than substitute a
 * default. An eyedropper that quietly sets black when it misses is worse than one that misses
 * visibly, because the author only finds out two strokes later.
 */
export function pickColorAt(
    doc: ReadonlyDocument, state: ComputedState, x: number, y: number
): string | null {
    const id = hitTest(state, x, y);
    if (id === null) return null;
    const node = doc.nodes.get(id);
    const c = state.nodes.get(id);
    if (!node || !c) return null;

    // A PAINTED SURFACE answers with its own pixel, which is the whole point of an eyedropper in a
    // pixel workspace: the colour you see at that texel, not the average of the node.
    if (node.surface) {
        const at = worldToSurface({
            world: c.world, localWidth: c.local.width, localHeight: c.local.height,
            surfaceWidth: node.surface.width, surfaceHeight: node.surface.height
        }, x, y);
        if (!at) return null;
        const buffer = decodeSurface(node.surface.data, node.surface.width, node.surface.height);
        if (!buffer) return null;
        const px = getPixel(buffer, at[0], at[1]);
        return px ? hexOf(px) : null;
    }

    // A `core.image` DRAWS ITS FILE, not its fill. Falling through to `style.fill` would hand back
    // a colour that is nowhere on screen — the placeholder underneath the bitmap — which is worse
    // than admitting the pure core never decoded those pixels. Caught by a test that expected null
    // and got the fill.
    if (node.type === "core.image") return null;

    const fill = node.style.fill;
    if (fill === undefined || fill === "none") return null;
    if (typeof fill === "string") return resolveColor(doc.variables, fill, doc.activeTheme);

    // A GRADIENT is sampled where the pointer is, through the same matrix the on-canvas handles
    // are placed by — so the colour picked is the colour drawn at the spot the author clicked.
    const g = fill as Gradient;
    const p = gradientPointOf(g, c.world, { width: c.local.width, height: c.local.height }, x, y);
    if (!p) return null;
    // PADDED at both ends, which is SVG's default spread and the only one any measured file states.
    const stop = colorAt(g, Math.max(0, Math.min(1, rampT(g, p.x, p.y))));
    return stop ? resolveColor(doc.variables, stop.color, doc.activeTheme) : null;
}
