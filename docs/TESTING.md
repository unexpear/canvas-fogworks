# Testing Strategy

> 🔒 Frozen for Milestone 0 · v0.0.5. Suite: `src/core/tests/document.test.ts` (97 tests).

## Philosophy

The engine's correctness lives in the **core** (document, actions, dispatcher, history,
serializer) — the layer every other layer trusts. That layer is deterministic, pure,
and has no DOM, so it is tested exhaustively with fast unit tests. UI/renderer behavior
is validated by targeted browser smoke tests during development, not (yet) automated.

**Milestone 0 bar:** no change to a frozen contract lands without a test. Regressions get
a test that is proven to fail before the fix and pass after (see *regression discipline*).

## Commands

```bash
npm test                                   # jest (ts-jest), 97 tests
npx tsc --noEmit                           # typecheck the app
npx tsc --noEmit -p tsconfig.test.json     # typecheck the tests too
npm run check                              # typecheck + test + build (the gate)
```

- Runner: **Jest** via **ts-jest**, `testEnvironment: node` (`jest.config.js`).
- `tsconfig.json` excludes `*.test.ts` from the app build; `tsconfig.test.json` type-checks
  them. Both must be clean.

## What is covered (97 tests)

| Area | Representative cases |
|------|----------------------|
| Document creation / empty-doc edges | version = `SCHEMA_VERSION`, **schema/app version decoupling**, empty round-trip, dispatch on empty doc |
| **Scene graph authoring** | nested add via `parentId`, duplicate-id rejected, reparent + undo, insertion index, self-parent/cycle rejected, `traverseSceneGraph` tree order + cycle safety + orphans |
| **History coalescing / retention** | a 50-event slider run = one undo step; discrete actions not coalesced; **initial revision survives overflow** |
| `AddNodeAction` | adds node, undo removes, rejects width/height = 0, empty type, NaN coords |
| `DeleteNodeAction` | leaf, cascading children, undo restores tree, missing node fails |
| `TransactionAction` | batched moves = one undo entry; failing child rejects all |
| `UpdateNodeGeometry/Style`, `ResizeNodeAction` | partial patches, undo restores, invalid rejected |
| Dispatcher `onChange` | called with `MutationResult`; unsubscribe; ordered; fires on undo |
| History sequences | dispatch-after-undo clears redo; undo to initial; **edit-after-undo doesn't corrupt revisions (R2)** |
| Serializer | unknown schema throws, **newer schema** throws, **legacy semver accepted**, invalid JSON throws, malformed node / key-id mismatch, root-order comparison, variables & metadata round-trip |
| `Serializer.loadResult` | empty vs loaded vs **corrupt** (with backup) — localStorage mocked |
| `ActionDispatcher.loadDocument` | replaces doc, resets history |
| **`ComputedGeometry`** | parent-relative → world composition; **pending patches propagate to children**; draw order; `hitTest` topmost / empty space |
| **Restore dirty set** | undo reports only the changed node, not the whole document |
| **Document integrity (load path)** | rejects `opacity: 5`, negative size, dangling parent, ghost root, unclaimed child, parentless non-root; accepts a well-formed nested doc |

## Regression discipline

When fixing a bug, add a test that **fails on the unfixed code and passes after**. Example
this project follows (R2, the undo/history aliasing bug): the fix in
`hydrateDocument` was temporarily reverted to confirm the new test failed with the exact
corruption signature (`Expected 0, Received 50`), then restored so it passes. A regression
test that was never seen to fail proves nothing.

## Gaps / not yet automated (tracked, not silently ignored)

- **Renderer & tools** have no automated DOM tests; move/resize/draw are validated by
  browser smoke tests. Adding jsdom-based tool tests is future work.
- **Electron main/preload** IPC is not unit-tested (thin, and requires an Electron host).
  The Open → edit → Ctrl+S round-trip in particular is only manually verified.
- `applyMutationsToDocument`'s `text` / `src` / `name` branches have no producing Action
  yet, so they are reachable only by constructing a delta directly — currently untested.
- The same-node `TransactionAction` merge path is exercised indirectly but never
  asserted on directly.
- `computeWorldGeometry` is translation-only, so there is no rotation/matrix coverage
  yet — that arrives with the Milestone 1 `GeometryEngine`.

## Conventions

- Test file mirrors the module and tags each `describe` with the requirement/fix id it
  satisfies (e.g. `T2`, `M24`, `R2`).
- Prefer the small factory helpers (`createDocWithRectangle`, `createDocWithParentChild`)
  over ad-hoc fixtures.
- Mock browser globals (e.g. `localStorage`) locally within the `describe` that needs them.
