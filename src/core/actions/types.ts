/**
 * @module ActionTypes
 * @description Shared types used across all Actions and History tracking.
 */

import { Node } from "../document/Node";
import { ProjectDocument, SerializedMetadata } from "../document/Document";

/** The result of an action execution. Communicates changes without coupling services. */
export interface MutationResult {
    /** Node IDs that were programmatically altered by this transaction. */
    updatedNodeIds: Set<string>;
    /** UUID -> Delta object detailing exactly what changed (e.g., { x: 150, y: 20 }). */
    propertyDeltas: Map<string, Record<string, any>>;
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
}
