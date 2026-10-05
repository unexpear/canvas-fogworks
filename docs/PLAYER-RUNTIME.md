# Shared player runtime — loading and session lifecycle

<!-- describes: src/runtime, src/app/Asset3DImportWorkflow.ts, src/app/LevelTransitionWorkflow.ts, scripts/smoke-level-transition.js -->
<!-- re-read 2026-10-04: packaged games can take their save-migration list from the entry document. Session loading still does not write the new slot. -->
<!-- re-read 2026-10-02: PlayerSession3D accepts an explicit save-migration list. Loading and session staging are otherwise unchanged. -->

Implemented 2026-09-12 as Q02 loading and player-session slices in the [engine roadmap](ENGINE-ROADMAP.md).
These modules provide reusable loading/session behavior, not the desktop host itself. The
[standalone follow-up](STANDALONE-PLAYER.md) supplies the export and packaged player; F1 remains
incomplete. The initial shared extraction did not change app 0.0.5, schema 78 or persisted files.
The [gameplay follow-up](GAMEPLAY-FOUNDATIONS.md) adds schema 79 rules and separate versioned
player progress; it does not merge runtime saves with project Save or editor recovery.

## Ownership and dependency map

| Module | Responsibility | Must not own |
|---|---|---|
| [ProjectReadHost](../src/runtime/ProjectReadHost.ts) | Read-only level, model, sidecar and environment contracts | File dialogs, Save, history, IPC registration or raw filesystem access |
| [Asset3DLoader](../src/runtime/Asset3DLoader.ts) | Existing glTF/GLB parsing, embedded texture sources, HDR decode and transient libraries | Document edits, Actions or React |
| [RuntimeProject](../src/runtime/RuntimeProject.ts) | Stage and publish a destination document and its libraries; discard superseded results | Editor savepoint/history, graphics resource ownership or simulation ticking |
| [PlayerSession3D](../src/runtime/PlayerSession3D.ts) | Direct entry/restart, staged world adoption, pause/Stop and host-driven fixed-step timing | DOM event listeners, frame scheduling, GPU resources, file dialogs or editor authority |
| [GamePackage](../src/runtime/GamePackage.ts) | Bounded inline manifest validation and level-scoped allowlisted reads | Filesystem/network fallback, package export, GUI or asset-license decisions |
| [Asset3DImportWorkflow](../src/app/Asset3DImportWorkflow.ts) | Undoable editor import Actions, plus compatibility exports of shared loaders | A separate copy of runtime decoding |
| [LevelTransitionWorkflow](../src/app/LevelTransitionWorkflow.ts) | Compatibility export of the shared level loader | A second runtime session implementation |

The existing editor imports continue to resolve to the same functions/class through re-exports.
Future players import `src/runtime` directly. The current browser-bundle regression traverses
the complete loader dependency graph and refuses app, editor, Electron, Action and React modules,
or unresolved external imports. It also checks that the graph actually includes the shared loader
and document deserializer so the assertion cannot pass on an empty build.

## Host contract

- `readLevelFile(currentFilePath, target)` returns serialized project content and its resolved key.
- `readEntryFile(entryKey)` returns an explicitly authorized entry and resolved key; only the player host requires this additional method.
- Optional `readProgressLevel(levelKey)` returns a known packaged level for validated progress
  restore. Hosts without this capability refuse restore; it never falls back to arbitrary paths.
- `readProject3DFile(projectFilePath, source)` returns base64 model bytes.
- `readProject3DSidecar(projectFilePath, modelSource, relative)` returns base64 dependency bytes.
- `readProjectEnvironmentFile(projectFilePath, source)` returns base64 Radiance HDR bytes.

Parameter names preserve the existing bridge contract. Project keys are opaque to the runtime:
the editor uses filesystem paths; a future package host can use manifest keys. The host must
resolve relative references, authorize the current project and enforce path, file and batch limits.
The type definitions alone are not a sandbox, permission system or manifest validator.
Existing Electron confinement and read bounds are unchanged. Ordinary 2D project image embedding
still belongs to its host read path; moving these modules does not add image embedding to every host.

A host without 3D methods can load levels without 3D assets. To preserve existing behavior,
any asset-bearing destination requires all three 3D read methods, even if that particular level
has no HDR. A method can refuse unlisted resources. No Save, file-picker or editing method is
required by the runtime. Hosts should expose only intended operations rather than broad IPC access.

The source supports this separation through [TypeScript type-only imports](https://www.typescriptlang.org/docs/handbook/modules/reference.html).
Electron recommends narrow bridge methods; see [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation).
Neither structural typing nor bundling proves a hostile host safe.

## Lifecycle and failure behavior retained

1. Each transition increments a generation before the level read.
2. The destination is deserialized, then model/material sources and HDR libraries stage privately.
3. Only the current generation publishes document, resolved key and both libraries together.
4. Failure keeps the prior published runtime. Superseded success or failure returns `false`.
5. Reset advances the generation and drops runtime-owned references; previously returned libraries
   and the editor's independent libraries are not mutated.

This is logical cancellation, not physical I/O abort: already-started reads/decodes may finish.
Texture sources are prepared here; browser image decoding/upload and GPU disposal are later owners.
Do not infer that every dependency is GPU-ready immediately after transition resolves.

The transition path parameter still supplies the editor's saved-project context when no runtime
level is active. The existing unsaved-project error is retained for compatibility. Players instead
use `RuntimeProject.open(host, entryKey)`, which reads the entry directly and shares the same staged
hydration and generation handling. They do not need an invented current level or editor Save path.
No entry-read IPC method has been added to the editor bridge.

## Player session lifecycle

`PlayerSession3D(host, entryKey, gameId?, saveMigrations?)` retains one configured entry and a privately staged candidate
for each asynchronous load. Existing editor play mode is unchanged and does not use this class.

| Operation | Contract |
|---|---|
| `start()` / `restart()` | Reload the configured entry, hydrate assets and create a fresh simulation; restart never means the last visited level |
| `followTransition()` | Follow the current simulation's target using its resolved level key; ignore duplicate requests while loading; the host explicitly retries failures |
| `pause()` / `resume()` | Preserve the world but reset timestamp anchoring; pause during a load remains effective when that load completes |
| `stop()` | Clear active/pending references, advance cancellation generation and reset error/clock; late successes and failures cannot revive the game |
| `advance(timestamp, input?)` | Consume a finite nonnegative monotonic timestamp in milliseconds and current movement input; use the existing bounded 60 Hz solver |
| `frame(width, height)` | Derive a backend-neutral scene from simulation transforms, shared animation and hydrated resources; return null when stopped |
| `interact()` / `checkpoint()` / `respawn()` | Shared gameplay commands against transient world state, not document history |
| `saveProgress()` / `restoreProgress(content)` | Require the package hash; encode bounded progress or adopt a same-build save, or a save whose hash and progress version are in the session's explicit migration list, then stage that level before adoption |

A candidate must deserialize, hydrate and contain a 3D camera, and its initial simulation must
be constructed before the session replaces any active document/world. Failure preserves the
previous scene, pauses it and exposes an error while rejecting the request. The caller must handle
that rejection. A failed first load remains stopped with a diagnostic. A successful retry clears
the error; a superseded request returns false without replacing a newer error or world.

Simulation is frozen during loads and while a level transition is pending. The host calls
`followTransition()` once when it observes a target and catches errors; `advance()` never schedules
I/O or retries a failed level every frame. After a failed transition, successful explicit retry
remains paused until resume. `start()`/`restart()` request running state unless paused during loading.

The first timestamp after load, pause/resume or a backwards clock change only anchors time.
Missing movement input supplies zero control instead of keeping the player's last input velocity.
The current typed dynamic Player is controlled; scenes without one can still preview animation.
Non-finite timestamps/input are rejected; movement axes must be within -1..1 and optional speed
within 0..1000. The existing solver caps long gaps to five fixed steps. Invalid viewport sizes
are refused outside integer 1..16384; this bound is not a GPU hardware-support guarantee.

The host owns requestAnimationFrame scheduling, keyboard/gamepad mapping, pressed-key clearing,
blur/visibility handling and actual rendering. It must pause on focus/visibility loss and resume
deliberately. This avoids treating background time as gameplay; see
[browser animation-frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame).
The class creates no event listeners, global timers or GPU context, and stores no pressed-key state.
It returns state for trusted host inspection; TypeScript read-only types are not a runtime sandbox.
Player progress encoding and staged restore now live in the session; a separate narrow store
owns persistence and the standalone host supplies checkpoint/respawn/save/load controls.
The standalone host follow-up owns event/render
integration and render-device teardown; these responsibilities do not move into the session.

## Verification and next work

[RuntimeBoundary tests](../src/runtime/RuntimeBoundary.test.ts) cover shared implementation identity,
a browser-only dependency graph, opaque package-key reads with a real owned glTF fixture, missing
host capabilities preserving the current level, and a stale failure after reset/new load.
Existing import and transition tests continue to cover Actions, hydration, failure and cancellation.
The dependency check uses [esbuild's in-memory build and JSON metadata](https://esbuild.github.io/api/#metafile),
not a search of minified names. Real Electron smokes remain necessary to verify IPC integration.

Verification on 2026-09-12: all 2,176 Jest tests in 42 suites, typecheck, module headers, build,
Open–Edit–Save, staged 3D level hydration and authoring Electron smokes passed. The authoring
smoke includes the offline three-level 2D game, PNG and sound checks. Documentation links,
backlog JSON and whitespace checks passed. The history-based doc gate still reports the
uncommitted roadmap and this new document, plus the existing FEATURE-AUDIT/PLANNED-FIXES
history flags. No commit, push, installer rebuild or new platform certification is claimed.

The lifecycle follow-up adds [PlayerSession3D tests](../src/runtime/PlayerSession3D.test.ts) covering
entry/transition/restart, malformed or camera-less entry, failed hydration, Stop during reads,
superseding requests, pause while loading, clock/input validation and equivalence with the existing
solver. Both loading and session modules must pass the editor-free browser dependency check.
The Electron level smoke also drives an actual session through entry, advance, frame submission,
pause, restart and Stop during reload, using the relocated fixture and confined asset reads.
The original lifecycle smoke supplied its entry through a test host. The package follow-up below
replaces that adapter with the validated inline package reader; editor IPC endpoints remain unchanged.

Lifecycle verification on 2026-09-12: all 2,190 Jest tests across 43 suites, typecheck, module
headers, build and rebuilt Open–Edit–Save/level/authoring Electron smokes passed. The level smoke
reports `playerLifecycle: true`. Documentation links, backlog JSON and whitespace checks passed;
the same four documentation-history flags above remain. These results supersede the earlier
extraction-only test count, not the remaining package/distribution limitations.

Q03 follow-up: the [inline game package v1](GAME-PACKAGE.md) and read-only resolver are implemented,
with an explicit per-level resource/transition allowlist and no external read fallback. The real
level smoke now drives PlayerSession3D from that manifest and reports `packageReader: true`.
Package follow-up verification passes 2,240 tests across 44 suites, typecheck, headers, build
and Open–Edit–Save/level/authoring smokes; see GAME-PACKAGE.md for limits and remaining doc-history flags.
The [standalone follow-up](STANDALONE-PLAYER.md) now adds package writing/export, Q04's actual
event/render host, a payload checksum and Q05's unsigned Windows unpacked build. The standalone
host has no editor authority; the editor gains a separate export endpoint. No new dependencies
or native backend were introduced. The packaged player now plays embedded sound cues and draws
screen-space 2D text over the 3D view. Clean-profile acceptance is `smoke:player-acceptance`.
Buffer, image and HDR bytes can stream from a host-supplied chunk when a level reads them; models
and fonts stay inline. `check:player-exe-evidence` is the clean-machine EXE scoring path. No
clean-machine result is recorded, signatures are omitted, and world-partition streaming and the
complete F1 gate remain open.
