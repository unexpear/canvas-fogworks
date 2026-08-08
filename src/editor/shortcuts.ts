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
    | { kind: "redo" }
    /**
     * Switch tool with ONE key, which every editor a person arrives from has and this one did not.
     *
     * V, M, R, P, B are not arbitrary: Figma, Illustrator, Photoshop and Aseprite agree on them
     * closely enough that muscle memory transfers. Unmodified single letters are free here because
     * nothing else claims one, and `isTypingTarget` already stops any of them reaching a text field.
     */
    | { kind: "tool"; name: string };

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
/**
 * The single-key tool bindings, and the one place they are written down.
 *
 * MATCHED TO THE APPS PEOPLE ALREADY KNOW rather than chosen: V selects and M moves (Figma,
 * Illustrator), R draws a rectangle, P is the pen, B is the brush (Photoshop, Aseprite,
 * Illustrator). A person arriving from any of them is right on the first press.
 */
const TOOL_KEYS: Record<string, string> = {
    v: "select", m: "move", r: "rectangle", e: "ellipse", t: "text", p: "pen", b: "paint"
};

/**
 * Every binding, as text, for the help panel — kept HERE because this is where bindings live.
 *
 * A help list assembled anywhere else drifts the first time a binding changes, and a shortcut
 * sheet that lies is worse than none: it teaches a key that does nothing. A test asserts every
 * `Shortcut` kind appears in this table, so adding a binding without documenting it fails.
 */
export const SHORTCUT_HELP: { keys: string; does: string; kind: Shortcut["kind"] }[] = [
    { keys: "V", does: "Select tool", kind: "tool" },
    { keys: "M", does: "Move tool", kind: "tool" },
    { keys: "R / E / T", does: "Rectangle · Ellipse · Text", kind: "tool" },
    { keys: "P", does: "Pen tool", kind: "tool" },
    { keys: "B", does: "Paint brush", kind: "tool" },
    { keys: "Arrows", does: "Nudge by 1", kind: "nudge" },
    { keys: "Shift+Arrows", does: "Nudge by 10", kind: "nudge" },
    { keys: "Ctrl+D", does: "Duplicate", kind: "duplicate" },
    { keys: "Ctrl+G", does: "Frame selection", kind: "group" },
    { keys: "Ctrl+A", does: "Select all", kind: "select-all" },
    { keys: "Ctrl+Z / Ctrl+Shift+Z", does: "Undo · Redo", kind: "undo" },
    { keys: "Ctrl+Y", does: "Redo", kind: "redo" },
    { keys: "Delete / Backspace", does: "Delete selection", kind: "delete" },
    { keys: "Escape", does: "Deselect", kind: "deselect" }
];

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

    // TOOL KEYS FIRST, and only unmodified: Ctrl+V is paste on every platform and must never be
    // read as "the move tool". The letters are lower-cased so Shift+V is the same tool, which is
    // what a user holding shift out of habit expects.
    if (!mod && !e.altKey) {
        const tool = TOOL_KEYS[e.key.toLowerCase()];
        if (tool) return { kind: "tool", name: tool };
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
