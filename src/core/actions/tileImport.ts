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
 * top of every grid whatever order the map drew them in. OBJECTS JOINED THE SAME LIST (2026-08-10)
 * for exactly that reason: a map interleaves tile layers and object layers, and a separate call
 * would put every entity above every tile or below it, whichever way round the caller happened to
 * write the two lines.
 *
 * AN OBJECT LAYER ARRIVES AS A FRAME with the objects inside it. The layer's opacity and visibility
 * belong to the LAYER — fading thirty overlapping sprites one at a time composites differently from
 * fading the group they are in — and nesting is also what makes the layers panel show the structure
 * the author built. A `core.rectangle` with no fill is how this editor frames things, which is why
 * there is no new node type here.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { SourceRect, PathCommand } from "../document/Node";
import { Tilemap } from "../document/Tilemap";
import { AddNodeAction } from "./AddNodeAction";
import { UpdateNodeContentAction } from "./UpdateNodeContentAction";
import { UpdateNodeTransformAction } from "./UpdateNodeTransformAction";
import { UpdateNodePathAction } from "./UpdateNodePathAction";
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
    }
    | {
        /** An object layer: a frame the objects that follow it are placed INSIDE. */
        kind: "group";
        x: number; y: number; width: number; height: number; name: string;
        opacity: number; hidden: boolean;
    }
    | {
        /**
         * One Tiled object — an entity rather than a cell.
         *
         * `shape` is what the engine already has to hold it: a tile object is an image with a
         * source rect, a rectangle is a box, an ellipse is an ellipse, and a polygon or polyline is
         * a path. The kinds this cannot hold — a point (no size), a text object (no string is read)
         * and a template (its file is not opened) — never become a placement at all, and the reader
         * counts them so the gap is visible instead of silent.
         */
        kind: "object";
        shape: "image" | "rectangle" | "ellipse" | "path";
        x: number; y: number; width: number; height: number; name: string;
        src: string | null;
        sourceRect: SourceRect | null;
        /**
         * Radians, plus the fraction of the box the rotation turns about.
         *
         * THE ORIGIN IS THE POINT. Tiled turns a tile object about its BOTTOM-LEFT corner and
         * everything else about its top-left, so a placement that only carried an angle would land
         * every rotated entity somewhere else entirely — see `objectTransform`.
         */
        transform: { rotation: number; scaleX: number; scaleY: number; origin: { x: number; y: number } } | null;
        /** A polygon's or polyline's commands, already relative to the node's own box. */
        path: PathCommand[] | null;
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
    /** The frame the objects that follow are placed inside; null until the first object layer. */
    let openGroup: string | null = null;
    for (const t of placements) {
        const id = generateUUID();
        ids.push(id);
        // A TILE LAYER ENDS THE OBJECT LAYER ABOVE IT, and what that protects is the placements
        // AFTER it, not the grid itself: a `tilemap` is added with an explicit null parent, so it
        // could never have been adopted. The mutant that deleted this line SURVIVED, and the reason
        // was a comment claiming the wrong effect — what actually breaks without it is an `object`
        // that follows a tile layer, which would be handed to a frame two layers up and inherit an
        // opacity from a group it is not in. Only an `object` stays inside; a `group` opens the next.
        if (t.kind === "tilemap" || t.kind === "image") openGroup = null;
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
        if (t.kind === "group") {
            // A FRAME WITH NO FILL. `core.rectangle` is how this editor nests, so an object layer
            // becomes the same thing a user gets from Frame Selection — visible in the layers panel,
            // and carrying the layer's own opacity and visibility for everything inside it.
            actions.push(new AddNodeAction(doc, "core.rectangle", t.x, t.y, t.width, t.height,
                "none", id, null));
            actions.push(new UpdateNodeContentAction(doc, id, { name: t.name }));
            if (t.opacity < 1) actions.push(new UpdateNodeStyleAction(doc, id, { opacity: t.opacity }));
            if (t.hidden) actions.push(new SetNodeFlagsAction(doc, id, { hidden: true }));
            openGroup = id;
            continue;
        }
        if (t.kind === "object") {
            // AN OUTLINE, NOT A FILL, for everything that is not a picture. A Tiled rectangle is a
            // collision volume or a trigger — a solid one would hide the map it is drawn over, and
            // the author would delete the import rather than the fill.
            const nodeType = t.shape === "image" ? "core.image"
                : t.shape === "ellipse" ? "core.ellipse"
                : t.shape === "path" ? "core.path"
                : "core.rectangle";
            // INSIDE THE MOST RECENT GROUP, which is what makes this a LIST rather than a bag: the
            // caller cannot name a parent id because the ids are minted here, three lines from now,
            // and Tiled's own file order is already the nesting. An object before any group is a
            // root, which is what a map with objects and no layer flags should produce.
            actions.push(new AddNodeAction(doc, nodeType, t.x, t.y, t.width, t.height, "none", id,
                openGroup, t.src !== null ? { src: t.src } : undefined));
            actions.push(new UpdateNodeContentAction(doc, id,
                t.shape === "image" ? { sourceRect: t.sourceRect, pixelated: true, name: t.name }
                    : { name: t.name }));
            // A SHAPE THAT IS NOT A PICTURE gets a visible stroke, because "none" fill plus no
            // stroke is a node that exists and draws nothing at all.
            if (t.shape !== "image") {
                actions.push(new UpdateNodeStyleAction(doc, id, { stroke: "#ff2d9b", strokeWidth: 1 }));
            }
            if (t.path) actions.push(new UpdateNodePathAction(doc, id, t.path));
            if (t.transform) actions.push(new UpdateNodeTransformAction(doc, id, t.transform));
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
