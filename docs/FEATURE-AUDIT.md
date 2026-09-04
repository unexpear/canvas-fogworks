# Feature audit — Canvas Fogworks against Pixelorama and Tiled

<!-- describes: src/editor/tools, src/core/paint, src/core/import, src/core/export -->
<!-- re-read 2026-08-14 after extracting the Tiled placement logic into core/import/tiledPlacements.
     THE UNREACHABLE LIST WAS MISSING ITS LARGEST ENTRY: 241 lines deciding what a .tmx places lived
     inside a <select onChange> in App.tsx, and window.electronAPI is frozen, so nothing could call
     them. This audit tracked "built, unreachable" CAPABILITIES and never asked whether a reachable
     capability's IMPLEMENTATION was reachable — the same question, one level down. Now extracted,
     tested (10) and mutated (4). The row below is otherwise accurate. -->
<!-- re-read 2026-08-16 after the document background (schema 70). A NEW ROW is below: it is
     the first document-level field in this codebase whose write path shipped in the same
     commit as the field, which is what the clips and tilesets rows exist to warn about. -->
<!-- re-read 2026-08-13 after the column recovery: the .tmx import row records it. -->
<!-- re-read 2026-08-13 after the tile-anchoring fix: the .tmx import row now records the
     anchoring and the columns gap. -->
<!-- re-read 2026-08-13 after schema 67: four rows were wrong, and the oldest by four schemas —
     autotiling was still listed as having no stored field. Tileset-as-content moved absent →
     partial, probability absent → have, tile user data absent → partial. -->
<!-- re-read 2026-08-10 after Escape's routing: accurate, and one row moved (the tilemap
     rectangle-fill is no longer absent). The Escape finding is not a feature row — every
     cancel it unblocked was already listed as had; they simply did not work. -->
<!-- re-read 2026-08-09 after the selection slices: the two selection rows and ranking item 2 are
     updated above. Verified against the running app, not just the source — the marquee, the
     clipped stroke and the refused bucket click were all driven over CDP. -->

> Measured 2026-08-09 against **Pixelorama** (the build in `possable tools/`, feature surface read
> out of `Pixelorama.pck`) and **Tiled** (the `.tmx`/`.tsx` format, against what
> `core/import/TiledMap` states it reads). Not a roadmap — a statement of what exists, what exists
> and cannot be reached, and what is absent.

## How this was measured, and what that is worth

**Pixelorama's surface came out of its own package**, not from its marketing: `strings` over
`Pixelorama.pck` yields every `res://src/...` path and every translated UI string, so the tool list,
the layer types, the effects and the tilemap vocabulary are read from the build the user has rather
than recalled. **Tiled's** side is the format, checked against `TiledMap`'s header — which already
enumerates what it reads, what it deliberately skips and reports, and what it skips silently.

**What this audit cannot tell you** is whether a feature is any good. It counts presence.

## THREE STATES, not two

The useful distinction this audit turned up is that a missing feature is not always missing work.

| | meaning |
|---|---|
| **have** | reachable in the running app |
| **built, unreachable** | the core function exists and is tested; nothing in the UI calls it |
| **absent** | not written |

**Nine capabilities have been built and unreachable; SIX are now wired and two are BLOCKED rather than merely unwired.** `PixelBuffer.floodFill` and `PixelBuffer.drawLine`
had **no caller anywhere outside the tests**; `paint/Palette` and `paint/Quantize` have **no importer
outside the tests at all** — an entire palette-and-quantisation layer the app cannot reach; and
`diagnostics/ActionJournal.recordAction` has no caller either, so nothing is ever journalled. These
are the cheapest features in the project: the arithmetic is written, tested and mutation-checked, and
only a tool or a panel is missing.

**`floodFill` is now reachable** (`BucketTool`, 2026-08-09), and wiring it found two things a feature
list cannot: `BucketTool`'s "only a raster" check was the ONLY thing refusing pixels on a rectangle,
because `Integrity` never enforced the rule its own comment cites as precedent — both actions do, the
loader did not. And an existing guard pinned the paint strip's exact tool list, so inserting a tool
broke a test whose subject was still true. Both are fixed.

## Paint side — against Pixelorama

| Feature | Canvas Fogworks | Note |
|---|---|---|
| Pencil / brush, eraser, size, roundness | **have** | `RasterTool`, `paint/Brush` |
| Symmetry guides | **have** | `paint/Symmetry`, reachable |
| Eyedropper | **have** | reads the DOCUMENT, not the framebuffer |
| Bucket fill (pixels) | **have** | `BucketTool`, in the Paint strip — closed 2026-08-09; still no tolerance parameter |
| Line / rectangle / ellipse **on pixels** | **absent** | `drawLine` exists and is NOT what a tool wants — a tool must stamp the BRUSH, which is `strokePath`+`linePoints`. Needs an ellipse rasteriser that does not exist |
| Palette panel | **have** | loaded from a folder, drawn in the palette’s OWN grid with holes; closed 2026-08-09. No create/EDIT yet |
| Quantise to a palette | **have** | `surfaceEdit.quantizeAction`, one button, one history entry — closed 2026-08-09 |
| Autotiling / terrain | **have** | `document/Autotile` (the dual grid, 16 masks from 6 drawn tiles) + `Tilemap.terrain` and `resolveTilemaps` (schema 63, 2026-08-10). The document stores WHICH CELLS ARE GRASS and derives the picture. Authored by a BRUSH: the tile tool has a terrain mode, and the inspector converts a layer and assigns one tile per symmetry class, and a RECTANGLE fills a block of it. MULTI-MATERIAL since schema 65: a layer holds a LIST of materials in paint order, and where two meet the later one wins — reorderable in the panel without touching a painted cell. A TILESET IS THE DOCUMENT'S since schema 67, so several layers share one and a mask may hold several tiles chosen by weight. Still absent: painting pixels into a tile |
| **Pixel selection** — rect, ellipse, lasso, magic wand, colour select | **have** | `paint/Selection` + `PixelSelectTool`, closed 2026-08-09. A binary MASK, four operators from the modifiers, marching ants drawn from `SelectionOutline`. EDITOR state, not schema. HONOURED by the brush (per dab), the bucket (as a WALL) and quantise (by restoring what fell outside) |
| Modify selection (grow / shrink / border / invert) | **have** | buttons on the marquee row, closed 2026-08-09. `growSelection` takes a negative to shrink; `borderSelection` is derived from it, so the two cannot disagree about the edge — and the border of a FULL selection is consequently empty, which is documented rather than fixed |
| Selected pixel content — move / cut / copy / paste / clear / transform | **have** | `paint/SelectionContent` + marquee-row controls, closed 2026-09-02. Tight internal clipboard payloads preserve lasso holes and transparent selected pixels; move/paste clip at the canvas edge; flips and clockwise rotation are nearest-neighbour byte rearrangements; mutations use the ordinary undoable surface action |
| Crop | **absent** | listed in PLANNED-FIXES and never built |
| Image adjustments — brightness/contrast, HSV, desaturate, invert, posterize, colour replace | **have** | `paint/Adjust` + an inspector section, closed 2026-08-10. Every one is `(buffer) => number`, which is what `surfaceEditAction` takes — so each became a button by being written, and each obeys the pixel selection. Destructive, one undo step apiece |
| Image adjustments — curves, gradient map, pixelize, outline, palettize | **absent** | the first two want a ramp editor; the last three are NEIGHBOURHOOD ops, which is a different shape from the per-pixel family (`outline` must write where alpha was 0, so "skip transparent" stops being right) |
| Rotation algorithms (nearest, OmniScale, rotxel, cleanEdge) | **absent** | rotation is a node transform, resampled by the backend |
| Indexed colour mode | **absent** | Pixelorama carries index maps and a palette index per pixel |
| Onion skinning, animation tags, timeline | **have** | schema 39 |
| GIF export | **absent** | Canvas Fogworks exports SVG and a sprite-sheet atlas |
| Import Aseprite | **have** | `import/Aseprite` — reachable since 2026-08-13. One `.aseprite` becomes one animated node with the file's OWN frame rate and its TAGS as clips (a rename, not a translation). Opening the door needed three things that were not about Aseprite: `composeFrame` (the reader could describe a file and draw nothing), `SetClipsAction` (`Document.clips` had no write path at all), and document deltas keyed by kind (a transaction could carry only one document-level change; this carries the clock and the ranges that index into it). Measured on the real tree: 23 files composite to real pixels, 96 tags, and the seven refusals are all `__MACOSX/._*` stubs |
| Import Krita, Photoshop | **absent** | Pixelorama parses both |
| Import a NUMBERED FRAME RUN | **have** | `import/Sequence` was the fourth unreachable importer and is now wired: the Assets drawer lists the runs a folder holds and imports one as a single `core.image` with a keyframed `src`. The guard is the interesting part — a tileset exported one file per tile is a numbered run by every rule a name reader has, and one pack here groups to **11,846 frames**, so runs longer than 240 are refused with the reason. Reliability follow-up 2026-09-02: every frame must read as an embedded image before anything is placed; missing/unreadable frames and duplicate basenames across subfolders refuse the whole run, and reads are confined to the chosen folder |
| Import glTF / GLB geometry | **have** | The 3D assets drawer opens confined `.gltf`/`.glb` files through `Asset3DImportWorkflow`, creates stable mesh/material assets plus a renderable scene node and first camera in one undoable transaction, rehydrates project-relative sources after reopen, and renders them through the live WebGL 3D path. Materials, textures, hierarchy, skin data, PBR, picking and Open–Edit–Save behavior are covered by unit and Electron smoke tests. glTF animation import remains absent. |
| Import OBJ geometry | **built, unreachable** | `import/Obj` parses and tests OBJ triangle geometry, but the live 3D asset workflow and confined Electron file boundary currently accept only `.gltf` and `.glb`; OBJ material sidecars and an authoring caller remain absent. |
| Reference images | **absent** | |
| Tile mode (seamless-texture preview with offsets and masking) | **absent** | a different feature from tilemaps |
| Brush VARIANTS (a stamp per dab) | **have** | `brushFromImage` + `brushWithVariants` + `pickFace` were written together and NONE had a caller. Reachable now: any canvas becomes a face, several become variants, and a stroke picks one per dab from `rollAt(seed, index)` — seeded by the PRESS POINT, so the same drag repeats and two drags differ. Indexed rather than streamed so the symmetry mirrors pick the same faces |
| Brush dynamics (pressure / velocity) | **absent** | |
| Audio layers, 3D layers and cels | **absent** | see *deliberately not building* |

## Map side — against Tiled and Pixelorama's tilemap layers

| Feature | Canvas Fogworks | Note |
|---|---|---|
| Tilemap as a grid of indices | **have** | `core.tilemap`, schema 61 |
| Per-cell orientation (3 flip bits) | **have** | schema 62, all three backends |
| Import a `.tmx` as one node per layer | **have** | 45 of the corpus's 53 layers fit; the rest fall back per layer with a reason — and that per-cell path now anchors a tile at the BOTTOM of its cell, so art taller than the grid stands up from it (nine maps in the tree have such art; one moves every tile 384px). A tileset declaring no `columns` is recovered: from its declared image size in the parser (25 of the tree's 26 such sets, which is why the sewer maps round-trip) or by MEASURING the picture at the import seam (the one set that declares neither — 79 cells that used to resolve to nothing) |
| Paint / bucket / erase tiles, pick from the sheet | **have** | `TileTool`, Map workspace |
| Resize the grid | **have** | keeps cells by coordinate |
| Dual-grid autotiling arithmetic | **have** | `document/Autotile`, STORED as `Tilemap.terrain` since schema 63 — the row said "no field yet" for four schemas after it shipped. A mask holds a LIST of candidates (schema 67), chosen deterministically by weight and cell position |
| **Document background** | **have** (schema 70) | `Document.background` — what the document sits ON. Until this, nothing in the tree carried one, so a level appeared to sit on the EDITOR'S chrome: a run had no sky, an export emitted no ground colour, and `<map backgroundcolor>` was read by nothing (3 of the 24 maps here declare one). Document-level rather than a giant rectangle, which would be selectable and inside `contentBounds` — the bounds the camera clamps to and the death plane comes from. Painted in SCREEN space by all three backends, exported as a real `<rect>`, and set by `SetBackgroundAction` + a colour input in the toolbar, ALL IN THE SAME COMMIT AS THE FIELD. Known divergence: the GPU parses hex only and falls back on names/`rgb()` |
| **Tileset as a document object** | **partial** (schemas 67–68, 73) | `Document.tilesets` is shared by layers. Sparse tile records now preserve probability, class, custom properties, collision objects and animation; sets preserve wangsets. Collection sets draw on SVG and Canvas; WebGL still needs a runtime atlas. STILL ABSENT: adding, duplicating or deleting a tile in the panel |
| **Paint PIXELS on a tilemap layer** (Manual / Auto / Stack) | **absent** | Pixelorama's headline tilemap feature: draw pixels and the tileset updates or grows |
| Autotiling bits painted per tile | **absent** | Pixelorama has a tool for exactly this; Canvas Fogworks' table is authored, not painted |
| Tile probability / random variants | **have** | `TilesetTile.probability` (schema 67), un-normalised as Tiled writes it, READ by the autotiler: a mask with several drawn tiles picks among them by weight, seeded by the cell and the material so a derived picture does not shimmer as you pan |
| Tile user data | **have** | `TilesetTile.userData` round-trips through TMX import/export and validates; runtime conventions are additionally projected into typed entity fields. No panel field edits tile metadata yet |
| Rotate / flip a tile in the tileset (not the cell) | **absent** | Canvas Fogworks turns CELLS, not tiles |
| Export a tileset (image, Godot `.tres`) | **absent** | |
| Hexagonal and staggered maps | **absent** | reported by the importer, not placed |
| Isometric maps | **partial** | `tilePosition` places them; no isometric map in the corpus has a single non-empty cell, so the formula is untested by real data |
| Tile shapes other than rectangles in a tileset | **absent** | |
| **Object layers** | **have** | imported as frames preserving layer opacity/visibility and containing tile objects, rectangles, ellipses, polygons and polylines; exported back as `<objectgroup>` entries. Point/text/template objects and object-layer parallax remain reported gaps |
| Image layers | **absent** | counted and reported |
| Group layers (nesting preserved) | **absent** | flattened; offset and opacity of the group are lost |
| Tile animations | **have** | frame ids and millisecond durations import/export; play mode resolves loops from deterministic world time without editing stored cells |
| Wangsets / terrains | **partial** | wangset names/classes/properties, colors and 8-entry wang ids import/export. Canvas Fogworks preserves this independently from its own dual-grid terrain authoring model |
| Open a `.unitypackage` | **have** | `import/UnityPackage` — gzip+tar, assets by GUID folder, paths recovered. Verified on all 7 packages in this tree: 523 files, 27.7 MB, zero notes. REACHABLE from the Folders drawer: `read-unity-folder` + `read-unity-package` (path-confined) and a `gunzip-sync` channel separate from `inflate-sync`, since a package is gzip and not raw zlib. Driven live — 7 packages found, a 5.3MB one opened in 609ms, and a path escape refused. Images place; everything else is counted |
| Unity sprite SLICING rects | **absent, and unbuildable here** | the valuable part of a `.meta`, and every one of the 96 sprites in the 2D package is `spriteMode: 0` with `sprites: []`. There is nothing in this tree to design against |
| Unity prefabs / scenes | **absent** | BINARY serialized type-trees in these packages, not YAML. The same models ship beside them as FBX and glTF, which `import/Gltf` already reads |
| Godot scenes / resources | **absent, and nothing to measure** | no `.tscn`, `.tres`, `.res` or `.scn` exists in this tree; the 6 `.import` files are Material Maker's own HDRI settings |
| Procedural generation (cave) | **have** | `document/CaveTerrain` — cellular automata writing `Tilemap.terrain`, so it is four rules and `resolveTilemaps` draws it. Reachable from the terrain panel with a seed WORD, and reproducible: the same seed is the same cave. Constants are measured, not chosen — see API-CONTRACTS. Absent: BSP rooms, wave function collapse, and any generator that needs MORE THAN ONE material, which the terrain field cannot yet hold |
| Custom properties (OBJECT) | **have** | schema 64 — `Node.className` + `Node.userData`, read, carried, written back out, and editable in the inspector's Metadata section. The value is kept as TEXT with its declared type beside it, because nothing here knows what a `float` or an enum named `Mood` means and this engine now exports `.tmx`. Measured first: all 41 custom properties in this tree live in ONE file and the 20 shipped packs carry none |
| Custom properties (map, layer, tile) | **partial** | tile and wang metadata are preserved; map and layer properties remain unread |
| Infinite maps (chunked) | **absent** | refused with a message |
| Collision shapes per tile | **partial** | rectangles, ellipses, points, polygons and polylines import/export. The current AABB physics consumes their bounds; exact curved/polygonal narrow-phase collision remains absent |
| Templates | **absent** | |
| More than one tileset per layer | **absent** | falls back to one node per cell, with the reason reported |
| Render order other than `right-down` | **absent** | reported |
| **Write a `.tmx`** | **have** | `core/export/ExportTiled` writes tile and object layers with one embedded `<tileset>` per distinct sheet-backed set; text, TMX and PNG export destinations are replaced atomically after a flushed sibling temporary write. Standalone `.tsx`, collection-set export and copying sheet images beside the map remain absent |

## Deliberately not building, with the reason

* **Audio layers, 3D layers and cels, Steam integration, an extensions marketplace.** Pixelorama is
  a shipping application with a plugin ecosystem; those are product surface, not engine capability.
* **Terrain inference from an imported map.** Measured impossible on this art: the corpus's layers
  are not a function of any neighbourhood mask (0.69 agreement for the dual grid over 22,198 cells).
  See `document/Autotile`.
* **Masks (soft / alpha).** Zero demand measured in the corpus; clipping (schema 59) covers the
  rectangular case.

## The ranking this suggests

1. ~~**Wire up what is already built**~~ — bucket, palette panel and quantise are DONE (2026-08-09).
   What remains of that tranche: `ActionJournal.recordAction`, still journalling nothing.
   **`drawLine` is SETTLED and is not part of it** — it is neither a missing feature nor dead code. A
   line tool must stamp the chosen BRUSH along the line (`strokePath` handed `linePoints`), so wiring
   this would give a tool that ignores brush size; and four tests use it to put a diagonal on a
   surface while one asserts its clipping, so deleting it would cost four hand-built fixtures and a
   guard. It stays a primitive, and its header now says why not to wire it.
2. ~~**Pixel selection**~~ — DONE 2026-08-09, in two slices. The arithmetic (`paint/Selection`),
   then the half that makes it mean something: a `PixelClip` predicate threaded to where paint
   actually lands, `pixelMaskFor` as the one validated read, the four marquee gestures, and the
   marching ants. Selection CONTENT followed 2026-09-02: move/cut/copy/paste/clear and lossless
   flip/quarter-turn operations now use that same mask. Crop remains absent.
3. ~~**Image adjustments**~~ — the per-pixel family is DONE 2026-08-10 (`paint/Adjust`): brightness,
   contrast, HSV, desaturate, invert, posterize, colour replace. What remains is the NEIGHBOURHOOD
   ops (pixelize, outline) and the ramp-driven ones (curves, gradient map); they are a different
   shape and want their own slice — `outline` writes where alpha was 0, so this family's
   "skip transparent pixels" rule stops being right for it.
4. ~~**Tiled object layers**~~ — DONE 2026-08-10, reader and placement. `parseTiledMap` returns
   `objectGroups`; `objectPlacement` says what each object becomes or why it cannot; the import
   places an object layer as a FRAME carrying its opacity and visibility with the objects nested
   inside. A tile object becomes a `core.image` with its source rect, a rectangle a box, an ellipse
   a `core.ellipse`, a polygon or polyline a `core.path`. **CLASS AND CUSTOM PROPERTIES ARE CARRIED
   NOW** — schema 64 gave them a home (`Node.className`, `Node.userData`), the import writes them and
   the `.tmx` export writes them back, so a round trip keeps a door's `door=true`. They are carried
   and NOT READ: nothing in the engine derives from them, which is the honest state and exactly what
   a `core.entity` would change. WHAT IS STILL NOT CARRIED, and is counted rather than dropped
   silently: template references (`.tx` files are not opened), text objects, points, and an object
   layer's parallax factor.
5. ~~**A tileset as editable content**~~ — DONE 2026-08-13 as schema 67. `Document.tilesets`, a
   panel, `SetTilesetsAction`, per-tile weights the autotiler READS, and an exporter that writes one
   `<tileset>` per distinct set. What it does not yet do is what Pixelorama's Manual/Auto/Stack
   modes need: adding or growing a TILE, and painting pixels into one. **Drawing a COLLECTION set is
   done** (2026-08-13) on SVG and Canvas, with its own picker; the GPU still cannot, and says so.
6. ~~**TMX export**~~ — DONE 2026-08-10 (`core/export/ExportTiled`). Tile layers go out as a
   `.tmx`, an autotiled layer exports the picture its terrain DERIVES, and a layer the format
   cannot hold (one map size, one tile size) is reported rather than dropped. The oracle is the
   round trip: a real Kenney map imported, exported and imported again, compared cell by cell.
   Object layers go out too, as objectgroups with their shapes, rotations and the bottom-left anchoring reversed. Still absent: copying the sheet beside the file, and an object's class and custom properties (they have no field to come from).
