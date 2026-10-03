# Standalone 3D export and Windows player

<!-- describes: src/electron/GamePackageExport.ts, src/player3d, src/runtime/PackageProfile.ts, src/app/ElectronAPI.ts, scripts/package-game.js, scripts/smoke-player.js, scripts/smoke-player-acceptance.js, scripts/smoke-player-startup.js, package.json -->
<!-- re-read 2026-10-02: package.json records test:progress-crash. The desktop slot may read package-declared predecessor hashes. -->
<!-- re-read 2026-09-28: package.json also records authoring benchmarks and smoke:crash-relaunch.
     readRecovery can decline or preserve a snapshot. 3D export packages custom fonts, diagnostics and unsigned provenance. -->

Implemented 2026-09-12 as bounded Q03–Q05 work in the [engine roadmap](ENGINE-ROADMAP.md).
This delivers a real offline host for the existing 3D runtime, not Unreal-level feature parity
or a completed F1 clean-machine release gate. The initial slice retained schema 78; the subsequent
[gameplay foundations](GAMEPLAY-FOUNDATIONS.md) use schema 79. App version remains 0.0.5.

## Export from the editor

Save the project, open the export drawer, and choose **Export offline 3D game (HTML)…**.
Choose a folder without an existing `game-3d.html`. The exporter refuses an existing file;
it does not replace an earlier export. Open the resulting HTML in a modern Chromium browser.
No editor, local server or source asset folder is needed to play that artifact.

The entry uses the current editor document, including unsaved edits. Linked levels use their
saved files. Cyclic return links resolve to the current entry, not an older disk snapshot.
The existing 2D HTML, SVG, PNG and Tiled exports are separate and unchanged.

Only declared 3D asset records, glTF/GLB buffer/image dependencies, HDR environments, ordinary
scene images and reachable typed level links are collected. Unreferenced folders are not scanned.
Local ordinary images are embedded as PNG/JPEG/WebP/GIF; external URLs and unsupported formats
fail. Source reads are bounded and confined to each level's directory, including real-path
junction checks. Case aliases that refer to different files are refused rather than merged.
Concurrent edits/replacement of source folders are not a supported export workflow.

The exporter applies the [v1 package limits](GAME-PACKAGE.md#limits) and validates the complete
manifest with the independent reader before writing. Source files are never modified.
The native HTML write uses exclusive creation; a disk/write failure can leave an incomplete new
export, which should not be distributed. No existing file is overwritten. Validation currently
runs synchronously in bounded portions; background-worker validation remains future performance work.

## Build a standalone Windows executable

From the repository, using a **new**, nonexistent output directory whose parent exists:

```powershell
npm run package:game -- "reference-projects/animated-3d.vde" "D:\game-builds\owned-demo" --desktop --fonts "D:\game-builds\fonts"
```

`--fonts` is a directory of `.ttf`/`.otf` files, not a recursive asset scan. Only faces whose family
is used by a packaged level are embedded. The editor export uses faces registered in that session
instead of a directory. This command reads the saved entry from disk; save current editor changes first. Without
`--desktop`, it generates HTML, the manifest, provenance and the desktop host staging app without bundling
Electron. It does not rebuild or replace the editor installer. Output:

| Path inside the new output directory | Purpose |
|---|---|
| `game.cfgame.json` | Validated inline package for inspection/future hosts |
| `game.provenance.json` | Unsigned hashes, packaged faces and profile warnings; not a signature |
| `app/game.html` | Self-contained browser player, embedded package and the same provenance |
| `app/main.cjs`, `app/progressPreload.js`, `app/package.json` | Dedicated Electron host and bounded progress bridge |
| `desktop/win-unpacked/Canvas Fogworks Game.exe` | Windows x64 player when `--desktop` is supplied |

Distribute the **entire `win-unpacked` directory**, not the EXE alone. It contains Electron's
runtime libraries, resources and license notices. This is an unpacked app, not a single-file
portable executable or installer. No Node installation is needed on the player's computer.
The build uses the repository's installed Electron version and never publishes artifacts.
Build failures can leave a partial new output directory; choose another new directory on retry.

Distribution remains unsigned and does not identify a personal publisher. Missing-author/default
icon warnings are expected. Windows reputation warnings can still occur. No certificate, signing
service or publisher identity was added. Only original repository fixtures were used in verification.

## Controls and lifecycle

- WASD/arrows move on X/Z; Q/E move down/up. Shift increases speed from 4 to 7.
  Controls opens the named-input panel; changed keys are stored for this origin and cleared on
  focus loss. These are the current bounded runtime controls, not a full character controller or jump system.
- Restart reloads the entry. Stop releases the session/GPU resources; Start creates a fresh run.
- F interacts with the nearest eligible target. Set checkpoint/Respawn preserve current-level
  runtime mutations; Save progress/Load progress use a versioned, package-bound slot. Restore
  leaves the 3D player paused for Resume. See [save limits](GAMEPLAY-FOUNDATIONS.md).
- Blur or visibility loss clears held keys and pauses. Resume is deliberate; refocusing alone
  does not resume simulation. Hidden-page startup also begins paused.
- Typed level transitions load automatically. A load failure preserves the prior world and frame,
  pauses, and offers an explicit Retry level. It never retries on every animation frame.
- Rendering failure is visible and paused; Restart is the recovery action. Page exit removes
  listeners, cancels scheduling and releases the session and GPU resources.

The host reuses `PlayerSession3D`, shared loaders, the fixed-step solver and WebGL renderer.
It has no React/editor/Action dependency or editor preload. The desktop window enables sandboxing,
context isolation and web security, with Node integration disabled. It denies permissions,
downloads, new windows and navigation. Requests are limited to the game HTML and embedded data/blob
resources; the HTML CSP also denies network connections. Its separate progress preload exposes
only read/write of a bounded main-process-selected save slot, never arbitrary paths or editor IPC.

SHA-256 verification checks the embedded package bytes before starting the player. The expected
digest is in the same HTML: it detects accidental damage, **not authenticity** against an attacker
who can replace both data and digest or replace the player program. The standalone JSON manifest
does not itself carry a digest. `game.provenance.json` repeats that manifest hash, per-file hashes,
the app version and an optional source revision. It is release provenance for inspection, not a
signature or a trusted-update mechanism. Anonymous unsigned distribution is unchanged.

## Verification and remaining gates

`npm run smoke:player` builds an owned two-level export, moves its source directory away, and
loads the actual standalone desktop window. It checks WebGL presentation, keyboard-driven level
transition, blur/pause, restart, Stop/Start, cleared input, absent Node/editor authority, denied
network/window/navigation actions and damaged-payload refusal. It also interacts, spawns, saves
through real IPC, closes/reopens the window, restores progress and refuses a corrupt save while
preserving the active level. It is included in `ci`.
Unit tests cover collection/path/size failures, graph identity and player event/error lifetime;
the browser dependency gate includes the actual standalone entry bundle.

For a generated executable:

```powershell
npm run smoke:player-startup -- "D:\game-builds\owned-demo\desktop\win-unpacked\Canvas Fogworks Game.exe"
```

This launches the actual EXE with an isolated temporary profile and hidden window, verifies its
renderer/WebGL presentation and Stop, then exits. Disposable startup profiles may remain under
the selected temp directory. This is host-machine verification, not clean-machine certification.

Initial standalone verification on 2026-09-12: 2,260 Jest tests across 46 suites; 24 package/profile Node tests;
typecheck, module headers, build and Open–Edit–Save/level/authoring/standalone-player smokes passed.
The unsigned artifact at `release/player-verified-20260912/desktop/win-unpacked/` passed the
actual executable startup smoke. Its ASAR contains only `game.html`, `main.cjs` and `package.json`;
no editor, preload, reference folder or ignored asset pack is included in that earlier artifact. The earlier generated
`release/player-baseline-20260912/` build remains, as do existing editor installers.
The history-based documentation gate still flags uncommitted ENGINE-ROADMAP, GAME-PACKAGE,
PLAYER-RUNTIME and STANDALONE-PLAYER documents plus the pre-existing FEATURE-AUDIT/PLANNED-FIXES
source-history flags. Links, backlog JSON and whitespace checks pass. No commit or push was made.

Gameplay follow-up: 2,287 Jest tests across 48 suites, typecheck, headers, build and
file-workflow/level/authoring/player smokes pass. The new unsigned example at
`release/gameplay-foundation-20260912/desktop/win-unpacked/` passes actual executable startup.
This build adds only `progressPreload.js` to the earlier three-file ASAR allowlist. Existing
artifacts were retained; full process-crash/relaunch save acceptance is not claimed.

Screen-space `core.text` is drawn on a transparent canvas over the WebGL view, using the same
typesetter as the 2D player and any packaged font faces. Text that also has a 3D transform is not
projected as glyphs. Embedded sound rules use the shared Web Audio player. A cue that fires before
the context is running is held until the next click or key, then played once. This is the existing
bounded voice path, not streaming music or mixer buses.

`npm run smoke:player-acceptance` packages an owned scene that uses a custom face and an embedded
sound cue, deletes the source project and font directory, and launches the HTML under an isolated
profile. It checks WebGL presentation, registration of the packaged face, overlay text drawn with
that face, playback of the embedded cue, absent Node/editor authority, and a provenance record that
matches the HTML and contains no host path. It is included in `ci`. The harness asks Electron for SwiftShader so a blocklisted host GPU
still has a context; that is clean-profile acceptance of the unpacked player, not hardware-GPU
certification or a signed Windows image on a separate computer.

A packaged game may declare `saveMigrations`. The desktop progress bridge reads a missing current
slot from those previous hashes only; the renderer still cannot choose a game id or path. Loading
that older slot does not write the new one. `npm run test:progress-crash` is the writer-kill check.

Still open: separate clean Windows-machine certification of the unpacked EXE; prefab campaign snapshots,
portable save files, multiple slots and an editor control for save migrations; long-session/GPU/device-loss evidence;
larger-content streaming; signatures, trusted updates and broader platform support. F1 remains partial.
Asset redistribution and attribution remain the game author's responsibility: an ignored pack
does not become redistributable just because a project references it.

The editor installer lifecycle is separate from this player package. It still omits personal publisher metadata and signing; see [Installer lifecycle testing](INSTALLER-TESTING.md).

Implementation was checked against [Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[request interception](https://www.electronjs.org/docs/latest/api/web-request),
[Node bounded file reads](https://nodejs.org/api/fs.html#filehandlereadbuffer-offset-length-position),
[browser SHA-256](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest) and the installed
electron-builder 26.15.3 API/types. The existing editor installer and historical assets were not removed.
