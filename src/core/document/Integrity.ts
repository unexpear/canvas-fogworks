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

function checkNodeRanges(node: ReadonlyNode): void {
    const g = node.geometry;
    for (const [field, value] of [["x", g.x], ["y", g.y], ["width", g.width], ["height", g.height]] as const) {
        if (!Number.isFinite(value)) {
            throw new Error(`Invalid document: node "${node.id}" geometry.${field} is not a finite number.`);
        }
    }
    if (g.width <= 0 || g.height <= 0) {
        throw new Error(
            `Invalid document: node "${node.id}" must have positive dimensions ` +
            `(got ${g.width}x${g.height}).`
        );
    }

    const s = node.style;
    if (!Number.isFinite(s.opacity) || s.opacity < 0 || s.opacity > 1) {
        throw new Error(`Invalid document: node "${node.id}" style.opacity must be within [0, 1] (got ${s.opacity}).`);
    }
    if (s.radius !== undefined && (!Number.isFinite(s.radius) || s.radius < 0)) {
        throw new Error(`Invalid document: node "${node.id}" style.radius must be >= 0 (got ${s.radius}).`);
    }
    if (s.fontSize !== undefined && (!Number.isFinite(s.fontSize) || s.fontSize <= 0)) {
        throw new Error(`Invalid document: node "${node.id}" style.fontSize must be > 0 (got ${s.fontSize}).`);
    }
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
    // 1. Per-node ranges.
    doc.nodes.forEach(node => checkNodeRanges(node));

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
