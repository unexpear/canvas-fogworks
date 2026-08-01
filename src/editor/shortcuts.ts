/**
 * @module shortcuts
 * @description Maps a key press to an editor command — the muscle-memory layer.
 *
 * PURE and node-testable: it takes the few fields of a `KeyboardEvent` that matter and returns
 * a command, so "what does Shift+Left do?" is a unit test rather than something you find out by
 * pressing it. The app performs the command; this only decides what was asked for.
 *
 * The bindings follow the conventions every design tool shares, because muscle memory is the
 * whole point of a shortcut — an arrow nudges by one unit, Shift+arrow by ten, Ctrl/Cmd+D
 * duplicates, Delete removes, Ctrl/Cmd+G groups. Cmd and Ctrl are accepted interchangeably so
 * the same build behaves correctly on either platform.
 */

/** How far an arrow key moves the selection, in WORLD units. */
export const NUDGE_STEP = 1;
/** …and with Shift held. Ten is the near-universal convention. */
export const NUDGE_STEP_LARGE = 10;

export type Shortcut =
    | { kind: "nudge"; dx: number; dy: number }
    | { kind: "duplicate" }
    | { kind: "delete" }
    | { kind: "group" }
    | { kind: "select-all" }
    | { kind: "deselect" }
    | { kind: "undo" }
    | { kind: "redo" };

/** The parts of a key event a binding depends on — so a test needs no DOM. */
export interface KeyChord {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
}

/**
 * True when the press came from a text field. A shortcut must never fire while someone is
 * typing a layer name or a hex colour — Delete would destroy their selection mid-word, and
 * every arrow key would move the shape instead of the caret.
 */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = (target.tagName || "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

const ARROWS: Record<string, { dx: number; dy: number }> = {
    ArrowLeft: { dx: -1, dy: 0 },
    ArrowRight: { dx: 1, dy: 0 },
    ArrowUp: { dx: 0, dy: -1 },
    ArrowDown: { dx: 0, dy: 1 }
};

/** The command a chord asks for, or null when it is not bound. */
export function resolveShortcut(e: KeyChord): Shortcut | null {
    // Either modifier, so one build is correct on Windows and macOS.
    const mod = !!(e.ctrlKey || e.metaKey);

    const arrow = ARROWS[e.key];
    if (arrow) {
        // An arrow with a MODIFIER is not a nudge — leave Ctrl/Cmd+arrow to the platform
        // (word-jump, desktop switching) rather than quietly stealing it.
        if (mod) return null;
        const step = e.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
        return { kind: "nudge", dx: arrow.dx * step, dy: arrow.dy * step };
    }

    if (mod && (e.key === "d" || e.key === "D")) return { kind: "duplicate" };
    if (mod && (e.key === "g" || e.key === "G")) return { kind: "group" };
    if (mod && (e.key === "a" || e.key === "A")) return { kind: "select-all" };
    if (mod && (e.key === "z" || e.key === "Z")) return e.shiftKey ? { kind: "redo" } : { kind: "undo" };
    if (mod && (e.key === "y" || e.key === "Y")) return { kind: "redo" };

    // Delete and Backspace both remove — which one "deletes" is a platform habit, not a rule.
    if (!mod && (e.key === "Delete" || e.key === "Backspace")) return { kind: "delete" };
    if (!mod && e.key === "Escape") return { kind: "deselect" };

    return null;
}
