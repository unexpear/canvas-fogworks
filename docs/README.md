# Visual Design Engine — Core Documentation

<!-- describes: src/core/document/Document.ts, src/core/tests -->

> **Frozen contracts · schema v3 (app v0.0.5) · current through Milestone 2 (auto-layout core).**
> These documents describe the *current, verified* implementation and lock the
> contracts the rest of the engine builds on. See [`../MILESTONES.md`](../MILESTONES.md)
> for the roadmap and where each layer fits.

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

| Doc | Covers | Status |
|-----|--------|--------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layered design, data flow, module map, the 5 invariants | 🔒 |
| [DOCUMENT-SCHEMA.md](DOCUMENT-SCHEMA.md) | `ProjectDocument`, `Node`, geometry/style/layout, variables, serialization envelope, versioning | 🔒 |
| [ACTION-SYSTEM.md](ACTION-SYSTEM.md) | Action contract, dispatch lifecycle, delta protocol, history/undo-redo, transactions | 🔒 |
| [API-CONTRACTS.md](API-CONTRACTS.md) | Public interfaces of every core module | 🔒 |
| [TESTING.md](TESTING.md) | Strategy, how to run, coverage, regression discipline | 🔒 |
| [CODING-STANDARDS.md](CODING-STANDARDS.md) | Invariants, conventions, review checklist | 🔒 |

## Quick facts

- **Stack:** TypeScript (strict) · React 19 · Electron 43 · esbuild · Jest (ts-jest).
- **Engine version:** `CURRENT_VERSION = "0.0.5"` (`src/core/document/Document.ts`).
- **Verify everything:** `npm run check` (typecheck app + tests + build).
- **Tests:** 142, in `src/core/tests/document.test.ts`.

## Source map

```
src/
  core/
    document/   ProjectDocument, Node, Serializer,     (the source of truth)
                Integrity, SceneGraph
    actions/    Action + commands, Dispatcher,         (the only write path)
                HistoryManager, applyMutations, types
    geometry/   Matrix, GeometryEngine (M1),           (intent -> computed results)
                LayoutEngine (M2 auto-layout)
    ids/        UUID
    tests/      document.test.ts, apiSurface.ts (compile-time API pin)
  editor/       EditorState + tools/ (Select/Move/Rectangle, ToolController)
  renderer/     SVGRenderer                            (read-only)
  app/          App.tsx + React bootstrap
  electron/     main.js (main process), preload.js (contextBridge)
scripts/build.js   three esbuild builds -> dist/{app,electron}
scripts/{check-module-headers,check-doc-drift}.js   lint + doc-staleness tripwire
```
