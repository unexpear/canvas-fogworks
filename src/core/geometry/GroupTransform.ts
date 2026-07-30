/**
 * @module GroupTransform
 * @description Pure math for rotating a MULTI-SELECTION as a rigid group about a shared pivot —
 * the geometry behind M4's group rotate handle. Each selected root is rotated RIGIDLY about the
 * group's pivot: its own rotation gains the same delta AND its centre ORBITS the pivot. Because a
 * node's own rotation is about its box CENTRE (the default origin), orbiting that centre by δ and
 * adding δ to the rotation reproduces a rigid rotation of the whole node about the pivot — this is
 * exactly `R(δ+θ)·q + C'` where `C' = pivot + R(δ)·(C − pivot)` (see the derivation in the tests).
 *
 * Pure and DOM-free (node-tested like `computeSnap`). The tool (`ToolController`) captures each
 * root's start pose at mouse-down and calls `rotateGroup` every frame with the TOTAL delta from the
 * start angle, so nothing compounds; it commits the absolute poses coalesced into one undo step.
 */

import { ReadonlyDocument } from "../document/Document";
import { isAbsolute, isLayoutContainer } from "./LayoutEngine";
import { isTranslationOnlyChain } from "./Snapping";

/** One root's state captured at gesture start, enough to compute its rotated pose each frame. */
export interface GroupRotateInput {
    id: string;
    /** Stored geometry x/y at gesture start (the parent-relative box top-left). */
    startX: number;
    startY: number;
    /** The node's own rotation (radians) at gesture start. */
    startRotation: number;
    /** The node's world-AABB CENTRE at gesture start (== its box centre for a centre-origin node). */
    centerX: number;
    centerY: number;
}

/** One root's new pose: stored x/y (orbited about the pivot) + new absolute rotation. */
export interface GroupRotateOutput {
    id: string;
    x: number;
    y: number;
    rotation: number;
}

/**
 * Rotate every input root rigidly about (`pivotX`, `pivotY`) by `delta` radians — clockwise, in the
 * y-down screen/world convention, matching `Transform.rotation` and `Matrix.compose`'s `R`. For each
 * root: `rotation = startRotation + delta`, and its centre orbits the pivot by `delta`. Since the
 * parent chain is translation-only (see `isGroupRotatable`), the change in WORLD centre equals the
 * change in STORED x/y, so `x = startX + (orbitedCx − centerX)`. Absolute in `delta` (not
 * incremental), so calling it each frame with the total delta never compounds.
 */
export function rotateGroup(
    pivotX: number,
    pivotY: number,
    delta: number,
    inputs: readonly GroupRotateInput[]
): GroupRotateOutput[] {
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    return inputs.map(n => {
        const rx = n.centerX - pivotX;
        const ry = n.centerY - pivotY;
        // R(delta) = [cos -sin; sin cos] — the SAME rotation `Matrix.compose` applies to a node's
        // own local points, so "orbit the centre + add delta to the rotation" is a rigid rotation.
        const cx2 = pivotX + cos * rx - sin * ry;
        const cy2 = pivotY + sin * rx + cos * ry;
        return {
            id: n.id,
            x: n.startX + (cx2 - n.centerX),
            y: n.startY + (cy2 - n.centerY),
            rotation: n.startRotation + delta
        };
    });
}

/** Every STRICT ancestor of `nodeId` is transform-free (the node ITSELF may be rotated/scaled). */
function isTranslationOnlyParentChain(doc: ReadonlyDocument, nodeId: string): boolean {
    const seen = new Set<string>([nodeId]);
    let id: string | null = doc.nodes.get(nodeId)?.parent ?? null;
    while (id !== null && !seen.has(id)) {
        seen.add(id);
        const n = doc.nodes.get(id);
        if (!n || n.transform) return false;
        id = n.parent ?? null;
    }
    return true;
}

/**
 * Whether a group of roots can be rigidly rotated by `rotateGroup`. Requires, for EVERY root:
 *   - a CENTRE transform origin (absent or exactly {0.5, 0.5}) — so its world-AABB centre equals its
 *     box centre, the fixed point the orbit assumes under the node's own rotation;
 *   - a translation-only PARENT chain — so a world orbit delta maps 1:1 to stored x/y;
 *   - stored geometry actually DRIVES its position — i.e. it is NOT an in-flow child of an auto-layout
 *     container (whose x/y the layout engine computes and IGNORES; the same class `MoveTool` skips).
 *     Rotating such a child would apply the spin but discard the orbit → members spin in place, a
 *     non-rigid group rotation. An `absolute` child escapes layout and stays eligible.
 * Empty set → false. A group that fails this shows NO rotate knob (see `SelectionHandles`/
 * `RenderModel`) rather than rotating incorrectly — a documented scope.
 */
export function isGroupRotatable(doc: ReadonlyDocument, rootIds: readonly string[]): boolean {
    if (rootIds.length === 0) return false;
    return rootIds.every(id => {
        const n = doc.nodes.get(id);
        if (!n) return false;
        const o = n.transform?.origin;
        const centreOrigin = !o || (o.x === 0.5 && o.y === 0.5);
        // Laid-out children are positioned by the layout engine, not stored x/y, so the orbit is lost.
        const parent = n.parent ? doc.nodes.get(n.parent) : undefined;
        const laidOut = isLayoutContainer(parent) && !isAbsolute(n);
        return centreOrigin && !laidOut && isTranslationOnlyParentChain(doc, id);
    });
}

/** One root's state captured at a group-resize grab. `startX/Y` are STORED geometry; `worldX/Y`
 *  the world-AABB origin (equal in extent for an eligible root, but offset under a translated
 *  parent — the scale runs in WORLD, and the world delta maps 1:1 back to stored). */
export interface GroupScaleInput {
    id: string;
    startX: number;
    startY: number;
    worldX: number;
    worldY: number;
    startWidth: number;
    startHeight: number;
}

/** One root's new stored geometry after the group scale. */
export interface GroupScaleOutput {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Scale every input root about a FIXED world point (the group box corner opposite the dragged
 * handle) by (`sx`, `sy`) — positions orbit the fixed point linearly, sizes scale. Valid ONLY
 * for `isGroupResizable` roots (node + ancestors transform-free): axis-aligned boxes scale to
 * axis-aligned boxes (no shear — the reason ROTATED sets can't group-resize), stored size ==
 * world size, and the world position delta maps 1:1 to stored x/y. Like `rotateGroup`, it is
 * absolute in (`sx`, `sy`) — each frame recomputes from the captured start poses, nothing
 * compounds. Callers keep `sx`/`sy` > 0 (the tool clamps the group extent at 1 world unit; a
 * flip would mirror member POSITIONS while leaving their content unmirrored — misleading).
 */
export function scaleGroup(
    fixedX: number,
    fixedY: number,
    sx: number,
    sy: number,
    inputs: readonly GroupScaleInput[]
): GroupScaleOutput[] {
    return inputs.map(n => {
        const newWorldX = fixedX + (n.worldX - fixedX) * sx;
        const newWorldY = fixedY + (n.worldY - fixedY) * sy;
        return {
            id: n.id,
            x: n.startX + (newWorldX - n.worldX),
            y: n.startY + (newWorldY - n.worldY),
            width: n.startWidth * sx,
            height: n.startHeight * sy
        };
    });
}

/**
 * Whether a group of roots can be proportionally resized by `scaleGroup`. STRICTER than
 * `isGroupRotatable`: every root must be entirely transform-free INCLUDING itself
 * (`isTranslationOnlyChain` — a rotated/scaled member scaled non-uniformly is a SHEAR the
 * rotation+scale transform model cannot represent, the documented inherent limit) and not an
 * in-flow auto-layout child (its stored geometry is ignored, the same class `MoveTool` skips).
 * Empty set → false. An ineligible group shows NO corner handles rather than shearing.
 */
export function isGroupResizable(doc: ReadonlyDocument, rootIds: readonly string[]): boolean {
    if (rootIds.length === 0) return false;
    return rootIds.every(id => {
        const n = doc.nodes.get(id);
        if (!n) return false;
        const parent = n.parent ? doc.nodes.get(n.parent) : undefined;
        const laidOut = isLayoutContainer(parent) && !isAbsolute(n);
        return !laidOut && isTranslationOnlyChain(doc, id);
    });
}
