# Third-party asset inventory

> Audited 2026-09-02 against the 469 `freeassets` files that were tracked before this change.

## Decision

`freeassets/` is a **local-only development example and test corpus**, not product source and not a
redistributable fixture set. Some packs require credit and others restrict redistribution, so the
whole directory is ignored regardless of any individual pack's licence. Keep each pack's original
licence/readme beside its files and apply its credit terms to any game that uses that art.

All 469 formerly tracked entries were removed from the current Git tree while the local files were
preserved by the ignore rule. They must not be restored to tracking, copied into a release, or used
as published test fixtures. The small, provenance-checked fixtures under `test-fixtures/tiled/`
remain tracked. The project owner has chosen to retain existing Git history rather than rewrite it;
that history may still contain the old 469-file subset and should not be treated as an asset source.

## Audited legacy packs

| Pack | Files | Approx. size | Evidence found | Current-tree decision |
|---|---:|---:|---|---|
| Creatures Pack Free | 13 | 3.40 MB | Local note permits commercial use but prohibits selling/redistributing the pack as a pack | Local-only; ignored |
| Free (isometric tileset) | 178 | 0.21 MB | Local README permits project use but prohibits redistribution/repackaging as standalone content or an asset collection | Local-only; ignored |
| Kenney Game Assets All-in-1 3.4.0 installer | 1 | 99.80 MB | Kenney assets are described as CC0, but an installer is unnecessary repository content | Local-only; ignored |
| P_P_FREE_RPG_TILESET | 4 | 0.05 MB | No licence/readme found in the tracked subset | Local-only; ignored; do not publish |
| Stick Figure Character Sprites 2D | 256 | 27.89 MB | Local `License.txt` states CC0 | Local-only; ignored |
| Weapon Pack Free | 17 | 0.27 MB | Local note permits commercial use but prohibits selling/redistributing the pack as a pack | Local-only; ignored |

The audit records local licence text and does not infer rights beyond it. In particular, permission
to use artwork in a game is not treated as permission to redistribute the source pack in a repository.

## Files intentionally tracked

`test-fixtures/tiled/` contains the small XML fixtures whose provenance is recorded in its README
and in `THIRD_PARTY_NOTICES.md`. Referenced PNGs are deliberately absent.
