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

import { ProjectDocument } from "../document/Document";
import { Node } from "../document/Node";
import { ActionPayload, Revision, DocumentSnapshot } from "./types";
import { generateUUID } from "../ids/UUID";

/** Deep-clone a document, converting Maps to plain objects for JSON serialization. */
function cloneDocument(doc: ProjectDocument): DocumentSnapshot {
    return JSON.parse(JSON.stringify({
        ...doc,
        nodes: Object.fromEntries(doc.nodes)
    }));
}

/** Reconstructs Map instances after JSON deserialization. */
function hydrateDocument(raw: DocumentSnapshot): ProjectDocument {
    // Deep-clone the stored snapshot before handing it back. The dispatcher
    // mutates the restored document in place (Object.assign on geometry/style,
    // rootNodeUuids.push, parent.children reassignment); if the restored doc
    // aliased the revision's own objects, the very next edit after an undo/redo
    // would silently rewrite committed history. Cloning isolates them.
    const source: DocumentSnapshot = JSON.parse(JSON.stringify(raw));

    const doc: ProjectDocument = {
        version: source.version,
        metadata: {
            ...source.metadata,
            date: new Date(source.metadata.date)
        },
        nodes: new Map<string, Node>(),
        rootNodeUuids: source.rootNodeUuids,
        variables: source.variables
    };

    for (const [key, value] of Object.entries(source.nodes || {})) {
        doc.nodes.set(key, value as Node);
    }
    return doc;
}

const MAX_HISTORY_SIZE = 200;

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
    const nodeId = payload.payload && typeof payload.payload === "object"
        ? (payload.payload as { nodeId?: unknown }).nodeId
        : undefined;
    if (typeof nodeId !== "string" || nodeId.length === 0) return null;
    return `${payload.actionId}:${nodeId}`;
}

export class HistoryManager {
    private revisions: Array<Revision>;
    private currentIndex: number;

    constructor(initialDoc: ProjectDocument) {
        this.revisions = [{
            id: generateUUID(),
            timestamp: Date.now(),
            actionId: "INITIAL",
            actionPayload: { actionId: "INITIAL", payload: null, timestamp: Date.now() },
            document: cloneDocument(initialDoc)
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
        documentState: ProjectDocument,
        allowCoalesce = false
    ): void {
        this.revisions = this.revisions.slice(0, this.currentIndex + 1);

        const now = Date.now();
        const revision: Revision = {
            id: generateUUID(),
            timestamp: now,
            actionId: actionPayload.actionId,
            actionPayload: actionPayload,
            document: cloneDocument(documentState)
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
            now - previous.timestamp <= COALESCE_WINDOW_MS
        ) {
            this.revisions[this.currentIndex] = revision;
            return;
        }

        this.revisions.push(revision);

        // Trim oldest revisions if exceeding max size, but ALWAYS keep the
        // INITIAL revision at index 0 so "undo all the way back" can still
        // reach the document's true starting state.
        if (this.revisions.length > MAX_HISTORY_SIZE) {
            const excess = this.revisions.length - MAX_HISTORY_SIZE;
            this.revisions.splice(1, excess);
        }

        this.currentIndex = this.revisions.length - 1;
    }

    public undo(): ProjectDocument | null {
        if (this.currentIndex <= 0) {
            return null;
        }
        this.currentIndex--;
        return hydrateDocument(this.revisions[this.currentIndex].document);
    }

    public redo(): ProjectDocument | null {
        if (this.currentIndex >= this.revisions.length - 1) {
            return null;
        }
        this.currentIndex++;
        return hydrateDocument(this.revisions[this.currentIndex].document);
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
