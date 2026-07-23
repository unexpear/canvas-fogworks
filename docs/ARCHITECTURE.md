# Architecture

> 🔒 Frozen for Milestone 0 · v0.0.5. Describes the verified current implementation.

## 1. The five invariants

Everything in the engine — now and in every future milestone — rests on these:

1. **The document is the single source of truth.** All persisted state lives in one
   `ProjectDocument`. Nothing authoritative lives in the renderer, the tools, or React.
2. **Actions are declarative.** An `Action` computes *what should change* (a
   `MutationResult` of deltas) and returns it. It never mutates the document.
3. **The Dispatcher is the only write path.** `ActionDispatcher.dispatchAction()` (plus
   `undo`/`redo`/`loadDocument`) are the *only* places the document changes. There is
   exactly one function that mutates document state: `applyMutationsToDocument`.
4. **History is snapshot-based.** Each committed revision is an immutable, deep-cloned
   JSON snapshot. Undo/redo restore a snapshot; they never replay actions. Restored
   state is deep-cloned so it can never alias the history stack.
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
3. `validate()`, `execute()` and listener callbacks never throw out of dispatch — an
   invalid/failed action returns `{ success: false }`, and a listener that throws is
   isolated and logged. *(Known boundary: the apply/commit stage — `applyMutations`,
   `serialize`, `commitRevision` — is not individually guarded; a throw there would
   escape after the document was already mutated. See §6.)*
4. React's `onChange` subscriber bumps a render tick; the effect calls `renderSVG`.
   (Ephemeral editor-state changes bump the same tick via `refresh()` directly.)

Undo/redo: `historyManager.undo()/redo()` returns a **deep-cloned** snapshot;
the dispatcher swaps `currentDocumentState` and notifies with `fullReload: true` so
delta-driven listeners reload wholesale.

## 4. Current vs. target data flow

The roadmap (M1/M2) inserts a computed layer. **The seam now exists:**

```
target:   Document → GeometryEngine → ComputedState   → Renderer
current:  Document → computeWorldGeometry → ComputedGeometry → Renderer
                          ▲
                          └── pending drag patches (previews are an INPUT)
```

`computeWorldGeometry(doc, pending)` (`src/core/geometry/ComputedGeometry.ts`)
resolves parent-relative stored intent into absolute world rects in scene-graph draw
order. The renderer reads **only** `RendererState.computed` for positions and never
composes coordinates itself; hit-testing runs off the same structure, so it does not
depend on per-node DOM.

It is deliberately narrow — translation only, geometry only. **Milestone 1 replaces
it in place**: `GeometryEngine` takes over composition (matrices, rotation, bounds)
and `ComputedGeometry` widens into `ComputedState` (adding resolved style, and
absorbing layout output in M2). Because every consumer already reads the computed
structure rather than `node.geometry`, that swap is a change of *producer*, not a
rewrite of the consumers.

## 5. Module map

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Document | `core/document/{Document,Node,Serializer}.ts`, `core/ids/UUID.ts` | Source of truth, types, (de)serialization, identity |
| Document integrity | `core/document/{SceneGraph,Integrity}.ts` | Tree traversal/draw order; structural + range validation on load |
| Computed geometry | `core/geometry/ComputedGeometry.ts` | Parent-relative → world composition, draw order, DOM-free hit-testing (**the M1 seam**) |
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
