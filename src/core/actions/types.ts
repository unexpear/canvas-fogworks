/**
 * @module ActionTypes
 * @description Shared types used across all Actions and History tracking.
 */

import { SourceRect, RasterSurface, UserData } from "../document/Node";
import { NineSliceInsets } from "../geometry/NineSlice";
import { Node, Geometry, Style, Layout, Transform, VariantKey, StateDefinition, PathCommand, BooleanOp, RESERVED_NODE_ID } from "../document/Node";
import { ProjectDocument, SerializedMetadata, VariableStore, ThemeMode } from "../document/Document";
import { InstanceOverride } from "../document/Components";
import { Interaction } from "../document/Prototype";
import { Keyframe } from "../document/Timeline";
import { Mesh } from "../document/Mesh";
import { Tilemap } from "../document/Tilemap";
import { Light } from "../document/Light";
import { Clip } from "../document/Clips";
import { Tileset } from "../document/Tileset";
import { Asset3D, Spatial3D } from "../document/Spatial3D";

/**
 * The reserved `propertyDeltas` key a DOCUMENT-LEVEL delta (kind "variables") travels
 * under — the delta map is keyed by node id, and doc-level state has none. The kind, not
 * the key, is what dispatch switches on; the id itself is RESERVED at the document layer
 * (`RESERVED_NODE_ID`, rejected by AddNodeAction + Integrity) so a real node can never
 * collide with it in a transaction's merged delta map.
 */
export const DOCUMENT_DELTA_KEY: string = RESERVED_NODE_ID;

/**
 * The key one document-level delta travels under, one slot PER KIND.
 *
 * A transaction may touch more than one document-level thing — an import sets the clock and the
 * named ranges that index into it, which is one act — and a single shared slot could hold only one
 * of them. It used to REFUSE that transaction outright, which was the right answer while the
 * alternative was losing one silently, and the wrong answer once a legitimate edit needed both.
 *
 * Two deltas of the SAME kind still collapse last-wins, exactly as they always did: the slot is per
 * kind, not per action.
 */
export function documentDeltaKey(kind: string): string {
    return `${DOCUMENT_DELTA_KEY}:${kind}`;
}

/**
 * Whether a delta-map key names the DOCUMENT rather than a node.
 *
 * Prefix-matched, and the separator is what makes that safe: `RESERVED_NODE_ID` is refused as a
 * stored node id by both `AddNodeAction` and `Integrity`, so no real node can produce a key that
 * begins this way.
 */
export function isDocumentDeltaKey(key: string): boolean {
    return key === DOCUMENT_DELTA_KEY || key.startsWith(`${DOCUMENT_DELTA_KEY}:`);
}

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
        /** The author's own kind for this node (schema 64); null clears it. */
        className?: string | null;
        /** Author-defined properties (schema 64); null clears them. Whole-map, like `overrides`. */
        userData?: UserData | null;
        /** Typed gameplay declarations (schema 73); null clears them. */
        entity?: import("../document/Entity").Entity | null;
        animation?: import("../document/AnimationController").AnimationController | null;
        /** Typed 3D authoring components (schemas 74-75); null clears them. */
        spatial3d?: Spatial3D | null;
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
        /**
         * The TILE GRID (schema 61) — a whole-value replace, as `path` and `mesh` are.
         *
         * NOT CLEARABLE, unlike most fields here: `Integrity` refuses a `core.tilemap` without a
         * grid, so "no tilemap" is not a state the node can be in. That is why it is read with
         * `!== undefined` rather than with `in`.
         */
        tilemap?: Tilemap;
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
    | { kind: "lighting"; lights: Light[] | undefined; ambient: number | undefined }
    /** NAMED RANGES of the clock (schema 46). Whole-value under `DOCUMENT_DELTA_KEY`, like the
     *  timeline it indexes into. `undefined` removes them. The field existed and was validated,
     *  serialised and EXPORTED from for four schema versions with no delta that could set it. */
    | { kind: "clips"; clips: Clip[] | undefined }
    /** The TILESET TABLE (schema 67). Whole-value under its own document key, like the clips and
     *  the clock. `undefined` removes it. A tileset is shared by every layer that names it, so it
     *  belongs to the file rather than to a node. */
    | { kind: "tilesets"; tilesets: Tileset[] | undefined }
    /** WHAT THE DOCUMENT SITS ON (schema 70). Whole-value under its own document key, like the
     *  tileset table and the clock. `undefined` removes it, which is how a document says it has no
     *  sky — the state every document was in before this field existed. */
    | { kind: "background"; background: string | undefined }
    /** ONE SCREEN OF THE GAME (schema 72). Whole-value under its own document key, like the sky it
     *  sits beside. `undefined` removes the declaration — the state of every pre-72 document. */
    | { kind: "screen"; screen: { width: number; height: number } | undefined }
    /** Stable imported 3D assets (schema 74), replaced as one validated table. */
    | { kind: "assets3d"; assets3d: Asset3D[] | undefined }
    | { kind: "behaviorAssets"; behaviorAssets: import("../document/BehaviorAssets").BehaviorAsset[] | undefined }
    | { kind: "gameplayVariables"; gameplayVariables: import("../document/GameplayData").GameplayVariable[] | undefined }
    | { kind: "behaviorFunctions"; behaviorFunctions: import("../document/BehaviorFunctions").BehaviorFunction[] | undefined };

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
     * `cloneDocument` spreads the whole document and therefore always captured these. It was
     * `hydrateDocument` that listed fields by hand and dropped whatever it had not been told
     * about — and the claim that used to sit here, that naming them "is what makes the compiler
     * catch the next one", was FALSE: every field below is optional, so one left out of that
     * literal was silently absent, not a type error. Two were missing when this was written
     * down. `hydrateDocument` now SPREADS instead of enumerating, which is what actually makes
     * the next field safe; this list is documentation of what a snapshot carries, and nothing
     * depends on it being complete.
     */
    activeState?: ProjectDocument["activeState"];
    timeline?: ProjectDocument["timeline"];
    frame?: ProjectDocument["frame"];
    clips?: ProjectDocument["clips"];
    lights?: ProjectDocument["lights"];
    ambient?: ProjectDocument["ambient"];
    assets3d?: ProjectDocument["assets3d"];
    behaviorAssets?: ProjectDocument["behaviorAssets"];
    gameplayVariables?: ProjectDocument["gameplayVariables"];
    behaviorFunctions?: ProjectDocument["behaviorFunctions"];
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
