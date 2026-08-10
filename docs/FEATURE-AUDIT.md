# Feature audit — VDE against Pixelorama and Tiled

<!-- describes: src/editor/tools, src/core/paint, src/core/import, src/core/export -->

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

**Four capabilities are built and unreachable.** `PixelBuffer.floodFill` and `PixelBuffer.drawLine`
have **no caller anywhere outside the tests**, and `paint/Palette` and `paint/Quantize` have **no
importer outside the tests at all** — an entire palette-and-quantisation layer the app cannot reach.
These are the cheapest features in the project: the arithmetic is written, tested and mutation-checked,
and only a tool and a panel are missing.

## Paint side — against Pixelorama

| Feature | VDE | Note |
|---|---|---|
| Pencil / brush, eraser, size, roundness | **have** | `RasterTool`, `paint/Brush` |
| Symmetry guides | **have** | `paint/Symmetry`, reachable |
| Eyedropper | **have** | reads the DOCUMENT, not the framebuffer |
| Bucket fill (pixels) | **built, unreachable** | `floodFill` exists; no tool, and no tolerance parameter |
| Line / rectangle / ellipse **on pixels** | **built, unreachable** (line) / **absent** (shapes) | `drawLine` has no caller; the shape tools make vector nodes |
| Palette panel, create/edit palettes | **built, unreachable** | `paint/Palette` has no UI |
| Quantise to a palette | **built, unreachable** | `paint/Quantize` has no UI |
| **Pixel selection** — rect, ellipse, lasso, magic wand, colour select, paint-select | **absent** | `marqueeRect` selects NODES; there is no selection mask anywhere |
| Modify selection (grow / shrink / border) | **absent** | needs the above first |
| Crop | **absent** | listed in PLANNED-FIXES and never built |
| Image adjustments — brightness/contrast, HSV, curves, desaturate, invert, posterize, pixelize, outline, gradient map, palettize, colour replace | **absent** | VDE has shadow/blur as NODE effects; it has no destructive pixel adjustments |
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

1. **Wire up what is already built** — bucket, pixel line, palette panel, quantise. Four features,
   no new arithmetic, and every one of them already has tests and surviving mutants.
2. **Pixel selection.** The largest single hole on the paint side, and everything else there
   (crop, transform a region, cut/copy/paste, modify-selection) is downstream of it.
3. **Image adjustments.** A family of small, independently testable pure functions over a
   `PixelBuffer` — the shape this codebase is best at.
4. **Tiled object layers.** The map side's largest hole and the one the "2D game engine" direction
   needs first: entities, not tiles.
5. **A tileset as editable content**, which is what unlocks Pixelorama's Manual/Auto/Stack modes and
   tile-level rotation. This is a schema change and should follow the terrain field.
6. **TMX export**, so a map authored here can leave.
