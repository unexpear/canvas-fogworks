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
const EXPECTED_TESTS = 1604;

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
    { id: "SS5", file: "src/core/paint/SurfaceSpace.ts",
      from: "const u = (sx + 0.5) / space.surfaceWidth;",
      to: "const u = sx / space.surfaceWidth;",
      note: "names a pixel's CORNER, not its centre — invisible to a round-trip-only assertion" },
    { id: "SS6", file: "src/core/paint/SurfaceSpace.ts",
      from: "    const p = applyToPoint(inv, worldX, worldY);",
      to: "    const p = applyToPoint(space.world, worldX, worldY);",
      note: "transforms FORWARD instead of inverting — invisible under an identity matrix" },

    // TiledMap — a layer's offset. The convenient fixture is a map where the two axes are equal,
    // or where one is absent, or where the layer offset and the tileset's tileoffset agree.
    { id: "TM1", file: "src/core/import/TiledMap.ts",
      from: "            offsetX: num(a.offsetx, 0),",
      to: "            offsetX: num(a.offsety, 0),",
      note: "layer offset reads the wrong axis — invisible when a map offsets only one axis" },
    { id: "TM2", file: "src/core/import/TiledMap.ts",
      from: "            offsetY: num(a.offsety, 0),",
      to: "            offsetY: num(a.offsety, undefined as unknown as number),",
      note: "an absent layer offset becomes undefined, not 0 — invisible unless a map omits it" },
    { id: "TM3", file: "src/core/import/TiledMap.ts",
      from: '    if (order !== "right-down") {',
      to: '    if (order === "right-down") {',
      note: "the render-order note fires on the DEFAULT — invisible if only one order is ever tested" },
    { id: "TM4", file: "src/core/import/TiledMap.ts",
      from: "visible: a.visible === undefined ? true : num(a.visible, 1) !== 0,",
      to: "visible: a.visible !== undefined,",
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
      from: "opacity: Math.min(1, Math.max(0, num(a.opacity, 1))),",
      to: "opacity: num(a.opacity, 1),",
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
      from: "    const row = Math.floor(y / map.tileHeight);",
      to: "    const row = Math.round(y / map.tileHeight);",
      note: "a cell is picked by ROUNDING — every boundary picks its neighbour" },
    { id: "TE5", file: "src/core/document/Tilemap.ts",
      from: "    const col = Math.floor(x / map.tileWidth);",
      to: "    const col = Math.floor(x / map.tileHeight);",
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
      from: "        return cellAt(map, local.x, local.y);",
      to: "        return cellAt(map, w.x, w.y);",
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
    { id: "MK11", file: "src/editor/tools/RasterTool.ts",
      from: "        const mirror: StrokeSession = { ...s.stroke, points: [from] };",
      to: "        const mirror: StrokeSession = { ...s.stroke, points: [from], clip: undefined };",
      note: "a symmetry mirror escapes the selection — paint where the author is not pointing" },
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

let survivors = 0;
for (const mut of MUTANTS) {
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
    if (!source.includes(mut.from)) {
        // NOT a survivor and NOT a kill: the code moved out from under the mutation, so the
        // battery is testing nothing. Re-author it against the code as it now stands.
        console.log(`${mut.id}  NOT APPLIED — 'from' no longer matches ${mut.file}`);
        survivors++;
        continue;
    }
    fs.writeFileSync(file, source.replace(mut.from, mut.to), "utf8");
    let res;
    try { res = verdict(runSuite()); } finally { fs.writeFileSync(file, original, "utf8"); }
    if (!res.ok) survivors++;
    console.log(`${mut.id}  ${res.v.padEnd(28)} (${res.total} tests)  ${mut.note}`);
}

console.log(`\n${MUTANTS.length - survivors}/${MUTANTS.length} killed.`);
process.exit(survivors > 0 ? 1 : 0);
