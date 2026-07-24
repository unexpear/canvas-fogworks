# MILESTONES.md — Visual Design Engine

> The engine is built in **layers**, where each milestone proves **one new
> architectural capability** before the next begins. This is the canonical roadmap.
> Status current as of **2026-07-23**, engine **v0.0.5**.

## Legend

`✅ done` · `🔒 frozen` (contract locked, see `/docs`) · `🚧 in progress` · `⬜ planned`

---

## The Engine Stack

```
M0  Document Engine          ✅   the source of truth + reversible actions
      │
M0.5 Core Documentation      ✅   contracts frozen before building upward
      │
M1  Computed State           ✅   stored intent -> calculated results
      │
M2  Layout Engine            🚧   auto-layout + hug + grow + grid; constraints deferred
      │
M3  Renderer                 ⬜*  reads ComputedState only
      │
M4  Editor                   ⬜*  viewport, selection, manipulation, guides
      │
M5  Variables & Tokens       ⬜
M6  Components                ⬜
M7  States                    ⬜
M8  Animation Engine          ⬜
M9  Interaction Graph         ⬜
M10 Drawing System            ⬜
M11 Assets                    ⬜
M12 Text Engine               ⬜
M13 Export                    ⬜
M14 AI Integration            ⬜
M15 Plugins                   ⬜
M16 Collaboration             ⬜
M17 Production Hardening      ⬜
```

\* **Note on M3/M4:** a working **vertical-slice prototype** of the renderer, the
editor tools, and the Electron shell already exists (originally built as "Phase 1"),
so functionality sits in M3/M4 territory while those milestones are still open.
As of M1 it **does** consume `ComputedState` — the renderer reads world matrices and
never composes coordinates itself — so M3/M4 are now "formalize + complete", not
"re-derive". What is genuinely missing is scope, not plumbing: M3 lacks ellipses,
lines, paths and any Canvas/WebGL backend; M4 lacks **panning**, box-select, rotate
(now representable, but with no editor affordance), snapping and guides.

---

## Phase 0 — Foundation

### Milestone 0 — Deterministic Document Engine ✅ 🔒
**Goal:** prove the document can be safely modified through validated, reversible actions.

**Deliverables (all present):** `ProjectDocument` · `Node` model · UUID identity ·
**scene graph** (`rootNodeUuids` + `parent`/`children`, authored via `AddNodeAction`
`parentId` + `ReparentNodeAction`, traversed by `traverseSceneGraph`) ·
`Action` interface · `ActionDispatcher` · `MutationResult` · `HistoryManager` ·
Undo/Redo (caller-opted coalescing; memory-bounded retention; undo stops at the
truncation boundary and the starting document is pinned OUTSIDE the trimmable list,
reachable via `revertToOriginal()`) · revision system ·
JSON serialization (schema version decoupled from app version) ·
**validation** (Action-path `validate()` **and** `validateDocumentIntegrity` on load:
ranges, dangling parents, ghost roots, cycles) · automated tests.
(M0 and M1 together contribute **123** of the suite's current **167** tests; the count is not M0's alone. M2 added the rest.)

**Round-trip closure (what took M0 from "nearly" to done):** an adversarial audit found
the engine could author a document it could not reopen — `AddNodeAction.validate()`
checked only that the node type was non-empty, while the load path checked membership in
`NODE_TYPES`. It also found `loadDocument()` bypassed `validateDocumentIntegrity`, leaving
the in-memory load path unguarded while the string path was guarded. Both are closed and
mutation-tested: **anything the edit path accepts, the load path can reopen.**

**Explicitly NOT in M0's scope** (so "done" means something precise): the engine can
*author* a nested scene graph — proven by building and restructuring a 4-level tree
through the dispatcher — but no editor affordance invokes it. `ReparentNodeAction` has no
non-test callers. That is a **Milestone 4** gap (grouping / drag-into-frame), not an M0
one. M0 is the engine; reachability is the editor's job.

**Proven concepts (the invariants everything above depends on):**
1. The **document is the single source of truth**.
2. **Actions are declarative** — they compute deltas, they do not mutate.
3. The **Dispatcher is the only write path**.
4. **History manages revisions** as immutable snapshots (undo/redo never re-executes actions).
5. The **renderer is completely independent** of the mutation path.

### Milestone 0.5 — Core Documentation ✅ 🔒
**Goal:** freeze the architectural contracts *before* building upward, so later
milestones extend a fixed reference instead of drifting.

**Deliverables (all present):** `docs/ARCHITECTURE.md`, `docs/DOCUMENT-SCHEMA.md`,
`docs/ACTION-SYSTEM.md`, `docs/TESTING.md`, `docs/CODING-STANDARDS.md`,
`docs/API-CONTRACTS.md`, `docs/README.md`, and this `MILESTONES.md`.

Verification is **continuous, not a one-off claim**: `apiSurface.ts` pins every
documented signature at compile time, `npm run lint` enforces module headers, and
`npm run doc-drift` flags a doc whose declared sources have moved. An adversarial
audit found six prose defects *after* the set was first called verified — stale test
counts, a `Serializer.save` signature contradicted between two frozen docs, a
`ProjectDocument`-for-`ReadonlyDocument` substitution, and a restore-notification
description the project had already replaced. All are fixed; the lesson recorded is
that "verified" is a perishable claim and only the tooling makes it durable.

**Rule (authoritative statement in [docs/README.md](docs/README.md#the-freeze-rule)):**
a change to a frozen contract ships in the *same* change as the doc update **and** a
test. Only a change to the **persisted document shape _or the interpretation of a
persisted field_** additionally bumps `SCHEMA_VERSION` (plus a `migrateIfNeeded`
step) — never bump it for anything else, and note that the app version moves
independently. This is the primary defense against architectural drift as the
engine grows.

---

## Phase 1 — Computed State Pipeline

### Milestone 1 — Computed State ✅
**Goal:** separate stored *intent* from calculated *results*.

```
Document → Geometry Engine → Computed State → Renderer
```

**Deliverables (all present):** `ComputedState` (`{ order, nodes }`, per node a world
matrix + local rect + rotation-aware world AABB) · `GeometryEngine` (`computeGeometry`) ·
transform calculation and parent↔child propagation (schema-2 `Node.transform`:
rotation/scale about a normalized origin) · coordinate spaces (`toLocal`/`toWorld` via
real inverse matrices) · bounding boxes (`subtreeBounds`, `selectionBounds`) ·
matrix math (`Matrix.ts` — multiply/invert/compose/AABB, singular matrices return
`null` rather than `Infinity`) · dirty-state tracking (clean subtrees reuse their
previous entry by reference; a dirty parent invalidates its descendants) · renderer
adapter — **not** a stub: `SVGRenderer` emits the world matrix directly and hit-testing
runs in local space, so a rotated node hits its true shape rather than its AABB.

**Schema cost, paid under the freeze rule:** `Node.transform` changed the persisted
shape, so `SCHEMA_VERSION` went `"1"` → `"2"` with a `migrate_1_to_2` step. The
migration is a pass-through *by content* — absent means identity — but the bump was
still required, because a schema-1 *build* would load a rotated node and draw it
unrotated with no error.

**Transform is a full document citizen, not a dead field.** `UpdateNodeTransformAction`
is the write-path primitive that sets rotation/scale/origin — so `transform` is
authorable, undoable, serializable and validated through the dispatcher, not only by
hand-editing a file. (The M4 rotate handle will invoke it; the action exists at the
document layer independently, exactly as `ReparentNodeAction` predates grouping UI.)

**Dirty tracking is wired, not just present.** `computeGeometry`'s `previous`/`dirty`
parameters are consumed by the app render path: `App` accumulates changed ids from every
`MutationResult` and reuses untouched subtrees between frames. The safety net is a seeded fuzz test asserting `incremental === full` over 300 random ops
(add/move/resize/rotate/reparent/undo/redo), plus explicit tests for the **pending
(drag-preview) path** that the fuzz does not cover — including that an Escape-cancelled
drag recomputes the formerly-pending node, and that omitting the `prevPending` union
would leave a stale preview on screen. Because an under-broad dirty set silently renders
stale, this equivalence is the correctness basis; companion tests prove it is not vacuous.

**Explicitly NOT in M1's scope:** `ComputedState` carries geometry only. Resolved style
(M5 tokens) and layout output (M2) belong in it and are not there — each arrives with
its own milestone rather than being pre-built here.

#### Prerequisites — ✅ all met (the seam is in place)

| # | Prerequisite | Status |
|---|--------------|--------|
| 1 | Scene-graph traversal helper used by renderer + layers panel | ✅ `traverseSceneGraph`; draw order is tree order, not `Map` order |
| 2 | Coordinate-space rule written into the schema; transform reserved | ✅ **stored `x/y` is parent-relative**, world is computed; rotation reserved for a future optional `Node.transform` (see [DOCUMENT-SCHEMA.md](docs/DOCUMENT-SCHEMA.md#coordinate-space-the-m1-contract)) |
| 3 | Drag previews as a computation **input**, not a renderer bypass | ✅ `EditorState.pendingGeometry` → `computeGeometry(doc, pending)`; a parent drag moves its children, and now inherits its rotation too |
| 4 | Undo/redo reports a real dirty set | ✅ `restoreNotification` diffs outgoing vs restored; `fullReload` kept as an alias hint |
| 5 | Hit-testing off computed state, not DOM | ✅ `hitTest(computed, x, y)`; `SelectTool` no longer reads `data-node-id` |

**How it landed:** exactly as predicted — a *producer swap*, not a consumer rewrite.
Every consumer already read the computed structure, so replacing the translation-only
producer with the matrix engine touched the renderer, `SelectTool` and `App` only where
they name the type. The compile pin caught the one call site that would otherwise have
been missed.

---

## Phase 2 — Layout Engine

### Milestone 2 — Layout Engine 🚧
**Goal:** replace absolute positioning with layout computation — the document stores
**"center inside parent"** instead of **`x = 240`**.

M2 is deliberately marked **in progress, not done**: the milestone's full system list is
large. **Auto-layout containers, intrinsic ("hug") sizing, flex-grow, and a grid** are
built and verified; the rest is real work with its own weight, listed as deferred below
rather than quietly folded in.

```
Document → Geometry + Layout Engine → Computed State → Renderer
```

**Built (the core — verified by suite + mutation testing):**
- **Auto-layout containers.** `Layout.container` (`{ direction: row|column, gap?,
  padding?, alignItems: start|center|end|stretch }`) makes a node's direct children a
  flex stack: their stored `geometry.x/y` is **ignored** and their position becomes a
  computed **result** (`LayoutEngine.layoutChildren`). `stretch` also overrides the
  child's cross-axis size. Nested containers compose (an inner container lays out within
  its own stretched size).
- **A producer inside the geometry pass, not a second engine.** `computeGeometry` runs
  the layout when it visits a container parent (parents-first, so each child reads its
  computed rect before it is processed), then composes it through the same matrix
  pipeline — so a laid-out child still inherits parent transforms and world position.
- **Intrinsic ("hug") sizing.** `LayoutContainer.hugWidth`/`hugHeight` size a physical
  axis to the contents (`measureIntrinsicSizes`), so the hugged width/height is a computed
  *result* like a laid-out child's position. Hug **composes upward**, so `computeGeometry`
  is now **two passes**: a bottom-up MEASURE fold feeding the existing top-down POSITION
  pass. Measure is run fully every compute (never memoized) — that keeps the size layer
  identical between a full and an incremental recompute, so `incremental === full` reduces
  to the dirty walk. It reads only pre-stretch sizes, so `hugHeight` + `stretch` are
  coherent (no cycle).
- **The dirty-ripple — now a hug-chain climb.** Resizing one child moves its *siblings*
  and can resize its hug *ancestors*, but a per-node mutation only reports the one node.
  `expandDirtyForLayout` climbs the change **up the hug chain** to the first fixed
  container (adding every container it passes, so siblings at each level reflow); with no
  hug flags it degenerates to the original one-level bump. Structural changes that alter
  membership report the affected container(s) directly (`ReparentNodeAction` reports old
  **and** new parent; `DeleteNodeAction` the removed child's parent), and pending keys join
  the climb seed so a live resize ripples up too. The `incremental === full` fuzz now
  includes hug flags, container toggles, reparents and deletes; mutation-testing found and
  closed a real gap (reparent-*out*-of-a-container) the fuzz alone had missed, and each hug
  guard (the multi-level climb, the fold, the pending seed) was independently killed.
- **Flex-grow — the inverse of hug.** `Layout.grow` (a per-child hint) claims a share of
  a flex parent's *leftover* main-axis space, split proportionally among growing siblings.
  It is applied in the position pass only — it never feeds back into measure, so there is
  no cycle and **no new dirty-tracking** (a growing sibling reflows through the existing
  ripple). It is inert where there is nothing to distribute: a hug-main container, or an
  overflow (flex-shrink is deferred). Orthogonal to `stretch` (main vs cross axis).
- **Grid.** `Layout.grid` is an ALTERNATIVE to `container` (the two are mutually exclusive,
  enforced on both write and read): children auto-flow row-major into `{ px }`/`{ fr }`
  column tracks + a uniform `rowHeight` and fill their cells (`layoutGridChildren`). Like
  grow it is a position-pass-only producer — it reads no child sizes, so it needs no
  measure feedback and reuses the dirty machinery once `isLayoutContainer` counts a grid as
  a container. Mutation testing surfaced a coverage gap it then closed: an `fr`-row grid's
  row heights depend on the item COUNT, so **adding** an item (which reports only the new
  node) must reflow the existing rows — pinned by a deterministic `incremental === full`
  test, since a `px`-row grid or a delete could not exercise the grid's climb path.
- **A full document citizen.** `UpdateNodeLayoutAction` is the write-path primitive
  (authorable, undoable, serializable, validated), exactly as `UpdateNodeTransformAction`
  is for M1. `layoutError` is shared by the edit path and the load path (a non-boolean
  `hugWidth`, or a negative `grow`, is rejected identically), so round-trip closure holds:
  a hand-edited layout the loader would reject is one the editor could never author.
- **Direct-manipulation honesty.** A laid-out child has no meaningful free-drag, so
  `MoveTool` skips it (reorder-by-drag is M4). *(Known UI refinement, deferred to the tools
  milestone: a resize handle on a hug container's hugged axis is a visual no-op — the
  engine correctly ignores the pending resize — but the handle is not yet hidden.)*
- **Schema cost, paid under the freeze rule.** `SCHEMA_VERSION` `"2"` → `"3"` (auto-layout)
  → `"4"` (hug) → `"5"` (grow) → `"6"` (grid), each with a pass-through migration, because
  an older build would draw the children at now-vestigial stored geometry.

**Deferred (each its own deliverable, NOT built):** constraints · anchors (pin to
edges) · flex-shrink · wrap · per-child margins · absolute-position escapes ·
responsive / breakpoint rules · drag-to-reorder · the **grid tail** (explicit
placement/spans, `auto`/content tracks, per-row sizes, grid-container hug).

**Explicitly NOT in scope yet:** `ComputedState` still carries geometry only; resolved
style (M5 tokens) is still absent. Layout output is expressed *as* geometry (computed
local rects), not as a separate channel.

---

## Phase 3 — Rendering Pipeline

### Milestone 3 — Renderer ⬜
Build the renderer for real. **SVG renderer:** rectangles · ellipses · lines · paths ·
text · images. **Canvas/WebGL renderer:** large scenes · shadows · blur · massive
documents. **The renderer only reads `ComputedState`.**

---

## Phase 4 — Editor

### Milestone 4 — Editor ⬜
**Viewport:** pan · zoom · infinite canvas. **Selection:** click · multi-select ·
box select. **Manipulation:** drag · resize · rotate. **Guides:** snapping · alignment
guides · smart guides · rulers.

---

## Phase 5 — Variables & Design Tokens

### Milestone 5 — Variables ⬜
Global values: `Color.Primary`, `Spacing.Small`, `Radius.Medium`, `Typography.Body`.
**Support:** themes · light/dark mode · variable references · token inheritance.
(`VariableStore` and `Style.fill` token syntax `$color/primary` are already reserved.)

---

## Phase 6 — Components

### Milestone 6 — Components ⬜
Reusable objects: components · instances · overrides · nested components · slots ·
variants. Similar to Figma Components.

---

## Phase 7 — States

### Milestone 7 — States ⬜
State machines per node: `Default` · `Hover` · `Pressed` · `Focused` · `Disabled`.
State transitions only — **no animation yet**. (`Node.states` is already reserved.)

---

## Phase 8 — Animation Engine

### Milestone 8 — Animation ⬜
The biggest engine after layout: timelines · keyframes · springs · Bézier curves ·
physics · interpolation · playback · scrubbing. **Animation becomes another producer
of `ComputedState`.**

---

## Phase 9 — Interaction Graph

### Milestone 9 — Interaction Graph ⬜
A visual behavior graph, e.g. `Button Click → Open Menu → Wait 300ms → Fade Overlay → Navigate`.

---

## Phase 10+ — Tools, Assets, Text, Export, and beyond

| M | Name | Scope |
|---|------|-------|
| 10 | Drawing System | pen · pencil · shapes · boolean ops · vector & Bézier editing |
| 11 | Assets | images · SVG · fonts · audio · video — referenced by UUID |
| 12 | Text Engine | rich text · paragraphs · wrapping · OpenType · variable fonts · text on path |
| 13 | Export | SVG · PNG · PDF · HTML · CSS · React · Vue · Flutter · SwiftUI · Android XML |
| 14 | AI Integration | every AI request becomes **Actions** through the Dispatcher — never direct mutation |
| 15 | Plugins | create Actions · read documents · add exporters/importers/tools — **cannot bypass the Dispatcher** |
| 16 | Collaboration | branches · merge · conflict resolution · presence · live cursors · shared history |
| 17 | Production Hardening | dirty rectangles · incremental layout · render caching · virtualization · crash recovery · autosave · backups · full test tiers |

**Why the deterministic Action system pays off later:** M14 (AI) and M15 (Plugins)
are safe because they can *only* emit Actions, and M16 (Collaboration) is feasible
because a linear, serializable revision history is exactly what branch/merge/conflict
resolution needs. These are dividends of the Milestone 0 invariants.
