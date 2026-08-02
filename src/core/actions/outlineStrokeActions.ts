/**
 * @module outlineStrokeActions
 * @description Turning a border into a shape — the editor-facing half of `StrokeOutline`.
 *
 * A factory returning a `TransactionAction`, like `booleanActions` and `alignAction`: the whole
 * conversion is one atomic result and therefore ONE undo, and returning null when it cannot apply
 * keeps an impossible click from pushing an empty revision onto the history.
 *
 * WHY a command and not just a renderer feature. A stroke is a parameter until it is outlined:
 * you cannot select part of it, cut it with a boolean, drag one of its vertices, or give the
 * inside a different colour from the outside. Outlining it makes the border an ordinary
 * `core.path`, and every one of those becomes possible with no further work — which is the same
 * argument the boolean bake makes, and the reason both live at this layer rather than inside a
 * backend.
 *
 * ALIGNMENT lives here rather than in the document. Neither SVG nor Canvas can draw an inside or
 * outside border, so `Style` carries no `strokeAlign` — a document field for it would render
 * three different ways on three backends. As an argument to a conversion it is exact: what comes
 * out is a fill, and every backend draws a fill identically. See `geometry/StrokeOutline`.
 */

import { Action } from "./Action";
import { AddNodeAction } from "./AddNodeAction";
import { TransactionAction } from "./TransactionAction";
import { UpdateNodePathAction } from "./UpdateNodePathAction";
import { ReadonlyDocument } from "../document/Document";
import { DEFAULT_MITER_LIMIT, PathCommand } from "../document/Node";
import { resolveScene } from "../document/Components";
import { selectionRoots } from "../document/SceneGraph";
import { ComputedState } from "../geometry/GeometryEngine";
import { ringsToCommands } from "../geometry/PathBoolean";
import { StrokeAlign, strokeOutline } from "../geometry/StrokeOutline";
import { normalizePathNode } from "../geometry/PathBuilder";
import { resolveNumber } from "../document/Variables";
import { UpdateNodeStyleAction } from "./UpdateNodeStyleAction";
import { shapeToCommands, transformCommands } from "../geometry/ShapeToPath";

/**
 * The stroke WIDTH a node actually draws with, in world units, or null when it draws no border.
 *
 * The same resolution the render model does — a number, a `$token` read under the document's
 * active theme, or absent — because the outline has to match what is on screen. Absent is the one
 * case that cannot be converted: it means a HAIRLINE, one screen pixel at any zoom, which is not
 * a width in world units at all and so has no fixed area to turn into a shape.
 */
export function strokeWidthOf(doc: ReadonlyDocument, nodeId: string): number | null {
    const node = doc.nodes.get(nodeId);
    if (!node || !node.style.stroke) return null;
    const raw = node.style.strokeWidth;
    if (raw === undefined) return null;                       // hairline: zoom-dependent, not geometry
    const width = typeof raw === "number" ? raw : resolveNumber(doc.variables, raw, doc.activeTheme);
    return width !== null && Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * Replace each selected node's BORDER with a `core.path` that fills the same area.
 *
 * The node itself is kept, minus its stroke: outlining a border should not throw away the shape
 * it went round. That is what every design tool does and it is also the only choice that loses
 * nothing — the fill stays a fill, the border becomes editable, and undo puts both back.
 *
 * The offsetting runs in LOCAL space and the result is transformed to world, because that is
 * where `stroke-width` means what it means: a node scaled 2x has a border twice as thick, on
 * screen and therefore in the outline. Doing it after the transform would produce a border of
 * uniform world width that matched nothing the user could see.
 *
 * Null when nothing in the selection has an outlineable border — a hairline, a zero width, no
 * stroke colour, or a shape with no outline at all (a text or image node).
 */
export function outlineStrokeAction(
    doc: ReadonlyDocument,
    computed: ComputedState,
    selectedNodeIds: readonly string[],
    /** Ids for the new paths, MINTED BY THE CALLER — one per converted node, in selection order. */
    newIds: readonly string[],
    align: StrokeAlign = "center"
): Action | null {
    const roots = selectionRoots(resolveScene(doc), [...selectedNodeIds]);
    // STORED nodes only, the same rule the boolean bake follows: an instance copy has no stored
    // identity to edit, and baking one would silently detach part of an instance.
    const ids = computed.order.filter(id => roots.includes(id) && doc.nodes.has(id));

    const actions: Action[] = [];
    let used = 0;
    for (const id of ids) {
        const width = strokeWidthOf(doc, id);
        const node = doc.nodes.get(id)!;
        const c = computed.nodes.get(id);
        if (width === null || !c) continue;
        const local = shapeToCommands(c.shape, c.local.width, c.local.height);
        if (!local) continue;

        const rings = strokeOutline(local, {
            width,
            join: node.style.strokeJoin, cap: node.style.strokeCap,
            miterLimit: node.style.strokeMiterLimit ?? DEFAULT_MITER_LIMIT,
            align
        });
        if (rings.length === 0) continue;
        const world: PathCommand[] = transformCommands(c.world, ringsToCommands(rings));
        const norm = normalizePathNode({ x: 0, y: 0, width: 0, height: 0 }, world);
        if (norm.geometry.width === 0 && norm.geometry.height === 0) continue;

        const newId = newIds[used++];
        if (newId === undefined) break;                       // caller minted fewer ids than we can use
        actions.push(
            // The border's COLOUR becomes the new shape's fill, because that is what the border
            // was painted in — and the new node carries no stroke of its own, or outlining would
            // be a thing you could do twice and get a different answer the second time.
            new AddNodeAction(
                doc, "core.path",
                norm.geometry.x, norm.geometry.y, norm.geometry.width, norm.geometry.height,
                node.style.stroke ?? "#cccccc", newId, null
            ),
            new UpdateNodePathAction(doc, newId, norm.path),
            // The original keeps its fill and loses its border — the border is now the new node,
            // and leaving both would draw it twice. A patch of `undefined` REMOVES the fields
            // (`Object.assign` sets them, and `JSON.stringify` drops them), so an outlined node
            // serialises exactly like one that never had a border — rather than carrying an
            // empty-string stroke that every reader has to know means "none".
            new UpdateNodeStyleAction(doc, id, { stroke: undefined, strokeWidth: undefined })
        );
    }
    if (actions.length === 0) return null;
    return new TransactionAction(doc, `outline-stroke:${align}`, actions);
}
