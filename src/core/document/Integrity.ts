/**
 * @module Integrity
 * @description Structural + range validation for a whole ProjectDocument.
 *
 * Action `validate()` guards the *edit* path, but until now nothing guarded the
 * *load* path — a hand-edited or third-party file could arrive with `opacity: 5`,
 * `width: -10`, a dangling `parent`, or a ghost entry in `rootNodeUuids`, and the
 * engine would happily accept it. This closes that gap: `deserializeDocument`
 * runs it, so an invalid document fails loudly at the boundary instead of
 * corrupting state later.
 */

import { ReadonlyDocument } from "./Document";
import { ReadonlyNode } from "./SceneGraph";
import { transformError, layoutError, dimensionError, pathError, booleanOpError, srcError, styleError, nodeIdError, variantError, variantSelectionError, slotError, slotContentError, variantNameError } from "./Node";
import { interactionsError } from "./Prototype";
import { timelineError, trackError } from "./Timeline";
import { depthError } from "./Depth";
import { overrideValueError } from "./Components";
import { componentError, overrideAgainstMasterError, overridesError, statesError } from "./Components";
import { variableStoreError, THEME_MODES } from "./Variables";

function checkNodeRanges(node: ReadonlyNode): void {
    const g = node.geometry;
    for (const [field, value] of [["x", g.x], ["y", g.y], ["width", g.width], ["height", g.height]] as const) {
        if (!Number.isFinite(value)) {
            throw new Error(`Invalid document: node "${node.id}" geometry.${field} is not a finite number.`);
        }
    }
    // Shared with the edit path so the two cannot drift; a `core.line` may collapse one axis.
    const dimErr = dimensionError(node.type, g.width, g.height);
    if (dimErr) {
        throw new Error(`Invalid document: node "${node.id}" ${dimErr} (got ${g.width}x${g.height}).`);
    }

    // Shared with the edit path (UpdateNodeStyleAction) so the two cannot drift; covers
    // fill/stroke/opacity/radius/fontSize AND the schema-18 shadow/blur effects.
    const styleErr = styleError(node.style);
    if (styleErr) throw new Error(`Invalid document: node "${node.id}" ${styleErr}.`);

    // The load path must reject exactly the transforms the edit path rejects — a
    // schema-2 file with scaleX:0 or rotation:Infinity would otherwise load clean and
    // produce a NaN / non-invertible (un-selectable) node.
    if (node.transform) {
        const err = transformError(node.transform);
        if (err) throw new Error(`Invalid document: node "${node.id}" ${err}.`);
    }
    const layoutErr = layoutError(node.layout);
    if (layoutErr) throw new Error(`Invalid document: node "${node.id}" ${layoutErr}.`);
    // `path` is a hand-editable, unbounded field — validate it (and reject it on a non-path
    // node) wherever it appears, sharing `pathError` with the edit path.
    const pathErr = pathError(node.type, node.path);
    if (pathErr) throw new Error(`Invalid document: node "${node.id}" ${pathErr}.`);
    // `booleanOp` (schema 33): only a `core.boolean` may carry one, and it must name a real
    // operation — a hand-edited "substract" would otherwise resolve as the default union and
    // draw a shape the file never described.
    const boolErr = booleanOpError(node.type, node.booleanOp);
    if (boolErr) throw new Error(`Invalid document: node "${node.id}" ${boolErr}.`);
    // `interactions` (schema 35): a hand-editable array of trigger/state pairs. A dangling STATE
    // name is deliberately allowed (it selects nothing, so the base shows) — the same rule every
    // other reference here follows.
    const interErr = interactionsError(node.interactions);
    if (interErr) throw new Error(`Invalid document: node "${node.id}" ${interErr}.`);
    // `src` (schema 23) is hand-editable and, since the image tool inlines a picked file as a
    // data: URL, potentially enormous — bounded and scheme-checked by the shared `srcError`.
    // `track` (schema 39): the TIMING is checked here and the VALUES by `overrideValueError`,
    // which is the rule a state and an instance override already obey — animation added a field,
    // not a second definition of what a node may say about itself.
    const depthErr = depthError(node.depth);
    if (depthErr) throw new Error(`Invalid document: node "${node.id}" ${depthErr}.`);
    const trackErr = trackError(node.track, v => overrideValueError("keyframe", v));
    if (trackErr) throw new Error(`Invalid document: node "${node.id}" ${trackErr}.`);
    const srcErr = srcError(node.type, node.src);
    if (srcErr) throw new Error(`Invalid document: node "${node.id}" ${srcErr}.`);
    // `componentId` (M6): only an instance may carry one; a DANGLING reference is deliberately
    // allowed (it draws nothing), so deleting a master never makes a document unloadable.
    const compErr = componentError(node.type, node.componentId);
    if (compErr) throw new Error(`Invalid document: node "${node.id}" ${compErr}.`);
    // Per-instance overrides (schema 22): the same shared-validator discipline; each field is
    // checked by the rule its stored counterpart obeys, and a key matching no master node is
    // inert rather than invalid.
    const ovrErr = overridesError(node.type, node.overrides);
    if (ovrErr) throw new Error(`Invalid document: node "${node.id}" ${ovrErr}.`);
    // Variants (schema 27): a master's place in a set, and an instance's selection within it.
    // Both are hand-editable maps, so both are bounded and reserved-key-checked; a selection
    // naming a property the set never defines is inert, not invalid.
    const varErr = variantError(node.variant);
    if (varErr) throw new Error(`Invalid document: node "${node.id}" ${varErr}.`);
    const selErr = variantSelectionError(node.type, node.variants);
    if (selErr) throw new Error(`Invalid document: node "${node.id}" ${selErr}.`);
    // Slots (schema 29): a named hole in a master, and what an instance puts in it. Neither
    // side is required to resolve — an unfilled slot draws its own default children.
    const slotErr = slotError(node.slot);
    if (slotErr) throw new Error(`Invalid document: node "${node.id}" ${slotErr}.`);
    const scErr = slotContentError(node.type, node.slotContent);
    if (scErr) throw new Error(`Invalid document: node "${node.id}" ${scErr}.`);
    // States (M7, schema 30). Declared since M0 as `{[key: string]: any}` and validated by
    // nothing — the dead-but-consumed field the schema doc warns against. Now it obeys the
    // same per-field rules an instance override does.
    const stErr = statesError(node.states);
    if (stErr) throw new Error(`Invalid document: node "${node.id}" ${stErr}.`);
}

/**
 * Throws a descriptive Error on the first problem found. Checks:
 *  - numeric ranges (finite geometry, positive size, opacity/radius/fontSize bounds)
 *  - every `parent` resolves to an existing node
 *  - every `children` entry resolves, is claimed once, and back-points via `parent`
 *  - `rootNodeUuids` entries exist, are unique, and have no parent
 *  - every parentless node appears in `rootNodeUuids`
 *  - the tree is acyclic
 */
export function validateDocumentIntegrity(doc: ReadonlyDocument): void {
    // 0. Document-level fields (schema 19): the variable store + active theme, shared with
    // the edit path (variable actions) so load and edit cannot drift.
    const varErr = variableStoreError(doc.variables);
    if (varErr) throw new Error(`Invalid document: ${varErr}.`);
    // The clock (schema 39). `frame` is NOT range-checked against it: a frame past the end is
    // clamped by the track lookup, which holds the last keyframe, and refusing to open a file
    // because its playhead was left beyond the end would be a cure worse than the disease.
    const tlErr = timelineError(doc.timeline);
    if (tlErr) throw new Error(`Invalid document: ${tlErr}.`);
    if (doc.frame !== undefined && (!Number.isFinite(doc.frame) || doc.frame < 0)) {
        throw new Error(`Invalid document: frame must be a finite number >= 0.`);
    }
    if (!(THEME_MODES as readonly string[]).includes(doc.activeTheme as string)) {
        throw new Error(`Invalid document: activeTheme must be one of ${THEME_MODES.join("/")} (got "${String(doc.activeTheme)}").`);
    }
    // `activeState` (M7) is free-form — any name a node might define — so it is bounded and
    // reserved-key-checked rather than enumerated. Naming a state NOTHING defines is fine:
    // the document simply shows its base, the same way an unknown theme never could.
    if (doc.activeState !== undefined) {
        const e = variantNameError("activeState", doc.activeState, true);
        if (e) throw new Error(`Invalid document: ${e}.`);
    }

    // 1. Per-node ranges — and no node may claim the reserved document-delta id (it would
    // collide with doc-level deltas in the action layer's node-id-keyed map).
    doc.nodes.forEach(node => {
        // Reserved ids: the document-delta sentinel, and any id containing the virtual-id
        // separator (it would collide with an expanded instance's materialized copies).
        const idErr = nodeIdError(node.id);
        if (idErr) throw new Error(`Invalid document: ${idErr}.`);
        checkNodeRanges(node);
        // The type-aware half of override validation needs the DOCUMENT (to resolve each key's
        // master and read its type), so it runs here rather than in `checkNodeRanges`.
        const dimErr = overrideAgainstMasterError(doc, node);
        if (dimErr) throw new Error(`Invalid document: node "${node.id}" ${dimErr}.`);
    });

    // 2. Parent references resolve.
    doc.nodes.forEach(node => {
        if (node.parent != null && !doc.nodes.has(node.parent)) {
            throw new Error(`Invalid document: node "${node.id}" has a dangling parent "${node.parent}".`);
        }
    });

    // 3. Children resolve, are claimed exactly once, and back-point correctly.
    const claimedBy = new Map<string, string>();
    doc.nodes.forEach(node => {
        for (const childId of node.children) {
            const child = doc.nodes.get(childId);
            if (!child) {
                throw new Error(`Invalid document: node "${node.id}" lists a missing child "${childId}".`);
            }
            const existing = claimedBy.get(childId);
            if (existing !== undefined) {
                throw new Error(
                    `Invalid document: node "${childId}" is a child of both "${existing}" and "${node.id}".`
                );
            }
            claimedBy.set(childId, node.id);
            if (child.parent !== node.id) {
                throw new Error(
                    `Invalid document: node "${childId}" is listed under "${node.id}" ` +
                    `but its parent is "${child.parent}".`
                );
            }
        }
    });

    // 3b. …and the link is bidirectional. Without this, a node may point at a
    // parent that does not list it: traversal renders it in the wrong place, and
    // deleting that parent leaves it orphaned — producing a file that then fails
    // to load at all. Checking only parent→children misses it entirely.
    doc.nodes.forEach(node => {
        if (node.parent != null && claimedBy.get(node.id) !== node.parent) {
            throw new Error(
                `Invalid document: node "${node.id}" claims parent "${node.parent}", ` +
                `but that node does not list it as a child.`
            );
        }
    });

    // 4. Roots exist, are unique, and are genuinely parentless.
    const seenRoots = new Set<string>();
    for (const rootId of doc.rootNodeUuids) {
        const root = doc.nodes.get(rootId);
        if (!root) {
            throw new Error(`Invalid document: rootNodeUuids references a missing node "${rootId}".`);
        }
        if (seenRoots.has(rootId)) {
            throw new Error(`Invalid document: rootNodeUuids contains "${rootId}" more than once.`);
        }
        seenRoots.add(rootId);
        if (root.parent != null) {
            throw new Error(`Invalid document: node "${rootId}" is a root but also has parent "${root.parent}".`);
        }
    }

    // 5. Every parentless node is reachable as a root.
    doc.nodes.forEach(node => {
        if (node.parent == null && !seenRoots.has(node.id)) {
            throw new Error(`Invalid document: node "${node.id}" has no parent but is not in rootNodeUuids.`);
        }
    });

    // 6. No cycles (walk up from each node to a root).
    doc.nodes.forEach(node => {
        const seen = new Set<string>([node.id]);
        let cursor = node.parent;
        while (cursor != null) {
            if (seen.has(cursor)) {
                throw new Error(`Invalid document: parent chain from "${node.id}" contains a cycle at "${cursor}".`);
            }
            seen.add(cursor);
            cursor = doc.nodes.get(cursor)?.parent ?? null;
        }
    });
}
