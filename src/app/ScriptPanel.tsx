/**
 * @module ScriptPanel
 * @description The script side panel extracted from the app shell. It still runs
 * in the sandbox and compiles the result into one undoable transaction.
 */

import React, { useState } from "react";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { compileScript, snapshotFor } from "../core/script/ScriptApi";
import { runScript } from "../editor/ScriptRunner";

const ui = {
    bg: "#0e0e18",
    line: "#262642",
    text: "#dcdce8",
    textDim: "#8a8aa5",
    textFaint: "#5f5f7a",
    accentSoft: "#22436b"
};

export interface ScriptPanelProps {
    dispatcher: ActionDispatcher;
    refresh: () => void;
}

/**
 * Write a small program, run it, and see what it did.
 *
 * The panel is deliberately thin, because none of the safety lives here: the script runs in a
 * worker (`runScript`) and comes back as plain data, which `compileScript` turns into ordinary
 * Actions — the same ones the inspector builds — inside ONE transaction. So a script is one undo,
 * and a script cannot do anything a person could not do by hand.
 *
 * Refusals are SHOWN. A script that asked for twelve things and got ten is a fact its author
 * needs; swallowing the two would leave them debugging a program that looked like it ran.
 */
export function ScriptPanel({ dispatcher, refresh }: ScriptPanelProps) {
    const [source, setSource] = useState(
        "// `api.nodes` is a snapshot; every call queues one edit.\n" +
        "for (const n of api.nodes) {\n" +
        "  if (n.type === \"core.rectangle\") api.style(n.id, { fill: \"#00bfff\" });\n" +
        "}\n"
    );
    const [output, setOutput] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    const run = async () => {
        setBusy(true);
        setOutput([]);
        const doc = dispatcher.getDocument();
        const result = await runScript(source, snapshotFor(doc));
        const lines = [...result.log];
        if (result.error) lines.push(`error: ${result.error}`);

        // Compile against the CURRENT document — the script ran against a snapshot, and anything
        // that changed underneath it is caught by each Action's own validator rather than assumed.
        const compiled = compileScript(dispatcher.getDocument(), result.requests, () => crypto.randomUUID());
        lines.push(...compiled.refusals.map(r => `refused ${r}`));
        if (compiled.action) {
            const ok = dispatcher.dispatchAction(compiled.action).success;
            lines.push(ok ? `applied ${result.requests.length - compiled.refusals.length} edit(s) — one undo`
                : "the transaction was refused as a whole");
        } else if (!result.error) {
            lines.push("nothing to apply");
        }
        setOutput(lines);
        setBusy(false);
        refresh();
    };

    return (
        <>
            <div style={{ color: ui.textFaint, fontSize: 10, marginBottom: 6 }}>
                Runs in a sandbox with no page, no filesystem and no network. It can only ask for
                edits — each one is validated, and the whole run is a single undo.
            </div>
            <textarea
                value={source}
                onChange={e => setSource(e.target.value)}
                spellCheck={false}
                style={{
                    width: "100%", height: 180, boxSizing: "border-box", fontSize: 11,
                    fontFamily: "ui-monospace, Consolas, monospace", padding: 6,
                    background: ui.bg, color: ui.text, border: `1px solid ${ui.line}`, borderRadius: 3
                }}
            />
            <button
                onClick={run}
                disabled={busy}
                style={{
                    marginTop: 6, width: "100%", fontSize: 11, padding: "4px 8px",
                    background: busy ? "transparent" : ui.accentSoft, color: "#ccc",
                    border: `1px solid ${ui.line}`, borderRadius: 3, cursor: busy ? "default" : "pointer"
                }}
            >{busy ? "Running…" : "▶ Run"}</button>
            {output.length > 0 && (
                <pre style={{
                    marginTop: 8, fontSize: 10, whiteSpace: "pre-wrap", color: ui.textDim,
                    background: ui.bg, border: `1px solid ${ui.line}`, borderRadius: 3, padding: 6
                }}>{output.join("\n")}</pre>
            )}
        </>
    );
}
