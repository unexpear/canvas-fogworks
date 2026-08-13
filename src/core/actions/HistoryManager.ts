/**
 * @module HistoryManager
 * @description Manages revision history for undo/redo.
 *
 * History is implemented as an array of immutable document revisions.
 * Undo/Redo navigates between revisions — no actions are re-executed.
 *
 * MVP Tradeoff: Uses full document snapshots for simplicity and reliability.
 * Future: Replace with delta-based history for large documents.
 */

import { ProjectDocument, ReadonlyDocument } from "../document/Document";
import { Node } from "../document/Node";
import { ActionPayload, Revision, DocumentSnapshot } from "./types";

/** Rough retained-bytes estimate for a snapshot (UTF-16 chars ≈ 2 bytes). */
function approximateSize(snapshot: DocumentSnapshot): number {
    return JSON.stringify(snapshot).length * 2;
}
import { generateUUID } from "../ids/UUID";

/** Deep-clone a document, converting Maps to plain objects for JSON serialization. */
function cloneDocument(doc: ReadonlyDocument): DocumentSnapshot {
    return JSON.parse(JSON.stringify({
        ...doc,
        nodes: Object.fromEntries(doc.nodes)
    }));
}

/**
 * Reconstructs Map instances after JSON deserialization.
 *
 * IT SPREADS, IT DOES NOT ENUMERATE, and that is the whole of the fix. This function used to name
 * the document-level fields one by one — `activeState`, `timeline`, `frame` — beside a comment
 * claiming that listing them "is what makes the compiler catch the next one". It does not: every
 * one of those fields is OPTIONAL, so a field left out of this literal is silently absent rather
 * than a type error, and the compiler has nothing to say. Two fields were already missing.
 *
 * `clips` (schema 46) was one, which is how a document could hold named ranges that undo threw
 * away. `lights` and `ambient` (schema 42) were the other, and that one was reachable by anybody:
 * turn the light on, draw a rectangle, press undo, and the scene goes dark with no way back except
 * setting it again. Neither is exotic. Both had shipped.
 *
 * So nothing is listed. The spread carries every field the snapshot holds, including the ones added
 * after this was written, and only the two that CANNOT survive JSON are rebuilt: `nodes` is a Map
 * and `metadata.date` is a Date. This is the fifth time this codebase has paid for rebuilding a
 * record field by field — after `Mesh.points` losing its bones, `UpdateNodeContentAction` losing
 * its nine-slice, `rebuild` losing the terrain, and the terrain panel losing a material's name.
 */
function hydrateDocument(raw: DocumentSnapshot): ProjectDocument {
    // Deep-clone the stored snapshot before handing it back. The dispatcher
    // mutates the restored document in place (Object.assign on geometry/style,
    // rootNodeUuids.push, parent.children reassignment); if the restored doc
    // aliased the revision's own objects, the very next edit after an undo/redo
    // would silently rewrite committed history. Cloning isolates them.
    const source: DocumentSnapshot = JSON.parse(JSON.stringify(raw));

    const doc: ProjectDocument = {
        ...(source as unknown as ProjectDocument),
        metadata: {
            ...source.metadata,
            date: new Date(source.metadata.date)
        },
        // The two that JSON cannot carry, rebuilt — and NOTHING else restated.
        nodes: new Map<string, Node>(),
        // A snapshot taken before the field existed hydrates as the default rather than undefined.
        // UNREACHABLE AND KEPT: history lives in memory only, and `cloneDocument` spreads a live
        // document whose `activeTheme` is always set, so no snapshot can arrive without one — a
        // mutation changing this default SURVIVES and no fixture can kill it. Recorded rather than
        // dressed in a test that would only assert the fallback calls itself.
        activeTheme: source.activeTheme ?? "light"
    };

    for (const [key, value] of Object.entries(source.nodes || {})) {
        doc.nodes.set(key, value as Node);
    }
    return doc;
}

/**
 * History retention is bounded by MEMORY, not by a step count, so a normal session
 * effectively never truncates. A snapshot is a full-document clone, so a fixed step
 * count meant "200 steps" regardless of whether that was 2 MB or 2 GB.
 *
 * `minEntries` is a usability floor that wins over the byte budget: on a very large
 * document a handful of snapshots can exceed the budget on their own, and a user
 * with two undo steps is worse than a user with elevated memory use.
 */
export interface HistoryLimits {
    maxBytes: number;
    minEntries: number;
    maxEntries: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
    maxBytes: 128 * 1024 * 1024,
    minEntries: 50,
    maxEntries: 10_000
};

/**
 * A run of edits to the SAME property-set of the SAME node within this window
 * collapses into one undo step. Continuous UI controls (a slider drag, typing
 * in a number field) emit one action per input event; without coalescing a
 * single drag would commit ~100 revisions and blow the whole history.
 */
const COALESCE_WINDOW_MS = 400;

/**
 * Merge key for coalescing, or null when the action carries no single node target.
 *
 * NOTE: whether an edit coalesces is decided by the CALLER (see
 * `dispatchAction(action, { coalesce: true })`), not by inspecting the action type.
 * An allow-list keyed on action class was wrong: `UpdateNodeGeometryAction` has two
 * producers — the inspector (continuous, should coalesce) and a drag committing on
 * mouse-up (discrete, must not) — so the class cannot tell you the input cadence.
 * Only the call site knows.
 */
function coalesceKey(payload: ActionPayload): string | null {
    const p = payload.payload && typeof payload.payload === "object" ? payload.payload as Record<string, unknown> : null;
    // A TransactionAction has no single-node target, so key it by its NAME instead. A continuous
    // gesture that emits one transaction per frame (group rotate: each root's geometry + transform in
    // one atomic step) then collapses into a single undo step — the multi-node analogue of a slider
    // drag's `Action:nodeId` key. The name is made gesture-specific by the caller (the sorted root
    // ids), so two different groups don't merge. Only ever consulted when the caller opts in
    // (coalesce:true); the discrete transactions (move-nodes, delete-nodes) don't, so they're unchanged.
    if (payload.actionId === "TransactionAction") {
        const name = p ? p.name : undefined;
        return typeof name === "string" && name.length > 0 ? `TransactionAction:${name}` : null;
    }
    const nodeId = p ? p.nodeId : undefined;
    if (typeof nodeId !== "string" || nodeId.length === 0) return null;
    return `${payload.actionId}:${nodeId}`;
}

export class HistoryManager {
    private revisions: Array<Revision>;
    private currentIndex: number;
    private limits: HistoryLimits;
    /**
     * The document as it was when this history began, kept OUTSIDE `revisions` so
     * trimming can never discard it. Undo deliberately does not walk to it (it stops
     * at the oldest retained step); `getOriginal()` is the explicit way back.
     */
    private readonly originalSnapshot: DocumentSnapshot;
    /** True once trimming has discarded steps, i.e. index 0 is no longer the original. */
    private truncated = false;
    /**
     * Id of the revision the last commit produced. Coalescing may only merge into
     * THAT revision — any undo/redo moves the cursor and clears this, so an edit
     * made after stepping through history starts a fresh undo step instead of
     * silently rewriting a revision the user just navigated to.
     */
    private lastCommittedId: string | null = null;

    constructor(initialDoc: ReadonlyDocument, limits?: HistoryLimits) {
        this.limits = limits ?? DEFAULT_HISTORY_LIMITS;
        const snapshot = cloneDocument(initialDoc);
        this.originalSnapshot = snapshot;
        this.revisions = [{
            id: generateUUID(),
            timestamp: Date.now(),
            actionId: "INITIAL",
            actionPayload: { actionId: "INITIAL", payload: null, timestamp: Date.now() },
            document: snapshot,
            sizeBytes: approximateSize(snapshot)
        }];
        this.currentIndex = 0;
    }

    /**
     * @param allowCoalesce Opt-in from the dispatch call site: true only for
     *   continuous UI (a slider drag, typing in a field) where one gesture emits
     *   many actions. Discrete gestures must leave it false.
     */
    public commitRevision(
        actionPayload: ActionPayload,
        documentState: ReadonlyDocument,
        allowCoalesce = false
    ): void {
        this.revisions = this.revisions.slice(0, this.currentIndex + 1);

        const now = Date.now();
        const snapshot = cloneDocument(documentState);
        const revision: Revision = {
            id: generateUUID(),
            timestamp: now,
            actionId: actionPayload.actionId,
            actionPayload: actionPayload,
            document: snapshot,
            sizeBytes: approximateSize(snapshot)
        };

        // Collapse a rapid run of edits to the same node property into a single
        // undo step. Index 0 is the INITIAL revision and is never merged into.
        const previous = this.revisions[this.currentIndex];
        const key = allowCoalesce ? coalesceKey(actionPayload) : null;
        if (
            key !== null &&
            this.currentIndex > 0 &&
            previous !== undefined &&
            coalesceKey(previous.actionPayload) === key &&
            previous.id === this.lastCommittedId &&
            // Bounded at BOTH ends: a backwards clock step would otherwise make
            // `now - previous.timestamp` negative and coalesce unrelated edits.
            now - previous.timestamp >= 0 &&
            now - previous.timestamp <= COALESCE_WINDOW_MS
        ) {
            this.revisions[this.currentIndex] = revision;
            this.lastCommittedId = revision.id;
            return;
        }

        this.revisions.push(revision);
        this.trim();

        this.currentIndex = this.revisions.length - 1;
        this.lastCommittedId = revision.id;
    }

    public undo(): ProjectDocument | null {
        if (this.currentIndex <= 0) {
            return null;
        }
        this.currentIndex--;
        this.lastCommittedId = null; // cursor moved — end any coalescing run
        return hydrateDocument(this.revisions[this.currentIndex].document);
    }

    public redo(): ProjectDocument | null {
        if (this.currentIndex >= this.revisions.length - 1) {
            return null;
        }
        this.currentIndex++;
        this.lastCommittedId = null; // cursor moved — end any coalescing run
        return hydrateDocument(this.revisions[this.currentIndex].document);
    }

    /**
     * Drop the oldest revisions until the history fits its memory budget. Trimming
     * from the FRONT means undo stops at the oldest retained step rather than
     * teleporting across a gap — `getOriginal()` is the explicit way back to the start.
     */
    private trim(): void {
        const { maxBytes, minEntries, maxEntries } = this.limits;

        while (this.revisions.length > maxEntries) {
            this.revisions.shift();
            this.truncated = true;
        }

        let total = this.revisions.reduce((sum, r) => sum + r.sizeBytes, 0);
        while (total > maxBytes && this.revisions.length > minEntries) {
            const dropped = this.revisions.shift();
            if (!dropped) break;
            total -= dropped.sizeBytes;
            this.truncated = true;
        }
    }

    /** True once trimming discarded steps — the oldest retained step is not the original. */
    public hasTruncatedHistory(): boolean {
        return this.truncated;
    }

    /** The document this history began from. Never trimmed; the explicit way back. */
    public getOriginal(): ProjectDocument {
        return hydrateDocument(this.originalSnapshot);
    }

    /** The document at the current cursor position (used to roll back a failed apply). */
    public current(): ProjectDocument | null {
        const revision = this.revisions[this.currentIndex];
        return revision ? hydrateDocument(revision.document) : null;
    }

    /** Id of the revision at the current cursor — a checkpoint a caller can later `rollbackTo`. */
    public getCurrentRevisionId(): string {
        return this.revisions[this.currentIndex].id;
    }

    /**
     * Hard-cancel: discard EVERY revision committed after `revisionId` and return that revision's
     * document. Unlike undo (which leaves the discarded revisions redoable), this erases them
     * entirely — the way a live-committed gesture (rotate) is cancelled so it leaves no undo AND no
     * redo trace, regardless of how the coalesce window split its frames. Returns null when the id is
     * not in the retained history (e.g. trimmed under memory pressure), so the caller can fall back.
     * `lastCommittedId` is cleared (like undo) so a later coalesced edit never merges into the head.
     */
    public rollbackTo(revisionId: string): ProjectDocument | null {
        const index = this.revisions.findIndex(r => r.id === revisionId);
        if (index < 0) return null;
        this.revisions = this.revisions.slice(0, index + 1);
        this.currentIndex = index;
        this.lastCommittedId = null;
        return hydrateDocument(this.revisions[index].document);
    }

    public canUndo(): boolean {
        return this.currentIndex > 0;
    }

    public canRedo(): boolean {
        return this.currentIndex < this.revisions.length - 1;
    }

    public getRevisionCount(): number {
        return this.revisions.length;
    }

    public getCurrentIndex(): number {
        return this.currentIndex;
    }

    public getCurrentActionId(): string {
        return this.revisions[this.currentIndex].actionId;
    }
}
