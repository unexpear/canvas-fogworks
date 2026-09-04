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
 * WHAT THIS IS NOT: it cannot generally tell you the prose is wrong. It targets
 * the failure that actually occurred — editing one section of a document and never
 * re-reading the rest, so drift accumulated in the parts nobody was looking at.
 * It answers "did the code this describes move without you looking?", not "is this
 * text correct?".
 *
 * KNOWN COST: noisy by construction. Every source commit flags its doc whether or not
 * the doc is actually wrong. Run `npm run doc-drift` to see the current state; it is
 * deliberately NOT part of `npm run check` (see docs/TESTING.md for the measured
 * noise rate and the reasoning).
 *
 * THE SECOND CHECK EXISTS BECAUSE THE FIRST ONE PASSED A LIE. Ancestry asks "was the doc committed
 * after its sources?", and a doc committed a dozen times can still carry a banner nobody re-read:
 * five of the seven stamped docs said `schema v63` against a live 66, and every one of them was
 * green. So a doc that STATES the schema version must state the CURRENT one — a fact with a single
 * source of truth, which is the only kind a script can check.
 *
 * `schema vNN` IS THE STAMP; `schema NN` IS HISTORY. The docs cite old versions constantly and
 * correctly — "schema 61 — `core.tilemap`", "a Style.fill value at schema 56" — and a check that
 * flagged those would be noise, and noise is what gets ignored. The `v` is the marker, and the
 * convention holds across every banner in the tree.
 *
 * IT REFUSES TO PASS VACUOUSLY, in two ways, because the failure mode of a pattern-matching check is
 * matching nothing and reporting that everything is fine. A doc carrying a frozen banner and NO
 * `schema vNN` stamp is reported. And a doc this tool was written to watch that declares no
 * `describes:` at all is reported — `MILESTONES.md` and `PLANNED-FIXES.md` are named in the code
 * below and BOTH lack the directive, so for as long as this script has existed it has looked them
 * up, found nothing, and moved on in silence. They sat at a 2026-07-23 status line with six
 * milestones marked not-started that were substantially done.
 *
 * THE THIRD CHECK IS NARROWLY SEMANTIC. General prose verification is impossible, but several
 * contradictions that shipped have exact, machine-readable counterparts: the live schema number,
 * the highest numbered runtime slice, a completed milestone's status, known stale phrases, the
 * structured backlog, and whether a forbidden reference corpus is tracked. Those are checked below
 * rather than hidden behind the broader claim that prose cannot be checked.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const git = (args) => execSync(`git ${args}`, { cwd: rootDir, stdio: "pipe" }).toString().trim();

/**
 * Docs outside `docs/` that this tool watches. Named ONCE so the checks below cannot disagree about
 * the list, and declared HERE rather than beside its first use: a `const` referenced above its own
 * declaration is a temporal-dead-zone fault that `node --check` passes and every run throws on,
 * which this project has already paid for once in `mutate-dimensions`.
 */
const ROOT_DOCS = ["MILESTONES.md", "PLANNED-FIXES.md", "README.md"];

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
    for (const name of ROOT_DOCS) {
        const full = path.join(rootDir, name);
        if (!fs.existsSync(full)) continue;
        const m = fs.readFileSync(full, "utf-8").match(/<!--\s*describes:\s*([^>]+?)\s*-->/);
        if (m) out.push({ doc: name, deps: m[1].split(",").map(s => s.trim()).filter(Boolean) });
    }
    return out;
}

/**
 * The schema version the CODE is at. One source of truth, read rather than restated — a constant
 * copied into this script would be one more thing to forget.
 */
function currentSchemaVersion() {
    const src = fs.readFileSync(path.join(rootDir, "src/core/document/Document.ts"), "utf-8");
    const m = src.match(/SCHEMA_VERSION[^=]*=\s*["'](\d+)["']/);
    if (!m) throw new Error("check-doc-drift: could not read SCHEMA_VERSION from Document.ts");
    return m[1];
}

/** Every markdown file this tool has an opinion about. */
function allDocs() {
    const out = [];
    const scan = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) scan(full);
            else if (e.name.endsWith(".md")) out.push(full);
        }
    };
    scan(path.join(rootDir, "docs"));
    for (const name of ROOT_DOCS) {
        const full = path.join(rootDir, name);
        if (fs.existsSync(full)) out.push(full);
    }
    return out;
}

/**
 * Root docs this tool is written to watch. `findDeclaringDocs` looks each one up for a `describes:`
 * directive; `checkUndeclared` reports the ones that have none, because being looked up and skipped
 * is indistinguishable from being checked and passing.
 */
function checkUndeclared() {
    const out = [];
    for (const name of ROOT_DOCS) {
        const full = path.join(rootDir, name);
        if (!fs.existsSync(full)) continue;
        if (!/<!--\s*describes:/.test(fs.readFileSync(full, "utf-8"))) out.push(name);
    }
    return out;
}

/** A doc's banner line — the one carrying the frozen-contract stamp, or -1. */
function bannerLine(lines) {
    return lines.findIndex(l => /^>.*Frozen contracts?/.test(l));
}

/**
 * Docs whose stated schema version is not the live one, and docs that state none at all.
 *
 * ONLY THE BANNER LINE IS A STAMP, which this learned by crying wolf on its first run: the very
 * commit that added the check also added a sentence to TESTING.md explaining the bug — "five of the
 * seven stamped docs said `schema v63`" — and the check flagged its own description of the problem.
 * A doc QUOTING a stale stamp is not a stale stamp. Restricting the match to the banner is not a
 * weakening: the banner IS what the rule was always about, and prose is free to cite any version it
 * likes, which docs recording history must be able to do.
 */
function checkStamps(current) {
    const wrong = [], unstamped = [];
    for (const full of allDocs()) {
        const rel = path.relative(rootDir, full).replace(/\\/g, "/");
        const lines = fs.readFileSync(full, "utf-8").split(/\r?\n/);
        const at = bannerLine(lines);
        if (at < 0) continue;                     // no banner, no stamp expected
        // `schema vNN` is the STAMP. `schema NN` without the v is a historical citation and is
        // none of this tool's business — see the header.
        const m = /schema v(\d+)/i.exec(lines[at]);
        // A BANNER WITH NO STAMP is the vacuous pass this check exists to prevent: rename the
        // format and every doc silently becomes compliant.
        if (!m) unstamped.push(rel);
        else if (m[1] !== current) wrong.push({ doc: rel, line: at + 1, said: m[1] });
    }
    return { wrong, unstamped };
}

/** Exact consistency rules for claims that have one machine-readable answer. */
function checkSemanticConsistency(current) {
    const issues = [];
    const read = rel => fs.readFileSync(path.join(rootDir, rel), "utf-8");
    const milestones = read("MILESTONES.md");

    const statusSchema = /Status reconciled[\s\S]{0,180}?schema \*\*(\d+)\*\*/.exec(milestones);
    if (!statusSchema) issues.push("MILESTONES.md has no machine-readable reconciled schema summary");
    else if (statusSchema[1] !== current) {
        issues.push(`MILESTONES.md summary says schema ${statusSchema[1]}, source says ${current}`);
    }

    if (!/^M6\s+Components\s+✅/m.test(milestones)) {
        issues.push("MILESTONES.md engine stack does not mark completed M6 Components as done");
    }
    if (!/^### Milestone 6 \u2014 Components ✅/m.test(milestones)) {
        issues.push("MILESTONES.md M6 body does not mark Components as done");
    }
    if (!/^M15\s+Plugins\s+🚧/m.test(milestones)) {
        issues.push("MILESTONES.md denies the landed M15 scripting foundation");
    }
    if (!/^M17\s+Production Hardening\s+🚧/m.test(milestones)) {
        issues.push("MILESTONES.md does not acknowledge active production hardening");
    }

    const runtimeAt = milestones.indexOf("## Phase 18 \u2014 Game Runtime");
    const runtime = runtimeAt >= 0 ? milestones.slice(runtimeAt) : "";
    const sliceNumbers = [...runtime.matchAll(/\*\*Slice (\d+)\b/gi)].map(m => Number(m[1]));
    const maxSlice = sliceNumbers.length > 0 ? Math.max(...sliceNumbers) : 0;
    const bodyClaim = /### Milestone 18[^\n]*\(slices 1[\-–](\d+) landed\)/.exec(runtime);
    const stackClaim = /^M18\s+Game Runtime[^\n]*slices 1[\-–](\d+)/m.exec(milestones);
    if (maxSlice === 0) issues.push("MILESTONES.md has no numbered M18 slices");
    if (!bodyClaim || Number(bodyClaim[1]) !== maxSlice) {
        issues.push(`MILESTONES.md M18 heading does not match highest documented slice ${maxSlice}`);
    }
    if (!stackClaim || Number(stackClaim[1]) !== maxSlice) {
        issues.push(`MILESTONES.md engine stack does not match highest documented M18 slice ${maxSlice}`);
    }

    const forbidden = [
        ["docs/DOCUMENT-SCHEMA.md", /layout.?\/transform overrides are a later slice/i,
            "component schema still defers live layout/transform overrides"],
        ["docs/FEATURE-AUDIT.md", /\| \*\*Object layers\*\* \| \*\*absent\*\*/,
            "feature audit still marks live Tiled object layers absent"],
        ["docs/FEATURE-AUDIT.md", /collection set is representable but not yet drawable/i,
            "feature audit still calls drawable collection tilesets undrawable"],
        ["docs/TESTING.md", /text` \/ `src` \/ `name` branches have no producing Action/i,
            "testing gaps still deny UpdateNodeContentAction"],
        ["docs/DOCUMENT-SCHEMA.md", /^## Gradient \u2014 modelled, NOT yet persisted$/m,
            "schema still presents the superseded pre-56 gradient boundary as current"],
        ["docs/API-CONTRACTS.md", /\*\*NOT YET CALLED\.\*\* `ensureTarget`/,
            "API contracts still call the live WebGL effects pass unreachable"],
        ["docs/API-CONTRACTS.md", /\*\*Canvas draws rasters; the GPU backend does not yet\*\*/,
            "API contracts still deny live WebGL raster drawing"],
        ["docs/API-CONTRACTS.md", /the non-destructive `core\.boolean` node is a later slice/i,
            "API contracts still defer the live schema-33 boolean node"],
        ["docs/ACTION-SYSTEM.md", /a `core\.boolean` node[^\n]*is a later slice/i,
            "action docs still defer the live schema-33 boolean node"],
        ["docs/DOCUMENT-SCHEMA.md", /Reserved-but-unused today:\*\* `states`/i,
            "schema still labels live states as unused"],
        ["docs/DOCUMENT-SCHEMA.md", /World-position-preserving reparent is deferred to M2/i,
            "schema assigns an open reparent limitation to completed M2"],
        ["docs/README.md", /\b2053\b|215\/215/,
            "documentation overview carries obsolete test or mutation totals"],
        ["docs/TESTING.md", /(?:suite contains|jest \(ts-jest\)|What is covered)[^\n]*\b2053\b/i,
            "testing overview carries the obsolete 2053-test total"],
        ["docs/FEATURE-AUDIT.md", /Import glTF \/ OBJ geometry\s*\|\s*\*\*built, BLOCKED\*\*/i,
            "feature audit still calls the live glTF/GLB workflow blocked"]
    ];
    for (const [rel, pattern, reason] of forbidden) {
        if (pattern.test(read(rel))) issues.push(`${rel}: ${reason}`);
    }

    try {
        const mutationOutput = execSync(`${JSON.stringify(process.execPath)} scripts/mutate-dimensions.js --count`, {
            cwd: rootDir,
            stdio: "pipe"
        }).toString().trim();
        if (!/^\d+$/.test(mutationOutput)) {
            issues.push("mutation manifest did not report a numeric mutant count");
        } else if (!new RegExp(`\\b${mutationOutput} mutants\\b`).test(read("docs/README.md"))) {
            issues.push(`docs/README.md does not state the live ${mutationOutput}-mutant battery size`);
        }
    } catch (e) {
        issues.push(`mutation preflight failed: ${e.message}`);
    }

    try {
        const backlog = JSON.parse(read("docs/BACKLOG.json"));
        const allowedStatus = new Set(backlog.statuses ?? []);
        const allowedPriority = new Set(backlog.priorities ?? []);
        const ids = new Set();
        if (backlog.schemaVersion !== 1) issues.push("docs/BACKLOG.json has an unsupported schemaVersion");
        if (!Array.isArray(backlog.items) || backlog.items.length === 0) {
            issues.push("docs/BACKLOG.json has no items");
        } else {
            for (const item of backlog.items) {
                if (typeof item.id !== "string" || ids.has(item.id)) issues.push(`invalid/duplicate backlog id: ${item.id}`);
                ids.add(item.id);
                if (!allowedStatus.has(item.status)) issues.push(`backlog ${item.id} has invalid status ${item.status}`);
                if (!allowedPriority.has(item.priority)) issues.push(`backlog ${item.id} has invalid priority ${item.priority}`);
                if (typeof item.summary !== "string" || item.summary.trim() === "") issues.push(`backlog ${item.id} has no summary`);
            }
            const direction = backlog.productDirection;
            if (direction?.mode !== "dual-track"
                || !Array.isArray(direction.tracks)
                || !direction.tracks.includes("visual-pixel-editing")
                || !direction.tracks.includes("game-authoring")) {
                issues.push("docs/BACKLOG.json does not preserve the resolved dual-track product direction");
            }
            if (backlog.items.some(i => i.id === "DIRECTION-001" || i.status === "decision")) {
                issues.push("docs/BACKLOG.json still treats the resolved product direction as an open decision");
            }
        }
    } catch (e) {
        issues.push(`docs/BACKLOG.json is not valid JSON: ${e.message}`);
    }

    const trackedAssets = git("ls-files -- freeassets");
    if (trackedAssets) {
        issues.push(`freeassets contains ${trackedAssets.split("\n").length} tracked reference files`);
    }
    return issues;
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

const current = currentSchemaVersion();
const { wrong, unstamped } = checkStamps(current);
const undeclared = checkUndeclared();
const semantic = checkSemanticConsistency(current);

if (stale.length === 0 && wrong.length === 0 && unstamped.length === 0 && undeclared.length === 0 && semantic.length === 0) {
    console.log(`Doc drift: sources, schema-v${current} stamps, roadmap summaries, backlog and tracked-asset policy agree.`);
    process.exit(0);
}

if (stale.length > 0) {
    console.log("Docs whose declared sources moved after the doc was last committed:\n");
    for (const s of stale) {
        console.log(`  ${s.doc}  (${s.reason})`);
        for (const c of s.commits.slice(0, 6)) console.log(`      ${c}`);
        if (s.commits.length > 6) console.log(`      … and ${s.commits.length - 6} more`);
        console.log("");
    }
    console.log("Re-read each doc. If it is still accurate, commit it anyway (e.g. touch the");
    console.log("`describes:` line) — that records the re-read and clears the flag.\n");
}

if (wrong.length > 0) {
    console.log(`Docs whose VERSION STAMP is behind the code (SCHEMA_VERSION is ${current}):\n`);
    for (const w of wrong) console.log(`  ${w.doc}:${w.line}  says schema v${w.said}`);
    console.log("\nA stamp is a claim about what the doc describes. Ancestry cannot catch this:");
    console.log("a doc committed a dozen times still carries whatever banner nobody re-read.\n");
}

if (unstamped.length > 0) {
    console.log("Docs with a frozen banner and NO `schema vNN` stamp — this check cannot see them:\n");
    for (const d of unstamped) console.log(`  ${d}`);
    console.log("");
}

if (undeclared.length > 0) {
    console.log("Docs this tool watches that declare no `describes:` — looked up and SKIPPED:\n");
    for (const d of undeclared) console.log(`  ${d}`);
    console.log("\nBeing skipped in silence is indistinguishable from passing. Add a directive, e.g.");
    console.log("`<!-- describes: src/core -->`, or the doc drifts unwatched.\n");
}
if (semantic.length > 0) {
    console.log("Machine-checkable documentation/repository contradictions:\n");
    for (const issue of semantic) console.log(`  ${issue}`);
    console.log("");
}
process.exit(1);
