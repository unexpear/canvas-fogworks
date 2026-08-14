# MILESTONES.md — Visual Design Engine

> The engine is built in **layers**, where each milestone proves **one new
> architectural capability** before the next begins. This is the canonical roadmap.
> Status current as of **2026-08-13**, engine **v0.0.5**, schema **68**.
>
> **Seven rows below said ⬜ for capabilities that had shipped.** They said it for three weeks
> because this file declared no `describes:` directive: `check-doc-drift` named it, looked it
> up, found nothing and moved on without a word. Being skipped is indistinguishable from
> passing, which is now itself a reported condition.

<!-- describes: src/core, src/editor, src/renderer -->
<!-- re-read 2026-08-13 after schema 67: M11 said Aseprite was BUILT AND UNREACHABLE and that a
     tileset was not a thing the document holds. Both had stopped being true, one of them the same
     day. M13 records the multi-tileset export. -->

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
M2  Layout Engine            ✅   flex(grow/shrink/wrap/align-content) + hug + grid(rows/auto/hug/spans/flow/pins) + constraints + absolute; minmax/fit-content deferred
      │
M3  Renderer                 ✅   SVG renderer (shapes + culling + effects) + Canvas backend (tested); canvas wiring → M4
      │
M4  Editor                   ✅*  pan/zoom + box-select + DOM-free handles + rotate + canvas wiring + snapping/guides
      │
M5  Variables & Tokens       ✅*  typed store + light/dark themes + $token references + aliases; radius/fontSize tokens live (schema 20); layout-side spacing tokens deferred
M6  Components                🚧   masters + instances + resolution + per-instance overrides (schema 22); variants/slots next
M7  States                    ✅   `Node.states` + `activeState` (schema 30, the first SANITIZING migration) + `SetStateAction`
M8  Animation Engine          ✅   timeline + keyframes + cubic-Bézier easing + HOLDS (cel) + onion skin — `Timeline` (407), `Bezier` (172), `Clips` (105)
M9  Interaction Graph         ✅*  `Node.interactions`: trigger → state, with duration/easing, plus NAVIGATE to a node (schema 36), and a Play mode that fires them. A state machine, not a node GRAPH — the name overpromises
M10 Drawing System            ✅   12 paint modules / 2,107 lines: buffer, patch, brush, stroke, fill, selection + outline, symmetry, palette, quantize, adjust, codec, surface space — with a Paint workspace and its tools
M11 Assets                    ✅*  16 importers: Tiled (maps, tilesets, objects), SVG, fonts, atlases, `.unitypackage`, sheets, numbered frame runs, and now ASEPRITE — a file arrives as one node that plays, with the file's own timing and its tags as clips, through a confined bytes channel. glTF and OBJ are BLOCKED rather than unwired — every `NODE_TYPE` is 2D, so there is no node to import a mesh into, and 10,937 files here are waiting on that. A TILESET IS NOW A THING THE DOCUMENT HOLDS (schema 67-68, 2026-08-13): shared by every layer that names it. The duplication took TWO schemas to actually end — 67 moved the picture and the importer went on writing the old copy, so a six-layer import stored the sheet SEVEN times (1,374KB against 202KB) until 68 refused the field. Collection sets draw via the node-per-cell path, not as one node; the corpus holds ZERO orthogonal tile layers that would use one. See FEATURE-AUDIT.md
M12 Text Engine               ✅*  typesetting, wrapping and on-canvas editing, shared by all three backends and the exporter. ONE style per node — no per-run styling
M13 Export                    ✅*  SVG, Tiled `.tmx` (tile AND object layers, one `<tileset>` per distinct set with its own `firstgid`), sprite sheet (`sheet.json` + `sheet.png`). No PNG or PDF of the canvas
M14 AI Integration            ⬜
M15 Plugins                   ⬜
M16 Collaboration             ⬜
M17 Production Hardening      ⬜
```

\* **Note on M3/M4:** a working **vertical-slice prototype** of the renderer, the
editor tools, and the Electron shell already exists (originally built as "Phase 1"),
so functionality sits in M3/M4 territory while those milestones are still open.
As of M1 it **does** consume `ComputedState` — the renderer reads world matrices and
never composes coordinates itself — so M3/M4 were "formalize + complete", not
"re-derive". What was genuinely missing was scope, not plumbing, and it has since ALL landed:
M3 (ellipses, lines, paths, effects, the Canvas backend) and M4 (pan/zoom, box-select, rotate,
DOM-free handle picking, canvas wiring, snapping + smart guides) are both complete — with
refinements deferred and listed in each milestone's close-out.

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
(M0 and M1 together contribute **123** of the suite's current **188** tests; the count is not M0's alone. M2 added the rest.)

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

### Milestone 2 — Layout Engine ✅
**Goal:** replace absolute positioning with layout computation — the document stores
**"center inside parent"** instead of **`x = 240`**.

M2's layout engine is **feature-complete**: flex (grow · shrink · wrap · align-content ·
wrap-reverse · per-side margins · hug), grid (px/fr/auto tracks · per-row sizes · container
hug · spans · dense/column auto-flow · explicit line placement · cell margins), constraints,
and absolute escapes — all through one two-pass, `incremental === full` engine where every
hugging container's size equals the geometry it lays out. Each feature landed as a verified
slice (design panel → mutation-tested guards → adversarial review → schema bump), which
repeatedly caught fuzz-blind bugs (a grid-placement OOM, a wrap grow-starve, a margin round-trip
gap). What remains is a short, honestly-scoped list of **advanced/edge features and cross-
milestone concerns** (below) — none a core-layout gap.

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
  ripple). It is inert where there is nothing to distribute: a hug-main container. Orthogonal
  to `stretch` (main vs cross axis).
- **Flex-shrink — grow's mirror.** `Layout.shrink` gives up a share of the *deficit* when
  the children overflow, weighted `shrink × base-size` (CSS-style — a bigger item gives up
  more), clamped at 0. Grow and shrink are mutually exclusive by the *sign* of the free
  space; margins are counted first, so they are never shrunk. Same position-pass-only shape
  as grow (no new dirty-tracking); all four guards mutation-tested — including a case with
  UNEQUAL bases, without which a mutation dropping the `×base` weight would have survived.
- **Grid.** `Layout.grid` is an ALTERNATIVE to `container` (the two are mutually exclusive,
  enforced on both write and read): children auto-flow row-major into `{ px }`/`{ fr }`
  column tracks + a uniform `rowHeight` and fill their cells (`layoutGridChildren`). In this
  schema-6 core (px/fr, no hug) it is a position-pass-only producer — it reads no child sizes,
  so it needs no measure feedback and reuses the dirty machinery once `isLayoutContainer`
  counts a grid as a container. (The later `auto`/hug slice changes that — see below.)
  Mutation testing surfaced a coverage gap it then closed: an `fr`-row grid's
  row heights depend on the item COUNT, so **adding** an item (which reports only the new
  node) must reflow the existing rows — pinned by a deterministic `incremental === full`
  test, since a `px`-row grid or a delete could not exercise the grid's climb path.
- **Grid per-row tracks — the tractable half of the grid tail.** `LayoutGrid.rows` gives
  explicit per-row track sizes (the mirror of `columns`), with `rowHeight` demoted to the
  IMPLICIT fallback for any row past the `rows[]` list (CSS `grid-template-rows` +
  `grid-auto-rows`). Both axes now run through one track resolver, so `fr` rows share the
  leftover inner height after the `px` rows exactly as columns do; row COUNT is still derived
  from the child count, so it stays a pure position-pass producer (`incremental === full`
  held under a fuzz that varies `rows` shorter/longer than the derived rows). A single
  unequal-row test pins explicit-wins + implicit-fallback + prefix-sum row-Y +
  fr-after-px at once; all five guards mutation-tested and killed.
- **Layout close-out (schema 15) — align-content/wrap-reverse, grid auto-flow, explicit
  placement.** The final batch, scoped by a design panel that flagged what was tractable vs. a
  genuine algorithm. **`alignContent`/`wrapReverse`** distribute + reflect wrapped lines — pure
  position-pass arithmetic that is a NO-OP under a cross-hug (so the measure fold is untouched).
  **`LayoutGrid.autoFlow`** adds dense packing and column flow — column flow is the exact
  TRANSPOSE of row flow, reusing the one placement kernel rather than a second algorithm.
  **`Layout.gridColumn`/`gridRow`** pin an item to explicit `[start,end)` lines via a pre-pass
  that marks the cells so auto items flow around them. All optional/byte-identical-when-absent;
  every guard mutation-tested (one column-flow guard needed a SPAN case to be observable — 1×1
  items don't distinguish a transpose). Honestly DEFERRED as their own weight: **`minmax()`/
  `fit-content` track sizing** (the CSS iterative freeze-and-reflow algorithm — the one piece
  that would rewrite `resolveTracks` rather than thread a field through) and single-axis explicit
  placement. This closes the M2 layout engine.
- **Per-side + grid-cell margins.** `Layout.margin` widened from a uniform `number` to
  `number | Margins` (per-side top/right/bottom/left), and now applies to GRID children too
  (a cell inset; an `auto` track grows to fit the child + its margins). The flex math generalised
  the symmetric `2·margin` to per-side before/after via a direction-based physical→logical map
  (`resolveMargin`/`logicalMargin`) used identically by `layoutChildren`, `breakFlexLines`, and
  the measure fold — so a hugged/wrapping container agrees with its children. A plain number is
  byte-identical to before (regression-checked). All eight guards mutation-tested and killed —
  one of which SURVIVED at first because the `breakFlexLines` margin test was vacuous (the items
  broke the same way with or without the margin); an unequal case that only wraps once the margin
  is added closed it (a-survivor-is-a-missing-test). An adversarial read-only review then found a
  round-trip-closure gap: `marginError` accepted an ARRAY margin (`typeof [] === "object"`, every
  named side reads undefined) and silently zeroed it — the loader was more permissive than the
  (TypeScript-guarded) edit path. Fixed with an `Array.isArray` guard + a both-paths test. schema 13→14.
- **Grid spans — a real placement algorithm.** `Layout.colSpan`/`rowSpan` let a grid item
  occupy multiple cells. A design panel (3 lenses converged) settled it around one shared
  `placeGridItems` — CSS-style SPARSE auto-placement: a forward-only, row-major cursor gives each
  item the next FREE `colSpan × rowSpan` block, skipping cells occupied by earlier spans (a `Set`
  of flat `row*cols + col` indices). Called ONCE inside `resolveGridTracks` and its `cells`
  reused by the position pass, so — the fourth application of the shared-resolver lesson — the
  hugged grid size and its laid-out cells cannot drift (pinned by an explicit hug == cells test).
  The row COUNT is DERIVED (a `rowSpan` grows the grid past `ceil(n/cols)`); a spanning cell
  covers its tracks + internal gaps; a spanning item does NOT drive `auto` sizing (CSS's first
  pass — a documented simplification). `colSpan` is clamped to the column count — **load-bearing:
  mutation testing proved an un-clamped `colSpan > cols` loops FOREVER** (the block never fits) —
  and spans are validated as integers in `[1, GRID_SPAN_MAX]`. All eight guards mutation-tested and
  killed; the fuzz now emits spans and holds `incremental === full`. An adversarial read-only review
  then found a real OOM the fuzz and units both missed: the occupancy set is `Σ colSpan·rowSpan`,
  NOT the row count, so a *validated* grid (unbounded column count × many wide-spanning children)
  blew the runtime `Set` cap — a hard `RangeError` near ~17 items. Fixed by capping the column count
  (validation) and the derived row count (placement, piling overflow into the last band), bounding
  the occupancy to `GRID_MAX_TRACKS²`; a regression test throws without the cap. My original
  "the span cap bounds the row count against OOM" reasoning was simply wrong — the review earned its
  keep. DEFERRED (own weight): explicit line-based placement (`grid-column: 2 / 4`), dense packing,
  column auto-flow.
- **Flex wrap — multi-line flow + per-line flex + cross-hug.** A design panel (2 lenses
  converged) settled it around one shared `breakFlexLines` (the flex analogue of
  `resolveGridTracks`), called by BOTH the position pass and the measure cross-hug fold — so a
  cross-hug wrap container's own size equals the stack it lays out, the fuzz-blind property
  pinned by an explicit `cross-hug == Σ line heights` test. A new line starts when the next
  child would overflow the inner main (strict `>`; first-child-always-fits); each line flexes
  its OWN grow/shrink; a single line still fills the container cross (nowrap byte-identical).
  Wrap is inert under a hugged main axis, and — the subtle consistency guard — both passes
  break against the container's OWN (measured) main, so a parent that grows/stretches it wider
  never splits measure from position (that extra space is a documented deferral). All nine
  guards mutation-tested and killed; the 300-op fuzz now emits `wrap` and holds
  `incremental === full`. An adversarial read-only review then found a real bug the fuzz and
  units both missed: the position-pass measured-main override was gated on `wrap` rather than
  `effectiveWrap`, so a hug-MAIN wrap container that a parent GREW was laid out against its
  un-grown intrinsic main — starving its grow children (240 → 60). Fixed (gate on
  `effectiveWrap`) with a proven regression test. DEFERRED (own weight): align-content,
  wrap-reverse, a separate cross-gap, wrapping against a stretched main.
- **Grid measure-integration — `auto` tracks + grid-container hug.** The hard half of the
  grid tail, resolved by a design panel (3 independent lenses converged): grid finally enters
  the bottom-up measure pass, the way flex hug does. An `auto` `TrackSize` (`{ auto: true }`,
  chosen over the string `"auto"` because `"px" in "auto"` throws in the must-never-throw
  measure path) sizes a track to the **max measured own-size** of the children flowed into it;
  `LayoutGrid.hugWidth/hugHeight` sizes the grid's own axis to `2·pad + Σtracks + gaps`. The
  keystone is ONE shared `resolveGridTracks` called by BOTH the measure fold (hug size) and
  the position pass (cells) off the SAME measured sizes — so a hugged grid's own size equals
  the sum of its cells *by construction*, the exact property the `incremental === full` fuzz
  is structurally blind to (a grid opens no dirty ripple, so both compute paths would be wrong
  together). It stays acyclic (reads children's PRE-fill own-sizes, never their filled cells)
  and total; `fr` collapses to 0 on a hugged axis; `containerHugs` gains a grid arm so a
  grid-child resize ripples up a hugging chain. All eleven guards mutation-tested and killed —
  including the fuzz-blind `hug-size == sum-of-cells` and the `containerHugs` climb; two
  independent adversarial read-only reviews verified it. DEFERRED (own weight): explicit
  placement / spans, `minmax()`/`fit-content`.
- **Constraints / anchors — the responsive model.** A child of a **plain** (non-flex/grid)
  parent pins to the parent's edges (`Layout.constraints`: left/right/left-right/center/
  scale × top/bottom/top-bottom/center/scale) and repositions when the parent resizes.
  The stateless engine resolves this against a **frozen per-child reference**
  (`constraintRef`, captured once at opt-in) rather than a resize delta — so `offset =
  parentComputed − constraintRef` responds to BOTH a direct resize (stored moves, ref
  frozen) AND a layout-driven one (a grown/stretched/celled frame's computed moves, ref
  frozen): the responsive cascade. Pure top-down — **no measure feedback, no
  `expandDirtyForLayout` change** — a parent size change dirties the parent and the child
  inherits. A design panel resolved the reference-size tension (per-child frozen ref beats
  per-parent, which would jump siblings); mutation testing found the defensive
  container-gate was untested and added a damaged-tree pin. *Known limitation, deferred to
  the M5 tool layer: editing a constrained child while its parent is off-reference writes
  geometry in the wrong frame — the re-baseline is not built.*
- **A full document citizen.** `UpdateNodeLayoutAction` is the write-path primitive
  (authorable, undoable, serializable, validated), exactly as `UpdateNodeTransformAction`
  is for M1. `layoutError` is shared by the edit path and the load path (a non-boolean
  `hugWidth`, or a negative `grow`, is rejected identically), so round-trip closure holds:
  a hand-edited layout the loader would reject is one the editor could never author.
- **Out-of-flow escapes + margins — the small tail wins.** `Layout.position: "absolute"`
  removes a child from its flex/grid parent's flow (no slot/cell, excluded from hug size and
  grow free-space), positioning it by stored geometry + constraints against the parent box —
  so the constraint gate admits an absolute child of any parent and `MoveTool` leaves it
  draggable. `Layout.margin` (uniform) is flex-flow spacing, folded into grow free-space and
  the hug measure. Both reuse the existing machinery (no new dirty-tracking); all five new
  guards were mutation-tested and killed.
- **Direct-manipulation honesty.** A laid-out child has no meaningful free-drag, so
  `MoveTool` skips it (reorder-by-drag is M4). *(Known UI refinement, deferred to the tools
  milestone: a resize handle on a hug container's hugged axis is a visual no-op — the
  engine correctly ignores the pending resize — but the handle is not yet hidden.)*
- **Schema cost, paid under the freeze rule.** `SCHEMA_VERSION` `"2"` → `"3"` (auto-layout)
  → `"4"` (hug) → `"5"` (grow) → `"6"` (grid) → `"7"` (constraints) → `"8"` (absolute +
  margin) → `"9"` (shrink) → `"10"` (grid per-row `rows`) → `"11"` (grid `auto` tracks +
  hug) → `"12"` (flex wrap) → `"13"` (grid spans) → `"14"` (per-side/grid margins) → `"15"`
  (align-content + auto-flow + line placement), each with a pass-through migration, because an
  older build would draw the children at now-vestigial stored geometry / unanchored / in-flow /
  unshrunk / at a uniform row height / not sized to content / on one overflowing line / one cell
  each / with a uniform (or ignored) margin / mis-distributed lines / the wrong flow / a mis-placed pin.

**Deferred (advanced/edge features and cross-milestone concerns — NOT core-layout gaps):**
`minmax()`/`fit-content` track sizing (a genuine iterative track-sizing algorithm) ·
single-axis explicit placement · a separate cross-gap · responsive / breakpoint rules (→ M5) ·
drag-to-reorder (→ M4) · the constrained-child **re-baseline** (off-reference edits, → M5 tool
layer).

**Explicitly NOT in scope yet:** `ComputedState` still carries geometry only; resolved
style (M5 tokens) is still absent. Layout output is expressed *as* geometry (computed
local rects), not as a separate channel.

---

## Phase 3 — Rendering Pipeline

### Milestone 3 — Renderer ✅
Build the renderer for real. **SVG renderer:** rectangles · ellipses · lines · paths ·
text · images. **Canvas/WebGL renderer:** large scenes · shadows · blur · massive
documents. **The renderer only reads `ComputedState`.**

**Done (schema 18):** a pure `buildRenderModel → DisplayList` + thin `emitSVG`/`emitCanvas` backends.
The SVG renderer is complete — rect/ellipse/line/path/text/image, viewport culling, drop shadow +
gaussian blur — over a node-tested model. The Canvas backend (`emitCanvas`) is a complete, recording-
mock-tested second emitter over the same list. Wiring canvas as the live *editing* backend (needs
DOM-free resize-handle picking) and richer effects (multiple/inner shadows, blend modes) are M4/future,
not the renderer. See the slice notes below.

**Landed (slice 1 — render-model extraction, no behavior change):** the renderer is now
a pure `buildRenderModel(size, doc, state) → DisplayList` (all draw decisions: content
shapes, resolved paint, world placement, overlay outlines/handles/preview, grid `sig` +
by-reference reuse) plus a thin `emitSVG` backend that only transcribes the list to DOM.
This is the renderer's first automated coverage — the `DisplayList` is asserted on plain
data in the `node` env exactly like the layout engine, and the extraction was verified
**byte-identical** to the previous renderer via a differential DOM oracle over a battery
of content/overlay/grid cases. `renderSVG` stays the app entry point (measures the
container, threads the previous list so the grid cache survives), so `App.tsx` is
unchanged. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) §1 and
[API-CONTRACTS.md](docs/API-CONTRACTS.md) § Renderer.

**Landed (slice 2 — viewport culling):** `buildRenderModel` now drops any content item
whose world AABB (`c.bounds`) does not inclusively intersect the viewport's world-space
visible rect, so a large document only pays for what is on screen. Content-only — overlay
and grid are not culled (each bounds its own visible range). This is the first M3 slice
that is deliberately **not** byte-identical to the prior renderer (off-screen content
leaves the DOM); safety was pre-verified (hit-testing is DOM-free; the tool layer reads
`data-node-id`/`data-resize-handle` only on overlay handles; the flat per-node list means
an off-screen parent never drops an on-screen child), the cull rect shares the exact
screen→world definition `emitSVG` uses, and every guard is mutation-tested.

**Landed (slice 3 — `core.ellipse` + `core.line`, schema 16):** two new node types. The
document-layer work: `NODE_TYPES` + validation + serializer migration + a schema bump, and a
shared per-type `dimensionError` (used by the load path AND `AddNode`/`Resize`/`UpdateNodeGeometry`
so they cannot drift) — rect/ellipse/text/image need a positive box; a `core.line` is the box
DIAGONAL and may collapse ONE axis (a horizontal/vertical line), not both. Render side (trivial as
predicted): an `ellipse` Shape (fills its box) and a `line` Shape (diagonal, colour = `stroke ?? fill`).
Every guard mutation-tested (11 mutations, all killed). Deferred: a settable line width (hairline `1/z`
for now) and "/" orientation (via a flip transform). (A follow-up added a `hitTest` **pick tolerance** so
a zero-extent axis-aligned line is selectable — bbox hit-testing otherwise collapses to zero area.)

**Landed (slice 4 — `core.path`, schema 17):** an SVG path node storing **structured absolute**
commands (`Node.path?: PathCommand[]` = `M`/`L`/`C`/`Q`/`Z`), NOT a raw `d` string — so the render model
maps them directly (a pure, unit-tested `commandsToPathData` join feeds `emitSVG`; the structured form is
also canvas-ready) and a shared `pathError` (load path + future edit action) validates them field-by-field
with a `PATH_MAX_COMMANDS` OOM cap. The genuine SVG-`d` PARSER + relative→absolute/shorthand/arc normalizer
is **deferred to a future SVG-import feature** (where foreign-`d` ingestion actually belongs), keeping the
core type clean and fully validatable. `path?` is optional (absent = empty path, renders nothing) so generic
creation works; geometry stays the type-agnostic box (tight path bounds deferred). Every guard mutation-tested.

**Landed (slice 5 — Canvas backend):** `emitCanvas(ctx, model, dpr?)` — the immediate-mode twin
of `emitSVG` over the SAME `DisplayList` (grid + content + overlay). A dumb per-kind transcriber
that does NO coordinate arithmetic: it sets the viewport CTM once (DPR folded in — `setTransform`
resets the CTM) then brackets each content item in `save()`/`transform(world…6 raw numbers)`/
`restore()`, since `ctx.transform` post-multiplies (= V∘world = the SVG nesting), so the *canvas*
composes and no `Matrix.multiply` enters the backend. Verified by a **recording-mock
`CanvasRenderingContext2D`** (immediate-mode's output IS its call sequence — zero deps, runs in the
node suite; 16 tests, every branch mutation-tested); pixel-level SVG↔canvas parity stays a browser
smoke test. **Not wired into the app** — the resize-handle hit-test still reads the SVG overlay DOM,
so making canvas the live editing backend needs DOM-free handle picking (M4); this is the same
lower-layer-capability-predates-its-editor-affordance pattern as `ReparentNodeAction` (M0) and
`UpdateNodeTransformAction` (M1), and it ships WITH tests, not as a dead flag. First-pass gaps
(all documented as inherent SVG-vs-canvas rasterizer differences, deferred like text wrapping): text
WRAPPED greedily via measureText (was single-line at first); image is deferred (draws nothing — `drawImage`
needs a decoded bitmap); **opacity** is per-op `globalAlpha` not SVG *group* opacity, so a
translucent stroked shape shows a fill-tinted ≈1px hairline in the stroke's inner half (true group
opacity needs an offscreen layer); rounded-rect radius clamping differs from SVG for an over-large
radius; and the `renderCanvas` DOM shim (canvas sizing / `getContext` / DPR read) lands with the M4 wiring.

**Landed (slice 6 — effects, schema 18):** drop **shadow** (`Style.shadow` = dx/dy/blur/color) and
whole-node **blur** (`Style.blur`), resolved onto `Paint` (world units, both backends read them).
The decidable parts live in the PURE model, node-tested: a `effectFilterId(shadow, blur)` that is
deterministic + **injective** + SVG-id-safe (the twin of `commandsToPathData`), and a deduped
`DisplayList.defs`. emitSVG builds one `<filter>` (feGaussianBlur → feDropShadow) per def in a
cleared-each-frame `<defs>` and references it via `filter="url(#id)"`; emitCanvas sets
`ctx.shadowColor/Blur/Offset*` + `ctx.filter`, replaying the CTM's `z·dpr` scale (shadow* is
device-space — the one backend arithmetic exception). Validation extracted a **shared `styleError`**
(load path + `UpdateNodeStyleAction`), closing a pre-existing inline-duplication drift risk. Every
guard mutation-tested. An adversarial review caught two real bugs, both fixed: `hexColor`'s
`padStart(2)` broke injectivity for colours with code points > U+0100 (→ `padStart(4)`), and an effect
on a ZERO-EXTENT box (an axis-aligned line) collapsed SVG's `objectBoundingBox` filter region and hid
the element — so effects are now dropped in the model for a zero-area box (both backends agree).
Documented parity gaps (browser-smoke): canvas `shadowBlur` ≠ SVG stdDeviation, `ctx.filter` blur may
double-scale under zoom, combined blur→shadow chaining, canvas casts the shadow per fill/stroke op (like
the opacity gap), filter-region clip on extreme offsets.

**Remaining:** nothing in the renderer proper. The SVG renderer is complete (rect/ellipse/line/path/
text/image + culling + effects) and the Canvas backend exists and is tested. What's left is not M3:
wiring canvas as a live *editing* surface needs DOM-free resize-handle picking (M4 editor), and richer
effects (multiple shadows, inner shadow, blend modes) are future scope.

---

## Phase 4 — Editor

### Milestone 4 — Editor ✅ (all five planned slices landed; refinements deferred)
**Viewport:** pan · zoom · infinite canvas. **Selection:** click · multi-select ·
box select. **Manipulation:** drag · resize · rotate. **Guides:** snapping · alignment
guides · smart guides · rulers.

**Close-out:** slices 1–5 are done — pan/zoom, box-select, DOM-free resize/rotate handle picking, a live
SVG/Canvas backend selector, and alignment snapping + smart guides (move AND resize). The per-slice deferrals
have since been cleared: resize snapping, Escape-cancel-rotate, nested translation-only chains, canvas
hover-cursor, rulers, canvas images, **multi-select / group snapping + rotate** (below), canvas text
WRAPPING, and **group RESIZE for transform-free groups** — dragging a group corner scales every root
proportionally about the opposite corner (pure `scaleGroup` in `GroupTransform.ts`, world scale mapped 1:1
to stored for translation-only chains), previewed via `pendingGeometry`, committed as ONE transaction,
Escape drops the preview, extent clamped at 1 world unit (no flip — mirroring member positions while their
content stays unmirrored would misrepresent the gesture). Gated on `isGroupResizable` — STRICTER than
rotate: every root transform-free *including itself*, because a rotated member scaled non-uniformly is a
SHEAR the rotation+scale transform model cannot represent. That rotated-set case is the one PERMANENT limit
(inherent, not deferred). The core editor loop is complete and every interaction is DOM-free, so it runs
identically on both backends.

Already present from earlier prototypes: click + shift-multi-select (DOM-free `hitTest`), drag (`MoveTool`),
resize (`ToolController`, but DOM-`data-resize-handle`-based — the canvas-wiring blocker), delete, and
origin-anchored wheel zoom. Slice plan: **(1) pan/zoom** — pure `panBy`/`zoomAt` viewport math (node-tested)
+ cursor-anchored wheel zoom + space/middle-mouse pan; **(2) box-select** (marquee + hit-in-rect);
**(3) DOM-free handle hit-testing [3a] + rotate [3b] — DONE** (moved resize-handle picking off the SVG DOM —
unblocks canvas — and added the rotate affordance over `UpdateNodeTransformAction`); **(4) canvas wiring** (a
backend selector, now that handles are DOM-free) — **DONE**; **(5) snapping / alignment guides**.

**Landed (slice 1 — pan/zoom):** pure `panBy(vp, dx, dy)` + `zoomAt(vp, factor, cursorX, cursorY)` viewport
math in `EditorState` (node-tested like `clampViewport`); the wheel now zooms **cursor-anchored** (the world
point under the pointer stays fixed), and **space+drag / middle-mouse drag** pans (a `ToolController` mode
intercepting before the active tool, like resize). Screen-space pan (zoom-independent); both re-clamp.

**Landed (slice 2 — box-select):** a pure `nodesInRect(computed, rect)` query (world-bounds OVERLAP —
"touch", not containment — in draw order; DOM-free like `hitTest`) plus a `SelectTool` **marquee**: a drag
begun on empty space draws `EditorState.marqueeRect` (a world-space overlay, `role: "marquee"`) and selects
the touched nodes on release (**shift = additive**, `Set`-deduped); a click below a small pixel **threshold**
deselects, and **Escape** cancels an in-flight marquee. The threshold is load-bearing for ROTATED nodes:
`pick` rejects against the exact rotated shape but `nodesInRect` overlaps the (larger) world AABB, so without
it a 1px wobble in a rotated node's AABB-corner margin would select instead of deselect. A missed mouse-up
(release off-window) can't strand the gesture — a new mouse-down resets it and a move with no button held
abandons it. Picking never reads the DOM, so it composes with a future Canvas backend. *(All 14 findings from
an adversarial multi-agent review were addressed; the removed-then-restored threshold was the key catch.)*

**Landed (slice 3a — DOM-free handle picking, the last DOM dependency in the editor):** resize-handle
grabbing no longer reads `data-resize-handle`/`data-node-id` off the SVG. A shared pure
`selectionHandles(computed, selectedNodeIds)` (the four world-AABB corners per selected node) is the SINGLE
source of truth — the renderer draws from it and the editor hit-tests it via `handleAtPoint(…, sizeWorld)`
(`HANDLE_SIZE_PX/zoom`, back-to-front), so draw and pick can't drift. `ToolController.onMouseDown` now enters
resize from that hit-test, which also makes the corner-resize gesture node-testable for the first time (fake
events, no DOM). Extracted the one screen→world inverse into a shared `screenToWorld(vp, rect, x, y)` used by
`SelectTool` and `ToolController`. With select (`hitTest`), box-select (`nodesInRect`), and resize
(`handleAtPoint`) all DOM-free — and hover unwired — **nothing in the editor reads the SVG DOM**, so the
Canvas backend can now be wired as a live editing surface (slice 4). No schema change. Remaining in slice 3:
**3b — rotate** (a rotate handle + gesture over `UpdateNodeTransformAction`).

**Landed (slice 3b — rotate; slice 3 COMPLETE):** the shared `selectionHandles` now also emits a **rotate
knob** — a circle a fixed `ROTATE_OFFSET_PX` screen px above the box's top-centre (so `selectionHandles`/
`handleAtPoint` gained a `zoom` param; deriving both the grab size and the rotate offset in ONE place also
removed the last draw-vs-pick size-drift risk). Grabbing the knob spins the node about its **world-AABB centre**
(= the default centre transform-origin; correct even for nested/rotated nodes since a parallelogram's AABB is
centred on its centroid): the pointer's angle-delta about the centre is added to the node's existing rotation,
and each move **live-commits a coalesced `UpdateNodeTransformAction`** — live feedback, and a CONTINUOUS drag
coalesces into ONE undo step (reusing the existing `actionId:nodeId` coalescing rather than adding pending-
transform plumbing; like any slider drag, a >window pause mid-gesture splits it, and two flicks on the same node
within the window merge — inherent, acceptable). No schema change (rotation is the existing
`Node.transform.rotation`, schema 2). Deferred: a stalk line to the knob, ~~Escape-to-cancel-rotate~~ DONE (was: undo covers
it), group-rotate for multi-select, rotate about a non-centre origin, and the cosmetic knob-slide as a rotating
node's AABB grows/shrinks (the handles are AABB-based). This closes M4 slice 3; next is **slice 4 — canvas
wiring**, now unblocked.

**Landed (slice 4 — canvas wiring; the Canvas backend is now a LIVE editing surface):** a `renderScene(container,
doc, state, backend)` selector dispatches each frame to `renderSVG` or the new `renderCanvas` shim (sizes a
`<canvas>` for the device pixel ratio — model in CSS px, backing store in device px, DPR handed to `emitCanvas`).
On a backend switch it clears the container and drops the SVG grid cache (`clearRenderState`, exported for this),
so the swap is clean; `renderCanvas` also self-heals if it finds a foreign element. A toolbar **Backend: SVG/Canvas**
toggle drives it (App `backend` state). No schema change, no new unit tests (the shims are DOM plumbing over the
already-tested `emitCanvas` + `buildRenderModel`) — but **live browser smoke-verified end-to-end**: on the Canvas
backend the background, grid, a drawn rectangle (correct fill/position), and the selection outline + handles all
rasterize; drawing a node on canvas re-renders on canvas; toggling SVG↔Canvas swaps the element cleanly and the
node + selection persist. All picking being DOM-free (slice 3) is what makes the two backends interchangeable.
An adversarial review (3 confirmed, all low/medium, zero correctness bugs) prompted one fix — App now repaints on
container-resize / DPR-change (a `ResizeObserver` + a resolution media query), since the fixed-CSS-px canvas
(unlike the SVG root's `100%`) needs an explicit trigger to keep filling the pane / stay sharp (live-verified:
`renderCanvas` re-sizes to the new container at dpr 2.4, backing store = CSS × dpr). Deferred: inherent
canvas-vs-SVG rasterizer gaps from the emitCanvas slice (single-line text, image, group-opacity, per-op shadow),
plus a NEW canvas gap the review found — **per-region hover cursor** (`paint.cursor`): a resize/rotate handle
doesn't switch the pointer on canvas (one element, no per-region cursor), though the handles still FUNCTION
(DOM-free picking); wiring it needs a hover system the editor doesn't have yet. Next is **slice 5 — snapping /
alignment guides**.

**Landed (slice 5 — snapping + smart guides; M4 COMPLETE):** a pure `computeSnap(moving, targets, threshold)`
(`src/core/geometry/Snapping.ts`) — each axis exposes three snap lines (min edge, centre, max edge); it returns
the smallest in-threshold `{dx, dy}` that lands a moving line on a target line, plus the guide lines at every
resulting alignment (spans merged across targets). `MoveTool` folds it into the drag for a SINGLE top-level,
unrotated node (stored == world, so a world snap delta is also its stored delta): targets = other nodes' world
bounds captured once at mouse-down (its own subtree excluded), snap applied to the pending AND the committed
position, `EditorState.snapGuides` drawn by the renderer as thin world-space lines (`role: "guide"`). No schema
change. This closes Milestone 4.

**Follow-up (deferral addressed) — resize snapping:** the same snapping now applies to the RESIZE gesture. A
pure `snapPoint(px, py, targets, threshold)` snaps the DRAGGED corner (the fixed corner stays) to target
lines; `ToolController` folds it into a corner-resize of a single top-level unrotated node (the shared
`snapTargetsExcludingSubtree` + `guidesForRect` helpers, extracted from `MoveTool`), snapping the pending +
committed geometry and showing the same guides. Still deferred: artboard/grid snapping (the pure snap already
generalises to any rects — only the per-gesture tool wiring is scoped).

**Follow-up (deferral addressed) — group operations (multi-select snapping + rotate):** a multi-selection now
acts as ONE object. **Group move-snapping:** `MoveTool` snaps the *union* box of all moving roots
(`selectionBounds`) to alignment lines when EVERY root is a translation-only chain, applying the one world
delta to all (a single node is just a one-member group); targets exclude *every* moving subtree
(`snapTargetsExcludingSubtrees`); a member deleted mid-drag disables snapping so the survivors don't snap
against a stale box. **Group rotate:** for 2+ roots the overlay draws ONE group bounding box + a single rotate
knob (`groupRotateHandle`), and grabbing it rotates every root *rigidly* about the group-box centre — the pure
`rotateGroup` (in `src/core/geometry/GroupTransform.ts`) adds the drag's angle-delta to each root's rotation
AND orbits its centre about the pivot (`newX = startX + Δcentre`, valid because the parent chain is
translation-only and the origin is centre). It live-commits one **coalesced `TransactionAction`** (a geometry
+ transform update per root) per frame — so a continuous drag is ONE undo — keyed gesture-specifically
(`rotate-group:<sorted ids>`) via a small `coalesceKey` extension that keys a transaction by its name.
**Escape** reverts the visible state (a `rotateGroup(delta 0)` coalesced into the same run; within the
coalesce window it nets to a no-op revision — a >window pause can leave the revert as its own undo step,
inherited from single-node rotate and left consistent with it). The knob shows only when the group is
*rotatable* (`isGroupRotatable`: every root centre-origin + translation-only parent chain + **not an in-flow
auto-layout child**, whose position the layout engine computes and whose orbit would therefore be discarded —
the same class `MoveTool` skips), so an ineligible group never offers a dead control. Multi-select no longer
offers per-node resize (only the group knob is grabbable). No schema change. Verified by node tests + a
10-mutant guard battery (all killed) + an adversarial multi-agent review (which caught the auto-layout-child
non-rigidity — now fixed — and confirmed the Escape/coalesce caveat above). Since addressed: **group
RESIZE** for transform-free groups (see the M4 close-out). Permanently out of scope: resizing a ROTATED set
(a non-uniform scale of a rotated box is a shear the transform model can't represent) and gestures on
rotated/scaled *parent* chains.

---

## Phase 5 — Variables & Design Tokens

### Milestone 5 — Variables ✅* (all three slices landed + schema-20 number tokens; layout-side spacing consumption deferred)
Global values: `Color.Primary`, `Spacing.Small`, `Radius.Medium`, `Typography.Body`.
**Support:** themes · light/dark mode · variable references · token inheritance.
(`VariableStore` and `Style.fill` token syntax `$color/primary` are already reserved.)

**Close-out:** the four support pillars are all live — a typed, validated, undoable variable
store (schema 19); light/dark **themes** with a persisted `activeTheme` and a toolbar toggle;
**variable references** (`$token` in every color slot, resolved in the render model on both
backends); **token inheritance** (alias chains through the active theme, cycle-safe). Since
the close-out, **number tokens became consumable too (schema 20)**: `Style.radius` and
`Style.fontSize` widened to `number | string` — a string must be a `$token` (arbitrary
strings rejected on both paths), resolved via `resolveNumber` in the render model with
range-checked fallbacks (broken/negative radius → no radius; broken/non-positive fontSize →
the 14 default). The remaining `*`: LAYOUT-side spacing tokens (`gap`/`padding`/margins) —
consuming them means threading the store through the entire must-never-throw measure pass,
deferred to the milestone that next touches the layout engine. Live-smoke-verified
end-to-end: a seeded token document renders the resolved light value, the theme toggle
re-resolves to the dark override (SVG attribute AND canvas pixel `#ff8800` at DPR 2.4), and
undo reverts the switch.

**Landed (slice 1 — the variable store; schema 18 → 19):** the reserved `variables` store is
now LIVE and typed (`src/core/document/Variables.ts`): a `Variable` is `{ type: "color" |
"spacing" | "font", value, modes? }` — color/font values are strings, spacing values NUMBERS,
and any value (base or per-theme override) may instead be an ALIAS `"$other/key"` (token
inheritance). The document gains a persisted **`activeTheme`** ("light"/"dark"); resolution
(`resolveVariable`/`resolveColor`/`resolveNumber`) is pure, follows alias chains through the
active theme at every hop with a seen-set, and maps a cycle / dangling target / wrong-typed
target to the visible `#ff006e` fallback — never a throw, and aliases are NOT required to
resolve at rest (deleting a variable can't corrupt a document). Validation
(`variableStoreError`, keys capped, `VARIABLES_MAX` OOM guard) is shared by the load path
(`Integrity`) and the coming edit actions. `migrate_18_to_19` is the chain's first migration
with CONTENT: it stamps `activeTheme` and SANITIZES the never-before-validated legacy store
(numeric-string spacing coerced, unvalidatable entries dropped) so every previously-loadable
file stays loadable. `activeTheme` threads through the serialize envelope, history
snapshots/hydration, and transaction clones.

**Landed (slice 2 — the token write path):** `SetVariableAction` (upsert) /
`DeleteVariableAction` / `SetActiveThemeAction` — all emitting a new DOCUMENT-level delta
kind `{ kind: "variables", variables, activeTheme }` under the reserved
`DOCUMENT_DELTA_KEY` ("__document__"), since the delta map is keyed by node id and
doc-level state has none. The delta is whole-state, so transactions compose LAST-WINS
safely (each component action builds its delta from the working document at execute time —
"set a, alias b to a, switch theme" in one transaction nets all three, and one undo
restores store + theme together). Validation delegates to the shared `variableStoreError`
(the edit path can never author what the loader rejects); deleting an aliased/referenced
variable is allowed by design (dangling refs resolve to the fallback). `updatedNodeIds`
stays empty — no node changes, the geometry dirty-tracker is untouched.

**Landed (slice 3 — renderer consumption + theme UI; M5 CLOSE-OUT):** every COLOR slot in
`buildRenderModel` (fill, stroke, `shadow.color`, the line's raw-first `stroke||fill`
fallback) resolves `$token` references via `resolveColor(doc.variables, raw,
doc.activeTheme)` — in the MODEL, so both backends agree by construction, presence checks
stay on the raw style values (a token string is truthy), and the deduped SVG filter defs key
on RESOLVED colors (two tokens resolving to one color share one `<filter>`). A broken
reference renders the loud fallback magenta; the unknown-node-type debug fill stays literal.
The toolbar gains a **Theme: Light/Dark** toggle dispatching `SetActiveThemeAction` — a
normal undoable action, so a theme switch repaints through the ordinary dispatch → refresh
path and undo restores the previous theme.

**M5 adversarial review (post-close-out fixes):** a multi-agent review over the whole
milestone confirmed three defect families, all fixed + mutation-verified: (1)
**prototype-machinery variable keys** — `store["__proto__"] = def` fires the prototype
SETTER, so `SetVariableAction` silently no-oped while a hand-edited file could carry the key
as an own property (an edit/load asymmetry); keys `__proto__`/`constructor`/`prototype` are
now RESERVED in the shared `variableKeyError` (rejected on load, pre-checked by the action
BEFORE building its candidate store — store-level validation alone cannot see a swallowed
assignment), and the 18→19 sanitizer drops them; (2) **the migration ignored
`VARIABLES_MAX`** — an over-cap legacy store passed migration untouched and then failed the
schema-19 validation the migration exists to satisfy; it now truncates to the first 10 000
entries; (3) **the `"__document__"` delta sentinel collided with node-id space** — a real
node with that id (constructible via `AddNodeAction`'s explicit id or a hand-edited file)
would have its transaction edits overwritten by a doc delta, and `TransactionAction` leaked
the sentinel into `updatedNodeIds` (seeding the geometry dirty-tracker with a ghost); the id
is now `RESERVED_NODE_ID` (rejected by AddNodeAction + Integrity) and the sentinel is
excluded from `updatedNodeIds`.

---

## Phase 6 — Components

### Milestone 6 — Components 🚧 (slices 1–2 landed: masters + instances + overrides, schema 22)
Reusable objects: components · instances · overrides · nested components · slots ·
variants. Similar to Figma Components.

**Landed (slice 1 — masters, instances, resolution; schema 20 → 21):** a component **master**
is an ordinary node subtree in the document (like a Figma component on the canvas) — the
design fork resolved in favour of NO new storage, so masters inherit every existing mechanism:
validation, geometry, layout, serialization, actions, editing. An **instance** is a
`core.instance` node carrying `componentId` (the master's node id), drawing nothing itself and
holding **no children in the stored document**.

The whole feature rests on one pure function: `expandInstances(doc)`
(`src/core/document/Components.ts`) materializes each instance's master subtree as VIRTUAL
children and returns a DERIVED document — never persisted, never mutated, never seen by an
Action. `computeGeometry` runs it FIRST, so layout, transforms, culling, hit-testing and BOTH
render backends work on an ordinary tree with zero special cases; the materialized master root
is re-origined to (0,0) so the instance's own geometry places the copy. Because nothing is
copied into the document, **editing a master updates every instance on the next frame**.

Virtual ids are `<instance path>::<master node id>` — stable, unique, and REVERSIBLE
(`splitVirtualId` recovers the owning instance + the master node, which per-child overrides
will key on). `::` is therefore RESERVED in stored node ids, rejected on BOTH paths via a
shared `nodeIdError` (the `RESERVED_NODE_ID` discipline). Virtual nodes are NOT selectable in
this slice — `hitTest`/`nodesInRect` skip them, so clicking instance content selects the
instance; per-child picking arrives with overrides.

Recursion is the hazard the module exists to bound (a master containing an instance of itself,
a cycle through several masters, and nested instances that MULTIPLY rather than add). Three
guards in the `GRID_MAX_TRACKS` tradition: a per-path master **chain** (a cycle stops
expanding), `INSTANCE_MAX_DEPTH` (nesting), and `INSTANCE_MAX_NODES` (total materialized — the
BREADTH guard depth cannot provide). A stopped expansion draws nothing; it never throws. A
**dangling** `componentId` is valid at rest and draws nothing, so deleting a master can never
make a document unloadable — the rule dangling `$token` aliases already follow.
`CreateInstanceAction` (+ a toolbar ⧉ Instance button) is the write path; it requires a real,
non-instance master at creation time.

**Review + live-smoke fixes (same slice):** a live browser smoke-test caught the central
integration bug the unit tests could not — `buildRenderModel` resolved node data from the
STORED document while `ComputedState` now holds virtual ids, so **instances drew nothing on
both backends**. The model now resolves against the same expanded view (and a RenderModel test
pins it). A 33-agent adversarial review then confirmed four more: an instance **snapped to its
own materialized copies** (they are not in its stored `children`, so the subtree walk missed
them — a coincident target that pinned every sub-threshold drag; fixed with a shared
`ownerInstanceOf`); the materialized root **inherited the master's constraints**, which
described a parent the copy no longer has and overrode the (0,0) re-origin (root copies now
drop `constraints`/`constraintRef`, deeper copies keep theirs); a **line/flat-path master could
never be instanced** (`dimensionError` now treats `core.instance` like line/path); and the ⧉
button placed the instance using the master's **parent-relative** coordinates while parenting it
to the root (now uses world bounds). One more was structural: schema 21 reserves `::`
*retroactively*, so `migrate_20_to_21` — a pass-through for the new type/field — now also
**renames** stored ids containing `::` and rewrites every reference (keys, `id`, `parent`,
`children`, `rootNodeUuids`, `componentId`), honouring the standing rule that a
previously-loadable file must stay loadable.

**Landed (slice 2 — per-instance OVERRIDES; schema 21 → 22):** an instance may now differ from
its master. `Node.overrides` maps a MASTER NODE ID to an `InstanceOverride`
(`geometry`/`style`/`text`/`src`), applied during expansion at each level — so a nested
instance applies the overrides it carries from the master. Keying by IDENTITY rather than
position is what makes an override survive edits to the master and go INERT (never invalid)
when that master node is deleted — the dangling-reference rule the token layer established.
Each field is validated by the SAME rule its stored counterpart obeys (`styleError`, finite
geometry), so an override can never hold a value the node itself could not;
`INSTANCE_MAX_OVERRIDES` caps the map. A ROOT override may resize the copy but never move it
(its position IS the instance's geometry). `SetInstanceOverrideAction` is the write path:
patches MERGE field-by-field (a move then a resize accumulate), and `null` clears an entry —
"reset to master".

The editor half is a single routing seam. `nodeEdit`'s `geometryActionFor`/`styleActionFor`
turn an edit on a VIRTUAL id into an override and an edit on a stored id into a direct action,
so MoveTool and the resize commit each call one factory rather than learning about virtual ids
— a missed site would otherwise dispatch an action that fails validation and looks like an edit
that silently did nothing. **ALT-click** deep-picks a copy (`hitTest`'s `includeVirtual`); a
plain click still selects the instance, and a marquee never scatters into instance internals.
A copy shows its four RESIZE corners but NOT the rotate knob — transform overrides are a later
slice, and the renderer and the picker refuse it identically, so no dead control appears.

Deferred to later slices: **variants/slots**, "detach instance", `layout`/`transform`
overrides, overriding THROUGH a nested instance (the outer instance changing a node inside an
inner one — `overrideTargetFor` refuses it rather than mis-target), instance content that
overflows the instance box being unpickable (the pick box is the instance's own), and
incremental dirty-tracking reuse for instanced documents (the dirty set names stored ids, not
the virtual copies a master edit changes, so instanced documents recompute fully — always
correct, just not incremental).

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
