/**
 * @module App
 * @description Top-level React shell. Renders the toolbar, canvas, layers panel,
 * inspector, and status bar.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import "./ElectronAPI";
import { applyOpenedProject, bindProjectFileWorkflow, ProjectFileTarget } from "./ProjectFileWorkflow";
import { ProjectSession } from "./ProjectSession";
import { exportCanvasPng } from "./CanvasExport";
import { stepGameplay } from "../core/runtime/GameplaySession";
import { RuntimeAudio } from "./RuntimeAudio";
import { GameplayPanel } from "./GameplayPanel";
import { ActorPlacementPanel } from "./ActorPlacementPanel";
import { SetBehaviorAssetsAction } from "../core/actions/SetBehaviorAssetsAction";
import { SetBehaviorFunctionsAction } from "../core/actions/SetBehaviorFunctionsAction";
import {SetGameplayVariablesAction} from "../core/actions/SetGameplayVariablesAction";
import { BehaviorDebugPanel } from "./BehaviorDebugPanel";
import { advanceBehaviors2D } from "../core/runtime/GameplaySession";
import { advanceBehaviors3D } from "../core/runtime/Gameplay3D";
import { prepareSequenceImport } from "./AssetImportWorkflow";
import { AnimationPanel } from "./AnimationPanel";
import { SetClipsAction } from "../core/actions/SetClipsAction";
import { SetAnimationControllerAction } from "../core/actions/SetAnimationControllerAction";
import { findClip } from "../core/document/Clips";
import { applyAnimations, sampleClip } from "../core/runtime/AnimationPlayback";
import { animateWorld2D } from "../core/runtime/AnimationWorld";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { createEmptyDocument, CURRENT_VERSION } from "../core/document/Document";
import { Node, Shadow, flatFill, UserData } from "../core/document/Node";
import { Gradient, GradientStop } from "../core/document/Gradient";
import { resolveTypography } from "../renderer/RenderModel";
import { gradientFromColor, withStop, withoutStop, withStopColor, withStopOffset, withKind, GRADIENT_MIN_STOPS } from "../core/document/GradientEdit";
import { Serializer, serializeDocument, CORRUPT_BACKUP_KEY } from "../core/document/Serializer";
import { traverseSceneGraph, ReadonlyNode } from "../core/document/SceneGraph";
import { computeGeometry, ComputedState, contentBounds, selectionBounds, hitTest } from "../core/geometry/GeometryEngine";
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
import { tileImportActions, TilePlacement } from "../core/actions/tileImport";
//  is aliased: the drawer already has a state variable of that name.
// ALIASED: this drawer already has a state variable called `importNote`, and the shadowing is not
// hypothetical — it typechecked as "String has no call signatures" the moment the import landed.
import { buildPlacements, importNote as tiledImportNote } from "../core/import/tiledPlacements";
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
import { createEditorState, frameOnLoad, pickedMeshPoint, pixelMaskFor, EditorState, zoomAt, viewportToFit, viewportToOpen, viewportToScreen, FIT_PADDING_PX, screenToWorld, overlayTransform } from "../editor/EditorState";
import { ToolController } from "../editor/tools/ToolController";
import { SelectTool } from "../editor/tools/SelectTool";
import { MoveTool } from "../editor/tools/MoveTool";
import { PenTool } from "../editor/tools/PenTool";
import { ShapeTool, SHAPE_KINDS, ShapeKind, PaintMode, supportsPaintMode, clampStrokeWidth, DEFAULT_STROKE_WIDTH, STROKE_WIDTH_MAX } from "../editor/tools/ShapeTool";
import { RasterTool } from "../editor/tools/RasterTool";
import { Rgba, PixelBuffer } from "../core/paint/PixelBuffer";
import { adjustBrightness, adjustContrast, adjustHsv, desaturate, invertColours, posterize,
    replaceColour, POSTERIZE_MIN, POSTERIZE_MAX } from "../core/paint/Adjust";
import { makeBrush, BRUSH_MAX_SIZE, brushWithVariants, brushFromImage, Brush } from "../core/paint/Brush";
import { decodeSurface } from "../core/paint/PixelCodec";
import { SymmetryMode, NO_SYMMETRY } from "../core/paint/Symmetry";
import { FrameSelectionAction } from "../core/actions/FrameSelectionAction";
import { alignAction, distributeAction } from "../core/actions/alignActions";
import { booleanAction, makeBooleanNodeAction } from "../core/actions/booleanActions";
import { outlineStrokeAction } from "../core/actions/outlineStrokeActions";
import { onionFrames, Keyframe } from "../core/document/Timeline";
import { DEMOS } from "../core/document/Demos";
import { applyParallax, parallaxIds, DEPTH_MIN, DEPTH_MAX } from "../core/document/Depth";
import { SetDepthAction } from "../core/actions/SetDepthAction";
import { SetMeshAction } from "../core/actions/SetMeshAction";
import { WeightTool, WeightBrush } from "../editor/tools/WeightTool";
import { TileTool, TileBrush } from "../editor/tools/TileTool";
import { BucketTool } from "../editor/tools/BucketTool";
import { PixelSelectTool, PixelSelectMode, PixelSelectConfig, WAND_TOLERANCE_MAX, wandMatcher } from "../editor/tools/PixelSelectTool";
import { SelectionMask, emptyMask, fullMask, invertSelection, growSelection, borderSelection,
    isEmptySelection, selectedCount } from "../core/paint/Selection";
import { PixelSelectionClipboard, PixelSelectionTransform, clearSelectionContent,
    copySelectionContent, moveSelectionContent, pasteSelectionContent,
    transformSelectionContent } from "../core/paint/SelectionContent";
import { Palette, parsePaletteFile, paletteAt } from "../core/paint/Palette";
import { quantizeAction, surfaceEditAction } from "../core/actions/surfaceEdit";
import { SetTilemapAction } from "../core/actions/SetTilemapAction";
import {
    resizeTilemap, withTerrainArt, asTerrain, withTerrain, withTerrainMaterials,
    reorderTerrainMaterial, removeTerrainMaterial, addTerrainMaterial, withTilesetId
} from "../core/document/TilemapEdit";
import { autotileClasses, CORNER_TL, CORNER_TR, CORNER_BL, CORNER_BR } from "../core/document/Autotile";
import { caveCells } from "../core/document/CaveTerrain";
import { TOOL_CURSORS } from "./theme/Cursors";
import { AlignIcon } from "./theme/AlignIcons";
import { parseUnityPackage, UnityAsset } from "../core/import/UnityPackage";
import { rngFrom, seedFrom } from "../core/random/Rng";
import { Tilemap, tileSourceRect as sheetTileRect, tileIndexAt,
    FLIP_H, FLIP_V, FLIP_D , TERRAIN_MATERIALS_MAX} from "../core/document/Tilemap";
import { EyedropperTool } from "../editor/tools/EyedropperTool";
import { SetLightingAction } from "../core/actions/SetLightingAction";
import { SetBackgroundAction } from "../core/actions/SetBackgroundAction";
import { SetScreenAction } from "../core/actions/SetScreenAction";
import { restMesh, MESH_MAX_DIVISIONS, copyMeshPoint, Mesh, ReadonlyMesh } from "../core/document/Mesh";
import { BLEND_MODES, BlendMode } from "../core/document/Node";
import { boneChoices, bonesAt, withBone, withoutBone, withBoneWeight, autoBindMesh, PAINT_STRENGTH } from "../core/document/MeshEdit";
import { SKIN_MAX_BONES } from "../core/geometry/Skin";
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
import { resolveShortcut, isTypingTarget, Shortcut, SHORTCUT_HELP } from "../editor/shortcuts";
import { ClipboardContents, copyNodes, remapForPaste } from "../core/document/Clipboard";
import { PasteNodesAction } from "../core/actions/PasteNodesAction";
import { AlignEdge, DistributeAxis } from "../core/geometry/Alignment";
import { IMAGE_SRC_MAX, srcError, sourceRectError, nineSliceError, NodeType } from "../core/document/Node";
import { NineSliceInsets } from "../core/geometry/NineSlice";
import { clampSides, POLYGON_DEFAULT_SIDES, POLYGON_MIN_SIDES, POLYGON_MAX_SIDES } from "../core/geometry/Polygon";
import { scanCapabilities, Capability } from "../core/scan/CapabilityScan";
import { exportSVG, TextLines } from "../core/export/ExportSVG";
import { exportTiledMap } from "../core/export/ExportTiled";
import { planSheet, sheetAtlas, sheetTooLarge, drawSheet, SheetPlan } from "../core/export/SpriteSheet";
import { sliceGrid, sliceCells, sliceTrack, blankCells } from "../core/import/SheetSlice";
import { groupSequences } from "../core/import/Sequence";
import { sequenceImportActions } from "../core/actions/sequenceImport";
import { asepriteImportActions, AsepritePlacement } from "../core/actions/asepriteImport";
import { Tileset, findTileset, tilesetTile, copyTileset, withTileWeight } from "../core/document/Tileset";
import { SetTilesetsAction } from "../core/actions/SetTilesetsAction";
import { parseAseprite, asepriteError, asepriteClips, asepriteTimeline, composeFrame } from "../core/import/Aseprite";

/** What the drawer hands the shell: everything but where on the canvas it lands. */
type AsepritePlacementInput = Omit<AsepritePlacement, "x" | "y">;
import { parseTextureAtlas, atlasError, AtlasEntry } from "../core/import/TextureAtlas";
import { parseSvgDocument, svgDocumentError } from "../core/import/SvgDocument";
import { svgNodeSpecs, SvgNodeSpec } from "../core/import/SvgNodes";
import { parseFontFile, fontFileError, FontInfo } from "../core/import/FontFile";
import { parseTiledMap, parseTiledTileset, tiledMapError, tilesetFor, tileSourceRect,
    tileImageBox, tileTransform, tileImageFor, tilesetOverflow, tilemapForLayer, objectPlacement,
    withImageSize,
    TiledTileset } from "../core/import/TiledMap";
import { registerFont, registeredFonts } from "../renderer/FontCache";
import { UpdateNodePathAction } from "../core/actions/UpdateNodePathAction";
import { generateUUID } from "../core/ids/UUID";
import { naturalSize, surfaceUrl, imageSizeAsync } from "../../src/renderer/ImageCache";
import { worldFrom, stepWorld, applyWorld, movedIds, stepsFor, applyCommands, applyFacing, facedIds, applyCells, applySpawns, applyTileAnimations, playBounds, runReadout } from "../core/runtime/World";
import { marioRules } from "../core/runtime/Rules";
import { applyPose } from "../core/runtime/Parts";
import { restartRun, respawnRun } from "../core/runtime/RunFlow";
import { advanceWorld3D, applyWorld3D, respawnRun3D, restartRun3D, World3DState } from "../core/runtime/World3D";
import { Entity, playerEntityId } from "../core/document/Entity";
import { RuntimeProject } from "./LevelTransitionWorkflow";
import { followCamera } from "../core/runtime/Camera";
import { SourceRect } from "../core/document/Node";
import { Action } from "../core/actions/Action";
import { textLinesFor } from "../renderer/TextRaster";
import { ReadonlyDocument, ProjectDocument } from "../core/document/Document";
import { AddNodeAction } from "../core/actions/AddNodeAction";
import { asset3DImportActions, environment3DImportActions, loadAsset3D, loadEnvironment3D,
    LoadedAsset3D, rehydrateAssets3D, rehydrateEnvironments3D } from "./Asset3DImportWorkflow";
import { buildFrame3D, MeshAsset3D } from "../renderer/Scene3D";
import { HdrEnvironmentImage } from "../renderer/HdrEnvironment";
import { disposeWebGL3D, emitWebGL3D, invalidateWebGL3DSource, lastWebGL3DFailure,
    pickWebGL3D } from "../renderer/emitWebGL3D";
import { buildRotateGizmo3D, buildTranslateGizmo3D, copySpatial3D, GizmoMode3D, GizmoSpace3D,
    hitRotateGizmo3D, hitTranslateGizmo3D, RotateHandle3D, rotatedSpatial3D, scaledSpatial3D,
    TranslateHandle3D, translatedSpatial3D } from "../renderer/Gizmo3D";
import { emitRotateGizmo3D, emitScaleGizmo3D, emitTranslateGizmo3D } from "../renderer/emitGizmo3D";
import { Spatial3D } from "../core/document/Spatial3D";
import { interact3D } from "../core/runtime/Gameplay3D";
import { interactGameplay2D } from "../core/runtime/GameplaySession";
import { SetSpatial3DAction } from "../core/actions/SetSpatial3DAction";
import { dollyCamera3D, orbitCamera3D, panCamera3D } from "../renderer/CameraOrbit3D";
import { RuntimeControls, Workspace, WorkspaceControls, WORKSPACES } from "./AppShellControls";
import { ThreeDInspector } from "./ThreeDInspector";
import {BlockoutShape} from "../core/geometry/Blockout3D";


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
 * How many NODES one map may place.
 *
 * The largest map measured is 10,618 non-empty cells across five layers, and the whole tree is
 * 22,808. This clears the largest by a wide margin and still refuses a map that would lock the
 * editor up — and it REPORTS rather than truncating, because half a map placed silently looks like
 * a broken importer rather than a refused one.
 *
 * MOSTLY MOOT NOW that a layer arrives as one `core.tilemap`: that same map is five nodes. It still
 * guards the fallback path, which is the one that can produce thousands.
 *
 * AND THERE IS A HARDER LIMIT BEHIND IT, measured rather than reasoned: every node placed cell by
 * cell carries the sheet's whole data URL, so `cloneDocument`'s `JSON.stringify` throws
 * `RangeError: Invalid string length` — V8's cap is ~512MB of string — at the FIRST revision commit.
 * The Roguelike sheet is 61KB of base64, so 10,618 cells is ~650MB and that map could never actually
 * be imported the old way; the transaction rolled back and placed nothing. The corpus's largest
 * fallback layer is 348 cells (~21MB), so nothing here reaches it any more. Fixing it properly means
 * the serializer sharing one copy of a repeated `src`, which is a change to the file format.
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

/**
 * The most frames an asset folder may be imported as ONE animation.
 *
 * NOT A MEMORY BOUND — a guard against the commonest false positive there is. A tileset exported
 * one file per tile (`tile_0000.png` … `tile_9999.png`) is a numbered run by every rule a name
 * reader has, and it is not an animation. Measured in the pack sitting beside this app: 11,846
 * files under one stem. 240 frames is ten seconds at 24fps, which is longer than any sprite cycle
 * and far short of a sheet.
 */
export const SEQUENCE_IMPORT_MAX = 240;

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

/**
 * The inverse, for a palette swatch: a colour from a FILE going into the colour control.
 *
 * ALPHA IS DROPPED, which is the same asymmetry `hexToRgba` documents from the other side — the
 * control has no alpha channel. A palette's transparent slots are drawn as holes rather than as
 * swatches, so nothing translucent reaches here in the first place.
 */
function rgbaToHex(c: Rgba): string {
    const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`;
}

/**
 * What the pure exporter cannot know, supplied from the DOM side.
 *
 * `ExportSVG` is deliberately pure — it is node-testable and runs where `emitSVG` cannot. That
 * purity is exactly why it cannot measure an image or encode a surface, and why it used to write
 * a tileset's WHOLE sheet in place of one cell and a `raster:` key that loads nowhere. Handing it
 * the two answers is the same injection the text wrapper already uses.
 */
const EXPORT_IMAGES = {
    naturalSize: (href: string) => naturalSize(href),
    surfaceUrl: (href: string, surface: { data: string; width: number; height: number }) =>
        surfaceUrl(href, surface)
};

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
import { GL_FALLBACK_ATTR } from "../renderer/WebGLRenderer";
import { rulerTicks } from "../core/geometry/Ruler";

const RULER = 18; // ruler bar thickness in px

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
    /**
     * The last thing the run noticed (M18 slice 5) — kept across frames because a world event is
     * produced by ONE step and this is a status line, not a log: most steps produce nothing, and a
     * message that vanished on the next frame would be unreadable at 60Hz.
     */
    const [lastEvent, setLastEvent] = useState<import("../core/runtime/World").WorldEvent | null>(null);
    /**
     * HOW THE RUN ENDED, mirrored into REACT STATE rather than read off `es.world` during render.
     *
     * The first version read `es.world.outcome` in the JSX, and it flickered: `es.world` is mutable
     * editor state that React does not track, so the banner rendered only when something ELSE
     * happened to trigger a re-render — the event line beside it, which is React state, persisted
     * while the banner did not. Measured live: the banner appeared at the right moment with the
     * right value and was gone within three seconds. Setting it here is what makes it a fact the
     * view is subscribed to.
     */
    const [runOutcome, setRunOutcome] =
        useState<import("../core/runtime/World").RunOutcome | null>(null);
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
    // WHICH SHAPE THE ONE SLOT OFFERS. Remembered rather than reset, because somebody drawing a
    // storyboard draws twenty rectangles, not one of each — a slot that snapped back to Rectangle
    // would cost them a second click every single time.
/**
 * WHICH JOB THE WINDOW IS SET UP FOR.
 *
 * Canvas Fogworks is not one app: it is a vector editor, a pixel editor and an animation system sharing a
 * document, with a 3D layer to come. That is Blender's problem exactly, and workspaces are how
 * Blender avoids offering sculpting tools to somebody editing video.
 *
 * The trade is deliberate and worth stating: a brush is not reachable while you are in Design.
 * Switching is one click, and the alternative — every tool for every job, always — is the twelve
 * flat slots this replaced.
 */
    const [lastShape, setLastShape] = useState<ShapeKind>("rectangle");
    const [workspace, setWorkspace] = useState<Workspace>("design");
    /**
     * The `core.text` node being edited ON THE CANVAS, or null.
     *
     * A NODE ID, not the text: the value lives in the document and every keystroke goes through
     * the ordinary content action, so an in-place edit undoes exactly like one made in the
     * inspector and a second view of the same node cannot disagree with this one.
     */
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    const workspaceDef = WORKSPACES.find(w => w.id === workspace) ?? WORKSPACES[0];
    // READ THROUGH A REF INSIDE THE KEY HANDLER. That handler is registered once in an effect, so
    // it closes over whatever workspace was current when it was registered — and a stale one means
    // the tool keys ask the WRONG workspace whether it shows a tool. Measured: after B moved to
    // Paint, pressing R checked Design's tool list, decided no switch was needed, and left the
    // rectangle tool active in a workspace with no button for it. That is precisely the invisible
    // live tool the workspaces exist to prevent.
    const workspaceRef = useRef(workspaceDef);
    workspaceRef.current = workspaceDef;
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
    // THE WEIGHT BRUSH (schema 58). `bone` is null until the author picks one, and the tool
    // refuses to paint without it — a stroke that silently chose a bone for you would be worse
    // than one that does nothing.
    const [weightBone, setWeightBone] = useState<string | null>(null);
    const [weightRadius, setWeightRadius] = useState(40);
    const [weightStrength, setWeightStrength] = useState(PAINT_STRENGTH);
    const [weightErasing, setWeightErasing] = useState(false);
    const weightBrushRef = useRef<WeightBrush>({ bone: null, radius: 40, strength: PAINT_STRENGTH, erasing: false });
    weightBrushRef.current = { bone: weightBone, radius: weightRadius, strength: weightStrength, erasing: weightErasing };
    // THE TILE BRUSH (schema 61). `index` starts at 0 rather than at nothing, because tile zero is a
    // real tile and a map's first stroke should not need a visit to a panel first — unlike a bone,
    // where a wrong guess is silent and a stroke without one is the honest refusal.
    const [tileIndex, setTileIndex] = useState(0);
    const [tileFlip, setTileFlip] = useState(0);
    const [tileMode, setTileMode] = useState<"paint" | "fill" | "rect">("paint");
    /** The word a cave is generated from — hashed by `seedFrom`, so the author can write it down. */
    const [caveSeed, setCaveSeed] = useState("cave");
    const [tileErasing, setTileErasing] = useState(false);
    // TERRAIN (schema 63): the same brush over a different question — which cells are grass rather
    // than which tile is drawn. Material 1 by default because 0 is the eraser, so a first stroke
    // paints something rather than nothing.
    const [tileTerrain, setTileTerrain] = useState(false);
    const [tileMaterial, setTileMaterial] = useState(1);
    const tileBrushRef = useRef<TileBrush>({ index: 0, flip: 0, mode: "paint", erasing: false,
        terrain: false, material: 1 });
    tileBrushRef.current = { index: tileIndex, flip: tileFlip, mode: tileMode, erasing: tileErasing,
        terrain: tileTerrain, material: tileMaterial };
    // THE MARQUEE. Which shape a drag makes, and — for the wand only — how far a colour may differ
    // and whether the run has to be connected. The OPERATOR is deliberately absent: it comes from the
    // modifiers held during the gesture, so there is no way to leave "subtract" switched on and then
    // wonder why the next marquee ate the selection.
    const [selectMode, setSelectMode] = useState<PixelSelectMode>("rect");
    const [wandTolerance, setWandTolerance] = useState(0);
    const [wandContiguous, setWandContiguous] = useState(true);
    const selectConfigRef = useRef<PixelSelectConfig>({ mode: "rect", contiguous: true, tolerance: 0 });
    selectConfigRef.current = { mode: selectMode, contiguous: wandContiguous, tolerance: wandTolerance };
    // THE ADJUSTMENT PANEL's numbers. Each is the amount ONE application applies, because these are
    // destructive edits rather than a live slider: a slider that meant "brightness = +30" would have
    // to hold a before-image across its whole drag and re-derive from it, which is a second source of
    // truth for the picture — the thing `RasterTool` refuses by committing to the document instead.
    // Apply, look, and Ctrl+Z is the honest workflow until an adjustment LAYER exists.
    const [adjBrightness, setAdjBrightness] = useState(20);
    const [adjContrast, setAdjContrast] = useState(20);
    const [adjHue, setAdjHue] = useState(30);
    const [adjSaturation, setAdjSaturation] = useState(1.2);
    const [adjValue, setAdjValue] = useState(1);
    const [adjLevels, setAdjLevels] = useState(4);
    const [adjFrom, setAdjFrom] = useState("#000000");
    const [adjTolerance, setAdjTolerance] = useState(0);
    const [brushRound, setBrushRound] = useState(false);
    /**
     * Images the brush stamps instead of a disc, one picked per dab.
     *
     * `brushFromImage`, `brushWithVariants` and `pickFace` were all written together and NONE of
     * them had a caller — the whole image-brush feature existed and could not be reached. This is
     * the state that reaches it.
     */
    const [brushFaces, setBrushFaces] = useState<Brush[]>([]);
    const brushFacesRef = useRef<Brush[]>([]);
    brushFacesRef.current = brushFaces;
    const brushRoundRef = useRef(false);
    brushRoundRef.current = brushRound;
    const [symmetry, setSymmetry] = useState<SymmetryMode>(NO_SYMMETRY);
    const symmetryRef = useRef<SymmetryMode>(NO_SYMMETRY);
    symmetryRef.current = symmetry;

    // Which folders are collapsed in the layer tree. Purely a VIEW concern — it never touches
    // the document, so collapsing is not undoable and not persisted.
    const [collapsedLayers, setCollapsedLayers] = useState<Set<string>>(new Set());
    const [backend, setBackend] = useState<RenderBackend>("svg");
    /**
     * Why the GPU backend is drawing through Canvas, when it is.
     *
     * A SILENT FALLBACK IS A LIE THE APP TELLS ABOUT ITSELF. The WebGL backend spent months
     * handing every frame to Canvas because a shader would not compile, and nothing anywhere
     * said so — the menu switched, the picture appeared, and every "verified on the GPU" claim
     * made by driving the app was measuring Canvas. The renderer now records the reason on the
     * container; this is where a PERSON sees it.
     *
     * Read from the DOM after the repaint rather than passed back through a callback, because
     * the fallback is discovered inside an imperative render that React does not own — a
     * setState from in there would be a render inside a render.
     */
    const [glFallback, setGlFallback] = useState<string | null>(null);
    const glFallbackRef = useRef<string | null>(null);
    const [showFolders, setShowFolders] = useState(false);
    const [showTokens, setShowTokens] = useState(false);
    const [showScript, setShowScript] = useState(false);
    // THE DEMO EXERCISES. Their dropdown left the toolbar with the other developer controls, and
    // the menu item that replaced it sent a command NOTHING HANDLED — so for two commits the
    // exercises were unreachable. That is the exact failure I had written down one commit earlier:
    // removing a control whose only other home does not exist yet is how a feature disappears.
    const [showExercises, setShowExercises] = useState(false);
    // Help ▸ Keyboard Shortcuts. The menu item existed from the moment the menu did and sent a
    // command NOTHING HANDLED — a dead entry, which is the thing I removed a Tiled submenu for.
    const [showShortcuts, setShowShortcuts] = useState(false);
    const [gizmoSpace3d, setGizmoSpace3d] = useState<GizmoSpace3D>("world");
    const gizmoSpace3dRef = useRef<GizmoSpace3D>("world");
    const [gizmoMode3d, setGizmoMode3d] = useState<GizmoMode3D>("translate");
    const gizmoMode3dRef = useRef<GizmoMode3D>("translate");
    // A REF, NOT STATE. The clipboard changes nothing on screen, so re-rendering on copy would be
    // a repaint for no visible reason — and it must NOT live in the document, or copying would be
    // an undoable edit and Ctrl+Z after Ctrl+C would "un-copy".
    const clipboardRef = useRef<ClipboardContents | null>(null);
    const [previewClipName, setPreviewClipName] = useState("");
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
    /** Decoded mesh arrays are derived runtime state, keyed by persisted asset id. */
    const meshLibrary3dRef = useRef<Map<string, MeshAsset3D>>(new Map());
    const environmentLibrary3dRef = useRef<Map<string, HdrEnvironmentImage>>(new Map());
    const world3dRef = useRef<World3DState | null>(null);
    const world3dLastAtRef = useRef<number | null>(null);
    /** Invalidates an asynchronous rehydrate when another project replaces the document. */
    const meshHydrationGenerationRef = useRef(0);
    type GizmoDragBase = {
        nodeId: string;
        start: Spatial3D;
        clientX: number;
        clientY: number;
    };
    const gizmoDrag3dRef = useRef<((GizmoDragBase & {
        mode: "translate" | "scale"; handle: TranslateHandle3D;
    }) | (GizmoDragBase & {
        mode: "rotate"; handle: RotateHandle3D;
    })) | null>(null);
    const orbitTarget3dRef = useRef({ x: 0, y: 0, z: 0 });
    const cameraDrag3dRef = useRef<null | {
        nodeId: string; start: Spatial3D; target: { x: number; y: number; z: number };
        clientX: number; clientY: number; viewportHeight: number; mode: "orbit" | "pan"; buttonMask: number;
    }>(null);
    const currentFilePathRef = useRef<string | null>(null);
    const confirmedOverwriteRef = useRef(false);
    // Dirty-state tracking (M1): the previous ComputedState to reuse clean subtrees
    // from, the ids changed by document mutations since it was computed, and the
    // node ids that carried a drag preview last frame (so releasing a drag recomputes
    // them). The invariant `incremental === full` is property-tested — this is the
    // producer of the dirty set the engine consumes.
    const prevComputedRef = useRef<ComputedState | null>(null);
    /** The playing level's extent, captured on the run's first derived frame and cleared on Stop. */
    const runBoundsRef = useRef<ReturnType<typeof contentBounds>>(null);
    /** Mirrors `runOutcome`, so the frame loop can tell a NEW ending from one already shown. */
    const runOutcomeRef = useRef<import("../core/runtime/World").RunOutcome | null>(null);
    const transitionLoadingRef = useRef<string | null>(null);
    const runtimeProjectRef = useRef(new RuntimeProject());
    const runtimeEntryFrameRef = useRef<number | undefined>(undefined);
    const dirtyNodesRef = useRef<Set<string>>(new Set());
    const prevPendingRef = useRef<Set<string>>(new Set());
    /**
     * The playhead the last computed geometry was built at.
     *
     * A frame change is a DIFFERENT DOCUMENT, exactly as a prototype frame is, and the incremental
     * path cannot see it — see the note where this is read.
     */
    const prevFrameRef = useRef<number | undefined>(undefined);
    /**
     * The viewport the last computed geometry was built at — the parallax half of `prevFrameRef`.
     *
     * A LAYERED NODE MOVES WHEN THE CAMERA DOES, and by a route the dirty set cannot see: nothing
     * dispatches an action and no body moves, so the incremental path reused an entry from where
     * the camera used to be. Measured at 300px on one depth-1 layer after a 600px pan.
     */
    const prevViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
    const editorStateRef = useRef<EditorState | null>(null);
    if (!editorStateRef.current) {
        editorStateRef.current = createEditorState();
        // The autosave's own playhead, so the scrubber and the canvas start out agreeing.
        editorStateRef.current.frame = frameOnLoad(initialDocument ?? {});
    }
    const es = editorStateRef.current;

    const dispatcherRef = useRef<ActionDispatcher | null>(null);
    if (!dispatcherRef.current) {
        dispatcherRef.current = new ActionDispatcher(initialDocument || createEmptyDocument());
    }
    const dispatcher = dispatcherRef.current;
    const [fileStatus, setFileStatus] = useState("");
    const audioRef = useRef<RuntimeAudio | null>(null);
    if (!audioRef.current) audioRef.current = new RuntimeAudio(setFileStatus);
    useEffect(() => () => audioRef.current?.dispose(), []);
    const projectSessionRef = useRef<ProjectSession | null>(null);
    if (!projectSessionRef.current) {
        projectSessionRef.current = new ProjectSession({
            serialize: () => serializeDocument(dispatcher.getDocument()),
            path: currentFilePathRef,
            write: async (path, content, source) => {
                const api = window.electronAPI;
                if (api) return api.saveFile(path, content, source);
                localStorage.setItem("vde-document", content);
                return true;
            },
            recover: async snapshot => {
                if (window.electronAPI) await window.electronAPI.writeRecovery(snapshot);
                else localStorage.setItem("vde-recovery", JSON.stringify(snapshot));
            },
            status: setFileStatus
        });
    }
    const projectSession = projectSessionRef.current;
    const [projectDirty, setProjectDirty] = useState(false);
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const dispose = dispatcher.onChange(() => {
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(() => setProjectDirty(projectSession.dirty), 200);
        });
        return () => { dispose(); if (timer !== undefined) clearTimeout(timer); };
    }, [dispatcher, projectSession]);
    const confirmLeaveProject = () => {
        if (projectSession.busy) { setFileStatus("Wait for the current save to finish."); return false; }
        return !projectSession.dirty || (window.electronAPI?.confirmDiscard()
            ?? window.confirm("Discard unsaved changes? Cancel to save first."));
    };
    const saveProject = () => {
        const api = window.electronAPI;
        const path = currentFilePathRef.current;
        if (api && !path) void api.requestSaveAs().catch(error => setFileStatus(`Save As failed: ${error.message}`));
        else void projectSession.save(path ?? "Browser snapshot").then(() => setProjectDirty(projectSession.dirty));
    };

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

    /**
     * How many pixels the selection holds, or null when nothing confines an edit to this canvas.
     *
     * COMPUTED ONCE PER RENDER and read by both the marquee row and the Adjust panel, because it
     * walks the whole mask: at `PIXEL_MAX_SIDE` that is 16.7 million bytes, and two callers counting
     * it separately would do that twice for one number that must agree in both places anyway.
     */
    const pixelSelectionCount = (() => {
        if (!selectedRasterId) return null;
        const mask = pixelMaskFor(es, dispatcher.getDocument(), selectedRasterId);
        return mask ? selectedCount(mask) : null;
    })();
    // Internal pixel clipboard: selection payloads retain their binary mask (including lasso holes),
    // which the text/image OS clipboard cannot represent without a lossy side channel.
    const pixelClipboardRef = useRef<PixelSelectionClipboard | null>(null);

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
            // THE WEIGHT BRUSH. Keyed "weights" beside "paint" because they are the same gesture
            // over different material: one moves pixels, the other moves how much a bone owns a
            // control point.
            weights: new WeightTool(dispatcher, es, refresh, () => weightBrushRef.current),
            // THE TILE BRUSH. Alt-click SAMPLES rather than paints, and it writes to the brush the
            // way the eyedropper writes to the swatch — it changes what the next stroke will be, so
            // it needs no action and leaves no history entry.
            tiles: new TileTool(dispatcher, es, refresh, () => tileBrushRef.current,
                (index, flip) => { setTileIndex(index); setTileFlip(flip); setTileErasing(index < 0); }),
            // THE EYEDROPPER writes to the SWATCH, not to the document — it changes what the next
            // stroke will be, which is why it needs no action and leaves no history entry.
            eyedropper: new EyedropperTool(dispatcher, es, refresh, setPaintColour),
            // THE BRUSH. Keyed "paint", not "raster": the `raster` SHAPE creates a surface, this
            // paints on one that exists. Two gestures, two tools — a single tool that did both
            // could not tell "start a new canvas here" from "start a stroke here".
            // THE BUCKET. `floodFill` was written, tested and mutation-checked with NO CALLER until
            // the feature audit asked whether anything reached it — this is the door, not new
            // arithmetic. It takes the same colour thunk the brush does, so the swatch and the
            // eraser toggle mean the same thing for both.
            bucket: new BucketTool(dispatcher, es, refresh,
                () => erasingRef.current ? [0, 0, 0, 0] : hexToRgba(paintColourRef.current)),
            // THE MARQUEE. `paint/Selection` was nine functions with no gesture — the arithmetic for
            // rect, ellipse, lasso, wand, grow, border and invert, none of it reachable. This is the
            // door, and it dispatches nothing: a selection is not content, so it writes editor state
            // and leaves no history entry, the same bargain the eyedropper makes with the swatch.
            marquee: new PixelSelectTool(dispatcher, es, refresh, () => selectConfigRef.current),
            paint: new RasterTool(dispatcher, es, refresh,
                () => erasingRef.current ? [0, 0, 0, 0] : hexToRgba(paintColourRef.current),
                () => (brushFacesRef.current.length > 0
                    // FACES WIN WHEN THERE ARE ANY, and the size/round controls go on describing the
                    // procedural brush they replace rather than being disabled — the author gets the
                    // disc back by clearing the faces, which is one button and no lost setting.
                    ? brushWithVariants(brushFacesRef.current) ?? makeBrush(brushSizeRef.current, brushRoundRef.current)
                    : makeBrush(brushSizeRef.current, brushRoundRef.current)),
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
    const previewTimeline = dispatcher.getDocument().timeline;
    const previewClip = findClip(dispatcher.getDocument().clips, previewClipName);
    useEffect(() => {
        const timeline = previewTimeline;
        if (!es.playingTimeline || es.playing || !timeline) return;
        const startedAt = Date.now();
        const clip = previewClip ?? { name: "", from: 0, to: timeline.frames - 1 };
        const from = es.frame !== undefined && es.frame >= clip.from && es.frame <= clip.to
            ? es.frame - clip.from : 0;
        const id = window.setInterval(() => {
            const sample = sampleClip(clip, (Date.now() - startedAt) / 1000 + from / timeline.fps, timeline.fps);
            es.frame = sample.frame;
            if (sample.finished) es.playingTimeline = false;
            refresh();
        }, 1000 / Math.min(60, timeline.fps * 2));
        return () => window.clearInterval(id);
    }, [es, refresh, es.playingTimeline, es.playing, previewTimeline, previewClip]);

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
        // THROUGH THE SANCTIONED CONVERSION, not a second copy of it. This restated
        // `(vp.x + screen) / zoom` by hand — the inverse transform, written out in a file that
        // already imports the function for it, with its own zoom floor to keep in step.
        const centre = screenToWorld(es.viewport, { left: 0, top: 0 },
            (el ? el.clientWidth : 800) / 2, (el ? el.clientHeight : 600) / 2);
        const cx = centre.x - w / 2;
        const cy = centre.y - h / 2;
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
    /**
     * Component commands, reachable from the Edit menu as well as the toolbar.
     *
     * Lifted out of their buttons for one reason: a command that only exists inside an onClick can
     * only ever be run by clicking that exact button. These now have two callers and could have a
     * shortcut tomorrow without moving again.
     */
    const createInstance = useCallback(() => {
        const masterId = es.selectedNodeIds[0];
        if (!masterId) return;
        const doc = dispatcher.getDocument();
        const master = doc.nodes.get(masterId);
        if (!master || master.type === "core.instance") return;
        // Place it near the master in WORLD space: the new instance is a ROOT, so its x/y are
        // world coords, while a nested master's stored x/y are parent-relative — using those
        // directly would misplace the instance.
        const box = computeGeometry(doc).nodes.get(masterId)?.bounds;
        const at = box ?? { x: master.geometry.x, y: master.geometry.y };
        const action = new CreateInstanceAction(doc, masterId, at.x + 40, at.y + 40);
        if (dispatcher.dispatchAction(action).success) {
            const created = action.getCreatedNodeId();
            if (created) es.selectedNodeIds = [created];
        }
        refresh();
    }, [dispatcher, es, refresh]);

    const detachInstance = useCallback(() => {
        const id = es.selectedNodeIds[0];
        if (es.selectedNodeIds.length !== 1 || !id) return;
        const action = new DetachInstanceAction(dispatcher.getDocument(), id);
        // Asked BEFORE dispatching, so a menu item that cannot apply does nothing rather than
        // throwing — the toolbar button used to be disabled instead, and the menu has no such gate.
        if (!action.validate()) return;
        if (dispatcher.dispatchAction(action).success) {
            // Select the baked ROOT: the instance the user had selected is gone, and a stale
            // selection would leave the inspector empty.
            const created = action.getCreatedNodeIds();
            es.selectedNodeIds = created.length > 0 ? [created[0]] : [];
        }
        refresh();
    }, [dispatcher, es, refresh]);

    const runShortcut = useCallback((s: Shortcut): boolean => {
        const doc = dispatcher.getDocument();
        const sel = es.selectedNodeIds;
        switch (s.kind) {
            // A TOOL SWITCH IS NOT AN ACTION, so it is not handled here: it changes no document
            // and it needs `setTool`, which is declared after this. The key handler takes it.
            case "tool": return false;
            case "copy": {
                const copied = copyNodes(doc, sel);
                // NOTHING SELECTED LEAVES THE CLIPBOARD ALONE rather than clearing it: pressing
                // Ctrl+C on empty space should not destroy what you copied a minute ago.
                if (copied) clipboardRef.current = copied;
                return true;
            }
            case "cut": {
                const copied = copyNodes(doc, sel);
                if (!copied) return true;
                clipboardRef.current = copied;
                // The DELETE goes through the ordinary action, so a cut is undoable like any other
                // removal — and the clipboard keeps its own detached copy, which is the whole
                // reason the payload holds nodes rather than ids.
                // THE SAME REMOVAL THE DELETE KEY MAKES — one transaction of per-node deletes, so
                // a cut is one undo step and cannot behave differently from a delete.
                const stored = sel.filter(id => !isVirtualId(id) && doc.nodes.has(id));
                if (stored.length === 0) return true;
                dispatcher.dispatchAction(new TransactionAction(doc, "cut",
                    stored.map(id => new DeleteNodeAction(doc, id))));
                es.selectedNodeIds = [];
                refresh();
                return true;
            }
            case "paste": {
                const held = clipboardRef.current;
                if (!held) return true;
                const { nodes, rootIds } = remapForPaste(held);
                const action = new PasteNodesAction(doc, nodes, rootIds);
                if (dispatcher.dispatchAction(action).success) {
                    // SELECT WHAT WAS PASTED, so a second Ctrl+V does not stack copies invisibly
                    // and the arrow keys move what just appeared.
                    es.selectedNodeIds = action.getCreatedRootIds();
                }
                refresh();
                return true;
            }
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

    /**
     * Switch the window's job.
     *
     * SELECTS THE WORKSPACE'S DEFAULT TOOL, because leaving the old one active can leave a tool
     * selected that this workspace does not show — a live tool with no button is a gesture the
     * user cannot see the state of, which is worse than any amount of clutter.
     */
    const pickWorkspace = useCallback((id: Workspace) => {
        const def = WORKSPACES.find(w => w.id === id);
        if (!def) return;
        setWorkspace(id);
        setTool(def.defaultTool);
    }, [setTool]);

    useEffect(() => {
        const target = canvasRef.current;
        if (!target) return;

        const handleMouseDown = (e: MouseEvent) => {
            const rect = target.getBoundingClientRect();
            if (workspaceRef.current.id === "3d") {
                const doc = dispatcher.getDocument();
                const selected = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
                const frame = buildFrame3D(doc, meshLibrary3dRef.current, rect.width, rect.height,
                    environmentLibrary3dRef.current);
                const cameraGesture = (e.altKey && e.button === 0) || e.button === 1;
                if (cameraGesture && frame.cameraNodeId) {
                    const cameraNode = doc.nodes.get(frame.cameraNodeId);
                    if (cameraNode?.spatial3d?.camera) {
                        const selectedWorld = selected && selected !== frame.cameraNodeId
                            ? frame.worlds.get(selected) : null;
                        const orbitTarget = selectedWorld
                            ? { x: selectedWorld[12], y: selectedWorld[13], z: selectedWorld[14] }
                            : orbitTarget3dRef.current;
                        orbitTarget3dRef.current = orbitTarget;
                        cameraDrag3dRef.current = {
                            nodeId: frame.cameraNodeId, start: copySpatial3D(cameraNode.spatial3d), target: orbitTarget,
                            clientX: e.clientX, clientY: e.clientY, viewportHeight: rect.height,
                            mode: e.shiftKey ? "pan" : "orbit", buttonMask: e.button === 1 ? 4 : 1
                        };
                        e.preventDefault();
                        return;
                    }
                }
                if (selected) {
                    const node = doc.nodes.get(selected);
                    const mode = gizmoMode3dRef.current;
                    const x = e.clientX - rect.left, y = e.clientY - rect.top;
                    const rotate = mode === "rotate"
                        ? buildRotateGizmo3D(doc, frame, selected, rect.width, rect.height, gizmoSpace3dRef.current)
                        : null;
                    const axes = mode !== "rotate"
                        ? buildTranslateGizmo3D(doc, frame, selected, rect.width, rect.height,
                            mode === "scale" ? "local" : gizmoSpace3dRef.current)
                        : null;
                    const rotateHandle = rotate ? hitRotateGizmo3D(rotate, x, y) : null;
                    const axisHandle = axes ? hitTranslateGizmo3D(axes, x, y) : null;
                    if (node?.spatial3d && (rotateHandle || axisHandle)) {
                        const s = node.spatial3d;
                        const base = {
                            nodeId: selected,
                            start: copySpatial3D(s),
                            clientX: e.clientX,
                            clientY: e.clientY
                        };
                        gizmoDrag3dRef.current = rotateHandle
                            ? { ...base, mode: "rotate", handle: rotateHandle }
                            : { ...base, mode: mode as "translate" | "scale", handle: axisHandle! };
                        e.preventDefault();
                        return;
                    }
                }
                const canvas = target.firstElementChild;
                const hit = canvas instanceof HTMLCanvasElement
                    ? pickWebGL3D(canvas, e.clientX - rect.left, e.clientY - rect.top, window.devicePixelRatio || 1)
                    : null;
                es.selectedNodeIds = hit ? [hit] : [];
                refresh();
                e.preventDefault();
                return;
            }
            toolController.onMouseDown(e, rect);
        };
        /**
         * DOUBLE-CLICK A LABEL TO EDIT IT — what every canvas tool does, and what this one made
         * you go and find a panel for.
         *
         * Hit-tested through the same `hitTest` the selection uses, so what a double-click opens
         * is what a single click would have selected. A double-click on anything else is left
         * alone rather than swallowed.
         */
        const handleDoubleClick = (e: MouseEvent) => {
            const rect = target.getBoundingClientRect();
            const w = screenToWorld(es.viewport, rect, e.clientX, e.clientY);
            const doc = resolveScene(dispatcher.getDocument());
            const hit = hitTest(computeGeometry(doc), w.x, w.y);
            const node = hit ? doc.nodes.get(hit) : undefined;
            if (!node || node.type !== "core.text" || isVirtualId(hit!)) return;
            es.selectedNodeIds = [hit!];
            setEditingTextId(hit!);
            e.preventDefault();
            refresh();
        };
        const handleMouseMove = (e: MouseEvent) => {
            const rect = target.getBoundingClientRect();
            const cameraDrag = cameraDrag3dRef.current;
            if (cameraDrag) {
                if ((e.buttons & cameraDrag.buttonMask) === 0) { cameraDrag3dRef.current = null; return; }
                const dx = e.clientX - cameraDrag.clientX, dy = e.clientY - cameraDrag.clientY;
                const result = cameraDrag.mode === "pan"
                    ? panCamera3D(cameraDrag.start, cameraDrag.target, dx, dy, cameraDrag.viewportHeight)
                    : { spatial: orbitCamera3D(cameraDrag.start, cameraDrag.target, dx, dy), target: cameraDrag.target };
                orbitTarget3dRef.current = result.target;
                dispatcher.dispatchAction(new SetSpatial3DAction(
                    dispatcher.getDocument(), cameraDrag.nodeId, result.spatial), { coalesce: true });
                refresh(); e.preventDefault(); return;
            }
            const drag = gizmoDrag3dRef.current;
            if (drag) {
                if ((e.buttons & 1) === 0) { gizmoDrag3dRef.current = null; return; }
                const next = drag.mode === "rotate"
                    ? rotatedSpatial3D(drag.start, drag.handle, drag.clientX, drag.clientY, e.clientX, e.clientY)
                    : drag.mode === "scale"
                        ? scaledSpatial3D(drag.start, drag.handle, e.clientX - drag.clientX, e.clientY - drag.clientY)
                        : translatedSpatial3D(drag.start, drag.handle, e.clientX - drag.clientX, e.clientY - drag.clientY);
                dispatcher.dispatchAction(new SetSpatial3DAction(
                    dispatcher.getDocument(), drag.nodeId, next), { coalesce: true });
                refresh();
                e.preventDefault();
                return;
            }
            toolController.onMouseMove(e, rect);
        };
        const handleMouseUp = (e: MouseEvent) => {
            if (cameraDrag3dRef.current) { cameraDrag3dRef.current = null; e.preventDefault(); return; }
            if (gizmoDrag3dRef.current) { gizmoDrag3dRef.current = null; e.preventDefault(); return; }
            toolController.onMouseUp(e);
        };
        /**
         * Which intent a physical key is (M18 slice 2), or null for one the game does not use.
         *
         * BOTH THE ARROWS AND WASD, because a level gets tested by whoever is nearest the keyboard
         * and neither layout is a decision worth making for them. `Space` is a third jump key for
         * the same reason. None of it is configurable yet — that is a settings surface, and this
         * slice is the loop.
         */
        const intentFor = (key: string): "left" | "right" | "jump" | "run" | "down" | null => {
            // SHIFT IS RUN (M18 slice 38) — the same reasoning as the three keys above: both
            // shifts, so neither hand's layout is a decision made for the player.
            if (key === "Shift") return "run";
            // DOWN IS THE PIPE'S BUTTON (M18 slice 39), on both layouts like everything else.
            if (key === "ArrowDown" || key === "s" || key === "S") return "down";
            switch (key) {
                case "ArrowLeft": case "a": case "A": return "left";
                case "ArrowRight": case "d": case "D": return "right";
                case "ArrowUp": case "w": case "W": case " ": return "jump";
                default: return null;
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            // WHILE PLAYING THE KEYBOARD IS THE GAME'S, and it takes the key before any shortcut
            // sees it. THE COLLISION IS THE ARROWS, and it is not a tidiness question: an arrow is
            // "Nudge by 1", which dispatches a real `TransactionAction` and EDITS THE DOCUMENT.
            // Walking a character right would move the level's art one pixel per press and leave
            // the undo stack full of it — the exact thing this runtime is built not to do.
            // Verified live, both halves: five presses while stopped moved the crate 268 -> 273,
            // and the same key while playing walked the body 132px and left the document alone.
            // (WASD and Space collide with nothing today; they are here because a level gets
            // tested by whoever is nearest the keyboard.)
            // Typing in a panel still wins over both — a name field is a name field.
            if (es.playing && !isTypingTarget(e.target as HTMLElement)) {
                if ((e.code === "KeyF" || e.key.toLowerCase() === "f") && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    if (!e.repeat) {
                        const runtimeDoc = runtimeProjectRef.current.document ?? dispatcher.getDocument();
                        const player = playerEntityId(runtimeDoc.nodes.values());
                        if (world3dRef.current && workspaceRef.current.id === "3d" && player) world3dRef.current = interact3D(runtimeDoc, world3dRef.current, player);
                        else if (es.world) { const result = interactGameplay2D(runtimeDoc, es.world, player); es.world = result.world; result.sounds.forEach(sound => { void audioRef.current?.play(sound); }); }
                        refresh();
                    }
                    return;
                }
                const intent = intentFor(e.key);
                if (intent) {
                    es.input = { ...es.input, [intent]: true };
                    e.preventDefault();
                    return;
                }
            }
            // A shortcut must never fire while someone is typing in the inspector — Delete
            // would destroy the selection mid-word and every arrow would move the shape
            // instead of the caret.
            if (!isTypingTarget(e.target as HTMLElement)) {
                // ESCAPE MEANS "CANCEL WHAT I AM DOING" BEFORE IT MEANS "DESELECT", and getting
                // that order wrong made every cancel in the app unreachable. `deselect` stands
                // aside only when NOTHING is selected — and a gesture that can be cancelled always
                // has a selection, because it needed one to start: a rotate, a resize, a marquee, a
                // pen stroke, a tile rectangle. So the shortcut consumed every press and no tool
                // ever saw the key. Found live, not by reading: with a rectangle mid-drag the tool
                // received a plain `q` and never received Escape.
                //
                // A TOOL SAYS IT CONSUMED THE PRESS by calling `preventDefault` in the branch that
                // acted — which is why each of those branches is guarded by "is there a gesture".
                // Unclaimed, Escape falls through and still means deselect.
                if (e.key === "Escape") {
                    toolController.onKeyDown(e);
                    if (e.defaultPrevented) return;
                    const drag = gizmoDrag3dRef.current;
                    if (drag) {
                        dispatcher.dispatchAction(new SetSpatial3DAction(
                            dispatcher.getDocument(), drag.nodeId, drag.start), { coalesce: true });
                        gizmoDrag3dRef.current = null;
                        refresh();
                        e.preventDefault();
                        return;
                    }
                    const cameraDrag = cameraDrag3dRef.current;
                    if (cameraDrag) {
                        dispatcher.dispatchAction(new SetSpatial3DAction(
                            dispatcher.getDocument(), cameraDrag.nodeId, cameraDrag.start), { coalesce: true });
                        cameraDrag3dRef.current = null; refresh(); e.preventDefault(); return;
                    }
                    const cancel = resolveShortcut(e);
                    if (cancel && runShortcut(cancel)) e.preventDefault();
                    return;
                }
                const shortcut = resolveShortcut(e);
                if (shortcut?.kind === "tool") {
                    // A TOOL THE CURRENT WORKSPACE DOES NOT SHOW would otherwise become active
                    // with no button to say so — a live gesture whose state is invisible, which is
                    // the one thing the workspaces were meant to prevent. So the workspace follows
                    // the tool: the first one that lists it wins.
                    const slot = (SHAPE_KINDS as readonly string[]).includes(shortcut.name)
                        ? "shapes" : shortcut.name;
                    const current = workspaceRef.current;
                    if (!current.tools.includes(slot) && !current.tools.includes(shortcut.name)) {
                        const home = WORKSPACES.find(w => w.tools.includes(slot) || w.tools.includes(shortcut.name));
                        if (home) setWorkspace(home.id);
                    }
                    if ((SHAPE_KINDS as readonly string[]).includes(shortcut.name)) {
                        setLastShape(shortcut.name as ShapeKind);
                    }
                    setTool(shortcut.name);
                    e.preventDefault();
                    return;
                }
                if (shortcut && runShortcut(shortcut)) {
                    e.preventDefault();
                    return;   // handled — don't also hand it to the active tool
                }
            }
            toolController.onKeyDown(e);
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            // RELEASED EVEN IF THE PRESS WAS NOT OURS. A key held while Play was pressed, or held
            // across a click into a panel, must still clear — a stuck "right" walks the body into
            // a wall forever with nothing on screen to say why.
            const intent = intentFor(e.key);
            if (intent) es.input = { ...es.input, [intent]: false };
            toolController.onKeyUp(e);
        };
        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = target.getBoundingClientRect();
            if (workspaceRef.current.id === "3d") {
                const doc = dispatcher.getDocument();
                const frame = buildFrame3D(doc, meshLibrary3dRef.current, rect.width, rect.height,
                    environmentLibrary3dRef.current);
                const cameraNode = frame.cameraNodeId ? doc.nodes.get(frame.cameraNodeId) : null;
                if (frame.cameraNodeId && cameraNode?.spatial3d?.camera) {
                    const next = dollyCamera3D(copySpatial3D(cameraNode.spatial3d), orbitTarget3dRef.current,
                        e.deltaY, cameraNode.spatial3d.camera);
                    dispatcher.dispatchAction(new SetSpatial3DAction(doc, frame.cameraNodeId, next), { coalesce: true });
                    refresh();
                }
                return;
            }
            // Zoom about the cursor (the world point under the pointer stays fixed).
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            zoomAt(es.viewport, zoomFactor, e.clientX - rect.left, e.clientY - rect.top);
            toolController.onWheel(e, rect);
            refresh(); // repaint at the new zoom (wheel doesn't go through a tool commit)
        };

        target.addEventListener("mousedown", handleMouseDown);
        target.addEventListener("dblclick", handleDoubleClick);
        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        target.addEventListener("wheel", handleWheel, { passive: false });

        return () => {
            target.removeEventListener("mousedown", handleMouseDown);
            target.removeEventListener("dblclick", handleDoubleClick);
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
            const base = (es.playing && runtimeProjectRef.current.document) || dispatcher.getDocument();
            const timed: ReadonlyDocument = es.frame !== undefined
                ? ({ ...(base as ProjectDocument), frame: es.frame } as ReadonlyDocument) : base;
            // PARALLAX (schema 40): a layered node is shifted HERE, before geometry is computed,
            // so that where it draws is where it can be clicked, marquee-selected and snapped to.
            // Costs nothing on a document that never mentions depth — the derivation returns the
            // same reference — which matters because this runs on every pan.
            // THE WORLD ADVANCES HERE (M18), before anything derives from the document, and it
            // advances by WHOLE FIXED STEPS the wall clock has earned — never by the frame's own
            // delta. A variable step makes a jump height depend on the frame rate; this is the
            // only place that knows the clock, which is why the accumulator lives here and the
            // physics does not. `stepsFor` caps a long gap (a backgrounded tab) rather than
            // spending 600 derivations on the frame that resumes.
            let worldMoved: Set<string> | null = null;
            let played: ReadonlyDocument = timed;
            if (es.playing && workspace === "3d" && world3dRef.current) {
                const now3d = Date.now(), last3d = world3dLastAtRef.current ?? now3d;
                const inputs3d = es.controlled ? new Map([[es.controlled, {
                    x: (es.input.right ? 1 : 0) - (es.input.left ? 1 : 0), y: 0,
                    z: (es.input.down ? 1 : 0) - (es.input.jump ? 1 : 0), speed: es.input.run ? 7 : 4
                }]]) : new Map();
                world3dRef.current = advanceWorld3D(base, world3dRef.current,
                    (now3d - last3d) / 1000, inputs3d);
                world3dLastAtRef.current = now3d;
                if (world3dRef.current.diagnostics?.length) setFileStatus(world3dRef.current.diagnostics[0]);
                if (world3dRef.current.transitionTo && es.world) {
                    es.world = { ...es.world, transitionTo: world3dRef.current.transitionTo };
                }
                if (world3dRef.current.outcome !== "running"
                    && runOutcomeRef.current !== world3dRef.current.outcome) {
                    runOutcomeRef.current = world3dRef.current.outcome;
                    setRunOutcome(world3dRef.current.outcome);
                }
            }
            if (es.playing && es.world && es.worldClock && !(workspace === "3d" && world3dRef.current?.behaviorState?.debug.paused)) {
                const now = Date.now();
                const spend = stepsFor(es.worldClock.accumulator, (now - es.worldClock.lastAt) / 1000);
                const before = es.world;              // what the last frame DREW, for the dirty set
                let world = es.world;
                // STEPPED AGAINST THE STORED DOCUMENT, never the derived one: a body's size and
                // every solid's box are the FILE's facts, so an edit to the level is picked up on
                // the next step and the physics never reads its own output back in.
                // A FINISHED RUN DOES NOT STEP. The world is kept rather than cleared, so the
                // last frame stays on screen and the bodies stay where they ended; Stop is what
                // throws it away, exactly as it always was.
                const stepsToRun = world.outcome === "running" ? spend.steps : 0;
                for (let i = 0; i < stepsToRun; i++) {
                    // STEPPED AGAINST THE DOCUMENT THAT INCLUDES WHAT THIS RUN SPAWNED, which is
                    // the one derive that has to happen BEFORE the step rather than after it — see
                    // `applySpawns`. Inside the loop, because a rule may spawn something on step
                    // three and step four must be able to collide with it; it returns the same
                    // reference until something is spawned, so a run that spawns nothing pays
                    // nothing for asking.
                    // …AND THE RUN'S CELLS (M18 slice 34), for two reasons measured on the same
                    // day: a spent ? block's own tile is what must answer the NEXT bump — read
                    // un-stamped, the original tile still declared its contents and every re-hit
                    // popped another coin, 2 spawns where the level authored 1 — and a BROKEN
                    // brick's cell must stop being solid, which only a step that reads the
                    // stamped document can see.
                    const step = stepGameplay(base, world, { controlled: es.controlled, bounds: runBoundsRef.current, input: es.input });
                    // THE RULES RUN PER STEP, INSIDE THE LOOP. A frame may earn five steps, and
                    // batching the commands to the end of it would delay every bounce by up to four
                    // — measured at 14.25px on a stomp. The physics still decides nothing: it
                    // produced events, this reads them, and `applyCommands` answers a FINISHED
                    // world. `marioRules` is the game; swapping it changes no line below.
                    const commands = step.commands;
                    world = step.world;
                    for (const sound of step.sounds) void audioRef.current?.play(sound);
                    // A WARP CUTS THE CAMERA (M18 slice 39): the follow camera closes a fraction
                    // per step, so a 3000px teleport would swoosh across the whole level. The
                    // original cuts, and so does this — by finishing the follow in one go.
                    if (canvasRef.current && commands.some(c =>
                            c.kind === "teleport" && c.bodyId === es.controlled)) {
                        const b = es.controlled ? world.bodies.get(es.controlled) : undefined;
                        const n = es.controlled ? base.nodes.get(es.controlled) : undefined;
                        if (b && n) Object.assign(es.viewport, followCamera(
                            es.viewport,
                            { width: canvasRef.current.clientWidth, height: canvasRef.current.clientHeight },
                            { x: b.x, y: b.y, width: n.geometry.width, height: n.geometry.height },
                            runBoundsRef.current, 10000));
                    }
                }
                es.world = world;
                es.worldClock = { accumulator: spend.accumulator, lastAt: now };
                if (world.transitionTo && transitionLoadingRef.current === null) {
                    const target = world.transitionTo;
                    transitionLoadingRef.current = target;
                    const api = window.electronAPI;
                    if (!api) {
                        es.world = applyCommands(world, [{ kind: "endRun", outcome: "lost" }]);
                        setRunOutcome("lost");
                    } else {
                        runtimeProjectRef.current.transition(api, currentFilePathRef.current, target).then(adopted => {
                            if (!adopted || !es.playing) return;
                            const runtimeDoc = runtimeProjectRef.current.document!;
                            audioRef.current?.stop();
                            es.frame = frameOnLoad(runtimeDoc);
                            es.controlled = playerEntityId(runtimeDoc.nodes.values());
                            es.world = restartRun(runtimeDoc);
                            world3dRef.current = workspace === "3d" ? restartRun3D(runtimeDoc) : null;
                            world3dLastAtRef.current = Date.now();
                            es.worldClock = { accumulator: 0, lastAt: Date.now() };
                            runBoundsRef.current = null;
                            runOutcomeRef.current = null;
                            setRunOutcome(null);
                            setLastEvent(null);
                            prevComputedRef.current = null;
                            transitionLoadingRef.current = null;
                            refresh();
                        }).catch(error => {
                            console.error(`Level transition to ${target} failed:`, error);
                            if (es.world) es.world = applyCommands(es.world, [{ kind: "endRun", outcome: "lost" }]);
                            runOutcomeRef.current = "lost";
                            setRunOutcome("lost");
                        });
                    }
                }
                // THE PREVIOUS WORLD IS PART OF THE QUESTION. A dirty set must name what changed
                // since the LAST frame, not what disagrees with the stored document — a body that
                // jumps and lands back on its authored position agrees with the document again, so
                // without this it goes unnamed on exactly the frame it arrives and the incremental
                // geometry keeps drawing it mid-air. Measured at 6px, permanent.
                // A CHARACTER THAT TURNS AROUND HAS NOT MOVED A PIXEL, so `movedIds` alone leaves
                // it out of the dirty set and the incremental geometry keeps the old matrix for
                // ever — the third time a stale dirty set would have shown a stale picture here.
                worldMoved = new Set([...movedIds(base, world, before), ...facedIds(base, world)]);
                // THE CAMERA FOLLOWS WHAT YOU DRIVE, and it is stepped with the SAME step count
                // the physics just spent, not once per frame — a camera closing a fixed fraction
                // per frame is a different camera on a 144Hz monitor, which is the same defect as
                // a frame-rate-dependent jump and far harder to notice. `followCamera` is pure and
                // cannot reach the bodies, so no level plays differently for being looked at.
                //
                // IT YIELDS TO AN EXPLICIT NAVIGATION: a `viewportTransition` is something the run
                // ASKED for, and two writers on one viewport is a fight the user always loses.
                const drivenNode = es.controlled ? base.nodes.get(es.controlled) : undefined;
                const drivenBody = es.controlled ? world.bodies.get(es.controlled) : undefined;
                const canvasEl = canvasRef.current;
                if (drivenNode && drivenBody && canvasEl && !es.viewportTransition) {
                    Object.assign(es.viewport, followCamera(
                        es.viewport,
                        { width: canvasEl.clientWidth, height: canvasEl.clientHeight },
                        {
                            // The body's own x/y are already WORLD space (slice 6); its SIZE is the
                            // file's, read from the stored node like every other body fact.
                            x: drivenBody.x, y: drivenBody.y,
                            width: drivenNode.geometry.width, height: drivenNode.geometry.height
                        },
                        runBoundsRef.current, spend.steps));
                }
                // THE LAST EVENT WINS on a frame that produced several, which a status line can
                // only show one of anyway. Set outside the render path's own state on purpose: it
                // is React state, so this schedules a repaint, and the loop is already asking for
                // one every frame while a world is running.
                if (world.events.length > 0) setLastEvent(world.events[world.events.length - 1]);
                // A RUN THAT HAS ENDED SAYS SO ONCE, and the guard is what stops a setState on
                // every frame of a finished run — which would re-render for ever.
                if (world.outcome !== "running" && runOutcomeRef.current !== world.outcome) {
                    runOutcomeRef.current = world.outcome;
                    setRunOutcome(world.outcome);
                }
                // …and the bodies reach the scene the way the PLAYHEAD does: stamped onto a copy.
                // …and then MIRRORED to face the way it is going. A sibling of applyWorld rather
                // than part of it: this changes no box, so nothing derived from bounds can shift.
                // …and POSED at the frame its distance has reached (M18). A third sibling, after
                // the stamp and the mirror, and the last of them that changes what is DRAWN without
                // changing what is THERE — `sourceRect` reaches no geometry, so no bounds, no
                // camera clamp and no death plane can move because a character took a step.
                // …and the CELLS this run has changed, stamped like the bodies are (M18). A bumped
                // block is the level looking different for the length of a run, so it belongs on the
                // derived copy beside the moved bodies rather than in the file.
                // `applySpawns` FIRST, and it is the only one of these five that also ran BEFORE
                // the step. It has to appear twice: once so the physics can collide with what was
                // spawned, and once so it is drawn. Feeding only the picture would put a coin on
                // screen that nothing can touch; feeding only the step would collide with one
                // nobody can see.
                played = applyTileAnimations(applyCells(
                    applyPose(applyFacing(applyWorld(applySpawns(timed, world), world), world), world),
                    world), world.time);
            }
            if (es.playing) played = applyAnimations(played, workspace === "3d"
                ? world3dRef.current?.animations : es.world?.animations);
            const stored = applyParallax(played as ProjectDocument, es.viewport) as ReadonlyDocument;
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
                // THE SIZE SAYS WHICH POINT STAYS STILL — the world point under the screen
                // CENTRE. Without it the offsets moved linearly under a geometric zoom and
                // the focused frame swung out and back, by more the further from the world
                // origin it sat. A null ref means a canvas that has not measured yet, which
                // degrades to holding the screen origin rather than to the old defect.
                Object.assign(es.viewport, lerpViewport(vt.from, vt.to, k,
                    { width: canvasRef.current?.clientWidth ?? 0, height: canvasRef.current?.clientHeight ?? 0 }));
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
            // A RUNNING WORLD IS THE BEST CASE FOR REUSE, not the worst — which is why play mode no
            // longer forfeits it. A tick moves a handful of bodies and leaves the level alone, and
            // `movedIds` names exactly those; measured on a 1,000-node scene that is 4.5x cheaper
            // than recomputing everything, which is the difference between 4.6ms and 1.2ms a frame.
            // It applies ONLY while the world is what changed: a state transition rewrites nodes
            // this set knows nothing about, so that case still recomputes in full.
            const worldOnly = es.playing && worldMoved !== null && !es.transition && !frameChanged;
            // PARALLAX IS THE OTHER THING THE DIRTY SET CANNOT SEE. `applyParallax` shifted every
            // layered node's stored geometry from the viewport a few lines above, and the engine
            // decides reuse by SET MEMBERSHIP — it never compares geometry — so a pan, which
            // dispatches no action and moves no body, left those nodes where the camera used to be.
            // Measured at 300px on one depth-1 layer after a 600px pan; the follow camera makes it
            // continuous. `parallaxIds` is empty for an unlayered document, which is almost all of
            // them, so this costs nothing to ask on every frame.
            const vpNow = es.viewport, vpWas = prevViewportRef.current;
            const viewportMoved = vpWas === null
                || vpWas.x !== vpNow.x || vpWas.y !== vpNow.y || vpWas.zoom !== vpNow.zoom;
            const layered = viewportMoved ? parallaxIds(doc) : null;
            const computed = (worldOnly || (!es.playing && !frameChanged)) && prevComputedRef.current
                ? computeGeometry(doc, es.pendingGeometry, prevComputedRef.current,
                    new Set([...dirtyNodesRef.current, ...pendingKeys, ...prevPendingRef.current,
                        ...(worldMoved ?? []), ...(layered ?? [])]))
                : computeGeometry(doc, es.pendingGeometry);
            prevFrameRef.current = es.frame;
            prevViewportRef.current = { x: vpNow.x, y: vpNow.y, zoom: vpNow.zoom };

            // …and the reuse chain is BROKEN across play, so the first frame back in the editor
            // does not diff against a state's geometry. A WORLD-ONLY frame is the exception: it
            // moved bodies and nothing else, so its geometry is a sound base for the next tick —
            // which is what makes the reuse above worth having, since a chain broken every frame
            // would have nothing to reuse FROM.
            prevComputedRef.current = es.playing && !worldOnly ? null : computed;
            // THE LEVEL'S EXTENT, MEASURED ONCE PER RUN — the edge the camera will not scroll past.
            // Once, because a level does not move while it is being played and `contentBounds` is
            // O(nodes); the frame it is captured on is the first the camera has a limit, which is a
            // frame at the position the editor was already showing.
            if (es.playing && es.world && runBoundsRef.current === null) {
                // THROUGH `playBounds`, so a DECLARED screen (schema 72) pins the run's vertical
                // extent — the death plane and the camera's clamp stop being a measurement an
                // empty scenery row can move. Without one this is `contentBounds` exactly.
                runBoundsRef.current = playBounds(contentBounds(computed), base.screen);
            }
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
                // VALIDATED HERE, once. `pixelMaskFor` is the door every consumer reads through, so
                // the marquee drawn on screen is exactly the mask the brush and the bucket obey — a
                // selection stale from a resize disappears from the canvas at the same moment it
                // stops clipping, rather than lingering as an outline nothing honours.
                pixelSelection: es.pixelSelection
                    && pixelMaskFor(es, doc, es.pixelSelection.nodeId) !== null
                    ? es.pixelSelection : null,
                snapGuides: es.snapGuides,
                pendingPath: es.pendingPath,
                computed,
                viewport: es.viewport
            };
            if (workspace === "3d") {
                const host = canvasRef.current;
                if (host.dataset.vdeBackend !== "webgl3d") {
                    host.innerHTML = "";
                    host.dataset.vdeBackend = "webgl3d";
                    const canvas = document.createElement("canvas");
                    canvas.style.display = "block";
                    canvas.style.width = `${host.clientWidth}px`;
                    canvas.style.height = `${host.clientHeight}px`;
                    host.appendChild(canvas);
                }
                const canvas = host.firstElementChild as HTMLCanvasElement;
                canvas.style.width = `${host.clientWidth}px`;
                canvas.style.height = `${host.clientHeight}px`;
                const scene3d = es.playing && world3dRef.current ? applyWorld3D(doc, world3dRef.current) : doc;
                const runtimeAssets = es.playing && runtimeProjectRef.current.document ? runtimeProjectRef.current : null;
                const frame3d = buildFrame3D(scene3d, runtimeAssets?.meshes ?? meshLibrary3dRef.current, host.clientWidth, host.clientHeight,
                    runtimeAssets?.environments ?? environmentLibrary3dRef.current, es.playing ? world3dRef.current?.time ?? 0 : (es.frame ?? 0) / (doc.timeline?.fps ?? 24));
                if (frame3d.diagnostics?.length) setFileStatus(frame3d.diagnostics[0]);
                if (!emitWebGL3D(canvas, frame3d, window.devicePixelRatio || 1)) {
                    host.dataset.vdeGlFallback = lastWebGL3DFailure() ?? "3D WebGL unavailable";
                } else delete host.dataset.vdeGlFallback;
                const selected = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
                if (gizmoMode3d === "rotate") emitRotateGizmo3D(host, selected
                    ? buildRotateGizmo3D(doc, frame3d, selected, host.clientWidth, host.clientHeight, gizmoSpace3d)
                    : null);
                else {
                    const axes = selected ? buildTranslateGizmo3D(doc, frame3d, selected,
                        host.clientWidth, host.clientHeight, gizmoMode3d === "scale" ? "local" : gizmoSpace3d) : null;
                    if (gizmoMode3d === "scale") emitScaleGizmo3D(host, axes);
                    else emitTranslateGizmo3D(host, axes);
                }
            } else {
                const former3d = canvasRef.current.firstElementChild as HTMLCanvasElement | null;
                if (canvasRef.current.dataset.vdeBackend === "webgl3d" && former3d) {
                    disposeWebGL3D(former3d); canvasRef.current.innerHTML = "";
                    delete canvasRef.current.dataset.vdeBackend;
                }
                renderScene(canvasRef.current, doc, rendererState, backend, refresh);
            }
            // GUARDED BY A REF, so this settles: the state change re-renders, the effect runs again,
            // the reason is unchanged and nothing is set. Without it, every frame would setState.
            const fell = canvasRef.current.dataset[GL_FALLBACK_ATTR] ?? null;
            if (fell !== glFallbackRef.current) {
                glFallbackRef.current = fell;
                setGlFallback(fell);
            }

            // The animation clock. A transition is redrawn until its duration is up, then cleared
            // — so the running state is derived from a TIMESTAMP rather than accumulated per
            // frame, and a dropped frame lands in the right place instead of drifting.
            // THE GAME LOOP IS THIS LINE (M18). A running world re-arms the frame unconditionally,
            // which is what makes it a loop rather than a transition that happens to tick: a
            // transition ends and stops asking, and a world never does. It is armed only while
            // PLAYING, so an editing session still repaints on demand and costs nothing when idle.
            if (es.playing && (es.transition || es.viewportTransition || es.world)) {
                if (es.transition && Date.now() - es.transition.startedAt >= es.transition.duration) es.transition = null;
                requestAnimationFrame(() => refresh());
            }
        }
    }, [ui.tick, dispatcher, backend, workspace, gizmoSpace3d, gizmoMode3d]);

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

    // FRAME THE DOCUMENT THE APP OPENED WITH — otherwise the editor starts at the viewport's
    // literal default, `{ x: 0, y: 0, zoom: 1 }`, and shows whatever happens to be at the world
    // origin. For the level this was found on that meant the ground sitting a third of the way up
    // with empty sky below it, and the only thing that ever looked right was PLAY — because the
    // follow camera clamps to the level's own extent, which is the framing nothing did on load.
    // For a document authored somewhere other than the origin it means opening a file and being
    // shown nothing at all.
    //
    // THE SAME ARITHMETIC `view.zoomFit` USES, deliberately: "what you see when you open it" and
    // "what you see when you ask to fit it" being two answers would be two behaviours to keep
    // right. That command already existed, tested, and was reachable only from a menu.
    //
    // ONCE, AND ONLY FOR THE DOCUMENT THE APP BOOTED WITH. A later `loadDocument` is a user
    // action — File > Open frames itself through the same command — and re-framing on every
    // document change would fight the user's own panning the moment they moved a node.
    const framedOnLoad = useRef(false);
    useEffect(() => {
        if (framedOnLoad.current || !initialDocument) return;
        const el = canvasRef.current;
        // The canvas has no size until it is laid out; an effect that runs before that would
        // divide by a zero-width box, so this waits for a frame that has one rather than guessing.
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        framedOnLoad.current = true;
        // THE DECLARED SCREEN WINS (schema 72): a document that states its play area opens ON it,
        // and what the content happens to measure cannot move that — the open-framing half of the
        // slice-30 defect, after `playBounds` closed the death-plane half. `viewportToScreen` pins
        // the VERTICAL axis (its docstring says why neither of `viewportToOpen`'s branches is
        // right), and a statement needs no measuring, so this path computes no geometry at load.
        const doc = dispatcher.getDocument();
        if (doc.screen) {
            es.viewport = viewportToScreen(doc.screen, { width: el.clientWidth, height: el.clientHeight });
            refresh();
            return;
        }
        const box = contentBounds(computeGeometry(resolveScene(doc)));
        if (!box) return;                        // an empty document has nothing to frame
        es.viewport = viewportToOpen(box, { width: el.clientWidth, height: el.clientHeight },
            FIT_PADDING_PX);
        refresh();
    });

    // Repaint whenever the DOCUMENT changes, from any source, and record which nodes
    // changed so the next compute can reuse the untouched ones. Ephemeral editor state
    // (selection, hover, viewport, drag previews) doesn't flow through the dispatcher,
    // so tools call `refresh()` directly for those (no document nodes are dirtied).
    useEffect(() => dispatcher.onChange(result => {
        if (result.fullReload) {
            es.playingTimeline = false;
            setPreviewClipName("");
        }
        result.updatedNodeIds.forEach(id => dirtyNodesRef.current.add(id));
        refresh();
    }), [dispatcher, refresh]);

    // Bridge the Electron native File menu (no-op in the browser build).
    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;

        const saveTo = (filePath: string) => {
            void projectSession.save(filePath).then(() => setProjectDirty(projectSession.dirty));
        };
        let projectTarget: ProjectFileTarget;

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
                        if (!confirmLeaveProject()) return;
                        runtimeProjectRef.current.reset();
                        audioRef.current?.stop();
                        es.playing = false; es.world = null; es.worldClock = null;
                        dispatcher.loadDocument(createEmptyDocument());
                        meshHydrationGenerationRef.current++;
                        meshLibrary3dRef.current.clear();
                        environmentLibrary3dRef.current.clear();
                        currentFilePathRef.current = null;
                        projectSession.adopt();
                        void projectSession.checkpoint();
                        setFileStatus("");
                        es.selectedNodeIds = [];
                        refresh();
                        return;
                    case "file.save": {
                        saveProject();
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
                    case "edit.instance": createInstance(); return;
                    case "edit.detach": detachInstance(); return;

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
                        if (es.playing || d.clips?.length) return;
                        const removing = !!d.timeline;
                        dispatcher.dispatchAction(new SetTimelineAction(d, d.timeline ? undefined : { frames: 24, fps: 12 }));
                        es.playingTimeline = false;
                        setPreviewClipName("");
                        es.frame = removing ? undefined : 0;
                        refresh();
                        return;
                    }
                    case "view.theme": {
                        const d = dispatcher.getDocument();
                        dispatcher.dispatchAction(new SetActiveThemeAction(d, d.activeTheme === "light" ? "dark" : "light"));
                        refresh();
                        return;
                    }
                    case "view.zoomFit":
                    case "view.zoomSelection": {
                        // A FRAME, not an action: the viewport is editor state, so this changes no
                        // document and takes no history step. `viewportToFit` is the same
                        // arithmetic a prototype NAVIGATE uses — it existed, tested, with nothing
                        // in the editor able to reach it.
                        const el = canvasRef.current;
                        if (!el) return;
                        const d = dispatcher.getDocument();
                        const computed = computeGeometry(resolveScene(d));
                        // SELECTION FALLS BACK TO EVERYTHING. "Fit the selection" with nothing
                        // selected doing nothing at all reads as a broken menu item; framing the
                        // document is close enough to what was meant, and is what every tool does.
                        const box = (command === "view.zoomSelection"
                            ? selectionBounds(computed, es.selectedNodeIds) : null) ?? contentBounds(computed);
                        if (!box) return;                 // an empty document has nothing to frame
                        es.viewport = viewportToFit(box,
                            { width: el.clientWidth, height: el.clientHeight },
                            FIT_PADDING_PX, es.viewport.zoom);
                        refresh();
                        return;
                    }
                    case "view.backend.svg": setBackend("svg"); return;
                    case "view.backend.canvas": setBackend("canvas"); return;
                    case "view.backend.webgl": setBackend("webgl"); return;

                    case "dev.script": setShowScript(v => !v); return;
                    case "dev.tokens": setShowTokens(v => !v); return;
                    case "dev.folders": setShowFolders(v => !v); return;
                    case "dev.exercises": setShowExercises(v => !v); return;
                    case "help.shortcuts": setShowShortcuts(v => !v); return;
                    default: return;
                }
            }),
            bindProjectFileWorkflow(api, projectTarget = {
                dispatcher,
                editorState: es,
                currentFilePath: currentFilePathRef,
                refresh,
                saveTo,
                beforeOpen: confirmLeaveProject,
                reportError: (message, error) => setFileStatus(`${message}: ${String(error)}`),
                afterOpen: ({ filePath }) => {
                    runtimeProjectRef.current.reset();
                    audioRef.current?.stop();
                    es.playing = false; es.world = null; es.worldClock = null;
                    projectSession.adopt();
                    setFileStatus("Opened.");
                    const generation = ++meshHydrationGenerationRef.current;
                    meshLibrary3dRef.current.clear();
                    environmentLibrary3dRef.current.clear();
                    const assets = dispatcher.getDocument().assets3d ?? [];
                    void rehydrateAssets3D(api, filePath, assets).then(({ meshes, failures }) => {
                        if (generation !== meshHydrationGenerationRef.current
                            || currentFilePathRef.current !== filePath) return;
                        // Preserve anything imported while the persisted files were loading.
                        for (const [id, mesh] of meshLibrary3dRef.current) meshes.set(id, mesh);
                        meshLibrary3dRef.current = meshes;
                        for (const failure of failures) {
                            console.warn(`Could not reload 3D asset ${failure.source}: ${failure.error.message}`);
                        }
                        refresh();
                    }).catch(error => console.error("3D asset reload failed:", error));
                    void rehydrateEnvironments3D(api, filePath, assets).then(({ environments, failures }) => {
                        if (generation !== meshHydrationGenerationRef.current
                            || currentFilePathRef.current !== filePath) return;
                        for (const [id, image] of environmentLibrary3dRef.current) environments.set(id, image);
                        environmentLibrary3dRef.current = environments;
                        for (const failure of failures) {
                            console.warn(`Could not reload HDR environment ${failure.source}: ${failure.error.message}`);
                        }
                        refresh();
                    }).catch(error => console.error("HDR environment reload failed:", error));
                }
            })
        ];
        let disposed = false;
        let recoveryReady = false;
        void api.readRecovery().then(snapshot => {
            if (disposed) return;
            if (snapshot && window.confirm("An unsaved recovery snapshot is available. Restore it?")) {
                const result = applyOpenedProject({ filePath: snapshot.filePath ?? "", content: snapshot.content }, projectTarget);
                if (result.ok) {
                    currentFilePathRef.current = snapshot.filePath;
                    projectSession.adopt(snapshot.savedContent);
                    setFileStatus("Recovered unsaved changes. Save to keep them.");
                }
            }
            recoveryReady = true;
        }).catch(error => setFileStatus(`Recovery could not be read; preserved on disk: ${error.message}`));
        const interval = window.setInterval(() => {
            if (recoveryReady) void projectSession.checkpoint();
        }, 5000);
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (!confirmLeaveProject()) { event.preventDefault(); event.returnValue = ""; }
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => {
            disposed = true;
            window.clearInterval(interval);
            window.removeEventListener("beforeunload", beforeUnload);
            disposers.forEach(dispose => dispose());
        };
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
    /**
     * A folder of numbered images as one animated node.
     *
     * THE ACTIONS ARE `sequenceImportActions`, and that is not a stylistic split — it is the same
     * reason `importTiles` uses `tileImportActions`. A node created inside a transaction exists in
     * no document yet, so it cannot be reached through `nodeEdit`'s router; and everything left in
     * this handler is verifiable only by reading it, because `window.electronAPI` is frozen, so the
     * native folder dialog this import starts with can be neither driven nor stubbed from a probe.
     * What lives here is therefore only the placement — where on the canvas, at what size.
     */
    const importSequence = useCallback((name: string, first: string, track: Keyframe[]) => {
        const el = canvasRef.current;
        const w = 200, h = 150;
        const centre = screenToWorld(es.viewport, { left: 0, top: 0 },
            (el ? el.clientWidth : 800) / 2, (el ? el.clientHeight : 600) / 2);
        const doc = dispatcher.getDocument();
        const { actions, id } = sequenceImportActions(doc, {
            name, first, track, x: centre.x - w / 2, y: centre.y - h / 2, width: w, height: h
        });
        if (actions.length === 0) return;
        if (dispatcher.dispatchAction(new TransactionAction(doc, "import-sequence", actions)).success) {
            es.selectedNodeIds = [id];
        }
        refresh();
    }, [dispatcher, es, refresh]);

    /**
     * An `.aseprite` as one node that plays, with the file's OWN timing and its tags as clips.
     *
     * The placement is all that lives here, as with `importSequence` — the actions are
     * `asepriteImportActions`, where a test can reach them. What is different is that this needed
     * three things built underneath it first: a frame compositor, a write path for `Document.clips`,
     * and a transaction able to carry two document-level deltas. None of them was about Aseprite.
     */
    const importAseprite = useCallback((p: AsepritePlacementInput) => {
        const el = canvasRef.current;
        const centre = screenToWorld(es.viewport, { left: 0, top: 0 },
            (el ? el.clientWidth : 800) / 2, (el ? el.clientHeight : 600) / 2);
        const doc = dispatcher.getDocument();
        // THE FILE'S OWN SIZE, unlike the sequence importer's fixed box: an `.aseprite` states its
        // canvas, so inventing 200x150 would stretch pixel art that came with exact dimensions.
        const { actions, id, droppedClips } = asepriteImportActions(doc, {
            ...p, x: centre.x - p.width / 2, y: centre.y - p.height / 2
        });
        if (actions.length === 0) return;
        if (dispatcher.dispatchAction(new TransactionAction(doc, "import-aseprite", actions)).success) {
            es.selectedNodeIds = [id];
        }
        if (droppedClips > 0) {
            console.warn(`${droppedClips} tag(s) named frames outside the file's own timeline and were dropped.`);
        }
        refresh();
    }, [dispatcher, es, refresh]);

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
                spec.geometry.width, spec.geometry.height, flatFill(spec.style.fill), id));
            actions.push(new UpdateNodePathAction(doc, id, spec.path));
        }
        dispatcher.dispatchAction(new TransactionAction(doc, "import-svg", actions));
        es.selectedNodeIds = ids.slice(0, 1);
        refresh();
    }, [dispatcher, es, refresh]);

    /** Import one glTF/GLB as stable authored identity plus transient decoded mesh data. */
    const import3D = useCallback(async (filePath: string, name: string, loaded: LoadedAsset3D) => {
        const api = window.electronAPI;
        const projectFilePath = currentFilePathRef.current;
        if (!api || !projectFilePath) throw new Error("Save the project before importing a 3D model.");
        const relative = await api.project3DSource(projectFilePath, filePath);
        const doc = dispatcher.getDocument();
        const plan = asset3DImportActions(doc, relative, name, generateUUID, loaded.materials);
        if (dispatcher.dispatchAction(new TransactionAction(doc, "import-3d", plan.actions)).success) {
            meshLibrary3dRef.current.set(plan.assetId, loaded.mesh);
            const liveCanvas = canvasRef.current?.firstElementChild;
            if (liveCanvas instanceof HTMLCanvasElement) invalidateWebGL3DSource(liveCanvas, relative);
            es.selectedNodeIds = [plan.modelId];
            setWorkspace("3d");
        }
        refresh();
    }, [dispatcher, es, refresh]);

    const importEnvironment3D = useCallback(async (filePath: string, name: string,
                                                    image: HdrEnvironmentImage) => {
        const api = window.electronAPI, projectFilePath = currentFilePathRef.current;
        if (!api || !projectFilePath) throw new Error("Save the project before importing an HDR environment.");
        const relative = await api.projectEnvironmentSource(projectFilePath, filePath);
        const doc = dispatcher.getDocument();
        const plan = environment3DImportActions(doc, relative, name, generateUUID);
        if (dispatcher.dispatchAction(new TransactionAction(doc, "import-hdr-environment", plan.actions)).success) {
            environmentLibrary3dRef.current.set(plan.assetId, image);
            const liveCanvas = canvasRef.current?.firstElementChild;
            if (liveCanvas instanceof HTMLCanvasElement) invalidateWebGL3DSource(liveCanvas, plan.assetId);
            es.selectedNodeIds = [plan.nodeId]; setWorkspace("3d"); refresh();
        }
    }, [dispatcher, es, refresh]);

    const addBlockout3D = useCallback((kind:BlockoutShape["kind"])=>{
        const doc=dispatcher.getDocument(),id=generateUUID();
        const dimensions={width:4,height:3,depth:kind==="wall"?.2:4};
        const blockout:BlockoutShape=kind==="room"?{kind,...dimensions,thickness:.2,ceiling:false}
            :kind==="stairs"?{kind,...dimensions,steps:8}:{kind,...dimensions};
        const spatial:Spatial3D={transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0,w:1},scale:{x:1,y:1,z:1}},blockout};
        if(dispatcher.dispatchAction(new TransactionAction(doc,"add-blockout-3d",[
            new AddNodeAction(doc,"core.rectangle",0,0,1,1,"none",id),new SetSpatial3DAction(doc,id,spatial)
        ])).success)es.selectedNodeIds=[id];
        refresh();
    },[dispatcher,es,refresh]);

    const addLight3D = useCallback((kind: "directional" | "point") => {
        const doc = dispatcher.getDocument(), id = generateUUID();
        const spatial: Spatial3D = {
            transform: {
                position: kind === "point" ? { x: 2, y: 2, z: 3 } : { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }
            },
            light: kind === "directional"
                ? { kind, color: { x: 1, y: 1, z: 1 }, intensity: 1 }
                : { kind, color: { x: 1, y: 1, z: 1 }, intensity: 10, range: 10 }
        };
        const actions: Action[] = [
            new AddNodeAction(doc, "core.rectangle", 0, 0, 1, 1, "none", id),
            new SetSpatial3DAction(doc, id, spatial)
        ];
        if (dispatcher.dispatchAction(new TransactionAction(doc, `add-${kind}-light-3d`, actions)).success) {
            es.selectedNodeIds = [id];
        }
        refresh();
    }, [dispatcher, es, refresh]);

    const composeSelected2DIn3D = useCallback(() => {
        const doc = dispatcher.getDocument(), id = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
        const selected = id ? doc.nodes.get(id) : undefined;
        if (!id || !selected || selected.spatial3d?.renderable || selected.spatial3d?.blockout || selected.spatial3d?.solidTree) return;
        const spatial: Spatial3D = selected.spatial3d ? copySpatial3D(selected.spatial3d) : {
            transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
                scale: { x: 1, y: 1, z: 1 } }
        };
        spatial.composition2d = spatial.composition2d ?? { mode: "plane", pixelsPerUnit: 100, lit: false };
        dispatcher.dispatchAction(new SetSpatial3DAction(doc, id, spatial)); refresh();
    }, [dispatcher, es, refresh]);

    /**
     * A map as nodes: a whole layer as ONE grid where it fits, and one image per cell where it does
     * not.
     *
     * The actions themselves are `tileImportActions`, which is not a stylistic split — a node created
     * inside a transaction cannot be reached through `nodeEdit`'s router (it exists in no document
     * yet), and this file is guarded against constructing those actions raw. That guard is about
     * VIRTUAL ids, which an import never has; moving the construction to a module that can be tested
     * satisfies it honestly instead of by exemption.
     */
    const importTiles = useCallback((placements: TilePlacement[], tilesets: Tileset[] = [],
                                     background?: string, screen?: { width: number; height: number }) => {
        if (placements.length === 0) return;
        const doc = dispatcher.getDocument();
        const { actions, ids } = tileImportActions(doc, placements);
        // THE TILESETS GO IN THE SAME TRANSACTION as the layers that name them, and they go FIRST.
        // Without this the import produced nodes naming sets the document did not have, so every
        // imported layer drew nothing — which is exactly what shipped for an hour, because the
        // importer built the list and dropped it on the floor. Setting them separately would also
        // be wrong: two undo steps for one import, with a document in between that no author made.
        const withSets = tilesets.length > 0
            ? [new SetTilesetsAction(doc, [...(doc.tilesets ?? []) as Tileset[], ...tilesets]), ...actions]
            : actions;
        // AND THE MAP'S OWN BACKGROUND (schema 70), in the SAME transaction for the same reason the
        // tilesets are: one import is one undo step, and a document that briefly had the layers but
        // not the sky is a state no author ever made. It does NOT overwrite a background the
        // document already has — placing a second map must not repaint the first one's sky, and the
        // map that declares nothing (21 of the 24 here) leaves the field exactly as it found it.
        const withSky = background !== undefined && doc.background === undefined
            ? [new SetBackgroundAction(doc, background), ...withSets]
            : withSets;
        // AND THE MAP'S OWN SIZE AS THE SCREEN (schema 72), by the same two rules: one import is
        // one undo step, and a document that already declares its screen keeps it — a second map
        // must not resize the first one's play area. A Tiled map states exactly this, in tiles.
        const withScreen = screen !== undefined && doc.screen === undefined
            ? [new SetScreenAction(doc, screen), ...withSky]
            : withSky;
        dispatcher.dispatchAction(new TransactionAction(doc, "import-tiles", withScreen));
        es.selectedNodeIds = ids.slice(0, 1);
        refresh();
    }, [dispatcher, es, refresh]);

    /**
     * Snap the selected canvas to a palette.
     *
     * The arithmetic and the patch live in `core/actions/surfaceEdit`, for the reason
     * `tileImportActions` does: a function returning an Action can be tested, and this panel is not
     * the third place the "decode, edit, diff, dispatch" sequence should be written out by hand.
     */
    const quantizeSelection = useCallback((palette: Palette) => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
        if (!id) return;
        // CONFINED TO THE PIXEL SELECTION when there is one. A panel button that ignored the marquee
        // would be the one edit in the app that does — and the author would have no way to quantise
        // just a sprite's shadow.
        const action = quantizeAction(doc, id, palette, pixelMaskFor(es, doc, id));
        // NULL MEANS NOTHING MOVED — a canvas already within the palette must not leave an undo step.
        if (!action) return;
        dispatcher.dispatchAction(action);
        refresh();
    }, [dispatcher, es, refresh]);

    /**
     * Apply a pixel adjustment to the selected canvas, confined to the pixel selection.
     *
     * ONE CALLBACK FOR EVERY ADJUSTMENT, and that is the payoff of the shape `core/paint/Adjust`
     * chose: each of them is already `(buffer) => number`, which is exactly what `surfaceEditAction`
     * takes, so a new adjustment becomes a button by being written — no action, no plumbing, no
     * second copy of "decode, edit, diff, dispatch".
     *
     * THE MASK GOES THROUGH THE SAME DOOR the brush and the bucket read, so an adjustment obeys the
     * marquee. Without it, the one edit that acts on every pixel at once would be the one edit that
     * ignored where the author said to act.
     */
    const applyAdjustment = useCallback((edit: (b: PixelBuffer) => number) => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
        if (!id) return;
        const action = surfaceEditAction(doc, id, edit, pixelMaskFor(es, doc, id));
        // NULL MEANS NOTHING MOVED — an adjustment that changed no pixel must not leave an undo step
        // that undoes nothing, which is the same rule quantise follows.
        if (!action) return;
        dispatcher.dispatchAction(action);
        refresh();
    }, [dispatcher, es, refresh]);

    /**
     * Replace the pixel selection with a function of itself — Select All, Invert, Grow, Shrink, Border.
     *
     * ONE CALLBACK FOR ALL OF THEM, taking the transform rather than a verb, because every one of
     * them is the same three steps: read the CURRENT mask through the validated door, apply a pure
     * function from `paint/Selection`, and write the result back. A callback per button would be five
     * copies of the target rule and five chances to forget that an empty result means no selection.
     *
     * THE FALLBACK IS AN EMPTY MASK, not a refusal: "select all" and "invert" have to work when
     * nothing is selected yet, and those are exactly the two an author reaches for first.
     */
    const reviseSelection = useCallback((make: (current: SelectionMask) => SelectionMask | null) => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
        const surface = id ? doc.nodes.get(id)?.surface : undefined;
        if (!id || !surface) return;
        const current = pixelMaskFor(es, doc, id) ?? emptyMask(surface.width, surface.height);
        const next = make(current);
        // AN EMPTY RESULT IS NO SELECTION, the same rule the tool writes by: both read as "no
        // constraint", and only null makes the marquee vanish.
        es.pixelSelection = next && !isEmptySelection(next) ? { nodeId: id, mask: next } : null;
        refresh();
    }, [dispatcher, es, refresh]);

    /** Copy, optionally clearing through the ordinary undoable surface-action seam. */
    const copyPixelSelection = useCallback((cut: boolean) => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
        const mask = id ? pixelMaskFor(es, doc, id) : null;
        const surface = id ? doc.nodes.get(id)?.surface : undefined;
        if (!id || !mask || !surface) return;
        const buffer = decodeSurface(surface.data, surface.width, surface.height);
        const content = buffer ? copySelectionContent(buffer, mask) : null;
        if (!content) return;
        pixelClipboardRef.current = content;
        if (cut) {
            const action = surfaceEditAction(doc, id, b => clearSelectionContent(b, mask));
            if (action) dispatcher.dispatchAction(action);
        }
        refresh();
    }, [dispatcher, es, refresh]);

    const clearPixelSelection = useCallback(() => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
        const mask = id ? pixelMaskFor(es, doc, id) : null;
        if (!id || !mask) return;
        const action = surfaceEditAction(doc, id, b => clearSelectionContent(b, mask));
        if (action) dispatcher.dispatchAction(action);
        refresh();
    }, [dispatcher, es, refresh]);

    const pastePixelSelection = useCallback(() => {
        const content = pixelClipboardRef.current;
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
        if (!content || !id || !doc.nodes.get(id)?.surface) return;
        let next: SelectionMask | null = null;
        const action = surfaceEditAction(doc, id, b => {
            const result = pasteSelectionContent(b, content);
            next = result.mask;
            return result.changed;
        });
        if (action) dispatcher.dispatchAction(action);
        if (next && !isEmptySelection(next)) es.pixelSelection = { nodeId: id, mask: next };
        refresh();
    }, [dispatcher, es, refresh]);

    const movePixelSelection = useCallback((dx: number, dy: number) => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
        const mask = id ? pixelMaskFor(es, doc, id) : null;
        if (!id || !mask) return;
        let next: SelectionMask | null = null;
        const action = surfaceEditAction(doc, id, b => {
            const result = moveSelectionContent(b, mask, dx, dy);
            next = result?.mask ?? null;
            return result?.changed ?? 0;
        });
        if (action) dispatcher.dispatchAction(action);
        es.pixelSelection = next && !isEmptySelection(next) ? { nodeId: id, mask: next } : null;
        refresh();
    }, [dispatcher, es, refresh]);

    const transformPixelSelection = useCallback((transform: PixelSelectionTransform) => {
        const doc = dispatcher.getDocument();
        const id = es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null;
        const mask = id ? pixelMaskFor(es, doc, id) : null;
        if (!id || !mask) return;
        let next: SelectionMask | null = null;
        const action = surfaceEditAction(doc, id, b => {
            const result = transformSelectionContent(b, mask, transform);
            next = result?.mask ?? null;
            return result?.changed ?? 0;
        });
        if (action) dispatcher.dispatchAction(action);
        es.pixelSelection = next && !isEmptySelection(next) ? { nodeId: id, mask: next } : null;
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
    //
    // THE POINTER SAYS WHICH TOOL IS IN YOUR HAND. Eight tools used to share one arrow: the toolbar
    // knew which was active and the pointer did not, which is the one place a person is looking.
    // `TOOL_CURSORS` covers the tools whose ART EXISTS — brush, bucket, picker, pen, pencil, spray,
    // marquee — and the rest keep their native keyword deliberately: `grab` already says "move" to
    // everybody, and no drawn cursor would say it better.
    // EVERY NAME HERE MUST BE ONE `setTool` CAN RECEIVE, which a test now checks — because a name
    // that is merely a good description of a tool matches nothing and the chain ends in a working
    // `default`, so it cannot fail loudly. `TOOL_CURSORS.pixelSelect` was named after the marquee's
    // tool CLASS and fired for months without firing.
    //
    // ALL EIGHT SHAPE KINDS, not just the rectangle. `setTool` is called with the KIND — the flyout
    // passes `rectangle`, `ellipse`, `text` and so on, and `"shapes"` is only the toolbar SLOT — so
    // naming one kind gave a crosshair to the rectangle and left the other seven on the arrow.
    const canvasCursor = es.hoverCursor
        ?? TOOL_CURSORS[toolName]
        ?? ((SHAPE_KINDS as readonly string[]).includes(toolName)
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

    const toggleRuntime = () => {
        runtimeProjectRef.current.reset();
        audioRef.current?.stop();
        audioRef.current?.unlock();
        es.playingTimeline = false;
        es.playing = !es.playing;
        es.playState = null;
        es.transition = null;
        es.viewportTransition = null;
        if (es.playing) runtimeEntryFrameRef.current = es.frame;
        else es.frame = runtimeEntryFrameRef.current;
        es.world = es.playing ? worldFrom(dispatcher.getDocument()) : null;
        world3dRef.current = es.playing && workspace === "3d"
            ? restartRun3D(dispatcher.getDocument()) : null;
        world3dLastAtRef.current = es.playing && workspace === "3d" ? Date.now() : null;
        es.worldClock = es.playing ? { accumulator: 0, lastAt: Date.now() } : null;
        es.controlled = es.playing
            ? (playerEntityId(dispatcher.getDocument().nodes.values()) ?? es.selectedNodeIds[0] ?? null)
            : null;
        es.input = { left: false, right: false, jump: false };
        setLastEvent(null);
        setRunOutcome(null);
        runOutcomeRef.current = null;
        transitionLoadingRef.current = null;
        prevComputedRef.current = null;
        runBoundsRef.current = null;
        if (es.playing) {
            es.playReturnViewport = { ...es.viewport };
        } else if (es.playReturnViewport) {
            Object.assign(es.viewport, es.playReturnViewport);
            es.playReturnViewport = null;
        }
        if (es.playing) es.selectedNodeIds = [];
        refresh();
    };

    const restartRuntime = () => {
        // Restart the authored entry project, not the last level visited during play.
        runtimeProjectRef.current.reset();
        audioRef.current?.stop();
        es.world = restartRun(dispatcher.getDocument());
        es.controlled = playerEntityId(dispatcher.getDocument().nodes.values());
        es.frame = runtimeEntryFrameRef.current;
        if (workspace === "3d") world3dRef.current = restartRun3D(dispatcher.getDocument());
        world3dLastAtRef.current = workspace === "3d" ? Date.now() : null;
        es.worldClock = { accumulator: 0, lastAt: Date.now() };
        runOutcomeRef.current = null;
        setRunOutcome(null);
        setLastEvent(null);
        transitionLoadingRef.current = null;
        prevComputedRef.current = null;
        runBoundsRef.current = null;
        refresh();
    };

    const respawnRuntime = () => {
        if (!es.world || !es.controlled) return;
        audioRef.current?.stop();
        const runtimeDoc = runtimeProjectRef.current.document ?? dispatcher.getDocument();
        es.world = respawnRun(runtimeDoc, es.world, es.controlled);
        if (workspace === "3d" && world3dRef.current) {
            world3dRef.current = respawnRun3D(runtimeDoc, world3dRef.current, es.controlled);
            world3dLastAtRef.current = Date.now();
        }
        es.worldClock = { accumulator: 0, lastAt: Date.now() };
        runOutcomeRef.current = null;
        setRunOutcome(null);
        setLastEvent(null);
        prevComputedRef.current = null;
        refresh();
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: UI.bg, color: UI.text }}>
            {/* Tools and document commands. Its height is its own again: the tool options moved
                    to their own row below, so nothing this row does can push the canvas around. */}
                <div style={{ display: "flex", alignItems: "center", alignContent: "flex-start", flexWrap: "wrap", rowGap: 4, padding: "4px 8px", background: UI.panel, borderBottom: `1px solid ${UI.line}`, gap: 4 }}>
                <span style={{ fontWeight: 700, marginRight: 8, color: "#00bfff", fontSize: 13 }}>CF</span>
                {workspace==="3d"&&<select aria-label="Add 3D blockout" value="" onChange={event=>{
                    if(event.target.value)addBlockout3D(event.target.value as BlockoutShape["kind"]);
                }}><option value="">Add blockout…</option>{["box","wall","room","ramp","stairs"].map(kind=><option key={kind} value={kind}>{kind}</option>)}</select>}
                <WorkspaceControls
                    workspace={workspace}
                    gizmoMode={gizmoMode3d}
                    gizmoSpace={gizmoSpace3d}
                    canCompose2D={es.selectedNodeIds.length === 1
                        && !dispatcher.getDocument().nodes.get(es.selectedNodeIds[0])?.spatial3d?.renderable
                        && !dispatcher.getDocument().nodes.get(es.selectedNodeIds[0])?.spatial3d?.blockout
                        && !dispatcher.getDocument().nodes.get(es.selectedNodeIds[0])?.spatial3d?.solidTree}
                    onWorkspaceChange={pickWorkspace}
                    onGizmoModeChange={mode => {
                        gizmoMode3dRef.current = mode;
                        setGizmoMode3d(mode);
                        if (mode === "scale") {
                            gizmoSpace3dRef.current = "local";
                            setGizmoSpace3d("local");
                        }
                    }}
                    onGizmoSpaceChange={space => {
                        gizmoSpace3dRef.current = space;
                        setGizmoSpace3d(space);
                    }}
                    onAddLight={addLight3D}
                    onCompose2D={composeSelected2DIn3D}
                />
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
                                <Divider />
                <RuntimeControls
                    playing={es.playing}
                    canRestart={!!es.world}
                    canRespawn={runOutcome === "lost" && !!es.controlled}
                    onTogglePlay={toggleRuntime}
                    onRestart={restartRuntime}
                    onRespawn={respawnRuntime}
                />
                <Divider />
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
                {/* THE DEBUG CONTROLS ARE NOT HERE ANY MORE. Design tokens, the script console,
                    asset folders, the renderer switch and the demo exercises all moved to the
                    Developer menu — the renderer switch especially, which changes what a user sees
                    for no reason they can name and sat at the same weight as Save.
                    Theme, Timeline and Light stay because they are FEATURES, not debugging. They
                    are in the View menu as well, which is where a newcomer looks first. */}
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
                                                                                {/* A document has no clock until somebody asks for one, so a still drawing carries
                    no timeline strip and serialises exactly as it did before animation existed. */}
                <button
                    title={dispatcher.getDocument().clips?.length ? "Remove named clips before removing their timeline" : "Give this document a timeline (24 frames at 12fps), or take it away again"}
                    disabled={es.playing || !!dispatcher.getDocument().clips?.length}
                    onClick={() => {
                        const d = dispatcher.getDocument();
                        if (es.playing || d.clips?.length) return;
                        const removing = !!d.timeline;
                        dispatcher.dispatchAction(new SetTimelineAction(d, d.timeline ? undefined : { frames: 24, fps: 12 }));
                        es.playingTimeline = false;
                        setPreviewClipName("");
                        es.frame = removing ? undefined : 0;
                        refresh();
                    }}
                    style={{ fontSize: 11, padding: "3px 8px", marginLeft: 4, background: "transparent",
                             color: dispatcher.getDocument().timeline ? UI.accent : "#ccc",
                             border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                >⏱ Timeline</button>
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
                {/* THE DOCUMENT'S BACKGROUND (schema 70), and a real colour input rather than a
                    toggle: the field is a colour, so the control that sets it should be one. A
                    document with no sky shows the swatch at the editor's own backdrop and the
                    CLEAR button is what puts it back to absent — absent and "the same colour the
                    editor happens to use" are different documents, and only one of them exports. */}
                <input
                    type="color"
                    data-doc-background="1"
                    title="What the document sits on. Exported, drawn by all three backends, and read from a Tiled map's backgroundcolor."
                    value={dispatcher.getDocument().background ?? "#1a1a2e"}
                    onChange={e => {
                        dispatcher.dispatchAction(
                            new SetBackgroundAction(dispatcher.getDocument(), e.target.value));
                        refresh();
                    }}
                    style={{ width: 26, height: 20, marginLeft: 4, padding: 0, background: "transparent",
                             border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer",
                             verticalAlign: "middle" }}
                />
                {dispatcher.getDocument().background !== undefined && (
                    <button
                        data-doc-background-clear="1"
                        title="Remove the background, so the document has none at all again."
                        onClick={() => {
                            dispatcher.dispatchAction(
                                new SetBackgroundAction(dispatcher.getDocument(), undefined));
                            refresh();
                        }}
                        style={{ fontSize: 11, padding: "3px 6px", marginLeft: 2, background: "transparent",
                                 color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                    >✕</button>
                )}
                {/* ONE SCREEN OF THE GAME (schema 72), drawn on the canvas as a translucent
                    outline. TWO NUMBER FIELDS rather than a picker, because the field is a size.
                    Absent shows both empty; committing a size on an empty document declares one,
                    and the CLEAR button puts it back to undeclared — the pre-72 state, which is
                    a different document from any declared size. */}
                <span title="One screen of the game: the play area's size, drawn as an outline on the canvas. The camera and death plane will read this in a later slice."
                      style={{ marginLeft: 8, fontSize: 11, color: "#888" }}>screen</span>
                <input
                    type="number" min={1} data-doc-screen="w" placeholder="w"
                    value={dispatcher.getDocument().screen?.width ?? ""}
                    onChange={e => {
                        const w = Number(e.target.value);
                        const now = dispatcher.getDocument().screen;
                        if (!Number.isFinite(w) || w <= 0) return;
                        dispatcher.dispatchAction(new SetScreenAction(dispatcher.getDocument(),
                            { width: w, height: now?.height ?? w }));
                        refresh();
                    }}
                    style={{ width: 46, fontSize: 11, marginLeft: 3, padding: "2px 3px", background: "transparent",
                             color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3 }}
                />
                <input
                    type="number" min={1} data-doc-screen="h" placeholder="h"
                    value={dispatcher.getDocument().screen?.height ?? ""}
                    onChange={e => {
                        const h = Number(e.target.value);
                        const now = dispatcher.getDocument().screen;
                        if (!Number.isFinite(h) || h <= 0) return;
                        dispatcher.dispatchAction(new SetScreenAction(dispatcher.getDocument(),
                            { width: now?.width ?? h, height: h }));
                        refresh();
                    }}
                    style={{ width: 46, fontSize: 11, marginLeft: 2, padding: "2px 3px", background: "transparent",
                             color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3 }}
                />
                {dispatcher.getDocument().screen !== undefined && (
                    <button
                        data-doc-screen-clear="1"
                        title="Remove the screen declaration, so the document has none again."
                        onClick={() => {
                            dispatcher.dispatchAction(new SetScreenAction(dispatcher.getDocument(), undefined));
                            refresh();
                        }}
                        style={{ fontSize: 11, padding: "3px 6px", marginLeft: 2, background: "transparent",
                                 color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer" }}
                    >✕</button>
                )}
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
                        saveProject();
                    }}
                    style={{ fontSize: 11, padding: "3px 8px", background: "#00bfff", color: "#000", border: "none", borderRadius: 3, cursor: "pointer" }}
                >
                    Save
                </button>
                <span role="status" style={{ fontSize: 11, marginLeft: 8, color: "#ffcf88" }}>{fileStatus}</span>
                {projectDirty && <span style={{ fontSize: 11, marginLeft: 8 }}>Unsaved changes</span>}
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
                {/* THE EYEDROPPER SHARES THIS ROW, because it shares the swatch. Picking a colour
                    you cannot then see is picking nothing you can act on — the tool sets the brush
                    colour, so the brush colour has to be on screen while it is selected. Found by
                    driving it: choosing the eyedropper hid the very control it writes to. */}
                {/* THE BUCKET SHARES THIS ROW TOO, and for the same reason the eyedropper does:
                    it fills with the swatch colour and honours the erase toggle, so a bucket
                    whose colour is off screen is a click with an invisible outcome. Found the
                    first time by driving the eyedropper, which hid the very control it writes
                    to — the lesson generalises to every tool that reads the swatch. */}
                {(toolName === "paint" || toolName === "eyedropper" || toolName === "bucket") && (
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
                        {/* THE SWATCH IS VISIBLE TO THE EYEDROPPER even with no canvas selected.
                            Everything else on this row acts on a raster and is rightly hidden
                            without one — but the eyedropper's whole output is this colour, and a
                            tool whose result you cannot see is a tool you cannot trust. Found by
                            driving it: the pick worked and there was nowhere for it to show. */}
                        {(selectedRasterId || toolName === "eyedropper") && (<>
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
                        {/* AN IMAGE AS THE STAMP. Several become VARIANTS: one is picked per dab,
                            from the press point, so the same drag leaves the same marks and two
                            drags differ. This is what `pickFace` has been waiting for since it was
                            written. */}
                        <button
                            aria-label="Add brush face"
                            title="Use the selected canvas as a brush stamp. Add several and each dab picks one."
                            disabled={!selectedRasterId}
                            onClick={() => {
                                const node = selectedRasterId
                                    ? dispatcher.getDocument().nodes.get(selectedRasterId) : undefined;
                                const stored = node?.surface;
                                if (!stored) return;
                                const buffer = decodeSurface(stored.data, stored.width, stored.height);
                                if (!buffer) return;
                                const face = brushFromImage(buffer);
                                // AN EMPTY CANVAS IS NOT A BRUSH: every pixel transparent means no
                                // dabs, and a stroke with it paints nothing while looking armed.
                                if (face.dabs.length === 0) return;
                                setBrushFaces(f => [...f, face]);
                            }}
                            style={ADJUST_BUTTON}
                        >+ face</button>
                        {brushFaces.length > 0 && (
                            <button
                                aria-label="Clear brush faces"
                                title="Back to the round or square brush"
                                onClick={() => setBrushFaces([])}
                                style={ADJUST_BUTTON}
                            >{brushFaces.length} face{brushFaces.length === 1 ? "" : "s"} ×</button>
                        )}
                        {/* Mirrored drawing: one stroke paints two, four, or one. */}
                        <ToolButton icon="⇋" label="Mirror H" active={symmetry.horizontal}
                            onClick={() => setSymmetry(m => ({ ...m, horizontal: !m.horizontal }))} />
                        <ToolButton icon="⇵" label="Mirror V" active={symmetry.vertical}
                            onClick={() => setSymmetry(m => ({ ...m, vertical: !m.vertical }))} />
                        </>
                        )}
                    </>
                )}
                {/* THE MARQUEE'S OWN ROW. It shares nothing with the brush: no colour, no size, no
                    mirror — a selection is not paint. What it does share is the "select a canvas"
                    refusal, because it acts on ONE raster's pixels for the same reason the brush
                    does, and a tool you can pick that silently does nothing reads as broken. */}
                {toolName === "marquee" && (
                    <>
                        {!selectedRasterId && (
                            <span style={{ fontSize: 11, color: UI.accent, display: "flex",
                                alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                                <span aria-hidden="true">⬚</span>
                                Select a canvas first — a pixel selection belongs to one surface
                            </span>
                        )}
                        {selectedRasterId && (<>
                            {/* THE FOUR SHAPES. One tool, four modes — the target rule, the base
                                mask and the combine are identical, and only the shape function
                                differs. */}
                            {([["rect", "▭", "Rectangle"], ["ellipse", "◯", "Ellipse"],
                               ["lasso", "➰", "Lasso"], ["wand", "✧", "Magic wand"]] as const).map(
                                ([mode, icon, label]) => (
                                    <ToolButton key={mode} icon={icon} label={label}
                                        active={selectMode === mode}
                                        onClick={() => setSelectMode(mode)} />
                                ))}
                            {/* WAND ONLY. A tolerance for a rectangle means nothing, and a control
                                whose value is ignored is worse than no control — the same rule the
                                polygon's side count and the outline width follow. */}
                            {selectMode === "wand" && (<>
                                <label style={{ fontSize: 10, color: UI.textFaint, display: "flex",
                                    alignItems: "center", gap: 3 }}>
                                    tol
                                    <input
                                        type="number" min={0} max={WAND_TOLERANCE_MAX} step={1}
                                        aria-label="Wand tolerance"
                                        data-testid="wand-tolerance"
                                        title="How far a colour may differ and still match, summed over all four channels. 0 is exact."
                                        value={wandTolerance}
                                        onChange={e => setWandTolerance(Math.max(0, Math.min(WAND_TOLERANCE_MAX,
                                            Math.round(Number(e.target.value) || 0))))}
                                        style={{ width: 44, background: UI.bg, color: UI.text,
                                            border: `1px solid ${UI.line}` }}
                                    />
                                </label>
                                <ToolButton icon="⛓" label="Contiguous" active={wandContiguous}
                                    onClick={() => setWandContiguous(v => !v)} />
                            </>)}
                            {/* WHAT THE MODIFIERS DO, said where the tool is. Four operators with no
                                on-screen home would be four gestures nobody discovers. */}
                            <span style={{ fontSize: 10, color: UI.textFaint, whiteSpace: "nowrap" }}>
                                shift adds · alt subtracts · both intersect · click to deselect
                            </span>
                            {/* THE WHOLE-SELECTION VERBS, which is what makes `fullMask`,
                                `invertSelection`, `growSelection` and `borderSelection` reachable —
                                arithmetic with no caller is what the feature audit exists to find. */}
                            <span data-selection-count="1" style={{ fontSize: 10, color: UI.textFaint,
                                whiteSpace: "nowrap", marginLeft: 4 }}>
                                {pixelSelectionCount === null ? "none" : `${pixelSelectionCount} px`}
                            </span>
                            <ToolButton icon="▣" label="Select all pixels"
                                onClick={() => reviseSelection(m => fullMask(m.width, m.height))} />
                            <ToolButton icon="▢" label="Deselect"
                                onClick={() => reviseSelection(() => null)} />
                            <ToolButton icon="⧉" label="Invert selection"
                                onClick={() => reviseSelection(invertSelection)} />
                            <ToolButton icon="＋" label="Grow selection by a pixel"
                                onClick={() => reviseSelection(m => growSelection(m, 1))} />
                            <ToolButton icon="－" label="Shrink selection by a pixel"
                                onClick={() => reviseSelection(m => growSelection(m, -1))} />
                            <ToolButton icon="◌" label="Border of the selection"
                                onClick={() => reviseSelection(m => borderSelection(m, 1))} />
                            <ToolButton icon="⧉" label="Copy selected pixels"
                                onClick={() => copyPixelSelection(false)} />
                            <ToolButton icon="✂" label="Cut selected pixels"
                                onClick={() => copyPixelSelection(true)} />
                            <ToolButton icon="▤" label="Paste pixels at their copied position"
                                onClick={pastePixelSelection} />
                            <ToolButton icon="⌫" label="Clear selected pixels"
                                onClick={clearPixelSelection} />
                            <ToolButton icon="←" label="Move selected pixels left"
                                onClick={() => movePixelSelection(-1, 0)} />
                            <ToolButton icon="→" label="Move selected pixels right"
                                onClick={() => movePixelSelection(1, 0)} />
                            <ToolButton icon="↑" label="Move selected pixels up"
                                onClick={() => movePixelSelection(0, -1)} />
                            <ToolButton icon="↓" label="Move selected pixels down"
                                onClick={() => movePixelSelection(0, 1)} />
                            <ToolButton icon="↔" label="Flip selected pixels horizontally"
                                onClick={() => transformPixelSelection("flip-horizontal")} />
                            <ToolButton icon="↕" label="Flip selected pixels vertically"
                                onClick={() => transformPixelSelection("flip-vertical")} />
                            <ToolButton icon="↻" label="Rotate selected pixels clockwise"
                                onClick={() => transformPixelSelection("rotate-clockwise")} />
                        </>)}
                    </>
                )}
                {/* THE GPU BACKEND FELL BACK, said where a person will see it. Not a toast and not a
                    console line: this stays up for as long as it is true, because the thing it is
                    reporting is a state the app is IN, not an event that happened. It sits at the
                    end of the row rather than beside the tool controls — it belongs to the window,
                    not to whatever tool is selected — and carries the driver's own words in its
                    tooltip, which is what turns "it fell back" into something anyone can fix. */}
                {glFallback !== null && (
                    <span
                        data-gl-fallback="1"
                        title={`WebGL could not be used: ${glFallback}`}
                        style={{ fontSize: 10, color: "#ffb454", marginLeft: "auto",
                            whiteSpace: "nowrap", cursor: "help" }}
                    >
                        ⚠ WebGL unavailable — drawing with Canvas
                    </span>
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
                {/* THE TOOL STRIP. Every editor a person arrives from puts the tools in a narrow
                    column beside the canvas — Photoshop, Illustrator, Aseprite, Krita, Blender,
                    Figma's cluster — and they are not all copying each other by accident. A tool is
                    reached constantly and reached BY POSITION, so it wants a place that never moves
                    and never competes with the document's own commands for room.
                    Five slots, because the eight shapes already collapsed into one. */}
                <div style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                    padding: "4px 3px", flexShrink: 0,
                    // FIXED WIDTH, for the reason the options row has a fixed height: the Design
                    // workspace's shape slot carries a caret and the others do not, so a strip
                    // sized to its contents was 48px in one workspace and 37px in the next — and
                    // the canvas slid sideways every time you switched jobs.
                    width: 48, boxSizing: "border-box",
                    background: UI.panel, borderRight: `1px solid ${UI.line}`
                }}>
                    {/* THE WORKSPACE DECIDES WHAT IS HERE. Driven off `workspaceDef.tools`, which
                        is also the order, so the list and the layout cannot disagree. */}
                    {workspaceDef.tools.map(slot => {
                        if (slot === "shapes") return (
                            <ShapeFlyout
                                key="shapes"
                                current={lastShape}
                                active={(SHAPE_KINDS as readonly string[]).includes(toolName)}
                                icons={SHAPE_ICONS}
                                compact
                                onPick={kind => { setLastShape(kind); setTool(kind); }}
                            />
                        );
                        // `raster` is a SHAPE kind promoted to its own slot in the Paint
                        // workspace: drawing a canvas and painting on it are one job, and burying
                        // the first behind a flyout is what made the second look broken.
                        const spec: Record<string, { icon: string; label: string }> = {
                            select: { icon: "↗", label: "Select" },
                            move: { icon: "↔", label: "Move" },
                            pen: { icon: "✒", label: "Pen" },
                            paint: { icon: "✏", label: "Paint" },
                            raster: { icon: SHAPE_ICONS.raster, label: "Canvas" },
                            weights: { icon: "◑", label: "Weights" },
                            eyedropper: { icon: "⌖", label: "Eyedropper" },
                            tiles: { icon: "▦", label: "Tiles" },
                            bucket: { icon: "◍", label: "Bucket" },
                            marquee: { icon: "⬚", label: "Select pixels" }
                        };
                        const t = spec[slot];
                        if (!t) return null;
                        return (
                            <ToolButton key={slot} icon={t.icon} label={t.label} compact
                                active={toolName === slot} onClick={() => setTool(slot)} />
                        );
                    })}
                </div>
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
                    {/* THE RUN'S HUD (M18 slice 37): tallies, power tier, star countdown — over
                        the canvas only while a world runs, reading `runReadout` fresh each frame
                        (the play loop already repaints every frame). This is the smallest honest
                        surface for state that was otherwise visible only in a debugger — the same
                        reasoning as the event status line, one shelf up. */}
                    {es.playing && es.world && (() => {
                        const r = runReadout(es.world, es.controlled);
                        if (r.tallies.length === 0 && r.power === 0 && r.starLeft === 0) return null;
                        return (
                            <div data-run-hud="1" style={{ position: "absolute", top: 8, left: 8,
                                display: "flex", gap: 10, padding: "4px 10px", borderRadius: 4,
                                background: "rgba(10, 10, 24, 0.72)", color: "#eee", fontSize: 12,
                                fontFamily: "monospace", pointerEvents: "none", zIndex: 5 }}>
                                {r.tallies.map(([k, n]) => (
                                    <span key={k} data-hud-tally={k}>{k} ×{n}</span>
                                ))}
                                {r.power > 0 && <span data-hud-power={r.power}>POWER {r.power}</span>}
                                {r.starLeft > 0 && (
                                    <span data-hud-star="1" style={{ color: "#f8d838" }}>
                                        STAR {r.starLeft.toFixed(1)}s
                                    </span>
                                )}
                            </div>
                        );
                    })()}
                    {/* IN-PLACE TEXT EDITING. A real textarea laid over the node by the same
                        transform the renderer places it with, so the caret is in the letters
                        rather than beside them. */}
                    <CanvasTextEditor
                        nodeId={editingTextId}
                        doc={dispatcher.getDocument()}
                        viewport={vp}
                        onChange={text => { editContent({ text }); refresh(); }}
                        onDone={() => { setEditingTextId(null); refresh(); }}
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
                {showShortcuts && (
                    <div style={{ width: 230, background: UI.panel, borderLeft: `1px solid ${UI.line}`, padding: 10, overflow: "auto" }}>
                        <div style={PANEL_HEADING}>Keyboard shortcuts</div>
                        {/* BUILT FROM `SHORTCUT_HELP`, which lives beside the bindings themselves.
                            A sheet assembled anywhere else drifts the first time a binding changes,
                            and a shortcut sheet that lies is worse than none — it teaches a key
                            that does nothing. A test holds the two together. */}
                        <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                            <tbody>
                                {SHORTCUT_HELP.map(row => (
                                    <tr key={row.keys}>
                                        <td style={{ padding: "3px 6px 3px 0", color: UI.accent,
                                            whiteSpace: "nowrap", verticalAlign: "top",
                                            fontFamily: "ui-monospace, Consolas, monospace" }}>{row.keys}</td>
                                        <td style={{ padding: "3px 0", color: "#ccc" }}>{row.does}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {showExercises && (
                    <div style={{ width: 200, background: UI.panel, borderLeft: `1px solid ${UI.line}`, padding: 10, overflow: "auto" }}>
                        <div style={PANEL_HEADING}>Exercises</div>
                        <p style={{ fontSize: 10, color: UI.textFaint, margin: "0 0 8px", lineHeight: 1.5 }}>
                            The classics animators learn on. Each stresses a different capability, and
                            building them is how the engine&apos;s holes get found.
                        </p>
                        {DEMOS.map(d => (
                            <button
                                key={d.name}
                                onClick={() => {
                                    // LOADED like any other document, through the same path a file
                                    // takes, so a demo cannot pass by being special-cased. If one of
                                    // these will not load, neither will somebody's work.
                                    dispatcher.loadDocument(d.build());
                                    es.selectedNodeIds = [];
                                    es.frame = 0;
                                    refresh();
                                }}
                                style={{ display: "block", width: "100%", textAlign: "left", fontSize: 11,
                                    padding: "4px 6px", marginBottom: 2, background: "transparent",
                                    color: "#ccc", border: `1px solid ${UI.line}`, borderRadius: 3,
                                    cursor: "pointer" }}
                            >{d.name}</button>
                        ))}
                    </div>
                )}
                {showFolders && (
                    <div style={{ width: 240, background: UI.panel, borderLeft: `1px solid ${UI.line}`, padding: 10, overflow: "auto" }}>
                        <div style={PANEL_HEADING}>Folders</div>
                        <FoldersDrawer
                            getProjectPath={() => currentFilePathRef.current}
                            onPlaceImage={placeAsset}
                            getDocument={() => dispatcher.getDocument()}
                            /* An import acts on the selected node only when it IS an image with a
                               source — there is nothing to slice into a shape that has no pixels. */
                            selectedImage={node && node.type === "core.image" && node.src
                                ? { id: node.id, src: node.src } : null}
                            onImportTrack={importTrack}
                            onImportSequence={importSequence}
                            onImportAseprite={importAseprite}
                            onImportSvg={importSvg}
                            onImport3D={import3D}
                            onImportEnvironment3D={importEnvironment3D}
                            editContentFont={family => { editSelected({ style: { fontFamily: family } }); refresh(); }}
                            onImportTiles={importTiles}
                            paintColour={paintColour}
                            onPickColour={hex => { setPaintColour(hex); setErasing(false); }}
                            selectedRasterId={selectedRasterId}
                            onQuantize={quantizeSelection}
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

                            {workspace === "3d" && node.spatial3d && (
                                <ThreeDInspector
                                    node={node as Node}
                                    assets={dispatcher.getDocument().assets3d ?? []}
                                    meshes={meshLibrary3dRef.current}
                                    onChange={(spatial, coalesce) => {
                                        const current = dispatcher.getDocument();
                                        if (!current.nodes.get(selectedNodeId)?.spatial3d) return;
                                        dispatcher.dispatchAction(
                                            new SetSpatial3DAction(current, selectedNodeId, spatial),
                                            coalesce ? { coalesce: true } : undefined
                                        );
                                        refresh();
                                    }}
                                />
                            )}


                            {/* Authored metadata (schema 64): the author's own kind for this node,
                                and properties this engine carries without reading. The reason it is
                                here rather than nowhere is that 41 of them were being parsed out of
                                every imported map and dropped for want of a field — and a field with
                                no way to edit it would be the same gap one layer down. */}
                            <InspectorSection title="Metadata">
                                <MetadataSection node={node as Node} dispatcher={dispatcher} refresh={refresh} />
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
                                    radians. Transform overrides exist, but this direct inspector field is
                                    still disabled for virtual instance children until it routes through
                                    the component override action seam. */}
                                <label style={INSPECTOR_LABEL}>Rotation°</label>
                                <NumInput
                                    value={Math.round(((node.transform?.rotation ?? 0) * 180 / Math.PI) * 10) / 10}
                                    disabled={isVirtualId(selectedNodeId)}
                                    onChange={v => { editTransform({ rotation: v * Math.PI / 180 }); refresh(); }}
                                />
                            </InspectorSection>

                            <InspectorSection title="Appearance">
                                <label style={INSPECTOR_LABEL}>Fill</label>
                                {/* SOLID or GRADIENT (schema 56). Two buttons rather than a
                                    checkbox, because the two states have different controls under
                                    them and a checkbox reads as a modifier of one set. Going to a
                                    gradient keeps the colour at both ends — see
                                    `gradientFromColor` — so the shape does not jump; coming back
                                    takes the first stop, which is what every surface that cannot
                                    paint a ramp already shows. */}
                                <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                                    {(["solid", "gradient"] as const).map(mode => {
                                        const isGradient = typeof node.style.fill !== "string";
                                        const on = mode === (isGradient ? "gradient" : "solid");
                                        return (
                                            <button
                                                key={mode}
                                                onClick={() => {
                                                    if (on) return;
                                                    editSelected({ style: { fill: mode === "gradient"
                                                        ? gradientFromColor(flatFill(node.style.fill))
                                                        : flatFill(node.style.fill) } });
                                                    refresh();
                                                }}
                                                style={{
                                                    flex: 1, fontSize: 10, padding: "2px 0", borderRadius: 2, cursor: "pointer",
                                                    background: on ? UI.accentSoft : "transparent",
                                                    color: on ? UI.text : UI.textDim,
                                                    border: `1px solid ${on ? UI.accent : UI.line}`
                                                }}
                                            >{mode}</button>
                                        );
                                    })}
                                </div>
                                {typeof node.style.fill !== "string" ? (
                                    <GradientEditor
                                        gradient={node.style.fill as Gradient}
                                        onChange={(next, coalesce) => {
                                            // The SAME dispatch path a colour takes; `coalesce`
                                            // is what makes a whole drag one undo and a click on
                                            // the ramp its own.
                                            const d = dispatcher.getDocument();
                                            const action = styleActionFor(d, selectedNodeId!, { fill: next });
                                            if (action) dispatcher.dispatchAction(action, { coalesce });
                                            refresh();
                                        }}
                                    />
                                ) : (<>
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
                                </>)}
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
                                                // COPIED, not rebuilt field by field: writing
                                                // { x, y, z } silently unbound every point this
                                                // touched the moment bindings existed — the same way
                                                // the mesh DRAG did, and the same way
                                                // UpdateNodeContentAction dropped nine-slice.
                                                const points = stored.mesh.points.map((p, i) => {
                                                    const col = i % (cols + 1), row = Math.floor(i / (cols + 1));
                                                    const edge = col === 0 || row === 0 || col === cols || row === rows;
                                                    return { ...copyMeshPoint(p), z: edge ? 0 : v };
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
                                    {/* BLEND MODE (schema 60). Three modes, because the corpus uses
                                        three: of 5,279 SVGs, 65 blend and they name only overlay,
                                        multiply and screen. "normal" is the empty value rather than
                                        an entry, because absent IS normal. */}
                                    <div><label style={INSPECTOR_LABEL}>Blend</label>
                                        <select
                                            value={node.style.blendMode ?? ""}
                                            title="How this shape's colour combines with what is behind it."
                                            onChange={e => {
                                                const v = e.target.value;
                                                editSelected({ style: { blendMode: v === "" ? undefined : v as BlendMode } });
                                                refresh();
                                            }}
                                            style={{ ...SELECT_STYLE, width: "100%" }}
                                        >
                                            <option value="">normal</option>
                                            {BLEND_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                                        </select></div>
                                    {/* CLIP CONTENT (schema 59). Only offered where it can mean
                                        something: a node with no children has nothing inside to
                                        cut, and the flag would be an offscreen target on the GPU
                                        bought for nothing. */}
                                    {node.children.length > 0 && (
                                        <div style={{ gridColumn: "1 / -1" }}>
                                            <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, color: "#aaa" }}
                                                   title="Cut this frame's children to its own box, corner radius included. What is hidden also stops being clickable.">
                                                <input
                                                    type="checkbox"
                                                    checked={node.clipsContent === true}
                                                    onChange={e => {
                                                        const id = es.selectedNodeIds[0];
                                                        if (id) dispatcher.dispatchAction(new UpdateNodeContentAction(
                                                            dispatcher.getDocument(), id, { clipsContent: e.target.checked }));
                                                        refresh();
                                                    }}
                                                />
                                                Clip content
                                            </label>
                                        </div>
                                    )}
                                    <div><label style={INSPECTOR_LABEL}>Radius</label>
                                        <NumInput
                                            value={typeof node.style.radius === "number" ? node.style.radius : 0}
                                            onChange={v => { editSelected({ style: { radius: Math.max(0, v) } }); refresh(); }}
                                        /></div>
                                </div>
                                {/* THE WEIGHT BRUSH (schema 58). Shown for any selected mesh, with
                                    NO control point picked first: a brush acts on a region, and
                                    making the author choose a point before painting over several
                                    would be asking for the thing the brush exists to avoid. */}
                                {(() => {
                                    const stored = dispatcher.getDocument().nodes.get(node.id);
                                    if (!stored?.mesh) return null;
                                    const siblings = boneChoices(dispatcher.getDocument(), node.id);
                                    if (siblings.length === 0) return null;
                                    const label = (id: string) => {
                                        const n = dispatcher.getDocument().nodes.get(id);
                                        return n ? (n.name || nodeTypeLabels[n.type] || n.type) : id;
                                    };
                                    return (
                                        <div style={{ marginTop: 8 }}>
                                            <label style={INSPECTOR_LABEL}>Weight brush</label>
                                            <select
                                                value={weightBone && siblings.includes(weightBone) ? weightBone : ""}
                                                title="Which bone the brush paints. Nothing is painted until one is chosen."
                                                onChange={e => setWeightBone(e.target.value || null)}
                                                style={{ ...SELECT_STYLE, width: "100%", marginTop: 4 }}
                                            >
                                                <option value="">pick a bone to paint…</option>
                                                {siblings.map(id => <option key={id} value={id}>{label(id)}</option>)}
                                            </select>
                                            <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                                                <span style={{ color: "#888", fontSize: 11, width: 34 }}>size</span>
                                                <input type="range" min={4} max={400} step={1} value={weightRadius}
                                                       title="Brush radius, in world units — the same ruler the canvas is measured in, so it does not change meaning when you zoom."
                                                       onChange={e => setWeightRadius(parseInt(e.target.value, 10))}
                                                       style={{ flex: 1 }} />
                                                <span style={{ width: 30, textAlign: "right", color: "#888", fontSize: 11 }}>{weightRadius}</span>
                                            </div>
                                            <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                                                <span style={{ color: "#888", fontSize: 11, width: 34 }}>flow</span>
                                                <input type="range" min={0.02} max={1} step={0.01} value={weightStrength}
                                                       title="How far one dab moves a point toward the bone. Strokes build up, so a low value is a finer instrument rather than a slower one."
                                                       onChange={e => setWeightStrength(parseFloat(e.target.value))}
                                                       style={{ flex: 1 }} />
                                                <span style={{ width: 30, textAlign: "right", color: "#888", fontSize: 11 }}>{weightStrength.toFixed(2)}</span>
                                            </div>
                                            <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, color: "#aaa" }}>
                                                <input type="checkbox" checked={weightErasing}
                                                       onChange={e => setWeightErasing(e.target.checked)} />
                                                erase (paint the bone away)
                                            </label>
                                        </div>
                                    );
                                })()}
                                {/* THE TILE BRUSH (schema 61). Shown for any selected tilemap, and
                                    it is the whole reason the node became editable: a map could be
                                    imported and drawn with no way to choose a tile, which is a
                                    picture rather than a document.

                                    THE PICKER IS THE SHEET ITSELF, at 1:1 in a scrolling box, with
                                    the chosen tile ringed. A list of index numbers would be exactly
                                    as correct and useless — an author picks a tile by looking at it.
                                    Where each tile sits comes from `tileSourceRect`, the same
                                    function the renderer slices with, so the ring cannot land
                                    somewhere the paint does not. */}
                                {(() => {
                                    const stored = dispatcher.getDocument().nodes.get(node.id);
                                    const map = stored?.tilemap;
                                    if (!stored || stored.type !== "core.tilemap" || !map) return null;
                                    // THE SHEET IS THE TILESET'S NOW (schema 67), and until this line
                                    // was fixed the WHOLE PANEL returned null without one — so a
                                    // layer pointed at a COLLECTION set, or at a tileset somebody
                                    // deleted, lost every control it had INCLUDING the dropdown that
                                    // would point it somewhere else. A dead end you can walk into
                                    // with one click of a picker and cannot walk back out of.
                                    //
                                    // Only the SHEET-SHAPED parts are conditional now: the selection
                                    // ring is a rectangle in a sheet, and a collection has no sheet
                                    // to put one in — it gets its own palette below instead.
                                    const mapSet = findTileset(dispatcher.getDocument().tilesets, map.tilesetId);
                                    const ring = mapSet?.sheet ? sheetTileRect(mapSet.sheet, tileIndex) : null;
                                    /**
                                     * TERRAIN (schema 63). Without art a terrain layer draws
                                     * NOTHING — the derivation has no tile to put anywhere — so the
                                     * six class pickers are not a refinement of this feature, they
                                     * are the feature. Each class stands for its whole orbit under
                                     * the symmetries of a square, which is why six buttons cover
                                     * sixteen neighbourhoods.
                                     */
                                    const classes = autotileClasses();
                                    // WHICH MATERIAL'S ART is now a question — a layer can draw
                                    // several, in paint order — so the panel edits the one selected.
                                    const mats = map.terrain?.materials ?? [];
                                    const activeMat = mats.find(m => m.id === tileMaterial) ?? mats[0];
                                    const artFor = (mask: number) =>
                                        activeMat?.art.find(a => a.mask === mask)?.index ?? null;
                                    /** A 2x2 picture of which corners a class holds — the mask, drawn. */
                                    const maskSwatch = (mask: number) => (
                                        <span style={{ display: "grid", gridTemplateColumns: "6px 6px",
                                            gridTemplateRows: "6px 6px", gap: 1 }}>
                                            {[CORNER_TL, CORNER_TR, CORNER_BL, CORNER_BR].map(bit => (
                                                <span key={bit} style={{
                                                    background: (mask & bit) !== 0 ? UI.accent : "#333"
                                                }} />
                                            ))}
                                        </span>
                                    );
                                    /** Replace the grid, keeping the node's box in step, as ONE step. */
                                    const setMap = (next: Tilemap | null) => {
                                        if (!next) return;
                                        const doc = dispatcher.getDocument();
                                        const actions: Action[] = [new SetTilemapAction(doc, node.id, next)];
                                        // THE BOX FOLLOWS THE GRID, in the same transaction. A resize
                                        // that moved one and not the other would leave the node
                                        // selectable over cells it no longer has — and undoing it
                                        // would take two presses for one gesture.
                                        const box = geometryActionFor(doc, node.id, {
                                            width: next.cols * next.tileWidth,
                                            height: next.rows * next.tileHeight
                                        });
                                        if (box) actions.push(box);
                                        dispatcher.dispatchAction(new TransactionAction(doc, "tilemap-size", actions));
                                        refresh();
                                    };
                                    // THE TILESET SECTION (schema 67). Without it the table is
                                    // reachable only by importing a map — a field a person can hold
                                    // and not touch, which is the state this project treats as a
                                    // defect rather than a milestone.
                                    const doc67 = dispatcher.getDocument();
                                    const allSets = (doc67.tilesets ?? []) as readonly Tileset[];
                                    const mySet = findTileset(allSets, map.tilesetId);
                                    const writeSets = (next: Tileset[]) => {
                                        const d = dispatcher.getDocument();
                                        dispatcher.dispatchAction(new SetTilesetsAction(d, next));
                                        refresh();
                                    };
                                    return (
                                        <div style={{ marginTop: 8 }}>
                                            <label style={INSPECTOR_LABEL}>Tileset</label>
                                            <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 6 }}>
                                                {/* RETARGETING A LAYER is the edit the schema
                                                    change exists for: two layers naming one set is
                                                    the whole point, and until now nothing could
                                                    point a layer anywhere. */}
                                                <select
                                                    data-tileset-pick="1"
                                                    aria-label="Tileset for this layer"
                                                    value={map.tilesetId}
                                                    onChange={e => {
                                                        const next = withTilesetId(map, e.target.value);
                                                        if (next) setMap(next);
                                                    }}
                                                    style={{ ...SELECT_STYLE, flex: 1 }}
                                                >
                                                    {/* THE EMPTY OPTION IS A REAL STATE, not a
                                                        placeholder: "none chosen yet" is what an
                                                        unset `src` used to mean, and a layer can
                                                        legitimately sit there waiting for art. */}
                                                    <option value="">(no tileset)</option>
                                                    {allSets.map(t => (
                                                        <option key={t.id} value={t.id}>{t.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            {mySet && (
                                                <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 6 }}>
                                                    <span style={{ color: UI.textFaint, fontSize: 10 }}>name</span>
                                                    <TextInput
                                                        value={mySet.name}
                                                        placeholder="tileset"
                                                        onChange={v => {
                                                            const trimmed = v.trim();
                                                            if (trimmed.length === 0) return;
                                                            writeSets(allSets.map(t => t.id === mySet.id
                                                                ? { ...copyTileset(t), name: trimmed } : copyTileset(t)));
                                                        }}
                                                    />
                                                    <span style={{ color: UI.textFaint, fontSize: 9 }}>
                                                        {mySet.sheet ? "sheet" : `${mySet.tiles.length} tiles`}
                                                    </span>
                                                </div>
                                            )}
                                            {/* PER-TILE PROBABILITY, the second thing the corpus
                                                asked for — 25 values across two files. It weights
                                                a chooser picking among equivalent tiles, and it is
                                                stored un-normalised because Tiled stores it that
                                                way and a round trip must not disagree. */}
                                            {mySet && tileIndex >= 0 && (
                                                <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 6 }}>
                                                    <span style={{ color: UI.textFaint, fontSize: 10 }}>
                                                        tile {tileIndex} weight
                                                    </span>
                                                    <NumInput
                                                        value={tilesetTile(mySet, tileIndex)?.probability ?? 1}
                                                        onChange={v => {
                                                            const weight = Math.max(0, v);
                                                            writeSets(allSets.map(t => t.id !== mySet.id
                                                                ? copyTileset(t)
                                                                : { ...copyTileset(t), tiles: withTileWeight(t, tileIndex, weight) }));
                                                        }}
                                                    />
                                                </div>
                                            )}
                                            <label style={INSPECTOR_LABEL}>Tile brush</label>
                                            <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                                                <ToolButton icon="✏" label="Paint" active={tileMode === "paint" && !tileErasing}
                                                    onClick={() => { setTileMode("paint"); setTileErasing(false); }} />
                                                <ToolButton icon="◍" label="Fill" active={tileMode === "fill" && !tileErasing}
                                                    onClick={() => { setTileMode("fill"); setTileErasing(false); }} />
                                                <ToolButton icon="▣" label="Rect" active={tileMode === "rect" && !tileErasing}
                                                    onClick={() => { setTileMode("rect"); setTileErasing(false); }} />
                                                <ToolButton icon="⌫" label="Erase" active={tileErasing}
                                                    onClick={() => setTileErasing(v => !v)} />
                                                <span style={{ color: "#888", fontSize: 11, marginLeft: 4 }}>
                                                    {tileErasing ? "clearing cells" : `tile ${tileIndex}`}
                                                </span>
                                            </div>
                                            {/* THE THREE FLIP BITS, as three toggles rather than a
                                                number: 0..7 is exactly what the document stores and
                                                exactly what nobody can read. The diagonal is named
                                                "turn" because that is what it does to a viewer —
                                                it is a transpose, and it is what makes all eight
                                                orientations reachable from three switches. */}
                                            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, color: "#aaa", fontSize: 11 }}>
                                                {([["flip X", FLIP_H], ["flip Y", FLIP_V], ["turn", FLIP_D]] as const).map(([label, bit]) => (
                                                    <label key={label} style={{ display: "flex", gap: 3, alignItems: "center" }}>
                                                        <input type="checkbox" checked={(tileFlip & bit) !== 0}
                                                               onChange={e => setTileFlip(f => e.target.checked ? (f | bit) : (f & ~bit))} />
                                                        {label}
                                                    </label>
                                                ))}
                                            </div>
                                            {/* ALT-CLICK ON THE CANVAS SAMPLES a tile, and this says
                                                so where the brush is: a gesture nothing mentions is
                                                a gesture nobody finds. */}
                                            <div style={{ color: "#666", fontSize: 10, marginTop: 3 }}>
                                                alt-click the map to pick up the tile under the cursor
                                            </div>
                                            {/* TERRAIN. A layer either stores its picture or
                                                derives it, and the button that converts is one-way
                                                by design: it throws the tiles away, because a
                                                stored grid and a derived one are two pictures that
                                                can disagree. */}
                                            <div style={{ marginTop: 6, borderTop: `1px solid ${UI.line}`, paddingTop: 6 }}>
                                                {!map.terrain ? (
                                                    <button
                                                        data-terrain-start="1"
                                                        title="Turn this layer into an autotiled one: it will store WHICH CELLS are the material and derive the tiles. The tiles it has now are discarded."
                                                        onClick={() => setMap(asTerrain(map, tileMaterial || 1,
                                                            [{ mask: 15, index: tileIndex }]))}
                                                        style={ADJUST_BUTTON}
                                                    >Autotile this layer…</button>
                                                ) : (<>
                                                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                                        <ToolButton icon="⛰" label="Paint terrain" active={tileTerrain}
                                                            onClick={() => setTileTerrain(v => !v)} />
                                                        <NumberField label="material" value={tileMaterial} min={0} max={255}
                                                            onChange={setTileMaterial} />
                                                        <span style={{ fontSize: 10, color: UI.textFaint }}>
                                                            0 erases
                                                        </span>
                                                    </div>
                                                    {/* GENERATE the question rather than paint it.
                                                        Cellular automata writes WHICH CELLS ARE
                                                        ROCK and `resolveTilemaps` draws it, so this
                                                        is four rules and not a renderer — and the
                                                        SEED is a word, so the same cave comes back
                                                        tomorrow. A generated map that changes when
                                                        reopened is not a document. */}
                                                    {/* THE MATERIALS THIS LAYER DRAWS, in PAINT
                                                        ORDER (schema 65). Where two meet, the later
                                                        one wins — a shore is exactly that cell — so
                                                        the order is an edit in its own right and
                                                        moving one redraws every boundary without
                                                        touching a single painted cell. */}
                                                    <div data-terrain-materials="1" style={{ marginTop: 6 }}>
                                                        <label style={INSPECTOR_LABEL}>Materials, in paint order</label>
                                                        {mats.map((m, i) => (
                                                            <div key={m.id} style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 2 }}>
                                                                {/* A SWATCH, because four materials
                                                                    in a list all read as numbers
                                                                    otherwise. Nothing renders it —
                                                                    the picture comes from the art —
                                                                    it is how a person tells them
                                                                    apart. Every real wangcolor has
                                                                    one. */}
                                                                <input
                                                                    type="color"
                                                                    aria-label={`Colour for material ${m.id}`}
                                                                    value={m.color ?? "#888888"}
                                                                    onChange={e => setMap(withTerrainMaterials(map,
                                                                        mats.map(x => (x.id === m.id
                                                                            ? { ...x, art: [...x.art], color: e.target.value }
                                                                            : { ...x, art: [...x.art] }))))}
                                                                    style={{ width: 20, height: 18, padding: 0, border: `1px solid ${UI.line}`,
                                                                        background: "transparent", borderRadius: 3 }}
                                                                />
                                                                <button
                                                                    aria-label={`Edit material ${m.id}`}
                                                                    title={`Paint and assign art for material ${m.id}`}
                                                                    onClick={() => setTileMaterial(m.id)}
                                                                    style={{ ...ADJUST_BUTTON, width: 22, textAlign: "center",
                                                                        outline: m.id === activeMat?.id ? "1px solid #4a90d9" : "none" }}
                                                                >{i + 1}</button>
                                                                {/* THE NAME, which is the whole
                                                                    point: "Cobblestone", not
                                                                    "material 3". Cleared back to
                                                                    absent rather than stored empty,
                                                                    so a file only mentions a name
                                                                    somebody typed. */}
                                                                <TextInput
                                                                    value={m.name ?? ""}
                                                                    placeholder={`material ${m.id}`}
                                                                    onChange={v => setMap(withTerrainMaterials(map,
                                                                        mats.map(x => {
                                                                            const copy = { ...x, art: [...x.art] };
                                                                            if (x.id !== m.id) return copy;
                                                                            const trimmed = v.trim();
                                                                            if (trimmed === "") { delete copy.name; return copy; }
                                                                            return { ...copy, name: trimmed };
                                                                        })))}
                                                                />
                                                                <span style={{ color: UI.textFaint, fontSize: 9 }}>{m.art.length}/6</span>
                                                                <button
                                                                    aria-label={`Move material ${m.id} later`}
                                                                    title="Draw this one over the others"
                                                                    disabled={i === mats.length - 1}
                                                                    onClick={() => setMap(reorderTerrainMaterial(map, m.id, 1))}
                                                                    style={{ ...ADJUST_BUTTON, padding: "0 5px" }}
                                                                >↓</button>
                                                                <button
                                                                    aria-label={`Remove material ${m.id}`}
                                                                    title="Stop drawing this material. The cells that hold it are LEFT ALONE — they draw as nothing until a material claims that id again."
                                                                    disabled={mats.length <= 1}
                                                                    onClick={() => setMap(removeTerrainMaterial(map, m.id))}
                                                                    style={{ ...ADJUST_BUTTON, padding: "0 5px" }}
                                                                >×</button>
                                                            </div>
                                                        ))}
                                                        <button
                                                            aria-label="Add material"
                                                            title="Draw a second thing in this layer — rock and water, grass and path. It draws over the ones above it."
                                                            disabled={mats.length >= TERRAIN_MATERIALS_MAX}
                                                            onClick={() => {
                                                                // THE ID COMES BACK from the edit rather than being
                                                                // guessed here — the panel needs it to select the new
                                                                // material, and guessing collides with a painted id.
                                                                const added = addTerrainMaterial(map);
                                                                if (!added) return;
                                                                setMap(added.map);
                                                                setTileMaterial(added.id);
                                                            }}
                                                            style={ADJUST_BUTTON}
                                                        >Add material</button>
                                                    </div>
                                                    <div data-cave="1" style={{ display: "flex", gap: 4, marginTop: 6, alignItems: "center" }}>
                                                        <TextInput value={caveSeed} placeholder="seed word"
                                                            onChange={setCaveSeed} />
                                                        <button
                                                            aria-label="Generate cave"
                                                            title="Fill this layer's terrain with a cave: cellular automata over which cells are the material. The same seed always gives the same cave."
                                                            onClick={() => {
                                                                const grid = caveCells(map.cols, map.rows,
                                                                    activeMat?.id ?? 1,
                                                                    rngFrom(seedFrom(caveSeed)));
                                                                if (grid.cells.length === 0) return;
                                                                // THROUGH THE SAME EDIT PATH A BRUSH USES, so the
                                                                // generator cannot author a terrain the loader
                                                                // would refuse — and one press is one undo step.
                                                                setMap(withTerrain(map, grid.cells.map((m, i) => ({
                                                                    col: i % map.cols, row: Math.floor(i / map.cols),
                                                                    material: m
                                                                }))));
                                                            }}
                                                            style={ADJUST_BUTTON}
                                                        >Generate cave</button>
                                                    </div>
                                                    {/* THE SIX SHAPES AN ARTIST DRAWS. Each button
                                                        shows the neighbourhood it stands for and
                                                        assigns the CURRENTLY PICKED tile to it, so
                                                        the sheet below is the palette for both. */}
                                                    <div data-terrain-art="1" style={{ display: "flex", gap: 4, marginTop: 5, flexWrap: "wrap" }}>
                                                        {classes.map(mask => (
                                                            <button
                                                                key={mask}
                                                                title={`Assign tile ${tileIndex} to this shape (mask ${mask})`}
                                                                onClick={() => setMap(withTerrainArt(map, mask, tileIndex, activeMat?.id))}
                                                                style={{ display: "flex", flexDirection: "column",
                                                                    alignItems: "center", gap: 2, padding: "3px 4px",
                                                                    background: "transparent", cursor: "pointer",
                                                                    border: `1px solid ${artFor(mask) === null ? "#a33" : UI.line}`,
                                                                    borderRadius: 3 }}
                                                            >
                                                                {maskSwatch(mask)}
                                                                <span style={{ fontSize: 9, color: artFor(mask) === null ? "#a66" : "#888" }}>
                                                                    {artFor(mask) === null ? "—" : artFor(mask)}
                                                                </span>
                                                            </button>
                                                        ))}
                                                    </div>
                                                    <div style={{ color: "#666", fontSize: 10, marginTop: 3 }}>
                                                        a shape with no tile draws nothing — pick a tile below, then click a shape
                                                    </div>
                                                </>)}
                                            </div>
                                            {/* THE PALETTE IS THE TILESET'S (schema 68), and it
                                                had been the NODE's — a field 66→67 already moved
                                                and 68 refuses. So this picker vanished for every
                                                document that had been through the migration, which
                                                is every document not imported since: the one
                                                control that says WHICH TILE to paint, gone, with
                                                the terrain panel still telling people to "pick a
                                                tile below". A read of a field nothing writes is as
                                                dead as a write nothing reads. */}
                                            {mySet?.src && (
                                                <div
                                                    data-tile-picker="1"
                                                    style={{
                                                        marginTop: 4, maxHeight: 180, overflow: "auto",
                                                        border: `1px solid ${UI.line}`, background: "#111", position: "relative"
                                                    }}
                                                >
                                                    <div style={{ position: "relative", display: "inline-block" }}>
                                                        <img
                                                            src={mySet.src}
                                                            alt="tile sheet"
                                                            draggable={false}
                                                            style={{ display: "block", imageRendering: "pixelated", cursor: "crosshair" }}
                                                            onClick={e => {
                                                                // SHEET PIXELS, measured against the
                                                                // IMAGE's own box so the container's
                                                                // scroll needs no arithmetic here.
                                                                const r = (e.target as HTMLImageElement).getBoundingClientRect();
                                                                const pickSet = findTileset(dispatcher.getDocument().tilesets, map.tilesetId);
                                                                if (!pickSet?.sheet) return;
                                                                const picked = tileIndexAt(pickSet.sheet,
                                                                    e.clientX - r.left, e.clientY - r.top);
                                                                // NULL IS THE GUTTER, and it selects
                                                                // nothing rather than the neighbour:
                                                                // the gap between tiles is not a tile.
                                                                if (picked === null) return;
                                                                setTileIndex(picked);
                                                                setTileErasing(false);
                                                            }}
                                                        />
                                                        {ring && (
                                                            <div style={{
                                                                position: "absolute", pointerEvents: "none",
                                                                left: ring.x, top: ring.y,
                                                                width: ring.width, height: ring.height,
                                                                outline: `1px solid ${UI.accent}`,
                                                                boxShadow: "0 0 0 1px #000"
                                                            }} />
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                            {/* A COLLECTION SET'S PALETTE — the other half, and the
                                                reason it needs one: a collection has no sheet to
                                                click, so the picker above was gated on an image
                                                that does not exist and there was NO WAY to choose a
                                                tile. Such a layer could be painted with tile 0 and
                                                nothing else, on a set of 244.

                                                ONE BUTTON PER TILE, IN ID ORDER, and the id is what
                                                a cell stores — so the label under each thumbnail is
                                                the number the rest of this panel talks about, not a
                                                position in a list. Real sets skip ids (one corpus
                                                set has no 47, another starts at 12), which is
                                                exactly why the number is shown.

                                                THUMBNAILS ARE CONTAINED, not stretched: the
                                                measured art is 256x352 and 256x512, so a fixed box
                                                with `object-fit: contain` keeps a tall tile tall
                                                rather than squashing it into a square, and a
                                                picker that misrepresents the shape of the art is a
                                                picker people stop trusting. */}
                                            {mySet && !mySet.sheet && mySet.tiles.some(t => t.src) && (
                                                <div
                                                    data-tile-picker="1"
                                                    data-picker-kind="collection"
                                                    style={{
                                                        marginTop: 4, maxHeight: 180, overflow: "auto",
                                                        border: `1px solid ${UI.line}`, background: "#111",
                                                        display: "flex", flexWrap: "wrap", gap: 3, padding: 3
                                                    }}
                                                >
                                                    {mySet.tiles.filter(t => t.src)
                                                        .slice().sort((a, b) => a.id - b.id).map(t => (
                                                        <button
                                                            key={t.id}
                                                            data-tile-id={t.id}
                                                            title={`tile ${t.id} — ${t.width}x${t.height}`}
                                                            onClick={() => { setTileIndex(t.id); setTileErasing(false); }}
                                                            style={{
                                                                display: "flex", flexDirection: "column",
                                                                alignItems: "center", gap: 1, padding: 2,
                                                                background: "transparent", cursor: "pointer",
                                                                // THE SELECTION IS THE BORDER, which is
                                                                // what the sheet picker's ring is for —
                                                                // the same statement in the shape this
                                                                // palette has.
                                                                border: `1px solid ${t.id === tileIndex && !tileErasing
                                                                    ? UI.accent : UI.line}`,
                                                                borderRadius: 3
                                                            }}
                                                        >
                                                            <img
                                                                src={t.src}
                                                                alt={`tile ${t.id}`}
                                                                draggable={false}
                                                                style={{ display: "block", width: 40, height: 40,
                                                                    objectFit: "contain",
                                                                    imageRendering: "pixelated" }}
                                                            />
                                                            <span style={{ fontSize: 9, color: "#888" }}>{t.id}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            <label style={INSPECTOR_LABEL}>Grid</label>
                                            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                                <NumInput value={map.cols}
                                                    onChange={v => setMap(resizeTilemap(map, Math.round(v), map.rows))} />
                                                <span style={{ color: "#666", fontSize: 11 }}>×</span>
                                                <NumInput value={map.rows}
                                                    onChange={v => setMap(resizeTilemap(map, map.cols, Math.round(v)))} />
                                                <span style={{ color: "#666", fontSize: 10 }}>cells</span>
                                            </div>
                                        </div>
                                    );
                                })()}
                                {/* BONES (schema 58), for the control point last pressed on the
                                    canvas. Only the SIBLINGS are offered, which is exactly the rule
                                    Integrity enforces — so an illegal binding is unreachable here
                                    rather than merely refused later. */}
                                {(() => {
                                    const pick = pickedMeshPoint(es, dispatcher.getDocument());
                                    if (!pick) return null;
                                    const mesh = dispatcher.getDocument().nodes.get(pick.nodeId)?.mesh;
                                    if (!mesh) return null;
                                    const bones = bonesAt(mesh, pick.index);
                                    const siblings = boneChoices(dispatcher.getDocument(), pick.nodeId);
                                    const live = new Set(siblings);
                                    const choices = siblings.filter(id => !bones.some(b => b.node === id));
                                    const full = bones.length >= SKIN_MAX_BONES;
                                    // The LAYERS PANEL'S own label. A binding stores an id, but an
                                    // id is not a thing anyone recognises in a list of siblings.
                                    const label = (id: string) => {
                                        const n = dispatcher.getDocument().nodes.get(id);
                                        return n ? (n.name || nodeTypeLabels[n.type] || n.type) : id;
                                    };
                                    const setMesh = (next: ReadonlyMesh, coalesce = false) => {
                                        if (next === mesh) return;
                                        dispatcher.dispatchAction(
                                            new SetMeshAction(dispatcher.getDocument(), pick.nodeId, next as Mesh),
                                            { coalesce });
                                        refresh();
                                    };
                                    return (
                                        <div style={{ marginTop: 8 }}>
                                            <label style={INSPECTOR_LABEL}>Bones · point {pick.index}</label>
                                            {bones.length === 0 && (
                                                <div style={{ color: "#777", fontSize: 11, marginTop: 2 }}>
                                                    Not bound — this point stays where it is drawn.
                                                </div>
                                            )}
                                            {bones.map(b => {
                                                // A BINDING CAN BE INERT and still be worth keeping: move the
                                                // shape into a group and its bones stop being siblings, so the
                                                // deform stops while the binding survives, ready to work again
                                                // when they are reunited. Saying so is the whole cost of not
                                                // silently deleting it — otherwise the rig just stops and the
                                                // panel looks exactly as it did when it worked.
                                                const inert = !live.has(b.node);
                                                return (
                                                <div key={b.node} style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                                                    <span
                                                        title={inert
                                                            ? `${b.node} — not a sibling of this node right now, so it moves nothing. Put the two back under the same parent and this works again.`
                                                            : b.node}
                                                        style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                                                 color: inert ? "#a06a4a" : undefined }}
                                                    >{label(b.node)}{inert ? " (inert)" : ""}</span>
                                                    {/* Coalesced, so a whole drag is ONE undo — the
                                                        bargain every slider in this panel makes. */}
                                                    <input
                                                        type="range" min={0} max={1} step={0.01} value={b.weight}
                                                        title="How strongly this bone pulls the point. Weights are relative: one bone at 0.5 still carries it all the way, and it takes a second influence to split the difference."
                                                        onChange={e => setMesh(withBoneWeight(mesh, pick.index, b.node, parseFloat(e.target.value)), true)}
                                                        style={{ width: 72 }}
                                                    />
                                                    <span style={{ width: 28, textAlign: "right", color: "#888", fontSize: 11 }}>
                                                        {b.weight.toFixed(2)}
                                                    </span>
                                                    <button
                                                        title="Unbind this bone from the point"
                                                        onClick={() => setMesh(withoutBone(mesh, pick.index, b.node))}
                                                        style={{ ...SELECT_STYLE, padding: "0 6px" }}
                                                    >×</button>
                                                </div>
                                                );
                                            })}
                                            {/* AUTO-BIND is the pass that makes a rig a starting
                                                point rather than an afternoon: binding by hand is
                                                one point and one dropdown at a time. It replaces
                                                every point's bindings, which undo covers. */}
                                            <button
                                                disabled={siblings.length === 0}
                                                title={siblings.length === 0
                                                    ? "Nothing beside this node to bind to."
                                                    : "Bind EVERY control point to the sibling nodes nearest it, weighted by distance. Replaces the bindings on all of them — auto-bind first, then correct the few it gets wrong."}
                                                onClick={() => {
                                                    const next = autoBindMesh(dispatcher.getDocument(), pick.nodeId);
                                                    if (next) setMesh(next);
                                                }}
                                                style={{ ...SELECT_STYLE, width: "100%", marginTop: 4 }}
                                            >Auto-bind all points</button>
                                            <select
                                                value=""
                                                disabled={full || choices.length === 0}
                                                title={full
                                                    ? "A point may name at most " + SKIN_MAX_BONES + " bones."
                                                    : "Bind this point to a sibling node. Moving that node then carries the point with it."}
                                                onChange={e => { if (e.target.value) setMesh(withBone(mesh, pick.index, e.target.value)); }}
                                                style={{ ...SELECT_STYLE, width: "100%", marginTop: 4 }}
                                            >
                                                <option value="">
                                                    {full ? "at most " + SKIN_MAX_BONES
                                                        : choices.length === 0 ? "no siblings to bind to" : "bind to…"}
                                                </option>
                                                {!full && choices.map(id => (
                                                    <option key={id} value={id}>{label(id)}</option>
                                                ))}
                                            </select>
                                        </div>
                                    );
                                })()}
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
                                                    display: "flex", alignItems: "center", justifyContent: "center",
                                                    // THE ACTIVE ONE IS COLOURED, not only outlined: the icon draws in
                                                    // `currentColor`, so the state reaches the bars themselves and not
                                                    // just the border a narrow button nearly hides.
                                                    color: (node.style.textAlign ?? "left") === a ? "#00bfff" : "#ccc",
                                                    borderColor: (node.style.textAlign ?? "left") === a ? "#00bfff" : "#2a2a4a"
                                                }}
                                            ><AlignIcon align={a} /></button>
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
                                    <NineSliceFields node={node} onEdit={patch => { editContent(patch); refresh(); }} />
                                </InspectorSection>
                            )}

                            {/* THE ADJUSTMENTS. `core/paint/Adjust` is a family of pure functions
                                over a buffer, every one of them already shaped `(buffer) => number`
                                — which is exactly what `surfaceEditAction` takes, so each becomes a
                                button by being written. They are DESTRUCTIVE and they obey the pixel
                                selection, both of which the panel says out loud. */}
                            {node.type === "core.raster" && node.surface && (
                                <InspectorSection title="Adjust">
                                    <div style={{ fontSize: 10, color: UI.textFaint, marginBottom: 4 }}>
                                        {pixelSelectionCount === null
                                            ? "Applies to the whole canvas — destructive, one undo step each."
                                            : `Confined to the ${pixelSelectionCount} px selection.`}
                                    </div>
                                    <div style={ADJUST_ROW}>
                                        <NumberField label="bright" value={adjBrightness} min={-255} max={255}
                                            onChange={setAdjBrightness} />
                                        <button data-adjust="brightness" style={ADJUST_BUTTON}
                                            onClick={() => applyAdjustment(b => adjustBrightness(b, adjBrightness))}
                                        >Apply</button>
                                    </div>
                                    <div style={ADJUST_ROW}>
                                        <NumberField label="contrast" value={adjContrast} min={-100} max={100}
                                            onChange={setAdjContrast} />
                                        <button data-adjust="contrast" style={ADJUST_BUTTON}
                                            onClick={() => applyAdjustment(b => adjustContrast(b, adjContrast))}
                                        >Apply</button>
                                    </div>
                                    {/* HUE, SATURATION AND VALUE ARE ONE PASS, because they share the
                                        conversion — three separate round trips would each lose a unit
                                        to rounding, so doing them together is not merely faster. */}
                                    <div style={ADJUST_ROW}>
                                        <NumberField label="hue°" value={adjHue} min={-360} max={360}
                                            onChange={setAdjHue} />
                                        <NumberField label="sat×" value={adjSaturation} min={0} max={8} step={0.1}
                                            onChange={setAdjSaturation} />
                                        <NumberField label="val×" value={adjValue} min={0} max={8} step={0.1}
                                            onChange={setAdjValue} />
                                        <button data-adjust="hsv" style={ADJUST_BUTTON}
                                            onClick={() => applyAdjustment(b => adjustHsv(b, adjHue, adjSaturation, adjValue))}
                                        >Apply</button>
                                    </div>
                                    <div style={ADJUST_ROW}>
                                        <NumberField label="levels" value={adjLevels}
                                            min={POSTERIZE_MIN} max={POSTERIZE_MAX}
                                            onChange={setAdjLevels} />
                                        <button data-adjust="posterize" style={ADJUST_BUTTON}
                                            onClick={() => applyAdjustment(b => posterize(b, adjLevels))}
                                        >Posterize</button>
                                    </div>
                                    {/* REPLACE takes the matcher the WAND uses, so "select this
                                        colour" and "replace this colour" cannot come to mean
                                        different pixels. The swatch is the destination, which is
                                        also what the brush and the bucket paint with. */}
                                    <div style={ADJUST_ROW}>
                                        <input
                                            type="color"
                                            aria-label="Colour to replace"
                                            data-adjust-from="1"
                                            value={adjFrom}
                                            onChange={e => setAdjFrom(e.target.value)}
                                            style={{ width: 26, height: 20, padding: 0, background: "none",
                                                border: `1px solid ${UI.line}` }}
                                        />
                                        <span style={{ fontSize: 10, color: UI.textFaint }}>→ {paintColour}</span>
                                        <NumberField label="tol" value={adjTolerance} min={0} max={WAND_TOLERANCE_MAX}
                                            onChange={setAdjTolerance} />
                                        <button data-adjust="replace" style={ADJUST_BUTTON}
                                            onClick={() => applyAdjustment(b => replaceColour(
                                                b, hexToRgba(adjFrom), hexToRgba(paintColour), wandMatcher(adjTolerance)))}
                                        >Replace</button>
                                    </div>
                                    <div style={ADJUST_ROW}>
                                        <button data-adjust="desaturate" style={ADJUST_BUTTON}
                                            onClick={() => applyAdjustment(desaturate)}
                                        >Desaturate</button>
                                        <button data-adjust="invert" style={ADJUST_BUTTON}
                                            onClick={() => applyAdjustment(invertColours)}
                                        >Invert</button>
                                    </div>
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
            {dispatcher.getDocument().timeline && <AnimationPanel document={dispatcher.getDocument()}
                nodeId={es.selectedNodeIds.length === 1 ? es.selectedNodeIds[0] : null}
                selectedClip={previewClip?.name ?? ""} disabled={es.playing}
                onSelectClip={name => {
                    es.playingTimeline = false;
                    setPreviewClipName(name);
                    es.frame = findClip(dispatcher.getDocument().clips, name)?.from ?? 0;
                    refresh();
                }}
                onClipsChange={clips => dispatcher.dispatchAction(new SetClipsAction(dispatcher.getDocument(), clips)).success}
                onControllerChange={controller => {
                    const id = es.selectedNodeIds[0];
                    return !!id && dispatcher.dispatchAction(new SetAnimationControllerAction(dispatcher.getDocument(), id, controller)).success;
                }} />}
            {(() => { const timeline = dispatcher.getDocument().timeline; return timeline ? (
                <div style={{ padding: "4px 10px", background: UI.panel, borderTop: `1px solid ${UI.line}`,
                              display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#ccc" }}>
                    <button style={ALIGN_BUTTON_STYLE} title="Play the selected clip or timeline from the playhead" disabled={es.playing}
                        onClick={() => {
                            if (!es.playingTimeline && previewClip?.loop === false && (es.frame ?? 0) >= previewClip.to) es.frame = previewClip.from;
                            es.playingTimeline = !es.playingTimeline; refresh();
                        }}>
                        {es.playingTimeline ? "⏸" : "▶"}
                    </button>
                    <input
                        type="range" min={previewClip?.from ?? 0} max={previewClip?.to ?? timeline.frames - 1} step={1} disabled={es.playing}
                        value={Math.round(es.frame ?? 0)}
                        onChange={e => { es.playingTimeline = false; es.frame = parseInt(e.target.value, 10); refresh(); }}
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

            {es.playing && (()=>{
                const world=workspace==="3d"?world3dRef.current:es.world;
                const runtimeDoc=runtimeProjectRef.current.document??dispatcher.getDocument();
                return world && <BehaviorDebugPanel doc={runtimeDoc} state={world.behaviorState} time={world.time} tallies={world.tallies??new Map()}
                    onChange={behaviorState=>{if(workspace==="3d"&&world3dRef.current)world3dRef.current={...world3dRef.current,behaviorState};else if(es.world)es.world={...es.world,behaviorState};refresh();}}
                    onStep={()=>{if(workspace==="3d"&&world3dRef.current)world3dRef.current=advanceBehaviors3D(runtimeDoc,world3dRef.current,[],"step");else if(es.world)es.world=advanceBehaviors2D(runtimeDoc,es.world,es.controlled,[],"step").world;refresh();}}/>;
            })()}
            <div style={{ padding: "3px 10px", background: UI.panel, borderTop: `1px solid ${UI.line}`, fontSize: 10, color: "#555", display: "flex", justifyContent: "space-between" }}>
                <span>{toolName.charAt(0).toUpperCase() + toolName.slice(1)} tool</span>
                {es.playing && <span data-animation-states style={{ color: UI.accent }}>
                    {[...(workspace === "3d" ? world3dRef.current?.animations : es.world?.animations) ?? []]
                        .slice(0, 4).map(([id, player]) => `${dispatcher.getDocument().nodes.get(id)?.name || id}: ${player.state} · ${player.frame}`).join(" | ")}
                </span>}
                {/* WHAT THE RUN JUST NOTICED (M18 slice 5). The world reports overlaps and does not
                    act on them — nothing here spawns, runs a script or loads a map — so without a
                    place for an event to LAND the whole feature would be unreachable, which is the
                    state this project has now found four separate fields in. A status line is the
                    smallest honest surface: it proves the chain end to end and commits to nothing
                    about what a game should do with it. */}
                {es.playing && runOutcome && (
                    <span data-run-outcome={runOutcome}
                        style={{ color: runOutcome === "won" ? "#5f9e78" : "#d4655a",
                                 fontWeight: 600 }}>
                        {runOutcome === "won" ? "COMPLETE" : "FAILED"}
                    </span>
                )}
                {es.playing && lastEvent && (
                    <span data-world-event="1" style={{ color: UI.accent }}>
                        {lastEvent.kind} {lastEvent.className || "(no class)"}
                        {/* THE SIDE IS THE ONLY NEW INFORMATION slice 9 produces, so leaving it off
                            here would make it a field nothing in the app can observe — the exact
                            shape of failure this project keeps finding. `below` is a stomp. */}
                        {lastEvent.side ? ` (${lastEvent.side})` : ""}
                    </span>
                )}
                <span>{Math.round(vp.zoom * 100)}% · {Math.round(vp.x)}, {Math.round(vp.y)}</span>
                <span>Canvas Fogworks v{CURRENT_VERSION}</span>
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

/**
 * The eight shape tools behind ONE slot.
 *
 * Eight of the twelve tools on the bar were shapes, which is eight decisions to make a rectangle —
 * and every editor a person arrives from (Photoshop, Illustrator, Aseprite, Krita) has nested them
 * for decades. The slot SHOWS THE LAST SHAPE USED and selects it on click, so the common case is
 * still one click; the caret opens the rest.
 *
 * THE CARET IS A SEPARATE BUTTON, not a long-press. A long-press hides the only affordance that
 * says more is here, and it cannot be reached from a keyboard at all.
 */
function ShapeFlyout({ current, active, icons, compact, onPick }: {
    current: ShapeKind; active: boolean;
    icons: Record<ShapeKind, string>;
    /** In the vertical strip the menu opens to the SIDE — below would cover the tools under it. */
    compact?: boolean;
    onPick: (kind: ShapeKind) => void;
}) {
    const [open, setOpen] = useState(false);
    // Escape closes, and so does a click anywhere else — a popover that can only be dismissed by
    // choosing something is a trap, and this one covers the canvas.
    useEffect(() => {
        if (!open) return;
        const away = () => setOpen(false);
        const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        // Captured, so a click on the canvas closes it before the tool sees a stray press.
        document.addEventListener("mousedown", away, true);
        document.addEventListener("keydown", key);
        return () => {
            document.removeEventListener("mousedown", away, true);
            document.removeEventListener("keydown", key);
        };
    }, [open]);
    const name = (k: ShapeKind) => k[0].toUpperCase() + k.slice(1);
    return (
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <ToolButton icon={icons[current]} label={name(current)} active={active}
                compact={compact} onClick={() => onPick(current)} />
            <button
                title="Choose a shape"
                aria-label="Choose a shape"
                aria-expanded={open}
                aria-haspopup="menu"
                onMouseDown={e => e.stopPropagation()}
                onClick={() => setOpen(o => !o)}
                style={{
                    padding: "3px 2px", fontSize: 9, lineHeight: 1, background: "transparent",
                    color: "#ccc", border: "none", borderRadius: 3, cursor: "pointer"
                }}
            >&#9662;</button>
            {open && (
                <div role="menu" onMouseDown={e => e.stopPropagation()} style={{
                    position: "absolute", zIndex: 60,
                    ...(compact ? { left: "100%", top: 0, marginLeft: 2 } : { top: "100%", left: 0, marginTop: 2 }),
                    display: "flex", flexDirection: "column", minWidth: 132,
                    background: UI.panel, border: `1px solid ${UI.line}`, borderRadius: 3,
                    boxShadow: "0 6px 18px rgba(0,0,0,.45)", padding: 3
                }}>
                    {SHAPE_KINDS.map(kind => (
                        <button
                            key={kind}
                            role="menuitem"
                            onClick={() => { onPick(kind); setOpen(false); }}
                            style={{
                                display: "flex", alignItems: "center", gap: 7, padding: "4px 8px",
                                fontSize: 11, textAlign: "left", cursor: "pointer",
                                background: kind === current ? "#2a4a6a" : "transparent",
                                color: "#ccc", border: "none", borderRadius: 2
                            }}
                        >
                            <span style={{ width: 14, display: "inline-block" }}>{icons[kind]}</span>
                            <span>{name(kind)}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

function ToolButton({ icon, label, active, disabled, compact, onClick }: {
    icon: string; label: string; active?: boolean; disabled?: boolean;
    /** Icon only, sized for the vertical strip. The name still reaches a screen reader and a tooltip. */
    compact?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            title={label}
            // THE NAME IS NOT OPTIONAL when the label is hidden. `title` alone is a hover
            // affordance; without this the compact strip is a column of unlabelled glyphs to
            // anything that is not a mouse.
            aria-label={label}
            aria-pressed={active}
            onClick={onClick}
            disabled={disabled}
            style={compact ? {
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 30, height: 28, fontSize: 15, lineHeight: 1,
                background: active ? "#2a4a6a" : "transparent", color: disabled ? "#444" : "#ccc",
                border: "none", borderRadius: 3, cursor: disabled ? "default" : "pointer"
            } : {
                display: "flex", alignItems: "center", gap: 3, padding: "3px 7px", fontSize: 11,
                background: active ? "#2a4a6a" : "transparent", color: disabled ? "#444" : "#ccc",
                border: "none", borderRadius: 3, cursor: disabled ? "default" : "pointer"
            }}
        >
            <span>{icon}</span>{!compact && <span>{label}</span>}
        </button>
    );
}


/** Inspector chrome — one place for the panel's spacing so the sections stay uniform. */
const INSPECTOR_LABEL: React.CSSProperties = { color: "#aaa", display: "block", marginTop: 4 };

/** One row of the Adjust panel: a few small fields and the button that spends them. */
const ADJUST_ROW: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 4, marginTop: 4, flexWrap: "wrap"
};
/** What a package holds that this engine can place. The rest is counted, not hidden. */
const UNITY_IMAGE = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

const ADJUST_BUTTON: React.CSSProperties = {
    fontSize: 10, padding: "2px 6px", background: "transparent", color: "#ccc",
    border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer"
};

/**
 * A labelled number, small enough for a panel row.
 *
 * CLAMPED HERE rather than at the button, so the value the field SHOWS is the value that will be
 * applied — a field that accepted 900 and then quietly applied 255 would make the result look like
 * an arithmetic bug in the adjustment. An unparseable entry keeps the last good number rather than
 * becoming NaN, which every adjustment would turn into a transparent canvas.
 */
function NumberField({ label, value, min, max, step, onChange }: {
    label: string; value: number; min: number; max: number; step?: number;
    onChange: (v: number) => void;
}) {
    return (
        <label style={{ fontSize: 10, color: "#888", display: "flex", alignItems: "center", gap: 2 }}>
            {label}
            <input
                type="number" min={min} max={max} step={step ?? 1}
                aria-label={label}
                value={value}
                onChange={e => {
                    const raw = Number(e.target.value);
                    if (!Number.isFinite(raw)) return;
                    onChange(Math.max(min, Math.min(max, raw)));
                }}
                style={{ width: 46, fontSize: 10, background: "#12121e", color: "#ddd",
                    border: "1px solid #2a2a4a", borderRadius: 3 }}
            />
        </label>
    );
}
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


/**
 * The CSS spelling of a ramp, for the preview bar and the stop handles.
 *
 * ALWAYS LEFT-TO-RIGHT, whatever the gradient's own axis says, and that is the point: this bar is
 * the RAMP — which colour sits at which offset — not a picture of the fill. Where the ramp runs on
 * the shape is the canvas's job. Every tool anybody arrives from draws this control the same way,
 * because a radial gradient has no left and right to preview.
 */
function rampCss(stops: readonly GradientStop[]): string {
    const parts = stops.map(s => `${cssColorOf(s)} ${(s.offset * 100).toFixed(2)}%`);
    // ONE stop is not a legal CSS gradient — it needs two positions — and a ramp mid-edit can
    // briefly have one. Doubling it paints the flat colour, which is what one stop means.
    if (parts.length === 1) parts.push(parts[0].replace(/[\d.]+%$/, "100%"));
    return `linear-gradient(to right, ${parts.join(", ")})`;
}

/**
 * One stop as a CSS colour, opacity folded in.
 *
 * A `$token` has no value here — the inspector has no variable store in scope and resolving one
 * would duplicate what the render model already does — so it previews as the missing-colour grey
 * the swatch already uses for a token. The CANVAS shows the resolved colour; this is a handle.
 */
/**
 * The alpha checkerboard every colour tool draws behind a ramp.
 *
 * WITHOUT IT A FADE TO TRANSPARENT READS AS A FADE TO THE PANEL. The default new gradient goes
 * from the shape's colour to nothing, and against a dark panel that looked like a fade to black —
 * indistinguishable from a ramp somebody actually authored that way. Found by looking at it.
 */
const ALPHA_CHECKER = "conic-gradient(#33334d 0 25%, #1b1b2e 0 50%, #33334d 0 75%, #1b1b2e 0)";

function cssColorOf(stop: GradientStop): string {
    const hex = /^#[0-9a-fA-F]{6}$/.test(stop.color) ? stop.color : "#888888";
    return `${hex}${Math.round(Math.min(1, Math.max(0, stop.opacity)) * 255).toString(16).padStart(2, "0")}`;
}

/**
 * The gradient stop editor.
 *
 * HOLDS NO GRADIENT OF ITS OWN — only which stop is selected. The ramp lives in the document and
 * every change goes out as an action, so undo has something to restore and a second view of the
 * same node cannot disagree with this one. A local copy is how an editor ends up fighting its own
 * document the first time anything else writes to the node.
 *
 * AND THE SELECTED INDEX COMES BACK FROM THE OPERATION, never from arithmetic here: dragging one
 * stop past another renumbers the list, and `withStopOffset` is what knows where the stop landed.
 */
function GradientEditor({ gradient, onChange }: {
    gradient: Gradient; onChange: (next: Gradient, coalesce: boolean) => void;
}) {
    const [selected, setSelected] = React.useState(0);
    const barRef = React.useRef<HTMLDivElement | null>(null);
    // CLAMPED on read rather than corrected in an effect: a stop can disappear from under this
    // component (an undo, another view), and a render that indexes past the end would throw before
    // any effect could run.
    const index = Math.min(selected, gradient.stops.length - 1);
    const stop = gradient.stops[index];

    /** Where along the bar a pointer is, 0..1. */
    const offsetAt = (clientX: number): number => {
        const box = barRef.current?.getBoundingClientRect();
        if (!box || box.width === 0) return 0;
        return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    };

    /** A drag on one handle. Coalesced, so the whole gesture is ONE undo like every slider here. */
    const dragStop = (i: number) => (e: React.PointerEvent) => {
        e.stopPropagation();
        setSelected(i);
        // THE GESTURE CARRIES ITS OWN GRADIENT, and it has to. The `gradient` prop is the one from
        // the render that installed this handler, and a re-render mid-drag does not reach a closure
        // already running. Advancing `at` against the NEW list while re-reading the OLD one is
        // exactly the mismatch the returned index exists to prevent: the moment a drag reorders the
        // stops, the next move edits whichever stop now happens to hold that number. Found by
        // dragging one in the running app, not by any test — a component has no fixture.
        let current = gradient;
        let at = i;
        const move = (ev: PointerEvent) => {
            const moved = withStopOffset(current, at, offsetAt(ev.clientX));
            if (!moved) return;
            current = moved.gradient;
            at = moved.index;
            setSelected(moved.index);
            onChange(moved.gradient, true);
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    return (
        <div>
            <div
                ref={barRef}
                title="Click the ramp to add a stop; drag a handle to move it"
                onPointerDown={e => {
                    const added = withStop(gradient, offsetAt(e.clientX));
                    if (!added) return;
                    setSelected(added.index);
                    onChange(added.gradient, false);
                }}
                style={{
                    position: "relative", height: 18, marginTop: 4, borderRadius: 3, cursor: "copy",
                    border: `1px solid ${UI.line}`,
                    // The ramp OVER the checker, so a transparent end shows the squares through it.
                    backgroundImage: `${rampCss(gradient.stops)}, ${ALPHA_CHECKER}`,
                    backgroundSize: "auto, 8px 8px"
                }}
            >
                {gradient.stops.map((s, i) => (
                    <div
                        key={i}
                        onPointerDown={dragStop(i)}
                        style={{
                            position: "absolute", top: -3, left: `${s.offset * 100}%`, width: 8, height: 22,
                            marginLeft: -4, borderRadius: 2, cursor: "ew-resize",
                            // Over the checker for the same reason the bar is: a fully transparent
                            // stop's handle was all but invisible, and it is the one you most need
                            // to find again.
                            backgroundImage: `linear-gradient(${cssColorOf(s)}, ${cssColorOf(s)}), ${ALPHA_CHECKER}`,
                            backgroundSize: "auto, 6px 6px",
                            border: `2px solid ${i === index ? UI.accent : "#0e0e18"}`, boxSizing: "border-box"
                        }}
                    />
                ))}
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 6 }}>
                <select
                    value={gradient.kind}
                    onChange={e => onChange(withKind(gradient, e.target.value as "linear" | "radial"), false)}
                    style={{ ...SELECT_STYLE, flex: 1 }}
                    title="Switching keeps the ramp where it is — a radial takes the linear axis's midpoint and half its length, and back again."
                >
                    <option value="linear">linear</option>
                    <option value="radial">radial</option>
                </select>
                <button
                    onClick={() => { const g = withoutStop(gradient, index); if (g) onChange(g, false); }}
                    disabled={gradient.stops.length <= GRADIENT_MIN_STOPS}
                    title={gradient.stops.length <= GRADIENT_MIN_STOPS
                        ? `A gradient needs at least ${GRADIENT_MIN_STOPS} stops — use Solid to go back to one colour`
                        : "Remove the selected stop"}
                    style={{
                        fontSize: 10, padding: "2px 6px", background: "transparent", color: UI.textDim,
                        border: `1px solid ${UI.line}`, borderRadius: 2,
                        cursor: gradient.stops.length <= GRADIENT_MIN_STOPS ? "default" : "pointer",
                        opacity: gradient.stops.length <= GRADIENT_MIN_STOPS ? 0.4 : 1
                    }}
                >Remove stop</button>
            </div>
            {stop && (
                <div style={INSPECTOR_GRID}>
                    <div>
                        <label style={INSPECTOR_LABEL}>Stop colour</label>
                        <ColorInput
                            value={stop.color}
                            onChange={v => { const g = withStopColor(gradient, index, v); if (g) onChange(g, true); }}
                        />
                    </div>
                    <div>
                        <label style={INSPECTOR_LABEL}>Stop opacity</label>
                        <NumInput
                            value={Math.round(stop.opacity * 100) / 100}
                            onChange={v => { const g = withStopColor(gradient, index, stop.color, v); if (g) onChange(g, true); }}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}


/**
 * A text node edited WHERE IT IS, rather than in a panel across the window.
 *
 * A real `<textarea>` placed over the node by `overlayTransform` — the same relationship the
 * renderer draws with, so the field lands on the letters under any rotation, scale or zoom. Its
 * typography comes from `resolveTypography`, the function the render model itself uses, because a
 * field whose metrics disagree with the render puts the caret in the wrong place and makes the
 * text jump the moment editing ends.
 *
 * THE NODE IS HIDDEN WHILE IT IS EDITED — via the field's own opaque backdrop rather than a change
 * to the document, which would be an undoable edit for something that is not one. What is on
 * screen is the textarea; what is in the document is whatever has been typed so far, because every
 * keystroke goes through the ordinary coalesced content action. There is no separate buffer to
 * commit and therefore nothing to lose.
 *
 * ESCAPE AND BLUR both leave, and neither is a cancel. A cancel would have to undo an unknown
 * number of coalesced steps; Ctrl+Z already does exactly that and means the same thing everywhere
 * else in the app.
 */
function CanvasTextEditor({ nodeId, doc, viewport, onChange, onDone }: {
    nodeId: string | null;
    doc: ReadonlyDocument;
    viewport: EditorState["viewport"];
    onChange: (text: string) => void;
    onDone: () => void;
}) {
    const ref = React.useRef<HTMLTextAreaElement | null>(null);
    React.useEffect(() => {
        // FOCUSED AND SELECTED on open: double-clicking a label in any other tool leaves you
        // able to type over it immediately, and a placeholder "Text" you have to select by hand
        // is the most common thing anybody replaces.
        const el = ref.current;
        if (!el) return;
        el.focus();
        el.select();
    }, [nodeId]);

    if (!nodeId) return null;
    const scene = resolveScene(doc);
    const node = scene.nodes.get(nodeId);
    const computed = computeGeometry(scene).nodes.get(nodeId);
    // The node went away under the editor (an undo, a delete): close rather than float over
    // nothing. Rendering null is enough — `onDone` here would set state during a render.
    if (!node || node.type !== "core.text" || !computed) return null;

    const type = resolveTypography(node.style, doc.variables as VariableStore, doc.activeTheme);
    return (
        <textarea
            ref={ref}
            value={node.text ?? ""}
            spellCheck={false}
            onChange={e => onChange(e.target.value)}
            onBlur={onDone}
            onKeyDown={e => {
                // ESCAPE LEAVES. Enter does NOT: a text node holds real newlines (schema 34) and
                // every backend draws them, so Enter has to type one.
                if (e.key === "Escape") { e.stopPropagation(); onDone(); }
                // Everything else stays in the field. Without this a Delete reaches the canvas
                // handler and removes the node being typed into.
                else e.stopPropagation();
            }}
            style={{
                position: "absolute", top: 0, left: 0, margin: 0,
                width: computed.local.width, height: computed.local.height,
                // PLACED BY THE SAME MATRIX THE RENDERER USES, from the element's own origin.
                transform: overlayTransform(computed.world, viewport),
                transformOrigin: "0 0",
                // The typography the renderer resolved, so the text does not move when the field
                // closes. `fontSize` is in WORLD units and the matrix carries the zoom, exactly as
                // it does for the node itself.
                fontSize: type.fontSize,
                fontFamily: type.fontFamily,
                fontWeight: type.fontWeight,
                textAlign: type.textAlign === "justify" ? "justify" : type.textAlign,
                lineHeight: type.lineHeight,
                letterSpacing: type.letterSpacing,
                // OPAQUE, so the node underneath does not show through as a second copy — the
                // canvas background rather than a panel colour, because it stands in for the
                // canvas here.
                background: "#1a1a2e",
                color: typeof node.style.fill === "string" ? node.style.fill : flatFill(node.style.fill),
                caretColor: UI.accent,
                border: `1px solid ${UI.accent}`,
                outline: "none", padding: 0, resize: "none", overflow: "hidden",
                boxSizing: "border-box"
            }}
        />
    );
}

/**
 * The four nine-slice insets (schema 57).
 *
 * BLANK CLEARS THE WHOLE THING, like the region fields above and for the same reason: a nine-slice
 * missing one number is not a narrower border, it is not a nine-slice. Zero IS a real value — a
 * three-slice bar has no top or bottom corner — so the clear has to be emptiness rather than 0.
 *
 * The SAME shared validator the loader uses, so a field cannot author insets the document would
 * refuse to reopen.
 */
function NineSliceFields({ node, onEdit }: {
    node: { type: NodeType; nineSlice?: NineSliceInsets };
    onEdit: (patch: { nineSlice: NineSliceInsets | null }) => void;
}) {
    return (
        <>
            <label style={INSPECTOR_LABEL}>Nine-slice (source pixels)</label>
            <div style={{ display: "flex", gap: 4 }}>
                {(["left", "top", "right", "bottom"] as const).map(key => (
                    <input
                        key={key}
                        type="number"
                        data-nineslice={key}
                        placeholder={key}
                        value={node.nineSlice ? String(node.nineSlice[key]) : ""}
                        onChange={e => {
                            const raw = e.target.value;
                            if (raw === "") { onEdit({ nineSlice: null }); return; }
                            const base = node.nineSlice ?? { left: 0, top: 0, right: 0, bottom: 0 };
                            const next = { ...base, [key]: Number(raw) };
                            if (nineSliceError(node.type, next) !== null) return;
                            onEdit({ nineSlice: next });
                        }}
                        style={{ width: "25%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                            background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                    />
                ))}
            </div>
        </>
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
function FoldersDrawer({ onPlaceImage, getDocument, selectedImage, onImportTrack, onSetRegion, onImportSvg,
    editContentFont, onImportTiles, paintColour, onPickColour, selectedRasterId, onQuantize,
    onImportSequence, onImportAseprite, onImport3D, onImportEnvironment3D, getProjectPath }: {
    getProjectPath: () => string | null;
    onPlaceImage: (dataUrl: string, name: string) => void;
    /** A numbered run of files as one animated node: its name, frame zero's data URL, its track. */
    onImportSequence: (name: string, first: string, track: Keyframe[]) => void;
    /** An `.aseprite` as one animated node: the file's own clock and its tags, too. */
    onImportAseprite: (p: AsepritePlacementInput) => void;
    onImport3D: (filePath: string, name: string, loaded: LoadedAsset3D) => Promise<void>;
    onImportEnvironment3D: (filePath: string, name: string, image: HdrEnvironmentImage) => Promise<void>;
    getDocument: () => ReadonlyDocument;
    /** The selected node when it is an image with a source — what a SHEET import acts ON. */
    selectedImage: { id: string; src: string } | null;
    onImportTrack: (track: Keyframe[]) => void;
    onSetRegion: (rect: SourceRect) => void;
    onImportSvg: (specs: SvgNodeSpec[]) => void;
    /** Apply a registered family to the selected node — the point of loading one. */
    editContentFont: (family: string) => void;
    onImportTiles: (placements: TilePlacement[], tilesets?: Tileset[], background?: string, screen?: { width: number; height: number }) => void;
    /** The swatch a palette click writes to, and what it currently holds. */
    paintColour: string;
    onPickColour: (hex: string) => void;
    /** Quantising acts on a RASTER's pixels, so the button is dead without one selected. */
    selectedRasterId: string | null;
    onQuantize: (palette: Palette) => void;
}) {
    const [tab, setTab] = useState<"source" | "assets" | "export" | "import">("source");
    /** Grid inputs. Strings, because a half-typed number is a state a number input has to hold. */
    const [cellW, setCellW] = useState("32");
    const [cellH, setCellH] = useState("32");
    const [margin, setMargin] = useState("0");
    const [spacing, setSpacing] = useState("0");
    const [step, setStep] = useState("2");
    const [palettes, setPalettes] = useState<Palette[]>([]);
    const [palette, setPalette] = useState<Palette | null>(null);
    const [atlasText, setAtlasText] = useState("");
    const [atlasEntries, setAtlasEntries] = useState<AtlasEntry[] | null>(null);
    const [svgText, setSvgText] = useState("");
    const [fonts, setFonts] = useState<FontInfo[]>(registeredFonts());
    const [tiledFolder, setTiledFolder] = useState<string | null>(null);
    const [tiledMaps, setTiledMaps] = useState<{ path: string; name: string; relative: string }[]>([]);
    const [unityFolder, setUnityFolder] = useState<string | null>(null);
    const [unityPacks, setUnityPacks] = useState<{ path: string; name: string; bytes: number; relative: string }[]>([]);
    /** What the chosen package holds — images are placeable, everything else is counted. */
    const [unityAssets, setUnityAssets] = useState<UnityAsset[]>([]);
    const [aseFolder, setAseFolder] = useState<string | null>(null);
    const [aseFiles, setAseFiles] = useState<{ path: string; name: string; bytes: number; relative: string }[]>([]);
    const [modelFolder, setModelFolder] = useState<string | null>(null);
    const [modelFiles, setModelFiles] = useState<{ path: string; name: string; bytes: number; relative: string }[]>([]);
    const [environmentFolder, setEnvironmentFolder] = useState<string | null>(null);
    const [environmentFiles, setEnvironmentFiles] = useState<{ path: string; name: string; bytes: number; relative: string }[]>([]);
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

    /**
     * The numbered runs in the listed folder — computed from the NAMES the folder read already
     * returned, which is why this costs a picker rather than a new IPC channel.
     *
     * A ONE-FRAME RUN IS NOT AN ANIMATION. `groupSequences` groups by stem and reports singletons
     * faithfully, so a folder of unrelated `icon_1.png`, `logo_2.png` would otherwise offer a row
     * per file that does nothing a click on the file itself does not.
     */
    const sequences = useMemo(
        () => groupSequences(assets.map(a => a.name)).filter(s => s.frames.length > 1),
        [assets]
    );

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

                    {/* PALETTES. `paint/Palette` and `paint/Quantize` were whole modules the app
                        could not reach — the feature audit's second and third built-but-unreachable
                        entries. This is the door.

                        A GRID, NOT A REFLOWED LIST. The palette's own `width`/`height` are honoured
                        because the layout is part of the artist's meaning: DawnBringer's 32 colours
                        are 8x4 to group ramps into rows, and reflowing them to fit a panel would
                        destroy the grouping while keeping every colour. A slot with no colour is
                        drawn as a HOLE for the same reason — 56 colours do not fill 12x5, and
                        shifting the tail up would move every swatch after the gap. */}
                    <label style={INSPECTOR_LABEL}>Load palettes from a folder</label>
                    <button
                        data-palette-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const files = await api.readPaletteFolder(folder);
                                const found: Palette[] = [];
                                const problems: string[] = [];
                                for (const f of files) {
                                    let text: string;
                                    try { text = await api.readPaletteFile(folder, f.path); }
                                    catch (err) { problems.push(`${f.name}: ${String(err)}`); continue; }
                                    // JSON.parse THROWING IS HANDLED HERE, not in the parser: it is
                                    // the one failure that carries a useful message about WHERE the
                                    // file is malformed, and the parser takes parsed JSON so that
                                    // message is not swallowed into a flat null.
                                    let json: unknown;
                                    try { json = JSON.parse(text); }
                                    catch (err) { problems.push(`${f.name}: ${String(err)}`); continue; }
                                    const palette = parsePaletteFile(json, f.name);
                                    // NOT EVERY `.json` IS A PALETTE, and there is no palette
                                    // extension to scan for — so the honest report is how many of
                                    // the files found actually described one.
                                    if (palette) found.push(palette);
                                }
                                setPalettes(found);
                                if (found.length > 0) setPalette(found[0]);
                                setImportNote(`${found.length} palette${found.length === 1 ? "" : "s"} `
                                    + `of ${files.length} .json file${files.length === 1 ? "" : "s"}`
                                    + (problems.length > 0 ? ` · ${problems[0]}` : ""));
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Reading…" : "Find palettes…"}</button>
                    {palettes.length > 1 && (
                        <select
                            data-palette-list="1"
                            value={palette ? palette.name : ""}
                            onChange={e => setPalette(palettes.find(p => p.name === e.target.value) ?? null)}
                            style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                        >
                            {palettes.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                        </select>
                    )}
                    {palette && (
                        <div data-palette-grid="1">
                            <div style={{
                                display: "grid", gap: 1, marginBottom: 4,
                                gridTemplateColumns: `repeat(${palette.width}, 1fr)`
                            }}>
                                {Array.from({ length: palette.width * palette.height }, (_, i) => {
                                    // ADDRESSED BY SLOT, so a hole stays where it is. `paletteAt`
                                    // is the shared accessor rather than an index into `colours`,
                                    // which may be shorter than the grid.
                                    const c = paletteAt(palette, i % palette.width, Math.floor(i / palette.width));
                                    if (!c || c[3] === 0) {
                                        return <div key={i} style={{ aspectRatio: "1", background: "transparent",
                                            border: `1px dashed ${UI.line}` }} />;
                                    }
                                    const hex = rgbaToHex(c);
                                    return (
                                        <button
                                            key={i}
                                            title={hex}
                                            aria-label={`Palette colour ${hex}`}
                                            onClick={() => onPickColour(hex)}
                                            style={{
                                                aspectRatio: "1", background: hex, cursor: "pointer",
                                                border: paintColour.toLowerCase() === hex.toLowerCase()
                                                    ? `2px solid ${UI.accent}` : "1px solid #0006",
                                                padding: 0
                                            }}
                                        />
                                    );
                                })}
                            </div>
                            {/* THE ATTRIBUTION IS SHOWN because a palette is somebody's work, and
                                the file carries the credit as a field. Dropping it on the floor
                                while using the colours would be the wrong call. */}
                            {palette.comment && (
                                <div style={{ color: "#666", fontSize: 10, whiteSpace: "pre-wrap", marginBottom: 4 }}>
                                    {palette.comment}
                                </div>
                            )}
                            <button
                                data-quantize-btn="1"
                                disabled={!selectedRasterId}
                                title={selectedRasterId
                                    ? "Snap every pixel of the selected canvas to its nearest palette colour"
                                    : "Select a canvas first — quantising acts on a raster's pixels"}
                                onClick={() => onQuantize(palette)}
                                style={{ ...DRAWER_BUTTON, opacity: selectedRasterId ? 1 : 0.5 }}
                            >Quantise the selected canvas</button>
                        </div>
                    )}

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
                                        // A sheet-backed set has ONE image; a collection has one
                                        // per tile. Both are cached by path, so a tile referenced
                                        // a thousand times is still decoded once.
                                        const wanted = set.image ? [set.image]
                                            : set.tiles.flatMap(t => t.image === null ? [] : [t.image]);
                                        for (const rel of wanted) {
                                            if (sheets.has(rel)) continue;
                                            try {
                                                sheets.set(rel, await api.readTiledImage(tiledFolder, mapPath, rel));
                                            } catch (err) { problems.push(`${rel}: ${String(err)}`); }
                                        }
                                        // A SET THAT DECLARES NEITHER ITS COLUMN COUNT NOR ITS
                                        // IMAGE'S SIZE can only be sliced by MEASURING the picture,
                                        // and this is the one place that holds both. `deriveGrid`
                                        // already recovers the count from a DECLARED size — 25 of
                                        // the tree's 26 such sets are answered that way, in the
                                        // parser, with no bitmap — so this is the last case rather
                                        // than the common one, and the decode is paid for only by
                                        // the file that needs it. Tiled's own `perspective_walls`
                                        // is that file: 79 painted cells that resolved to nothing.
                                        const sheetPath = set.image;
                                        if (sheetPath && set.columns <= 0 && set.imageWidth === null) {
                                            const url = sheets.get(sheetPath);
                                            const size = url ? await imageSizeAsync(url) : null;
                                            if (size) set = withImageSize(set, size.width, size.height);
                                            // SAID OUT LOUD when it cannot be measured either, or
                                            // the map arrives empty with nothing to act on — which
                                            // is how this one went unnoticed.
                                            else problems.push(`tileset "${set.name}" states neither a column `
                                                + "count nor its image's size, and the image could not be "
                                                + "measured, so none of its tiles could be placed");
                                        }
                                        sets.push(set);
                                        // Reported once RESOLVED, which is the only point an
                                        // external set has an image to be measured against — and
                                        // that is now after the grid is recovered, since a set with
                                        // no columns has no grid to overflow.
                                        if (stub.source) {
                                            const over = tilesetOverflow(set);
                                            if (over) problems.push(over);
                                        }
                                    }

                                    // THE CONVERSION LIVES IN `core/import/tiledPlacements` NOW, and moving
                                    // it there was the point rather than the tidiness. `window.electronAPI`
                                    // is frozen, so this handler cannot be driven from a test or a script —
                                    // which meant the most intricate part of the importer (grid-or-per-cell
                                    // per layer, tileset deduplication, anchoring, object layers) was the
                                    // one part nothing could exercise. Everything ABOVE this line is
                                    // filesystem work that genuinely needs a filesystem; everything below
                                    // it was pure all along and is now reachable.
                                    const built = buildPlacements(map, sets, sheets,
                                        { newId: generateUUID, problems });
                                    const tiles = built.placements;
                                    const newTilesets = built.tilesets;

                                    if (tiles.length > TILE_PLACE_MAX) {
                                        setImportNote(`${tiles.length} nodes is more than the `
                                            + `${TILE_PLACE_MAX} this will place at once.`);
                                        return;
                                    }
                                    onImportTiles(tiles, newTilesets, map.background,
                                        map.width > 0 && map.tileWidth > 0
                                            ? { width: map.width * map.tileWidth,
                                                height: map.height * map.tileHeight }
                                            : undefined);
                                    setImportNote(tiledImportNote(map, built));
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

                    <label style={INSPECTOR_LABEL}>Import a 3D model</label>
                    <button
                        data-model-3d-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const files = await api.read3DFolder(folder);
                                setModelFolder(folder); setModelFiles(files);
                                setImportNote(files.length === 0 ? "No .gltf or .glb files in that folder."
                                    : `${files.length} 3D model${files.length === 1 ? "" : "s"} found`);
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Reading…" : "Find glTF/GLB models…"}</button>
                    {modelFiles.length > 0 && modelFolder && (
                        <select
                            data-model-3d-list="1"
                            defaultValue=""
                            onChange={async e => {
                                const file = modelFiles.find(f => f.path === e.target.value);
                                if (!file) return;
                                setBusy(true);
                                try {
                                    const loaded = await loadAsset3D(api, modelFolder, file.path);
                                    await onImport3D(file.path, file.name.replace(/\.(gltf|glb)$/i, ""), loaded);
                                    setImportNote(`Imported ${loaded.mesh.instances.length} primitive${loaded.mesh.instances.length === 1 ? "" : "s"}`
                                        + (loaded.notes.length ? ` · ${loaded.notes[0]}` : ""));
                                } catch (err) { setImportNote(String(err instanceof Error ? err.message : err)); }
                                finally { setBusy(false); }
                            }}
                            style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                        >
                            <option value="">Import a model…</option>
                            {modelFiles.map(f => <option key={f.path} value={f.path}>{f.relative}</option>)}
                        </select>
                    )}

                    <label style={INSPECTOR_LABEL}>Import an HDR environment</label>
                    <button disabled={busy} onClick={async () => {
                        const folder = await api.pickFolder(); if (!folder) return;
                        setBusy(true);
                        try {
                            const files = await api.readEnvironmentFolder(folder);
                            setEnvironmentFolder(folder); setEnvironmentFiles(files);
                            setImportNote(files.length ? `${files.length} HDR environment${files.length === 1 ? "" : "s"} found`
                                : "No Radiance .hdr files in that folder.");
                        } finally { setBusy(false); }
                    }} style={DRAWER_BUTTON}>{busy ? "Reading…" : "Find Radiance HDR files…"}</button>
                    {environmentFiles.length > 0 && environmentFolder && (
                        <select data-environment-3d-list="1" defaultValue="" onChange={async event => {
                            const file = environmentFiles.find(candidate => candidate.path === event.target.value);
                            if (!file) return;
                            setBusy(true);
                            try {
                                const image = await loadEnvironment3D(api, environmentFolder, file.path);
                                await onImportEnvironment3D(file.path, file.name.replace(/\.hdr$/i, ""), image);
                                setImportNote(`Imported HDR environment ${image.width}×${image.height}`);
                            } catch (error) { setImportNote(String(error instanceof Error ? error.message : error)); }
                            finally { setBusy(false); }
                        }} style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                            color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}>
                            <option value="">Use an environment…</option>
                            {environmentFiles.map(file => <option key={file.path} value={file.path}>{file.relative}</option>)}
                        </select>
                    )}

                    {/* THE FILE THE SHEET WAS EXPORTED FROM. The reader was written months ago,
                        tested, pinned in apiSurface, and had no door — and opening one meant
                        building a frame compositor, a write path for `Document.clips`, and a
                        transaction that can carry two document-level deltas. None was about
                        Aseprite; all three were things this engine could not do. */}
                    <button
                        data-ase-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const files = await api.readAsepriteFolder(folder);
                                setAseFolder(folder);
                                setAseFiles(files);
                                setImportNote(files.length === 0
                                    ? "No .aseprite files in that folder."
                                    : `${files.length} Aseprite file${files.length === 1 ? "" : "s"} found`);
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Reading…" : "Find Aseprite files…"}</button>
                    {aseFiles.length > 0 && aseFolder && (
                        <select
                            data-ase-list="1"
                            defaultValue=""
                            onChange={async e => {
                                const filePath = e.target.value;
                                if (!filePath) return;
                                setBusy(true);
                                try {
                                    const b64 = await api.readAsepriteBytes(aseFolder, filePath);
                                    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                                    // THE SHARED VALIDATOR, so the panel refuses exactly what the
                                    // reader would and says the same thing about why.
                                    const bad = asepriteError(bytes);
                                    if (bad) { setImportNote(`Cannot read that file: ${bad}.`); return; }
                                    // CEL PIXELS ARE ZLIB, the same compression a `.tmx` layer uses,
                                    // so the channel that already exists serves both.
                                    const file = parseAseprite(bytes, {
                                        inflate: (d: Uint8Array) => {
                                            let bin = "";
                                            for (const b of d) bin += String.fromCharCode(b);
                                            const r = api.inflateSync(btoa(bin));
                                            if (!r.ok || !r.data) throw new Error(r.error ?? "inflate failed");
                                            return Uint8Array.from(atob(r.data), c => c.charCodeAt(0));
                                        }
                                    });
                                    const timeline = asepriteTimeline(file);
                                    // ENCODED HERE because only the renderer has a canvas, and the
                                    // compositor is pure on purpose — it returns pixels, not a PNG.
                                    const canvas = document.createElement("canvas");
                                    canvas.width = file.width;
                                    canvas.height = file.height;
                                    const ctx = canvas.getContext("2d");
                                    if (!ctx) { setImportNote("No 2D context to compose frames with."); return; }
                                    const track: Keyframe[] = [];
                                    const notes = new Set<string>();
                                    for (let f = 0; f < file.frames.length; f++) {
                                        const composed = composeFrame(file, f);
                                        if (!composed) continue;
                                        for (const n of composed.notes) notes.add(n);
                                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                                        ctx.putImageData(new ImageData(
                                            new Uint8ClampedArray(composed.rgba), composed.width, composed.height), 0, 0);
                                        track.push({ frame: f, values: { src: canvas.toDataURL("image/png") } });
                                    }
                                    if (track.length === 0) { setImportNote("That file has no frames to import."); return; }
                                    onImportAseprite({
                                        name: (aseFiles.find(x => x.path === filePath)?.name ?? "aseprite")
                                            .replace(/\.(aseprite|ase)$/i, ""),
                                        first: track[0].values.src as string,
                                        track,
                                        timeline,
                                        clips: asepriteClips(file),
                                        width: file.width,
                                        height: file.height
                                    });
                                    setImportNote(`${track.length} frames at ${timeline.fps}fps, `
                                        + `${file.tags.length} tag${file.tags.length === 1 ? "" : "s"}`
                                        // BLEND MODES THIS CANNOT HONOUR ARE SURFACED rather than
                                        // left in a console nobody reads — the compositor names them.
                                        + (notes.size > 0 ? ` — ${notes.size} layer(s) drawn as normal` : ""));
                                } catch (err) {
                                    setImportNote(`Could not read that file: ${String(err).slice(0, 80)}`);
                                } finally { setBusy(false); }
                            }}
                            style={{ ...DRAWER_BUTTON, marginBottom: 6 }}
                        >
                            <option value="">Import an animation…</option>
                            {aseFiles.map(f => <option key={f.path} value={f.path}>{f.relative}</option>)}
                        </select>
                    )}

                    {/* A `.unitypackage` is a gzipped tar of GUID folders, and nothing here could
                        open one — seven sit in this tree. This is the door: the reader was written
                        first and left deliberately unreachable, which is a state this project
                        treats as a defect rather than a milestone. */}
                    <button
                        data-unity-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const packs = await api.readUnityFolder(folder);
                                setUnityFolder(folder);
                                setUnityPacks(packs);
                                setUnityAssets([]);
                                setImportNote(packs.length === 0
                                    ? "No .unitypackage files in that folder."
                                    : `${packs.length} package${packs.length === 1 ? "" : "s"} found`);
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Reading…" : "Find Unity packages…"}</button>
                    {unityPacks.length > 0 && unityFolder && (
                        <select
                            data-unity-list="1"
                            defaultValue=""
                            onChange={async e => {
                                const pkgPath = e.target.value;
                                if (!pkgPath) return;
                                setBusy(true);
                                try {
                                    const b64 = await api.readUnityPackage(unityFolder, pkgPath);
                                    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                                    // THE INJECTION POINT, used at last: the parser takes a gunzip
                                    // it calls during the parse, which is what keeps it pure and
                                    // testable with no decompressor present.
                                    const held = parseUnityPackage(bytes, {
                                        gunzip: d => {
                                            let bin = "";
                                            for (let i = 0; i < d.length; i++) bin += String.fromCharCode(d[i]);
                                            const r = api.gunzipSync(btoa(bin));
                                            if (!r.ok || !r.data) throw new Error(r.error ?? "gunzip failed");
                                            return Uint8Array.from(atob(r.data), c => c.charCodeAt(0));
                                        }
                                    });
                                    setUnityAssets(held.assets);
                                    const images = held.assets.filter(a => UNITY_IMAGE.test(a.path)).length;
                                    setImportNote(`${held.assets.length} files, ${images} placeable`
                                        + (held.notes.length > 0 ? ` — ${held.notes.length} not read` : ""));
                                } catch (err) {
                                    setImportNote(String(err instanceof Error ? err.message : err));
                                } finally { setBusy(false); }
                            }}
                            style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                        >
                            <option value="">Open a package…</option>
                            {unityPacks.map(u => (
                                <option key={u.path} value={u.path}>
                                    {u.relative} ({Math.round(u.bytes / 1024)}KB)
                                </option>
                            ))}
                        </select>
                    )}
                    {unityAssets.length > 0 && (
                        <div data-unity-assets="1" style={{ maxHeight: 180, overflowY: "auto", marginBottom: 6 }}>
                            {unityAssets.filter(a => UNITY_IMAGE.test(a.path)).map(a => (
                                <button
                                    key={a.guid}
                                    title={a.path}
                                    aria-label={`Place ${a.path}`}
                                    onClick={() => {
                                        // BYTES TO A DATA URL, because that is what a `core.image`
                                        // holds — a package's files never touch the disk, so nothing
                                        // is unpacked anywhere the author did not ask for.
                                        let bin = "";
                                        for (let i = 0; i < a.bytes.length; i++) bin += String.fromCharCode(a.bytes[i]);
                                        const ext = a.path.split(".").pop()!.toLowerCase();
                                        onPlaceImage(`data:image/${ext === "jpg" ? "jpeg" : ext};base64,${btoa(bin)}`,
                                            a.path.split("/").pop() ?? a.path);
                                    }}
                                    style={{ ...DRAWER_BUTTON, textAlign: "left", width: "100%", marginBottom: 2 }}
                                >{a.path.split("/").pop()}</button>
                            ))}
                        </div>
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
                                const written = await api.writeIntoFolder(folder, "design.svg", exportSVG(getDocument(), exportTextLines, EXPORT_IMAGES));
                                setExported(written);
                            } finally { setBusy(false); }
                        }}
                        disabled={busy}
                        style={DRAWER_BUTTON}
                    >{busy ? "Writing…" : "Export SVG to a folder…"}</button>
                    <button disabled={busy} style={DRAWER_BUTTON} data-export-png="1" onClick={async () => {
                        setBusy(true);
                        try {
                            const folder = await api.pickFolder();
                            if (folder) setExported(await api.writePngIntoFolder(folder, "design.png", await exportCanvasPng(getDocument())));
                        } catch (error) { setExported(`PNG export failed: ${String(error)}`); }
                        finally { setBusy(false); }
                    }}>Export whole canvas as PNG…</button>
                    <button disabled={busy} style={DRAWER_BUTTON} data-export-game="1" onClick={async () => {
                        setBusy(true);
                        try {
                            const folder = await api.pickFolder();
                            if (folder) setExported(await api.exportGame(folder, serializeDocument(getDocument()), getProjectPath()));
                        } catch (error) { setExported(`Game export failed: ${String(error)}`); }
                        finally { setBusy(false); }
                    }}>Export offline 2D game (HTML)…</button>
                    <button disabled={busy} style={DRAWER_BUTTON} data-export-game-3d="1" onClick={async () => {
                        setBusy(true);
                        try {
                            const folder = await api.pickFolder();
                            if (folder) setExported(await api.exportGame3D(folder, serializeDocument(getDocument()), getProjectPath()));
                        } catch (error) { setExported(`3D game export failed: ${String(error)}`); }
                        finally { setBusy(false); }
                    }}>Export offline 3D game (HTML)…</button>
                    <small>3D export includes referenced assets only. Check their redistribution and credit requirements before sharing.</small>

                    {/* A MAP CAN LEAVE AGAIN (2026-08-10). Canvas Fogworks reads a Tiled map, turns each layer
                        into one grid, places its objects and authors terrain — and until now
                        nothing went the other way, which made this tool a one-way door for art.
                        The sheet is named rather than copied: a `.tmx` states a relative path, and
                        only the person choosing the folder knows what is beside it. */}
                    <button
                        data-export-tmx="1"
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                // The SAME pure exporter the round-trip test exercises; the main
                                // process only writes.
                                const out = exportTiledMap(getDocument(), "tiles.png");
                                if (out.xml === "") { setExported(out.notes[0] ?? "nothing to export"); return; }
                                const written = await api.writeIntoFolder(folder, "map.tmx", out.xml);
                                // WHAT COULD NOT BE WRITTEN IS SAID, not swallowed: a .tmx holds one
                                // size for every layer, and a map that quietly lost one is the kind
                                // of export somebody discovers a week later.
                                setExported(written + (out.notes.length > 0 ? ` · ${out.notes[0]}` : ""));
                            } finally { setBusy(false); }
                        }}
                        disabled={busy}
                        style={DRAWER_BUTTON}
                    >{busy ? "Writing…" : "Export the tile layers as .tmx…"}</button>
                    <input
                        type="text"
                        placeholder="…or paste a folder path and press Enter"
                        onKeyDown={async e => {
                            if (e.key !== "Enter") return;
                            const folder = (e.target as HTMLInputElement).value.trim();
                            if (!folder) return;
                            setBusy(true);
                            try { setExported(await api.writeIntoFolder(folder, "design.svg", exportSVG(getDocument(), exportTextLines, EXPORT_IMAGES))); }
                            finally { setBusy(false); }
                        }}
                        style={{ width: "100%", boxSizing: "border-box", fontSize: 11, padding: "3px 5px", background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3, marginBottom: 6 }}
                    />
                    {exported && <div style={{ color: "#6a9", wordBreak: "break-all" }}>Wrote {exported}</div>}
                    {/* PREVIEW: the same `exportSVG` output, without writing a file. Worth having
                        on its own — you can read what you are about to hand someone — and it is
                        the only way to see the export without a native dialog in the way. */}
                    <button onClick={() => setPreview(exportSVG(getDocument(), exportTextLines, EXPORT_IMAGES))} style={DRAWER_BUTTON}>
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
                    {sequences.length > 0 && (
                        <>
                            <label style={INSPECTOR_LABEL}>Numbered runs in this folder</label>
                            <div style={{ marginBottom: 8 }}>
                                {sequences.map(s => {
                                    const tooMany = s.frames.length > SEQUENCE_IMPORT_MAX;
                                    return (
                                        <button
                                            key={s.name}
                                            data-sequence={s.name}
                                            disabled={busy || tooMany}
                                            title={tooMany
                                                // THE TILESET CASE, which is most of what a real folder holds: a sheet
                                                // exported as `tile_0000.png … tile_9999.png` is a numbered run by every
                                                // rule this reader has, and it is not an animation. Measured here: one
                                                // pack groups to 11,846 frames. Refusing loudly beats reading eleven
                                                // thousand images into data URLs to build an eight-minute "animation".
                                                ? `${s.frames.length} frames — too many to be an animation. This is `
                                                  + `almost certainly a tileset exported one file per tile; slice the `
                                                  + `sheet instead.`
                                                : `Import ${s.frames.length} frames as one animated node`}
                                            onClick={async () => {
                                                setBusy(true);
                                                try {
                                                    const prepared = await prepareSequenceImport(api, assetFolder!, assets, s);
                                                    if (!prepared.ok) { setImportNote(prepared.error); return; }
                                                    onImportSequence(prepared.name, prepared.first, prepared.track);
                                                    setImportNote(prepared.note);
                                                } finally { setBusy(false); }
                                            }}
                                            style={{ ...DRAWER_BUTTON, textAlign: "left", opacity: tooMany ? 0.5 : 1 }}
                                        >{s.name || "(unnamed)"} — {s.frames.length} frames</button>
                                    );
                                })}
                            </div>
                        </>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                        {assets.slice(0, 300).map(a => (
                            <button
                                key={a.path}
                                title={`${a.relative} — click to place on the canvas`}
                                onClick={async () => {
                                    setBusy(true);
                                    try {
                                        onPlaceImage(await api.readImageDataUrl(assetFolder!, a.path), a.name);
                                        setImportNote(`Placed ${a.relative}.`);
                                    } catch (err) {
                                        setImportNote(`Could not read ${a.relative}: ${String(err instanceof Error ? err.message : err)}`);
                                    } finally { setBusy(false); }
                                }}
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

/**
 * The author's own kind for a node, and its custom properties (schema 64).
 *
 * WHAT THE ENGINE CARRIES WITHOUT READING, which is exactly why it needs a panel: nothing else in
 * the app would ever show it, so a property imported from a map would live in the file, survive
 * every save, and be invisible to the person who owns it.
 *
 * THE TYPE IS A FREE TEXT FIELD rather than a dropdown, and that is deliberate. The document stores
 * whatever the file declared so that a map written by a newer editor round-trips untouched; a
 * closed list here would make those types uneditable — visible, unchangeable, and silently replaced
 * the moment anyone touched the row. The common ones are offered as a datalist instead.
 */
function MetadataSection({ node, dispatcher, refresh }: { node: Node; dispatcher: ActionDispatcher; refresh: () => void }) {
    const [newName, setNewName] = useState("");
    const data = node.userData ?? {};
    const names = Object.keys(data).sort();

    const write = (patch: { className?: string | null; userData?: UserData | null; entity?: Entity | null }) => {
        dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(), node.id, patch));
        refresh();
    };
    const setEntity = <K extends keyof Entity>(key: K, value: Entity[K] | undefined) => {
        const next: Entity = { ...(node.entity ?? {}) };
        if (value === undefined) delete next[key]; else next[key] = value;
        write({ entity: Object.keys(next).length ? next : null });
    };
    /** One property replaced, or removed when `next` is null — the whole map travels, as the delta wants. */
    const setProp = (name: string, next: { type: string; propertyType?: string; value: string } | null) => {
        const copy: UserData = { ...data };
        if (next === null) delete copy[name];
        else copy[name] = next;
        write({ userData: copy });
    };

    return (
        <>
            <label style={INSPECTOR_LABEL}>Class</label>
            <TextInput
                value={node.className ?? ""}
                placeholder="none"
                onChange={v => write({ className: v.trim() === "" ? null : v.trim() })}
            />
            <div style={{ color: UI.textDim, fontSize: 10, marginTop: 10, marginBottom: 4 }}>Runtime entity</div>
            <label style={INSPECTOR_LABEL}>Body</label>
            <SelectInput value={node.entity?.body ?? ""} options={["", "static", "dynamic", "oneway"]}
                onChange={v => setEntity("body", v === "" ? undefined : v as Entity["body"])} />
            <label style={{ ...INSPECTOR_LABEL, display: "flex", gap: 6 }}>
                <input type="checkbox" checked={node.entity?.player === true}
                    onChange={e => setEntity("player", e.target.checked || undefined)} /> Player
            </label>
            <label style={INSPECTOR_LABEL}>Respawn anchor node id</label>
            <TextInput value={node.entity?.respawnAt ?? ""} placeholder="optional node id"
                onChange={v => setEntity("respawnAt", v.trim() || undefined)} />
            <label style={INSPECTOR_LABEL}>Next level project</label>
            <TextInput value={node.entity?.transitionTo ?? ""} placeholder="level-2.vde"
                onChange={v => setEntity("transitionTo", v.trim() || undefined)} />
            <label style={INSPECTOR_LABEL}>Warp destination node id</label>
            <TextInput value={node.entity?.warpsTo ?? ""} placeholder="optional node id"
                onChange={v => setEntity("warpsTo", v.trim() || undefined)} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, marginTop: 6 }}>
                {(["stompable", "deadly", "goal", "collectible"] as const).map(key => (
                    <label key={key} style={{ ...INSPECTOR_LABEL, display: "flex", gap: 5 }}>
                        <input type="checkbox" checked={node.entity?.[key] === true}
                            onChange={e => setEntity(key, e.target.checked || undefined)} /> {key}
                    </label>
                ))}
            </div>
            {(["friction", "patrol", "powers", "stars", "bounces"] as const).map(key => (
                <div key={key}>
                    <label style={INSPECTOR_LABEL}>{key}</label>
                    <NumInput value={node.entity?.[key] ?? 0}
                        onChange={v => setEntity(key, Number.isFinite(v) ? v : undefined)} />
                </div>
            ))}
            <ActorPlacementPanel key={`actor-${node.id}`} nodeId={node.id} dispatcher={dispatcher} onPlaced={refresh}/>
            <GameplayPanel key={node.id} entity={node.entity ?? {}} onChange={entity => write({ entity })}
                assets={dispatcher.getDocument().behaviorAssets}
                variables={dispatcher.getDocument().gameplayVariables}
                functions={dispatcher.getDocument().behaviorFunctions}
                onFunctionsChange={functions=>{const result=dispatcher.dispatchAction(new SetBehaviorFunctionsAction(dispatcher.getDocument(),functions));refresh();return result.success;}}
                onVariablesChange={variables=>{const result=dispatcher.dispatchAction(new SetGameplayVariablesAction(dispatcher.getDocument(),variables));refresh();return result.success;}}
                onAssetsChange={(assets,entity)=>{dispatcher.dispatchAction(new SetBehaviorAssetsAction(dispatcher.getDocument(),assets,entity?{nodeId:node.id,entity}:undefined));refresh();}} />
            {node.spatial3d && <>
                <label style={INSPECTOR_LABEL}>3D gravity (enables contact solver)</label>
                <NumInput value={node.entity?.gravity3d ?? 0} onChange={v => setEntity("gravity3d", Math.max(0, Math.min(1000, v)))} />
                <label style={INSPECTOR_LABEL}>3D restitution</label>
                <NumInput value={node.entity?.restitution3d ?? 0} onChange={v => setEntity("restitution3d", Math.max(0, Math.min(1, v)))} />
            </>}
            <datalist id="vde-prop-types">
                {["string", "int", "float", "bool", "color", "file", "object"].map(t => <option key={t} value={t} />)}
            </datalist>
            <div style={{ color: UI.textFaint, fontSize: 10, marginTop: 8, marginBottom: 4 }}>
                {names.length === 0
                    ? "No imported/custom properties. Runtime behavior uses the typed fields above."
                    : `${names.length} imported/custom propert${names.length === 1 ? "y" : "ies"}; preserved for round trips.`}
            </div>
            {names.map(name => {
                const p = data[name];
                return (
                    <div key={name} style={{ display: "grid", gridTemplateColumns: "1fr 64px 20px", gap: 4, marginBottom: 3 }}>
                        <TextInput value={p.value} onChange={v => setProp(name, { ...p, value: v })} />
                        <input
                            list="vde-prop-types"
                            value={p.type}
                            title={`Type of "${name}"${p.propertyType ? ` (${p.propertyType})` : ""}`}
                            onChange={e => {
                                // AN EMPTY TYPE IS NOT A TYPE — `userDataError` refuses it, and the
                                // action would silently do nothing. Mid-edit it reads as "string".
                                const t = e.target.value.trim();
                                setProp(name, { ...p, type: t === "" ? "string" : t });
                            }}
                            style={{ ...SELECT_STYLE, minWidth: 0 }}
                        />
                        <button
                            onClick={() => setProp(name, null)}
                            title={`Remove "${name}"`}
                            aria-label={`Remove property ${name}`}
                            style={{ ...ADJUST_BUTTON, padding: "0 4px" }}
                        >×</button>
                        <div style={{ gridColumn: "1 / -1", color: UI.textFaint, fontSize: 9, marginTop: -2 }}>{name}</div>
                    </div>
                );
            })}
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <TextInput value={newName} placeholder="new property name" onChange={setNewName} />
                <button
                    disabled={newName.trim() === "" || Object.prototype.hasOwnProperty.call(data, newName.trim())}
                    onClick={() => {
                        const n = newName.trim();
                        if (n === "") return;
                        // `string` IS THE FORMAT'S DEFAULT, so a new property starts as one rather
                        // than as a type the author has to correct before it means anything.
                        setProp(n, { type: "string", value: "" });
                        setNewName("");
                    }}
                    aria-label="Add property"
                    style={ADJUST_BUTTON}
                >Add</button>
            </div>
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
            data-layer-node-id={node.id}
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
