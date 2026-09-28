# Gameplay foundations and 3D level authoring — delivery goal

<!-- describes: src/core/document, src/core/runtime, src/core/actions, src/runtime, src/player, src/player3d, src/app/BehaviorGraphPanel.tsx, scripts/smoke-player.js -->
<!-- re-read 2026-09-28: runtime tests now also read FoldersDrawer.tsx when pinning shell source.
     Gameplay actions, player runtime and this delivery goal are unchanged. -->

Started 2026-09-19 at the user's explicit request. All five parts are required; partial delivery
does not complete this goal. Existing schema-81 work is uncommitted and must be preserved.
No commit/push, Git-history cleanup, reference-asset removal or installer replacement is authorized
by this implementation goal. Work and build outputs stay on D:.

Scope expanded by explicit user request on 2026-09-23: the original five gameplay parts AND
the 3D level-authoring requirements below are required for completion. These are part of this
same delivery goal, not optional follow-up work. See [Level authoring](LEVEL-AUTHORING.md)
for the detailed four-area implementation plan and current geometry-foundation evidence.

## Baseline and research

Baseline: graph-v2 events/branches/actions, simulation-time delays, bounded repeats, reusable
project graph assets, debugger pause/step/breakpoints, and player-progress v1/v2.
The last complete run passed 2,326 tests in 52 suites plus editor/export/player smokes.
Existing sources are the authority for command order, graph budgets, asset confinement,
immutable Actions and staged level adoption.

Implementation references:
- [TypeScript narrowing and exhaustive unions](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [React immutable state arrays](https://react.dev/learn/updating-arrays-in-state)
- [Electron webContents crash/lifecycle APIs](https://www.electronjs.org/docs/latest/api/web-contents)

## 1. Behavior lifecycle and custom events

Status: in progress.

Initial implementation: graph-v3 declarations, fixed-step spawn/update dispatch in both runtimes,
single active update execution per actor, bounded named-event sending (32-hop chain limit), and
once-only despawn notifications with preserved waiting callbacks. Body-targeting commands on an
already removed actor are refused; callbacks may still update counters or complete the run.
Player-progress v3 records notification bookkeeping so save-before-first-tick preserves pending
birth events; older v1/v2 saves remain accepted. Lifecycle-slice verification: 2,331 tests in 53 suites passed,
along with typecheck, headers, build, real lifecycle/send authoring and exported-player save/reopen
smokes. The typed-data follow-up also verifies callback spawning/removal in both runtimes: a parent
spawns a child, removes itself, saves during cleanup, and finishes once without revival. Final-game
and lifecycle-specific debugger/transition coverage remain part of the final acceptance audit.
No other part of the five-part goal is complete yet.

Add graph-specific spawn, fixed-step update, despawn and named custom events without silently
changing existing rule behavior. Preserve deterministic ordering and instruction/queue limits.
Update handlers must not accumulate a new delayed copy every tick. Despawn notification must
run once, retain a safe execution context, and never revive a removed actor accidentally.
Custom dispatch uses an explicit bounded queue, not recursive JavaScript calls.
Spawned actors receive their lifecycle independently of level-start events.

Acceptance:
- Both runtimes emit the same documented lifecycle meanings.
- Restart/Stop/transition/hidden actors and restored progress have explicit behavior.
- Inspector exposes events and sending nodes, with validation and undo/reopen coverage.
- Tests cover event storms, delayed update handlers, spawn/despawn during callbacks,
  custom-event cycles, and pause/step behavior.

## 2. Typed variables and graph functions

Status: implemented through visual authoring and saved execution; final-game acceptance remains.

Schema 83 / graph v4 adds entity-local and game-scoped number/boolean/string declarations,
strict assignment/arithmetic/comparison nodes, immutable runtime tables, inspector authoring,
debugger watches and undo/reopen validation. Progress v4 preserves assigned values and accepts
older saves with defaults. Game scope currently means actors in the active level; cross-level
sharing remains part 4. Verification: 2,341 tests across 55 suites, typecheck, headers and production
build pass. Real Electron behavior-authoring, existing authoring/export and standalone-player
smokes pass. The exported player saves entity health and shared inventory, reopens, resumes two
delayed changes exactly once, and rejects corrupt saves. Tests also cover isolated actor values,
wrong types, zero division, overflow, bounded malformed saves and immutable debugger single-step.
Documentation semantic checks pass; the gate still reports only existing commit-history flags.
Function implementation is now underway in `BehaviorFunctions.ts` and `BehaviorFunctionFrames.ts`.
The contracts validate typed inputs/outputs, explicit returns, local scalar storage, nested calls,
missing references, duplicate/aliased bindings, recursion refusal and a 16-call depth limit. Immutable
frame helpers snapshot inputs, isolate invocation-local values and stage output writes atomically.
Verification after this contract/frame slice: 2,350 tests across 57 suites, typecheck and module
headers pass, including nested local returns and failed-return non-adoption. The documentation
gate still reports only the known commit-history flags.
Schema 84 now stores the validated function library, with transaction-safe edits, undo/redo,
reopen validation and non-destructive migration. Declaration edits cannot break function variable
bindings. `BehaviorFunctionExecution.ts` now steps nested functions one instruction at a time,
preserves independent local/repeat frames and yields wait/action/signal effects to a caller-owned
scheduler. Focused tests cover nested typed return propagation and two delayed loop iterations.
Schema 85 / graph v5 now connects root call nodes to the shared 2D/3D scheduler. Function steps
consume its instruction budgets; delays use simulation time and nested calls retain independent
frames. Root-call inputs/outputs are editable through the Gameplay inspector with Action-backed
validation and undo. Qualified function breakpoints, traces and frame watches are integrated.
Player-progress v5 stores plain typed continuations, validates them against project call sites and
accepts older saves. Both-runtime nested wait/save/restore tests and the real exported-player
reopen smoke pass. The latter saves inside a nested function and resumes two loop returns exactly
once. Visual creation/editing now supports signatures, locals, every function node kind, connection
editing, entry selection and nested typed calls. Drafts apply atomically after validation, retain
the saved version on failure, and refuse to overwrite external changes. DOM tests author a waiting
function and a nested local-arithmetic function from scratch, execute their reopened documents,
and verify undo, cycle refusal, deletion protection and draft conflicts. The real Electron smoke
now creates the function library through the UI instead of seeding it in code. Original-game
demonstration remains part of the final goal acceptance rather than being inferred from fixtures.

Schema-84 library/execution-helper verification: 2,354 tests in 58 suites pass, with typecheck,
module headers and production build passing. Real Electron behavior-authoring and exported-player
smokes remain green. These smokes protect existing behavior, not yet the unconnected function UI.
Documentation semantic checks pass; the gate retains the existing commit-history-only flags.

Schema-85 call integration verification: 2,362 tests across 60 suites pass, with typecheck,
headers and production build passing. Real Electron authoring now adds a typed call, edits an
argument, and checks save/reopen; the exported player saves/reopens two nested function frames
inside a repeat. Tests cover qualified loop breakpoints, immutable stepping, changed-library
cancellation, malformed saved frames and the shared 10,000-instruction job circuit breaker.
The authoring smoke exited successfully; Chromium printed GPU teardown diagnostics after its
success message. The documentation gate continues to report only commit-history flags.

Visual-library verification: 2,368 tests across 61 suites pass, including two actors sharing waiting
functions independently in each runtime. Typecheck, headers, production build, exported-player
save/reopen and the real UI-created function-library smoke pass. A desktop screenshot was reviewed;
the smoke now waits for the final clean React render before capture. No project schema change was
needed for the definition editor. Part 3 (reusable actor prefabs) is the next implementation work.

Number, boolean and string gameplay values use explicit declarations, defaults and validation.
They are separate from document design tokens. Provide entity-local and shared game scopes,
safe get/set/arithmetic/conditions, inspector authoring and debugger watches.
Reusable graph functions have declared typed inputs/outputs, call/return nodes and local frames.
Calls use bounded scheduler frames rather than unbounded host recursion. Validate bad calls,
missing functions, duplicate parameter IDs, type mismatches and recursion policy before adoption.
Waiting inside a function must retain caller state across pause and save/restore.

Acceptance:
- Health, inventory count and a boolean switch can be authored without userData conventions.
- Two actors share a function definition but not local execution state.
- Return values, nested calls, waits, wrong types and missing references are tested.
- Old graphs migrate without altered behavior; editor Actions undo all authored changes.

## 3. Reusable actor prefabs

Status: in progress; hierarchy-copy, behavior-dependency capture and independent editor placement are implemented. Named prefab definitions and linked instances remain outstanding.

`ActorHierarchy.ts` bounds owned traversal to 256 nodes, deep-copies authored data and remaps
internal scene references without changing function IDs, score keys or level paths. Malformed
ownership, cycles, colliding mappings and override paths are refused. `ActorBehaviors.ts` captures
resolved inline/shared graphs and their transitive function dependencies, then binds scene-node
references into an isolated actor context. Tests execute nested functions for two copies and
verify each targets its own child without modifying the original library. Disabled graphs retain
their dependencies. These helpers are not yet integrated into a persisted named prefab format
or runtime hierarchy spawning; prefab delivery is not complete.

`PlaceActorHierarchyAction.ts` now copies a selected actor hierarchy into the same parent with
an explicit local 2D/3D offset. Referenced functions are copied under fresh IDs, including nested
calls, so internal spawn references target that copy's children. Source libraries remain unchanged.
Placement validates the entire proposed document before adoption, is one undoable revision,
preserves hidden child templates and prevents copied actors from taking over player control.
The Metadata inspector exposes independent-copy placement through `ActorPlacementPanel.tsx`,
with dimension/offset controls and visible validation failures. This is not linked-prefab delivery
and does not convert 3D content to 2D. Focused tests cover both runtimes executing each copy's
nested functions, save/reopen, 3D spawned-progress restoration, undo/redo, invalid offsets,
missing dependencies, function capacity and actual DOM controls.
Placement checkpoint verification: 2,431 tests across 73 suites, typecheck, module headers,
production build and the existing Electron authoring smoke pass. The smoke protects existing
authoring/export/gameplay flows; the new placement controls are currently covered by DOM tests,
not a dedicated Electron placement smoke. The documentation gate still reports only the known
commit-history flags. Named prefab storage, instance relationships, runtime hierarchy spawning
and end-to-end prefab/export acceptance are the next work, not satisfied by independent copies.
Verification on 2026-09-23: typecheck, module headers and all 2,376 tests in 63 suites pass.
The documentation gate still reports the existing commit-history flags. No production build or
Electron smoke was rerun for these unconnected pure helpers; editor/runtime integration remains
required before those checks can demonstrate actual prefab authoring and play.

Capture appearance, components and behavior as a named reusable actor definition, including
owned child hierarchies and referenced project assets. Place and spawn instances with fresh IDs,
remap internal references, and expose deliberate instance editing/detach behavior.
Use existing document Actions and asset loaders; do not introduce a second scene representation.
Do not silently flatten unsupported hierarchy/transform combinations: validate and explain limits.

Acceptance:
- Save an authored actor as a prefab, place multiple copies, edit/detach safely, undo and reopen.
- Runtime spawn/despawn covers supported 2D and 3D actor structures and lifecycle callbacks.
- Internal references never point back into the original instance by accident.
- Exports include the required appearance/behavior assets without external editor authority.
- Missing assets, malformed hierarchies, recursion and instance limits fail safely.

## 4. Cross-level saved progress and recovery

Status: pending lifecycle/variable/prefab state shapes.

Introduce a versioned campaign snapshot containing visited-level state and shared gameplay values.
Stage reads, validation and asset loading before replacing live state. Returning to a visited level
must preserve collected items, actor/prefab state and suspended behavior work under an explicit policy.
Migrate supported older save formats; continue rejecting foreign build identities unless an explicit,
validated compatibility mapping exists. Schema migration does not authorize arbitrary cross-build saves.

Acceptance:
- Visit A, alter state, enter B, save, relaunch, return to A without duplicated pickups or start effects.
- Typed values, prefab instances and waiting function/loop frames survive.
- Invalid/oversized/unknown saves retain the last usable world and save slot.
- Real writer/renderer crash and fresh-process relaunch tests cover interrupted persistence.
- Exercise both 2D and 3D lifecycle adapters; retain the narrow save-slot host bridge.

## 5. Original proving game and exported build

Status: pending foundations; build incrementally as features become usable.

Make a compact original multi-level game using enemies, pickups, checkpoints and reusable actors.
Use owned geometric/pixel assets, not ignored third-party reference packs. Demonstrate lifecycle
events, typed health/inventory/switches, reusable functions, prefabs and cross-level persistence.
Keep the editable project and produce a separate, clearly named playable export on D:.

Acceptance:
- Author/open/edit/save, play all levels, fail/respawn/restart, and win.
- Export runs without the original project folder or editor API.
- Save mid-game, close/crash, relaunch and complete the game.
- Validate the actual exported output, not only test fixtures.
- Document controls, supported limits, build location and remaining broader engine gaps.

## 6. Required 3D level-authoring expansion

Status: incomplete. Schema-88 saved solid-operation trees now connect numeric inspector editing,
undo/reopen, generated rendering and matching collision. Surface-material authoring, prefab integration,
complete traversal/export acceptance and performance/lighting remain outstanding. See `LEVEL-AUTHORING.md`
for evidence and limitations.

- [ ] Editor controls and persistence: create/edit rooms, walls, ramps and stairs; numeric
  controls and snapping; undo/redo; schema validation/migration; save/reopen and exported rendering.
- [ ] Matching collision: convex/compound shapes agree with visible slopes, stairs and solid
  cutouts. Verify traversal through doors and blocked movement against remaining surfaces;
  rebuild collision after edits, placement, spawning and save restoration.
- [ ] Non-destructive solid operations: add/subtract/intersect with editable operation trees,
  door/window openings, stable material surfaces, bounded evaluation and safe failure handling.
- [ ] Building prefabs: extend part 3's actor-prefab system with building geometry, materials,
  collision and behavior; verify placement/spawning, instance editing/detach, undo and reopening.
- [ ] Performance and lighting improvements: establish representative large-level benchmarks,
  implement measured visibility/spatial-query improvements and static-lighting improvements;
  verify visual correctness, edit invalidation and standalone exports, not just faster timings.

Completion requires integrated editor and runtime evidence, including an exported playable
3D level exercising these features. Generator unit tests alone do not satisfy this expansion.
Keep the existing 2D/pixel-design workflows and all original gameplay acceptance requirements.
No Chisel engine replacement or third-party code adoption is implied by these requirements.

## Verification and completion

### Historical checkpoint — before Chisel research, 2026-09-23

Implementation stopped for the user's requested research into an engine named "Sclupt"
(identity and claimed Source relationship still to be verified). Work remains local and
uncommitted on D:. No integration or engine replacement has been authorized.
Latest verification: 2,376 tests / 63 suites, typecheck and module headers pass.
Resume at part 3: persist named actor prefabs, add Action-backed placement/detach and editor
authoring, then integrate spawning and continuation restoration in both runtimes. The hierarchy
and behavior-copy helpers are verified but not connected to those workflows. Parts 4 and 5 and
the final acceptance audit remain outstanding. Preserve all existing work and reference assets.

For each part: focused core tests, production-panel tests, both-runtime integration where applicable,
and serializer/history regressions. Before completion: full test suite, typecheck, module headers,
production build, semantic documentation checks and real exported-game acceptance.
Commit-history-only documentation flags remain reported rather than bypassed.
Do not mark this goal complete until every acceptance group in parts 1–6 and the linked
level-authoring plan has evidence. The expansion is required even if the original five-part
objective still appears in the app's goal summary.
