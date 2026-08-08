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
import { geometryActionFor, styleActionFor, contentActionFor, layoutActionFor, transformActionFor } from "../core/actions/nodeEdit";
import { ContentPatch, UpdateNodeContentAction } from "../core/actions/UpdateNodeContentAction";
import { resolveScene, isVirtualId } from "../core/document/Components";
import { SetActiveThemeAction, SetVariableAction, DeleteVariableAction } from "../core/actions/VariableActions";
import { Variable, VariableStore, variableKeyError, tokenRefFor, tokenKeyOf } from "../core/document/Variables";
import { TrackSize, newGridPatch, VariantKey, variantError, slotError, variantNameError } from "../core/document/Node";
import { SetVariantAction, SetInstanceVariantAction } from "../core/actions/VariantActions";
import { SetSlotAction, SetSlotContentAction } from "../core/actions/SlotActions";
import { SetNodeStateAction, SetActiveStateAction } from "../core/actions/StateActions";
import { SetNodeFlagsAction } from "../core/actions/SetNodeFlagsAction";
import { resolveLayerDrop, DropPosition } from "../editor/layerDrop";
import { selectionForRowClick, ClickModifiers } from "../editor/layerSelection";
import { filterLayers } from "../editor/layerFilter";
import { ReparentNodeAction } from "../core/actions/ReparentNodeAction";
import { variantProperties, resolveVariantMaster, masterSubtreeIds } from "../core/document/Components";
import { parseTrackList, formatTrackList } from "../core/document/TrackList";
import { CreateInstanceAction } from "../core/actions/CreateInstanceAction";
import { DetachInstanceAction } from "../core/actions/DetachInstanceAction";
import { UpdateNodeTransformAction } from "../core/actions/UpdateNodeTransformAction";
import { UpdateNodeLayoutAction } from "../core/actions/UpdateNodeLayoutAction";
import { createEditorState, EditorState, zoomAt } from "../editor/EditorState";
import { ToolController } from "../editor/tools/ToolController";
import { SelectTool } from "../editor/tools/SelectTool";
import { MoveTool } from "../editor/tools/MoveTool";
import { PenTool } from "../editor/tools/PenTool";
import { ShapeTool, SHAPE_KINDS, ShapeKind, PaintMode, supportsPaintMode, clampStrokeWidth, DEFAULT_STROKE_WIDTH, STROKE_WIDTH_MAX } from "../editor/tools/ShapeTool";
import { RasterTool } from "../editor/tools/RasterTool";
import { Rgba } from "../core/paint/PixelBuffer";
import { makeBrush, BRUSH_MAX_SIZE } from "../core/paint/Brush";
import { SymmetryMode, NO_SYMMETRY } from "../core/paint/Symmetry";
import { FrameSelectionAction } from "../core/actions/FrameSelectionAction";
import { alignAction, distributeAction } from "../core/actions/alignActions";
import { booleanAction, makeBooleanNodeAction } from "../core/actions/booleanActions";
import { outlineStrokeAction } from "../core/actions/outlineStrokeActions";
import { onionFrames, Keyframe } from "../core/document/Timeline";
import { DEMOS } from "../core/document/Demos";
import { applyParallax, DEPTH_MIN, DEPTH_MAX } from "../core/document/Depth";
import { SetDepthAction } from "../core/actions/SetDepthAction";
import { SetMeshAction } from "../core/actions/SetMeshAction";
import { SetLightingAction } from "../core/actions/SetLightingAction";
import { restMesh, MESH_MAX_DIVISIONS } from "../core/document/Mesh";
import { SetTrackAction } from "../core/actions/SetTrackAction";
import { SetTimelineAction } from "../core/actions/SetTimelineAction";
import { STROKE_ALIGNS, StrokeAlign } from "../core/geometry/StrokeOutline";
import { FILL_RULES, STROKE_CAPS, STROKE_JOINS } from "../core/document/Node";
import { SetBooleanOpAction } from "../core/actions/SetBooleanOpAction";
import { BooleanOp, TEXT_ALIGNS, FONT_FAMILY_MAX, StateDefinition } from "../core/document/Node";
import { blendStates, easingAt, TRIGGERS, EASINGS, TRANSITION_MAX_MS, Interaction, Trigger, Easing } from "../core/document/Prototype";
import { BEZIER_PRESETS, CubicBezier } from "../core/document/Bezier";
import { lerpViewport } from "../editor/EditorState";
import { SetInteractionsAction } from "../core/actions/SetInteractionsAction";
import { compileScript, snapshotFor } from "../core/script/ScriptApi";
import { runScript } from "../editor/ScriptRunner";
import { applyActiveState } from "../core/document/Components";
import { DuplicateNodesAction } from "../core/actions/DuplicateNodesAction";
import { DeleteNodeAction } from "../core/actions/DeleteNodeAction";
import { TransactionAction } from "../core/actions/TransactionAction";
import { selectionRoots } from "../core/document/SceneGraph";
import { resolveShortcut, isTypingTarget, Shortcut } from "../editor/shortcuts";
import { AlignEdge, DistributeAxis } from "../core/geometry/Alignment";
import { IMAGE_SRC_MAX, srcError, sourceRectError } from "../core/document/Node";
import { clampSides, POLYGON_DEFAULT_SIDES, POLYGON_MIN_SIDES, POLYGON_MAX_SIDES } from "../core/geometry/Polygon";
import { scanCapabilities, Capability } from "../core/scan/CapabilityScan";
import { exportSVG, TextLines } from "../core/export/ExportSVG";
import { planSheet, sheetAtlas, sheetTooLarge, drawSheet, SheetPlan } from "../core/export/SpriteSheet";
import { sliceGrid, sliceCells, sliceTrack, blankCells } from "../core/import/SheetSlice";
import { parseTextureAtlas, atlasError, AtlasEntry } from "../core/import/TextureAtlas";
import { parseSvgDocument, svgDocumentError } from "../core/import/SvgDocument";
import { svgNodeSpecs, SvgNodeSpec } from "../core/import/SvgNodes";
import { parseFontFile, fontFileError, FontInfo } from "../core/import/FontFile";
import { parseTiledMap, parseTiledTileset, tiledMapError, tilesetFor, tileSourceRect,
    tilePosition, tileTransform, tileImageFor, tilesetOverflow, TiledTileset } from "../core/import/TiledMap";
import { registerFont, registeredFonts } from "../renderer/FontCache";
import { UpdateNodePathAction } from "../core/actions/UpdateNodePathAction";
import { generateUUID } from "../core/ids/UUID";
import { naturalSize } from "../../src/renderer/ImageCache";
import { SourceRect } from "../core/document/Node";
import { Action } from "../core/actions/Action";
import { textLinesFor } from "../renderer/TextRaster";
import { ReadonlyDocument, ProjectDocument } from "../core/document/Document";
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
    accentSoft: "#22436b",
    warn: "#ff9060"         // a field explaining why it refused input
};

/** A panel's section heading — small, spaced, quiet. Used by every panel so they match. */
/**
 * Paths one SVG import will place.
 *
 * A drawing of a few hundred shapes is ordinary; a map of ten thousand is a document nobody meant
 * to make by pasting into a text box. Refused rather than truncated — half a picture placed quietly
 * is worse than a sentence saying it was too large.
 */
const SVG_PLACE_MAX = 2000;
/**
 * How many tiles one map may place.
 *
 * The largest map measured is 10,618 non-empty cells across five layers, and the whole tree is
 * 22,808. This clears the largest by a wide margin and still refuses a map that would lock the
 * editor up — and it REPORTS rather than truncating, because half a map placed silently looks like
 * a broken importer rather than a refused one.
 */
const TILE_PLACE_MAX = 20000;

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
/** Boolean controls: operation, glyph, tooltip — one list, like the align row. */
const BOOLEAN_BUTTONS: readonly [BooleanOp, string, string][] = [
    ["union", "∪", "Union — merge into one shape"],
    ["subtract", "∖", "Subtract — cut the shapes above out of the bottom one"],
    ["intersect", "∩", "Intersect — keep only where they overlap"],
    ["exclude", "⊖", "Exclude — keep everything except the overlap"]
];
/** The compact select/input used by the prototype rows — one style so the row lines up. */
const SELECT_STYLE: React.CSSProperties = {
    fontSize: 11, padding: "2px 4px", background: "#12121f", color: "#ccc",
    border: "1px solid #2a2a4a", borderRadius: 3, boxSizing: "border-box"
};

const ALIGN_BUTTON_STYLE: React.CSSProperties = {
    fontSize: 12, padding: "3px 6px", background: "transparent", color: "#ccc",
    border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer", minWidth: 24
};

/** Toolbar glyph per basic shape (the label is the kind's own name). */
/**
 * `#rrggbb` from an `<input type="color">` as the four bytes a brush paints.
 *
 * FULLY OPAQUE, because the colour control has no alpha channel and inventing one would make
 * every stroke silently translucent. Erasing is a separate mode (alpha 0), not a dimmed colour —
 * `setPixel` REPLACES, so a transparent brush is the eraser.
 */
function hexToRgba(hex: string): Rgba {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return [0, 0, 0, 255];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

const SHAPE_ICONS: Record<ShapeKind, string> = {
    rectangle: "□", ellipse: "○", line: "╱", text: "T", triangle: "△", polygon: "⬟", image: "▣",
    // A CANVAS to paint on, distinct from ▣ (an image someone else made). This tool CREATES the
    // surface; the brush below paints on one that already exists.
    raster: "▦"
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
            onMenuCommand: (cb: (command: string) => void) => () => void;
            onFileOpened: (cb: (payload: { filePath: string; content: string }) => void) => () => void;
            onRequestSave: (cb: (filePath: string) => void) => () => void;
            saveFile: (filePath: string, content: string) => Promise<boolean>;
            requestSaveAs: () => Promise<boolean>;
            pickFolder: () => Promise<string | null>;
            readSourceFolder: (folder: string) => Promise<{ path: string; content: string }[]>;
            readAssetFolder: (folder: string) => Promise<{ path: string; name: string; relative: string }[]>;
            readImageDataUrl: (filePath: string) => Promise<string>;
            writeIntoFolder: (folder: string, filename: string, content: string) => Promise<string>;
            writePngIntoFolder: (folder: string, filename: string, dataUrl: string) => Promise<string>;
            readFontFolder: (folder: string) => Promise<{ path: string; name: string; relative: string }[]>;
            readFontBytes: (filePath: string) => Promise<string>;
            readTiledFolder: (folder: string) => Promise<{ path: string; name: string; relative: string }[]>;
            readTiledMap: (folder: string, mapPath: string) => Promise<string>;
            readTiledTileset: (folder: string, mapPath: string, relative: string) => Promise<string>;
            readTiledImage: (folder: string, mapPath: string, relative: string) => Promise<string>;
            /** The one SYNCHRONOUS channel — see the preload. Returns base64, or an error to show. */
            inflateSync: (base64: string) => { ok: boolean; data?: string; error?: string };
        };
    }
}

// Use the rich result: a corrupt autosave must NOT look like "no autosave".
// Starting blank and letting the user overwrite it would destroy recoverable work.
const initialLoad = Serializer.loadResult();
const initialDocument = initialLoad.document;
const startedFromCorruptSave = initialLoad.status === "corrupt";

/**
 * How the EXPORTER breaks text into lines.
 *
 * The exporter is pure and cannot measure; this runs in a browser and can. Handing it
 * `TextRaster.textLinesFor` means an exported file wraps where the Canvas and GPU backends wrap,
 * rather than running every paragraph off the side of its box — one typesetter for the editor and
 * for the artefact you hand somebody. Falls back to hard breaks only where there is no DOM to
 * measure with, which is the answer the exporter gave before this existed.
 */
const exportTextLines: TextLines = shape => textLinesFor(shape) ?? shape.text.split("\n");

/**
 * Draw a planned sheet and write both halves of it.
 *
 * The DOM half of the sprite-sheet export, which is why it lives here rather than in `core`: a
 * plan is arithmetic and belongs in a module a test can reach, but turning it into pixels needs a
 * canvas. `drawSheet` is handed a context and knows nothing about files.
 *
 * TWO FILES, because an engine needs both — the texture, and the description of which rectangle is
 * which frame of which clip. The PNG is written FIRST: the atlas's `image` field names a file, and
 * an atlas pointing at a name nobody wrote is worse than no atlas, because it fails in the engine
 * rather than here.
 */
async function writeSheet(doc: ReadonlyDocument, plan: SheetPlan, folder: string): Promise<string> {
    const api = window.electronAPI;
    if (!api) throw new Error("No file bridge — the sprite sheet has nowhere to go.");
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D context for the sprite sheet.");
    drawSheet(ctx, doc, plan);
    const png = await api.writePngIntoFolder(folder, "sheet.png", canvas.toDataURL("image/png"));
    await api.writeIntoFolder(folder, "sheet.json", JSON.stringify(sheetAtlas(doc, plan, "sheet.png"), null, 2));
    return png;
}

/**
 * The easing choices offered anywhere easing is authored — the four NAMES plus the curve presets.
 *
 * One list rather than one per control, because an animator who learns "overshoot" on a keyframe
 * should find the same word on an interaction. The value round-trips through a string key so a
 * `<select>` can carry it; `easingFromKey` is the only place that mapping lives.
 */
const EASING_CHOICES: readonly string[] = [...EASINGS, ...BEZIER_PRESETS.map(p => p.name)];

function easingKeyOf(easing: Easing | undefined): string {
    if (easing === undefined) return "linear";
    if (typeof easing === "string") return easing;
    const hit = BEZIER_PRESETS.find(p =>
        p.curve.x1 === easing.x1 && p.curve.y1 === easing.y1 && p.curve.x2 === easing.x2 && p.curve.y2 === easing.y2);
    // A curve that is not a preset still has to display as something. "custom" is offered ONLY
    // when one is already set, so the list never suggests a choice that does nothing.
    return hit ? hit.name : "custom";
}

function easingFromKey(key: string, current: Easing | undefined): Easing | undefined {
    if ((EASINGS as readonly string[]).includes(key)) return key as Easing;
    const hit = BEZIER_PRESETS.find(p => p.name === key);
    return hit ? { ...hit.curve } : current;
}

/** The easing `<select>`, shared by the interaction rows and the timeline's keyframe control. */
function EasingSelect({ value, onPick, width }: { value: Easing | undefined; onPick: (e: Easing | undefined) => void; width: number }) {
    const key = easingKeyOf(value);
    return (
        <select
            value={key}
            title="How the tween leaving this point is shaped. The named curves are CSS's; overshoot and anticipate go past the target and settle back."
            onChange={e => onPick(easingFromKey(e.target.value, value))}
            style={{ ...SELECT_STYLE, width }}
        >
            {key === "custom" ? <option value="custom">custom</option> : null}
            {EASING_CHOICES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
    );
}

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
    // THE BRUSH. Same getter pattern again, and for the same reason: `RasterTool` is constructed
    // once, so a captured colour would freeze whatever was chosen when the toolbar first rendered.
    const [paintColour, setPaintColour] = useState<string>("#000000");
    const paintColourRef = useRef<string>("#000000");
    paintColourRef.current = paintColour;
    // ERASING IS NOT A COLOUR, it is alpha 0 — `setPixel` REPLACES rather than blends, so the
    // eraser is the pencil holding a transparent colour and needs no second code path.
    const [erasing, setErasing] = useState(false);
    const erasingRef = useRef(false);
    erasingRef.current = erasing;
    const [brushSize, setBrushSize] = useState<number>(1);
    const brushSizeRef = useRef(1);
    brushSizeRef.current = brushSize;
    const [brushRound, setBrushRound] = useState(false);
    const brushRoundRef = useRef(false);
    brushRoundRef.current = brushRound;
    const [symmetry, setSymmetry] = useState<SymmetryMode>(NO_SYMMETRY);
    const symmetryRef = useRef<SymmetryMode>(NO_SYMMETRY);
    symmetryRef.current = symmetry;

    // Which folders are collapsed in the layer tree. Purely a VIEW concern — it never touches
    // the document, so collapsing is not undoable and not persisted.
    const [collapsedLayers, setCollapsedLayers] = useState<Set<string>>(new Set());
    const [backend, setBackend] = useState<RenderBackend>("svg");
    const [showFolders, setShowFolders] = useState(false);
    const [showTokens, setShowTokens] = useState(false);
    const [showScript, setShowScript] = useState(false);
    // The layer drag in flight: what is being dragged, and where the pointer currently is.
    // Kept in React state (not a ref) because the row that is being hovered has to REDRAW to
    // show the indicator — a ref would move the data without moving the picture.
    const [layerDrag, setLayerDrag] = useState<{ id: string; over: string | null; position: DropPosition | null }>({ id: "", over: null, position: null });
    const [layerQuery, setLayerQuery] = useState("");
    // The row a shift-click measures from. Panel-local: it is an affordance, not document
    // state, and it must survive a re-render without causing one.
    const layerAnchorRef = useRef<string | null>(null);
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
    /**
     * The playhead the last computed geometry was built at.
     *
     * A frame change is a DIFFERENT DOCUMENT, exactly as a prototype frame is, and the incremental
     * path cannot see it — see the note where this is read.
     */
    const prevFrameRef = useRef<number | undefined>(undefined);
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
    // THE BRUSH'S TARGET, resolved here only to say so in the toolbar. `RasterTool` decides for
    // itself at press time from the document — this is a label, not a second rule that could
    // disagree with the one that paints.
    const selectedRasterId = (() => {
        if (es.selectedNodeIds.length !== 1) return null;
        const n = dispatcher.getDocument().nodes.get(es.selectedNodeIds[0]);
        return n && n.type === "core.raster" && n.surface ? n.id : null;
    })();

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
                [kind, new ShapeTool(dispatcher, es, refresh, kind, pickImageSource, () => polygonSidesRef.current, () => paintModeRef.current, () => strokeWidthRef.current)])),
            // The PEN — the first way to create a `core.path`, which has been renderable since
            // schema 17 with no way to author one.
            pen: new PenTool(dispatcher, es, refresh, () => paintModeRef.current === "outline" ? "none" : "#4a90d9"),
            // THE BRUSH. Keyed "paint", not "raster": the `raster` SHAPE creates a surface, this
            // paints on one that exists. Two gestures, two tools — a single tool that did both
            // could not tell "start a new canvas here" from "start a stroke here".
            paint: new RasterTool(dispatcher, es, refresh,
                () => erasingRef.current ? [0, 0, 0, 0] : hexToRgba(paintColourRef.current),
                () => makeBrush(brushSizeRef.current, brushRoundRef.current),
                () => symmetryRef.current)
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

    /**
     * Combine the selection with a boolean. Geometry is resolved FRESH for the same reason align
     * does it: the toolbar is clickable at any time, and a stale ComputedState would combine the
     * shapes' old outlines. The result's id is minted here because both halves of the transaction
     * (create the node, then set its commands) have to name it.
     */
    const runBoolean = useCallback((op: BooleanOp, live: boolean) => {
        const doc = dispatcher.getDocument();
        const id = crypto.randomUUID();
        // LIVE keeps the operands as children of a `core.boolean` and derives the shape every
        // frame; FLATTEN bakes it into one path and consumes them. Same maths, different
        // permanence — so the choice is the user's, not a default buried in the code.
        const action = live
            ? makeBooleanNodeAction(doc, computeGeometry(doc), es.selectedNodeIds, op, id)
            : booleanAction(doc, computeGeometry(doc), es.selectedNodeIds, op, id);
        if (action && dispatcher.dispatchAction(action).success) {
            es.selectedNodeIds = [id];   // select the result, not the shapes that no longer exist
        }
        refresh();
    }, [dispatcher, es, refresh]);

    /**
     * Turn the selection's BORDERS into paths — the stroke equivalent of the boolean bake.
     *
     * Alignment is asked for here rather than stored on the node, because it is a property of the
     * conversion and not of the document: no backend can draw an inside border, so a node that
     * claimed to have one would look different depending on which backend was live. Outlined, it
     * is a fill, and a fill is a fill everywhere.
     */
    const runOutlineStroke = useCallback((align: StrokeAlign) => {
        const doc = dispatcher.getDocument();
        // One id per selected node, minted here for the same reason the boolean's is: both halves
        // of each node's transaction have to name it, and unused ones simply go unspent.
        const ids = es.selectedNodeIds.map(() => crypto.randomUUID());
        const action = outlineStrokeAction(doc, computeGeometry(doc), es.selectedNodeIds, ids, align);
        if (action && dispatcher.dispatchAction(action).success) {
            es.selectedNodeIds = ids.filter(id => dispatcher.getDocument().nodes.has(id));
        }
        refresh();
    }, [dispatcher, es, refresh]);

    /**
     * Advance the playhead while the timeline runs.
     *
     * Wall-clock driven rather than one-frame-per-tick, so an animation authored at 12 fps plays
     * at 12 fps whether the machine manages 60 redraws a second or 20. It LOOPS, because the
     * thing you want while animating is to watch the same second over and over.
     */
    useEffect(() => {
        const timeline = dispatcher.getDocument().timeline;
        if (!es.playingTimeline || !timeline) return;
        const startedAt = Date.now();
        const from = Math.round(es.frame ?? 0);
        const id = window.setInterval(() => {
            const elapsed = ((Date.now() - startedAt) / 1000) * timeline.fps;
            es.frame = (from + Math.floor(elapsed)) % timeline.frames;
            refresh();
        }, 1000 / Math.min(60, timeline.fps * 2));
        return () => window.clearInterval(id);
    }, [dispatcher, es, refresh, es.playingTimeline]);

    /**
     * Put a KEYFRAME on the selected node at the playhead, holding what it looks like NOW.
     *
     * The values captured are the node's own stored geometry, transform and opacity, which is the
     * thing a user has just finished arranging. Animating is therefore the same gesture as
     * editing — move the shape, press the key — rather than a separate mode with its own notion of
     * where things are.
     */
    const addKeyframe = useCallback((hold: boolean) => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds[0];
        const node = id ? doc.nodes.get(id) : undefined;
        if (!node) return;
        const frame = Math.round(es.frame ?? 0);
        const values = {
            geometry: { x: node.geometry.x, y: node.geometry.y, width: node.geometry.width, height: node.geometry.height },
            transform: node.transform ? { ...node.transform } : undefined,
            style: { opacity: node.style.opacity }
        };
        // Replace the keyframe already on this frame rather than adding a second one: two
        // keyframes at one time is not a drawing anybody can mean, and the shared validator
        // refuses it — better to make the obvious gesture do the obvious thing.
        const track: Keyframe[] = [...(node.track ?? [])].filter(k => k.frame !== frame);
        track.push({ frame, hold: hold || undefined, values } as Keyframe);
        track.sort((a, b) => a.frame - b.frame);
        dispatcher.dispatchAction(new SetTrackAction(doc, id, track));
        refresh();
    }, [dispatcher, es, refresh]);

    /**
     * Re-shape the tween LEAVING the keyframe under the playhead.
     *
     * The `easing` field has been on `Keyframe` since the timeline landed and had no way to reach
     * it — a schema field with no authoring surface, which is the same "feature without a
     * consumer" this codebase refuses everywhere else. Schema 44 makes it worth reaching, since it
     * can now hold a curve rather than one of four words.
     */
    const setKeyframeEasing = useCallback((easing: Easing | undefined) => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds[0];
        const node = id ? doc.nodes.get(id) : undefined;
        if (!node?.track) return;
        const frame = Math.round(es.frame ?? 0);
        // Only the keyframe ON the playhead. Easing belongs to a specific keyframe, so "the
        // nearest one" would silently re-shape a tween the user is not looking at.
        if (!node.track.some(k => k.frame === frame)) return;
        const track: Keyframe[] = node.track.map(k =>
            k.frame === frame
                ? (easing === undefined ? { ...k, easing: undefined } as Keyframe : { ...k, easing } as Keyframe)
                : { ...k } as Keyframe);
        dispatcher.dispatchAction(new SetTrackAction(doc, id, track));
        refresh();
    }, [dispatcher, es, refresh]);

    /** Remove whatever keyframe sits on the playhead — the other half of authoring a track. */
    const removeKeyframe = useCallback(() => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds[0];
        const node = id ? doc.nodes.get(id) : undefined;
        if (!node?.track) return;
        const frame = Math.round(es.frame ?? 0);
        dispatcher.dispatchAction(new SetTrackAction(doc, id, node.track.filter(k => k.frame !== frame)));
        refresh();
    }, [dispatcher, es, refresh]);

    /** Re-point a selected `core.boolean` at a different operation — the live form's payoff. */
    const setBooleanOp = useCallback((op: BooleanOp) => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds[0];
        if (!id) return;
        dispatcher.dispatchAction(new SetBooleanOpAction(doc, id, op));
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
    /**
     * Perform a resolved shortcut. Returns true when it was consumed, so an unbound or
     * inapplicable press still reaches the active tool (Escape cancelling a drag, say).
     * Every branch goes through an existing Action, so shortcuts inherit undo for free.
     */
    const runShortcut = useCallback((s: Shortcut): boolean => {
        const doc = dispatcher.getDocument();
        const sel = es.selectedNodeIds;
        switch (s.kind) {
            case "undo": dispatcher.undo(); refresh(); return true;
            case "redo": dispatcher.redo(); refresh(); return true;
            case "select-all": {
                es.selectedNodeIds = [...doc.rootNodeUuids];
                refresh();
                return true;
            }
            case "deselect": {
                if (sel.length === 0) return false;   // let the tool cancel its gesture
                es.selectedNodeIds = [];
                refresh();
                return true;
            }
            case "nudge": {
                if (sel.length === 0) return false;
                // Routed per node, so nudging an instance COPY writes an override; and one
                // transaction, so holding an arrow key does not fill the history with steps.
                const eff = resolveScene(doc);
                const moves = selectionRoots(eff, sel).flatMap(id => {
                    const g = eff.nodes.get(id)?.geometry;
                    if (!g) return [];
                    const a = geometryActionFor(doc, id, { x: g.x + s.dx, y: g.y + s.dy });
                    return a ? [a] : [];
                });
                if (moves.length === 0) return false;
                dispatcher.dispatchAction(new TransactionAction(doc, "nudge", moves), { coalesce: true });
                refresh();
                return true;
            }
            case "delete": {
                const stored = sel.filter(id => !isVirtualId(id) && doc.nodes.has(id));
                if (stored.length === 0) return false;
                const actions = stored.map(id => new DeleteNodeAction(doc, id));
                dispatcher.dispatchAction(new TransactionAction(doc, "delete", actions));
                es.selectedNodeIds = [];
                refresh();
                return true;
            }
            case "duplicate": {
                const action = new DuplicateNodesAction(doc, sel);
                if (!action.validate()) return false;
                if (dispatcher.dispatchAction(action).success) {
                    es.selectedNodeIds = action.getCreatedRootIds();   // the copy is now the selection
                }
                refresh();
                return true;
            }
            case "group": {
                const action = new FrameSelectionAction(doc, sel);
                if (!action.validate()) return false;
                if (dispatcher.dispatchAction(action).success) {
                    const frame = action.getFrameId();
                    if (frame) es.selectedNodeIds = [frame];
                }
                refresh();
                return true;
            }
        }
    }, [dispatcher, es, refresh]);
    const setTool = useCallback((name: string) => {
        // Switching away mid-stroke abandons it: a preview that outlived its tool would hang
        // on screen with nothing able to finish or cancel it.
        const leaving = toolsRef.current.pen as PenTool | undefined;
        if (name !== "pen" && leaving) leaving.cancel();
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
        const handleKeyDown = (e: KeyboardEvent) => {
            // A shortcut must never fire while someone is typing in the inspector — Delete
            // would destroy the selection mid-word and every arrow would move the shape
            // instead of the caret.
            if (!isTypingTarget(e.target as HTMLElement)) {
                const shortcut = resolveShortcut(e);
                if (shortcut && runShortcut(shortcut)) {
                    e.preventDefault();
                    return;   // handled — don't also hand it to the active tool
                }
            }
            toolController.onKeyDown(e);
        };
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
            // PLAY MODE (M7): the scene is the prototype's current state, or a frame part-way
            // between two of them. Both are ordinary DOCUMENTS produced by a pure function, so
            // everything below — geometry, picking, both backends — is unchanged; an animation
            // frame is just another frame, exactly as a drag preview is.
            // THE PLAYHEAD is ephemeral, and stamped onto a shallow copy rather than written
            // into the document. Scrubbing is not an edit: pushing an undo step per frame would
            // bury a day's work under a second of dragging, and the same reasoning keeps a
            // marquee and a drag preview out of the document too. `doc.frame` is still a real
            // field — it records where the playhead was when the file was SAVED — but the app
            // does not write to it while you scrub.
            const base = dispatcher.getDocument();
            const timed: ReadonlyDocument = es.frame !== undefined
                ? ({ ...(base as ProjectDocument), frame: es.frame } as ReadonlyDocument) : base;
            // PARALLAX (schema 40): a layered node is shifted HERE, before geometry is computed,
            // so that where it draws is where it can be clicked, marquee-selected and snapped to.
            // Costs nothing on a document that never mentions depth — the derivation returns the
            // same reference — which matters because this runs on every pan.
            const stored = applyParallax(timed as ProjectDocument, es.viewport) as ReadonlyDocument;
            const doc: ReadonlyDocument = !es.playing
                ? stored
                : es.transition
                    ? blendStates(stored, es.transition.from, es.transition.to,
                        easingAt(es.transition.easing, (Date.now() - es.transition.startedAt) / es.transition.duration),
                        applyActiveState)
                    : applyActiveState({ ...(stored as ProjectDocument), activeState: es.playState ?? undefined } as ProjectDocument);
            // NAVIGATION (schema 36): the viewport glides to the frame an interaction pointed at.
            // Written onto the LIVE viewport rather than kept beside it, because everything —
            // rendering, picking, the rulers — already reads that one object; a second source of
            // truth for "where we are looking" is how those drift apart.
            if (es.playing && es.viewportTransition) {
                const vt = es.viewportTransition;
                const k = easingAt(vt.easing, (Date.now() - vt.startedAt) / vt.duration);
                Object.assign(es.viewport, lerpViewport(vt.from, vt.to, k));
                if (Date.now() - vt.startedAt >= vt.duration) es.viewportTransition = null;
            }
            const pendingKeys = new Set(es.pendingGeometry ? [...es.pendingGeometry.keys()] : []);

            // The dirty set the engine consumes must be a SUPERSET of everything whose
            // geometry changed since `prevComputed`: document edits (accumulated by
            // onChange), nodes with a preview now, and nodes that had one last frame
            // (a released/cancelled drag). The engine propagates to descendants itself.
            //
            // WHILE PLAYING the incremental path is skipped entirely. A prototype frame is a
            // DIFFERENT DOCUMENT — a state, or a blend part-way to one — and the dirty set only
            // ever names nodes an ACTION touched, so nothing marks the ones a transition is
            // animating. Reusing the previous entries drew the animation with stale geometry:
            // the state applied, the clock ran, and the shape did not move. An under-broad dirty
            // set is the one failure this engine's `incremental === full` invariant exists to
            // forbid, and a derived document has no dirty set that could be broad enough.
            //
            // A TIMELINE FRAME CHANGE is the same hazard for the same reason, and the guard above
            // named only `es.playing` — which is PROTOTYPE play, a different thing. Scrubbing the
            // playhead dispatches no action, so the dirty set is empty, so the engine reused the
            // previous frame's geometry and the shape did not move AT ALL while the playhead ran
            // the length of the track. The fix was written once, for the case it was found in.
            const frameChanged = es.frame !== prevFrameRef.current;
            const computed = !es.playing && !frameChanged && prevComputedRef.current
                ? computeGeometry(doc, es.pendingGeometry, prevComputedRef.current,
                    new Set([...dirtyNodesRef.current, ...pendingKeys, ...prevPendingRef.current]))
                : computeGeometry(doc, es.pendingGeometry);
            prevFrameRef.current = es.frame;

            // …and the reuse chain is BROKEN across play, so the first frame back in the editor
            // does not diff against a state's geometry.
            prevComputedRef.current = es.playing ? null : computed;
            prevPendingRef.current = pendingKeys;
            dirtyNodesRef.current = new Set();

            // ONION SKINS: neighbouring frames, derived here because the renderer reads every
            // position from a ComputedState and composes none itself. Nearer frames are drawn
            // less faintly, so which way time runs is readable at a glance.
            const ghosts = es.onion && es.frame !== undefined && base.timeline
                ? onionFrames(es.frame, es.onion, es.onion, base.timeline.frames).map((f: number) => {
                    const ghostDoc = { ...(base as ProjectDocument), frame: f } as ReadonlyDocument;
                    const distance = Math.abs(f - (es.frame as number));
                    return { doc: ghostDoc, computed: computeGeometry(ghostDoc), opacity: 0.28 / distance };
                })
                : undefined;

            const rendererState: RendererState = {
                ghosts,
                selectedNodeIds: es.selectedNodeIds,
                hoveredNodeId: es.hoveredNodeId,
                previewRect: es.previewRect,
                marqueeRect: es.marqueeRect,
                snapGuides: es.snapGuides,
                pendingPath: es.pendingPath,
                computed,
                viewport: es.viewport
            };
            renderScene(canvasRef.current, doc, rendererState, backend, refresh);

            // The animation clock. A transition is redrawn until its duration is up, then cleared
            // — so the running state is derived from a TIMESTAMP rather than accumulated per
            // frame, and a dropped frame lands in the right place instead of drifting.
            if (es.playing && (es.transition || es.viewportTransition)) {
                if (es.transition && Date.now() - es.transition.startedAt >= es.transition.duration) es.transition = null;
                requestAnimationFrame(() => refresh());
            }
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
            /**
             * EVERY MENU ENTRY ARRIVES HERE, as a command string.
             *
             * The edit commands go through `runShortcut`, the SAME function the keyboard uses, so
             * the menu and the keys cannot drift apart — and every one of them inherits undo,
             * because `runShortcut` only ever goes through Actions.
             *
             * An unknown command is IGNORED rather than thrown on: the menu lives in the main
             * process and the renderer is a separate build, so a newer menu meeting an older
             * renderer is a real state, and it should degrade to a dead click, not a crash.
             */
            api.onMenuCommand((command: string) => {
                switch (command) {
                    case "file.new":
                        dispatcher.loadDocument(createEmptyDocument());
                        currentFilePathRef.current = null;
                        es.selectedNodeIds = [];
                        refresh();
                        return;
                    case "file.save": {
                        const path = currentFilePathRef.current;
                        if (path) saveTo(path);
                        // No file yet: prompt for one rather than silently saving somewhere the
                        // user did not choose.
                        else api.requestSaveAs().catch(err => console.error("Save As failed:", err));
                        return;
                    }
                    case "file.export": setShowFolders(true); return;

                    case "edit.undo": runShortcut({ kind: "undo" }); return;
                    case "edit.redo": runShortcut({ kind: "redo" }); return;
                    case "edit.duplicate": runShortcut({ kind: "duplicate" }); return;
                    case "edit.delete": runShortcut({ kind: "delete" }); return;
                    case "edit.selectAll": runShortcut({ kind: "select-all" }); return;
                    case "edit.deselect": runShortcut({ kind: "deselect" }); return;
                    case "edit.group": runShortcut({ kind: "group" }); return;

                    // ZOOM ABOUT THE CANVAS CENTRE, not the viewport origin. Scaling around the
                    // origin slides whatever you were looking at off the edge, which is why every
                    // editor zooms about the middle when the command came from a menu rather than
                    // from a wheel over a point.
                    case "view.zoomIn":
                    case "view.zoomOut":
                    case "view.zoomReset": {
                        const host = document.querySelector("canvas, svg");
                        const rect = host?.getBoundingClientRect();
                        const cx = (rect?.width ?? 0) / 2, cy = (rect?.height ?? 0) / 2;
                        if (command === "view.zoomReset") zoomAt(es.viewport, 1 / Math.max(0.01, es.viewport.zoom), cx, cy);
                        else zoomAt(es.viewport, command === "view.zoomIn" ? 1.25 : 0.8, cx, cy);
                        refresh();
                        return;
                    }
                    case "view.timeline": {
                        const d = dispatcher.getDocument();
                        dispatcher.dispatchAction(new SetTimelineAction(d, d.timeline ? undefined : { frames: 24, fps: 12 }));
                        es.frame = d.timeline ? undefined : 0;
                        refresh();
                        return;
                    }
                    case "view.theme": {
                        const d = dispatcher.getDocument();
                        dispatcher.dispatchAction(new SetActiveThemeAction(d, d.activeTheme === "light" ? "dark" : "light"));
                        refresh();
                        return;
                    }
                    case "view.backend.svg": setBackend("svg"); return;
                    case "view.backend.canvas": setBackend("canvas"); return;
                    case "view.backend.webgl": setBackend("webgl"); return;

                    case "dev.script": setShowScript(v => !v); return;
                    case "dev.tokens": setShowTokens(v => !v); return;
                    case "dev.folders": setShowFolders(v => !v); return;
                    default: return;
                }
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
            })
        ];
        return () => disposers.forEach(dispose => dispose());
    }, []);

    // Resolved against the EXPANDED document so the inspector can show — and edit — a component
    // instance's COPY (a virtual node, alt-clicked). Its edits route through `nodeEdit`, which
    // turns them into per-instance overrides; a raw action would target a node that isn't in the
    // stored document and fail validation, looking like an input that does nothing.
    const node = selectedNodeId ? resolveScene(dispatcher.getDocument()).nodes.get(selectedNodeId) : undefined;
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
    /**
     * Interaction edits (M7). A whole-array replace through `SetInteractionsAction`, since a
     * node's interactions are edited as a LIST. Not routed through `nodeEdit` like style and
     * geometry: an instance override cannot carry interactions, so a copy's prototype behaviour
     * comes from its master — which is what makes a component's button behave the same everywhere.
     */
    const writeInteractions = (next: Interaction[]) => {
        if (!selectedNodeId) return;
        const d = dispatcher.getDocument();
        dispatcher.dispatchAction(new SetInteractionsAction(d, selectedNodeId, next));
    };
    const currentInteractions = (): Interaction[] =>
        [...(selectedNodeId ? dispatcher.getDocument().nodes.get(selectedNodeId)?.interactions ?? [] : [])];
    const addInteraction = () => writeInteractions([...currentInteractions(), { trigger: "click", state: null }]);
    const removeInteraction = (i: number) => writeInteractions(currentInteractions().filter((_, k) => k !== i));
    const setInteraction = (i: number, patch: Partial<Interaction>) =>
        writeInteractions(currentInteractions().map((it, k) => (k === i ? { ...it, ...patch } : it)));

    const editContent = (patch: ContentPatch) => {
        if (!selectedNodeId) return;
        const action = contentActionFor(dispatcher.getDocument(), selectedNodeId, patch);
        if (action) dispatcher.dispatchAction(action, { coalesce: true });
    };

    /**
     * Apply an imported track, and give the document a clock long enough to play it.
     *
     * ONE TRANSACTION, because a track without a timeline is a document that says a node animates
     * over frames it does not have — a half-applied import that an undo would have to unpick in two
     * steps. The timeline is only widened, never shrunk: importing a short animation into a document
     * that already holds a longer one must not truncate the longer one.
     */
    const importTrack = useCallback((track: Keyframe[]) => {
        if (!selectedNodeId || track.length === 0) return;
        const doc = dispatcher.getDocument();
        const needed = track[track.length - 1].frame + 1;
        const current = doc.timeline;
        const timeline = { frames: Math.max(needed, current?.frames ?? 0), fps: current?.fps ?? 24 };
        const actions: Action[] = [new SetTrackAction(doc, selectedNodeId, track)];
        if (!current || current.frames < needed) actions.push(new SetTimelineAction(doc, timeline));
        dispatcher.dispatchAction(actions.length === 1
            ? actions[0]
            : new TransactionAction(doc, "Import sheet as animation", actions));
        refresh();
    }, [selectedNodeId, dispatcher, refresh]);

    /**
     * Place imported SVG shapes as `core.path` nodes.
     *
     * ONE TRANSACTION for the whole drawing. An SVG is a single picture, so a single undo should
     * remove it — and a node whose commands arrived in a later action would be an empty path if the
     * import were interrupted between the two, which is the trap the pen tool already avoids.
     */
    const importSvg = useCallback((specs: SvgNodeSpec[]) => {
        if (specs.length === 0) return;
        const doc = dispatcher.getDocument();
        const actions: Action[] = [];
        const ids: string[] = [];
        for (const spec of specs) {
            // The id is minted HERE so both halves can name it — the same reason the pen tool does.
            const id = generateUUID();
            ids.push(id);
            actions.push(new AddNodeAction(doc, "core.path", spec.geometry.x, spec.geometry.y,
                spec.geometry.width, spec.geometry.height, spec.style.fill, id));
            actions.push(new UpdateNodePathAction(doc, id, spec.path));
        }
        dispatcher.dispatchAction(new TransactionAction(doc, "import-svg", actions));
        es.selectedNodeIds = ids.slice(0, 1);
        refresh();
    }, [dispatcher, es, refresh]);

    /**
     * Tiles as image nodes, one per non-empty cell.
     *
     * Every tile is the SAME sheet with a different `sourceRect` — the region field schema 51
     * added — so a whole map costs one decoded image no matter how many cells reference it. The
     * flips arrive as a rotation and a scale, applied only to the cells that carry one.
     */
    const importTiles = useCallback((tiles: {
        x: number; y: number; width: number; height: number; src: string;
        sourceRect: SourceRect | null; name: string;
        transform: { rotation: number; scaleX: number; scaleY: number } | null;
    }[]) => {
        if (tiles.length === 0) return;
        const doc = dispatcher.getDocument();
        const actions: Action[] = [];
        const ids: string[] = [];
        for (const t of tiles) {
            // Minted HERE so both halves can name it, the same reason the pen tool and the SVG
            // importer do — the node does not exist yet to be looked up.
            const id = generateUUID();
            ids.push(id);
            actions.push(new AddNodeAction(doc, "core.image", t.x, t.y, t.width, t.height, "none", id,
                null, { src: t.src }));
            // The REGION and the pixel-art hint are content PATCHES rather than creation fields, so
            // they go through the same door the region inputs use. `pixelated` is what stops a 16px
            // tile being smoothed into its neighbours when the map is zoomed.
            actions.push(new UpdateNodeContentAction(doc, id,
                { sourceRect: t.sourceRect, pixelated: true, name: t.name }));
            if (t.transform) actions.push(new UpdateNodeTransformAction(doc, id, t.transform));
        }
        dispatcher.dispatchAction(new TransactionAction(doc, "import-tiles", actions));
        es.selectedNodeIds = ids.slice(0, 1);
        refresh();
    }, [dispatcher, es, refresh]);

    /** Transform edits — routed, so a copy gets a transform override (schema 26). */
    const editTransform = (patch: { rotation?: number; scaleX?: number; scaleY?: number }) => {
        if (!selectedNodeId) return;
        const action = transformActionFor(dispatcher.getDocument(), selectedNodeId, patch);
        if (action) dispatcher.dispatchAction(action, { coalesce: true });
    };

    /** A shadow is a WHOLE value in the schema, so a single field edit merges over the current
     *  one — otherwise typing in dx would drop the colour and softness. */
    const editShadow = (patch: Partial<Shadow>) => {
        const current = node?.style.shadow;
        if (!current) return;
        editSelected({ style: { shadow: { ...current, ...patch } } });
    };

    /**
     * Layout edits — routed, so a copy gets a layout override (schema 26): one instance of a
     * card can stack its children in a column while every other instance keeps the master's row.
     */
    const editLayout = (patch: Partial<Node["layout"]>) => {
        if (!selectedNodeId) return;
        const action = layoutActionFor(dispatcher.getDocument(), selectedNodeId, patch);
        if (action) dispatcher.dispatchAction(action, { coalesce: true });
    };

    /** A container is a WHOLE value (`direction` is required), so one field edit merges over
     *  the current container rather than replacing it with a partial one. */
    const editContainer = (patch: Partial<NonNullable<Node["layout"]["container"]>>) => {
        const current = node?.layout.container;
        if (!current) return;
        editLayout({ container: { ...current, ...patch } });
    };

    /** A grid is a WHOLE value too (`columns` and `rowHeight` are required), so one field edit
     *  merges over the current grid rather than replacing it with a partial one. */
    const editGrid = (patch: Partial<NonNullable<Node["layout"]["grid"]>>) => {
        const current = node?.layout.grid;
        if (!current) return;
        editLayout({ grid: { ...current, ...patch } });
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
        const parent = resolveScene(dispatcher.getDocument()).nodes.get(node.parent);
        return !!parent && (parent.layout.container !== undefined || parent.layout.grid !== undefined);
    })();

    /** …and specifically a GRID parent, which offers spans where a flex parent offers grow. */
    const parentIsGrid = (() => {
        if (!node?.parent) return false;
        const parent = resolveScene(dispatcher.getDocument()).nodes.get(node.parent);
        return !!parent && parent.layout.grid !== undefined;
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
            {/* Tools and document commands. Its height is its own again: the tool options moved
                    to their own row below, so nothing this row does can push the canvas around. */}
                <div style={{ display: "flex", alignItems: "center", alignContent: "flex-start", flexWrap: "wrap", rowGap: 4, padding: "4px 8px", background: UI.panel, borderBottom: `1px solid ${UI.line}`, gap: 4 }}>
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
                <ToolButton icon="✒" label="Pen" active={toolName === "pen"} onClick={() => setTool("pen")} />
                <ToolButton icon="✏" label="Paint" active={toolName === "paint"} onClick={() => setTool("paint")} />
                {es.selectedNodeIds.length === 1
                    && dispatcher.getDocument().nodes.get(es.selectedNodeIds[0])?.type === "core.boolean" && (
                    // A LIVE boolean is selected: offer the operation itself. This is the whole
                    // reason the node form exists — the combine stays a decision, not a bake.
                    <>
                        <Divider />
                        {BOOLEAN_BUTTONS.map(([op, glyph, label]) => (
                            <button
                                key={op}
                                title={label}
                                onClick={() => setBooleanOp(op)}
                                style={{
                                    ...ALIGN_BUTTON_STYLE,
                                    borderColor: (dispatcher.getDocument().nodes.get(es.selectedNodeIds[0])?.booleanOp ?? "union") === op ? "#00bfff" : "#2a2a4a"
                                }}
                            >{glyph}</button>
                        ))}
                    </>
                )}
                {es.selectedNodeIds.length >= 2 && (
                    // Align + distribute, shown only for a MULTI-selection — the operations are
                    // meaningless for one node, and a row of dead buttons is worse than none.
                    <>
                        <Divider />
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
                        <Divider />
                        {/* Booleans — same multi-selection gate as align: one shape has nothing
                            to combine with. A plain click builds a LIVE boolean node whose
                            operands stay editable; Alt bakes the result into a flat path. */}
                        {BOOLEAN_BUTTONS.map(([op, glyph, label]) => (
                            <button
                                key={op}
                                title={`${label} — hold Alt to flatten into a plain path`}
                                onClick={e => runBoolean(op, !e.altKey)}
                                style={ALIGN_BUTTON_STYLE}
                            >{glyph}</button>
                        ))}
                    </>
                )}
                <Divider />
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
                <Divider />
                {/* PLAY (M7): run the prototype. Leaving play mode drops the run's state and its
                    transition, so the document is exactly as it was — playing is not editing. */}
                <button
                    title={es.playing ? "Stop — back to editing" : "Play the prototype: clicks and hovers fire interactions"}
                    onClick={() => {
                        es.playing = !es.playing;
                        es.playState = null;
                        es.transition = null;
                        es.viewportTransition = null;
                        // Starting REMEMBERS where the canvas was looking; stopping puts it back.
                        // A prototype run navigates, and being dumped three screens away from
                        // where you pressed Play is the editor losing your place.
                        if (es.playing) {
                            es.playReturnViewport = { ...es.viewport };
                        } else if (es.playReturnViewport) {
                            Object.assign(es.viewport, es.playReturnViewport);
                            es.playReturnViewport = null;
                        }
                        if (es.playing) es.selectedNodeIds = [];   // nothing is selected in a prototype
                        refresh();
                    }}
                    style={{
                        fontSize: 11, padding: "3px 10px", borderRadius: 3, cursor: "pointer",
                        background: es.playing ? "#00bfff" : "transparent",
                        color: es.playing ? "#0b0b18" : "#ccc",
                        border: `1px solid ${es.playing ? "#00bfff" : "#2a2a4a"}`
                    }}
                >{es.playing ? "■ Stop" : "▶ Play"}</button>
                <Divider />
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
                {/* Which STATE the whole document shows (M7) — the same document-level
                    selection shape as the theme, and placed beside it for that reason.
                    Only appears once something defines a state; otherwise it would be a
                    control with exactly one option. */}
                {(() => {
                    const d = dispatcher.getDocument();
                    const names = new Set<string>();
                    d.nodes.forEach(n => { for (const k of Object.keys(n.states ?? {})) names.add(k); });
                    if (names.size === 0) return null;
                    return (
                        <select
                            title="Show every node in this named state"
                            value={d.activeState ?? ""}
                            onChange={e => {
                                dispatcher.dispatchAction(new SetActiveStateAction(dispatcher.getDocument(), e.target.value || null));
                                refresh();
                            }}
                            style={{ fontSize: 11, padding: "3px 8px", marginRight: 8, background: d.activeState ? UI.accentSoft : "transparent", color: "#ccc", border: `1px solid ${UI.line}`, borderRadius: 3, cursor: "pointer" }}
                        >
                            <option value="">State: base</option>
                            {[...names].sort().map(n => <option key={n} value={n}>State: {n}</option>)}
                        </select>
                    );
                })()}
                                <button
                    title="Design tokens — named colours and numbers, with per-theme values"
                    onClick={() => setShowTokens(v => !v)}
                    style={{ fontSize: 11, padding: "3px 8px", marginRight: 8, background: showTokens ? UI.accentSoft : "transparent", color: "#ccc", border: `1px solid ${UI.line}`, borderRadius: 3, cursor: "pointer" }}
                >
                    ◈ Tokens
                </button>
                <button
                    title="Scripts — run a small program against the document; it can only emit the same Actions you can"
                    onClick={() => setShowScript(v => !v)}
                    style={{ fontSize: 11, padding: "3px 8px", marginRight: 8, background: showScript ? UI.accentSoft : "transparent", color: "#ccc", border: `1px solid ${UI.line}`, borderRadius: 3, cursor: "pointer" }}
                >
                    &gt;_ Script
                </button>
                <button
                    title="Folders — scan a codebase for capabilities with no UI, or browse an image folder"
                    onClick={() => setShowFolders(v => !v)}
                    style={{ fontSize: 11, padding: "3px 8px", marginRight: 8, background: showFolders ? UI.accentSoft : "transparent", color: "#ccc", border: `1px solid ${UI.line}`, borderRadius: 3, cursor: "pointer" }}
                >
                    🗀 Folders
                </button>
<button
                    title="Switch the rendering backend — all three draw the same display list. WebGL is a PREVIEW: it fills and strokes shapes as triangles on the GPU, and does not yet draw text, images or effects."
                    onClick={() => setBackend(b => (b === "svg" ? "canvas" : b === "canvas" ? "webgl" : "svg"))}
                    style={{ fontSize: 11, padding: "3px 8px", marginRight: 8, background: "transparent", color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                >
                    Backend: {backend === "svg" ? "SVG" : backend === "canvas" ? "Canvas" : "WebGL (preview)"}
                </button>
                {/* A document has no clock until somebody asks for one, so a still drawing carries
                    no timeline strip and serialises exactly as it did before animation existed. */}
                <button
                    title="Give this document a timeline (24 frames at 12fps), or take it away again"
                    onClick={() => {
                        const d = dispatcher.getDocument();
                        dispatcher.dispatchAction(new SetTimelineAction(d, d.timeline ? undefined : { frames: 24, fps: 12 }));
                        es.frame = d.timeline ? undefined : 0;
                        refresh();
                    }}
                    style={{ fontSize: 11, padding: "3px 8px", marginLeft: 4, background: "transparent",
                             color: dispatcher.getDocument().timeline ? UI.accent : "#ccc",
                             border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                >⏱ Timeline</button>
                <select
                    value=""
                    title="Load a classic animation exercise. These are the things animators learn on — each stresses a different capability, and building them is how the engine's holes get found."
                    onChange={e => {
                        const hit = DEMOS.find(d => d.name === e.target.value);
                        if (!hit) return;
                        // LOADED like any other document, through the same path a file takes, so a
                        // demo cannot pass by being special-cased. If one of these will not load,
                        // neither will somebody's work.
                        dispatcher.loadDocument(hit.build());
                        es.selectedNodeIds = [];
                        es.frame = 0;
                        refresh();
                    }}
                    style={{ fontSize: 11, padding: "3px 6px", marginLeft: 4, background: "transparent",
                             color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                >
                    <option value="">Exercises…</option>
                    {DEMOS.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
                </select>
                {/* A document is unlit until somebody asks, and an unlit one draws byte-for-byte
                    as it did before lighting existed — ambient 1, no lights, colours times one. */}
                <button
                    title="Light the scene from the top-left, or turn the lights off again. Raise a mesh control point's HEIGHT to give a shape something to shade."
                    onClick={() => {
                        const d = dispatcher.getDocument();
                        const on = d.lights !== undefined;
                        dispatcher.dispatchAction(new SetLightingAction(d,
                            on ? undefined : [{ x: 0.6, y: 0.6, z: -0.5, color: "#ffffff", intensity: 1 }],
                            on ? undefined : 0.35));
                        refresh();
                    }}
                    style={{ fontSize: 11, padding: "3px 8px", marginLeft: 4, background: "transparent",
                             color: dispatcher.getDocument().lights ? UI.accent : "#ccc",
                             border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                >☀ Light</button>
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
                {/* THE TOOL OPTIONS BAR — its own row, its own fixed height.
                    Every control here belongs to the ACTIVE TOOL, and they used to sit in the row
                    above, sharing it with twelve tools and the document commands. Adding six brush
                    options wrapped that row and pushed the canvas and both panels down 27px, which
                    is how a click computed a moment earlier lands on the wrong pixel.
                    The previous fix reserved 86px on the row above — measured, and honest that a
                    narrow window would take a third row and bring the jump back. This removes the
                    guess: a fixed 30px that never wraps (`nowrap` + `overflow-x`) is stable at
                    EVERY window width, and it is the shape Photoshop's options bar has always had.
                    It is always rendered, empty or not, because a row that appears and disappears
                    moves things exactly as wrapping did. */}
                <div style={{
                    display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap",
                    overflowX: "auto", height: 30, boxSizing: "border-box", padding: "0 8px",
                    background: UI.panel, borderBottom: `1px solid ${UI.line}`
                }}>
                {toolName === "paint" && (
                    <>
                        {/* WHY THE TOOL CANNOT ACT, said where the tool's own controls are.
                            The brush paints the SELECTION, so with nothing selected — or a
                            rectangle selected — it silently does nothing, and a tool you can pick
                            but that never marks the canvas reads as broken software. This was a
                            10px grey aside lost among twenty-seven other controls; on its own row
                            it can be read, and it says what to DO rather than what is wrong.
                            The other controls hide while it shows: offering a colour and a brush
                            size for a stroke that cannot land is an invitation to a dead click. */}
                        {!selectedRasterId && (
                            <span style={{
                                fontSize: 11, color: UI.accent, display: "flex", alignItems: "center",
                                gap: 6, whiteSpace: "nowrap"
                            }}>
                                <span aria-hidden="true">▦</span>
                                Select a canvas to paint on — or draw one with the Raster tool
                            </span>
                        )}
                        {selectedRasterId && (<>
                        <input
                            type="color"
                            aria-label="Paint colour"
                            data-testid="paint-colour"
                            value={paintColour}
                            disabled={erasing}
                            onChange={e => setPaintColour(e.target.value)}
                            style={{ width: 28, height: 22, padding: 0, background: "none",
                                border: `1px solid ${UI.line}`, opacity: erasing ? 0.4 : 1 }}
                        />
                        <ToolButton icon="⌫" label="Erase" active={erasing}
                            onClick={() => setErasing(v => !v)} />
                        <label style={{ fontSize: 10, color: UI.textFaint, display: "flex", alignItems: "center", gap: 3 }}>
                            size
                            <input
                                type="number" min={1} max={BRUSH_MAX_SIZE} step={1}
                                aria-label="Brush size"
                                data-testid="brush-size"
                                value={brushSize}
                                onChange={e => setBrushSize(Math.max(1, Math.min(BRUSH_MAX_SIZE,
                                    Math.round(Number(e.target.value) || 1))))}
                                style={{ width: 44, background: UI.bg, color: UI.text,
                                    border: `1px solid ${UI.line}` }}
                            />
                        </label>
                        <ToolButton icon="●" label="Round" active={brushRound}
                            onClick={() => setBrushRound(v => !v)} />
                        {/* Mirrored drawing: one stroke paints two, four, or one. */}
                        <ToolButton icon="⇋" label="Mirror H" active={symmetry.horizontal}
                            onClick={() => setSymmetry(m => ({ ...m, horizontal: !m.horizontal }))} />
                        <ToolButton icon="⇵" label="Mirror V" active={symmetry.vertical}
                            onClick={() => setSymmetry(m => ({ ...m, vertical: !m.vertical }))} />
                        </>
                        )}
                    </>
                )}
                {toolName === "pen" && (
                    <span style={{ fontSize: 10, color: UI.textFaint, marginRight: 8 }}>
                        click to add · drag to curve · click the first point to close · Enter to finish
                    </span>
                )}
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
                </div>

            <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
                <div style={{ width: 180, background: UI.panel, borderRight: `1px solid ${UI.line}`, overflow: "auto", padding: 8 }}>
                    <div style={PANEL_HEADING}>Layers</div>
                    <input
                        type="text"
                        value={layerQuery}
                        placeholder="Search layers…"
                        onChange={e => setLayerQuery(e.target.value)}
                        onKeyDown={e => { if (e.key === "Escape") setLayerQuery(""); }}
                        style={{ width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px", marginBottom: 6,
                            background: UI.bg, color: UI.text, border: `1px solid ${layerQuery ? UI.accent : UI.line}`, borderRadius: 2 }}
                    />
                    {(() => {
                        // Walk the REAL tree: roots, then each node's children, depth-first. The
                        // panel was a flat list from `traverseSceneGraph`, which had no way to show
                        // the hierarchy that frames, groups and instances now create.
                        const doc = dispatcher.getDocument();
                        const rows: React.ReactNode[] = [];
                        const labelOf = (id: string) => {
                            const n = doc.nodes.get(id);
                            return n ? (n.name || nodeTypeLabels[n.type] || n.type) : id;
                        };
                        // The SAME label the row displays, so the filter cannot disagree with
                        // what the user is reading.
                        const filter = filterLayers(doc, layerQuery, labelOf);
                        // The order rows are actually RENDERED in — what a shift-click range
                        // means. Rows the user cannot see are not between anything.
                        const visibleOrder: string[] = [];
                        // Both flags INHERIT, so the walk carries them down rather than each row
                        // re-deriving them by climbing — the panel then agrees with the engine,
                        // which computes lock the same way during its own parents-first walk.
                        const walk = (ids: readonly string[], depth: number, hiddenAbove = false, lockedAbove = false) => {
                            for (const id of ids) {
                                const n = doc.nodes.get(id);
                                if (!n) continue;
                                if (!filter.inactive && !filter.visible.has(id)) continue;
                                const hasChildren = n.children.length > 0;
                                // While filtering, a hit inside a collapsed group must be
                                // reachable — otherwise search only finds what was already open.
                                const isCollapsed = filter.inactive ? collapsedLayers.has(id) : false;
                                visibleOrder.push(id);
                                rows.push(
                                    <LayerRow
                                        key={id}
                                        node={n}
                                        depth={depth}
                                        selected={es.selectedNodeIds.includes(id)}
                                        collapsed={isCollapsed}
                                        hasChildren={hasChildren}
                                        isAutoLayout={n.layout.container !== undefined || n.layout.grid !== undefined}
                                        inheritedHidden={hiddenAbove}
                                        inheritedLocked={lockedAbove}
                                        onFlag={flags => {
                                            dispatcher.dispatchAction(new SetNodeFlagsAction(dispatcher.getDocument(), id, flags));
                                            refresh();
                                        }}
                                        dropHint={layerDrag.over === id ? layerDrag.position : null}
                                        onDragStart={() => setLayerDrag({ id, over: null, position: null })}
                                        onDragOver={position => {
                                            // Only show a hint for a drop that would actually be
                                            // taken — `resolveLayerDrop` decides, so the indicator
                                            // and the outcome cannot disagree.
                                            const ok = layerDrag.id && layerDrag.id !== id
                                                && resolveLayerDrop(dispatcher.getDocument(), layerDrag.id, id, position) !== null;
                                            setLayerDrag(d => ({ ...d, over: ok ? id : null, position: ok ? position : null }));
                                        }}
                                        onDrop={() => {
                                            const drop = layerDrag.id && layerDrag.position
                                                ? resolveLayerDrop(dispatcher.getDocument(), layerDrag.id, id, layerDrag.position)
                                                : null;
                                            if (drop) {
                                                dispatcher.dispatchAction(new ReparentNodeAction(dispatcher.getDocument(), layerDrag.id, drop.parent, drop.index));
                                            }
                                            setLayerDrag({ id: "", over: null, position: null });
                                            refresh();
                                        }}
                                        onDragEnd={() => setLayerDrag({ id: "", over: null, position: null })}
                                        onOpacity={opacity => {
                                            // ROUTED, so a copy gets a style override instead of
                                            // a raw action at an id the document does not hold.
                                            const action = styleActionFor(dispatcher.getDocument(), id, { opacity });
                                            if (action) dispatcher.dispatchAction(action, { coalesce: true });
                                            refresh();
                                        }}
                                        onRename={name => {
                                            // The SAME routed content edit the inspector's Name
                                            // field uses, so a copy is refused here too.
                                            const action = contentActionFor(dispatcher.getDocument(), id, { name });
                                            if (action) dispatcher.dispatchAction(action);
                                            refresh();
                                        }}
                                        label={n.name || nodeTypeLabels[n.type] || n.type}
                                        onSelect={mods => {
                                            const next = selectionForRowClick(visibleOrder, es.selectedNodeIds, layerAnchorRef.current, id, mods);
                                            es.selectedNodeIds = next.selected;
                                            layerAnchorRef.current = next.anchor;
                                            refresh();
                                        }}
                                        onToggle={() => {
                                            const next = new Set(collapsedLayers);
                                            next.has(id) ? next.delete(id) : next.add(id);
                                            setCollapsedLayers(next);
                                        }}
                                    />
                                );
                                // A collapsed folder hides its subtree; the nodes stay selected and
                                // rendered, this is purely how much of the tree the panel shows.
                                if (hasChildren && !isCollapsed) walk(n.children, depth + 1, hiddenAbove || !!n.hidden, lockedAbove || !!n.locked);
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

                {showScript && (
                    <div style={{ width: 300, background: UI.panel, borderLeft: `1px solid ${UI.line}`, padding: 10, overflow: "auto" }}>
                        <div style={PANEL_HEADING}>Script</div>
                        <ScriptPanel dispatcher={dispatcher} refresh={refresh} />
                    </div>
                )}
                {showTokens && (
                    <div style={{ width: 230, background: UI.panel, borderLeft: `1px solid ${UI.line}`, padding: 10, overflow: "auto" }}>
                        <div style={PANEL_HEADING}>Tokens</div>
                        <TokensPanel dispatcher={dispatcher} refresh={refresh} />
                    </div>
                )}
                {showFolders && (
                    <div style={{ width: 240, background: UI.panel, borderLeft: `1px solid ${UI.line}`, padding: 10, overflow: "auto" }}>
                        <div style={PANEL_HEADING}>Folders</div>
                        <FoldersDrawer
                            onPlaceImage={placeAsset}
                            getDocument={() => dispatcher.getDocument()}
                            /* An import acts on the selected node only when it IS an image with a
                               source — there is nothing to slice into a shape that has no pixels. */
                            selectedImage={node && node.type === "core.image" && node.src
                                ? { id: node.id, src: node.src } : null}
                            onImportTrack={importTrack}
                            onImportSvg={importSvg}
                            editContentFont={family => { editSelected({ style: { fontFamily: family } }); refresh(); }}
                            onImportTiles={importTiles}
                            onSetRegion={rect => { editContent({ sourceRect: rect }); refresh(); }}
                        />
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

                            {/* Variants (schema 27): tag a master into a set, or switch an
                                instance between the masters of the set its own master joins. */}
                            <InspectorSection title="Variants">
                                <VariantSection node={node as Node} dispatcher={dispatcher} refresh={refresh} />
                            </InspectorSection>

                            {/* Slots (schema 29): a named hole in a master, and what an
                                instance puts in it. */}
                            <InspectorSection title="Slots">
                                <SlotSection node={node as Node} dispatcher={dispatcher} refresh={refresh} />
                            </InspectorSection>

                            {/* States (M7): what this node looks like in a named context. */}
                            <InspectorSection title="States">
                                <StatesSection node={node as Node} dispatcher={dispatcher} refresh={refresh} />
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
                                <TokenSelect
                                    store={dispatcher.getDocument().variables as VariableStore}
                                    value={node.style.fill}
                                    onPick={v => { editSelected({ style: { fill: v || "#4a90d9" } }); refresh(); }}
                                />
                                {/* Which points a closed outline encloses (schema 38). It only
                                    ever matters for a path that crosses itself or has more than
                                    one contour, which is why it sits with the fill. */}
                                <label style={INSPECTOR_LABEL}>Fill rule</label>
                                <select
                                    value={node.style.fillRule ?? "nonzero"}
                                    onChange={e => { editSelected({ style: { fillRule: e.target.value as typeof FILL_RULES[number] } }); refresh(); }}
                                    style={{ ...SELECT_STYLE, width: "100%" }}
                                    title="Which points a closed outline encloses. They differ only where a path crosses itself: a five-pointed star drawn in one stroke is solid under nonzero and hollow under even-odd."
                                >{FILL_RULES.map(r => <option key={r} value={r}>{r}</option>)}</select>
                                <label style={INSPECTOR_LABEL}>Stroke</label>
                                <ColorInput
                                    value={node.style.stroke ?? "#000000"}
                                    muted={!node.style.stroke}
                                    onChange={v => { editSelected({ style: { stroke: v } }); refresh(); }}
                                />
                                <TokenSelect
                                    store={dispatcher.getDocument().variables as VariableStore}
                                    value={node.style.stroke ?? ""}
                                    onPick={v => { editSelected({ style: { stroke: v || "#000000" } }); refresh(); }}
                                />
                                <div style={INSPECTOR_GRID}>
                                    <div><label style={INSPECTOR_LABEL}>Width</label>
                                        <NumInput
                                            value={typeof node.style.strokeWidth === "number" ? node.style.strokeWidth : 0}
                                            onChange={v => { editSelected({ style: { strokeWidth: clampStrokeWidth(v) } }); refresh(); }}
                                        /></div>
                                    <div><label style={INSPECTOR_LABEL}>Warp</label>
                                        <select
                                            value={(() => { const m = dispatcher.getDocument().nodes.get(node.id)?.mesh;
                                                return m ? `${m.cols}x${m.rows}` : "off"; })()}
                                            title="Lay a grid of control points over this shape. Dragging one bends the outline; the result is an ordinary path, so it can be clicked, cut and tessellated like any other."
                                            onChange={e => {
                                                const id = es.selectedNodeIds[0];
                                                if (!id) return;
                                                const v = e.target.value;
                                                const src = dispatcher.getDocument().nodes.get(id);
                                                const box = { width: src?.geometry.width ?? node.geometry.width, height: src?.geometry.height ?? node.geometry.height };
                                                const mesh = v === "off" ? undefined
                                                    : restMesh(parseInt(v, 10), parseInt(v.split("x")[1], 10));
                                                dispatcher.dispatchAction(new SetMeshAction(dispatcher.getDocument(), id, mesh));
                                                refresh();
                                            }}
                                            style={{ ...SELECT_STYLE, width: "100%" }}
                                        >
                                            <option value="off">off</option>
                                            <option value="1x1">1x1</option>
                                            <option value="2x2">2x2</option>
                                            <option value="3x3">3x3</option>
                                            <option value="4x4">4x4</option>
                                        </select></div>
                                    <div><label style={INSPECTOR_LABEL}>Height</label>
                                        <NumInput
                                            value={(() => { const m = dispatcher.getDocument().nodes.get(node.id)?.mesh;
                                                return m ? Math.max(...m.points.map(p => p.z ?? 0)) : 0; })()}
                                            onChange={v => {
                                                const id = es.selectedNodeIds[0];
                                                // The STORED mesh, not the resolved one: a raised or warped node
                                                // resolves to a path with its mesh dropped, so reading it back
                                                // from the scene would show every control as "off" the moment it
                                                // started working. The mesh DRAG already had to learn this.
                                                const stored = id ? dispatcher.getDocument().nodes.get(id) : undefined;
                                                if (!id || !stored?.mesh) return;
                                                // Raise the MIDDLE of the grid and leave the rim at zero, which is
                                                // the shape a bevel has — a grid raised uniformly is still flat, and
                                                // flat is exactly what a light cannot find.
                                                const { cols, rows } = stored.mesh;
                                                const points = stored.mesh.points.map((p, i) => {
                                                    const col = i % (cols + 1), row = Math.floor(i / (cols + 1));
                                                    const edge = col === 0 || row === 0 || col === cols || row === rows;
                                                    return { x: p.x, y: p.y, z: edge ? 0 : v };
                                                });
                                                dispatcher.dispatchAction(new SetMeshAction(dispatcher.getDocument(), id, { cols, rows, points }));
                                                refresh();
                                            }}
                                        /></div>
                                    <div><label style={INSPECTOR_LABEL}>Depth</label>
                                        <NumInput
                                            value={node.depth ?? 0}
                                            onChange={v => { const id = es.selectedNodeIds[0];
                                                if (id) dispatcher.dispatchAction(new SetDepthAction(dispatcher.getDocument(), id, Math.max(DEPTH_MIN, Math.min(DEPTH_MAX, v))));
                                                refresh(); }}
                                        /></div>
                                    <div><label style={INSPECTOR_LABEL}>Radius</label>
                                        <NumInput
                                            value={typeof node.style.radius === "number" ? node.style.radius : 0}
                                            onChange={v => { editSelected({ style: { radius: Math.max(0, v) } }); refresh(); }}
                                        /></div>
                                </div>
                                {/* Corners and ends (schema 37). SVG's own vocabulary, so what is
                                    picked here is literally what reaches the attribute. */}
                                <div style={INSPECTOR_GRID}>
                                    <div><label style={INSPECTOR_LABEL}>Join</label>
                                        <select
                                            value={node.style.strokeJoin ?? "miter"}
                                            onChange={e => { editSelected({ style: { strokeJoin: e.target.value as typeof STROKE_JOINS[number] } }); refresh(); }}
                                            style={{ ...SELECT_STYLE, width: "100%" }}
                                        >{STROKE_JOINS.map(j => <option key={j} value={j}>{j}</option>)}</select></div>
                                    <div><label style={INSPECTOR_LABEL}>Cap</label>
                                        <select
                                            value={node.style.strokeCap ?? "butt"}
                                            onChange={e => { editSelected({ style: { strokeCap: e.target.value as typeof STROKE_CAPS[number] } }); refresh(); }}
                                            style={{ ...SELECT_STYLE, width: "100%" }}
                                        >{STROKE_CAPS.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                                </div>
                                {/* ALIGNMENT is not a field on the node — it is how the border is
                                    BAKED, because neither SVG nor Canvas can draw one off-centre.
                                    Outlined it becomes a path, and every backend agrees on it. */}
                                <label style={INSPECTOR_LABEL}>Outline stroke</label>
                                <div style={{ display: "flex", gap: 4 }}>
                                    {STROKE_ALIGNS.map(a => (
                                        <button
                                            key={a}
                                            onClick={() => runOutlineStroke(a)}
                                            title={`Convert the border into a path, sitting ${a === "center" ? "astride" : a} the shape's edge. The border stops being a parameter and becomes geometry you can select, cut and reshape.`}
                                            style={{ ...ALIGN_BUTTON_STYLE, flex: 1, fontSize: 11 }}
                                        >{a}</button>
                                    ))}
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
                                    {/* A TEXTAREA, not an input: an `<input>` strips newlines, so
                                        multi-line text — which schema 34 made a real thing in both
                                        backends and the exporter — could not be typed at all. */}
                                    <textarea
                                        value={node.text ?? ""}
                                        placeholder="Text"
                                        spellCheck={false}
                                        onChange={e => { editContent({ text: e.target.value }); refresh(); }}
                                        style={{
                                            width: "100%", boxSizing: "border-box", height: 54, resize: "vertical",
                                            fontSize: 11, padding: "4px 6px", background: UI.bg, color: UI.text,
                                            border: `1px solid ${UI.line}`, borderRadius: 3
                                        }}
                                    />
                                    <label style={INSPECTOR_LABEL}>Font size</label>
                                    <NumInput
                                        value={typeof node.style.fontSize === "number" ? node.style.fontSize : 14}
                                        onChange={v => { editSelected({ style: { fontSize: Math.max(1, v) } }); refresh(); }}
                                    />
                                    {/* Typography (schema 34). Each control clamps to the same range the
                                        shared `styleError` enforces, so the inspector cannot author a
                                        style the loader would refuse. */}
                                    <label style={INSPECTOR_LABEL}>Font family</label>
                                    <TextInput
                                        value={node.style.fontFamily ?? ""}
                                        placeholder="sans-serif"
                                        onChange={v => {
                                            if (v.length > FONT_FAMILY_MAX) return;
                                            editSelected({ style: { fontFamily: v } });
                                            refresh();
                                        }}
                                    />
                                    <label style={INSPECTOR_LABEL}>Weight</label>
                                    <NumInput
                                        value={typeof node.style.fontWeight === "number" ? node.style.fontWeight : 400}
                                        onChange={v => { editSelected({ style: { fontWeight: Math.min(1000, Math.max(1, v)) } }); refresh(); }}
                                    />
                                    <label style={INSPECTOR_LABEL}>Align</label>
                                    <div style={{ display: "flex", gap: 4 }}>
                                        {TEXT_ALIGNS.map(a => (
                                            <button
                                                key={a}
                                                title={`Align ${a}`}
                                                onClick={() => { editSelected({ style: { textAlign: a } }); refresh(); }}
                                                style={{
                                                    ...ALIGN_BUTTON_STYLE, flex: 1,
                                                    borderColor: (node.style.textAlign ?? "left") === a ? "#00bfff" : "#2a2a4a"
                                                }}
                                            >{a === "left" ? "⇤" : a === "center" ? "⇹" : a === "right" ? "⇥" : "≡"}</button>
                                        ))}
                                    </div>
                                    <label style={INSPECTOR_LABEL}>Line height (× size)</label>
                                    <NumInput
                                        value={typeof node.style.lineHeight === "number" ? node.style.lineHeight : 1.2}
                                        onChange={v => { editSelected({ style: { lineHeight: Math.max(0.01, v) } }); refresh(); }}
                                    />
                                    <label style={INSPECTOR_LABEL}>Letter spacing</label>
                                    <NumInput
                                        value={typeof node.style.letterSpacing === "number" ? node.style.letterSpacing : 0}
                                        onChange={v => { editSelected({ style: { letterSpacing: v } }); refresh(); }}
                                    />
                                </InspectorSection>
                            )}

                            {/* PROTOTYPE (M7, schema 35). A trigger, the state it selects, and how
                                long the change takes. The state NAME is free text on purpose: a
                                dangling one is inert, so naming a state before defining it is a
                                legitimate order of work rather than an error. */}
                            <InspectorSection title="Prototype">
                                {(node.interactions ?? []).map((it, i) => (
                                    <div key={i} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
                                        <select
                                            value={it.trigger}
                                            onChange={e => { setInteraction(i, { trigger: e.target.value as Trigger }); refresh(); }}
                                            style={{ ...SELECT_STYLE, width: 66 }}
                                        >{TRIGGERS.map(t => <option key={t} value={t}>{t}</option>)}</select>
                                        <input
                                            value={it.state ?? ""}
                                            placeholder="(base)"
                                            title="The named state to select — empty means the base state"
                                            onChange={e => { setInteraction(i, { state: e.target.value === "" ? null : e.target.value }); refresh(); }}
                                            style={{ ...SELECT_STYLE, flex: 1, minWidth: 0 }}
                                        />
                                        {/* NAVIGATE: pick a node to move the viewport to. The list is
                                            every frame-ish root, and "—" means stay where we are. */}
                                        <select
                                            value={it.target ?? ""}
                                            title="Navigate to — the viewport moves to fit this node"
                                            onChange={e => { setInteraction(i, { target: e.target.value === "" ? undefined : e.target.value }); refresh(); }}
                                            style={{ ...SELECT_STYLE, width: 92 }}
                                        >
                                            <option value="">— stay —</option>
                                            {dispatcher.getDocument().rootNodeUuids.map(id => (
                                                <option key={id} value={id}>
                                                    {dispatcher.getDocument().nodes.get(id)?.name ?? id.slice(0, 8)}
                                                </option>
                                            ))}
                                        </select>
                                        <input
                                            type="number"
                                            value={it.duration ?? 0}
                                            title="Transition duration in ms (0 = instant)"
                                            onChange={e => { setInteraction(i, { duration: Math.max(0, Math.min(TRANSITION_MAX_MS, Number(e.target.value) || 0)) }); refresh(); }}
                                            style={{ ...SELECT_STYLE, width: 52 }}
                                        />
                                        <EasingSelect
                                            value={it.easing}
                                            width={92}
                                            onPick={e => { setInteraction(i, { easing: e }); refresh(); }}
                                        />
                                        <button title="Remove" onClick={() => { removeInteraction(i); refresh(); }} style={ALIGN_BUTTON_STYLE}>×</button>
                                    </div>
                                ))}
                                <button
                                    onClick={() => { addInteraction(); refresh(); }}
                                    style={{ ...ALIGN_BUTTON_STYLE, width: "100%" }}
                                >+ Add interaction</button>
                            </InspectorSection>

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
                                    {/* THE REGION (schema 51). A tileset or a sprite strip is a grid
                                        inside one file, and without this the whole file is the only
                                        thing that can be drawn. Four numbers in the SOURCE image's
                                        own pixels — the unit the art is authored in, so a 24px grid
                                        is 0/24/48/72 rather than a fraction of a size the document
                                        cannot see. Blank clears it back to the whole image. */}
                                    <label style={INSPECTOR_LABEL}>Region (source pixels)</label>
                                    <div style={{ display: "flex", gap: 4 }}>
                                        {(["x", "y", "width", "height"] as const).map(key => (
                                            <input
                                                key={key}
                                                type="number"
                                                data-region={key}
                                                placeholder={key}
                                                value={node.sourceRect ? String(node.sourceRect[key]) : ""}
                                                onChange={e => {
                                                    const raw = e.target.value;
                                                    // CLEARED as a whole when a field is emptied: a
                                                    // region missing one number is not a smaller
                                                    // region, it is not a region.
                                                    if (raw === "") { editContent({ sourceRect: null }); refresh(); return; }
                                                    const base = node.sourceRect ?? { x: 0, y: 0, width: 1, height: 1 };
                                                    const next = { ...base, [key]: Number(raw) };
                                                    // The SAME shared validator the loader uses, so
                                                    // a field cannot author a rect the document
                                                    // would refuse — a zero extent above all.
                                                    if (sourceRectError(next) !== null) return;
                                                    editContent({ sourceRect: next });
                                                    refresh();
                                                }}
                                                style={{ width: "25%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                                                    background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                                            />
                                        ))}
                                    </div>
                                    {/* PIXEL ART. Per node, because one scene mixes a tileset that
                                        must stay crisp with a photograph that must not. */}
                                    <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6 }}>
                                        <input
                                            type="checkbox"
                                            data-pixelated="1"
                                            checked={node.pixelated === true}
                                            onChange={e => { editContent({ pixelated: e.target.checked || undefined }); refresh(); }}
                                        />
                                        Pixel art (no smoothing)
                                    </label>
                                </InspectorSection>
                            )}

                            <InspectorSection title="Layout">
                                {/* Auto-layout has been in the engine since M2 — flex, hug, grow,
                                shrink, wrap, and a whole grid module. Since schema 26 `layout`
                                IS an override field, so a copy edits these like any other node:
                                the change lands on its instance and leaves the master alone. */}
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

                                    {/* Grid is the other half of M2's layout module, and until now
                                        the only way to make one was to hand-write the document.
                                        The action carries grid ⊕ container exclusivity, so ticking
                                        this while auto-layout is on replaces it rather than
                                        producing a node that claims to be both. */}
                                    <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6 }}>
                                        <input
                                            type="checkbox"
                                            checked={!!node.layout.grid}
                                            onChange={e => {
                                                editLayout(e.target.checked ? newGridPatch() : { grid: undefined });
                                                refresh();
                                            }}
                                        />
                                        Grid
                                    </label>
                                    {node.layout.grid && (
                                        <>
                                            <label style={INSPECTOR_LABEL}>Columns</label>
                                            <TrackListInput
                                                value={formatTrackList(node.layout.grid.columns)}
                                                placeholder="1fr 1fr 200px"
                                                onCommit={t => { if (t) { editGrid({ columns: t }); refresh(); } }}
                                            />
                                            {/* `rows` SIZES the leading rows and is optional — empty means
                                                every row falls back to the implicit row height below. Row
                                                COUNT still comes from the children, never from this field. */}
                                            <label style={INSPECTOR_LABEL}>Rows (optional)</label>
                                            <TrackListInput
                                                value={node.layout.grid.rows ? formatTrackList(node.layout.grid.rows) : ""}
                                                placeholder="auto 1fr"
                                                allowEmpty
                                                onCommit={t => { editGrid({ rows: t ?? undefined }); refresh(); }}
                                            />
                                            <label style={INSPECTOR_LABEL}>Row height (implicit rows)</label>
                                            <TrackListInput
                                                value={formatTrackList([node.layout.grid.rowHeight])}
                                                placeholder="80px"
                                                onCommit={t => { if (t && t.length === 1) { editGrid({ rowHeight: t[0] }); refresh(); } }}
                                            />
                                            <div style={INSPECTOR_GRID}>
                                                <div><label style={INSPECTOR_LABEL}>Column gap</label>
                                                    <NumInput value={node.layout.grid.columnGap ?? 0} onChange={v => { editGrid({ columnGap: Math.max(0, v) }); refresh(); }} /></div>
                                                <div><label style={INSPECTOR_LABEL}>Row gap</label>
                                                    <NumInput value={node.layout.grid.rowGap ?? 0} onChange={v => { editGrid({ rowGap: Math.max(0, v) }); refresh(); }} /></div>
                                            </div>
                                            <label style={INSPECTOR_LABEL}>Padding</label>
                                            <NumInput value={node.layout.grid.padding ?? 0} onChange={v => { editGrid({ padding: Math.max(0, v) }); refresh(); }} />
                                            <label style={INSPECTOR_LABEL}>Auto-flow</label>
                                            <SelectInput
                                                value={node.layout.grid.autoFlow ?? "row"}
                                                options={["row", "row dense", "column", "column dense"]}
                                                onChange={v => { editGrid({ autoFlow: v as NonNullable<NonNullable<Node["layout"]["grid"]>["autoFlow"]> }); refresh(); }}
                                            />
                                            <div style={INSPECTOR_GRID}>
                                                <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6 }}>
                                                    <input type="checkbox" checked={!!node.layout.grid.hugWidth}
                                                        onChange={e => { editGrid({ hugWidth: e.target.checked || undefined }); refresh(); }} />
                                                    Hug W
                                                </label>
                                                <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6 }}>
                                                    <input type="checkbox" checked={!!node.layout.grid.hugHeight}
                                                        onChange={e => { editGrid({ hugHeight: e.target.checked || undefined }); refresh(); }} />
                                                    Hug H
                                                </label>
                                            </div>
                                        </>
                                    )}

                                    {/* CHILD-side fields. Which ones apply depends on the PARENT:
                                        a container lays its children out (grow/shrink/margin), while a
                                        plain parent anchors them (constraints). Showing both at once
                                        would offer controls that do nothing. */}
                                    {parentIsContainer ? (
                                        <>
                                            <div style={{ ...INSPECTOR_LABEL, color: "#777", marginTop: 8 }}>In its parent</div>
                                            {/* A grid child spans CELLS; a flex child grows. Both fields
                                                exist on `Layout`, but only one set means anything under a
                                                given parent. */}
                                            {parentIsGrid && (
                                                <div style={INSPECTOR_GRID}>
                                                    <div><label style={INSPECTOR_LABEL}>Col span</label>
                                                        <NumInput value={node.layout.colSpan ?? 1} onChange={v => { editLayout({ colSpan: Math.max(1, Math.round(v)) }); refresh(); }} /></div>
                                                    <div><label style={INSPECTOR_LABEL}>Row span</label>
                                                        <NumInput value={node.layout.rowSpan ?? 1} onChange={v => { editLayout({ rowSpan: Math.max(1, Math.round(v)) }); refresh(); }} /></div>
                                                </div>
                                            )}
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

            {/* THE TIMELINE (schema 39). Shown once a document has a clock, so a still document
                is exactly as uncluttered as it was before animation existed. */}
            {(() => { const timeline = dispatcher.getDocument().timeline; return timeline ? (
                <div style={{ padding: "4px 10px", background: UI.panel, borderTop: `1px solid ${UI.line}`,
                              display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#ccc" }}>
                    <button style={ALIGN_BUTTON_STYLE} title="Play the timeline from the playhead"
                        onClick={() => { es.playingTimeline = !es.playingTimeline; refresh(); }}>
                        {es.playingTimeline ? "⏸" : "▶"}
                    </button>
                    <input
                        type="range" min={0} max={timeline.frames - 1} step={1}
                        value={Math.round(es.frame ?? 0)}
                        onChange={e => { es.frame = parseInt(e.target.value, 10); refresh(); }}
                        style={{ flex: 1 }}
                        title="Scrub the playhead. Scrubbing is not an edit — it pushes no undo step."
                    />
                    <span style={{ width: 84, textAlign: "right", color: "#888" }}>
                        {Math.round(es.frame ?? 0)} / {timeline.frames - 1} · {timeline.fps}fps
                    </span>
                    <button style={ALIGN_BUTTON_STYLE} onClick={() => addKeyframe(false)}
                        title="Key the selected node here, TWEENING from it to the next keyframe">◆ Key</button>
                    <button style={ALIGN_BUTTON_STYLE} onClick={() => addKeyframe(true)}
                        title="Key the selected node here and HOLD it until the next keyframe — frame-by-frame animation">◼ Hold</button>
                    <button style={ALIGN_BUTTON_STYLE} onClick={removeKeyframe}
                        title="Remove the keyframe on this frame">✕</button>
                    {(() => {
                        // Shown only when the playhead is ON a keyframe, because easing describes
                        // the tween leaving one — offering it anywhere else would be a control
                        // that silently does nothing.
                        const id = es.selectedNodeIds[0];
                        const k = id ? dispatcher.getDocument().nodes.get(id)?.track
                            ?.find(kf => kf.frame === Math.round(es.frame ?? 0)) : undefined;
                        if (!k) return null;
                        return k.hold
                            ? <span style={{ color: "#666", fontSize: 11 }} title="A HELD keyframe does not tween, so it has no curve to shape.">held</span>
                            : <EasingSelect value={k.easing} width={104} onPick={setKeyframeEasing} />;
                    })()}
                    <button style={{ ...ALIGN_BUTTON_STYLE, color: es.onion ? UI.accent : "#ccc" }}
                        onClick={() => { es.onion = es.onion ? undefined : 2; refresh(); }}
                        title="ONION SKIN: draw the neighbouring frames faintly behind this one. Ghosts are not pickable — they are a picture of another moment.">
                        ◐ Onion
                    </button>
                </div>
            ) : null; })()}

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

/** A hairline group separator — the toolbar reads as clusters, not one long row. */
function Divider() {
    return <div style={{ width: 1, height: 20, background: UI.line, margin: "0 4px" }} />;
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
function FoldersDrawer({ onPlaceImage, getDocument, selectedImage, onImportTrack, onSetRegion, onImportSvg, editContentFont, onImportTiles }: {
    onPlaceImage: (dataUrl: string, name: string) => void;
    getDocument: () => ReadonlyDocument;
    /** The selected node when it is an image with a source — what a SHEET import acts ON. */
    selectedImage: { id: string; src: string } | null;
    onImportTrack: (track: Keyframe[]) => void;
    onSetRegion: (rect: SourceRect) => void;
    onImportSvg: (specs: SvgNodeSpec[]) => void;
    /** Apply a registered family to the selected node — the point of loading one. */
    editContentFont: (family: string) => void;
    onImportTiles: (tiles: {
        x: number; y: number; width: number; height: number; src: string;
        sourceRect: SourceRect | null; name: string;
        transform: { rotation: number; scaleX: number; scaleY: number } | null;
    }[]) => void;
}) {
    const [tab, setTab] = useState<"source" | "assets" | "export" | "import">("source");
    /** Grid inputs. Strings, because a half-typed number is a state a number input has to hold. */
    const [cellW, setCellW] = useState("32");
    const [cellH, setCellH] = useState("32");
    const [margin, setMargin] = useState("0");
    const [spacing, setSpacing] = useState("0");
    const [step, setStep] = useState("2");
    const [atlasText, setAtlasText] = useState("");
    const [atlasEntries, setAtlasEntries] = useState<AtlasEntry[] | null>(null);
    const [svgText, setSvgText] = useState("");
    const [fonts, setFonts] = useState<FontInfo[]>(registeredFonts());
    const [tiledFolder, setTiledFolder] = useState<string | null>(null);
    const [tiledMaps, setTiledMaps] = useState<{ path: string; name: string; relative: string }[]>([]);
    const [importNote, setImportNote] = useState<string | null>(null);
    const [exported, setExported] = useState<string | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    /** The sheet the preview canvas is showing, or null for none. */
    const [sheet, setSheet] = useState<SheetPlan | null>(null);
    const sheetCanvas = useRef<HTMLCanvasElement | null>(null);
    const [sourceFolder, setSourceFolder] = useState<string | null>(null);
    const [assetFolder, setAssetFolder] = useState<string | null>(null);
    const [findings, setFindings] = useState<Capability[] | null>(null);
    const [assets, setAssets] = useState<{ path: string; name: string; relative: string }[]>([]);
    const [busy, setBusy] = useState(false);

    // Drawn in an effect rather than in the click handler because the canvas does not exist yet
    // when the plan is computed — React mounts it on the render that follows. Drawing straight
    // from the handler would silently paint nothing on the first click and work on the second,
    // which is the kind of bug that gets blamed on the exporter.
    useEffect(() => {
        const canvas = sheetCanvas.current;
        if (!sheet || !canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawSheet(ctx, getDocument(), sheet);
    }, [sheet, getDocument]);
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
                {(["source", "assets", "import", "export"] as const).map(t => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        style={{
                            flex: 1, fontSize: 11, padding: "3px 6px", cursor: "pointer", borderRadius: 3,
                            background: tab === t ? UI.accentSoft : "transparent",
                            color: tab === t ? UI.text : "#999", border: `1px solid ${UI.line}`
                        }}
                    >{t === "source" ? "Code" : t === "assets" ? "Assets" : t === "import" ? "Import" : "Export"}</button>
                ))}
            </div>

            {tab === "import" ? (
                <>
                    {/* IT ACTS ON THE SELECTED IMAGE NODE rather than opening a picker of its own:
                        the node already carries the `src`, already has a `sourceRect` field to fill
                        in, and is already on the canvas — so the result is visible where it lands. */}
                    {!selectedImage ? (
                        <div style={{ color: "#999", padding: "6px 2px" }}>
                            Select an image node to slice a sheet into it.
                        </div>
                    ) : (
                        <>
                            <label style={INSPECTOR_LABEL}>Slice a grid into an animation</label>
                            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                                {([["cell w", cellW, setCellW], ["cell h", cellH, setCellH],
                                   ["margin", margin, setMargin], ["gutter", spacing, setSpacing]] as const).map(([label, value, set]) => (
                                    <input
                                        key={label}
                                        type="number"
                                        data-slice={label}
                                        placeholder={label}
                                        value={value}
                                        onChange={e => set(e.target.value)}
                                        style={{ width: "25%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                                            background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                                    />
                                ))}
                            </div>
                            <button
                                data-slice-btn="1"
                                onClick={() => {
                                    // THE NATURAL SIZE COMES FROM THE DECODED IMAGE. Slicing against a
                                    // guessed size is wrong everywhere at once, so an image that has not
                                    // loaded is refused rather than divided.
                                    const size = naturalSize(selectedImage.src);
                                    if (!size) { setImportNote("That image has not decoded yet."); return; }
                                    const opts = { cellWidth: Number(cellW), cellHeight: Number(cellH),
                                        margin: Number(margin), spacing: Number(spacing) };
                                    const grid = sliceGrid(size.width, size.height, opts);
                                    // `sliceGrid` returns null when the cell size does not divide the
                                    // sheet — reported as the mismatch it is, rather than rounded away.
                                    if (!grid) {
                                        setImportNote(`${size.width}x${size.height} does not divide into ${opts.cellWidth}x${opts.cellHeight} cells.`);
                                        return;
                                    }
                                    const cells = sliceCells(grid, opts);
                                    onImportTrack(sliceTrack(cells, { step: Number(step) || 1 }));
                                    setImportNote(`${grid.columns}x${grid.rows} = ${cells.length} cells, ${Number(step) || 1} frames apart.`);
                                }}
                                style={DRAWER_BUTTON}
                            >Slice into an animation</button>
                            <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 6 }}>
                                <span style={{ color: "#999" }}>frames per cell</span>
                                <input
                                    type="number"
                                    data-slice="step"
                                    value={step}
                                    onChange={e => setStep(e.target.value)}
                                    style={{ width: 50, fontSize: 11, padding: "2px 4px",
                                        background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                                />
                            </div>

                            {/* AN ATLAS is the only route for a sheet that is packed irregularly —
                                57% of real ones — because no division recovers a grid that is not there. */}
                            <label style={INSPECTOR_LABEL}>…or paste a TextureAtlas XML</label>
                            <textarea
                                data-atlas-input="1"
                                value={atlasText}
                                onChange={e => setAtlasText(e.target.value)}
                                placeholder="<TextureAtlas imagePath=…"
                                spellCheck={false}
                                style={{ width: "100%", boxSizing: "border-box", height: 60, fontSize: 10,
                                    fontFamily: "monospace", background: UI.raised, color: UI.text,
                                    border: `1px solid ${UI.line}`, borderRadius: 3, marginBottom: 4 }}
                            />
                            <button
                                data-atlas-btn="1"
                                onClick={() => {
                                    // The SHARED validator, so the panel cannot accept a descriptor the
                                    // reader would refuse — and says which part it refused.
                                    const bad = atlasError(atlasText);
                                    if (bad) { setImportNote(bad); setAtlasEntries(null); return; }
                                    const atlas = parseTextureAtlas(atlasText);
                                    setAtlasEntries(atlas.entries);
                                    const turned = atlas.entries.filter(e => e.rotated).length;
                                    setImportNote(`${atlas.entries.length} sprites in ${atlas.image || "(unnamed image)"}`
                                        + (turned ? `, ${turned} stored turned` : ""));
                                }}
                                style={DRAWER_BUTTON}
                            >Read the atlas</button>
                            {atlasEntries && (
                                <select
                                    data-atlas-pick="1"
                                    onChange={e => {
                                        const entry = atlasEntries[Number(e.target.value)];
                                        if (entry) { onSetRegion(entry.source); setImportNote(`${entry.name} → ${entry.source.width}x${entry.source.height}`); }
                                    }}
                                    style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                        color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                                >
                                    <option value="">Pick a sprite…</option>
                                    {atlasEntries.slice(0, 2000).map((e, i) => (
                                        <option key={e.name + i} value={i}>{e.name || `sprite ${i}`}</option>
                                    ))}
                                </select>
                            )}
                        </>
                    )}
                    {/* SVG NEEDS NO SELECTION, unlike a sheet: it CREATES nodes rather than filling
                        in numbers on one that exists, so it sits outside the guard above. */}
                    <label style={INSPECTOR_LABEL}>Import an SVG as paths</label>
                    <textarea
                        data-svg-input="1"
                        value={svgText}
                        onChange={e => setSvgText(e.target.value)}
                        placeholder="<svg …>"
                        spellCheck={false}
                        style={{ width: "100%", boxSizing: "border-box", height: 60, fontSize: 10,
                            fontFamily: "monospace", background: UI.raised, color: UI.text,
                            border: `1px solid ${UI.line}`, borderRadius: 3, marginBottom: 4 }}
                    />
                    <button
                        data-svg-btn="1"
                        onClick={() => {
                            // The SHARED validator, so the panel cannot accept what the reader
                            // would refuse — and names the part it refused.
                            const bad = svgDocumentError(svgText);
                            if (bad) { setImportNote(bad); return; }
                            const doc = parseSvgDocument(svgText);
                            const specs = svgNodeSpecs(doc.shapes);
                            if (specs.length > SVG_PLACE_MAX) {
                                // BOUNDED, and refused rather than truncated: half a drawing placed
                                // silently is worse than a sentence saying it was too big.
                                setImportNote(`${specs.length} shapes is more than the ${SVG_PLACE_MAX} this will place at once.`);
                                return;
                            }
                            onImportSvg(specs);
                            // NOTES ARE SHOWN, not swallowed — a flattened gradient is a fact about
                            // the drawing that just landed, and the reader already recorded it.
                            const flattened = doc.notes.length;
                            setImportNote(`placed ${specs.length} paths`
                                + (flattened ? ` · ${flattened} approximation${flattened === 1 ? "" : "s"}: ${doc.notes[0]}` : ""));
                        }}
                        style={DRAWER_BUTTON}
                    >Place the SVG</button>

                    {/* FONTS need no selection either — registering a family makes it available to
                        every backend at once, because all three ask the platform for it by name. */}
                    <label style={INSPECTOR_LABEL}>Load fonts from a folder</label>
                    <button
                        data-font-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const files = await api.readFontFolder(folder);
                                const problems: string[] = [];
                                let added = 0;
                                for (const f of files) {
                                    const base64 = await api.readFontBytes(f.path);
                                    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                                    // The SHARED validator, so the panel refuses exactly what the
                                    // reader would — and names which file it refused.
                                    const bad = fontFileError(bytes);
                                    if (bad) { problems.push(`${f.name}: ${bad}`); continue; }
                                    // THE FAMILY COMES OUT OF THE FILE. 36 of the 56 fonts measured
                                    // have a filename that differs from the name the platform
                                    // matches on, so a picker built from filenames would offer
                                    // families no document could ever use.
                                    const note = await registerFont(parseFontFile(bytes), bytes);
                                    if (note) problems.push(note); else added++;
                                }
                                setFonts(registeredFonts());
                                setImportNote(`${added} font${added === 1 ? "" : "s"} registered of ${files.length}`
                                    + (problems.length ? ` · ${problems[0]}` : ""));
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Loading…" : "Load fonts…"}</button>
                    {fonts.length > 0 && (
                        <select
                            data-font-list="1"
                            onChange={e => { if (e.target.value) { editContentFont(e.target.value); } }}
                            style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                        >
                            <option value="">Apply a family to the selection…</option>
                            {fonts.map(f => (
                                <option key={f.family} value={f.family}>
                                    {f.family}{f.subfamily && f.subfamily !== "Regular" ? ` ${f.subfamily}` : ""}
                                </option>
                            ))}
                        </select>
                    )}
                    {/* TILED MAPS. A tile is a `sourceRect` and a tileset is a grid this already
                        slices, so the import is mostly resolving what the file NAMES: an external
                        `.tsx`, a sheet, and a compressed layer. Each of those crosses the bridge
                        through its own narrow door, and every path is confined to the folder the
                        user picked — a `.tmx` is a plain text file anyone can write, and
                        `<image source="../../../.ssh/id_rsa"/>` is a well-formed one. */}
                    <label style={INSPECTOR_LABEL}>Import a Tiled map</label>
                    <button
                        data-tiled-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const maps = await api.readTiledFolder(folder);
                                setTiledFolder(folder);
                                setTiledMaps(maps);
                                setImportNote(maps.length === 0
                                    ? "No .tmx files in that folder."
                                    : `${maps.length} map${maps.length === 1 ? "" : "s"} found`);
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Reading…" : "Find maps…"}</button>
                    {tiledMaps.length > 0 && tiledFolder && (
                        <select
                            data-tiled-list="1"
                            defaultValue=""
                            onChange={async e => {
                                const mapPath = e.target.value;
                                if (!mapPath) return;
                                setBusy(true);
                                try {
                                    const xml = await api.readTiledMap(tiledFolder, mapPath);
                                    // The SHARED validator, so the panel refuses exactly what the
                                    // reader would and says the same thing about why.
                                    const bad = tiledMapError(xml);
                                    if (bad) { setImportNote(`Cannot read that map: ${bad}.`); return; }
                                    const map = parseTiledMap(xml, {
                                        inflate: (d: Uint8Array) => {
                                            let bin = "";
                                            for (const b of d) bin += String.fromCharCode(b);
                                            const r = api.inflateSync(btoa(bin));
                                            if (!r.ok || !r.data) throw new Error(r.error ?? "inflate failed");
                                            return Uint8Array.from(atob(r.data), c => c.charCodeAt(0));
                                        }
                                    });

                                    // EXTERNAL tilesets are resolved here rather than in the parser,
                                    // which has no filesystem and is the reason it stays testable.
                                    const sets: TiledTileset[] = [];
                                    const sheets = new Map<string, string>();
                                    const problems = [...map.notes];
                                    for (const stub of map.tilesets) {
                                        let set = stub;
                                        if (stub.source) {
                                            try {
                                                set = parseTiledTileset(
                                                    await api.readTiledTileset(tiledFolder, mapPath, stub.source), stub);
                                            } catch (err) { problems.push(`${stub.source}: ${String(err)}`); }
                                        }
                                        sets.push(set);
                                        // Reported once RESOLVED, which is the only point an
                                        // external set has an image to be measured against. The
                                        // map already noted the embedded ones for itself.
                                        if (stub.source) {
                                            const over = tilesetOverflow(set);
                                            if (over) problems.push(over);
                                        }
                                        // A sheet-backed set has ONE image; a collection has one
                                        // per tile. Both are cached by path, so a tile referenced
                                        // a thousand times is still decoded once.
                                        const wanted = set.image ? [set.image] : set.tiles.map(t => t.image);
                                        for (const rel of wanted) {
                                            if (sheets.has(rel)) continue;
                                            try {
                                                sheets.set(rel, await api.readTiledImage(tiledFolder, mapPath, rel));
                                            } catch (err) { problems.push(`${rel}: ${String(err)}`); }
                                        }
                                    }

                                    const tiles = [];
                                    let unresolved = 0;
                                    for (const layer of map.layers) {
                                        for (let i = 0; i < layer.cells.length; i++) {
                                            const cell = layer.cells[i];
                                            if (cell.gid === 0) continue;   // EMPTY is most of a map
                                            const set = tilesetFor(sets, cell.gid);
                                            if (!set) { unresolved++; continue; }
                                            // A COLLECTION tile is asked about FIRST: it is a whole
                                            // file at its own size, so there is no rect to cut and
                                            // the set's declared tile size does not apply to it.
                                            const own = tileImageFor(set, cell.gid);
                                            const rect = own ? null : tileSourceRect(set, cell.gid);
                                            const path = own ? own.image : set.image;
                                            const src = path ? sheets.get(path) : undefined;
                                            if (!src || (!own && !rect)) { unresolved++; continue; }
                                            const at = tilePosition(map, i % layer.width, Math.floor(i / layer.width));
                                            const t = tileTransform(cell);
                                            tiles.push({
                                                // The set's OFFSET is what lets a tall tile hang
                                                // above its own cell — a building rooted in one
                                                // square standing over the three behind it.
                                                x: at.x + set.offsetX, y: at.y + set.offsetY,
                                                // The TILE's size, not the map's: a collection tile
                                                // states its own, and a sheet tile may be taller
                                                // than the grid it sits on.
                                                width: own ? own.width : set.tileWidth,
                                                height: own ? own.height : set.tileHeight,
                                                src, sourceRect: rect,
                                                name: `${layer.name} ${cell.gid}`,
                                                // Only the 820-in-124,692 that need one, so an
                                                // unflipped tile carries no transform at all.
                                                transform: t.rotation === 0 && t.scaleX === 1 ? null : t
                                            });
                                        }
                                    }

                                    if (tiles.length > TILE_PLACE_MAX) {
                                        setImportNote(`${tiles.length} tiles is more than the `
                                            + `${TILE_PLACE_MAX} this will place at once.`);
                                        return;
                                    }
                                    onImportTiles(tiles);
                                    setImportNote(`${tiles.length} tiles from ${map.layers.length} layer`
                                        + `${map.layers.length === 1 ? "" : "s"} · ${map.orientation}`
                                        + (unresolved > 0 ? ` · ${unresolved} unresolved` : "")
                                        + (problems.length > 0 ? ` · ${problems[0]}` : ""));
                                } catch (err) {
                                    setImportNote(`Cannot read that map: ${String(err)}`);
                                } finally { setBusy(false); }
                            }}
                            style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                        >
                            <option value="">Place a map…</option>
                            {tiledMaps.map(m => <option key={m.path} value={m.path}>{m.relative}</option>)}
                        </select>
                    )}

                    {importNote && <div style={{ color: "#6a9", wordBreak: "break-all" }}>{importNote}</div>}
                </>
            ) : tab === "export" ? (
                <>
                    <button
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                // The SAME pure exporter the tests exercise; the main process only writes.
                                const written = await api.writeIntoFolder(folder, "design.svg", exportSVG(getDocument(), exportTextLines));
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
                            try { setExported(await api.writeIntoFolder(folder, "design.svg", exportSVG(getDocument(), exportTextLines))); }
                            finally { setBusy(false); }
                        }}
                        style={{ width: "100%", boxSizing: "border-box", fontSize: 11, padding: "3px 5px", background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3, marginBottom: 6 }}
                    />
                    {exported && <div style={{ color: "#6a9", wordBreak: "break-all" }}>Wrote {exported}</div>}
                    {/* PREVIEW: the same `exportSVG` output, without writing a file. Worth having
                        on its own — you can read what you are about to hand someone — and it is
                        the only way to see the export without a native dialog in the way. */}
                    <button onClick={() => setPreview(exportSVG(getDocument(), exportTextLines))} style={DRAWER_BUTTON}>
                        Preview the SVG
                    </button>
                    {/* SPRITE SHEET — the game-facing export. Two files, because an engine needs
                        both: the texture, and the description of which rectangle is which frame of
                        which clip. The PLAN is computed here and shown before anything is written,
                        so an oversize sheet is a sentence rather than a failed encode. */}
                    <button
                        onClick={async () => {
                            const plan = planSheet(getDocument());
                            if (sheetTooLarge(plan)) {
                                setPreview(`Sheet would be ${plan.width}x${plan.height}px — too large to export.`);
                                return;
                            }
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                setExported(await writeSheet(getDocument(), plan, folder));
                            } finally { setBusy(false); }
                        }}
                        disabled={busy}
                        style={DRAWER_BUTTON}
                    >{busy ? "Writing…" : "Export sprite sheet to a folder…"}</button>
                    {/* The ATLAS without writing anything — the half that can be read and checked. */}
                    <button
                        data-sheet-preview-btn="1"
                        onClick={() => {
                            const plan = planSheet(getDocument());
                            setPreview(JSON.stringify(sheetAtlas(getDocument(), plan, "sheet.png"), null, 2));
                            setSheet(plan);
                        }}
                        style={DRAWER_BUTTON}
                    >
                        Preview the sprite-sheet atlas
                    </button>
                    {/* THE SHEET ITSELF, drawn through the same `drawSheet` the export uses, before
                        any folder is chosen. Worth having for the same reason the SVG preview is:
                        you can see what you are about to hand an engine. It also means the drawing
                        half is reachable without a native dialog standing in front of it. */}
                    {sheet && (
                        <canvas
                            ref={sheetCanvas}
                            data-sheet-canvas="1"
                            width={sheet.width}
                            height={sheet.height}
                            style={{ width: "100%", marginTop: 6, border: `1px solid ${UI.line}`, imageRendering: "pixelated" }}
                        />
                    )}
                    {preview !== null && (
                        <textarea
                            readOnly
                            value={preview}
                            data-svg-preview="1"
                            spellCheck={false}
                            style={{
                                width: "100%", height: 140, boxSizing: "border-box", marginTop: 6,
                                fontSize: 10, fontFamily: "ui-monospace, Consolas, monospace",
                                background: UI.bg, color: UI.textDim, border: `1px solid ${UI.line}`, borderRadius: 3
                            }}
                        />
                    )}
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


/**
 * The TOKENS panel — design tokens (M5) reaching the UI at last.
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

/**
 * Assign a design token to a colour slot. Without this, tokens are creatable but unusable —
 * the same "built but unreachable" trap this whole stretch of work has been closing.
 *
 * Shows the CURRENT value as `$key` when the slot already holds a reference, so you can see at
 * a glance which colours are tokenised and which are hardcoded.
 */
function TokenSelect({ store, value, onPick }: { store: VariableStore; value: string; onPick: (v: string) => void }) {
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
                background: UI.raised, color: current ? UI.accent : UI.textDim, border: `1px solid ${UI.line}`, borderRadius: 2
            }}
        >
            <option value="">— no token (fixed colour) —</option>
            {colorKeys.map(k => <option key={k} value={k}>${k}</option>)}
        </select>
    );
}

/**
 * A grid track-list field: `1fr 1fr 200px`, `auto`, `120px 1fr`.
 *
 * It keeps its own DRAFT text while you type, because a track list passes through invalid
 * states on the way to a valid one — "1f" is one keystroke short of "1fr", and a field that
 * reverted every unparseable keystroke would be impossible to type into. The document is
 * written only when `parseTrackList` accepts the draft; anything else stays local and explains
 * itself. Blur drops the draft so the field re-syncs to what the document actually holds.
 */

/**
 * The VARIANTS section — both halves, because either alone is useless.
 *
 * On any node: tag it into a set and give it property values, which is what MAKES a variant set
 * (there is no set object to create — a set is the nodes that name it). On an instance whose
 * master belongs to a set: one dropdown per property the set defines, and choosing swaps which
 * master is drawn while the instance, its position and its overrides stay put.
 */

/**
 * The SLOTS section — again both halves, because either alone is useless.
 *
 * On any node: name it as a slot, which makes it a hole in whatever master contains it. On an
 * instance: one picker per slot the master defines, choosing which node to draw there. The
 * slot keeps supplying the box; its own children are the default whenever nothing fills it.
 */

/**
 * Everything a captured state records: the node's LOOK, not just its paint.
 *
 * Style alone was the original capture, and it made most of the transition machinery
 * unreachable: `blendStates` interpolates geometry and transform, so a prototype could change
 * colour but could never move, grow or turn anything — the animation existed and nothing could
 * author an input for it. A state now pins where the node is and how it is transformed as well
 * as how it is painted, which is what "this node's current look" already claimed to mean.
 *
 * `transform` is included only when the node HAS one, so a state on an untransformed node does
 * not pin an identity transform onto it — an absent transform and an identity one are the same
 * picture, but only the absent one leaves a later rotate free to take effect from the base.
 */
function captureLook(node: Node): StateDefinition {
    return {
        style: { ...node.style },
        geometry: { ...node.geometry },
        ...(node.transform ? { transform: { ...node.transform } } : {})
    };
}

/**
 * The STATES section — what a node looks like in a named context.
 *
 * Defining one CAPTURES the node's current appearance under a name: you style the node the way
 * you want it to look while hovered, press "Capture", and that becomes the hover state. That is
 * the only authoring gesture that does not need a second inspector — the node in front of you
 * IS the editor for the state.
 */
function StatesSection({ node, dispatcher, refresh }: { node: Node; dispatcher: ActionDispatcher; refresh: () => void }) {
    const [newState, setNewState] = useState("");
    const doc = dispatcher.getDocument();
    const states = node.states ?? {};
    const active = doc.activeState;

    return (
        <>
            <div style={{ color: UI.textFaint, fontSize: 10, marginBottom: 4 }}>
                {active
                    ? `Showing “${active}”. Capture stores this node's current look under a name.`
                    : "Capture stores this node's current look under a name; the toolbar switches between them."}
            </div>

            {Object.keys(states).sort().map(name => (
                <div key={name} style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }}>
                    <span style={{ flex: 1, color: name === active ? UI.accent : UI.text, fontSize: 11 }}>{name}</span>
                    <button
                        title={`Re-capture this node's current look as "${name}"`}
                        onClick={() => {
                            dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), node.id, name, captureLook(node)));
                            refresh();
                        }}
                        style={{ fontSize: 10, padding: "1px 5px", background: "transparent", color: UI.textDim, border: `1px solid ${UI.line}`, borderRadius: 2, cursor: "pointer" }}
                    >⟳</button>
                    <button
                        title={`Remove the "${name}" state from this node`}
                        onClick={() => {
                            dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), node.id, name, null));
                            refresh();
                        }}
                        style={{ fontSize: 10, padding: "1px 5px", background: "transparent", color: UI.textDim, border: `1px solid ${UI.line}`, borderRadius: 2, cursor: "pointer" }}
                    >✕</button>
                </div>
            ))}

            <input
                type="text"
                value={newState}
                placeholder="capture as… (e.g. hover)"
                onChange={e => setNewState(e.target.value)}
                onKeyDown={e => {
                    if (e.key !== "Enter") return;
                    const name = newState.trim();
                    if (!name) return;
                    // The shared name rule is the authority; the field only explains a refusal.
                    const err = variantNameError("state name", name, true);
                    if (err) { window.alert(`That state can't be used: ${err}.`); return; }
                    dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), node.id, name, captureLook(node)));
                    setNewState("");
                    refresh();
                }}
                style={{
                    width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                    background: UI.bg, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 2
                }}
            />
        </>
    );
}

function SlotSection({ node, dispatcher, refresh }: { node: Node; dispatcher: ActionDispatcher; refresh: () => void }) {
    const doc = dispatcher.getDocument();

    // Which slots does this instance's master expose? Walk exactly what expansion walks.
    const masterId = node.type === "core.instance" ? resolveVariantMaster(doc, node) : null;
    const slots = masterId
        ? masterSubtreeIds(doc, masterId)
            .map(id => doc.nodes.get(id)!.slot)
            .filter((s): s is string => typeof s === "string")
        : [];
    const uniqueSlots = [...new Set(slots)].sort();

    // Anything top-level can fill a slot — except this instance itself, which would be a cycle
    // the expansion would have to stop, drawing nothing and looking broken.
    const candidates = doc.rootNodeUuids
        .filter(id => id !== node.id)
        .map(id => ({ id, label: doc.nodes.get(id)?.name ?? doc.nodes.get(id)?.type ?? id }));

    return (
        <>
            {uniqueSlots.length > 0 && (
                <>
                    <div style={{ color: UI.textFaint, fontSize: 10, marginBottom: 4 }}>
                        This component exposes {uniqueSlots.length === 1 ? "a slot" : `${uniqueSlots.length} slots`}.
                        An empty one draws its own default content.
                    </div>
                    {uniqueSlots.map(name => (
                        <div key={name}>
                            <label style={INSPECTOR_LABEL}>{name}</label>
                            <SelectInput
                                value={node.slotContent?.[name] ?? ""}
                                options={["", ...candidates.map(c => c.id)]}
                                onChange={v => {
                                    dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), node.id, name, v || null));
                                    refresh();
                                }}
                            />
                        </div>
                    ))}
                </>
            )}

            {/* The MASTER half: make this node a slot. */}
            <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6, marginTop: uniqueSlots.length ? 8 : 0 }}>
                <input
                    type="checkbox"
                    checked={node.slot !== undefined}
                    onChange={e => {
                        dispatcher.dispatchAction(new SetSlotAction(dispatcher.getDocument(), node.id, e.target.checked ? "content" : null));
                        refresh();
                    }}
                />
                Is a slot
            </label>
            {node.slot !== undefined && (
                <>
                    <label style={INSPECTOR_LABEL}>Slot name</label>
                    <TextInput
                        value={node.slot}
                        placeholder="content"
                        onChange={v => {
                            // `slotError` is the authority; an empty name is simply not committed.
                            if (slotError(v) !== null) return;
                            dispatcher.dispatchAction(new SetSlotAction(dispatcher.getDocument(), node.id, v));
                            refresh();
                        }}
                    />
                </>
            )}
        </>
    );
}

function VariantSection({ node, dispatcher, refresh }: { node: Node; dispatcher: ActionDispatcher; refresh: () => void }) {
    const [newProp, setNewProp] = useState("");
    const doc = dispatcher.getDocument();
    const variant = node.variant;

    const setVariant = (v: VariantKey | null) => {
        dispatcher.dispatchAction(new SetVariantAction(dispatcher.getDocument(), node.id, v));
        refresh();
    };

    // An instance shows the PICKER for the set its master belongs to.
    const masterId = node.type === "core.instance" ? node.componentId : undefined;
    const masterSet = masterId ? doc.nodes.get(masterId)?.variant?.set : undefined;
    const props = masterSet ? variantProperties(doc, masterSet) : null;
    const resolvedId = node.type === "core.instance" ? resolveVariantMaster(doc, node) : null;
    const resolved = resolvedId ? doc.nodes.get(resolvedId) : null;

    return (
        <>
            {props && masterSet && (
                <>
                    <div style={{ color: UI.textFaint, fontSize: 10, marginBottom: 4 }}>
                        Set “{masterSet}” — switching redraws this instance from another master.
                    </div>
                    {Object.keys(props).length === 0 && (
                        <div style={{ color: UI.textFaint }}>This set has no properties yet.</div>
                    )}
                    {Object.entries(props).map(([prop, values]) => {
                        // What this instance SHOWS: its own choice, else the master's own value.
                        const current = node.variants?.[prop] ?? resolved?.variant?.values[prop] ?? "";
                        return (
                            <div key={prop}>
                                <label style={INSPECTOR_LABEL}>{prop}</label>
                                <SelectInput
                                    value={current}
                                    options={values}
                                    onChange={v => {
                                        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), node.id, prop, v));
                                        refresh();
                                    }}
                                />
                            </div>
                        );
                    })}
                    {resolvedId && resolvedId !== masterId && (
                        <div style={{ color: UI.accent, fontSize: 10, marginBottom: 6 }}>
                            Drawing “{resolved?.name ?? resolvedId}”.
                        </div>
                    )}
                </>
            )}

            {/* The MASTER half: tag this node into a set. */}
            <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6, marginTop: props ? 8 : 0 }}>
                <input
                    type="checkbox"
                    checked={!!variant}
                    onChange={e => setVariant(e.target.checked ? { set: "Set", values: {} } : null)}
                />
                In a variant set
            </label>
            {variant && (
                <>
                    <label style={INSPECTOR_LABEL}>Set name</label>
                    <TextInput
                        value={variant.set}
                        placeholder="Button"
                        onChange={v => { if (v.length > 0) setVariant({ ...variant, set: v }); }}
                    />
                    {Object.entries(variant.values).map(([k, v]) => (
                        <div key={k} style={{ display: "flex", gap: 4, alignItems: "flex-end", marginBottom: 4 }}>
                            <div style={{ flex: 1 }}>
                                <label style={INSPECTOR_LABEL}>{k}</label>
                                <TextInput
                                    value={v}
                                    onChange={nv => { if (nv.length > 0) setVariant({ ...variant, values: { ...variant.values, [k]: nv } }); }}
                                />
                            </div>
                            <button
                                title={`Remove the "${k}" property`}
                                onClick={() => {
                                    const values = { ...variant.values };
                                    delete values[k];
                                    setVariant({ ...variant, values });
                                }}
                                style={{ fontSize: 10, padding: "2px 5px", marginBottom: 4, background: "transparent", color: UI.textDim, border: `1px solid ${UI.line}`, borderRadius: 2, cursor: "pointer" }}
                            >✕</button>
                        </div>
                    ))}
                    <input
                        type="text"
                        value={newProp}
                        placeholder="add property (e.g. size)"
                        onChange={e => setNewProp(e.target.value)}
                        onKeyDown={e => {
                            if (e.key !== "Enter") return;
                            const key = newProp.trim();
                            if (!key) return;
                            // `variantError` is the authority; the field only explains a refusal.
                            const candidate: VariantKey = { ...variant, values: { ...variant.values, [key]: "default" } };
                            const err = variantError(candidate);
                            if (err) { window.alert(`That property can't be used: ${err}.`); return; }
                            setVariant(candidate);
                            setNewProp("");
                        }}
                        style={{
                            width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                            background: UI.bg, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 2
                        }}
                    />
                </>
            )}
        </>
    );
}

function TrackListInput({ value, placeholder, allowEmpty, onCommit }: {
    value: string;
    placeholder?: string;
    /** When set, clearing the field commits `null` — for the OPTIONAL `rows` list. */
    allowEmpty?: boolean;
    onCommit: (tracks: readonly TrackSize[] | null) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const text = draft ?? value;
    const blank = text.trim().length === 0;
    const error = blank
        ? (allowEmpty ? null : "needs at least one track")
        : parseTrackList(text).error;

    return (
        <>
            <input
                type="text"
                value={text}
                placeholder={placeholder}
                onChange={e => {
                    const next = e.target.value;
                    setDraft(next);
                    if (next.trim().length === 0) { if (allowEmpty) onCommit(null); return; }
                    const parsed = parseTrackList(next);
                    if (parsed.tracks) onCommit(parsed.tracks);
                }}
                onBlur={() => setDraft(null)}
                style={{
                    width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                    background: UI.bg, color: error ? UI.warn : UI.text,
                    border: `1px solid ${error ? UI.warn : "#2a2a4a"}`, borderRadius: 2, marginBottom: error ? 2 : 4
                }}
            />
            {error && <div style={{ fontSize: 10, color: UI.warn, marginBottom: 4 }}>{error}</div>}
        </>
    );
}

/**
 * The SCRIPT panel (Milestone 15) — write a small program, run it, see what it did.
 *
 * The panel is deliberately thin, because none of the safety lives here: the script runs in a
 * worker (`runScript`) and comes back as plain data, which `compileScript` turns into ordinary
 * Actions — the same ones the inspector builds — inside ONE transaction. So a script is one undo,
 * and a script cannot do anything a person could not do by hand.
 *
 * Refusals are SHOWN. A script that asked for twelve things and got ten is a fact its author
 * needs; swallowing the two would leave them debugging a program that looked like it ran.
 */
function ScriptPanel({ dispatcher, refresh }: { dispatcher: ActionDispatcher; refresh: () => void }) {
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
            <div style={{ color: UI.textFaint, fontSize: 10, marginBottom: 6 }}>
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
                    background: UI.bg, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3
                }}
            />
            <button
                onClick={run}
                disabled={busy}
                style={{
                    marginTop: 6, width: "100%", fontSize: 11, padding: "4px 8px",
                    background: busy ? "transparent" : UI.accentSoft, color: "#ccc",
                    border: `1px solid ${UI.line}`, borderRadius: 3, cursor: busy ? "default" : "pointer"
                }}
            >{busy ? "Running…" : "▶ Run"}</button>
            {output.length > 0 && (
                <pre style={{
                    marginTop: 8, fontSize: 10, whiteSpace: "pre-wrap", color: UI.textDim,
                    background: UI.bg, border: `1px solid ${UI.line}`, borderRadius: 3, padding: 6
                }}>{output.join("\n")}</pre>
            )}
        </>
    );
}

function TokensPanel({ dispatcher, refresh }: { dispatcher: ActionDispatcher; refresh: () => void }) {
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
            <div style={{ color: UI.textFaint, marginBottom: 6 }}>
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
                    style={{ flex: 1, boxSizing: "border-box", fontSize: 11, padding: "3px 5px", background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                />
            </div>

            {keys.length === 0 && (
                <div style={{ color: UI.textFaint }}>No tokens yet. Type a name and press Enter — a name starting with “spacing” or “radius” becomes a number token.</div>
            )}

            {keys.map(key => {
                const v = store[key];
                const themed = v.modes?.[theme];
                const isColor = v.type === "color";
                return (
                    <div key={key} style={{ borderTop: `1px solid ${UI.line}`, padding: "6px 0" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ flex: 1, color: UI.text, wordBreak: "break-all" }}>${key}</span>
                            <button
                                title="Delete this token — anything using it falls back to the debug colour"
                                onClick={() => {
                                    dispatcher.dispatchAction(new DeleteVariableAction(dispatcher.getDocument(), key));
                                    refresh();
                                }}
                                style={{ fontSize: 10, padding: "0 5px", background: "transparent", color: UI.textDim, border: `1px solid ${UI.line}`, borderRadius: 2, cursor: "pointer" }}
                            >✕</button>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 4, alignItems: "center", marginTop: 3 }}>
                            <span style={{ color: UI.textFaint }}>base</span>
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
                            <span style={{ color: UI.textFaint }}>{theme}</span>
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

function LayerRow({ node, depth, selected, collapsed, hasChildren, isAutoLayout, inheritedHidden, inheritedLocked, onSelect, onToggle, onFlag, label, dropHint, onDragStart, onDragOver, onDrop, onDragEnd, onRename, onOpacity }: {
    node: ReadonlyNode; depth: number; selected: boolean; collapsed: boolean; hasChildren: boolean;
    isAutoLayout: boolean;
    /** True when an ANCESTOR is hidden/locked — both inherit, so the row shows the effect
     *  without pretending the flag is set on this node. */
    inheritedHidden: boolean; inheritedLocked: boolean;
    onSelect: (mods: ClickModifiers) => void; onToggle: () => void; onFlag: (flags: { hidden?: boolean; locked?: boolean }) => void; label: string;
    /** Drag-to-reorder. `dropHint` is where the pointer currently is within THIS row, so the
     *  row can draw the line that says what the release will do. */
    dropHint: DropPosition | null;
    onDragStart: () => void; onDragOver: (position: DropPosition) => void; onDrop: () => void; onDragEnd: () => void;
    onRename: (name: string) => void;
    onOpacity: (opacity: number) => void;
}) {
    const [hover, setHover] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const isGroup = hasChildren && (node.style.fill === "none" || !node.style.fill);
    return (
        <div
            draggable={!renaming}
            onDragStart={e => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
            onDragOver={e => {
                e.preventDefault();
                // Top and bottom eighths reorder; the middle reparents INTO the row. A row
                // that cannot hold children never offers "inside", so the indicator never
                // promises a drop that would be refused.
                const r = e.currentTarget.getBoundingClientRect();
                const t = (e.clientY - r.top) / r.height;
                onDragOver(t < 0.3 ? "before" : t > 0.7 ? "after" : "inside");
            }}
            onDrop={e => { e.preventDefault(); onDrop(); }}
            onDragEnd={onDragEnd}
            onClick={e => onSelect({ shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey })}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            title={`${label} — ${node.id.slice(0, 8)}`}
            style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 6px", paddingLeft: 6 + depth * 12,
                fontSize: 11, borderRadius: 3, cursor: "pointer", marginBottom: 1,
                background: selected ? "#22436b" : hover ? "#1d1d33" : "transparent",
                // A hidden row stays LISTED but reads as absent — that is the whole difference
                // between hiding and deleting, and the panel is where it has to be legible.
                opacity: node.hidden || inheritedHidden ? 0.4 : 1,
                // The drop indicator: a line where it would land, or a ring around the row it
                // would go inside. Saying which of the two is about to happen is the whole job.
                boxShadow: dropHint === "before" ? `inset 0 2px 0 ${UI.accent}`
                    : dropHint === "after" ? `inset 0 -2px 0 ${UI.accent}`
                    : dropHint === "inside" ? `inset 0 0 0 1px ${UI.accent}` : undefined,
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
            {renaming ? (
                <input
                    autoFocus
                    defaultValue={label}
                    onClick={e => e.stopPropagation()}
                    onBlur={e => { setRenaming(false); onRename(e.target.value); }}
                    onKeyDown={e => {
                        if (e.key === "Enter") { setRenaming(false); onRename((e.target as HTMLInputElement).value); }
                        if (e.key === "Escape") setRenaming(false);   // abandon, keep the old name
                    }}
                    style={{ flex: 1, minWidth: 0, fontSize: 11, padding: "0 2px", background: UI.bg, color: UI.text, border: `1px solid ${UI.accent}`, borderRadius: 2 }}
                />
            ) : (
                <span
                    onDoubleClick={e => { e.stopPropagation(); setRenaming(true); }}
                    style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >{label}</span>
            )}
            {/* Opacity, as a percentage. Shown on hover or whenever it is not 100 — a layer
                that is half-faded should say so without being hovered. It edits this node's
                OWN opacity; what you see on canvas is that multiplied by its ancestors'. */}
            {(hover || node.style.opacity < 1) && (
                <input
                    type="number" min={0} max={100} step={5}
                    value={Math.round(node.style.opacity * 100)}
                    title="Opacity %"
                    onClick={e => e.stopPropagation()}
                    onChange={e => {
                        const pct = parseFloat(e.target.value);
                        // Skip a half-typed value rather than substituting 0 — the same rule
                        // NumInput follows, for the same reason: `|| 0` makes a node vanish.
                        if (!Number.isFinite(pct)) return;
                        onOpacity(Math.min(1, Math.max(0, pct / 100)));
                    }}
                    style={{ width: 34, fontSize: 9, padding: "0 2px", background: UI.bg, color: UI.textDim,
                        border: `1px solid ${UI.line}`, borderRadius: 2 }}
                />
            )}
            {/* Hide and lock. Shown on hover or when SET, so the panel stays quiet but a
                hidden/locked node always says so — a control you cannot see is a state you
                cannot explain. An inherited flag is shown greyed and does nothing on click:
                the node is not the one holding it. */}
            <span
                title={inheritedHidden ? "Hidden by a parent" : node.hidden ? "Show" : "Hide"}
                onClick={e => { e.stopPropagation(); if (!inheritedHidden) onFlag({ hidden: !node.hidden }); }}
                style={{ width: 12, textAlign: "center", fontSize: 10, cursor: inheritedHidden ? "default" : "pointer",
                    color: inheritedHidden ? "#4a4a60" : node.hidden ? "#8a8aa5" : "#5f5f7a",
                    opacity: hover || node.hidden || inheritedHidden ? 1 : 0 }}
            >{node.hidden || inheritedHidden ? "◌" : "◉"}</span>
            <span
                title={inheritedLocked ? "Locked by a parent" : node.locked ? "Unlock" : "Lock"}
                onClick={e => { e.stopPropagation(); if (!inheritedLocked) onFlag({ locked: !node.locked }); }}
                style={{ width: 12, textAlign: "center", fontSize: 10, cursor: inheritedLocked ? "default" : "pointer",
                    color: inheritedLocked ? "#4a4a60" : node.locked ? "#d8a657" : "#5f5f7a",
                    opacity: hover || node.locked || inheritedLocked ? 1 : 0 }}
            >{node.locked || inheritedLocked ? "⊘" : "◇"}</span>
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
