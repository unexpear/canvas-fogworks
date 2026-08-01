/**
 * @module App
 * @description Top-level React shell. Renders the toolbar, canvas, layers panel,
 * inspector, and status bar.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { createEmptyDocument, CURRENT_VERSION } from "../core/document/Document";
import { Node, Shadow } from "../core/document/Node";
import { Serializer, serializeDocument, deserializeDocument, CORRUPT_BACKUP_KEY } from "../core/document/Serializer";
import { traverseSceneGraph, ReadonlyNode } from "../core/document/SceneGraph";
import { computeGeometry, ComputedState } from "../core/geometry/GeometryEngine";
import { geometryActionFor, styleActionFor, contentActionFor } from "../core/actions/nodeEdit";
import { expandInstances, isVirtualId } from "../core/document/Components";
import { SetActiveThemeAction } from "../core/actions/VariableActions";
import { CreateInstanceAction } from "../core/actions/CreateInstanceAction";
import { DetachInstanceAction } from "../core/actions/DetachInstanceAction";
import { UpdateNodeTransformAction } from "../core/actions/UpdateNodeTransformAction";
import { UpdateNodeLayoutAction } from "../core/actions/UpdateNodeLayoutAction";
import { createEditorState, EditorState, zoomAt } from "../editor/EditorState";
import { ToolController } from "../editor/tools/ToolController";
import { SelectTool } from "../editor/tools/SelectTool";
import { MoveTool } from "../editor/tools/MoveTool";
import { ShapeTool, SHAPE_KINDS, ShapeKind, PaintMode, supportsPaintMode, clampStrokeWidth, DEFAULT_STROKE_WIDTH, STROKE_WIDTH_MAX } from "../editor/tools/ShapeTool";
import { FrameSelectionAction } from "../core/actions/FrameSelectionAction";
import { alignAction, distributeAction } from "../core/actions/alignActions";
import { AlignEdge, DistributeAxis } from "../core/geometry/Alignment";
import { IMAGE_SRC_MAX, srcError } from "../core/document/Node";
import { clampSides, POLYGON_DEFAULT_SIDES, POLYGON_MIN_SIDES, POLYGON_MAX_SIDES } from "../core/geometry/Polygon";
import { scanCapabilities, Capability } from "../core/scan/CapabilityScan";
import { exportSVG } from "../core/export/ExportSVG";
import { ReadonlyDocument } from "../core/document/Document";
import { AddNodeAction } from "../core/actions/AddNodeAction";


/**
 * The editor's visual tokens. Colours and spacing were repeated inline at ~40 sites, so the
 * panels had drifted apart — three different greys for a heading, two panel backgrounds, four
 * border colours. One place to change them is also the only way "make it look better" stays
 * true after the next feature lands.
 */
const UI = {
    bg: "#0e0e18",          // canvas / deepest surface
    panel: "#15152a",       // side panels + toolbar
    raised: "#1c1c33",      // inputs, wells
    line: "#262642",        // hairline borders
    lineSoft: "#1f1f38",
    text: "#dcdce8",
    textDim: "#8a8aa5",
    textFaint: "#5f5f7a",
    accent: "#4da3ff",
    accentSoft: "#22436b"
};

/** A panel's section heading — small, spaced, quiet. Used by every panel so they match. */
const DRAWER_BUTTON: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", fontSize: 11, padding: "4px 6px", cursor: "pointer",
    background: "transparent", color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, marginBottom: 4
};

const PANEL_HEADING: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase",
    color: UI.textDim, marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${UI.lineSoft}`
};

/** A toolbar button. `active` is the pressed state for a selected tool. */
function toolbarButtonStyle(active = false): React.CSSProperties {
    return {
        fontSize: 11, padding: "4px 9px", borderRadius: 4, cursor: "pointer",
        background: active ? UI.accentSoft : "transparent",
        color: active ? "#eaf4ff" : UI.text,
        border: `1px solid ${active ? UI.accent : UI.line}`,
        whiteSpace: "nowrap"
    };
}

/** Align controls: edge, glyph, tooltip. One list so the row and its handlers cannot drift. */
const ALIGN_BUTTONS: readonly [AlignEdge, string, string][] = [
    ["left", "⇤", "Align left"],
    ["center-h", "⇹", "Align horizontal centres"],
    ["right", "⇥", "Align right"],
    ["top", "⤒", "Align top"],
    ["center-v", "⇳", "Align vertical centres"],
    ["bottom", "⤓", "Align bottom"]
];
const DISTRIBUTE_BUTTONS: readonly [DistributeAxis, string, string][] = [
    ["horizontal", "⇿", "Distribute horizontal spacing evenly"],
    ["vertical", "⇕", "Distribute vertical spacing evenly"]
];
const ALIGN_BUTTON_STYLE: React.CSSProperties = {
    fontSize: 12, padding: "3px 6px", background: "transparent", color: "#ccc",
    border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer", minWidth: 24
};

/** Toolbar glyph per basic shape (the label is the kind's own name). */
const SHAPE_ICONS: Record<ShapeKind, string> = {
    rectangle: "□", ellipse: "○", line: "╱", text: "T", triangle: "△", polygon: "⬟", image: "▣"
};

/**
 * Ask the user for an image source: a file (inlined as a `data:` URL so the document is
 * self-contained) or a URL. This is the DOM half of `ShapeTool`'s `SourceResolver` — the tool
 * itself never touches the DOM, which is what keeps it testable in the `node` environment.
 *
 * Resolves to null when the user cancels. An oversized file is refused HERE, with a message,
 * rather than being inlined into a document that could then never be saved.
 */
function pickImageSource(): Promise<string | null> {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.style.display = "none";
        // A cancelled file dialog fires no event in most browsers, so the URL fallback is
        // offered on `cancel` where supported and the promise otherwise settles on `change`.
        input.addEventListener("cancel", () => {
            input.remove();
            const url = window.prompt("Image URL (https:// or a relative path):");
            const trimmed = url ? url.trim() : "";
            if (trimmed.length === 0) { resolve(null); return; }
            // The SAME check the file branch runs. Without it a refused URL fell through to
            // AddNodeAction, whose validate() fails silently (`dispatchAction` logs nothing for
            // a failed validate) — the drag vanished with no explanation on exactly the inputs
            // the file branch is careful to explain.
            const err = srcError("core.image", trimmed);
            if (err) { window.alert(`That URL can't be used as an image source: ${err}.`); resolve(null); return; }
            resolve(trimmed);
        });
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) { resolve(null); return; }
            const reader = new FileReader();
            reader.onload = () => {
                const src = String(reader.result ?? "");
                // The shared validator is the authority — the app just explains the refusal.
                const err = srcError("core.image", src);
                if (err) {
                    window.alert(
                        src.length > IMAGE_SRC_MAX
                            ? `That image is too large to embed (${Math.round(src.length / 1e6)} MB encoded; the limit is ${IMAGE_SRC_MAX / 1e6} MB). Use a URL instead.`
                            : `That file can't be used as an image source: ${err}.`
                    );
                    resolve(null);
                    return;
                }
                resolve(src);
            };
            reader.onerror = () => { window.alert("Could not read that file."); resolve(null); };
            reader.readAsDataURL(file);
        });
        document.body.appendChild(input);
        input.click();
    });
}
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
            pickFolder: () => Promise<string | null>;
            readSourceFolder: (folder: string) => Promise<{ path: string; content: string }[]>;
            readAssetFolder: (folder: string) => Promise<{ path: string; name: string; relative: string }[]>;
            readImageDataUrl: (filePath: string) => Promise<string>;
            writeIntoFolder: (folder: string, filename: string, content: string) => Promise<string>;
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
    // The N-gon's side count. Held in a ref as well as state because ShapeTool is constructed
    // ONCE and reads the count at commit time through a getter — a captured value would freeze
    // whatever the count was when the toolbar first rendered.
    const [polygonSides, setPolygonSides] = useState<number>(POLYGON_DEFAULT_SIDES);
    const polygonSidesRef = useRef(POLYGON_DEFAULT_SIDES);
    polygonSidesRef.current = polygonSides;
    // FILLED vs OUTLINE for newly drawn shapes — the same getter pattern as the side count,
    // for the same reason: the tool is built once and must read the CURRENT choice.
    const [paintMode, setPaintMode] = useState<PaintMode>("filled");
    const paintModeRef = useRef<PaintMode>("filled");
    paintModeRef.current = paintMode;
    // Border thickness for new OUTLINE shapes, in world units — same getter pattern again.
    const [strokeWidth, setStrokeWidth] = useState<number>(DEFAULT_STROKE_WIDTH);
    const strokeWidthRef = useRef(DEFAULT_STROKE_WIDTH);
    strokeWidthRef.current = strokeWidth;
    // Which folders are collapsed in the layer tree. Purely a VIEW concern — it never touches
    // the document, so collapsing is not undoable and not persisted.
    const [collapsedLayers, setCollapsedLayers] = useState<Set<string>>(new Set());
    const [backend, setBackend] = useState<RenderBackend>("svg");
    const [showFolders, setShowFolders] = useState(false);
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
            // One ShapeTool per basic shape, keyed by the SAME names the toolbar maps over.
            ...Object.fromEntries(SHAPE_KINDS.map(kind =>
                [kind, new ShapeTool(dispatcher, es, refresh, kind, pickImageSource, () => polygonSidesRef.current, () => paintModeRef.current, () => strokeWidthRef.current)]))
        };
        toolController.setTool(toolsRef.current.select);
    }

    /**
     * Align / distribute the current selection. Both resolve geometry FRESH rather than reusing
     * the render tick's state: the toolbar can be clicked at any time, and aligning against a
     * stale ComputedState would move nodes to where they used to be.
     */
    const runAlign = useCallback((edge: AlignEdge) => {
        const doc = dispatcher.getDocument();
        const action = alignAction(doc, computeGeometry(doc), es.selectedNodeIds, edge);
        if (action) dispatcher.dispatchAction(action);
        refresh();
    }, [dispatcher, es, refresh]);

    const runDistribute = useCallback((axis: DistributeAxis) => {
        const doc = dispatcher.getDocument();
        const action = distributeAction(doc, computeGeometry(doc), es.selectedNodeIds, axis);
        if (action) dispatcher.dispatchAction(action);
        refresh();
    }, [dispatcher, es, refresh]);

    /**
     * Place an asset from the folder browser. It lands at the centre of the CURRENT view (not
     * a fixed canvas point), inlined as a data: URL so the document stays self-contained —
     * the same source rule `srcError` applies to a file picked with the image tool.
     */
    const placeAsset = useCallback((dataUrl: string, name: string) => {
        const el = canvasRef.current;
        const w = 200, h = 150;
        const zoom = Math.max(0.01, es.viewport.zoom);
        const cx = (es.viewport.x + (el ? el.clientWidth : 800) / 2) / zoom - w / 2;
        const cy = (es.viewport.y + (el ? el.clientHeight : 600) / 2) / zoom - h / 2;
        const doc = dispatcher.getDocument();
        const action = new AddNodeAction(doc, "core.image", cx, cy, w, h, "none", undefined, null, { src: dataUrl });
        if (dispatcher.dispatchAction(action).success) {
            const id = action.getCreatedNodeId();
            if (id) {
                es.selectedNodeIds = [id];
                // Name it after the file, so the layers panel shows something meaningful.
                const named = contentActionFor(dispatcher.getDocument(), id, { name });
                if (named) dispatcher.dispatchAction(named);
            }
        }
        refresh();
    }, [dispatcher, es, refresh]);
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
    /** Content edits (text / src / name) — routed, so a copy gets an override where it can. */
    const editContent = (patch: { text?: string; src?: string; name?: string }) => {
        if (!selectedNodeId) return;
        const action = contentActionFor(dispatcher.getDocument(), selectedNodeId, patch);
        if (action) dispatcher.dispatchAction(action, { coalesce: true });
    };

    /** Transform edits. NOT routed: a transform override is a documented later slice, so this
     *  is refused for an instance copy rather than written somewhere it cannot live. */
    const editTransform = (patch: { rotation?: number; scaleX?: number; scaleY?: number }) => {
        if (!selectedNodeId || isVirtualId(selectedNodeId)) return;
        const d = dispatcher.getDocument();
        if (!d.nodes.has(selectedNodeId)) return;
        dispatcher.dispatchAction(new UpdateNodeTransformAction(d, selectedNodeId, patch), { coalesce: true });
    };

    /** A shadow is a WHOLE value in the schema, so a single field edit merges over the current
     *  one — otherwise typing in dx would drop the colour and softness. */
    const editShadow = (patch: Partial<Shadow>) => {
        const current = node?.style.shadow;
        if (!current) return;
        editSelected({ style: { shadow: { ...current, ...patch } } });
    };

    /**
     * Layout edits. NOT routed through `nodeEdit`: `layout` has no per-instance override slot,
     * so a copy's layout comes from its master and the inspector says so rather than offering
     * controls that would silently do nothing.
     */
    const editLayout = (patch: Partial<Node["layout"]>) => {
        if (!selectedNodeId || isVirtualId(selectedNodeId)) return;
        const d = dispatcher.getDocument();
        if (!d.nodes.has(selectedNodeId)) return;
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, selectedNodeId, patch), { coalesce: true });
    };

    /** A container is a WHOLE value (`direction` is required), so one field edit merges over
     *  the current container rather than replacing it with a partial one. */
    const editContainer = (patch: Partial<NonNullable<Node["layout"]["container"]>>) => {
        const current = node?.layout.container;
        if (!current) return;
        editLayout({ container: { ...current, ...patch } });
    };

    /** Constraints are a pair; editing one axis must not drop the other. */
    const editConstraint = (axis: "horizontal" | "vertical", value: string) => {
        const current = node?.layout.constraints ?? {};
        editLayout({ constraints: { ...current, [axis]: value } as Node["layout"]["constraints"] });
    };

    /** Whether the SELECTED node's parent lays it out — which of the child-side layout fields
     *  apply depends on this, and offering both sets at once would offer dead controls. */
    const parentIsContainer = (() => {
        if (!node?.parent) return false;
        const parent = expandInstances(dispatcher.getDocument()).nodes.get(node.parent);
        return !!parent && (parent.layout.container !== undefined || parent.layout.grid !== undefined);
    })();

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
        <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: UI.bg, color: UI.text }}>
            <div style={{ display: "flex", alignItems: "center", padding: "4px 8px", background: UI.panel, borderBottom: `1px solid ${UI.line}`, gap: 4 }}>
                <span style={{ fontWeight: 700, marginRight: 8, color: "#00bfff", fontSize: 13 }}>VDE</span>
                <ToolButton icon="↗" label="Select" active={toolName === "select"} onClick={() => setTool("select")} />
                <ToolButton icon="↔" label="Move" active={toolName === "move"} onClick={() => setTool("move")} />
                {SHAPE_KINDS.map(kind => (
                    <ToolButton
                        key={kind}
                        icon={SHAPE_ICONS[kind]}
                        label={kind[0].toUpperCase() + kind.slice(1)}
                        active={toolName === kind}
                        onClick={() => setTool(kind)}
                    />
                ))}
                {supportsPaintMode(toolName) && (
                    // Shown only for shapes the choice means something for — a line is already
                    // nothing but a stroke, and an image draws its own pixels.
                    <button
                        title="Draw new shapes as a solid fill, or as just their outline"
                        onClick={() => setPaintMode(m => (m === "filled" ? "outline" : "filled"))}
                        style={{ fontSize: 11, padding: "3px 8px", marginLeft: 4, background: "transparent", color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                    >
                        {paintMode === "filled" ? "◆ Filled" : "◇ Outline"}
                    </button>
                )}
                {supportsPaintMode(toolName) && paintMode === "outline" && (
                    // Only in outline mode: a border width means nothing for a shape drawn as a
                    // solid fill, and a control whose value is ignored is worse than no control.
                    <label style={{ fontSize: 11, color: "#ccc", display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
                        width
                        <input
                            type="number"
                            min={0}
                            max={STROKE_WIDTH_MAX}
                            step={1}
                            value={strokeWidth}
                            title="Border thickness for new outline shapes, in WORLD units — it scales with zoom, like the shape itself"
                            onChange={e => {
                                const raw = Number(e.target.value);
                                setStrokeWidth(Number.isFinite(raw) ? clampStrokeWidth(raw) : DEFAULT_STROKE_WIDTH);
                            }}
                            style={{ width: 44, fontSize: 11, padding: "2px 4px", background: UI.bg, color: UI.text, border: "1px solid #2a2a4a", borderRadius: 3 }}
                        />
                    </label>
                )}
                {toolName === "polygon" && (
                    // Only while the polygon tool is active — a control for a tool you are not
                    // using is noise, and its value is meaningless for every other shape.
                    <label style={{ fontSize: 11, color: "#ccc", display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
                        sides
                        <input
                            type="number"
                            min={POLYGON_MIN_SIDES}
                            max={POLYGON_MAX_SIDES}
                            value={polygonSides}
                            title={`Number of sides for the polygon tool (${POLYGON_MIN_SIDES}–${POLYGON_MAX_SIDES}); 5 = pentagon, 6 = hexagon, 8 = octagon`}
                            onChange={e => {
                                // Clamped through the SAME shared rule the generator uses, so the
                                // number shown is always the number that will be drawn.
                                const raw = Number(e.target.value);
                                setPolygonSides(Number.isFinite(raw) ? clampSides(raw) : POLYGON_DEFAULT_SIDES);
                            }}
                            style={{ width: 44, fontSize: 11, padding: "2px 4px", background: UI.bg, color: UI.text, border: "1px solid #2a2a4a", borderRadius: 3 }}
                        />
                    </label>
                )}
                {es.selectedNodeIds.length >= 2 && (
                    // Align + distribute, shown only for a MULTI-selection — the operations are
                    // meaningless for one node, and a row of dead buttons is worse than none.
                    <>
                        <div style={{ width: 1, height: 20, background: "#2a2a4a", margin: "0 4px" }} />
                        {ALIGN_BUTTONS.map(([edge, glyph, label]) => (
                            <button
                                key={edge}
                                title={label}
                                onClick={() => runAlign(edge)}
                                style={ALIGN_BUTTON_STYLE}
                            >{glyph}</button>
                        ))}
                        {DISTRIBUTE_BUTTONS.map(([axis, glyph, label]) => (
                            <button
                                key={axis}
                                title={`${label} — needs 3 or more`}
                                disabled={es.selectedNodeIds.length < 3}
                                onClick={() => runDistribute(axis)}
                                style={ALIGN_BUTTON_STYLE}
                            >{glyph}</button>
                        ))}
                    </>
                )}
                <div style={{ width: 1, height: 20, background: "#2a2a4a", margin: "0 4px" }} />
                <button
                    title="Wrap the selected nodes in a frame that fits them — the way to build a hierarchy (they must share a parent)"
                    disabled={!new FrameSelectionAction(dispatcher.getDocument(), es.selectedNodeIds).validate()}
                    onClick={() => {
                        const action = new FrameSelectionAction(dispatcher.getDocument(), es.selectedNodeIds);
                        if (dispatcher.dispatchAction(action).success) {
                            const frame = action.getFrameId();
                            if (frame) es.selectedNodeIds = [frame];
                        }
                        refresh();
                    }}
                    style={{ fontSize: 11, padding: "3px 8px", background: "transparent", color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                >
                    ⧉̲ Frame
                </button>
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
                <button
                    title="Detach the selected instance — bakes what it draws into ordinary nodes and severs the link to its master (undoable)"
                    disabled={(() => {
                        const sel = es.selectedNodeIds;
                        if (sel.length !== 1) return true;
                        // Enabled exactly when the action would succeed, so the control never
                        // offers a click that silently does nothing (a dangling instance has
                        // nothing to bake).
                        return !new DetachInstanceAction(dispatcher.getDocument(), sel[0]).validate();
                    })()}
                    onClick={() => {
                        const action = new DetachInstanceAction(dispatcher.getDocument(), es.selectedNodeIds[0]);
                        if (dispatcher.dispatchAction(action).success) {
                            // Select the baked ROOT: the instance the user had selected is gone,
                            // and a stale selection would leave the inspector empty.
                            const created = action.getCreatedNodeIds();
                            es.selectedNodeIds = created.length > 0 ? [created[0]] : [];
                        }
                        refresh();
                    }}
                    style={{ fontSize: 11, padding: "3px 8px", marginLeft: 6, background: "transparent", color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                >
                    ⊘ Detach
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
                    title="Folders — scan a codebase for capabilities with no UI, or browse an image folder"
                    onClick={() => setShowFolders(v => !v)}
                    style={{ fontSize: 11, padding: "3px 8px", marginRight: 8, background: showFolders ? UI.accentSoft : "transparent", color: "#ccc", border: `1px solid ${UI.line}`, borderRadius: 3, cursor: "pointer" }}
                >
                    🗀 Folders
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
                <div style={{ width: 180, background: UI.panel, borderRight: `1px solid ${UI.line}`, overflow: "auto", padding: 8 }}>
                    <div style={PANEL_HEADING}>Layers</div>
                    {(() => {
                        // Walk the REAL tree: roots, then each node's children, depth-first. The
                        // panel was a flat list from `traverseSceneGraph`, which had no way to show
                        // the hierarchy that frames, groups and instances now create.
                        const doc = dispatcher.getDocument();
                        const rows: React.ReactNode[] = [];
                        const walk = (ids: readonly string[], depth: number) => {
                            for (const id of ids) {
                                const n = doc.nodes.get(id);
                                if (!n) continue;
                                const hasChildren = n.children.length > 0;
                                const isCollapsed = collapsedLayers.has(id);
                                rows.push(
                                    <LayerRow
                                        key={id}
                                        node={n}
                                        depth={depth}
                                        selected={es.selectedNodeIds.includes(id)}
                                        collapsed={isCollapsed}
                                        hasChildren={hasChildren}
                                        isAutoLayout={n.layout.container !== undefined || n.layout.grid !== undefined}
                                        label={n.name || nodeTypeLabels[n.type] || n.type}
                                        onSelect={() => { es.selectedNodeIds = [id]; refresh(); }}
                                        onToggle={() => {
                                            const next = new Set(collapsedLayers);
                                            next.has(id) ? next.delete(id) : next.add(id);
                                            setCollapsedLayers(next);
                                        }}
                                    />
                                );
                                // A collapsed folder hides its subtree; the nodes stay selected and
                                // rendered, this is purely how much of the tree the panel shows.
                                if (hasChildren && !isCollapsed) walk(n.children, depth + 1);
                            }
                        };
                        walk(doc.rootNodeUuids, 0);
                        return rows;
                    })()}
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
                    <div style={{ position: "absolute", top: 0, left: 0, width: RULER, height: RULER, background: UI.panel, borderRight: `1px solid ${UI.line}`, borderBottom: "1px solid #2a2a4a" }} />
                </div>

                {showFolders && (
                    <div style={{ width: 240, background: UI.panel, borderLeft: `1px solid ${UI.line}`, padding: 10, overflow: "auto" }}>
                        <div style={PANEL_HEADING}>Folders</div>
                        <FoldersDrawer onPlaceImage={placeAsset} getDocument={() => dispatcher.getDocument()} />
                    </div>
                )}
                <div style={{ width: 220, background: UI.panel, borderLeft: `1px solid ${UI.line}`, padding: 10, overflow: "auto" }}>
                    <div style={PANEL_HEADING}>Inspector</div>
                    {node && selectedNodeId ? (
                        <div style={{ fontSize: 11, lineHeight: 1.6 }}>
                            <div style={{ color: "#666", marginBottom: 6 }}>{nodeTypeLabels[node.type] || node.type} — {selectedNodeId.slice(0, 8)}</div>

                            <InspectorSection title="Identity">
                                <label style={INSPECTOR_LABEL}>Name</label>
                                <TextInput
                                    value={node.name ?? ""}
                                    placeholder={nodeTypeLabels[node.type] || node.type}
                                    onChange={v => { editContent({ name: v }); refresh(); }}
                                />
                            </InspectorSection>

                            <InspectorSection title="Position & size">
                                <div style={INSPECTOR_GRID}>
                                    <div><label style={INSPECTOR_LABEL}>X</label>
                                        <NumInput value={Math.round(node.geometry.x)} onChange={v => { editSelected({ geometry: { x: v } }); refresh(); }} /></div>
                                    <div><label style={INSPECTOR_LABEL}>Y</label>
                                        <NumInput value={Math.round(node.geometry.y)} onChange={v => { editSelected({ geometry: { y: v } }); refresh(); }} /></div>
                                    <div><label style={INSPECTOR_LABEL}>W</label>
                                        <NumInput value={Math.round(node.geometry.width)} onChange={v => { editSelected({ geometry: { width: Math.max(1, v) } }); refresh(); }} /></div>
                                    <div><label style={INSPECTOR_LABEL}>H</label>
                                        <NumInput value={Math.round(node.geometry.height)} onChange={v => { editSelected({ geometry: { height: Math.max(1, v) } }); refresh(); }} /></div>
                                </div>
                                {/* Rotation in DEGREES: the document stores radians, but nobody thinks in
                                    radians. Disabled for an instance copy — a transform override is a
                                    later slice, so the field would silently do nothing. */}
                                <label style={INSPECTOR_LABEL}>Rotation°</label>
                                <NumInput
                                    value={Math.round(((node.transform?.rotation ?? 0) * 180 / Math.PI) * 10) / 10}
                                    disabled={isVirtualId(selectedNodeId)}
                                    onChange={v => { editTransform({ rotation: v * Math.PI / 180 }); refresh(); }}
                                />
                            </InspectorSection>

                            <InspectorSection title="Appearance">
                                <label style={INSPECTOR_LABEL}>Fill</label>
                                <ColorInput
                                    value={node.style.fill}
                                    onChange={v => { editSelected({ style: { fill: v } }); refresh(); }}
                                    onClear={() => { editSelected({ style: { fill: "none" } }); refresh(); }}
                                    clearLabel="No fill"
                                />
                                <label style={INSPECTOR_LABEL}>Stroke</label>
                                <ColorInput
                                    value={node.style.stroke ?? "#000000"}
                                    muted={!node.style.stroke}
                                    onChange={v => { editSelected({ style: { stroke: v } }); refresh(); }}
                                />
                                <div style={INSPECTOR_GRID}>
                                    <div><label style={INSPECTOR_LABEL}>Width</label>
                                        <NumInput
                                            value={typeof node.style.strokeWidth === "number" ? node.style.strokeWidth : 0}
                                            onChange={v => { editSelected({ style: { strokeWidth: clampStrokeWidth(v) } }); refresh(); }}
                                        /></div>
                                    <div><label style={INSPECTOR_LABEL}>Radius</label>
                                        <NumInput
                                            value={typeof node.style.radius === "number" ? node.style.radius : 0}
                                            onChange={v => { editSelected({ style: { radius: Math.max(0, v) } }); refresh(); }}
                                        /></div>
                                </div>
                                <label style={INSPECTOR_LABEL}>Opacity</label>
                                <input
                                    type="range" min="0" max="1" step="0.01"
                                    value={node.style.opacity}
                                    onChange={e => { editSelected({ style: { opacity: parseFloat(e.target.value) } }); refresh(); }}
                                    style={{ width: "100%" }}
                                />
                            </InspectorSection>

                            {node.type === "core.text" && (
                                <InspectorSection title="Text">
                                    <label style={INSPECTOR_LABEL}>Content</label>
                                    <TextInput
                                        value={node.text ?? ""}
                                        placeholder="Text"
                                        onChange={v => { editContent({ text: v }); refresh(); }}
                                    />
                                    <label style={INSPECTOR_LABEL}>Font size</label>
                                    <NumInput
                                        value={typeof node.style.fontSize === "number" ? node.style.fontSize : 14}
                                        onChange={v => { editSelected({ style: { fontSize: Math.max(1, v) } }); refresh(); }}
                                    />
                                </InspectorSection>
                            )}

                            {node.type === "core.image" && (
                                <InspectorSection title="Image">
                                    <label style={INSPECTOR_LABEL}>Source</label>
                                    <TextInput
                                        value={node.src ?? ""}
                                        placeholder="https://… or a relative path"
                                        onChange={v => {
                                            // The SAME shared validator the tool and the loader use, so the
                                            // field cannot author a source the document would refuse.
                                            if (v.length > 0 && srcError("core.image", v) !== null) return;
                                            editContent({ src: v });
                                            refresh();
                                        }}
                                    />
                                </InspectorSection>
                            )}

                            <InspectorSection title="Layout">
                                {/* Auto-layout has been in the engine since M2 — flex, hug, grow,
                                    shrink, wrap, and a whole grid module — with no way to reach it.
                                    Layout is not an override field, so these are stored-node only. */}
                                {isVirtualId(selectedNodeId) ? (
                                    <div style={{ color: "#666" }}>Layout is set on the master, not on a copy.</div>
                                ) : (
                                    <>
                                        <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6 }}>
                                            <input
                                                type="checkbox"
                                                checked={!!node.layout.container}
                                                onChange={e => {
                                                    // `direction` is required, so enabling means supplying a whole
                                                    // container; disabling clears it. The action carries grid ⊕
                                                    // container exclusivity itself.
                                                    editLayout({ container: e.target.checked ? { direction: "row", gap: 8, padding: 8 } : undefined });
                                                    refresh();
                                                }}
                                            />
                                            Auto-layout
                                        </label>
                                        {node.layout.container && (
                                            <>
                                                <label style={INSPECTOR_LABEL}>Direction</label>
                                                <SelectInput
                                                    value={node.layout.container.direction}
                                                    options={["row", "column"]}
                                                    onChange={v => { editContainer({ direction: v as "row" | "column" }); refresh(); }}
                                                />
                                                <div style={INSPECTOR_GRID}>
                                                    <div><label style={INSPECTOR_LABEL}>Gap</label>
                                                        <NumInput value={node.layout.container.gap ?? 0} onChange={v => { editContainer({ gap: Math.max(0, v) }); refresh(); }} /></div>
                                                    <div><label style={INSPECTOR_LABEL}>Padding</label>
                                                        <NumInput value={node.layout.container.padding ?? 0} onChange={v => { editContainer({ padding: Math.max(0, v) }); refresh(); }} /></div>
                                                </div>
                                                <label style={INSPECTOR_LABEL}>Align items</label>
                                                <SelectInput
                                                    value={node.layout.container.alignItems ?? "start"}
                                                    options={["start", "center", "end", "stretch"]}
                                                    onChange={v => { editContainer({ alignItems: v as "start" | "center" | "end" | "stretch" }); refresh(); }}
                                                />
                                                <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6 }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={!!node.layout.container.wrap}
                                                        onChange={e => { editContainer({ wrap: e.target.checked }); refresh(); }}
                                                    />
                                                    Wrap
                                                </label>
                                            </>
                                        )}

                                        {/* CHILD-side fields. Which ones apply depends on the PARENT:
                                            a container lays its children out (grow/shrink/margin), while a
                                            plain parent anchors them (constraints). Showing both at once
                                            would offer controls that do nothing. */}
                                        {parentIsContainer ? (
                                            <>
                                                <div style={{ ...INSPECTOR_LABEL, color: "#777", marginTop: 8 }}>In its parent</div>
                                                <div style={INSPECTOR_GRID}>
                                                    <div><label style={INSPECTOR_LABEL}>Grow</label>
                                                        <NumInput value={node.layout.grow ?? 0} onChange={v => { editLayout({ grow: Math.max(0, v) }); refresh(); }} /></div>
                                                    <div><label style={INSPECTOR_LABEL}>Shrink</label>
                                                        <NumInput value={node.layout.shrink ?? 0} onChange={v => { editLayout({ shrink: Math.max(0, v) }); refresh(); }} /></div>
                                                </div>
                                                <label style={INSPECTOR_LABEL}>Margin</label>
                                                <NumInput
                                                    value={typeof node.layout.margin === "number" ? node.layout.margin : 0}
                                                    onChange={v => { editLayout({ margin: Math.max(0, v) }); refresh(); }}
                                                />
                                                <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6 }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={node.layout.position === "absolute"}
                                                        onChange={e => { editLayout({ position: e.target.checked ? "absolute" : undefined }); refresh(); }}
                                                    />
                                                    Absolute (out of flow)
                                                </label>
                                            </>
                                        ) : node.parent ? (
                                            <>
                                                <div style={{ ...INSPECTOR_LABEL, color: "#777", marginTop: 8 }}>Constraints</div>
                                                <label style={INSPECTOR_LABEL}>Horizontal</label>
                                                <SelectInput
                                                    value={node.layout.constraints?.horizontal ?? "left"}
                                                    options={["left", "right", "left-right", "center", "scale"]}
                                                    onChange={v => { editConstraint("horizontal", v); refresh(); }}
                                                />
                                                <label style={INSPECTOR_LABEL}>Vertical</label>
                                                <SelectInput
                                                    value={node.layout.constraints?.vertical ?? "top"}
                                                    options={["top", "bottom", "top-bottom", "center", "scale"]}
                                                    onChange={v => { editConstraint("vertical", v); refresh(); }}
                                                />
                                            </>
                                        ) : null}
                                    </>
                                )}
                            </InspectorSection>

                            <InspectorSection title="Effects">
                                {/* Shadow and blur have been in the schema and both renderers since
                                    M3; this is the first way to reach them. */}
                                <label style={INSPECTOR_LABEL}>Blur</label>
                                <NumInput
                                    value={node.style.blur ?? 0}
                                    onChange={v => { editSelected({ style: { blur: Math.max(0, v) } }); refresh(); }}
                                />
                                <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6 }}>
                                    <input
                                        type="checkbox"
                                        checked={!!node.style.shadow}
                                        onChange={e => {
                                            editSelected({ style: { shadow: e.target.checked ? { dx: 2, dy: 2, blur: 4, color: "#000000" } : undefined } });
                                            refresh();
                                        }}
                                    />
                                    Drop shadow
                                </label>
                                {node.style.shadow && (
                                    <>
                                        <div style={INSPECTOR_GRID}>
                                            <div><label style={INSPECTOR_LABEL}>dx</label>
                                                <NumInput value={node.style.shadow.dx} onChange={v => { editShadow({ dx: v }); refresh(); }} /></div>
                                            <div><label style={INSPECTOR_LABEL}>dy</label>
                                                <NumInput value={node.style.shadow.dy} onChange={v => { editShadow({ dy: v }); refresh(); }} /></div>
                                        </div>
                                        <label style={INSPECTOR_LABEL}>Softness</label>
                                        <NumInput value={node.style.shadow.blur} onChange={v => { editShadow({ blur: Math.max(0, v) }); refresh(); }} />
                                        <label style={INSPECTOR_LABEL}>Shadow colour</label>
                                        <ColorInput value={node.style.shadow.color} onChange={v => { editShadow({ color: v }); refresh(); }} />
                                    </>
                                )}
                            </InspectorSection>
                        </div>
                    ) : (
                        <div style={{ fontSize: 11, color: "#555" }}>Select a node to edit</div>
                    )}

                </div>
            </div>

            <div style={{ padding: "3px 10px", background: UI.panel, borderTop: `1px solid ${UI.line}`, fontSize: 10, color: "#555", display: "flex", justifyContent: "space-between" }}>
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


/** Inspector chrome — one place for the panel's spacing so the sections stay uniform. */
const INSPECTOR_LABEL: React.CSSProperties = { color: "#aaa", display: "block", marginTop: 4 };
const INSPECTOR_GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };

/** A titled group of controls. Sections are what turn a list of fields into a panel you can scan. */
function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ borderTop: "1px solid #23233d", marginTop: 10, paddingTop: 6 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#777", letterSpacing: 0.4, textTransform: "uppercase" }}>{title}</div>
            {children}
        </div>
    );
}

/** Free text, committed on every keystroke (edits coalesce into one undo, like the sliders). */
function TextInput({ value, placeholder, onChange }: { value: string; placeholder?: string; onChange: (v: string) => void }) {
    return (
        <input
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={e => onChange(e.target.value)}
            style={{
                width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                background: UI.bg, color: UI.text, border: "1px solid #2a2a4a", borderRadius: 2, marginBottom: 4
            }}
        />
    );
}

/**
 * A colour swatch. `muted` dims it to show the field is currently ABSENT (a node with no
 * stroke still needs a colour to pick, but must not look like it has one), and `onClear`
 * adds an explicit "none" affordance where the field can be switched off.
 */
function ColorInput({ value, onChange, muted, onClear, clearLabel }: {
    value: string; onChange: (v: string) => void; muted?: boolean; onClear?: () => void; clearLabel?: string;
}) {
    // A `$token` reference (or "none") is not a hex colour, so the native picker cannot show it.
    // Fall back to a neutral swatch rather than letting the control silently rewrite the token.
    const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#888888";
    return (
        <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }}>
            <input
                type="color"
                value={hex}
                onChange={e => onChange(e.target.value)}
                style={{ flex: 1, height: 22, border: "none", background: "transparent", cursor: "pointer", opacity: muted ? 0.35 : 1 }}
            />
            {onClear && (
                <button onClick={onClear} title={clearLabel} style={{ fontSize: 10, padding: "1px 5px", background: "transparent", color: "#888", border: "1px solid #2a2a4a", borderRadius: 2, cursor: "pointer" }}>∅</button>
            )}
        </div>
    );
}


/** A plain dropdown for an enum field — the schema's own union, so the options cannot drift. */
function SelectInput({ value, options, onChange }: { value: string; options: readonly string[]; onChange: (v: string) => void }) {
    return (
        <select
            value={value}
            onChange={e => onChange(e.target.value)}
            style={{
                width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                background: UI.bg, color: UI.text, border: "1px solid #2a2a4a", borderRadius: 2, marginBottom: 4
            }}
        >
            {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
    );
}


/** Glyph per node type — a layer list you can scan by shape rather than by reading every row. */
const LAYER_ICONS: Record<string, string> = {
    "core.rectangle": "▭", "core.ellipse": "○", "core.line": "╱", "core.text": "T",
    "core.image": "▣", "core.path": "◇", "core.instance": "⧉"
};

/**
 * One row of the layer tree.
 *
 * A row is a FOLDER when it has children. Two kinds exist and they are deliberately the same
 * mechanism: a GROUP is a container with no fill (organisational — it holds things and paints
 * nothing), and a FRAME is one that paints and can lay its children out. Nothing in the
 * document distinguishes them, exactly as a component master is "just a node subtree" — so the
 * tree shows what a node IS (does it paint? does it lay out?) rather than a stored kind.
 */

/**
 * The FOLDERS drawer: the two directory-backed workflows.
 *
 *  - SOURCE: point at the codebase you are designing for; `scanCapabilities` lists what it can
 *    already do that nothing reaches, so you know which screens are still missing.
 *  - ASSETS: point at an image folder and click one to place it on the canvas.
 *
 * Both are inert without Electron (the browser build has no `electronAPI`), so the drawer says
 * so rather than showing controls that do nothing.
 */
function FoldersDrawer({ onPlaceImage, getDocument }: {
    onPlaceImage: (dataUrl: string, name: string) => void;
    getDocument: () => ReadonlyDocument;
}) {
    const [tab, setTab] = useState<"source" | "assets" | "export">("source");
    const [exported, setExported] = useState<string | null>(null);
    const [sourceFolder, setSourceFolder] = useState<string | null>(null);
    const [assetFolder, setAssetFolder] = useState<string | null>(null);
    const [findings, setFindings] = useState<Capability[] | null>(null);
    const [assets, setAssets] = useState<{ path: string; name: string; relative: string }[]>([]);
    const [busy, setBusy] = useState(false);
    const api = window.electronAPI;

    /** Scan a folder. `folder` may come from the native picker OR from the typed path field —
     *  you usually know where the project is, and pasting it beats clicking through a tree. */
    const scan = async (folder: string | null) => {
        if (!api || !folder) return;
        setBusy(true);
        try {
            const files = await api.readSourceFolder(folder);
            setSourceFolder(folder);
            // The analysis is pure and runs HERE, on file contents the main process read —
            // so the same function the tests exercise is the one the user sees.
            setFindings(scanCapabilities(files));
        } finally { setBusy(false); }
    };

    const browseAssets = async () => {
        if (!api) return;
        const folder = await api.pickFolder();
        if (!folder) return;
        setBusy(true);
        try {
            setAssetFolder(folder);
            setAssets(await api.readAssetFolder(folder));
        } finally { setBusy(false); }
    };

    if (!api) {
        return <div style={{ fontSize: 11, color: "#666", padding: 8 }}>Folder access needs the desktop app.</div>;
    }

    return (
        <div style={{ fontSize: 11 }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                {(["source", "assets", "export"] as const).map(t => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        style={{
                            flex: 1, fontSize: 11, padding: "3px 6px", cursor: "pointer", borderRadius: 3,
                            background: tab === t ? UI.accentSoft : "transparent",
                            color: tab === t ? UI.text : "#999", border: `1px solid ${UI.line}`
                        }}
                    >{t === "source" ? "Code" : t === "assets" ? "Assets" : "Export"}</button>
                ))}
            </div>

            {tab === "export" ? (
                <>
                    <button
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                // The SAME pure exporter the tests exercise; the main process only writes.
                                const written = await api.writeIntoFolder(folder, "design.svg", exportSVG(getDocument()));
                                setExported(written);
                            } finally { setBusy(false); }
                        }}
                        disabled={busy}
                        style={DRAWER_BUTTON}
                    >{busy ? "Writing…" : "Export SVG to a folder…"}</button>
                    <input
                        type="text"
                        placeholder="…or paste a folder path and press Enter"
                        onKeyDown={async e => {
                            if (e.key !== "Enter") return;
                            const folder = (e.target as HTMLInputElement).value.trim();
                            if (!folder) return;
                            setBusy(true);
                            try { setExported(await api.writeIntoFolder(folder, "design.svg", exportSVG(getDocument()))); }
                            finally { setBusy(false); }
                        }}
                        style={{ width: "100%", boxSizing: "border-box", fontSize: 11, padding: "3px 5px", background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3, marginBottom: 6 }}
                    />
                    {exported && <div style={{ color: "#6a9", wordBreak: "break-all" }}>Wrote {exported}</div>}
                    <div style={{ color: "#666", marginTop: 6 }}>
                        The whole document, framed to its own content — no grid, no selection chrome.
                    </div>
                </>
            ) : tab === "source" ? (
                <>
                    <button onClick={async () => scan(await api.pickFolder())} disabled={busy} style={DRAWER_BUTTON}>
                        {busy ? "Scanning…" : "Choose a folder…"}
                    </button>
                    <input
                        type="text"
                        placeholder="…or paste a path and press Enter"
                        onKeyDown={e => { if (e.key === "Enter") scan((e.target as HTMLInputElement).value.trim() || null); }}
                        style={{ width: "100%", boxSizing: "border-box", fontSize: 11, padding: "3px 5px", background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3, marginBottom: 6 }}
                    />
                    {sourceFolder && (
                        <div style={{ color: "#666", margin: "6px 0", wordBreak: "break-all" }}>{sourceFolder}</div>
                    )}
                    {findings && findings.length === 0 && (
                        <div style={{ color: "#6a9", padding: "6px 0" }}>Nothing unwired found — every export is referenced somewhere.</div>
                    )}
                    {findings && findings.length > 0 && (
                        <>
                            <div style={{ color: "#888", margin: "6px 0" }}>
                                {findings.length} capabilit{findings.length === 1 ? "y" : "ies"} with no apparent UI
                            </div>
                            {findings.slice(0, 200).map(c => (
                                <div key={`${c.path}:${c.line}:${c.name}`} style={{ borderTop: `1px solid ${UI.line}`, padding: "5px 0" }}>
                                    <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                                        <span style={{
                                            fontSize: 9, padding: "0 4px", borderRadius: 2, color: UI.bg,
                                            background: c.confidence === "high" ? "#6ac48a" : c.confidence === "medium" ? "#d0a85c" : "#5a5a72"
                                        }}>{c.kind}</span>
                                        <span style={{ color: UI.text }}>{c.name}</span>
                                    </div>
                                    <div style={{ color: "#666" }}>{c.path}:{c.line}</div>
                                    <div style={{ color: "#7a7a90" }}>{c.reason}</div>
                                </div>
                            ))}
                            {findings.length > 200 && (
                                <div style={{ color: "#888", paddingTop: 6 }}>…and {findings.length - 200} more (showing the top 200).</div>
                            )}
                        </>
                    )}
                </>
            ) : (
                <>
                    <button onClick={browseAssets} disabled={busy} style={DRAWER_BUTTON}>
                        {busy ? "Reading…" : "Choose an asset folder…"}
                    </button>
                    {assetFolder && <div style={{ color: "#666", margin: "6px 0", wordBreak: "break-all" }}>{assetFolder}</div>}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                        {assets.slice(0, 300).map(a => (
                            <button
                                key={a.path}
                                title={`${a.relative} — click to place on the canvas`}
                                onClick={async () => { onPlaceImage(await api.readImageDataUrl(a.path), a.name); }}
                                style={{ ...DRAWER_BUTTON, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            >{a.name}</button>
                        ))}
                    </div>
                    {assetFolder && assets.length === 0 && <div style={{ color: "#666" }}>No images in that folder.</div>}
                </>
            )}
        </div>
    );
}

function LayerRow({ node, depth, selected, collapsed, hasChildren, isAutoLayout, onSelect, onToggle, label }: {
    node: ReadonlyNode; depth: number; selected: boolean; collapsed: boolean; hasChildren: boolean;
    isAutoLayout: boolean; onSelect: () => void; onToggle: () => void; label: string;
}) {
    const [hover, setHover] = useState(false);
    const isGroup = hasChildren && (node.style.fill === "none" || !node.style.fill);
    return (
        <div
            onClick={onSelect}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            title={`${label} — ${node.id.slice(0, 8)}`}
            style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 6px", paddingLeft: 6 + depth * 12,
                fontSize: 11, borderRadius: 3, cursor: "pointer", marginBottom: 1,
                background: selected ? "#22436b" : hover ? "#1d1d33" : "transparent",
                borderLeft: selected ? "2px solid #4da3ff" : "2px solid transparent",
                color: selected ? "#f0f6ff" : "#c8c8d8"
            }}
        >
            {/* The disclosure triangle is its own hit target so clicking it does not also select. */}
            <span
                onClick={e => { if (hasChildren) { e.stopPropagation(); onToggle(); } }}
                style={{ width: 10, textAlign: "center", color: "#7a7a95", cursor: hasChildren ? "pointer" : "default" }}
            >
                {hasChildren ? (collapsed ? "▸" : "▾") : ""}
            </span>
            <span style={{ width: 12, textAlign: "center", color: selected ? "#9ecbff" : "#8a8aa5" }}>
                {hasChildren ? (isGroup ? "🗀" : "▤") : (LAYER_ICONS[node.type] || "◦")}
            </span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
            {/* Badges say what a folder DOES, which is the thing you actually need at a glance. */}
            {isAutoLayout && <span title="Auto-layout" style={{ fontSize: 9, color: "#6f9", opacity: 0.8 }}>⇥</span>}
            {node.type === "core.instance" && <span title="Component instance" style={{ fontSize: 9, color: "#b98cff" }}>⧉</span>}
        </div>
    );
}

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
                background: UI.bg, color: UI.text, border: "1px solid #2a2a4a", borderRadius: 2, marginBottom: 4
            }}
        />
    );
}
