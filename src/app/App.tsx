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
import { geometryActionFor, styleActionFor } from "../core/actions/nodeEdit";
import { expandInstances } from "../core/document/Components";
import { SetActiveThemeAction } from "../core/actions/VariableActions";
import { CreateInstanceAction } from "../core/actions/CreateInstanceAction";
import { createEditorState, EditorState, zoomAt } from "../editor/EditorState";
import { ToolController } from "../editor/tools/ToolController";
import { SelectTool } from "../editor/tools/SelectTool";
import { MoveTool } from "../editor/tools/MoveTool";
import { RectangleTool } from "../editor/tools/RectangleTool";
import { RendererState } from "../renderer/SVGRenderer";
import { renderScene, RenderBackend } from "../renderer/renderScene";
import { rulerTicks } from "../core/geometry/Ruler";

const RULER = 18; // ruler bar thickness in px

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
    const [backend, setBackend] = useState<RenderBackend>("svg");
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
        const handleKeyUp = (e: KeyboardEvent) => toolController.onKeyUp(e);
        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = target.getBoundingClientRect();
            // Zoom about the cursor (the world point under the pointer stays fixed).
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            zoomAt(es.viewport, zoomFactor, e.clientX - rect.left, e.clientY - rect.top);
            toolController.onWheel(e, rect);
            refresh(); // repaint at the new zoom (wheel doesn't go through a tool commit)
        };

        target.addEventListener("mousedown", handleMouseDown);
        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        target.addEventListener("wheel", handleWheel, { passive: false });

        return () => {
            target.removeEventListener("mousedown", handleMouseDown);
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
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
                marqueeRect: es.marqueeRect,
                snapGuides: es.snapGuides,
                computed,
                viewport: es.viewport
            };
            renderScene(canvasRef.current, doc, rendererState, backend, refresh);
        }
    }, [ui.tick, dispatcher, backend]);

    // Repaint on container-resize and DPR change. The SVG root is width/height=100% so it
    // auto-fills the pane, but the Canvas backend is sized in fixed CSS px (and its backing
    // store in device px), so without an explicit repaint it would leave a blank gutter when
    // the pane grows, or go blurry when the device pixel ratio changes (e.g. moving the window
    // to a different-density monitor). renderCanvas re-reads clientWidth/dpr each frame, so a
    // refresh() is all that's needed.
    useEffect(() => {
        const el = canvasRef.current;
        if (!el) return;
        const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => refresh()) : null;
        observer?.observe(el);

        // A DPR change need not change the container size, so watch the resolution media query
        // too, re-subscribing after each change (the matched query is pinned to the old value).
        let mql: MediaQueryList | null = null;
        const onDprChange = () => { mql?.removeEventListener("change", onDprChange); refresh(); watchDpr(); };
        const watchDpr = () => {
            if (typeof window.matchMedia !== "function") return;
            mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
            mql.addEventListener("change", onDprChange);
        };
        watchDpr();

        return () => { observer?.disconnect(); mql?.removeEventListener("change", onDprChange); };
    }, [refresh]);

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

    // Resolved against the EXPANDED document so the inspector can show — and edit — a component
    // instance's COPY (a virtual node, alt-clicked). Its edits route through `nodeEdit`, which
    // turns them into per-instance overrides; a raw action would target a node that isn't in the
    // stored document and fail validation, looking like an input that does nothing.
    const node = selectedNodeId ? expandInstances(dispatcher.getDocument()).nodes.get(selectedNodeId) : undefined;
    /** Dispatch a geometry/style edit for the selected node, routed for stored vs instance copy. */
    const editSelected = (patch: { geometry?: Partial<Node["geometry"]>; style?: Partial<Node["style"]> }) => {
        if (!selectedNodeId) return;
        const d = dispatcher.getDocument();
        const action = patch.geometry
            ? geometryActionFor(d, selectedNodeId, patch.geometry)
            : styleActionFor(d, selectedNodeId, patch.style ?? {});
        if (action) dispatcher.dispatchAction(action, { coalesce: true });
    };
    const vp = es.viewport;

    // A hovered resize/rotate handle wins (both backends); otherwise the tool's cursor.
    const canvasCursor = es.hoverCursor
        ?? (toolName === "rectangle"
            ? "crosshair"
            : toolName === "move"
                ? (es.isDragging ? "grabbing" : "grab")
                : "default");

    // One friendly label per NODE_TYPES entry (the `|| n.type` fallback keeps this graceful).
    const nodeTypeLabels: Record<string, string> = {
        "core.rectangle": "Rectangle",
        "core.text": "Text",
        "core.image": "Image",
        "core.ellipse": "Ellipse",
        "core.line": "Line",
        "core.path": "Path"
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
                <button
                    title="Create an instance of the selected node — it mirrors that master until you edit the master (M6 components)"
                    disabled={es.selectedNodeIds.length !== 1 || dispatcher.getDocument().nodes.get(es.selectedNodeIds[0])?.type === "core.instance"}
                    onClick={() => {
                        const masterId = es.selectedNodeIds[0];
                        const doc = dispatcher.getDocument();
                        const master = doc.nodes.get(masterId);
                        if (!master) return;
                        // Place it near the master in WORLD space: the new instance is a ROOT, so
                        // its x/y are world coords, while a nested master's stored x/y are
                        // parent-relative — using those directly would misplace the instance.
                        const box = computeGeometry(doc).nodes.get(masterId)?.bounds;
                        const at = box ?? { x: master.geometry.x, y: master.geometry.y };
                        const action = new CreateInstanceAction(doc, masterId, at.x + 40, at.y + 40);
                        if (dispatcher.dispatchAction(action).success) {
                            const created = action.getCreatedNodeId();
                            if (created) es.selectedNodeIds = [created];
                        }
                        refresh();
                    }}
                    style={{ fontSize: 11, padding: "3px 8px", marginLeft: 8, background: "transparent", color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                >
                    ⧉ Instance
                </button>
                <div style={{ flex: 1 }} />
                <button
                    title="Switch the document's theme mode — $token colors re-resolve against the variable store (undoable, persisted)"
                    onClick={() => {
                        const doc = dispatcher.getDocument();
                        dispatcher.dispatchAction(new SetActiveThemeAction(doc, doc.activeTheme === "light" ? "dark" : "light"));
                        refresh();
                    }}
                    style={{ fontSize: 11, padding: "3px 8px", marginRight: 8, background: "transparent", color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                >
                    Theme: {dispatcher.getDocument().activeTheme === "light" ? "Light" : "Dark"}
                </button>
                <button
                    title="Switch the rendering backend (both draw the same display list)"
                    onClick={() => setBackend(b => (b === "svg" ? "canvas" : "svg"))}
                    style={{ fontSize: 11, padding: "3px 8px", marginRight: 8, background: "transparent", color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                >
                    Backend: {backend === "svg" ? "SVG" : "Canvas"}
                </button>
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

                <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
                    {/* Imperative render surface (SVG or Canvas) fills the pane; React never touches its children. */}
                    <div
                        ref={canvasRef}
                        style={{ position: "absolute", inset: 0, cursor: canvasCursor }}
                    />
                    {/* Rulers overlay the top/left edges (pointer-events off, so clicks pass through). */}
                    <Ruler axis="x" length={canvasRef.current?.clientWidth ?? 0} vp={vp} />
                    <Ruler axis="y" length={canvasRef.current?.clientHeight ?? 0} vp={vp} />
                    <div style={{ position: "absolute", top: 0, left: 0, width: RULER, height: RULER, background: "#16162a", borderRight: "1px solid #2a2a4a", borderBottom: "1px solid #2a2a4a" }} />
                </div>

                <div style={{ width: 220, background: "#16162a", borderLeft: "1px solid #2a2a4a", padding: 10, overflow: "auto" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#888", marginBottom: 8 }}>INSPECTOR</div>
                    {node && selectedNodeId ? (
                        <div style={{ fontSize: 11, lineHeight: 1.8 }}>
                            <div style={{ color: "#666", marginBottom: 6 }}>{nodeTypeLabels[node.type] || node.type} — {selectedNodeId.slice(0, 8)}</div>
                            <label style={{ color: "#aaa" }}>X</label>
                            <NumInput value={Math.round(node.geometry.x)} onChange={v => {
                                editSelected({ geometry: { x: v } });
                                refresh();
                            }} />
                            <label style={{ color: "#aaa" }}>Y</label>
                            <NumInput value={Math.round(node.geometry.y)} onChange={v => {
                                editSelected({ geometry: { y: v } });
                                refresh();
                            }} />
                            <label style={{ color: "#aaa" }}>W</label>
                            <NumInput value={Math.round(node.geometry.width)} onChange={v => {
                                editSelected({ geometry: { width: Math.max(1, v) } });
                                refresh();
                            }} />
                            <label style={{ color: "#aaa" }}>H</label>
                            <NumInput value={Math.round(node.geometry.height)} onChange={v => {
                                editSelected({ geometry: { height: Math.max(1, v) } });
                                refresh();
                            }} />
                            <label style={{ color: "#aaa" }}>Fill</label>
                            <input
                                type="color"
                                value={node.style.fill}
                                onChange={e => {
                                    editSelected({ style: { fill: e.target.value } });
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
                                    editSelected({ style: { opacity: parseFloat(e.target.value) } });
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

// A screen-fixed ruler bar. Ticks come from the pure `rulerTicks`; each world tick maps to a screen
// position via the same transform the content uses (`screen = z·world − vp`).
function Ruler({ axis, length, vp }: { axis: "x" | "y"; length: number; vp: { x: number; y: number; zoom: number } }) {
    if (length <= 0) return null;
    const z = Math.max(0.01, vp.zoom);
    const off = axis === "x" ? vp.x : vp.y;
    const ticks = rulerTicks(off / z, (length + off) / z, z);
    const horizontal = axis === "x";
    return (
        <svg
            width={horizontal ? length : RULER}
            height={horizontal ? RULER : length}
            style={{
                position: "absolute", top: 0, left: 0, background: "#16162a", pointerEvents: "none",
                borderBottom: horizontal ? "1px solid #2a2a4a" : undefined,
                borderRight: horizontal ? undefined : "1px solid #2a2a4a"
            }}
        >
            {ticks.map(t => {
                const s = t.world * z - off; // screen position along the ruler's axis
                return horizontal ? (
                    <g key={t.world}>
                        <line x1={s} y1={t.major ? 4 : 11} x2={s} y2={RULER} stroke="#555" strokeWidth={1} />
                        {t.major && <text x={s + 2} y={9} fontSize={8} fill="#8a8aa0">{t.label}</text>}
                    </g>
                ) : (
                    <g key={t.world}>
                        <line x1={t.major ? 4 : 11} y1={s} x2={RULER} y2={s} stroke="#555" strokeWidth={1} />
                        {t.major && <text x={9} y={s - 2} fontSize={8} fill="#8a8aa0" transform={`rotate(-90 9 ${s - 2})`}>{t.label}</text>}
                    </g>
                );
            })}
        </svg>
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
