/**
 * @module AppShellControls
 * @description DOM-facing workspace, 3D transform and runtime controls extracted
 * from the top-level shell so their visible states and interactions can be tested.
 */

import React from "react";
import { GizmoMode3D, GizmoSpace3D } from "../renderer/Gizmo3D";

export type Workspace = "design" | "paint" | "animate" | "map" | "3d";

export interface WorkspaceDefinition {
    id: Workspace;
    label: string;
    icon: string;
    tools: string[];
    defaultTool: string;
}

export const WORKSPACES: WorkspaceDefinition[] = [
    { id: "design", label: "Design", icon: "◱", tools: ["select", "move", "shapes", "pen"], defaultTool: "select" },
    { id: "paint", label: "Paint", icon: "✏", tools: ["select", "move", "raster", "marquee", "paint", "bucket", "eyedropper"], defaultTool: "paint" },
    { id: "animate", label: "Animate", icon: "⏱", tools: ["select", "move", "weights"], defaultTool: "select" },
    { id: "map", label: "Map", icon: "▦", tools: ["select", "move", "tiles"], defaultTool: "tiles" },
    { id: "3d", label: "3D", icon: "◇", tools: ["select"], defaultTool: "select" }
];

const palette = {
    raised: "#1c1c33",
    line: "#262642",
    textDim: "#8a8aa5",
    textFaint: "#5f5f7a"
};

const actionButton: React.CSSProperties = {
    padding: "2px 6px",
    fontSize: 10,
    background: palette.raised,
    color: palette.textDim,
    border: `1px solid ${palette.line}`,
    borderRadius: 3,
    cursor: "pointer"
};

export interface WorkspaceControlsProps {
    workspace: Workspace;
    gizmoMode: GizmoMode3D;
    gizmoSpace: GizmoSpace3D;
    canCompose2D: boolean;
    onWorkspaceChange: (workspace: Workspace) => void;
    onGizmoModeChange: (mode: GizmoMode3D) => void;
    onGizmoSpaceChange: (space: GizmoSpace3D) => void;
    onAddLight: (kind: "directional" | "point") => void;
    onCompose2D: () => void;
}

export function WorkspaceControls(props: WorkspaceControlsProps) {
    const { workspace, gizmoMode, gizmoSpace, canCompose2D, onWorkspaceChange,
        onGizmoModeChange, onGizmoSpaceChange, onAddLight, onCompose2D } = props;
    return <>
        <div role="tablist" aria-label="Workspace" style={{ display: "flex", gap: 2, marginRight: 10 }}>
            {WORKSPACES.map(item => (
                <button key={item.id} role="tab" aria-selected={workspace === item.id}
                    title={`${item.label} workspace`} onClick={() => onWorkspaceChange(item.id)}
                    style={{
                        display: "flex", alignItems: "center", gap: 4, padding: "3px 9px", fontSize: 11,
                        background: workspace === item.id ? "#2a4a6a" : "transparent",
                        color: workspace === item.id ? "#fff" : "#aaa",
                        border: "none", borderRadius: 3, cursor: "pointer"
                    }}>
                    <span aria-hidden="true">{item.icon}</span><span>{item.label}</span>
                </button>
            ))}
        </div>
        {workspace === "3d" && (
            <div aria-label="3D transform controls"
                style={{ display: "flex", alignItems: "center", gap: 3, marginRight: 8 }}>
                {(["translate", "rotate", "scale"] as const).map(mode => (
                    <button key={mode} data-gizmo-mode={mode} aria-pressed={gizmoMode === mode}
                        onClick={() => onGizmoModeChange(mode)}
                        style={{ ...actionButton,
                            background: gizmoMode === mode ? "#2a4a6a" : palette.raised,
                            color: gizmoMode === mode ? "#fff" : palette.textDim }}>
                        {mode[0].toUpperCase()}
                    </button>
                ))}
                {gizmoMode !== "scale" && (["world", "local"] as const).map(space => (
                    <button key={space} data-gizmo-space={space} aria-pressed={gizmoSpace === space}
                        onClick={() => onGizmoSpaceChange(space)}
                        style={{ ...actionButton,
                            background: gizmoSpace === space ? "#2a4a6a" : palette.raised,
                            color: gizmoSpace === space ? "#fff" : palette.textDim }}>
                        {space[0].toUpperCase() + space.slice(1)}
                    </button>
                ))}
                <button data-add-light-3d="directional" onClick={() => onAddLight("directional")}
                    title="Add a directional light emitting along local −Z"
                    style={{ ...actionButton, marginLeft: 4 }}>☀ Directional</button>
                <button data-add-light-3d="point" onClick={() => onAddLight("point")}
                    title="Add a point light with inverse-square falloff"
                    style={actionButton}>● Point</button>
                <button data-compose-2d-3d onClick={onCompose2D} disabled={!canCompose2D}
                    title="Place the selected 2D visual on an explicit 3D plane"
                    style={actionButton}>▣ 2D Surface</button>
                <span title="Orbit: Alt+drag or middle-drag · Pan: add Shift · Dolly: wheel"
                    style={{ marginLeft: 4, color: palette.textFaint, fontSize: 9, whiteSpace: "nowrap" }}>
                    Orbit: Alt/MMB · Wheel
                </span>
            </div>
        )}
    </>;
}

export interface RuntimeControlsProps {
    playing: boolean;
    canRestart: boolean;
    canRespawn: boolean;
    onTogglePlay: () => void;
    onRestart: () => void;
    onRespawn: () => void;
}

export function RuntimeControls({ playing, canRestart, canRespawn, onTogglePlay,
    onRestart, onRespawn }: RuntimeControlsProps) {
    return <>
        <button
            title={playing ? "Stop — back to editing" : "Play the prototype: clicks and hovers fire interactions"}
            onClick={onTogglePlay}
            style={{
                fontSize: 11, padding: "3px 10px", borderRadius: 3, cursor: "pointer",
                background: playing ? "#00bfff" : "transparent",
                color: playing ? "#0b0b18" : "#ccc",
                border: `1px solid ${playing ? "#00bfff" : "#2a2a4a"}`
            }}>
            {playing ? "■ Stop" : "▶ Play"}
        </button>
        {playing && canRestart && <>
            <button title="Restart the level and clear all run state" onClick={onRestart}
                style={actionButton}>↻ Restart</button>
            {canRespawn && <button
                title="Respawn at the player's typed respawn anchor; keep tallies and power"
                onClick={onRespawn} style={actionButton}>◆ Respawn</button>}
        </>}
    </>;
}
