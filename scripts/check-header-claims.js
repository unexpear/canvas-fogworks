/**
 * @module check-header-claims
 * @description Lists the module-header sentences that can go STALE — `npm run header-claims`.
 *
 * A header saying what a module IS does not rot. A header saying what it CANNOT DO, what does not
 * exist yet, or what nothing consumes rots the moment somebody builds the thing — and nothing else
 * in this repo can notice, because the claim and the code share a file. `doc-drift` compares a
 * doc's git timestamp against its declared sources; a header has no such pair to compare.
 *
 * ADVISORY, and NOT part of `npm run check`, for the same reason `doc-drift` is not: the output is
 * a reading list, not a verdict. Deciding whether "for now" is still true means opening the file.
 *
 * MEASURED, so the noise rate is a number rather than a hope. On the sweep that produced this
 * script — all 151 module headers in `src` and `scripts` — it surfaced 8 sentences, of which 1 was
 * genuinely stale: `emitWebGL` had declared shadow and blur "ignored ... needs a render target this
 * backend does not allocate" long after it grew the render targets. The other 7 were accurate
 * (snapshot history is still snapshot history; booleans are still destructive). One in eight is a
 * usable rate for something a person reads once in a while; it would be a terrible gate.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is check that a symbol a header NAMES still exists. That was
 * built, measured, and thrown away: it produced 8 hits and 0 defects. Six were names belonging to
 * other projects (`NinePatchRect` is Godot's, `JOINTS_0` is glTF's), one was a path into `docs`,
 * and one was this codebase doing something it does well — naming a dead predecessor on purpose,
 * "(This began as `RectangleTool` with the type hard-coded.)" A rule whose entire yield is correct
 * prose punishes the habit of recording provenance, and a check that cries wolf gets switched off.
 */

const fs = require("fs");
const path = require("path");

const ROOTS = ["src", "scripts"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js"]);
const EXCLUDE = /\.(test|spec)\.(ts|tsx|js)$/;

/**
 * Phrases that assert something about THIS codebase's own backlog.
 *
 * Not phrases that assert something about the world. "A directional light has no penumbra" is
 * physics and will be true forever; "effects are ignored" is a to-do wearing a statement's clothes.
 * Getting that line wrong in the noisy direction is what makes a tool like this unread — an earlier
 * pattern matched every "has no" and returned 57 sentences, nearly all of them permanent truths.
 */
const CLAIM = new RegExp([
    "not yet", "yet to be", "for now", "at present", "currently (no|does not|cannot)",
    "nothing (consumes|reads|writes|calls|uses|renders|draws) (it|this|them)",
    "remaining gap", "the gap (today )?is", "are ignored", "is ignored", "this backend does not",
    "does not allocate", "is a divergence",
    "no (inspector|control|ui|editor|way to author)", "is not wired", "does nothing yet",
    "will (be|come|land)", "planned", "future", "eventually"
].join("|"), "i");

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (EXTENSIONS.has(path.extname(entry.name)) && !EXCLUDE.test(entry.name)) out.push(full);
    }
    return out;
}

const rootDir = path.join(__dirname, "..");
const found = [];
let headers = 0;

for (const root of ROOTS) {
    const dir = path.join(rootDir, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
        // NOT THIS FILE. Its own header quotes the phrases it hunts for, so it matches itself on
        // every run — a fixed nag that teaches a reader to skim past the output, which is the one
        // thing an advisory tool cannot survive.
        if (path.resolve(file) === path.resolve(__filename)) continue;
        const text = fs.readFileSync(file, "utf-8");
        const header = /^\s*\/\*\*([\s\S]*?)\*\//.exec(text);
        if (!header || !/@module\b/.test(header[1])) continue;
        headers++;
        const prose = header[1]
            .split("\n").map(l => l.trim().replace(/^\*\s?/, "")).join(" ")
            .replace(/\s+/g, " ");
        // Sentence-ish. Good enough: the output is read, not parsed.
        for (const sentence of prose.split(/(?<=[.!?]) +/)) {
            if (sentence.length > 30 && CLAIM.test(sentence)) {
                found.push([path.relative(rootDir, file).split(path.sep).join("/"), sentence.trim()]);
            }
        }
    }
}

console.log(`${headers} module headers; ${found.length} sentence(s) with a shelf life.\n`);
let current = null;
for (const [file, sentence] of found) {
    if (file !== current) { console.log(`\n${file}`); current = file; }
    console.log(`   ${sentence.length > 220 ? sentence.slice(0, 217) + "..." : sentence}`);
}
console.log(
    "\nEach of these was true when written. Open the file and check it still is; if it is, leave it." +
    "\nOn the sweep that produced this script the rate was 1 stale in 8."
);
