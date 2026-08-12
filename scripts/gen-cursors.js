/**
 * @module gen-cursors
 * @description Generate `src/app/theme/Cursors.ts` — the chosen cursors, inlined.
 *
 * INLINED RATHER THAN LOADED, because a cursor that arrives a frame late is a cursor that flickers
 * on every tool switch, and because the bundle already has no asset-loading path for chrome. Seven
 * files at ~600 bytes each is under 6KB of base64 — small enough that the alternative would be
 * machinery for nothing.
 */
const fs = require("fs");
const path = require("path");

const SRC = "C:/Users/micha/Documents/code projects/f1/New folder/freeassets/UI assets/Cursor Pack/PNG/Outline/Default";
const OUT = "C:/Users/micha/Documents/code projects/f1/New folder/src/app/theme/Cursors.ts";

/**
 * The choice, and the reason for each. Hotspots are the measured opaque extremity toward the tool's
 * working end — decoded from the alpha, not eyeballed.
 */
const CHOSEN = [
    ["paint", "drawing_brush", 1, 16, "the brush's bristles, bottom-left of the sprite"],
    ["bucket", "drawing_bucket", 1, 25, "the pouring lip, bottom-left"],
    ["eyedropper", "drawing_picker", 5, 3, "the pipette's point"],
    ["pen", "drawing_pen", 5, 4, "the nib"],
    ["tiles", "drawing_pencil", 6, 4, "the pencil's tip — a tile brush draws one cell at a time"],
    ["weights", "drawing_spray", 4, 4, "a soft falloff brush, which is what a weight brush is"],
    ["pixelSelect", "cross_large", 15, 15, "a marquee is aimed from its centre"],
];

const rows = [];
for (const [tool, file, hx, hy, why] of CHOSEN) {
    const b64 = fs.readFileSync(path.join(SRC, file + ".png")).toString("base64");
    rows.push({ tool, file, hx, hy, why, b64 });
}

const body = rows.map(r =>
    `    /** \`${r.file}\` — ${r.why}. */\n`
    + `    ${r.tool}: "url(data:image/png;base64,${r.b64}) ${r.hx} ${r.hy}, crosshair",`
).join("\n");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `/**
 * @module Cursors
 * @description The pointer says which tool is in your hand.
 *
 * GENERATED — see \`scripts/gen-cursors.js\`. Kenney's Cursor Pack (CC0), the Outline set, whose
 * white keyline keeps a dark cursor legible over dark art and a light one over light.
 *
 * WHY THIS AND NOT A SKIN. VDE had eight tools that all showed the same arrow: the toolbar knew
 * which was active and the pointer did not, so the one place you are actually looking said nothing.
 * These are the assets whose vocabulary matches the tools exactly — brush, bucket, picker, pen,
 * pencil, spray — which is what makes this a theme rather than a costume. The dense panels, the
 * typography and the hit targets are deliberately untouched: a chunky nine-sliced game frame around
 * an inspector would read as themed and measure as worse.
 *
 * EACH HOTSPOT IS MEASURED, not centred. The alpha of every sprite was decoded and the opaque
 * extremity toward the tool's working end taken as the point — a brush whose hotspot sits in the
 * middle of the sprite paints half a cursor away from where it was aimed, which is worse than the
 * arrow it replaces.
 *
 * THE FALLBACK IS \`crosshair\`, not \`default\`: if the data URI is ever rejected, a precise tool
 * should still get a precise pointer.
 */

/** A CSS \`cursor\` value per tool name, as \`ToolController\` names them. */
export const TOOL_CURSORS: Readonly<Record<string, string>> = {
${body}
};
`, "utf8");

const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`wrote ${OUT}`);
console.log(`  ${rows.length} cursors, ${kb}KB total`);
for (const r of rows) console.log(`  ${r.tool.padEnd(12)} ${r.file.padEnd(16)} hotspot (${r.hx},${r.hy})`);
