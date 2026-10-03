/**
 * @module TimelineTransport
 * @description The timeline strip extracted from the app shell: play, scrub,
 * keyframe buttons and onion skin. Playback and track edits stay in App.
 */

import React from "react";

const panel = "#15152a";
const line = "#262642";
const accent = "#4da3ff";

const buttonStyle: React.CSSProperties = {
    fontSize: 12, padding: "3px 6px", background: "transparent", color: "#ccc",
    border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer", minWidth: 24
};

export type TimelineKeyframeMode = "none" | "held" | "tween";

export interface TimelineTransportProps {
    frames: number;
    fps: number;
    frame: number;
    rangeFrom: number;
    rangeTo: number;
    playing: boolean;
    playingTimeline: boolean;
    onion: boolean;
    /**
     * Shown only when the playhead is ON a keyframe, because easing describes the tween leaving
     * one — offering it anywhere else would be a control that silently does nothing.
     */
    keyframe: TimelineKeyframeMode;
    easingControl: React.ReactNode;
    onTogglePlay: () => void;
    onScrub: (frame: number) => void;
    onKey: () => void;
    onHold: () => void;
    onRemoveKey: () => void;
    onToggleOnion: () => void;
}

export function TimelineTransport({ frames, fps, frame, rangeFrom, rangeTo, playing, playingTimeline,
    onion, keyframe, easingControl, onTogglePlay, onScrub, onKey, onHold, onRemoveKey, onToggleOnion }: TimelineTransportProps) {
    return (
        <div style={{ padding: "4px 10px", background: panel, borderTop: `1px solid ${line}`,
                      display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#ccc" }}>
            <button style={buttonStyle} title="Play the selected clip or timeline from the playhead" disabled={playing}
                onClick={onTogglePlay}>
                {playingTimeline ? "⏸" : "▶"}
            </button>
            <input
                type="range" min={rangeFrom} max={rangeTo} step={1} disabled={playing}
                value={frame}
                onChange={e => onScrub(parseInt(e.target.value, 10))}
                style={{ flex: 1 }}
                title="Scrub the playhead. Scrubbing is not an edit — it pushes no undo step."
            />
            <span style={{ width: 84, textAlign: "right", color: "#888" }}>
                {frame} / {frames - 1} · {fps}fps
            </span>
            <button style={buttonStyle} onClick={onKey}
                title="Key the selected node here, TWEENING from it to the next keyframe">◆ Key</button>
            <button style={buttonStyle} onClick={onHold}
                title="Key the selected node here and HOLD it until the next keyframe — frame-by-frame animation">◼ Hold</button>
            <button style={buttonStyle} onClick={onRemoveKey}
                title="Remove the keyframe on this frame">✕</button>
            {keyframe === "held"
                ? <span style={{ color: "#666", fontSize: 11 }} title="A HELD keyframe does not tween, so it has no curve to shape.">held</span>
                : keyframe === "tween" ? easingControl : null}
            <button style={{ ...buttonStyle, color: onion ? accent : "#ccc" }}
                onClick={onToggleOnion}
                title="ONION SKIN: draw the neighbouring frames faintly behind this one. Ghosts are not pickable — they are a picture of another moment.">
                ◐ Onion
            </button>
        </div>
    );
}
