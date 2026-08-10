# Feature audit — VDE against Pixelorama and Tiled

<!-- describes: src/editor/tools, src/core/paint, src/core/import, src/core/export -->
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

**Five capabilities were built and unreachable; three are now wired and one was reclassified.** `PixelBuffer.floodFill` and `PixelBuffer.drawLine`
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

| Feature | VDE | Note |
|---|---|---|
| Pencil / brush, eraser, size, roundness | **have** | `RasterTool`, `paint/Brush` |
| Symmetry guides | **have** | `paint/Symmetry`, reachable |
| Eyedropper | **have** | reads the DOCUMENT, not the framebuffer |
| Bucket fill (pixels) | **have** | `BucketTool`, in the Paint strip — closed 2026-08-09; still no tolerance parameter |
| Line / rectangle / ellipse **on pixels** | **absent** | `drawLine` exists and is NOT what a tool wants — a tool must stamp the BRUSH, which is `strokePath`+`linePoints`. Needs an ellipse rasteriser that does not exist |
| Palette panel | **have** | loaded from a folder, drawn in the palette’s OWN grid with holes; closed 2026-08-09. No create/EDIT yet |
| Quantise to a palette | **have** | `surfaceEdit.quantizeAction`, one button, one history entry — closed 2026-08-09 |
| **Pixel selection** — rect, ellipse, lasso, magic wand, colour select | **have** | `paint/Selection` + `PixelSelectTool`, closed 2026-08-09. A binary MASK, four operators from the modifiers, marching ants drawn from `SelectionOutline`. EDITOR state, not schema. HONOURED by the brush (per dab), the bucket (as a WALL) and quantise (by restoring what fell outside) |
| Modify selection (grow / shrink / border / invert) | **have** | buttons on the marquee row, closed 2026-08-09. `growSelection` takes a negative to shrink; `borderSelection` is derived from it, so the two cannot disagree about the edge — and the border of a FULL selection is consequently empty, which is documented rather than fixed |
| Crop | **absent** | listed in PLANNED-FIXES and never built |
| Image adjustments — brightness/contrast, HSV, desaturate, invert, posterize, colour replace | **have** | `paint/Adjust` + an inspector section, closed 2026-08-10. Every one is `(buffer) => number`, which is what `surfaceEditAction` takes — so each became a button by being written, and each obeys the pixel selection. Destructive, one undo step apiece |
| Image adjustments — curves, gradient map, pixelize, outline, palettize | **absent** | the first two want a ramp editor; the last three are NEIGHBOURHOOD ops, which is a different shape from the per-pixel family (`outline` must write where alpha was 0, so "skip transparent" stops being right) |
| Rotation algorithms (nearest, OmniScale, rotxel, cleanEdge) | **absent** | rotation is a node transform, resampled by the backend |
| Indexed colour mode | **absent** | Pixelorama carries index maps and a palette index per pixel |
| Onion skinning, animation tags, timeline | **have** | schema 39 |
| GIF export | **absent** | VDE exports SVG and a sprite-sheet atlas |
| Import Aseprite | **have** | `import/Aseprite` |
| Import Krita, Photoshop | **absent** | Pixelorama parses both |
| Reference images | **absent** | |
| Tile mode (seamless-texture preview with offsets and masking) | **absent** | a different feature from tilemaps |
| Brush dynamics (pressure / velocity) | **absent** | |
| Audio layers, 3D layers and cels | **absent** | see *deliberately not building* |

## Map side — against Tiled and Pixelorama's tilemap layers

| Feature | VDE | Note |
|---|---|---|
| Tilemap as a grid of indices | **have** | `core.tilemap`, schema 61 |
| Per-cell orientation (3 flip bits) | **have** | schema 62, all three backends |
| Import a `.tmx` as one node per layer | **have** | 45 of the corpus's 53 layers fit; the rest fall back per layer with a reason |
| Paint / bucket / erase tiles, pick from the sheet | **have** | `TileTool`, Map workspace |
| Resize the grid | **have** | keeps cells by coordinate |
| Dual-grid autotiling arithmetic | **have** (no field yet) | `document/Autotile`; terrain is not yet a stored field |
| **Tileset as a document object** — add, duplicate, edit, delete a tile | **absent** | VDE's sheet is an image plus a slicing rule; Pixelorama's tileset is editable content |
| **Paint PIXELS on a tilemap layer** (Manual / Auto / Stack) | **absent** | Pixelorama's headline tilemap feature: draw pixels and the tileset updates or grows |
| Autotiling bits painted per tile | **absent** | Pixelorama has a tool for exactly this; VDE's table is authored, not painted |
| Tile probability / random variants | **absent** | |
| Tile user data | **absent** | |
| Rotate / flip a tile in the tileset (not the cell) | **absent** | VDE turns CELLS, not tiles |
| Export a tileset (image, Godot `.tres`) | **absent** | |
| Hexagonal and staggered maps | **absent** | reported by the importer, not placed |
| Isometric maps | **partial** | `tilePosition` places them; no isometric map in the corpus has a single non-empty cell, so the formula is untested by real data |
| Tile shapes other than rectangles in a tileset | **absent** | |
| **Object layers** | **absent** | read as a COUNT and reported; this is where a game's entities live |
| Image layers | **absent** | counted and reported |
| Group layers (nesting preserved) | **absent** | flattened; offset and opacity of the group are lost |
| Tile animations | **absent** | unread and unreported |
| Wangsets / terrains | **absent** | unread; the corpus contains none, so there is nothing to import |
| Custom properties (map, layer, tile, object) | **absent** | unread and unreported |
| Infinite maps (chunked) | **absent** | refused with a message |
| Collision shapes per tile | **absent** | |
| Templates | **absent** | |
| More than one tileset per layer | **absent** | falls back to one node per cell, with the reason reported |
| Render order other than `right-down` | **absent** | reported |
| **Write a `.tmx` / `.tsx`** | **absent** | VDE imports Tiled and cannot export it |

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
   marching ants. What is downstream and still absent: CROP, cut/copy/paste of a region, and
   transform-a-region — all three now have the mask they were waiting for.
3. ~~**Image adjustments**~~ — the per-pixel family is DONE 2026-08-10 (`paint/Adjust`): brightness,
   contrast, HSV, desaturate, invert, posterize, colour replace. What remains is the NEIGHBOURHOOD
   ops (pixelize, outline) and the ramp-driven ones (curves, gradient map); they are a different
   shape and want their own slice — `outline` writes where alpha was 0, so this family's
   "skip transparent pixels" rule stops being right for it.
4. **Tiled object layers.** The map side's largest hole and the one the "2D game engine" direction
   needs first: entities, not tiles.
5. **A tileset as editable content**, which is what unlocks Pixelorama's Manual/Auto/Stack modes and
   tile-level rotation. This is a schema change and should follow the terrain field.
6. **TMX export**, so a map authored here can leave.
