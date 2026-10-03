/**
 * @module TokensPanel
 * @description Design-token authoring and the colour-slot picker extracted from
 * the app shell. Creates, themes and deletes still go through the variable actions.
 */

import React, { useState } from "react";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { DeleteVariableAction, SetVariableAction } from "../core/actions/VariableActions";
import { tokenKeyOf, tokenRefFor, Variable, VariableStore, variableKeyError } from "../core/document/Variables";

const ui = {
    bg: "#0e0e18",
    raised: "#1c1c33",
    line: "#262642",
    text: "#dcdce8",
    textDim: "#8a8aa5",
    textFaint: "#5f5f7a",
    accent: "#4da3ff"
};

function NumInput({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
    return (
        <input
            type="number"
            value={value}
            disabled={disabled}
            // Skip non-numeric input rather than substituting 0: `|| 0` turned a
            // half-typed value (or "-") into a real edit that snapped the node to 0.
            onChange={e => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v)) onChange(v);
            }}
            style={{
                width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                background: ui.bg, color: ui.text, border: "1px solid #2a2a4a", borderRadius: 2, marginBottom: 4
            }}
        />
    );
}

export interface TokenSelectProps {
    store: VariableStore;
    value: string;
    onPick: (v: string) => void;
}

/**
 * Assign a design token to a colour slot. Without this, tokens are creatable but unusable —
 * the same "built but unreachable" trap this whole stretch of work has been closing.
 *
 * Shows the CURRENT value as `$key` when the slot already holds a reference, so you can see at
 * a glance which colours are tokenised and which are hardcoded.
 */
export function TokenSelect({ store, value, onPick }: TokenSelectProps) {
    const colorKeys = Object.keys(store).filter(k => store[k].type === "color").sort();
    if (colorKeys.length === 0) return null;
    const current = tokenKeyOf(value);
    return (
        <select
            value={current}
            onChange={e => onPick(tokenRefFor(e.target.value))}
            title="Use a design token for this colour"
            style={{
                width: "100%", boxSizing: "border-box", fontSize: 10, padding: "1px 3px", marginBottom: 4,
                background: ui.raised, color: current ? ui.accent : ui.textDim, border: `1px solid ${ui.line}`, borderRadius: 2
            }}
        >
            <option value="">— no token (fixed colour) —</option>
            {colorKeys.map(k => <option key={k} value={k}>${k}</option>)}
        </select>
    );
}

export interface TokensPanelProps {
    dispatcher: ActionDispatcher;
    refresh: () => void;
}

/**
 * Design tokens reaching the UI.
 *
 * The store, per-theme values, alias resolution, cycle safety and the visible magenta fallback
 * have all been in the engine and both renderers since schema 19. Nothing could create a token,
 * so `$color/brand` only existed if you hand-edited the file.
 *
 * Every edit goes through the existing `SetVariableAction` / `DeleteVariableAction`, so tokens
 * inherit validation and undo exactly like a node edit. Deleting a token in use is deliberately
 * allowed: a dangling reference is valid at rest and renders the fallback, which is the same
 * rule a dangling `componentId` follows — the alternative is a delete that refuses to run and
 * gives no way out.
 */
export function TokensPanel({ dispatcher, refresh }: TokensPanelProps) {
    const [newKey, setNewKey] = useState("");
    const doc = dispatcher.getDocument();
    const store = doc.variables as VariableStore;
    const theme = doc.activeTheme;
    const keys = Object.keys(store).sort();

    const set = (key: string, variable: Variable) => {
        dispatcher.dispatchAction(new SetVariableAction(dispatcher.getDocument(), key, variable), { coalesce: true });
        refresh();
    };

    return (
        <div style={{ fontSize: 11 }}>
            <div style={{ color: ui.textFaint, marginBottom: 6 }}>
                Values resolve against the active theme ({theme}). A token used by a style shows through
                every node at once.
            </div>

            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                <input
                    type="text"
                    value={newKey}
                    placeholder="color/brand"
                    onChange={e => setNewKey(e.target.value)}
                    onKeyDown={e => {
                        if (e.key !== "Enter") return;
                        const key = newKey.trim();
                        if (!key) return;
                        // The shared `variableKeyError` is the authority — the field just explains.
                        const err = variableKeyError(key);
                        if (err) { window.alert(`That token name can't be used: ${err}.`); return; }
                        set(key, { type: key.startsWith("spacing") || key.startsWith("radius") ? "spacing" : "color", value: key.startsWith("spacing") || key.startsWith("radius") ? 8 : "#4a90d9" });
                        setNewKey("");
                    }}
                    style={{ flex: 1, boxSizing: "border-box", fontSize: 11, padding: "3px 5px", background: ui.raised, color: ui.text, border: `1px solid ${ui.line}`, borderRadius: 3 }}
                />
            </div>

            {keys.length === 0 && (
                <div style={{ color: ui.textFaint }}>No tokens yet. Type a name and press Enter — a name starting with “spacing” or “radius” becomes a number token.</div>
            )}

            {keys.map(key => {
                const v = store[key];
                const themed = v.modes?.[theme];
                const isColor = v.type === "color";
                return (
                    <div key={key} style={{ borderTop: `1px solid ${ui.line}`, padding: "6px 0" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ flex: 1, color: ui.text, wordBreak: "break-all" }}>${key}</span>
                            <button
                                title="Delete this token — anything using it falls back to the debug colour"
                                onClick={() => {
                                    dispatcher.dispatchAction(new DeleteVariableAction(dispatcher.getDocument(), key));
                                    refresh();
                                }}
                                style={{ fontSize: 10, padding: "0 5px", background: "transparent", color: ui.textDim, border: `1px solid ${ui.line}`, borderRadius: 2, cursor: "pointer" }}
                            >✕</button>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 4, alignItems: "center", marginTop: 3 }}>
                            <span style={{ color: ui.textFaint }}>base</span>
                            {isColor ? (
                                <input
                                    type="color"
                                    value={typeof v.value === "string" && /^#[0-9a-fA-F]{6}$/.test(v.value) ? v.value : "#888888"}
                                    onChange={e => set(key, { ...v, value: e.target.value })}
                                    style={{ width: "100%", height: 20, border: "none", background: "transparent", cursor: "pointer" }}
                                />
                            ) : (
                                <NumInput value={typeof v.value === "number" ? v.value : 0} onChange={n => set(key, { ...v, value: n })} />
                            )}
                            {/* A per-theme override is what makes a token more than a constant. */}
                            <span style={{ color: ui.textFaint }}>{theme}</span>
                            {isColor ? (
                                <input
                                    type="color"
                                    value={typeof themed === "string" && /^#[0-9a-fA-F]{6}$/.test(themed) ? themed : "#888888"}
                                    onChange={e => set(key, { ...v, modes: { ...v.modes, [theme]: e.target.value } })}
                                    style={{ width: "100%", height: 20, border: "none", background: "transparent", cursor: "pointer", opacity: themed === undefined ? 0.35 : 1 }}
                                />
                            ) : (
                                <NumInput value={typeof themed === "number" ? themed : (typeof v.value === "number" ? v.value : 0)}
                                    onChange={n => set(key, { ...v, modes: { ...v.modes, [theme]: n } })} />
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
