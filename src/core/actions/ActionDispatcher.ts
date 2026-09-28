/**
 * @module ActionDispatcher
 * @description The central gateway that coordinates all changes to the document state.
 * Enforces the lifecycle: Validate → Execute → Commit → Notify.
 * The Dispatcher is the ONLY path for modifying the document.
 */

import { ProjectDocument, ReadonlyDocument } from "../document/Document";
import { Action } from "./Action";
import { HistoryManager, HistoryLimits, RetainedHistoryAccounting } from "./HistoryManager";
import { MutationResult } from "./types";
import { applyMutationsToDocument } from "./applyMutations";
import { validateDocumentIntegrity } from "../document/Integrity";

export type DocumentChangeListener = (result: MutationResult) => void;

/** Coordinates the execution of actions, ensuring atomicity and transaction safety. */
export class ActionDispatcher {
    private historyManager: HistoryManager;
    private currentDocumentState: ProjectDocument;
    private listeners: DocumentChangeListener[] = [];
    private readonly historyLimits?: HistoryLimits;

    /** @param historyLimits override the memory budget (tests force truncation). */
    constructor(initialDoc: ProjectDocument, historyLimits?: HistoryLimits) {
        this.currentDocumentState = initialDoc;
        this.historyLimits = historyLimits;
        this.historyManager = new HistoryManager(initialDoc, historyLimits);
    }

    /** Subscribe to document mutations. Returns an unsubscribe function. */
    public onChange(listener: DocumentChangeListener): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    /**
     * @param options.coalesce Set true ONLY from continuous UI (slider drag, typing)
     *   where one user gesture emits many actions; consecutive edits to the same
     *   node then collapse into a single undo step. Discrete gestures must omit it.
     */
    public dispatchAction(action: Action, options?: { coalesce?: boolean }): MutationResult {
        if (!(action instanceof Action)) {
            return { updatedNodeIds: new Set(), propertyDeltas: new Map(), success: false };
        }

        // Retarget the action at the CURRENT document before validating. An action
        // constructed against an older document (e.g. built before an undo, or from
        // a stale React closure) would otherwise validate against one document and
        // mutate another — passing the gate and then half-applying.
        action.rebind(this.currentDocumentState);

        const failure = (): MutationResult =>
            ({ updatedNodeIds: new Set(), propertyDeltas: new Map(), success: false });

        // Every stage is guarded, so "dispatch never throws" holds without a
        // boundary: a buggy validate()/serialize() or a hostile delta cannot
        // escape into a React event handler.
        let mutationResult: MutationResult;
        try {
            if (!action.validate()) return failure();
            mutationResult = action.execute();
        } catch (e) {
            console.error("ActionDispatcher: action failed during validate/execute:", e);
            return failure();
        }

        if (!mutationResult.success) {
            return mutationResult;
        }

        try {
            this.applyMutations(mutationResult);
            const historyPayload = action.serialize();
            this.historyManager.commitRevision(
                historyPayload,
                this.currentDocumentState,
                options?.coalesce === true
            );
        } catch (e) {
            // The document may have been partially mutated. Roll back to the last
            // committed revision so the live document and history cannot diverge.
            console.error("ActionDispatcher: apply/commit failed; rolling back:", e);
            const restored = this.historyManager.current();
            if (restored) this.currentDocumentState = restored;
            this.notify(this.restoreNotification(this.currentDocumentState, this.currentDocumentState));
            return failure();
        }

        this.notify(mutationResult);

        return mutationResult;
    }

    private applyMutations(result: MutationResult): void {
        applyMutationsToDocument(this.currentDocumentState, result.propertyDeltas);
    }

    private notify(result: MutationResult): void {
        // Isolate listeners: one throwing subscriber must not skip the rest or
        // propagate out of dispatch after the mutation has already committed.
        for (const listener of this.listeners) {
            try {
                listener(result);
            } catch (e) {
                console.error("ActionDispatcher onChange listener threw:", e);
            }
        }
    }

    /**
     * A whole-document restore (undo/redo/load). `updatedNodeIds` carries a REAL
     * dirty set — the nodes that actually differ between the outgoing and restored
     * documents — so listeners (and, from Milestone 1, the GeometryEngine) can
     * recompute just those instead of the whole document. `fullReload` remains a
     * hint for listeners that hold aliases into the previous document.
     */
    private restoreNotification(previous: ProjectDocument, restored: ProjectDocument): MutationResult {
        const dirty = new Set<string>();

        // Removed or changed.
        previous.nodes.forEach((prevNode, id) => {
            const nextNode = restored.nodes.get(id);
            if (!nextNode || JSON.stringify(prevNode) !== JSON.stringify(nextNode)) {
                dirty.add(id);
            }
        });
        // Added.
        restored.nodes.forEach((_node, id) => {
            if (!previous.nodes.has(id)) dirty.add(id);
        });
        // A changed root ordering re-stacks everything it names.
        // Compared as JSON, not a joined string: a separator that can appear in an id makes
        // ["a b","c"] and ["a","b c"] compare equal, and the NUL this used to join with made
        // the whole FILE binary to ripgrep — so `Grep` silently skipped it.
        if (JSON.stringify(previous.rootNodeUuids) !== JSON.stringify(restored.rootNodeUuids)) {
            for (const id of previous.rootNodeUuids) dirty.add(id);
            for (const id of restored.rootNodeUuids) dirty.add(id);
        }

        return {
            updatedNodeIds: dirty,
            propertyDeltas: new Map(),
            success: true,
            fullReload: true
        };
    }

    public undo(): ProjectDocument | null {
        const previous = this.currentDocumentState;
        const restoredDoc = this.historyManager.undo();
        if (restoredDoc) {
            this.currentDocumentState = restoredDoc;
            this.notify(this.restoreNotification(previous, restoredDoc));
        }
        return restoredDoc;
    }

    public redo(): ProjectDocument | null {
        const previous = this.currentDocumentState;
        const restoredDoc = this.historyManager.redo();
        if (restoredDoc) {
            this.currentDocumentState = restoredDoc;
            this.notify(this.restoreNotification(previous, restoredDoc));
        }
        return restoredDoc;
    }

    public canUndo(): boolean {
        return this.historyManager.canUndo();
    }

    /**
     * A history checkpoint (the current revision id) to capture BEFORE a live-committed gesture, and
     * later hand to `rollbackToCheckpoint` to cancel it. See the rotate cancel in `ToolController`.
     */
    public getHistoryCheckpoint(): string {
        return this.historyManager.getCurrentRevisionId();
    }

    /**
     * Hard-cancel back to a checkpoint from `getHistoryCheckpoint`: discard every revision committed
     * since, restore that document, and notify listeners with a real dirty set. Used to cancel a
     * live-committed gesture (rotate) so it leaves NO undo/redo trace, regardless of the coalesce
     * window. Returns false when the checkpoint is no longer retained (trimmed) so the caller can
     * fall back to a manual revert.
     */
    public rollbackToCheckpoint(revisionId: string): boolean {
        const previous = this.currentDocumentState;
        const restored = this.historyManager.rollbackTo(revisionId);
        if (!restored) return false;
        this.currentDocumentState = restored;
        this.notify(this.restoreNotification(previous, restored));
        return true;
    }

    public canRedo(): boolean {
        return this.historyManager.canRedo();
    }

    /**
     * A READ-ONLY view. The mutable document is held privately; the only way to
     * change it is to dispatch an Action. This is invariant #3, enforced by the
     * type system rather than by convention.
     */
    public getDocument(): ReadonlyDocument {
        return this.currentDocumentState;
    }

    /** True once history trimming discarded steps — undo no longer reaches the start. */
    public hasTruncatedHistory(): boolean {
        return this.historyManager.hasTruncatedHistory();
    }

    /**
     * Return the document to the state this history began from.
     *
     * Undo deliberately stops at the oldest RETAINED step rather than teleporting
     * across discarded history, so this is the explicit way back. It commits as a
     * normal revision, which means the revert itself is undoable.
     */
    public revertToOriginal(): ProjectDocument {
        const previous = this.currentDocumentState;
        const original = this.historyManager.getOriginal();
        this.currentDocumentState = original;
        this.historyManager.commitRevision(
            { actionId: "RevertToOriginal", payload: null, timestamp: Date.now() },
            original
        );
        this.notify(this.restoreNotification(previous, original));
        return original;
    }

    /**
     * Replace the entire document (e.g. File → New / Open), resetting history to
     * the loaded state. Notifies listeners with a full-reload result.
     */
    public loadDocument(doc: ProjectDocument): void {
        // The OTHER load path. deserializeDocument validates what it parses, but an
        // in-memory document handed straight to the dispatcher used to bypass every
        // structural check — so a ghost root or dangling parent entered the live
        // document silently. Both load paths are now guarded.
        validateDocumentIntegrity(doc);

        const previous = this.currentDocumentState;
        this.currentDocumentState = doc;
        this.historyManager = new HistoryManager(doc, this.historyLimits);
        this.notify(this.restoreNotification(previous, doc));
    }

    /** Exact serialized retention of undo history. Does not measure process heap. */
    public retainedHistoryAccounting(): RetainedHistoryAccounting {
        return this.historyManager.retainedAccounting();
    }
}
