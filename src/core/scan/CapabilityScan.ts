/**
 * @module CapabilityScan
 * @description Finds capabilities in a codebase that nothing appears to USE — the things a
 * product can already do that have no way to reach them.
 *
 * The workflow this serves: you point the editor at the source folder of the app you are
 * designing for, and it tells you which handlers, commands and actions exist but are wired to
 * nothing. Those are the screens you still owe the user. (This project found six of its own
 * that way — an engine with flex, grid, effects and design tokens all implemented and
 * unreachable from its UI.)
 *
 * PURE and DOM-free: it takes file contents and returns findings, so the whole heuristic is
 * node-testable, like the layout and geometry engines. Reading the folder is the caller's job.
 *
 * The core definition is deliberately simple and checkable, not clever:
 *
 *   a capability is EXPORTED from one file and REFERENCED IN NO OTHER FILE.
 *
 * That is a fact about the text, not a guess. Everything else here — the verb heuristic, the
 * directory hints — only RANKS what was found, so a wrong guess changes an ordering rather than
 * inventing or hiding a finding. Nothing is reported as unused unless it is genuinely
 * unreferenced elsewhere.
 *
 * It cannot see dynamic dispatch (a handler looked up by a string key, a route table built at
 * runtime, reflection). Those show up as false positives, which is the safe direction: the tool
 * suggests places to look, and a human decides. It never edits the scanned code.
 */

/** One source file to consider. `path` is only used for reporting and directory hints. */
export interface SourceFile {
    path: string;
    content: string;
}

/** How likely a finding is to be something a USER would reach, as opposed to internal plumbing. */
export type Confidence = "high" | "medium" | "low";

export interface Capability {
    /** The exported symbol's name. */
    name: string;
    /** The file that exports it. */
    path: string;
    /** 1-indexed line of the export, so a caller can jump to it. */
    line: number;
    /** What the name/location suggests it is — "command", "handler", "route", or "export". */
    kind: string;
    confidence: Confidence;
    /** Why it was ranked this way, in words a person can check. */
    reason: string;
}

/** Files that are never product code; scanning them produces only noise. */
const IGNORED_SEGMENTS = ["node_modules", ".git", "dist", "build", "out", "coverage", ".next", "vendor"];

/**
 * ENTRY POINTS. A root component, a `main`, a preload script — these are reached by the
 * bundler, the HTML, or the runtime, never by another source file, so "referenced nowhere
 * else" is their NORMAL state. Reporting them would put a confident false positive at the top
 * of every scan and teach people to distrust the list.
 */
const ENTRY_BASENAMES = ["index", "main", "app", "preload", "bootstrap", "entry", "server"];

/**
 * Two different questions, two different filters — conflating them is a bug I hit while
 * building this:
 *
 *  - "may this file DECLARE a capability?" excludes build output, dependencies, tests, type
 *    declarations and entry points.
 *  - "may this file COUNT AS A USE?" excludes only the first four. An entry point is exactly
 *    where an app wires its parts together, so its imports are the strongest evidence a
 *    capability IS reachable. Excluding entries from both lists made every component the entry
 *    imports look unwired.
 */
function isExcludedEntirely(path: string): boolean {
    const p = path.replace(/\\/g, "/").toLowerCase();
    if (IGNORED_SEGMENTS.some(seg => p.includes(`/${seg}/`) || p.startsWith(`${seg}/`))) return true;
    // A symbol used ONLY by its own test is still unwired from the product's point of view,
    // so tests count as neither a declaration site nor a use.
    return /\.(test|spec)\.[jt]sx?$/.test(p) || p.endsWith(".d.ts");
}

function isEntryPoint(path: string): boolean {
    const p = path.replace(/\\/g, "/").toLowerCase();
    const base = (p.split("/").pop() || "").replace(/\.[jt]sx?$/, "");
    return ENTRY_BASENAMES.includes(base);
}

/** Verbs that mark a symbol as something a user triggers rather than internal machinery. */
const ACTION_VERBS = [
    "handle", "on", "do", "run", "exec", "execute", "perform", "trigger", "invoke", "dispatch",
    "create", "add", "new", "insert", "delete", "remove", "destroy", "update", "edit", "save",
    "load", "open", "close", "submit", "send", "cancel", "confirm", "toggle", "select", "apply",
    "import", "export", "publish", "share", "copy", "duplicate", "rename", "move", "search",
    "filter", "sort", "refresh", "reset", "clear", "undo", "redo", "print", "download", "upload"
];

/** Directories whose contents are, by convention, user-facing entry points. */
const CAPABILITY_DIRS = ["command", "commands", "action", "actions", "handler", "handlers", "route", "routes", "api", "endpoints", "menu", "menus"];

function dirHint(path: string): string | null {
    const parts = path.replace(/\\/g, "/").toLowerCase().split("/");
    for (const p of parts) if (CAPABILITY_DIRS.includes(p)) return p;
    return null;
}

function startsWithActionVerb(name: string): string | null {
    // Split a camel/Pascal name into its leading word: `handleSubmit` -> `handle`.
    const first = (name.match(/^[a-z]+|^[A-Z][a-z]*/) || [""])[0].toLowerCase();
    return ACTION_VERBS.includes(first) ? first : null;
}

/** Every exported symbol in a file, with the line it appears on. */
function exportsOf(file: SourceFile): { name: string; line: number }[] {
    const found: { name: string; line: number }[] = [];
    const lines = file.content.split(/\r?\n/);
    lines.forEach((text, i) => {
        // `export function foo`, `export async function foo`, `export class Foo`
        const decl = text.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/);
        if (decl) { found.push({ name: decl[1], line: i + 1 }); return; }
        // `export const foo =`, `export let foo =`
        const binding = text.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
        if (binding) { found.push({ name: binding[1], line: i + 1 }); return; }
        // `export { a, b as c }` — the EXPORTED name is what another file would import.
        const list = text.match(/^\s*export\s*\{([^}]*)\}/);
        if (list) {
            for (const part of list[1].split(",")) {
                const m = part.trim().match(/(?:\w+\s+as\s+)?([A-Za-z_$][\w$]*)\s*$/);
                if (m) found.push({ name: m[1], line: i + 1 });
            }
        }
    });
    return found;
}

/** Whether `name` appears anywhere in `content` as a whole word. */
function mentions(content: string, name: string): boolean {
    return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(content);
}

/**
 * Find exported capabilities that no OTHER file references.
 *
 * `files` should be the product's source files; test files and build output are skipped, since
 * a symbol used only by its own test is still unwired from the product's point of view — which
 * is exactly what this is looking for.
 */
export function scanCapabilities(files: readonly SourceFile[]): Capability[] {
    // Everything an app is actually built from — the corpus a USE may come from.
    const corpus = files.filter(f => !isExcludedEntirely(f.path));
    // …of which these may DECLARE a capability (see the note on the two filters).
    const declarers = corpus.filter(f => !isEntryPoint(f.path));
    const out: Capability[] = [];

    for (const file of declarers) {
        for (const { name, line } of exportsOf(file)) {
            // Referenced by any OTHER product file? Then it is wired to something.
            const usedElsewhere = corpus.some(other => other.path !== file.path && mentions(other.content, name));
            if (usedElsewhere) continue;

            const verb = startsWithActionVerb(name);
            const dir = dirHint(file.path);
            let confidence: Confidence = "low";
            let reason = "exported but not referenced in any other file";
            let kind = "export";

            // A CONSTANT_CASE name is a tuning value, not something a user triggers. Without
            // this, a stray `const` in an actions/ directory outranks every real finding —
            // which is what running this over its own repository actually produced.
            if (/^[A-Z0-9_]+$/.test(name)) {
                out.push({ name, path: file.path, line, kind: "constant", confidence: "low", reason: "an exported constant, referenced nowhere else" });
                continue;
            }
            if (dir && verb) {
                confidence = "high";
                kind = dir.replace(/s$/, "");
                reason = `an action-style name in a ${dir}/ directory, referenced nowhere else`;
            } else if (dir) {
                confidence = "medium";
                kind = dir.replace(/s$/, "");
                reason = `exported from a ${dir}/ directory but referenced nowhere else`;
            } else if (verb) {
                confidence = "medium";
                kind = "handler";
                reason = `named like an action ("${verb}…") but referenced nowhere else`;
            }
            out.push({ name, path: file.path, line, kind, confidence, reason });
        }
    }

    // Most likely to matter first; then stable by path and line so a re-scan of unchanged code
    // returns an identical list (a jumping report is one nobody trusts).
    const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) =>
        rank[a.confidence] - rank[b.confidence] || a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name));
}
