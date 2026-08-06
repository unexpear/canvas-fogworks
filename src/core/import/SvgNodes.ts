/**
 * @module SvgNodes
 * @description Turning read SVG shapes into what a `core.path` node needs.
 *
 * `SvgDocument` produces shapes whose coordinates are absolute in the file's own space, because
 * that is what baking the group transforms leaves behind. A node wants the opposite: a BOX saying
 * where its ink is, and commands relative to that box's corner — the arrangement selection,
 * snapping, culling and hit-testing all read.
 *
 * THAT CONVERSION ALREADY EXISTED. `PathBuilder.normalizePathNode` puts commands back onto a (0,0)
 * origin and moves the box to match, and the pen tool has used it since paths could be drawn. This
 * module calls it rather than computing bounds again — the same reuse the last commit had to learn
 * the hard way, having written a second `transformCommands` before the compiler objected.
 *
 * SO WHAT IS LEFT HERE IS THE STYLE, which is where the two models genuinely differ. A node's
 * `fill` is a required string; SVG's may be absent, `none`, or a gradient already flattened
 * upstream. `none` becomes fully transparent black rather than being dropped, because a shape with
 * no fill and a stroke is a real drawing and a node has to hold some fill either way.
 */

import { PathCommand, Style } from "../document/Node";
import { Rect } from "../geometry/Matrix";
import { normalizePathNode } from "../geometry/PathBuilder";
import { SvgShape } from "./SvgDocument";

/**
 * The fill given to a shape that has none.
 *
 * Eight-digit hex because all three backends read it: `emitWebGL.parseColor` accepts `#rrggbbaa`
 * explicitly, and Canvas and SVG take it as CSS. A word like `transparent` would work in two of
 * them and fall back to the missing-colour magenta on the GPU.
 */
export const SVG_TRANSPARENT = "#00000000";

/** Everything needed to create one `core.path` node. */
export interface SvgNodeSpec {
    geometry: Rect;
    path: PathCommand[];
    style: Style;
}

/**
 * The nodes a set of read shapes becomes, in document order.
 *
 * A shape whose box is zero in BOTH axes is dropped: it has no ink, and the document would refuse
 * it. A single-axis collapse is kept, because a perfectly horizontal stroke is a legitimate path —
 * the same rule `penNodeFrom` applies, and for the same reason.
 */
export function svgNodeSpecs(shapes: readonly SvgShape[]): SvgNodeSpec[] {
    const out: SvgNodeSpec[] = [];
    for (const shape of shapes) {
        // AN EMPTY command list cannot arrive from `parseSvgDocument` — a parsed path always holds
        // at least its moveto — and if one did, `pathBounds` answers with a zero box and the extent
        // check below drops it. So this is CLARITY, not correctness, and a mutation removing it
        // survives. It stays because "no commands, no node" is worth saying where it is decided.
        if (shape.commands.length === 0) continue;
        // The commands arrive ABSOLUTE, so the box starts at the origin and `normalizePathNode`
        // moves it to wherever the ink actually is.
        const placed = normalizePathNode({ x: 0, y: 0, width: 0, height: 0 }, shape.commands);
        if (placed.geometry.width === 0 && placed.geometry.height === 0) continue;

        const style: Style = {
            fill: shape.fill ?? SVG_TRANSPARENT,
            // CLAMPED, because `styleError` refuses anything outside [0,1] and a product of nested
            // opacities can land a hair outside it in floating point. Refusing the shape over a
            // rounding error would be a poor trade.
            opacity: Math.min(1, Math.max(0, shape.opacity))
        };
        // OMITTED rather than set to a falsy value: `stroke` absent means "no stroke", while
        // `stroke: ""` is a colour the renderer would have to interpret.
        if (shape.stroke !== null) style.stroke = shape.stroke;
        if (shape.strokeWidth !== null) style.strokeWidth = shape.strokeWidth;
        out.push({ geometry: placed.geometry, path: placed.path, style });
    }
    return out;
}
