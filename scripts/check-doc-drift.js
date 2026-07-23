/**
 * @module check-doc-drift
 * @description Staleness tripwire for documentation.
 *
 * A doc declares the sources it describes, in the doc itself:
 *
 *     <!-- describes: src/core/actions, src/core/document/Serializer.ts -->
 *
 * If any declared source has been committed to SINCE the doc was last committed to,
 * the doc is flagged. Clearing the flag means committing the doc — which is the
 * re-read this exists to force.
 *
 * WHAT THIS IS NOT: it cannot tell you the prose is wrong. Nothing can. It targets
 * the failure that actually occurred — editing one section of a document and never
 * re-reading the rest, so drift accumulated in the parts nobody was looking at.
 * It answers "did the code this describes move without you looking?", not "is this
 * text correct?".
 *
 * KNOWN COST: noisy by construction. Every source commit flags its doc whether or not
 * the doc is actually wrong. Run `npm run doc-drift` to see the current state; it is
 * deliberately NOT part of `npm run check` (see docs/TESTING.md for the measured
 * noise rate and the reasoning).
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const git = (args) => execSync(`git ${args}`, { cwd: rootDir, stdio: "pipe" }).toString().trim();

/** Docs that declare a `describes:` directive. */
function findDeclaringDocs() {
    const out = [];
    const scan = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) scan(full);
            else if (e.name.endsWith(".md")) {
                const text = fs.readFileSync(full, "utf-8");
                const m = text.match(/<!--\s*describes:\s*([^>]+?)\s*-->/);
                if (m) {
                    out.push({
                        doc: path.relative(rootDir, full).replace(/\\/g, "/"),
                        deps: m[1].split(",").map(s => s.trim()).filter(Boolean)
                    });
                }
            }
        }
    };
    scan(path.join(rootDir, "docs"));
    for (const name of ["MILESTONES.md", "PLANNED-FIXES.md"]) {
        const full = path.join(rootDir, name);
        if (!fs.existsSync(full)) continue;
        const m = fs.readFileSync(full, "utf-8").match(/<!--\s*describes:\s*([^>]+?)\s*-->/);
        if (m) out.push({ doc: name, deps: m[1].split(",").map(s => s.trim()).filter(Boolean) });
    }
    return out;
}

const stale = [];
for (const { doc, deps } of findDeclaringDocs()) {
    const docSha = git(`log -1 --format=%H -- "${doc}"`);
    if (!docSha) {
        stale.push({ doc, reason: "never committed", commits: [] });
        continue;
    }
    // Commits touching the declared sources that are NOT ancestors of the doc's
    // last commit — i.e. the code moved after the doc was last looked at.
    const depArgs = deps.map(d => `"${d}"`).join(" ");
    const log = git(`log --oneline ${docSha}..HEAD -- ${depArgs}`);
    if (log) {
        stale.push({ doc, reason: "sources changed after this doc", commits: log.split("\n") });
    }
}

if (stale.length === 0) {
    console.log("Doc drift: no declared doc is behind its sources.");
    process.exit(0);
}

console.log("Docs whose declared sources moved after the doc was last committed:\n");
for (const s of stale) {
    console.log(`  ${s.doc}  (${s.reason})`);
    for (const c of s.commits.slice(0, 6)) console.log(`      ${c}`);
    if (s.commits.length > 6) console.log(`      … and ${s.commits.length - 6} more`);
    console.log("");
}
console.log("Re-read each doc. If it is still accurate, commit it anyway (e.g. touch the");
console.log("`describes:` line) — that records the re-read and clears the flag.");
process.exit(1);
