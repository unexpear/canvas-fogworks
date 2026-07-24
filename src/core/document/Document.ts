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
 *
 *   "2" — adds the optional `Node.transform` (rotation/scale about a normalized
 *         origin) for Milestone 1. Schema-1 documents are valid schema-2 documents
 *         with the field absent, so `migrate_1_to_2` is a pass-through — but the
 *         bump is still required: a schema-1 BUILD would load a rotated node and
 *         draw it unrotated with no error, silently misstating the document.
 *
 *   "3" — adds the optional `Layout.container` (auto-layout: a node's children are
 *         positioned by a flex-stack rule) for Milestone 2. Absent = no auto-layout,
 *         so `migrate_2_to_3` is a pass-through — but a schema-2 build would ignore
 *         the container and draw the children at their now-vestigial stored x/y.
 *
 *   "4" — adds optional `LayoutContainer.hugWidth`/`hugHeight` (intrinsic sizing: a
 *         container sizes an axis to its contents) for Milestone 2. Absent = fixed
 *         size, so `migrate_3_to_4` is a pass-through — but a schema-3 build would draw
 *         a hug container at its now-vestigial stored width/height, misstating the doc.
 *
 *   "5" — adds optional `Layout.grow` (flex-grow: a child's share of leftover main-axis
 *         space) for Milestone 2. Absent = 0 = fixed to base size, so `migrate_4_to_5`
 *         is a pass-through — but a schema-4 build would draw a growing child at its base
 *         size instead of filled, misstating the doc.
 *
 *   "6" — adds optional `Layout.grid` (grid auto-layout: children flow into a cell grid)
 *         for Milestone 2. Absent = no grid, so `migrate_5_to_6` is a pass-through — but a
 *         schema-5 build would ignore the grid and draw the children at their stored x/y.
 *
 *   "7" — adds optional `Layout.constraints` + `Layout.constraintRef` (anchors: a child
 *         repositions when its plain parent resizes) for Milestone 2. Absent = static
 *         (left/top), so `migrate_6_to_7` is a pass-through — but a schema-6 build would
 *         draw a constrained child unanchored, misstating a responsive layout.
 *
 *   "8" — adds optional `Layout.position` ("absolute": out of flow) and `Layout.margin`
 *         (flex flow spacing) for Milestone 2. Absent = in-flow / 0, so `migrate_7_to_8`
 *         is a pass-through — but a schema-7 build would lay an absolute child into the
 *         flow / ignore its margin, misstating the layout.
 *
 *   "9" — adds optional `Layout.shrink` (flex-shrink: give up a share of the overflow
 *         deficit) for Milestone 2. Absent = 0 = never shrinks, so `migrate_8_to_9` is a
 *         pass-through — but a schema-8 build would draw an overflowing child at full size
 *         instead of shrunk, misstating the layout.
 *
 *   "10" — adds optional `LayoutGrid.rows` (explicit per-row grid track sizes) for the
 *         Milestone 2 grid tail. Absent = every row uses the uniform `rowHeight`, so
 *         `migrate_9_to_10` is a pass-through — but a schema-9 build would ignore the
 *         per-row tracks and lay every row out at `rowHeight`, misstating the grid.
 *
 *   "11" — adds the `auto` grid `TrackSize` (`{ auto: true }`, sizes to content) and
 *         `LayoutGrid.hugWidth`/`hugHeight` (grid-container hug) for the Milestone 2 grid
 *         measure-integration. Absent auto / hug false = a fixed-size grid of px/fr tracks,
 *         so `migrate_10_to_11` is a pass-through — but a schema-10 build would not
 *         understand an `auto` track or size a hugging grid to its contents.
 */
export const SCHEMA_VERSION = "11";

/**
 * Recursively strips mutability. `Date` is left intact (it is a value here, and
 * its mutators are not part of how the document is edited).
 */
export type DeepReadonly<T> =
    T extends Date ? T :
    T extends Map<infer K, infer V> ? ReadonlyMap<K, DeepReadonly<V>> :
    T extends (infer E)[] ? ReadonlyArray<DeepReadonly<E>> :
    T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } :
    T;

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

/**
 * A read-only view of the document.
 *
 * `ActionDispatcher.getDocument()` returns this, so invariant #3 ("the dispatcher
 * is the only write path") is checked by the compiler instead of by convention:
 * a tool, the renderer, or a React handler that tries to assign to `node.geometry`
 * or push to `rootNodeUuids` now fails to build. Only `applyMutationsToDocument`
 * — which takes the mutable `ProjectDocument` the dispatcher holds privately —
 * can write.
 */
export type ReadonlyDocument = DeepReadonly<ProjectDocument>;

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