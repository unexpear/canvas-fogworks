# Production workflow programme

Requested scope: all five priorities from the September 5 project review. Both visual/pixel authoring and game authoring remain first-class tracks. Local ignored example assets are not distribution fixtures.

Gameplay follow-up (2026-09-12, schema 79): named input actions, interact rules, bounded
template spawning/despawning, checkpoint respawn and versioned current-level player progress
are now implemented for 2D/3D. See [Gameplay foundations](GAMEPLAY-FOUNDATIONS.md) for exact
semantics and verification. The schema 78 baseline below is historical; general scripting,
full prefabs, cross-level persistent state and complete 3D audio remain open.

## Delivered baseline (schema 78, app 0.0.5)

All five tracks have implementation; this is a bounded production baseline, not completion of every future engine capability. Historical M18 slice counts are unchanged. The remaining work below is tracked in `BACKLOG.json`.

1. **Project safety.** `ProjectSession` unifies toolbar/menu Save and Save As. A path/savepoint advances only after a successful host write; failed or overlapping saves are visible, and edits made during a save stay dirty. New/Open/close have unsaved-edit protection. Native recovery snapshots are written every five seconds and offered at startup. Recovery does not replace explicit Save and can lose edits since the last successful checkpoint. Cross-folder Save As copies a bounded linked-level graph, relative images, glTF/GLB/HDR sources and glTF buffers/images, with confinement and conflict refusal. Native Open embeds confined relative images, including states, overrides and tilesets. It never copies unreferenced packs. Five forced writer-process exits now test editing, partial writes, flush, pre-rename and post-rename recovery. Browser restore and full desktop crash/relaunch automation remain open; see the exact bounds below.

2. **Shared authoring.** Aseprite imports preserve the existing timeline, clips and controllers. Incoming timings are converted to the document FPS only when all boundaries land exactly on frames; incompatible timing fails before mutation. Clip-name collisions receive unique names and imports cannot shorten the timeline. The export drawer now offers whole-canvas PNG with decoded images/fonts, transparent or authored background, content framing and no grid/selection overlays. PNG is limited to 16 megapixels / 16,384 pixels per side and rejects native 3D capture. Chromium smoke checks actual unlit and lit pixels.

3. **Gameplay and export.** Runtime Entity inspector rules support start/enter/leave/contact/separate events, any/player conditions, self/other targets, win/lose/despawn/velocity/score and embedded sound actions. Choose Authored rules on the player to disable the compatibility platformer rules. `stepGameplay` is shared by editor and player; commands modify transient world state, not document history. Level playback has its own document/path and stages destination meshes, material textures and HDR environments before publication. Failure preserves the previous runtime; Stop/Restart and superseding transitions invalidate late reads. Authoring caches, Save target and history remain separate. The export drawer can write a standalone offline **2D** `game.html`, including a bounded linked-level graph, embedded images/sounds, camera, controls and restart/respawn. That 2D exporter refuses external images, unsupported runtime geometry and native 3D. A separate [standalone 3D export](STANDALONE-PLAYER.md) now supplies bounded HTML packaging and an unsigned Windows player; full 3D game-rule/audio coverage and clean-machine acceptance remain open. Custom fonts and broader script/condition bindings remain open. Web Audio supports 32 voices and 32 cached cues, with a 32 MiB decoded limit per cue; this is not a streaming/mixing system or a total-byte-budgeted cache.

4. **Native 3D.** glTF import retains TRS tracks and four-influence skin data. The 3D inspector selects a clip, loop/speed and optional second clip/pose-blend weight; Run or timeline scrubbing samples it. STEP, LINEAR (including quaternion slerp) and CUBICSPLINE are tested. CPU skinning is limited to 100,000 vertices, 128 joints per skin, one buffer and four million imported scalar values. These are safety limits, not a 60 FPS guarantee. Invalid/singular sampled poses report a diagnostic and fall back to the imported pose. Rotated box SAT and sphere contacts replace AABB-only overlap queries. Setting gravity/restitution opts a dynamic entity into bounded substeps and static-contact resolution; absent settings retain legacy movement. Skins of at most 16 joints deform on the GPU; larger skins, morph application and the reference formula stay on the CPU. Automatic crossfades and morph weights are sampled with the clip. Dynamic-pair impulses, angular dynamics and a production character controller remain open.

5. **Owned examples and measurements.** The small original visual/game/animated-triangle examples remain unchanged. `reference-projects/authoring-v1/` adds Signal Garden (editable pixel atlas, palette, master and 15 component instances) and Signal Relay (three 68-node stages, 24 collectibles, upper routes and gates). `npm run examples:create -- <new-folder>` regenerates portable copies and refuses existing folders. CPU benchmarks now include these exact projects, 1024-square raster encoding/decoding, 500 instances, 100 animated mesh draws and isolated disk reload. `benchmark:gpu` measures production WebGL CPU submission and asynchronous GPU queries when available. Chromium completes the three-level offline game and exports the workshop PNG. Hardware-specific release budgets still need calibration.

## Commands and evidence

- `npm run ci`: typecheck, module headers, doc drift, header-claim inventory, mutation-target preflight, complete Jest suite, real writer-process crash tests, build, startup/file/lighting/3D/level-transition/authoring Electron smokes.
- `npm run smoke:package`: build the Windows NSIS package and launch the unpacked executable for startup and Open/Edit/Save tests. It does not silently install the application on the user's machine.
- `npm run benchmark:authoring`: informational local measurements; intentionally no hardware-dependent CI failure threshold.
- Focused regression suites: `ProjectSession`, `ProjectFileWorkflow`, `projectDependencies`, `asepriteImport`, `CanvasExport`, `GameplayPanel`, `GameplaySession`, `GameExport`, `LevelTransitionWorkflow`, `GltfMotion`, `Collision3D` and `ThreeDInspector`.
- `smoke:authoring` uses actual Chromium PNG decoding/pixel inspection, silent generated WAV decode/play/stop, and an offline game reaching victory. This is not an audible listening test.
- Mutation preflight checks all 402 targets still match; it is not equivalent to executing and killing all mutants.

## Shared-authoring follow-up — 2026-09-07

Portability is limited to 32 levels, 4096 dependency files, 64 MiB per dependency and 256 MiB per copy batch; linked project files retain the runtime's 20 MB limit. Nested level paths obey the same per-level directory confinement as playback. Return links from sibling levels are rewritten to the new entry filename. A self-linked entry must keep its filename during cross-folder Save As; the operation refuses a rename rather than writing stale references. External URLs and absolute paths are not downloaded/copied. Custom fonts are not packaged. Existing conflicting assets are never overwritten; an I/O failure can leave newly created dependency files/directories, but the entry project is committed only after copying succeeds. Dependency-directory rollback and power-loss filesystem durability are not claimed.

Relative image embedding observes the schema's 4,000,000-character image limit, a 32 MiB unique-image batch and a 64 MiB expanded-project limit. Images remain embedded in subsequent saves; source image files are unchanged. Network images retain their existing Open behavior but are refused by cross-folder portability.

Verification follow-up: entry-level comparisons now use the confined filesystem-resolved path, so differently capitalized Windows return links cannot copy an older entry from disk. Exclusive dependency writes accept an existing alias only when its bytes match; differing contents are still refused. Distinct logical placements (including internal junction paths) remain intact. Windows destination entry names are conservatively reserved case-insensitively, even in a case-sensitive directory, to prevent a dependency occupying the project filename. Regression tests cover these cases and a conflicting file appearing after preflight; the Electron level smoke includes case-aliased return links and shared image/texture references. This follows [Node realpath behavior](https://nodejs.org/api/fs.html#fsrealpathsyncnativepath-options) while respecting [Windows per-directory case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity).

`test:recovery` kills a real isolated Node writer using the production `ProjectSession` and `atomicWrite`, then deserializes and restores in another process. Before rename, the previous save survives byte-for-byte; after rename, the complete new save survives. The latest completed recovery checkpoint survives all five cases. This verifies process failure, not unplugging the drive, OS failure or the desktop recovery confirmation dialog.

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

A separate offline [installer lifecycle harness](INSTALLER-TESTING.md) passed the complete per-user sequence on 2026-09-07: fresh install, installed startup/Open–Edit–Save, uninstall, synthetic 0.0.4-to-0.0.5 upgrade, upgraded startup/Open–Edit–Save and final uninstall. Installed archive hashes matched; owned project and recovery bytes survived. Earlier Sandbox desktop crashes were isolated to virtual-GPU mode, so this test configuration explicitly uses software rendering. A Windows PowerShell exit-code reporting issue in the harness was reproduced and corrected before the passing run. This is not historical-project compatibility or hardware-GPU certification. Broader release coverage remains open in `RELEASE-001`; signing and personal publisher identification are not required under the user's current distribution preference.

## Initial local budgets

Informational targets: 16.67 ms geometry/display-list frame CPU, 100 ms deserialize, 128 MiB retained heap delta for 50 history edits. They are provisional, not release guarantees. Representative Windows x64 / Node 24.15.0 measurements from this implementation pass:

| Owned workload | Deserialize P95 | Frame-build P95 | Approximate history heap delta |
| --- | ---: | ---: | ---: |
| 250 rectangles (91.8 KiB) | 3.934 ms | 3.430 ms | 4.32 MiB |
| 1,000 rectangles (368.1 KiB) | 11.818 ms | 6.247 ms | 12.13 MiB |

100 gameplay steps: 3.651 ms P95. Sampling 3,000 CPU-skinned vertices: 7.074 ms P95. These exclude GPU presentation; the history delta includes other retained process allocations. Repeat under comparable idle conditions before treating changes as regressions.

## Implementation references

Behavior was checked against [Electron close handling](https://www.electronjs.org/docs/latest/api/browser-window), [dialogs](https://www.electronjs.org/docs/latest/api/dialog), [Node filesystem operations](https://nodejs.org/api/fs.html), the [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html), [Canvas PNG encoding](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL), [Web Audio decoding](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData), and [esbuild build contexts](https://esbuild.github.io/api/#build). Local tests and real Electron smokes are the evidence for this application's integration behavior.
