/**
 * @module ActionTypes
 * @description Shared types used across all Actions and History tracking.
 */

import { Node, Geometry, Style, Layout, Transform } from "../document/Node";
import { ProjectDocument, SerializedMetadata } from "../document/Document";

/**
 * What one action wants done to one node.
 *
 * The union encodes the terminal/composable rule that used to live only in prose:
 *  - `add` and `delete` are TERMINAL — they fully describe the node's fate, and the
 *    type makes it impossible to attach property edits to them.
 *  - `patch` is COMPOSABLE — an optional reparent plus optional property patches,
 *    applied together. "Drop into a frame and reposition" is one `patch`.
 *
 * Replacing the old `Record<string, any>` with magic `__addNode`/`__deleteNode`/
 * `__reparent` keys means a malformed delta is now a compile error rather than a
 * silently-dropped edit.
 */
export type NodeDelta =
    | { kind: "add"; node: Node }
    | { kind: "delete" }
    | {
        kind: "patch";
        /** Move within the tree. Applied before the property patches below. */
        reparent?: { parent: string | null; index?: number };
        geometry?: Partial<Geometry>;
        transform?: Partial<Transform>;
        style?: Partial<Style>;
        layout?: Partial<Layout>;
        text?: string;
        src?: string;
        name?: string;
    };

/** The result of an action execution. Communicates changes without coupling services. */
export interface MutationResult {
    /** Node IDs that were programmatically altered by this transaction. */
    updatedNodeIds: Set<string>;
    /** Node id → the change requested for that node. */
    propertyDeltas: Map<string, NodeDelta>;
    success: boolean;
    /**
     * Set on undo/redo notifications: the whole document was replaced, so
     * delta-driven listeners should reload from getDocument() rather than
     * trying to apply propertyDeltas incrementally.
     */
    fullReload?: boolean;
}

/**
 * A JSON-safe snapshot of a document as stored in the history stack.
 * Nodes are a plain object (Map is not JSON-serializable) and `date` is an
 * ISO string after the round-trip; hydrateDocument reconstructs both.
 */
export interface DocumentSnapshot {
    version: string;
    metadata: SerializedMetadata;
    nodes: Record<string, Node>;
    rootNodeUuids: string[];
    variables: ProjectDocument["variables"];
}

/** The serialized payload needed to store history for Undo/Redo */
export interface ActionPayload {
    actionId: string;
    payload: any;
    timestamp: number;
}

/** A revision represents an immutable snapshot of the document at a point in time. */
export interface Revision {
    id: string;
    timestamp: number;
    actionId: string;
    actionPayload: ActionPayload;
    document: DocumentSnapshot;
    /** Approximate retained bytes, used for the memory-bounded history budget. */
    sizeBytes: number;
}
