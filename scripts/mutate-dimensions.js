/**
 * @module mutate-dimensions
 * @description Dimension-confusion mutation battery — `npm run mutate:dimensions`.
 *
 * Every mutation here is one a SQUARE or otherwise symmetric fixture cannot see: it swaps a width
 * for a height, or a row stride for a column one. These are not exotic. They are the single most
 * common defect this codebase's paint arithmetic can have, and the single most common reason a
 * fixture fails to notice — see "Fixture design" in docs/TESTING.md.
 *
 * A SURVIVOR IS A MISSING TEST, not a safe module.
 *
 * THE HARNESS RULE (docs/TESTING.md): a run reporting fewer tests than the suite holds did not
 * COMPILE, and is reported as UNVERIFIED rather than as a kill. A false *survived* prompts
 * investigation; a false *killed* is silent, and leaves a guard unprotected while looking green.
 *
 * AND THE THIRD VERDICT, NOT APPLIED, is the one that has actually cost guards here — five of them
 * across two sittings. It means the `from` matched nothing, so the mutant tested NOTHING while the
 * summary line still read as a pass. Twice the cause was a mutation the author had "simplified" into
 * a shape that no longer appeared in the source, and three times it was line endings; the matcher
 * now normalises those (see below), so what remains is genuine drift. Read every NOT APPLIED as a
 * missing guard, not as noise.
 *
 * REFUSES TO RUN ON A DIRTY TREE. It edits real source files and restores them; if it is
 * interrupted between the two, `git checkout` is the recovery, and that is only safe when there
 * was nothing uncommitted to lose.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/** The suite's size. Anything less means the mutant did not compile. */
const EXPECTED_TESTS = 1705;

const MUTANTS = [
    { id: "SY1", file: "src/core/paint/Symmetry.ts",
      from: "const my = height - 1 - y;", to: "const my = width - 1 - y;",
      note: "vertical axis reads the WRONG dimension — invisible on any square surface" },
    { id: "PA1", file: "src/core/paint/Palette.ts",
      from: "const index = row * palette.width + column;", to: "const index = column * palette.height + row;",
      note: "palette grid addressed column-major — invisible on a square grid" },
    { id: "PB1", file: "src/core/paint/PixelBuffer.ts",
      from: "return x >= 0 && x < buffer.width && y >= 0 && y < buffer.height;",
      to: "return x >= 0 && x < buffer.height && y >= 0 && y < buffer.width;",
      note: "bounds check swaps the two sides — invisible on a square buffer" },
    { id: "PB2", file: "src/core/paint/PixelBuffer.ts",
      from: "    const at = (y * buffer.width + x) * 4;\n    return [buffer.data[at]",
      to: "    const at = (x * buffer.width + y) * 4;\n    return [buffer.data[at]",
      note: "getPixel transposes — invisible on a square buffer with symmetric content" },
    { id: "PP1", file: "src/core/paint/PixelPatch.ts",
      from: "const from = ((y + row) * buffer.width + x) * 4;",
      to: "const from = ((y + row) * buffer.height + x) * 4;",
      note: "copyRect strides by height — invisible on a square buffer" },
    { id: "PP2", file: "src/core/paint/PixelPatch.ts",
      from: "const to = ((patch.y + row) * buffer.width + patch.x) * 4;",
      to: "const to = ((patch.y + row) * buffer.height + patch.x) * 4;",
      note: "applyPatch strides by height — invisible on a square buffer" },
    { id: "PP3", file: "src/core/paint/PixelPatch.ts",
      from: "const at = ((box.y + row) * buffer.width + box.x + col) * 4;",
      to: "const at = ((box.y + row) * buffer.height + box.x + col) * 4;",
      note: "diffRect strides by height — invisible on a square buffer" },

    // SurfaceSpace — the same family plus its neighbours: a box at the ORIGIN hides a dropped
    // origin term, and a round-trip-only assertion hides a half-pixel shift in BOTH directions.
    { id: "SS1", file: "src/core/paint/SurfaceSpace.ts",
      from: "const v = p.y / space.localHeight;",
      to: "const v = p.y / space.localWidth;",
      note: "the vertical axis divides by the WRONG side — invisible on a square box" },
    { id: "SS2", file: "src/core/paint/SurfaceSpace.ts",
      from: "const sy = Math.floor(v * space.surfaceHeight);",
      to: "const sy = Math.floor(v * space.surfaceWidth);",
      note: "the row index scales by the wrong dimension — invisible on a square surface" },
    { id: "SS3", file: "src/core/paint/SurfaceSpace.ts",
      from: "    const u = p.x / space.localWidth;",
      to: "    const u = p.y / space.localWidth;",
      note: "the horizontal axis reads the WRONG component — invisible on a point where x === y" },
    { id: "SS4", file: "src/core/paint/SurfaceSpace.ts",
      from: "const sx = Math.floor(u * space.surfaceWidth);",
      to: "const sx = Math.round(u * space.surfaceWidth);",
      note: "rounds instead of flooring — invisible unless a point sits inside a pixel's first half" },
    // SS5 MOVED WITH THE CODE: `surfaceToWorld` is now derived from `surfaceCornerToWorld`, so the
    // half-pixel it adds is the whole of what it does. Re-authored rather than left to rot — the
    // old `from` would have matched nothing and reported NOT APPLIED, which is the verdict that
    // reads as a pass while testing nothing.
    { id: "SS5", file: "src/core/paint/SurfaceSpace.ts",
      from: "    return surfaceCornerToWorld(space, sx + 0.5, sy + 0.5);",
      to: "    return surfaceCornerToWorld(space, sx, sy);",
      note: "names a pixel's CORNER, not its centre — invisible to a round-trip-only assertion" },
    { id: "SS7", file: "src/core/paint/SurfaceSpace.ts",
      from: "    const v = gy / space.surfaceHeight;",
      to: "    const v = gy / space.surfaceWidth;",
      note: "a grid line divides by the WRONG dimension — invisible on a square surface" },
    { id: "SS6", file: "src/core/paint/SurfaceSpace.ts",
      from: "    const p = applyToPoint(inv, worldX, worldY);",
      to: "    const p = applyToPoint(space.world, worldX, worldY);",
      note: "transforms FORWARD instead of inverting — invisible under an identity matrix" },

    // TiledMap — a layer's offset. The convenient fixture is a map where the two axes are equal,
    // or where one is absent, or where the layer offset and the tileset's tileoffset agree.
    { id: "TM1", file: "src/core/import/TiledMap.ts",
      from: "            offsetX: num(a.offsetx, 0),\n            offsetY: num(a.offsety, 0),\n            // CLAMPED",
      to: "            offsetX: num(a.offsety, 0),\n            offsetY: num(a.offsety, 0),\n            // CLAMPED",
      note: "layer offset reads the wrong axis — invisible when a map offsets only one axis" },
    { id: "TM2", file: "src/core/import/TiledMap.ts",
      from: "            offsetY: num(a.offsety, 0),\n            // CLAMPED",
      to: "            offsetY: num(a.offsety, undefined as unknown as number),\n            // CLAMPED",
      note: "an absent layer offset becomes undefined, not 0 — invisible unless a map omits it" },
    { id: "TM3", file: "src/core/import/TiledMap.ts",
      from: '    if (order !== "right-down") {',
      to: '    if (order === "right-down") {',
      note: "the render-order note fires on the DEFAULT — invisible if only one order is ever tested" },
    { id: "TM4", file: "src/core/import/TiledMap.ts",
      from: "visible: a.visible === undefined ? true : num(a.visible, 1) !== 0,\n            cells: raw.map(decodeGid)",
      to: "visible: a.visible !== undefined,\n            cells: raw.map(decodeGid)",
      note: "treats the ATTRIBUTE'S PRESENCE as the flag — invisible unless a map says visible=\"1\"" },
    // NineSlice — the newest member of the family, and it arrived with two survivors: every
    // fixture used a SQUARE 9x9 source, so "clamp the vertical against the width" was invisible.
    { id: "NS1", file: "src/core/geometry/NineSlice.ts",
      from: "const [st, sb] = fitPair(Math.max(0, insets.top), Math.max(0, insets.bottom), source.height);",
      to: "const [st, sb] = fitPair(Math.max(0, insets.top), Math.max(0, insets.bottom), source.width);",
      note: "vertical insets clamped against the source's WIDTH — invisible on square art" },
    { id: "NS2", file: "src/core/geometry/NineSlice.ts",
      from: "const [dt, db] = fitPair(st, sb, dest.height);",
      to: "const [dt, db] = fitPair(st, sb, dest.width);",
      note: "vertical corners fitted to the box's WIDTH — invisible on a square box" },
    { id: "NS3", file: "src/core/geometry/NineSlice.ts",
      from: "[source.x + source.width - sr, sr, dest.x + dest.width - dr, dr]",
      to: "[source.x + source.width - sr, sr, dest.x + dest.width - dl, dl]",
      note: "the right column takes the LEFT inset — invisible on a symmetric border" },
    { id: "NS4", file: "src/core/geometry/NineSlice.ts",
      from: "[source.y + source.height - sb, sb, dest.y + dest.height - db, db]",
      to: "[source.y + source.height - sb, sb, dest.y + dest.height - dt, dt]",
      note: "the bottom row takes the TOP inset — invisible on a symmetric border" },

    { id: "SK1", file: "src/core/document/Mesh.ts",
      from: "const at = applyToPoint(rest.matrix, p.x * rest.box.width, p.y * rest.box.height);",
      to: "const at = applyToPoint(rest.matrix, p.x * rest.box.height, p.y * rest.box.width);",
      note: "a control point scaled out on the wrong axis — invisible on a square node, and on a corner point at (0, 0)" },
    { id: "SK2", file: "src/core/document/Mesh.ts",
      from: "x: posed.box.width === 0 ? p.x : local.x / posed.box.width,",
      to: "x: posed.box.width === 0 ? p.x : local.x / posed.box.height,",
      note: "the skinned point divided back on the wrong axis — the same blindness, on the return trip" },
    { id: "SK3", file: "src/core/document/Mesh.ts",
      from: "y: posed.box.height === 0 ? p.y : local.y / posed.box.height,",
      to: "y: posed.box.height === 0 ? p.y : local.y / posed.box.width,",
      note: "and the other axis of the same division, which a square box cannot tell apart" },

    { id: "TM5", file: "src/core/import/TiledMap.ts",
      from: "opacity: Math.min(1, Math.max(0, num(a.opacity, 1))),\n            // ABSENT MEANS SHOWN",
      to: "opacity: num(a.opacity, 1),\n            // ABSENT MEANS SHOWN",
      note: "opacity is not clamped — invisible unless a map states one outside 0..1" },

    // `tilemapForLayer` — a whole layer as one grid. Every mutation here is one a SQUARE layer, a
    // firstgid of 1, a tight sheet or a symmetric offset cannot see.
    { id: "TG1", file: "src/core/import/TiledMap.ts",
      from: "        tiles.push(cell.gid - set.firstGid);",
      to: "        tiles.push(cell.gid);",
      note: "a gid stored as if it were an index — invisible when firstGid is 1" },
    { id: "TG2", file: "src/core/import/TiledMap.ts",
      from: "        cols: layer.width, rows: layer.height,",
      to: "        cols: layer.height, rows: layer.width,",
      note: "the grid transposed — invisible on a square layer" },
    // ONE LINE EACH, and that is a repair rather than a style choice: these two were written with a
    // two-line `from` and matched NOTHING, which the harness reported as NOT APPLIED — the state
    // that is neither a kill nor a survivor and is the only reason it was noticed.
    { id: "TG3", file: "src/core/import/TiledMap.ts",
      from: "            x: layer.offsetX + set.offsetX,",
      to: "            x: layer.offsetY + set.offsetY,",
      note: "the node's x takes the y offsets — invisible unless the two axes differ" },
    { id: "TG4", file: "src/core/import/TiledMap.ts",
      from: "            width: layer.width * map.tileWidth,",
      to: "            width: layer.width * map.tileHeight,",
      note: "the node's box measured on the wrong axis — invisible on a square cell" },
    { id: "TG5", file: "src/core/import/TiledMap.ts",
      from: "            tiles.push(TILE_EMPTY);",
      to: "            tiles.push(0);",
      note: "an empty cell stored as TILE ZERO, which is a real tile somebody drew" },
    { id: "TG6", file: "src/core/import/TiledMap.ts",
      from: "        ...(turned ? { flips } : {})",
      to: "        ...(false ? { flips } : {})",
      note: "orientation dropped — a fifth of the art in fourteen of twenty maps turns the wrong way" },
    { id: "TG7", file: "src/core/import/TiledMap.ts",
      from: "    if (set.tileWidth !== map.tileWidth || set.tileHeight !== map.tileHeight) {",
      // `if (false)` did not COMPILE, which the harness reported as UNVERIFIED on 149 tests rather
      // than as a kill — and dropping the height clause is the better mutant regardless: it is the
      // dimension-confusion one, and it needs a fixture whose tiles differ in HEIGHT alone.
      to: "    if (set.tileWidth !== map.tileWidth) {",
      note: "only the WIDTH is checked against the cell — invisible unless a fixture differs in height alone" },
    { id: "TG8", file: "src/core/import/TiledMap.ts",
      from: "        else if (found.firstGid !== set.firstGid) return no(\"draws from more than one tileset\");",
      to: "        else if (false) return no(\"draws from more than one tileset\");",
      note: "a two-tileset layer drawn from whichever set came first" },
    { id: "TG9", file: "src/core/import/TiledMap.ts",
      from: "    const bad = tilemapError(tilemap);",
      to: "    const bad: string | null = null;",
      note: "the document's own validator skipped — the importer can mint an unopenable node" },
    { id: "TG10", file: "src/core/import/TiledMap.ts",
      from: "            hidden: !layer.visible,",
      to: "            hidden: layer.visible,",
      note: "visibility inverted — every shown layer hidden and every hidden one shown" },

    // Editing a grid. The convenient fixture here is a SQUARE cell on a SQUARE grid with nothing
    // turned — which cannot see an axis swap, a stride, or the flip array's invariant.
    { id: "TE1", file: "src/core/document/TilemapEdit.ts",
      from: "    const turned = flips !== null && flips.some(f => f !== 0);",
      to: "    const turned = flips !== null;",
      note: "an all-zero flip array is kept — the absent-when-unturned invariant lasts one edit" },
    { id: "TE2", file: "src/core/document/TilemapEdit.ts",
      from: "            tiles[row * cols + col] = tileAt(map, col, row);",
      to: "            tiles[row * map.cols + col] = tileAt(map, col, row);",
      note: "a resize strides by the OLD width — the map slides diagonally, which no square resize shows" },
    { id: "TE3", file: "src/core/document/TilemapEdit.ts",
      from: "        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {",
      to: "        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]] as const) {",
      note: "a fill spreads diagonally and leaks through a wall drawn as a diagonal" },
    { id: "TE4", file: "src/core/document/Tilemap.ts",
      from: "row: Math.floor(y / map.tileHeight)",
      to: "row: Math.round(y / map.tileHeight)",
      note: "a cell is picked by ROUNDING — every boundary picks its neighbour" },
    { id: "TE5", file: "src/core/document/Tilemap.ts",
      from: "col: Math.floor(x / map.tileWidth)",
      to: "col: Math.floor(x / map.tileHeight)",
      note: "the column divides by the cell's HEIGHT — invisible on a square cell" },
    { id: "TE6", file: "src/core/actions/SetTilemapAction.ts",
      from: "        if (sameMap(node.tilemap, this.next)) return false;",
      to: "        if (false) return false;",
      note: "a no-op edit is accepted — an undo step that undoes nothing" },
    { id: "TE7", file: "src/core/actions/applyMutations.ts",
      from: "                if (delta.tilemap !== undefined) node.tilemap = delta.tilemap;",
      to: "                if (delta.tilemap !== undefined) node.tilemap = node.tilemap;",
      note: "the delta layer drops the grid — the hand-written-list loss that has cost `path` and `hidden` before" },
    { id: "TE8", file: "src/core/document/TilemapEdit.ts",
      from: "        if (tiles[at] !== edit.index) { tiles[at] = edit.index; changed = true; }",
      to: "        tiles[at] = edit.index; changed = true;",
      note: "writing what is already there counts as a change" },

    // The tile BRUSH, and picking a tile out of a sheet. A square tile and a tight sheet hide the
    // pitch confusions here exactly as a square buffer hides a stride one.
    { id: "TT1", file: "src/editor/tools/TileTool.ts",
      from: "        this.write(nodeId, linePoints(from.col, from.row, cell.col, cell.row)",
      to: "        this.write(nodeId, [cell].map(c => [c.col, c.row] as [number, number])",
      note: "the gaps between pointer samples are NOT filled — a stroke comes out as beads" },
    { id: "TT2", file: "src/editor/tools/TileTool.ts",
      from: "return loose ? cellCoordAt(map, local.x, local.y) : cellAt(map, local.x, local.y);",
      to: "return loose ? cellCoordAt(map, w.x, w.y) : cellAt(map, w.x, w.y);",
      note: "the cell is picked in WORLD space — a moved or nested map paints the wrong cell" },
    { id: "TT3", file: "src/editor/tools/TileTool.ts",
      from: "        if (e.altKey) {",
      to: "        if (e.altKey && this.brush().mode !== \"fill\") {",
      note: "alt stops sampling in fill mode — the pick becomes a bucket" },
    { id: "TT4", file: "src/editor/tools/TileTool.ts",
      from: "        const flip = brush.erasing ? 0 : brush.flip;",
      to: "        const flip = brush.flip;",
      note: "an erased cell keeps its orientation, holding the flips array alive forever" },
    { id: "TT5", file: "src/editor/tools/TileTool.ts",
      from: "        if (!cell) { this.last = null; return; }",
      to: "        if (!cell) { return; }",
      note: "leaving the grid keeps the anchor — returning stripes a line across the map" },
    { id: "TI1", file: "src/core/document/Tilemap.ts",
      from: "    if (px - col * pitchX >= sheet.tileWidth) return null;",
      to: "    if (false) return null;",
      note: "a click in the horizontal gutter selects the tile before it — invisible on a tight sheet" },
    { id: "TI2", file: "src/core/document/Tilemap.ts",
      from: "    if (py - row * pitchY >= sheet.tileHeight) return null;",
      to: "    if (false) return null;",
      note: "a click in the vertical gutter selects the row above — invisible on a tight sheet" },
    { id: "TI3", file: "src/core/document/Tilemap.ts",
      from: "    if (col >= sheet.columns) return null;                   // past the right edge of the grid",
      to: "    if (false) return null;                   // past the right edge of the grid",
      note: "past the right edge wraps into the next row" },
    { id: "TI4", file: "src/core/document/Tilemap.ts",
      from: "    const col = Math.floor(px / pitchX);",
      to: "    const col = Math.floor(px / pitchY);",
      note: "the column divides by the VERTICAL pitch — invisible on square tiles" },

    // AUTOTILING. The blindness here is a SYMMETRIC fixture rather than a square one: a blob of
    // terrain that looks the same turned cannot tell one corner from another, and a table whose
    // entries are all unturned cannot tell one flip order from another.
    { id: "AT1", file: "src/core/document/Autotile.ts",
      from: "    if (flip & FLIP_D) swap(CORNER_TR, CORNER_BL);",
      to: "    if (flip & FLIP_D) swap(CORNER_TL, CORNER_BR);",
      note: "the transpose swaps the corners ON the diagonal instead of the other pair" },
    { id: "AT2", file: "src/core/document/Autotile.ts",
      from: "        for (let flip = 0; flip <= FLIP_MAX; flip++) seen.add(flipMask(flip, mask));",
      to: "        seen.add(mask);",
      note: "classes are not orbits — sixteen of them instead of six" },
    { id: "AT3", file: "src/core/document/Autotile.ts",
      from: "        | (has(col, row - 1) ? CORNER_TR : 0)",
      to: "        | (has(col, row - 1) ? CORNER_BL : 0)",
      note: "the cell above names the wrong corner — invisible to a symmetric blob of terrain" },
    { id: "AT4", file: "src/core/document/Autotile.ts",
      from: "    const cols = terrain.cols + 1;",
      to: "    const cols = terrain.cols;",
      note: "the display grid is NOT one larger — the last terrain column is never fully drawn" },
    { id: "AT5", file: "src/core/document/Autotile.ts",
      from: "        if (c < 0 || r < 0 || c >= terrain.cols || r >= terrain.rows) return false;",
      to: "        if (c < 0 || r < 0 || c >= terrain.cols || r >= terrain.rows) return true;",
      note: "off the terrain counts AS the material — no coastline at the map's edge" },
    { id: "AT6", file: "src/core/document/Autotile.ts",
      from: "    return turned ? { cols, rows, tiles, flips } : { cols, rows, tiles };",
      to: "    return { cols, rows, tiles, flips };",
      note: "flips always present — the absent-when-unturned invariant, broken from the derived side" },
    { id: "AT7", file: "src/core/document/Autotile.ts",
      from: "        return terrain.cells[r * terrain.cols + c] === material;",
      to: "        return terrain.cells[r * terrain.cols + c] !== 0;",
      note: "any material counts as this one — two materials collapse into one layer" },

    // TWO-LINE MUTATIONS, which is the point of them being here: both were proved to kill and then
    // could not be added until the matcher stopped caring about line endings. ORDER is the whole
    // subject of AT8 — transpose-then-mirror is not commutative, and no single-line edit expresses
    // getting it backwards.
    { id: "AT8", file: "src/core/document/Autotile.ts",
      from: "    if (flip & FLIP_D) swap(CORNER_TR, CORNER_BL);\n    if (flip & FLIP_H) { swap(CORNER_TL, CORNER_TR); swap(CORNER_BL, CORNER_BR); }",
      to: "    if (flip & FLIP_H) { swap(CORNER_TL, CORNER_TR); swap(CORNER_BL, CORNER_BR); }\n    if (flip & FLIP_D) swap(CORNER_TR, CORNER_BL);",
      note: "mirror BEFORE transpose — the order `flipMatrix` does not use, and not commutative" },
    { id: "AT9", file: "src/core/document/Autotile.ts",
      from: "            for (let flip = 0; flip <= FLIP_MAX; flip++) {\n                if (flipMask(flip, classMask) !== mask) continue;",
      to: "            for (let flip = FLIP_MAX; flip >= 0; flip--) {\n                if (flipMask(flip, classMask) !== mask) continue;",
      note: "flips tried DESCENDING — a class's own mask gets a turned tile that only looks the same" },

    // THE BUCKET, whose blind fixture is a SQUARE canvas and an OPAQUE fill. Three of the six
    // mutations first written for it survive and are NOT here: two are equivalent by design (the
    // action refuses an empty patch on its own; `Integrity` refuses a surface on a non-raster) and
    // one was a deliberate control. A battery must only hold mutants that kill, or its own summary
    // lies — the reasoning for the three that do not lives in `BucketTool`'s comments.
    { id: "BK1", file: "src/editor/tools/BucketTool.ts",
      from: "        const before = readRegion(buffer, 0, 0, buffer.width, buffer.height);",
      to: "        const before = readRegion(buffer, 0, 0, buffer.height, buffer.width);",
      note: "the captured region is transposed — invisible on a square canvas AND on any opaque fill" },
    { id: "BK2", file: "src/editor/tools/BucketTool.ts",
      from: "        if (ids.length !== 1) return null;",
      to: "        if (ids.length < 1) return null;",
      note: "two selected canvases no longer refuse — which one would the fill be for?" },
    { id: "BK3", file: "src/core/paint/PixelBuffer.ts",
      from: "        const neighbours: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];",
      to: "        const neighbours: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1], [cx + 1, cy + 1], [cx - 1, cy - 1]];",
      note: "the fill spreads diagonally and leaks through the wall a diagonal seam is meant to be" },
    { id: "IN1", file: "src/core/document/Integrity.ts",
      from: "    if (node.surface !== undefined && node.type !== \"core.raster\") {",
      to: "    if (false) {",
      note: "pixels on a rectangle load again — the rule two actions enforce and the loader did not" },

    // A WHOLE-CANVAS EDIT and the palette it snaps to. `surfaceEdit`'s two guards look redundant and
    // are not: the count is a CALLER's claim and the patch is the truth, so each catches the other's
    // disagreement in one direction. A third mutant here (any node with a surface is editable) is
    // EQUIVALENT now that `Integrity` refuses such a document, and is deliberately not listed.
    { id: "SE1", file: "src/core/actions/surfaceEdit.ts",
      from: "    if (edit(buffer) === 0) return null;",
      to: "    edit(buffer);",
      note: "an edit reporting no change still becomes an undo step" },
    { id: "SE2", file: "src/core/actions/surfaceEdit.ts",
      from: "    if (isEmptyPatch(patch)) return null;",
      to: "    if (false) return null;",
      note: "a caller's inflated count is trusted — an empty patch reaches the action" },
    { id: "SE3", file: "src/core/actions/surfaceEdit.ts",
      from: "    const before = readRegion(buffer, 0, 0, buffer.width, buffer.height);",
      to: "    const before = readRegion(buffer, 0, 0, buffer.height, buffer.width);",
      note: "the before-image is transposed — invisible on a square canvas" },
    { id: "QZ1", file: "src/core/paint/Quantize.ts",
      from: "        if (mapped[0] === r && mapped[1] === g && mapped[2] === b && mapped[3] === a) continue;",
      to: "        if (false) continue;",
      note: "a pixel that already matched counts as changed — caught by the suite, not by the filtered run" },

    // PIXEL SELECTION, where the blind fixture is a CIRCLE (hides swapped radii), a polygon whose
    // vertices sit at integer y (hides the half-open scanline rule), and two overlapping rectangles of
    // the SAME width (hides a subtract that takes the wrong side). One mutant is deliberately absent:
    // the wand's row bound is not observable in the result, because a read past the buffer is
    // `undefined` and a write past a `Uint8Array` is a silent no-op — stated in the module.
    { id: "SL1", file: "src/core/paint/Selection.ts",
      from: "            const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;",
      to: "            const dx = (x - cx) / rx, dy = (y - cy) / ry;",
      note: "the ellipse tests a pixel's CORNER \u2014 the smallest one becomes empty" },
    { id: "SL2", file: "src/core/paint/Selection.ts",
      from: "            const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;",
      to: "            const dx = (x + 0.5 - cx) / ry, dy = (y + 0.5 - cy) / rx;",
      note: "the two radii are swapped \u2014 invisible on a circular fixture" },
    { id: "SL3", file: "src/core/paint/Selection.ts",
      from: "                if ((a.y > py) === (b.y > py)) continue;",
      to: "                if ((a.y >= py) === (b.y >= py)) continue;",
      note: "the lasso's Y rule is no longer half-open \u2014 needs a vertex ON a scanline to show" },
    { id: "SL4", file: "src/core/paint/Selection.ts",
      from: "                if (px < a.x + t * (b.x - a.x)) inside = !inside;",
      to: "                if (px > a.x + t * (b.x - a.x)) inside = !inside;",
      note: "the lasso crosses on the wrong side \u2014 inside becomes outside" },
    { id: "SL5", file: "src/core/paint/Selection.ts",
      from: "                    if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return shrinking;",
      to: "                    if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return false;",
      note: "shrinking eats a ring off the SURFACE EDGE \u2014 select all, shrink, lose a border" },
    { id: "SL6", file: "src/core/paint/Selection.ts",
      from: "                if (shrinking ? (self && neighbours) : any) next[i] = SELECTED;",
      to: "                if (shrinking ? (self || neighbours) : any) next[i] = SELECTED;",
      note: "shrinking stops shrinking at all" },
    { id: "SL7", file: "src/core/paint/Selection.ts",
      from: "    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };",
      to: "    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };",
      note: "mask bounds are EXCLUSIVE \u2014 one pixel is a 0x0 box and a crop eats the outline" },
    { id: "SL8", file: "src/core/paint/Selection.ts",
      from: "            : op === \"subtract\" ? (had && !now)",
      to: "            : op === \"subtract\" ? (!had && now)",
      note: "subtract takes the wrong side of the overlap \u2014 needs rectangles of DIFFERENT widths to show" },
    { id: "SL9", file: "src/core/paint/Selection.ts",
      from: "    if (into.width !== shape.width || into.height !== shape.height) return null;",
      to: "    if (false) return null;",
      note: "a mismatched shape is combined against a sheared index" },
    { id: "SL10", file: "src/core/paint/Selection.ts",
      from: "    const cells = (m.width as number) * (m.height as number);",
      to: "    const cells = (m.width as number) + (m.height as number);",
      note: "the mask length check adds instead of multiplying" },

    // HONOURING the mask. A marquee that changes nothing is a decoration, and every one of these is
    // a way for the clip to be present in the source and absent in the picture.
    { id: "MK1", file: "src/core/paint/Brush.ts",
      from: "        if (clip && !clip(cx + d.dx, cy + d.dy)) continue;",
      to: "        if (clip && !clip(cx, cy)) continue;",
      note: "the clip is tested at the stamp's CENTRE, so a wide brush lands whole or not at all" },
    { id: "MK2", file: "src/core/paint/PixelBuffer.ts",
      from: "            if (clip && !clip(nx, ny)) continue;\n            const key = ny * buffer.width + nx;",
      to: "            const key = ny * buffer.width + nx;",
      note: "a fill spreads through unselected pixels — the boundary stops being a wall" },
    { id: "MK3", file: "src/core/paint/PixelBuffer.ts",
      from: "    if (clip && !clip(x, y)) return 0;",
      to: "    if (clip && !clip(y, x)) return 0;",
      note: "the seed's clip test is transposed — invisible on a square, symmetric selection" },
    { id: "MK4", file: "src/core/paint/Selection.ts",
      from: "        if (mask.data[i] !== 0) continue;",
      to: "        if (mask.data[i] === 0) continue;",
      note: "restoreUnselected puts back the SELECTED half, confining the edit to its inverse" },
    { id: "MK5", file: "src/core/paint/Selection.ts",
      from: "    if (mask.width !== buffer.width || mask.height !== buffer.height) return 0;",
      to: "    if (mask.width !== buffer.width) return 0;",
      note: "a mask of the right width and wrong height is honoured against a sheared index" },
    { id: "MK6", file: "src/core/actions/surfaceEdit.ts",
      from: "    if (mask && (mask.width !== buffer.width || mask.height !== buffer.height)) return null;",
      to: "    if (mask && (mask.width !== buffer.width || mask.height !== buffer.height)) mask = undefined;",
      note: "a stale selection is IGNORED, so a panel button edits the whole canvas instead" },
    { id: "MK7", file: "src/core/actions/surfaceEdit.ts",
      from: "    if (mask) restoreUnselected(buffer, before, mask);\n    const patch = capturePatch(buffer, before, 0, 0, buffer.width, buffer.height);",
      to: "    const patch = capturePatch(buffer, before, 0, 0, buffer.width, buffer.height);\n    if (mask) restoreUnselected(buffer, before, mask);",
      note: "the diff is taken BEFORE the restore, so the patch carries the pixels it put back" },
    { id: "MK8", file: "src/editor/EditorState.ts",
      from: "    if (sel.mask.width !== surface.width || sel.mask.height !== surface.height) return null;",
      to: "    if (sel.mask.width !== surface.width) return null;",
      note: "a mask that survived a resize on one axis clips a stroke to a sheared ghost" },
    { id: "MK9", file: "src/editor/EditorState.ts",
      from: "    if (!sel || sel.nodeId !== nodeId) return null;",
      to: "    if (!sel) return null;",
      note: "a mask drawn on one canvas clips an edit to another" },
    { id: "MK10", file: "src/core/paint/Selection.ts",
      from: "    if (!mask || isEmptySelection(mask)) return undefined;",
      to: "    if (!mask) return undefined;",
      note: "an empty selection becomes a clip that refuses everything — paint stops working" },
    // THE OUTLINE and the gesture that produces it. A selection nobody can SEE is as useless as one
    // nothing honours, so these are the same family as MK: ways for the marquee to be wrong quietly.
    { id: "OL1", file: "src/core/paint/SelectionOutline.ts",
      from: "!isSelected(mask, x, y + (side === 0 ? -1 : 1));",
      to: "!isSelected(mask, x, y + (side === 0 ? 1 : -1));",
      note: "top and bottom edges are detected against the wrong neighbour" },
    { id: "OL2", file: "src/core/paint/SelectionOutline.ts",
      from: "                    segments.push({ x1: runStart, y1: edgeY, x2: x, y2: edgeY });",
      to: "                    segments.push({ x1: runStart, y1: edgeY, x2: x - 1, y2: edgeY });",
      note: "a horizontal run ends one short — a single pixel's outline becomes zero-length lines" },
    // OL3 REPLACED. Its first form mutated a `y < y1` guard in the vertical scan and SURVIVED,
    // because the guard was dead: the bounds are tight, so the row one past them holds nothing, and
    // `isSelected` answers false off the mask anyway. The guard is gone rather than documented — a
    // check that cannot fail is not a check — and this mutates the line's load-bearing half instead:
    // the neighbour a left or right edge is tested against.
    { id: "OL3", file: "src/core/paint/SelectionOutline.ts",
      from: "!isSelected(mask, x + (side === 0 ? -1 : 1), y);",
      to: "!isSelected(mask, x + (side === 0 ? 1 : -1), y);",
      note: "left and right edges are detected against the wrong neighbour" },
    { id: "OL4", file: "src/core/paint/SelectionOutline.ts",
      from: "            for (let y = y0; y <= y1; y++) {",
      to: "            for (let y = y0; y < y1; y++) {",
      note: "a vertical run reaching the last row is never flushed — two sides vanish" },
    { id: "OL5", file: "src/core/paint/SelectionOutline.ts",
      from: "            for (let x = x0; x <= x1; x++) {",
      to: "            for (let x = x0; x < x1; x++) {",
      note: "a horizontal run reaching the last column is never flushed" },
    { id: "RM1", file: "src/renderer/RenderModel.ts",
      from: "                const a = surfaceCornerToWorld(space, seg.x1, seg.y1);",
      to: "                const a = surfaceCornerToWorld(space, seg.y1, seg.x1);",
      note: "the ants' coordinates are transposed — invisible on a square surface in a square box" },
    { id: "RM2", file: "src/renderer/RenderModel.ts",
      from: '                for (const pass of [{ stroke: "#000000", dash: null }, { stroke: "#ffffff", dash: `${3 / z} ${3 / z}` }]) {',
      to: '                for (const pass of [{ stroke: "#000000", dash: null }]) {',
      note: "one pass only — a marquee invisible over half the artwork an author paints" },
    { id: "PS1", file: "src/editor/tools/PixelSelectTool.ts",
      from: 'if (e.shiftKey && e.altKey) return "intersect";',
      to: 'if (e.shiftKey && e.altKey) return "add";',
      note: "shift+alt ADDS rather than intersecting — three operators reachable, not four" },
    { id: "PS2", file: "src/editor/tools/PixelSelectTool.ts",
      from: "+ Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]) <= tolerance;",
      to: "+ Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]) < tolerance;",
      note: "the wand's tolerance is exclusive — needs a fixture ON the boundary to show" },
    { id: "PS3", file: "src/editor/tools/PixelSelectTool.ts",
      from: "                polygon.data[y * s.width + x] = SELECTED;",
      to: "                polygon.data[y * s.width + x] = 0;",
      note: "the lasso drops the line it traced, so half of a thin one falls out by parity" },
    { id: "PS4", file: "src/editor/tools/PixelSelectTool.ts",
      from: "            s.trail.map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 })));",
      to: "            s.trail.map(([x, y]) => ({ x, y })));",
      note: "lasso vertices sit on pixel CORNERS, so which pixel was meant is ambiguous" },
    { id: "PS5", file: "src/editor/tools/PixelSelectTool.ts",
      from: "        this.editorState.pixelSelection = isEmptySelection(mask) ? null : { nodeId, mask };",
      to: "        this.editorState.pixelSelection = { nodeId, mask };",
      note: "an empty result is STORED, leaving ants around nothing and a status line that lies" },
    { id: "PS6", file: "src/editor/tools/PixelSelectTool.ts",
      from: "        s.moved = true;\n        s.trail.push(p);",
      to: "        s.trail.push(p);",
      note: "a drag is never seen to move, so every marquee deselects on release" },
    { id: "PS7", file: "src/editor/tools/PixelSelectTool.ts",
      from: "            this.write(s.nodeId, s.base);",
      to: "            this.editorState.pixelSelection = null;",
      note: "Escape mid-drag clears instead of restoring — cancel costs the author their selection" },
    // TILED OBJECT LAYERS. The anchoring rule is the one that matters and the one a fixture cannot
    // see by accident: every object still lands SOMEWHERE plausible when it is wrong.
    { id: "OB1", file: "src/core/import/TiledMap.ts",
      from: '        y: obj.kind === "tile" ? obj.y - obj.height : obj.y,',
      to: "        y: obj.y,",
      note: "a tile object is anchored top-left — every one lands an object-height too low" },
    { id: "OB2", file: "src/core/import/TiledMap.ts",
      from: '        y: obj.kind === "tile" ? obj.y - obj.height : obj.y,',
      to: "        y: obj.y - obj.height,",
      note: "the bottom-left shift is applied to EVERY kind, so collision volumes ride up" },
    { id: "OB3", file: "src/core/import/TiledMap.ts",
      from: '        origin: obj.kind === "tile" ? { x: 0, y: 1 } : { x: 0, y: 0 }',
      to: "        origin: { x: 0, y: 0 }",
      note: "a rotated tile object turns about the wrong corner and swings off its position" },
    { id: "OB4", file: "src/core/import/TiledMap.ts",
      from: "        rotation: obj.rotation * Math.PI / 180,",
      to: "        rotation: -obj.rotation * Math.PI / 180,",
      note: "the rotation sign is 'corrected' for clockwise, mirroring every rotated object" },
    { id: "OB5", file: "src/core/import/TiledMap.ts",
      from: '            a.template !== undefined ? "template"',
      to: '            a.template !== null ? "template"',
      note: "every object reads as a template, because an absent attribute is undefined not null" },
    { id: "OB6", file: "src/core/import/TiledMap.ts",
      from: '            className: a.class ?? a.type ?? "",',
      to: '            className: a.class ?? "",',
      note: "Tiled 1.8's `type` is dropped — the only class in the corpus disappears" },
    { id: "OB7", file: "src/core/import/TiledMap.ts",
      from: 'const head = { type: a.type ?? "string",',
      to: 'const head = { type: a.type ?? "",',
      note: "an untyped property loses the format's default, so a consumer's switch stops being total" },
    { id: "OB8", file: "src/core/import/TiledMap.ts",
      from: "    for (const m of body.matchAll(/<object\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/object>)/g)) {",
      to: "    for (const m of body.matchAll(/<object\\b([^>]*?)(\\/>|>([\\s\\S]*)<\\/object>)/g)) {",
      note: "the object close is GREEDY, so one object swallows its neighbours and their properties" },
    { id: "OB9", file: "src/core/import/TiledMap.ts",
      from: "                return { x: num(px, 0), y: num(py, 0) };",
      to: "                return { x: num(px, 0), y: num(px, 0) };",
      note: "a polygon's points read x for y — invisible on any point where the two are equal" },
    { id: "OB11", file: "src/core/import/TiledMap.ts",
      from: "            visible: a.visible === undefined ? true : num(a.visible, 1) !== 0,\n            cell:",
      to: "            visible: a.visible !== undefined,\n            cell:",
      note: "an OBJECT's visibility reads the attribute's presence — every shown object hides" },
    { id: "OB10", file: "src/core/import/TiledMap.ts",
      from: "            visible: a.visible === undefined ? true : num(a.visible, 1) !== 0,\n            offsetX: num(a.offsetx, 0),\n            offsetY: num(a.offsety, 0),\n            objects: parseObjects(m[3] ?? \"\")",
      to: "            visible: a.visible !== undefined,\n            offsetX: num(a.offsetx, 0),\n            offsetY: num(a.offsety, 0),\n            objects: parseObjects(m[3] ?? \"\")",
      note: "an object layer's visibility reads the ATTRIBUTE'S PRESENCE, hiding every shown layer" },

    // THE ADJUSTMENTS. Every one is a small pure map over a buffer, which is the shape that makes a
    // wrong constant invisible: the picture still looks like a picture.
    { id: "AD1", file: "src/core/paint/Adjust.ts",
      from: "export const MID = 127.5;",
      to: "export const MID = 128;",
      note: "contrast pivots on 128, so every application creeps toward black — invisible once" },
    { id: "AD2", file: "src/core/paint/Adjust.ts",
      from: "    const quantise = (v: number) => Math.round(v / step) * step;",
      to: "    const quantise = (v: number) => Math.floor(v / step) * step;",
      note: "posterize floors instead of rounding — every value falls to the level below" },
    { id: "AD3", file: "src/core/paint/Adjust.ts",
      from: "    const step = 255 / (n - 1);",
      to: "    const step = 255 / n;",
      note: "posterize cuts the VALUES into buckets rather than the RANGE into intervals" },
    { id: "AD4", file: "src/core/paint/Adjust.ts",
      from: "        if (buffer.data[i + 3] === 0) continue;",
      to: "        if (buffer.data[i + 3] < 0) continue;",
      note: "transparent pixels are adjusted too, putting invisible bytes into every patch" },
    { id: "AD5", file: "src/core/paint/Adjust.ts",
      from: "        if (out === key) continue;",
      to: "        if (out === key && false) continue;",
      note: "an unchanged pixel counts as changed, so a no-op edit becomes an undo step" },
    { id: "AD6", file: "src/core/paint/Adjust.ts",
      from: "        const y = 0.299 * r + 0.587 * g + 0.114 * b;",
      to: "        const y = 0.587 * r + 0.299 * g + 0.114 * b;",
      note: "desaturate weights red like green — a plain-average grey by another route" },
    { id: "AD7", file: "src/core/paint/Adjust.ts",
      from: "    return Math.max(0, Math.min(255, Math.round(v)));",
      to: "    return Math.max(0, Math.min(255, Math.floor(v)));",
      note: "the byte floors, so every half-step lands one below — the pivot's whole point" },
    { id: "AD8", file: "src/core/paint/Adjust.ts",
      from: "    return [h, max === 0 ? 0 : d / max, max / 255];",
      to: "    return [h, max === 0 ? 0 : d / 255, max / 255];",
      note: "saturation divides by the wrong thing — the HSV round trip stops being exact" },
    { id: "AD9", file: "src/core/paint/Adjust.ts",
      from: "    const sector = Math.floor(hue / 60) % 6;",
      to: "    const sector = Math.floor(hue / 60) % 5;",
      note: "the last hue sector wraps to the first — magenta comes back red" },
    { id: "AD10", file: "src/core/paint/Adjust.ts",
      from: "    if (hueShift === 0 && saturationScale === 1 && valueScale === 1) return 0;",
      to: "    if (hueShift === 0 && valueScale === 1) return 0;",
      note: "a saturation-only adjustment is treated as a no-op and silently does nothing" },

    // TERRAIN (schema 63). The dual grid's half-cell offset is the classic one to get wrong, and
    // wrong by half a cell still looks like a map — just one that does not line up with anything.
    { id: "TR1", file: "src/core/document/Components.ts",
      from: "                x: n.geometry.x - map.tileWidth / 2,",
      to: "                x: n.geometry.x - map.tileHeight / 2,",
      note: "the horizontal shift uses the cell's HEIGHT — invisible on a square cell" },
    { id: "TR2", file: "src/core/document/Components.ts",
      from: "                y: n.geometry.y - map.tileHeight / 2,",
      to: "                y: n.geometry.y + map.tileHeight / 2,",
      note: "the display grid is offset the wrong way, so every tile sits a cell off its corner" },
    { id: "TR3", file: "src/core/document/Components.ts",
      from: "                width: n.geometry.width + map.tileWidth,",
      to: "                width: n.geometry.width,",
      note: "the box does not grow, so the extra column the dual grid needs falls outside it" },
    // TR4 WAS REMOVED, and the reason belongs here rather than in a commit nobody will find. It
    // mutated the line that DROPS the terrain from a resolved node, and it could not be written in
    // a form that compiles: `map` is a `ReadonlyTilemap`, so a `terrain` carried through cannot be
    // assigned into a mutable `Tilemap`. The type system already refuses the defect, which leaves a
    // mutation battery nothing to catch — and a mutant that cannot compile reports UNVERIFIED,
    // which is neither a kill nor a survivor and would make the summary line a lie. The behaviour
    // is still asserted (the resolved node's terrain is undefined); it simply has two guards, one
    // of which runs at compile time.
    { id: "TR9", file: "src/core/actions/SetTilemapAction.ts",
      from: "    return sameTerrain(a.terrain, b.terrain);",
      to: "    return true;",
      note: "a terrain edit reads as a no-op and is REFUSED — the brush silently does nothing" },
    { id: "TR10", file: "src/core/actions/SetTilemapAction.ts",
      from: "    if (a.art.length !== b.art.length) return false;",
      to: "    if (a.art.length !== b.art.length) return true;",
      note: "ASSIGNING a class that had none reads as no change — the six pickers cannot be used" },
    { id: "TB1", file: "src/core/document/Autotile.ts",
      from: "col: Math.floor((localX - map.tileWidth / 2) / map.tileWidth)",
      to: "col: Math.floor(localX / map.tileWidth)",
      note: "the terrain brush does not undo the half-cell offset — it paints the neighbour" },
    { id: "TB2", file: "src/core/document/Autotile.ts",
      from: "row: Math.floor((localY - map.tileHeight / 2) / map.tileHeight)",
      to: "row: Math.floor((localY - map.tileWidth / 2) / map.tileHeight)",
      note: "the vertical offset subtracts the cell's WIDTH — invisible on a square cell" },
    { id: "TB3", file: "src/core/document/TilemapEdit.ts",
      from: "    if (map.terrain) return null;\n    const tiles = map.tiles.slice();",
      to: "    const tiles = map.tiles.slice();",
      note: "tiles can be painted onto an autotiled layer, which silently drops its terrain" },
    { id: "TB4", file: "src/core/document/TilemapEdit.ts",
      from: "        if (cells[at] === edit.material) continue;",
      to: "        if (cells[at] !== edit.material) continue;",
      note: "a terrain edit writes only where it changes nothing — the brush does nothing" },
    { id: "TB5", file: "src/core/document/TilemapEdit.ts",
      from: "        if (!Number.isInteger(edit.material) || edit.material < 0) continue;",
      to: "        if (!Number.isInteger(edit.material) || edit.material < -1) continue;",
      note: "a negative material is stored, which `terrainError` would refuse on the next load" },
    { id: "TB6", file: "src/core/document/TilemapEdit.ts",
      from: "    if (at >= 0 && art[at].index === index) return null;",
      to: "    if (at >= 0) return null;",
      note: "a class's tile can never be REASSIGNED, so the six pickers are write-once" },
    { id: "TB7", file: "src/core/document/TilemapEdit.ts",
      from: "    const next = rebuild(map, new Array(map.cols * map.rows).fill(TILE_EMPTY), null);",
      to: "    const next = rebuild(map, map.tiles.slice(), null);",
      note: "becoming a terrain layer keeps its tiles, which `tilemapError` then refuses" },
    { id: "TB8", file: "src/core/document/TilemapEdit.ts",
      from: "            material: map.terrain.material,",
      to: "            material: 0,",
      note: "terrain survives an unrelated edit with its material reset to the ERASER" },

    { id: "TR5", file: "src/core/document/Components.ts",
      from: "            { cols: map.cols, rows: map.rows, cells: terrain.cells }, terrain.material, table);",
      to: "            { cols: map.rows, rows: map.cols, cells: terrain.cells }, terrain.material, table);",
      note: "the terrain is transposed — invisible on a square grid, a sheared coast otherwise" },
    { id: "TR6", file: "src/core/document/Tilemap.ts",
      from: "    if (m.terrain !== undefined && (m.tiles as number[]).some(t => t !== TILE_EMPTY)) {",
      to: "    if (m.terrain !== undefined && (m.tiles as number[]).every(t => t !== TILE_EMPTY)) {",
      note: "a file may carry a stored picture AND a derived one, which can disagree" },
    { id: "TR7", file: "src/core/document/Tilemap.ts",
      from: "    if (t.cells.length !== cells) {",
      to: "    if (t.cells.length > cells) {",
      note: "a SHORT terrain passes, and every row after the first reads from the wrong place" },
    { id: "TR8", file: "src/core/document/Tilemap.ts",
      from: "    if (!Number.isInteger(t.material) || (t.material as number) < 1) {",
      to: "    if (!Number.isInteger(t.material) || (t.material as number) < 0) {",
      note: "material 0 is allowed, so a layer autotiles the holes rather than the land" },

    // PLACING an object: the arithmetic between "what the file says" and "where the node goes".
    { id: "OP1", file: "src/core/import/TiledMap.ts",
      from: "                x: obj.x + minX, y: obj.y + minY,",
      to: "                x: obj.x, y: obj.y,",
      note: "a polygon's box ignores its own points, so any shape with a negative point shifts" },
    { id: "OP2", file: "src/core/import/TiledMap.ts",
      from: "            i === 0 ? { c: \"M\" as const, x: pt.x - minX, y: pt.y - minY }",
      to: "            i === 0 ? { c: \"M\" as const, x: pt.x, y: pt.y }",
      note: "the first command is not made relative to the derived box — the shape leaves the node" },
    { id: "OP3", file: "src/core/import/TiledMap.ts",
      from: '        if (obj.kind === "polygon") commands.push({ c: "Z" });',
      to: '        if (obj.kind === "polyline") commands.push({ c: "Z" });',
      note: "a polygon opens and a polyline closes — the only difference between the two, inverted" },
    { id: "OP4", file: "src/core/import/TiledMap.ts",
      from: "            rotation: base.rotation + t.rotation,",
      to: "            rotation: t.rotation,",
      note: "a tile object's own rotation is dropped for the tile's, so every turned entity is upright" },
    { id: "OP5", file: "src/core/import/TiledMap.ts",
      from: "            scaleX: t.scaleX, scaleY: t.scaleY",
      to: "            scaleX: 1, scaleY: t.scaleY",
      note: "the gid's mirror is lost, so a flipped entity faces the wrong way" },
    { id: "OP6", file: "src/core/actions/tileImport.ts",
      from: "            openGroup = id;",
      to: "            openGroup = null;",
      note: "an object layer's frame adopts nothing — every entity lands as a root, unfaded" },
    { id: "OP7", file: "src/core/actions/tileImport.ts",
      from: '        if (t.kind === "tilemap" || t.kind === "image") openGroup = null;',
      to: '        if (t.kind === "image") openGroup = null;',
      note: "an object AFTER a tile layer is adopted by the frame two layers up (the grid itself never was)" },
    { id: "OP8", file: "src/core/actions/tileImport.ts",
      from: '            if (t.shape !== "image") {',
      to: '            if (t.shape === "image") {',
      note: "a collision volume gets no stroke and no fill — a node that exists and draws nothing" },

    // EXPORTING a .tmx. The round trip is the oracle, so most of these are caught by reading the
    // file back with a parser that has only ever met files Tiled itself wrote.
    { id: "EX1", file: "src/core/export/ExportTiled.ts",
      from: "    let gid = index + firstGid;",
      to: "    let gid = index;",
      note: "the tileset's firstgid is dropped, so every exported tile is one place off in the sheet" },
    { id: "EX2", file: "src/core/export/ExportTiled.ts",
      from: "    if (index === TILE_EMPTY) return 0;",
      to: "    if (index === TILE_EMPTY) return firstGid;",
      note: "an empty cell exports as tile 0 — a map with no holes in it" },
    { id: "EX3", file: "src/core/export/ExportTiled.ts",
      from: "    return gid >>> 0;",
      to: "    return gid;",
      note: "a flipped gid stays SIGNED, so the file holds a negative number no reader accepts" },
    { id: "EX4", file: "src/core/export/ExportTiled.ts",
      from: "            const at = row * map.cols + col;\n            cells.push(String(encodeGid",
      to: "            const at = col * map.rows + row;\n            cells.push(String(encodeGid",
      note: "the CSV is written column-major — invisible on a square grid" },
    { id: "EX5", file: "src/core/export/ExportTiled.ts",
      from: "    for (let row = 0; row < map.rows; row++) {\n        const cells: string[] = [];",
      to: "    for (let row = 0; row < map.cols; row++) {\n        const cells: string[] = [];",
      note: "the row loop counts COLUMNS — invisible on a square grid" },
    { id: "EX6", file: "src/core/export/ExportTiled.ts",
      from: "            && m.tileWidth === first.tileWidth && m.tileHeight === first.tileHeight) return true;",
      to: "            && m.tileWidth === first.tileWidth) return true;",
      note: "a layer with a different cell HEIGHT is written anyway, into a map that cannot hold it" },
    { id: "EX7", file: "src/core/export/ExportTiled.ts",
      from: '    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")',
      to: '    return value.replace(/</g, "&lt;").replace(/>/g, "&gt;")',
      note: "an ampersand is written raw, so a layer named `A & B` produces a file that will not parse" },
    { id: "EX8", file: "src/core/export/ExportTiled.ts",
      from: "        if (l.opacity < 1) attrs.push(`opacity=\"${l.opacity}\"`);",
      to: "        if (l.opacity <= 1) attrs.push(`opacity=\"${l.opacity}\"`);",
      note: "every layer states an opacity, so a round trip through Tiled rewrites the whole file" },
    { id: "EX9", file: "src/core/export/ExportTiled.ts",
      from: "    const resolved = resolveTilemaps(doc);",
      to: "    const resolved = doc;",
      note: "an autotiled layer exports the empty grid it STORES rather than the picture it derives" },
    { id: "EX10", file: "src/core/import/TiledMap.ts",
      from: '    return value\n        .replace(/&lt;/g, "<")',
      to: '    return value\n        .replace(/&amp;/g, "&")\n        .replace(/&lt;/g, "<")',
      note: "the ampersand is undone FIRST, so `&amp;lt;` becomes markup the author escaped on purpose" },

    { id: "EX11", file: "src/core/export/ExportTiled.ts",
      from: '        attrs.push(`gid="${index + firstGid}"`, `x="${g.x}"`, `y="${g.y + g.height}"`,',
      to: '        attrs.push(`gid="${index + firstGid}"`, `x="${g.x}"`, `y="${g.y}"`,',
      note: "a tile object is written from its TOP-left, so every entity lands an object-height high" },
    { id: "EX12", file: "src/core/export/ExportTiled.ts",
      from: '        const tag = commands.some(c => c.c === "Z") ? "polygon" : "polyline";',
      to: '        const tag = commands.some(c => c.c === "Z") ? "polyline" : "polygon";',
      note: "a closed path exports as a polyline and an open one as a polygon — the two, swapped" },
    { id: "EX13", file: "src/core/export/ExportTiled.ts",
      from: "        if (written.length === 0) return;",
      to: "        if (written.length === -1) return;",
      note: "a group whose every object was refused writes an EMPTY objectgroup, which reads as a layer somebody emptied" },
    { id: "EX14", file: "src/core/export/ExportTiled.ts",
      from: '`width="${g.width}"`, `height="${g.height}"`);\n        if (rotation !== 0)',
      to: '`width="${g.width}"`, `height="${g.height}"`);\n        if (rotation === 0)',
      note: "a tile object never states its rotation, so every turned entity exports upright" },

    // THE SHADERS, which nothing in the gate compiles: tsc sees a string, the bundler sees a string,
    // jest sees a string, and the first reader that knows the language is a driver on a machine
    // somewhere. An identifier named `packed` — reserved in GLSL ES 1.00 — turned the whole GPU
    // backend off silently for months. This is the guard that would have caught it on day one.
    { id: "RW1", file: "src/renderer/emitWebGL.ts",
      from: "        vec4 cellTexel = texture2D(u_tileIndex, (cell + 0.5) / u_tileGrid.xy);",
      to: "        vec4 packed = texture2D(u_tileIndex, (cell + 0.5) / u_tileGrid.xy);",
      note: "a shader declares a GLSL ES 1.00 RESERVED WORD — the GPU path dies, silently" },
    { id: "RW2", file: "src/renderer/emitWebGL.ts",
      from: '    return (log ?? "no log").replace(/[\\u0000-\\u001f]+/g, " ").trim() || "no log";',
      to: '    return (log ?? "no log").trim() || "no log";',
      note: "a driver's NUL terminator survives into the tooltip, so the reason reads as corruption" },
    { id: "MK11", file: "src/editor/tools/RasterTool.ts",
      from: "        const mirror: StrokeSession = { ...s.stroke, points: [from] };",
      to: "        const mirror: StrokeSession = { ...s.stroke, points: [from], clip: undefined };",
      note: "a symmetry mirror escapes the selection — paint where the author is not pointing" },
    // THE RECTANGLE GESTURE (2026-08-10). Its shape differs from every other tool here in one
    // way — it recomputes from the map as it was at the PRESS — and that is the part a convenient
    // fixture cannot see, because a rectangle only ever dragged outward looks identical either way.
    { id: "RC1", file: "src/editor/tools/TileTool.ts",
      from: "const next = this.edited(rect.base, cells) ?? rect.base;",
      to: "const next = this.edited(doc.nodes.get(nodeId)!.tilemap!, cells) ?? rect.base;",
      note: "each frame paints onto the LIVE map, so a rectangle pulled back in keeps the high-water mark and can only grow" },
    { id: "RC2", file: "src/editor/tools/TileTool.ts",
      from: "const corner = this.cellUnder(e, canvasRect, nodeId, true);",
      to: "const corner = this.cellUnder(e, canvasRect, nodeId, false);",
      note: "the far corner is asked for strictly, so a drag off the map freezes in BOTH axes and the last column cannot be filled" },
    { id: "RC3", file: "src/editor/tools/TileTool.ts",
      from: "if (rect && rect.dispatched && rect.netZero) {",
      to: "if (rect && rect.dispatched && !rect.netZero) {",
      note: "the release throws away a rectangle that painted something and keeps the undo step of one that painted nothing" },
    { id: "RC4", file: "src/editor/tools/TileTool.ts",
      from: "new SetTilemapAction(doc, nodeId, next), { coalesce: rect.dispatched }",
      to: "new SetTilemapAction(doc, nodeId, next), { coalesce: false }",
      note: "every frame of the drag is its own undo step — undoing one rectangle takes as many presses as the pointer had samples" },
    { id: "RC5", file: "src/editor/tools/TileTool.ts",
      from: "        if (!result.success) return;\n        rect.dispatched = true;",
      to: "        rect.dispatched = true;\n        if (!result.success) return;",
      note: "a REFUSED first frame still opens the step, so the rectangle coalesces into whatever the author did before it" },
    // ESCAPE'S ROUTING (2026-08-10). Found live, after the rectangle's own Escape test passed in
    // jest and did nothing in the app: `deselect` stands aside only when NOTHING is selected, and a
    // cancellable gesture always has a selection, so the shortcut consumed every press and no tool
    // ever saw the key. Seven tools had a dead Escape branch.
    { id: "EK1", file: "src/app/App.tsx",
      from: "                if (e.key === \"Escape\") {\n                    toolController.onKeyDown(e);\n                    if (e.defaultPrevented) return;",
      to: "                if (e.key === \"Escape\") {\n                    if (e.defaultPrevented) return;",
      note: "Escape is never offered to the active tool, so every cancel in the app is unreachable again" },
    { id: "EK2", file: "src/app/App.tsx",
      from: "                    if (e.defaultPrevented) return;\n                    const cancel = resolveShortcut(e);",
      to: "                    if (!e.defaultPrevented) return;\n                    const cancel = resolveShortcut(e);",
      note: "a tool that CLAIMED the press is then also deselected, and one that declined it is not" },
    { id: "EK3", file: "src/editor/tools/TileTool.ts",
      from: "        this.rect = null;\n        e.preventDefault();",
      to: "        this.rect = null;",
      note: "the rectangle cancels without claiming the press, so Escape also deselects — the cancel works in a test and not in the app" },
    { id: "EK4", file: "src/editor/tools/TileTool.ts",
      from: "        if (e.key !== \"Escape\" || !this.rect) return;",
      to: "        if (e.key === \"Escape\") e.preventDefault();\n        if (e.key !== \"Escape\" || !this.rect) return;",
      note: "Escape is claimed with no gesture in flight, so the key stops deselecting whenever the tile tool is active" },

    // AUTHORED METADATA (schema 64). The corpus evidence is thin on purpose — all 41 real
    // properties live in ONE file, where every float is `1`, every bool is `true` and every string
    // is `static`. So these aim at what that file cannot see.
    { id: "UD1", file: "src/core/import/TiledMap.ts",
      from: "        const { inner, end } = takeElement(body, re.lastIndex, \"property\");\n        re.lastIndex = end;",
      to: "        const { inner } = takeElement(body, re.lastIndex, \"property\");",
      note: "the scan resumes INSIDE a class property, so its members read as the object's own siblings — a member named friction overwrites the real one and is written back out as a property nobody wrote" },
    { id: "UD2", file: "src/core/import/TiledMap.ts",
      from: "if (variantNameError(\"name\", p.name, true) !== null) {",
      to: "if (variantNameError(\"name\", p.name, false) !== null) {",
      note: "a property named __proto__ passes the import gate, so the map it builds is one the loader refuses — and because import is a transaction, that aborts the whole file rather than dropping one property" },
    { id: "UD3", file: "src/core/actions/applyMutations.ts",
      from: "                    if (delta.userData === null || Object.keys(delta.userData).length === 0) {",
      to: "                    if (delta.userData === null) {",
      note: "an empty property map is STORED, so every object this engine imports carries an empty userData field that means nothing" },
    { id: "UD4", file: "src/core/export/ExportTiled.ts",
      from: "        if (p.type !== \"string\") a.push(`type=\"${escapeXml(p.type)}\"`);",
      to: "        a.push(`type=\"${escapeXml(p.type)}\"`);",
      note: "the format's DEFAULT type is written back explicitly, so an exported file no longer looks like one a person would have written" },
    { id: "UD5", file: "src/core/export/ExportTiled.ts",
      from: "            notes.push(`${owner} property \"${name}\" holds a character XML cannot carry, and was not written`);\n            continue;",
      to: "            notes.push(`${owner} property \"${name}\" holds a character XML cannot carry, and was not written`);",
      note: "a value XML cannot carry is COUNTED and then written anyway, which produces a file no reader will open" },
    { id: "UD6", file: "src/core/export/ExportTiled.ts",
      from: "            xml: body === \"\" ? `  <object ${attrs.join(\" \")}/>`",
      to: "            xml: false ? `  <object ${attrs.join(\" \")}/>`",
      note: "an object with nothing inside is written as an empty <object></object> pair rather than self-closing" },

    // THE CAVE GENERATOR. Every one of these produces a cave that still looks like a cave — which
    // is the whole difficulty: the rule has three equivalent phrasings and two misreadings that
    // differ from it by one character, and none of them throws.
    { id: "CV1", file: "src/core/document/CaveTerrain.ts",
      from: "                        if (dr === 0 && dc === 0) continue;",
      to: "                        if (dr === 0 && dc === 0 && false) continue;",
      note: "the cell counts itself, so the rule stops being self-dual and grows rock on every pass" },
    { id: "CV2", file: "src/core/document/CaveTerrain.ts",
      from: "                        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) { n++; continue; }",
      to: "                        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) { continue; }",
      note: "off the grid counts as FLOOR, so the cave erodes outward instead of being closed by the edge" },
    { id: "CV3", file: "src/core/document/CaveTerrain.ts",
      from: "const DEFAULTS = { fill: 0.45, passes: 5, margin: 2, connect: true };",
      to: "const DEFAULTS = { fill: 0.45, passes: 5, margin: 1, connect: true };",
      note: "one ring of rock instead of two, so the dual grid's outermost drawable ring is never full and the map has a ragged fringe" },
    { id: "CV4", file: "src/core/document/CaveTerrain.ts",
      from: "                next[r * cols + c] = cur[r * cols + c] + n >= 5 ? 1 : 0;",
      to: "                next[r * cols + c] = cur[r * cols + c] + n > 5 ? 1 : 0;",
      note: "the threshold is off by one, which dissolves the rock instead of coarsening it" },
    { id: "CV5", file: "src/core/document/CaveTerrain.ts",
      from: "    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;",
      to: "    for (let i = 1; i < sizes.length; i++) if (sizes[i] < sizes[best]) best = i;",
      note: "the SMALLEST pocket is kept and the cave filled in — still one region, still connected, and unplayable" },
    { id: "CV7", file: "src/core/document/CaveTerrain.ts",
      from: "        cells[i] = cur[i] === 1 ? material : 0;",
      to: "        cells[i] = cur[i] === 1 ? 1 : 0;",
      note: "the automaton's working value is stored instead of the material, so a layer drawing material 3 fills with 1s it cannot see" },
];

function runSuite() {
    try {
        return execSync("npx jest --config=./jest.config.js 2>&1",
            { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
        return (e.stdout || "") + (e.stderr || "");
    }
}

function verdict(out) {
    const total = Number((/Tests:.*?(\d+) total/.exec(out) || [])[1] || 0);
    if (total < EXPECTED_TESTS) return { v: "UNVERIFIED (did not compile?)", total, ok: false };
    const failed = (/Tests:.*?(\d+) failed/.exec(out) || [])[1];
    return { v: failed ? `KILLED (${failed} failing)` : "SURVIVED", total, ok: !!failed };
}

const dirty = execSync("git status --porcelain", { cwd: ROOT, encoding: "utf8" }).trim();
if (dirty) {
    console.error("Refusing to run: the tree has uncommitted changes.\n" + dirty);
    process.exit(2);
}

/**
 * ONE FAMILY AT A TIME — `MUTANT_ONLY=^OL npm run mutate:dimensions`.
 *
 * A full run is a full suite per mutant, so it is ~20 minutes; fixing one survivor and re-running
 * all 105 to check the fix is a bad trade, and the alternative reached for the first time was
 * commenting out the rest of the array by hand — which is how a battery loses a mutant permanently.
 *
 * A FILTERED RUN SAYS SO IN ITS SUMMARY, loudly, because that line is what gets copied into
 * docs/TESTING.md: "6/6 killed" from a filtered run would be a true sentence about a false thing.
 */
const only = process.env.MUTANT_ONLY ? new RegExp(process.env.MUTANT_ONLY) : null;
const selected = only ? MUTANTS.filter(m => only.test(m.id)) : MUTANTS;
if (only && selected.length === 0) {
    console.error(`No mutant id matches ${process.env.MUTANT_ONLY}`);
    process.exit(2);
}

/**
 * How many times a mutant's `from` occurs in its file — 0 is NOT APPLIED, more than 1 is AMBIGUOUS.
 *
 * Shared by the pre-flight and the run so the two cannot disagree about what matches, including the
 * line-ending normalisation that has already cost five guards.
 */
function matchCount(mut) {
    const source = fs.readFileSync(path.join(ROOT, mut.file), "utf8").replace(/\r\n/g, "\n");
    return source.split(mut.from).length - 1;
}

/**
 * `MUTANT_CHECK=1 npm run mutate:dimensions` — do every mutant still MATCH? No tests, ~a second.
 *
 * A full run is twenty minutes, and until now that was also how long it took to learn that a `from`
 * had drifted out from under the code it guards. Which is backwards: NOT APPLIED is the verdict a
 * refactor causes, so the moment to find it is right after the refactor, not after a battery. Three
 * mutants (TT2, SS5, RW2) were re-authored in one sitting for exactly this, each discovered late.
 *
 * The run below keeps its own checks — this exits before reaching them, so they stay live for a
 * file that changes underfoot, and both ask `matchCount`.
 */
if (process.env.MUTANT_CHECK) {
    const bad = selected
        .map(mut => ({ mut, n: matchCount(mut) }))
        .filter(({ n }) => n !== 1);
    for (const { mut, n } of bad) {
        console.log(`${mut.id}  ${n === 0 ? "NOT APPLIED" : `AMBIGUOUS (${n} sites)`} — ${mut.file}`);
    }
    console.log(`\n${selected.length - bad.length}/${selected.length} mutants still match their code.`);
    process.exit(bad.length > 0 ? 1 : 0);
}

let survivors = 0;
for (const mut of selected) {
    const file = path.join(ROOT, mut.file);
    const original = fs.readFileSync(file, "utf8");
    // LINE ENDINGS ARE NOT PART OF A MUTATION, and this is subtler than it looks. Every `from`
    // below is written with `\n`; a file NEWLY WRITTEN in the working tree is LF and matches, and
    // the same file after a clone or checkout is CRLF and does not. So a two-line mutation works
    // the day it is added and silently stops working later — reported as NOT APPLIED, the verdict
    // that is neither a kill nor a survivor. That has already cost five guards across two sittings.
    // Matching a normalised copy is the fix; the file is restored from `original`, so the
    // normalisation never outlives the run.
    const source = original.replace(/\r\n/g, "\n");
    const occurrences = source.split(mut.from).length - 1;
    if (occurrences === 0) {
        // NOT a survivor and NOT a kill: the code moved out from under the mutation, so the
        // battery is testing nothing. Re-author it against the code as it now stands.
        console.log(`${mut.id}  NOT APPLIED — 'from' no longer matches ${mut.file}`);
        survivors++;
        continue;
    }
    if (occurrences > 1) {
        // AMBIGUOUS — the verdict this harness was missing, and the worse of the two. `String.replace`
        // takes the FIRST match, so a `from` that appears twice mutates whichever site comes first
        // while its note goes on describing the other. Not hypothetical: reading object layers gave
        // `visible: a.visible === undefined ? ...` a second home, and TM4 silently re-aimed from a
        // tile layer to an object — still reporting a kill, for a guard nothing was testing.
        console.log(`${mut.id}  AMBIGUOUS — 'from' matches ${occurrences} places in ${mut.file}; `
            + "add context so it names one");
        survivors++;
        continue;
    }
    fs.writeFileSync(file, source.replace(mut.from, mut.to), "utf8");
    let res;
    try { res = verdict(runSuite()); } finally { fs.writeFileSync(file, original, "utf8"); }
    if (!res.ok) survivors++;
    console.log(`${mut.id}  ${res.v.padEnd(28)} (${res.total} tests)  ${mut.note}`);
}

console.log(`\n${selected.length - survivors}/${selected.length} killed.`
    + (only ? `  — PARTIAL RUN (MUTANT_ONLY=${process.env.MUTANT_ONLY}); the battery holds ${MUTANTS.length}.` : ""));
process.exit(survivors > 0 ? 1 : 0);
