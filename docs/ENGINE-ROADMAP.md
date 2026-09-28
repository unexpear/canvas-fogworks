# Canvas Fogworks — full engine development plan

<!-- describes: src/core/document, src/core/runtime, src/core/export, src/core/script, src/runtime, src/renderer, src/app/RuntimeAudio.ts, package.json -->
<!-- re-read 2026-09-28: the only runtime-tree edit is shell source pins reading FoldersDrawer.tsx.
     This plan's scope and acceptance gates are unchanged.
     package.json records benchmark:authoring, benchmark:gpu and test:benchmark-budgets. ENG-16 benchmarks remain informational. -->

Planning assessment: 2026-09-07. Baseline inspected: commit `dac1ef9` plus the current
uncommitted production-work and Windows Save As fixes; app 0.0.5, schema 78.
This is a proposed delivery plan, not a claim that future capabilities exist, a release
schedule, or authorization to replace subsystems, purchase services, publish, or change Git history.

Implementation follow-up 2026-09-12: Q02's read-only level/asset loading extraction is implemented
in `src/runtime`, with existing editor compatibility exports and a browser dependency-boundary
regression. See [Shared player runtime](PLAYER-RUNTIME.md) for ownership and retained limits.
The follow-up also implements direct entry loading and a host-driven 3D session with staged world
adoption, restart, pause/Stop and bounded simulation timing. F1 is not complete. F0's versioned
baseline remains pending an authorized commit. Q03 implements a bounded inline package manifest
and read-only resolver; see [Game package v1](GAME-PACKAGE.md). The subsequent Q03–Q05 slice adds
package export, an embedded-payload checksum, a real event/render host and an unsigned Windows
unpacked build; see [Standalone player](STANDALONE-PLAYER.md). Clean-profile acceptance, custom font
packaging, unsupported-feature diagnostics and unsigned provenance are now part of that player.
Separate Windows clean-machine EXE certification, signatures and broader runtime coverage remain open.
See PLAYER-RUNTIME.md for scoped verification evidence.

Q06 follow-up 2026-09-12: schema 79 adds reusable named input actions, nearest-target interaction,
bounded leaf-template spawning/despawning, checkpoints/respawn and versioned current-level progress
for 2D/3D players. The native progress bridge is slot-only; it grants no editor authority. See
[Gameplay foundations](GAMEPLAY-FOUNDATIONS.md) for acceptance evidence and limits. Q06 remains
partial: input settings UI, full prefabs, cross-build save migration and process-crash/relaunch
acceptance remain open. Visited-level campaign progress is player-progress v6. F1/F2 are not complete.

## 1. Purpose and definition of success

Behavior-graph follow-up 2026-09-16: schema 80 delivers an optional visual event/branch/action
graph per entity, validated acyclic connections, shared 2D/3D execution and undo/save authoring.
Follow-up 2026-09-19: schema 81 adds simulation-time delays, bounded repeats, reusable project graph
assets, saved continuations and editor breakpoint/step/trace/counter debugging. See
[Behavior graphs](BEHAVIOR-GRAPHS.md). ENG-04/Q06 remain partial: full behavior lifecycle,
callable graph functions, richer variables, scripting equivalence and cross-project assets remain open.

Build one product for **visual/pixel design and 2D/3D game authoring**, with Unreal-level
breadth and production quality as a long-term ambition. Neither authoring track is being
abandoned. Shared assets, documents, Actions, animation and rendering should make each
track more useful to the other without forcing design-only projects to behave like games.

Unreal-level means more than a similar viewport. It means creators can author, debug,
optimize, package and maintain substantial games using interoperable systems, with
predictable performance, compatibility and failure behavior. It does not require copying
Unreal's internal architecture, branding, formats or every specialized feature.

Use three separate success levels:

1. **Shippable engine:** independently package and complete a representative 2D and 3D game;
   save progress, recover failures, preserve authoring data and run on declared hardware.
2. **Production engine:** reusable gameplay, character tools, assets, larger worlds,
   diagnostics and team workflows work across multiple games, not just a showcase.
3. **Advanced engine:** high-end rendering, streaming, multiplayer, platform breadth and
   specialist simulation meet explicitly selected quality and scale targets.

Do not assign an overall percentage toward Unreal. A feature checkbox, passing unit suite,
small triangle benchmark and mature production subsystem are different kinds of evidence.
Full breadth is a multi-year, team-scale programme; no credible completion date exists yet.

### Navigation

- [Baseline and evidence](#baseline)
- [Architecture commitments](#architecture)
- [Delivery phases and dependencies](#phases)
- [Major gap work packages](#gaps)
- [First implementation queue](#queue)
- [Verification and performance gates](#verification)
- [Decisions, resourcing and risks](#decisions)
- [Backlog integration and maintenance](#maintenance)

<a id="baseline"></a>
## 2. Baseline: what we retain and what it does not prove

The current source and scoped documentation take precedence over historical milestone labels.
The former Morphic engine remains a preserved reference, not a second production runtime.

| Existing foundation | Boundary of the evidence |
|---|---|
| Versioned documents, Actions, undo/redo and component instances | Not yet a scalable multi-file project database or general gameplay object system |
| Visual, pixel, tile and timeline authoring | Remaining layout, instance-performance and large-raster work still matters |
| Typed 3D transforms, cameras, lights, mesh/material/texture references | Box/sphere colliders and bounded imported data, not arbitrary engine components |
| WebGL 3D, picking, PBR textures, shadows and HDR environment lighting | Not scene-dependent global illumination, virtualized geometry or a modern high-end render pipeline |
| Imported glTF TRS and morph animation, CPU skinning, 16-joint GPU skinning and two-pose blending | Not full animation graphs, events, root motion or character production tools |
| 2D/3D gameplay rules, interactions, bounded spawning, checkpoints and current-level progress | Not a general behavior lifecycle, full prefab system, production physics or multiplayer |
| Dependency-aware Save As, recovery checkpoints, browser restore, desktop crash/relaunch, and dependency-folder rollback | Power-loss durability is not guaranteed. A killed copy is repaired from its journal on the next cross-folder Save As |
| Offline 2D/3D HTML players, unsigned Windows 3D player and separate editor installer | Clean-profile acceptance, custom fonts and unsigned provenance; separate Windows clean-machine certification and broader runtime coverage remain open |
| Tests, Electron smokes and CPU/GPU benchmarks | Hardware-specific, bounded fixtures; not a broad compatibility or scalability certification |

Evidence starting points:

- [Production workflows](PRODUCTION-WORK.md), [3D foundation](3D-FOUNDATION.md),
  [animation](ANIMATION.md), [feature audit](FEATURE-AUDIT.md) and [testing](TESTING.md).
- [Spatial3D contracts](../src/core/document/Spatial3D.ts),
  [World3D](../src/core/runtime/World3D.ts),
  [renderer](../src/renderer/emitWebGL3D.ts),
  [game export](../src/core/export/GameExport.ts),
  [editor scripting boundary](../src/core/script/ScriptApi.ts) and
  [audio playback](../src/app/RuntimeAudio.ts).
- The last fix verification reported 2,171 Jest tests across 41 suites, typecheck,
  headers, build, Open–Edit–Save, level-transition smoke and five crash cases passing.
  This document-only task does not rerun or extend that runtime evidence.
- The existing history-based documentation gate requires reviewed documentation to be
  committed. This new source-linked plan also remains uncommitted until separately authorized.

For areas without an equivalent production subsystem in the reviewed source, the work below
is classified as **new**. This is not a claim that no experiment exists anywhere in the legacy
tree. Audit relevant live modules again when promoting a work package into implementation.

<a id="architecture"></a>
## 3. Architecture commitments

1. **One authored truth.** Keep the document and stable authored IDs authoritative. New
   persisted behavior requires validation, migrations, Actions, undo/redo and round-trip tests.
2. **Separate lifetimes.** Editor selection/history, project data, derived asset caches,
   simulation worlds and persistent player saves are separate stores with explicit ownership.
   Runtime commands do not become document history every frame.
3. **Reusable runtime.** Move only necessary host-bound behavior behind tested interfaces.
   The editor, standalone player and eventual headless server share simulation contracts.
4. **Backend boundaries.** Rendering, physics, audio, storage and asset compilation expose
   capabilities, cancellation and typed failures. A backend must not silently reinterpret data.
5. **Keep 2D meanings intact.** Preserve 2D coordinate, color, pixel-filtering, layout and export
   semantics. Explicit 2D-in-3D composition remains the bridge, not an implicit conversion.
6. **Bound work and memory.** Define allocation, upload, decode, simulation and queue budgets.
   Every asynchronous operation has ownership, cancellation and stale-result handling.
7. **Determinism is scoped.** Specify fixed-step ordering and replay guarantees per subsystem.
   Do not promise cross-platform floating-point physics determinism without proving it.
8. **Untrusted inputs stay untrusted.** Assets, project files, scripts, plugins and network
   messages cross validated boundaries. Opening a project must not grant arbitrary host access.
9. **Profile before migration.** Preserve TypeScript/React editor work. Evaluate modern GPU,
   WebAssembly or native modules when a requirement or measured workload justifies them.
10. **Retain legacy work safely.** Reuse Morphic's tested ideas for asset envelopes, generation
    cancellation and replay equivalence. Do not merge its editor, file formats or native FFI wholesale.

Proposed host contracts should cover asset lookup by ID, bounded byte reads, input events,
clock ownership, audio requests, diagnostics and player-save storage. Specify cancellation
and error semantics before moving code. Choose worker/native boundaries from actual message
volume and ownership needs; avoid serialization or copying entire worlds per frame.

<a id="phases"></a>
## 4. Delivery phases

All phases below are **planned**, not completed. `F` identifiers are new roadmap gates;
they do not change historical M1–M18 or 3D-0–3D-4 completion/slice counts.
Quality, security and both authoring tracks continue through every phase.

| Phase | Outcome and scope | Prerequisite | Exit gate |
|---|---|---|---|
| F0 — Reproducible baseline | Record current source/artifacts, regression evidence, support assumptions and outstanding failures | Current working tree | Reproducible checks; known failures explicit; no lost files; authorized baseline commit when requested |
| F1 — Independent 3D game | Minimal shared runtime host, bounded dependency manifest, standalone Windows player, clean-machine test | F0 | Owned two-level 3D project runs offline without editor, Node installation or original asset folder |
| F2 — Gameplay and movement | Runtime behavior lifecycle, input, player saves, reusable templates, physics/character vertical slice, early authority contract | F1 | A creator builds interactions and reliable traversal without modifying engine source |
| F3 — Complete representative games | Animation, NPC navigation, runtime UI, audio and basic effects; maintain visual/pixel workflow | F2 | 2D and 3D samples complete, save/reload, package and pass long-session tests |
| F4 — Production scale and tooling | Incremental asset pipeline, renderer/backend decision, GPU animation where justified, large-scene visibility, diagnostics | F3; bounded measurements begin in F0 | Declared scene/hardware budgets pass; repeated reload/edit/play does not accumulate resources |
| F5 — World and team production | Streaming, terrain/foliage, expanded cinematic/editor tools, source-control-friendly projects | F4 and migration design | Streamed sample and two-person change/merge workflow preserve identity and references |
| F6 — Networked and broader targets | Authoritative multiplayer, dedicated server, mature runtime scripting, selected additional platforms | F2 authority design; F4 resource budgets; F5 for streamed multiplayer | Packaged clients/server pass latency/loss/version tests; each added platform passes its release gate |
| F7 — Advanced fidelity and ecosystem | Selected GI/reflections, geometry virtualization research, specialist simulation, mature plugins/collaboration | Relevant F4–F6 gates and explicit business/creator need | Each adopted system passes quality, scale, fallback, tooling and distribution gates |

The sequence limits active scope, not all discovery. Networking identity/authority decisions
start in F2; do not wait for F6 to discover that every behavior assumes one local player.
Renderer research can start in F4 without committing to a rewrite. Team file-format research
can precede F5; no automatic conversion of existing projects is authorized by this plan.

Critical path: independent player → reusable gameplay and reliable movement → complete
games → measured production scale. Advanced rendering is not a prerequisite to proving this path.

<a id="gaps"></a>
## 5. Major gap work packages

Each `ENG-*` identifier is a stable planning reference. **First slice** defines the smallest
useful delivery, **Expansion** records the remaining major gap, **Depends** identifies enabling
work, and **Acceptance** describes observable evidence. Acceptance is for the first slice unless
explicitly called the full gate. Every slice also obeys section 7's common definition of done.

### ENG-01 — Standalone runtime and game distribution

**State:** partial; 2D/3D HTML export, editor packaging, an unsigned Windows standalone 3D unpacked
build, custom font embedding, profile diagnostics, unsigned provenance and a clean-profile
acceptance smoke exist. Separate Windows clean-machine certification and signatures remain open;
see [Standalone player](STANDALONE-PLAYER.md).
**Phases:** F1, then F4/F6. **Role:** runtime/release engineering.

- **First slice:** extract a minimal runtime host; build a Windows game player without editor
  UI or editor-write IPC; package a versioned manifest and only reachable 3D/2D dependencies.
  Preserve the existing HTML export. Reuse the current host technology initially unless the
  extraction spike demonstrates a blocker; native player replacement is a separate decision.
- **Expansion:** debug/release configurations, platform-specific cooking, content chunks,
  patch/rollback, launcher settings, error reports, custom fonts and compatibility checks.
- **Depends:** ENG-02 minimal manifest, ENG-03 host lifecycle, ENG-18 security and ENG-19 QA.
  These minimum contracts can land together; do not wait for their full programmes.
- **Acceptance:** export an owned two-level scene with animated mesh, material textures,
  HDR and 2D overlay; run from a new path/profile offline without source folders or developer
  tools. Test transition, failure preservation, Stop/restart semantics, corrupted/missing
  dependencies and unsupported capabilities. Published game directories contain no editor,
  private workspace paths or ignored example packs.

Unreal explicitly separates building, cooking, staging and packaging. Use that separation as
a comparison, not its implementation: [Epic packaging documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/packaging-your-project).

### ENG-02 — Asset database, compilation and content management

**State:** partial stable references/imports; production cooking/cache pipeline remains.
**Phases:** minimal F1; F4/F5. **Role:** tools/asset engineering.

- **First slice:** explicit reachable-dependency manifest with asset ID, kind, source,
  content hash, importer/version and settings. Validate cycles, missing references, case aliases,
  confinement and redistributable inclusion. Preserve IDs across relocation and reimport.
- **Expansion:** incremental dependency graph, versioned derived-data cache, background
  jobs, cancellation, source-change detection, cache eviction, texture compression, mipmaps,
  generated LOD/colliders, thumbnails, searchable content browser and reference repair.
  Add formats only with a documented fidelity matrix; never silently discard unsupported data.
- **Depends:** document contracts, ENG-18 input limits, ENG-16 measurement; renderer/physics
  consumers define compiled formats rather than importers inventing incompatible copies.
- **Acceptance:** clean import and hot reimport produce equivalent runtime data; changing one
  source invalidates only dependent products; interrupted compilation preserves previous valid
  output. Corrupt cache entries rebuild safely. Renames preserve bindings, and removed assets
  show actionable diagnostics. Full gate adds repeatable incremental builds and measured bounds.

### ENG-03 — General gameplay framework and simulation lifecycle

**State:** partial typed rules and specialized runtimes. **Phases:** F1 minimum; F2 onward.
**Role:** gameplay/runtime engineering.

- **First slice:** explicit world/session/entity lifetimes; typed runtime command/event API;
  spawn/despawn, activation, timers, component queries, seeded randomness and persistent
  session state. Separate controller input from the controlled entity. Define system order
  and delayed-command behavior; preserve existing platformer/rule behavior through adapters.
- **Expansion:** reusable behavior assets, gameplay tags/attributes, interactions, inventory,
  abilities/cooldowns, camera policies, scene services and data-driven game templates.
  Not every genre-specific mechanic belongs in the engine core.
- **Depends:** ENG-01 host interface, ENG-06 input; coordinate ownership/IDs with ENG-14 early.
- **Acceptance:** construct a collectible, switch/door and spawned opponent without engine
  source edits. Tests cover commands targeting removed entities, recursive events, pause,
  repeated play/stop, transition cancellation and preserved authored history. Runtime IDs
  cannot accidentally resolve to entities from an earlier world generation.

Epic's [gameplay framework](https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-framework-in-unreal-engine)
is a useful reference for distinct player, controller, world and session responsibilities.
Canvas Fogworks need not reproduce that class hierarchy.

### ENG-04 — Gameplay scripting and visual logic

**State:** editor script-to-Action boundary and a bounded event/branch/action visual runtime
are implemented; see [Behavior graphs](BEHAVIOR-GRAPHS.md). Full runtime programming remains open.
**Phases:** typed behavior F2; richer scripting F4/F6; visual language after API stability.
**Role:** language/runtime tools engineering.

- **First slice:** expose validated runtime requests and immutable query snapshots to a
  small behavior runner; define update/event lifecycle, resource/time limits and error reporting.
  Editor scripts continue to emit Actions; game scripts emit simulation commands.
- **Expansion:** modules, typed public API, source maps, breakpoints/step/watch, versioned
  behavior assets and hot reload with explicit state migration. A visual graph should compile
  into the same validated representation, with functions, variables, events and diagnostics.
- **Depends:** ENG-03, ENG-18 execution isolation, ENG-16 debugger and ENG-14 authority model.
- **Acceptance:** a faulty/infinite behavior is terminated without freezing the editor/player;
  malformed commands cannot corrupt state. A graph and equivalent textual behavior have the
  same tested result. Reload failure retains the prior valid behavior. No script gains host
  filesystem/network access merely because the player uses Electron.

### ENG-05 — Physics and character movement

**State:** bounded box/sphere contacts and opt-in gravity/restitution; production gap remains.
**Phases:** F2; advanced simulation F7. **Role:** physics/gameplay engineering.

- **First slice:** backend contract and comparative spike for maintained physics libraries
  versus extending current code. Select only after testing licensing, packaging, supported
  targets, stability and cost. Deliver capsule character movement, slopes, stairs, moving
  platforms, collision layers, triggers, ray/sweep queries and hierarchical transforms.
- **Expansion:** dynamic-pair impulses, friction, angular motion, sleeping, joints, continuous
  detection, convex/static-mesh colliders, scalable broad phase and physics debugging.
  Later specialist adapters: vehicles, ragdolls, cloth, fracture/destruction and fluids.
- **Depends:** ENG-03 lifecycle, ENG-02 collider products, ENG-16 measurements; ENG-14 before
  claiming networked physics. No specific physics dependency is selected in this document.
- **Acceptance:** fixed test courses cover slope limits, low ceilings, corners, stairs,
  platform motion, fast small objects and frame-time spikes. Pin ground/jump behavior;
  exercise stacking/joints for later slices. Record solver tolerances and determinism scope.
  Existing 2D games retain their behavior and replay fixtures.

Full comparison includes much more than collision detection; see [Epic physics](https://dev.epicgames.com/documentation/unreal-engine/physics-in-unreal-engine?lang=en-US).

### ENG-06 — Input, cameras, runtime UI and accessibility

**State:** basic controls/cameras and design tools exist; a general player-facing system remains.
**Phases:** F2/F3; platform expansion F6. **Role:** interaction/UI engineering.

- **First slice:** named input actions, contexts, rebinding, gamepad and keyboard/mouse paths,
  focus/pause handling and device disconnect behavior. Runtime UI binds to read-only game state
  and dispatches commands; reuse authored 2D layouts for menus, HUD and settings.
- **Expansion:** touch, controller navigation, safe areas, DPI scaling, camera collision and
  transitions, split-screen, localization/fonts, subtitles, reduced-motion options, scalable
  text and alternatives to color-only/audio-only cues. Keep editor accessibility in scope too.
- **Depends:** ENG-03 commands, ENG-07 preferences, ENG-20 shared visual authoring.
- **Acceptance:** play and navigate menus without a mouse; rebind without duplicate/stuck
  actions; lose focus or unplug a device without continued movement. Verify UI at multiple
  aspect ratios/scales, font fallback, pause ownership and input consumed by UI versus world.

### ENG-07 — Player saves and project resilience

**State:** editor recovery restores in the browser, relaunches after a killed desktop session, and rolls back a failed dependency copy. Power-loss durability and player-save crash acceptance remain separate.
**Phases:** F2/F3 and continuous hardening. **Role:** storage/runtime engineering.

- **First slice:** versioned player-save model, settings and profiles in user-writable storage
  outside installed content. Add atomic replacement, validation, migration and recovery to a
  last valid save. Specify checkpoint/session/level persistence and stable cross-level references.
- **Expansion:** save slots, import/export saves and optional cloud conflict handling. Browser
  recovery restore, desktop crash/relaunch automation and transactional dependency-copy cleanup
  are delivered for editor projects. Power-loss durability is still not claimed.
  Cloud services are not required for offline games and require separate approval.
- **Depends:** ENG-03 lifetimes, ENG-18 safe storage and ENG-19 failure injection.
- **Acceptance:** progress survives exit/relaunch and a level round trip; corrupted/future-version
  saves fail safely. Kill during writes and verify old or complete new state. Project recovery
  must not overwrite newer explicit saves. Never promise power-loss durability from process-kill
  tests alone; retain original project/source files during migration and repair.

### ENG-08 — Animation and character production

**State:** native clip playback, morph weights, bounded CPU/GPU skinning, crossfades and per-instance clocks are in place. Events, parameters and root motion are not.
**Phases:** F3; scaling F4; advanced character tools F7. **Role:** animation engineering/tools.

- **First slice:** automatic crossfades and component-instance playback are in place. Still open:
  animation events, state parameters, and root-motion policy coordinated with collision. Preserve existing 2D
  timeline and sprite timing; explicit behavior for interruption, looping and reversed speed.
- **Expansion:** blend trees/spaces, layered/additive poses, skeletal LOD, IK, retargeting, rig editing,
  procedural controls, motion matching and facial workflows. GPU skinning of up to 16 joints matches the
  CPU reference; larger skins stay on the CPU. Morph weights are sampled before skinning.
- **Depends:** ENG-03 events, ENG-05 movement, ENG-02 import fidelity, ENG-09 GPU capabilities.
- **Acceptance:** idle/walk/run/jump/land works on an owned character with timed footsteps and
  a collision-safe root-motion test. Events fire exactly as specified through transitions;
  two instances play independently. Later GPU output matches CPU reference within a declared
  tolerance; missing bones, singular poses and unsupported channels produce diagnostics.

Reference: [Epic animation graphs](https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-blueprints-in-unreal-engine)
and [Control Rig](https://dev.epicgames.com/documentation/unreal-engine/control-rig-in-unreal-engine).

### ENG-09 — Renderer architecture and scene-scale performance

**State:** production-tested bounded WebGL 1 path; high-end/large-scene renderer remains.
**Phases:** measurements F0 onward; backend choice F4. **Role:** graphics engineering.

- **First slice:** representative textured/skinned scenes; instrument preparation, uploads,
  submission, GPU time, retained CPU/GPU resources and stalls. Add spatial visibility, batching,
  instancing, mesh/texture lifetime and LOD improvements where measurements justify them.
- **Expansion:** modern backend evaluation, resource handles, frame/pass scheduling, pipeline
  caching, asynchronous compilation, compute workloads, GPU-driven draw preparation and
  robust device-loss recovery. Compare WebGPU and native-host options against concrete targets;
  no API or language migration is selected in advance.
- **Depends:** ENG-02 compiled products, ENG-16 profiler, ENG-19 hardware matrix.
- **Acceptance:** same owned scene exercises old and candidate backends with bounded visual
  differences, picking agreement, resource cleanup and unsupported-device behavior. Publish
  end-to-end frame distributions and memory, not only shader or triangle microbenchmarks.
  A new backend ships incrementally without removing the working one before validation.

### ENG-10 — Materials, lighting and image quality

**State:** metallic/roughness textures, lights, shadows and HDR IBL exist; fidelity gap remains.
**Phases:** incremental F3/F4; advanced F7. **Role:** graphics/technical art.

- **First slice:** measurable material/light limits, material instances, preview/diagnostics,
  color-management tests and scalable shadow quality. Preserve unlit pixel-art color and
  nearest sampling. Distinguish authored environment contribution from scene-bounce lighting.
- **Expansion:** typed material graph and shader variants; decals, transparency policies,
  ambient occlusion, reflection probes, exposure/tone mapping, antialiasing, temporal history,
  bloom, depth of field, motion blur, volumetrics, atmosphere and clouds. Evaluate baked and
  dynamic GI, ray-based reflections and advanced shadow approaches as separate quality tiers.
- **Depends:** ENG-09 capabilities/performance, ENG-02 material cooking, ENG-16 debugging.
- **Acceptance:** controlled scenes test normals, roughness, energy/color handling, shadow
  bias, transparent overlap and camera motion. Each optional effect has budgets and a fallback.
  Temporal effects must survive cuts, teleport, resize and level changes without stale history.
  SVG/Canvas 2D capability differences remain explicit rather than silently approximated.

Epic's [Lumen](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine)
is the comparison for dynamic GI/reflections, not a capability of the existing HDR path.
[Nanite](https://dev.epicgames.com/documentation/unreal-engine/nanite-in-unreal-engine?lang=en-US)
geometry virtualization belongs to separate F7 research after ordinary LOD/streaming works.

### ENG-11 — World streaming, terrain and environment authoring

**State:** linked-level loading exists; large-world production systems are new.
**Phases:** F4 foundations; F5 delivery; advanced F7. **Role:** world/tools engineering.

- **First slice:** spatial partition and cell/subscene contract with stable references,
  asynchronous load/unload, cancellation, memory residency and activation rules. Keep the
  currently playable world valid while cells load or fail; define teleport/loading behavior.
- **Expansion:** origin/coordinate precision strategy, hierarchical LOD, terrain sculpt/paint,
  terrain collision, foliage instancing, splines/roads, water and procedural placement with
  reproducible seeds. Coordinate collision, navigation, lighting and audio residency.
- **Depends:** ENG-02 cooking, ENG-03 world ownership, ENG-05 collision, ENG-09 visibility.
- **Acceptance:** traverse and teleport through an owned multi-cell scene under a fixed memory
  budget; no duplicated gameplay entities, missing collision underfoot or leaked unloaded cells.
  Reload/undo terrain edits preserves seams and derived collision. Precision is tested at the
  declared world extent. Do not simply increase schema limits to claim larger worlds.

Epic's [World Partition](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-in-unreal-engine)
illustrates the difference between distance-based streaming and switching complete levels.

### ENG-12 — NPC intelligence and navigation

**State:** general NPC planning/navigation is new relative to specialized game behavior.
**Phases:** F3 minimum; F5 scale. **Role:** gameplay AI/navigation engineering.

- **First slice:** navigation build/query boundary, path requests with cancellation, steering
  and simple authored idle/patrol/chase/return states. Add perception queries and debug overlays.
- **Expansion:** dynamic obstacles, links/jumps, hierarchical paths, crowds, behavior trees
  or state graphs, reusable tasks, blackboard data and time-budgeted updates.
- **Depends:** ENG-03 behaviors, ENG-05 geometry/queries, ENG-02 derived navigation data;
  ENG-11 before streamed-world navigation.
- **Acceptance:** NPC reaches valid goals, reports unreachable goals and replans after obstacle
  changes without walking through collision. Deleting targets or unloading cells cancels stale
  paths. Deterministic fixtures and larger-agent benchmarks specify behavior and cost.

This gameplay AI is distinct from deferred generative authoring assistance.
Reference: [Epic behavior trees](https://dev.epicgames.com/documentation/en-us/unreal-engine/behavior-trees-in-unreal-engine).

### ENG-13 — Audio and visual effects

**State:** bounded sound cues exist; streaming/mixing and reusable particle production remain.
**Phases:** F3; scaling F4; advanced F7. **Role:** audio/VFX engineering and technical art.

- **First slice:** reusable sound assets, total decoded-memory budget, voice priority,
  spatial attenuation, music streaming and master/music/effects buses. Add bounded particle
  emitters with seed, lifetime, spawn rate, simple curves and sprite/mesh presentation.
- **Expansion:** occlusion/reverb zones, DSP routing, adaptive music, event-driven sound graphs;
  GPU particles, ribbons/trails, collision, effect graphs, volumetric and simulation integration.
- **Depends:** ENG-02 assets, ENG-03 events, ENG-09 rendering, ENG-11 spatial residency later.
- **Acceptance:** repeated effects cannot exceed declared voices/particles/memory; pause,
  mute, transition and device changes obey policy. Conduct actual listening tests as well as
  silent decode automation. Seeded effects replay consistently within the advertised mode;
  deleting an emitter frees resources. Package every required sound/effect dependency.

Unreal's [Niagara](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-niagara-effects-for-unreal-engine)
and [MetaSounds](https://dev.epicgames.com/documentation/en-us/unreal-engine/metasounds-the-next-generation-sound-sources-in-unreal-engine)
are references for authorable effect systems, not requirements to copy their graph models.

### ENG-14 — Multiplayer and online runtime

**State:** production multiplayer is new. **Phases:** architecture F2; prototype F4; delivery F6.
**Role:** networking/server engineering.

- **First slice:** document authority, ownership, runtime network IDs, command validation and
  timestamp/tick policy early. Later prove a headless authoritative server with two clients,
  minimal replication and disconnect/rejoin behavior using an owned interaction scene.
- **Expansion:** interest management, delta compression, interpolation, prediction/reconciliation,
  lag compensation, replicated spawning, level travel, version negotiation and networked physics.
  Sessions, authentication, matchmaking, relays and hosting require separate service decisions.
- **Depends:** ENG-03/04 command boundaries, ENG-05 determinism scope, ENG-01 host separation,
  ENG-18 security; ENG-11 for large worlds. Local cooperative input is not network replication.
- **Acceptance:** simulate latency, jitter, packet loss, duplicates and reordering; clients
  converge according to the declared model. Unauthorized state changes are rejected; late
  joins and disconnects do not corrupt world ownership. Measure server tick and bandwidth costs.
  No online service or recurring hosting charge is approved merely by accepting this roadmap.

Reference: [Epic networking overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/networking-overview-for-unreal-engine).

### ENG-15 — Cinematics, 3D construction and professional editor workflows

**State:** transform/inspector/timeline tools exist; broader production workflows remain.
**Phases:** incremental F3; F5. **Role:** editor/tools engineering and UX.

- **First slice:** reusable scene templates, searchable hierarchy/assets, multi-selection
  inspector consistency, snapping/alignment and runtime inspection. Extract cohesive shell
  workflows with tests as needed; do not turn this into an unrelated full UI rewrite.
- **Expansion:** shot/camera tracks, nested sequences, audio/event tracks, deterministic
  capture and image-sequence/movie output; primitive/blockout tools, mesh inspection, collision
  authoring, pivots, spline editing, material/animation workspaces and DCC round-trip workflows.
  Full sculpting/retopology is a later scope decision, not required to ship the first engine.
- **Depends:** ENG-08 animation, ENG-02 assets, ENG-06 cameras/UI, ENG-16 diagnostics.
- **Acceptance:** an author builds and packages a small scene and cinematic without private
  developer controls; edits undo correctly. Scrub/play/capture agree on event policy and frame
  timing. Export never overwrites unrelated files and reports unsupported capture features.

### ENG-16 — Performance architecture, diagnostics and debugging

**State:** tests, replay digests and informational benchmarks exist; integrated tooling remains.
**Phases:** every phase; F4 production gate. **Role:** performance/runtime engineering.

- **First slice:** frame timeline, counters, errors with stable entity/asset context and
  allocation/lifetime inventory. Measure input-to-present separately from simulation, CPU
  frame construction, GPU submission and GPU execution. Add pause/single-step/state inspection.
- **Expansion:** trace capture, memory/resource views, leak comparisons, script/physics/network
  panels, background job scheduler, worker tasks and data-oriented hot paths where profiles justify.
  Profile garbage collection and message copies before moving code into native modules.
- **Depends:** instrument host/backend boundaries without introducing alternate mutable truth.
- **Acceptance:** a report identifies a known injected slow job/leak/missing asset and links
  it to the responsible subsystem. Profiling overhead is measured. Unsupported GPU queries
  remain unavailable rather than zero. Long sessions show bounded resource retention.

### ENG-17 — Project organization, source control and collaboration

**State:** single-document workflows and components exist; team-scale asset/project editing remains.
**Phases:** design F4; source-control workflow F5; live collaboration F7 after approval.
**Role:** project/tools engineering.

- **First slice:** evaluate a versioned project manifest plus independently editable scene,
  asset and behavior records, preserving IDs and supporting old documents. Define deterministic
  serialization, reference validation, conflict presentation and recoverable migration.
- **Expansion:** semantic diffs, binary locking/LFS policy, branch-friendly generated content,
  external source-control integration, project diagnostics and eventual live collaboration.
  Live collaboration needs document operation ordering, presence, permissions and recovery;
  it is not the multiplayer game's replication protocol.
- **Depends:** ENG-02 references, ENG-07 recovery, ENG-18 permissions, schema migration design.
- **Acceptance:** two contributors edit different entities/assets and merge without unrelated
  changes or broken references. Same-field conflicts are visible, not last-write-wins surprises.
  Cancelled migration retains the original project. Do not rewrite existing Git history or
  move ignored packs into tracking as part of this work.

### ENG-18 — Security, privacy, provenance and dependency maintenance

**State:** confinement and bounded import safeguards exist; growing surfaces need continuous review.
**Phases:** all. **Role:** security/release engineering, with owner approval for policy changes.

- **First slice:** threat model for project import, archives, shaders, scripts, IPC and packages;
  validate file sizes/paths, decompression budgets, sender identity, permissions and output roots.
  Reassess dependency findings against actual locked versions; do not repeat old audit counts
  as current evidence or apply blind breaking upgrades.
- **Expansion:** parser fuzzing, isolated untrusted execution, package/plugin manifests,
  software inventory, dependency update cadence, reproducible artifact/provenance reports,
  opt-in crash reporting with redaction, and server abuse defenses when networking lands.
- **Depends:** every new input boundary. Review Electron-specific isolation and IPC practices
  against [official Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
- **Acceptance:** malicious paths, malformed payloads, decompression bombs and untrusted
  commands fail without external reads/writes or unbounded resource use; updates rerun
  relevant tests. No personal publisher metadata/signing is required under the user's current
  anonymous/unsigned policy. Do not imply that an unsigned build guarantees anonymity.

Local ignored assets and their license/credit files remain intact. They are not automatically
redistributable fixtures. Releases/examples use original or explicitly approved content and
include applicable notices. Follow [asset policy](ASSET-INVENTORY.md); this plan authorizes
neither legal conclusions about packs nor historical asset purging.

### ENG-19 — QA, compatibility and release engineering

**State:** substantial automated coverage; broad production certification remains.
**Phases:** all. **Role:** QA/release engineering.

- **First slice:** reproducible build/test instructions, artifact-to-source identity, owned
  compatibility corpus, clean-profile player smoke and recorded failure triage.
- **Expansion:** visual/reference tests, importer fuzzing, bounded mutation batches with a
  zero-tests breaker, historical upgrade migration, hardware GPU/driver
  matrix, long sessions, packaging rollback and performance regression gates. The installer
  harness now plans legacy 0.0.4 project migration, assisted GUI and per-machine installs, and
  a host hardware-GPU classifier outside the software-rendered Sandbox. A recorded Windows run
  of those phases is still required; that guest result is not hardware certification.
- **Depends:** each subsystem exposes test seams; ENG-16 measurable diagnostics.
- **Acceptance:** each supported target can build, launch, author/play where applicable,
  save, migrate and uninstall/update according to its policy without losing user data.
  Archive checks exclude forbidden assets and stale bundles. Software-rendered Sandbox results
  are not labeled hardware-GPU certification. Flaky tests receive diagnosis, not silent removal.

### ENG-20 — Visual/pixel design and shared authoring quality

**State:** substantial existing product; refinement and scaling remain first-class work.
**Phases:** every phase, especially F3/F4. **Role:** 2D editor/graphics engineering and UX.

- **First slice:** regression contract for snapping, pixel-selection transforms, palettes,
  layer/component editing, sprite timing, tiled placement and import/export fidelity. Address
  large/noisy raster latency and component invalidation from measured workloads.
- **Expansion:** remaining layout tracks/placement, reusable design assets, advanced typography
  and font packaging, predictable color/export behavior, better sprite/tile animation workflows,
  large canvases, accessibility and reusable runtime UI/2D-in-3D composition.
- **Depends:** existing Actions/history, ENG-02 assets, ENG-06 UI, ENG-16 profiling.
- **Acceptance:** complete an owned design board, editable sprite set and tile-based game;
  reopen, transform, undo, export and package without timing, alpha, palette or placement loss.
  Native 3D improvements cannot silently change 2D pixel output or make design-only projects
  require simulation. Include this workload in every major release gate.

### ENG-21 — Platform abstraction and hardware tiers

**State:** Windows editor and offline 2D browser player; broader 3D targets are unproven.
**Phases:** F1 Windows; F4 capability tiers; F6 additional targets. **Role:** platform engineering.

- **First slice:** declare Windows player support with tested OS/GPU/driver/build evidence;
  separate platform input, paths, saves, windowing, audio and graphics capabilities from gameplay.
- **Expansion:** select macOS/Linux, browser 3D, mobile or XR individually; add SDK/build,
  lifecycle, controls, packaging and device tests per target. Consoles require separate platform
  access, agreements, SDK and certification work; no support promise follows from a portable API.
- **Depends:** ENG-01 runtime boundary, ENG-09 graphics, ENG-06 interaction, ENG-19 matrix.
- **Acceptance:** every advertised target has tested install/run/save/update behavior, fallback
  behavior and a supported feature list. Unsupported hardware sees a useful diagnostic, not a
  crash or misleadingly altered scene. Add targets only when someone can maintain their tests.

### ENG-22 — Extensions, ecosystem and specialized advanced systems

**State:** editor scripting is partial; full ecosystem and specialist simulation are deferred.
**Phases:** F7 after relevant production gates. **Role:** platform/API engineering and specialists.

- **First slice:** when justified, versioned extension manifests, explicit permissions,
  isolated execution, compatibility checks and one supported extension seam with examples.
  Do not expose mutable documents or arbitrary host APIs to plugins.
- **Expansion:** import/export plugins, tool/inspector extensions, shader/effect extensions,
  packaging hooks, discovery/update controls and optional collaboration/generative assistance.
  Specialist tracks include advanced vehicles/destruction/cloth/fluids, facial/digital-human
  tools, procedural generation, virtual production and high-quality offline rendering.
- **Depends:** stable ENG-02/03/04/09 contracts, ENG-18 security, ENG-19 compatibility;
  specialist features depend on their physics/animation/rendering work packages.
- **Acceptance:** install/disable/update/fail an extension without damaging a project;
  denied permissions are enforced. Each specialist track first defines a concrete sample,
  quality/performance target, ownership and supported-platform scope. No marketplace, cloud
  account, telemetry or paid integration is introduced without separate approval.

<a id="queue"></a>
## 6. First implementation queue

These are proposed bounded tasks, not instructions to start implementation in this document task.
Promote one into the active backlog at a time; keep advanced work deferred.

| Order | Task | Required output | Verification |
|---|---|---|---|
| Q01 | Record F0 baseline | Current revision/dirty-tree evidence, known failures, test/artifact manifest and supported-host assumptions | Existing relevant checks; no commit/push without authorization |
| Q02 | Specify player/host boundary | Small interface proposal plus import/dependency map of editor-only versus reusable runtime code | Lifecycle/cancellation tests; confirm 2D and 3D ownership semantics |
| Q03 | Specify game manifest | Version, entry, reachable levels/assets, feature requirements, ID/path policy and bounded validation | Cycles, aliases, missing assets, corruption, unsupported versions and relocation tests |
| Q04 | Build minimal 3D player | Dedicated player entry sharing runtime/render paths; no editor authority | Owned 3D scene loads, animates, transitions and restarts in real Chromium |
| Q05 | Package and prove F1 | Windows distributable, dependency/archive report, isolated-profile test | Offline execution away from originals; corruption and missing-file diagnostics |
| Q06 | Add gameplay lifecycle/input/save foundation | Typed behaviors and input actions, reusable scene interaction, versioned player save | Spawn/despawn, pause/focus, level round trip, crash-safe save and unchanged authoring |
| Q07 | Evaluate and deliver physics slice | Evidence-backed backend decision and character test course | Slopes/stairs/platforms/sweeps, packaging, runtime cost and old-game regression |
| Q08 | Expand representative games | Character animation, one NPC, audio/effects/UI and design assets | Complete-game packaged playthrough and full shared-authoring regression |

Q02–Q05 should not grow into the full asset database, visual scripting or native renderer.
If the player cannot reuse a runtime path without pulling in the editor, extract the smallest
cohesive seam with tests and reassess; do not clone simulation logic into a second implementation.

<a id="verification"></a>
## 7. Acceptance, measurements and release gates

### Common definition of done

Every promoted slice requires:

1. Explicit scope, non-goals, owning role, dependencies and current baseline evidence.
2. Small implementation with unit/integration tests; Actions and migration tests for authored changes.
3. A reachable editor or player workflow, not only an exported function or hidden debug control.
4. Malformed-input, failure, cancellation, stale-result and resource-lifetime tests where applicable.
5. An owned representative fixture and reproducible verification commands/artifact locations.
6. Updated capability matrix, user documentation and backlog status; no unsupported completion claims.
7. No regression to existing design/pixel, 2D game, 3D authoring or Save/undo behavior.
8. Measured cost on declared hardware and a supported fallback or explicit refusal.

A subsystem becomes **production-ready for a declared scope** only after these gates and
representative packaged use. A prototype or baseline must retain that label until then.

### Representative project ladder

- **Existing regressions:** retain the original fixtures and Signal Garden/Signal Relay examples.
  Do not replace them with more complicated content that obscures previously pinned behavior.
- **F1 portability scene:** two linked levels, mesh/skin, shared material textures, HDR and a
  composed 2D overlay; use original content and test from outside the source tree.
- **F2 movement course:** stairs, slopes, corners, dynamic obstacles, moving platforms,
  trigger interactions and a save checkpoint, with deterministic inputs where supported.
- **F3 complete game:** proposed 10–15 minute original experience with three levels, one
  controllable animated character, several NPCs, interactions, menus, sound, victory and saved
  progress. Exact counts are scope targets to approve, not existing capabilities.
- **F4 stress scenes:** increase instances, unique materials, textured/skinned characters,
  lights and raster size independently before combining them. Avoid triangle-only conclusions.
- **F5 streamed world / F6 network scene:** add residency and authority stress only after
  the corresponding subsystem is independently validated.

### Proposed budgets — not current performance promises

First record hardware/OS/driver, resolution, quality tier, scene revision, warmup, sample count
and background conditions. Choose minimum and recommended machines before making release claims.

| Measure | Initial proposed target | Measurement rule |
|---|---|---|
| Complete-game presentation | Aim for 60 FPS at a declared quality/resolution; 30 FPS only as an explicit lower tier | Report p50/p95/p99 frame times and hitch counts; 16.67 ms and 33.33 ms are frame intervals, not proven current budgets |
| Ordinary editor response | Aim for p95 under 100 ms for ordinary commands; drag response should track the selected refresh target | Measure input-to-visible response, including geometry and presentation |
| Memory/resource residency | Fixed per-scene/per-tier limits chosen after F3 measurements | Count CPU heap, decoded assets, native allocations and GPU resources separately where observable |
| Repeat lifecycle stability | 100 play/stop and level/reload cycles | No unexplained monotonic retention; account for intentional caches and GC noise |
| Soak stability | Initial 60-minute mixed author/play session; expand to overnight qualification | Log errors, handles, memory, frame stalls and recovery behavior |
| Portability and compatibility | All supported fixtures load or fail explicitly; no silent data loss | Versioned corpus, clean-profile runs, moved folders, missing/corrupt dependencies |
| Startup/loading | Establish cold/warm baselines before selecting release thresholds | Include disk, decode, compile/upload and time to usable input; do not time only deserialization |

Do not add CPU p95 and GPU p95 measurements from separate runs and label the sum a frame time.
Microbenchmarks establish local costs, not maximum supported world size. Hardware-GPU validation
must be separate from software-rendered Sandbox installer testing.

### Release evidence bundle

Capture source revision and working-tree state, build identity, hashes, dependency/license
inventory, test commands/results, platform matrix, screenshots/traces, budgets, known issues,
migration outcomes and rollback instructions. Keep generated evidence in designated ignored
build/test locations, not as large unreviewed binary additions to source tracking.

Run checks in proportion to changes. Source/runtime work normally needs typecheck, headers,
tests, build and affected real-host smokes; release changes need package/lifecycle checks too.
Documentation-only work needs link/structure/consistency checks, not a claimed fresh runtime run.
The history-based documentation gate must be reported honestly until reviewed docs are committed.

<a id="decisions"></a>
## 8. Decisions, resourcing and risks

### Decisions already settled

- Both visual/pixel design and game authoring remain first-class.
- Preserve the current authoring model and isolated Morphic reference; no wholesale rewrite.
- Keep ignored local assets and their credit files; do not restore tracking or purge Git history.
- Keep anonymous publisher metadata and unsigned distribution unless the user changes that policy.
- Keep generative assistance, full plugins and live collaboration deferred while the core matures.

### Decisions to make at the relevant gate

| Decision | Latest safe point | Evidence/approval required |
|---|---|---|
| First complete game's genre and scope | Before F2 behavior expansion | Proposed small traversal/interactions game; user chooses art/game direction before content production |
| Physics backend | ENG-05 spike | Owned movement corpus, license review, packaging/targets, measured stability/cost; no preselected library |
| Renderer/backend evolution | Before F4 graphics rewrite | Representative GPU/CPU profiles, feature needs and tested hardware support |
| Player host beyond initial Windows route | Before adding non-Windows/native targets | Packaging, memory/startup and API requirements; preserve shared runtime |
| Minimum/recommended hardware and quality tiers | F3 measurements, before F4 release budgets | Real-device results and acceptable user experience; not inferred from one GPU |
| Network model and first multiplayer scope | Authority contract F2; product scope before F6 | Player counts, latency model, trust/hosting costs and explicit service approval |
| Multi-file project format | Before F5 migration | Diff/merge examples, performance evidence, lossless migration and rollback |
| Additional OS/mobile/XR/console targets | Before each F6 target starts | Maintainer/test devices, SDK access, requirements and applicable approvals |
| Advanced GI/virtualized geometry/simulation | Before each F7 investment | Identified use case, benchmark, quality bar, maintenance owner and fallback |

### Ownership and capacity

Roles in work packages are responsibilities, not assigned staff. Assign a primary implementer
and a reviewer/test owner before starting a slice. A small team can combine roles, but should
limit work in progress to one primary implementation slice and one verification/documentation
stream. Parallelize graphics, assets and gameplay only once their contracts are stable.

Expect specialist contributions for physics, rendering, animation, networking, audio and
cross-platform release QA at advanced stages. Do not forecast a calendar from feature count.
Estimate only the next bounded slice after its discovery work; update forecasts using actual
throughput, integration/review cost, defect rate and available test hardware.

### Risk register

| Risk | Early warning | Mitigation / stop condition |
|---|---|---|
| Breadth overwhelms integration | Many panels exist, no complete packaged game | Freeze new subsystems until F1/F3 path passes |
| 2D product regresses | Pixel output, import timing or editing latency changes unexpectedly | Shared-authoring regression gate every release |
| Premature native/GPU rewrite | No reproducible bottleneck or unsupported required feature | Require comparative spike and migration/fallback plan |
| Physics complexity escalates | Repeated solver fixes destabilize earlier courses | Evaluate established backend behind contract; preserve legacy policies |
| Unsafe scripts/assets/plugins | Host access, hangs or uncontrolled allocations | Isolate execution, validate capabilities, fuzz and bound resource use |
| Large-world memory spikes | Unloading does not release references/resources | Residency ownership and lifecycle counters before increasing world scale |
| Network retrofit | Behaviors mutate local state without authority | Define commands, ownership and network ID policy in F2 |
| Asset/license leakage | Packs enter packages or public fixtures | Reachable-content allowlist and provenance checks; retain local-only policy |
| Data migration loss | IDs/semantics change without corpus coverage | Versioned migrations, backups, explicit preview and compatibility tests |
| False release confidence | Passing small tests treated as full certification | Representative packaged runs, hardware matrix and scoped claims |
| Platform/service burden | New target has no test owner or service budget | Do not advertise/support it until ownership and approval exist |
| Roadmap drift | Summary says complete while detail still lists missing gates | Status/evidence review at every phase exit; preserve historical records |

<a id="maintenance"></a>
## 9. Relationship to existing backlog and documentation

This document owns the **long-term capability map and phase dependencies**.
[BACKLOG.json](BACKLOG.json) remains the compact active/deferred work list.
[MILESTONES.md](../MILESTONES.md) retains historical delivery evidence;
[3D-FOUNDATION.md](3D-FOUNDATION.md) retains adoption boundaries;
[PRODUCTION-WORK.md](PRODUCTION-WORK.md) records current verified workflow limits.
Do not mark a historical milestone incomplete merely because its successor is ambitious.

| Existing backlog item | Related roadmap work |
|---|---|
| RELEASE-001 | ENG-01, ENG-19, ENG-21 |
| SHELL-001 | ENG-15, ENG-20 |
| ANIMATION-002 | ENG-08 |
| GAMEPLAY-001 | ENG-03, ENG-04, ENG-06 |
| EXPORT-001 | ENG-01, ENG-02, ENG-21 |
| PHYSICS-001 | ENG-05 |
| AUDIO-001 | ENG-13 |
| PROJECT-001 | ENG-07, ENG-17 |
| SCALE-001 | ENG-09, ENG-16, ENG-20 |
| RENDER-002 | ENG-10, ENG-20 |
| LAYOUT-001 | ENG-06, ENG-20 |
| COMPONENT-001 | ENG-16, ENG-20 |
| FUTURE-001 | ENG-17 live collaboration and ENG-22; not ordinary NPC navigation |

When promoting work, reuse the existing backlog item where appropriate and add an evidence
link to the specific ENG work package. Create new active entries only for approved bounded
slices; avoid duplicating all future tasks as urgent work. Preserve the backlog's existing
schema/status rules unless a separate change explicitly extends and tests them.

Review this plan after each phase gate or material architecture decision:

1. Re-read relevant live source and official API/library documentation.
2. Record baseline revision, observed limits and verification artifacts.
3. Update only the affected work package and dependency/gate statements.
4. Separate delivered evidence from next scope; record deferred decisions with reasons.
5. Reconcile active backlog and user-facing summaries without rewriting historical evidence.

## 10. Research scope and limits

Official Epic links beside the work packages establish the comparison categories: gameplay,
animation, physics, rendering, worlds, effects, audio, networking and shipping. They are not
instructions to import Unreal code or claims of equivalent implementation. Proposed Canvas
Fogworks interfaces, milestones, priorities and budgets are engineering recommendations based
on the inspected local architecture, not requirements quoted from Epic.

Vendor documentation is living material. Recheck specific APIs, versions, licenses, supported
platforms and parameters at implementation time. The attempted full W3C WebGPU specification
fetch exceeded the research tool's size limit; this plan therefore makes no API-level WebGPU
claims and leaves backend selection to a measured, separately researched decision.

The immediate objective remains clear: **ship a complete, portable 3D game using the same
foundation that continues to support strong visual/pixel editing and 2D game creation.**
Build production breadth from that evidence; pursue advanced fidelity without sacrificing it.
