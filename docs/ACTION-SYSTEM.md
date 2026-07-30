# Action System

<!-- describes: src/core/actions -->

> 🔒 Frozen contract · schema v19 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins). Code in `src/core/actions/`.

The action system is the engine's spine: it is **the only way the document changes**,
and it is what makes undo/redo, and later AI, plugins, and collaboration, safe.

## 1. The Action contract

`Action` (`Action.ts`) is abstract. Every mutation is a subclass.

```ts
abstract class Action {
  protected document: ReadonlyDocument;      // an Action only READS its document
  constructor(document: ReadonlyDocument);
  rebind(document: ReadonlyDocument): void;  // retarget (transactions; and the
                                             // dispatcher, before validate)
  abstract validate(): boolean;              // may this run against `document`?
  abstract execute(): MutationResult;         // compute deltas — DO NOT mutate
  abstract serialize(): ActionPayload;        // for the history payload
}
```

**Rules an Action must obey:**
- `execute()` **must not** mutate the document. It returns a `MutationResult` describing
  the change. (Mutation happens later, once, in `applyMutationsToDocument`.)
- `execute()` should re-check `validate()` and throw if invalid (defensive — the
  dispatcher already validated, but state may have changed).
- `validate()` must reject non-finite numbers and out-of-range values (see schema invariants).
- Actions are **reversible** by virtue of snapshot history — they don't implement `undo()`.

### Command catalogue
| Action | Effect (delta) |
|--------|----------------|
| `AddNodeAction` | `{ kind: "add", node }` |
| `DeleteNodeAction` | `{ kind: "delete" }` for the node **and every descendant** (cycle-safe) |
| `MoveNodeAction` | `{ kind: "patch", geometry: { x, y } }` |
| `ResizeNodeAction` | `{ kind: "patch", geometry: { width, height } }` |
| `UpdateNodeGeometryAction` | `{ kind: "patch", geometry: {…partial…} }` |
| `UpdateNodeStyleAction` | `{ kind: "patch", style: {…partial…} }` |
| `UpdateNodeTransformAction` | `{ kind: "patch", transform: {…partial…} }` — rotation/scale/origin |
| `UpdateNodeLayoutAction` | `{ kind: "patch", layout: {…partial…} }` — M2 layout (container/grid/grow/constraints/position/margin). Carries grid⊕container exclusivity IN the delta, and auto-captures `constraintRef` from a NON-container parent's stored size on first opt-in |
| `ReparentNodeAction` | `{ kind: "patch", reparent: { parent, index? } }` |
| `SetVariableAction` | `{ kind: "variables", variables, activeTheme }` — upsert one design token (M5); validated via the shared `variableStoreError` |
| `DeleteVariableAction` | `{ kind: "variables", … }` — remove one token; dangling references stay valid (they resolve to the visible fallback) |
| `SetActiveThemeAction` | `{ kind: "variables", … }` — switch the persisted light/dark theme |
| `TransactionAction` | merges multiple actions into one atomic result + one revision |

The `"variables"` delta is DOCUMENT-level: it replaces the whole store + active theme
atomically and travels under the reserved `DOCUMENT_DELTA_KEY` (`"__document__"`) since the
delta map is keyed by node id. That id is reserved in NODE-id space too (`RESERVED_NODE_ID`,
rejected by `AddNodeAction` and `Integrity`) so a real node can never collide with the
sentinel, and `TransactionAction` excludes the sentinel from `updatedNodeIds`. In a
transaction the LAST variables delta wins — safe because each component action builds its
delta from the *working* document at execute time, so a later `SetActiveThemeAction` already
carries an earlier `SetVariableAction`'s store. These actions report an EMPTY
`updatedNodeIds` (no node changed; the id set feeds the geometry dirty-tracker, which token
edits never affect). `SetVariableAction` pre-checks its KEY via the shared
`variableKeyError` before building its candidate store — a reserved key like `"__proto__"`
would be swallowed by the assignment itself (the prototype setter fires), invisible to
store-level validation.

`AddNodeAction`/`ResizeNodeAction`/`UpdateNodeGeometryAction` validate dimensions through the
shared per-type `dimensionError` (so the edit and load paths cannot drift) — rect/ellipse/text/image
need a positive box; a `core.line` may collapse one axis (a horizontal/vertical line), not both.
`UpdateNodeGeometryAction` merges its partial patch over the current geometry before the check.
`UpdateNodeStyleAction` validates through the shared `styleError` (all `Style` fields incl. the
schema-18 shadow/blur effects), closing what was a duplicated inline style-validation copy.

## 2. MutationResult & the delta protocol

```ts
interface MutationResult {
  updatedNodeIds: Set<string>;
  propertyDeltas: Map<string, NodeDelta>;           // nodeId → delta
  success: boolean;
  fullReload?: boolean;   // set on undo/redo/load: reload from getDocument()
}
```

Deltas are interpreted by `applyMutationsToDocument` (`applyMutations.ts`) — the single
mutation site. A delta is a **discriminated union** (`NodeDelta`), not a bag of magic keys — the
terminal/composable rule below is enforced by the type system, so a malformed delta
is a compile error rather than a silently-dropped edit:

```ts
type NodeDelta =
  | { kind: "add";    node: Node }
  | { kind: "delete" }
  | { kind: "patch";  reparent?: { parent: string | null; index?: number };
                      geometry?: Partial<Geometry>; transform?: Partial<Transform>;
                      style?: Partial<Style>; layout?: Partial<Layout>;
                      text?: string; src?: string; name?: string };
```

| Variant | Meaning | Applied as |
|---------|---------|-----------|
| `add` | create a node | `nodes.set`; if it has a resolvable `parent`, push to `parent.children`, else land it at the root |
| `delete` | remove a node | detach from `parent.children`, `nodes.delete`, drop from `rootNodeUuids` |
| `patch.reparent` | move within the tree | resolve the destination first, detach from **both** the source and the destination, then insert at `index` (appended if omitted) |
| `patch.geometry` / `.style` / `.layout` | patch | `Object.assign(node.<field>, …)` |
| `patch.transform` | patch | `node.transform = { ...node.transform, ...delta.transform }` (created if absent) |
| `patch.text` / `.src` / `.name` | scalar set | assigned when not `undefined` |

`applyMutationsToDocument` switches exhaustively on `kind`; adding a variant without
handling it fails to compile.

**Terminal vs. composable — now enforced by the type.** `add` and `delete` are
*terminal*: they fully describe the node's fate, and the union makes it impossible to
attach property edits to them. `reparent` lives **inside** `patch`, so it composes:
`{ kind: "patch", reparent, geometry }` is one delta that lands both (a transaction
that drops a node into a frame and repositions it emits exactly that).

`reparent` detaches from the **destination** before inserting, so re-parenting a node
the destination already lists (e.g. an `add` that baked the child into its new parent's
`children`) cannot duplicate the entry.

**`updatedNodeIds` under auto-layout (M2).** The dirty set must be a *superset* of the
nodes whose **rendered** output changed — and once a parent is a layout container, that
includes more than the node the action names, because a container's children are
positioned *relative to each other*. So a **structural** change to a container's
membership reports the container too: `ReparentNodeAction` adds both the **old and new**
parent, and `DeleteNodeAction` adds the removed child's parent. (A change to a child's
own size is handled by the engine's `expandDirtyForLayout`, which dirties the current
parent; but neither the old parent of a move nor the vanished parent of a delete is
derivable from the post-mutation document, so the *action* must report it.) Reporting a
non-container parent is harmless — recomputing an unaffected node yields the same result.
The `incremental === full` fuzz (see [TESTING.md](TESTING.md)) exercises exactly these
cases; a mutation-testing pass proved each report load-bearing.

## 3. Dispatch lifecycle

`ActionDispatcher.dispatchAction(action)` (`ActionDispatcher.ts`) runs:

```
validate → execute → apply → commit → notify
```

1. Guard: not an `Action` → `{ success: false }`.
2. **Rebind** the action to the current document, so the gate and the mutation always
   target the same document (a stale action then fails closed instead of half-applying).
3. `validate()` false, or `validate()`/`execute()` throwing → `{ success: false }`.
4. `execute()` returns `{ success: false }` → returned as-is (no apply/commit).
5. Otherwise: `applyMutationsToDocument` → `commitRevision` → `notify`. If that stage
   throws, the document is **rolled back** to the last committed revision.

**The dispatcher never throws out of dispatch — no boundary.** Every stage is guarded,
so failures are values, not exceptions; a React event handler cannot be crashed by a
bad edit, and the live document can never end up ahead of history.

**Listener isolation:** `notify` wraps each `onChange` listener in try/catch, so one
throwing subscriber neither skips the others nor propagates after the mutation committed.

`onChange(listener) → unsubscribe` is the subscription API.

## 4. History & undo/redo (snapshot model)

`HistoryManager` (`HistoryManager.ts`) stores an array of immutable `Revision`s and a
cursor. **No actions are re-executed on undo/redo** — a full snapshot is restored.

- `commitRevision(payload, doc)`: truncates any redo tail, deep-clones the document via
  `cloneDocument` (JSON round-trip; `Map`→object, `Date`→ISO string), pushes it, and
  trims to fit a **memory budget** (`DEFAULT_HISTORY_LIMITS`: 128 MB, floor of 50
  entries, hard cap 10 000) rather than a fixed step count — a snapshot is a whole
  document, so "200 steps" meant wildly different memory for different documents.
  A normal session never truncates.
- **At the truncation boundary, undo STOPS — it does not teleport.** Trimming drops
  the oldest revisions, so after truncation index 0 is the oldest *retained* step, not
  the original. Undo walks back to there and stops. The document the history began
  from is pinned **outside** the trimmable list and reachable via
  `revertToOriginal()`, which commits as a normal revision (so the revert is itself
  undoable). `hasTruncatedHistory()` tells the UI when to offer it.

- **Coalescing — opt-in by the CALLER, not inferred from the action type.**
  `dispatchAction(action, { coalesce: true })` lets consecutive edits with the *same
  coalesce key* within `COALESCE_WINDOW_MS = 400` replace the previous revision instead of
  appending, so a slider drag or a run of keystrokes is **one** undo step. The key is
  `actionId:nodeId` for a single-node action, or — for a `TransactionAction`, which has no
  single node — `TransactionAction:<name>`, so a continuous *multi-node* gesture (group
  rotate emits one geometry+transform transaction per frame, named gesture-specifically as
  `rotate-group:<sorted ids>`) also collapses to one undo. Only continuous UI opts in; every
  other dispatch — including the discrete `move-nodes`/`delete-nodes` transactions — defaults
  to a separate revision.

  > CANCELLING a live-committed gesture does NOT rely on the coalesce window. The tool captures a
  > checkpoint (`getHistoryCheckpoint` = the current revision id) at grab; Escape calls
  > `rollbackToCheckpoint`, which **discards** every revision committed since (no undo AND no redo
  > trace) and restores that document. This is what makes a rotate cancel reliable regardless of a
  > mid-drag pause, and makes a grab-then-Escape with no drag a true no-op instead of a phantom
  > revision. (Unlike undo, which steps the cursor back but leaves the revisions redoable.)

  > This used to be an allow-list of action classes, which was wrong:
  > `UpdateNodeGeometryAction` has two producers — the inspector (continuous) *and* a
  > drag committing on mouse-up (discrete) — so the class cannot tell you the input
  > cadence, and two deliberate drags silently collapsed into one undo step. Only the
  > call site knows.
- `undo()/redo()`: move the cursor and return `hydrateDocument(snapshot)`.

**Critical invariant — hydrate deep-clones.** `hydrateDocument` runs
`JSON.parse(JSON.stringify(snapshot))` before rebuilding the `Map` and rehydrating
`date`. This guarantees the restored document shares **no** objects with the stored
revision. Without it, the next in-place edit after an undo would silently rewrite
committed history (regression **R2**; locked by the test
*"edit after undo does not corrupt earlier revisions"*).

The dispatcher's `undo`/`redo`/`loadDocument` swap `currentDocumentState` and notify
with `fullReload: true` and `updatedNodeIds` = the REAL dirty set so delta-driven
subscribers reload wholesale.

## 5. Transactions

`TransactionAction` groups actions into **one** atomic `MutationResult` and therefore
**one** revision. Component actions are `rebind`-ed onto a working copy so each observes
the effects of the previous ones (e.g. create-a-node-then-move-it in one transaction),
using the same `applyMutationsToDocument` as the live path. If any component fails
validation, the whole transaction is rejected.

## 6. Why this matters downstream

Because every change is a validated, serializable, reversible Action funnelled through
one dispatcher:
- **Milestone 14 (AI)** and **Milestone 15 (Plugins)** can only ever emit Actions — they
  cannot corrupt the document or bypass history.
- **Milestone 16 (Collaboration)** gets a clean, linear, serializable revision stream to
  branch, merge, and resolve against.

Do not add side-channels that mutate the document outside this system.
