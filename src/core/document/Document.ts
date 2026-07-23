/**
 * @module Document
 * @description The canonical, authoritative document container. This structure represents the user's intent and must be immutable from a service perspective.
 */

import { Node } from "./Node";

/**
 * The build injects the version from package.json via esbuild `define`
 * (see scripts/build.js). Outside the bundle (tests, ts-jest) the define is
 * absent, so we fall back to a literal that a test keeps in sync with
 * package.json. `typeof` guards the undeclared global without a ReferenceError.
 */
declare const __APP_VERSION__: string | undefined;
export const CURRENT_VERSION: string =
    typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.5";

/**
 * The on-disk document schema version. DELIBERATELY DECOUPLED from the app
 * version: shipping a new build must never orphan saved documents. Bump this
 * ONLY when the persisted shape changes, and add a matching step to
 * `migrateIfNeeded` in Serializer.ts in the same change.
 *
 * Bump when the persisted SHAPE **or the INTERPRETATION** of any field changes — the
 * test is compatibility, not shape (see docs/README.md § The freeze rule).
 *
 * History:
 *   "1" — initial schema. Documents written by app versions <= 0.0.5 were
 *         stamped with the app version (a semver string) but share this exact
 *         shape, so the loader accepts them as schema 1.
 *
 *         KNOWN AMBIGUITY: within schema 1, `geometry.x/y` was redefined from
 *         world to parent-relative. This was safe ONLY because no build that
 *         could author a nested node ever shipped — every schema-1 document in
 *         existence is flat, and for a root node the two are identical. Had a
 *         nested document existed, "1" would now mean two incompatible things.
 *         This is the precise case the shape-only trigger missed; the rule now
 *         keys on interpretation so the next one is caught.
 */
export const SCHEMA_VERSION = "1";

/** Runtime metadata: `date` is a live Date object. */
export interface DocumentMetadata {
    project_name: string;
    created_by: string;
    date: Date;
}

/** On-the-wire / snapshot metadata: `date` is an ISO 8601 string after JSON. */
export interface SerializedMetadata {
    project_name: string;
    created_by: string;
    date: string;
}

/** Defines the complete state of the project file at a specific revision point. */
export interface ProjectDocument {
    /** The document SCHEMA version (see SCHEMA_VERSION) — not the app version. */
    version: string;
    metadata: DocumentMetadata;

    /** The core repository of all nodes, indexed by UUID for O(1) lookup. */
    nodes: Map<string, Node>; 
    
    // Top-level roots that are not contained within any other node.
    rootNodeUuids: string[]; 
    
    variables: VariableStore; // Global design tokens and variables
}

/** Defines the global context for reusable styles (Design Tokens). */
export interface VariableStore {
    [key: string]: {
        type: "color" | "spacing" | "font";
        value: string; 
        modes?: Record<"light" | "dark", string>; // For theme support
    }
}

// Utility function to create a new, empty document instance.
export function createEmptyDocument(): ProjectDocument {
    return {
        version: SCHEMA_VERSION,
        metadata: {
            project_name: "Untitled Prototype",
            created_by: "system",
            date: new Date()
        },
        nodes: new Map<string, Node>(),
        rootNodeUuids: [],
        variables: {} // Empty variable store
    };
}