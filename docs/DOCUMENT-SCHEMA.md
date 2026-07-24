# Document Schema

<!-- describes: src/core/document -->

> 🔒 Frozen contract · schema v5 (app v0.0.5) · current through Milestone 2 (auto-layout + hug + flex-grow). Types are in `src/core/document/`.

## ProjectDocument

The complete, authoritative state of a project (`Document.ts`).

```ts
interface ProjectDocument {
  version: string;                 // = SCHEMA_VERSION on new docs (NEVER the app version)
  metadata: DocumentMetadata;
  nodes: Map<string, Node>;        // UUID → Node, O(1) lookup
  rootNodeUuids: string[];         // top-level nodes, in order
  variables: VariableStore;        // design tokens
}

interface DocumentMetadata {       // runtime shape (date is a live Date)
  project_name: string;
  created_by: string;
  date: Date;
}
```

- `nodes` is the flat repository of **all** nodes (roots and descendants alike).
- The tree is expressed by `rootNodeUuids` + each node's `parent`/`children`, not by nesting.
- New documents are stamped `SCHEMA_VERSION`. `createEmptyDocument()` returns a valid empty document
  (`"Untitled Prototype"`, `created_by: "system"`, empty maps/arrays).

## Node

Every object in `nodes` (`Node.ts`). **Nodes are never mutated directly — only via Actions.**

```ts
const NODE_TYPES = ["core.rectangle", "core.text", "core.image"] as const;
type NodeType = typeof NODE_TYPES[number];   // derived — one edit adds a type
function isNodeType(v: unknown): v is NodeType;  // membership, checked on BOTH paths

interface Node {
  id: string;                       // UUID, equals the map key
  type: NodeType;
  parent?: string | null;           // null/undefined ⇒ a root
  children: string[];               // ordered child UUIDs
  geometry: Geometry;
  style: Style;
  layout: Layout;
  states?: Record<string, StateDefinition>; // reserved for Milestone 7
  text?: string;                    // core.text
  src?: string;                     // core.image
  name?: string;                    // display name
}

interface Geometry { x: number; y: number; width: number; height: number; }
// COORDINATE SPACE: x/y are PARENT-RELATIVE. See the rule below.

interface Style {
  fill: string;        // color OR token id, e.g. "$color/primary"  (tokens: Milestone 5)
  stroke?: string;
  radius?: number;
  opacity: number;     // 0..1
  fontSize?: number;   // core.text; world units, defaults to 14
}

interface Layout {     // constraint intent, not absolute position (Milestone 2)
  horizontalAlignment?: "left" | "right" | "center";  // reserved (constraints, deferred)
  verticalAlignment?: "top" | "bottom" | "center";    // reserved (constraints, deferred)
  spacing?: number;                                    // reserved
  container?: LayoutContainer;                         // M2 auto-layout — LIVE
  grow?: number;                                       // M2 flex-grow (child hint) — LIVE
}

interface LayoutContainer {          // this node's DIRECT CHILDREN are auto-positioned
  direction: "row" | "column";
  gap?: number;                      // between children, >= 0
  padding?: number;                  // inset from the container's edges, >= 0
  alignItems?: "start" | "center" | "end" | "stretch";  // cross-axis; stretch resizes
  hugWidth?: boolean;                // size width to contents (schema 4); absolute axis
  hugHeight?: boolean;               // size height to contents (schema 4); absolute axis
}

interface StateDefinition { [key: string]: any; } // reserved for Milestone 7
```

## Read-only views

`Document.ts` also exports `DeepReadonly<T>` and `ReadonlyDocument`
(`= DeepReadonly<ProjectDocument>`). `ActionDispatcher.getDocument()` returns the
latter, so "the dispatcher is the only write path" is enforced by the compiler rather
than by convention — see [ARCHITECTURE.md](ARCHITECTURE.md) invariant 3.

## Coordinate space (the M1 contract)

**`geometry.x/y` is PARENT-RELATIVE.** A node's world position is a *computed
output*, never stored:

```
world(node) = world(node.parent) + node.geometry.{x,y}      // root: world == stored
```

- Resolved by `computeGeometry(doc, pending?, previous?, dirty?)` → `ComputedState`
  (`src/core/geometry/GeometryEngine.ts`), which walks the scene graph parents-first
  and multiplies each node's local matrix into its parent's world matrix.
- **Nothing outside that module may compose coordinates.** The renderer, hit-testing
  and tools all read the computed rects.
- Composition is full 2D affine (`Mat2D`): rotation and scale propagate from parent to
  child. World→local uses a real inverse matrix (`toLocal`), not subtraction.
- **Reparenting keeps stored (relative) coordinates**, so a node moves with its new
  parent. World-position-preserving reparent is deferred to M2.

**Rotation / scale — landed in schema 2 (Milestone 1).** `Node.transform` is optional:

```ts
interface Transform {
  rotation?: number;                    // radians, clockwise
  scaleX?: number; scaleY?: number;
  origin?: { x: number; y: number };    // fraction of the node's box; default centre
}
```

It is a separate field rather than a widening of `Geometry`, which stays a pure
axis-aligned box so Milestone 2 layout can compute it. `origin` is normalized so the
pivot survives a resize, and is settable via `UpdateNodeTransformAction`
(the write-path primitive; the M4 rotate handle will invoke it). A zero scale is
rejected — it is non-invertible, so `toLocal`/hit-testing would break. **Absent means
identity**, so every schema-1 document is a
valid schema-2 document — which is exactly why `migrate_1_to_2` is a pass-through.

**Auto-layout — landed in schema 3 (Milestone 2, core).** When a node carries
`layout.container`, its **direct children are positioned by the layout engine**: their
stored `geometry.x/y` is *ignored* and replaced by a computed one (a row/column flex
stack with `gap`, `padding`, and cross-axis `alignItems`). This is precisely what
"store *center inside parent* instead of `x = 240`" means — for a laid-out child,
position is a **result**, not stored intent. `alignItems: "stretch"` additionally
overrides the child's cross-axis *size*. Containers nest: an inner container lays out
within its own (possibly stretched) size.

- Computed by `LayoutEngine.layoutChildren`, invoked *inside* `computeGeometry` when it
  visits a container parent — so the result composes through the same matrix pipeline
  and a laid-out child still inherits parent world position and transform.
- **The stored `x/y` of a laid-out child is vestigial** but retained: removing the
  container (`UpdateNodeLayoutAction` with `{ container: undefined }`) reverts the child
  to honouring it again.
- Settable via `UpdateNodeLayoutAction` (the write-path primitive; an M5 layout inspector
  will invoke it). Validated by `layoutError`, **shared with the load path** so the
  round-trip closure holds — a hand-edited container the loader rejects is one the editor
  could never author.
- **Absent means no auto-layout**, so every schema-2 document is a valid schema-3
  document — which is why `migrate_2_to_3` is a pass-through. The bump is still required:
  a schema-2 *build* would ignore the container and draw the children at their now-
  vestigial stored `x/y`, silently misstating the document (the same "old build, not old
  file" hazard as the schema-2 bump below).

**Intrinsic ("hug") sizing — landed in schema 4 (Milestone 2).** A container may set
`hugWidth` / `hugHeight` to size a **physical** axis to its contents instead of using
its stored `geometry`: the hugged width/height becomes a computed *result*, exactly as
a laid-out child's position is.

- `hugWidth` → width = (row: Σ child widths + gaps; column: max child width) + 2·padding.
  `hugHeight` is the same on the other axis. Absolute axes (not "main"/"cross") on
  purpose — flipping `direction` must never silently re-interpret which axis hugs, which
  is exactly the kind of interpretation change the freeze rule exists to catch.
- Hug **composes**: a hug container inside a hug container ripples upward until a fixed
  ancestor absorbs it. So sizing needs a **bottom-up measure pass** (`measureIntrinsicSizes`)
  that runs before positioning — see [ARCHITECTURE.md](ARCHITECTURE.md). The measure reads
  only stored/pending sizes and container rules (never a child's *stretched* size), so it
  is an acyclic fold: `hugHeight` + `alignItems: "stretch"` are coherent (a container hugs
  to its children's pre-stretch cross-size, then stretches them to fill it).
- Validated by the shared `layoutError` on both the edit and load paths (a non-boolean
  `hugWidth` is rejected identically), and settable via `UpdateNodeLayoutAction`.
- **Absent means fixed size**, so every schema-3 document is a valid schema-4 document —
  hence `migrate_3_to_4` is a pass-through. The bump is still required: a schema-3 *build*
  would draw a hug container at its now-vestigial stored width/height, misstating the doc.

**Flex-grow — landed in schema 5 (Milestone 2).** A child sets `Layout.grow` (a number,
default 0) to claim a share of its flex parent's **leftover main-axis space**, split
among siblings in proportion to their `grow`. It lives on the child's own `Layout` (like
CSS `flex-grow`), and is consumed by the container parent during positioning.

- Applied in the **position pass only** — it never feeds back into the bottom-up measure
  pass, so there is no cycle and a growing child does not change a hug ancestor's size.
- **Inert when there is no free space:** a *standalone* container that hugs its main axis,
  or one whose children already overflow, has nothing to distribute (overflow is *not*
  shrunk — flex-shrink is deferred). `grow` and `alignItems: "stretch"` are orthogonal
  (main vs cross axis).
- **grow wins over hug on a shared axis.** A node can be both a hug *container* and a grow
  *child*: it hugs its own content, but if its parent grows it, the grown size wins and its
  children lay out within the grown box (matching CSS `flex-grow` overriding content size).
- **Intentional divergence from CSS:** all free space is distributed by `grow` ratio, so a
  lone `grow: 0.5` still fills the row — the `(1 − Σgrow)` fraction CSS leaves empty when
  `Σgrow < 1` is *not* reserved. `grow` means "my share of the space", not "my fraction of
  one unit".
- Validated by the shared `layoutError` on both paths (`grow` must be finite and ≥ 0);
  because a `{ grow }` patch may carry no `container`, the check runs *before* the
  no-container early return. Settable via `UpdateNodeLayoutAction`.
- **Absent means 0**, so every schema-4 document is a valid schema-5 document —
  `migrate_4_to_5` is a pass-through. The bump is still required: a schema-4 build would
  draw a growing child at its base size instead of filled.

> **Still deferred (not in schema 5):** constraints/anchors, flex-shrink, wrap, grid,
> per-child margins, absolute-position escapes, responsive rules. These are M2's
> remaining deliverables — see [MILESTONES.md](../MILESTONES.md) § Milestone 2.

> **It bumped `SCHEMA_VERSION` to `"2"`** — as the freeze rule required, with a
> matching `migrate_1_to_2` step. The bump was necessary even though the migration is
> a pass-through *by content*: without it a schema-1 **build** would load a rotated
> node, pass the exact-match gate, and draw it unrotated with no error.
>
> Do not be tempted by "it's optional and additive, so old files still load." That
> reasoning is backwards: the risk is not old *files*, it is old *builds*. Without a
> bump, an old build reads a rotated node, passes the exact-match gate, and draws it
> **unrotated with no error** — and the user then edits against a canvas that misstates
> their document. With a bump, `migrateIfNeeded` throws *"newer than this build
> supports"* and fails loudly. **There is no "additive so it's safe" exception.**
>
> ⚠️ *"Fails loudly" is a property of the READER, not of the bump.* Builds released
> before the newer-than-schema gate existed simply treat an unknown version as an
> unreadable file — the installer checked into `exe/` is one of them: it exact-matches
> its own `CURRENT_VERSION` and swallows the failure. So before bumping, check the
> oldest build you still support: for those readers a bump is silent data loss, not a
> clear error.

### Field invariants — and where each is enforced

| Invariant | Action path | Load path (`deserializeDocument`) |
|-----------|-------------|-----------------------------------|
| `geometry.*` finite; `width`/`height` `> 0` | ✅ `validate()` | ✅ `validateDocumentIntegrity` |
| `opacity ∈ [0,1]`; `radius ≥ 0`; `fontSize > 0` | ✅ `validate()` | ✅ `validateDocumentIntegrity` |
| `id` equals the `nodes` map key | — | ✅ throws on mismatch |
| node shape (required fields/types) | ✅ by construction | ✅ `isValidNode` |
| `type` ∈ `NODE_TYPES` | ✅ `AddNodeAction.validate()` | ✅ `isNodeType` |
| `parent` resolves; no dangling refs | ✅ `AddNodeAction`/`ReparentNodeAction` | ✅ `validateDocumentIntegrity` |
| `children` resolve, claimed once, back-point via `parent` | ✅ | ✅ |
| roots exist, unique, parentless; parentless nodes are roots | ✅ | ✅ |
| tree is acyclic | ✅ `ReparentNodeAction` rejects cycles | ✅ `validateDocumentIntegrity` |

`validateDocumentIntegrity(doc)` (`src/core/document/Integrity.ts`) runs at the end
of `deserializeDocument`, so a hand-edited or third-party file with `opacity: 5`,
`width: -10`, a dangling `parent`, or a ghost root now **fails loudly at the
boundary** instead of corrupting state later.

> **Reserved-but-unused today:** `states`, the `layout` *constraint* fields
> (`horizontalAlignment` / `verticalAlignment` / `spacing`), and token resolution of
> `fill` are part of the schema so later milestones don't require a breaking change,
> but the current renderer/actions do not yet interpret them. **`layout.container` is
> the exception — it is live (M2 auto-layout).**

## VariableStore (design tokens — reserved for Milestone 5)

```ts
interface VariableStore {
  [key: string]: {
    type: "color" | "spacing" | "font";
    value: string;
    modes?: Record<"light" | "dark", string>; // theme support
  };
}
```

## Serialization

`Serializer.ts` converts to/from a versioned JSON **envelope**. Because JSON has no
`Map` or `Date`, the wire form differs from the runtime form — this is captured by a
distinct type.

```ts
interface SerializedMetadata {          // wire shape: date is an ISO string
  project_name: string;
  created_by: string;
  date: string;
}

interface SerializedDocument {
  version: string;
  document: {
    metadata: SerializedMetadata;
    nodes: Record<string, Node>;        // Map flattened to an object
    rootNodeUuids: string[];
    variables: ProjectDocument["variables"];
  };
}
```

- `serializeDocument(doc): string` — stamps `version`, writes `date` as `toISOString()`,
  flattens `nodes` via `Object.fromEntries`, `JSON.stringify(..., 2)`.
- `deserializeDocument(json): ProjectDocument` —
  1. `JSON.parse` wrapped to throw a descriptive `"Invalid JSON…"` on failure;
  2. envelope validation (root object, `version` string, `document` object, `nodes` object);
  3. `migrateIfNeeded` (below);
  4. rebuilds the `nodes` `Map`, rehydrates `date` to a `Date`, falls back to
     `createEmptyDocument()` defaults for any missing `metadata` fields.
- `compareDocuments(a, b): boolean` — structural equality over version,
  `metadata.project_name`, `rootNodeUuids` (order-sensitive), and each node.

## Versioning & migration

There are **two independent version identifiers**. Confusing them is a data-loss bug:

| Constant | Meaning | Changes when | Used for |
|----------|---------|--------------|----------|
| `SCHEMA_VERSION` | on-disk document schema (currently `"5"`; chain: 1→2 transform, 2→3 auto-layout, 3→4 hug sizing, 4→5 flex-grow) | **only** when the persisted shape changes | `document.version`, the migration gate |
| `CURRENT_VERSION` | app/release version (injected from `package.json` via esbuild `define`; literal fallback in tests) | every release | display only (status bar, About) |

They are deliberately decoupled: **shipping a new build must never orphan saved
documents.** A drift test pins `CURRENT_VERSION` to `package.json`, and another
asserts `SCHEMA_VERSION` is *not* the app version.

`migrateIfNeeded(raw, currentSchema = SCHEMA_VERSION)` behaviour (the schema is a
parameter so the future-bump case is testable today):
- version **equals** `SCHEMA_VERSION` → pass through.
- **legacy semver** (`0.0.5` etc., written before the split) → same shape as schema 1;
  re-stamped and accepted.
- **numerically newer** than `SCHEMA_VERSION` → throws *"newer than this build supports"*.
- anything else → throws *"Migration not implemented…"* (fails loudly rather than
  silently corrupting).

- **When you bump `SCHEMA_VERSION`:** add the migration step in `migrateIfNeeded`,
  update this doc, and add a round-trip + migration test. (See the freeze rule.)
  Bumping the **app** version requires none of this.

## Persistence (localStorage convenience wrapper)

```ts
type LoadResult =
  | { status: "empty";   document: null }              // nothing saved
  | { status: "loaded";  document: ProjectDocument }
  | { status: "corrupt"; document: null; error: Error };// present but unreadable

Serializer.loadResult(): LoadResult   // distinguishes the three cases
Serializer.load(): ProjectDocument | null   // back-compat: document or null
Serializer.save(doc): SaveResult   // { status: "saved" } | { status: "failed"; error }
```

- Storage key `"vde-document"`; a corrupt payload is preserved to
  `"vde-document.corrupt-backup"` and logged, never silently dropped.
