/**
 * @module tileImport
 * @description The actions a placed Tiled map becomes — a grid per layer, an image per leftover cell.
 *
 * HERE RATHER THAN IN THE PANEL for two reasons, one of which is a guard. The panel had been building
 * these inline, and "EVERY editor entry point routes" refuses `new UpdateNodeStyleAction(` in
 * `App.tsx`: every id the inspector touches may be a VIRTUAL one (an instance's copy), which a raw
 * action cannot write to, so those sites must go through `nodeEdit`. An import is the one case that
 * cannot: its ids are minted three lines earlier and exist in no document yet, which is exactly the
 * case `nodeEdit` answers null for. Moving the construction out satisfies the guard honestly rather
 * than by exemption — and the other reason is that a function returning a list of actions can be
 * tested, which the same code inside a `<select onChange>` could not.
 *
 * ONE ORDERED LIST OF PLACEMENTS, not one call per kind. Tiled layers stack in file order and z-order
 * here follows child order, so two lists — grids and loose tiles — would put every leftover tile on
 * top of every grid whatever order the map drew them in.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { SourceRect } from "../document/Node";
import { Tilemap } from "../document/Tilemap";
import { AddNodeAction } from "./AddNodeAction";
import { UpdateNodeContentAction } from "./UpdateNodeContentAction";
import { UpdateNodeTransformAction } from "./UpdateNodeTransformAction";
import { UpdateNodeStyleAction } from "./UpdateNodeStyleAction";
import { SetNodeFlagsAction } from "./SetNodeFlagsAction";
import { generateUUID } from "../ids/UUID";

/** One thing a map import places — a whole layer as a grid, or a single cell as an image. */
export type TilePlacement =
    | {
        kind: "tilemap";
        x: number; y: number; width: number; height: number; src: string;
        map: Tilemap; name: string;
        /** The Tiled layer's own opacity and visibility — a grid can finally carry both. */
        opacity: number; hidden: boolean;
    }
    | {
        kind: "image";
        x: number; y: number; width: number; height: number; src: string;
        sourceRect: SourceRect | null; name: string;
        transform: { rotation: number; scaleX: number; scaleY: number } | null;
    };

/**
 * The actions that place `placements`, in order, and the ids they will create.
 *
 * The ids are minted HERE and returned, for the reason the pen tool and the SVG importer mint theirs:
 * the nodes do not exist yet to be looked up, and the caller needs to select one afterwards.
 *
 * Every action after the first for a given node names a node THIS list creates, which only works
 * inside a `TransactionAction` — it rebinds each component action to the working document, so a patch
 * sees the node the `AddNodeAction` before it made. Dispatched one by one they would all fail
 * validation.
 */
export function tileImportActions(
    doc: ReadonlyDocument, placements: readonly TilePlacement[]
): { actions: Action[]; ids: string[] } {
    const actions: Action[] = [];
    const ids: string[] = [];
    for (const t of placements) {
        const id = generateUUID();
        ids.push(id);
        if (t.kind === "tilemap") {
            // THE GRID IS A CREATION FIELD, not a patch: `Integrity` refuses a tilemap node without
            // one, so a node made first and filled second would be unsaveable in between — the same
            // rule that makes a raster arrive with its pixels.
            actions.push(new AddNodeAction(doc, "core.tilemap", t.x, t.y, t.width, t.height,
                "none", id, null, { src: t.src, tilemap: t.map }));
            // `pixelated` is what stops a 16px tile being smoothed into its neighbours when the map
            // is zoomed, and it is the one hint every measured pack needs.
            actions.push(new UpdateNodeContentAction(doc, id, { pixelated: true, name: t.name }));
            // THE LAYER'S OWN OPACITY AND VISIBILITY, which the per-cell path had nowhere to put:
            // fading ten thousand nodes one at a time composites differently from fading the layer.
            // Emitted only when they differ from the default, so an ordinary layer still costs two
            // actions rather than four.
            if (t.opacity < 1) actions.push(new UpdateNodeStyleAction(doc, id, { opacity: t.opacity }));
            if (t.hidden) actions.push(new SetNodeFlagsAction(doc, id, { hidden: true }));
            continue;
        }
        // ONE IMAGE PER CELL, for the layers a grid cannot express — every tile the SAME sheet with a
        // different `sourceRect` (schema 51), so the layer still costs one decoded image however many
        // cells reference it. The flips arrive as a rotation and a scale.
        actions.push(new AddNodeAction(doc, "core.image", t.x, t.y, t.width, t.height, "none", id,
            null, { src: t.src }));
        // The REGION and the pixel-art hint are content PATCHES rather than creation fields, so they
        // go through the same door the region inputs use.
        actions.push(new UpdateNodeContentAction(doc, id,
            { sourceRect: t.sourceRect, pixelated: true, name: t.name }));
        // Only the cells that need one — 820 of the corpus's 22,808 — so an unflipped tile carries no
        // transform at all.
        if (t.transform) actions.push(new UpdateNodeTransformAction(doc, id, t.transform));
    }
    return { actions, ids };
}
