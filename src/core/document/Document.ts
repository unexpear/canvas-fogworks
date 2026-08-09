/**
 * @module Document
 * @description The canonical, authoritative document container. This structure represents the user's intent and must be immutable from a service perspective.
 */

import { Node } from "./Node";
import { Clip } from "./Clips";
import { VariableStore, ThemeMode } from "./Variables";

// The variables layer (types + validation + resolution) lives in Variables.ts; the document
// re-exports the store type so existing `import { VariableStore } from "./Document"` holds.
export { VariableStore, ThemeMode };

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
 *
 *   "12" — adds `LayoutContainer.wrap` (flex-wrap: multi-line flow) for Milestone 2. Absent
 *         = nowrap (a single line), so `migrate_11_to_12` is a pass-through — but a schema-11
 *         build would draw a wrapping container's children on one overflowing line and
 *         mis-size a cross-hug container, misstating the layout.
 *
 *   "13" — adds `Layout.colSpan`/`rowSpan` (grid item spans) for Milestone 2. Absent = 1 (a
 *         single cell), so `migrate_12_to_13` is a pass-through — but a schema-12 build would
 *         ignore the spans and mis-place / mis-size the grid's cells.
 *
 *   "14" — widens `Layout.margin` to `number | Margins` (per-side margins) and applies it to
 *         GRID children (cell inset), not just flex. A plain `number` is the old uniform
 *         margin, so `migrate_13_to_14` is a pass-through — but a schema-13 build would not
 *         understand a per-side object and would ignore a grid child's margin.
 *
 *   "15" — the M2 layout-engine close-out batch: `LayoutContainer.alignContent`/`wrapReverse`
 *         (cross-axis line distribution + reverse stacking), `LayoutGrid.autoFlow`
 *         ("row"/"column", dense), and `Layout.gridColumn`/`gridRow` (explicit line placement).
 *         All optional (absent = start / false / "row" / auto-flow), so `migrate_14_to_15` is a
 *         pass-through — but a schema-14 build would mis-distribute wrapped lines, flow a grid the
 *         wrong way, or auto-place a pinned item at the wrong cell.
 *
 *   "16" — adds the `core.ellipse` and `core.line` node types (Milestone 3 renderer). Existing
 *         documents contain neither, so `migrate_15_to_16` is a pass-through — but a schema-15
 *         build would reject an ellipse/line as an unknown type on load, and would not know that a
 *         `core.line` may collapse one geometry axis (a horizontal/vertical line).
 *
 *   "17" — adds the `core.path` node type + `Node.path` (structured absolute drawing commands,
 *         `PathCommand[]`). Existing documents contain none, so `migrate_16_to_17` is a pass-through
 *         — but a schema-16 build would reject a path as an unknown type on load, and would not
 *         understand the `path` command array. Raw SVG-`d`-string parsing is deferred to a future
 *         import feature; the stored form is always explicit absolute commands.
 *
 *   "18" — adds `Style.shadow` (drop shadow: dx/dy/blur/color) and `Style.blur` (whole-node gaussian
 *         blur), the Milestone 3 renderer effects. Existing documents have neither, so
 *         `migrate_17_to_18` is a pass-through — but a schema-17 build would silently ignore an
 *         effect and render the node flat.
 *
 *   "19" — Milestone 5 design tokens: the reserved `variables` store becomes LIVE and typed
 *         (`{ type: "color"|"spacing"|"font", value, modes? }`, values may ALIAS other
 *         variables via "$key", spacing values are numbers), and the document gains
 *         `activeTheme` ("light"/"dark", the mode token resolution reads). `migrate_18_to_19`
 *         NORMALIZES rather than passes through: the old store was never validated, so it
 *         stamps `activeTheme: "light"`, coerces legacy string-valued spacing variables to
 *         numbers, and drops entries that cannot validate — every previously-loadable file
 *         stays loadable. The bump is interpretation too: "$"-prefixed strings are now
 *         aliases/tokens, and an 18 build would render a token fill as a literal color string.
 *
 *   "20" — widens `Style.radius` and `Style.fontSize` to `number | string` (a "$token" number
 *         reference, resolved against `variables` under `activeTheme` at render time — the M5
 *         number tokens becoming consumable). Existing documents carry only numbers, so
 *         `migrate_19_to_20` is a pass-through — but a schema-19 build's `isValidNode` rejects a
 *         string radius/fontSize outright, which is exactly what the bump signals.
 *
 *   "21" — adds the `core.instance` node type + `Node.componentId` (Milestone 6 components: an
 *         instance renders a copy of a MASTER node subtree, resolved by `expandInstances`).
 *         Existing documents contain neither, so `migrate_20_to_21` is a pass-through — but a
 *         schema-20 build would reject an instance as an unknown node type on load, and would
 *         not know that `::` is now RESERVED in stored node ids (the virtual-id separator).
 *
 *   "22" — adds `Node.overrides` (per-instance property overrides, M6 slice 2: what one instance
 *         changes about the master copy it renders, keyed by master node id). Existing documents
 *         carry none — and an absent map means "mirrors the master exactly", which is what schema
 *         21 already meant — so `migrate_21_to_22` is a pass-through. The bump is still required:
 *         a schema-21 build would IGNORE the overrides and render every instance identically,
 *         silently misstating the document.
 */
import type { TimelineSettings } from "./Timeline";
import type { Light } from "./Light";

export const SCHEMA_VERSION = "61";

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

    /**
     * The theme mode token resolution reads (schema 19) — a variable's `modes[activeTheme]`
     * override wins over its base value. Persisted, so a document reopens in the theme it was
     * saved in; changed only through an action (undoable). Absent on the wire = "light".
     */
    activeTheme: ThemeMode;
    /**
     * The document's own clock, and where it is on it (schema 39).
     *
     * `frame` sits beside `activeState` for the same reason that does: it is a statement about
     * which derivation to show, and every consumer reaches the shown document through
     * `resolveScene`. Absent `timeline` means the document is not animated, and `applyFrame`
     * returns it by reference — a document nobody animated must cost what it always did.
     */
    timeline?: TimelineSettings;
    frame?: number;
    /**
     * Named frame ranges over the timeline — `idle`, `walk`, `jump` (schema 46).
     *
     * A character is a dozen animations, not one. ORDERED because that is the order somebody
     * arranged them in; absent means the whole timeline is the only animation there is.
     */
    clips?: Clip[];
    /**
     * What the document is LIT by (schema 42). Absent = unlit, which every document was.
     *
     * Document-level rather than per-node, because a light is a property of the SCENE: two shapes
     * lit from different directions do not read as two shapes, they read as a mistake.
     */
    lights?: Light[];
    /** The floor below which nothing gets darker, 0..1. Absent = 1, i.e. no lighting at all. */
    ambient?: number;

    /** The named STATE every node resolves against (Milestone 7, schema 30) — the same
     *  document-level-selection shape as `activeTheme`. Absent/empty = the base state. */
    activeState?: string;
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
        variables: {}, // Empty variable store
        activeTheme: "light"
    };
}