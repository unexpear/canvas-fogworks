/**
 * @module Clipboard
 * @description Copy, cut and paste — the most reflexive thing a person tries in any editor, and
 * the one this engine did nothing at all for.
 *
 * THE CLIPBOARD HOLDS NODES, NOT IDS, and that is the whole design. Copy could have remembered the
 * selection and let paste re-run `DuplicateNodesAction` on it — three lines, and broken in the one
 * case that matters: CUT deletes the originals, so a paste that reaches back for them finds
 * nothing. Detaching a real copy at copy time is what makes cut-then-paste work, and it is also
 * what would let a second window paste from a first.
 *
 * ROOTS ONLY, like duplication. A child already travels inside its parent's copy, so copying both
 * produces it twice — and the second copy is the one that looks like a bug, because it is
 * identical and exactly on top.
 *
 * IDS ARE MINTED AT PASTE, NOT AT COPY. One copy pasted three times must give three distinct sets
 * of nodes; minting at copy would give the same ids each time and the second paste would collide
 * with the first. It also means the payload can be held indefinitely without reserving anything.
 *
 * A REFERENCE OUT OF THE PAYLOAD IS LEFT ALONE. An instance names its master by `componentId`, and
 * copying the instance without its master must keep pointing at the ORIGINAL master — remapping it
 * blindly would point at nothing, and the paste would render empty. Only links whose target is
 * inside the payload are rewritten; the same rule `$token` and `componentId` already follow.
 */

import { Node } from "./Node";
import { ReadonlyDocument } from "./Document";
import { generateUUID } from "../ids/UUID";

/** How far a paste lands from the original, in world units, so it is visible and grabbable. */
export const PASTE_OFFSET = 20;

/** A detached copy of some nodes: complete, and owned by nobody. */
export interface ClipboardContents {
    /** Every node in the copied subtrees, originals' ids intact. */
    nodes: Node[];
    /** The subtree roots, in the order they were copied. */
    rootIds: string[];
}

/** A deep copy, so nothing the clipboard holds shares an object with the document. */
function detach(node: Node): Node {
    const copy: Node = {
        ...node,
        geometry: { ...node.geometry },
        style: { ...node.style },
        layout: { ...node.layout },
        children: [...node.children]
    };
    // EVERY MUTABLE FIELD ITS OWN. A shallow copy leaves the clipboard sharing arrays with the
    // document, so editing the original afterwards would silently change what pastes — and the
    // paste would look like it had been corrupted by something unrelated.
    if (node.transform) copy.transform = { ...node.transform };
    if (node.path) copy.path = node.path.map(c => ({ ...c }));
    if (node.overrides) copy.overrides = JSON.parse(JSON.stringify(node.overrides));
    if (node.surface) copy.surface = { ...node.surface };
    return copy;
}

/**
 * The selection, detached from the document.
 *
 * Returns null when there is nothing copyable, so a caller can leave the clipboard's previous
 * contents ALONE rather than clearing it — pressing Ctrl+C with nothing selected should not
 * destroy what you copied a minute ago.
 */
export function copyNodes(doc: ReadonlyDocument, ids: readonly string[]): ClipboardContents | null {
    // ROOTS ONLY: drop any id whose ancestor is also selected.
    const selected = new Set(ids.filter(id => doc.nodes.has(id)));
    const isCovered = (id: string): boolean => {
        let parent = doc.nodes.get(id)?.parent ?? null;
        while (parent) {
            if (selected.has(parent)) return true;
            parent = doc.nodes.get(parent)?.parent ?? null;
        }
        return false;
    };
    const rootIds = [...selected].filter(id => !isCovered(id));
    if (rootIds.length === 0) return null;

    const nodes: Node[] = [];
    const seen = new Set<string>();
    const walk = (id: string): void => {
        if (seen.has(id)) return;
        seen.add(id);
        const node = doc.nodes.get(id);
        if (!node) return;
        nodes.push(detach(node as Node));
        for (const child of node.children) walk(child);
    };
    for (const id of rootIds) walk(id);
    return { nodes, rootIds };
}

/** Nodes ready to be added: fresh ids, links rewritten, roots nudged clear of the original. */
export interface PasteResult {
    nodes: Node[];
    rootIds: string[];
}

/**
 * A payload turned into nodes a document can accept.
 *
 * `offset` moves the ROOTS only. A child's stored position is relative to its parent, so offsetting
 * it too would move it twice — and the subtree would come apart, which reads as a corrupted paste
 * rather than a misplaced one.
 */
export function remapForPaste(contents: ClipboardContents, offset: number = PASTE_OFFSET): PasteResult {
    // MINTED HERE, so pasting the same payload twice gives two distinct sets rather than a
    // collision with whatever the first paste created.
    const idMap = new Map(contents.nodes.map(n => [n.id, generateUUID()]));
    const roots = new Set(contents.rootIds);
    const nodes = contents.nodes.map(original => {
        const copy = detach(original);
        copy.id = idMap.get(original.id)!;
        // A ROOT is pasted as a root. Its original parent may not exist here — a different
        // document, or one the user has since deleted — and a node claiming a missing parent is
        // an orphan the integrity check refuses.
        copy.parent = roots.has(original.id) ? null : (idMap.get(original.parent ?? "") ?? null);
        // Children that travelled with the payload point at their copies; anything else is
        // dropped, because it is not here to point at.
        copy.children = original.children.filter(c => idMap.has(c)).map(c => idMap.get(c)!);
        if (roots.has(original.id)) {
            copy.geometry = { ...copy.geometry, x: copy.geometry.x + offset, y: copy.geometry.y + offset };
        }
        // `componentId` names a MASTER that is usually not in the payload. Rewritten only when it
        // is; otherwise the copy keeps pointing at the original master, which is the whole reason
        // copying an instance is useful.
        if (copy.componentId && idMap.has(copy.componentId)) {
            copy.componentId = idMap.get(copy.componentId)!;
        }
        return copy;
    });
    return { nodes, rootIds: contents.rootIds.map(id => idMap.get(id)!) };
}
