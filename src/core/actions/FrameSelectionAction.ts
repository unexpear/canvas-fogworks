/**
 * @module FrameSelectionAction
 * @description Wraps the selected nodes in a new parent frame sized to fit them.
 *
 * The editor's only way to BUILD a hierarchy. Nesting existed at the document layer from the
 * start (`ReparentNodeAction`, parent-relative geometry, the whole layout engine), but nothing
 * in the UI could create a parent — every drawn node was a root. So auto-layout, constraints
 * and multi-node component masters were all unreachable by drawing, and only testable in node
 * tests.
 *
 * The frame is an ordinary `core.rectangle`: this engine has no dedicated group type, and
 * masters, containers and frames are all just nodes with children. It takes the position and
 * size of the selection's bounding box and the z-position of its FRONTMOST member, and each
 * framed node's geometry is rebased onto it (stored geometry is parent-relative).
 *
 * SIBLINGS ONLY. Every selected node must already share one parent, which makes the rebase a
 * single subtraction that is exact — no matter how the shared parent (or a child) is rotated or
 * scaled, since inserting the frame introduces a pure translation within that one space.
 * Framing across different parents would need each node's transform chain re-expressed against
 * the frame, which is a different (and much larger) feature.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Node, dimensionError } from "../document/Node";
import { isLayoutContainer } from "../geometry/LayoutEngine";
import { compose, transformRectToAABB } from "../geometry/Matrix";
import { MutationResult, ActionPayload, NodeDelta } from "./types";
import { generateUUID } from "../ids/UUID";

/** Padding, in the parent's units, between the selection's bounds and the frame's edges. */
export const FRAME_PADDING = 0;

export class FrameSelectionAction extends Action {
    private nodeIds: string[];
    private fill: string;
    private frameId: string | null = null;

    constructor(document: ReadonlyDocument, nodeIds: readonly string[], fill = "#2a2a4a") {
        super(document);
        this.nodeIds = [...new Set(nodeIds)];
        this.fill = fill;
    }

    /** The selection's shared parent id, or `undefined` when they do not share one. `null` is a
     *  legitimate answer (they are all top-level roots), hence undefined for "no". */
    private sharedParent(): string | null | undefined {
        const parents = new Set(this.nodeIds.map(id => this.document.nodes.get(id)?.parent ?? null));
        return parents.size === 1 ? [...parents][0] : undefined;
    }

    /** The union of the selection's STORED rects — already in the shared parent's space, which
     *  is the space the frame is created in. */
    private bounds(): { x: number; y: number; width: number; height: number } | null {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const id of this.nodeIds) {
            const node = this.document.nodes.get(id);
            const g = node?.geometry;
            if (!g || ![g.x, g.y, g.width, g.height].every(Number.isFinite)) return null;
            // A ROTATED or SCALED child occupies its transformed AABB in the parent's space,
            // not its raw box — the frame is supposed to FIT what it wraps, and the frame paints
            // a fill behind it. The child's local matrix is entirely in the shared parent's
            // space, so no transform-chain walk is needed. (The REBASE below is unaffected: the
            // frame contributes a pure translation either way.)
            const box = node!.transform
                ? transformRectToAABB(
                    compose(g.x, g.y, node!.transform.rotation ?? 0, node!.transform.scaleX ?? 1, node!.transform.scaleY ?? 1,
                        g.width * (node!.transform.origin?.x ?? 0.5), g.height * (node!.transform.origin?.y ?? 0.5)),
                    { x: 0, y: 0, width: g.width, height: g.height })
                : { x: g.x, y: g.y, width: g.width, height: g.height };
            if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null;
            minX = Math.min(minX, box.x);
            minY = Math.min(minY, box.y);
            maxX = Math.max(maxX, box.x + box.width);
            maxY = Math.max(maxY, box.y + box.height);
        }
        if (!Number.isFinite(minX)) return null;
        return {
            x: minX - FRAME_PADDING,
            y: minY - FRAME_PADDING,
            width: (maxX - minX) + FRAME_PADDING * 2,
            height: (maxY - minY) + FRAME_PADDING * 2
        };
    }

    public validate(): boolean {
        if (this.nodeIds.length === 0) return false;
        // The one check with no backstop: nodes under DIFFERENT parents would be unioned across
        // unrelated coordinate spaces and rebased into a frame that means nothing for at least
        // one of them. Everything else below is defence in depth — an unresolvable id or
        // non-finite geometry also reaches `dimensionError` as a non-finite box, so removing any
        // single one of them still yields `false`, just by a less specific route. They stay
        // because they say what the precondition IS; don't mistake them for the only guard.
        if (this.sharedParent() === undefined) return false;
        // A child of an auto-layout or grid container has its stored x/y IGNORED — the layout
        // computes its position — so both the frame's box and the rebase would be built from
        // dead data, and the children visibly jump. Inserting a frame would also collapse N
        // in-flow children into one, changing the container's own flow and hug size. Framing
        // INSIDE a container is a real feature (it needs the frame to inherit the flow slot);
        // refusing is the honest interim, and the button follows validate() so it just greys out.
        const parentId = this.sharedParent();
        if (parentId != null && isLayoutContainer(this.document.nodes.get(parentId))) return false;
        // Covers an instance's materialized copy too: a virtual id contains `::`, reserved in
        // stored ids on both paths, so it never resolves here.
        const box = this.bounds();
        if (!box) return false;
        // The frame is a rectangle, so it obeys the rectangle rule — a selection of collinear
        // zero-height lines would otherwise produce a frame the loader rejects.
        return dimensionError("core.rectangle", box.width, box.height) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error("Validation failed: cannot frame this selection.");
        }
        const parentId = this.sharedParent() as string | null;
        const box = this.bounds()!;
        const frameId = this.frameId ?? generateUUID();
        this.frameId = frameId;

        // Frame the selection in its members' existing z-order, and put the frame where the
        // FRONTMOST of them sat: anywhere earlier would push the whole group behind siblings
        // that were previously in front of only part of it.
        const siblings = parentId
            ? (this.document.nodes.get(parentId)?.children ?? [])
            : this.document.rootNodeUuids;
        const ordered = [...this.nodeIds].sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b));
        const frontmost = Math.max(...ordered.map(id => siblings.indexOf(id)));

        const frame: Node = {
            id: frameId,
            type: "core.rectangle",
            parent: parentId,
            // Listed up front so `applyMutationsToDocument`'s reparent (which detaches from the
            // destination first) lands each child at its intended index rather than appending.
            children: [],
            geometry: box,
            style: { fill: this.fill, opacity: 1 },
            layout: {},
            name: "Frame"
        };

        const deltas = new Map<string, NodeDelta>();
        // The frame must exist before anything reparents into it.
        deltas.set(frameId, { kind: "add", node: frame, index: frontmost });
        ordered.forEach((id, i) => {
            const g = this.document.nodes.get(id)!.geometry;
            deltas.set(id, {
                kind: "patch",
                reparent: { parent: frameId, index: i },
                // Stored geometry is parent-relative: rebasing onto the frame's origin is what
                // keeps every framed node exactly where it was on screen.
                geometry: { x: g.x - box.x, y: g.y - box.y },
                // `constraintRef` is a FROZEN snapshot of the parent's size that the child is at
                // rest against, and `constraints` anchor it to that parent's edges. The frame is
                // a DIFFERENT parent of a different size, so leaving them would have
                // `resolveConstraints` shift the child by (frameSize − oldParentSize) and undo
                // the rebase. Cleared, exactly as `materializeNode` clears them on an instance
                // root copy for the same reason: the reference frame they describe is gone.
                layout: { constraints: undefined, constraintRef: undefined }
            });
        });

        const updatedNodeIds = new Set([frameId, ...this.nodeIds]);
        if (parentId) updatedNodeIds.add(parentId); // an auto-layout parent reflows around the frame

        return { updatedNodeIds, propertyDeltas: deltas, success: true };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "FrameSelectionAction",
            payload: { nodeId: this.frameId, nodeIds: [...this.nodeIds] },
            timestamp: Date.now()
        };
    }

    /** The id of the frame this action created (null before `execute`). */
    public getFrameId(): string | null {
        return this.frameId;
    }
}
