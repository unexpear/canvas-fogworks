# Testing Strategy

<!-- describes: src/core/tests, jest.config.js, scripts/check-module-headers.js -->

> 🔒 Frozen for Milestone 0 · v0.0.5. Suite: `src/core/tests/document.test.ts` (107 tests).

## Philosophy

The engine's correctness lives in the **core** (document, actions, dispatcher, history,
serializer) — the layer every other layer trusts. That layer is deterministic, pure,
and has no DOM, so it is tested exhaustively with fast unit tests. UI/renderer behavior
is validated by targeted browser smoke tests during development, not (yet) automated.

**Milestone 0 bar:** no change to a frozen contract lands without a test. Regressions get
a test that is proven to fail before the fix and pass after (see *regression discipline*).

## Commands

```bash
npm test                                   # jest (ts-jest), 107 tests
npx tsc --noEmit                           # typecheck the app
npx tsc --noEmit -p tsconfig.test.json     # typecheck the tests too
npm run lint                               # module-header rule (no ESLint dependency)
npm run check                              # typecheck + lint + test + build (the gate)
```

- Runner: **Jest** via **ts-jest**, `testEnvironment: node` (`jest.config.js`).
- `tsconfig.json` excludes `*.test.ts` from the app build; `tsconfig.test.json` type-checks
  them. Both must be clean.

## What is covered (107 tests)

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

## The API-surface pin

`src/core/tests/apiSurface.ts` is never executed. It imports every symbol documented
in [API-CONTRACTS.md](API-CONTRACTS.md) and asserts its shape, so `tsc` fails if a
documented export is renamed, removed, or changes signature.

It exists because API-CONTRACTS.md drifted in three places during one pass **while the
freeze rule was in force**, and the drift was found by accident. Two mechanisms were
measured against that drift before this one was kept:

| Mechanism | Result |
|---|---|
| Identifier-existence checker over backticked names in docs | caught **0 of 4** — the drift was semantic (`ProjectDocument` still existed, it was just the wrong type), and 5 of 5 hits were false positives |
| Assignability assertion (`expectType<ReadonlyDocument>(…)`) | **passed** even with `getDocument()` reverted to mutable — mutable widens to readonly |
| Generic conditional (`expectNotMutable`) | **fails** correctly: `Argument of type 'ProjectDocument' is not assignable to parameter of type 'never'` |

The lesson is in the middle row: an assertion that only checks *assignability* cannot
detect a guarantee weakening, because weakening is exactly the direction assignability
allows. Guarantees that must not weaken need a conditional generic over the argument's
own type — and the check must be verified by breaking the code on purpose.

**Not covered:** prose describing behaviour that has since changed. Nothing mechanical
catches that; it needs review.

## Mutation testing (verifying the tests, not the code)

"A check is worthless until you have broken the code on purpose and watched it fail"
applies to the whole suite, not just to new regression tests. Every guard added during
the audit campaign was weakened one at a time, with the suite run against each
weakening. A guard nothing notices is not protected.

First pass over 18 guards: **13 killed, 2 survived, 3 unverified** (the mutation string
did not match — *unverified*, not passing). The survivors were real gaps:

| Guard | Why nothing caught it |
|---|---|
| `MoveTool` selection-root filter | the test exercised `selectionRoots` + `computeWorldGeometry` directly, never `MoveTool` — so the CRITICAL parent+child double-apply could have been reintroduced silently |
| coalesce anchored to the last commit | the existing test happened to land on `currentIndex === 0`, so a *different* guard was rejecting the merge; the anchor itself was never exercised |
| legacy → schema-1 normalisation | `LEGACY_SCHEMA` and `SCHEMA_VERSION` are both `"1"` today, so correct and incorrect behaviour are indistinguishable until a future bump — exactly when it would bite |

Three tests were added to close them; the third required making the schema injectable
(`migrateIfNeeded(raw, currentSchema)`) so the future-bump case can be exercised now.

**Three of the mutations were themselves wrong**, and they failed in BOTH directions:

- Two produced false *survived* results — one changed an object field but not the local
  variable set on the next line; the other left the `try/catch` in place while claiming
  to remove listener isolation. Corrected, both were killed.
- One produced a false ***killed*** result. The `ComputedGeometry` unresolved-parent
  mutation did not compile (dropping the `continue` leaves `parentRect` possibly
  undefined at the deref), so jest exited non-zero having run **zero tests** — and the
  harness read any non-zero exit as "a test caught it". Mutated validly, by restoring
  the exact pre-fix code, it **survived**: nothing protected that guard. A test was added.

> **Harness rule:** a mutation run must assert that the suite actually RAN. Treat
> `Tests: 0 total`, or a non-zero exit with no failure count, as **unverified** — never
> as a kill. A false *survived* prompts investigation; a false *killed* is silent, and
> is the one that leaves a guard unprotected while looking green.

## Doc-staleness tripwire (`npm run doc-drift`)

Each doc that describes specific code declares it in the doc itself:

```html
<!-- describes: src/core/actions, src/core/document/Serializer.ts -->
```

`scripts/check-doc-drift.js` flags a doc when any declared source has been **committed
to since the doc was last committed to**. Clearing the flag means committing the doc —
which is the re-read it exists to force.

It cannot tell you prose is wrong; nothing can. It targets the failure that actually
occurred: editing one section and never re-reading the rest, so drift accumulated where
nobody was looking.

**Measured on first run against real history — 3 flags, 2 true positives:**

| Doc | Verdict |
|---|---|
| `API-CONTRACTS.md` | **true** — `migrateIfNeeded` had become a public export and was undocumented |
| `DOCUMENT-SCHEMA.md` | **true** — still described `version` as `= CURRENT_VERSION on new docs`; it is `SCHEMA_VERSION`, plus a stale `migrateIfNeeded` signature and a hand-written `NodeType` |
| `ARCHITECTURE.md` | **false** — its history claims were still accurate |

The `DOCUMENT-SCHEMA` case is the point: `CURRENT_VERSION` still *exists*, so no
identifier check could see it, and it is prose, so the API pin could not either. The
freeze rule had already missed it once. The tripwire caught it only by forcing the
re-read — which is the whole design claim.

**Not in `npm run check`.** It is noisy by construction: every source commit flags its
doc whether or not the doc is wrong, and the flag clears only on a doc commit. Adding it
to the gate is one line in `package.json`; that is a workflow-cost decision, not a
correctness one.

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
