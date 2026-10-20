# Canvas Fogworks — Core Documentation

<!-- describes: src/core/document/Document.ts, src/core/tests -->
<!-- re-read 2026-10-20: schema 91 adds optional 3D fog, particle emitters and light strings. The frozen-contract summary is otherwise unchanged. -->
<!-- re-read 2026-10-04: schema 90 adds the document save-migration list. The frozen-contract summary is otherwise unchanged. -->
<!-- re-read 2026-09-28: shell source pins in the test suite now also read FoldersDrawer.tsx.
     The frozen contracts summarised here are unchanged.
     api surface pins exact history retention. Schema and milestone claims are unchanged. -->

> **Frozen contracts · schema v91 (app v0.0.5) · current through project recovery, gameplay rules, offline 2D export and native mesh playback.**

Current workflow scope, limits, commands and measured budgets: [Production workflows](PRODUCTION-WORK.md).
Timers, bounded repeats, reusable project graphs, saved continuations and editor debugging:
[Behavior graphs](BEHAVIOR-GRAPHS.md).
Long-term engine ambition, major gaps, phase dependencies and acceptance gates: [Full engine development plan](ENGINE-ROADMAP.md).
> The contract documents below describe the *current, verified* implementation and lock
> the contracts the rest of the engine builds on. The engine development plan is prospective,
> not a claim of delivered features. See [`../MILESTONES.md`](../MILESTONES.md) for historical
> delivery and where each layer fits.

## The freeze rule

A change to any contract marked **🔒 frozen** below must ship **in the same change**
as **(1)** the matching doc update and **(2)** a test covering the new behaviour.

**Additionally, if — and only if — the change alters the persisted document shape
*or the interpretation of any persisted field*:** bump `SCHEMA_VERSION` **and** add
the corresponding step to `migrateIfNeeded`.

> The trigger is **compatibility, not shape**. Ask: *would a document written by the
> previous build be read differently by this one, or vice versa?* If yes, bump — even
> if not a single field was added or removed. A shape-only test misses redefinitions
> (this project changed `geometry.x/y` from world to parent-relative without touching
> the shape at all).

> Do **not** bump `SCHEMA_VERSION` for non-schema changes (renderer, editor, API
> surface). It is the migration gate: bumping it without a migration makes every
> previously saved document fail to load. The app/release version
> (`CURRENT_VERSION`) is separate and may change freely — see
> [DOCUMENT-SCHEMA.md](DOCUMENT-SCHEMA.md) § *Versioning & migration*.

This is the primary defense against architectural drift.

## Documents

For clip browsing, preview and state-driven playback, see [Animation workflow](ANIMATION.md).

| Doc | Covers | Status |
|-----|--------|--------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layered design, data flow, module map, the 5 invariants | 🔒 |
| [DOCUMENT-SCHEMA.md](DOCUMENT-SCHEMA.md) | `ProjectDocument`, `Node`, geometry/style/layout, variables, serialization envelope, versioning | 🔒 |
| [ACTION-SYSTEM.md](ACTION-SYSTEM.md) | Action contract, dispatch lifecycle, delta protocol, history/undo-redo, transactions | 🔒 |
| [API-CONTRACTS.md](API-CONTRACTS.md) | Public interfaces of every core module | 🔒 |
| [TESTING.md](TESTING.md) | Strategy, how to run, coverage, regression discipline | 🔒 |
| [FEATURE-AUDIT.md](FEATURE-AUDIT.md) | What exists, what is built and unreachable, and what is absent — measured against Pixelorama and Tiled | — |
| [CODING-STANDARDS.md](CODING-STANDARDS.md) | Invariants, conventions, review checklist | 🔒 |
| [BACKLOG.json](BACKLOG.json) | Machine-readable open work, priorities, status and evidence links | — |
| [ASSET-INVENTORY.md](ASSET-INVENTORY.md) | Local-only third-party example/test corpus audit and repository policy | — |
| [3D-FOUNDATION.md](3D-FOUNDATION.md) | Boundary and staged plan for extending the 2D foundation into 3D | — |
| [ENGINE-ROADMAP.md](ENGINE-ROADMAP.md) | Full dual-track engine plan: 22 major gap work packages, delivery phases, acceptance gates and decision register | Planned |
| [PLAYER-RUNTIME.md](PLAYER-RUNTIME.md) | Shared level/asset loading and 3D session lifecycle; clean-machine release gate remains open | Partial |
| [GAME-PACKAGE.md](GAME-PACKAGE.md) | Inline v1 manifest, allowlisted resolver and bounded package contract | Partial |
| [STANDALONE-PLAYER.md](STANDALONE-PLAYER.md) | 3D HTML export, fonts, embedded cues, screen-space text, streamed buffer/image/HDR chunks, diagnostics, unsigned provenance, clean-profile acceptance and an EXE evidence checker; a recorded clean-machine pass is still pending | Partial |
| [GAMEPLAY-FOUNDATIONS.md](GAMEPLAY-FOUNDATIONS.md) | Named input, 2D/3D interaction/spawn/checkpoint rules and bounded player progress saves | Partial |
| [BEHAVIOR-GRAPHS.md](BEHAVIOR-GRAPHS.md) | Visual event/branch/action graphs, shared runtime execution, validated links and authoring undo | First slice delivered |

## Quick facts

- **Product direction:** dual-track — visual/pixel editing and game authoring are equal products over one shared engine; 3D extends that engine through the boundary in [3D-FOUNDATION.md](3D-FOUNDATION.md).
- **Stack:** TypeScript (strict) · React 19 · Electron 43 · esbuild · Jest (ts-jest).
- **Engine version:** `CURRENT_VERSION = "0.0.5"` (`src/core/document/Document.ts`).
- **Verify everything:** `npm run check` (typecheck + lint + test + build).
- **Tests:** more than 2,000 across core, runtime, renderer, Electron confinement, project workflows, and import workflows; the test runner reports the exact current count.
- **Verify the tests themselves:** `npm run mutate:dimensions` (402 mutants; 400 killable plus two deliberate controls) — breaks the paint arithmetic
  on purpose in the ways a square fixture cannot see. Not in `check`: it runs the suite per mutant,
  and it refuses a dirty tree. See TESTING.md § Fixture design.

## Source map

```
src/
  core/
    document/   ProjectDocument, Node, Serializer,     (the source of truth)
                Integrity, SceneGraph, Components,
                Timeline (39), Depth (40), Mesh (41), Light (42),
                Bezier (44), Clips (46), Demos (the classic exercises)
    actions/    Action + commands, Dispatcher,         (the only write path)
                HistoryManager, applyMutations, types,
                tileImport / sequenceImport / asepriteImport
                — an import's
                actions, where a test can REACH them: a
                panel's onClick cannot be run at all,
                since `electronAPI` is frozen and the
                native folder dialog cannot be stubbed
    geometry/   Matrix, GeometryEngine (M1),           (intent -> computed results)
                LayoutEngine (M2 auto-layout),
                PathBoolean, Resolve, StrokeOutline,
                Tessellate, ConvexDecompose, CastShadow, RayMarch,
                DashPath
    diagnostics/ MotionTrace (where the ink IS, per frame),
                ActionJournal (what was dispatched, when)
    import/     SheetSlice (a sheet's grid), Sequence
                (numbered frames), Trim (padding, kept in place),
                Aseprite (the file a sheet came from),
                TextureAtlas (the descriptor a packer wrote),
                SvgPath (vector data), SvgDocument (whole
                files), SvgNodes (shapes as nodes),
                FontFile (a face's identity)
    geometry/   ...and NineSlice (a bitmap whose corners keep
                their size — one arithmetic, three backends) +
                Skin (linear blend skinning: posed · rest⁻¹,
                the join Rig and Mesh have been missing)
    document/   ...and Gradient (the fill that changes across
                a shape — a Style.fill value at schema 56) +
                GradientEdit (add/move/recolour a stop; what the
                inspector's ramp control dispatches)
    paint/      PixelBuffer, PixelPatch, Brush, PixelCodec,   (the pixel side of 2D)
                Stroke, Palette, Symmetry, Quantize,
                SurfaceSpace (world point -> surface pixel)
    ids/        UUID
    tests/      document.test.ts, apiSurface.ts (compile-time API pin —
                a module that gains a documented export gains a line
                there in the SAME commit; see TESTING.md)
  editor/       EditorState + tools/ (Select/Move/Shape/Pen/Raster,
                ToolController)
  app/          App.tsx — the shell: workspace tabs (Design/Paint/
                Animate/Map), a 48px tool strip, a fixed-height tool
                options row, Layers + Inspector, status bar. The
                native menu owns File/Edit/View/Developer/Help and
                reaches the renderer through ONE `menu-command`
                channel carrying a command string.
  renderer/     RenderModel (pure display list) + emitSVG /  (read-only)
                emitCanvas / emitWebGL backends + ImageCache/TextRaster +
                renderScene selector (SVG/Canvas/WebGL — all three agree pixel-for-pixel
                on gradients, nine-slice, clipping and blend modes)
  app/          App.tsx + React bootstrap
  app/theme/    Cursors (generated: the tool in your hand, as the
                pointer) + AlignIcons (four bars, so text alignment
                stops borrowing the glyphs that MOVE a node)
  electron/     main.js (main process), preload.js (contextBridge),
                confine.js — the ONE containment rule, in its own
                module because main.js opens a window on require
                and so could only ever be grep-tested
scripts/build.js   three esbuild builds -> dist/{app,electron}
scripts/{check-module-headers,check-doc-drift}.js   lint + doc-staleness tripwire
scripts/menu-command.js   fire a native menu item in the running app (main-process
                          inspector); the only reliable way — an accelerator never
                          reaches the renderer, and CDP key injection needs focus
scripts/mutate-dimensions.js   mutation battery over the paint modules, the Tiled reader, the mesh,
                               nine-slice, the tile grid, the tile brush and the autotiler
                               (count in Quick facts above)
```
