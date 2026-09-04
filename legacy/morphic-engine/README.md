# Morphic / Hold Engine — legacy source snapshot

This directory preserves the first game-engine implementation as design evidence for
Canvas Fogworks' future 3D work. It is a source snapshot, not a second application core and not a
dependency of the TypeScript build.

## Provenance

- Original location: `C:\Users\micha\Desktop\morphic-engine`
- Engine repository: `hold_engine_remote`
- Source revision: `a414cde62fcec4ead3d52172b7441fadf608fb56`
- Branch at capture: `codex/native-hierarchy-surface`
- Captured: 2026-09-02

The original folder and its Git history remain in place. Nested `.git` metadata,
Codex/Claude workspace metadata, and Cargo `target` directories were deliberately not
copied. Generated targets can be recreated and do not belong in Canvas Fogworks' history.

## Boundary

- Nothing under `src/` may import this directory.
- Canvas Fogworks' document, Action, history, editor, and renderer contracts remain authoritative.
- Code is promoted from here only as a small reviewed implementation with Canvas Fogworks-native
  tests and an explicit interface.
- See [`../../docs/3D-FOUNDATION.md`](../../docs/3D-FOUNDATION.md) for the adoption plan.

## Useful reference areas

- `hold_engine_remote/src/ecs/` — entity identity, sparse storage and scheduling
- `hold_engine_remote/src/renderer/` — backend capabilities and frame descriptions
- `hold_engine_remote/src/assets/` — compiled assets and strict binary decoding
- `hold_engine_remote/src/hot_reload/` — generation ordering and reload equivalence
- `hold_engine_remote/src/determinism/` — input recording and replay digests
- `hold_engine_remote/src/editor/session.rs` — authored/runtime state separation

Run the preserved Rust tests from this directory with `cargo test --workspace`.
