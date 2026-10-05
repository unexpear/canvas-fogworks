# Production workflow programme

Requested scope: all five priorities from the September 5 project review. Both visual/pixel authoring and game authoring remain first-class tracks. Local ignored example assets are not distribution fixtures.

Gameplay follow-up (2026-09-12, schema 79): named input actions, interact rules, bounded
template spawning/despawning, checkpoint respawn and versioned current-level player progress
are now implemented for 2D/3D, including a Controls panel that rebinds those named actions.
See [Gameplay foundations](GAMEPLAY-FOUNDATIONS.md) for exact
semantics and verification. The schema 78 baseline below is historical; general scripting,
full prefabs and complete 3D audio remain open. Visited-level game values are saved as player-progress v6.
Explicit cross-build adoption and `npm run test:progress-crash` cover listed content hashes and a killed progress writer; neither is a prefab system or a power-loss proof.

## Delivered baseline (schema 78, app 0.0.5)

All five tracks have implementation; this is a bounded production baseline, not completion of every future engine capability. Historical M18 slice counts are unchanged. The remaining work below is tracked in `BACKLOG.json`.

1. **Project safety.** `ProjectSession` unifies toolbar/menu Save and Save As. A path/savepoint advances only after a successful host write; failed or overlapping saves are visible, and edits made during a save stay dirty. New/Open/close have unsaved-edit protection. Native recovery snapshots are written every five seconds and offered at startup. Recovery does not replace explicit Save and can lose edits since the last successful checkpoint. Cross-folder Save As copies a bounded linked-level graph, relative images, glTF/GLB/HDR sources and glTF buffers/images, with confinement and conflict refusal. Native Open embeds confined relative images, including states, overrides and tilesets. It never copies unreferenced packs. Writer-process exits now test editing, partial writes, file flush, pre-rename, post-rename and post-directory-fsync recovery. The post-rename kill still sees the new bytes and is not a power-loss proof, because the directory entry was not flushed. The next replacement removes a temporary file left by a killed partial write. The browser restores the same snapshot from local storage, and `smoke:crash-relaunch` kills the real editor after a checkpoint, then relaunches it to restore and to discard. A recovery snapshot is not applied when the explicit save is newer, and it never writes the project file by itself. See the exact bounds below.

2. **Shared authoring.** Aseprite imports preserve the existing timeline, clips and controllers. Incoming timings are converted to the document FPS only when all boundaries land exactly on frames; incompatible timing fails before mutation. Clip-name collisions receive unique names and imports cannot shorten the timeline. The export drawer now offers whole-canvas PNG with decoded images/fonts, transparent or authored background, content framing and no grid/selection overlays. PNG is limited to 16 megapixels / 16,384 pixels per side and rejects native 3D capture. Chromium smoke checks actual unlit and lit pixels.

3. **Gameplay and export.** Runtime Entity inspector rules support start/enter/leave/contact/separate events, any/player conditions, self/other targets, win/lose/despawn/velocity/score and embedded sound actions. Choose Authored rules on the player to disable the compatibility platformer rules. `stepGameplay` is shared by editor and player; commands modify transient world state, not document history. Level playback has its own document/path and stages destination meshes, material textures and HDR environments before publication. Failure preserves the previous runtime; Stop/Restart and superseding transitions invalidate late reads. Authoring caches, Save target and history remain separate. The export drawer can write a standalone offline **2D** `game.html`, including a bounded linked-level graph, embedded images/sounds, camera, controls and restart/respawn. That 2D exporter refuses external images, unsupported runtime geometry and native 3D. A separate [standalone 3D export](STANDALONE-PLAYER.md) packages reachable assets and custom fonts, reports unsupported features and writes unsigned provenance. Clean-profile acceptance is automated. Embedded sound cues and screen-space text play in that package. Buffer, image and HDR bytes can stream from sibling chunks. Signatures and a recorded clean-machine EXE pass remain open. Broader script/condition bindings remain open. Web Audio supports 32 voices and 32 cached cues, with a 32 MiB decoded limit per cue; this is not a streaming/mixing system or a total-byte-budgeted cache.

4. **Native 3D.** glTF import retains TRS tracks and four-influence skin data. The 3D inspector selects a clip, loop/speed and optional second clip/pose-blend weight; Run or timeline scrubbing samples it. STEP, LINEAR (including quaternion slerp) and CUBICSPLINE are tested. CPU skinning is limited to 100,000 vertices, 128 joints per skin, one buffer and four million imported scalar values. These are safety limits, not a 60 FPS guarantee. Invalid/singular sampled poses report a diagnostic and fall back to the imported pose. Rotated box SAT and sphere contacts replace AABB-only overlap queries. Setting gravity/restitution opts a dynamic entity into bounded substeps and static-contact resolution; absent settings retain legacy movement. Skins of at most 16 joints deform on the GPU; larger skins, morph application and the reference formula stay on the CPU. Automatic crossfades and morph weights are sampled with the clip. Dynamic-pair impulses, angular dynamics and a production character controller remain open.

5. **Owned examples and measurements.** The small original visual/game/animated-triangle examples remain unchanged. `reference-projects/authoring-v1/` adds Signal Garden (editable pixel atlas, palette, master and 15 component instances) and Signal Relay (three 68-node stages, 24 collectibles, upper routes and gates). `npm run examples:create -- <new-folder>` regenerates portable copies and refuses existing folders. CPU benchmarks now include these exact projects, 1024-square raster encoding/decoding, 500 instances, 100 animated mesh draws and isolated disk reload. `benchmark:gpu` measures production WebGL CPU submission and asynchronous GPU queries when available. Chromium completes the three-level offline game and exports the workshop PNG. SCALE-001 release budgets are calibrated in the section below; they stay informational and are not a hardware-independent CI gate.

## Commands and evidence

- `npm run ci`: typecheck, module headers, doc drift, header-claim inventory, mutation-target preflight, complete Jest suite, real writer-process crash tests, build, startup/file/lighting/3D/level-transition/authoring Electron smokes.
- `npm run smoke:package`: build the Windows NSIS package and launch the unpacked executable for startup and Open/Edit/Save tests. It does not silently install the application on the user's machine.
- `npm run benchmark:authoring`: informational local measurements, including the mixed soak, noisy 2048 raster and textured scenes; intentionally no hardware-dependent CI failure threshold. `npm run test:benchmark-budgets` locks the budget formula and the rule that extra host samples do not move it. `node scripts/record-benchmark-sample.js` stores a later host beside the frozen budgets. `node scripts/preview-hardware-admission.js` prints a physical-GPU admission and leaves that cohort unchanged.
- Focused regression suites: `ProjectSession`, `ProjectFileWorkflow`, `projectDependencies`, `asepriteImport`, `CanvasExport`, `GameplayPanel`, `GameplaySession`, `GameExport`, `LevelTransitionWorkflow`, `GltfMotion`, `Collision3D` and `ThreeDInspector`.
- `smoke:authoring` uses actual Chromium PNG decoding/pixel inspection, silent generated WAV decode/play/stop, and an offline game reaching victory. This is not an audible listening test.
- Mutation preflight checks all 402 targets still match; it is not equivalent to executing and killing all mutants.

## Shared-authoring follow-up — 2026-09-07

Portability is limited to 32 levels, 4096 dependency files, 64 MiB per dependency and 256 MiB per copy batch; linked project files retain the runtime's 20 MB limit. Nested level paths obey the same per-level directory confinement as playback. Return links from sibling levels are rewritten to the new entry filename. A self-linked entry must keep its filename during cross-folder Save As; the operation refuses a rename rather than writing stale references. External URLs and absolute paths are not downloaded/copied. Project relocation does not copy custom fonts; standalone 3D export packages referenced faces separately. Existing conflicting assets are never overwritten. The entry project is committed only after copying succeeds. A failed copy deletes only destination files and directories that copy created. A killed copy leaves `.fogworks-dependency-journal.json`. Created dependency bytes are fsynced, and their directories are fsynced when the platform allows it, before that journal is replaced with a `filesSynced` record and that record's bytes are flushed. The journal name is removed only after that replacement. The next cross-folder Save As deletes files and directories listed by an in-progress journal. A journal that still says `filesSynced` keeps those copies and removes only itself. `filesSynced` means those file sync calls returned; it does not mean the directory flush succeeded. The same replacement helper fsyncs a project or recovery file's parent directory after rename when the platform allows it, and the next replacement removes a stale sibling temporary file left by an unclean shutdown. Power-loss durability is not claimed: a crash before a directory fsync returns can still show the previous journal or drop a new name, a disk that ignores flush can still lose bytes that sync reported, and a platform that refuses directory fsync can still drop a new name.

Relative image embedding observes the schema's 4,000,000-character image limit, a 32 MiB unique-image batch and a 64 MiB expanded-project limit. Images remain embedded in subsequent saves; source image files are unchanged. Network images retain their existing Open behavior but are refused by cross-folder portability.

Verification follow-up: entry-level comparisons now use the confined filesystem-resolved path, so differently capitalized Windows return links cannot copy an older entry from disk. Exclusive dependency writes accept an existing alias only when its bytes match; differing contents are still refused. Distinct logical placements (including internal junction paths) remain intact. Windows destination entry names are conservatively reserved case-insensitively, even in a case-sensitive directory, to prevent a dependency occupying the project filename. Regression tests cover these cases and a conflicting file appearing after preflight; the Electron level smoke includes case-aliased return links and shared image/texture references. This follows [Node realpath behavior](https://nodejs.org/api/fs.html#fsrealpathsyncnativepath-options) while respecting [Windows per-directory case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity).

`test:recovery` kills a real isolated Node writer using the production `ProjectSession` and `atomicWrite`, then deserializes and restores in another process. Before rename, the previous save survives byte-for-byte; after rename, and again after the parent-directory fsync, the complete new save survives. The latest completed recovery checkpoint survives all six kill points. A separate case kills during a partial write and checks that the next replacement removes the leftover temporary file. The same run kills a dependency copy during a payload write, after the `filesSynced` journal is renamed and before its directory flush returns, after that directory flush returns, and after the journal name is removed. The in-progress kill rolls the partial copy back on the next relocation. The `filesSynced` kills keep the copied bytes. After the name is removed, the test plants that same record and checks that the next relocation still keeps the bytes. Planting the record is not a power-loss proof. `smoke:crash-relaunch` repeats the checkpoint in the built Electron app, kills that process, and relaunches into the same profile. Restore shows the unsaved timeline and leaves the project file byte-for-byte unchanged. Discard leaves both the project file and the recovery snapshot. The relaunch answers the production recovery dialog by its Restore and Cancel results; it does not click the operating-system window. This verifies process failure, not unplugging the drive or OS failure.

`smoke:levels` first relocates an owned linked project into a new folder, then exercises the real Electron preload and filesystem IPC with its copied mesh, binary, PNG texture/relative image and HDR files. It stages a new runtime, decodes the image and submits its frame to WebGL. Missing destinations preserve the current runtime. Unit tests additionally cover missing HDR, Stop during hydration and superseded transitions.

Verification on September 7: 2,165 Jest tests across 41 suites, five forced-crash cases, 22 release-tooling tests, typecheck, module headers, mutation preflight, build and all startup/file/lighting/3D/level/authoring Electron smokes passed. The full `ci` command stops at the existing history-based doc-drift gate: `FEATURE-AUDIT.md` and `PLANNED-FIXES.md` were stale after baseline `dac1ef9`. Both are corrected/re-read in this working tree, but their review must be committed before that gate can pass. Remaining gates were executed separately; no new commit, push or installer build is claimed for this follow-up.

### Measured baseline and priorities

Windows x64, Node 24.15.0, Electron 43.2.0 / Chromium 150, Intel Iris Xe through ANGLE D3D11. CPU and GPU runs are separate, warm, informational measurements; do not add their p95 values or interpret them as end-to-end frame rate. GPU runs used 20 valid timer samples per workload at 1280×800, with zero disjoint samples.

| Workload | CPU p95 | GPU p95 |
|---|---:|---:|
| Signal Garden: 36 stored / 81 resolved nodes | 1.120 ms geometry + display list | 2.076 ms |
| Relay stages, 68 nodes each | 0.119–0.218 ms geometry + display list | 1.536–2.312 ms |
| 500 instances / 2021 resolved nodes | 3.559 ms geometry | not measured |
| 1024×1024 raster encode / decode | 6.889 / 3.267 ms | not applicable |
| 100 animated mesh nodes | 1.239 ms frame construction | 1.851 ms fixed-pose drawing |
| Original glTF + binary disk reload | 1.399 ms | not applicable |

Next performance work should start with large/noisy raster operations and longer mixed authoring sessions, then larger textured/skinned scenes and cross-hardware budget calibration. These samples do not justify a renderer rewrite or a Rust migration. GPU skinning remains a future scaling option, not a demonstrated bottleneck in the tiny triangle benchmark. Keep AI, collaboration and the plugin ecosystem deferred.

API behavior was checked against [Node filesystem synchronization](https://nodejs.org/api/fs.html#filehandlesync), [Node process termination](https://nodejs.org/api/child_process.html#subprocesskillsignal) and the [Khronos WebGL timer-query specification](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query/). Timings that are unsupported, timed out or disjoint are reported as unavailable, not zero.

## Windows packaging verification — 2026-09-05

The initial `smoke:package` pass from the relocated D: workspace took 45.73 seconds, with process-local temporary storage and download caches on D:. After the follow-up hardening below, packaging passed again and produced `release/Canvas Fogworks Setup 0.0.5.exe` (100,453,429 bytes; September 5, 12:44 EDT build). Packaged startup and Open–Edit–Save both passed against the unpacked packaged executable; installation/uninstallation of the NSIS installer was not exercised.

The 202-entry application archive was inspected: its HTML, editor bundle, offline player bundle, Electron main and preload files matched the current build byte-for-byte. Local asset packs, legacy/reference source folders, test fixtures and application source were excluded.

September 5 installer SHA-256: `0A2641DD9A2E2E075399137390BA5CD97FA3F10662599A17E5F6E53BCCC8F50C`.

The September 7 branding build replaces the default Electron icon with the original editable `build/icon.svg` mark and updates the installer description to reflect both authoring tracks and 3D. The branded installer is 100,524,624 bytes; SHA-256: `DF609C8CE900FADDC325497DB46B11D2148EDF83A002EEB1AFD3D37F8CC636EE`. Archive validation and packaged startup/Open–Edit–Save pass. Its CompanyName field is blank and Authenticode status is `NotSigned`, as verified after packaging. The user explicitly chose to omit personal publisher information and keep the build unsigned; missing author metadata is intentional, not an outstanding request for credentials. This is not a signed/public-release certification or a guarantee of complete anonymity.

The full software-rendered Sandbox lifecycle was also rerun successfully against that exact branded installer: fresh install, both installed-app smokes, uninstall, synthetic-version upgrade, both upgraded-app smokes and final uninstall, with project/recovery bytes preserved. All seven generated icon representations were found in the packaged executable's resources.

Follow-up hardening makes archive inspection repeatable with `check:package`, wired into `smoke:package`. `test:package` exercises missing/stale bundles, forbidden application entries, package identity, corrupt archives and unpacked required files using actual ASAR fixtures. Startup/file smokes now isolate native recovery and Chromium storage in per-run temporary profiles. The normal application profile is unchanged. The checker uses the already-locked `@electron/asar` 3.4.1, now declared explicitly as a development dependency; no dependency versions were upgraded.

Follow-up verification: all 22 release-tooling tests, typecheck, module headers, doc drift, archive inspection and both packaged smokes passed. Separate smoke profiles were created under the D: temporary directory. The earlier full Jest run is separate evidence; the whole Jest suite was not rerun for this release-tooling-only pass.

A separate offline [installer lifecycle harness](INSTALLER-TESTING.md) passed the complete per-user sequence on 2026-09-07: fresh install, installed startup/Open–Edit–Save, uninstall, synthetic 0.0.4-to-0.0.5 upgrade, upgraded startup/Open–Edit–Save and final uninstall. Installed archive hashes matched; owned project and recovery bytes survived. Earlier Sandbox desktop crashes were isolated to virtual-GPU mode, so this test configuration explicitly uses software rendering. A Windows PowerShell exit-code reporting issue in the harness was reproduced and corrected before the passing run. The harness now also stages a legacy 0.0.4 project migration, assisted GUI per-user and per-machine installs, silent per-machine install/uninstall, and a separate host `validate:hardware-gpu` command. Those added phases have not been executed as a new Sandbox or hardware-GPU pass. Signing and personal publisher identification stay omitted under the user's current distribution preference. Broader recorded release evidence remains open in `RELEASE-001`.

On 2026-09-28 the repository gained `check:installer-evidence` and a staged `OPERATOR.txt` plan so a Windows host can record pass/fail artifacts for that extended guest and for a separate host hardware-GPU draw. The change was made where Windows Sandbox and a hardware GPU are unavailable. No new Sandbox `result.json` and no host `hardware-gpu.json` were produced. Exit 2 from the checker, with no files supplied, is the recorded state of that manual gate.

On 2026-10-02 the guest result writer was moved onto the staged Node binary so a finished Windows run emits the same JSON shape the checker scores, and the guest refuses `status: passed` unless that file already meets the guest half of the contract. Assisted clicks try UI Automation invoke or selection before a raw button message. Per-machine phases fail closed when the guest is not elevated. Named NVIDIA, AMD, and Intel adapter strings classify as hardware when they do not contain a software-renderer token. No Sandbox was launched and no `hardware-gpu.json` was recorded. Exit 2 with no files is still the open manual gate.

On 2026-10-05 the same gate was tightened where Windows Sandbox and a hardware GPU are unavailable. A guest field list whose status is `passed` is refused, and a previous passed file is removed, unless the bytes already meet the guest half, including `installerSha256` and smoke stdout that contains `smoke passed`. `validate:hardware-gpu` exits 0 only after `--out hardware-gpu.json` is re-read and meets the host half; a missing `--out` exits 1 and is not evidence. A certifying verdict the writer will not stand behind is not written. Operator instructions name DESKTOP-2SB8IKI and the two files that host must produce. No Sandbox was launched and no `result.json` or `hardware-gpu.json` was recorded. Exit 2 with no files remains the open manual gate. Virtual GPU stays disabled. Publisher metadata and signing stay omitted.

## Release budget calibration — SCALE-001

Recorded 2026-09-28. The prior host is the September 7 Windows x64 / Node 24.15.0 / Intel Iris Xe sample already in this document. The new host is Linux x64, Node 22.14.0, 4 vCPU Intel Xeon, 16 GiB, with `node --expose-gc`. CPU and GPU runs are separate. Do not add their p95 values or read them as an end-to-end frame rate.

Three workloads were added to the delivered CPU/GPU, 1024 raster, 500-instance, 100-mesh and disk-reload set:

- A mixed soak: 40 cycles of five discrete edits, a 1,000-node frame build, 25 relay steps and a 1024 decode, then further edits through the history ceiling and 30 edits after the first trim.
- A noisy 2048-square raster (16 MiB raw, 20 MiB packed). Runs do not collapse.
- Larger textured scenes: one 2048 raster plus eight unique 512 rasters (40 MiB of payload, frame-build p95), and 80 billboards carrying four texture ids (frame-build p95). GPU drawing of those scenes is below.

**Exact retention.** Each history revision stores the UTF-8 length of its canonical snapshot JSON and of its action payload. `retainedAccounting()` counts each distinct snapshot once. `stackBudgetEstimateBytes` is the UTF-16 estimate the trimmer compares with the 128 MiB ceiling. The pinned original is outside that ceiling and is added to `budgetEstimateBytes` only after trim detaches it. Process heap is not this ledger.

| 50 edits | Exact JSON retention | Trim estimate | Process heap delta | Snapshots |
| --- | ---: | ---: | ---: | ---: |
| 250 rectangles | 2.361 MiB | 4.712 MiB | 4.27 MiB | 51, not trimmed |
| 1,000 rectangles | 9.482 MiB | 18.955 MiB | 17.24 MiB | 51, not trimmed |

The September Windows heap deltas (4.32 MiB and 12.13 MiB) are process measurements, not this JSON ledger.

**Soak.** 373 edits in 3.547 s. Growth stayed proportional to new snapshots (`accountedGrowth`). Trim began at the ceiling and the tail held 344 revisions (`tailPlateaued`). Stack estimate at the end: 127.643 MiB, inside 128 MiB. With the detached original: 128.015 MiB. Exact JSON retention at that plateau: 64.042 MiB. Process heap: 134.84 MiB. Retention is bounded by the existing trim rule. That is not a leak and not a reason to replace snapshot history.

**Budget rule.** Interactive frame work still aims at 16.67 ms. Deserialize still aims at 100 ms. A frozen release budget is 1.5× the highest p95 in the frozen cohort, rounded up to 0.1 ms (`scripts/benchmark-budgets.js`). That cohort is the September 7 Windows sample and the 2026-09-28 Linux Xeon sample named in `FROZEN_CPU_HOSTS`. `benchmark:authoring` reports whether a later run exceeded that budget. It does not move the budget, and it does not fail CI. Single-host rows were not measured on Windows. Gameplay includes the small reference scene and the slowest Linux relay stage.

| Workload | Windows p95 | Linux p95 | Release budget | Over 16.67 ms on Linux |
| --- | ---: | ---: | ---: | --- |
| 250-rect frame | 3.430 | 0.977 | 5.2 ms | no |
| 1,000-rect frame | 6.247 | 2.087 | 9.4 ms | no |
| 250-rect deserialize | 3.934 | 1.487 | 6.0 ms |  |
| 1,000-rect deserialize | 11.818 | 3.481 | 17.8 ms |  |
| Signal Garden frame | 1.120 | 0.979 | 1.7 ms | no |
| Relay frame | 0.218 ceiling | 0.273 max | 0.5 ms | no |
| 500 instances, geometry | 3.559 | 4.441 | 6.7 ms | no |
| 100 animated meshes, frame | 1.239 | 2.581 | 3.9 ms | no |
| 100 gameplay steps | 3.651 | 4.401 relay max | 6.7 ms |  |
| 3,000 skinned vertices | 7.074 | 4.919 | 10.7 ms |  |
| 1024 raster encode | 6.889 | 4.766 | 10.4 ms |  |
| 1024 raster decode | 3.267 | 3.811 | 5.8 ms |  |
| Disk asset reload | 1.399 | 1.034 | 2.1 ms |  |
| Noisy 2048 encode |  | 464.389 | 696.6 ms |  |
| Noisy 2048 decode |  | 27.667 | 41.6 ms |  |
| Textured rasters, frame |  | 516.552 | 774.9 ms | yes |
| 80 textured billboards, frame |  | 0.358 | 0.6 ms | no |

Every delivered scene workload stays inside 16.67 ms on both hosts. The new over-goal cost is CPU work on large raster payloads: encoding a noisy 2048 surface, and building a render model that walks 40 MiB of encoded pixels. Billboards that only carry texture ids cost 0.358 ms, so the texture reference itself is not the frame cost. These samples do not justify a renderer rewrite or a Rust migration. A second physical GPU host is still required before any of these budgets become a CI gate.

GPU submission is not part of the CPU budgets above. Plain `npm run benchmark:gpu` on this host reports WebGL 1 unavailable and does not invent a zero time. Rerunning with `electron --ignore-gpu-blocklist --enable-unsafe-swiftshader` used ANGLE llvmpipe (Mesa, LLVM 20.1.2), Electron 43.2.0 / Chromium 150, 1280×800. Timer queries were available and no sample was disjoint. This is a software renderer, not a hardware GPU, and it is not folded into the release budgets. Hardware GPU budgets stay single-host, 1.5× the Iris Xe p95: Signal Garden 3.2 ms, relay 3.5 ms, 100 meshes 2.8 ms.

| Workload | Iris Xe GPU p95 | llvmpipe CPU submission p95 | llvmpipe GPU p95 | Samples |
| --- | ---: | ---: | ---: | ---: |
| Signal Garden | 2.076 | 4.9 | 20.442 | 20 |
| Relay stages | 1.536–2.312 | 2.1–2.6 | 2.424–4.144 | 20 |
| 100 animated meshes | 1.851 | 3.4 | 14.499 | 20 |
| Textured rasters |  | 1.4 | 10.93 | 8 |
| 80 textured billboards |  | 24.9 | 33.707 | 10 |

Cached raster draws are cheaper on this software GL than building the 40 MiB frame (516.552 ms CPU). The 80 billboards, which upload and sample real textures, are the slow software-GL case. Neither result is a hardware certification, and neither selects a new backend. That llvmpipe table stays prose. Relay was published as a range, so the run was not copied into a host-sample file and was not given a single invented relay p95.

**Adding a host sample.** Frozen CPU budgets stay the two hosts above. Frozen GPU budgets stay the Iris Xe p95 only: Signal Garden 3.2 ms, relay 3.5 ms, 100 meshes 2.8 ms. A file in `scripts/benchmark-host-samples/` is a later observation. It does not change those numbers, and `CI_GATE_ENABLED` stays false. `npm run ci` does not run these benchmarks.

On the machine to record:

1. Run `npm run benchmark:authoring` and save the JSON. That is a CPU sample (`rendererKind: "cpu"`), not a GPU certification.
2. Run `npm run benchmark:gpu` and save the JSON. Leave SwiftShader, llvmpipe, and `--enable-unsafe-swiftshader` off when the sample is meant to be hardware. A missing WebGL context is reported as unavailable and has no timings.
3. Store each report under a new id of lowercase letters, digits, dots, and hyphens. Reusing an id with the same body is a no-op. A different body is refused. Do not reuse a frozen cohort id.

```
node scripts/record-benchmark-sample.js authoring.json --id <host>-cpu --recorded YYYY-MM-DD --out scripts/benchmark-host-samples/<host>-cpu.json
node scripts/record-benchmark-sample.js gpu.json --id <host>-gpu --recorded YYYY-MM-DD --out scripts/benchmark-host-samples/<host>-gpu.json
```

The command uses the same software-renderer list as `validate:hardware-gpu`. llvmpipe, SwiftShader, softpipe, lavapipe, virgl, and the Microsoft Basic Render Driver are `software`. An empty or unrecognized renderer is `unknown` or `unavailable`. Those samples are stored with `excludedFromHardwareBudget: true`. `rendererKind: "hardware"` is accepted only when the renderer string itself classifies as hardware. The printed `previewBudgetMs` is the 1.5× figure that would result if a later edit admitted the sample. The command does not write that figure into `RELEASE_BUDGETS_MS` or `GPU_HARDWARE_BUDGETS_MS`. Exit status is 0 when the sample is over budget or software GL. Exit status is 1 when the JSON is invalid, the id is a frozen cohort id, or that id is already stored with different numbers.

Per-stage GPU names such as `relay-1.vde` are kept on `stageP95Ms`. The sample's `relay` value is the maximum of those stage GPU p95s, the same ceiling rule as the Iris Xe relay budget. CPU submission stays on `cpuSubmissionP95Ms` and is not compared with the GPU budgets.

Admitting a CPU sample means editing `FROZEN_CPU_HOSTS` and the CPU table in this section. Admitting a physical GPU sample follows the preview below. One added hardware GPU host still does not justify a CI gate or a renderer rewrite.

**Admitting a physical GPU sample.** A file under `scripts/benchmark-host-samples/` remains an observation. `node scripts/preview-hardware-admission.js` prints the source edit that would append one GPU sample and does not perform it. `CI_GATE_ENABLED` stays false.

1. Store the GPU report with the command above. On a physical GPU, leave SwiftShader, llvmpipe, and `--enable-unsafe-swiftshader` off.
2. Preview that file, or list the directory:

```
node scripts/preview-hardware-admission.js scripts/benchmark-host-samples/<host>-gpu.json
node scripts/preview-hardware-admission.js --summary
```

3. `readyForOperatorAttestation` is true only when the renderer string classifies as hardware and `pixel-workshop`, `relay`, and `animated-meshes-100` each have one finite p95. `relay` is the stored maximum stage p95. `proposedBudgetsMs` is the 1.5× preview for those three. Workloads outside them stay in `recordedOnly` and are observations, not new hardware budgets. `cohortEntry` stays empty until step 5.
4. CPU samples, unavailable WebGL, unrecognized renderers, and software GL stay blocked. The software list is the same one `validate:hardware-gpu` uses: llvmpipe, SwiftShader, softpipe, lavapipe, virgl, and the Microsoft Basic Render Driver. `--physical-gpu` does not reclassify them. Exit status is 0 for an ineligible sample, including software GL, so this command is not a CI failure. `npm run ci` does not run it. Exit status is 1 for invalid JSON, an unknown flag, or `--summary` combined with a sample.
5. A sample file cannot set `physicalGpu` or `admitsToHardwareBudget`. Pass `--physical-gpu` only when you know the machine is a physical GPU. The renderer string is not that attestation.
6. When `eligible` is true, append the printed `cohortEntry` to `FROZEN_GPU_HOSTS` and append each measured p95 to the matching array in `GPU_IRIS_XE_P95_MS`. `proposedBudgetsMs` is the 1.5× figure that edit would freeze. Update the GPU table in this section from those figures. Leave `CI_GATE_ENABLED` false. One added physical GPU host still does not justify a CI gate or a renderer rewrite.

The stored 2026-09-28 cloud samples are ineligible. `--summary` reports `readyForOperatorAttestation` 0 for that directory.

**Cloud VM, 2026-09-28.** This environment is Linux x64, 4 vCPU Intel Xeon, 16014 MiB. It is not a physical GPU host. `benchmark:authoring` under Node 22.14.0 with `--expose-gc` is stored as `linux-x64-xeon-cloud-2026-09-28-cpu`. That file is a later measurement, not a second copy of the frozen Xeon cohort, and the frozen CPU table above was not edited. Rows over the frozen CPU budget were 100 animated meshes 17.282 ms (budget 3.9), 100 gameplay steps 7.427 ms (6.7), Signal Garden frame 1.739 ms (1.7), 1024 raster decode 7.897 ms (5.8), and 80 textured billboards 1.133 ms (0.6). The other CPU rows were inside the frozen budget.

Plain `benchmark:gpu` on Electron 43.2.0 / Chromium 150 (that process reports Node 24.18.0) found WebGL1 blocklisted. `linux-x64-xeon-cloud-2026-09-28-gpu-unavailable` has an empty timing map. Rerunning with `--ignore-gpu-blocklist --enable-unsafe-swiftshader` produced `ANGLE (Mesa, llvmpipe (LLVM 20.1.2 256 bits), OpenGL 4.5)`, stored as `linux-x64-xeon-cloud-2026-09-28-llvmpipe` with `rendererKind: "software"`. GPU p95 was Signal Garden 17.535 ms, relay ceiling 5.247 ms (stages 3.459 / 2.226 / 5.247), 100 meshes 11.341 ms, textured rasters 10.462 ms, and 80 billboards 30.429 ms. CPU submission for the 100 meshes was 267.1 ms. The mesh and billboard GPU p95s each omit one invalid timer sample. None of these figures were admitted. Hardware GPU budgets remain Signal Garden 3.2 ms, relay 3.5 ms, and 100 meshes 2.8 ms. `preview-hardware-admission.js --summary` reports these three files ineligible for a physical-GPU admission. This run does not add a physical GPU host, a CI gate, or a reason to rewrite the renderer.

## Initial local budgets

Informational targets: 16.67 ms geometry/display-list frame CPU, 100 ms deserialize, 128 MiB retained heap delta for 50 history edits. They are provisional, not release guarantees. Representative Windows x64 / Node 24.15.0 measurements from this implementation pass:

| Owned workload | Deserialize P95 | Frame-build P95 | Approximate history heap delta |
| --- | ---: | ---: | ---: |
| 250 rectangles (91.8 KiB) | 3.934 ms | 3.430 ms | 4.32 MiB |
| 1,000 rectangles (368.1 KiB) | 11.818 ms | 6.247 ms | 12.13 MiB |

100 gameplay steps: 3.651 ms P95. Sampling 3,000 CPU-skinned vertices: 7.074 ms P95. These exclude GPU presentation; the history delta includes other retained process allocations. Repeat under comparable idle conditions before treating changes as regressions.

## Implementation references

Behavior was checked against [Electron close handling](https://www.electronjs.org/docs/latest/api/browser-window), [dialogs](https://www.electronjs.org/docs/latest/api/dialog), [Node filesystem operations](https://nodejs.org/api/fs.html), the [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html), [Canvas PNG encoding](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL), [Web Audio decoding](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData), and [esbuild build contexts](https://esbuild.github.io/api/#build). Local tests and real Electron smokes are the evidence for this application's integration behavior.
