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
 * REFUSES TO RUN ON A DIRTY TREE. It edits real source files and restores them; if it is
 * interrupted between the two, `git checkout` is the recovery, and that is only safe when there
 * was nothing uncommitted to lose.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/** The suite's size. Anything less means the mutant did not compile. */
const EXPECTED_TESTS = 1547;

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
    { id: "TG3", file: "src/core/import/TiledMap.ts",
      from: "            x: layer.offsetX + set.offsetX,\n            y: layer.offsetY + set.offsetY,",
      to: "            x: layer.offsetY + set.offsetY,\n            y: layer.offsetX + set.offsetX,",
      note: "the two offsets swapped — invisible unless x and y differ" },
    { id: "TG4", file: "src/core/import/TiledMap.ts",
      from: "            width: layer.width * map.tileWidth,\n            height: layer.height * map.tileHeight,",
      to: "            width: layer.width * map.tileHeight,\n            height: layer.height * map.tileWidth,",
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
      to: "    if (false) {",
      note: "oversized tiles accepted into a cell that squashes them — five real layers" },
    { id: "TG8", file: "src/core/import/TiledMap.ts",
      from: "        else if (found.firstGid !== set.firstGid) return no(\"draws from more than one tileset\");",
      to: "        else if (false) return no(\"draws from more than one tileset\");",
      note: "a two-tileset layer drawn from whichever set came first" },
    { id: "TG9", file: "src/core/import/TiledMap.ts",
      from: "    const bad = tilemapError(tilemap);\n    if (bad) return no(bad);",
      to: "    const bad = null;\n    if (bad) return no(bad);",
      note: "the document's own validator skipped — the importer can mint an unopenable node" },
    { id: "TG10", file: "src/core/import/TiledMap.ts",
      from: "            hidden: !layer.visible,",
      to: "            hidden: layer.visible,",
      note: "visibility inverted — every shown layer hidden and every hidden one shown" },
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
    if (!original.includes(mut.from)) {
        // NOT a survivor and NOT a kill: the code moved out from under the mutation, so the
        // battery is testing nothing. Re-author it against the code as it now stands.
        console.log(`${mut.id}  NOT APPLIED — 'from' no longer matches ${mut.file}`);
        survivors++;
        continue;
    }
    fs.writeFileSync(file, original.replace(mut.from, mut.to), "utf8");
    let res;
    try { res = verdict(runSuite()); } finally { fs.writeFileSync(file, original, "utf8"); }
    if (!res.ok) survivors++;
    console.log(`${mut.id}  ${res.v.padEnd(28)} (${res.total} tests)  ${mut.note}`);
}

console.log(`\n${MUTANTS.length - survivors}/${MUTANTS.length} killed.`);
process.exit(survivors > 0 ? 1 : 0);
