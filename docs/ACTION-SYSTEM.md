# Action System

<!-- describes: src/core/actions -->

> 🔒 Frozen for Milestone 0 · v0.0.5. Code in `src/core/actions/`.

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
| `ReparentNodeAction` | `{ kind: "patch", reparent: { parent, index? } }` |
| `TransactionAction` | merges multiple actions into one atomic result + one revision |

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
                      geometry?: Partial<Geometry>; style?: Partial<Style>;
                      layout?: Partial<Layout>;
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
  `dispatchAction(action, { coalesce: true })` lets consecutive edits to the *same node*
  within `COALESCE_WINDOW_MS = 400` replace the previous revision instead of appending,
  so a slider drag or a run of keystrokes is **one** undo step. Only continuous UI (the
  inspector) opts in; every other dispatch defaults to a separate revision.

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
