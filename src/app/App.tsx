/**
 * @module App
 * @description Top-level React shell. Renders the toolbar, canvas, layers panel,
 * inspector, and status bar.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { createEmptyDocument, CURRENT_VERSION } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { Serializer, serializeDocument, deserializeDocument, CORRUPT_BACKUP_KEY } from "../core/document/Serializer";
import { traverseSceneGraph, ReadonlyNode } from "../core/document/SceneGraph";
import { computeGeometry, ComputedState } from "../core/geometry/GeometryEngine";
import { UpdateNodeGeometryAction } from "../core/actions/UpdateNodeGeometryAction";
import { UpdateNodeStyleAction } from "../core/actions/UpdateNodeStyleAction";
import { createEditorState, EditorState, clampViewport } from "../editor/EditorState";
import { ToolController } from "../editor/tools/ToolController";
import { SelectTool } from "../editor/tools/SelectTool";
import { MoveTool } from "../editor/tools/MoveTool";
import { RectangleTool } from "../editor/tools/RectangleTool";
import { renderSVG, RendererState } from "../renderer/SVGRenderer";

declare global {
    interface Window {
        electronAPI?: {
            onMenuNew: (cb: () => void) => () => void;
            onMenuSave: (cb: () => void) => () => void;
            onFileOpened: (cb: (payload: { filePath: string; content: string }) => void) => () => void;
            onRequestSave: (cb: (filePath: string) => void) => () => void;
            saveFile: (filePath: string, content: string) => Promise<boolean>;
            requestSaveAs: () => Promise<boolean>;
        };
    }
}

// Use the rich result: a corrupt autosave must NOT look like "no autosave".
// Starting blank and letting the user overwrite it would destroy recoverable work.
const initialLoad = Serializer.loadResult();
const initialDocument = initialLoad.document;
const startedFromCorruptSave = initialLoad.status === "corrupt";

export function App() {
    const [toolName, setToolName] = useState<string>("select");
    // Consolidated UI state — one setState per refresh (React batches it into a
    // single commit). `tick` drives the imperative canvas repaint effect.
    const [ui, setUi] = useState<{ tick: number; selectedNodeId: string | null; canUndo: boolean; canRedo: boolean; truncated: boolean }>({
        tick: 0, selectedNodeId: null, canUndo: false, canRedo: false, truncated: false
    });

    const canvasRef = useRef<HTMLDivElement>(null);
    const currentFilePathRef = useRef<string | null>(null);
    const confirmedOverwriteRef = useRef(false);
    // Dirty-state tracking (M1): the previous ComputedState to reuse clean subtrees
    // from, the ids changed by document mutations since it was computed, and the
    // node ids that carried a drag preview last frame (so releasing a drag recomputes
    // them). The invariant `incremental === full` is property-tested — this is the
    // producer of the dirty set the engine consumes.
    const prevComputedRef = useRef<ComputedState | null>(null);
    const dirtyNodesRef = useRef<Set<string>>(new Set());
    const prevPendingRef = useRef<Set<string>>(new Set());
    const editorStateRef = useRef<EditorState | null>(null);
    if (!editorStateRef.current) editorStateRef.current = createEditorState();
    const es = editorStateRef.current;

    const dispatcherRef = useRef<ActionDispatcher | null>(null);
    if (!dispatcherRef.current) {
        dispatcherRef.current = new ActionDispatcher(initialDocument || createEmptyDocument());
    }
    const dispatcher = dispatcherRef.current;

    const refresh = useCallback(() => {
        setUi(prev => ({
            tick: prev.tick + 1,
            selectedNodeId: es.selectedNodeIds[0] ?? null,
            canUndo: dispatcher.canUndo(),
            canRedo: dispatcher.canRedo(),
            truncated: dispatcher.hasTruncatedHistory()
        }));
    }, []);

    const selectedNodeId = ui.selectedNodeId;

    const toolControllerRef = useRef<ToolController | null>(null);
    if (!toolControllerRef.current) {
        toolControllerRef.current = new ToolController(dispatcher, es, refresh);
    }
    const toolController = toolControllerRef.current;

    const toolsRef = useRef<Record<string, any>>({});
    if (Object.keys(toolsRef.current).length === 0) {
        toolsRef.current = {
            select: new SelectTool(dispatcher, es, refresh),
            move: new MoveTool(dispatcher, es, refresh),
            rectangle: new RectangleTool(dispatcher, es, refresh)
        };
        toolController.setTool(toolsRef.current.select);
    }

    const setTool = useCallback((name: string) => {
        toolController.setTool(toolsRef.current[name] ?? toolsRef.current.select);
        es.activeTool = name;
        setToolName(name);
    }, [toolController]);

    useEffect(() => {
        const target = canvasRef.current;
        if (!target) return;

        const handleMouseDown = (e: MouseEvent) => {
            const rect = target.getBoundingClientRect();
            toolController.onMouseDown(e, rect);
        };
        const handleMouseMove = (e: MouseEvent) => {
            const rect = target.getBoundingClientRect();
            toolController.onMouseMove(e, rect);
        };
        const handleMouseUp = (e: MouseEvent) => toolController.onMouseUp(e);
        const handleKeyDown = (e: KeyboardEvent) => toolController.onKeyDown(e);
        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = target.getBoundingClientRect();
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            es.viewport.zoom *= zoomFactor;
            clampViewport(es.viewport);
            toolController.onWheel(e, rect);
            refresh(); // repaint at the new zoom (wheel doesn't go through a tool commit)
        };

        target.addEventListener("mousedown", handleMouseDown);
        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        window.addEventListener("keydown", handleKeyDown);
        target.addEventListener("wheel", handleWheel, { passive: false });

        return () => {
            target.removeEventListener("mousedown", handleMouseDown);
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
            window.removeEventListener("keydown", handleKeyDown);
            target.removeEventListener("wheel", handleWheel);
        };
    }, [toolController]);

    useEffect(() => {
        if (canvasRef.current) {
            const doc = dispatcher.getDocument();
            const pendingKeys = new Set(es.pendingGeometry ? [...es.pendingGeometry.keys()] : []);

            // The dirty set the engine consumes must be a SUPERSET of everything whose
            // geometry changed since `prevComputed`: document edits (accumulated by
            // onChange), nodes with a preview now, and nodes that had one last frame
            // (a released/cancelled drag). The engine propagates to descendants itself.
            const computed = prevComputedRef.current
                ? computeGeometry(doc, es.pendingGeometry, prevComputedRef.current,
                    new Set([...dirtyNodesRef.current, ...pendingKeys, ...prevPendingRef.current]))
                : computeGeometry(doc, es.pendingGeometry);

            prevComputedRef.current = computed;
            prevPendingRef.current = pendingKeys;
            dirtyNodesRef.current = new Set();

            const rendererState: RendererState = {
                selectedNodeIds: es.selectedNodeIds,
                hoveredNodeId: es.hoveredNodeId,
                previewRect: es.previewRect,
                computed,
                viewport: es.viewport
            };
            renderSVG(canvasRef.current, doc, rendererState);
        }
    }, [ui.tick, dispatcher]);

    // Repaint whenever the DOCUMENT changes, from any source, and record which nodes
    // changed so the next compute can reuse the untouched ones. Ephemeral editor state
    // (selection, hover, viewport, drag previews) doesn't flow through the dispatcher,
    // so tools call `refresh()` directly for those (no document nodes are dirtied).
    useEffect(() => dispatcher.onChange(result => {
        result.updatedNodeIds.forEach(id => dirtyNodesRef.current.add(id));
        refresh();
    }), [dispatcher, refresh]);

    // Bridge the Electron native File menu (no-op in the browser build).
    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;

        const saveTo = (filePath: string) => {
            api.saveFile(filePath, serializeDocument(dispatcher.getDocument()))
                .catch(err => console.error("Save failed:", err));
        };

        const disposers = [
            api.onMenuNew(() => {
                dispatcher.loadDocument(createEmptyDocument());
                currentFilePathRef.current = null;
                es.selectedNodeIds = [];
                refresh();
            }),
            api.onFileOpened(({ filePath, content }) => {
                try {
                    dispatcher.loadDocument(deserializeDocument(content));
                    // Remember where it came from so Ctrl+S writes back to the
                    // same file instead of diverting to localStorage.
                    currentFilePathRef.current = filePath;
                    es.selectedNodeIds = [];
                    refresh();
                } catch (err) {
                    console.error("Failed to open file:", err);
                }
            }),
            api.onRequestSave((filePath) => {
                currentFilePathRef.current = filePath;
                saveTo(filePath);
            }),
            api.onMenuSave(() => {
                const path = currentFilePathRef.current;
                if (path) saveTo(path);
                // No file yet: prompt for one rather than silently saving somewhere
                // the user did not choose.
                else api.requestSaveAs().catch(err => console.error("Save As failed:", err));
            })
        ];
        return () => disposers.forEach(dispose => dispose());
    }, []);

    const node = selectedNodeId ? dispatcher.getDocument().nodes.get(selectedNodeId) : undefined;
    const vp = es.viewport;

    const canvasCursor = toolName === "rectangle"
        ? "crosshair"
        : toolName === "move"
            ? (es.isDragging ? "grabbing" : "grab")
            : "default";

    const nodeTypeLabels: Record<string, string> = {
        "core.rectangle": "Rectangle",
        "core.text": "Text",
        "core.image": "Image"
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0f0f1a", color: "#e0e0e0" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "4px 8px", background: "#16162a", borderBottom: "1px solid #2a2a4a", gap: 4 }}>
                <span style={{ fontWeight: 700, marginRight: 8, color: "#00bfff", fontSize: 13 }}>VDE</span>
                <ToolButton icon="↗" label="Select" active={toolName === "select"} onClick={() => setTool("select")} />
                <ToolButton icon="↔" label="Move" active={toolName === "move"} onClick={() => setTool("move")} />
                <ToolButton icon="□" label="Rectangle" active={toolName === "rectangle"} onClick={() => setTool("rectangle")} />
                <div style={{ width: 1, height: 20, background: "#2a2a4a", margin: "0 4px" }} />
                <ToolButton icon="↩" label="Undo" disabled={!ui.canUndo} onClick={() => { dispatcher.undo(); refresh(); }} />
                <ToolButton icon="↪" label="Redo" disabled={!ui.canRedo} onClick={() => { dispatcher.redo(); refresh(); }} />
                {ui.truncated && (
                    // Only shown once history actually truncated: undo now stops at the
                    // oldest retained step, so this is the explicit way back to the start.
                    <ToolButton
                        icon="⟲"
                        label="Revert to original"
                        onClick={() => {
                            if (window.confirm(
                                "Some older history was discarded, so Undo cannot reach the start.\n\n" +
                                "Revert the document to how it was when this session began? " +
                                "(You can undo this revert.)"
                            )) {
                                dispatcher.revertToOriginal();
                                es.selectedNodeIds = [];
                                refresh();
                            }
                        }}
                    />
                )}
                <div style={{ flex: 1 }} />
                {startedFromCorruptSave && (
                    <span
                        title={`The previous autosave could not be read and was kept at "${CORRUPT_BACKUP_KEY}". Saving now will replace it.`}
                        style={{ fontSize: 11, color: "#ffb454", marginRight: 8 }}
                    >
                        ⚠ previous autosave unreadable (backed up)
                    </span>
                )}
                <button
                    onClick={() => {
                        // Don't silently destroy a recoverable payload the user
                        // has not been told about.
                        if (startedFromCorruptSave && !confirmedOverwriteRef.current) {
                            confirmedOverwriteRef.current = window.confirm(
                                "The previous autosave could not be read and has been backed up to " +
                                `"${CORRUPT_BACKUP_KEY}".\n\nSaving now replaces the autosave. Continue?`
                            );
                            if (!confirmedOverwriteRef.current) return;
                        }
                        const result = Serializer.save(dispatcher.getDocument());
                        if (result.status === "failed") {
                            window.alert(`Save failed: ${result.error.message}`);
                        }
                    }}
                    style={{ fontSize: 11, padding: "3px 8px", background: "#00bfff", color: "#000", border: "none", borderRadius: 3, cursor: "pointer" }}
                >
                    Save
                </button>
            </div>

            <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
                <div style={{ width: 180, background: "#16162a", borderRight: "1px solid #2a2a4a", overflow: "auto", padding: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#888", marginBottom: 6 }}>LAYERS</div>
                    {traverseSceneGraph(dispatcher.getDocument()).map((n: ReadonlyNode) => {
                        const id = n.id;
                        return (
                        <div
                            key={id}
                            onClick={() => {
                                es.selectedNodeIds = [id];
                                refresh();
                            }}
                            style={{
                                padding: "4px 6px", fontSize: 11, borderRadius: 3, cursor: "pointer", marginBottom: 2,
                                background: selectedNodeId === id ? "#2a4a6a" : "transparent",
                                borderLeft: selectedNodeId === id ? "2px solid #00bfff" : "2px solid transparent"
                            }}
                        >
                            {nodeTypeLabels[n.type] || n.type} <span style={{ color: "#666" }}>{id.slice(0, 6)}</span>
                        </div>
                        );
                    })}
                    {dispatcher.getDocument().nodes.size === 0 && (
                        <div style={{ fontSize: 11, color: "#555", padding: "4px 6px" }}>No layers yet</div>
                    )}
                </div>

                <div
                    ref={canvasRef}
                    style={{ flex: 1, overflow: "hidden", position: "relative", cursor: canvasCursor }}
                />

                <div style={{ width: 220, background: "#16162a", borderLeft: "1px solid #2a2a4a", padding: 10, overflow: "auto" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#888", marginBottom: 8 }}>INSPECTOR</div>
                    {node && selectedNodeId ? (
                        <div style={{ fontSize: 11, lineHeight: 1.8 }}>
                            <div style={{ color: "#666", marginBottom: 6 }}>{nodeTypeLabels[node.type] || node.type} — {selectedNodeId.slice(0, 8)}</div>
                            <label style={{ color: "#aaa" }}>X</label>
                            <NumInput value={Math.round(node.geometry.x)} onChange={v => {
                                dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), selectedNodeId, { x: v }), { coalesce: true });
                                refresh();
                            }} />
                            <label style={{ color: "#aaa" }}>Y</label>
                            <NumInput value={Math.round(node.geometry.y)} onChange={v => {
                                dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), selectedNodeId, { y: v }), { coalesce: true });
                                refresh();
                            }} />
                            <label style={{ color: "#aaa" }}>W</label>
                            <NumInput value={Math.round(node.geometry.width)} onChange={v => {
                                dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), selectedNodeId, { width: Math.max(1, v) }), { coalesce: true });
                                refresh();
                            }} />
                            <label style={{ color: "#aaa" }}>H</label>
                            <NumInput value={Math.round(node.geometry.height)} onChange={v => {
                                dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), selectedNodeId, { height: Math.max(1, v) }), { coalesce: true });
                                refresh();
                            }} />
                            <label style={{ color: "#aaa" }}>Fill</label>
                            <input
                                type="color"
                                value={node.style.fill}
                                onChange={e => {
                                    dispatcher.dispatchAction(new UpdateNodeStyleAction(dispatcher.getDocument(), selectedNodeId, { fill: e.target.value }), { coalesce: true });
                                    refresh();
                                }}
                                style={{ width: "100%", height: 22, border: "none", background: "transparent", cursor: "pointer" }}
                            />
                            <label style={{ color: "#aaa" }}>Opacity</label>
                            <input
                                type="range"
                                min="0" max="1" step="0.01"
                                value={node.style.opacity}
                                onChange={e => {
                                    dispatcher.dispatchAction(new UpdateNodeStyleAction(dispatcher.getDocument(), selectedNodeId, { opacity: parseFloat(e.target.value) }), { coalesce: true });
                                    refresh();
                                }}
                                style={{ width: "100%" }}
                            />
                        </div>
                    ) : (
                        <div style={{ fontSize: 11, color: "#555" }}>Select a node to edit</div>
                    )}
                </div>
            </div>

            <div style={{ padding: "3px 10px", background: "#16162a", borderTop: "1px solid #2a2a4a", fontSize: 10, color: "#555", display: "flex", justifyContent: "space-between" }}>
                <span>{toolName.charAt(0).toUpperCase() + toolName.slice(1)} tool</span>
                <span>{Math.round(vp.zoom * 100)}% · {Math.round(vp.x)}, {Math.round(vp.y)}</span>
                <span>Visual Design Engine v{CURRENT_VERSION}</span>
            </div>
        </div>
    );
}

function ToolButton({ icon, label, active, disabled, onClick }: {
    icon: string; label: string; active?: boolean; disabled?: boolean; onClick: () => void;
}) {
    return (
        <button
            title={label}
            onClick={onClick}
            disabled={disabled}
            style={{
                display: "flex", alignItems: "center", gap: 3, padding: "3px 7px", fontSize: 11,
                background: active ? "#2a4a6a" : "transparent", color: disabled ? "#444" : "#ccc",
                border: "none", borderRadius: 3, cursor: disabled ? "default" : "pointer"
            }}
        >
            <span>{icon}</span><span>{label}</span>
        </button>
    );
}

function NumInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    return (
        <input
            type="number"
            value={value}
            // Skip non-numeric input rather than substituting 0: `|| 0` turned a
            // half-typed value (or "-") into a real edit that snapped the node to 0.
            onChange={e => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v)) onChange(v);
            }}
            style={{
                width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                background: "#0f0f1a", color: "#e0e0e0", border: "1px solid #2a2a4a", borderRadius: 2, marginBottom: 4
            }}
        />
    );
}
