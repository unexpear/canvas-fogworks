# Third-party asset inventory

> Audited 2026-09-02 against the 469 `freeassets` files that were tracked before this change.

## Decision

`freeassets/` is reference material, not product source or a deliberate test-fixture set. All 469
entries were removed from current Git tracking while their local working-tree files were preserved
by the existing ignore rule. The small, provenance-checked fixtures under `test-fixtures/tiled/`
remain tracked. Rewriting earlier Git history is a separate decision recorded as `ASSET-001` in
`BACKLOG.json`.

## Audited legacy packs

| Pack | Files | Approx. size | Evidence found | Current-tree decision |
|---|---:|---:|---|---|
| Creatures Pack Free | 13 | 3.40 MB | Local note permits commercial use but prohibits selling/redistributing the pack as a pack | Remove from tracking |
| Free (isometric tileset) | 178 | 0.21 MB | Local README permits project use but prohibits redistribution/repackaging as standalone content or an asset collection | Remove from tracking |
| Kenney Game Assets All-in-1 3.4.0 installer | 1 | 99.80 MB | Kenney assets are described as CC0, but an installer is unnecessary reference material | Remove from tracking |
| P_P_FREE_RPG_TILESET | 4 | 0.05 MB | No licence/readme found in the tracked subset | Remove from tracking |
| Stick Figure Character Sprites 2D | 256 | 27.89 MB | Local `License.txt` states CC0 | Remove from tracking; not an intentional fixture |
| Weapon Pack Free | 17 | 0.27 MB | Local note permits commercial use but prohibits selling/redistributing the pack as a pack | Remove from tracking |

The audit records local licence text and does not infer rights beyond it. In particular, permission
to use artwork in a game is not treated as permission to redistribute the source pack in a repository.

## Files intentionally retained

`test-fixtures/tiled/` contains the small XML fixtures whose provenance is recorded in its README
and in `THIRD_PARTY_NOTICES.md`. Referenced PNGs are deliberately absent.
