# MILESTONES.md — Canvas Fogworks

> The engine is built in **layers**, where each milestone proves **one new
> architectural capability** before the next begins. This is the canonical roadmap.
> Status reconciled **2026-09-05** against the shared animation-controller implementation and the 2026-08-21
> mutation-battery close-out; engine **v0.0.5**, schema **89**.

**2026-09-16 behavior graphs:** visual event/branch/action authoring and bounded shared 2D/3D
execution are delivered as the first ENG-04/Q06 graph slice. See [Behavior graphs](docs/BEHAVIOR-GRAPHS.md).
Historical milestone slice counts are unchanged.

**2026-09-19 graph follow-up:** simulation-time delays, bounded repeats, reusable project graphs,
saved continuations and editor breakpoint/step/trace debugging extend ENG-04/Q06. See the graph guide
for limits and verification; this does not complete the broader engine milestones.

**2026-09-05 production workflow extension:** save/recovery and relocation seams, multi-animation import coexistence, whole-canvas PNG, typed gameplay/audio, offline 2D game export, imported TRS/skin playback and opt-in oriented 3D contacts. This cross-cutting extension is tracked in [Production workflows](docs/PRODUCTION-WORK.md), not retroactively counted as a historical M18 slice.

**2026-09-07 shared-authoring follow-up:** bounded linked-level/image portability, five real writer-process crash checkpoints, staged 3D level asset hydration, an original pixel/component workshop and three-stage relay game, plus CPU/GPU/raster/component/mesh/reload measurements. Exact bounds and remaining production work are in [Production workflows](docs/PRODUCTION-WORK.md) and the machine-readable backlog. Historical slice totals are unchanged.
>
> **Seven rows below said ⬜ for capabilities that had shipped.** They said it for three weeks
> because this file declared no `describes:` directive: `check-doc-drift` named it, looked it
> up, found nothing and moved on without a word. Being skipped is indistinguishable from
> passing, which is now itself a reported condition.

<!-- describes: src/core, src/editor, src/renderer -->
<!-- re-read 2026-10-02: the 2D game package can carry an optional saveMigrations list. Milestone
     status and historical slice counts are unchanged. -->
<!-- re-read 2026-09-28: named-input Controls live under src/core and do not change milestone
     status or historical slice counts. Embedded 3D cues and screen-space text do not either.
     Shell source pins include FoldersDrawer.tsx.
     Exact history retention and SCALE-001 benchmark scenes do not change historical milestone status. Budgets stay in PRODUCTION-WORK.md. -->
<!-- re-read 2026-09-03: summary reconciled through schema 76 and the 3D production/runtime baseline. -->
<!-- re-read 2026-08-14 after M18 slice 9 (body-vs-body contact): the runtime section below is current, including the
     two things that went wrong and were kept — the reuse chain held across Stop, and my first
     claim about which key the game has to take from the editor. -->
<!-- re-read 2026-08-13 after schema 67: M11 said Aseprite was BUILT AND UNREACHABLE and that a
     tileset was not a thing the document holds. Both had stopped being true, one of them the same
     day. M13 records the multi-tileset export. -->

## Legend

`✅ done` · `🔒 frozen` (contract locked, see `/docs`) · `🚧 in progress` · `⬜ planned`

---

## Product Direction — Dual Track

Canvas Fogworks is intentionally **both** a general visual/pixel editor and a game-authoring
environment. Neither track is subordinate or temporary. They share one document model,
action/history system, renderer, asset pipeline, animation system and production gate:

- **Visual/pixel editing:** drawing, layout, components, typography, raster selection and
  transforms, grid-aware editing, import and export.
- **Game authoring:** tilemaps, typed entities, clips, runtime rules, level transitions,
  play flow and Tiled fidelity.

Work should strengthen the shared foundation when possible and keep track-specific UI or
runtime behavior behind explicit seams. AI, collaboration and a full plugin ecosystem remain
deferred until the shared production-hardening baseline is mature.

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
M6  Components                ✅   masters + instances + nested resolution + overrides + detach + variants + slots (schemas 21-29)
M7  States                    ✅   `Node.states` + `activeState` (schema 30, the first SANITIZING migration) + `SetStateAction`
M8  Animation Engine          ✅   timeline + keyframes + cubic-Bézier easing + HOLDS (cel) + onion skin — `Timeline` (407), `Bezier` (172), `Clips` (105)
M9  Interaction Graph         ✅*  `Node.interactions`: trigger → state, with duration/easing, plus NAVIGATE to a node (schema 36), and a Play mode that fires them. A state machine, not a node GRAPH — the name overpromises
M10 Drawing System            ✅   12 paint modules / 2,107 lines: buffer, patch, brush, stroke, fill, selection + outline, symmetry, palette, quantize, adjust, codec, surface space — with a Paint workspace and its tools
M11 Assets                    ✅*  Tiled, SVG, fonts, atlases, Unity packages, sheets, sequences and Aseprite imports are reachable; glTF/GLB imports and rehydration are live in the 3D workspace. OBJ remains parser-only. Named imported clips now reach preview and runtime controllers. See docs/FEATURE-AUDIT.md for format fidelity and remaining limits.
M12 Text Engine               ✅*  typesetting, wrapping and on-canvas editing, shared by all three backends and the exporter. ONE style per node — no per-run styling
M13 Export                    ✅*  SVG, Tiled `.tmx` (tile AND object layers, one `<tileset>` per distinct set with its own `firstgid`), sprite sheet (`sheet.json` + `sheet.png`). No PNG or PDF of the canvas
M14 AI Integration            ⬜
M15 Plugins                   🚧   sandboxed script worker + request-to-Action API + script panel landed; plugin packages/discovery/extensions remain
M16 Collaboration             ⬜
M17 Production Hardening      🚧   CI + semantic doc gate + full mutation battery + installer/startup/Open-Edit-Save smoke; autosave/crash recovery/full UI tiers remain
M18 Game Runtime              🚧   slices 1-41: fixed-step play, collision/camera/rules, spawning, pickups, animation poses, HUD, power tiers, pipes, restart/respawn, typed entities, confined level transitions and shared clip controllers
M19 3D Foundation             ✅*  schema 76: authored scenes, PBR/IBL/shadows, resilient WebGL, deterministic runtime and explicit 2D surfaces
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
committed geometry and showing the same guides. At that point artboard/grid snapping remained deferred
(the pure snap already generalised to any rects); the follow-up below closes the grid half.

**Follow-up (deferral addressed) — visible-grid snapping (2026-09-02):** `EditorGrid.visibleGridSize`
is now the one zoom/density rule used by both `RenderModel` and the move/resize gestures. Each axis
chooses the nearest in-threshold candidate from the visible grid and smart alignment lines; smart
guides win exact ties so guide feedback is stable. Move preview and commit share the same captured
grid step, and resize uses the same point rule. Rotated/scaled chains remain outside snapping's
translation-only scope.

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

### Milestone 6 — Components ✅ (planned scope landed; schemas 21–29)
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
A copy initially showed its four RESIZE corners but not the rotate knob; that was the slice-2
boundary, not the final M6 state.

**Landed after slice 2 (M6 close-out; schemas 23–29):** image-source validation was shared across
stored nodes and overrides (23–24); layout and transform overrides made copied content fully
editable, including rotation (26); variants and per-instance variant selection landed with
override remapping (27); override keys became nested master-node paths so an outer instance can
edit through an inner one (28); slots and per-instance slot content landed (29). Slice 3 added
`DetachInstanceAction`, which bakes exactly the materialized tree that was drawn while preserving
its parent position and z-order. The inspector and `nodeEdit` routing seam expose geometry, style,
content, layout and transform edits for virtual nodes, plus variant and slot controls. The stated
M6 deliverables — components, instances, overrides, nested components, variants, slots and detach —
are therefore complete. Full incremental dirty reuse for instanced documents remains a performance
refinement, not a missing component capability.

---

## Phase 7 — States

### Milestone 7 — States ✅
`Node.states` + `activeState` (schema 30), with `SetStateAction` and the toolbar switcher. Capture
stores a node's current look under a name; switching re-derives. It was the FIRST sanitizing
migration, which is the part worth remembering: a state holding a field the schema no longer allows
had to be cleaned on load rather than refused, or the file would not open.

---

## Phase 8 — Animation Engine

### Milestone 8 — Animation ✅
Timeline + keyframes + cubic-Bézier easing + HOLDS (cel) + onion skin — `Timeline` (407), `Bezier`
(172), `Clips` (105). **Animation did become another producer of `ComputedState`**, exactly as this
line planned: `applyFrame` takes the document and a time and hands back the document AT that time,
which the same derivation chain then resolves. NOT DONE from the original list: springs, and
physics — which is where a game RUNTIME starts rather than where animation ends.

---

## Phase 9 — Interaction Graph

### Milestone 9 — Interaction Graph ✅*
`Node.interactions` (schema 35): trigger → state, with duration and easing, plus NAVIGATE to a node
(schema 36), and a Play mode that fires them. **The name overpromises and the star is why**: this is
a state machine, not a node GRAPH — there is no canvas of wired boxes, and `Button Click → Open Menu
→ Wait 300ms → Fade Overlay → Navigate` is a chain this cannot express. What it can express is one
trigger choosing one state on one target.

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


---

## Phase 18 — Game Runtime

### Milestone 18 — Game Runtime 🚧 (slices 1–41 landed)
A 2D game that RUNS inside Canvas Fogworks rather than being exported to something else that runs it.

**The architecture was already there, in a shape nobody had used for this.** `applyFrame(doc, frame)`
takes the document and a moment and returns a NEW document showing that moment; everything below it
— layout, picking, culling, three backends — reads it without knowing time exists. `applyWorld` is
the same move for a different question. The run's mutable half lives on `EditorState`, beside
selection, under the rule that file already states: *"Runtime editor context. Never serialized."* A
game that wrote every body's position sixty times a second would put sixty entries a second on the
undo stack.

**Slice 1 is the TICK, not an entity model** — deliberately, and against a measurement. Of the 248
objects in the corpus only 24 carry a class, and the level's real collision geometry carries none at
all: six untyped rectangles on a `visible="0"` layer whose only property is `bodyType=static`, which
is also the single most-declared property in the tree (51 of 138). So the runtime reads
`userData.bodyType` — a field that already round-trips through import and export and had **no reader
anywhere** until now — rather than a `core.entity` invented ahead of any content.

What landed: `core/runtime/World` — a fixed 1/60s step with a carried accumulator and a spiral cap,
gravity, axis-separated AABB collision against static bodies, and `onGround`. Play builds the world,
Stop throws it away, and the document is never touched.

**Measured, because the design turned on it.** `resolveScene` is ~0.002ms and `computeGeometry`
~2.2µs/node, so a real map — five nodes holding 10,618 cells — costs **0.04ms a frame**, 0.3% of a
60Hz budget, while 5,000 separate nodes costs 22ms and blows it. A tick moves a handful of bodies, so
play mode now KEEPS the incremental geometry path it used to forfeit (4.5x: 4.6ms → 1.2ms).

**Verified live**: a crate falls 590/596/602 ms across three runs against a hand-computed 589 ms,
lands exactly on the floor's top, and Stop puts it back where the document says it is.

**Slice 2 — INPUT, so the loop closes.** Left/right is a SET speed rather than an acceleration (a
platformer's walk is a speed you have while the key is down, and losing it the moment you let go is
what makes the character feel attached to the button); a jump is stated as a HEIGHT and its launch
speed derived, `v = sqrt(2gh)`, so changing gravity keeps the jump clearing the same wall. The press
is an EDGE — holding it is one jump, not a bounce — which needs `jumpWas` on the world, because the
app produces one input per frame while the world may take several steps from it.

A terminal velocity arrived here too, and it is a COLLISION bound before it is a feel decision:
capped at 1200 px/s the travel is 20px a step, so slice 1's "as deep as the fastest body's travel"
becomes the constant **"any solid 20px or deeper is safe"**.

**WHICH BODY YOU DRIVE comes from the SELECTION** when Play was pressed. Nothing in the corpus says
which object is the player — 216 of 248 carry no class — so a property for it would be schema
invented ahead of content. Driving the selection is how a level gets tested, and a real convention
can replace it the day real content declares one.

**While playing the keyboard is the game's**, and the collision is real: an arrow is `Nudge by 1`,
which dispatches a `TransactionAction` and EDITS THE DOCUMENT. Verified both ways — five presses
while stopped moved the crate 268 → 273, and the same key while playing walked the body 132px in
600ms (220 px/s, exactly) and left the document alone.

**Slice 3 — PER-TILE COLLISION, which is what makes a level a level.** Until it, solids came from
whole nodes, and a `core.tilemap` is ONE node holding ten thousand cells — so a level was either
entirely solid or entirely not. A tile's own answer comes from `TilesetTile.userData`, the third
field this project has found that shipped validated, round-tripping and READ BY NOTHING.

THE BROADPHASE IS THE DESIGN. A solid per cell would build an array of thousands every step; asking
which cells a BOX covers turns that into the four or six a body can touch, through the same
`visibleCells` the renderer culls with — one statement of "which cells does this rectangle cover",
not two. Measured on a real 10,618-cell map with every sheet tile solid: **0.0285 ms a step for one
body**, 0.79 ms for fifty, 6 microseconds for one box query. The cost scales with BODIES, not with
the level.

Verified live: a crate lands on the tile floor at exactly the row's top, walks across four cell
seams at constant height, and falls through a one-cell hole at precisely the screen x that hole
occupies.

**Slice 4 — SURFACE FRICTION, and the measurement chose it.** `friction` is the corpus's second
most-declared property (45) and **44 of the 45 sit on STATIC objects**: it describes what you are
standing on, not what you are. Applied as Coulomb — `a = mu * g` — so the slice brought no new
constant, and the distances belong to the model rather than to taste: at mu=1 a body walking at 220
px/s slides 26.9px before stopping, at 0.45 (the corpus's one other value, on the block a player
pushes) 59.8px, and at 0 it never stops.

**`floating` WAS MEASURED AND NOT IMPLEMENTED.** It is the third most-declared property (24) and
every one of its 24 objects is STATIC — a body that never moves cannot be exempted from a gravity
that never touches it. Whatever sticker-knight means by it, this data cannot say, and a guess
dressed as a feature is worse than the gap. `density`, declared by one object in the whole tree,
likewise.

Friction also corrected slice 2: releasing a key used to SET the speed to zero, which made friction
meaningless for the one body a player drives — no slide on ice, and no air control, because letting
go mid-jump killed the flight. Releasing now hands the body back to the surface.

**Slice 5 — REGIONS, and the corpus defined the rule.** 26 objects carry a class and no `bodyType`
— coin, spikes, exit, Trigger, Location, NPC, Sign — and 51 carry a `bodyType` and no class, which
is the collision geometry. **Not one carries both.** So a region is a classed node that is not a
body, read from the data rather than imposed on it, and `Node.className` becomes the second
carried-but-unread field this runtime has put to work.

**THE WORLD REPORTS, IT DOES NOT ACT.** An overlap becomes an `enter`/`leave` event naming the region
and its class — and that is all of it. Nothing spawns a maggot, runs `chest-discovered.lua` or loads
`sandbox2.json`; each is a separate decision about what an APP does with an event, and welding any
of them into the physics would make all three undesignable.

Enter and leave are EDGES, not states — a coin is collected once, not on all sixty frames a player
stands inside it — and leaving survives the region being deleted under the body, or a counter drifts
up by one every time something is collected. Verified live to the status line: "enter coin" as the
crate falls in, "leave coin" as it walks out.

**Slice 6 — WORLD SPACE, which was a defect and not a feature.** A node's `geometry` is stated in
its PARENT's space; the runtime read it as the world's. A floor stored at (10,200) inside a frame at
(100,50) really sits at (110,250) and was collided against at (10,200) — a body dropped over that
floor's ART landed on a phantom fifty pixels above it. The header had called this a hypothetical for
a transformed parent; it was neither hypothetical nor about transforms, and **the Tiled importer puts
every object of an object layer inside a frame**, which is exactly how the corpus's own collision
geometry arrives.

Ancestor TRANSLATIONS are composed, which is exact and covers the case that occurs. A rotated or
scaled ancestor, an auto-layout container (where a stored x/y is dead data), a missing parent and a
cycle are all REFUSED rather than approximated — `runtimeExclusions` names each and why, because
half-composing would put the art in one place and its collision in another, which is the defect this
replaced.

Every fixture in the runtime's test file had been a FLAT document — all roots, where stored space and
world space are the same thing. That is the purest way to be blind to this, and it is why the new
ones nest two levels deep.

**Slice 7 — ONE-WAY PLATFORMS, and the first INVENTION here rather than a reading.** The corpus's
vocabulary was spent, so this is a choice, said plainly: `bodyType=oneway` is solid only from above
and only to a body that was above it when the step began. A new VALUE on an existing field rather
than a new field, because an unknown word is already not a body — a level written before this
behaves identically, and a typo becomes decoration rather than a wall.

Two fixtures were wrong before they were right, and both are recorded: the "jumps up through it"
test jumped from ON TOP of the platform, where a body starts on the surface and moves away so the
rule is never asked; and the surviving mutant turned out to be EQUIVALENT rather than a gap — `vy>0`
is implied by "was above", so the term was deleted rather than tested around.

**Slice 8 — THE CAMERA, without which none of the above is playable.** The corpus's levels are
1600x1600 and the probe level 3000 wide; on a 606px canvas a character walks off screen in under
three seconds, so every slice before this was verifiable only in a viewport that happened to contain
the whole level.

`core/runtime/Camera` is a separate module from `World` and takes a viewport rather than a world:
**nothing in the physics may read the camera**, or a level would play differently depending on where
you were looking, which is precisely what a fixed step exists to prevent.

**A DEADZONE, NOT A LEASH.** Pinning the target to the screen centre means every footstep moves the
entire world, which reads as the scenery walking rather than the character — the character being the
one thing on screen that never moves. So the camera does nothing at all while the target is inside a
centred window, and only pushes when the target reaches its edge.

**SMOOTHING IS PER FIXED STEP**, for the same reason the physics is: closing a fixed fraction per
FRAME is a different camera on a 144Hz monitor than a 60Hz one, the same class of defect as a
frame-rate-dependent jump and much harder to notice, since nobody can say what the right answer
looked like. Folding it `1 - (1-k)^n` makes five steps of 0.18 equal one step of 0.62926, always.
Bounds are applied AFTER the smoothing, so the view cannot leave the level part-way through a glide
— clamping the destination instead is right only while the camera is already inside, which it is not
on the first frame of a run begun with the canvas scrolled away.

**Two recorded defects turned out to be already fixed, and the memory saying otherwise was the
defect.** `lerpViewport`'s origin drift and a missing `worldToScreen` were re-measured before being
acted on: drift is now 0.000px at x = 0, 1000 AND 5000 (it was 0/84/418), and the round trip is
exact to 1.4e-14. A note naming a bug has to be re-measured, not quoted.

**One of this slice's own fixtures was blind and is recorded as such.** The `steps > 0` guard test
passed a null bounds, where every case returns the start position through the ordinary path too — so
deleting the guard outright changed nothing. Moved outside a 1600-wide level, it pins to 800 instead.

Verified live, and the first probe was blind too: tracking markers by a shared fill read as "the
camera barely moved", because viewport culling drops an off-screen node from the SVG and the probe
silently switched to the NEXT marker each time one scrolled away. With a colour per marker the
viewport is recoverable from the picture itself (every marker agrees to 1.1e-13 px, so it really is
one transform): the crate walks world 60 -> 280 with the viewport at exactly **0**, reaches the
deadzone edge at world 390, and from then on its SCREEN x is pinned at 399 while its world x runs to
940 and the viewport climbs to 541. The settled 399 is the predicted one — a target moving 3.667px a
step against an 18%-a-step camera settles 16.7px past the 382.02 edge. Stop puts the view back.

**Slice 9 — BODY MEETS BODY, and the measurement said NOT TO BUILD IT.** That is recorded first
because it is the most useful thing this slice produced. Counted across the same 97 Tiled files
every other rule here was read from: **ONE** object declares `bodyType=dynamic`, and it lives in
`templates/block.tx`, which `TiledMap.ts:644` refuses to import — so **zero** dynamic bodies reach
the runtime from the corpus, and not one of the 248 placed objects is dynamic. The nearest declared
pair sits **654px apart** on different tiers and never touches in any map. Twenty-four
contact-vocabulary stems — damage, health, hp, bounce, restitution, stomp, kill, hurt, pushable,
mass, weight, hit, attack, collide, impulse, force, kinematic, knockback, squash and five more —
return **zero** across all 65 files.

By this milestone's own published scale that is BELOW `density` (refused at one declaration) and
below `floating` (refused at twenty-four). **So it ships LABELLED an invention, and a larger one
than `oneway`** — whose justification does not transfer: that was a new VALUE on a field that
already had a reader, leaving every prior document bit-identical. This is a mechanism for a
situation the corpus never declares. It is here because the **stated test game** needs it: an
authored enemy must fall off a ledge, so it must be a dynamic body, and a Region cannot move.

**AND THE OBVIOUS MOTIVATION WAS FALSE AGAINST THE DATA.** "Stomping an enemy is two dynamic bodies
meeting" is not true of this corpus: every blob (x2), enemy (x1), NPC (x2) and spike (x4) carries a
class and NO `bodyType`, and so does the hero — his whole template is
`<object name="hero" type="hero" gid="22" width="128" height="160"/>`. Under slice 5's rule all nine
are already REGIONS and a stomp is already an `enter blob` event. **That is why `side` was added to
enter/leave in the same commit:** that half is measured and serves content that exists today, while
the pair pass serves content that does not.

**IT REPORTS AND IT DOES NOT RESOLVE, and the refusal is the design.** Making bodies solid to each
other was written out in full and rejected on three concrete failures, each reachable with ordinary
level geometry: (1) neither resolution loop breaks and both re-read the mutated velocity, so a body
landing on a floor while overlapping a crate takes the crate's `else` branch, is driven INTO the
floor, and is ejected the solid's full width by the next step's horizontal pass; (2) the same shove
puts a body's top at a one-way platform's top, where slice 7's `was.y + h <= s.y` correctly refuses
it *forever* and the body leaves the level; (3) the tunnelling guarantee — "any solid 20px or deeper
is safe" — is a fact about SOLIDS, which the corpus makes 32px and up, while two 10px bodies give a
margin of **exactly zero**, exactly hittable because every position here is a dyadic rational.

**`side` SAYS WHERE THE OTHER THING SITS**, not which edge was touched — the same fact said
backwards, and it reads wrong in every test that uses it. So a stomp is `below`, and the pair of
events carries OPPOSITE sides, which is precisely what tells a stomp from being stomped. A spanned
axis cannot be the contact axis: a 4-wide body on a 100-wide floor has a *shallower* horizontal
overlap, so a naive shallowest-axis test reports it walked into the floor it is standing on. Ties
go vertical, stated, because a platformer's commonest contact is a landing.

**THE EVENT ORDER IS A FUNCTION OF THE DOCUMENT.** Pairs are built from a SORTED id list, not from
the body Map, whose order the document's node-Map inherits and which undoing a DELETE permutes — two
files with byte-identical content would otherwise emit their events in different orders. Nothing in
the runtime had ever tested iteration order; a fixture with **two** bodies cannot see it, so the
test uses three, one overlapping the other two in a single step.

**A FIXTURE LANDED EXACTLY ON A FLOATING-POINT TIE**, which is worth keeping. The walk-into test put
the gap at 88px against 24 steps of 220/60 — and a position here is a running SUM, so twenty-four
additions of 11/3 give 88.00000000000001 rather than 88 and the contact fired a step early. The
hand-computation was right and the code was right; the fixture was on the boundary. Moved to 90.

**AND ONE OF THIS SLICE'S OWN FIXTURES WAS BLIND, caught by its mutant.** The test for "skip a body
whose world offset is refused" refused the body FROM THE START — and `worldFrom` already skips a
refused body, so it never entered the world and the guard in the contact pass was never reached; the
mutant that deletes that guard survived. The reachable case is a refusal appearing MID-RUN: the body
is in `world.bodies` from Play, and the app steps against the LIVE stored document, so rotating its
frame during a run makes `worldOffsetOf` start answering null for a body that is already moving.
Rebuilt around that, with the positive control the first version lacked — assert the pair really
does report a contact while the frame is composable, THEN that rotating it suppresses them.

**VERIFIED LIVE against two documents**, because one alone proves only that something reaches the
status line: dropping onto the blob reports `contact enemy (below)` and walking into it reports
`contact enemy (right)` then a separate. The blob in that fixture is CLASSED and a body at once,
which no object in the corpus is — precisely the authored shape this slice exists for and the corpus
cannot testify to.

**THERE IS NO IMPULSE CHANNEL**, and it is written into API-CONTRACTS as a stated limit rather than
left for whoever first tries to bounce a stomp: `stepWorld`'s opts carry gravity, solids, tileSolids,
regions, input and controlled, and not one of them can set a body's velocity. Acting on an event is
the next slice's design and it needs a channel that does not exist.

**THREE DEFECTS THAT HAD ALREADY SHIPPED, found by attacking slice 9 rather than by writing it —
and every one was invisible to the whole suite.**

1. **`dropHidden` returned an enumerated seven-field literal**, so hiding ANYTHING silently dropped
   all six of the document's optional fields — `tilesets`, `timeline`, `frame`, `clips`, `lights`,
   `ambient`. `resolveScene` calls it FIRST, so the renderer then looked for its tilesets on a
   document that no longer had any. **Reachable from the corpus with no user action:** the Tiled
   importer writes `hidden: !layer.visible` and `sandbox.tmx` ships a `visible="0"` layer, so
   importing it blanked every tile layer's art and switched the lights off. It had NO behavioural
   test at all — only a type assertion in `apiSurface` — which is why it rotted. Fixed with a spread,
   because an enumerated literal is correct exactly until the next field is added.

2. **`movedIds` answered the wrong question.** It reported "does the world disagree with the STORED
   document"; a dirty set must report "did this frame's geometry change since the LAST one". They
   differ in precisely the case a platformer produces constantly — a body that jumps and lands back
   on its authored position agrees with the document again, so it went unnamed on the very frame it
   arrived and `computeGeometry` reused the previous frame's entry. **Measured at 6px of permanent
   divergence** from a full recompute, on a 72px jump onto a floor at y=400. Same family as the
   Play/Stop reuse bug already recorded above. Fixed by taking the previous world and unioning.

3. **A contact pair does NOT always carry opposite sides**, though slice 9's own header said it did.
   `sideOf` is not antisymmetric and cannot be: "b is inside a" is true while "a is inside b" is
   false, so a 32x8 enemy under a 32x32 hero gave (below, **inside**) and every rule keyed on the
   STOMPED body was unreachable for the commonest case. The first fix was wrong too — deriving from
   whichever id sorts first picks the CONTAINED body half the time and yields (inside, inside). The
   informative direction has to win.

**AND THE "97 Tiled files" IN SLICE 9's OWN HEADER WAS WRONG — it is 65**, corrected in all three
places it was published. The likely cause is the `.tsx` extension collision: a Tiled tileset and a
React component share it. Every other headline recounted exactly (248 objects, 138 declarations,
bodyType 51, friction 45, floating 24, density 1, 1,235 tiles).

**Slice 11 — THE PLACEMENT LOGIC LEAVES THE FOLDER DIALOG, and it was found by trying to build the
test game for real rather than by reading the code.** Two hundred and forty-one lines deciding WHAT
a Tiled map places — grid-or-per-cell per layer, tileset deduplication, tile anchoring, object
layers, and the note the drawer prints — lived inside a `<select onChange>` in `App.tsx`. And
`window.electronAPI` is FROZEN and non-configurable, so that handler cannot be driven from a test,
a script or CDP: **the most intricate part of the importer was the only part nothing could
exercise.** The ACTIONS were extracted to `core/actions/tileImport` months ago for exactly this
reason; the code that decides what to place never followed them out.

`core/import/tiledPlacements` now holds it, and the seam is AFTER the filesystem: resolving an
external `.tsx`, reading a PNG and measuring an image all need a filesystem, so they stay in the
handler, and everything below them was pure all along. Even the id source is a parameter — a test
that cannot predict the ids cannot assert on the output.

**AND IT IMMEDIATELY IMPORTED AN ASSET PACK NOTHING HAD EVER IMPORTED.** Kenney's Pixel Platformer
(`freeassets/2D assets/Pixel Platformer/Tiled/tilemap-example-a.tmx`), 26x15 at 18x18 with TWO
tilesets, run through the extracted module: **3 grids + 10 loose tiles, 0 unresolved**, and the
character layer correctly refuses the grid with its reason stated — *"layer 'Characters' draws 24x24
tiles on a 18x18 grid, which a cell cannot hold"* — falling back to the per-cell path, which is the
only thing that can draw it. The set's `<tileoffset x="-3">` is carried. That map is the visual
basis for the test game.

**One tileset is minted, not two, and that is correct:** only the GRID path needs a document
tileset, and the 24x24 characters become `core.image` nodes with their own source rects. Worth
knowing before anyone tries to PAINT with that set — it is not in the document.

**Slice 12 — THE PARTS VOCABULARY, and the level chose its entries.** A part declares its own
behaviour in `userData` under a `vde.` prefix, read by `core/runtime/Parts.partOf`. This is Super
Mario Maker's shape rather than a level format's: a goomba there is not a name the engine looks up,
it is a part that brings its behaviour with it, and the editor's palette IS the vocabulary.

**WHY THIS IS NOT THE SCHEMA-AHEAD-OF-CONTENT THAT REFUSED `core.entity`.** That charge is about
inventing a shape and WAITING. The corpus cannot justify this because the corpus is somebody else's
imported level geometry — 12 `coin` objects carrying zero properties between them, a `script` naming
a `.lua` that does not exist, no game source shipped. The content that uses this vocabulary is
content WE author, and it ships in the same commit as the vocabulary and its reader. A node that
declares nothing is INERT, so every corpus document and every older file plays exactly as it did —
`oneway`'s argument, and unlike slice 9's it genuinely transfers.

**TWO ENTRIES, BOTH NAMED BY BUILDING THE LEVEL rather than guessed.** `vde.stompable` replaces the
inference I disliked when I wrote it — slice 10 read `className !== ""` as "authored as an actor",
the corpus's measured disjointness pressed into service as a marker it never was. Sticker-knight's
push-block is now safe by its own SILENCE rather than by a heuristic about classes, and the class is
back to being a name. `vde.patrol` makes a part walk: measured need, because every enemy in the
built level was a statue — `worldFrom` starts every body at rest and nothing could give one a
velocity.

**`Body.blockedX` IS THE PHYSICS GIVING BACK A FACT IT ALREADY HAD.** The horizontal pass sets
`vx = 0` and said nothing; a part that walks needs exactly that to turn around, and deriving it
outside would mean re-running the sweep. A WALL, NOT A LEDGE — Mario's own goombas walk off ledges,
and the level's enemy1 duly did (y 144 -> 198), which is faithful rather than a bug.

**A DECLARED SPEED IS NOT THE SPEED IT TRAVELS, measured and documented rather than papered over.**
A part declaring 60 walks at 45: friction is the GROUND's property and applies to every body, and a
velocity re-set once per step loses exactly one step of it (mu*g*dt = 15) before the move. The player
escapes this only because input re-sets `vx` INSIDE the step. On ice the two numbers would agree.

Verified live in the built Kenney level: enemy1 walks 180 -> 288 and falls off a ledge, enemy2 walks
LEFT from its negative declared speed, the player stomps enemy2 (`contact enemy (below)`, 237 -> 236
images) and bumps two others from the side with no effect.

**Slice 13 — THE RUN LIFECYCLE, so a level can be lost, won and ended.** Until this a run could
only be STOPPED by the editor, which is a different thing: the person watching decided, not the game.
Building a real level measured the cost — with no bounds, one stomp bounced the player past the edge
and it reached **y=4658** still at terminal velocity, the run happily continuing with nothing to do
but reach for Stop.

**AND THE RESEARCH SAID THE SAME THING FROM THE OTHER SIDE.** Every published account of World 1-1
turns on CONSEQUENCE: the first Goomba teaches by killing you once, and the first pit is deliberately
given a filled-in bottom so the jump can be rehearsed before the identical next pit charges for it.
A safe-then-lethal pair means nothing while both halves are survivable — so the single most important
principle in the Mario level-design literature was unbuildable here until now.

`WorldState.outcome` is `running | lost | won`, set ONLY by an `endRun` command — the third verb, and
the physics still decides nothing. It is MONOTONIC and first-one-wins: nothing un-ends a run, and a
step that both kills the player and reaches the goal reports the kill. A finished run decides nothing
further, which is not an optimisation — without it a dead player keeps patrolling enemies and keeps
re-reporting its own death every step.

`vde.deadly` and `vde.goal` join the parts vocabulary. **THE ORDERING BETWEEN DEADLY AND STOMPABLE IS
THE RULE, not an accident:** a part may be both — which is exactly what a Goomba is — so the stomp is
read FIRST and a part it despawned cannot then kill. Falling out of the world is the one ending no
part can declare, because it is the ABSENCE of parts; the caller supplies the level's extent, which
is the same rectangle the camera already refuses to scroll past, with one body height of slack so
standing on the lowest floor is not death. With no bounds supplied the runtime behaves exactly as it
did before, and a test pins the 4,000px runaway to prove it.

**Slice 14 — A NODE'S OWN PLAYHEAD (schema 69), the first ART-side slice of the 8-bit rung.** The
ladder is FIDELITY ERAS — 8-bit, 16-bit pixel art, 2.5D, 3D — and the point is holes that stop people
MAKING ART as much as ones that stop them building games. Thirteen slices of runtime had left the
presentation floor untouched.

**THE MEASUREMENT OVERTURNED THE ASSUMPTION, which is why it was worth making.** I expected the hole
to be that a sprite-sheet frame could not be keyframed. It can: `sourceRect` is one of the eight
`OVERRIDE_FIELDS` and is NOT among the sixteen `EASABLE_PATHS`, so under `applyFrame` it STEPS — which
is exactly frame-by-frame playback — and `sliceTrack` already builds such tracks with a live caller.

**THE REAL HOLE WAS ONE CLOCK FOR THE WHOLE DOCUMENT.** `applyFrame` took a single frame for every
node, so two identical props flapped in perfect lockstep with nothing an author could do, and a hero
mid-jump and a goomba mid-walk were **not expressible at the same instant by any route**. `Node.frame`
ends that. Absent means "read the document's", so every existing file behaves exactly as it did, and
the 68→69 migration is named and empty rather than absent.

**A BLOCKING DEFECT WAS CAUGHT IN REVIEW RATHER THAN IN CODE.** `applyFrame` returned at
`!Number.isFinite(frame)` BEFORE it looked at a single node — and `doc.frame` is `undefined` for every
document that had no timeline when it was loaded, which is every imported map. A per-node playhead
read inside that loop would have been a **silent no-op on exactly the documents that need it**. The
document's frame is now a DEFAULT, not a gate.

**AND THE SIXTH INSTANCE OF THE ENUMERATED-LITERAL BUG, the second found today.** `applyFrame`
returned a nine-field literal and dropped `tilesets`, `clips`, `lights` and `ambient` from every
animated document — so a level with a tilemap AND an animated character lost its tileset the moment
the character had a track, and the terrain stopped drawing. `dropHidden` had the identical defect for
the identical reason. Spread, never enumerate.

**STILL OPEN on the animation gap, with the refutations recorded rather than guessed at:** the
runtime cannot yet select a frame from a velocity, and `clipFrameAt` remains a complete, tested clip
player with ZERO production callers. Four blocking problems stand between here and that — a pose
feeding back into policy through `contentBounds` and the death plane, `clipFrameAt`'s `elapsed`
counting from the CLIP's start rather than the run's, `importTrack` replacing a whole track so a node
holds one clip spanning the entire sheet, and a pose sampled per FRAME rather than per STEP.

**Slice 15 — A CHARACTER FACES THE WAY IT IS GOING**, the first half of the animation gap and the
half chosen because it avoids all four blockers the design review found.

`Body.facing` lives beside `onGround` and `blockedX` because which way something moves is a fact
about MOTION rather than about presentation — and because a body field is per-step BY CONSTRUCTION,
which is the defect that would otherwise make the picture depend on the monitor. It keeps its last
non-zero direction: a stopped character has no velocity left to read, so deriving this outside the
step would snap it back to facing right the instant it stood still.

`applyFacing` is a SIBLING of `applyWorld`, not part of it — they answer different questions to
different readers. The magnitude is the author's and only the sign is the run's, so a node scaled 2x
stays 2x. **IT CANNOT MOVE ANYTHING**, checked rather than assumed: a negative `scaleX` about the
default origin leaves the AABB identical, so nothing derived from bounds — the camera,
`contentBounds`, the death plane — can shift because a character turned around. A pose that changed
a node's BOX would feed back into policy and move the death plane, which is exactly why the FRAME
half is still not here.

`facedIds` is the dirty set's other half: a character that turns around while standing still has not
moved a pixel, so `movedIds` leaves it out and the incremental geometry would keep the old matrix for
ever — the third time a stale dirty set would have shown a stale picture in this runtime.

Verified live in the built Kenney level: the enemy declaring `patrol=-45` renders
`matrix(-1 0 0 1 226 180)` while the one declaring `+45` renders a plain `translate`, and Stop
restores both. 3/3 mutants killed.

**AND THE ERA RESEARCH FOUND A CHOICE OF MINE THAT DOES NOT MATCH THE ART.** SMB1 accelerates,
carries momentum and skids; slice 2 implemented the walk as a SET speed on the reasoning that "a
platformer's walk is a speed you have while the key is down". That is a defensible arcade feel and it
is not what the 8-bit era does. Nor is the jump: SMB1's signature rule is a VARIABLE jump height, and
this runtime has one fixed 72px jump with no analogue component at all. Both are holes this project
introduced rather than found, and the jump is the smaller and sharper of the two — it is also the
first test of whether the input path can carry an analogue value.

**Slice 16 — VARIABLE JUMP HEIGHT, the 8-bit rung's signature vertical rule.** Slice 15's research
found two choices of mine that do not match the art; this closes the smaller and sharper of them.
The runtime had ONE fixed 72px arc: press, and the rest was decided. It now answers how long you
hold the key — a tap clears 25.92px and a full hold 72, which on this 18px grid is 1.44 tiles against
four.

**THE INPUT PATH DID NOT NEED TO CARRY AN ANALOGUE VALUE AFTER ALL**, which is what slice 15 expected
this to test. `Input.jump` was ALREADY a held boolean; only the launch had ever read it. The height
comes out of reading it a second time, for a different question — "did it just go down" against "is
it still down".

**TWO GRAVITIES, NOT A VELOCITY CUT, and the mechanism was checked rather than chosen.** The original
sets `VerticalForce` and `VerticalForceDown` at jump time and only ever applies the first; its
`JumpSwimSub` overwrites it with the second. Nothing touches `Player_Y_Speed`. Cutting the velocity
on release is the commoner tutorial answer and gives a visible KINK at the moment of release; two
gravities give one smooth arc whose curvature changes, which is what the 1985 game looks like.

**THE FRACTION IS THE RATIO OF THE SHORTEST JUMP TO THE TALLEST, exactly**, which is why
`HELD_JUMP_GRAVITY` is one constant instead of two heights: same launch speed, rising under `g*f`
against a full `g`. So `JUMP_HEIGHT` still means what it always meant — how high a fully held jump
goes — and the launch speed is the SHORTEST jump's, which is also what a stomp bounce uses.

**9/25 IS MEASURED, AND THE OBVIOUS ARITHMETIC IS WRONG.** The original's `JumpMForceData` and
`FallMForceData` hold `$20`/`$70`, `$1e`/`$60` and `$28`/`$90` across three speed tiers — ratios of
3.5, 3.2 and 3.6, so "about a third" looks like the answer. It is not, and it is wrong in the
direction that flatters it: the launch frame is exempt from the switch, so even the shortest jump
gets one frame of weak gravity (+14% on the minimum), and the original moves by its velocity BEFORE
it accelerates, which lifts the maximum. Simulating the tables frame by frame gives min/max heights
of 0.350, 0.371 and 0.344 against gravity ratios of 0.286, 0.313 and 0.278. 0.36 sits in the middle
of the HEIGHTS — the quantity a level is built from — and is also the value that comes out whole
here: launch exactly 216 px/s, apex exactly on step 40. The published block figures agree
from the other side: "a little over one block" and "almost exactly 4 blocks" against our 1.44 and 4.

**AND THE RESEARCH OVERTURNED A CLAIM I HAD ALREADY WRITTEN INTO A COMMENT.** I had said a stomp
bounce taken with the key held carries higher, "which is the original's behaviour". It is not. The
original's stomp writes a bare `-4` into `Player_Y_Speed` and never reloads the rising acceleration,
so by then the falling one is latched in and A does nothing — the popular framing is false for
ordinary stomps, and true only for the from-below case and for jumpsprings. The fix was not to
special-case the bounce but to implement the LATCH the original actually has: `WorldState.jumpCut`
closes on the first step the key comes up OR the rise ends, whichever is first, and only a fresh
launch reopens it. That one field buys three era behaviours at once — fluttering the button cannot
out-jump an honest hold, a bounce does not answer the key, and the arc past the apex is committed.

**WHAT IS DELIBERATELY NOT COPIED:** the original's initial velocity depends on how fast Mario is
RUNNING (-4 px/frame walking, -5 flat out, a jump about 25% taller). This runtime has no run to read
— its walk is a single set speed — so a speed tier here would be a table indexed by a constant.
That belongs to the OTHER era mismatch, acceleration and skid, which is now the last one outstanding.

Eight mutants, and every one of them survives a fixture that only ever HOLDS the key — which is what
every jump fixture in this repo did before this slice. The range only exists if something releases.

**AND ONE OF THE EIGHT SURVIVED FIRST TIME, which is the battery doing its job.** Dropping the
`was.vy < 0` guard and leaning on the latch alone reads almost equivalent, because the latch also
closes at the apex — but it closes ONE STEP LATER, since it is computed from the velocity entering
the PREVIOUS step. That leaves a single step in which a descending body would still get the weak
gravity, and one step is invisible to every apex-height and landing-step comparison, because both
arms of those comparisons hold the key across the apex. The fixture now asserts the velocity
sequence THROUGH the apex instead: -5.4, 0, then 15 — a full gravity for a sixtieth of a second,
with the key still down. Blind fixture, not a missing assertion, for the umpteenth time.

**Slice 17 — ACCELERATION AND SKID, the LAST era mismatch this project introduced.** Slice 2 made
the walk a SET speed on the reasoning that "a platformer's walk is a speed you have while the key is
down" — defensible arcade feel, and not what the 8-bit era does. A walk is now built up over a
run-up, and turning round has its own, harder rate.

**IT ADDS ONE NEW MAGNITUDE, AND THE ERA SAYS IT IS A BIT SHIFT.** The original has no skid constant
at all: holding the opposite direction takes the SAME table entry as releasing, and the whole effect
is `asl FrictionAdderLow / rol FrictionAdderHigh`, firing on the frames facing and moving disagree.
So `SKID_TURN` is exactly 2 — not approximately 2 — and everything else here is a number this runtime
already had.

**THE PUSH IS ONE GRAVITY, WHICH IS SLICE 4'S STANDARD MET AGAIN.** In the original's WALK tier the
acceleration byte and the release-friction byte are the same byte, `$98`: acceleration EQUALS
friction there, one addition per frame whose sign the D-pad chooses. This runtime already carries a
friction of `mu * g` defaulting to `mu = 1`, because 44 of the corpus's 45 surfaces declare exactly
1 — so "the push is one gravity" reproduces the era's identity out of the constant slice 4 already
measured, and `walkAccel` introduces no number of its own.

**I ANCHORED ON THE WRONG TIER FIRST, and the research caught it.** `MOVE_SPEED` is 220 px/s, which
is 1.47x the original's RUNNING top speed, so the run tier looked like the match. A tier is chosen by
the BUTTON, not by the speed, and with no run button a held key is a walk. Read off the run tier the
run-up came out at 3.5 tiles against the walk tier's 1.5, and the skid at 2 tiles against 0.75 —
both more than double the era's own figures, and the skid ratio drifted to 1.75 where the original's
is a shift.

**THE DISTANCES ARE DERIVED RATHER THAN DECLARED**, which was the other correction. `walkRunup` and
`skidDistance` read the way `JUMP_HEIGHT` reads — a distance is what a gap and a ledge are drawn
against — but declaring them and deriving the rate puts two numbers where the era has none, and lets
the ratio drift with nothing noticing. Measured: 26.89px (1.49 tiles) and 13.44px (0.75) against the
original's 1.90 and 0.75 blocks. **The turn matches exactly and the run-up is punchier**, which is
what a body moving 2.4x faster on a tile only 1.125x bigger has to be; the two cannot both be
preserved, and the turn is the one a player feels. A cross-check that fell out rather than being
aimed at: the run-up is 26.89px and a TAPPED jump clears 25.92.

**FRICTION IS NOW SUPPRESSED WHILE A KEY IS HELD, and that is forced rather than chosen.** Compose
them and the effective acceleration is `a - mu*g`; the push IS one gravity and the default mu is
exactly 1, so the two cancel to zero and the player cannot move at all on the surface almost every
level declares. The original agrees from the code — its `ImposeFriction` applies exactly one adder
per frame and lets the D-pad choose its sign, so acceleration and friction are never both applied.
Until now this line ran always and the walk simply ASSIGNED over it, which is the same suppression
written less honestly.

**TWO DIVERGENCES RECORDED RATHER THAN FAKED.** (1) The original does NOT double the rate in the air,
because its doubling fires on facing-vs-moving and it only writes facing from the D-pad while
GROUNDED — so a midair turn is weaker, and reproducing it needs a facing that comes from the KEY and
freezes in flight. `Body.facing` comes from the VELOCITY and therefore can never disagree with it.
(2) Its release friction is 133.6 px/s^2 against our 900, so our coast is far shorter — a level
wanting the original's slide declares `friction="0.15"` on the surface, which the measured knob
already supports.

**AND THE FIRST MUTANT THIS PROJECT HAS RETIRED FOR THE OPPOSITE REASON TO THE USUAL.** KB1 mutated
the walk from SET to ACCUMULATED, and accumulated is now what the walk deliberately does — a mutant
whose defect has become the feature cannot be repaired, only replaced. What made its version wrong
was the absence of a CAP, which survives as AS1. `OW2` and `RL4` were deleted for being EQUIVALENT;
this one was deleted for being RIGHT. FR6 then had to be retargeted as an INSERTION, because its
defect stopped being expressible as an edit — `if (push !== 0)` multiplies the rate BY the push, so
opening the guard changes nothing, and my first retarget was itself an equivalent mutant.

Eight mutants, 8/8 killed, and 16/16 across the three families the slice touched.

**Slice 18 — THE DOCUMENT HAS A BACKGROUND (schema 70), and the hole was found by looking at a
screenshot.** Nothing in the document carried a background of any kind. What a level appeared to sit
on was the EDITOR'S chrome, which is not part of the document — so a run had no sky, an export
emitted no ground colour, and a Tiled map's own `backgroundcolor` was read by nothing.

**MEASURED BEFORE BUILT, and the measurement narrowed it.** Three of the twenty-four maps in this
tree declare `<map backgroundcolor>` — `#000000`, `#3a3a3a`, `#27b99a` — and the importer dropped all
three. **ZERO** use an `<imagelayer>`, so the backdrop-picture feature the importer counts and does
not read is correctly unbuilt. One declares a parallax factor. The era agrees with the small answer:
the original's background is not an image layer, it is a solid sky colour plus scenery drawn as
ORDINARY TILES, so a colour and a second tile layer is the whole of it.

**A DOCUMENT-LEVEL FIELD, not a very large rectangle.** A rectangle behind everything would be
selectable, draggable, deletable, and INSIDE `contentBounds` — which the follow camera clamps to and
the death plane is derived from, so the sky would move the edge of the world.

**THE WRITE PATH SHIPPED IN THE SAME COMMIT AS THE FIELD.** `Document.clips` arrived at schema 46
validated, serialised, migrated and read by the sprite-sheet exporter with nothing able to set it;
`Document.tilesets` shipped the same way. Twice made `SetTilesetsAction`'s header ask for a rule, so
`SetBackgroundAction`, the delta, the inspector control and the import seam are all in this commit.

**PAINTED IN SCREEN SPACE BY ALL THREE BACKENDS**, so a level three screens wide needs no rectangle
three screens wide behind it — and EXPORTED AS A REAL `<rect>` rather than a style on the root,
because a standalone file is opened by converters and printers that drop presentation, which would
make the sky the one thing that did not survive the export.

**ONE DIVERGENCE, STATED RATHER THAN HIDDEN.** SVG and Canvas hand the string to the browser, which
takes names and `rgb()`; `gl.clearColor` takes four floats, so the GPU parses hex and falls back to
the editor backdrop on anything else. That is the one place these backends disagree by construction.
It is hex in all three maps that declare one, so the gap is real and unexercised — the fix, when it
is needed, is to resolve the colour ONCE in the render model rather than teach a backend CSS.

**AND TILED PUTS THE ALPHA FIRST.** `#aarrggbb`, where CSS reads `#rrggbbaa`. Both are eight hex
characters and nothing in the string says which end it is, so an opaque sky arrives nearly
transparent — normalised at the reader, where the format is known, rather than at the far end.

**WHAT THIS DID NOT DO, and is the next thing the screenshot asks for:** the test level still has no
scenery. The Kenney map ships four layers — `Tiles`, `Tiles (layer A)`, `Tiles (layer B)`,
`Characters` — and the wide level rebuilt the terrain on ONE of them and discarded the other two.
`depth` and `applyParallax` have existed since schema 40 and are applied against the viewport, which
during a run IS the follow camera, so layered scenery should already parallax in a playing game.
That has never been verified with a game camera and is the cheap check to make before building on it.

7 tests, 4 mutants, 4/4 killed.

**Slice 19 — PARALLAX DID NOT SURVIVE THE INCREMENTAL GEOMETRY PATH, and it never had.** Slice 18
ended by saying layered scenery *should* already parallax during a run, because `applyParallax` is
applied against the viewport and the viewport during a run IS the follow camera — and that the claim
had never been checked. It was wrong. **300px of divergence on a single depth-1 layer after a 600px
pan**, with the depth-0 control agreeing, so the fixture was not passing for the wrong reason.

**THE ENGINE COMPARES SET MEMBERSHIP, NEVER GEOMETRY.** `selfDirty` is `effectiveDirty.has(id)`, so
a node whose stored geometry changed by a route the dirty set cannot see reuses its previous entry
unconditionally. `applyParallax` shifts a layered node from the VIEWPORT, and a pan dispatches no
action and moves no body — so nothing named the shift and the reused entry stayed where the camera
used to be. `parallaxIds` is the missing half, and the app asks it only when the viewport moved.

**THE FOURTH INSTANCE OF THIS EXACT SHAPE**, after a run's bodies (`movedIds`, 6px permanent), a
scrubbed playhead (the shape did not move at all while the track ran), and a character that turned
around without moving a pixel (`facedIds`). Each was geometry changed by a route the dirty set could
not see. That is now four, and the pattern is worth stating as a rule: **anything that derives
geometry from something other than an action must ship the ids it touched in the same commit.**

**IT WAS BROKEN IN THE EDITOR TOO, not only during a run** — `!es.playing && !frameChanged` takes
the same reuse branch, and panning a layered document is the single most common thing a person does
to one. Parallax has existed since schema 40; on the evidence it has worked only on frames where
something else happened to be dirty.

**DEPTH 0 IS EXCLUDED and that is load-bearing rather than tidy:** `parallaxRate(0)` is 1 and the
offset is exactly zero, so including it would dirty every node of every document on every frame of
every pan — which is the incremental path deleted. PX1 is the mutant that does exactly that, and it
KEEPS THE PICTURE CORRECT, so only a test that asks which ids come back can see it.

3 tests, 2 mutants, 2/2 killed.

**Slice 20 — SCENERY, and it was a hole in the engine.** The Kenney map ships four layers and the
wide level had rebuilt terrain on ONE of them. Putting the other two back found that a layered
tilemap was **solid**: every one of that tileset's 29 declared tiles is `bodyType=static`, and
solidity belongs to the TILESET TILE, so every layer drawing that tile shares it. Measured on the
real level: **0 solids up in the empty sky before adding a scenery layer, 2 after**.

**THE RULE: the physics must not collide with something whose position depends on where you are
looking.** `applyParallax` shifts a layered node by an offset derived from the VIEWPORT, so a
depth-1 cloud is drawn somewhere different on every frame of a pan while its stored geometry never
moves. Collide against the stored box and the wall is nowhere near the picture; collide against the
drawn one and the level plays differently depending on the camera — the same class of defect as a
frame-rate-dependent jump, and far harder to notice. `isLayered` guards all three runtime scans:
solids, tile solids, and REGIONS (a coin at a depth would be collected where it is not drawn).

**DEPTH RATHER THAN A NEW DECLARATION, because it is a consequence rather than a choice.** Nothing
was invented and no property added: a layer says it is scenery by being at a depth, which is the
same statement that makes it parallax. A level that wants solid ground keeps it at 0, where every
node already is. SC2 is the mutant that excuses only BACKGROUND layers and leaves a FOREGROUND one
solid — the half a fixture written around clouds would never reach.

**THE PROOF THE SCENERY IS INERT is that the playthrough did not change.** 189 far-hill cells at
depth 2 and 90 bush cells at depth 1 were added to the level, and all three scripted runs end at the
identical step, the identical x, with the identical cause and the identical enemy positions.

**AND THE LEVEL HAS A SKY**, `#5c94fc`, which is the original's own — schema 70 gave the document
somewhere to put it one slice earlier, and this is the first content that uses it.

**AN OBSERVATION FROM THE PICTURE, recorded rather than silently accepted:** `parallaxOffset` shifts
BOTH axes, so with the camera panned vertically the hills ride up off the horizon instead of sitting
on it. That is right for a design canvas — a layered card lifts in both directions — and it is not
what a side-scroller wants, where parallax is horizontal and the ground is fixed. It is a missing
per-layer axis rather than a defect, and nothing in the corpus asks for one yet.

3 tests, 2 mutants, 2/2 killed.

**Slice 21 — PARALLAX HAS TWO AXES (schema 71), because the format always did.** The user looked at
the scenery screenshot and said the terrain was not lined up, and they were right: one scalar drove
both axes, so with the camera 176px up the depth-2 hills rode **117px off the horizon** (`-176 × 2/3`)
and the depth-1 bushes 88px, which is why the two scenery layers stopped agreeing with the ground
and with each other. I had filed that as cosmetic one message earlier. It was not.

**MEASURED, NOT INVENTED: Tiled declares `parallaxx` and `parallaxy` as INDEPENDENT per-layer
factors** — the importer has been counting them as "not read" all along, so the vocabulary was
already sitting there. `Node.depthY` is the second factor in this engine's own depth vocabulary:
absent means "the same as `depth`", so every document written before this behaves exactly as it did
and the 70→71 migration moves no data.

**ONE SCALAR IS RIGHT FOR A DESIGN CANVAS AND WRONG FOR A SIDE-SCROLLER**, which is the whole
tension and why this is a field rather than a change of behaviour. A layered card should lift in
every direction when the canvas pans; a hillside should scroll sideways and stay on the horizon. A
side-scroller writes `depthY: 0` — vertical rate 1, no vertical lag — and that is the one value that
pins a layer to the world in an axis.

**IT DOES NOT TOUCH DRAW ORDER OR THE Z-BUFFER**, which stay `depth`'s alone: this is how far a
layer LAGS the camera, not how far away it is. Two layers that sort identically may still scroll
differently, which is exactly what a sky and a hillside do.

**EITHER AXIS MAKES A NODE LAYERED**, and `isParallaxed` is the one answer both callers use. A node
at `depth: 0, depthY: 2` does not move sideways and does move vertically — asking only about `depth`
would leave it out of the dirty set that keeps parallax fresh AND leave it SOLID to a runtime that
must not collide with anything the camera can move. PA10 is that mutant.

**A PINNED AXIS RETURNS EXACTLY ZERO, not negative zero.** `-176 × 0` is `-0`, which adds to a
position harmlessly and then fails `Object.is` against 0 for anyone comparing offsets — found by a
test asserting `toBe(0)`, and fixed in the function rather than in the assertion.

Verified in the running app: the hills and bushes now sit ON the ground line and still lag
horizontally, and the playthrough is byte-identical to every run before the scenery existed.

4 tests, 2 mutants, 6/6 killed across the parallax and scenery families.

**Slice 22 — THE WALK CYCLE, and the animation gap's runtime half is closed.** Slice 15 did facing
and stopped, because a design review had recorded four blockers between here and selecting a frame
from a velocity. Re-measured against the tree first, and **two of them had dissolved**:

- **`applyFrame`'s gate — resolved at schema 69.** `doc.frame` is a DEFAULT, not a gate.
- **A pose feeding back into policy through `contentBounds` and the death plane — DOES NOT APPLY.**
  Measured rather than assumed: `sourceRect` appears NOWHERE in `core/geometry` or `core/runtime` —
  only the render model, the image cache and the Tiled exporter read it. So a frame change cannot
  shift a node's AABB, which means it cannot move the camera's clamp or the death plane. The same
  escape hatch facing used: change what is DRAWN without changing what is THERE.
- **`clipFrameAt`'s elapsed semantics and `importTrack` replacing a whole track — AVOIDED, not
  solved.** Both are real and both only bite on the CLIP PLAYER's path. Nothing here has a clock.
- **Per FRAME versus per STEP — the one that was real**, and solved the way facing was: it lives on
  the `Body` and is updated inside `stepWorld`, which is per-step by construction.

**DISTANCE, NOT A CLOCK, and that is the era's own answer.** `Body.travelled` accumulates while a
body is ON THE GROUND, and the frame is `floor(travelled / stride) % frames`. The original's walk
animation advances as the character covers ground — it visibly speeds up as you do, stops dead when
you stop, and has no playback rate that can drift out of sync with the physics. A clock would have
needed one, plus the two clip-player blockers, to arrive somewhere worse.

**GROUND ONLY, so a jump holds one pose** rather than flickering through the cycle mid-air. WK1 is
that mutant, and the position is identical either way — only a fixture watching the POSE while
airborne can see it.

**FLOOR, NOT ROUND.** Rounding gives the first and last frames of every cycle half a stride and the
others a whole one, which is a limp rather than a walk. WK2, and invisible to a fixture that samples
only whole strides.

**THE DECLARATION ADDS NO COORDINATES.** `vde.walk: "4"` says the next three frames sit beside the
`sourceRect` the node already carries, one width apart — which is how every sheet in `freeassets` is
cut, and it means the artist positions frame one by eye in the inspector as they already do.
`vde.walkStride` defaults to the node's own WIDTH, the one default that needs no number invented.
Fewer than two frames is not a cycle: one is the pose the node has, and zero or negative would index
backwards off the sheet (WK3). A sheet laid out vertically or ragged is NOT expressible, stated
rather than guessed — 57% of Kenney's 421 atlases are irregularly packed and none of them are walks.

**AND THERE IS NO `posedIds`, deliberately.** `facedIds` exists because a mirror is a TRANSFORM,
which the incremental geometry path reuses and would otherwise keep stale. A `sourceRect` is rebuilt
into the display list every frame from the document, so there is no reused entry to go stale — the
same measurement that killed blocker two answers this too.

8 tests, 3 mutants, 3/3 killed. At slice 22, `clipFrameAt` still had zero production callers, which was then a
statement about a path not taken rather than an unreachable feature.

**Slice 23 — BUMPING A BLOCK, the collision a level made of tiles could not report.** Placing pipes,
bricks and `?` blocks in the test level exposed it immediately: they were solid, you could stand on
them and jump into them, and **hitting one produced nothing at all**.

**A SOLID WAS A BARE BOX, and that is the whole defect.** Every collision this runtime reported was
against a NODE — a body meeting a body, a body entering a region — because both have ids. A tilemap
is ONE node holding ten thousand cells, so it collided perfectly and said nothing about WHICH cell.
The single thing an author most wants to act on in this era, bumping the block above your head, was
the one collision the world could not name. `Solid` now carries `nodeId` and `cell`, and
`tileSolidsNear` fills them.

**THE `else` IS THE WHOLE CONDITION.** A head hit is "the body was rising and something stopped it
from below", which is exactly the branch the vertical resolution already had — landing is the other
one. No new test, no threshold, no guess. BP2 swaps them and 49 fixtures fail: a floor that bumps
sixty times a second and a ceiling you stand on.

**THE WORLD REPORTS AND DOES NOT ACT**, which is slice 5's rule and deliberate here. Turning a `?`
into a used block and putting a coin above it are a GAME's decisions, and they need two things the
command channel does not have: a way to change a CELL mid-run, and a way to bring a thing into
EXISTENCE. `applyCommands` can despawn and set a velocity; it cannot create. Both want their own
design, and inventing either inside a collision resolver is how a physics loop becomes a game.

**THE CELL, NOT THE TILE INDEX.** A rule wants to act on the PLACE — that cell becomes used, that
cell spawns something — and the index is already readable from the map at those coordinates.
Reporting the index would answer a different question.

**NOTHING FIRES FOR A NODE SOLID**, and that is a decision rather than an omission: a rectangle has
an id, so `contact` already says it properly. A cell-less bump would be a second, weaker way to say
the same thing.

3 tests, 2 mutants, 2/2 killed.

**Slice 24 — A CELL BECOMES SOMETHING: the fourth command verb, and the first that names no body.**
Slice 23 made the block bump reportable and deliberately stopped there. This is the half that acts:
a `?` that stays a `?` after you hit it was the whole of what remained.

**DESPAWN, SETVELOCITY AND ENDRUN ARE ALL ABOUT THINGS THAT MOVE.** A level made of tiles has ten
thousand cells and one node, and nothing in the command channel could touch one of them —
`applyCommands` looked up `c.bodyId` before doing anything, so a command naming no body was dropped
before it was read. `setCell` is handled ahead of that lookup, which is the one structural change.

**IT DOES NOT EDIT THE DOCUMENT**, exactly as despawn does not delete a node. `WorldState.cells`
holds the run's overrides keyed `nodeId NUL col NUL row` — the same shape and the same NUL reasoning
as `despawned` and `overlaps` — and `applyCells` stamps them onto a derived copy beside the moved
bodies. Stop throws them away and the level is whole; a run leaves nothing on the undo stack.

**THE TILE SAYS WHAT IT BECOMES.** A `?` block declares `vde.bumpsTo` on its TILESET entry and the
rule reads it, so no index is hard-coded in `Rules`, a level may use any sheet, and a brick that
declares nothing simply does not change. `TilesetTile.userData` was already how a tile declares its
`bodyType`, so this adds a WORD to a vocabulary rather than a channel.

**`Number("")` IS 0 AND FINITE, and 0 IS A REAL TILE INDEX** — so an empty declaration would silently
turn a bumped block into whatever tile zero happens to be. The third time this project has paid for
that constant (after `frictionOf` and `speedOf`), and the first time it was checked before shipping
rather than after. CE2 is the mutant; a declared `0` still goes through, which is the other half.

**TWO MUTANTS SURVIVED FIRST TIME, AND BOTH WERE BLIND FIXTURES rather than missing rules.** CE1:
nothing asserted that an override matching the tile already there returns the SAME reference, so
rebuilding a thousands-entry tile array on every frame of a run was invisible — the picture stays
perfectly correct while doing it, which is why the assertion has to be on identity. CE3: every
fixture bumped exactly ONE cell, and starting a fresh map per command loses only the EARLIER ones.
Two cells is the smallest number that can tell the difference.

**WHAT THIS STILL CANNOT DO, and it is the honest remaining half of "acting on events": put a coin
above the block.** That needs a way to bring a thing into EXISTENCE, and all four verbs act on things
that are already there. Spawning wants its own design — an id to mint, a lifetime, and a decision
about what a spawned node belongs to — and inventing it inside a collision resolver is how a physics
loop becomes a game.

**AND A LITERAL NUL BYTE REACHED THE SOURCE AGAIN**, at `World.ts:478` — a `\\0` in a heredoc that
python resolved to the byte rather than the escape. `check-module-headers` caught it, which is what
it was written for after the last time; nothing else notices, because it compiles, bundles and runs.

6 tests, 3 mutants, 3/3 killed.

**Slice 25 — SPAWNING: the fifth verb, the only one that ADDS, and the only derive that runs BEFORE
the step.** Four verbs acted on things that already existed, so a coin could not come out of a block.

**IT INVERTS THE PATTERN THE OTHER FOUR FOLLOW, and that was the finding worth measuring for.**
`applyWorld`, `applyFacing`, `applyPose` and `applyCells` all run AFTER `stepWorld` and feed only the
PICTURE. The app steps against the STORED document, so a spawned node fed in that way would be drawn
and invisible to the physics — not a solid, not a region, not collidable. `applySpawns` therefore
appears TWICE in the frame: once before the step so the world can touch what was made, once in the
render chain so it can be seen. SP3 removes the first and every fixture about position still passes.

**AND IT IS AFFORDABLE BECAUSE NOTHING CACHES.** `stepWorld` re-derives its solids and regions from
the document every step, so a node that appears between two steps takes part in the next one with no
invalidation to arrange. `applySpawns` returns the SAME REFERENCE until something is spawned, which
is every run until a rule says otherwise.

**IT COPIES A TEMPLATE rather than describing a node.** Describing one means naming a type, a
geometry, a style, a source rect and whatever the schema grows next — a second definition of "what a
node is", drifting from the first from the day it is written. A template is a node the AUTHOR made,
in the editor, with every field they wanted. That is Tiled's own shape (`templates/*.tx`) and Mario
Maker's, and it is copied BY SPREAD: the sixth instance of the enumerated-literal bug in this
codebase lost a document's tilesets, and a spawner that enumerated would drop whatever comes next.

**IDS ARE THE INDEX, and that is what keeps the runtime replayable.** The nth spawn of a run is at
index n however the run got there, so `templateId#n` is reproducible and a test asserts it with a
literal. `generateUUID` here would have made a pure, reproducible runtime neither — and SP1 shows it
is invisible to everything except an assertion on the id itself, because every position and every
event stays identical.

**A SPAWNED THING IS A ROOT**, because keeping the template's parent makes `worldOffsetOf` compose a
frame's offset the thing was never positioned against — slice 6's defect arriving by a new route.
SP2 SURVIVED FIRST TIME on a blind fixture whose template was already a root, where keeping the
parent is a no-op; it needed a template nested in a frame at (500,300) to show, and then the coin
asked for at world (100,50) lands at (600,350).

**WHAT IS DELIBERATELY ABSENT: a spawned BODY.** `worldFrom` runs once, at Play, so a spawned node
never becomes a body — a spawned REGION costs nothing because regions are derived per step, and a
coin that SITS above the block is a region. A coin that POPS is a body, and wants `applyCommands` to
mint body state as well as a node. Stated rather than half-built.

**Verified end to end on the real level**, through the whole chain and not a fixture: hitting the
block over the player's start at step 19 turns cell (3,7) from 11 to 31 in the derived document,
leaves the STORED cell at 11, and spawns `coin-template#0` at (54,108) — one cell above the block,
classed `coin`, present in the derived document and absent from the stored one.

5 tests, 3 mutants, 3/3 killed.

**Slice 26 — COLLECTING, and the loop closes: a coin can be made and then taken away.** Slice 25
could spawn one and nothing could remove it.

**DESPAWN WAS ABOUT A BODY AND HAD TO BECOME ABOUT A NODE.** `applyCommands` looked up
`live.get(c.bodyId)` and dropped anything that was not a live body — and a spawned REGION is not one,
because bodies are established ONCE, by `worldFrom`, at Play. So the command channel accepted the
despawn, found no body, and silently did nothing. Despawn now sits above that lookup, records the id,
and removes a body only if there was one. Its meaning is "a node leaves the run", and only some nodes
are bodies.

**AND `applySpawns` MUST NOT MATERIALISE A DESPAWNED SPAWN.** Stamping `hidden` the way `applyWorld`
does would leave an invisible region in the scene, still reporting enters for ever; never making it
is the honest removal. CO1 is that mutant, and it is invisible to any assertion about the COMMAND —
the despawn is recorded correctly and then ignored one derive later.

**A PART SAYS IT CAN BE PICKED UP.** `vde.collect`, on the same footing as `stompable`, `deadly` and
`goal` — not a class table saying `coin` means collectible, which is the refusal `Parts` was built
on, and the corpus's twelve coin objects carry zero properties between them so their word could not
have meant anything anyway. CO2 drops the declaration check and every region entered vanishes: a
checkpoint, a trigger volume and the level's own exit, all gone the first time you walk through one.

**IT RIDES ON `enter`, WHICH IS ALREADY AN EDGE** — a region reports entering once rather than on all
sixty frames the body spends inside it — so collecting cannot fire twice for one pickup without a
set to remember it.

2 tests, 2 mutants, 2/2 killed.

**Slice 27 — A SPAWNED BODY: the coin that POPS rather than sits.** Slice 25 could bring a node into
existence and slice 26 could take it away, but a spawned thing could never MOVE — `worldFrom`
establishes bodies once, at Play, so a node that appears later never became one.

**THE COMMAND MINTS IT, AND THAT WAS THE DESIGN QUESTION.** The other candidate was for
`applySpawns` to add bodies for spawned nodes declaring a `bodyType` — and it is the wrong one:
`applySpawns` returns a DOCUMENT, so letting it write to `world.bodies` would give the runtime a
SECOND producer of world state. `stepWorld` and `applyCommands` being the only two is exactly what
makes a run replayable from its inputs, and it is not worth trading for a shorter diff.

**SO THE COMMAND CARRIES THE VELOCITY, and the RULE decides.** `applyCommands` cannot see the
document, so it cannot know whether a template is a body; the rule can, and does —
`bodyTypeOf(template) === "dynamic"` is the whole test. The channel stays as ignorant of what a coin
is as it already is of what a stomp means. Everything else the body needs has the same default
`worldFrom` gives every other one: at the spawn's position, on nothing, with grip, and facing the
way it was thrown.

**SB2 SURVIVED FIRST TIME, on a fixture that called `applyCommands` DIRECTLY with a body** — which
never asks the rule anything. It took a fixture that bumps a real block twice, with the only
difference being what the template declares about itself, to see it. The same blindness as SP2 and
CE1 and CO1 before it: the assertion has to reach the decision, not the result.

**AND A COMMENT THAT HAD BECOME A LIE WAS FIXED.** `Rules` said "what this still cannot do is put a
coin above the block" — true for exactly one slice. A stale comment in the source is worse than no
comment, because it is read as current.

2 tests, 2 mutants, 2/2 killed.

**Slice 28 — THE COIN THE BLOCK THROWS OUT CAN ACTUALLY BE PICKED UP.** Two defects, both found by
making the LEVEL use what the last three slices built rather than by reading the code.

**COLLECTING READ ONLY `enter`, so slice 27 broke it the moment it landed.** A coin sitting in a
niche declares no `bodyType` and is a REGION — touching it is an `enter`. A coin thrown out of a
block declares `dynamic` and is a BODY — touching it is a `contact`. Letting a spawn MOVE therefore
made exactly the shape a level uses uncollectable. The deadly and goal rules already accepted both
kinds, for this reason; collecting now does too. CO3 is the mutant, and no fixture whose coin sits
still can see it.

**AND A SPAWNED COPY INHERITED `hidden`.** A template is a real node in the document and draws — mine
was parked at y=-100, and the level's bounds start at 0, so "off-screen" was never off-canvas. The
fix is to hide it; the flag then copied through, `dropHidden` removed every spawn from the scene, and
the physics went on colliding with something nobody could see. `applySpawns` now clears it: a
template is hidden BECAUSE it is a template, and its instances are not. **I had written a comment
asserting copies do not inherit it, then checked — the spread copies every field, which is exactly
what it is for, and this is the one that must not be.**

**THE COUNT DID NOT MOVE and the battery said so.** The `hidden` assertions joined an existing test
rather than adding one; bumping `EXPECTED_TESTS` anyway made the run report UNVERIFIED (did not
compile) — which is the pre-flight working, and the fourth distinct way a mutation run has reported
something other than what it found.

2 tests, 2 mutants, 2/2 killed.

**Slice 29 — A SPAWNED THING THAT DRAWS WHERE IT IS.** Found by WATCHING THE APP, and findable no
other way. The coin the block throws out arced 24px up and back down over half a second in the
world, and did not move one pixel on screen for any of it.

**THE DERIVED DOCUMENT WAS RIGHT ON EVERY FRAME**, which is what made this invisible. Measured
before it was touched, because the two candidates — `applyWorld` never writing the position, or the
position being written and never redrawn — have completely different fixes and guessing between them
is what the last four instances each cost. `applyWorld` wrote the body's exact y on all 33 frames of
the flight; `movedIds`, asked the way `App` asks it, named the coin on **none** of them.

**BECAUSE A SPAWNED NODE IS IN NO STORED DOCUMENT.** `movedIds` and `facedIds` both open with
`doc.nodes.get(id)`, and both take the stored document — the only one a caller has. So for the one
node the frame had just invented they answered "no such node, nothing to say", the incremental
geometry kept the matrix it first drew, and the coin sat still. THE FIFTH STALE-DIRTY-SET DEFECT
here, and the first where the node the set was asked about did not exist yet.

**SO THE FIX IS INSIDE THE QUESTION, not at the call site.** `App` is unchanged: both functions now
materialise the spawns themselves. A question no caller can ask wrongly is the only kind that stops
coming back, and this is the fifth time. It costs nothing when nothing has spawned — `applySpawns`
returns the document itself — and the docstring names the one trap it creates: pass the STORED
document, because handing it one that already has the spawns would overwrite the positions
`applyWorld` had just stamped.

**THE BUMPED BLOCK WAS NEVER AT RISK**, and checking rather than assuming is why that is a sentence
here. Tiles are read from the derived document every frame; only POSITIONS come from the cached
`ComputedState`. Confirmed in the running app: the block is brown and spent while playing and orange
again on Stop.

2 tests, 2 mutants, 2/2 killed.

**Slice 30 — THE EDITOR FRAMES THE DOCUMENT IT OPENS.** Reported from use: "the floor should not be
that high up in the first place, and why would it lower when I hit play". Three of my hypotheses
about it were wrong, and each was killed by a measurement rather than by more thinking.

**WRONG 1: the hidden template stretches the level.** `runBounds` is `contentBounds`, which is the
camera clamp AND the death plane, so a template parked at y=-100 looked like it would move the edge
of the world. It does not — bounds are identical with it and without it. **WRONG 2: empty rows below
the ground.** The tilemap's lowest non-empty row is its last; there are none. **WRONG 3: Stop is
drifting.** Stop restores the pre-Play viewport to the PIXEL — 0px on all four layers, measured
across a run that drove the camera 264px.

**WHAT IT ACTUALLY WAS: nothing ever framed the document.** `EditorState`'s viewport starts at
`{ x: 0, y: 0, zoom: 1 }`, and no code moved it on load — so a document opened showing whatever sat
at the world ORIGIN. For a level whose ground is at the bottom of its map that is sky, with the
ground high and a void beneath; for a document authored away from the origin it is nothing at all.
PLAY looked right only because the follow camera clamps to the level's own extent, which is the
framing the editor never did. `viewportToFit` had existed, tested, reachable from one menu item —
the same reachability shape as Escape and the GPU backend.

**AND FIT WAS THE WRONG QUESTION, which only the running app said.** Framing on load with
`viewportToFit` put the 3618x270 level at zoom 0.15, occupying **7.9% of the canvas**, every tile
under three pixels. **SO WAS "ACTUAL SIZE", which took a second measurement and a second report to
see.** An 8-bit level is fifteen tiles tall by construction and its ground occupies four of them —
proportions that are CORRECT in the document and only look wrong on screen. Opening it at 100% on an
885px canvas shows forty-nine rows of a level drawn for fifteen, so the horizon lands a fifth of the
way down with sky beneath it. The pixels were honest and the picture was wrong, and my first answer
to that — deepening the level's floor until it covered the frame — treated the symptom, wrecked the
level's proportions, and tripled how long a pit took to kill (0.47s to 1.27s, measured). It was
reverted.

**`viewportToOpen` FILLS THE VIEW instead.** A document that fits at actual size or larger is framed
exactly as the menu frames it; one that does not has its LOOSER axis set the zoom, so one axis
matches the canvas exactly and the other opens at the document's own start. No padding on the filled
axis — a margin there puts background where the document should be, which for a level is sky under
the floor. A wide level opens on its beginning at the scale a screen of it was drawn for; a tall one
opens on its top. Measured on the real level: the ground is **21% of the canvas** where the ask was
a quarter or less, and the sky is the rest.

**AND WHAT SET THE DOCUMENT'S HEIGHT WAS NOT THE LEVEL.** Filling the view left a band of sky under
the floor anyway, and the arithmetic said why: the framing chose 176% where 188% fills a 474px
canvas, which is 474/270 rather than 474/252. The terrain is 14 rows; the two DECORATIVE parallax
layers were still 15, their last row entirely empty, and a left-wall rectangle was still 270 tall.
`contentBounds` is the union over every node, so an empty trailing row in a layer that draws nothing
there set the document's height — and with it the open framing, the camera clamp and the death
plane. The third instance of a geometry-derived value moving for a reason that had nothing to do
with it, after the parallax dirty set and the spawned bodies. Trimming the empty tails put the
ground at **21.5% of the frame** with nothing below it.

**STILL OPEN, and stated rather than fixed:** the background is painted in SCREEN space
(`svg.style.background`) by every backend, deliberately — a level three screens wide needs no
three-screen rectangle behind it, and in PLAY that is simply correct. The cost is that the EDITOR
gives no indication of where the document ends, so a framed level still floats in an unbounded sky.
That is a decision about what an editor shows, not a defect in the runtime.

4 tests, 3 mutants (VO1-VO3).

**Slice 31 — THE DOCUMENT DECLARES ITS SCREEN (schema 72), and the editor draws it.** The user
asked for a cue where a level ends, and to look at how Unity, Godot and GameMaker handle it first.

**THE RESEARCH CHANGED THE RECTANGLE.** I was going to outline `contentBounds`. Both engines that
have a document outline ONE SCREEN instead: Godot draws its project viewport as four translucent
lines (`editors/2d/viewport_border_color`, `Color(0.4, 0.4, 1.0, 0.4)`, on by default — read from
`canvas_item_editor_plugin.cpp`, not from documentation), GameMaker outlines its room views, and
neither dims anything outside. Content past the edge is NORMAL in a scrolling level; the question a
boundary answers is "what does the player see at once", and nothing in this document could answer
it — `contentBounds` measures where things happen to be, which is how an empty scenery row moved
the death plane in slice 30. Unity was the third data point and turned into its own lesson: the
quote I first offered for "scenes are unbounded" was invented by a search summariser and its URL
404s. Retracted, re-verified from pages actually fetched, and recorded as a rule — quote only what
came out of a fetch.

**`Document.screen` IS A SIZE, NOT A RECT** — anchored at the origin like Godot's, because the one
document whose play area starts elsewhere can move its content, and two more numbers would be two
more numbers every consumer must remember to add. Absent means undeclared, which is every pre-72
document: drawing nothing, changing nothing. Validated FINITE AND POSITIVE and nothing else.
`SetScreenAction` ships in the same commit — the clips/tilesets rule, third time it has needed
following. The outline is CHROME: four `role: "guide"` lines emitted FIRST in the render model's
overlay, hairline at every zoom, clicks passing through; never a node, never exported. A Tiled
import declares the map's own pixel size in the same transaction and never resizes a screen the
document already has — the background's two rules, applied to the field beside it.

**STILL OPEN, stated:** nothing READS the screen yet. The follow camera still clamps to
`contentBounds` and the death plane still derives from it; pointing both at a declared screen is
its own slice, and doing it silently inside this one would have changed how every existing level
plays.

6 tests, 3 mutants (DS1-DS3 — DS because SC was already the setCell family; the EX1-EX7 collision
lesson, checked before writing this time).

**Slice 32 — THE RUNTIME READS THE SCREEN: `playBounds`.** The gap slice 31 stated, closed the next
slice rather than silently inside it. A declared screen now pins the run's VERTICAL extent — the
death plane and the camera's clamp — while the horizontal span stays measured, because a
side-scroller is as LONG as its content but as TALL as one screen: SMB1 scrolls five screens of
length and not one pixel of height, and its pits kill at the screen's bottom even though the shaft
is drawn below it.

**THIS IS THE SLICE-30 DEFECT CLOSED PROPERLY, not worked around.** Trimming the empty scenery rows
fixed the LEVEL; any future decoration below the floor would have moved the death plane again,
because the play area was a measurement. It is now a statement: the fall-time fixture reproduces
the deepened-floor shape (content 900 tall, screen 220) and dies in less than half the steps, with
the level's 3618px width asserted untouched — the axis a screen must never pin.

**WITHOUT A SCREEN, `playBounds(content)` RETURNS THE SAME OBJECT** — not an equal one — so every
pre-72 level plays identically by identity, not by coincidence.

**STATED LIMIT, in the docstring rather than discovered later:** a vertically scrolling level wants
the opposite axes and is not served; its author should not declare a screen yet. The tower level on
M18's ladder will find this hole, which is what the ladder is for.

4 tests, 3 mutants (RB1-RB3; RB3 is the Escape-key shape — the app not asking).

**Slice 33 — A DECLARED SCREEN IS ALSO WHAT YOU OPEN ON.** The other half of what `playBounds`
closed: the death plane stopped being a measurement in slice 32, but the load-time framing still
measured `contentBounds`, so decoration below the floor still moved what you SAW on open — content
900 tall put the ground back near the top of the frame, the original complaint by a new route.

**MY FIRST ANSWER WAS WRONG, AND THE COMMIT SAID 188% BEFORE THE APP SAID 126%.** I handed
`viewportToOpen` the screen rect and claimed the fill branch would run; on the real 613x474 canvas
the screen FITS at zoom 1.26, so the FIT branch ran, centred it, and put a band of background under
the floor — the reported defect, back by the route built to remove it. Its FILL branch is wrong the
other way: on a WIDE canvas cover picks the horizontal ratio and crops the ground off the bottom,
so a maximised window would open on sky. The claim shipped in a commit message before the live
check ran, which is exactly what verify-before-declaring-done exists to prevent.

**`viewportToScreen` PINS THE VERTICAL AXIS INSTEAD** — the same axis rule `playBounds` gives the
run, now one rule for the whole feature: `zoom = canvas.height / screen.height`, origin at the
screen's. Height exact on EVERY canvas shape, so the ground a game keeps at the bottom of its
screen is at the bottom of the canvas — no bands, no crop, on narrow and wide alike. The declared
path computes no geometry at load; the measured path survives as the fallback every pre-72
document uses. Verified in the app on both levels — trimmed and wrecked open IDENTICALLY at 188%,
because they declare the same screen.

1 test, 2 mutants (VO4 re-authored on arrival — its first anchor was the falsified approach — and
VO5, which needs a second aspect ratio to see). And the third `
`-became-a-real-newline generator
failure in two days — one in a mutant anchor, one in a test regex, one here — each caught by the
next gate in line.

**Slice 34 — POWER AND BREAKING: Mario's own eligibility, each clause a declaration.** The ask was
the full block-hit taxonomy — a block can pop a power-up or coins, can give nothing, and bricks
break by Mario's rules. Decomposed against SMB1: a ? block pops its authored content and becomes
spent, never breakable; an EMPTY brick gives nothing and breaks — but only under Super; a brick
WITH contents acts like a ? block, contents win, no shatter; small Mario hitting a brick gets
nothing at all.

**THE MEASUREMENT CAME FIRST AND FOUND A LIVE DEFECT: the app had an INFINITE ? block.** The run
recorded the cell override, but the step and the rules read a document nothing stamped it onto — so
the spent block's original tile still declared its contents, and every re-hit popped another coin.
Measured headlessly: 2 spawns where the level authors 1. The step chain is now
`applyCells(applySpawns(base))`, which closes that and is also what lets a broken cell stop being
solid — one fix, three consumers.

**`Body.power` (0 is small), the `setPower` verb, `vde.powers` on a collectible, `vde.breaks` on a
tileset tile.** The rule keeps SMB1's arithmetic — the HIGHER tier survives, so a mushroom does
nothing for Fire Mario — and the channel records the absolute result. Breaking is `setCell` to
EMPTY (-1): the run's override, never the file; Stop restores the brick. Eligibility is all three
clauses in one guard: declares `vde.breaks`, has no contents this hit delivers (contents win), and
the BUMPER's power is above small. Not resized: SMB1's Super is also taller, and resizing a body
changes every collision — a separate decision, stated not smuggled.

**AN HOUR OF DEBUGGING THAT WAS THE FIXTURE, with the engine right all along.** The block-hit
fixture seeded the body 6px INSIDE the floor; the horizontal resolver read that overlap as a wall
and shoved the body sideways out from under the block, so the jump rose through empty air. Found by
instrumenting the vertical pass and reading the query box: x=36 where the body was seeded at 20.
The fixture comment now warns the next author.

**AND THE ARC REPLAY FOUND A SECOND LIVE HOLE: a HIDDEN dynamic template became a real body.**
`worldFrom` minted the parked mushroom template, it fell from its parking spot through the sky, and
the player collected the TEMPLATE mid-level — the first level to park a dynamic template is what
exposed it. `hidden` already means "out of the displayed scene"; the world now honours the same
word in `worldFrom`, `solidsOf`, `regionsOf` and `tileSolidsNear`. A spawned COPY still lives,
because `applySpawns` clears the flag — the mould stays a mould, the casting is real.

Verified end to end on the real level, stepped exactly as the app steps: small hits the brick —
nothing, no spawn, still small; the power block pops the mushroom (block spent to 31, the mushroom
arcs and lands on it); collected — power 1; back to the SAME brick as Super — broken to -1, and the
physics walks through the hole.

8 tests, 5 mutants (PW1-PW2, BR1-BR3). PW1 is the seventh field-by-field body literal doing what
the sixth did — dropping a field — and BR3 is -1 vs 0, which "the cell changed" cannot see.

**Slice 35 — THE MULTI-COIN BRICK, its window read off the disassembly.** `vde.paysFor` declares a
payout window in SECONDS from the FIRST hit: every hit inside it pays without converting, and the
first hit past it pays AND converts — the original's own behaviour, where the timed-out hit still
yields its coin while writing the spent metatile. The number is derived, not quoted:
`BrickCoinTimer = $0B` ticks of an interval timer that fires every 21 frames — 231 frames, 3.85
seconds — and the LEVEL declares it, not the engine.

**THE STATE IS THE RUN'S: `WorldState.cellClocks`,** written only by the idempotent
`startCellClock` command, keyed like the cell overrides, dead at Stop like everything else. ONE
DECLARED DIVERGENCE: SMB1's `BrickCoinTimerFlag` is GLOBAL — every coin brick in an area joins one
countdown — which is one flag byte's quirk, not a design; ours is per cell. Absent `paysFor` is
byte-identical to before: first hit converts.

2 tests, 3 mutants (MC1-MC3; MC2 is the clock-refresh, killable only because the fixture's third
arc is inside the window measured from the SECOND hit and outside it measured from the FIRST).
And the FIFTH 
-became-a-newline generator failure — the fix is now line surgery by quote parity,
not more careful escaping.

**Slice 36 — THE STAR AND THE 1-UP: spawned movers, and what collecting them means.** Everything
measured before built. The star's duration is the disassembly's: `StarInvincibleTimer = $23` ticks
of the 21-frame interval — 735 frames, 12.25 seconds — declared by the LEVEL as `vde.stars`. Its
motion is the disassembly's too: `MoveJumpingEnemy` + `EnemyJump`, a body that never rests, is
`vde.bounces` — an apex HEIGHT whose speed comes through the same identity every jump uses, no new
constant — composed with `vde.patrol`, which already set velocity every step, airborne included.
The 1-up needed NOTHING new to move: patrol iterates `world.bodies` against the live document, so a
spawned body walks — measured, not assumed.

**WHAT COLLECTING MEANS, in the corpus's own shapes.** A star grants invincibility until an ABSOLUTE
world time (`Body.star`, the `setStar` verb — rules own the now+duration arithmetic); a starred
player's deadly contact DESPAWNS the enemy instead of ending the run, which is SMB1's star. A 1-up
is its counter: `WorldState.tallies`, keyed by class, written by the `tally` verb on every classed
collect — `CoinTally` and `NumberofLives` are both exactly this, so coins now count too. NOT built:
lives-as-respawn, which is a run-restart system, not a number.

**THREE FIXTURE DEFECTS BEFORE ANY CODE DEFECT, all mine:** the bounce test read `onGround` after
the bounce command had already cleared it (rebounds are vy sign flips); the star overlapped the hero
at step 0 and was collected at t=0 when the collect TIME was the test's whole content; a single
shove decayed under friction and the enemy stalled short of contact. The engine was right each time.

4 tests, 5 mutants (BN1-2, ST1-2, TY1). ST2 is absolute-vs-relative time, visible only to a fixture
that collects later than its star's own length.

**Slice 37 — THE HUD: the run state that was visible only in a debugger.** Tallies, the power tier
and the star clock all landed as world state nothing rendered — the fifth invisible field this
project has caught, and the standing reachability lesson applied to itself. `runReadout` is the
pure half: every tally in first-collected order, the controlled body's power, and a star countdown
CLAMPED AT ZERO (a HUD counts down and stops; how long ago protection ended is nobody's business).
The strip is chrome in `App`, over the canvas only while a world runs, reading fresh each frame the
play loop already repaints. 1 test, 2 mutants (HD2 is the strip never drawing — the disease itself).

**Slice 38 — THE RUN TIER, every number a ratio of the walk.** SMB1's caps are $18 and $28 — 5/3
exactly — and its acceleration bytes $98 and $e4 — 3/2 exactly; `RUN_SPEED` and `RUN_ACCEL` are
those RATIOS, not absolute numbers, so the relationship cannot drift (slice 17's trap, applied).
The tier is chosen by the BUTTON — `Input.run`, both Shifts — which was the correction the research
made in slice 17 and is now load-bearing. A full-run jump is 25% taller (`RUN_JUMP_BOOST` on the
HEIGHT, gated on a speed only the run tier reaches, so the whole arc scales by one ratio).

**AND THE EASE-BACK CLOSED A LATENT UNBOUNDED-SPEED DEFECT** found by asking what the clamp does
the step after: it only catches the step that CROSSES a cap, so releasing run at full speed left
the body above a cap nothing re-checked, and every pushed step accelerated it further, forever.
Above-cap-and-pushing now eases down at the walk rate — what releasing B does in the original —
landing exactly on the cap.

4 tests, 4 mutants (RS1-RS4; RS4 is the ease, visible only to a fixture that releases run at full
speed and watches the next fifteen steps).

**Slice 39 — PIPES: down inside a warp region moves you where the author pointed.** `vde.warpsTo`
names a NODE, not coordinates — the same reason `vde.spawns` names a template — and the ideal
anchor is a HIDDEN node, which slice 34 made mean "out of the world entirely": it neither draws nor
collides, it only names a place. The gesture is the original's: DOWN while inside, a STATE read
that needs no latch because the teleport un-makes its own condition. The `teleport` verb lands you
standing ON the anchor, centred, at rest — pipes emit you standing still, and 366 px/s of run speed
carried through a warp would fling you off the destination.

**AND THE RULES CAN NOW SEE THE BUTTONS** — `ctx.input`, optional. The rules are the game, and a
game reads its buttons; every rule written before this reads nothing from it. The app passes the
run's input and CUTS the camera on a teleport of the controlled body (the follow camera closes a
fraction per step, so a 3000px warp would swoosh across the whole level; the original cuts).

**IN-DOCUMENT, deliberately.** SMB1's 1-1 underground is an area of the same level, and a filmstrip
of areas side by side inside one document needs no document-loading machinery, no run-state
hand-off, and no new bounds rules — the camera clamp already spans the content. A warp to a
DIFFERENT document is a real thing this is not; stated, not smuggled.

2 tests, 3 mutants (WP1: fires on touch; WP2: velocity carried through; WP3: one sign, and every
pipe dumps its traveller a body-height too low).

**Slice 40 — RUN FLOW, TYPED ENTITIES AND CROSS-DOCUMENT LEVELS.** Restart now constructs a clean
world from the current document. Respawn reconstructs the level at a typed anchor while preserving
the run's tallies and player power. A typed goal may name a sibling project document; Electron
confines that relative path to the opened project's directory, reads a bounded `.vde`/`.json` file,
fully validates it, and only then adopts it as the next level.

Schema 73 gives nodes and tiles engine-owned `entity` fields for body, player, respawn, transition,
warp and rule declarations. Migration and Tiled import project recognized legacy `userData` into
that typed shape without deleting the original metadata, and runtime readers keep a compatibility
fallback. Tiled tilesets now preserve and export classes, typed properties, collision objects,
animation frames and wangsets. Runtime animation follows authored millisecond frame durations;
collision currently consumes each authored shape's AABB, so exact polygon/ellipse narrow phase is
still open.

10 focused tests across entity migration/projection, restart/respawn, transition adoption and rich
Tiled metadata, plus the Electron production smoke gate.

**Slice 41 — SHARED CLIP PLAYBACK AND CONTROLLERS (2026-09-05, schema 77).** `ANIMATION-001`
is delivered: an extracted clip browser/editor, inclusive-loop/one-shot preview, persisted per-node
states and ordered transition conditions, independent transient clocks, and fixed-step runtime
adapters. Controllers drive descendants until a nested controller owns its scope. 2D movement,
ground/air, contact/region/bump events and outcomes can trigger transitions. 3D supports movement,
outcomes and completion; its composed 2D surfaces now sample tracks and sprite atlas crops.
Actions, migration, round trips, DOM authoring and Electron author/play/save plus GPU crop pixels
have coverage. Native glTF clips/skinning, crossfades and instance expansion remain separate work.
See [Animation workflow](docs/ANIMATION.md).

**THE GAUNTLET VERDICT ON THE 8-BIT RUNG (2026-08-20)** — a Gauntlet Loop pass (Shumer's method:
agent-side decomposition, fresh-context critics, a fetchable bar) judged the rung piece by piece
against REAL SMB1: the disassembly with line citations as the mechanical bar, the classic 1-1
screenshot as the visual bar, and fresh engine measurements as our side. Eight pieces, eight
critics: **2 MATCH the bar, 6 LOSE.**

MATCHES: **jump-arc** (all three heights land in SMB1's tile envelope; noted gap: our gravity is
~half SMB1's in tile units, so an equal-height jump hangs ~25% longer — floatier) and
**item-timers** (coin window and star duration exact to the frame; noted gap: no star-expiry
warning — SMB1 slows the flash and reverts the music, ours switches off).

LOSSES, each with the critic's single most valuable fix:
- **ground-speeds** — our caps are 12.2/20.4 tiles/s against SMB1's 5.625/9.375: the RATIOS are
  exact (5/3 cap, 2x skid) but the absolute tile-scale is ~2.17x too fast, and time-to-cap 0.25s
  vs ~0.67s means far less inertia. A FEEL DECISION, not a bug — but now a measured one.
- **blocks-and-pickups** — `superHeightChange`: SMB1 gates its whole brick branch and its damage
  downgrade on PlayerSize (asm 7223-7225); without the taller hitbox the tiers are palette swaps.
  Fragments and fireballs queue behind it.
- **enemy-interactions** — the Koopa SHELL lifecycle (stomp-to-shell, kickable, shell-vs-enemy
  chain kills); three of the four missing interaction classes hang off that one mechanic. Also
  structurally absent: side-contact injury tiers, a stomp-immune Spiny, points.
- **hud-and-meta** — a persistent status bar driven by a real countdown TIMER is the spine (hurry
  music at 100, death at 0, time-to-score at the flag); audio=false silences every event SMB1
  announces. Our tally HUD covers none of the six meta systems.
- **scene-grammar** — the level composes like a physics test: isolated single blocks where SMB1's
  unit is the CLUSTER (?-brick-? runs with airborne coins above), no free coins in frame, no
  decoration vocabulary at the ground line. LEVEL AUTHORING, not engine.
- **art-fidelity** — the enemy sprite reads as a PLATFORM (faceless rounded slab); the popped coin
  is a raw yellow rectangle; the style is pastel-modern, not NES. Function-legibility failures,
  named concretely.

THE METHOD EARNED ITS KEEP: the critics found things this project's own reviews had not framed —
the per-tile speed scale (our slices verified RATIOS against the disassembly, never the absolute
tile rate), the timer-as-spine observation, and "the enemy reads as a platform", which no
mechanics test could ever say.

**THE GAUNTLET VERDICT ON THE ENGINE ITSELF (2026-08-20)** — a second Gauntlet pass, this time over
Canvas Fogworks as an engine, judged code-against-code: Godot 4.4 source on disk (tilemap, tileset, the whole
2D canvas editor plugin), LDtk's published schema, Unity's RuleTile, Aseprite/Godot/GameMaker/Tiled
docs fetched and placeholder-checked. Ten agents, 294 tool calls of reading both sides. **1 MATCH,
8 LOSE** — with per-piece strengths named, several genuinely above the bar.

THE MATCH: **testing-quality.** The critic's words: the mutation harness is "genuinely above the
bar" — Godot has no mutation testing and its 6,410-line canvas editor has zero tests, against our
39,077 test lines on 52,137 source lines. **At the time of the 2026-08-20 verdict**, two absences
held it to MATCHES: no automated enforcement and no end-to-end full battery after 2026-08-12.
The battery completed on 2026-08-21; CI, semantic docs, installer build and startup gates landed
2026-09-02. Hooks and the broader M17 UI/recovery tiers remain open.

THE LOSSES, each with the critic's one most valuable fix:
- **tilemap-autotile** — side/edge-aware matching: our only model is the corner dual-grid; Godot
  ships three modes, Unity full 3x3 neighbor rules, LDtk rule groups with chance and modulo.
- **runtime-physics** — RUN FLOW shipped in schema 73: restart clears a run, respawn uses a typed
  anchor while retaining tallies/power, and typed goals can load confined sibling level documents.
- **animation** — REACHABILITY CLOSED 2026-09-05: clip browsing, preview and state-driven
  runtime playback ship in slice 41 beside the existing distance-driven pose. Native glTF animation
  and skinning are recorded separately in `ANIMATION-002`.
- **editor-canvas** — GRID SNAPPING CLOSED 2026-09-02: move and resize use the same zoom-adaptive
  step the renderer displays, composed with smart alignment under the existing 6-screen-pixel budget.
- **art-paint** — selection CONTENT CLOSED 2026-09-02: the marquee row exposes move, cut, copy,
  paste, clear, horizontal/vertical flip and clockwise quarter-turn. Operations preserve mask holes,
  clip at surface edges and commit through the undoable surface action.
- **document-format** — TYPED ENTITY FIELDS shipped in schema 73: validated body, player,
  respawn/transition references and runtime-rule values replace engine dependence on verbatim text;
  legacy and imported `userData` remains intact and readable as a compatibility fallback.
- **interop** — the TILESET half of TMX now preserves and exports per-tile collision, animation
  frames, wangsets, classes and per-tile properties. Play mode resolves tile animation from world
  time; AABB physics consumes collision bounds. Exact curved/polygon narrow-phase remains open.
- **rendering** — FLAT-SURFACE LIGHTING PARITY CLOSED 2026-09-02: SVG and Canvas now consume the
  same ambient + coloured directional Lambert sum as WebGL, in explicit sRGB component-transfer
  filters, while backgrounds and editor chrome stay unlit. A production Electron pixel smoke test
  guards Canvas's URL-backed filter path. Mesh-relief per-fragment normals and self-occlusion remain
  WebGL's higher-fidelity path. (Named strength: the one-quad GPU tilemap beats Godot's per-cell quadrant
  items; the round-trip TMX writer beats what Godot/Unity ship natively.)

DEFECT-GRADE FACTS THE PASS PRODUCED (acted on or queued): TESTING.md's suite itemization summed
to 2013 under a correct 2020 total — `confine.test.ts` omitted, a drift class the doc-drift tool
cannot see; fixed same day. The full-battery run is queued. The TMX silent drop and flat-surface
lit-unlit backend divergence have since been closed.

**THE FIRST FULL BATTERY RUN, AND WHAT IT COST TO GET (2026-08-21).** Two attempts. The first
degraded partway and reported 96/402 with the tail failing at "0 tests" in 10s each — a report
about the MACHINE, not the code: 402 consecutive jest spawns leak workers and cache state until
later invocations starve, and 28 zombie node processes kept the box degraded into the next
morning (an isolated mutant that takes 18s healthy timed out at five minutes). Kill the workers
by COMMAND LINE, never `taskkill node.exe` — the session itself runs on node. The second attempt,
on a cleaned machine: **350/402 KILLED, both intended-survivor controls SURVIVED (harness sanity
holds on a full run), one real survivor, and the last 49 again UNVERIFIED at 0 tests** — the same
exhaustion at a different index, so it is hours-of-spawns, not any specific mutant. The 49 rerun
clean in a fresh batch the same day: **50/50 killed (the fiftieth being RU1 under its new fixture),
37s per mutant — so the battery's first complete verdict is 400/400 killable mutants killed, the
only survivors the two controls, by design.** The run's own bookkeeping fumbled twice before the
progress page told the truth: a `| tail` pipe kept six lines of the first log, and a
stdout-redirect launcher buffered the second into a `process.exit` void — capture to a plain file,
nothing cleverer. **HARNESS LESSON CLOSED 2026-09-02:** every suite now runs in-band, the Jest
cache is cleared after each 50-mutant batch, and a zero-test result aborts the run immediately
instead of unverifying everything after it.

**RU1 WAS THE ONE REAL SURVIVOR, and it had drifted rather than lied.** Authored when stomps were
class-inferred, its blast radius shrank as the parts vocabulary landed, until its only observable
difference was: a REGION declaring `vde.stompable` gets despawned and bounced off when landed on —
an `enter` carries a side too, which is what made it look right. No fixture had ever put stompable
on a region, so the contract was never said out loud: a stomp squashes a BODY; a volume is not
squashable, whatever it declares. The fixture now says it. 1 test.

**STILL NOT DONE**, each a decision rather than a measurement: acting on an event (spawning, scripts,
level transitions), slopes, rotation, restitution, and anything configurable about the keys. The corpus's other property vocabulary — `spawncount`,
`spawntype`, `script`, `triggering`, `map` — is the map of what comes next.

---

## Phase 19 — 3D Foundation

### Milestone 19 — Versioned 3D contracts ✅

Canvas Fogworks' 3D work begins as an extension of the working document and runtime boundaries,
not as a merge of the preserved first engine. The first slice defines typed 3D
transforms, cameras, lights, asset-backed renderables, materials and colliders; imports
one minimal owned glTF fixture; and proves save/load plus Action undo/redo before a
viewport is added.

The staged architecture, adoption rules and explicit legacy boundary are in
[`docs/3D-FOUNDATION.md`](docs/3D-FOUNDATION.md). The Morphic/Hold source snapshot is
preserved under [`legacy/morphic-engine`](legacy/morphic-engine/README.md) at revision
`a414cde62fcec4ead3d52172b7441fadf608fb56` as evidence and reference code, not as a
runtime dependency.

**Slice 1 landed (schema 74):** `Spatial3D.ts` defines distinct 3D transforms, perspective and
orthographic cameras, directional and point lights, asset-backed renderables, box/sphere colliders,
and stable mesh/material/texture records. `SetSpatial3DAction` and `SetAssets3DAction` provide the
only write paths; Integrity and Serializer share their validation, schema 73 migrates without
inventing state, and undo/redo plus round-trip tests pin the contract. The owned `triangle.gltf`
fixture proves hierarchy transforms, indexed geometry, normals, UVs and material slots through the
existing Khronos-aligned reader. The next slice was **3D-1 viewport proof**, not a legacy renderer merge.

**Slice 2 landed (3D-1 complete):** `Scene3D.ts` derives a backend-neutral frame from the
schema-74 node hierarchy and a transient asset-id mesh library, with distinct perspective and
orthographic projections plus camera-pose inversion. `emitWebGL3D.ts` submits indexed triangles,
enables depth/culling, and retains an RGBA8 plus depth framebuffer for synchronous color-id picking.
A deterministic software capture pins projection, hierarchy, winding, depth and picking in five
tests. The live 3D workspace imports confined glTF/GLB files as one undoable asset/model/camera
transaction, renders through that backend and selects nodes through GPU ids. `smoke:3d` verifies
indexed depth rendering and readback against Electron's real GPU path. 3D-2 begins with rehydrating
persisted project-relative mesh sources after reopen, then adds gizmos, materials and lighting.

**Slice 3 started (3D-2):** import now normalizes model sources against the saved project and
refuses assets outside that root. Opening a project reloads each persisted mesh through confined
IPC into the transient library; failures are isolated per asset, and asynchronous results cannot
leak across a later project switch. The Open–Edit–Save Electron smoke now waits for a restored mesh
id in the GPU draw list before editing and saving. A selected 3D node now has fixed-screen X/Y/Z
translation handles with world/local orientation, parent-correct movement, Action-backed undo and
an Electron drag/save assertion. Color-coded rotation rings add normalized local/world quaternion
composition; local scale handles preserve non-zero schema-valid components. Imported glTF materials
now receive stable source-fragment asset ids, can be reassigned per primitive slot, and carry
base-color plus `KHR_materials_unlit` into rendering. Authored directional and point lights use node
world transforms, a bounded four-light WebGL diffuse path, Khronos range attenuation and a matching
CPU reference capture. The Electron smoke performs all three gizmo edits, resolves the persisted
material, renders a directional light, creates a point light through the UI, and verifies every
authored result after save. Alt/middle drag now orbits the authored camera around the selected object,
Shift adds camera-plane panning, and the wheel dollies perspective cameras or scales orthographic
views; all poses remain Action-backed. Rehydrated glTF materials now carry metallic, roughness,
emissive, base-color textures and linear G/B metallic-roughness textures into a GGX/Schlick WebGL
path. Texture RGB is decoded from sRGB as glTF requires, shared images are read/uploaded once, and a
neutral roughness-aware environment term keeps metals legible without authored punctual lights.
The live Electron smoke loads a real texture into the GPU cache and serializes an orbit gesture.
Normal and emissive maps, glTF sampler state, two UV sets, `KHR_texture_transform`, and sorted
OPAQUE/MASK/BLEND rendering are now live. The GPU smoke compiles the exact production shader rather
than a stand-in. Schema 75 adds an authored environment component referencing a project-relative
Radiance texture asset. Import and reopen decode bounded flat or scanline-RLE RGBE into transient
linear floats; the inspector edits intensity and horizontal rotation through Actions, and WebGL
samples the equirectangular map with a neutral fallback when float textures are unavailable.
**Slice 4 landed (3D-2 through 3D-4 baseline):** schema 76 makes 2D-in-3D composition explicit as
an authored plane or billboard. HDR environments are offline-convolved into diffuse irradiance and
GGX roughness prefilters; the WebGL 1 path reserves its eighth texture unit for a fitted,
RGBA-packed directional shadow map. Renderer resources have eager disposal, bounded uploads,
capability reporting, source invalidation, clean reload and context-loss restoration. The new
transient 3D runtime projects authored bodies/colliders, advances deterministic fixed steps,
queries collisions, follows the controlled body with the camera, and covers restart, respawn,
cross-document transitions and replay digests. The Electron GPU smoke compiles these production
shaders and exercises recovery and clean reload.
