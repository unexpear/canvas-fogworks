/**
 * @module nodeEdit
 * @description Routes an edit to the right Action for the node it targets (M6 slice 2).
 *
 * With component instances, a selected id can be one of two things: a STORED node (edit it
 * directly) or a VIRTUAL node — an instance's materialized copy, which has no stored geometry
 * to change. Editing a copy must instead record a per-instance OVERRIDE, so the master and
 * every other instance are untouched.
 *
 * Every tool that commits a geometry/style edit goes through here, so the rule lives in ONE
 * place: without it each tool would have to know about virtual ids, and a missed site would
 * silently dispatch an action that fails validation (the node isn't in the document) — an edit
 * that appears to do nothing.
 *
 * Returns null when the edit cannot be expressed: a virtual node whose owning instance no
 * longer exists, or a virtual node nested INSIDE another instance's expansion (overriding
 * through a nested instance is a documented deferral). A null result means "don't dispatch".
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Style } from "../document/Node";
import { Geometry } from "../document/Node";
import { isVirtualId, ownerInstanceOf, splitVirtualId } from "../document/Components";
import { UpdateNodeGeometryAction } from "./UpdateNodeGeometryAction";
import { UpdateNodeStyleAction } from "./UpdateNodeStyleAction";
import { SetInstanceOverrideAction } from "./SetInstanceOverrideAction";

/**
 * The instance + master node a VIRTUAL id's override should be written against, or null when
 * the id is stored, unowned, or nested one level deeper than overrides currently reach.
 *
 * The nested case is what the `instancePath === owner` check rules out: for `I::MC` the owner
 * (`I`) IS the whole instance path, so the override belongs on the stored instance `I` under
 * key `MC`. For `I::OI::IM` the path is `I::OI` — a VIRTUAL instance node, which cannot carry a
 * stored override — so the edit is refused rather than written to the wrong node.
 */
export function overrideTargetFor(doc: ReadonlyDocument, nodeId: string): { instanceId: string; masterNodeId: string } | null {
    const split = splitVirtualId(nodeId);
    const owner = ownerInstanceOf(nodeId);
    if (!split || owner === null) return null;
    if (split.instancePath !== owner) return null;            // nested — deferred, never mis-target
    const instance = doc.nodes.get(owner);
    if (!instance || instance.type !== "core.instance") return null;
    return { instanceId: owner, masterNodeId: split.masterNodeId };
}

/**
 * The copy of the master's own ROOT node — the one virtual node whose POSITION is not its own:
 * expansion re-origins it to (0,0) because the INSTANCE's geometry is what places the content
 * (`expandInstances`'s `x: 0, y: 0`). It is the master root exactly when the override key equals
 * the instance's `componentId`. Size overrides on it are honoured; x/y are not.
 */
function isMasterRootTarget(doc: ReadonlyDocument, target: { instanceId: string; masterNodeId: string }): boolean {
    return doc.nodes.get(target.instanceId)?.componentId === target.masterNodeId;
}

/** True for the virtual node that copies its master's ROOT (see `isMasterRootTarget`) — tools
 *  use it to withhold a MOVE affordance that would preview a change the document can't keep. */
export function isMasterRootCopy(doc: ReadonlyDocument, nodeId: string): boolean {
    const target = overrideTargetFor(doc, nodeId);
    return target !== null && isMasterRootTarget(doc, target);
}

/** The Action that applies a GEOMETRY patch to `nodeId` — direct for a stored node, an
 *  override for an instance copy. Null when the edit cannot be expressed (don't dispatch). */
export function geometryActionFor(doc: ReadonlyDocument, nodeId: string, patch: Partial<Geometry>): Action | null {
    if (!isVirtualId(nodeId)) {
        return doc.nodes.has(nodeId) ? new UpdateNodeGeometryAction(doc, nodeId, patch) : null;
    }
    const target = overrideTargetFor(doc, nodeId);
    if (!target) return null;
    let geometry = patch;
    if (isMasterRootTarget(doc, target)) {
        // Drop x/y rather than write what expansion will throw away: an inert override that
        // dirties the document and pushes an undo step for a gesture that changed nothing. The
        // rule belongs HERE — enforcing it only where a tool happens to check would leave every
        // other edit site (the inspector's X/Y fields) writing the discarded value.
        const { x, y, ...rest } = patch;
        void x; void y;
        if (Object.keys(rest).length === 0) return null;
        geometry = rest;
    }
    return new SetInstanceOverrideAction(doc, target.instanceId, target.masterNodeId, { geometry });
}

/** The Action that applies a STYLE patch to `nodeId` — direct, or an override for a copy. */
export function styleActionFor(doc: ReadonlyDocument, nodeId: string, patch: Partial<Style>): Action | null {
    if (!isVirtualId(nodeId)) {
        return doc.nodes.has(nodeId) ? new UpdateNodeStyleAction(doc, nodeId, patch) : null;
    }
    const target = overrideTargetFor(doc, nodeId);
    return target ? new SetInstanceOverrideAction(doc, target.instanceId, target.masterNodeId, { style: patch }) : null;
}

/** Whether `nodeId` can be edited at all (a stored node, or an override-able instance copy).
 *  Tools use this to gate an affordance rather than offer a control that would do nothing. */
export function isEditableNode(doc: ReadonlyDocument, nodeId: string): boolean {
    return isVirtualId(nodeId) ? overrideTargetFor(doc, nodeId) !== null : doc.nodes.has(nodeId);
}

/**
 * Whether a per-node selection handle is OFFERED for `nodeId` — the single rule read by all
 * three sites that must agree: the renderer (what is drawn), the picker (what a press grabs),
 * and the hover cursor (what the pointer promises). Splitting it three ways is how they drift,
 * and a handle that is drawn but not grabbable — or grabbable but never drawn — is worse than
 * no handle at all.
 *
 * A stored node offers all of them. An instance COPY offers only its RESIZE corners, and only
 * when it can actually hold an override: rotation would need a TRANSFORM override (a later
 * slice), and a copy nested inside another instance's expansion cannot be targeted at all.
 */
export function isHandleOffered(doc: ReadonlyDocument, nodeId: string, handle: string): boolean {
    if (!isVirtualId(nodeId)) return true;
    return handle !== "rotate" && isEditableNode(doc, nodeId);
}
