/**
 * @module check-module-headers
 * @description Enforces the CODING-STANDARDS rule that every source module opens
 * with a `@module` / `@description` JSDoc header stating its single responsibility.
 *
 * Deliberately a ~40-line script rather than ESLint: the project has exactly one
 * rule to enforce here and zero lint tooling today. Adding eslint +
 * @typescript-eslint + eslint-plugin-jsdoc would bring a config surface and a
 * dependency tree far larger than the rule being enforced, and would immediately
 * want opinions on a hundred rules nobody has triaged. If a second or third rule
 * ever appears, swap this for ESLint then.
 */

const fs = require("fs");
const path = require("path");

const ROOTS = ["src", "scripts"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js"]);
/** Test files document themselves by name and describe blocks. */
const EXCLUDE = /\.(test|spec)\.(ts|tsx|js)$/;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (EXTENSIONS.has(path.extname(entry.name)) && !EXCLUDE.test(entry.name)) out.push(full);
    }
    return out;
}

const rootDir = path.join(__dirname, "..");
const offenders = [];

for (const root of ROOTS) {
    const dir = path.join(rootDir, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
        const head = fs.readFileSync(file, "utf-8").slice(0, 400);
        if (!/@module\b/.test(head) || !/@description\b/.test(head)) {
            offenders.push(path.relative(rootDir, file).replace(/\\/g, "/"));
        }
    }
}

// SHADER SOURCES must contain no backtick. They are GLSL held in TEMPLATE LITERALS, so a comment
// quoting a symbol name the way every other comment in this codebase does TERMINATES the string,
// and the failure surfaces as a TS1005 pointing at a line of GLSL — which reads as anything but
// its cause. It cost a round twice before this check existed.
/**
 * A CONTROL CHARACTER IN SOURCE — the one defect nothing else in this project can see.
 *
 * `tsc` compiles it, esbuild bundles it, jest runs it, and a terminal RENDERS it by erasing the
 * character before it, so the source reads correctly on screen while meaning something else. It cost
 * an hour on 2026-08-10: a word-boundary escape in a regex arrived as a literal 0x08 through a shell
 * heredoc, turning a pattern that matches every object tag into one that matches nothing — in a
 * reader that then silently found zero objects in a file full of them.
 *
 * TAB, NEWLINE AND CARRIAGE RETURN ARE THE ONLY ONES ALLOWED, because they are the only ones that
 * mean anything in a text file. Everything else in the C0 range is a transcription accident, and the
 * moment it arrives is the only cheap moment to find it.
 */
const controlOffenders = [];
for (const root of ROOTS) {
    const dir = path.join(rootDir, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
        const text = fs.readFileSync(file, "utf-8");
        const m = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(text);
        if (!m) continue;
        const line = text.slice(0, m.index).split("\n").length;
        const code = "0x" + m[0].charCodeAt(0).toString(16).padStart(2, "0");
        controlOffenders.push(
            path.relative(rootDir, file).split(path.sep).join("/") + ":" + line + " holds " + code);
    }
}

const shaderOffenders = [];
for (const root of ROOTS) {
    const dir = path.join(rootDir, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
        const text = fs.readFileSync(file, "utf-8");
        // The body runs to the first backtick-then-SEMICOLON, which is how these constants
        // actually end. Counting matched pairs instead does not work and was tried: an injected
        // backtick simply becomes the closing one, the counts stay equal, and the check passes on
        // exactly the file it exists for. Verified by reintroducing the bug on purpose.
        const bodies = text.match(/const\s+\w*SHADER\w*\s*=\s*`[\s\S]*?`;/g) || [];
        const broken = bodies.some(b => b.slice(b.indexOf("`") + 1, -2).includes("`"));
        if (broken) shaderOffenders.push(path.relative(rootDir, file).split(path.sep).join("/"));
    }
}

// A .js FILE UNDER `scripts/` MUST PARSE, and nothing else in the gate ever finds out. `npm run
// check` typechecks `src` and runs jest; it never loads a tool script, so a syntax error in one sits
// there looking fine until somebody runs that tool. That is exactly what happened: a mutation's
// `from` was written with a REAL newline inside a JS string literal instead of an escape, the file
// stopped parsing, `npm run check` and `npm run lint` both passed, and it was COMMITTED — the
// mutation battery then died on load, which is a tool reporting nothing rather than a tool reporting
// a problem. `vm.compileFunction` compiles WITHOUT executing, which matters: requiring these scripts
// would run them.
const parseOffenders = [];
for (const file of walk(path.join(rootDir, "scripts"))) {
    if (path.extname(file) !== ".js") continue;
    try {
        require("vm").compileFunction(fs.readFileSync(file, "utf-8"), [], { filename: file });
    } catch (e) {
        parseOffenders.push(`${path.relative(rootDir, file).split(path.sep).join("/")}: ${e.message}`);
    }
}
if (parseOffenders.length > 0) {
    console.error(
        `A script under scripts/ does not parse (${parseOffenders.length}):\n`
        + parseOffenders.map(f => "  " + f).join("\n")
        + "\n\nNothing else in the gate loads these, so this is the only thing that would notice."
    );
    process.exit(1);
}

if (controlOffenders.length > 0) {
    console.error(
        "A CONTROL CHARACTER is in the source of " + controlOffenders.length + " file(s):\n" +
        controlOffenders.map(f => "  " + f).join("\n") +
        "\n\nNothing else notices: it compiles, it bundles, it runs, and a terminal hides it by\n" +
        "erasing the character before it. Usually an escape eaten by a shell heredoc."
    );
    process.exit(1);
}

if (shaderOffenders.length > 0) {
    console.error(
        "A backtick inside a shader template literal in " + shaderOffenders.length + " file(s):\n" +
        shaderOffenders.map(f => "  " + f).join("\n") +
        "\n\nGLSL comments must not quote symbols with backticks - the string ends there."
    );
    process.exit(1);
}

if (offenders.length > 0) {
    console.error(
        `Missing a @module/@description header in ${offenders.length} file(s):\n` +
        offenders.map(f => `  ${f}`).join("\n") +
        "\n\nSee docs/CODING-STANDARDS.md § Type & style."
    );
    process.exit(1);
}

console.log(`Module headers OK (${ROOTS.join(", ")}).`);
