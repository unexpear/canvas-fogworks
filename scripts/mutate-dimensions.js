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
const os = require("os");

// DECLARED HERE, ABOVE EVERY USE, and that is not tidiness: `restorePendingMutation` is
// called before the dirty-tree check near the top of this file, and a `const` declared
// further down is in its temporal dead zone at that moment. The script threw on every run
// and `node --check` passed, because it is a runtime fault and not a syntax one.
/** The page a browser tab watches — see `writeProgressPage`. */
const PROGRESS_PAGE = path.join(os.tmpdir(), "vde-mutation-progress.html");
/** Written before a file is mutated and deleted after it is restored — see `restorePendingMutation`. */
const PENDING = path.join(os.tmpdir(), "vde-mutation-pending.json");

const ROOT = path.resolve(__dirname, "..");

/** The suite's size. Anything less means the mutant did not compile. */
const EXPECTED_TESTS = 1814;

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
      from: "    const cols = terrain.cols + 1;\n    const rows = terrain.rows + 1;\n    const tiles: number[] = new Array(cols * rows);",
      to: "    const cols = terrain.cols;\n    const rows = terrain.rows + 1;\n    const tiles: number[] = new Array(cols * rows);",
      note: "the display grid is NOT one larger — the last terrain column is never fully drawn" },
    { id: "AT5", file: "src/core/document/Autotile.ts",
      from: "        if (c < 0 || r < 0 || c >= terrain.cols || r >= terrain.rows) return false;",
      to: "        if (c < 0 || r < 0 || c >= terrain.cols || r >= terrain.rows) return true;",
      note: "off the terrain counts AS the material — no coastline at the map's edge" },
    { id: "AT6", file: "src/core/document/Autotile.ts",
      from: "    // keeps — a derived grid that always carried a flip array would break it from the other side.\n    return turned ? { cols, rows, tiles, flips } : { cols, rows, tiles };",
      to: "    // keeps — a derived grid that always carried a flip array would break it from the other side.\n    return { cols, rows, tiles, flips };",
      note: "flips always present — the absent-when-unturned invariant, broken from the derived side" },
    { id: "MM6", file: "src/core/document/Autotile.ts",
      from: "            if (flip !== 0) turned = true;\n        }\n    }\n    return turned ? { cols, rows, tiles, flips } : { cols, rows, tiles };",
      to: "            if (flip !== 0) turned = true;\n        }\n    }\n    return { cols, rows, tiles, flips };",
      note: "the COMPOSITED grid always carries flips, so a multi-material layer breaks the same invariant its single-material twin keeps" },
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
      from: "        if (am.art.length !== bm.art.length) return false;",
      to: "        if (am.art.length !== bm.art.length) return true;",
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
      from: "    if (slot >= 0 && art[slot].index === index) return null;",
      to: "    if (slot >= 0) return null;",
      note: "a class's tile can never be REASSIGNED, so the six pickers are write-once" },
    { id: "TB7", file: "src/core/document/TilemapEdit.ts",
      from: "    const next = rebuild(map, new Array(map.cols * map.rows).fill(TILE_EMPTY), null);",
      to: "    const next = rebuild(map, map.tiles.slice(), null);",
      note: "becoming a terrain layer keeps its tiles, which `tilemapError` then refuses" },
    { id: "TB8", file: "src/core/document/TilemapEdit.ts",
      from: "        id: m.id,\n        ...(m.name !== undefined",
      to: "        id: 0,\n        ...(m.name !== undefined",
      note: "terrain survives an unrelated edit with its material reset to the ERASER" },

    { id: "TR5", file: "src/core/document/Components.ts",
      from: "            { cols: map.cols, rows: map.rows, cells: terrain.cells },",
      to: "            { cols: map.rows, rows: map.cols, cells: terrain.cells },",
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
      from: "        if (!Number.isInteger(m.id) || (m.id as number) < 1) {",
      to: "        if (!Number.isInteger(m.id) || (m.id as number) < 0) {",
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

    // THE .unitypackage READER. Seven real packages parse with no notes, which is exactly why the
    // tests build their own archive: every entry Unity writes is alphabetical, so the real files
    // cannot reach half of these branches.
    { id: "UP1", file: "src/core/import/UnityPackage.ts",
      from: "    if (!Number.isFinite(stated) || stated !== sum) return \"corrupt\";",
      to: "    if (!Number.isFinite(stated)) return \"corrupt\";",
      note: "a corrupt header is read as a valid one, so a truncated archive becomes a very strange package instead of a reported one" },
    { id: "UP2", file: "src/core/import/UnityPackage.ts",
      from: "        sum += (i >= at + 148 && i < at + 156) ? 0x20 : bytes[i];",
      to: "        sum += bytes[i];",
      note: "the checksum counts its own field instead of spaces, so every header in every archive fails" },
    { id: "UP4", file: "src/core/import/UnityPackage.ts",
      from: "    assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));",
      to: "    assets.sort((a, b) => (a.path > b.path ? -1 : a.path < b.path ? 1 : 0));",
      note: "the listing comes out reversed, so a diff of what a package holds shows changes that are not there" },

    // THE VIEWPORT PAIR. The defect these guard was live and shipped: offsets moving linearly under
    // a geometric zoom swing the focused point out and back, by MORE the further from the world
    // origin — and the test that covered it used a viewport at the origin, where it is exactly zero.
    { id: "VP1", file: "src/editor/EditorState.ts",
      from: "        x: zoom * (ax + (bx - ax) * k) - halfW,",
      to: "        x: a.x + (b.x - a.x) * k,",
      note: "the offsets go back to moving linearly under a geometric zoom, so the focused point bows away and returns — 430px at world x=5000, and 0px at the origin where the old fixture sat" },
    { id: "VP2", file: "src/editor/EditorState.ts",
      from: "    const bx = (halfW + b.x) / b.zoom, by = (halfH + b.y) / b.zoom;",
      to: "    const bx = (halfW + b.x) / a.zoom, by = (halfH + b.y) / a.zoom;",
      note: "the destination's focus is measured at the SOURCE's zoom, so a navigation ends somewhere else entirely" },
    { id: "VP3", file: "src/editor/EditorState.ts",
      from: "    if (!(a.zoom > 0) || !(b.zoom > 0)) return { x: b.x, y: b.y, zoom: b.zoom };",
      to: "    if (!(a.zoom > 0) && !(b.zoom > 0)) return { x: b.x, y: b.y, zoom: b.zoom };",
      note: "one non-positive zoom slips past the guard, and dividing by it puts NaN in the viewport — a blank canvas with nothing to say why" },
    { id: "VP4", file: "src/editor/EditorState.ts",
      from: "        x: zoom * worldX - vp.x + canvasRect.left,",
      to: "        x: zoom * worldX + vp.x + canvasRect.left,",
      note: "worldToScreen adds the viewport instead of subtracting it, so it is no longer screenToWorld's inverse and the round trip lands at twice the offset" },
    { id: "VP5", file: "src/editor/EditorState.ts",
      from: "export function worldToScreen(\n    vp: EditorState[\"viewport\"],\n    canvasRect: { left: number; top: number },\n    worldX: number,\n    worldY: number\n): { x: number; y: number } {\n    const zoom = Math.max(0.01, vp.zoom);",
      to: "export function worldToScreen(\n    vp: EditorState[\"viewport\"],\n    canvasRect: { left: number; top: number },\n    worldX: number,\n    worldY: number\n): { x: number; y: number } {\n    const zoom = vp.zoom;",
      note: "the zoom floor stops matching its inverse's, so the round trip fails below 0.01 for a reason that has nothing to do with either function" },

    // THE UNITY DOOR. A reader with no caller is not a feature — this is the pair that opens it,
    // and the confinement is the part a panel cannot be trusted to respect.
    { id: "UD7", file: "src/electron/main.js",
      from: "    const target = resolveConfined(folder, folder, filePath, \"a package\");",
      to: "    const target = path.resolve(filePath);",
      note: "a package path escapes the folder the user picked, so anything on disk named .unitypackage can be read. RETARGETED: this mutated the INLINE prefix check, which moved into confine.js when a directory junction was found to walk straight through it — same defect, different home" },
    { id: "UD8", file: "src/electron/preload.js",
      from: "    gunzipSync: (base64) => ipcRenderer.sendSync(\"gunzip-sync\", base64),",
      to: "    gunzipSyncMissing: (base64) => ipcRenderer.sendSync(\"gunzip-sync\", base64),",
      note: "the gzip channel is not exposed, so the panel is a button that cannot open anything" },

    // MULTI-MATERIAL TERRAIN (schema 65). Every one of these still draws a plausible map — which is
    // the difficulty: the rule is about what happens WHERE TWO MATERIALS MEET, and a fixture whose
    // materials never touch cannot see any of them.
    { id: "MM1", file: "src/core/document/Autotile.ts",
      from: "            if (layer.tiles[at] === TILE_EMPTY) continue;",
      to: "            if (layer.tiles[at] === TILE_EMPTY && false) continue;",
      note: "a later material's EMPTY cells overwrite an earlier one's tiles, so only the last material drawn survives anywhere" },
    { id: "MM2", file: "src/core/document/Autotile.ts",
      from: "    for (const material of materials) {\n        const table = rotatedTable",
      to: "    for (const material of [...materials].reverse()) {\n        const table = rotatedTable",
      note: "paint order is reversed, so the material an author put on top is drawn underneath at every shore" },
    { id: "MM3", file: "src/core/document/Tilemap.ts",
      from: "        if (seen.has(m.id as number)) return `terrain material ${m.id} appears more than once`;",
      to: "        if (false) return `terrain material ${m.id} appears more than once`;",
      note: "one id may appear twice, so a cell has two answers about which art draws it and paint order cannot break the tie" },
    { id: "MM4", file: "src/core/actions/SetTilemapAction.ts",
      from: "        if (am.id !== bm.id) return false;",
      to: "        if (false) return false;",
      note: "REORDERING materials reads as a no-op, so the one edit that redraws every shore without touching a cell is refused" },
    { id: "MM5", file: "src/core/document/Serializer.ts",
      from: "        if (!terrain || terrain.materials !== undefined) { out[id] = node; continue; }",
      to: "        if (!terrain) { out[id] = node; continue; }",
      note: "an ALREADY-migrated terrain is migrated again, wrapping its material list in a material whose id is undefined" },

    // A MATERIAL'S NAME AND SWATCH (schema 66). Nothing derives from either, which is exactly why
    // they are easy to drop: the picture is identical whether they survive an edit or not.
    { id: "MN1", file: "src/core/document/TilemapEdit.ts",
      from: "        ...(m.name !== undefined ? { name: m.name } : {}),",
      to: "",
      note: "a material's NAME is dropped by the one function that copies one, so every edit that is not about it quietly erases it" },
    { id: "MN2", file: "src/core/document/TilemapEdit.ts",
      from: "        ...(m.color !== undefined ? { color: m.color } : {}),",
      to: "        color: m.color,",
      note: "an ABSENT swatch is written as undefined, which does not round-trip through JSON as a material that never had one" },
    { id: "MN3", file: "src/core/actions/SetTilemapAction.ts",
      from: "        if (am.name !== bm.name || am.color !== bm.color) return false;",
      to: "",
      note: "renaming a material, or picking a new swatch, reads as a no-op — the panel moves and the document does not" },
    { id: "MN4", file: "src/core/document/Tilemap.ts",
      from: "        if (m.color !== undefined && (typeof m.color !== \"string\" || !TERRAIN_COLOR.test(m.color))) {",
      to: "        if (m.color !== undefined && typeof m.color !== \"string\") {",
      note: "any string is accepted as a colour, so a swatch the panel cannot show is stored and the control silently falls back" },

    // THE VARIANT BRUSH. Every one of these still paints a stroke — what changes is WHICH face each
    // dab uses, which no test that only asks "did paint land" can see.
    { id: "BF1", file: "src/core/paint/Stroke.ts",
      from: "        () => rollAt(session.seed, at++));",
      to: "        () => rollAt(session.seed, at));",
      note: "every dab of a segment draws the SAME index, so a variant brush stamps one face for the whole stroke" },
    { id: "BF2", file: "src/core/paint/Stroke.ts",
      from: "        seed: seedFrom(`${x},${y}`),",
      to: "        seed: 0,",
      note: "every stroke shares one seed, so two different drags lay the identical sequence of faces" },
    { id: "BF3", file: "src/core/paint/Stroke.ts",
      from: "    let at = session.dabs;",
      to: "    let at = 0;",
      note: "each segment restarts the index, so a stroke repeats its first faces every time the pointer moves" },
    { id: "BF4", file: "src/core/paint/Brush.ts",
      from: "    const face = brush.variants.length > 0 && roll",
      to: "    const face = roll",
      note: "a brush with no variants consumes a roll anyway, so adding a face shifts every later dab of every stroke" },
    { id: "BF5", file: "src/core/random/Rng.ts",
      from: "    let h = (Math.imul(index, 0x9E3779B9) ^ seed) | 0;",
      to: "    let h = (index + seed) | 0;",
      note: "(seed, index) collapses to their SUM, so dab 5 of one stroke and dab 0 of a stroke seeded five higher are the same draw" },
    // THE EXPANDER. It threw away art the document was already allowed to hold: given a tile for all
    // sixteen masks it kept six, and WHICH six depended on the order of the stored array.
    { id: "RT1", file: "src/core/document/Autotile.ts",
      from: "        if (had) { if (!had.some(c => c.index === index)) had.push({ index }); }\n        else table[mask] = [{ index }];",
      to: "        table[mask] = [{ index }];",
      note: "the exact-entry pass stops accumulating, so a mask keeps only its LAST drawn tile — which is what the Map it replaced did, discarding an artist's variants at the door. RETARGETED: the pass builds a LIST per mask now, since a real set ships 185 tiles for 74 configurations" },
    { id: "RT2", file: "src/core/document/Autotile.ts",
      from: "        .sort((a, b) => a.mask - b.mask);",
      to: "        ;",
      note: "gap-filling follows the STORED order again, so the same art in a different array order draws a different map" },

    // THE EXPORTER, once a document could hold more than one tileset. Every one of these still
    // writes a `.tmx` that PARSES and opens in Tiled — what changes is which picture a cell draws
    // from, which is why the fixtures re-IMPORT the file and ask `tilemapForLayer` rather than
    // reading the XML back with a regex.
    { id: "EX15", file: "src/core/export/ExportTiled.ts",
      from: "+ tilemapCsv(l.map, gidOf.get(l.map.tilesetId) ?? 1)",
      to: "+ tilemapCsv(l.map, 1)",
      note: "every layer's cells are numbered from the FIRST set's firstgid — the exact bug this change closed: right places, wrong pictures" },
    { id: "EX16", file: "src/core/export/ExportTiled.ts",
      from: "        const mine = fitting.filter(x => x.map.tilesetId === l.map.tilesetId);",
      to: "        const mine = fitting;",
      note: "a set's tilecount is the highest index anywhere in the MAP, so a small set inherits a large one's count and every set after it starts at the wrong gid" },
    { id: "EX17", file: "src/core/export/ExportTiled.ts",
      from: "        if (gidOf.has(l.map.tilesetId)) return true;",
      to: "        if (gidOf.has(l.name)) return true;",
      note: "a set is entered once per LAYER rather than once per set, so one tileset is written twice and everything after it is renumbered" },
    { id: "EX18", file: "src/core/export/ExportTiled.ts",
      from: "        const firstGid = used.reduce((n, u) => n + u.tileCount, 1);",
      to: "        const firstGid = 1;",
      note: "every set claims firstgid 1, so their gid ranges overlap and a reader resolves every cell to the first set" },
    { id: "EX19", file: "src/core/export/ExportTiled.ts",
      from: "    const setFor = (src: string | undefined) => used.find(u => u.set.src === src) ?? used[0];",
      to: "    const setFor = (src: string | undefined) => used.find(u => u.set.id === src) ?? used[0];",
      note: "a tile object's picture is matched against the set's ID instead of its src, so every object falls back to the first set and draws the wrong tile" },
    { id: "EX20", file: "src/core/export/ExportTiled.ts",
      from: "            image: used.length === 0 ? image : `${safeFileName(set.name)}.png`",
      to: "            image: used.length < 1 ? image : `${safeFileName(set.name)}.png`",
      note: "THE CONTROL — an equivalent rewrite that SHOULD survive. A run where everything dies cannot tell a real kill from a harness that fails every time" },
    // THE SHEET CHECK ITSELF CANNOT BE MUTATED, and that is a finding rather than a gap: `!set` in
    // place of `!set?.sheet` does not COMPILE, because `Tileset.sheet` is `TileSheet | null` and
    // `used[]` cannot be built from a set without one. tsc enforces the guard's existence, so what
    // needs a fixture is the REASON — a silent drop is the failure this codebase keeps finding.
    { id: "EX21", file: "src/core/export/ExportTiled.ts",
      from: "            notes.push(`layer \"${l.name}\" draws from a tileset with no sheet to write `\n                + \"(a collection tileset, or an id naming nothing), so it was not written\");\n            return false;",
      to: "            return false;",
      note: "a layer whose tileset has no sheet is dropped IN SILENCE, so a collection-set layer leaves the export with nothing said and the .tmx simply lacks it" },
    // A COLLECTION TILESET DRAWN (schema 67, built at 68). Every one of these still draws a picture
    // in every cell — what changes is WHICH picture, or WHERE. The family exists because the
    // anchoring is the kind of arithmetic that reads as bad art rather than as a bug.
    { id: "CT1", file: "src/core/document/Tilemap.ts",
      from: "        y: originY + row * map.tileHeight + map.tileHeight - picture.height,",
      to: "        y: originY + row * map.tileHeight,",
      note: "a collection tile is TOP-aligned in its cell, so art three cells tall sinks through the floor instead of standing over the row behind it — invisible on any fixture whose tiles are exactly cell-sized" },
    { id: "CT2", file: "src/renderer/RenderModel.ts",
      from: "                pictures: tileset && tileset.sheet === null && tileset.tiles.length > 0",
      to: "                pictures: tileset && tileset.tiles.length > 0",
      note: "a SHEET-backed set with per-tile records (weights, which 25 corpus tiles carry) also resolves a pictures map, so the collection branch runs for a layer that has a sheet" },
    { id: "CT3", file: "src/renderer/emitCanvas.ts",
      from: "                            const m = flipMatrix(box.flip, box.width, box.height);",
      to: "                            const m = flipMatrix(box.flip, map.tileWidth, map.tileHeight);",
      note: "a turned collection cell is mirrored about the CELL's centre rather than the tile's, so a tall tile swings out of place — and a FLIP_H-only fixture cannot see it, because that term is the width either way" },
    { id: "CT4", file: "src/core/document/Tilemap.ts",
      from: "    const picture = pictures.get(index);\n    // A CELL NAMING A TILE THE SET DOES NOT HOLD DRAWS NOTHING",
      to: "    const picture = pictures.get(index) ?? pictures.values().next().value;\n    // A CELL NAMING A TILE THE SET DOES NOT HOLD DRAWS NOTHING",
      note: "a cell naming a tile the set does not hold falls back to the set's FIRST tile, so a sparse set (real ones skip ids) draws a plausible wrong picture instead of nothing" },

    // THE RUNTIME (M18). Every one of these still runs a world and still draws a falling body —
    // what changes is where it ends up, or how fast it got there, which is the class of defect a
    // "does it move" assertion cannot see.
    { id: "RN1", file: "src/core/runtime/World.ts",
      from: "        let vy = was.vy + gravity * FIXED_STEP;",
      to: "        let vy = was.vy + gravity;",
      note: "gravity is applied per STEP rather than per second, so the world falls sixty times too fast and a jump height depends on the step size — the exact mistake a fixed timestep exists to prevent" },
    { id: "RN2", file: "src/core/runtime/World.ts",
      from: "            if (vy > 0) { y = s.y - h; onGround = true; groundFriction = s.friction; }",
      to: "            if (vy > 0) { y = s.y; onGround = true; groundFriction = s.friction; }",
      note: "a landing body's TOP is put on the floor's top, so every body sinks into the ground by its own height — invisible to any fixture asserting only that it stopped" },
    { id: "RN3", file: "src/core/runtime/World.ts",
      from: "        let onGround = false;\n        let groundFriction = was.groundFriction;",
      to: "        let onGround = false;\n        let groundFriction = was.groundFriction;\n        x += 0;",
      note: "THE CONTROL — an equivalent statement that should SURVIVE. A run where every mutant dies cannot tell a real kill from a harness failing every time" },
    { id: "RN4", file: "src/core/runtime/World.ts",
      from: "        acc = 0;                                  // the dropped time is gone; do not owe it back",
      to: "        acc = acc - steps * FIXED_STEP;           // the dropped time is gone; do not owe it back",
      note: "a capped frame KEEPS the debt it just refused to spend, so the next frame spends the cap again, and the frame after that — the spiral the cap exists to stop, in instalments" },
    { id: "RN5", file: "src/core/runtime/World.ts",
      from: "        if (node.geometry.x === body.x && node.geometry.y === body.y) continue;",
      to: "        if (node.geometry.x === body.x) continue;",
      note: "only the X coordinate decides whether a body moved, so a body falling straight down is never stamped onto the document and never appears to move at all — and `if (false)` could not be used here, because it does not COMPILE" },

    // SURFACE FRICTION (M18 slice 4). The ground's property, not the body's — 44 of the corpus's
    // 45 `friction` values sit on STATIC objects. Every mutant here still walks and still stops;
    // what changes is where, and by how much.
    { id: "FR1", file: "src/core/runtime/World.ts",
      from: "    if (text === \"\") return 1;",
      to: "    if (text === \"nothing-is-this\") return 1;",
      note: "AN EMPTY VALUE BECOMES ICE. `Number(\"\")` is 0 and finite, so it sails past the isFinite check — and the corpus really does hold a property with an empty value. This one bit for real: the comment beside the code warned about it and the first version did it anyway" },
    { id: "FR2", file: "src/core/runtime/World.ts",
      from: "    if (raw === null) return 1;",
      to: "    if (raw === null) return 0;",
      note: "a surface that says nothing becomes ICE, so every level in the tree that never heard of friction turns frictionless — the loudest possible wrong default, and the easiest to ship" },
    { id: "FR3", file: "src/core/runtime/World.ts",
      from: "            const drop = was.groundFriction * gravity * FIXED_STEP;",
      to: "            const drop = was.groundFriction * gravity;",
      note: "friction decelerates per STEP rather than per second, so it is sixty times too strong and every surface stops a body inside one frame — which also makes 0.45 and 1 indistinguishable" },
    { id: "FR4", file: "src/core/runtime/World.ts",
      from: "        if (was.onGround && was.groundFriction > 0 && vx !== 0) {",
      to: "        if (was.groundFriction > 0 && vx !== 0) {",
      note: "friction applies IN THE AIR, so a jump loses its forward speed mid-flight and there is no air control — the body drops out of the arc it launched into" },
    { id: "FR5", file: "src/core/runtime/World.ts",
      from: "            vx = vx > 0 ? Math.max(0, vx - drop) : Math.min(0, vx + drop);",
      to: "            vx = vx > 0 ? vx - drop : vx + drop;",
      note: "the deceleration overshoots past zero, so a body that should have stopped reverses and creeps backwards — friction turned into a spring" },
    { id: "FR6", file: "src/core/runtime/World.ts",
      from: "            const held = (input.left ? -MOVE_SPEED : 0) + (input.right ? MOVE_SPEED : 0);\n            if (held !== 0) vx = held;",
      to: "            vx = (input.left ? -MOVE_SPEED : 0) + (input.right ? MOVE_SPEED : 0);",
      note: "releasing the key SETS the speed to zero rather than handing the body to the surface, so friction means nothing for the one body a player controls: no slide on ice, and no air control, because letting go mid-jump kills the flight" },

    // PER-TILE COLLISION (M18 slice 3). A level here is ONE node holding ten thousand cells, so
    // every one of these still stands a body on something — what changes is WHICH cells are solid
    // and WHERE they are, which no "did it land" assertion can see.
    { id: "TC1", file: "src/core/runtime/World.ts",
      from: "    return tile !== null && bodyTypeOf(tile) === \"static\";",
      to: "    return tile !== null;",
      note: "ANY tile with a per-tile record becomes solid, so a tile carrying `door=true` — which is what the corpus's only per-tile properties actually say — becomes a wall" },
    { id: "TC2", file: "src/core/runtime/World.ts",
      from: "                    x: node.geometry.x + col * map.tileWidth,\n                    y: node.geometry.y + row * map.tileHeight,",
      to: "                    x: col * map.tileWidth,\n                    y: row * map.tileHeight,",
      note: "the level's own position is dropped from its solid cells, so the collision sits at the origin while the art sits where the node is — a body stops in mid-air, or falls through the floor it is standing on" },
    { id: "TC3", file: "src/core/runtime/World.ts",
      from: "                    width: map.tileWidth, height: map.tileHeight",
      to: "                    width: map.tileHeight, height: map.tileWidth",
      note: "a solid cell's two dimensions are swapped — invisible on every square grid, which is what every other fixture in this file uses, and 24px out on the 32x8 one written to catch exactly this" },
    { id: "TC4", file: "src/core/runtime/World.ts",
      from: "        const acrossTiles = tiles ? tileSolidsNear(doc, { x, y, width: w, height: h }) : [];",
      to: "        const acrossTiles: Solid[] = [];",
      note: "only the VERTICAL axis consults the tiles, so a body stands on a tile floor and walks straight through a tile wall" },
    { id: "TC5", file: "src/core/runtime/World.ts",
      from: "        const local = { x: box.x - node.geometry.x, y: box.y - node.geometry.y,",
      to: "        const local = { x: box.x, y: box.y,",
      note: "the query box is not brought into the grid's own space, so a level placed anywhere but the origin looks up the wrong cells entirely" },

    // INPUT (M18 slice 2). Every one of these still walks and still jumps — what changes is how it
    // FEELS, which is the class of defect a "did it move" assertion is blind to.
    { id: "KB1", file: "src/core/runtime/World.ts",
      from: "            const held = (input.left ? -MOVE_SPEED : 0) + (input.right ? MOVE_SPEED : 0);\n            if (held !== 0) vx = held;",
      to: "            const held = (input.left ? -MOVE_SPEED : 0) + (input.right ? MOVE_SPEED : 0);\n            vx += held;",
      note: "the walk ACCUMULATES instead of being set, so holding right builds speed without limit and releasing keeps it — the character skates, and every distance assertion becomes a function of how long the key was held" },
    { id: "KB2", file: "src/core/runtime/World.ts",
      from: "            if (input.jump && !world.jumpWas && was.onGround) vy = -jumpSpeedFor(JUMP_HEIGHT, gravity);",
      to: "            if (input.jump && was.onGround) vy = -jumpSpeedFor(JUMP_HEIGHT, gravity);",
      note: "the jump stops being an EDGE, so a held key re-launches on every grounded step and the body bunny-hops for as long as the button is down" },
    { id: "KB3", file: "src/core/runtime/World.ts",
      from: "            if (input.jump && !world.jumpWas && was.onGround) vy = -jumpSpeedFor(JUMP_HEIGHT, gravity);",
      to: "            if (input.jump && !world.jumpWas) vy = -jumpSpeedFor(JUMP_HEIGHT, gravity);",
      note: "the ground check goes, so a body jumps in mid-air — which is what `onGround` was computed for in the first place" },
    { id: "KB4", file: "src/core/runtime/World.ts",
      from: "        if (vy > MAX_FALL_SPEED) vy = MAX_FALL_SPEED;",
      to: "        if (Math.abs(vy) > MAX_FALL_SPEED) vy = MAX_FALL_SPEED;",
      note: "the cap is applied to the RISE as well and with the wrong sign, so a jump is turned into a fall at terminal velocity the instant it launches" },
    { id: "KB5", file: "src/core/runtime/World.ts",
      from: "    return { bodies: next, time: world.time + FIXED_STEP, jumpWas: input.jump };",
      to: "    return { bodies: next, time: world.time + FIXED_STEP, jumpWas: false };",
      note: "the world forgets whether jump was held, so the edge never latches and a held key bounces — the same defect as IN2 by a different route, which is why the fixture has to watch LANDINGS rather than one step" },

    // A SET THAT STATES NEITHER ITS COLUMNS NOR ITS IMAGE SIZE. One file in the tree, 79 cells, and
    // the recovery has to leave the other 25 such sets — the ones that DO state a size — untouched.
    { id: "CL1", file: "src/core/import/TiledMap.ts",
      from: "    if (set.imageWidth !== null || !Number.isFinite(width) || !Number.isFinite(height)",
      to: "    if (!Number.isFinite(width) || !Number.isFinite(height)",
      note: "a measured bitmap OVERRIDES what the file declared, so the picture's real size silently wins over the map's own claim — two answers to one question, and the file stops being the authority" },
    { id: "CL2", file: "src/core/import/TiledMap.ts",
      from: "    return deriveGrid({ ...set, imageWidth: width, imageHeight: height });",
      to: "    return { ...set, imageWidth: width, imageHeight: height };",
      note: "the size is recorded and the grid is NOT re-derived, so `columns` stays 0 and every gid still resolves to nothing — the measurement happens and changes nothing" },
    { id: "CL3", file: "src/renderer/ImageCache.ts",
      from: "    if (img.complete) return naturalSize(href);",
      to: "    if (img.naturalWidth > 0) return naturalSize(href);",
      note: "THE GUARD ASKS THE WRONG QUESTION, and this one took two tries: the obvious mutants do not COMPILE. `if (false)` never does, and `entry.loaded` is a TS18048 because `entry` is possibly undefined there while `img` is what got narrowed. Asking the IMAGE whether it has a size looks equivalent and is not: an href whose load ALREADY failed reports width 0, falls through, and is waited on for an event that cannot arrive — so the import hangs with no error anywhere rather than reporting the set it could not measure" },

    // TILE ANCHORING. A tile sits at the BOTTOM of its cell, so art taller than the grid stands up
    // from it. Every mutant here still places every tile — what changes is how far off the ground.
    { id: "AN1", file: "src/core/import/TiledMap.ts",
      from: "        y: at.y + map.tileHeight - image.height + set.offsetY + layer.offsetY,",
      to: "        y: at.y + set.offsetY + layer.offsetY,",
      note: "the ORIGINAL bug: a tile is placed at the TOP of its cell, so a 256x512 tile on a 256x128 cell hangs 384px through the floor — and it is invisible on any layer whose art is exactly cell-sized, which is 45 of the corpus's 53" },
    { id: "AN2", file: "src/core/import/TiledMap.ts",
      from: "        y: at.y + map.tileHeight - image.height",
      to: "        y: at.y + map.tileWidth - image.height",
      note: "the anchoring measures the cell's WIDTH, which is identical on every square grid and wrong on every isometric one — 64x32 cells are the usual isometric case" },
    { id: "AN3", file: "src/core/import/TiledMap.ts",
      from: "image.height + set.offsetY + layer.offsetY,",
      to: "image.height + layer.offsetY,",
      note: "the SET's `<tileoffset>` is dropped from y, which is the field that lets a building stand over the squares behind it — four real sets in the tree carry one" },

    // SCHEMA 68 — the sheet leaves the tilemap node. Note what could NOT be mutated: putting `src`
    // back into `tileImportActions` does not compile, because the field left `TilePlacement`
    // altogether. Deleting a field beats guarding one, and tsc is the guard.
    { id: "TS1", file: "src/core/document/Node.ts",
      from: "    if (type !== \"core.image\") {\n        return \"only a core.image node may carry a src\";",
      to: "    if (type !== \"core.image\" && type !== \"core.tilemap\") {\n        return \"only a core.image node may carry a src\";",
      note: "a tilemap may carry a sheet again, so the picture has two homes and the importer's old copy is legal — the state that stored it seven times for six layers" },
    { id: "TS2", file: "src/core/document/Serializer.ts",
      from: "        if (node?.type === \"core.tilemap\" && node.src !== undefined) {",
      to: "        if (node?.type === \"core.image\" && node.src !== undefined) {",
      note: "the 67->68 strip takes an IMAGE's src instead of a tilemap's, so every photo loses its picture and every tilemap keeps the copy that made the migration necessary" },
    { id: "EX22", file: "src/core/export/ExportTiled.ts",
      from: "    if (writable.length === 0) {",
      to: "    if (writable.length < 0) {",
      note: "a document whose every layer draws from an unwritable set exports a map with no tileset at all — a file Tiled opens as an error dialog — instead of saying so and writing nothing" },
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

// BEFORE THE DIRTY-TREE CHECK, and the ordering IS the point: a killed run leaves a MUTATED
// file behind, which makes the tree dirty, which makes every later run refuse to start — so a
// restore placed after the check could never once have fired. Heal first, then judge.
restorePendingMutation();

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
/**
 * NO TWO MUTANTS MAY SHARE AN ID, checked before anything runs.
 *
 * Written after adding EX1–EX7 to a battery that already had EX1–EX14: `MUTANT_ONLY=^EX` then
 * reported "21 mutants" for what the author believed were seven, and a run of `^EX1$` would have
 * silently exercised one of the two. An id is how a survivor is named in a commit message and in
 * docs/TESTING.md, so two mutants answering to one id makes both records ambiguous — which is the
 * same class of fault as the `-t` filter reaching fewer tests than assumed.
 */
const byId = new Map();
for (const mut of MUTANTS) byId.set(mut.id, (byId.get(mut.id) ?? 0) + 1);
const dupes = [...byId].filter(([, n]) => n > 1).map(([id]) => id);
if (dupes.length > 0) {
    console.error(`Refusing to run: duplicate mutant id(s) — ${dupes.join(", ")}`);
    process.exit(2);
}

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

/**
 * HOW LONG THIS WILL TAKE, because a run is a full test suite per mutant and there was no way to
 * tell twenty minutes in whether it was halfway or nearly done.
 *
 * TWO SHAPES, DECIDED BY WHETHER ANYONE IS WATCHING. On a terminal it is one line rewritten in
 * place, which is what a progress bar is for. REDIRECTED TO A FILE it must not be: a bar drawn with
 * carriage returns turns a log into a single unreadable line, and this script's output is read from
 * a file more often than from a terminal — every count quoted in `docs/TESTING.md` came out of one.
 * So a redirected run gets an occasional plain line instead, and the per-mutant verdicts it already
 * prints carry the rest.
 *
 * THE ESTIMATE IS MEASURED, NOT ASSUMED: the first mutant to finish sets the pace and every one
 * after refines it, so the first line appears only once there is something real to say.
 */
/**
 * A PAGE THAT SHOWS THE RUN, because the terminal bar is invisible to anyone not watching that
 * terminal — and this script is usually started in the background, where its only trace is a log
 * file nobody is tailing.
 *
 * NO SERVER, NO DEPENDENCY, NO CORS. The file is rewritten after every mutant with the current
 * state baked in and a `<meta http-equiv="refresh">` in the head, so a browser tab reloads it on a
 * timer. `fetch` against `file://` is blocked, which rules out the obvious JSON-and-poll design;
 * baking the state into the document sidesteps the question entirely.
 *
 * IT WRITES ITS OWN LAST-UPDATED TIME, so a run that DIED shows as a page that has stopped moving
 * rather than as one that is merely slow. That distinction matters here: killing this script leaves
 * a mutated source file on disk (see `restorePendingMutation`).
 */
function writeProgressPage(state) {
    const pct = state.total === 0 ? 0 : Math.round((state.done / state.total) * 100);
    const rows = state.recent.map(r =>
        `<tr><td class="id">${esc(r.id)}</td><td class="${r.ok ? "ok" : "bad"}">${esc(r.verdict)}</td>`
        + `<td class="note">${esc(r.note)}</td></tr>`).join("");
    fs.writeFileSync(PROGRESS_PAGE, `<!doctype html><html><head><meta charset="utf-8">
<title>${state.done}/${state.total} — mutation battery</title>
${state.finished ? "" : '<meta http-equiv="refresh" content="2">'}
<style>
 body{background:#0d0d16;color:#ccc;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:22px}
 h1{font-size:15px;font-weight:600;margin:0 0 14px;color:#fff}
 .bar{height:22px;background:#12121f;border:1px solid #2a2a4a;border-radius:4px;overflow:hidden}
 .fill{height:100%;width:${pct}%;background:${state.survivors > 0 ? "#b4443a" : "#3a7d5c"};transition:width .4s}
 .n{display:flex;justify-content:space-between;margin:8px 0 18px;color:#888}
 table{border-collapse:collapse;width:100%}
 td{padding:2px 8px 2px 0;vertical-align:top;border-bottom:1px solid #1c1c30}
 .id{color:#7aa2d0;white-space:nowrap}.ok{color:#5f9e78;white-space:nowrap}.bad{color:#d4655a;white-space:nowrap}
 .note{color:#6d6d80}
 .done{color:${state.survivors > 0 ? "#d4655a" : "#5f9e78"};font-size:15px;margin-top:16px}
 .stale{color:#8a7a3a;margin-top:14px}
</style></head><body>
<h1>${esc(state.title)}</h1>
<div class="bar"><div class="fill"></div></div>
<div class="n"><span>${state.done} / ${state.total} &nbsp; (${pct}%)</span>
 <span>${esc(state.elapsed)} elapsed &middot; ${esc(state.eta)}</span></div>
${state.finished
        ? `<div class="done">${state.total - state.survivors}/${state.total} killed &mdash; ${esc(state.elapsed)} total, ${esc(state.pace)} per mutant.</div>`
        : `<div class="stale">Updated ${esc(state.at)}. If this stops changing, the run has stopped.</div>`}
<table>${rows}</table>
</body></html>`, "utf8");
}

const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Put back a file a PREVIOUS run was killed in the middle of mutating.
 *
 * THIS IS NOT HYPOTHETICAL AND IT IS NOT COSMETIC. The restore below lives in a `finally`, which a
 * hard kill skips — so an interrupted run leaves a MUTATED source file in the working tree. It
 * happened twice in ten minutes: once leaving `node.tilemap = node.tilemap` in the tilemap write
 * path, once leaving `width - 1 - y` in the vertical mirror. Both compile, both are wrong, and both
 * would have been committed by anyone who did not think to check `git status` first.
 *
 * So the original is written to disk BEFORE the mutation and cleared after, and the next run puts
 * back anything it finds. Self-healing rather than a warning nobody reads.
 */
function restorePendingMutation() {
    if (!fs.existsSync(PENDING)) return;
    try {
        const held = JSON.parse(fs.readFileSync(PENDING, "utf8"));
        if (held && typeof held.file === "string" && typeof held.original === "string") {
            fs.writeFileSync(held.file, held.original, "utf8");
            console.log(`Restored ${held.file}, which a killed run left mutated.`);
        }
    } catch (e) {
        console.error(`Could not restore a pending mutation: ${String(e)}`);
    }
    fs.unlinkSync(PENDING);
}

const WATCHING = process.stdout.isTTY === true;
const startedAt = Date.now();
const BAR_WIDTH = 24;
let barDrawn = false;
let done = 0;

const humanTime = (ms) => {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** Erase the live bar, so whatever prints next starts on a clean line. */
function clearBar() {
    if (!WATCHING || !barDrawn) return;
    process.stdout.write(`\r${" ".repeat(78)}\r`);
    barDrawn = false;
}

/** Everything the loop prints goes through here, so a verdict never lands on top of the bar. */
function say(line) {
    clearBar();
    console.log(line);
}

function showProgress(nextId) {
    const elapsed = Date.now() - startedAt;
    const left = selected.length - done;
    // ONLY ONCE A MUTANT HAS FINISHED is there a pace to extrapolate from; before that the estimate
    // would be a number invented to fill the space.
    const eta = done > 0 ? `~${humanTime((elapsed / done) * left)} left` : "measuring…";
    if (WATCHING) {
        const filled = Math.round((done / selected.length) * BAR_WIDTH);
        process.stdout.write(`\r[${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}] `
            + `${String(done).padStart(3)}/${selected.length}  ${humanTime(elapsed)} · ${eta}  ${nextId}   `);
        barDrawn = true;
    } else if (done > 0 && done % 10 === 0) {
        console.log(`… ${done}/${selected.length} · ${humanTime(elapsed)} elapsed · ${eta}`);
    }
}

/** What the page shows. `recent` is newest-first and bounded — a log, not a transcript. */
const page = { title: "", total: selected.length, done: 0, survivors: 0, recent: [],
    elapsed: "0s", eta: "measuring…", pace: "", at: "", finished: false };
page.title = only
    ? `Mutation battery — PARTIAL RUN (MUTANT_ONLY=${process.env.MUTANT_ONLY}) of ${MUTANTS.length}`
    : "Mutation battery";

/** Push the current numbers into the page. Cheap: one small file, once per mutant. */
function refreshPage() {
    const ms = Date.now() - startedAt;
    page.done = done;
    page.survivors = survivors;
    page.elapsed = humanTime(ms);
    page.eta = done > 0 ? `~${humanTime((ms / done) * (selected.length - done))} left` : "measuring…";
    page.pace = humanTime(ms / Math.max(1, done));
    page.at = new Date().toTimeString().slice(0, 8);
    writeProgressPage(page);
}

console.log(`${selected.length} mutants, one full test suite each.`);
console.log(`Progress page: ${PROGRESS_PAGE}`);
writeProgressPage(page);
// AUTO-OPENED ONLY WHEN ASKED. A run started in the background should not throw a window at
// somebody; a run somebody is waiting on should. `MUTANT_POPUP=1` is that difference.
if (process.env.MUTANT_POPUP) {
    try {
        require("child_process").spawn(
            process.platform === "win32" ? "cmd" : "open",
            process.platform === "win32" ? ["/c", "start", "", PROGRESS_PAGE] : [PROGRESS_PAGE],
            { detached: true, stdio: "ignore" }
        ).unref();
    } catch (e) {
        console.error(`Could not open the progress page: ${String(e)}`);
    }
}

let survivors = 0;
for (const mut of selected) {
    showProgress(mut.id);
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
        say(`${mut.id}  NOT APPLIED — 'from' no longer matches ${mut.file}`);
        survivors++;
        done++;
        page.recent.unshift({ id: mut.id, verdict: "NOT APPLIED", note: mut.file, ok: false });
        refreshPage();
        continue;
    }
    if (occurrences > 1) {
        // AMBIGUOUS — the verdict this harness was missing, and the worse of the two. `String.replace`
        // takes the FIRST match, so a `from` that appears twice mutates whichever site comes first
        // while its note goes on describing the other. Not hypothetical: reading object layers gave
        // `visible: a.visible === undefined ? ...` a second home, and TM4 silently re-aimed from a
        // tile layer to an object — still reporting a kill, for a guard nothing was testing.
        say(`${mut.id}  AMBIGUOUS — 'from' matches ${occurrences} places in ${mut.file}; `
            + "add context so it names one");
        survivors++;
        done++;
        page.recent.unshift({ id: mut.id, verdict: "AMBIGUOUS", note: mut.file, ok: false });
        refreshPage();
        continue;
    }
    // WRITTEN DOWN BEFORE THE FILE IS TOUCHED, so a killed run can be undone by the next one.
    fs.writeFileSync(PENDING, JSON.stringify({ file, original }), "utf8");
    fs.writeFileSync(file, source.replace(mut.from, mut.to), "utf8");
    let res;
    try { res = verdict(runSuite()); } finally {
        fs.writeFileSync(file, original, "utf8");
        if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
    }
    if (!res.ok) survivors++;
    done++;
    say(`${mut.id}  ${res.v.padEnd(28)} (${res.total} tests)  ${mut.note}`);
    page.recent.unshift({ id: mut.id, verdict: res.v, note: mut.note, ok: res.ok });
    page.recent.length = Math.min(page.recent.length, 40);
    refreshPage();
}

clearBar();
console.log(`\n${selected.length - survivors}/${selected.length} killed.`
    + (only ? `  — PARTIAL RUN (MUTANT_ONLY=${process.env.MUTANT_ONLY}); the battery holds ${MUTANTS.length}.` : ""));
page.finished = true;
refreshPage();
// THE PACE, so the next run can be planned rather than waited out.
console.log(`${humanTime(Date.now() - startedAt)} total, ${humanTime((Date.now() - startedAt) / Math.max(1, selected.length))} per mutant.`);
process.exit(survivors > 0 ? 1 : 0);
