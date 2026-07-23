# Action System

> 🔒 Frozen for Milestone 0 · v0.0.5. Code in `src/core/actions/`.

The action system is the engine's spine: it is **the only way the document changes**,
and it is what makes undo/redo, and later AI, plugins, and collaboration, safe.

## 1. The Action contract

`Action` (`Action.ts`) is abstract. Every mutation is a subclass.

```ts
abstract class Action {
  protected document: ProjectDocument;
  constructor(document: ProjectDocument);
  rebind(document: ProjectDocument): void;   // retarget (used by transactions)
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
| `AddNodeAction` | `__addNode` (a full `Node`) |
| `DeleteNodeAction` | `__deleteNode` for the node **and every descendant** (cycle-safe) |
| `MoveNodeAction` | `geometry: { x, y }` |
| `ResizeNodeAction` | `geometry: { width, height }` |
| `UpdateNodeGeometryAction` | `geometry: {…partial…}` |
| `UpdateNodeStyleAction` | `style: {…partial…}` |
| `ReparentNodeAction` | `__reparent: { parent, index? }` — moves a node in the tree |
| `TransactionAction` | merges multiple actions into one atomic result + one revision |

## 2. MutationResult & the delta protocol

```ts
interface MutationResult {
  updatedNodeIds: Set<string>;
  propertyDeltas: Map<string, Record<string, any>>; // nodeId → delta
  success: boolean;
  fullReload?: boolean;   // set on undo/redo/load: reload from getDocument()
}
```

A **delta** (the `Record` per node) is interpreted by `applyMutationsToDocument`
(`applyMutations.ts`) — the single mutation site — as follows:

| Delta key | Meaning | Applied as |
|-----------|---------|-----------|
| `__addNode: Node` | create a node | `nodes.set`; if it has a `parent`, push to `parent.children`, else push to `rootNodeUuids` |
| `__deleteNode: true` | remove a node | detach from `parent.children`, `nodes.delete`, drop from `rootNodeUuids` |
| `__reparent: { parent, index? }` | move within the tree | detach from current parent/root, insert into the new parent's `children` (or `rootNodeUuids`) at `index` (appended if omitted), update `node.parent` |
| `geometry: {…}` | patch geometry | `Object.assign(node.geometry, …)` |
| `style: {…}` | patch style | `Object.assign(node.style, …)` |
| `layout: {…}` | patch layout | `Object.assign(node.layout, …)` |
| `text` / `src` / `name` | scalar set | assigned when not `undefined` |

**Terminal vs. composable structural keys.** `__addNode` and `__deleteNode` are
*terminal*: they fully describe the node's fate, and mixing property keys with them in
one delta is meaningless — don't. `__reparent` is structural but **composable**: it is
applied and then execution falls through to the property assignments, so
`{ __reparent, geometry }` is legal and lands both (a transaction that drops a node into
a frame and repositions it emits exactly that).

`__reparent` also detaches from the **destination** before inserting, so re-parenting a
node that the destination already lists (e.g. an `__addNode` that baked the child into
its new parent's `children`) cannot duplicate the entry.

## 3. Dispatch lifecycle

`ActionDispatcher.dispatchAction(action)` (`ActionDispatcher.ts`) runs:

```
validate → execute → apply → commit → notify
```

1. Guard: not an `Action` → `{ success: false }`.
2. `validate()` false → `{ success: false }`.
3. `execute()` throwing → caught → `{ success: false }`.
4. `execute()` returns `{ success: false }` → returned as-is (no apply/commit).
5. Otherwise: `applyMutationsToDocument` → `historyManager.commitRevision` → `notify`.

**The dispatcher never throws out of dispatch.** Failures are values, not exceptions —
callers (e.g. React event handlers) can't be crashed by a bad edit.

**Listener isolation:** `notify` wraps each `onChange` listener in try/catch, so one
throwing subscriber neither skips the others nor propagates after the mutation committed.

`onChange(listener) → unsubscribe` is the subscription API.

## 4. History & undo/redo (snapshot model)

`HistoryManager` (`HistoryManager.ts`) stores an array of immutable `Revision`s and a
cursor. **No actions are re-executed on undo/redo** — a full snapshot is restored.

- `commitRevision(payload, doc)`: truncates any redo tail, deep-clones the document via
  `cloneDocument` (JSON round-trip; `Map`→object, `Date`→ISO string), pushes it, and
  trims to `MAX_HISTORY_SIZE = 200` — **but never evicts index 0**, so "undo all the
  way back" always reaches the true starting document.
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
with `fullReload: true` (and `updatedNodeIds` = all current node ids) so delta-driven
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
