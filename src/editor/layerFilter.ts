/**
 * @module layerFilter
 * @description Which layer rows a search query leaves visible.
 *
 * Filtering a TREE is not filtering a list: a node that matches is useless on its own if its
 * parents are hidden, because the row would appear at the wrong depth with no way to tell what
 * it belongs to. So a node stays visible when it matches OR when anything beneath it does, and
 * the panel shows the path down to every hit.
 *
 * A match also IGNORES the collapsed state — a hit inside a collapsed group must be reachable,
 * or searching would only find what was already on screen. The caller therefore treats a
 * filtered tree as fully expanded, which is what `matched` is for: it distinguishes the rows
 * that actually matched from the ancestors kept only to hold them.
 */

import { ReadonlyDocument } from "../core/document/Document";

export interface LayerFilter {
    /** Rows to render — every match, plus the ancestors that lead to one. */
    visible: Set<string>;
    /** The rows that matched the query themselves, for highlighting. */
    matched: Set<string>;
    /** True when no query is active, so the caller can skip filtering entirely. */
    inactive: boolean;
}

/**
 * Resolve a query against the document.
 *
 * @param labelOf the panel's own label for a node — the thing the user can SEE and is therefore
 *        searching. Passed in rather than recomputed here so the filter cannot disagree with
 *        what the row displays.
 */
export function filterLayers(doc: ReadonlyDocument, query: string, labelOf: (id: string) => string): LayerFilter {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return { visible: new Set(), matched: new Set(), inactive: true };

    const matched = new Set<string>();
    doc.nodes.forEach((_n, id) => {
        if (labelOf(id).toLowerCase().includes(q)) matched.add(id);
    });

    // Walk UP from each match, marking the path. Cycle-safe: a hand-edited parent chain can
    // loop, and this runs on every keystroke.
    const visible = new Set<string>(matched);
    for (const id of matched) {
        const seen = new Set<string>();
        let cur = doc.nodes.get(id)?.parent ?? null;
        while (cur != null && !seen.has(cur)) {
            seen.add(cur);
            visible.add(cur);
            cur = doc.nodes.get(cur)?.parent ?? null;
        }
    }

    return { visible, matched, inactive: false };
}
