/**
 * @module apiSurface
 * @description Compile-time pin for the public API surface documented in
 * `docs/API-CONTRACTS.md`.
 *
 * This file is never executed — it exists so that `tsc` fails if a documented
 * symbol is renamed, removed, or changes shape. It is the same move the engine
 * already uses elsewhere: turn a convention into something the compiler checks.
 *
 * WHY: `docs/API-CONTRACTS.md` drifted three times in one pass while the freeze
 * rule was nominally in force, and the drift was found by accident. An identifier
 * checker was measured against that drift and caught 0 of 4 cases, because the
 * drift was semantic — `ProjectDocument` still existed, it was just no longer the
 * right type. A type-level assertion catches exactly that class.
 *
 * SCOPE — be honest about what this does and does not cover:
 *   ✓ a documented export disappearing or being renamed
 *   ✓ a documented signature changing shape (params, return, readonly-ness)
 *   ✗ prose that describes behaviour which has since changed
 * Prose drift is still caught only by review.
 *
 * COVERAGE was itself the failure once. For six schemas — 37 stroke joins/caps, 38 fill rules, 39
 * animation, 40 depth, 41 mesh, 42 lighting — API-CONTRACTS grew entries for `Mesh`, `Light`,
 * `Depth`, `Timeline`, `emitWebGL` and the whole `geometry/` seam while this file imported none of
 * them. Documented prose with nothing holding it to the code is the exact thing this file exists
 * to prevent, so a pin that silently stops covering new work is worse than no pin: it reads as
 * enforcement. When a module gains a documented export, it gains a line here in the same commit.
 *
 * The pin is verified the same way every guard in this codebase is — by breaking the code on
 * purpose. Eight documented signatures were mutated (a rename, a dropped interface field, a
 * changed return type, an un-exported type, a widened generic, three dropped parameters) and each
 * one failed `tsc` with THIS FILE named in the error. A `tsc` failure that does not name
 * `apiSurface.ts` is the mutation breaking its own module, which scores nothing.
 */

import {
    ProjectDocument, ReadonlyDocument, createEmptyDocument,
    CURRENT_VERSION, SCHEMA_VERSION
} from "../document/Document";
import { Variable, VariableStore, VariableType, VariableValue, ThemeMode, THEME_MODES, VARIABLES_MAX, VARIABLE_KEY_MAX, VARIABLE_FALLBACK_COLOR, isTokenRef, variableError, variableKeyError, variableStoreError, resolveVariable, resolveColor, resolveNumber } from "../document/Variables";
import { Node, NodeType, NODE_TYPES, isNodeType, LayoutContainer, LayoutGrid, TrackSize, Constraints, HConstraint, VConstraint, Margins, layoutError, dimensionError, pathError, PathCommand, PATH_MAX_COMMANDS, styleError, flatFill, Shadow, Layout, RESERVED_NODE_ID, RESERVED_ID_SUBSTRING, nodeIdError, SourceRect, sourceRectError, SOURCE_RECT_MAX } from "../document/Node";
import {
    serializeDocument, deserializeDocument, compareDocuments, Serializer,
    LoadResult, SaveResult
} from "../document/Serializer";
// --- core/paint ---------------------------------------------------------------------------
// Nine modules that shipped over one day with NONE of them pinned here, while API-CONTRACTS grew
// entries for every one. That is the exact failure this file's header describes: a pin that
// silently stops covering new work reads as enforcement while checking nothing.
import { PixelBuffer, Rgba, PIXEL_MAX_SIDE, PIXEL_FILL_MAX, pixelBufferError, createPixelBuffer,
    inBounds, getPixel, setPixel, linePoints, drawLine, floodFill } from "../paint/PixelBuffer";
import { PixelPatch, EMPTY_PATCH, isEmptyPatch, readRegion, capturePatch, applyPatch,
    revertPatch, invertPatch, patchCost } from "../paint/PixelPatch";
import { Brush, BrushDab, BRUSH_MAX_SIZE, brushError, makeBrush, brushFromImage, brushWithVariants,
    pickFace, stampBrush, brushBounds, strokePath, strokeBounds } from "../paint/Brush";
import { EncodedSurface, PIXEL_CODEC_VERSION, PIXEL_RUN_MAX, encodeSurface,
    decodeSurface } from "../paint/PixelCodec";
import { StrokeSession, beginStroke, extendStroke, endStroke, strokeEscaped,
    NO_STROKE } from "../paint/Stroke";
import { Palette, PALETTE_MAX_COLOURS, PALETTE_MAX_SIDE, paletteError, paletteAt, parseFloatColour,
    parsePaletteFile } from "../paint/Palette";
import { SymmetryMode, NO_SYMMETRY, symmetryPoints, isMirrored } from "../paint/Symmetry";
import { colourDistance, nearestColour, quantizeToPalette } from "../paint/Quantize";
import { SurfaceSpace, surfaceSpaceError, worldToSurface, surfaceToWorld,
    surfacePixelSize } from "../paint/SurfaceSpace";
import { RasterSurface, rasterSurfaceError, RASTER_MAX_SIDE } from "../document/Node";
import { ClipboardContents, PasteResult, PASTE_OFFSET, copyNodes, remapForPaste } from "../document/Clipboard";
import { parseSvgGradients } from "../import/SvgGradient";
import { PasteNodesAction } from "../actions/PasteNodesAction";
import { Gradient, GradientStop, GradientUnits, GradientSample, GRADIENT_MAX_STOPS,
    defaultGradient, gradientError, normalizeStops, sampleGradient } from "../document/Gradient";
import { PaintSurfaceAction } from "../actions/PaintSurfaceAction";
import { traverseSceneGraph, selectionRoots, ReadonlyNode } from "../document/SceneGraph";
import { validateDocumentIntegrity } from "../document/Integrity";
import { computeGeometry, hitTest, nodesInRect, toLocal, toWorld, subtreeBounds, selectionBounds, ComputedState, ComputedNode } from "../geometry/GeometryEngine";
import { layoutChildren, layoutGridChildren, resolveGridTracks, placeGridItems, GridCell, breakFlexLines, FlexLine, resolveMargin, expandDirtyForLayout, isLayoutContainer, isAbsolute, measureIntrinsicSizes, resolveConstraints } from "../geometry/LayoutEngine";
import { Mat2D, Rect, IDENTITY, multiply, translation, invert, compose, applyToPoint, transformRectToAABB, unionRect, toMatrixString, parseSvgTransform, isTranslationOnly } from "../geometry/Matrix";
import { Action } from "../actions/Action";
import { MutationResult, NodeDelta, ActionPayload, Revision, DocumentSnapshot, DOCUMENT_DELTA_KEY } from "../actions/types";
import { SetVariableAction, DeleteVariableAction, SetActiveThemeAction } from "../actions/VariableActions";
import { CreateInstanceAction } from "../actions/CreateInstanceAction";
import { expandInstances, componentError, overridesError, isVirtualId, virtualId, splitVirtualId, ownerInstanceOf, InstanceOverride, VIRTUAL_ID_SEP, INSTANCE_MAX_DEPTH, INSTANCE_MAX_NODES, INSTANCE_MAX_OVERRIDES } from "../document/Components";
import { SetInstanceOverrideAction } from "../actions/SetInstanceOverrideAction";
import { geometryActionFor, styleActionFor, overrideTargetFor, isEditableNode } from "../actions/nodeEdit";
import { applyMutationsToDocument } from "../actions/applyMutations";
import { ActionDispatcher } from "../actions/ActionDispatcher";
import { HistoryManager, HistoryLimits, DEFAULT_HISTORY_LIMITS } from "../actions/HistoryManager";
import { AddNodeAction } from "../actions/AddNodeAction";
import { DeleteNodeAction } from "../actions/DeleteNodeAction";
import { MoveNodeAction } from "../actions/MoveNodeAction";
import { ResizeNodeAction } from "../actions/ResizeNodeAction";
import { ReparentNodeAction } from "../actions/ReparentNodeAction";
import { UpdateNodeGeometryAction } from "../actions/UpdateNodeGeometryAction";
import { UpdateNodeStyleAction } from "../actions/UpdateNodeStyleAction";
import { UpdateNodeTransformAction } from "../actions/UpdateNodeTransformAction";
import { UpdateNodeLayoutAction } from "../actions/UpdateNodeLayoutAction";
import { TransactionAction } from "../actions/TransactionAction";
import { createEditorState, clampViewport, panBy, zoomAt, screenToWorld, EditorState } from "../../editor/EditorState";
import { selectionHandles, handleAtPoint, groupRotateHandle, groupHandleAtPoint, groupCornerHandles, SelectionHandle, HANDLE_SIZE_PX, ROTATE_OFFSET_PX } from "../geometry/SelectionHandles";
import { rotateGroup, isGroupRotatable, scaleGroup, isGroupResizable, GroupRotateInput, GroupRotateOutput, GroupScaleInput, GroupScaleOutput } from "../geometry/GroupTransform";
import { computeSnap, snapPoint, guidesForRect, snapTargetsExcludingSubtree, snapTargetsExcludingSubtrees, isTranslationOnlyChain, SNAP_THRESHOLD_PX, SnapGuide, SnapResult } from "../geometry/Snapping";
import { rulerTicks, niceStep, RulerTick } from "../geometry/Ruler";
import { renderSVG, clearRenderState, RendererState } from "../../renderer/SVGRenderer";
import { renderCanvas } from "../../renderer/CanvasRenderer";
import { renderScene, RenderBackend } from "../../renderer/renderScene";
import { buildRenderModel, DisplayList, DrawItem, Shape, Paint, FilterDef, PaintGradient, gradientDefId, resolvePaintGradient, commandsToPathData, effectFilterId } from "../../renderer/RenderModel";
import { emitSVG } from "../../renderer/emitSVG";
import { emitCanvas, setImageReadyCallback, CanvasTarget } from "../../renderer/emitCanvas";
import { resolveImage, imageGeneration, naturalSize, imageInkBounds } from "../../renderer/ImageCache";
import { exportSVG, EXPORT_MARGIN, TextLines } from "../export/ExportSVG";
import { TextShape, drawTextInto, wrapText, wrapTextWith, textLinesFor, textRasterKey, textRasterScale, TEXT_RASTER_MIN, TEXT_RASTER_MAX } from "../../renderer/TextRaster";
import { emitWebGL, initGL, parseColor, shapeToLocalCommands, viewMatrix, itemDraws, itemTolerance, setLighting, normalisedUV, Draw, GLState, HeightTexture, heightTexture, decodeHeight, HEIGHT_TEX_SIZE } from "../../renderer/emitWebGL";
import { CubicBezier, cubicBezierAt, cubicBezierError, solveForX, BEZIER_PRESETS } from "../document/Bezier";
import { Clip, clipsError, findClip, clipLength, clipFrameAt, CLIPS_MAX, CLIP_NAME_MAX } from "../document/Clips";
import { MotionPath, Point as MotionPoint, motionPathError, motionPointAt, motionPolyline, ARC_SAMPLES, MOTION_OFFSET_MAX } from "../document/MotionPath";
import { IkPoint, IkBend, IkSolution, solveTwoBone, solveFabrik, rotationDelta, FABRIK_PASSES, FABRIK_TOLERANCE, FABRIK_SEED } from "../geometry/Ik";
import { IkConstraint, ikError, applyIk, IK_TARGET_MAX, IK_CHAIN_MAX } from "../document/Rig";
import { Cell, SheetPlan, SheetAtlas, planSheet, sheetAtlas, sheetClipFrames, sheetTooLarge, drawSheet, SHEET_MAX_PIXELS } from "../export/SpriteSheet";
import { SliceGrid, SliceOptions, sliceGrid, sliceCells, sliceTrack, blankCells, SLICE_MAX_CELLS } from "../import/SheetSlice";
import { Sequence, SequenceFrame, parseFrameName, groupSequences, sequenceTrack, SEQUENCE_MAX } from "../import/Sequence";
import { Trim, TrimBox, trimmedPlacement, inkUnion } from "../import/Trim";
import { Atlas, AtlasEntry, parseTextureAtlas, atlasError, atlasEntry, atlasPlacement, ATLAS_MAX_ENTRIES } from "../import/TextureAtlas";
import { parseSvgPath, svgPathError, SVG_PATH_MAX_COMMANDS } from "../import/SvgPath";
import { SvgShape, SvgDocumentResult, parseSvgDocument, svgDocumentError,
    SVG_MAX_SHAPES, SVG_MAX_USE_DEPTH } from "../import/SvgDocument";
import { SvgNodeSpec, svgNodeSpecs, SVG_TRANSPARENT } from "../import/SvgNodes";
import { FontInfo, FontFlavour, parseFontFile, fontFileError, FONT_MAX_TABLES, FONT_MAX_NAMES } from "../import/FontFile";
import { TiledMapResult, TiledTileset, TiledTileImage, TiledLayer, TiledCell, parseTiledMap, parseTiledTileset,
    tiledMapError, decodeGid, tilesetFor, tileSourceRect, tilePosition, tileTransform, tileImageFor, tilesetOverflow,
    TILED_MAX_CELLS, TILED_MAX_LAYERS, TILED_MAX_TILE_IMAGES } from "../import/TiledMap";
import { GlbContainer, GltfJson, GltfNode, GltfResult, GltfMeshInstance, GltfPrimitive,
    parseGlb, glbError, parseGltf, gltfError, readAccessor, nodeMatrix, multiplyMat4,
    GLTF_IGNORABLE_REQUIRED, GLTF_MAX_VERTICES, GLTF_MAX_PRIMITIVES, GLTF_MAX_NODE_DEPTH,
    GltfMaterial, GltfImageSource, gltfMaterials, gltfImageSource
} from "../import/Gltf";
import { ObjResult, ObjMaterial, parseObj, objError, parseMtl, mtlError, resolveObjIndex,
    OBJ_MAX_VERTICES, OBJ_MAX_GROUPS, OBJ_FACE_MAX_CORNERS } from "../import/Obj";
import { MeshPrimitive, MeshInstance, MESH_IDENTITY } from "../import/MeshData";
import { registerFont, registeredFonts, clearFonts } from "../../renderer/FontCache";
import { AseFile, AseLayer, AseCel, AseTag, parseAseprite, asepriteError, asepriteClips, asepriteTimeline,
    aseBytesPerPixel, celRgba, ASE_MAX_FRAMES, ASE_MAX_LAYERS, ASE_MAX_CELS, ASE_MAX_CANVAS } from "../import/Aseprite";
import { DEMOS, bouncingBall, jumpingSquare, pendulum, celSequence, wavingLimb } from "../document/Demos";
import { Sample, Velocity, Timing, traceMotion, traceVelocity, traceTiming, traceDigest, TRACE_MAX_SAMPLES } from "../diagnostics/MotionTrace";
import { JournalEntry, recordAction, journal, journalDropped, clearJournal, JOURNAL_MAX } from "../diagnostics/ActionJournal";
import { EASABLE_PATHS } from "../document/Timeline";
import { EaseFor, DiscreteMode, blendNode } from "../document/Prototype";
import { Keyframe, TimelineSettings, timelineError, trackError, channelsError, CHANNELS_MAX, keyframesAt, applyFrame, onionFrames, TIMELINE_MAX_FRAMES, TRACK_MAX_KEYFRAMES, FPS_MIN, FPS_MAX } from "../document/Timeline";
import { DEPTH_MIN, DEPTH_MAX, depthError, depthOf, parallaxRate, parallaxOffset, depthToClipZ, byDepth, applyParallax } from "../document/Depth";
import { Mesh, ReadonlyMesh, MESH_MAX_DIVISIONS, meshError, restPoint, restMesh, isIdentityMesh, warpPoint, warpCommands, heightOf, warpHeight, heightRange, surfaceNormal, normalAt, isFlatMesh } from "../document/Mesh";
import { Light, LIGHTS_MAX, lightsError, ambientError, normalize, lambert, shadowOffset, heightAbovePage } from "../document/Light";
import { resolveScene, resolveMeshes, resolveBooleans, applyActiveState, dropHidden } from "../document/Components";
import { BooleanOp, Ring, Point, Piece, windingAt, insideRings, splitAgainst, chainPieces, booleanRings, ringsToCommands, commandsToRings, booleanPaths } from "../geometry/PathBoolean";
import { FillRule, FILL_RULES, crossingCount, insideRule, resolveRings, resolveWith, resolveBoolean, resolveBooleanPaths } from "../geometry/Resolve";
import { ShadowShape, CastShadowPatch, shadowPatch, castShadows, SHADOW_ALPHA, CAST_SHADOW_MAX_PAIRS } from "../geometry/CastShadow";
import { marchOccluded, RAY_STEPS } from "../geometry/RayMarch";
import { StrokeStyle, StrokeAlign, STROKE_ALIGNS, strokeOutline } from "../geometry/StrokeOutline";
import { signedArea2, triangulate, subdivideTriangles, TESSELLATE_MAX_VERTICES, SUBDIVIDE_MAX_DEPTH } from "../geometry/Tessellate";
import { dashSubpaths, parseDashArray } from "../geometry/DashPath";
import { isConvexRing, convexPieces, convexOverlaps, piecesOverlap, rectRing, piecesArea, edgesOverlap, DECOMPOSE_MAX_PIECES } from "../geometry/ConvexDecompose";
import { HitShape, Subpath, isPaintBearing, hitShapeOf, flattenPath, hitsShape, displayTolerance, localScaleOf, FLATTEN_TOLERANCE, FLATTEN_MAX_DEPTH, DISPLAY_DEVIATION_PX, DISPLAY_TOLERANCE_MAX, DISPLAY_TOLERANCE_MIN } from "../geometry/ShapeHit";
import { ellipseCommands, rectCommands, shapeToCommands, transformCommands } from "../geometry/ShapeToPath";
import { Quad, axisLengths, boxQuad, quadCenter, cursorForDirection, localLinear, worldDeltaToLocal, resizeBox, Box } from "../geometry/OrientedBox";
import { TrackListParse, parseTrackList, formatTrackList } from "../document/TrackList";
import { worldCommandsOf, booleanAction, makeBooleanNodeAction } from "../actions/booleanActions";
import { strokeWidthOf, outlineStrokeAction } from "../actions/outlineStrokeActions";
import { SetTrackAction } from "../actions/SetTrackAction";
import { SetTimelineAction } from "../actions/SetTimelineAction";
import { SetDepthAction } from "../actions/SetDepthAction";
import { SetMeshAction } from "../actions/SetMeshAction";
import { SetLightingAction } from "../actions/SetLightingAction";

/**
 * Assert an expression is ASSIGNABLE to the documented type.
 *
 * Note the limit: assignability is one-directional. `expectType<ReadonlyDocument>(x)`
 * passes even if `x` is the *mutable* `ProjectDocument`, because mutable widens to
 * readonly. Verified empirically — reverting `getDocument()` to `ProjectDocument`
 * did NOT fail this check. Guarantees that must not weaken use `expectNotMutable`.
 */
function expectType<T>(_value: T): void { /* compile-time only */ }

/**
 * Assert the ARGUMENT'S OWN static type is not assignable to the mutable document.
 *
 * The conditional is load-bearing and must stay generic: a first attempt declared
 * the parameter as `ReadonlyDocument`, which made the check tautological — it
 * asserted a fact about the two types rather than about the value being passed, and
 * silently passed when `getDocument()` was reverted to mutable. Here `T` is inferred
 * from the call site, so a mutable argument collapses the parameter to `never`.
 */
function expectNotMutable<T>(_value: T extends ProjectDocument ? never : T): void { }

export function __apiSurfacePin(): void {
    const doc: ProjectDocument = createEmptyDocument();
    const dispatcher = new ActionDispatcher(doc);

    // --- Document -----------------------------------------------------------
    expectType<string>(CURRENT_VERSION);
    expectType<string>(SCHEMA_VERSION);
    expectType<readonly NodeType[]>(NODE_TYPES);
    expectType<boolean>(isNodeType("core.rectangle"));
    expectType<string | null>(dimensionError("core.line", 1, 0));
    expectType<string | null>(pathError("core.path", []));
    expectType<string | null>(styleError({}));
    // A fill may be a colour OR a gradient (schema 56); `flatFill` is the one-colour answer for
    // the places that cannot hold a ramp.
    expectType<string>(flatFill("#fff"));
    expectType<string>(flatFill(defaultGradient("linear")));
    const shadow: Shadow = { dx: 0, dy: 0, blur: 0, color: "#000" };
    expectType<Shadow>(shadow);
    expectType<number>(PATH_MAX_COMMANDS);
    const pathCmd: PathCommand = { c: "M", x: 0, y: 0 };
    expectType<PathCommand>(pathCmd);

    // --- Variables / design tokens (schema 19) ------------------------------
    const variable: Variable = { type: "color", value: "#fff", modes: { dark: "$other" } };
    expectType<Variable>(variable);
    expectType<VariableType>(variable.type);
    expectType<VariableValue>(variable.value);
    const store: VariableStore = { "color/primary": variable };
    expectType<VariableStore>(doc.variables);
    expectType<ThemeMode>(doc.activeTheme);
    expectType<readonly ThemeMode[]>(THEME_MODES);
    expectType<number>(VARIABLES_MAX);
    expectType<number>(VARIABLE_KEY_MAX);
    expectType<string>(VARIABLE_FALLBACK_COLOR);
    expectType<boolean>(isTokenRef("$color/primary"));
    expectType<string | null>(variableError(variable));
    expectType<string | null>(variableKeyError("color/primary"));
    expectType<string | null>(variableStoreError(store));
    expectType<string>(RESERVED_NODE_ID);

    // --- Components / instances (schema 21) ---------------------------------
    expectType<string>(RESERVED_ID_SUBSTRING);
    expectType<string>(VIRTUAL_ID_SEP);
    expectType<number>(INSTANCE_MAX_DEPTH);
    expectType<number>(INSTANCE_MAX_NODES);
    expectType<string | null>(nodeIdError("some-id"));
    expectType<string | null>(componentError("core.instance", "master"));
    expectType<string>(virtualId("instance", "master"));
    expectType<boolean>(isVirtualId("a::b"));
    expectType<{ instancePath: string; masterNodeId: string } | null>(splitVirtualId("a::b"));
    expectType<string | null>(ownerInstanceOf("a::b"));
    expectType<ReadonlyDocument>(expandInstances(doc));
    expectType<MutationResult>(new CreateInstanceAction(doc, "master", 0, 0).execute());

    // --- Instance overrides (schema 22) -------------------------------------
    const override: InstanceOverride = { geometry: { x: 1 }, style: { fill: "#fff" }, text: "t", src: "u" };
    expectType<InstanceOverride>(override);
    expectType<number>(INSTANCE_MAX_OVERRIDES);
    expectType<string | null>(overridesError("core.instance", { key: override }));
    expectType<MutationResult>(new SetInstanceOverrideAction(doc, "inst", "masterNode", override).execute());
    expectType<Action | null>(geometryActionFor(doc, "id", { x: 0 }));
    expectType<Action | null>(styleActionFor(doc, "id", { fill: "#fff" }));
    expectType<{ instanceId: string; masterNodeId: string } | null>(overrideTargetFor(doc, "a::b"));
    expectType<boolean>(isEditableNode(doc, "id"));
    expectType<string | null>(hitTest({ order: [], nodes: new Map(), locked: new Set() }, 0, 0, 0, true));
    expectType<string | number | null>(resolveVariable(store, "color/primary", "light"));
    expectType<string>(resolveColor(store, "$color/primary", "dark"));
    expectType<number | null>(resolveNumber(store, "$spacing/gap", "light"));
    expectType<string>(DOCUMENT_DELTA_KEY);
    expectType<MutationResult>(new SetVariableAction(doc, "color/primary", variable).execute());
    expectType<MutationResult>(new DeleteVariableAction(doc, "color/primary").execute());
    expectType<MutationResult>(new SetActiveThemeAction(doc, "dark").execute());
    expectType<string>(commandsToPathData([{ c: "M", x: 0, y: 0 }, { c: "Z" }]));

    // getDocument() is READ-ONLY — asserted in BOTH directions, so the guarantee
    // cannot be silently weakened back to a mutable document.
    expectType<ReadonlyDocument>(dispatcher.getDocument());
    expectNotMutable(dispatcher.getDocument());

    // --- Serializer ---------------------------------------------------------
    expectType<string>(serializeDocument(dispatcher.getDocument()));
    expectType<ProjectDocument>(deserializeDocument("{}"));
    expectType<boolean>(compareDocuments(doc, doc));
    expectType<LoadResult>(Serializer.loadResult());
    expectType<ProjectDocument | null>(Serializer.load());
    expectType<SaveResult>(Serializer.save(doc));

    // --- Scene graph / integrity / geometry ---------------------------------
    expectType<ReadonlyNode[]>(traverseSceneGraph(doc));
    expectType<string[]>(selectionRoots(doc, []));
    expectType<void>(validateDocumentIntegrity(doc));
    const computed: ComputedState = computeGeometry(doc, null);
    expectType<string[]>(computed.order);
    expectType<Map<string, ComputedNode>>(computed.nodes);
    expectType<string | null>(hitTest(computed, 0, 0));
    expectType<string | null>(hitTest(computed, 0, 0, 4)); // optional world-space pick tolerance
    expectType<string[]>(nodesInRect(computed, { x: 0, y: 0, width: 1, height: 1 })); // marquee (box) select
    expectType<{ x: number; y: number } | null>(toLocal(computed, "id", 0, 0));
    expectType<{ x: number; y: number } | null>(toWorld(computed, "id", 0, 0));
    expectType<Rect | null>(subtreeBounds(doc, computed, "id"));
    expectType<Rect | null>(selectionBounds(computed, ["id"]));

    // --- M2 layout engine ---------------------------------------------------
    const container: LayoutContainer = { direction: "row", gap: 0, padding: 0, alignItems: "start", wrap: true, alignContent: "space-between", wrapReverse: true };
    expectType<LayoutContainer>(container);
    expectType<string | null>(layoutError({ container } as Partial<Layout>));
    expectType<Map<string, Rect>>(layoutChildren(container, { width: 1, height: 1 }, [{ id: "a", width: 1, height: 1 }]));
    expectType<FlexLine[]>(breakFlexLines([{ main: 1, cross: 1, marginMain: 0, marginCross: 0 }], 1, 0, true));
    const margins: Margins = { top: 1, left: 2 };
    expectType<{ top: number; right: number; bottom: number; left: number }>(resolveMargin(margins));
    expectType<{ top: number; right: number; bottom: number; left: number }>(resolveMargin(5));
    expectType<Set<string>>(expandDirtyForLayout(doc, new Set<string>()));
    expectType<boolean>(isLayoutContainer(doc.nodes.get("id")));
    expectType<boolean>(isAbsolute(doc.nodes.get("id")));
    expectType<Map<string, { width: number; height: number }>>(measureIntrinsicSizes(traverseSceneGraph(doc), null));
    const track: TrackSize = { fr: 1 };
    const autoTrack: TrackSize = { auto: true };
    const grid: LayoutGrid = { columns: [{ px: 1 }, track, autoTrack], rowHeight: { px: 1 }, rows: [autoTrack], hugWidth: true, hugHeight: false, autoFlow: "column dense", columnGap: 0, rowGap: 0, padding: 0 };
    expectType<LayoutGrid>(grid);
    expectType<Map<string, Rect>>(layoutGridChildren(grid, { width: 1, height: 1 }, [{ id: "a", width: 1, height: 1, colSpan: 2, rowSpan: 1 }]));
    expectType<{ colWidths: number[]; rowHeights: number[]; cols: number; rows: number; cells: GridCell[] }>(resolveGridTracks(grid, [{ width: 1, height: 1, colSpan: 1 }], { width: 1, height: 1 }));
    expectType<{ cells: GridCell[]; rows: number; cols: number }>(placeGridItems([{ colSpan: 2, rowSpan: 1, gridColumn: [1, 3], gridRow: [1, 2] }], 3, { columnFlow: true, dense: true }));
    const constraints: Constraints = { horizontal: "right" as HConstraint, vertical: "center" as VConstraint };
    expectType<Constraints>(constraints);
    expectType<Rect>(resolveConstraints({ x: 0, y: 0, width: 1, height: 1 }, constraints, { width: 1, height: 1 }, { width: 2, height: 2 }));

    // Matrix primitive
    expectType<Mat2D>(IDENTITY);
    expectType<Mat2D>(multiply(IDENTITY, IDENTITY));
    expectType<Mat2D>(translation(0, 0));
    expectType<Mat2D | null>(invert(IDENTITY));
    expectType<Mat2D>(compose(0, 0, 0, 1, 1, 0, 0));
    expectType<{ x: number; y: number }>(applyToPoint(IDENTITY, 0, 0));
    expectType<Rect>(transformRectToAABB(IDENTITY, { x: 0, y: 0, width: 1, height: 1 }));
    expectType<Rect>(unionRect({ x: 0, y: 0, width: 1, height: 1 }, { x: 1, y: 1, width: 1, height: 1 }));
    expectType<string>(toMatrixString(IDENTITY));
    expectType<boolean>(isTranslationOnly(IDENTITY));

    // --- Actions ------------------------------------------------------------
    // The delta channel is a discriminated union, NOT Record<string, any>.
    expectType<Map<string, NodeDelta>>(({} as MutationResult).propertyDeltas);
    expectType<void>(applyMutationsToDocument(doc, new Map<string, NodeDelta>()));

    const actions: Action[] = [
        new AddNodeAction(doc, "core.rectangle", 0, 0, 1, 1, "#fff", "id", null),
        new DeleteNodeAction(doc, "id"),
        new MoveNodeAction(doc, "id", 0, 0),
        new ResizeNodeAction(doc, "id", 1, 1),
        new ReparentNodeAction(doc, "id", null, 0),
        new UpdateNodeGeometryAction(doc, "id", { x: 0 }),
        new UpdateNodeStyleAction(doc, "id", { opacity: 1 }),
        new UpdateNodeTransformAction(doc, "id", { rotation: 0 }),
        new UpdateNodeLayoutAction(doc, "id", { container: { direction: "row" } })
    ];
    expectType<TransactionAction>(new TransactionAction(doc, "label", actions));
    expectType<MutationResult>(actions[0].execute());
    expectType<ActionPayload>(actions[0].serialize());

    // --- Dispatcher & history ----------------------------------------------
    expectType<MutationResult>(dispatcher.dispatchAction(actions[0], { coalesce: true }));
    expectType<() => void>(dispatcher.onChange(() => { }));
    expectType<ProjectDocument | null>(dispatcher.undo());
    expectType<ProjectDocument | null>(dispatcher.redo());
    expectType<boolean>(dispatcher.canUndo());
    expectType<boolean>(dispatcher.canRedo());
    expectType<string>(dispatcher.getHistoryCheckpoint());
    expectType<boolean>(dispatcher.rollbackToCheckpoint("rev-id"));
    expectType<void>(dispatcher.loadDocument(doc));
    expectType<boolean>(dispatcher.hasTruncatedHistory());
    expectType<ProjectDocument>(dispatcher.revertToOriginal());

    const history = new HistoryManager(doc, DEFAULT_HISTORY_LIMITS);
    expectType<HistoryLimits>(DEFAULT_HISTORY_LIMITS);
    expectType<void>(history.commitRevision({ actionId: "x", payload: null, timestamp: 0 }, doc, false));
    expectType<ProjectDocument>(history.getOriginal());
    expectType<boolean>(history.hasTruncatedHistory());
    expectType<number>(history.getRevisionCount());
    expectType<Revision["sizeBytes"]>(0);
    expectType<DocumentSnapshot["version"]>("1");

    // --- Editor & renderer --------------------------------------------------
    const es: EditorState = createEditorState();
    expectType<Map<string, Partial<Node["geometry"]>> | null>(es.pendingGeometry);
    expectType<{ x: number; y: number; width: number; height: number } | null>(es.marqueeRect);
    expectType<string | null>(es.hoverCursor);
    expectType<void>(clampViewport(es.viewport));
    expectType<void>(panBy(es.viewport, 0, 0));
    expectType<void>(zoomAt(es.viewport, 1.1, 0, 0));
    expectType<{ x: number; y: number }>(screenToWorld(es.viewport, { left: 0, top: 0 }, 0, 0));
    expectType<number>(HANDLE_SIZE_PX);
    expectType<number>(ROTATE_OFFSET_PX);
    expectType<SelectionHandle[]>(selectionHandles(computed, ["id"], 1));       // zoom (for the rotate-knob offset)
    expectType<SelectionHandle | null>(handleAtPoint(computed, ["id"], 0, 0, 1)); // zoom (sizes the grab square)
    expectType<SelectionHandle | null>(groupRotateHandle(computed, ["id"], 1));    // the group's single rotate knob
    expectType<SelectionHandle | null>(groupHandleAtPoint(computed, ["id"], 0, 0, 1));
    const gri: GroupRotateInput = { id: "id", startX: 0, startY: 0, startRotation: 0, centerX: 0, centerY: 0 };
    expectType<GroupRotateOutput[]>(rotateGroup(0, 0, 0, [gri]));
    expectType<boolean>(isGroupRotatable(doc, ["id"]));
    expectType<SelectionHandle[]>(groupCornerHandles(computed, ["id"], 1));           // the group's 4 resize corners
    expectType<SelectionHandle | null>(groupHandleAtPoint(computed, ["id"], 0, 0, 1, true)); // incl. corners (resizable groups)
    const gsi: GroupScaleInput = { id: "id", startX: 0, startY: 0, worldX: 0, worldY: 0, startWidth: 1, startHeight: 1 };
    expectType<GroupScaleOutput[]>(scaleGroup(0, 0, 1, 1, [gsi]));
    expectType<boolean>(isGroupResizable(doc, ["id"]));
    const unit: Rect = { x: 0, y: 0, width: 1, height: 1 };
    const snap: SnapResult = computeSnap(unit, [unit], 6);
    expectType<number>(snap.dx); expectType<number>(snap.dy); expectType<SnapGuide[]>(snap.guides);
    expectType<"x" | "y">(snap.guides[0]?.axis ?? "x");
    expectType<number>(SNAP_THRESHOLD_PX);
    expectType<{ dx: number; dy: number }>(snapPoint(0, 0, [unit], 6));
    expectType<SnapGuide[]>(guidesForRect(unit, [unit]));
    expectType<Rect[]>(snapTargetsExcludingSubtree(doc, computed, "id"));
    expectType<Rect[]>(snapTargetsExcludingSubtrees(doc, computed, ["id"]));
    expectType<boolean>(isTranslationOnlyChain(doc, "id"));
    expectType<number>(niceStep(80));
    expectType<RulerTick[]>(rulerTicks(0, 100, 1));
    expectType<RulerTick[]>(rulerTicks(0, 100, 1, 60));
    const rendererState: RendererState = {
        selectedNodeIds: [], hoveredNodeId: null, computed, viewport: es.viewport
    };
    expectType<RendererState>(rendererState);
    expectType<(c: HTMLElement, d: ReadonlyDocument, s: RendererState) => void>(renderSVG);
    expectType<(c: HTMLElement, d: ReadonlyDocument, s: RendererState) => void>(renderCanvas);
    expectType<(c: HTMLElement, d: ReadonlyDocument, s: RendererState, b: RenderBackend) => void>(renderScene);
    expectType<(c: HTMLElement) => void>(clearRenderState);
    expectType<RenderBackend>("svg"); expectType<RenderBackend>("canvas");

    // M3 render model: pure display list + backend seam.
    const model: DisplayList = buildRenderModel({ width: 800, height: 600 }, doc, rendererState);
    expectType<DrawItem[]>(model.content);
    expectType<DrawItem[]>(model.overlay);
    expectType<DrawItem[]>(model.grid.lines);
    expectType<string>(model.grid.sig);
    expectType<boolean>(model.grid.unchanged);
    expectType<Shape>(model.content[0].shape);
    expectType<Paint>(model.content[0].paint);
    expectType<Mat2D | null>(model.content[0].world);
    expectType<FilterDef[]>(model.defs);
    expectType<string | null>(effectFilterId(shadow, 4));
    // Gradient defs (schema 56): resolved here, deduped by a content-derived id, so a hundred
    // shapes sharing one ramp reference one `<defs>` entry.
    expectType<PaintGradient[]>(model.gradients);
    expectType<string | PaintGradient | null>(model.content[0].paint.fill);
    const paintRamp: PaintGradient = resolvePaintGradient(defaultGradient("radial"), c => c);
    expectType<PaintGradient>(paintRamp);
    expectType<string>(paintRamp.flat);
    expectType<GradientUnits>(paintRamp.units);
    expectType<readonly GradientStop[]>(paintRamp.stops);
    expectType<string>(gradientDefId(paintRamp));
    expectType<(c: HTMLElement, m: DisplayList) => void>(emitSVG);
    expectType<(ctx: CanvasRenderingContext2D, m: DisplayList, dpr?: number) => void>(emitCanvas);
    expectType<(cb: (() => void) | null) => void>(setImageReadyCallback);
    // ONE decode serves every backend, so switching from the toolbar does not re-download the
    // document. The generation is what lets a TEXTURE know it has something new to upload.
    expectType<HTMLImageElement | null>(resolveImage("a.png"));
    expectType<number>(imageGeneration());
    // ONE typesetter for every backend that can measure. The GPU rasterises through this rather
    // than through a glyph atlas, so it cannot break a line where Canvas would not.
    const textShape: TextShape = { kind: "text", x: 0, y: 0, width: 10, height: 10, text: "hi",
        fontSize: 10, fontFamily: "sans-serif", fontWeight: 400, textAlign: "left", lineHeight: 1.2, letterSpacing: 0 };
    expectType<TextShape>(textShape);
    expectType<(ctx: CanvasRenderingContext2D, s: TextShape, p: Paint) => void>(drawTextInto);
    // ONE wrapper, two ways to measure: a context for the backends, an injected function for the
    // pure exporter. `textLinesFor` is the DOM-backed bridge, null where there is nothing to
    // measure with — which is why the exporter's parameter has a hard-breaks-only default.
    expectType<(ctx: CanvasRenderingContext2D, t: string, w: number) => string[]>(wrapText);
    expectType<string[]>(wrapTextWith(t => t.length, "a b", 10));
    expectType<string[] | null>(textLinesFor(textShape));

    // --- The EXPORTER, the artefact the tool actually hands over ---------------
    // Wrapping is INJECTED because this module is pure and wrapping has to measure; the default
    // honours explicit newlines only, which is what it did before the app started passing one.
    expectType<string>(exportSVG(doc));
    expectType<string>(exportSVG(doc, shape => [shape.text]));
    expectType<TextLines>((shape: TextShape) => [shape.text]);
    expectType<number>(EXPORT_MARGIN);
    expectType<number>(textRasterScale(2));
    expectType<string>(textRasterKey(textShape, model.content[0].paint, 2));
    expectType<number>(TEXT_RASTER_MIN); expectType<number>(TEXT_RASTER_MAX);

    // --- Geometry the display seam is built out of (schemas 33–38) -----------
    // Everything below this line was documented in API-CONTRACTS with nothing holding it to the
    // code. That is the exact failure this file exists to prevent, so the gap is closed rather
    // than noted: a rename in any of these now fails `tsc` instead of a review.
    const ring: Ring = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const rings: Ring[] = [ring];
    expectType<Point>(ring[0]);
    expectType<BooleanOp>("union");
    expectType<number>(windingAt(rings, 1, 1));
    expectType<boolean>(insideRings(rings, 1, 1));
    const pieces: Piece[] = splitAgainst(rings, rings);
    expectType<Point>(pieces[0]?.from ?? ring[0]);
    expectType<Ring[]>(chainPieces(pieces));
    expectType<Ring[]>(booleanRings(rings, rings, "subtract"));
    expectType<PathCommand[]>(ringsToCommands(rings));
    expectType<Ring[]>(commandsToRings([pathCmd]));
    expectType<Ring[]>(commandsToRings([pathCmd], 0.05));
    expectType<PathCommand[]>(booleanPaths([pathCmd], [pathCmd], "exclude"));

    // Fill-rule RESOLUTION (schema 38) — the GPU has no `fill-rule`, so the rule becomes geometry.
    expectType<FillRule>("evenodd");
    expectType<readonly FillRule[]>(FILL_RULES);
    expectType<number>(crossingCount(rings, 1, 1));
    expectType<boolean>(insideRule(rings, 1, 1, "evenodd"));
    expectType<Ring[]>(resolveRings(rings));
    expectType<Ring[]>(resolveRings(rings, "evenodd"));
    // The general form both the fill rule and the booleans are written in terms of. `resolveWith`
    // takes a PREDICATE, which is what makes one engine serve both — and what made the booleans
    // robust at coincident edges, where classifying an edge's own midpoint has no answer.
    expectType<Ring[]>(resolveWith(rings, () => true));
    expectType<Ring[]>(resolveBoolean(rings, rings, "union"));
    expectType<PathCommand[]>(resolveBooleanPaths([pathCmd], [pathCmd], "intersect"));

    // Stroke as GEOMETRY (schema 37) — joins and caps the document chose, not a rasterizer's.
    const strokeStyle: StrokeStyle = { width: 2, join: "miter", cap: "round", miterLimit: 4, align: "center" };
    expectType<StrokeStyle>(strokeStyle);
    expectType<StrokeAlign>("outer");
    expectType<readonly StrokeAlign[]>(STROKE_ALIGNS);
    expectType<Ring[]>(strokeOutline([pathCmd], strokeStyle));
    expectType<Ring[]>(strokeOutline([pathCmd], strokeStyle, 0.05));
    // DASHES as geometry — the pieces, not a rendering flag. Null from the parser means SOLID,
    // which is what SVG does with a malformed spec; it is not an empty pattern.
    expectType<number[] | null>(parseDashArray("4 4"));
    expectType<PathCommand[][]>(dashSubpaths([pathCmd], [4, 4]));
    expectType<PathCommand[][]>(dashSubpaths([pathCmd], [4, 4], 2, 0.05));

    // Tessellation + interior subdivision — the GPU's only input, and where shading gets vertices.
    expectType<number>(signedArea2(ring));
    const tris: number[] = triangulate(rings);
    expectType<number[]>(subdivideTriangles(tris, 10));
    expectType<number[]>(subdivideTriangles(tris, 10, 3));
    expectType<number>(TESSELLATE_MAX_VERTICES);
    expectType<number>(SUBDIVIDE_MAX_DEPTH);

    // Convex decomposition — what makes marquee selection INK-accurate rather than box-accurate.
    expectType<boolean>(isConvexRing(ring));
    const convex: Ring[] = convexPieces(rings);
    expectType<boolean>(convexOverlaps(ring, ring));
    expectType<boolean>(piecesOverlap(convex, ring));
    expectType<Ring>(rectRing(0, 0, 10, 10));
    expectType<number>(piecesArea(convex));
    // SUBPATHS, not rings: `closed` is a real distinction here — an open subpath that silently
    // closed would gain an edge the author never drew, and a marquee near it would select a shape
    // that is not there. Pinned with the subpath type so the parameter cannot quietly widen.
    expectType<boolean>(edgesOverlap([{ points: ring, closed: false }], ring));
    expectType<number>(DECOMPOSE_MAX_PIECES);

    // Flattening + the ADAPTIVE display tolerance the GPU backend needs.
    const hitShape: HitShape = hitShapeOf({ type: "core.path", path: [pathCmd], style: { fill: "#000" } }, 0);
    expectType<HitShape>(hitShape);
    expectType<boolean>(isPaintBearing("none"));
    const subpaths: Subpath[] = flattenPath([pathCmd]);
    expectType<Subpath[]>(flattenPath([pathCmd], 0.05));
    expectType<boolean>(subpaths[0]?.closed ?? false);
    expectType<boolean>(hitsShape(hitShape, 10, 10, 1, 1, 0.05));
    expectType<number>(displayTolerance(2));
    expectType<number>(localScaleOf(IDENTITY, 2));
    expectType<number>(FLATTEN_TOLERANCE);
    expectType<number>(FLATTEN_MAX_DEPTH);
    expectType<number>(DISPLAY_DEVIATION_PX);
    expectType<number>(DISPLAY_TOLERANCE_MAX);
    expectType<number>(DISPLAY_TOLERANCE_MIN);

    // Shape → path: the ONE conversion every consumer shares, so a fourth idea of "what shape is
    // this" cannot drift into existence.
    expectType<PathCommand[]>(ellipseCommands(10, 10));
    expectType<PathCommand[]>(rectCommands(10, 10));
    expectType<PathCommand[]>(rectCommands(10, 10, 2));
    expectType<PathCommand[] | null>(shapeToCommands(hitShape, 10, 10));
    expectType<PathCommand[]>(transformCommands(IDENTITY, [pathCmd]));

    // Oriented box / handle math.
    const quad: Quad = boxQuad(IDENTITY, 10, 10);
    expectType<Quad>(boxQuad(IDENTITY, 10, 10, 2));
    expectType<{ ux: number; uy: number }>(axisLengths(IDENTITY));
    expectType<Point>(quadCenter(quad));
    expectType<string>(cursorForDirection(1, 0));
    expectType<Mat2D>(localLinear(IDENTITY, IDENTITY));
    expectType<Point>(worldDeltaToLocal(IDENTITY, 1, 1));
    const box: Box = { x: 0, y: 0, width: 10, height: 10 };
    expectType<Box>(resizeBox("se", box, { x: 1, y: 1 }, IDENTITY));
    expectType<Box>(resizeBox("se", box, { x: 1, y: 1 }, IDENTITY, { x: 0.5, y: 0.5 }, 1));

    // Track-list parsing (the grid inspector's text field).
    const parsed: TrackListParse = parseTrackList("1fr auto");
    expectType<TrackListParse>(parsed);
    expectType<string>(formatTrackList([]));

    // --- The display SEAM, in the order it composes ---------------------------
    expectType<ReadonlyDocument>(resolveScene(doc));
    expectType<ReadonlyDocument>(dropHidden(doc));
    expectType<ReadonlyDocument>(applyActiveState(doc));
    expectType<ReadonlyDocument>(resolveBooleans(doc));
    expectType<ReadonlyDocument>(resolveMeshes(doc));

    // --- Animation (schema 39) -----------------------------------------------
    const keyframe: Keyframe = { frame: 0, values: {} };
    expectType<Keyframe>(keyframe);
    expectType<number>(keyframe.frame);
    const timeline: TimelineSettings = { frames: 60, fps: 24 };
    expectType<TimelineSettings>(timeline);
    expectType<string | null>(timelineError(timeline));
    expectType<string | null>(trackError([keyframe], () => null));
    expectType<{ from: Keyframe; to: Keyframe | null; t: number } | null>(keyframesAt([keyframe], 0));
    expectType<ReadonlyDocument>(applyFrame(doc, 0));
    expectType<ReadonlyDocument>(applyFrame(doc, undefined));
    expectType<number[]>(onionFrames(5, 2, 2, 60));
    // EASING as a CURVE (schema 44). x is TIME and is bounded; y is not, because overshoot is
    // the point. `solveForX` is exported because a solver whose failure mode is "converged to
    // the wrong root" deserves checking directly rather than through the value that hides it.
    const curve: CubicBezier = { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
    expectType<CubicBezier>(curve);
    expectType<number>(cubicBezierAt(curve, 0.5));
    expectType<number>(solveForX(curve, 0.5));
    expectType<string | null>(cubicBezierError(curve));
    expectType<readonly { name: string; curve: CubicBezier }[]>(BEZIER_PRESETS);
    // The classic exercises, as REAL documents — they are how feature holes get found.
    expectType<readonly { name: string; build: () => ProjectDocument }[]>(DEMOS);
    expectType<ProjectDocument>(bouncingBall());
    expectType<ProjectDocument>(jumpingSquare());
    expectType<ProjectDocument>(pendulum());
    expectType<ProjectDocument>(celSequence());
    expectType<ProjectDocument>(wavingLimb());

    // --- The accuracy instruments -------------------------------------------
    // A trace samples the COMPUTED world and is deterministic, so two runs are comparable; the
    // journal carries wall-clock times and is deliberately NOT, which is why they are separate.
    const trace: Sample[] = traceMotion(bouncingBall(), { from: 0, to: 4, nodeIds: ["ball"] });
    expectType<Sample[]>(trace);
    expectType<number>(trace[0]?.anchorX ?? 0);
    expectType<Velocity[]>(traceVelocity(trace));
    expectType<Timing>(traceTiming(bouncingBall(), 0, 11));
    expectType<string>(traceDigest(trace));
    expectType<number>(TRACE_MAX_SAMPLES);
    recordAction({ at: 0, type: "probe", nodeIds: [], ok: true });
    expectType<readonly JournalEntry[]>(journal());
    expectType<number>(journalDropped());
    expectType<number>(JOURNAL_MAX);
    clearJournal();
    // PER-PROPERTY easing (schema 45), and the paths a keyframe may name.
    expectType<ReadonlySet<string>>(EASABLE_PATHS);
    expectType<EaseFor>((path: string) => path.length);
    // NAMED CLIPS over the one timeline (schema 46) — a character is a dozen animations.
    const clip: Clip = { name: "walk", from: 0, to: 11, loop: true };
    expectType<Clip>(clip);
    expectType<Clip[] | undefined>(doc.clips);
    expectType<string | null>(clipsError([clip], timeline));
    expectType<Clip | null>(findClip([clip], "walk"));
    expectType<number>(clipLength(clip));
    expectType<number>(clipFrameAt(clip, 3));
    expectType<number>(CLIPS_MAX); expectType<number>(CLIP_NAME_MAX);
    // SPRITE SHEETS — the plan is pure and holds every decision; `drawSheet` takes a context,
    // the same split `TextRaster` uses, so the decisions are the half a test can reach.
    const plan: SheetPlan = planSheet(doc, { columns: 4, padding: 2 });
    expectType<SheetPlan>(plan);
    expectType<Cell[]>(plan.cells);
    expectType<SheetAtlas>(sheetAtlas(doc, plan, "hero.png"));
    expectType<number>(sheetClipFrames(plan, "walk"));
    expectType<boolean>(sheetTooLarge(plan));
    expectType<number>(SHEET_MAX_PIXELS);
    // The EXPORT TARGET: an offset plus a background that may be null. `emitCanvas` sets the
    // CTM absolutely, so this is the only way a caller places the output anywhere but 0,0.
    expectType<CanvasTarget>({ x: 0, y: 0, background: null });

    // CHANNELS (schema 47): a track per property path, validated by the SAME value validator the
    // track path passes in. The rest of `Timeline` was already pinned here — it was API-CONTRACTS
    // that had never described it, so the pin was holding a shape no document claimed.
    expectType<number>(CHANNELS_MAX);
    expectType<string | null>(channelsError({ "geometry.x": [] }, () => null));

    // MOTION PATHS (schema 48): two control points as OFFSETS from the segment's own ends, and a
    // progress that is arc length rather than the cubic's parameter.
    const route: MotionPath = { c1: { x: 0, y: -1 }, c2: { x: 0, y: -1 } };
    expectType<MotionPath>(route);
    expectType<MotionPoint>(route.c1);
    expectType<string | null>(motionPathError(route));
    expectType<MotionPoint>(motionPointAt({ x: 0, y: 0 }, { x: 1, y: 1 }, route, 0.5));
    expectType<MotionPoint[]>(motionPolyline({ x: 0, y: 0 }, { x: 1, y: 1 }, route));
    expectType<number>(ARC_SAMPLES); expectType<number>(MOTION_OFFSET_MAX);

    // INVERSE KINEMATICS (schema 49): the solver is pure points and lengths; the document layer
    // turns a node into those and the angles back into transforms.
    const bend: IkBend = -1;
    expectType<IkSolution>(solveTwoBone({ x: 0, y: 0 }, { x: 1, y: 1 }, 1, 1, bend));
    expectType<IkPoint>(solveTwoBone({ x: 0, y: 0 }, { x: 1, y: 1 }, 1, 1).joint);
    expectType<boolean>(solveTwoBone({ x: 0, y: 0 }, { x: 1, y: 1 }, 1, 1).reached);
    expectType<number>(rotationDelta(0, 1));
    expectType<IkConstraint>({ x: 0, y: 0, bend });
    expectType<string | null>(ikError({ x: 0, y: 0 }));
    expectType<ReadonlyDocument>(applyIk(doc));
    expectType<number>(IK_TARGET_MAX);
    // LONGER CHAINS (schema 50): FABRIK past two bones, the closed form at exactly two.
    expectType<{ joints: IkPoint[]; reached: boolean }>(solveFabrik([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }], { x: 1, y: 1 }));
    expectType<number>(FABRIK_PASSES); expectType<number>(FABRIK_TOLERANCE); expectType<number>(FABRIK_SEED);
    expectType<number>(IK_CHAIN_MAX);
    expectType<IkConstraint>({ x: 0, y: 0, chain: 6 });

    // IMAGE REGIONS AND PIXEL ART (schema 51). The rect is in the SOURCE image's own pixels; the
    // normalisation into texture coordinates is the GPU's, because only it knows the real size.
    const region: SourceRect = { x: 72, y: 48, width: 24, height: 24 };
    expectType<SourceRect>(region);
    expectType<string | null>(sourceRectError(region));
    expectType<number>(SOURCE_RECT_MAX);
    expectType<{ x: number; y: number; width: number; height: number }>(normalisedUV(region, 360, 168));
    expectType<{ width: number; height: number } | null>(naturalSize("a.png"));
    // SPRITE-SHEET PLAYBACK (schema 52): a region is a StateDefinition value, so it is keyframable,
    // state-able and instance-overridable — one addition, three capabilities.
    expectType<InstanceOverride>({ sourceRect: region });
    expectType<Keyframe>({ frame: 0, values: { sourceRect: region } });

    // SHEET SLICING: the grid, never the ink. Pure, and it yields plain rects rather than a
    // document — turning them into keyframes is a separate decision.
    const sliceOpts: SliceOptions = { cellWidth: 24, cellHeight: 24, margin: 0, spacing: 0 };
    expectType<SliceGrid | null>(sliceGrid(360, 168, sliceOpts));
    const sheetGrid: SliceGrid = { columns: 15, rows: 7, cellWidth: 24, cellHeight: 24, count: 105 };
    expectType<SourceRect[]>(sliceCells(sheetGrid));
    expectType<Keyframe[]>(sliceTrack(sliceCells(sheetGrid), { start: 0, step: 2 }));
    expectType<number[]>(blankCells(sliceCells(sheetGrid), () => true));
    expectType<number>(SLICE_MAX_CELLS);

    // SEQUENCE IMPORT: a folder of numbered names, grouped into the animations it holds. Takes
    // NAMES rather than reading a disk — every decision is in the names.
    expectType<{ stem: string; index: number } | null>(parseFrameName("fighter_climb_0039.png"));
    const sequences: Sequence[] = groupSequences(["run_1.png"]);
    expectType<Sequence[]>(sequences);
    expectType<SequenceFrame[]>(sequences[0].frames);
    expectType<Keyframe[]>(sequenceTrack(sequences[0], { start: 0, step: 2, hrefFor: f => f }));
    expectType<number>(SEQUENCE_MAX);

    // TRIMMING: a rectangle AND a placement, never a rectangle alone — narrowing the source is paid
    // for by moving the destination, so the ink does not shift. Measuring needs pixels and lives in
    // the renderer; this half takes the measurement as an argument.
    const trimBox: TrimBox = { x: 0, y: 0, width: 256, height: 256 };
    expectType<Trim | null>(trimmedPlacement(trimBox, region, region));
    expectType<SourceRect | null>(inkUnion([region]));

    // TEXTURE ATLAS: the descriptor that says where each sprite is, for the 57% of real sheets that
    // are irregularly packed and so have no grid to recover. Its trim reuses `trimmedPlacement`.
    expectType<string | null>(atlasError("<TextureAtlas/>"));
    const atlas: Atlas = { image: "sprites.png", entries: [] };
    expectType<Atlas>(atlas);
    expectType<AtlasEntry[]>(atlas.entries);
    expectType<(t: string) => Atlas>(parseTextureAtlas);
    const entry: AtlasEntry = { name: "a.png", source: region, trim: null, rotated: false };
    expectType<AtlasEntry | null>(atlasEntry(atlas, "a.png"));
    expectType<Trim>(atlasPlacement(entry, trimBox));
    expectType<number>(ATLAS_MAX_ENTRIES);

    // SVG PATH DATA: the one import that CONVERTS rather than reads — twenty letters, relative
    // forms and elliptical arcs down to this engine's five absolute commands.
    expectType<string | null>(svgPathError("M0 0"));
    expectType<PathCommand[]>(parseSvgPath("M0 0 L1 1 Z"));
    expectType<number>(SVG_PATH_MAX_COMMANDS);
    // A WHOLE FILE: the group tree walked, transforms BAKED into the coordinates (this engine's
    // `Transform` has no skew and no general matrix), `<use>` expanded, gradients flattened with a
    // note. Reuses `ShapeToPath.transformCommands` rather than carrying a second copy.
    expectType<string | null>(svgDocumentError("<svg/>"));
    const svgDoc: SvgDocumentResult = parseSvgDocument('<svg><path d="M0 0"/></svg>');
    expectType<SvgDocumentResult>(svgDoc);
    expectType<SvgShape[]>(svgDoc.shapes);
    // A colour, a GRADIENT (schema 56), or unfilled — the union is what stops a consumer quietly
    // stringifying a ramp into a fill attribute.
    expectType<string | Gradient | null>(svgDoc.shapes[0].fill);
    expectType<string[]>(svgDoc.notes);
    // Beside `toMatrixString`, which it undoes — moved out of `SvgDocument` when a second import
    // module needed it and the two started importing each other.
    expectType<Mat2D>(parseSvgTransform("translate(1,2)"));
    expectType<number>(SVG_MAX_SHAPES); expectType<number>(SVG_MAX_USE_DEPTH);
    // …and the shapes as NODES: a box where the ink is, commands relative to its corner. The
    // conversion is `PathBuilder.normalizePathNode`, the one the pen tool already uses.
    const svgSpecs: SvgNodeSpec[] = svgNodeSpecs(svgDoc.shapes);
    expectType<SvgNodeSpec[]>(svgSpecs);
    expectType<string>(SVG_TRANSPARENT);

    // FONTS: the family comes out of the FILE, because 36 of the 56 measured have a filename that
    // differs from the name the platform matches on. Parsing is pure; registering needs a DOM.
    expectType<string | null>(fontFileError(new Uint8Array(0)));
    const face: FontInfo = { family: "", subfamily: "", fullName: "", postScriptName: "",
        flavour: "truetype" as FontFlavour, unitsPerEm: 1000, weight: 400, italic: false };
    expectType<FontInfo>(face);
    expectType<(b: Uint8Array) => FontInfo>(parseFontFile);
    expectType<Promise<string | null>>(registerFont(face, new Uint8Array(0)));
    expectType<FontInfo[]>(registeredFonts());
    expectType<() => void>(clearFonts);
    expectType<number>(FONT_MAX_TABLES); expectType<number>(FONT_MAX_NAMES);

    // TILED: a grid of references into a sheet, which is what a `sourceRect` already is. INFLATING
    // is injected as it is for Aseprite, and an EXTERNAL tileset is resolved by the caller — a
    // parser that reached for a file would need a filesystem and stop being pure.
    expectType<string | null>(tiledMapError("<map/>"));
    const tmap: TiledMapResult = parseTiledMap('<map width="1" height="1" tilewidth="16" tileheight="16"/>');
    expectType<TiledMapResult>(parseTiledMap("<map/>", { inflate: (d: Uint8Array) => d }));
    expectType<number>(tmap.width); expectType<number>(tmap.height);
    expectType<number>(tmap.tileWidth); expectType<number>(tmap.tileHeight);
    expectType<string>(tmap.orientation);
    expectType<string[]>(tmap.notes);
    const tset: TiledTileset = tmap.tilesets[0] ?? { firstGid: 1, source: null, name: "", tileWidth: 16,
        tileHeight: 16, columns: 0, tileCount: 0, spacing: 0, margin: 0, image: null,
        imageWidth: null, imageHeight: null, tiles: [], offsetX: 0, offsetY: 0 };
    // `source` is the CONTRACT for an unresolved external set — a caller with no way to tell an
    // embedded set from a named one would silently draw nothing for 18 of the measured maps.
    expectType<string | null>(tset.source);
    expectType<string | null>(tset.image);
    expectType<number | null>(tset.imageWidth); expectType<number | null>(tset.imageHeight);
    expectType<TiledTileset>(parseTiledTileset("<tileset/>", tset));
    expectType<TiledTileset | null>(tilesetFor(tmap.tilesets, 1));
    const tlayer: TiledLayer = tmap.layers[0] ?? { name: "", width: 0, height: 0, cells: [] };
    expectType<TiledCell[]>(tlayer.cells);
    const tcell: TiledCell = decodeGid(0);
    expectType<number>(tcell.gid);
    // The three flips are part of the CONTRACT: a tile drawn unflipped is a wrong picture, not a
    // missing one, and 820 of the measured cells carry at least one flag.
    expectType<boolean>(tcell.flipH); expectType<boolean>(tcell.flipV); expectType<boolean>(tcell.flipD);
    expectType<SourceRect | null>(tileSourceRect(tset, 1));
    expectType<{ x: number; y: number }>(tilePosition(tmap, 0, 0));
    // The flips as something the DOCUMENT can hold — a quarter turn and one axis flip, which is
    // exactly the eight symmetries of a square and no more than one way to say each.
    expectType<{ rotation: number; scaleX: number; scaleY: number }>(tileTransform(tcell));
    // A COLLECTION set is a documented Tiled form whose tiles are separate files — three in the
    // measured tree. `tiles` empty is the tell that a set is sheet-backed instead, which a caller
    // must check FIRST, since only a sheet has a rect to cut.
    const tileImage: TiledTileImage | undefined = tset.tiles[0];
    expectType<TiledTileImage | undefined>(tileImage);
    expectType<TiledTileImage | null>(tileImageFor(tset, 1));
    // A WARNING, not a refusal: a set may over-declare and leave the tail unused. What it must not
    // do is go unmentioned — one real set claimed 348 tiles in a picture holding 1 and every field
    // it returned looked plausible.
    expectType<string | null>(tilesetOverflow(tset));
    // The draw offset lets a tall tile hang ABOVE its own cell; zero when the file omits it.
    expectType<number>(tset.offsetX); expectType<number>(tset.offsetY);
    expectType<number>(TILED_MAX_CELLS); expectType<number>(TILED_MAX_LAYERS);
    expectType<number>(TILED_MAX_TILE_IMAGES);

    // glTF: 3D arrives as a READER first. Nothing draws these yet — a schema, a node type and a
    // pipeline are what that needs — but reading them correctly is a self-contained problem with a
    // right answer, and doing it first is what makes the rest small.
    expectType<string | null>(glbError(new Uint8Array(0)));
    const gjson: GltfJson = { asset: { version: "2.0" } };
    const glbBox: GlbContainer = { json: gjson, bin: null };
    // `bin` NULL is part of the contract: a `.gltf` names an external buffer and a `.glb` may too,
    // so a caller must be able to tell "no buffer here" from "an empty one".
    expectType<Uint8Array | null>(glbBox.bin);
    expectType<GlbContainer>(parseGlb(new Uint8Array([0x67, 0x6c, 0x54, 0x46])));
    expectType<string | null>(gltfError(gjson));
    const gres: GltfResult = parseGltf(gjson, new Uint8Array(0));
    expectType<string>(gres.generator);
    expectType<string[]>(gres.extensions); expectType<string[]>(gres.notes);
    const inst: GltfMeshInstance | undefined = gres.instances[0];
    expectType<GltfMeshInstance | undefined>(inst);
    const prim: GltfPrimitive | undefined = inst?.primitive;
    // Positions and indices are ALWAYS present; normals and uvs may not be, and a caller that
    // assumed them would crash on a file that states neither.
    expectType<Float32Array | undefined>(prim?.positions);
    expectType<Uint32Array | undefined>(prim?.indices);
    expectType<Float32Array | null | undefined>(prim?.normals);
    expectType<Float32Array | null | undefined>(prim?.uvs);
    // WIDENED when OBJ landed: glTF names a material by INDEX and OBJ by NAME, and the shared
    // shape carries both rather than each reader declaring its own near-identical primitive.
    expectType<number | string | null | undefined>(prim?.material);
    expectType<number[] | undefined>(inst?.matrix);
    expectType<Float64Array | null>(readAccessor(gjson, 0, new Uint8Array(0)));
    const gnode: GltfNode = { name: "n" };
    expectType<number[]>(nodeMatrix(gnode));
    expectType<number[]>(multiplyMat4([], []));
    expectType<string[]>(GLTF_IGNORABLE_REQUIRED);
    expectType<number>(GLTF_MAX_VERTICES); expectType<number>(GLTF_MAX_PRIMITIVES);
    expectType<number>(GLTF_MAX_NODE_DEPTH);

    // MATERIALS. 7,955 across the tree, 4,255 naming a base-colour texture, and 4,489 relying on
    // the spec's default white — so the DEFAULTS are load-bearing for more than half the corpus.
    const gmats: GltfMaterial[] = gltfMaterials(gjson);
    expectType<GltfMaterial[]>(gmats);
    const gmat: GltfMaterial | undefined = gmats[0];
    expectType<[number, number, number, number] | undefined>(gmat?.baseColor);
    expectType<number | undefined>(gmat?.metallic);
    expectType<string | undefined>(gmat?.alphaMode);
    expectType<boolean | undefined>(gmat?.doubleSided);
    // An image is LOCATED, not fetched: a `uri` names a file the caller opens, a `buffer` names a
    // slice of the bytes already in hand. Both appear — 4,130 and 125.
    const gimg: GltfImageSource | null = gltfImageSource(gjson, 0);
    expectType<GltfImageSource | null>(gimg);
    expectType<GltfImageSource | null | undefined>(gmat?.baseColorImage);

    // OBJ produces the SAME shape glTF does — `MeshData` names it once so a mesh node, a picker and
    // a GPU path are each written once rather than per format. FBX will produce it too.
    expectType<string | null>(objError("v 0 0 0"));
    const objRes: ObjResult = parseObj("v 0 0 0");
    const objInst: MeshInstance | undefined = objRes.instances[0];
    const objPrim: MeshPrimitive | undefined = objInst?.primitive;
    expectType<MeshInstance | undefined>(objInst);
    expectType<MeshPrimitive | undefined>(objPrim);
    // The material is a NAME here and an index in glTF; the shared field carries both.
    expectType<number | string | null | undefined>(objPrim?.material);
    // The `.mtl` files are REPORTED for a caller to resolve, never fetched.
    expectType<string[]>(objRes.materialLibraries);
    expectType<string[]>(objRes.notes);
    expectType<readonly number[]>(MESH_IDENTITY);
    // 1-based, and NEGATIVE counts back from what has been read so far.
    expectType<number>(resolveObjIndex(-1, 3));
    expectType<string | null>(mtlError("newmtl x"));
    const objMat: ObjMaterial | undefined = parseMtl("newmtl x").get("x");
    expectType<[number, number, number] | null | undefined>(objMat?.diffuse);
    expectType<number | undefined>(objMat?.opacity);
    expectType<string | null | undefined>(objMat?.diffuseMap);
    expectType<Map<string, ObjMaterial>>(parseMtl("newmtl x"));
    expectType<number>(OBJ_MAX_VERTICES); expectType<number>(OBJ_MAX_GROUPS);
    expectType<number>(OBJ_FACE_MAX_CORNERS);
    expectType<{ x: number; y: number; width: number; height: number } | null>(imageInkBounds("a.png", region, 0));

    // ASEPRITE: the file a sheet was exported FROM, which states the grid, the trim and the clips
    // that a PNG export throws away. Parsing is pure; INFLATING is injected.
    const aseBytes = new Uint8Array(128);
    expectType<string | null>(asepriteError(aseBytes));
    const ase: AseFile = { width: 0, height: 0, colorDepth: 32, transparentIndex: 0,
        frames: [], layers: [], cels: [], tags: [], palette: [] };
    expectType<AseFile>(ase);
    expectType<AseLayer[]>(ase.layers);
    expectType<AseCel[]>(ase.cels);
    expectType<AseTag[]>(ase.tags);
    expectType<(b: Uint8Array, o?: { inflate?: (d: Uint8Array) => Uint8Array }) => AseFile>(parseAseprite);
    // The tags ARE clips — a rename, not a translation.
    expectType<{ name: string; from: number; to: number; loop: boolean }[]>(asepriteClips(ase));
    expectType<{ frames: number; fps: number }>(asepriteTimeline(ase));
    expectType<number>(ASE_MAX_FRAMES); expectType<number>(ASE_MAX_LAYERS);
    expectType<number>(ASE_MAX_CELS); expectType<number>(ASE_MAX_CANVAS);
    // `pixels` holds the file's own SAMPLES, whatever depth that is; converting is a separate step,
    // because naming a field `pixels` while quietly converting hides what the file actually said.
    expectType<number>(aseBytesPerPixel(8));
    expectType<Uint8Array | null>(celRgba(ase, { frame: 0, layer: 0, x: 0, y: 0, width: 0, height: 0,
        opacity: 255, pixels: null, compressed: null, linkedFrom: null }));

    // WHICH END A NON-INTERPOLATABLE VALUE TAKES is the CALLER's question (schema 54). A timeline
    // steps so a drawing appears on its own keyframe; a state transition switches so a hover means
    // it now. Stated once rather than as a per-property list that grows a clause at a time.
    const discreteMode: DiscreteMode = "step";
    expectType<DiscreteMode>(discreteMode);
    const blendable = { ...doc.nodes.values().next().value } as Node;
    expectType<Node>(blendNode(blendable, blendable, 0.5, undefined, discreteMode));
    expectType<Node>(blendNode(blendable, blendable, 0.5));
    expectType<(ctx: CanvasRenderingContext2D, d: ReadonlyDocument, p: SheetPlan) => void>(drawSheet);
    expectType<number>(TIMELINE_MAX_FRAMES);
    expectType<number>(TRACK_MAX_KEYFRAMES);
    expectType<number>(FPS_MIN); expectType<number>(FPS_MAX);

    // --- Depth: one number, three consumers (schema 40) ----------------------
    expectType<string | null>(depthError(0));
    expectType<number>(depthOf({}));
    expectType<number>(parallaxRate(1));
    expectType<{ x: number; y: number }>(parallaxOffset(1, es.viewport));
    expectType<number>(depthToClipZ(1));
    expectType<number>(byDepth({ depth: 0 }, { depth: 1 }));
    // GENERIC and identity-preserving: `applyParallax` returns the SAME type it was given, which
    // is what lets it sit in front of `computeGeometry` on a mutable document without a cast.
    // Pinned by ANNOTATING the result rather than by `expectType<ReadonlyDocument>(…)`, on the
    // same reasoning as `expectNotMutable` above: `expectType` is one-directional, so a return
    // type widened to readonly would widen straight past it.
    //
    // What is actually VERIFIED, stated separately from the reasoning: widening the return type to
    // the generic's own constraint fails this line. The narrower claim — that the `expectType`
    // form would have let a widening to exactly `ReadonlyDocument` through — is NOT verified,
    // because that mutation cannot be made to compile inside `Depth.ts` without rewriting the
    // function body, and a mutation whose own file fails to compile scores nothing.
    const parallaxed: ProjectDocument = applyParallax(doc, es.viewport);
    expectType<ProjectDocument>(parallaxed);
    expectType<number>(DEPTH_MIN); expectType<number>(DEPTH_MAX);

    // --- Mesh: bending a shape, and the surface a light reads (schemas 41–42) -
    const meshBox = { width: 100, height: 100 };
    const mesh: Mesh = restMesh(1, 1);
    expectType<Mesh>(mesh);
    expectNotMutable<ReadonlyMesh>(mesh as ReadonlyMesh);
    expectType<string | null>(meshError(mesh));
    expectType<{ x: number; y: number }>(restPoint(mesh, 0, 0));
    expectType<boolean>(isIdentityMesh(mesh));
    expectType<{ x: number; y: number }>(warpPoint(mesh, meshBox, 1, 1));
    expectType<PathCommand[]>(warpCommands([pathCmd], meshBox, mesh, flattenPath));
    expectType<number>(heightOf({}));
    expectType<number>(warpHeight(mesh, meshBox, 1, 1));
    expectType<boolean>(isFlatMesh(mesh));
    expectType<{ min: number; max: number }>(heightRange(mesh));
    // RAY CASTING through a heightfield. `height` is INJECTED — the module knows nothing about
    // meshes or lights, the same arrangement `castShadows` uses for its offset.
    expectType<boolean>(marchOccluded(() => 0, 0, 0, { x: 0, y: 0, z: 1 }, 10));
    expectType<boolean>(marchOccluded(() => 0, 0, 0, { x: 0, y: 0, z: 1 }, 10, 32));
    expectType<number>(RAY_STEPS);
    expectType<number>(MESH_MAX_DIVISIONS);
    // TWO normals, and the distinction is the contract: `surfaceNormal` is RAW (what the GPU gets,
    // because only an un-normalised vector survives linear interpolation) and `normalAt` is its
    // unit form. Collapsing them back into one function is exactly the regression to catch.
    expectType<{ x: number; y: number; z: number }>(surfaceNormal(mesh, meshBox, 1, 1));
    expectType<{ x: number; y: number; z: number }>(normalAt(mesh, meshBox, 1, 1));

    // --- Lighting (schema 42) ------------------------------------------------
    const light: Light = { x: 1, y: 0, z: -1, color: "#ffffff", intensity: 1 };
    expectType<Light>(light);
    expectType<string | null>(lightsError([light]));
    expectType<string | null>(ambientError(0.2));
    expectType<{ x: number; y: number; z: number } | null>(normalize(light));
    expectType<number>(lambert({ x: 0, y: 0, z: 1 }, light));
    expectType<{ x: number; y: number }>(shadowOffset(light, 4));
    expectType<number>(heightAbovePage(-4));

    // Shape-on-shape shadows, as geometry rather than as a shadow map.
    const shadowShape: ShadowShape = { id: "A", rings, depth: -10 };
    expectType<ShadowShape>(shadowShape);
    expectType<Ring[]>(shadowPatch(rings, rings, { x: 1, y: 1 }));
    const patches: CastShadowPatch[] = castShadows([shadowShape], () => ({ x: 1, y: 1 }));
    expectType<CastShadowPatch[]>(castShadows([shadowShape], () => ({ x: 1, y: 1 }), 10));
    expectType<string>(patches[0]?.receiverId ?? "");
    expectType<string>(patches[0]?.casterId ?? "");
    expectType<Ring[]>(patches[0]?.rings ?? []);
    expectType<string>(SHADOW_ALPHA);
    expectType<number>(CAST_SHADOW_MAX_PAIRS);
    expectType<number>(LIGHTS_MAX);
    expectType<readonly Light[] | undefined>(model.lights);
    expectType<number | undefined>(model.ambient);
    expectType<number | undefined>(model.content[0].depth);

    // --- The GPU backend -----------------------------------------------------
    expectType<(c: HTMLCanvasElement, m: DisplayList, vp: { x: number; y: number; zoom: number }, dpr?: number) => boolean>(emitWebGL);
    expectType<(c: HTMLCanvasElement) => GLState | null>(initGL);
    expectType<[number, number, number, number] | null>(parseColor("#fff"));
    expectType<PathCommand[] | null>(shapeToLocalCommands(model.content[0].shape, null));
    expectType<number[]>(viewMatrix(800, 600, 0, 0, 1));
    expectType<number>(itemTolerance(model.content[0], 1));
    const draws: Draw[] = itemDraws(model.content[0]);
    expectType<Draw[]>(itemDraws(model.content[0], 0.05));
    expectType<number[]>(draws[0]?.vertices ?? []);
    // `normals` is part of the CONTRACT, not an implementation detail: a backend that dropped it
    // would still compile against a `Draw` that never named it, and the shading would go quietly.
    expectType<number[]>(draws[0]?.normals ?? []);
    expectType<number[]>(draws[0]?.locals ?? []);
    // The heightfield the FRAGMENT stage marches. Null is a real answer — a flat surface has no
    // relief to occlude with and no range to pack sixteen bits against.
    expectType<HeightTexture | null>(draws[0]?.height ?? null);
    expectType<{ href: string; x: number; y: number; width: number; height: number } | null>(draws[0]?.image ?? null);
    expectType<TextShape | null>(draws[0]?.text ?? null);
    expectType<HeightTexture | null>(heightTexture(mesh, meshBox));
    expectType<HeightTexture | null>(heightTexture(mesh, meshBox, 32));
    expectType<number>(decodeHeight(0, 0, 0, 1));
    expectType<number>(HEIGHT_TEX_SIZE);
    expectType<[number, number, number, number]>(draws[0]?.color ?? [0, 0, 0, 1]);
    expectType<(gl: WebGLRenderingContext, s: GLState, l: readonly Light[] | undefined, a: number | undefined) => void>(setLighting);

    // --- Actions that write the schema-37–42 fields --------------------------
    expectType<Action | null>(booleanAction(doc, computed, [], "union", "new-id"));
    expectType<Action | null>(makeBooleanNodeAction(doc, computed, [], "union", "new-id"));
    expectType<PathCommand[] | null>(worldCommandsOf(computed, "id"));
    expectType<number | null>(strokeWidthOf(doc, "id"));
    expectType<Action | null>(outlineStrokeAction(doc, computed, [], ["new-id"]));
    expectType<Action | null>(outlineStrokeAction(doc, computed, [], ["new-id"], "outer"));
    expectType<Action>(new SetTrackAction(doc, "id", [keyframe]));
    expectType<Action>(new SetTimelineAction(doc, timeline));
    expectType<Action>(new SetDepthAction(doc, "id", 1));
    expectType<Action>(new SetMeshAction(doc, "id", mesh));
    expectType<Action>(new SetLightingAction(doc, [light], 0.2));
}

/**
 * The `core/paint` surface — the pixel side of 2D.
 *
 * A BOX TYPE IS SPELT OUT rather than aliased to `Rect`. These modules deliberately do not import
 * the geometry types (a brush knows nothing about world space), so pinning them against `Rect`
 * would assert a coupling the code does not have and would go green if one were introduced.
 */
function _paintSurface(): void {
    type Box = { x: number; y: number; width: number; height: number };
    const buffer: PixelBuffer = createPixelBuffer(4, 3);
    const colour: Rgba = [0, 0, 0, 0];
    const brush: Brush = makeBrush(3, true);

    // --- PixelBuffer: the surface itself ---------------------------------------
    expectType<number>(PIXEL_MAX_SIDE);
    expectType<number>(PIXEL_FILL_MAX);
    expectType<string | null>(pixelBufferError(1, 1));
    expectType<{ width: number; height: number; data: Uint8ClampedArray }>(buffer);
    expectType<boolean>(inBounds(buffer, 0, 0));
    // NULL IS PART OF THE CONTRACT: off the surface is a real answer, not an exception.
    expectType<Rgba | null>(getPixel(buffer, 0, 0));
    expectType<void>(setPixel(buffer, 0, 0, colour));
    expectType<[number, number][]>(linePoints(0, 0, 1, 1));
    expectType<void>(drawLine(buffer, 0, 0, 1, 1, colour));
    expectType<number>(floodFill(buffer, 0, 0, colour));

    // --- PixelPatch: what an edit was ------------------------------------------
    const patch: PixelPatch = capturePatch(buffer, readRegion(buffer, 0, 0, 2, 2), 0, 0, 2, 2);
    expectType<{ x: number; y: number; width: number; height: number;
        before: Uint8ClampedArray; after: Uint8ClampedArray }>(patch);
    expectType<PixelPatch>(EMPTY_PATCH);
    expectType<boolean>(isEmptyPatch(patch));
    expectType<Uint8ClampedArray>(readRegion(buffer, 0, 0, 1, 1));
    expectType<void>(applyPatch(buffer, patch));
    expectType<void>(revertPatch(buffer, patch));
    expectType<PixelPatch>(invertPatch(patch));
    expectType<number>(patchCost(patch));

    // --- Brush: the mark a press leaves ----------------------------------------
    expectType<number>(BRUSH_MAX_SIZE);
    expectType<string | null>(brushError(3, true));
    // WIDTH AND HEIGHT ARE SEPARATE, because a 3x1 brush is a real tool and one `size` cannot say it.
    expectType<{ width: number; height: number; round: boolean; dabs: BrushDab[]; variants: Brush[] }>(brush);
    expectType<{ dx: number; dy: number; colour: Rgba | null }>(brush.dabs[0]);
    expectType<Brush>(brushFromImage(buffer));
    expectType<Brush | null>(brushWithVariants([brush]));
    expectType<Brush>(pickFace(brush, 0));
    expectType<void>(stampBrush(buffer, brush, 0, 0, colour));
    expectType<Box>(brushBounds(brush, 0, 0));
    expectType<void>(strokePath(buffer, brush, [[0, 0]], colour, linePoints));
    expectType<Box | null>(strokeBounds(brush, [[0, 0]]));

    // --- PixelCodec: a surface as text a document can hold ---------------------
    expectType<number>(PIXEL_CODEC_VERSION);
    expectType<number>(PIXEL_RUN_MAX);
    const encoded: EncodedSurface = encodeSurface(buffer);
    expectType<{ data: string; rawBytes: number; packedBytes: number }>(encoded);
    expectType<PixelBuffer | null>(decodeSurface(encoded.data, 4, 3));

    // --- Stroke: a drag, from press to patch -----------------------------------
    const session: StrokeSession | null = beginStroke(buffer, brush, 0, 0, colour, 8);
    expectType<StrokeSession | null>(session);
    expectType<{ brush: Brush; colour: Rgba; points: [number, number][];
        region: Box; before: Uint8ClampedArray }>(session!);
    expectType<void>(extendStroke(buffer, session!, 1, 1, linePoints));
    expectType<PixelPatch>(endStroke(buffer, session!, linePoints));
    expectType<boolean>(strokeEscaped(session!));
    expectType<PixelPatch>(NO_STROKE);

    // --- Palette: colours plus the layout the artist chose ---------------------
    const palette: Palette = { name: "p", colours: [colour], width: 1, height: 1, comment: "" };
    expectType<number>(PALETTE_MAX_COLOURS);
    expectType<number>(PALETTE_MAX_SIDE);
    expectType<{ name: string; colours: Rgba[]; width: number; height: number; comment: string }>(palette);
    expectType<string | null>(paletteError(palette));
    // NULL IS A REAL ANSWER — a grid may have holes, and a picker must draw one rather than shift up.
    expectType<Rgba | null>(paletteAt(palette, 0, 0));
    expectType<Rgba | null>(parseFloatColour("(1, 1, 1, 1)"));
    expectType<Palette | null>(parsePaletteFile({}, "n"));

    // --- Symmetry: one stroke that paints two, four, or one --------------------
    const mode: SymmetryMode = NO_SYMMETRY;
    expectType<{ horizontal: boolean; vertical: boolean }>(mode);
    expectType<[number, number][]>(symmetryPoints(0, 0, 4, 3, mode));
    expectType<boolean>(isMirrored(mode));

    // --- Quantize: snapping to the palette an artist chose ---------------------
    expectType<number>(colourDistance(colour, colour));
    expectType<Rgba | null>(nearestColour(palette, colour));
    expectType<number>(quantizeToPalette(buffer, palette));

    // --- SurfaceSpace: where a pointer is, in pixels ---------------------------
    const space: SurfaceSpace = {
        world: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        localWidth: 4, localHeight: 3,
        surfaceWidth: 4, surfaceHeight: 3
    };
    expectType<string | null>(surfaceSpaceError(space));
    expectType<[number, number] | null>(worldToSurface(space, 0, 0));
    expectType<{ x: number; y: number } | null>(surfaceToWorld(space, 0, 0));
    expectType<{ x: number; y: number } | null>(surfacePixelSize(space));

    // --- The document side: a node that HOLDS a surface ------------------------
    const stored: RasterSurface = { data: encoded.data, width: 4, height: 3 };
    expectType<{ data: string; width: number; height: number }>(stored);
    expectType<string | null>(rasterSurfaceError(stored));
    expectType<number>(RASTER_MAX_SIDE);
    const paintDoc: ProjectDocument = createEmptyDocument();
    expectType<Action>(new PaintSurfaceAction(paintDoc, "id", patch));
}

/**
 * `core/document/Gradient` — the fill that changes across a shape.
 *
 * Pinned on arrival, per the trigger this file's header now carries: a new file under `src/core`
 * is the moment the pin is cheapest to extend and the moment it is always forgotten.
 */
function _gradientSurface(): void {
    expectType<number>(GRADIENT_MAX_STOPS);
    const g: Gradient = defaultGradient("linear");
    expectType<{ kind: "linear" | "radial"; stops: readonly GradientStop[]; units: GradientUnits;
        transform: { a: number; b: number; c: number; d: number; e: number; f: number };
        x1: number; y1: number; x2: number; y2: number;
        cx: number; cy: number; r: number; fx: number; fy: number }>(g);
    expectType<{ offset: number; color: string; opacity: number }>(g.stops[0]);
    expectType<Gradient>(defaultGradient("radial"));
    expectType<string | null>(gradientError(g));
    expectType<GradientStop[]>(normalizeStops(g.stops));
    // NULL IS A REAL ANSWER: a gradient with no stops has no colour to report, and inventing one
    // would paint something the document never said.
    expectType<GradientSample | null>(sampleGradient(g, 0.5));
    expectType<{ color: string; opacity: number; mix: number | null; from: number; to: number } | null>(
        sampleGradient(g, 0.5));
}

/** `core/document/Clipboard` and the action that lands a paste — pinned on arrival. */
function _clipboardSurface(): void {
    const doc: ProjectDocument = createEmptyDocument();
    expectType<number>(PASTE_OFFSET);
    // NULL IS A REAL ANSWER: nothing copyable must leave a previous clipboard alone rather than
    // clearing it, so the caller has to be able to tell "nothing" from "empty".
    expectType<ClipboardContents | null>(copyNodes(doc, ["id"]));
    const held: ClipboardContents = { nodes: [], rootIds: [] };
    expectType<{ nodes: Node[]; rootIds: string[] }>(held);
    expectType<PasteResult>(remapForPaste(held));
    expectType<{ nodes: Node[]; rootIds: string[] }>(remapForPaste(held, 10));
    const paste = new PasteNodesAction(doc, [], []);
    expectType<Action>(paste);
    expectType<string[]>(paste.getCreatedRootIds());
}

/** `core/import/SvgGradient` — pinned on arrival, per the trigger. */
function _svgGradientSurface(): void {
    expectType<Map<string, Gradient>>(parseSvgGradients("<svg></svg>"));
}
