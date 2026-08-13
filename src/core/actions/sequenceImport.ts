/**
 * @module sequenceImport
 * @description The actions a folder of numbered frames becomes — one image node that plays.
 *
 * HERE RATHER THAN IN THE PANEL, for the reason `tileImport` states and one more. A function
 * returning a list of actions can be TESTED; the same code inside an `onClick` cannot, and the code
 * inside that `onClick` is unreachable from any harness — `window.electronAPI` is frozen and
 * non-configurable, so the native folder dialog every importer starts with can be neither driven nor
 * stubbed from CDP. Whatever lives in the handler is verifiable only by reading it. So as little as
 * possible lives there.
 *
 * THE ID IS MINTED HERE so both halves can name it. The alternative — place the node, then set its
 * track through the panel's existing `importTrack` — reads `selectedNodeId` from a closure the
 * render has not rebuilt, so the track lands on whatever was selected BEFORE the import, or on
 * nothing at all. Minting first is what `importSvg` and the pen tool already do.
 *
 * FRAME ZERO IS ALSO THE NODE'S OWN `src`. A `core.image` whose source only ever arrives from a
 * keyframe is blank until the playhead moves, and blank forever in a document with no timeline —
 * so the first frame is written twice on purpose, once as content and once as the track's head.
 *
 * THE TIMELINE IS GROWN, NEVER SHRUNK. A track whose last keyframe sits past the end plays into a
 * wall; a timeline shortened to fit would truncate whatever else the document already animates.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Keyframe } from "../document/Timeline";
import { AddNodeAction } from "./AddNodeAction";
import { UpdateNodeContentAction } from "./UpdateNodeContentAction";
import { SetTrackAction } from "./SetTrackAction";
import { SetTimelineAction } from "./SetTimelineAction";
import { generateUUID } from "../ids/UUID";

/** Where the imported animation lands, and what it is called. */
export interface SequencePlacement {
    /** The run's stem — `fighter_Idle`, not `Image`. A folder holds a dozen of these. */
    name: string;
    /** Frame zero's href: the node's `src`, so it draws before the playhead has moved. */
    first: string;
    /** One keyframe per frame, as `sequenceTrack` builds them. */
    track: readonly Keyframe[];
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The default a document with no timeline is given. Matches the panel's own Timeline button. */
export const SEQUENCE_DEFAULT_FPS = 24;

/**
 * The actions, and the id they all name — empty when there is nothing to import.
 *
 * AN EMPTY TRACK YIELDS NO ACTIONS rather than a bare image node: "import an animation" that
 * produced a still frame would be a silent half-success, and the caller has nothing to undo.
 */
export function sequenceImportActions(
    doc: ReadonlyDocument, p: SequencePlacement
): { actions: Action[]; id: string } {
    if (p.track.length === 0) return { actions: [], id: "" };
    const id = generateUUID();
    const actions: Action[] = [
        new AddNodeAction(doc, "core.image", p.x, p.y, p.width, p.height, "none", id, null, { src: p.first }),
        // NAMED AFTER THE RUN. Constructed raw rather than through `nodeEdit`'s router, which
        // resolves against the LIVE document and answers null for a node this transaction has not
        // created yet — the same case `tileImport` documents.
        new UpdateNodeContentAction(doc, id, { name: p.name }),
        new SetTrackAction(doc, id, [...p.track])
    ];
    // The last keyframe's frame is an INDEX, so the timeline needs one more than that to reach it.
    const needed = p.track[p.track.length - 1].frame + 1;
    const current = doc.timeline;
    if (!current || current.frames < needed) {
        actions.push(new SetTimelineAction(doc, { frames: needed, fps: current?.fps ?? SEQUENCE_DEFAULT_FPS }));
    }
    return { actions, id };
}
