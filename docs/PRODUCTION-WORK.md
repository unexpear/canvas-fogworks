# Production workflow programme

Requested scope: all five priorities from the September 5 project review. Both visual/pixel authoring and game authoring remain first-class tracks. Local ignored example assets are not distribution fixtures.

## Delivered baseline (schema 78, app 0.0.5)

All five tracks have implementation; this is a bounded production baseline, not completion of every future engine capability. Historical M18 slice counts are unchanged. The remaining work below is tracked in `BACKLOG.json`.

1. **Project safety.** `ProjectSession` unifies toolbar/menu Save and Save As. A path/savepoint advances only after a successful host write; failed or overlapping saves are visible, and edits made during a save stay dirty. New/Open/close have unsaved-edit protection. Native recovery snapshots are written every five seconds and offered at startup. Recovery does not replace explicit Save and can lose edits since the last successful checkpoint. Cross-folder Save As copies only referenced glTF/GLB/HDR files and glTF buffers/images, with confinement, bounded discovery and conflict refusal. It never copies entire reference packs. Linked-level graphs and arbitrary external 2D resources are not relocated yet; preserve their folder layout manually. Process-crash fault injection and browser recovery restore remain open.

2. **Shared authoring.** Aseprite imports preserve the existing timeline, clips and controllers. Incoming timings are converted to the document FPS only when all boundaries land exactly on frames; incompatible timing fails before mutation. Clip-name collisions receive unique names and imports cannot shorten the timeline. The export drawer now offers whole-canvas PNG with decoded images/fonts, transparent or authored background, content framing and no grid/selection overlays. PNG is limited to 16 megapixels / 16,384 pixels per side and rejects native 3D capture. Chromium smoke checks actual unlit and lit pixels.

3. **Gameplay and export.** Runtime Entity inspector rules support start/enter/leave/contact/separate events, any/player conditions, self/other targets, win/lose/despawn/velocity/score and embedded sound actions. Choose Authored rules on the player to disable the compatibility platformer rules. `stepGameplay` is shared by editor and player; commands modify transient world state, not document history. Level playback has its own document/path and discards late reads after Stop/Restart; Stop preserves the authored document and Save target. The export drawer can write a standalone offline **2D** `game.html`, including a bounded linked-level graph, embedded images/sounds, camera, controls and restart/respawn. External images, unsupported runtime geometry and native 3D export fail explicitly. Custom fonts, native 3D asset hydration across runtime level transitions and broader script/condition bindings remain open. Web Audio supports 32 voices and 32 cached cues, with a 32 MiB decoded limit per cue; this is not a streaming/mixing system or a total-byte-budgeted cache.

4. **Native 3D.** glTF import retains TRS tracks and four-influence skin data. The 3D inspector selects a clip, loop/speed and optional second clip/pose-blend weight; Run or timeline scrubbing samples it. STEP, LINEAR (including quaternion slerp) and CUBICSPLINE are tested. CPU skinning is limited to 100,000 vertices, 128 joints per skin, one buffer and four million imported scalar values. These are safety limits, not a 60 FPS guarantee. Invalid/singular sampled poses report a diagnostic and fall back to the imported pose. Rotated box SAT and sphere contacts replace AABB-only overlap queries. Setting gravity/restitution opts a dynamic entity into bounded substeps and static-contact resolution; absent settings retain legacy movement. GPU skinning, morph targets, automatic crossfades, dynamic-pair impulses, angular dynamics and a production character controller remain open.

5. **Owned examples and measurements.** `reference-projects/visual.vde`, `game.vde` and `animated-3d.vde` are original geometric examples; the animated triangle's glTF and binary are also original. Open them normally; choose the 3D workspace for the animated example. `npm run examples:create -- <new-folder>` regenerates portable copies and refuses to overwrite an existing folder. `benchmark:authoring` measures loading, geometry/display-list frames, undo-memory deltas, gameplay and 3,000-vertex CPU skinning. Electron smokes exercise asset reload and both unpackaged and packaged project workflows. GPU frame timing, raster/component scale cases and isolated asset-reload budgets still need dedicated measurement.

## Commands and evidence

- `npm run ci`: typecheck, module headers, doc drift, header-claim inventory, mutation-target preflight, complete Jest suite, build, startup/file/lighting/3D/authoring Electron smokes.
- `npm run smoke:package`: build the Windows NSIS package and launch the unpacked executable for startup and Open/Edit/Save tests. It does not silently install the application on the user's machine.
- `npm run benchmark:authoring`: informational local measurements; intentionally no hardware-dependent CI failure threshold.
- Focused regression suites: `ProjectSession`, `ProjectFileWorkflow`, `projectDependencies`, `asepriteImport`, `CanvasExport`, `GameplayPanel`, `GameplaySession`, `GameExport`, `LevelTransitionWorkflow`, `GltfMotion`, `Collision3D` and `ThreeDInspector`.
- `smoke:authoring` uses actual Chromium PNG decoding/pixel inspection, silent generated WAV decode/play/stop, and an offline game reaching victory. This is not an audible listening test.
- Mutation preflight checks all 402 targets still match; it is not equivalent to executing and killing all mutants.

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
