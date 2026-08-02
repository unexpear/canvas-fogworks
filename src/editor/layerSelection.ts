/**
 * @module layerSelection
 * @description What a click on a layer row selects — the rules, without the DOM.
 *
 * Three gestures, and the awkwardness is entirely in how they interact:
 *   · plain click  — select just this row, and make it the anchor
 *   · ctrl/cmd     — toggle this row in or out, leaving the rest alone
 *   · shift        — select the contiguous RANGE from the anchor to this row
 *
 * "Contiguous" means contiguous in the VISIBLE row order, not in the document: rows the user
 * cannot see (collapsed, or filtered out) are not between anything, and selecting them would
 * pick up nodes that were never on screen. So the caller passes the order it actually rendered,
 * which is also what makes this testable — the rule never has to ask the panel anything.
 */

/** The modifier state a row click carried. Cmd and Ctrl are interchangeable, as everywhere else. */
export interface ClickModifiers {
    shift?: boolean;
    ctrl?: boolean;
    meta?: boolean;
}

export interface LayerSelection {
    selected: string[];
    /** The row a subsequent shift-click measures from. */
    anchor: string | null;
}

/**
 * The selection a row click produces.
 *
 * @param visible the row ids in the order the panel rendered them
 * @param current the ids selected before the click
 * @param anchor  the row the last non-shift click landed on, if any
 */
export function selectionForRowClick(
    visible: readonly string[],
    current: readonly string[],
    anchor: string | null,
    clicked: string,
    mods: ClickModifiers = {}
): LayerSelection {
    const multi = !!(mods.ctrl || mods.meta);

    if (multi) {
        // Toggle. The clicked row becomes the anchor either way — it is the last thing touched,
        // and a following shift-click should measure from it.
        const has = current.includes(clicked);
        const selected = has ? current.filter(id => id !== clicked) : [...current, clicked];
        return { selected, anchor: clicked };
    }

    if (mods.shift) {
        const from = anchor !== null ? visible.indexOf(anchor) : -1;
        const to = visible.indexOf(clicked);
        // No usable anchor (first click of the session, or the anchor scrolled out of the
        // filtered list) — fall back to a plain click rather than guessing at a range.
        if (from < 0 || to < 0) return { selected: [clicked], anchor: clicked };
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        // The anchor does NOT move: shift-clicking again should grow or shrink the same range,
        // not walk it down the list one row per click.
        return { selected: visible.slice(lo, hi + 1), anchor };
    }

    return { selected: [clicked], anchor: clicked };
}
