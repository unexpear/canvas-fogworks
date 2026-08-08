/**
 * @module menu-command
 * @description Fire a native menu command in the running app — `node scripts/menu-command.js "Zoom to Fit"`.
 *
 * A menu command is a string crossing a process boundary, which makes it the one part of this app
 * that neither side's tests can watch: the renderer's `case` and the menu's `send()` are each
 * correct on their own while the pair does nothing. A jest test pins that they MATCH; this drives
 * them, so what a click really does can be checked against the running window.
 *
 * WHY NOT JUST SEND THE KEY. A menu accelerator is handled before the renderer sees the key, so
 * nothing dispatched into the page can fire one — `dispatchEvent(new KeyboardEvent(...))` is
 * silently ignored. CDP's `Input.dispatchKeyEvent` reaches the browser layer and does work, but
 * only while the window happens to be focused: it fired once here and then quietly stopped, which
 * is the worst behaviour a verification tool can have. Clicking the item through the MAIN process
 * has no such condition and exercises the real closure, the real channel and the real handler.
 *
 * Requires the app started with the main-process inspector open:
 *
 *     npx electron --inspect=9229 dist/electron/main.js --remote-debugging-port=9222
 *
 * `--list` prints every clickable label (with the accelerator Electron shows beside it), which is
 * also the quickest way to see whether an item exists at all.
 */
const PORT = process.env.MENU_INSPECT_PORT || 9229;

function ask(ws, id, method, params) {
    return new Promise((ok, bad) => {
        const timer = setTimeout(() => bad(new Error(`timed out on ${method}`)), 15000);
        const on = (m) => {
            const msg = JSON.parse(m.data);
            if (msg.id !== id) return;
            ws.removeEventListener("message", on);
            clearTimeout(timer);
            if (msg.error) return bad(new Error(JSON.stringify(msg.error)));
            ok(msg.result);
        };
        ws.addEventListener("message", on);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

/**
 * Run in the MAIN process: walk the real application menu and either list it or click one item.
 *
 * Built as a string because it is evaluated over the inspector protocol, and searched DEPTH-FIRST
 * by label so a caller names the item the way the menu shows it rather than by a path.
 */
function program(label) {
    return `(() => {
        const { Menu } = require("electron");
        const root = Menu.getApplicationMenu();
        if (!root) return "no application menu";
        if (${label === null}) {
            const out = [];
            const walk = (m) => m.items.forEach(i => {
                if (i.label) out.push(i.accelerator ? i.label + "  [" + i.accelerator + "]" : i.label);
                if (i.submenu) walk(i.submenu);
            });
            walk(root);
            return JSON.stringify(out);
        }
        const find = (m) => {
            for (const i of m.items) {
                if (i.label === ${JSON.stringify(label)}) return i;
                if (i.submenu) { const r = find(i.submenu); if (r) return r; }
            }
            return null;
        };
        const item = find(root);
        if (!item) return "NO SUCH ITEM: " + ${JSON.stringify(label)};
        if (!item.enabled) return "DISABLED: " + item.label;
        item.click();
        return "clicked " + item.label;
    })()`;
}

(async () => {
    const arg = process.argv[2];
    if (!arg) {
        console.error('usage: node scripts/menu-command.js "<menu item label>" | --list');
        process.exit(2);
    }
    let targets;
    try {
        targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    } catch {
        console.error(`No main-process inspector on ${PORT}. Start the app with:\n`
            + "  npx electron --inspect=9229 dist/electron/main.js --remote-debugging-port=9222");
        process.exit(2);
    }
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("inspector socket failed")); });
    await ask(ws, 1, "Runtime.enable", {});
    const r = await ask(ws, 2, "Runtime.evaluate", {
        expression: program(arg === "--list" ? null : arg),
        includeCommandLineAPI: true, returnByValue: true
    });
    ws.close();
    if (r.exceptionDetails) {
        console.error("threw in the main process:", JSON.stringify(r.exceptionDetails).slice(0, 600));
        process.exit(1);
    }
    const value = r.result.value;
    console.log(value);
    // A missing or disabled item is a FAILURE, not a message: this is used to verify, and a tool
    // that reports "no such item" with exit code 0 is one a script will happily ignore.
    process.exit(/^(NO SUCH ITEM|DISABLED|no application menu)/.test(String(value)) ? 1 : 0);
})();
