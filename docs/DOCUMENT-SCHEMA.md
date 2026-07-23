# Document Schema

<!-- describes: src/core/document -->

> 🔒 Frozen for Milestone 0 · v0.0.5. Types are in `src/core/document/`.

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
  horizontalAlignment?: "left" | "right" | "center";
  verticalAlignment?: "top" | "bottom" | "center";
  spacing?: number;
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

- Resolved by `computeWorldGeometry(doc, pending?)` → `{ order, rects }`
  (`src/core/geometry/ComputedGeometry.ts`), which walks the scene graph
  parents-first and accumulates ancestor offsets.
- **Nothing outside that module may compose coordinates.** The renderer, hit-testing
  and tools all read the computed rects.
- Today it is translation-only; Milestone 1's `GeometryEngine` replaces it with full
  transform/matrix composition and grows it into `ComputedState`.
- **Reparenting keeps stored (relative) coordinates**, so a node moves with its new
  parent. World-position-preserving reparent is deferred to M2.

**Rotation / skew — reserved, deliberately not yet in the type.** When transforms
arrive they go in a **new optional `transform` field on `Node`**, *not* by widening
`Geometry` (which stays a pure axis-aligned box that layout in M2 can compute).
Nothing is added to the type until M1 populates it — a field no code reads or writes
is dead API surface, and "reserved" is a decision, not a declaration.

> **Adding it bumps `SCHEMA_VERSION`** — it changes the persisted shape, so the
> [freeze rule](README.md#the-freeze-rule) applies as written, with a matching
> (initially no-op) `migrateIfNeeded` step from schema `"1"`.
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
| `parent` resolves; no dangling refs | ✅ `AddNodeAction`/`ReparentNodeAction` | ✅ `validateDocumentIntegrity` |
| `children` resolve, claimed once, back-point via `parent` | ✅ | ✅ |
| roots exist, unique, parentless; parentless nodes are roots | ✅ | ✅ |
| tree is acyclic | ✅ `ReparentNodeAction` rejects cycles | ✅ `validateDocumentIntegrity` |

`validateDocumentIntegrity(doc)` (`src/core/document/Integrity.ts`) runs at the end
of `deserializeDocument`, so a hand-edited or third-party file with `opacity: 5`,
`width: -10`, a dangling `parent`, or a ghost root now **fails loudly at the
boundary** instead of corrupting state later.

> **Reserved-but-unused today:** `states`, `layout` behavior, and token resolution of
> `fill` are part of the schema so later milestones don't require a breaking change,
> but the current renderer/actions do not yet interpret them.

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
| `SCHEMA_VERSION` | on-disk document schema (currently `"1"`) | **only** when the persisted shape changes | `document.version`, the migration gate |
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
Serializer.save(doc): void
```

- Storage key `"vde-document"`; a corrupt payload is preserved to
  `"vde-document.corrupt-backup"` and logged, never silently dropped.
