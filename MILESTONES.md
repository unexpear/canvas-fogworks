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
M1  Computed State           ⬜   separate stored intent from calculated results
      │
M2  Layout Engine            ⬜   constraints replace absolute positions
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
editor tools, and the Electron shell already exists (originally built as "Phase 1").
It proved the Document↔Renderer independence, but it currently reads node geometry
**directly**. Under this plan it will be **re-derived to consume `ComputedState`**
once M1–M2 land, at which point M3/M4 become "formalize + complete," not "build from
zero." See `docs/ARCHITECTURE.md` § *Current vs. target data flow*.

---

## Phase 0 — Foundation

### Milestone 0 — Deterministic Document Engine ✅ 🔒
**Goal:** prove the document can be safely modified through validated, reversible actions.

**Deliverables (all present):** `ProjectDocument` · `Node` model · UUID identity ·
**scene graph** (`rootNodeUuids` + `parent`/`children`, authored via `AddNodeAction`
`parentId` + `ReparentNodeAction`, traversed by `traverseSceneGraph`) ·
`Action` interface · `ActionDispatcher` · `MutationResult` · `HistoryManager` ·
Undo/Redo (with coalescing; the initial revision is never evicted) · revision system ·
JSON serialization (schema version decoupled from app version) ·
**validation** (Action-path `validate()` **and** `validateDocumentIntegrity` on load:
ranges, dangling parents, ghost roots, cycles) · **89 automated tests**.

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
`docs/API-CONTRACTS.md`, `docs/README.md`, and this `MILESTONES.md` — all
independently verified against the code by an adversarial review pass.

**Rule (authoritative statement in [docs/README.md](docs/README.md#the-freeze-rule)):**
a change to a frozen contract ships in the *same* change as the doc update **and** a
test. Only a change to the **persisted document shape _or the interpretation of a
persisted field_** additionally bumps `SCHEMA_VERSION` (plus a `migrateIfNeeded`
step) — never bump it for anything else, and note that the app version moves
independently. This is the primary defense against architectural drift as the
engine grows.

---

## Phase 1 — Computed State Pipeline

### Milestone 1 — Computed State ⬜
**Goal:** separate stored *intent* from calculated *results*.

```
Document → Geometry Engine → Computed State → Renderer
```

**Deliverables:** `ComputedState` · `GeometryEngine` · transform calculation ·
parent↔child transforms · coordinate spaces · bounding boxes · matrix math ·
dirty-state tracking · renderer adapter (may still be a stub). **No UI required.**

#### Prerequisites — ✅ all met (the seam is in place)

| # | Prerequisite | Status |
|---|--------------|--------|
| 1 | Scene-graph traversal helper used by renderer + layers panel | ✅ `traverseSceneGraph`; draw order is tree order, not `Map` order |
| 2 | Coordinate-space rule written into the schema; transform reserved | ✅ **stored `x/y` is parent-relative**, world is computed; rotation reserved for a future optional `Node.transform` (see [DOCUMENT-SCHEMA.md](docs/DOCUMENT-SCHEMA.md#coordinate-space-the-m1-contract)) |
| 3 | Drag previews as a computation **input**, not a renderer bypass | ✅ `EditorState.pendingGeometry` → `computeWorldGeometry(doc, pending)`; a parent drag now moves its children |
| 4 | Undo/redo reports a real dirty set | ✅ `restoreNotification` diffs outgoing vs restored; `fullReload` kept as an alias hint |
| 5 | Hit-testing off computed state, not DOM | ✅ `hitTest(computed, x, y)`; `SelectTool` no longer reads `data-node-id` |

**What M1 actually changes:** `computeWorldGeometry` is translation-only and
geometry-only. `GeometryEngine` replaces it as the *producer* (matrices, rotation,
bounds) and `ComputedGeometry` widens into `ComputedState`. Every consumer already
reads the computed structure, so this is a producer swap, not a consumer rewrite.

---

## Phase 2 — Layout Engine

### Milestone 2 — Layout Engine ⬜
**Goal:** replace absolute positioning with layout computation.

**Systems:** constraints · anchors · alignment · margins · padding · containers ·
flex · grid · intrinsic sizing · responsive rules.

The document stores **"center inside parent"** instead of **`x = 240`**.
(The `Node.layout` field already reserves the shape for this — see the schema doc.)

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
