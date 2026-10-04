/**
 * @module ImportPlacement
 * @description Commits prepared imports into the document: where a picture lands,
 * and the one transaction that places sequences, Aseprite files, SVG paths and maps.
 * Folder dialogs and decoding stay in the folders drawer. 3D imports stay in the shell
 * because they also copy project files and switch workspace.
 */

import { Action } from "../core/actions/Action";
import { AddNodeAction } from "../core/actions/AddNodeAction";
import { asepriteImportActions } from "../core/actions/asepriteImport";
import { contentActionFor } from "../core/actions/nodeEdit";
import { sequenceImportActions } from "../core/actions/sequenceImport";
import { SetBackgroundAction } from "../core/actions/SetBackgroundAction";
import { SetScreenAction } from "../core/actions/SetScreenAction";
import { SetTilesetsAction } from "../core/actions/SetTilesetsAction";
import { tileImportActions, TilePlacement } from "../core/actions/tileImport";
import { TransactionAction } from "../core/actions/TransactionAction";
import { UpdateNodePathAction } from "../core/actions/UpdateNodePathAction";
import { ReadonlyDocument } from "../core/document/Document";
import { flatFill } from "../core/document/Node";
import { Tileset } from "../core/document/Tileset";
import { Keyframe } from "../core/document/Timeline";
import { screenToWorld } from "../editor/EditorState";
import { SvgNodeSpec } from "../core/import/SvgNodes";
import { generateUUID } from "../core/ids/UUID";
import type { AsepritePlacementInput } from "./FoldersDrawer";

/** Fixed box for a placed still or a numbered sequence. An Aseprite file uses its own canvas. */
export const PLACED_IMAGE_SIZE = { width: 200, height: 150 };

/** Used when the canvas host has not been measured yet — the same fallback the shell used inline. */
export const UNMEASURED_CANVAS = { width: 800, height: 600 };

export interface PlacementView {
    viewport: { x: number; y: number; zoom: number };
    /** Null when the canvas host is not mounted. Zero is a real measurement and is kept. */
    clientWidth: number | null;
    clientHeight: number | null;
}

/** Centre of the current view, in document coordinates. */
export function viewCentre(view: PlacementView): { x: number; y: number } {
    const width = view.clientWidth ?? UNMEASURED_CANVAS.width;
    const height = view.clientHeight ?? UNMEASURED_CANVAS.height;
    // THROUGH THE SANCTIONED CONVERSION, not a second copy of it. The old inline form restated
    // `(vp.x + screen) / zoom` by hand, with its own zoom floor to keep in step.
    return screenToWorld(view.viewport, { left: 0, top: 0 }, width / 2, height / 2);
}

export interface ImportPlacementHost {
    getView: () => PlacementView;
    getDocument: () => ReadonlyDocument;
    dispatch: (action: Action) => { success: boolean };
    select: (ids: string[]) => void;
    refresh: () => void;
    warn: (message: string) => void;
}

/**
 * The callbacks the folders drawer uses once an import has been decoded.
 *
 * SEQUENCE AND ASEPRITE HOLD ONLY THE PLACEMENT. Their actions are `sequenceImportActions` and
 * `asepriteImportActions`, for the same reason `importTiles` uses `tileImportActions`: a node
 * created inside a transaction exists in no document yet, so it cannot be reached through
 * `nodeEdit`. The native folder dialog cannot be driven from a probe, so everything that is not
 * placement already lives where a test can call it.
 */
export function bindImportPlacement(host: ImportPlacementHost) {
    /**
     * A folder of numbered images as one animated node.
     *
     * What lives here is only the placement — where on the canvas, at what size. The id comes
     * back from the actions, because the node it names is created inside the transaction.
     */
    const importSequence = (name: string, first: string, track: Keyframe[]) => {
        const doc = host.getDocument();
        const centre = viewCentre(host.getView());
        const { width, height } = PLACED_IMAGE_SIZE;
        const { actions, id } = sequenceImportActions(doc, {
            name, first, track, x: centre.x - width / 2, y: centre.y - height / 2, width, height
        });
        if (actions.length === 0) return;
        if (host.dispatch(new TransactionAction(doc, "import-sequence", actions)).success) {
            host.select([id]);
        }
        host.refresh();
    };

    /**
     * Place imported SVG shapes as `core.path` nodes.
     *
     * ONE TRANSACTION for the whole drawing. An SVG is a single picture, so a single undo should
     * remove it — and a node whose commands arrived in a later action would be an empty path if the
     * import were interrupted between the two, which is the trap the pen tool already avoids.
     */
    const importSvg = (specs: SvgNodeSpec[]) => {
        if (specs.length === 0) return;
        const doc = host.getDocument();
        const actions: Action[] = [];
        const ids: string[] = [];
        for (const spec of specs) {
            // The id is minted HERE so both halves can name it — the same reason the pen tool does.
            const id = generateUUID();
            ids.push(id);
            actions.push(new AddNodeAction(doc, "core.path", spec.geometry.x, spec.geometry.y,
                spec.geometry.width, spec.geometry.height, flatFill(spec.style.fill), id));
            actions.push(new UpdateNodePathAction(doc, id, spec.path));
        }
        host.dispatch(new TransactionAction(doc, "import-svg", actions));
        host.select(ids.slice(0, 1));
        host.refresh();
    };

    /**
     * An `.aseprite` as one node that plays, with the file's OWN timing and its tags as clips.
     *
     * The placement is all that lives here, as with `importSequence`. The file's own size is used,
     * unlike the sequence importer's fixed box: an `.aseprite` states its canvas, so inventing
     * 200×150 would stretch pixel art that came with exact dimensions.
     */
    const importAseprite = (p: AsepritePlacementInput) => {
        const doc = host.getDocument();
        const centre = viewCentre(host.getView());
        const { actions, id, droppedClips } = asepriteImportActions(doc, {
            ...p, x: centre.x - p.width / 2, y: centre.y - p.height / 2
        });
        if (actions.length === 0) return;
        if (host.dispatch(new TransactionAction(doc, "import-aseprite", actions)).success) {
            host.select([id]);
        }
        if (droppedClips > 0) {
            host.warn(`${droppedClips} tag(s) named frames outside the file's own timeline and were dropped.`);
        }
        host.refresh();
    };

    /**
     * A map as nodes: a whole layer as ONE grid where it fits, and one image per cell where it does
     * not.
     *
     * The node actions are `tileImportActions`. Tilesets, the map background and the map screen
     * travel in the SAME transaction: one import is one undo step, and a document that briefly had
     * the layers but not the sky is a state no author ever made. A background or screen the
     * document already has is left alone — placing a second map must not repaint or resize the first.
     */
    const importTiles = (placements: TilePlacement[], tilesets: Tileset[] = [],
                         background?: string, screen?: { width: number; height: number }) => {
        if (placements.length === 0) return;
        const doc = host.getDocument();
        const { actions, ids } = tileImportActions(doc, placements);
        const withSets = tilesets.length > 0
            ? [new SetTilesetsAction(doc, [...(doc.tilesets ?? []) as Tileset[], ...tilesets]), ...actions]
            : actions;
        const withSky = background !== undefined && doc.background === undefined
            ? [new SetBackgroundAction(doc, background), ...withSets]
            : withSets;
        const withScreen = screen !== undefined && doc.screen === undefined
            ? [new SetScreenAction(doc, screen), ...withSky]
            : withSky;
        host.dispatch(new TransactionAction(doc, "import-tiles", withScreen));
        host.select(ids.slice(0, 1));
        host.refresh();
    };

    /**
     * Place an asset from the folder browser. It lands at the centre of the CURRENT view (not
     * a fixed canvas point), inlined as a data: URL so the document stays self-contained.
     */
    const placeAsset = (dataUrl: string, name: string) => {
        const doc = host.getDocument();
        const centre = viewCentre(host.getView());
        const { width, height } = PLACED_IMAGE_SIZE;
        const cx = centre.x - width / 2;
        const cy = centre.y - height / 2;
        const action = new AddNodeAction(doc, "core.image", cx, cy, width, height, "none", undefined, null, { src: dataUrl });
        if (host.dispatch(action).success) {
            const id = action.getCreatedNodeId();
            if (id) {
                host.select([id]);
                // Name it after the file, so the layers panel shows something meaningful.
                const named = contentActionFor(host.getDocument(), id, { name });
                if (named) host.dispatch(named);
            }
        }
        host.refresh();
    };

    return { importSequence, importSvg, importAseprite, importTiles, placeAsset };
}
