/**
 * @module ScriptRunner
 * @description Runs a user script in a WORKER and brings back its requests.
 *
 * The sandbox is defence in depth, not the guarantee. The guarantee is `ScriptApi.compileScript`:
 * whatever comes back is plain data, validated and turned into ordinary Actions by the host. This
 * module's job is narrower — make sure a script cannot reach the things a worker still has, and
 * cannot hang the app.
 *
 * What a worker gives us for free: no DOM, no `window`, and no access to the preload bridge, so a
 * script cannot read the page, touch the filesystem, or call into Electron. What it does NOT give
 * us is a network-free scope, so the bootstrap deletes the network globals before the script is
 * compiled — a design tool's scripts have no business making requests, and a script that could
 * would be an exfiltration path for the document it is handed.
 *
 * The two remaining hazards are handled explicitly rather than hoped away:
 *   - A RUNAWAY script (`while (true) {}`) cannot be interrupted from inside, so the host arms a
 *     timeout and TERMINATES the worker. That is the only reliable stop for a loop, and it is why
 *     scripts run in a worker at all rather than in a scrubbed function on the main thread.
 *   - A script that returns nonsense is not a special case: it flows into the same validation.
 */

import { ScriptSnapshot } from "../core/script/ScriptApi";

/** How long a script may run before the worker is terminated. */
export const SCRIPT_TIMEOUT_MS = 2_000;

export interface ScriptResult {
    /** Plain-data requests, exactly as returned — validation is the host compiler's job. */
    requests: unknown[];
    /** Anything the script printed with `api.log(...)`, in order. */
    log: string[];
    /** A message when the script threw or timed out; null on a clean run. */
    error: string | null;
}

/**
 * The worker's whole program, as source.
 *
 * Built as a STRING and loaded from a blob rather than bundled as a file, because the app is
 * loaded from `file://` in Electron: a separate worker script would be a second file to locate,
 * and a blob URL is the one form that works identically in the packaged app and in a test.
 *
 * The user's code is compiled with `new Function`, so it gets its own scope and cannot see the
 * bootstrap's variables — the requests array is reachable only through the `api` object handed to
 * it. `api` is frozen so a script cannot swap a method for one the host would call later.
 */
const WORKER_SOURCE = `
self.onmessage = function (e) {
    var source = e.data.source, snapshot = e.data.snapshot;
    // Remove what a worker still has and a design script must not: the network is an
    // exfiltration path for the document the script was just handed.
    try {
        self.fetch = undefined; self.XMLHttpRequest = undefined; self.WebSocket = undefined;
        self.importScripts = undefined; self.EventSource = undefined;
        self.indexedDB = undefined; self.caches = undefined;
    } catch (ignored) { /* a frozen global is already unreachable */ }

    var requests = [];
    var log = [];
    var api = Object.freeze({
        nodes: snapshot.nodes,
        move: function (id, x, y) { requests.push({ op: "move", id: id, x: x, y: y }); },
        resize: function (id, width, height) { requests.push({ op: "resize", id: id, width: width, height: height }); },
        style: function (id, style) { requests.push({ op: "style", id: id, style: style }); },
        text: function (id, text) { requests.push({ op: "text", id: id, text: text }); },
        create: function (nodeType, x, y, width, height, fill) {
            requests.push({ op: "create", nodeType: nodeType, x: x, y: y, width: width, height: height, fill: fill });
        },
        remove: function (id) { requests.push({ op: "delete", id: id }); },
        log: function () { log.push(Array.prototype.map.call(arguments, String).join(" ")); }
    });

    var error = null;
    try {
        // Own scope: the script cannot see \`requests\`, \`log\`, or anything else here.
        new Function("api", source)(api);
    } catch (err) {
        error = String(err && err.message ? err.message : err);
    }
    self.postMessage({ requests: requests, log: log, error: error });
};
`;

/**
 * Run `source` against `snapshot`, resolving with whatever it asked for.
 *
 * NEVER REJECTS. A script that throws, times out, or cannot start returns a result with `error`
 * set — the caller is a UI panel showing an author what happened, and an exception crossing that
 * boundary would only turn a script bug into an app bug.
 */
export function runScript(
    source: string,
    snapshot: ScriptSnapshot,
    timeoutMs: number = SCRIPT_TIMEOUT_MS
): Promise<ScriptResult> {
    return new Promise(resolve => {
        let url: string | null = null;
        let worker: Worker | null = null;
        const done = (result: ScriptResult): void => {
            if (worker) worker.terminate();
            if (url) URL.revokeObjectURL(url);
            worker = null;
            resolve(result);
        };
        try {
            url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
            worker = new Worker(url);
        } catch (err) {
            done({ requests: [], log: [], error: `could not start the sandbox: ${String(err)}` });
            return;
        }

        // The timeout is the ONLY way out of an infinite loop: a worker cannot be asked to stop,
        // it can only be terminated, and until it is the app has no idea whether the script is
        // slow or stuck.
        const timer = setTimeout(() => done({
            requests: [], log: [],
            error: `the script ran longer than ${timeoutMs}ms and was stopped`
        }), timeoutMs);

        worker.onmessage = (e: MessageEvent) => {
            clearTimeout(timer);
            const data = e.data as Partial<ScriptResult> | null;
            done({
                requests: Array.isArray(data?.requests) ? data!.requests : [],
                log: Array.isArray(data?.log) ? data!.log : [],
                error: typeof data?.error === "string" ? data.error : null
            });
        };
        worker.onerror = (e: ErrorEvent) => {
            clearTimeout(timer);
            done({ requests: [], log: [], error: e.message || "the script failed to run" });
        };
        worker.postMessage({ source, snapshot });
    });
}

/** The worker program, exported so a test can assert what the sandbox removes. */
export const WORKER_BOOTSTRAP = WORKER_SOURCE;
