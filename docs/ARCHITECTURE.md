# Architecture

<!-- describes: src/core/actions/ActionDispatcher.ts, src/core/actions/applyMutations.ts, src/core/actions/HistoryManager.ts, src/core/geometry, src/renderer -->

> 🔒 Frozen contract · schema v18 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins; see MILESTONES.md for deferred layout deliverables) + M3 renderer (shapes + culling + effects + Canvas backend) + M4 editor (pan/zoom, box-select, DOM-free handle picking, rotate, live SVG/Canvas backends, snapping/guides). Describes the verified current implementation.

## 1. The five invariants

Everything in the engine — now and in every future milestone — rests on these:

1. **The document is the single source of truth.** All persisted state lives in one
   `ProjectDocument`. Nothing authoritative lives in the renderer, the tools, or React.
2. **Actions are declarative.** An `Action` computes *what should change* (a
   `MutationResult` of deltas) and returns it. It never mutates the document.
3. **The Dispatcher is the only write path — enforced by the compiler.**
   `getDocument()` returns `ReadonlyDocument` (a `DeepReadonly<ProjectDocument>`), so a
   tool, the renderer, or a React handler that tries to assign to `node.geometry` or
   push to `rootNodeUuids` **fails to build**. The mutable document is held privately by
   the dispatcher, and exactly one function mutates it: `applyMutationsToDocument`.
4. **History is snapshot-based.** Each committed revision is an immutable, deep-cloned
   JSON snapshot. Undo/redo restore a snapshot; they never replay actions. Restored
   state is deep-cloned so it can never alias the history stack. Retention is bounded
   by *memory* rather than a step count; at the truncation boundary undo stops rather
   than teleporting, and `revertToOriginal()` is the explicit way back.
5. **The renderer is completely independent, and split into a pure model + a backend.**
   `buildRenderModel(size, document, RendererState) → DisplayList` is a pure, DOM-free
   read (testable in the `node` env like the layout engine); a backend transcribes the
   display list to the screen — `emitSVG` to DOM elements, or `emitCanvas` to a 2D context.
   `renderScene` picks the live backend (`renderSVG`/`renderCanvas` compose model + backend);
   picking is DOM-free, so both are interchangeable. Nothing here holds a reference to the
   dispatcher, and nothing can write.

## 2. Layered design

```
            ┌──────────────────────────────────────────────┐
   input →  │  Editor (EditorState + Tools + ToolController)│
            └───────────────┬──────────────────────────────┘
                            │ constructs Actions
                            ▼
            ┌──────────────────────────────────────────────┐
   WRITE →  │  ActionDispatcher   (validate→execute→apply→  │
            │                      commit→notify)           │
            └───┬───────────────────────────┬──────────────┘
                │ applyMutationsToDocument   │ commitRevision
                ▼                            ▼
        ┌───────────────┐            ┌────────────────┐
        │ ProjectDocument│──────────▶│ HistoryManager │
        │ (source truth) │  snapshot │ (revisions)    │
        └───────┬────────┘           └────────────────┘
                │ read-only
                ▼
        ┌───────────────┐   onChange   ┌──────────────┐
        │  renderScene   │◀────────────│   App (React)│
        │ (SVG / Canvas) │   re-render  └──────────────┘
        └───────────────┘
```

- **Editor** turns pointer/keyboard input into `Action` objects and dispatches them.
  It owns only *ephemeral* UI state (`EditorState`: selection, hover, viewport, drag
  previews) — never document state.
- **Dispatcher** enforces the lifecycle and is the sole mutator.
- **Document** is passive data.
- **HistoryManager** stores snapshots and serves undo/redo.
- **Renderer** reads the document plus `EditorState`-derived `RendererState` and paints via the
  selected backend (SVG or Canvas).
- **App (React)** wires the pieces and re-renders on a tick. It subscribes to
  `dispatcher.onChange` so **document** changes repaint from any source. It is also a
  second input surface: the inspector constructs and dispatches Actions directly, and
  the toolbar/wheel handlers mutate `EditorState`.
- **Ephemeral editor state** (selection, hover, viewport, drag previews) does **not**
  flow through the dispatcher, so tools call the explicit `refresh()` callback for it.

## 3. Data flow (a single edit)

1. A tool builds an `Action` bound to the current document.
2. `dispatchAction`: `validate()` → `execute()` (returns `MutationResult`) →
   `applyMutationsToDocument` (the mutation) → `historyManager.commitRevision` (snapshot)
   → `notify` (listeners).
3. **Dispatch never throws — no boundary.** Every stage is guarded: `validate()` and
   `execute()` share a try/catch, listener callbacks are isolated, and the
   apply/commit stage (`applyMutations` → `serialize` → `commitRevision`) is wrapped
   with a **rollback to the last committed revision**, so a throw there cannot leave
   the live document ahead of history. Failures are always `{ success: false }`.
4. React's `onChange` subscriber bumps a render tick; the effect calls `renderScene`
   (SVG or Canvas). (Ephemeral editor-state changes bump the same tick via `refresh()` directly.)

Undo/redo: `historyManager.undo()/redo()` returns a **deep-cloned** snapshot;
the dispatcher swaps `currentDocumentState` and notifies with `fullReload: true` so
delta-driven listeners reload wholesale.

## 4. Current vs. target data flow

The roadmap (M1/M2) inserts a computed layer. **The seam now exists:**

```
Document → GeometryEngine ─(runs)→ LayoutEngine → ComputedState → Renderer
                 ▲
                 └── pending drag patches (previews are an INPUT)
```

`computeGeometry(doc, pending?, previous?, dirty?)`
(`src/core/geometry/GeometryEngine.ts`) resolves parent-relative stored intent into a
`ComputedState`: per node a **world matrix**, its **local rect**, and a rotation-aware
**world AABB**, in scene-graph draw order. The renderer reads *only* that for
positions and emits the matrix directly; hit-testing tests in each node's local space
through the inverse matrix, so a rotated node hits against its true shape rather than
its bounding box, and never touches the DOM. `hitTest` takes an optional world-space
`tolerance` (a pick halo, `screen-px / zoom`) that inflates the test, so a zero-extent
target — an axis-aligned `core.line` whose box has zero area — stays selectable.
**All picking is DOM-free** (M4): point selection (`hitTest`), marquee/box-select
(`nodesInRect` — the nodes whose world AABB overlaps a rect), and resize/rotate-handle
grabbing (`handleAtPoint` over `selectionHandles`, the SAME handle geometry the renderer
draws, so pick and draw can't drift). Rotate spins the node about its world-AABB centre and
live-commits a coalesced `UpdateNodeTransformAction` (a continuous drag = one undo). Tools convert the pointer once via the shared
`screenToWorld` (the inverse of `screen = z·world − vp`). Because nothing reads
`data-node-id`/`data-resize-handle`, the editor works unchanged under the Canvas backend.
The renderer's `buildRenderModel` also
uses that world AABB to **cull** off-screen content — dropping any node whose bounds
don't intersect the viewport's world rect — so a large document only pays for what is
on screen (content only; overlay and grid are not culled).

**Layout runs *inside* that pass (M2).** When `computeGeometry` visits a node carrying
`layout.container`, it calls `LayoutEngine` to position that node's children — so a
laid-out child's local rect is a computed **result** (a row/column flex stack) that then
composes through the same matrices. It is not a second engine or a second tree walk; it
is a producer feeding the one `ComputedState`. Layout's cross-sibling dependency (moving
one child shifts the others) is reconciled here too, via `expandDirtyForLayout`.

**Intrinsic ("hug") sizing makes it two passes.** A container may size an axis to its
contents, and hug **composes upward** (a hug parent of a hug child depends on the
grandchildren). So `computeGeometry` first runs `measureIntrinsicSizes` — a **bottom-up**
fold over the same scene walk (reversed) that resolves every node's own size, folding a
hug container's hugged axis from its children — then the existing **top-down** position
pass consumes those sizes. The measure pass is deliberately run *fully* on every compute
(never memoized): that makes the size layer byte-identical between a full and an
incremental recompute, so the `incremental === full` invariant reduces to the dirty walk.
That walk (`expandDirtyForLayout`) climbs a change **up the hug chain** to the first fixed
container, so a deep resize re-lays-out every ancestor it actually moves. **Flex-grow**
(`Layout.grow`) is the inverse of hug — children fill a fixed container's leftover
main-axis space — and is applied purely in the position pass, so it needs no measure
feedback and no new dirty-tracking (a growing sibling reflows through the same ripple).
**Flex-shrink** (`Layout.shrink`) is its mirror: when the children overflow, it gives up
the deficit weighted by `shrink × base-size` (grow and shrink are exclusive by the sign of
free space) — likewise position-pass-only.
**Flex wrap** (`LayoutContainer.wrap`) breaks children into multiple lines when they overflow
the main axis. Like grid-hug, it pulls flex INTO the measure pass: a single shared
`breakFlexLines` is called by both the position pass and the measure cross-hug fold (a
cross-hug container sizes its cross to the stacked lines), so the container's own size equals
the lines it lays out. Each line flexes its own grow/shrink; wrap is inert under a hugged main
axis, and breaks against the container's OWN size (a parent-stretched main is not re-flowed
into — a documented deferral that keeps the fold acyclic). **`alignContent`** distributes the
lines in leftover cross space and **`wrapReverse`** reflects them from the far edge — both pure
position-pass arithmetic downstream of `breakFlexLines` (no-ops under a cross-hug, so the measure
fold is untouched).
**Grid** (`layoutGridChildren`) auto-flows children into cell tracks and fills them, reusing
the same dirty machinery (once `isLayoutContainer` counts a grid as a container). Both axes
size through one shared `resolveGridTracks`: columns, and per-row tracks (`LayoutGrid.rows` —
explicit sizes for the leading rows, `rowHeight` the implicit fallback). A `px`/`fr` grid with
no hug reads no child sizes. But an **`auto` track** (sizes to the max child content) and
**grid-container hug** (`LayoutGrid.hugWidth/hugHeight` — the grid sizes its own axis to
`2·pad + Σtracks + gaps`) pull grid INTO the bottom-up measure pass, exactly like flex hug:
the measure fold and the position pass call the SAME `resolveGridTracks` off the SAME measured
own-sizes, so a hugged grid's own size equals the sum of its cells by construction, and
`containerHugs` recognises grid hug flags so a grid-child resize ripples up. On a hugged axis
`fr` collapses to 0 (no definite size to share). **Item spans** (`Layout.colSpan/rowSpan`) run a
CSS-style auto-placement (`placeGridItems`, called once inside `resolveGridTracks` so measure and
position share it): a forward-only cursor gives each item the next free `colSpan × rowSpan` block,
the row count is DERIVED (a `rowSpan` can grow the grid), and a spanning cell covers its tracks +
internal gaps. **`autoFlow`** adds dense packing (backfill gaps) and column flow (fix the rows,
derive the columns — the exact transpose of row flow, reusing the one kernel); **`gridColumn`/
`gridRow`** pin an item to explicit lines (a pre-pass marks it so auto items flow around it).

**Constraints / anchors** (`resolveConstraints`) are the responsive-positioning model for
children of a **plain** (non-flex/grid) parent: each child pins to the parent's edges and
repositions when the parent resizes. The stateless engine resolves this against a **frozen
per-child reference** (`Layout.constraintRef`, captured once at opt-in) rather than a
resize delta — `offset = parentComputed.local.size − constraintRef` is non-zero for BOTH a
direct `ResizeNodeAction` (stored size moves, ref frozen) and a layout-driven resize (a
grown/stretched/celled frame's computed size moves, ref frozen). It is pure top-down (no
measure feedback, no `expandDirtyForLayout` change): a parent size change dirties the
parent and the child inherits. *Known limitation (an M5 tool-layer concern): editing a
constrained child while its parent is off-reference writes geometry in the wrong frame; the
re-baseline is not yet built.*

**Out-of-flow escapes and margins.** `Layout.position: "absolute"` takes a child OUT of
its flex/grid parent's flow (no slot/cell, excluded from hug size and grow free-space),
positioned instead by its stored geometry + constraints against the parent box — so the
constraint gate admits an absolute child of any parent, and `MoveTool` leaves it draggable.
`Layout.margin` (`number | Margins`) is flex-flow spacing / a grid-cell inset, folded into the
grow free-space and the hug measure. Per-side margins map physical sides to the flex logical
axes by `direction` (via `resolveMargin`/`logicalMargin`), and both the measure fold and the
position pass map identically so a hugged container agrees with its children. All are small
position-pass/measure additions with no new dirty-tracking.

Still outstanding for the computed layer: **resolved style** (M5 tokens) belongs in
`ComputedState` and is not there yet; and M2's **remaining layout** — `minmax()`/`fit-content`
tracks, single-axis explicit placement, a separate cross-gap — is deferred (see MILESTONES.md).
Layout output today is expressed *as* geometry (computed local rects), not as a distinct channel.

## 5. Module map

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Document | `core/document/{Document,Node,Serializer}.ts`, `core/ids/UUID.ts` | Source of truth, types, (de)serialization, identity |
| Document integrity | `core/document/{SceneGraph,Integrity}.ts` | Tree traversal/draw order; structural + range validation on load |
| Computed state | `core/geometry/{Matrix,GeometryEngine,LayoutEngine,SelectionHandles,Snapping}.ts` | 2D affine primitive; world matrices, local rects, rotation-aware bounds, draw order, DOM-free hit-testing (**M1**); auto-layout containers + bottom-up intrinsic ("hug") sizing computed inside the same pass (**M2**); DOM-free handle geometry + alignment snapping (move + resize; any translation-only chain) (**M4**) |
| Actions | `core/actions/{Action,types,applyMutations}.ts` + `*Action.ts` | Declarative mutations + delta protocol |
| Dispatch/History | `core/actions/{ActionDispatcher,HistoryManager}.ts` | Only write path; snapshot undo/redo |
| Editor | `editor/EditorState.ts`, `editor/tools/*` | Ephemeral state; input → Actions |
| Renderer | `renderer/{RenderModel,emitSVG,emitCanvas,SVGRenderer,CanvasRenderer,renderScene}.ts` | Pure `(doc, state) → DisplayList`, then thin SVG + Canvas backends; `renderScene` selects the live backend |
| App | `app/App.tsx`, `app/index.tsx`, `app/index.html` | React shell + wiring |
| Shell | `electron/{main.js,preload.js}` | Native window, menus, file IO via IPC |
| Build | `scripts/build.js` | Three esbuild bundles → `dist/` |

## 6. Boundaries that must not be crossed

- The renderer, tools, and React **must not** write to the document except by
  dispatching an Action. (Drag previews use `EditorState.pendingGeometry`, which the
  renderer reads and the document never sees.)
- Nothing may hold a long-lived reference into a history snapshot, and hydrated
  snapshots must be deep-cloned before use (see [ACTION-SYSTEM.md](ACTION-SYSTEM.md)).
- `EditorState` is never serialized into the document.
