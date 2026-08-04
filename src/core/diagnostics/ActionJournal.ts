/**
 * @module ActionJournal
 * @description What was DISPATCHED, in order — the edit history, as distinct from the result.
 *
 * The other half of the accuracy story, and deliberately a different thing from `MotionTrace`.
 * A trace measures where the ink ended up; a journal records what somebody asked for. They answer
 * different questions — "where did it land" against "what did I change" — and they have different
 * relationships with time.
 *
 * THIS ONE CARRIES WALL-CLOCK TIMESTAMPS ON PURPOSE. When something was done is precisely what an
 * edit history is for: which actions arrived in one gesture, which coalesced, how long a drag ran.
 * That is also exactly why it is kept apart from the trace, whose whole value is being comparable
 * between runs — a timestamp would make every trace differ from every other and destroy that.
 *
 * NOT THE UNDO STACK. `HistoryManager` holds document SNAPSHOTS and answers "put it back"; this
 * holds a description of each dispatch and answers "what happened, in what order". A journal entry
 * survives its revision being undone, which is what makes it useful for working out how a document
 * reached a state that undo has already walked away from.
 *
 * BOUNDED, and it says what it dropped. An unbounded log in a long session is a leak that only
 * shows up hours in; silently discarding the oldest entries would make the journal lie about being
 * complete, which is worse than being short.
 */

/** One dispatch: what it was, when, what it touched, and whether it took. */
export interface JournalEntry {
    /** Monotonic across the session, so ORDER survives the oldest entries being dropped. */
    seq: number;
    /** Wall clock, milliseconds. See the module note on why this belongs here and not in a trace. */
    at: number;
    type: string;
    nodeIds: readonly string[];
    ok: boolean;
}

/** Entries kept. Beyond this the oldest go, and `journalDropped` reports how many. */
export const JOURNAL_MAX = 2000;

let entries: JournalEntry[] = [];
let dropped = 0;
let nextSeq = 1;

/**
 * Record one dispatch.
 *
 * `at` is INJECTED rather than read from the clock here, so a test can state the times it wants
 * and assert on them. A module that reaches for `Date.now()` internally cannot be tested for
 * anything time-shaped without mocking the global, which is a much larger hammer.
 */
export function recordAction(entry: { at: number; type: string; nodeIds?: readonly string[]; ok?: boolean }): void {
    entries.push({
        seq: nextSeq++,
        at: entry.at,
        type: entry.type,
        nodeIds: entry.nodeIds ? [...entry.nodeIds] : [],
        ok: entry.ok ?? true
    });
    if (entries.length > JOURNAL_MAX) {
        dropped += entries.length - JOURNAL_MAX;
        entries = entries.slice(entries.length - JOURNAL_MAX);
    }
}

/** Everything still held, oldest first. */
export function journal(): readonly JournalEntry[] {
    return entries;
}

/** How many entries fell off the front — so a reader knows the journal is not the whole session. */
export function journalDropped(): number {
    return dropped;
}

/** Forget everything, including the drop count. Used when a document is loaded or replaced. */
export function clearJournal(): void {
    entries = [];
    dropped = 0;
    nextSeq = 1;
}
