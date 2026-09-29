/**
 * @module DocumentControls
 * @description Document-level toolbar controls extracted from the app shell:
 * theme, named state, timeline, lighting, background and screen size.
 * Dispatch stays in App so each control still reads the live document.
 */

import React from "react";
import { ReadonlyDocument } from "../core/document/Document";

const accent = "#4da3ff";
const accentSoft = "#22436b";
const line = "#262642";

export interface DocumentControlsProps {
    document: ReadonlyDocument;
    playing: boolean;
    onToggleTheme: () => void;
    onSetActiveState: (state: string | null) => void;
    onToggleTimeline: () => void;
    onToggleLighting: () => void;
    onSetBackground: (color: string | undefined) => void;
    onCommitScreen: (axis: "width" | "height", value: number) => void;
    onClearScreen: () => void;
}

export function DocumentControls({ document, playing, onToggleTheme, onSetActiveState,
    onToggleTimeline, onToggleLighting, onSetBackground, onCommitScreen, onClearScreen }: DocumentControlsProps) {
    const names = new Set<string>();
    document.nodes.forEach(n => { for (const k of Object.keys(n.states ?? {})) names.add(k); });
    const clipsBlockTimeline = !!document.clips?.length;

    return <>
        <button
            title="Switch the document's theme mode — $token colors re-resolve against the variable store (undoable, persisted)"
            onClick={onToggleTheme}
            style={{ fontSize: 11, padding: "3px 8px", marginRight: 8, background: "transparent", color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
        >
            Theme: {document.activeTheme === "light" ? "Light" : "Dark"}
        </button>
        {/* Which state the whole document shows — the same document-level selection as the theme.
            Only appears once something defines a state; otherwise it would be a control with one option. */}
        {names.size > 0 && (
            <select
                title="Show every node in this named state"
                value={document.activeState ?? ""}
                onChange={e => onSetActiveState(e.target.value || null)}
                style={{ fontSize: 11, padding: "3px 8px", marginRight: 8, background: document.activeState ? accentSoft : "transparent", color: "#ccc", border: `1px solid ${line}`, borderRadius: 3, cursor: "pointer" }}
            >
                <option value="">State: base</option>
                {[...names].sort().map(n => <option key={n} value={n}>State: {n}</option>)}
            </select>
        )}
        {/* A document has no clock until somebody asks for one, so a still drawing carries no timeline strip. */}
        <button
            title={clipsBlockTimeline ? "Remove named clips before removing their timeline" : "Give this document a timeline (24 frames at 12fps), or take it away again"}
            disabled={playing || clipsBlockTimeline}
            onClick={onToggleTimeline}
            style={{ fontSize: 11, padding: "3px 8px", marginLeft: 4, background: "transparent",
                     color: document.timeline ? accent : "#ccc",
                     border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
        >⏱ Timeline</button>
        {/* A document is unlit until somebody asks, and an unlit one draws as it did before lighting existed. */}
        <button
            title="Light the scene from the top-left, or turn the lights off again. Raise a mesh control point's HEIGHT to give a shape something to shade."
            onClick={onToggleLighting}
            style={{ fontSize: 11, padding: "3px 8px", marginLeft: 4, background: "transparent",
                     color: document.lights ? accent : "#ccc",
                     border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
        >☀ Light</button>
        {/* The document's background. Absent shows the editor backdrop; clear removes it entirely. */}
        <input
            type="color"
            data-doc-background="1"
            title="What the document sits on. Exported, drawn by all three backends, and read from a Tiled map's backgroundcolor."
            value={document.background ?? "#1a1a2e"}
            onChange={e => onSetBackground(e.target.value)}
            style={{ width: 26, height: 20, marginLeft: 4, padding: 0, background: "transparent",
                     border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer",
                     verticalAlign: "middle" }}
        />
        {document.background !== undefined && (
            <button
                data-doc-background-clear="1"
                title="Remove the background, so the document has none at all again."
                onClick={() => onSetBackground(undefined)}
                style={{ fontSize: 11, padding: "3px 6px", marginLeft: 2, background: "transparent",
                         color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
            >✕</button>
        )}
        {/* One screen of the game, drawn on the canvas as a translucent outline. */}
        <span title="One screen of the game: the play area's size, drawn as an outline on the canvas. The camera and death plane will read this in a later slice."
              style={{ marginLeft: 8, fontSize: 11, color: "#888" }}>screen</span>
        <input
            type="number" min={1} data-doc-screen="w" placeholder="w"
            value={document.screen?.width ?? ""}
            onChange={e => {
                const w = Number(e.target.value);
                if (!Number.isFinite(w) || w <= 0) return;
                onCommitScreen("width", w);
            }}
            style={{ width: 46, fontSize: 11, marginLeft: 3, padding: "2px 3px", background: "transparent",
                     color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3 }}
        />
        <input
            type="number" min={1} data-doc-screen="h" placeholder="h"
            value={document.screen?.height ?? ""}
            onChange={e => {
                const h = Number(e.target.value);
                if (!Number.isFinite(h) || h <= 0) return;
                onCommitScreen("height", h);
            }}
            style={{ width: 46, fontSize: 11, marginLeft: 2, padding: "2px 3px", background: "transparent",
                     color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3 }}
        />
        {document.screen !== undefined && (
            <button
                data-doc-screen-clear="1"
                title="Remove the screen declaration, so the document has none again."
                onClick={onClearScreen}
                style={{ fontSize: 11, padding: "3px 6px", marginLeft: 2, background: "transparent",
                         color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
            >✕</button>
        )}
    </>;
}
