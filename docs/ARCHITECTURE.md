# Architecture

<!-- describes: src/core/actions/ActionDispatcher.ts, src/core/actions/applyMutations.ts, src/core/actions/HistoryManager.ts, src/core/geometry, src/renderer/SVGRenderer.ts -->

> 🔒 Frozen for Milestone 0 · v0.0.5. Describes the verified current implementation.

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
5. **The renderer is completely independent.** `renderSVG` is a pure read of
   `(document, RendererState) → DOM`. It has no reference to the dispatcher and cannot
   write.

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
        │  SVGRenderer   │◀────────────│   App (React)│
        └───────────────┘   re-render  └──────────────┘
```

- **Editor** turns pointer/keyboard input into `Action` objects and dispatches them.
  It owns only *ephemeral* UI state (`EditorState`: selection, hover, viewport, drag
  previews) — never document state.
- **Dispatcher** enforces the lifecycle and is the sole mutator.
- **Document** is passive data.
- **HistoryManager** stores snapshots and serves undo/redo.
- **Renderer** reads the document plus `EditorState`-derived `RendererState` and paints SVG.
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
4. React's `onChange` subscriber bumps a render tick; the effect calls `renderSVG`.
   (Ephemeral editor-state changes bump the same tick via `refresh()` directly.)

Undo/redo: `historyManager.undo()/redo()` returns a **deep-cloned** snapshot;
the dispatcher swaps `currentDocumentState` and notifies with `fullReload: true` so
delta-driven listeners reload wholesale.

## 4. Current vs. target data flow

The roadmap (M1/M2) inserts a computed layer. **The seam now exists:**

```
Document → GeometryEngine → ComputedState → Renderer
                 ▲
                 └── pending drag patches (previews are an INPUT)
```

`computeGeometry(doc, pending?, previous?, dirty?)`
(`src/core/geometry/GeometryEngine.ts`) resolves parent-relative stored intent into a
`ComputedState`: per node a **world matrix**, its **local rect**, and a rotation-aware
**world AABB**, in scene-graph draw order. The renderer reads *only* that for
positions and emits the matrix directly; hit-testing tests in each node's local space
through the inverse matrix, so a rotated node hits against its true shape rather than
its bounding box, and never touches the DOM.

Still outstanding for the computed layer: **resolved style** (M5 tokens) and **layout
output** (M2) both belong in `ComputedState` and are not there yet.

## 5. Module map

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Document | `core/document/{Document,Node,Serializer}.ts`, `core/ids/UUID.ts` | Source of truth, types, (de)serialization, identity |
| Document integrity | `core/document/{SceneGraph,Integrity}.ts` | Tree traversal/draw order; structural + range validation on load |
| Computed state | `core/geometry/{Matrix,GeometryEngine}.ts` | 2D affine primitive; world matrices, local rects, rotation-aware bounds, draw order, DOM-free hit-testing (**Milestone 1**) |
| Actions | `core/actions/{Action,types,applyMutations}.ts` + `*Action.ts` | Declarative mutations + delta protocol |
| Dispatch/History | `core/actions/{ActionDispatcher,HistoryManager}.ts` | Only write path; snapshot undo/redo |
| Editor | `editor/EditorState.ts`, `editor/tools/*` | Ephemeral state; input → Actions |
| Renderer | `renderer/SVGRenderer.ts` | Read-only `(doc, state) → SVG` |
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
