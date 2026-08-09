/**
 * @module ActionTypes
 * @description Shared types used across all Actions and History tracking.
 */

import { SourceRect, RasterSurface } from "../document/Node";
import { NineSliceInsets } from "../geometry/NineSlice";
import { Node, Geometry, Style, Layout, Transform, VariantKey, StateDefinition, PathCommand, BooleanOp, RESERVED_NODE_ID } from "../document/Node";
import { ProjectDocument, SerializedMetadata, VariableStore, ThemeMode } from "../document/Document";
import { InstanceOverride } from "../document/Components";
import { Interaction } from "../document/Prototype";
import { Keyframe } from "../document/Timeline";
import { Mesh } from "../document/Mesh";
import { Light } from "../document/Light";

/**
 * The reserved `propertyDeltas` key a DOCUMENT-LEVEL delta (kind "variables") travels
 * under — the delta map is keyed by node id, and doc-level state has none. The kind, not
 * the key, is what dispatch switches on; the id itself is RESERVED at the document layer
 * (`RESERVED_NODE_ID`, rejected by AddNodeAction + Integrity) so a real node can never
 * collide with it in a transaction's merged delta map.
 */
export const DOCUMENT_DELTA_KEY: string = RESERVED_NODE_ID;

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
    | {
        kind: "add";
        node: Node;
        /** Where among the parent's `children` (or `rootNodeUuids`) to insert. Omitted =
         *  append, which is what creating a node means. A node REPLACING another in place
         *  (DetachInstanceAction) passes the outgoing node's index so the z-order is kept. */
        index?: number;
    }
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
        /**
         * An image's SOURCE REGION (schema 51). `null` REMOVES it — the one field here that can be
         * cleared, because "no region" is a real state meaning the whole image, and an omitted key
         * already means "leave it alone" everywhere in this protocol.
         */
        sourceRect?: SourceRect | null;
        /** A painted surface (schema 55). Null clears it. */
        surface?: RasterSurface | null;
        /** Whether the image scales by nearest neighbour (schema 51). */
        pixelated?: boolean;
        /** A bitmap's nine-slice insets (schema 57). `null` REMOVES them, like a region's. */
        nineSlice?: NineSliceInsets | null;
        /** Cut children to this node's box (schema 59); null clears it. */
        clipsContent?: boolean | null;
        src?: string;
        name?: string;
        /** Whole-map replace of a `core.instance`'s per-instance overrides (M6 slice 2). Whole-map
         *  rather than per-key so a transaction merge is last-wins on a coherent value; the
         *  ACTION does the field-level merging before emitting. */
        overrides?: Record<string, InstanceOverride>;
        /** Variants (schema 27). Both are whole-value replaces, and both are read with `in`
         *  rather than an `!== undefined` test, because CLEARING one is a real edit — untagging
         *  a master, or dropping a property back to the master's value — and an undefined that
         *  meant "absent from the delta" could never express it. */
        variant?: VariantKey;
        variants?: Record<string, string>;
        /** Slots (schema 29). Read with `in` for the same reason: CLEARING is a real edit. */
        slot?: string;
        slotContent?: Record<string, string>;
        /** Named states (M7). Read with `in`: clearing the last one is a real edit. */
        states?: Record<string, StateDefinition>;
        /** Layer flags (schema 31). `in`-read, since clearing one is a real edit. */
        hidden?: boolean;
        locked?: boolean;
        /** `core.path` drawing commands — a whole-array replace (a path is edited as a shape). */
        path?: PathCommand[];
        /** `core.boolean`'s operation (schema 33). A whole-value replace; `in`-read like the
         *  other optional fields so clearing it (back to the default union) is expressible. */
        booleanOp?: BooleanOp;
        /** Prototype interactions (schema 35). A whole-array replace, `in`-read so that
         *  removing the last one (delta value `undefined`) clears the field rather than
         *  being mistaken for "not mentioned". */
        interactions?: Interaction[];
        /** KEYFRAMES (schema 39). Same rule as `interactions`: `undefined` CLEARS the field. */
        track?: Keyframe[];
        /** How far BACK the node sits (schema 40). `undefined` clears it back to the page. */
        depth?: number;
        /** The deformation GRID (schema 41). `undefined` clears it, making the node rigid again. */
        mesh?: Mesh;
    }
    /**
     * DOCUMENT-level state (schema 19): replaces the whole variable store + active theme
     * atomically. Travels under `DOCUMENT_DELTA_KEY`. Whole-state (not a patch) on purpose:
     * transactions then compose last-wins — and since each component action builds its delta
     * from the working document at execute time, "set a variable, then switch theme" carries
     * the earlier edit forward naturally. TERMINAL like add/delete (no property patches ride along).
     */
    | { kind: "variables"; variables: VariableStore; activeTheme: ThemeMode }
    /** The document-level ACTIVE STATE (M7, schema 30) — which named state every node
     *  resolves against. `undefined` = the base state. Travels under `DOCUMENT_DELTA_KEY`
     *  like the variable store, for the same reason: it is one whole-document value. */
    | { kind: "activeState"; activeState: string | undefined }
    /** The document's CLOCK (schema 39). Whole-value, like `activeState`, and travels under
     *  `DOCUMENT_DELTA_KEY`. `undefined` removes it, which is how a document stops being animated. */
    | { kind: "timeline"; timeline: { frames: number; fps: number } | undefined }
    /** The scene's LIGHTING (schema 42). Whole-value, and the two fields travel together
     *  because they are one decision. Also under `DOCUMENT_DELTA_KEY`. */
    | { kind: "lighting"; lights: Light[] | undefined; ambient: number | undefined };

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
    /** Theme mode (schema 19). Snapshots taken before the field existed hydrate as "light". */
    activeTheme?: ProjectDocument["activeTheme"];
    /**
     * The rest of the document-level state, so UNDO restores it.
     *
     * `cloneDocument` spreads the whole document and therefore always captured these; it was
     * `hydrateDocument` that listed fields by hand and quietly dropped whatever it had not been
     * told about. Naming them here is what makes the compiler catch the next one.
     */
    activeState?: ProjectDocument["activeState"];
    timeline?: ProjectDocument["timeline"];
    frame?: ProjectDocument["frame"];
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
