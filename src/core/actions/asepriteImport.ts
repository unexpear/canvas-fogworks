/**
 * @module asepriteImport
 * @description What an `.aseprite` becomes: one node that plays, with the file's own timing and its
 * tags as named clips.
 *
 * THE WHOLE ARGUMENT FOR READING THIS FORMAT is that it states what every other importer has to
 * reconstruct. A sheet's grid is recovered by dividing an image; a trim by scanning pixels; a frame
 * duration is invented outright, because a folder of PNGs has none. This file declares all three,
 * and its TAGS are `Clip` field for field — so importing them is a rename rather than a translation.
 *
 * WHICH IS WHY IT NEEDED THREE THINGS BUILT FIRST, none of them about Aseprite:
 *   - `composeFrame`, because the reader could describe a file perfectly and draw nothing;
 *   - `SetClipsAction`, because `Document.clips` had no write path at all, so the field the tags map
 *     onto had nowhere to land;
 *   - document deltas keyed BY KIND, because a transaction could carry only one document-level
 *     change and this carries two — the clock and the ranges that index into it.
 * An importer is only as good as the destination it has.
 *
 * ONE TRANSACTION, so one undo removes the node, its name, its track, the clock and the clips
 * together. Half an import is a document nobody authored.
 *
 * THE CLIPS ARE VALIDATED AGAINST THE CLOCK ARRIVING WITH THEM, not the document's current one —
 * which is usually absent, and would refuse every range in the file.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Keyframe } from "../document/Timeline";
import { Clip } from "../document/Clips";
import { AddNodeAction } from "./AddNodeAction";
import { UpdateNodeContentAction } from "./UpdateNodeContentAction";
import { SetTrackAction } from "./SetTrackAction";
import { SetTimelineAction } from "./SetTimelineAction";
import { SetClipsAction } from "./SetClipsAction";
import { generateUUID } from "../ids/UUID";

/** An `.aseprite`, reduced to what the document layer needs. */
export interface AsepritePlacement {
    /** The file's name, minus its extension — what the layers panel shows. */
    name: string;
    /** Frame zero's href: the node's `src`, so it draws before the playhead has moved. */
    first: string;
    /** One keyframe per frame, `src` stepping. */
    track: readonly Keyframe[];
    /** The file's own clock: `asepriteTimeline`. */
    timeline: { frames: number; fps: number };
    /** The file's tags: `asepriteClips`. Empty is normal — most files carry none. */
    clips: readonly Clip[];
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * The actions, and the id they all name — empty when there is nothing to import.
 *
 * CLIPS THE CLOCK CANNOT HOLD ARE DROPPED, not carried. A tag whose range runs past the last frame
 * is a file disagreeing with itself, and `clipsError` refuses the whole list for one bad entry —
 * which would cost the import over a detail. Dropping is reported by the caller through the count,
 * so a person can see it happened.
 */
export function asepriteImportActions(
    doc: ReadonlyDocument, p: AsepritePlacement
): { actions: Action[]; id: string; droppedClips: number } {
    if (p.track.length === 0) return { actions: [], id: "", droppedClips: 0 };
    const id = generateUUID();
    const actions: Action[] = [
        new AddNodeAction(doc, "core.image", p.x, p.y, p.width, p.height, "none", id, null, { src: p.first }),
        new UpdateNodeContentAction(doc, id, { name: p.name }),
        new SetTrackAction(doc, id, [...p.track]),
        // THE CLOCK COMES FROM THE FILE, which is the point: Aseprite times every frame and this
        // engine has one rate, so `asepriteTimeline` picks the shortest — the only choice that
        // expresses every frame as a whole number of ticks.
        new SetTimelineAction(doc, p.timeline)
    ];

    const kept = p.clips.filter(c => c.from >= 0 && c.to >= c.from && c.to <= p.timeline.frames - 1);
    if (kept.length > 0) {
        // VALIDATED AGAINST THE CLOCK ABOVE, not the document's — the document usually has none
        // yet, and `SetClipsAction` would refuse every range in the file.
        actions.push(new SetClipsAction(doc, kept.map(c => ({ ...c })), p.timeline));
    }
    return { actions, id, droppedClips: p.clips.length - kept.length };
}
