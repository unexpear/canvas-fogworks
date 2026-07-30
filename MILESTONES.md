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
M2  Layout Engine            ✅   flex(grow/shrink/wrap/align-content) + hug + grid(rows/auto/hug/spans/flow/pins) + constraints + absolute; minmax/fit-content deferred
      │
M3  Renderer                 ✅   SVG renderer (shapes + culling + effects) + Canvas backend (tested); canvas wiring → M4
      │
M4  Editor                   ✅*  pan/zoom + box-select + DOM-free handles + rotate + canvas wiring + snapping/guides
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
is single-line `fillText` (no HTML wrapping/metrics); image is deferred (draws nothing — `drawImage`
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
SVG/Canvas backend selector, and alignment snapping + smart guides. Deferred refinements (documented at each
slice): resize-snapping and multi-select/group snapping + rotate (snapping is move-only, single top-level
unrotated node); Escape-to-cancel-rotate; the canvas per-region hover cursor and text/image rasterization;
rulers. The core editor loop is complete and every interaction is DOM-free, so it runs identically on both
backends.

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
`Node.transform.rotation`, schema 2). Deferred: a stalk line to the knob, Escape-to-cancel-rotate (undo covers
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
change. Deferred: resize-snapping, multi-select/group snapping, nested/rotated moving nodes, and artboard/grid
snapping (the pure `computeSnap` already generalises to any rects — only the tool wiring is scoped). This closes
Milestone 4.

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
