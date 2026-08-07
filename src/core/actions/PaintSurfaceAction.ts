/**
 * @module PaintSurfaceAction
 * @description A stroke, through the dispatcher.
 *
 * This is what makes painting part of the document rather than beside it. Every other edit in this
 * engine is an Action — validated, undoable, transactable, serializable — and a paint tool that
 * kept its own undo stack would be the one feature that could not participate in a transaction, a
 * component override, or a coalesced drag.
 *
 * THE ACTION CARRIES A PATCH, NOT A SURFACE. A 4096-square RGBA buffer is 67 MB; an action holding
 * one would make twenty pencil dots cost 1.3 GB of history. It carries the RECTANGLE that changed,
 * which for two dots is a few dozen bytes — and `PixelPatch` already measures that rectangle rather
 * than trusting the caller's estimate.
 *
 * THE NEW PAYLOAD IS COMPUTED HERE, NOT PASSED IN. A caller hands over the patch describing what a
 * stroke did; this re-encodes the surface with it applied. That keeps the document's stored text
 * and the patch from ever disagreeing — a caller that computed both could get them out of step, and
 * the disagreement would only show on the next load.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { rasterSurfaceError } from "../document/Node";
import { MutationResult, ActionPayload } from "./types";
import { PixelPatch, applyPatch, isEmptyPatch } from "../paint/PixelPatch";
import { decodeSurface, encodeSurface } from "../paint/PixelCodec";

export class PaintSurfaceAction extends Action {
    private nodeId: string;
    private patch: PixelPatch;

    constructor(document: ReadonlyDocument, nodeId: string, patch: PixelPatch) {
        super(document);
        this.nodeId = nodeId;
        this.patch = patch;
    }

    public validate(): boolean {
        const node = this.document.nodes.get(this.nodeId);
        if (!node) return false;
        // A raster node is the only thing that HAS a surface. This is REDUNDANT with the check
        // below — nothing else carries one — and is kept because "only a raster node is paintable"
        // is a rule, while "nothing else happens to have that field" is a fact that could change.
        if (node.type !== "core.raster") return false;
        if (!node.surface || rasterSurfaceError(node.surface) !== null) return false;
        // AN EMPTY PATCH IS INVALID, not a harmless no-op: it would put an undo step on the stack
        // that undoes nothing, so a user pressing undo once would appear to have been ignored.
        if (isEmptyPatch(this.patch)) return false;
        // The patch must actually LIE on the surface. A stroke captured against a different-sized
        // surface would otherwise write into the wrong rows.
        const { width, height } = node.surface;
        return this.patch.x >= 0 && this.patch.y >= 0
            && this.patch.x + this.patch.width <= width
            && this.patch.y + this.patch.height <= height;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: cannot paint node "${this.nodeId}".`);
        }
        const node = this.document.nodes.get(this.nodeId);
        const stored = node!.surface!;
        // DECODED, PATCHED, RE-ENCODED. Storing the patch alongside the old payload would be
        // cheaper and would mean the document's text no longer described its own pixels — every
        // reader would have to know to replay a history to see the picture.
        const buffer = decodeSurface(stored.data, stored.width, stored.height);
        if (!buffer) {
            throw new Error(`Validation failed: node "${this.nodeId}" holds a surface that will not decode.`);
        }
        // NO REVERSE FLAG. An earlier version took one, and a mutation showed nothing exercised
        // it — because the dispatcher undoes by REPLAYING DELTAS, not by running an inverted
        // action. A parameter no path reaches is a second way to express undo that could disagree
        // with the real one, so it was removed rather than tested into existence.
        applyPatch(buffer, this.patch);
        const encoded = encodeSurface(buffer);
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, {
                kind: "patch",
                surface: { data: encoded.data, width: stored.width, height: stored.height }
            } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "PaintSurfaceAction",
            payload: {
                nodeId: this.nodeId,
                // The patch's BYTES are deliberately absent from the serialized form: an action log
                // is for replay and diagnosis, and a megabyte of pixels per stroke would drown it.
                // The rectangle is what identifies the edit; the pixels live in the document.
                patch: { x: this.patch.x, y: this.patch.y, width: this.patch.width, height: this.patch.height }
            },
            timestamp: Date.now()
        };
    }
}
