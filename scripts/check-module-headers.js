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
