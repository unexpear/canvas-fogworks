# Action System

<!-- describes: src/core/actions -->

> 🔒 Frozen contract · schema v56 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins). Code in `src/core/actions/`.

The action system is the engine's spine: it is **the only way the document changes**,
and it is what makes undo/redo, and later AI, plugins, and collaboration, safe.

## PaintSurfaceAction — a stroke through the dispatcher (schema 55)

```ts
new PaintSurfaceAction(document, nodeId, patch: PixelPatch)
```

Painting is an Action like everything else, so undo, transactions and coalescing work by default
rather than through a private stack beside them.

**IT CARRIES A PATCH, NOT A SURFACE.** A 4096-square buffer is 67 MB; an action holding one would
make twenty pencil dots cost 1.3 GB of history. The patch is the rectangle that changed, already
measured by `capturePatch` rather than trusted from the caller.

**The new payload is computed IN the action** — decode, patch, re-encode. A caller supplying both
the patch and the encoded result could get them out of step, and the disagreement would only appear
on the next load.

**An EMPTY patch is invalid**, not a harmless no-op: it would put a step on the undo stack that
undoes nothing, so a user pressing undo once would appear to have been ignored.

**There is no `reverse` flag.** An earlier version had one and nothing reached it — the dispatcher
undoes by REPLAYING DELTAS, never by running an inverted action. A parameter no path reaches is a
second way to express undo that can disagree with the real one.

> **A DELTA FIELD THIS LAYER EMITS MUST EXIST IN `applyMutations`.** `surface` did not, so the
> action validated, returned `success: true`, and the document kept its old pixels. Nothing threw.
> `success` is not evidence that anything changed — a test must read the RESULT back out of the
> document, not assert on the action's return.

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
| `PasteNodesAction` | `{ kind: "add", node }` per node — ONE action for the whole paste, so undo removes the group rather than its last node. `AddNodeAction` cannot serve: it builds one node from a type and a box, and a paste carries whole subtrees that already exist as nodes. The IDS ARE MINTED BEFORE the action (in `remapForPaste`) and held for its lifetime, because the dispatcher may execute an action more than once — minting inside `execute` would make a redo add a SECOND copy and leave the selection pointing at nodes that never existed. Refuses a colliding id (it would replace a node and orphan its children) and an orphan parent (which saves fine and fails to reopen) |
| `AddNodeAction` | `{ kind: "add", node }` — optional `content` carries a `core.text`'s text, a `core.path`'s commands, a `core.image`'s src, or a `core.raster`'s **surface** (validated by the shared `pathError`/`srcError`/`rasterSurfaceError`, the first EDIT-path callers of them). A raster MUST be creatable with pixels: one without a surface is not a smaller picture but a node `PaintSurfaceAction` refuses, so it would exist and be permanently inert — creating it and giving it pixels is one act. Only a `core.raster` may carry one, and an optional `stroke` makes the node an OUTLINE (`fill: "none"` + stroke). The assembled style is checked by the shared `styleError` — a created node's style was previously never validated at all |
| `FrameSelectionAction` | `{ kind: "add" }` for a frame rectangle + `{ kind: "patch", reparent, geometry }` per member — wraps the selection in a parent sized to fit it, rebasing each member onto the frame's origin so nothing MOVES on screen. The editor's only way to build a hierarchy. SIBLINGS ONLY (one shared parent = one space to rebase in) and NOT inside an auto-layout/grid container, where stored x/y is dead data. The frame is fitted to the members' TRANSFORMED boxes, takes the frontmost member's z-position, keeps their relative order, and CLEARS each member's constraints/constraintRef (they describe the old parent, and would undo the rebase) |
| `DeleteNodeAction` | `{ kind: "delete" }` for the node **and every descendant** (cycle-safe) |
| `MoveNodeAction` | `{ kind: "patch", geometry: { x, y } }` |
| `ResizeNodeAction` | `{ kind: "patch", geometry: { width, height } }` |
| `UpdateNodeGeometryAction` | `{ kind: "patch", geometry: {…partial…} }` |
| `UpdateNodeStyleAction` | `{ kind: "patch", style: {…partial…} }` |
| `UpdateNodeTransformAction` | `{ kind: "patch", transform: {…partial…} }` — rotation/scale/origin |
| `UpdateNodeContentAction` | `{ kind: "patch", text?/src?/name? }` — the write path for a node's CONTENT. Until this existed a `core.text` node's text was write-once-at-creation, an image's `src` could not be changed, and `Node.name` could not be set at all. `src` obeys the shared `srcError`; `name` is length-capped. An omitted field is left alone; a field cannot be CLEARED back to absent (the delta layer encodes "not mentioned" as `undefined`) |
| `UpdateNodeLayoutAction` | `{ kind: "patch", layout: {…partial…} }` — M2 layout (container/grid/grow/constraints/position/margin). Carries grid⊕container exclusivity IN the delta, and auto-captures `constraintRef` from a NON-container parent's stored size on first opt-in |
| `ReparentNodeAction` | `{ kind: "patch", reparent: { parent, index? } }` |
| `CreateInstanceAction` | `{ kind: "add", node }` — a `core.instance` sized to its MASTER (M6); the master must exist at creation time (a DANGLING reference is only valid at rest) |
| `SetInstanceOverrideAction` | `{ kind: "patch", overrides }` — set/clear ONE per-instance override (M6 slice 2), keyed by master node id; patches MERGE field-by-field so a move then a resize accumulate, `null` clears the entry (reset to master); validated via the shared `overridesError` **and** `overrideAgainstMasterError` (the type-aware half, which needs the document) |
| `SetVariantAction` | `{ kind: "patch", variant }` — tag a node into a variant SET, or (with `null`) untag it (schema 27). There is no set object to create: a set is the masters that name it, so this action both starts and ends one. Validated via the shared `variantError` |
| `SetInstanceVariantAction` | `{ kind: "patch", variants }` — choose ONE variant property on an instance (schema 27). The selection MERGES, so choosing `size` does not forget `state`; `null` clears a property (back to the master's own value), and an emptied selection is stored ABSENT rather than `{}` so equal documents still compare equal. Both variant deltas are applied with an `in` test, not `!== undefined`, because CLEARING is a real edit. A switch also RESIZES the instance to the new variant — but only when the box is still the size the old variant made it, so a deliberate resize survives — and REMAPS the overrides onto the new variant's nodes (`remapOverridesForVariant`), without which every edit to the copy vanished on switch. Validated via the shared `variantSelectionError` |
| `UpdateNodePathAction` | `{ kind: "patch", path }` — sets a `core.path`'s drawing commands. The write path `Node.path` never had: paths could only enter a document by hand-editing a file. A whole-array replace (a path is edited as a shape, not field by field); validated by the shared, TYPE-AWARE `pathError`, so it refuses path data on a non-path node without a separate check. |
| `SetSlotAction` | `{ kind: "patch", slot }` — name a node as a SLOT, or (with `null`) stop it being one (schema 29). Like a variant set, a slot needs no object of its own. Validated via the shared `slotError` |
| `SetSlotContentAction` | `{ kind: "patch", slotContent }` — put a node in ONE of an instance's slots, or (with `null`) empty it (schema 29). Fills MERGE; an emptied map is stored ABSENT, not `{}`. The fill is a REFERENCE — nothing is moved. Refuses filling a slot with the instance ITSELF, the one fill that could never draw. Validated via the shared `slotContentError` |
| `DetachInstanceAction` | one `{ kind: "add" }` per baked node + `{ kind: "delete" }` for the instance (M6 slice 3) — bakes what the instance was DRAWING into ordinary nodes via the shared `materializeNode`, severing the link to the master. The root takes the instance's position AND its `index` among its siblings (z-order). A NESTED instance is copied as an instance, not expanded. The baked root also inherits what the INSTANCE contributed on screen — its transform and its PARENT-facing layout (constraints/grow/shrink/margin/position/spans), while the master root keeps the CHILD-facing layout (container/grid). REFUSES: a dangling instance (nothing to bake), an instance nested inside its OWN master (baking would edit the component and change every other instance), and an instance whose transform would have to compose with the master root's (not representable as one Node.transform) |
| `alignAction` / `distributeAction` (factories) | a `TransactionAction` of routed geometry patches — one undo per click. Align references the SELECTION's own bounding box (so it is idempotent); distribute equalises the GAPS and pins the two extremes. Only selection ROOTS move, each must be a TRANSLATION-ONLY chain (a world delta is only a stored delta through one), and a laid-out child is skipped because its stored x/y is dead data. Returns null when nothing would move, so an already-aligned click pushes no empty undo step |
| `booleanAction` (factory) | a `TransactionAction` of `{ kind: "add" }` + the result's path + one `{ kind: "delete" }` per operand — combining shapes is ONE undo. Folds in DRAW order (bottom-most first, so `subtract` cuts the shapes above out of the one below whatever order they were clicked) and in WORLD space, the only space nodes with different parents and transforms share. Every operand converts to an outline first (`ShapeToPath`), which is how a rectangle and an ellipse can be combined at all; a `core.line` has no interior and is refused. Returns null — changing nothing — for fewer than two operands with an outline, or an empty result, rather than deleting shapes to produce a zero-area node. DESTRUCTIVE: a `core.boolean` node that keeps its children and resolves at derivation time is a later slice. Folds through `Resolve.resolveBooleanPaths`, NOT the older `PathBoolean.booleanPaths` — the latter classifies an edge piece by whether its midpoint lies inside the other shape, which has no answer when the shapes share an edge, so the UNION of two axis-aligned rectangles at the same `y` came back empty and this factory then correctly returned null and did nothing. Aligning two rectangles and merging them is close to the most ordinary thing anybody does here, and it was a silent no-op |
| `makeBooleanNodeAction` (factory) | a `TransactionAction` of `{ kind: "add" }` for a `core.boolean` + one reparent and one re-base per operand — the NON-destructive combine (schema 33). The operands become its children and stay editable; the shape is derived by `resolveBooleans` at the display seam, so moving a child or switching the operation re-derives it. Same sibling/re-basing rules as `FrameSelectionAction`: one shared parent, and never inside an auto-layout container, where stored x/y is dead data |
| `SetDepthAction` | `{ kind: "patch", depth }` — how far BACK a node sits (schema 40). One field on purpose, like `SetBooleanOpAction`: nudging a layer backwards is ONE undoable edit that re-sorts the drawing, re-parallaxes it and re-writes its z, with the shape untouched. A depth of exactly 0 REMOVES the field, so a node returned to the page serialises like one never layered |
| `SetTrackAction` | `{ kind: "patch", track }` — a node's KEYFRAMES (schema 39). Validated by the shared `trackError` (timing) plus `overrideValueError` (values), the same two rules the loader runs, so it cannot author a track a reload would refuse. An EMPTY track REMOVES the field, so a node whose animation was deleted serialises like one that was never animated |
| `SetTimelineAction` | `{ kind: "timeline", timeline }` under `DOCUMENT_DELTA_KEY` — the document's clock. Whole-value like `activeState`; `undefined` removes it. A transaction carrying more than ONE document-level delta (variables / active state / timeline) is REFUSED rather than silently losing the others — counted rather than compared pairwise, since a pairwise test stops covering them all the moment a third claimant arrives |
| `outlineStrokeAction` (factory) | a `TransactionAction` of `{ kind: "add" }` + the new path's commands + a style patch that REMOVES the source's stroke — one undo per click, for the whole selection. Turns each selected node's BORDER into a `core.path`, so it becomes something you can select, cut with a boolean and reshape; the node itself survives, minus its border, because outlining a border should not throw away the shape it went round. Offsets in LOCAL space and transforms afterwards, which is where `stroke-width` means what it means — a node scaled 2x has a border twice as thick, on screen and therefore in the outline. ALIGNMENT (center/inner/outer) is an argument HERE rather than a field on the node: no backend can draw an off-centre border, but every backend draws the resulting fill identically. Returns null when nothing in the selection has an outlineable border — a HAIRLINE most notably, whose width is one screen pixel at any zoom and so has no world-unit area to become a shape |
| `SetBooleanOpAction` | `{ kind: "patch", booleanOp }` — re-point a `core.boolean` at a different operation (schema 33). A one-field action precisely because the operation is meant to stay a decision: switching union → subtract is one undoable edit that re-derives the shape with the operands untouched. Validated by the shared, type-aware `booleanOpError` |
| `DuplicateNodesAction` | one `{ kind: "add" }` per copied node — deep-copies the selection ROOTS and their subtrees, offset by `DUPLICATE_OFFSET`, with ids remapped THROUGHOUT so links point inside the copy. Each copy is inserted directly AFTER its original in the sibling order (a duplicate must not re-stack the document). Only the root is offset; a child moved with its parent. Refuses an instance COPY — duplicating the INSTANCE is that gesture |
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
  | { kind: "add";    node: Node; index?: number }
  | { kind: "delete" }
  | { kind: "patch";  reparent?: { parent: string | null; index?: number };
                      geometry?: Partial<Geometry>; transform?: Partial<Transform>;
                      style?: Partial<Style>; layout?: Partial<Layout>;
                      text?: string; src?: string; name?: string;
                      overrides?: Record<string, InstanceOverride> };  // whole-map replace
```

| Variant | Meaning | Applied as |
|---------|---------|-----------|
| `add` | create a node | `nodes.set`; if it has a resolvable `parent`, insert into `parent.children` at `index` (appended when omitted, clamped like `reparent`), else land it at the root. `index` exists so a node REPLACING another in place (`DetachInstanceAction`) keeps its z-order instead of jumping to the front |
| `delete` | remove a node | detach from `parent.children`, `nodes.delete`, drop from `rootNodeUuids` |
| `patch.reparent` | move within the tree | resolve the destination first, detach from **both** the source and the destination, then insert at `index` (appended if omitted) |
| `patch.geometry` / `.style` / `.layout` | patch | `Object.assign(node.<field>, …)` |
| `patch.transform` | patch | `node.transform = { ...node.transform, ...delta.transform }` (created if absent) |
| `patch.text` / `.src` / `.name` | scalar set | assigned when not `undefined` |
| `patch.overrides` | whole-map replace | `node.overrides = delta.overrides` — whole-map, not per-key, so a transaction merge is last-wins on a coherent value (the ACTION does the field-level merging) |

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

**Merging two patches for the same node** (`mergePatch`) is **later-wins**, and the merge is a
**spread** — deliberately total, not a list of fields. A hand-written allow-list is correct only
until the next field is added to `PatchDelta`, and nothing forces that edit: the list silently ate
`path`, `hidden`, `locked`, `variant`, `variants`, `slot`, `slotContent` and `states`, which
surfaced as a vertex drag (a geometry action + a path action) moving a node's box and leaving its
ink behind. A spread also preserves **key presence**, which is exactly what the `in`-read fields
need — carrying a key with `undefined` is how they express a *clear*. The four object-valued
fields (`geometry`, `transform`, `style`, `layout`) still merge **field by field**, because their
actions emit partials: a move (`{x,y}`) and a resize (`{width,height}`) in one transaction must
both land, and `layout`'s grid ⊕ container exclusivity rides along as an explicit `undefined`
that resolves last-wins instead of dropping both.

## 6. Why this matters downstream

Because every change is a validated, serializable, reversible Action funnelled through
one dispatcher:
- **Milestone 15 (Scripting) is now real, and it is that promise mechanised.** A script runs
  in a WORKER (no DOM, no preload bridge, and the network globals deleted by the bootstrap), and
  the boundary is plain data in both directions: it receives a frozen SNAPSHOT, never the
  document, and returns REQUESTS, never Actions. `compileScript` turns those into ordinary
  Actions, each one validated by the SAME validator the inspector and the loader run — so a
  script can only ask for edits a person could make by hand, and the whole run lands as one
  transaction, one undo. Refusals are reported per request rather than thrown, because one bad
  line must not discard the good ones. A runaway script is stopped by TERMINATING the worker;
  that is the only reliable interrupt for a loop, and the reason scripts are not run on the
  main thread at all.
- **Milestone 14 (AI)** and **Milestone 15 (Plugins)** can only ever emit Actions — they
  cannot corrupt the document or bypass history.
- **Milestone 16 (Collaboration)** gets a clean, linear, serializable revision stream to
  branch, merge, and resolve against.

Do not add side-channels that mutate the document outside this system.
