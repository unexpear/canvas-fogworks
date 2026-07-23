# Coding Standards

> 🔒 Frozen for Milestone 0 · v0.0.5. Conventions + the hard rules that protect the invariants.

## Hard rules (never violate)

1. **The Dispatcher is the only write path.** Never mutate a `ProjectDocument` or a
   `Node` outside an `Action` → `applyMutationsToDocument`. No component, tool, effect, or
   AI/plugin code writes the document directly. **The compiler enforces this**:
   `getDocument()` hands back a `ReadonlyDocument`. If you find yourself wanting to cast
   it away, you want an Action instead — the only legitimate casts are the serialization
   boundary in `serializeDocument` (which copies out to the wire shape).
2. **Actions are declarative.** `execute()` returns deltas; it must not mutate the document.
3. **Never alias a history snapshot.** Any document obtained from history/serialization
   must be deep-cloned before it becomes live state (`hydrateDocument` guarantees this).
   Do not hand a snapshot's inner objects to the live document.
4. **`EditorState` is never serialized** into the document, and document state never leaks
   into `EditorState`.
5. **Validate at the boundary.** Every `Action.validate()` rejects non-finite numbers and
   out-of-range values; `execute()` re-checks and throws on invalid state.
6. **The renderer is read-only.** `renderSVG` takes `(doc, state)` and returns nothing; it
   holds no dispatcher reference.
7. **Drag previews use the override channel**, not the document. Move/resize preview via
   `EditorState.pendingGeometry` (patches fed INTO `computeWorldGeometry`, and `previewRect` for draw); commit one Action on mouse-up.

## Type & style

- **TypeScript strict** is on. No `any` in public signatures; localize unavoidable `any`
  (e.g. JSON boundaries) and cast narrowly.
- Prefer explicit interfaces for all cross-module data. Distinguish runtime vs. wire types
  when they differ (`DocumentMetadata` vs `SerializedMetadata`).
- Every module starts with a `@module` / `@description` JSDoc header stating its single
  responsibility.
- Name Actions `<Verb>NodeAction`; keep one Action per file.
- Keep functions single-purpose; extract shared logic to one home (e.g. the single
  `applyMutationsToDocument`) rather than duplicating.

## Determinism

- No `Date.now()`/`Math.random()` in pure core logic paths that feed comparisons or
  snapshots beyond the existing revision id/timestamp fields; identity comes from `UUID.ts`.
- Serialization must be stable and reversible; wire `Date` as ISO strings, rebuild on load.

## Error handling

- The dispatcher returns `{ success: false }` instead of throwing; callers check the result.
- Listener callbacks are isolated (try/catch) so one subscriber can't break dispatch.
- Never swallow errors silently: distinguish "absent" from "corrupt" (see
  `Serializer.loadResult`) and log with context.

## Numbers & geometry

- `width`/`height` are strictly `> 0`; `opacity ∈ [0,1]`; `radius ≥ 0`.
- Clamp the viewport (`clampViewport`: zoom `[0.05, 20]`; pan `±10000` **world** units,
  scaled by zoom so content stays reachable); guard against
  divide-by-zero on `zoom` (`Math.max(0.01, zoom)`).
- Guard rendering against non-finite geometry before emitting SVG attributes.

## The freeze rule (drift control)

A change to any 🔒-frozen contract ships **together** with **(1)** the matching `/docs`
update and **(2)** a test for the new behaviour. Contracts are not edited silently.

If the change alters the **persisted document shape _or the interpretation of any
persisted field_** — and only then — also bump `SCHEMA_VERSION` and add the matching
`migrateIfNeeded` step. The test is compatibility, not shape: *would the previous
build read a document written by this one differently?* Never bump
`SCHEMA_VERSION` for a non-schema change: it is the load gate, and a bump without a
migration makes every saved document unreadable. The app version (`CURRENT_VERSION`,
injected from `package.json`) is display-only and moves independently.

## Review checklist

- [ ] Does this change the document only through an Action + the dispatcher?
- [ ] Does any `execute()` mutate the document? (must not)
- [ ] Could any live object alias a history snapshot?
- [ ] Are new numeric inputs validated for finiteness/range?
- [ ] Is `EditorState`/UI state kept out of the document (and vice-versa)?
- [ ] If a frozen contract changed: doc updated + test added?
- [ ] If **and only if** the persisted shape *or interpretation* changed: `SCHEMA_VERSION`
      bumped **and** a `migrateIfNeeded` step added in the same change?
- [ ] Confirm `SCHEMA_VERSION` was **not** touched for a renderer/editor/API-only change
      (a bump without a migration makes every saved document unreadable).
- [ ] `npm run check` green (typecheck app + tests + build)?
