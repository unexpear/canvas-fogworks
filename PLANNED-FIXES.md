# PLANNED-FIXES.md — Reconciled (fix-all pass complete)

> **A HISTORICAL RECORD of the fix-all pass completed 2026-07-23**, kept for what it
> decided and why. Its numbers are that pass's numbers — the gate was green at **97
> tests** then — and are deliberately NOT updated: rewriting them would destroy the
> record while pretending to maintain it. For where the project stands now see
> [MILESTONES.md](MILESTONES.md) and [docs/README.md](docs/README.md).

<!-- describes: src/core/document -->
<!-- re-read 2026-09-07 against schema 78 and the shared-authoring follow-up. This is still
     the historical July fix-pass record; current evidence is in docs/PRODUCTION-WORK.md. -->
<!-- re-read 2026-09-05: schema 77 adds animation controllers; this historical fix-pass record
     remains unchanged in meaning. Current behavior is described in docs/ANIMATION.md. -->
<!-- re-read 2026-09-03 for the Canvas Fogworks rename: still accurate BECAUSE IT IS FROZEN;
     persisted `.vde` and `vde.*` compatibility identifiers intentionally remain unchanged. -->
<!-- re-read 2026-09-03 for the production and 3D foundation baseline: still accurate BECAUSE
     IT IS FROZEN. Current implementation status remains in MILESTONES.md and docs/README.md. -->
<!-- re-read 2026-08-17 after schema 72 (the document screen + playBounds): still accurate BECAUSE
     IT IS FROZEN. This file is the 2026-07-23 record; the screen is not in it. -->
<!-- re-read 2026-08-16 after schema 71 (per-axis parallax): still accurate BECAUSE IT IS FROZEN. -->
<!-- re-read 2026-08-16 after the parallax dirty-set fix: still accurate BECAUSE IT IS FROZEN. -->
<!-- re-read 2026-08-16 after schema 70 (the document background): still accurate BECAUSE IT IS
     FROZEN. This file is the 2026-07-23 record and the background is not in it. -->
<!-- re-read 2026-08-15 after schema 69 (a node's own playhead): still accurate BECAUSE IT IS FROZEN.
     The step moves no data — a node without a frame reads the document's, which is what every node
     already did — so nothing this record decided is affected. -->
<!-- re-read 2026-08-14 after the dropHidden/movedIds/reciprocal-side fixes: still accurate BECAUSE
     IT IS FROZEN; none of the three touched anything this record decided. -->
<!-- re-read 2026-08-13 after schema 68 and the collection draw path: still accurate BECAUSE IT IS FROZEN. This file is the record of
     the 2026-07-23 pass and its numbers are that pass's; it is flagged by drift only because
     `src/core/document` keeps moving under it. Current status lives in MILESTONES.md and
     docs/README.md. -->

## ⚠️ Identifier namespaces — read first

Two different `M<n>` schemes exist in this repo. They are **not** the same thing:

| Prefix | Meaning | Lives in |
|--------|---------|----------|
| `AUD-C/H/M/L/T<n>` | An **audit finding** from the original review (severity + number) | this file |
| `NEW-<n>` | A finding discovered during the reconciliation pass | this file |
| `R<n>` | A **regression** found and fixed during the fix campaign | this file |
| `M<n>` | A **roadmap milestone** (M0 through M17) | [MILESTONES.md](MILESTONES.md) |

Audit ids in this file are written `AUD-M8`, `AUD-H2`, … precisely so they cannot be
confused with roadmap milestones. A bare `M8` **always** means milestone 8.

## Where things stand

| Bucket | Count | Fixed | N/A |
|--------|------:|------:|----:|
| Original audit (CRITICAL/HIGH/MEDIUM/LOW/TEST) | 79 | 78 | 1 (`AUD-H1`) |
| New findings from reconciliation | 34 | 34 | 0 |
| Regressions found by the fix campaign (`R1`–`R4`) | 4 | 4 | 0 |
| Confirmed findings from the project+docs review | 8 | 8 | 0 |

> **Evidence caveat — do not treat the first two rows as independently verifiable.**
> The original itemised audit was **overwritten** by this reconciliation and the repo
> is not under version control, so per-item detail survives only for the ids named
> below (17 original ids and 30 `NEW-` ids). The remaining counts are carried over
> from the reconciliation pass and **cannot be re-derived from anything in the repo**.
> Rows 3 and 4 *are* fully itemised and independently checkable. Treat rows 1–2 as
> historical bookkeeping, not as verified status.

Capabilities added across the fix passes: a shared `applyMutations` helper,
`Action.rebind`, optional explicit id **and parent** on `AddNodeAction`,
`ReparentNodeAction`, `traverseSceneGraph`, `SCHEMA_VERSION`, history coalescing,
`Style.fontSize`, `EditorState.isDragging`/`previewRect`/`pendingGeometry`,
`MutationResult.fullReload`, a typed `DocumentSnapshot`, and `typecheck`/`check`
npm scripts. Test count 43 → **97**.

---

## Fixed in the fix-all pass

### Core engine
- **NEW-7 (R2) / undo aliasing** — `hydrateDocument` deep-clones the snapshot; edit-after-undo no longer corrupts history. *(regression test)*
- **NEW-8** — `ActionDispatcher.notify()` isolates each listener in try/catch. *(test: throwing listener)*
- **NEW-9** — `applyMutations` (now shared in `applyMutations.ts`) is parent-aware on `__addNode`.
- **NEW-10** — undo/redo notifications carry the restored node ids + `fullReload: true`.
- **NEW-11** — `AddNodeAction.execute()` self-validates.
- **AUD-H17 + NEW-12** — `TransactionAction` rewritten to simulate on a working copy: component actions compose (create-then-edit in one atomic step), conflicts are rejected in any order, and the net delta is collapsed to one entry per node. *(tests: create-then-edit, delete-then-edit)*
- **NEW-13** — `DeleteNodeAction.collectDescendants` de-duplicates across DAG paths.
- **NEW-14** — `ResizeNodeAction.serialize()` keys match the constructor.
- **AUD-M17** — `HistoryManager`/`Revision` use the typed `DocumentSnapshot`.

### Serializer
- **NEW-1** — `compareDocuments` now compares `created_by` and `date`.
- **AUD-M18 / NEW-2 / NEW-4** — `deserializeDocument` validates each node's shape and key/id agreement, and no longer overwrites safe defaults with `undefined`. *(tests: malformed node, key/id mismatch)*
- **NEW-3** — `serializeDocument` stamps `doc.version`.
- **NEW-6** — corrected the stale migration/`v0.1.0` comments.

### Editor & renderer
- **AUD-H2** — corner resize is computed from the fixed opposite corner, so it flips instead of pinning at 1px. *(browser-verified)*
- **AUD-H3** — `MoveTool` filters a stale selection on mouse-down and aborts cleanly when tracked nodes vanish mid-drag; **Escape** reverts and cancels a move.
- **NEW-16** — multi-delete is one `TransactionAction` (one undo restores the whole selection); descendants of a selected node are filtered out.
- **NEW-17 (partial) / NEW-18** — `RectangleTool` rewritten to a **preview-based, single-revision** flow: no live-document mutation during drag, one `AddNodeAction` on release, Escape cancels. *(browser-verified: preview shows, one node committed, preview clears)*
- **AUD-M8** — text nodes read `Style.fontSize` (default 14).
- **AUD-M10 / NEW-21** — renderer uses persistent `grid`/`content`/`overlay` groups; the grid rebuilds only when the visible range changes and its density is capped, so node drags/selection no longer thrash thousands of lines.
- **NEW-22** — rectangle stroke width uses `1/z`.

### App shell
- **AUD-M20** — Move tool shows a `grabbing` cursor while dragging (`EditorState.isDragging`).
- **AUD-M23 / NEW-24** — `refresh()` is a single consolidated `setState`; the dead per-frame document deep-copy is gone.
- **NEW-23** — wheel-zoom repaints immediately.

### Electron
- **AUD-M14 / NEW-27** — `save-file` only writes to dialog-approved paths and validates that content is a string.
- **NEW-25** — preload subscriptions return unsubscribe disposers.
- **NEW-26** — removed the dangling leading separator in the Edit menu.
- **NEW-28** — `loadFile` failure surfaces via `.catch` + `did-fail-load` error box.

### Build & tests
- **AUD-L9** — `typecheck` (over `tsconfig.test.json`) and `check` scripts added; tests now type-check in CI.
- **AUD-L10** — version injected from `package.json` via esbuild `define`; `CURRENT_VERSION` derives from it with a literal fallback that a **drift test** keeps in sync.
- **NEW-30** — watch mode re-copies `index.html` on change.
- **NEW-31** — `npm run dev` runs the watch build and launches Electron.
- **AUD-M11** — Escape now cancels resize, rectangle draw, and move.
- **NEW-32** — the mislabeled "dispatch after redo" test is renamed; a real `redo()` path test was added.
- **NEW-33 / NEW-34 / AUD-T1(d) / AUD-T4** — variables round-trip uses the real `VariableStore` shape; metadata round-trip asserts `date`/`created_by`; a throwing-listener test and same-node transaction tests were added.

---

## Follow-up pass — the last deferred items (all now fixed)

- **AUD-M19 — fixed.** `Serializer.loadResult()` returns a discriminated `empty | loaded | corrupt` result (with the unreadable data preserved to a backup key); `load()` stays backwards-compatible. *(tests: empty / loaded / corrupt)*
- **NEW-5 — fixed.** Split `DocumentMetadata` (runtime `Date`) from `SerializedMetadata` (wire `string`); `SerializedDocument` and `DocumentSnapshot` use the accurate type, and serialize writes an explicit ISO string.
- **NEW-17 — fixed.** `MoveTool` and corner-resize now preview through a renderer **geometry-override** channel (`EditorState.geometryOverrides`) and never mutate the document during a drag; the single committed action fires on mouse-up. *(browser-verified: move renders at the dragged position, commits, undoes; resize 150→210 commits, Escape mid-resize cancels)*
- **Electron File-menu wiring — done.** `App` subscribes to `window.electronAPI` (New / Open / Save / Save As) with effect-cleanup disposers, backed by a new `ActionDispatcher.loadDocument` that swaps the document and resets history. No-ops safely in the browser build. *(test: loadDocument resets history)*

Supporting additions this pass: `ActionDispatcher.loadDocument`, `Serializer.LoadResult`/`loadResult`, `DocumentMetadata`/`SerializedMetadata`, `EditorState.geometryOverrides`.

- **AUD-H1 — N/A (unchanged).** The audit's "partial-delta replay" failure can't occur; history is snapshot-based.

---

## Project + documentation review pass (8 confirmed findings — all fixed)

An independent multi-agent review of the whole project *and* every planning doc
raised 23 HIGH claims; adversarial verification confirmed **8**. All are now fixed.

1. **`RV-1` Schema/app version coupling.** `CURRENT_VERSION` was the app version
   *and* the document schema gate, so bumping `package.json` would have made every
   saved document unloadable (and `loadResult` would classify the user's own
   autosave as *corrupt*). Split out **`SCHEMA_VERSION`** (hand-bumped, currently
   `"1"`); legacy semver-stamped files are accepted and re-stamped; a genuinely
   newer schema gets a clear error. *(tests: decoupling, legacy load, newer-schema)*
2. **`RV-2` Inspector flooded history.** One slider drag committed ~100 revisions;
   two drags hit the 200 cap and **permanently evicted the INITIAL revision**, so
   the user could never undo back to the start. Added **coalescing** (same node +
   same continuous action within 400 ms collapses to one undo step) and the trim
   now **never evicts index 0**. *(tests: coalescing, discrete-not-coalesced, overflow)*
3. **`RV-3` Open → Ctrl+S saved to the wrong place.** `file-opened` never carried
   the path, so Save silently wrote to localStorage. The path now travels with the
   content and is registered as save-approved; with no path, Save now **prompts
   Save As** (new `request-save-as` IPC) instead of diverting.
4. **`RV-4` `onChange` was documented but unused.** `App` now subscribes
   (`dispatcher.onChange(refresh)`), so document changes repaint from any source;
   ephemeral editor state still uses the explicit `refresh` callback.
5. **`RV-5` "Scene graph" was overstated.** Nothing could create a nested node.
   Added **`ReparentNodeAction`** (rejects self-parenting and cycles, supports an
   insertion index), a **`parentId`** option on `AddNodeAction`, and a `__reparent`
   delta in `applyMutations`. *(tests: nested add, reparent + undo, index, cycles)*
6. **`RV-6` Unfalsifiable status table.** Added the evidence caveat above.
7. **`RV-7` `M<n>` namespace collision.** Audit ids are now `AUD-*`; see the
   namespace table at the top of this file.
8. **`RV-8` No scene-graph traversal.** Draw order was `Map` insertion order.
   Added **`traverseSceneGraph`** (depth-first, cycle-safe, keeps orphans) and both
   the renderer and the layers panel now use it. *(tests: tree order, cycle safety)*

Also fixed alongside: `AddNodeAction` now rejects a **duplicate explicit id**
(previously it silently replaced an existing node).

---

## Milestone reality-check pass (M0 completion + M1 prerequisites)

**M0 — the two overstated deliverables are now genuinely true.**
- *Scene Graph* — closed earlier this session (`AddNodeAction` `parentId`,
  `ReparentNodeAction`, `traverseSceneGraph`).
- *Validation* — **`validateDocumentIntegrity`** (`src/core/document/Integrity.ts`) now
  runs inside `deserializeDocument`. It rejects out-of-range values (`opacity: 5`,
  negative size, bad radius/fontSize), dangling parents, ghost/duplicate roots,
  children not claimed or not back-pointing, parentless non-roots, and cycles.
  Previously these invariants held only on the Action path. *(7 tests)*

**M1 prerequisites — all five met.**

| # | Prerequisite | How it was met |
|---|--------------|----------------|
| 1 | Scene-graph traversal used by renderer + layers | `traverseSceneGraph`; draw order is tree order, not `Map` order |
| 2 | Coordinate-space rule in the schema; transform reserved | **stored `x/y` is parent-relative**, world is computed by `computeWorldGeometry`; rotation reserved for a future optional `Node.transform` — **adding it will require a `SCHEMA_VERSION` bump**, since an old build that ignores it would silently render rotated nodes unrotated |
| 3 | Previews as a computation input, not a renderer bypass | `EditorState.geometryOverrides` → **`pendingGeometry`** (`Partial<Geometry>` patches) fed into `computeWorldGeometry`; **a parent drag now moves its children** — impossible with the old render-time override |
| 4 | Real dirty set on undo/redo | `restoreNotification(previous, restored)` diffs the two documents; `fullReload` kept as an alias hint |
| 5 | Hit-testing off computed state, not DOM | `hitTest(computed, x, y)`; `SelectTool` no longer reads `data-node-id` |

**New modules:** `core/document/Integrity.ts`, `core/geometry/ComputedGeometry.ts`
(`WorldRect`, `ComputedGeometry`, `computeWorldGeometry`, `hitTest`).
**Changed contracts:** `RendererState.geometryOverrides` → `RendererState.computed`
(required); `EditorState.geometryOverrides` → `pendingGeometry`. Docs updated per the
freeze rule. Test count 68 → **81**.

> **M1 is now a producer swap, not a consumer rewrite:** every consumer already reads
> the computed structure, so `GeometryEngine` replaces `computeWorldGeometry` and
> `ComputedGeometry` widens into `ComputedState`.

---

## Rule-soundness audit (11 confirmed flaws — all fixed)

An adversarial audit of every rule the project encodes raised 29 serious claims;
independent verification **confirmed 11, downgraded 18, refuted 0**. Every confirmed
flaw sat at a **carve-out, allow-list, threshold, or one-directional check** — the
general mechanisms all held.

**Data-corrupting (fixed):**
- `RS-1` **"Group the selection" wrote an unopenable file.** `__reparent` detached from
  the source but not the **destination**, so an add-then-reparent transaction produced
  `children: ["x","x"]`. Invisible on canvas (traversal dedupes); the saved file then
  failed integrity on reload. Now detaches from the destination first. *(test asserts a
  save/load round-trip)*
- `RS-2` **Moving a parent together with its own child applied the drag twice.**
  `MoveTool` patched both, then composition added the parent's delta again. Now uses the
  shared **`selectionRoots`** helper — extracted precisely because duplicating that filter
  is what caused the bug (`deleteSelectedNodes` had it, `MoveTool` didn't).
- `RS-3` **Stale actions half-applied.** `validate()` checked the action's bound document
  while the mutation hit `currentDocumentState`; after an undo they differ, so an action
  passed the gate and orphaned a node with `success: true`. `dispatchAction` now
  **rebinds before validating**, so stale actions fail closed.
- `RS-4` **`{ width: undefined }` passed validation.** Guards were value-based
  (`!== undefined`), but `Object.assign` copies a present key regardless of value — the
  node vanished and the saved file became unloadable. Guards are now **presence-based** (`in`).
- `RS-5` **Reparent + move in one transaction silently dropped the move.** `__reparent`
  was terminal; it is now **composable** and falls through to property assignments.

**Integrity / composition (fixed):**
- `RS-6` **Parent↔child linkage was checked one way only.** A child pointing at a parent
  that doesn't list it loaded fine, then deleting that parent orphaned it and the file
  became unopenable. Integrity is now **bidirectional**.
- `RS-7` **Composition silently invented an origin.** An unresolved ancestor fell back to
  `(0,0)`, drawing the node in the wrong place *and* making hit-testing agree with the
  wrong drawing. Such nodes are now skipped rather than misplaced.

**Versioning (fixed):**
- `RS-8` **The legacy-semver carve-out was a time bomb.** It re-stamped to whatever
  `SCHEMA_VERSION` currently is and `return`ed **before** the migration chain — so the
  first real bump would have marked every legacy file "fully migrated" and skipped the
  migration. Now: refuse-newer **first**, normalise legacy stamps to the schema they
  actually are (`"1"`), then **fall through** the chain. The open regex is replaced by a
  **closed set** of the five app versions that genuinely shipped shape 1.
- `RS-9` **"Over-bumping is cheap / fails loudly" was false.** The installer checked into
  `exe/` predates the gate and swallows the failure — for that reader a bump is silent
  data loss. Claim qualified; `App` now uses `loadResult()`, surfaces a corrupt autosave
  in the toolbar, and **confirms before overwriting** it.
- `RS-10` **The review checklist contradicted the rule it checks** ("version bumped" for
  *any* frozen-contract change), re-arming the destroy-every-document failure. Rewritten.
- `RS-11` **The freeze-rule trigger was shape-only**, so it structurally could not catch a
  meaning-only redefinition — and we shipped one (`geometry.x/y` world → parent-relative).
  The trigger is now **shape *or interpretation***, and the ambiguity is recorded in
  `SCHEMA_VERSION`'s history block.

Also fixed: coalescing is now **opt-in by the caller** (`dispatchAction(a, { coalesce: true })`)
rather than an allow-list of action classes — the class couldn't distinguish the
inspector (continuous) from a drag commit (discrete), so two deliberate drags collapsed
into one undo step. Test count 81 → **89**.

---

## Rule-audit follow-ups (medium/low findings)

The audit's remaining medium/low findings, worked after the 11 confirmed flaws.

**Validation completeness**
- `node.type` is now checked for **membership** in `NODE_TYPES` (single source of
  truth, `isNodeType`) on both paths — an unknown type previously loaded and rendered
  as a fallback box, silently misrepresenting the document.
- `isValidNode` now also validates `layout`, `parent`, `children` element types,
  `style.stroke/radius/fontSize`, and `text`/`src`/`name`/`states`.
- Metadata is **validated, not just defaulted**: a non-string name or unparseable date
  falls back instead of flowing through (an `Invalid Date` serializes to `null`, quietly
  losing the field).
- `fontSize` is settable via `StyleUpdate` and validated (`> 0`) — the schema table
  asserted Action-path coverage that did not exist.

**Dispatcher / transactions**
- **`dispatch` now never throws, with no boundary.** `validate()` is inside the
  try/catch, and the apply/commit stage is guarded with a **rollback** to the last
  revision so the live document and history cannot diverge.
- **Add-then-delete in one transaction emits nothing.** `addedIds` is a live set, so it
  could not answer "did this exist before the transaction?"; a new `everAdded` set makes
  the documented net-no-op skip actually fire (it previously emitted `__deleteNode` for a
  node the real document never had).

**Editor / geometry**
- Resize handles clamp in **screen pixels** (`HANDLE_SIZE_PX / z`). Clamping `8/z`
  clamped a *world* size, so past zoom 2 the handle stopped being 8px on screen.
- The rectangle minimum size is a **screen-pixel** threshold, and the preview uses the
  identical predicate — what is drawn is exactly what commits.
- `clampViewport` scales the pan limit by zoom; at zoom 20 nothing beyond world x≈500
  was previously reachable.
- Inspector number fields **skip non-numeric input** instead of substituting `0`
  (`parseFloat(...) || 0` turned a half-typed value into an edit that snapped to 0).

**History**
- Coalescing is anchored to the **last committed revision id** and bounded at both ends,
  so an edit after an undo/redo starts a fresh undo step rather than rewriting a revision
  the user just navigated to, and a backwards clock step cannot merge unrelated edits.

**Persistence**
- `Serializer.save` returns a `SaveResult`; a quota/disabled-storage failure surfaces in
  the UI instead of a silent no-op. "Saved" is no longer able to be a lie.

Test count 89 → **97**.

### Deliberately not done
- **`DeepReadonly<ProjectDocument>` for `getDocument()`** and a **discriminated-union
  delta type** — both are genuine improvements and would make two invariants
  compiler-enforced rather than convention, but each is a broad refactor of every
  consumer. Better as their own change than smuggled into a fix pass.
- **A linter for the JSDoc-header rule** — adding ESLint is tooling scope creep here;
  the rule is currently convention, and is marked as such.
- **Surfacing the history-truncation discontinuity in the UI** — real, but it is a UX
  decision (what should "undo" do at the boundary?), not a defect to patch silently.

---

## Verification
- `npx tsc --noEmit` (app) — clean.
- `npx tsc --noEmit -p tsconfig.test.json` (tests) — clean.
- `npm test` — **97/97**.
- `node scripts/build.js` — emits `dist/electron/preload.js`; version injected (no `__APP_VERSION__` left in the bundle).
- `npm run check` (typecheck + test + build) — green.
- Browser smoke test of the built app: draw (single node, preview shows then clears), select (outline + 4 handles), **move via override** (renders at dragged position, commits, undo restores), **resize via override** (150→210, Escape mid-resize cancels) — no console errors.
