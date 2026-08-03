/**
 * Document Engine Tests
 * Covers: document model, serialization, action system, dispatcher, history.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { createEmptyDocument, ProjectDocument, ReadonlyDocument, CURRENT_VERSION, SCHEMA_VERSION } from "../document/Document";
import { variableStoreError, variableKeyError, resolveVariable, resolveColor, resolveNumber, isTokenRef, tokenRefFor, tokenKeyOf, Variable, VariableStore, VARIABLES_MAX, VARIABLE_FALLBACK_COLOR } from "../document/Variables";
import { SetVariableAction, DeleteVariableAction, SetActiveThemeAction } from "../actions/VariableActions";
import { CreateInstanceAction } from "../actions/CreateInstanceAction";
import { expandInstances, componentError, overridesError, overrideAgainstMasterError, isVirtualId, splitVirtualId, INSTANCE_MAX_DEPTH, INSTANCE_MAX_NODES, INSTANCE_MAX_OVERRIDES , variantMembers, variantProperties, resolveVariantMaster, masterSubtreeIds, resolveOverridePath, resolveScene, statesError} from "../document/Components";
import { SetInstanceOverrideAction } from "../actions/SetInstanceOverrideAction";
import { SetVariantAction, SetInstanceVariantAction } from "../actions/VariantActions";
import { SetSlotAction, SetSlotContentAction } from "../actions/SlotActions";
import { SetNodeStateAction, SetActiveStateAction } from "../actions/StateActions";
import { SetNodeFlagsAction } from "../actions/SetNodeFlagsAction";
import { resolveLayerDrop } from "../../editor/layerDrop";
import { selectionForRowClick } from "../../editor/layerSelection";
import { filterLayers } from "../../editor/layerFilter";
import { PenPoint, penCommands, pathBounds, translatePath, penNodeFrom, pathVertices, movePathVertex, normalizePathNode } from "../geometry/PathBuilder";
import { UpdateNodePathAction } from "../actions/UpdateNodePathAction";
import { DetachInstanceAction } from "../actions/DetachInstanceAction";
import { applyMutationsToDocument } from "../actions/applyMutations";
import { geometryActionFor, styleActionFor, contentActionFor, layoutActionFor, transformActionFor, isEditableNode, isHandleOffered, isMasterRootCopy , overrideTargetFor} from "../actions/nodeEdit";
import { serializeDocument, deserializeDocument, compareDocuments, Serializer, migrateIfNeeded } from "../document/Serializer";
import { ActionDispatcher } from "../actions/ActionDispatcher";
import { MoveNodeAction } from "../actions/MoveNodeAction";
import { AddNodeAction } from "../actions/AddNodeAction";
import { DeleteNodeAction } from "../actions/DeleteNodeAction";
import { ResizeNodeAction } from "../actions/ResizeNodeAction";
import { UpdateNodeGeometryAction } from "../actions/UpdateNodeGeometryAction";
import { UpdateNodeStyleAction } from "../actions/UpdateNodeStyleAction";
import { TransactionAction } from "../actions/TransactionAction";
import { UpdateNodeTransformAction } from "../actions/UpdateNodeTransformAction";
import { UpdateNodeLayoutAction } from "../actions/UpdateNodeLayoutAction";
import { ReparentNodeAction } from "../actions/ReparentNodeAction";
import { traverseSceneGraph, selectionRoots } from "../document/SceneGraph";
import { computeGeometry, hitTest, nodesInRect, toLocal, toWorld, subtreeBounds, selectionBounds, ComputedState, ComputedNode } from "../geometry/GeometryEngine";
import { flattenPath, hitsShape, isPaintBearing, FLATTEN_TOLERANCE, FLATTEN_MAX_DEPTH, hitShapeOf, displayTolerance, localScaleOf, DISPLAY_DEVIATION_PX, DISPLAY_TOLERANCE_MIN, DISPLAY_TOLERANCE_MAX } from "../geometry/ShapeHit";
import { cursorForDirection, localLinear, worldDeltaToLocal } from "../geometry/OrientedBox";
import { booleanRings, booleanPaths, commandsToRings, ringsToCommands, insideRings } from "../geometry/PathBoolean";
import { triangulate, signedArea2, TESSELLATE_MAX_VERTICES, subdivideTriangles, SUBDIVIDE_MAX_DEPTH } from "../geometry/Tessellate";
import { convexPieces, isConvexRing, convexOverlaps, piecesOverlap, piecesArea, rectRing, DECOMPOSE_MAX_PIECES } from "../geometry/ConvexDecompose";
import { resolveRings, insideRule, crossingCount, FILL_RULES, FillRule, resolveBoolean } from "../geometry/Resolve";
import { applyFrame, trackError, timelineError, onionFrames, keyframesAt, TIMELINE_MAX_FRAMES, FPS_MAX } from "../document/Timeline";
import { SetTrackAction } from "../actions/SetTrackAction";
import { SetTimelineAction } from "../actions/SetTimelineAction";
import { depthError, depthOf, depthToClipZ, parallaxOffset, parallaxRate, applyParallax, DEPTH_MIN, DEPTH_MAX } from "../document/Depth";
import { Mesh, meshError, restMesh, warpPoint, isIdentityMesh, MESH_MAX_DIVISIONS } from "../document/Mesh";
import { meshHandles, meshHandleAtPoint, meshIndexOf } from "../geometry/SelectionHandles";
import { normalAt, surfaceNormal, warpHeight, isFlatMesh, heightRange } from "../document/Mesh";
import { Light, lightsError, ambientError, lambert, shadowOffset, heightAbovePage, LIGHTS_MAX } from "../document/Light";
import { resolveMeshes } from "../document/Components";
import { castShadows, shadowPatch, ShadowShape, SHADOW_ALPHA } from "../geometry/CastShadow";
import { Ring } from "../geometry/PathBoolean";
import { marchOccluded, RAY_STEPS } from "../geometry/RayMarch";
import { overrideValueError } from "../document/Components";
import { strokeOutline, STROKE_JOINS, STROKE_CAPS, STROKE_ALIGNS, DEFAULT_MITER_LIMIT } from "../geometry/StrokeOutline";
import { StrokeAlign } from "../geometry/StrokeOutline";
import { outlineStrokeAction, strokeWidthOf } from "../actions/outlineStrokeActions";
import { itemDraws, itemTolerance, parseColor, viewMatrix, shapeToLocalCommands, heightTexture, decodeHeight, HEIGHT_TEX_SIZE } from "../../renderer/emitWebGL";
import { imageGeneration, resolveImage } from "../../renderer/ImageCache";
import { textRasterScale, textRasterKey, TEXT_RASTER_MIN, TEXT_RASTER_MAX } from "../../renderer/TextRaster";
import { ellipseCommands, rectCommands, shapeToCommands, transformCommands } from "../geometry/ShapeToPath";
import { booleanAction, makeBooleanNodeAction } from "../actions/booleanActions";
import { SetBooleanOpAction } from "../actions/SetBooleanOpAction";
import { resolveBooleans } from "../document/Components";
import { BooleanOp, booleanOpError } from "../document/Node";
import { TEXT_ALIGNS, FONT_FAMILY_MAX } from "../document/Node";
import { blendColor, blendStates, easingAt, interactionFor, interactionsError, Interaction, Trigger, TRANSITION_MAX_MS, INTERACTIONS_MAX } from "../document/Prototype";
import { applyActiveState } from "../document/Components";
import { SetInteractionsAction } from "../actions/SetInteractionsAction";
import { viewportToFit, lerpViewport } from "../../editor/EditorState";
import { compileScript, snapshotFor, actionRequestError, SCRIPT_MAX_REQUESTS } from "../script/ScriptApi";
import { WORKER_BOOTSTRAP } from "../../editor/ScriptRunner";
import { layoutChildren, layoutGridChildren, resolveGridTracks, placeGridItems, breakFlexLines, resolveMargin, expandDirtyForLayout, isLayoutContainer, measureIntrinsicSizes, resolveConstraints } from "../geometry/LayoutEngine";
import { translation, compose, multiply, invert, applyToPoint, transformRectToAABB, IDENTITY } from "../geometry/Matrix";
import { clampViewport, createEditorState, panBy, zoomAt, screenToWorld } from "../../editor/EditorState";
import { selectionHandles, selectionFrame, handleAtPoint, groupRotateHandle, groupHandleAtPoint, groupCornerHandles, HANDLE_SIZE_PX, ROTATE_OFFSET_PX , pathVertexHandles, vertexIndexOf, vertexHandleAtPoint} from "../geometry/SelectionHandles";
import { rotateGroup, isGroupRotatable, scaleGroup, isGroupResizable } from "../geometry/GroupTransform";
import { computeSnap, snapPoint, guidesForRect, snapTargetsExcludingSubtree, snapTargetsExcludingSubtrees, isTranslationOnlyChain } from "../geometry/Snapping";
import { rulerTicks, niceStep } from "../geometry/Ruler";
import { MoveTool } from "../../editor/tools/MoveTool";
import { buildRenderModel } from "../../renderer/RenderModel";
import { ShapeTool, SHAPE_KINDS, ShapeKind, PaintMode, polygonCommands, supportsPaintMode, clampStrokeWidth, DEFAULT_STROKE_WIDTH, STROKE_WIDTH_MAX } from "../../editor/tools/ShapeTool";
import { polygonPoints, clampSides, POLYGON_MIN_SIDES, POLYGON_MAX_SIDES } from "../geometry/Polygon";
import { FrameSelectionAction } from "../actions/FrameSelectionAction";
import { alignBoxes, distributeBoxes, AlignEdge } from "../geometry/Alignment";
import { scanCapabilities } from "../scan/CapabilityScan";
import { exportSVG, EXPORT_MARGIN } from "../export/ExportSVG";
import { textParagraphs } from "../../renderer/RenderModel";
import { resolveShortcut, isTypingTarget, NUDGE_STEP, NUDGE_STEP_LARGE } from "../../editor/shortcuts";
import { DuplicateNodesAction, DUPLICATE_OFFSET } from "../actions/DuplicateNodesAction";
import { alignAction, distributeAction } from "../actions/alignActions";
import { UpdateNodeContentAction, NODE_NAME_MAX } from "../actions/UpdateNodeContentAction";
import { SelectTool } from "../../editor/tools/SelectTool";
import { ToolController } from "../../editor/tools/ToolController";
import { Node, NODE_TYPES, nodeIdError, srcError, IMAGE_SRC_MAX, GRID_SPAN_MAX, GRID_MAX_TRACKS, dimensionError, isNodeType, pathError, PATH_MAX_COMMANDS, PathCommand, styleError, Shadow, TrackSize, layoutError, newGridPatch, mergeLayout, transformError, Layout, variantError, variantSelectionError , slotError, slotContentError} from "../document/Node";
import { parseTrackList, formatTrackList } from "../document/TrackList";

/** A hand-built ComputedNode's ink: a plain square box (what every non-shape type gets). */
const BOX = { kind: "box", radius: 0 } as const;

function createDocWithRectangle(): ProjectDocument {
    const doc = createEmptyDocument();
    const node: Node = {
        id: "rectangle-001",
        type: "core.rectangle",
        parent: null,
        children: [],
        geometry: { x: 0, y: 0, width: 200, height: 100 },
        style: { fill: "#ff0000", opacity: 1 },
        layout: {}
    };
    doc.nodes.set("rectangle-001", node);
    doc.rootNodeUuids = ["rectangle-001"];
    return doc;
}

function createDocWithParentChild(): ProjectDocument {
    const doc = createEmptyDocument();
    const parent: Node = {
        id: "parent-001",
        type: "core.rectangle",
        parent: null,
        children: ["child-001", "child-002"],
        geometry: { x: 0, y: 0, width: 400, height: 300 },
        style: { fill: "#0000ff", opacity: 1 },
        layout: {}
    };
    const child1: Node = {
        id: "child-001",
        type: "core.rectangle",
        parent: "parent-001",
        children: [],
        geometry: { x: 10, y: 10, width: 50, height: 50 },
        style: { fill: "#ff0000", opacity: 1 },
        layout: {}
    };
    const child2: Node = {
        id: "child-002",
        type: "core.rectangle",
        parent: "parent-001",
        children: [],
        geometry: { x: 70, y: 10, width: 50, height: 50 },
        style: { fill: "#00ff00", opacity: 1 },
        layout: {}
    };
    doc.nodes.set("parent-001", parent);
    doc.nodes.set("child-001", child1);
    doc.nodes.set("child-002", child2);
    doc.rootNodeUuids = ["parent-001"];
    return doc;
}

// ─── T13: Version uses SCHEMA_VERSION ───
describe("Document creation", () => {
    test("creates empty document with correct schema version", () => {
        const doc = createEmptyDocument();
        expect(doc.version).toBe(SCHEMA_VERSION);
        expect(doc.nodes.size).toBe(0);
        expect(doc.rootNodeUuids).toEqual([]);
    });

    test("creates document with node", () => {
        const doc = createDocWithRectangle();
        expect(doc.nodes.size).toBe(1);
        const node = doc.nodes.get("rectangle-001");
        expect(node).toBeDefined();
        expect(node!.type).toBe("core.rectangle");
        expect(node!.geometry.width).toBe(200);
    });

    test("CURRENT_VERSION matches package.json version", () => {
        // The build injects package.json's version via esbuild define; the
        // fallback literal used in tests must stay in sync so what ships and
        // what is tested never diverge. This is the DISPLAY version only.
        const pkg = require("../../../package.json");
        expect(CURRENT_VERSION).toBe(pkg.version);
    });

    test("schema version is decoupled from the app version", () => {
        // Bumping the app version must never change the persisted schema
        // version, or every previously saved document would fail to load.
        const pkg = require("../../../package.json");
        expect(SCHEMA_VERSION).not.toBe(pkg.version);
        expect(createEmptyDocument().version).toBe(SCHEMA_VERSION);
    });
});

// ─── T9: Empty document serialization ───
describe("Empty document edge cases", () => {
    test("serialize/deserialize empty document", () => {
        const doc = createEmptyDocument();
        const json = serializeDocument(doc);
        const loaded = deserializeDocument(json);
        expect(compareDocuments(doc, loaded)).toBe(true);
        expect(loaded.nodes.size).toBe(0);
    });

    test("dispatch MoveNodeAction on empty doc returns failure", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);
        const action = new MoveNodeAction(doc, "nonexistent", 10, 10);
        const result = dispatcher.dispatchAction(action);
        expect(result.success).toBe(false);
    });

    test("compareDocuments returns true for two empty docs", () => {
        const a = createEmptyDocument();
        const b = createEmptyDocument();
        b.metadata.date = a.metadata.date; // equalize creation timestamps
        expect(compareDocuments(a, b)).toBe(true);
    });
});

// ─── T3: AddNodeAction ───
describe("AddNodeAction", () => {
    test("adds a rectangle node to document", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);
        const action = new AddNodeAction(doc, "core.rectangle", 10, 20, 100, 50, "#aabbcc");
        const result = dispatcher.dispatchAction(action);

        expect(result.success).toBe(true);
        expect(action.getCreatedNodeId()).not.toBeNull();

        const id = action.getCreatedNodeId()!;
        const node = dispatcher.getDocument().nodes.get(id)!;
        expect(node.type).toBe("core.rectangle");
        expect(node.geometry).toEqual({ x: 10, y: 20, width: 100, height: 50 });
        expect(node.style.fill).toBe("#aabbcc");
        expect(dispatcher.getDocument().rootNodeUuids).toContain(id);
    });

    test("undo add removes node", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);
        const action = new AddNodeAction(doc, "core.rectangle", 10, 20, 100, 50);
        dispatcher.dispatchAction(action);
        const id = action.getCreatedNodeId()!;
        expect(dispatcher.getDocument().nodes.has(id)).toBe(true);

        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.has(id)).toBe(false);
        expect(dispatcher.getDocument().rootNodeUuids).not.toContain(id);
    });

    test("validation rejects width=0", () => {
        const doc = createEmptyDocument();
        const action = new AddNodeAction(doc, "core.rectangle", 0, 0, 0, 10);
        expect(action.validate()).toBe(false);
    });

    test("validation rejects height=0", () => {
        const doc = createEmptyDocument();
        const action = new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 0);
        expect(action.validate()).toBe(false);
    });

    test("validation rejects empty nodeType", () => {
        const doc = createEmptyDocument();
        const action = new AddNodeAction(doc, "" as any, 0, 0, 10, 10);
        expect(action.validate()).toBe(false);
    });

    test("validation rejects NaN coordinates", () => {
        const doc = createEmptyDocument();
        const action = new AddNodeAction(doc, "core.rectangle", NaN, 0, 10, 10);
        expect(action.validate()).toBe(false);
    });
});

// ─── T2: DeleteNodeAction ───
describe("DeleteNodeAction", () => {
    test("deletes a leaf node", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const action = new DeleteNodeAction(doc, "rectangle-001");
        const result = dispatcher.dispatchAction(action);

        expect(result.success).toBe(true);
        expect(action.getDeletedNodeIds()).toEqual(["rectangle-001"]);
        expect(dispatcher.getDocument().nodes.has("rectangle-001")).toBe(false);
        expect(dispatcher.getDocument().rootNodeUuids).not.toContain("rectangle-001");
    });

    test("deletes parent with cascading children", () => {
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        const action = new DeleteNodeAction(doc, "parent-001");
        const result = dispatcher.dispatchAction(action);

        expect(result.success).toBe(true);
        const deleted = action.getDeletedNodeIds();
        expect(deleted).toContain("parent-001");
        expect(deleted).toContain("child-001");
        expect(deleted).toContain("child-002");
        expect(dispatcher.getDocument().nodes.size).toBe(0);
    });

    test("undo delete restores full tree", () => {
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        const action = new DeleteNodeAction(doc, "parent-001");
        dispatcher.dispatchAction(action);
        expect(dispatcher.getDocument().nodes.size).toBe(0);

        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.size).toBe(3);
        expect(dispatcher.getDocument().nodes.has("parent-001")).toBe(true);
        expect(dispatcher.getDocument().nodes.has("child-001")).toBe(true);
        expect(dispatcher.getDocument().nodes.has("child-002")).toBe(true);
    });

    test("delete nonexistent node returns failure", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const action = new DeleteNodeAction(doc, "nonexistent");
        const result = dispatcher.dispatchAction(action);
        expect(result.success).toBe(false);
    });
});

// ─── T4: TransactionAction ───
describe("TransactionAction", () => {
    test("batches multiple moves into single undo entry", () => {
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);

        const move1 = new MoveNodeAction(doc, "child-001", 20, 20);
        const move2 = new MoveNodeAction(doc, "child-002", 80, 20);
        const tx = new TransactionAction(doc, "move-children", [move1, move2]);
        const result = dispatcher.dispatchAction(tx);

        expect(result.success).toBe(true);
        expect(dispatcher.getDocument().nodes.get("child-001")!.geometry.x).toBe(20);
        expect(dispatcher.getDocument().nodes.get("child-002")!.geometry.x).toBe(80);

        // Single undo restores both
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("child-001")!.geometry.x).toBe(10);
        expect(dispatcher.getDocument().nodes.get("child-002")!.geometry.x).toBe(70);
    });

    test("transaction with failing child rejects all", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);

        const move1 = new MoveNodeAction(doc, "rectangle-001", 50, 50);
        const move2 = new MoveNodeAction(doc, "nonexistent", 50, 50);
        const tx = new TransactionAction(doc, "mixed", [move1, move2]);
        const result = dispatcher.dispatchAction(tx);

        expect(result.success).toBe(false);
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.geometry.x).toBe(0);
    });

    test("create-then-edit compose in one atomic transaction", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);

        // The edit needs the id up front, so the Add uses an explicit id.
        const id = "tx-created-node";
        const add = new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 10, "#123456", id);
        const move = new MoveNodeAction(doc, id, 50, 60);
        const tx = new TransactionAction(doc, "create-and-move", [add, move]);
        const result = dispatcher.dispatchAction(tx);

        expect(result.success).toBe(true);
        const node = dispatcher.getDocument().nodes.get(id)!;
        expect(node).toBeDefined();
        // The move's effect is baked into the single created node.
        expect(node.geometry.x).toBe(50);
        expect(node.geometry.y).toBe(60);

        // One undo removes the whole thing (single revision).
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.has(id)).toBe(false);
    });

    test("editing a node deleted earlier in the same transaction rejects all", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);

        const del = new DeleteNodeAction(doc, "rectangle-001");
        const move = new MoveNodeAction(doc, "rectangle-001", 5, 5);
        const tx = new TransactionAction(doc, "delete-then-edit", [del, move]);
        const result = dispatcher.dispatchAction(tx);

        expect(result.success).toBe(false);
        // Nothing applied: the node still exists at its original position.
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.geometry.x).toBe(0);
    });
});

// ─── T5: UpdateNodeGeometryAction ───
describe("UpdateNodeGeometryAction", () => {
    test("updates single geometry field", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const action = new UpdateNodeGeometryAction(doc, "rectangle-001", { x: 99 });
        dispatcher.dispatchAction(action);

        const node = dispatcher.getDocument().nodes.get("rectangle-001")!;
        expect(node.geometry.x).toBe(99);
        expect(node.geometry.y).toBe(0);
        expect(node.geometry.width).toBe(200);
    });

    test("undo restores original geometry", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const action = new UpdateNodeGeometryAction(doc, "rectangle-001", { x: 99, y: 88 });
        dispatcher.dispatchAction(action);
        dispatcher.undo();

        const node = dispatcher.getDocument().nodes.get("rectangle-001")!;
        expect(node.geometry.x).toBe(0);
        expect(node.geometry.y).toBe(0);
    });

    // An explicitly-present `undefined` must be rejected: Object.assign copies the
    // key regardless of value, producing an undefined dimension that makes the node
    // vanish and the saved file unloadable.
    test("rejects an explicitly-undefined dimension", () => {
        const doc = createDocWithRectangle();
        const action = new UpdateNodeGeometryAction(doc, "rectangle-001", { width: undefined, height: 40 });
        expect(action.validate()).toBe(false);
        expect(new ActionDispatcher(doc).dispatchAction(action).success).toBe(false);
        expect(doc.nodes.get("rectangle-001")!.geometry.width).toBe(200);
    });

    test("rejects NaN values", () => {
        const doc = createDocWithRectangle();
        const action = new UpdateNodeGeometryAction(doc, "rectangle-001", { x: NaN });
        expect(action.validate()).toBe(false);
    });

    test("rejects width <= 0", () => {
        const doc = createDocWithRectangle();
        const action = new UpdateNodeGeometryAction(doc, "rectangle-001", { width: 0 });
        expect(action.validate()).toBe(false);
    });
});

// ─── T6: UpdateNodeStyleAction ───
describe("UpdateNodeStyleAction", () => {
    test("updates fill color", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const action = new UpdateNodeStyleAction(doc, "rectangle-001", { fill: "#000000" });
        dispatcher.dispatchAction(action);

        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.style.fill).toBe("#000000");
    });

    test("updates opacity", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const action = new UpdateNodeStyleAction(doc, "rectangle-001", { opacity: 0.5 });
        dispatcher.dispatchAction(action);

        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.style.opacity).toBe(0.5);
    });

    test("undo restores original style", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const action = new UpdateNodeStyleAction(doc, "rectangle-001", { fill: "#000" });
        dispatcher.dispatchAction(action);
        dispatcher.undo();

        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.style.fill).toBe("#ff0000");
    });

    test("rejects opacity out of range", () => {
        const doc = createDocWithRectangle();
        const action = new UpdateNodeStyleAction(doc, "rectangle-001", { opacity: 1.5 });
        expect(action.validate()).toBe(false);
    });

    test("rejects negative radius", () => {
        const doc = createDocWithRectangle();
        const action = new UpdateNodeStyleAction(doc, "rectangle-001", { radius: -5 });
        expect(action.validate()).toBe(false);
    });
});

// ─── T7: ResizeNodeAction ───
describe("ResizeNodeAction", () => {
    test("resizes node", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const action = new ResizeNodeAction(doc, "rectangle-001", 300, 150);
        dispatcher.dispatchAction(action);

        const node = dispatcher.getDocument().nodes.get("rectangle-001")!;
        expect(node.geometry.width).toBe(300);
        expect(node.geometry.height).toBe(150);
    });

    test("undo restores original size", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const action = new ResizeNodeAction(doc, "rectangle-001", 300, 150);
        dispatcher.dispatchAction(action);
        dispatcher.undo();

        const node = dispatcher.getDocument().nodes.get("rectangle-001")!;
        expect(node.geometry.width).toBe(200);
        expect(node.geometry.height).toBe(100);
    });

    test("rejects zero dimensions", () => {
        const doc = createDocWithRectangle();
        const action = new ResizeNodeAction(doc, "rectangle-001", 0, 100);
        expect(action.validate()).toBe(false);
    });

    test("rejects NaN dimensions", () => {
        const doc = createDocWithRectangle();
        const action = new ResizeNodeAction(doc, "rectangle-001", NaN, 100);
        expect(action.validate()).toBe(false);
    });
});

// ─── T1: ActionDispatcher onChange listeners ───
describe("ActionDispatcher onChange", () => {
    test("listener called with MutationResult on dispatch", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const calls: any[] = [];
        dispatcher.onChange((result) => calls.push(result));

        const action = new MoveNodeAction(doc, "rectangle-001", 10, 10);
        dispatcher.dispatchAction(action);

        expect(calls.length).toBe(1);
        expect(calls[0].success).toBe(true);
    });

    test("unsubscribe stops notifications", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const calls: any[] = [];
        const unsub = dispatcher.onChange((result) => calls.push(result));

        unsub();
        const action = new MoveNodeAction(doc, "rectangle-001", 10, 10);
        dispatcher.dispatchAction(action);

        expect(calls.length).toBe(0);
    });

    test("listener called on undo", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const calls: any[] = [];
        dispatcher.onChange((result) => calls.push(result));

        const action = new MoveNodeAction(doc, "rectangle-001", 10, 10);
        dispatcher.dispatchAction(action);
        dispatcher.undo();

        expect(calls.length).toBe(2);
    });

    test("multiple listeners fire in order", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const order: number[] = [];
        dispatcher.onChange(() => order.push(1));
        dispatcher.onChange(() => order.push(2));

        const action = new MoveNodeAction(doc, "rectangle-001", 10, 10);
        dispatcher.dispatchAction(action);

        expect(order).toEqual([1, 2]);
    });

    test("a throwing listener does not stop other listeners or the dispatch", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const calls: number[] = [];
        dispatcher.onChange(() => { throw new Error("boom"); });
        dispatcher.onChange(() => calls.push(2));

        const spy = jest.spyOn(console, "error").mockImplementation(() => {});
        const result = dispatcher.dispatchAction(new MoveNodeAction(doc, "rectangle-001", 5, 5));
        spy.mockRestore();

        expect(result.success).toBe(true);
        expect(calls).toEqual([2]);
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.geometry.x).toBe(5);
    });
});

// ─── M24: Multiple undo/redo sequences ───
describe("History sequences", () => {
    test("dispatch after undo clears redo stack", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);

        dispatcher.dispatchAction(new MoveNodeAction(doc, "rectangle-001", 10, 0));
        dispatcher.dispatchAction(new MoveNodeAction(doc, "rectangle-001", 20, 0));
        dispatcher.undo();
        expect(dispatcher.canRedo()).toBe(true);

        dispatcher.dispatchAction(new MoveNodeAction(dispatcher.getDocument(), "rectangle-001", 30, 0));
        expect(dispatcher.canRedo()).toBe(false);
    });

    test("redo re-applies, and a dispatch after redo truncates the redo stack", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);

        dispatcher.dispatchAction(new MoveNodeAction(doc, "rectangle-001", 10, 0));
        dispatcher.dispatchAction(new MoveNodeAction(doc, "rectangle-001", 20, 0));
        dispatcher.undo();
        dispatcher.undo();

        dispatcher.redo();
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.geometry.x).toBe(10);
        expect(dispatcher.canRedo()).toBe(true);

        dispatcher.dispatchAction(new MoveNodeAction(dispatcher.getDocument(), "rectangle-001", 99, 0));
        expect(dispatcher.canRedo()).toBe(false);
    });

    test("undo all the way to initial", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);

        dispatcher.dispatchAction(new MoveNodeAction(doc, "rectangle-001", 10, 0));
        dispatcher.dispatchAction(new MoveNodeAction(doc, "rectangle-001", 20, 0));
        dispatcher.undo();
        dispatcher.undo();

        expect(dispatcher.canUndo()).toBe(false);
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.geometry.x).toBe(0);
    });

    // Regression: an edit made after an undo must not mutate the restored
    // history snapshot in place. If hydrateDocument aliases the stored revision,
    // the x=50 edit below rewrites the initial (x=0) snapshot and the final undo
    // wrongly yields 50.
    test("edit after undo does not corrupt earlier revisions", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);

        dispatcher.dispatchAction(new MoveNodeAction(doc, "rectangle-001", 100, 0));
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.geometry.x).toBe(100);

        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.geometry.x).toBe(0);

        // Continue editing from the restored state (must target the live doc).
        dispatcher.dispatchAction(new MoveNodeAction(dispatcher.getDocument(), "rectangle-001", 50, 0));
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.geometry.x).toBe(50);

        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.geometry.x).toBe(0);
    });
});

// ─── T8: Serializer version mismatch ───
describe("Serializer edge cases", () => {
    test("throws on unknown schema version", () => {
        const bad = JSON.stringify({ version: "not-a-schema", document: { metadata: {}, nodes: {}, rootNodeUuids: [], variables: {} } });
        expect(() => deserializeDocument(bad)).toThrow("Migration not implemented");
    });

    // The legacy allow-list is a closed set, not an open semver regex: an unknown
    // semver could be a FUTURE build whose shape we know nothing about.
    test("rejects an unknown semver version instead of assuming schema 1", () => {
        const unknown = JSON.stringify({
            version: "9.9.9",
            document: { metadata: {}, nodes: {}, rootNodeUuids: [], variables: {} }
        });
        expect(() => deserializeDocument(unknown)).toThrow("Migration not implemented");
    });

    test("throws a clear error on a newer schema version", () => {
        const future = JSON.stringify({ version: "999", document: { metadata: {}, nodes: {}, rootNodeUuids: [], variables: {} } });
        expect(() => deserializeDocument(future)).toThrow("newer than this build supports");
    });

    // An app-version bump must not orphan documents saved by older builds.
    test("accepts legacy app-version-stamped documents and re-stamps the schema", () => {
        const legacy = JSON.stringify({
            version: "0.0.4",
            document: { metadata: { project_name: "Legacy" }, nodes: {}, rootNodeUuids: [], variables: {} }
        });
        const doc = deserializeDocument(legacy);
        expect(doc.version).toBe(SCHEMA_VERSION);
        expect(doc.metadata.project_name).toBe("Legacy");
    });

    test("throws on invalid JSON", () => {
        expect(() => deserializeDocument("not json")).toThrow("Invalid JSON");
    });

    test("throws on missing envelope", () => {
        expect(() => deserializeDocument(JSON.stringify({ version: "0.0.5" }))).toThrow("missing 'document'");
    });

    test("throws on missing nodes", () => {
        expect(() => deserializeDocument(JSON.stringify({ version: "0.0.5", document: { metadata: {}, rootNodeUuids: [] } }))).toThrow("missing 'nodes'");
    });

    test("throws on malformed node", () => {
        const bad = JSON.stringify({
            version: SCHEMA_VERSION,
            document: {
                metadata: {},
                nodes: { "n1": { id: "n1", type: "core.rectangle" } }, // missing geometry/style/children
                rootNodeUuids: ["n1"],
                variables: {}
            }
        });
        expect(() => deserializeDocument(bad)).toThrow("malformed");
    });

    test("throws when a node key does not match node.id", () => {
        const bad = JSON.stringify({
            version: SCHEMA_VERSION,
            document: {
                metadata: {},
                nodes: {
                    "wrong-key": {
                        id: "n1", type: "core.rectangle", children: [],
                        geometry: { x: 0, y: 0, width: 10, height: 10 },
                        style: { fill: "#000", opacity: 1 }, layout: {}
                    }
                },
                rootNodeUuids: ["n1"],
                variables: {}
            }
        });
        expect(() => deserializeDocument(bad)).toThrow("does not match");
    });
});

// ─── T10: compareDocuments with different rootNodeUuids order ───
describe("compareDocuments", () => {
    test("detects different rootNodeUuids order", () => {
        const a = createEmptyDocument();
        a.rootNodeUuids = ["a", "b"];
        const b = createEmptyDocument();
        b.rootNodeUuids = ["b", "a"];
        expect(compareDocuments(a, b)).toBe(false);
    });
});

// ─── T14: VariableStore round-trip ───
describe("Variables round-trip", () => {
    test("preserves variables (schema-19 shapes: modes, aliases, number spacing) and the active theme", () => {
        const doc = createEmptyDocument();
        doc.variables = {
            "color/primary": { type: "color", value: "#ff0000", modes: { light: "#ff0000", dark: "#cc0000" } },
            "color/accent": { type: "color", value: "$color/primary" },   // alias
            "spacing/gap": { type: "spacing", value: 8 },                  // numbers, not strings, at schema 19
            "font/body": { type: "font", value: "Inter" }
        };
        doc.activeTheme = "dark";
        const json = serializeDocument(doc);
        const loaded = deserializeDocument(json);
        expect(loaded.variables).toEqual(doc.variables);
        expect(loaded.variables["color/primary"].modes!.dark).toBe("#cc0000"); // nested mode map survives
        expect(loaded.activeTheme).toBe("dark");                               // the theme is persisted
        expect(compareDocuments(doc, loaded)).toBe(true);
    });
});

// ─── M5: variable store validation (shared by load + edit paths) ───
describe("variableStoreError / variableError", () => {
    const color = (value: unknown, modes?: unknown) => ({ type: "color", value, ...(modes !== undefined ? { modes } : {}) });

    test("accepts an empty store, typed values, aliases, and per-theme overrides", () => {
        expect(variableStoreError({})).toBeNull();
        expect(variableStoreError({
            "color/primary": color("#f00", { light: "#f00", dark: "#900" }),
            "color/accent": color("$color/primary"),          // alias (target NOT required to exist)
            "color/dangling": color("$nope"),                  // dangling alias is valid at rest
            "spacing/gap": { type: "spacing", value: 8 },
            "spacing/wide": { type: "spacing", value: "$spacing/gap" }, // alias in a spacing slot
            "font/body": { type: "font", value: "Inter" }
        })).toBeNull();
    });

    test("rejects non-object stores, bad keys, and malformed definitions", () => {
        expect(variableStoreError([])).toMatch("must be an object");
        expect(variableStoreError(null)).toMatch("must be an object");
        expect(variableStoreError({ "": color("#f00") })).toMatch("key must be non-empty");
        expect(variableStoreError({ "$x": color("#f00") })).toMatch('must not start with "$"');
        expect(variableStoreError({ ["k".repeat(201)]: color("#f00") })).toMatch("at most 200 characters");
        expect(variableStoreError({ a: null })).toMatch("must be an object");
        expect(variableStoreError({ a: { type: "gradient", value: "#f00" } })).toMatch('type must be "color", "spacing" or "font"');
        expect(variableStoreError({ a: { type: "color", value: "" } })).toMatch("non-empty string");
        expect(variableStoreError({ a: { type: "color", value: 7 } })).toMatch("non-empty string");
        expect(variableStoreError({ a: { type: "color", value: "$" } })).toMatch("bare");
        expect(variableStoreError({ a: { type: "spacing", value: "8" } })).toMatch("finite number");   // strings are schema-18 legacy
        expect(variableStoreError({ a: { type: "spacing", value: Infinity } })).toMatch("finite number");
        expect(variableStoreError({ a: color("#f00", { sepia: "#a52" }) })).toMatch('unknown theme mode "sepia"');
        expect(variableStoreError({ a: color("#f00", { dark: "" }) })).toMatch('mode "dark"');
        expect(variableStoreError({ a: color("#f00", []) })).toMatch("modes must be an object");
    });

    test("caps the entry count (OOM guard on a hand-editable map)", () => {
        const big: Record<string, unknown> = {};
        for (let i = 0; i <= VARIABLES_MAX; i++) big[`v${i}`] = { type: "spacing", value: i };
        expect(variableStoreError(big)).toMatch(`at most ${VARIABLES_MAX} entries`);
    });

    test("prototype-machinery keys are RESERVED on every path (edit can't author them — assignment fires the setter)", () => {
        // Load path: a JSON.parse'd "__proto__" IS an own property, but the validator rejects it
        // so load and edit stay symmetric.
        const viaParse = JSON.parse('{ "__proto__": { "type": "color", "value": "#000" } }');
        expect(variableStoreError(viaParse)).toMatch("reserved");
        expect(variableKeyError("__proto__")).toMatch("reserved");
        expect(variableKeyError("constructor")).toMatch("reserved");
        expect(variableKeyError("prototype")).toMatch("reserved");
        expect(variableKeyError("color/primary")).toBeNull();
        // Edit path: the action must FAIL (without the key pre-check it would silently no-op,
        // because `store["__proto__"] = def` swaps the prototype instead of adding a property).
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const r = dispatcher.dispatchAction(new SetVariableAction(dispatcher.getDocument(), "__proto__", { type: "color", value: "#000" }));
        expect(r.success).toBe(false);
        expect(dispatcher.canUndo()).toBe(false);
        // Resolution stays null-safe for inherited names even without a stored entry.
        expect(resolveVariable({}, "constructor", "light")).toBeNull();
        expect(resolveVariable({}, "__proto__", "light")).toBeNull();
        expect(resolveColor({}, "$toString", "light")).toBe(VARIABLE_FALLBACK_COLOR);
    });

    test("the 18→19 migration DROPS reserved-key entries (stays loadable, never crashes)", () => {
        const v18 = JSON.stringify({
            version: "18",
            document: {
                metadata: {}, nodes: {}, rootNodeUuids: [],
                variables: JSON.parse('{ "__proto__": { "type": "color", "value": "#000" }, "ok": { "type": "color", "value": "#fff" } }')
            }
        });
        const doc = deserializeDocument(v18);
        expect(Object.keys(doc.variables)).toEqual(["ok"]); // the reserved key was dropped
    });

    test("the 18→19 migration TRUNCATES an over-cap legacy store (the file must stay loadable)", () => {
        // The legacy store had no cap; schema 19 does. Without truncation the sanitized
        // output would fail the very validation the migration exists to satisfy.
        const vars: Record<string, unknown> = {};
        for (let i = 0; i <= VARIABLES_MAX; i++) vars[`v${i}`] = { type: "spacing", value: i }; // 10 001 entries
        const v18 = JSON.stringify({ version: "18", document: { metadata: {}, nodes: {}, rootNodeUuids: [], variables: vars } });
        const doc = deserializeDocument(v18); // must NOT throw
        expect(Object.keys(doc.variables).length).toBe(VARIABLES_MAX); // first 10 000 kept
        expect(doc.variables["v0"]).toBeDefined();
    });

    test("the node id \"__document__\" is RESERVED on both paths (it is the doc-delta sentinel)", () => {
        // Load path: rejected by Integrity.
        const bad = JSON.stringify({
            version: SCHEMA_VERSION,
            document: {
                metadata: {}, rootNodeUuids: ["__document__"], variables: {},
                nodes: { "__document__": { id: "__document__", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} } }
            }
        });
        expect(() => deserializeDocument(bad)).toThrow('node id "__document__" is reserved');
        // Edit path: AddNodeAction refuses the explicit id.
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const r = dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", 0, 0, 10, 10, "#fff", "__document__"));
        expect(r.success).toBe(false);
    });

    test("radius/fontSize accept a $token or the old number rules — arbitrary strings rejected (schema 20)", () => {
        // Numbers: the pre-20 range rules hold.
        expect(styleError({ radius: 4 })).toBeNull();
        expect(styleError({ radius: 0 })).toBeNull(); // zero is a legal (no-op) radius
        expect(styleError({ radius: -1 })).toMatch("radius");
        expect(styleError({ fontSize: 14 })).toBeNull();
        expect(styleError({ fontSize: 0 })).toMatch("fontSize");
        // Tokens: any "$key" passes validation (the RESOLVED value is range-checked at render).
        expect(styleError({ radius: "$radius/medium" })).toBeNull();
        expect(styleError({ fontSize: "$type/body" })).toBeNull();
        // Arbitrary non-token strings are rejected — they could never resolve.
        expect(styleError({ radius: "big" })).toMatch("radius");
        expect(styleError({ fontSize: "" })).toMatch("fontSize");
        expect(styleError({ radius: "$" })).toMatch("radius"); // a bare "$" is not a token
        // The load path applies the same rule (shared styleError) and round-trips a token radius.
        const doc = createEmptyDocument();
        doc.nodes.set("n", { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1, radius: "$radius/medium", fontSize: "$type/body" }, layout: {} });
        doc.rootNodeUuids = ["n"];
        const loaded = deserializeDocument(serializeDocument(doc));
        expect(loaded.nodes.get("n")!.style.radius).toBe("$radius/medium");
        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1, radius: "big" }, layout: {} } } } });
        expect(() => deserializeDocument(bad)).toThrow("radius");
    });

    test("stroke corners and ends are a closed vocabulary on BOTH paths (schema 37)", () => {
        // The join and cap names reach `stroke-linejoin`/`stroke-linecap` and Canvas's
        // `lineJoin`/`lineCap` verbatim, so an unknown one is not a harmless string: it is an
        // attribute the browser ignores, silently drawing a different picture from the one the
        // document describes. Both the edit path and the load path go through this one check.
        expect(styleError({ strokeJoin: "round" })).toBeNull();
        expect(styleError({ strokeCap: "square" })).toBeNull();
        // Cast: TypeScript already refuses these, which is why the RUNTIME check exists —
        // it guards a hand-edited file, where no type ever ran.
        expect(styleError({ strokeJoin: "rounded" as never })).toMatch("strokeJoin");
        expect(styleError({ strokeCap: "flat" as never })).toMatch("strokeCap");
        // The miter limit is SVG's ratio of miter length to stroke width. Below 1 it would ask
        // for a miter shorter than the stroke is wide, which no join can be.
        expect(styleError({ strokeMiterLimit: 1 })).toBeNull();
        expect(styleError({ strokeMiterLimit: 10 })).toBeNull();
        expect(styleError({ strokeMiterLimit: 0.5 })).toMatch("strokeMiterLimit");
        expect(styleError({ strokeMiterLimit: Infinity })).toMatch("strokeMiterLimit");
        // Absent stays absent — the defaults are what all three backends already drew.
        expect(styleError({})).toBeNull();

        // EDIT path: the dispatcher refuses the same values.
        const doc = createEmptyDocument();
        doc.nodes.set("n", { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["n"];
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new UpdateNodeStyleAction(dispatcher.getDocument(), "n", { strokeJoin: "round" })).success).toBe(true);
        expect(dispatcher.dispatchAction(new UpdateNodeStyleAction(dispatcher.getDocument(), "n", { strokeJoin: "rounded" as never })).success).toBe(false);

        // LOAD path: the same rule, and a valid document round-trips its corners unchanged.
        const loaded = deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(loaded.nodes.get("n")!.style.strokeJoin).toBe("round");
        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1, strokeCap: "flat" }, layout: {} } } } });
        expect(() => deserializeDocument(bad)).toThrow("strokeCap");
    });

    test("a schema-36 document migrates to 37 and draws identically", () => {
        // Purely additive: the absent values ARE the old behaviour, so the migration adds nothing
        // but the stamp. The bump exists so an OLD build refuses a document whose corners it
        // would silently draw mitred.
        const v36 = { version: "36", document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1, stroke: "#f00", strokeWidth: 2 }, layout: {} } } } };
        const loaded = deserializeDocument(JSON.stringify(v36));
        const node = loaded.nodes.get("n")!;
        expect(node.style.strokeJoin).toBeUndefined();
        expect(node.style.strokeCap).toBeUndefined();
        expect(node.style.strokeMiterLimit).toBeUndefined();
        expect(node.style.strokeWidth).toBe(2);
        expect(JSON.parse(serializeDocument(loaded)).version).toBe(SCHEMA_VERSION);
    });

    test("a mixed transaction's updatedNodeIds lists the NODE, never the \"__document__\" sentinel", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("n", { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["n"];
        const dispatcher = new ActionDispatcher(doc);
        const d = dispatcher.getDocument();
        const r = dispatcher.dispatchAction(new TransactionAction(d, "mixed", [
            new SetVariableAction(d, "color/x", { type: "color", value: "#fff" }),
            new UpdateNodeStyleAction(d, "n", { fill: "$color/x" })
        ]));
        expect(r.success).toBe(true);
        expect([...r.updatedNodeIds]).toEqual(["n"]); // the sentinel must not seed the geometry dirty-set
        expect(r.propertyDeltas.has("__document__")).toBe(true); // …but the doc delta itself is present
    });
});

// ─── M5: token resolution (pure, never throws) ───
describe("resolveVariable / resolveColor / resolveNumber", () => {
    const store: VariableStore = {
        "color/primary": { type: "color", value: "#ff0000", modes: { dark: "#990000" } },
        "color/accent": { type: "color", value: "$color/primary" },              // one-hop alias
        "color/brand": { type: "color", value: "$color/accent" },                // two-hop chain
        "color/loop-a": { type: "color", value: "$color/loop-b" },               // cycle
        "color/loop-b": { type: "color", value: "$color/loop-a" },
        "color/dangling": { type: "color", value: "$color/nope" },
        "color/theme-alias": { type: "color", value: "#000000", modes: { dark: "$color/primary" } }, // override IS an alias
        "spacing/gap": { type: "spacing", value: 8, modes: { dark: 12 } },
        "color/to-number": { type: "color", value: "$spacing/gap" }              // wrong-type alias
    };

    test("resolves concrete values, per-theme overrides, and base fallback", () => {
        expect(resolveVariable(store, "color/primary", "light")).toBe("#ff0000");
        expect(resolveVariable(store, "color/primary", "dark")).toBe("#990000");  // override wins
        expect(resolveVariable(store, "spacing/gap", "light")).toBe(8);           // no light override → base
        expect(resolveVariable(store, "missing", "light")).toBeNull();
    });

    test("follows alias chains — through the ACTIVE theme at every hop", () => {
        expect(resolveVariable(store, "color/accent", "light")).toBe("#ff0000");
        expect(resolveVariable(store, "color/brand", "dark")).toBe("#990000");    // 2 hops, dark override at the end
        expect(resolveVariable(store, "color/theme-alias", "dark")).toBe("#990000"); // the OVERRIDE is the alias
        expect(resolveVariable(store, "color/theme-alias", "light")).toBe("#000000");
    });

    test("a cycle or dangling target resolves to null, never throws or hangs", () => {
        expect(resolveVariable(store, "color/loop-a", "light")).toBeNull();
        expect(resolveVariable(store, "color/dangling", "light")).toBeNull();
    });

    test("resolveColor: pass-through for non-tokens, fallback magenta for broken/wrong-type tokens", () => {
        expect(resolveColor(store, "#123456", "light")).toBe("#123456");          // not a token → untouched
        expect(resolveColor(store, "$color/primary", "dark")).toBe("#990000");
        expect(resolveColor(store, "$color/loop-a", "light")).toBe(VARIABLE_FALLBACK_COLOR);
        expect(resolveColor(store, "$missing", "light")).toBe(VARIABLE_FALLBACK_COLOR);
        expect(resolveColor(store, "$color/to-number", "light")).toBe(VARIABLE_FALLBACK_COLOR); // number in a color slot
        expect(resolveColor({}, "$anything", "light")).toBe(VARIABLE_FALLBACK_COLOR);
    });

    test("resolveNumber: numbers pass through, tokens must land on a number", () => {
        expect(resolveNumber(store, 5, "light")).toBe(5);
        expect(resolveNumber(store, "$spacing/gap", "dark")).toBe(12);
        expect(resolveNumber(store, "$color/primary", "light")).toBeNull();       // string in a number slot
        expect(resolveNumber(store, "not-a-token", "light")).toBeNull();
        expect(resolveNumber(store, Infinity, "light")).toBeNull();
    });
});

// ─── M5: schema 18 → 19 migration (the first migration with CONTENT) ───
describe("Schema 19 migration (design tokens)", () => {
    test("an 18 file gets activeTheme stamped, string-spacing coerced, junk dropped", () => {
        const v18 = JSON.stringify({
            version: "18",
            document: {
                metadata: {}, nodes: {}, rootNodeUuids: [],
                variables: {
                    primary: { type: "color", value: "#ff0000", modes: { light: "#ff0000", dark: "#cc0000" } },
                    gap: { type: "spacing", value: "8", modes: { dark: "12" } }, // legacy string spacing → coerced
                    junk: { type: "gradient", value: "#f00" },                    // unknown type → dropped
                    broken: "not-an-object",                                      // malformed → dropped
                    "$bad": { type: "color", value: "#fff" }                      // unkeyable → dropped
                }
            }
        });
        const doc = deserializeDocument(v18);
        expect(doc.version).toBe(SCHEMA_VERSION);
        expect(doc.activeTheme).toBe("light");                                    // stamped
        expect(doc.variables.primary.value).toBe("#ff0000");                      // valid entry kept as-is
        expect(doc.variables.gap).toEqual({ type: "spacing", value: 8, modes: { dark: 12 } }); // coerced to numbers
        expect(doc.variables.junk).toBeUndefined();
        expect(doc.variables.broken).toBeUndefined();
        expect(doc.variables["$bad"]).toBeUndefined();
        expect(() => deserializeDocument(serializeDocument(doc))).not.toThrow();  // round-trips at 19
    });

    test("activeTheme survives the history snapshot/hydrate cycle (undo/redo)", () => {
        const doc = createEmptyDocument();
        doc.activeTheme = "dark";
        doc.variables = { "color/primary": { type: "color", value: "#f00" } };
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", 0, 0, 10, 10, "#fff", "n1"));
        dispatcher.undo(); // hydrates the INITIAL snapshot — the theme + variables must come back
        expect(dispatcher.getDocument().activeTheme).toBe("dark");
        expect(dispatcher.getDocument().variables["color/primary"].value).toBe("#f00");
        dispatcher.redo();
        expect(dispatcher.getDocument().activeTheme).toBe("dark");
    });

    test("the load path REJECTS a malformed store and a bad theme at the current schema", () => {
        const env = (vars: string, theme = '"light"') =>
            `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "nodes": {}, "rootNodeUuids": [], "variables": ${vars}, "activeTheme": ${theme} } }`;
        expect(() => deserializeDocument(env('{ "a": { "type": "spacing", "value": "8" } }'))).toThrow("finite number");
        expect(() => deserializeDocument(env('{ "a": { "type": "color", "value": "#f00", "modes": { "sepia": "#a52" } } }'))).toThrow("unknown theme mode");
        expect(() => deserializeDocument(env("{}", '"banana"'))).toThrow("activeTheme must be one of light/dark");
        expect(() => deserializeDocument(env("{}", "42"))).toThrow("activeTheme must be one of light/dark");
        // A valid store + theme loads.
        expect(() => deserializeDocument(env('{ "a": { "type": "color", "value": "$b" } }', '"dark"'))).not.toThrow();
    });
});

// ─── M5: variable actions (the doc-level write path) ───
describe("Variable actions", () => {
    const primary: Variable = { type: "color", value: "#ff0000", modes: { dark: "#990000" } };

    test("SetVariableAction upserts (create then replace), is undoable, and touches no node", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("n", { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["n"];
        const dispatcher = new ActionDispatcher(doc);
        const r1 = dispatcher.dispatchAction(new SetVariableAction(dispatcher.getDocument(), "color/primary", primary));
        expect(r1.success).toBe(true);
        expect(r1.updatedNodeIds.size).toBe(0); // no node changed — the geometry dirty-set stays clean
        expect(dispatcher.getDocument().variables["color/primary"].value).toBe("#ff0000");
        dispatcher.dispatchAction(new SetVariableAction(dispatcher.getDocument(), "color/primary", { type: "color", value: "#00ff00" }));
        expect(dispatcher.getDocument().variables["color/primary"].value).toBe("#00ff00"); // replaced
        dispatcher.undo();
        expect(dispatcher.getDocument().variables["color/primary"].value).toBe("#ff0000"); // back to v1
        dispatcher.undo();
        expect(dispatcher.getDocument().variables["color/primary"]).toBeUndefined();       // back to empty
        expect(dispatcher.getDocument().nodes.get("n")!.style.fill).toBe("#000");          // node untouched throughout
    });

    test("SetVariableAction rejects what the LOAD path rejects (shared validator)", () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const doc = dispatcher.getDocument();
        expect(dispatcher.dispatchAction(new SetVariableAction(doc, "$bad", primary)).success).toBe(false);       // "$" key
        expect(dispatcher.dispatchAction(new SetVariableAction(doc, "", primary)).success).toBe(false);            // empty key
        expect(dispatcher.dispatchAction(new SetVariableAction(doc, "a", { type: "spacing", value: "8" as unknown as number })).success).toBe(false); // string spacing
        expect(dispatcher.dispatchAction(new SetVariableAction(doc, "a", { type: "color", value: "" })).success).toBe(false);
        expect(dispatcher.canUndo()).toBe(false); // nothing committed
    });

    test("DeleteVariableAction removes; a dangling alias stays LOADABLE and resolves to the fallback", () => {
        const doc = createEmptyDocument();
        doc.variables = {
            "color/base": { type: "color", value: "#123456" },
            "color/alias": { type: "color", value: "$color/base" }
        };
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new DeleteVariableAction(dispatcher.getDocument(), "color/base")).success).toBe(true);
        const after = dispatcher.getDocument();
        expect(after.variables["color/base"]).toBeUndefined();
        // The alias now dangles: still valid at rest (round-trips), resolves to the fallback.
        expect(() => deserializeDocument(serializeDocument(after))).not.toThrow();
        expect(resolveColor(after.variables as VariableStore, "$color/alias", "light")).toBe(VARIABLE_FALLBACK_COLOR);
        dispatcher.undo();
        expect(resolveColor(dispatcher.getDocument().variables as VariableStore, "$color/alias", "light")).toBe("#123456");
        // Deleting a missing key fails cleanly.
        expect(dispatcher.dispatchAction(new DeleteVariableAction(dispatcher.getDocument(), "nope")).success).toBe(false);
    });

    test("SetActiveThemeAction switches the persisted theme, undoably; rejects junk", () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        expect(dispatcher.getDocument().activeTheme).toBe("light");
        expect(dispatcher.dispatchAction(new SetActiveThemeAction(dispatcher.getDocument(), "dark")).success).toBe(true);
        expect(dispatcher.getDocument().activeTheme).toBe("dark");
        // Persisted: the serialized envelope carries it.
        expect(deserializeDocument(serializeDocument(dispatcher.getDocument())).activeTheme).toBe("dark");
        dispatcher.undo();
        expect(dispatcher.getDocument().activeTheme).toBe("light");
        expect(dispatcher.dispatchAction(new SetActiveThemeAction(dispatcher.getDocument(), "sepia" as unknown as "light")).success).toBe(false);
    });

    test("a TRANSACTION composes variable edits: later actions see earlier ones; one undo restores all", () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const doc = dispatcher.getDocument();
        // set a, set b, switch theme — the theme action's delta must CARRY a and b (it reads
        // the working doc), and the last-wins document delta must lose nothing.
        const r = dispatcher.dispatchAction(new TransactionAction(doc, "tokens", [
            new SetVariableAction(doc, "color/a", { type: "color", value: "#aaa111" }),
            new SetVariableAction(doc, "color/b", { type: "color", value: "$color/a" }),
            new SetActiveThemeAction(doc, "dark")
        ]));
        expect(r.success).toBe(true);
        const after = dispatcher.getDocument();
        expect(after.variables["color/a"].value).toBe("#aaa111");
        expect(after.variables["color/b"].value).toBe("$color/a");
        expect(after.activeTheme).toBe("dark");
        dispatcher.undo(); // ONE undo restores store AND theme
        expect(dispatcher.getDocument().variables["color/a"]).toBeUndefined();
        expect(dispatcher.getDocument().activeTheme).toBe("light");
    });

    test("a transaction set-then-delete nets to absent; a failing step rejects the whole batch", () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const doc = dispatcher.getDocument();
        dispatcher.dispatchAction(new TransactionAction(doc, "net", [
            new SetVariableAction(doc, "color/tmp", { type: "color", value: "#fff" }),
            new DeleteVariableAction(doc, "color/tmp")
        ]));
        expect(dispatcher.getDocument().variables["color/tmp"]).toBeUndefined(); // net absent
        // Atomicity: a bad step (deleting a missing key) rejects the earlier valid step too.
        const r = dispatcher.dispatchAction(new TransactionAction(dispatcher.getDocument(), "atomic", [
            new SetVariableAction(dispatcher.getDocument(), "color/kept", { type: "color", value: "#fff" }),
            new DeleteVariableAction(dispatcher.getDocument(), "never-existed")
        ]));
        expect(r.success).toBe(false);
        expect(dispatcher.getDocument().variables["color/kept"]).toBeUndefined(); // rolled back with the batch
    });

    test("variable edits and NODE edits mix in one transaction (the doc delta rides alongside patches)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("n", { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["n"];
        const dispatcher = new ActionDispatcher(doc);
        const d = dispatcher.getDocument();
        dispatcher.dispatchAction(new TransactionAction(d, "mixed", [
            new SetVariableAction(d, "color/primary", primary),
            new UpdateNodeStyleAction(d, "n", { fill: "$color/primary" }) // the node now REFERENCES the token
        ]));
        const after = dispatcher.getDocument();
        expect(after.nodes.get("n")!.style.fill).toBe("$color/primary");
        expect(after.variables["color/primary"].value).toBe("#ff0000");
        expect(resolveColor(after.variables as VariableStore, after.nodes.get("n")!.style.fill, "dark")).toBe("#990000");
        dispatcher.undo(); // one undo reverts BOTH the style patch and the store
        expect(dispatcher.getDocument().nodes.get("n")!.style.fill).toBe("#000");
        expect(dispatcher.getDocument().variables["color/primary"]).toBeUndefined();
    });
});

// ─── M1 seam: computed world geometry, previews-as-input, hit-testing ───
describe("GeometryEngine", () => {
    test("stored geometry is parent-relative; world position composes down the tree", () => {
        const doc = createDocWithParentChild(); // parent at (0,0), children at (10,10)/(70,10)
        doc.nodes.get("parent-001")!.geometry.x = 100;
        doc.nodes.get("parent-001")!.geometry.y = 200;

        const { nodes: rects } = computeGeometry(doc);
        expect(rects.get("parent-001")!.bounds).toMatchObject({ x: 100, y: 200 });
        // Child stores (10,10) relative to its parent -> world (110, 210).
        expect(rects.get("child-001")!.bounds).toMatchObject({ x: 110, y: 210, width: 50, height: 50 });
        expect(rects.get("child-002")!.bounds).toMatchObject({ x: 170, y: 210 });
    });

    test("pending patches are an INPUT to composition, and propagate to children", () => {
        const doc = createDocWithParentChild();
        const pending = new Map([["parent-001", { x: 50, y: 5 }]]);

        const { nodes: rects } = computeGeometry(doc, pending);
        expect(rects.get("parent-001")!.bounds).toMatchObject({ x: 50, y: 5 });
        // Dragging the parent moves the child too — impossible with a render-time override.
        expect(rects.get("child-001")!.bounds).toMatchObject({ x: 60, y: 15 });
    });

    test("draw order follows the scene graph", () => {
        expect(computeGeometry(createDocWithParentChild()).order)
            .toEqual(["parent-001", "child-001", "child-002"]);
    });

    test("hitTest returns the topmost node and null on empty space", () => {
        const doc = createDocWithParentChild();
        const computed = computeGeometry(doc);
        // (20,20) is inside parent AND child-001; the child draws later, so it wins.
        expect(hitTest(computed, 20, 20)).toBe("child-001");
        expect(hitTest(computed, 350, 250)).toBe("parent-001"); // parent only
        expect(hitTest(computed, 5000, 5000)).toBeNull();
    });
});

// ─── hitTest pick tolerance — makes thin/zero-extent targets selectable ───
describe("hitTest pick tolerance", () => {
    // A horizontal line: box collapses to zero height at world y = 100.
    function lineDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("L", { id: "L", type: "core.line", parent: null, children: [], geometry: { x: 0, y: 100, width: 200, height: 0 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["L"];
        return doc;
    }

    test("a zero-extent (horizontal) line is UNSELECTABLE without tolerance", () => {
        const cs = computeGeometry(lineDoc());
        expect(hitTest(cs, 100, 102)).toBeNull();  // 2 units off the hairline → miss
        expect(hitTest(cs, 100, 100)).toBe("L");   // exactly on it still hits (default tol 0)
    });

    test("a small tolerance makes the hairline pickable near it, not far or past its ends", () => {
        const cs = computeGeometry(lineDoc());
        expect(hitTest(cs, 100, 102, 4)).toBe("L");  // within 4 units of the line
        expect(hitTest(cs, 100, 96, 4)).toBe("L");   // the other side, within tol
        expect(hitTest(cs, 100, 110, 4)).toBeNull(); // 10 units off → beyond tol
        expect(hitTest(cs, 250, 100, 4)).toBeNull(); // past the x end (> 200 + tol)
    });

    test("tolerance defaults to 0 and only widens (a rect's hit region is unchanged without it)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("R", { id: "R", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["R"];
        const cs = computeGeometry(doc);
        expect(hitTest(cs, 25, 25)).toBe("R");    // inside
        expect(hitTest(cs, 55, 25)).toBeNull();   // 5 units outside, no tolerance → miss
        expect(hitTest(cs, 55, 25, 8)).toBe("R"); // ...but inside an 8-unit halo → hit
    });
});

// ─── M4: marquee (box) selection — the pure geometry query ───
describe("nodesInRect (box select)", () => {
    // Three 50×50 rects: A at origin, B to the right (x 100), C below (y 100).
    function boxDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mk("A", 0, 0); mk("B", 100, 0); mk("C", 0, 100);
        doc.rootNodeUuids = ["A", "B", "C"];
        return doc;
    }

    test("selects only nodes whose bounds overlap the marquee, in draw order", () => {
        const cs = computeGeometry(boxDoc());
        expect(nodesInRect(cs, { x: -10, y: -10, width: 70, height: 70 })).toEqual(["A"]);
        expect(nodesInRect(cs, { x: -10, y: -10, width: 300, height: 300 })).toEqual(["A", "B", "C"]);
        expect(nodesInRect(cs, { x: 500, y: 500, width: 10, height: 10 })).toEqual([]);
        // A band along y∈[100,150] reaches C (below) but not A/B (both entirely above it):
        // isolates the "node-bottom ≥ marquee-top" term.
        expect(nodesInRect(cs, { x: -10, y: 100, width: 300, height: 50 })).toEqual(["C"]);
    });

    test("touch semantics: a marquee fully INSIDE a node still selects it (overlap, not containment)", () => {
        const cs = computeGeometry(boxDoc());
        expect(nodesInRect(cs, { x: 10, y: 10, width: 5, height: 5 })).toEqual(["A"]);
    });

    test("edges are inclusive: a marquee flush against a node's edge selects it, and stops there", () => {
        const cs = computeGeometry(boxDoc());
        // x∈[60,100] reaches B's left edge (x=100) exactly and does NOT reach A (right edge x=50).
        expect(nodesInRect(cs, { x: 60, y: 0, width: 40, height: 10 })).toEqual(["B"]);
    });

    test("non-finite bounds are skipped, never thrown", () => {
        const ok: ComputedNode = { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: 0, y: 0, width: 10, height: 10 }, shape: BOX };
        const bad: ComputedNode = { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: NaN, y: 0, width: 10, height: 10 }, shape: BOX };
        const cs: ComputedState = { order: ["bad", "ok"], nodes: new Map([["bad", bad], ["ok", ok]]), locked: new Set<string>() };
        expect(nodesInRect(cs, { x: -100, y: -100, width: 1000, height: 1000 })).toEqual(["ok"]);
    });
});

// ─── M4: SelectTool marquee gesture (drag empty space to box-select) ───
describe("SelectTool marquee", () => {
    const rect = { left: 0, top: 0 } as DOMRect;
    // `buttons` defaults to 1 (left held) — the marquee abandons on a move with no button held.
    const md = (x: number, y: number, shift = false, buttons = 1) =>
        ({ clientX: x, clientY: y, button: 0, buttons, shiftKey: shift, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
    const key = (k: string) => ({ key: k } as unknown as KeyboardEvent);

    function harness() {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mk("A", 0); mk("B", 100);
        doc.rootNodeUuids = ["A", "B"];
        const es = createEditorState();
        const tool = new SelectTool(new ActionDispatcher(doc), es, () => { });
        return { es, tool };
    }

    test("a click on a node selects it (pick resolves in world space, no marquee)", () => {
        const { es, tool } = harness();
        tool.onMouseDown(md(10, 10), rect); // inside A (x 0..50)
        tool.onMouseUp(md(10, 10));
        expect(es.selectedNodeIds).toEqual(["A"]);
        expect(es.marqueeRect).toBeNull();
    });

    test("a drag on empty space selects the nodes in the box and clears the marquee", () => {
        const { es, tool } = harness();
        tool.onMouseDown(md(-5, -5), rect);
        tool.onMouseMove(md(60, 40), rect);
        expect(es.marqueeRect).toMatchObject({ x: -5, y: -5, width: 65, height: 45 }); // shown mid-drag
        tool.onMouseUp(md(60, 40));
        expect(es.selectedNodeIds).toEqual(["A"]); // B starts at x=100, outside the box
        expect(es.marqueeRect).toBeNull();          // cleared on release
    });

    test("a plain click (no move fired) on empty space deselects", () => {
        const { es, tool } = harness();
        es.selectedNodeIds = ["A"];
        tool.onMouseDown(md(300, 300), rect);
        tool.onMouseUp(md(300, 300)); // no onMouseMove → no marquee rect → treated as a click
        expect(es.selectedNodeIds).toEqual([]);
    });

    test("shift + marquee adds to the existing selection instead of replacing it", () => {
        const { es, tool } = harness();
        es.selectedNodeIds = ["B"];
        tool.onMouseDown(md(-5, -5, true), rect);
        tool.onMouseMove(md(60, 40, true), rect);
        tool.onMouseUp(md(60, 40, true));
        expect(es.selectedNodeIds).toEqual(["B", "A"]); // B kept, A added
    });

    test("maps SCREEN pixels to WORLD under a non-identity zoom AND pan", () => {
        const { es, tool } = harness();
        es.viewport = { x: 100, y: 50, zoom: 2 };
        const r = { left: 40, top: 20 } as DOMRect;
        // world = (clientX − left + vp.x) / zoom. Drag client (−60,−40) → (20,80):
        // start world (0,−5), end (40,55) — pins every term (drop /zoom, wrong vp sign, or drop left → wrong rect).
        tool.onMouseDown(md(-60, -40), r);
        tool.onMouseMove(md(20, 80), r);
        expect(es.marqueeRect).toMatchObject({ x: 0, y: -5, width: 40, height: 60 });
        tool.onMouseUp(md(20, 80));
        expect(es.selectedNodeIds).toEqual(["A"]); // world box [0,40]×[−5,55] overlaps A, not B
    });

    test("shift-click on empty space with no drag keeps the selection", () => {
        const { es, tool } = harness();
        es.selectedNodeIds = ["B"];
        tool.onMouseDown(md(300, 300, true), rect);
        tool.onMouseUp(md(300, 300, true)); // no move; shift held → keep, do not deselect
        expect(es.selectedNodeIds).toEqual(["B"]);
    });

    test("a reverse-direction (up-left) drag normalizes to the same rect and hits", () => {
        const { es, tool } = harness();
        tool.onMouseDown(md(60, 40), rect);
        tool.onMouseMove(md(-5, -5), rect);
        expect(es.marqueeRect).toMatchObject({ x: -5, y: -5, width: 65, height: 45 }); // Math.min/abs normalize
        tool.onMouseUp(md(-5, -5));
        expect(es.selectedNodeIds).toEqual(["A"]);
    });

    test("a press just outside a node edge (within the pick halo) selects it, no marquee", () => {
        const { es, tool } = harness();
        tool.onMouseDown(md(52, 25), rect); // 2px past A's right edge (x=50), inside the 4px halo
        tool.onMouseUp(md(52, 25));
        expect(es.selectedNodeIds).toEqual(["A"]);
        expect(es.marqueeRect).toBeNull(); // pick won → no marquee started
    });

    test("shift-marquee re-covering an already-selected node does not duplicate it", () => {
        const { es, tool } = harness();
        es.selectedNodeIds = ["A"];
        tool.onMouseDown(md(-10, -10, true), rect);
        tool.onMouseMove(md(160, 60, true), rect); // box covers A AND B
        tool.onMouseUp(md(160, 60, true));
        expect(es.selectedNodeIds).toEqual(["A", "B"]); // A kept once (Set dedup), B added
    });

    test("a non-additive marquee replaces the prior selection", () => {
        const { es, tool } = harness();
        es.selectedNodeIds = ["B"];
        tool.onMouseDown(md(-5, -5), rect);
        tool.onMouseMove(md(60, 40), rect); // box over A only
        tool.onMouseUp(md(60, 40));
        expect(es.selectedNodeIds).toEqual(["A"]); // B replaced, not unioned
    });

    test("a click in a rotated node's AABB-corner margin deselects (threshold guards the pick/AABB gap)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("r", { id: "r", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 100, height: 20 }, style: { fill: "#000", opacity: 1 }, layout: {}, transform: { rotation: Math.PI / 4 } });
        doc.rootNodeUuids = ["r"];
        const es = createEditorState();
        es.selectedNodeIds = ["r"];
        const tool = new SelectTool(new ActionDispatcher(doc), es, () => { });
        const b = computeGeometry(doc).nodes.get("r")!.bounds;
        // The AABB corner sits ~10px from the rotated bar — outside the 4px halo, so pick misses and
        // a marquee begins; a 1px wobble must NOT let the AABB overlap re-select it (that is the bug
        // the threshold prevents). pick uses the exact shape; nodesInRect uses the (larger) AABB.
        tool.onMouseDown(md(b.x, b.y), rect);
        tool.onMouseMove(md(b.x + 1, b.y + 1), rect);
        tool.onMouseUp(md(b.x + 1, b.y + 1));       // 1px < threshold → a click, not a marquee
        expect(es.selectedNodeIds).toEqual([]);      // deselected, not re-selected via the AABB touch
    });

    test("Escape cancels an in-flight marquee without changing the selection", () => {
        const { es, tool } = harness();
        es.selectedNodeIds = ["B"];
        tool.onMouseDown(md(-5, -5), rect);
        tool.onMouseMove(md(60, 40), rect);
        expect(es.marqueeRect).not.toBeNull();
        tool.onKeyDown(key("Escape"));
        expect(es.marqueeRect).toBeNull();          // overlay cleared
        tool.onMouseUp(md(60, 40));                 // the release no longer commits a selection
        expect(es.selectedNodeIds).toEqual(["B"]);  // selection untouched
    });

    test("a marquee stranded by a missed mouse-up does not hijack the next click", () => {
        const { es, tool } = harness();
        tool.onMouseDown(md(-5, -5), rect);
        tool.onMouseMove(md(60, 40), rect); // marquee active + rect set; NO mouse-up is delivered
        tool.onMouseDown(md(120, 10), rect); // now click node B — must start from a clean slate
        tool.onMouseUp(md(120, 10));
        expect(es.selectedNodeIds).toEqual(["B"]); // B, not the stale box's contents (A)
        expect(es.marqueeRect).toBeNull();
    });

    test("a move with no button held abandons the marquee (dropped mouse-up)", () => {
        const { es, tool } = harness();
        tool.onMouseDown(md(-5, -5), rect);
        tool.onMouseMove(md(60, 40), rect);        // buttons:1 → tracks
        expect(es.marqueeRect).not.toBeNull();
        tool.onMouseMove(md(70, 50, false, 0), rect); // buttons:0 → the drag is over
        expect(es.marqueeRect).toBeNull();
    });
});

// ─── M4: DOM-free selection handles (shared draw/pick geometry) ───
describe("selectionHandles + handleAtPoint", () => {
    function handleDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mk("A", 0, 0); mk("B", 50, 50); // B's nw corner coincides with A's se corner
        doc.rootNodeUuids = ["A", "B"];
        return doc;
    }

    test("a selected node yields its four AABB-corner handles plus a rotate knob", () => {
        const cs = computeGeometry(handleDoc());
        const hs = selectionHandles(cs, ["A"], 1);
        expect(hs.map(h => h.handle)).toEqual(["nw", "ne", "sw", "se", "rotate"]);
        expect(hs.slice(0, 4).map(h => [h.cx, h.cy])).toEqual([[0, 0], [50, 0], [0, 50], [50, 50]]);
        expect(hs[4]).toMatchObject({ handle: "rotate", cx: 25, cy: -ROTATE_OFFSET_PX, cursor: "grab" }); // top-centre, offset up
        expect(hs.find(h => h.handle === "ne")!.cursor).toBe("nesw-resize");
        expect(hs.find(h => h.handle === "se")!.cursor).toBe("nwse-resize");
        expect(selectionHandles(cs, [], 1)).toEqual([]); // nothing selected → no handles
        expect(selectionHandles(cs, ["A", "B"], 1).length).toBe(10); // 5 per node
    });

    test("the rotate knob sits a fixed SCREEN distance above the box (its world offset scales with zoom)", () => {
        const cs = computeGeometry(handleDoc());
        expect(selectionHandles(cs, ["A"], 1)[4].cy).toBe(-ROTATE_OFFSET_PX);
        expect(selectionHandles(cs, ["A"], 2)[4].cy).toBe(-ROTATE_OFFSET_PX / 2); // half the world offset at 2× zoom
    });

    test("selectionHandles skips a node with non-finite bounds, never throws", () => {
        const ok: ComputedNode = { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: 0, y: 0, width: 10, height: 10 }, shape: BOX };
        const bad: ComputedNode = { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: NaN, y: 0, width: 10, height: 10 }, shape: BOX };
        const cs: ComputedState = { order: ["bad", "ok"], nodes: new Map([["bad", bad], ["ok", ok]]), locked: new Set<string>() };
        expect(selectionHandles(cs, ["bad", "ok"], 1).map(h => h.nodeId)).toEqual(["ok", "ok", "ok", "ok", "ok"]); // 5 for ok, none for bad
    });

    test("handleAtPoint returns the handle under a point, null between them, and scales with zoom", () => {
        const cs = computeGeometry(handleDoc());
        // zoom 1 → grab half = HANDLE_SIZE_PX/2 = 4
        expect(handleAtPoint(cs, ["A"], 0, 0, 1)!.handle).toBe("nw");
        expect(handleAtPoint(cs, ["A"], 50, 0, 1)!.handle).toBe("ne");
        expect(handleAtPoint(cs, ["A"], 25, 25, 1)).toBeNull();   // node centre — no corner near
        // Each point is out of nw's square by ONE bound only (isolates all four comparisons):
        expect(handleAtPoint(cs, ["A"], 5, 0, 1)).toBeNull();     // +x past the right edge
        expect(handleAtPoint(cs, ["A"], -5, 0, 1)).toBeNull();    // −x past the left edge
        expect(handleAtPoint(cs, ["A"], 0, 5, 1)).toBeNull();     // +y past the bottom edge
        expect(handleAtPoint(cs, ["A"], 0, -5, 1)).toBeNull();    // −y past the top edge
        expect(handleAtPoint(cs, ["A"], 3, 0, 1)!.handle).toBe("nw"); // 3 < half → hit
        expect(handleAtPoint(cs, ["A"], 5, 0, 0.5)!.handle).toBe("nw"); // zoom 0.5 → half 8 → grabbable further
        expect(handleAtPoint(cs, ["A"], 25, -ROTATE_OFFSET_PX, 1)!.handle).toBe("rotate"); // the rotate knob
        expect(handleAtPoint(cs, ["A"], 50, 50, 1)!.handle).toBe("se"); // A only
    });

    test("handleAtPoint lets a later-drawn handle win an overlap (scan is back to front)", () => {
        const cs = computeGeometry(handleDoc());
        // At (50,50): A's se and B's nw coincide; B is selected after A, so B wins.
        const hit = handleAtPoint(cs, ["A", "B"], 50, 50, 1)!;
        expect([hit.nodeId, hit.handle]).toEqual(["B", "nw"]);
    });

    test("groupRotateHandle: one knob above the UNION box's top-centre; groupHandleAtPoint hits only it", () => {
        const cs = computeGeometry(handleDoc()); // A{0,0,50,50}, B{50,50,50,50} → union {0,0,100,100}
        const knob = groupRotateHandle(cs, ["A", "B"], 1)!;
        expect(knob).toMatchObject({ handle: "rotate", nodeId: "", cx: 50, cy: -ROTATE_OFFSET_PX, cursor: "grab" });
        expect(groupRotateHandle(cs, ["A", "B"], 2)!.cy).toBe(-ROTATE_OFFSET_PX / 2); // fixed screen offset → scales with zoom
        expect(groupHandleAtPoint(cs, ["A", "B"], 50, -ROTATE_OFFSET_PX, 1)!.handle).toBe("rotate"); // on the knob
        expect(groupHandleAtPoint(cs, ["A", "B"], 50, 0, 1)).toBeNull();   // the box top-centre is NOT the knob
        expect(groupHandleAtPoint(cs, ["A", "B"], 0, 0, 1)).toBeNull();    // a group exposes no corner handles
        expect(groupRotateHandle(cs, [], 1)).toBeNull();                   // empty group → no knob
    });
});

// ─── M4: screenToWorld — the one sanctioned screen→world inverse ───
describe("screenToWorld", () => {
    test("inverts screen = z·world − vp under zoom, pan, and a canvas offset", () => {
        const vp = { x: 100, y: 50, zoom: 2 };
        // world = (clientX − left + vp.x)/zoom : (500−40+100)/2 = 280
        expect(screenToWorld(vp, { left: 40, top: 20 }, 500, 80)).toEqual({ x: 280, y: 55 });
        // Round-trips the render transform: world → screen (z·w − vp + left) → back.
        const w = { x: 123.5, y: -47 };
        const cx = vp.zoom * w.x - vp.x + 40, cy = vp.zoom * w.y - vp.y + 20;
        expect(screenToWorld(vp, { left: 40, top: 20 }, cx, cy)).toEqual(w);
    });
});

// ─── M4: ToolController corner-resize now hit-tests handles WITHOUT the DOM ───
describe("ToolController DOM-free resize", () => {
    const rect = { left: 0, top: 0 } as DOMRect;
    const md = (x: number, y: number) =>
        ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);

    function harness(selected: string[]) {
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["A"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState();
        es.selectedNodeIds = selected;
        const tc = new ToolController(dispatcher, es, () => { });
        return { dispatcher, es, tc };
    }
    const geomOf = (d: ActionDispatcher) => d.getDocument().nodes.get("A")!.geometry;

    test("dragging the SE handle resizes the node — the target came from geometry, not the DOM", () => {
        const { dispatcher, tc } = harness(["A"]);
        tc.onMouseDown(md(50, 50), rect); // se handle sits at world (50,50); e.target has no attributes
        tc.onMouseMove(md(70, 70), rect);
        tc.onMouseUp(md(70, 70));
        expect(geomOf(dispatcher)).toMatchObject({ x: 0, y: 0, width: 70, height: 70 });
    });

    test("a press that is NOT on a handle does not start a resize", () => {
        const { dispatcher, tc } = harness(["A"]);
        tc.onMouseDown(md(25, 25), rect); // node centre — no handle
        tc.onMouseMove(md(45, 45), rect);
        tc.onMouseUp(md(45, 45));
        expect(geomOf(dispatcher)).toMatchObject({ x: 0, y: 0, width: 50, height: 50 }); // unchanged
    });

    test("with nothing selected there are no handles, so a corner press does not resize", () => {
        const { dispatcher, tc } = harness([]);
        tc.onMouseDown(md(50, 50), rect);
        tc.onMouseMove(md(70, 70), rect);
        tc.onMouseUp(md(70, 70));
        expect(geomOf(dispatcher)).toMatchObject({ x: 0, y: 0, width: 50, height: 50 }); // unchanged
    });

    test("resize hit-test AND drag math hold under a non-identity zoom + pan + canvas offset", () => {
        const { dispatcher, es, tc } = harness(["A"]);
        es.viewport = { x: 100, y: 50, zoom: 2 };
        const r = { left: 40, top: 20 } as DOMRect;
        // A's SE world corner (50,50) maps to screen (2·50−100+40, 2·50−50+20) = (40,70).
        tc.onMouseDown(md(40, 70), r);
        tc.onMouseMove(md(80, 110), r); // +40 screen px each axis = +20 world at zoom 2
        tc.onMouseUp(md(80, 110));
        // Drops /zoom on the move delta → width 90; mishandles pan/offset → misses the handle → 50.
        expect(geomOf(dispatcher)).toMatchObject({ x: 0, y: 0, width: 70, height: 70 });
    });

    test("a handle press is intercepted before the active tool; a body press falls through to it", () => {
        const { tc } = harness(["A"]);
        const calls: string[] = [];
        tc.setTool({ onMouseDown: () => calls.push("down") });
        tc.onMouseDown(md(25, 25), rect); // body centre → not a handle → the tool sees it
        expect(calls).toEqual(["down"]);
        tc.onMouseDown(md(50, 50), rect); // SE handle → resize intercepts → the tool is NOT called
        expect(calls).toEqual(["down"]);  // unchanged
    });

    test("pan wins over a handle: a corner press with Space held pans instead of resizing", () => {
        const { dispatcher, es, tc } = harness(["A"]);
        const key = (k: string) => ({ key: k, target: { tagName: "BODY", isContentEditable: false }, preventDefault() { } } as unknown as KeyboardEvent);
        tc.onKeyDown(key(" "));
        tc.onMouseDown(md(50, 50), rect); // on the SE handle, but Space is held → the pan branch wins
        tc.onMouseMove(md(70, 60), rect);
        tc.onMouseUp(md(70, 60));
        expect(geomOf(dispatcher)).toMatchObject({ x: 0, y: 0, width: 50, height: 50 }); // NOT resized
        expect(es.viewport).toMatchObject({ x: -20, y: -10 }); // panned (screen −delta) instead
    });

    test("multi-select shows NO per-node resize handle — a press where a corner used to be does not resize", () => {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mk("A", 0, 0); mk("B", 50, 50); // A's SE corner and B's NW corner both at (50,50)
        doc.rootNodeUuids = ["A", "B"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tc = new ToolController(dispatcher, es, () => { });
        // A group exposes only its rotate knob (above the box), NOT per-node corner squares — so a
        // press where a per-node corner used to be grabs nothing and falls through to the (null) tool.
        tc.onMouseDown(md(50, 50), rect);
        tc.onMouseMove(md(60, 60), rect);
        tc.onMouseUp(md(60, 60));
        expect(dispatcher.getDocument().nodes.get("A")!.geometry).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
        expect(dispatcher.getDocument().nodes.get("B")!.geometry).toMatchObject({ x: 50, y: 50, width: 50, height: 50 });
        expect(dispatcher.canUndo()).toBe(false); // nothing committed
    });

    test("handles and resize follow a child's WORLD AABB under a translated parent (bounds, not local)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["C"], geometry: { x: 100, y: 200, width: 200, height: 200 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: "P", children: [], geometry: { x: 10, y: 10, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P"];
        // C's world bounds are (110,210,50,50); its NW handle is at WORLD (110,210), not local (10,10).
        expect(selectionHandles(computeGeometry(doc), ["C"], 1)[0]).toMatchObject({ handle: "nw", cx: 110, cy: 210 });
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["C"];
        const tc = new ToolController(dispatcher, es, () => { });
        tc.onMouseDown(md(160, 260), rect); // C's SE world corner (110+50, 210+50)
        tc.onMouseMove(md(180, 280), rect);
        tc.onMouseUp(md(180, 280));
        expect(dispatcher.getDocument().nodes.get("C")!.geometry).toMatchObject({ width: 70, height: 70 });
    });

    test("idle hover over a handle sets the hover cursor (so the Canvas backend can show it)", () => {
        const { es, tc } = harness(["A"]); // A is 50×50 at origin
        const hover = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 0, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
        tc.onMouseMove(hover(50, 50), rect); // over A's SE corner handle
        expect(es.hoverCursor).toBe("nwse-resize");
        tc.onMouseMove(hover(25, -ROTATE_OFFSET_PX), rect); // over the rotate knob (top-centre)
        expect(es.hoverCursor).toBe("grab");
        tc.onMouseMove(hover(25, 25), rect); // node centre — no handle
        expect(es.hoverCursor).toBeNull();
    });

    test("hover does nothing while a button is held (that's a drag, not a hover)", () => {
        const { es, tc } = harness(["A"]);
        const drag = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
        tc.onMouseMove(drag(50, 50), rect); // button held → not a hover
        expect(es.hoverCursor).toBeNull();
    });

    test("resize snaps the dragged corner to another node's edge, with a guide", () => {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number, w: number, h: number) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: w, height: h }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mk("A", 0, 0, 50, 50); mk("B", 100, 100, 60, 60);
        doc.rootNodeUuids = ["A", "B"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A"];
        const tc = new ToolController(dispatcher, es, () => { });
        tc.onMouseDown(md(50, 50), rect);  // A's SE corner (world 50,50)
        tc.onMouseMove(md(97, 50), rect);  // drag the right edge to 97 → within 6 of B's left (100) → snaps to 100
        expect(es.snapGuides && es.snapGuides.length).toBeGreaterThan(0); // a guide is shown
        tc.onMouseUp(md(97, 50));
        expect(dispatcher.getDocument().nodes.get("A")!.geometry).toMatchObject({ x: 0, y: 0, width: 100, height: 50 }); // 97 snapped to 100
        expect(es.snapGuides).toBeNull(); // cleared on release
    });

    test("resize snaps a NESTED node's corner in world space (translated parent)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["C"], geometry: { x: 500, y: 500, width: 400, height: 400 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: "P", children: [], geometry: { x: 10, y: 10, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} }); // world (510,510) → SE (560,560)
        doc.nodes.set("T", { id: "T", type: "core.rectangle", parent: null, children: [], geometry: { x: 600, y: 510, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "T"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["C"];
        const tc = new ToolController(dispatcher, es, () => { });
        tc.onMouseDown(md(560, 560), rect); // C's SE world corner
        tc.onMouseMove(md(597, 560), rect); // world right 560→597, within 6 of T's left (600) → snaps; stored width += (37+3)
        expect(es.snapGuides).toContainEqual(expect.objectContaining({ axis: "x", pos: 600 })); // guide at T's WORLD edge (not the stored 100)
        tc.onMouseUp(md(597, 560));
        expect(dispatcher.getDocument().nodes.get("C")!.geometry.width).toBe(90); // 50 + 37 + 3(snap)
    });

    test("resize does NOT snap a transformed (rotated) node", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {}, transform: { rotation: 0.0001 } });
        doc.nodes.set("T", { id: "T", type: "core.rectangle", parent: null, children: [], geometry: { x: 100, y: 100, width: 60, height: 60 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["A", "T"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A"];
        const tc = new ToolController(dispatcher, es, () => { });
        tc.onMouseDown(md(50, 50), rect); // A's SE ≈ (50,50) (barely rotated)
        tc.onMouseMove(md(97, 50), rect); // near T's left (100), but A is rotated → snapping disabled
        tc.onMouseUp(md(97, 50));
        // Raw, NOT snapped (a snap would have pulled it to 100). Not exactly 97 because the drag
        // is now measured along the node's OWN axis: 47 world units across a 0.0001 rad rotation
        // is 47·cos(0.0001) of the node's width.
        expect(dispatcher.getDocument().nodes.get("A")!.geometry.width).toBeCloseTo(97, 6);
        expect(dispatcher.getDocument().nodes.get("A")!.geometry.width).not.toBeCloseTo(100, 1);
    });
});

// ─── M4: ToolController rotate — grab the knob to spin about the node's centre ───
describe("ToolController rotate", () => {
    const rect = { left: 0, top: 0 } as DOMRect;
    const md = (x: number, y: number) =>
        ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);

    function harness(rotation?: number) {
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {}, ...(rotation !== undefined ? { transform: { rotation } } : {}) });
        doc.rootNodeUuids = ["A"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A"];
        const tc = new ToolController(dispatcher, es, () => { });
        return { dispatcher, es, tc };
    }
    const rotOf = (d: ActionDispatcher) => d.getDocument().nodes.get("A")!.transform?.rotation ?? 0;

    test("dragging the knob spins about the centre, and the whole drag is ONE undo step", () => {
        const { dispatcher, tc } = harness();
        // A is 100×100 at origin → centre (50,50); the knob is at (50, −ROTATE_OFFSET_PX), straight up.
        tc.onMouseDown(md(50, -ROTATE_OFFSET_PX), rect); // grab: pointer angle −90° about the centre
        tc.onMouseMove(md(90, 10), rect);                // an intermediate frame
        tc.onMouseMove(md(100, 50), rect);               // pointer straight RIGHT of centre → 0°, so +90° total
        tc.onMouseUp(md(100, 50));
        expect(rotOf(dispatcher)).toBeCloseTo(Math.PI / 2, 10);
        dispatcher.undo();
        expect(rotOf(dispatcher)).toBe(0); // ONE undo restores the original → the two frames coalesced
    });

    test("rotation is RELATIVE to the node's existing rotation (adds the drag delta)", () => {
        // The knob rides the node's OWN top edge, so a 90°-turned square puts it to the RIGHT:
        // local mid-top (50,0) rotates about the centre (50,50) to (100,50), and the knob sits
        // ROTATE_OFFSET_PX further out along that direction. (The AABB is unchanged for a square
        // — which is exactly why the old axis-aligned knob stayed put and looked detached.)
        const { dispatcher, tc } = harness(Math.PI / 2);
        tc.onMouseDown(md(100 + ROTATE_OFFSET_PX, 50), rect); // grab: pointer angle 0 about the centre
        tc.onMouseMove(md(50, 150), rect);                    // straight BELOW the centre → +90°
        tc.onMouseUp(md(50, 150));
        expect(rotOf(dispatcher)).toBeCloseTo(Math.PI, 10); // π/2 initial + π/2 delta
    });

    test("a non-knob press does not rotate (a corner press resizes instead)", () => {
        const { dispatcher, tc } = harness();
        tc.onMouseDown(md(100, 100), rect); // SE corner, not the knob
        tc.onMouseMove(md(120, 120), rect);
        tc.onMouseUp(md(120, 120));
        expect(rotOf(dispatcher)).toBe(0); // never rotated
        expect(dispatcher.getDocument().nodes.get("A")!.geometry).toMatchObject({ width: 120, height: 120 }); // resized
    });

    test("the knob grab and the angle math hold under a non-identity zoom + pan", () => {
        const { dispatcher, es, tc } = harness();
        es.viewport = { x: 30, y: 20, zoom: 2 };
        const r = { left: 0, top: 0 } as DOMRect;
        // Knob world (50, −ROTATE_OFFSET_PX/2 = −11) → screen (2·50−30, 2·(−11)−20) = (70, −42).
        tc.onMouseDown(md(70, -42), r);
        // World (100,50) [straight right of centre → angle 0] → screen (2·100−30, 2·50−20) = (170, 80).
        tc.onMouseMove(md(170, 80), r);
        tc.onMouseUp(md(170, 80));
        expect(rotOf(dispatcher)).toBeCloseTo(Math.PI / 2, 10); // wrong zoom/pan handling → wrong angle
    });

    test("deleting the rotated node mid-drag ends the gesture and clears the drag-cursor flag", () => {
        const { dispatcher, es, tc } = harness();
        tc.onMouseDown(md(50, -ROTATE_OFFSET_PX), rect); // grab knob → isDragging = true
        expect(es.isDragging).toBe(true);
        dispatcher.dispatchAction(new DeleteNodeAction(dispatcher.getDocument(), "A")); // node vanishes
        tc.onMouseMove(md(60, 0), rect); // abort path: rotateNodeId no longer in the doc
        expect(es.isDragging).toBe(false); // not left stuck on "grabbing"
    });

    const key = (k: string) => ({ key: k, target: { tagName: "BODY", isContentEditable: false }, preventDefault() { } } as unknown as KeyboardEvent);

    test("Escape cancels an in-flight rotate, reverting to the pre-gesture angle", () => {
        const { dispatcher, es, tc } = harness(); // rotation 0
        tc.onMouseDown(md(50, -ROTATE_OFFSET_PX), rect);
        tc.onMouseMove(md(90, 10), rect);
        tc.onMouseMove(md(100, 50), rect); // rotated ~+90°
        expect(rotOf(dispatcher)).toBeCloseTo(Math.PI / 2, 10);
        tc.onKeyDown(key("Escape"));
        expect(rotOf(dispatcher)).toBe(0);     // reverted to initial
        expect(es.isDragging).toBe(false);
        tc.onMouseUp(md(100, 50));             // gesture already cancelled → no further change
        expect(rotOf(dispatcher)).toBe(0);
    });

    test("Escape reverts to a NON-zero initial rotation", () => {
        const { dispatcher, tc } = harness(Math.PI / 2);
        tc.onMouseDown(md(100 + ROTATE_OFFSET_PX, 50), rect);   // the knob follows the turned top edge
        tc.onMouseMove(md(50, 150), rect); // +90° → ~π
        expect(rotOf(dispatcher)).toBeCloseTo(Math.PI, 10);
        tc.onKeyDown(key("Escape"));
        expect(rotOf(dispatcher)).toBeCloseTo(Math.PI / 2, 10); // back to the initial π/2
    });

    test("Escape after a >coalesce-window pause fully cancels — undo does NOT resurrect the rotation", () => {
        const { dispatcher, tc } = harness();
        const nowSpy = jest.spyOn(Date, "now");
        try {
            nowSpy.mockReturnValue(1000);
            tc.onMouseDown(md(50, -ROTATE_OFFSET_PX), rect); // checkpoint = the pre-gesture (INITIAL) revision
            tc.onMouseMove(md(90, 10), rect);                // frame 1 @ t=1000
            nowSpy.mockReturnValue(2000);                    // +1000ms > COALESCE_WINDOW_MS(400)
            tc.onMouseMove(md(100, 50), rect);               // frame 2 @ t=2000 → a SEPARATE revision (history split)
            tc.onKeyDown(key("Escape"));                     // rollback to the checkpoint erases BOTH frames
        } finally { nowSpy.mockRestore(); }
        expect(rotOf(dispatcher)).toBe(0);                   // reverted
        expect(dispatcher.canUndo()).toBe(false);            // NO resurrectable "rotated" revision via undo (a coalesced revert leaves one)
        expect(dispatcher.canRedo()).toBe(false);            // NOR via redo — the gesture's revisions are TRUNCATED, not just stepped past
    });

    test("grabbing the knob and pressing Escape with NO drag commits nothing", () => {
        const { dispatcher, tc } = harness();
        tc.onMouseDown(md(50, -ROTATE_OFFSET_PX), rect); // grab, no move
        tc.onKeyDown(key("Escape"));
        expect(dispatcher.canUndo()).toBe(false);        // no phantom no-op revision
        expect(rotOf(dispatcher)).toBe(0);
    });
});

// ─── M4: GroupTransform — rigid group rotation about a shared pivot (pure math) ───
describe("GroupTransform (group rotate math)", () => {
    test("rotateGroup rotates each root rigidly about the pivot: orbit the centre + add the delta", () => {
        // Pivot (150,50). +90° clockwise (y-down). A due-WEST of pivot, B due-EAST; B already rotated 0.1.
        const inputs = [
            { id: "A", startX: 0, startY: 0, startRotation: 0, centerX: 50, centerY: 50 },
            { id: "B", startX: 200, startY: 0, startRotation: 0.1, centerX: 250, centerY: 50 },
        ];
        const out = rotateGroup(150, 50, Math.PI / 2, inputs);
        // A (west) orbits to due-NORTH → centre (150,-50); geom shifts by (+100,-100). rotation 0→π/2.
        expect(out[0].x).toBeCloseTo(100, 9); expect(out[0].y).toBeCloseTo(-100, 9);
        expect(out[0].rotation).toBeCloseTo(Math.PI / 2, 9);
        // B (east) orbits to due-SOUTH → centre (150,150); geom shifts by (-100,+100). rotation adds to 0.1.
        expect(out[1].x).toBeCloseTo(100, 9); expect(out[1].y).toBeCloseTo(100, 9);
        expect(out[1].rotation).toBeCloseTo(0.1 + Math.PI / 2, 9);
    });

    test("rotateGroup with delta 0 is the identity — returns the captured start poses (the Escape path)", () => {
        const inputs = [{ id: "A", startX: 7, startY: 9, startRotation: 0.3, centerX: 30, centerY: 40 }];
        expect(rotateGroup(100, 100, 0, inputs)).toEqual([{ id: "A", x: 7, y: 9, rotation: 0.3 }]);
    });

    test("a DIAGONALLY-offset centre at a generic angle exercises all four cos/sin orbit terms", () => {
        // rx and ry BOTH non-zero and unequal; delta with cos AND sin clearly non-zero — so a sign
        // flip or dropped coefficient on ANY of cos·rx, sin·ry, sin·rx, cos·ry changes the result.
        const pivotX = 30, pivotY = -10, delta = 0.7;
        const centerX = 100, centerY = 50, startX = 5, startY = 8;
        const rx = centerX - pivotX, ry = centerY - pivotY;
        const cos = Math.cos(delta), sin = Math.sin(delta);
        const expX = startX + ((pivotX + cos * rx - sin * ry) - centerX); // independent oracle for the formula
        const expY = startY + ((pivotY + sin * rx + cos * ry) - centerY);
        const out = rotateGroup(pivotX, pivotY, delta, [{ id: "A", startX, startY, startRotation: 0.2, centerX, centerY }]);
        expect(out[0].x).toBeCloseTo(expX, 9);
        expect(out[0].y).toBeCloseTo(expY, 9);
        expect(out[0].rotation).toBeCloseTo(0.2 + delta, 9);
    });

    test("a root AT the pivot only spins (its centre doesn't move)", () => {
        const out = rotateGroup(50, 50, 1.2345, [{ id: "A", startX: 0, startY: 0, startRotation: 0, centerX: 50, centerY: 50 }]);
        expect(out[0].x).toBeCloseTo(0, 9); expect(out[0].y).toBeCloseTo(0, 9); // no orbit
        expect(out[0].rotation).toBeCloseTo(1.2345, 9);
    });

    test("isGroupRotatable requires centre origin + a translation-only PARENT chain for EVERY root", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["C"], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: "P", children: [], geometry: { x: 0, y: 0, width: 20, height: 20 }, style: { fill: "#000", opacity: 1 }, layout: {}, transform: { rotation: 0.5 } }); // C's OWN rotation is fine
        doc.nodes.set("R", { id: "R", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 20, height: 20 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "R"];
        expect(isGroupRotatable(doc, ["C", "R"])).toBe(true);   // C rotated, but its parent P is translation-only
        expect(isGroupRotatable(doc, [])).toBe(false);           // empty group → false
        doc.nodes.get("P")!.transform = { rotation: 0.2 };       // a ROTATED PARENT breaks C's eligibility
        expect(isGroupRotatable(doc, ["C", "R"])).toBe(false);
        doc.nodes.get("P")!.transform = undefined;
        doc.nodes.get("R")!.transform = { rotation: 0, origin: { x: 0, y: 0 } }; // a NON-centre origin breaks it
        expect(isGroupRotatable(doc, ["C", "R"])).toBe(false);
        doc.nodes.get("R")!.transform = { rotation: 0, origin: { x: 0.5, y: 0 } }; // ONE axis centred is NOT centre (both must be 0.5)
        expect(isGroupRotatable(doc, ["C", "R"])).toBe(false);
        doc.nodes.get("R")!.transform = { rotation: 0, origin: { x: 0.5, y: 0.5 } }; // explicit centre origin is fine
        expect(isGroupRotatable(doc, ["C", "R"])).toBe(true);
    });

    test("isGroupRotatable rejects an in-flow auto-layout child (its position isn't driven by stored x/y)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("F", { id: "F", type: "core.rectangle", parent: null, children: ["A", "B"], geometry: { x: 0, y: 0, width: 300, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: { container: { direction: "row" } } });
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: "F", children: [], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("B", { id: "B", type: "core.rectangle", parent: "F", children: [], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["F"];
        // A and B are laid out by F (a container, no transform) → their orbit would be discarded → not rotatable.
        expect(isGroupRotatable(doc, ["A", "B"])).toBe(false);
        // Making A `absolute` takes it out of flow → positioned by stored x/y → the group is rotatable again.
        doc.nodes.get("A")!.layout = { position: "absolute" };
        doc.nodes.get("B")!.layout = { position: "absolute" };
        expect(isGroupRotatable(doc, ["A", "B"])).toBe(true);
    });
});

// ─── M6: components — instance resolution (pure), guards, and the pipeline ───
describe("Components: expandInstances", () => {
    /** master M = a 100×50 rect at (10,20) with a 20×20 child; plus an instance of it at (300,300). */
    function docWithInstance(instanceExtra: Partial<import("../document/Node").Node> = {}): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: ["MC"], geometry: { x: 10, y: 20, width: 100, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("MC", { id: "MC", type: "core.rectangle", parent: "M", children: [], geometry: { x: 5, y: 5, width: 20, height: 20 }, style: { fill: "#0f0", opacity: 1 }, layout: {} });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 300, y: 300, width: 100, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M", ...instanceExtra });
        doc.rootNodeUuids = ["M", "I"];
        return doc;
    }

    test("materializes the master subtree under the instance, with the ROOT re-origined to (0,0)", () => {
        const x = expandInstances(docWithInstance());
        expect(x.nodes.get("I")!.children).toEqual(["I::M"]);
        const root = x.nodes.get("I::M")!;
        expect(root.parent).toBe("I");
        expect([root.geometry.x, root.geometry.y]).toEqual([0, 0]);   // the INSTANCE places the copy
        expect([root.geometry.width, root.geometry.height]).toEqual([100, 50]); // size copied as-is
        expect(root.type).toBe("core.rectangle");
        expect(root.style.fill).toBe("#f00");
        // The child copies keep their own parent-relative geometry.
        const child = x.nodes.get("I::MC")!;
        expect(child.parent).toBe("I::M");
        expect([child.geometry.x, child.geometry.y]).toEqual([5, 5]);
        expect(x.nodes.get("I::M")!.children).toEqual(["I::MC"]);
        // The STORED document is untouched (expansion is derived, never persisted).
        expect(x).not.toBe(docWithInstance());
    });

    test("an instance-free document is returned UNCHANGED (same reference — no allocation)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["A"];
        expect(expandInstances(doc)).toBe(doc);
    });

    test("an ABSENT or DANGLING componentId expands to nothing (valid at rest — deleting a master can't corrupt)", () => {
        const dangling = docWithInstance({ componentId: "gone" });
        expect(expandInstances(dangling)).toBe(dangling);             // nothing expandable
        expect(() => deserializeDocument(serializeDocument(dangling))).not.toThrow();
        const empty = docWithInstance({ componentId: undefined });
        expect(expandInstances(empty)).toBe(empty);
        expect(() => deserializeDocument(serializeDocument(empty))).not.toThrow();
    });

    test("NESTED instances expand recursively, with reversible ids", () => {
        const doc = createEmptyDocument();
        // Inner master IM; outer master OM CONTAINS an instance of IM; I instances OM.
        doc.nodes.set("IM", { id: "IM", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#00f", opacity: 1 }, layout: {} });
        doc.nodes.set("OM", { id: "OM", type: "core.rectangle", parent: null, children: ["OI"], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("OI", { id: "OI", type: "core.instance", parent: "OM", children: [], geometry: { x: 5, y: 5, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "IM" });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 200, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "OM" });
        doc.rootNodeUuids = ["IM", "OM", "I"];
        const x = expandInstances(doc);
        expect(x.nodes.has("I::OM")).toBe(true);
        expect(x.nodes.has("I::OI")).toBe(true);          // the nested instance's own copy
        expect(x.nodes.has("I::OI::IM")).toBe(true);      // …expanded one level deeper
        expect(x.nodes.get("I::OI::IM")!.parent).toBe("I::OI");
        // The id decomposes back to (instance path, master node) — what overrides will key on.
        expect(splitVirtualId("I::OI::IM")).toEqual({ instancePath: "I::OI", masterNodeId: "IM" });
        expect(splitVirtualId("plain")).toBeNull();
        expect(isVirtualId("I::OM")).toBe(true);
        expect(isVirtualId("I")).toBe(false);
    });

    test("a SELF-referential master stops at the cycle instead of expanding forever", () => {
        const doc = createEmptyDocument();
        // M contains an instance of M itself.
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: ["SI"], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("SI", { id: "SI", type: "core.instance", parent: "M", children: [], geometry: { x: 5, y: 5, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M"];
        const x = expandInstances(doc);          // must terminate
        expect(x.nodes.has("SI::M")).toBe(true); // one level materialized…
        expect(x.nodes.has("SI::M::SI::M")).toBe(false); // …then the chain guard stops it
        expect(x.nodes.size).toBeLessThan(20);
    });

    test("a two-master CYCLE also terminates (chain, not just self-reference)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: ["AI"], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("AI", { id: "AI", type: "core.instance", parent: "A", children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "B" });
        doc.nodes.set("B", { id: "B", type: "core.rectangle", parent: null, children: ["BI"], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#0f0", opacity: 1 }, layout: {} });
        doc.nodes.set("BI", { id: "BI", type: "core.instance", parent: "B", children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "A" });
        doc.rootNodeUuids = ["A", "B"];
        const x = expandInstances(doc); // terminates
        expect(x.nodes.size).toBeLessThan(100);
    });

    test("DEPTH is capped: a long instance chain stops materializing rather than exploding", () => {
        // m0 <- i1 (in m1) <- i2 (in m2) … a chain deeper than INSTANCE_MAX_DEPTH.
        const doc = createEmptyDocument();
        const depth = INSTANCE_MAX_DEPTH + 6;
        doc.nodes.set("m0", { id: "m0", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        for (let k = 1; k <= depth; k++) {
            doc.nodes.set(`m${k}`, { id: `m${k}`, type: "core.rectangle", parent: null, children: [`i${k}`], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
            doc.nodes.set(`i${k}`, { id: `i${k}`, type: "core.instance", parent: `m${k}`, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: `m${k - 1}` });
        }
        doc.rootNodeUuids = Object.keys(Object.fromEntries([...doc.nodes].filter(([, n]) => !n.parent))).map(String);
        const x = expandInstances(doc); // terminates
        // The deepest chain materializes at most INSTANCE_MAX_DEPTH+1 levels of separators.
        const deepest = [...x.nodes.keys()].reduce((m, id) => Math.max(m, id.split("::").length - 1), 0);
        expect(deepest).toBeLessThanOrEqual(INSTANCE_MAX_DEPTH + 1);
    });

    test("the total materialized-node CAP bounds a WIDE expansion (breadth, which depth can't stop)", () => {
        // A big master instanced many times: 1001 × 60 = 60 060 copies — the DEPTH cap is
        // irrelevant here (every instance is depth 0), so only the node cap bounds it.
        const doc = createEmptyDocument();
        const kids: string[] = [];
        for (let k = 0; k < 1000; k++) {
            const id = `k${k}`;
            kids.push(id);
            doc.nodes.set(id, { id, type: "core.rectangle", parent: "BIG", children: [], geometry: { x: 0, y: 0, width: 5, height: 5 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        }
        doc.nodes.set("BIG", { id: "BIG", type: "core.rectangle", parent: null, children: kids, geometry: { x: 0, y: 0, width: 500, height: 500 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        const roots = ["BIG"];
        for (let n = 0; n < 60; n++) {
            const id = `inst${n}`;
            roots.push(id);
            doc.nodes.set(id, { id, type: "core.instance", parent: null, children: [], geometry: { x: n * 10, y: 0, width: 500, height: 500 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "BIG" });
        }
        doc.rootNodeUuids = roots;
        const stored = doc.nodes.size;
        const x = expandInstances(doc);
        const materialized = x.nodes.size - stored;
        expect(materialized).toBeLessThanOrEqual(INSTANCE_MAX_NODES); // capped, not 60 060
        expect(materialized).toBeGreaterThan(1000);                    // …but it DID expand (non-vacuous)
    });

    test("componentError: only an instance may carry a componentId; dangling is allowed", () => {
        expect(componentError("core.instance", "M")).toBeNull();
        expect(componentError("core.instance", undefined)).toBeNull();
        expect(componentError("core.rectangle", "M")).toMatch("only a core.instance");
        expect(componentError("core.rectangle", undefined)).toBeNull();
        expect(componentError("core.instance", "")).toMatch("non-empty");
        expect(componentError("core.instance", 42)).toMatch("non-empty");
        // The load path enforces the same rule.
        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["r"], variables: {}, nodes: { r: { id: "r", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, componentId: "M" } } } });
        expect(() => deserializeDocument(bad)).toThrow("only a core.instance");
    });

    test('"::" is RESERVED in stored node ids on both paths (it would collide with virtual ids)', () => {
        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["a::b"], variables: {}, nodes: { "a::b": { id: "a::b", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} } } } });
        expect(() => deserializeDocument(bad)).toThrow('must not contain "::"');
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        expect(dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", 0, 0, 10, 10, "#fff", "a::b")).success).toBe(false);
        expect(nodeIdError("ok-id")).toBeNull();
        expect(nodeIdError("__document__")).toMatch("reserved");
    });

    test("through computeGeometry: the instance's copies get WORLD positions under the instance", () => {
        const cs = computeGeometry(docWithInstance());
        // The instance sits at (300,300); its master copy is at the instance origin, and the
        // master's child keeps its (5,5) offset → world (305,305).
        expect(cs.nodes.get("I")!.bounds).toMatchObject({ x: 300, y: 300, width: 100, height: 50 });
        expect(cs.nodes.get("I::M")!.bounds).toMatchObject({ x: 300, y: 300 });
        expect(cs.nodes.get("I::MC")!.bounds).toMatchObject({ x: 305, y: 305, width: 20, height: 20 });
        // The MASTER itself still renders in place, independently.
        expect(cs.nodes.get("M")!.bounds).toMatchObject({ x: 10, y: 20 });
    });

    test("picking: clicking instance CONTENT selects the instance, never a virtual copy", () => {
        const cs = computeGeometry(docWithInstance());
        expect(hitTest(cs, 310, 310)).toBe("I");        // over the copied child → the INSTANCE
        expect(nodesInRect(cs, { x: 290, y: 290, width: 200, height: 200 })).toEqual(["I"]);
        expect(hitTest(cs, 15, 25)).toBe("MC");          // the real master still picks normally
    });

    test("a master edit is reflected by its instances on the next compute (no copy in the document)", () => {
        const doc = docWithInstance();
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), "MC", { x: 40 }));
        const cs = computeGeometry(dispatcher.getDocument());
        expect(cs.nodes.get("I::MC")!.bounds).toMatchObject({ x: 340 }); // 300 + 40
        // …and the stored document still holds no copies.
        expect([...dispatcher.getDocument().nodes.keys()].some(isVirtualId)).toBe(false);
    });

    test("CreateInstanceAction adds an instance sized to its master; undo removes it", () => {
        const doc = docWithInstance();
        doc.nodes.delete("I"); doc.rootNodeUuids = ["M"];
        const dispatcher = new ActionDispatcher(doc);
        const action = new CreateInstanceAction(dispatcher.getDocument(), "M", 500, 500, "NEW");
        expect(dispatcher.dispatchAction(action).success).toBe(true);
        const made = dispatcher.getDocument().nodes.get("NEW")!;
        expect(made.type).toBe("core.instance");
        expect(made.componentId).toBe("M");
        expect(made.geometry).toEqual({ x: 500, y: 500, width: 100, height: 50 }); // master's size
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("NEW::MC")).toBeDefined();
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.has("NEW")).toBe(false);
    });

    test("CreateInstanceAction rejects a missing master, an instance-of-an-instance, and a reserved id", () => {
        const dispatcher = new ActionDispatcher(docWithInstance());
        const d = dispatcher.getDocument();
        expect(dispatcher.dispatchAction(new CreateInstanceAction(d, "nope", 0, 0)).success).toBe(false);
        expect(dispatcher.dispatchAction(new CreateInstanceAction(d, "I", 0, 0)).success).toBe(false);      // master is itself an instance
        expect(dispatcher.dispatchAction(new CreateInstanceAction(d, "M", 0, 0, "a::b")).success).toBe(false);
        expect(dispatcher.dispatchAction(new CreateInstanceAction(d, "M", NaN, 0)).success).toBe(false);
        expect(dispatcher.canUndo()).toBe(false);
    });

    test("a moving instance does NOT snap to its OWN materialized copies (they travel with it)", () => {
        // The copies sit exactly on the instance's edges but are NOT in its stored `children`,
        // so the subtree walk can't see them: without the owner check every sub-threshold drag
        // would snap back to 0 and pin the instance in place.
        const doc = docWithInstance();
        const cs = computeGeometry(doc);
        const targets = snapTargetsExcludingSubtrees(doc, cs, ["I"]);
        // The instance's own copies (world 300,300 and 305,305) must be absent…
        expect(targets.some(t => t.x === 300 && t.y === 300)).toBe(false);
        // …while the MASTER's real nodes (elsewhere on canvas) remain valid targets.
        expect(targets.some(t => t.x === 10 && t.y === 20)).toBe(true);
        // A drag of the instance is therefore free to move (nothing pins it at its start).
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["I"];
        const tool = new MoveTool(dispatcher, es, () => { });
        const mev = (x: number, y: number) => ({ clientX: x, clientY: y } as unknown as MouseEvent);
        tool.onMouseDown(mev(0, 0));
        tool.onMouseMove(mev(3, 0)); // a 3px drag — inside the 6px snap threshold
        expect(es.pendingGeometry!.get("I")).toEqual({ x: 303, y: 300 }); // moved, NOT pinned at 300
    });

    test("a LINE master can be instanced (the instance box follows the line/path rule)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("L", { id: "L", type: "core.line", parent: null, children: [], geometry: { x: 0, y: 100, width: 200, height: 0 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["L"];
        expect(dimensionError("core.instance", 200, 0)).toBeNull();     // one axis may collapse…
        expect(dimensionError("core.instance", 0, 0)).toMatch("non-zero"); // …but not both
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new CreateInstanceAction(dispatcher.getDocument(), "L", 0, 300, "LI")).success).toBe(true);
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("LI::L")).toBeDefined();
    });

    test("the 20→21 migration RENAMES stored ids containing the now-reserved \"::\" (old files stay loadable)", () => {
        // Schema 21 reserves "::" retroactively; a schema-20 file using it loaded fine before,
        // so the migration must rewrite the id AND every reference, not make the file unreadable.
        const v20 = JSON.stringify({
            version: "20",
            document: {
                metadata: {}, rootNodeUuids: ["a::b"], variables: {}, activeTheme: "light",
                nodes: {
                    "a::b": { id: "a::b", type: "core.rectangle", parent: null, children: ["c::d"], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} },
                    "c::d": { id: "c::d", type: "core.rectangle", parent: "a::b", children: [], geometry: { x: 1, y: 1, width: 5, height: 5 }, style: { fill: "#000", opacity: 1 }, layout: {} }
                }
            }
        });
        const doc = deserializeDocument(v20); // must NOT throw
        expect(doc.nodes.has("a__b")).toBe(true);
        expect(doc.nodes.has("c__d")).toBe(true);
        expect(doc.rootNodeUuids).toEqual(["a__b"]);
        expect(doc.nodes.get("a__b")!.children).toEqual(["c__d"]);  // references rewritten…
        expect(doc.nodes.get("c__d")!.parent).toBe("a__b");          // …in both directions
        expect(doc.nodes.get("c__d")!.geometry).toMatchObject({ x: 1, y: 1 }); // content preserved
        expect(() => deserializeDocument(serializeDocument(doc))).not.toThrow();
    });

    test("the materialized ROOT drops the master's constraints (they described a parent the copy lost)", () => {
        // The master is a constrained child of a frame; its copy sits under the INSTANCE, whose
        // box is unrelated — leaving the constraints would reposition the copy and override the
        // (0,0) re-origin. Deeper copies keep theirs (their parent IS a faithful copy).
        const doc = createEmptyDocument();
        doc.nodes.set("F", { id: "F", type: "core.rectangle", parent: null, children: ["M"], geometry: { x: 0, y: 0, width: 400, height: 400 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: "F", children: ["MC"], geometry: { x: 10, y: 10, width: 100, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: { constraints: { horizontal: "right" }, constraintRef: { width: 400, height: 400 } } });
        doc.nodes.set("MC", { id: "MC", type: "core.rectangle", parent: "M", children: [], geometry: { x: 5, y: 5, width: 20, height: 20 }, style: { fill: "#0f0", opacity: 1 }, layout: { constraints: { horizontal: "right" }, constraintRef: { width: 100, height: 50 } } });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 700, y: 700, width: 100, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["F", "I"];
        const x = expandInstances(doc);
        expect(x.nodes.get("I::M")!.layout.constraints).toBeUndefined();   // root copy: cleared
        expect(x.nodes.get("I::M")!.layout.constraintRef).toBeUndefined();
        expect(x.nodes.get("I::MC")!.layout.constraints).toBeDefined();     // deeper copy: kept
        // …so the copy lands exactly at the instance origin, not shifted by a stale anchor.
        expect(computeGeometry(doc).nodes.get("I::M")!.bounds).toMatchObject({ x: 700, y: 700 });
    });

    test("a master edit invalidates the instance's copies even with dirty-tracking inputs", () => {
        // computeGeometry disables previous/dirty reuse while instances are present, because the
        // dirty set names STORED ids — the virtual copies a master edit changes are not in it.
        const doc = docWithInstance();
        const first = computeGeometry(doc);
        expect(first.nodes.get("I::MC")!.bounds).toMatchObject({ x: 305 });
        doc.nodes.get("MC")!.geometry.x = 40; // a master edit, reported as dirty on the STORED id
        const second = computeGeometry(doc, null, first, new Set(["MC"]));
        expect(second.nodes.get("I::MC")!.bounds).toMatchObject({ x: 340 }); // not the stale 305
    });

    test("sibling copies keep the master's CHILD ORDER (z-order must survive expansion)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: ["c1", "c2", "c3"], geometry: { x: 0, y: 0, width: 90, height: 30 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        for (const c of ["c1", "c2", "c3"]) doc.nodes.set(c, { id: c, type: "core.rectangle", parent: "M", children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 0, width: 90, height: 30 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I"];
        expect(expandInstances(doc).nodes.get("I::M")!.children).toEqual(["I::c1", "I::c2", "I::c3"]);
    });

    test("two SIBLING instances of the same master both expand (the chain is per-branch, not global)", () => {
        const doc = docWithInstance();
        doc.nodes.set("I2", { id: "I2", type: "core.instance", parent: null, children: [], geometry: { x: 600, y: 600, width: 100, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I", "I2"];
        const x = expandInstances(doc);
        expect(x.nodes.has("I::M")).toBe(true);
        expect(x.nodes.has("I2::M")).toBe(true); // a SHARED chain set would have blocked the second
    });

    test("the depth cap is two-sided: nesting DOES reach the cap before stopping", () => {
        // A one-sided "≤ cap" assertion also passes for a cap of 1 — assert a deep chain really
        // materializes several levels, so a tightening off-by-one is caught too.
        const doc = createEmptyDocument();
        doc.nodes.set("m0", { id: "m0", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        for (let k = 1; k <= 5; k++) {
            doc.nodes.set(`m${k}`, { id: `m${k}`, type: "core.rectangle", parent: null, children: [`i${k}`], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
            doc.nodes.set(`i${k}`, { id: `i${k}`, type: "core.instance", parent: `m${k}`, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: `m${k - 1}` });
        }
        doc.rootNodeUuids = ["m0", "m1", "m2", "m3", "m4", "m5"];
        const x = expandInstances(doc);
        // Instancing m5 nests 5 levels: i5::m4, then i5::i4::m3, … all within the cap of 16.
        expect(x.nodes.has("i5::m4")).toBe(true);
        expect(x.nodes.has("i5::i4::m3")).toBe(true);
        expect(x.nodes.has("i5::i4::i3::m2")).toBe(true);
        expect(x.nodes.has("i5::i4::i3::i2::m1")).toBe(true);
        expect(x.nodes.has("i5::i4::i3::i2::i1::m0")).toBe(true);
    });

    test("an instance round-trips through serialize/deserialize", () => {
        const doc = docWithInstance();
        const loaded = deserializeDocument(serializeDocument(doc));
        expect(loaded.nodes.get("I")!.componentId).toBe("M");
        expect(loaded.nodes.get("I")!.type).toBe("core.instance");
        expect(compareDocuments(doc, loaded)).toBe(true);
    });
});

// ─── M6 slice 2: per-instance overrides ───
describe("Components: instance overrides", () => {
    /** master M (100×50 at 10,20) with child MC (20×20 at 5,5); instance I at (300,300). */
    function doc2(overrides?: Record<string, import("../document/Components").InstanceOverride>): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: ["MC"], geometry: { x: 10, y: 20, width: 100, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("MC", { id: "MC", type: "core.rectangle", parent: "M", children: [], geometry: { x: 5, y: 5, width: 20, height: 20 }, style: { fill: "#0f0", opacity: 1 }, layout: {}, text: undefined });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 300, y: 300, width: 100, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M", ...(overrides ? { overrides } : {}) });
        doc.rootNodeUuids = ["M", "I"];
        return doc;
    }

    test("an override changes ONLY this instance's copy — master and siblings are untouched", () => {
        const doc = doc2({ MC: { geometry: { x: 60 }, style: { fill: "#00f" } } });
        doc.nodes.set("I2", { id: "I2", type: "core.instance", parent: null, children: [], geometry: { x: 600, y: 600, width: 100, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I", "I2"];
        const x = expandInstances(doc);
        expect(x.nodes.get("I::MC")!.geometry).toMatchObject({ x: 60, y: 5, width: 20 }); // merged over the master
        expect(x.nodes.get("I::MC")!.style.fill).toBe("#00f");
        expect(x.nodes.get("I2::MC")!.geometry.x).toBe(5);    // the OTHER instance is unaffected…
        expect(x.nodes.get("I2::MC")!.style.fill).toBe("#0f0");
        expect(doc.nodes.get("MC")!.geometry.x).toBe(5);       // …and so is the master
        expect(doc.nodes.get("MC")!.style.fill).toBe("#0f0");
    });

    test("a ROOT override may resize but never moves the copy (the instance's geometry places it)", () => {
        const x = expandInstances(doc2({ M: { geometry: { x: 999, y: 999, width: 250 } } }));
        expect(x.nodes.get("I::M")!.geometry).toMatchObject({ x: 0, y: 0, width: 250, height: 50 });
        expect(computeGeometry(doc2({ M: { geometry: { x: 999, y: 999, width: 250 } } })).nodes.get("I::M")!.bounds)
            .toMatchObject({ x: 300, y: 300, width: 250 });
    });

    test("overrides survive a master edit and go INERT when the master node disappears", () => {
        const doc = doc2({ MC: { style: { fill: "#00f" } } });
        const dispatcher = new ActionDispatcher(doc);
        // Editing the master's OTHER properties leaves the override applying to the same node.
        dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), "MC", { y: 40 }));
        let x = expandInstances(dispatcher.getDocument());
        expect(x.nodes.get("I::MC")!.geometry.y).toBe(40);      // master edit flows through…
        expect(x.nodes.get("I::MC")!.style.fill).toBe("#00f");  // …with the override still on top
        // Deleting the master node makes the override inert, never invalid.
        dispatcher.dispatchAction(new DeleteNodeAction(dispatcher.getDocument(), "MC"));
        x = expandInstances(dispatcher.getDocument());
        expect(x.nodes.has("I::MC")).toBe(false);
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();
    });

    test("overridesError: instance-only, known fields, and each field obeys its stored rule", () => {
        expect(overridesError("core.instance", undefined)).toBeNull();
        expect(overridesError("core.instance", { MC: { geometry: { x: 1 }, style: { opacity: 0.5 }, text: "hi", src: "u" } })).toBeNull();
        expect(overridesError("core.instance", { unknownNode: { text: "inert but valid" } })).toBeNull(); // a key matching nothing is inert
        expect(overridesError("core.rectangle", { MC: {} })).toMatch("only a core.instance");
        expect(overridesError("core.instance", [])).toMatch("must be an object");
        expect(overridesError("core.instance", { "": {} })).toMatch("non-empty");
        // `a::b` is a PATH key now (schema 28) — reaching into the nested instance `a`.
        expect(overridesError("core.instance", { "a::b": {} })).toBeNull();
        expect(overridesError("core.instance", { "a::": {} })).toMatch("empty path segment");
        expect(overridesError("core.instance", { "::b": {} })).toMatch("empty path segment");
        expect(overridesError("core.instance", { MC: null })).toMatch("must be an object");
        expect(overridesError("core.instance", { MC: { bogus: 1 } })).toMatch('unknown field "bogus"');
        expect(overridesError("core.instance", { MC: { geometry: { z: 1 } } })).toMatch("unknown field");
        expect(overridesError("core.instance", { MC: { geometry: { x: Infinity } } })).toMatch("finite");
        expect(overridesError("core.instance", { MC: { style: { opacity: 5 } } })).toMatch("opacity must be within"); // the SHARED styleError
        expect(overridesError("core.instance", { MC: { text: 7 } })).toMatch("text must be a string");
        const many: Record<string, unknown> = {};
        for (let i = 0; i <= INSTANCE_MAX_OVERRIDES; i++) many[`k${i}`] = {};
        expect(overridesError("core.instance", many)).toMatch(`at most ${INSTANCE_MAX_OVERRIDES}`);
        // The load path enforces exactly the same rule.
        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["r"], variables: {}, nodes: { r: { id: "r", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, overrides: { a: {} } } } } });
        expect(() => deserializeDocument(bad)).toThrow("only a core.instance");
    });

    test("SetInstanceOverrideAction merges field-by-field, clears with null, and is undoable", () => {
        const dispatcher = new ActionDispatcher(doc2());
        const d = () => dispatcher.getDocument();
        expect(dispatcher.dispatchAction(new SetInstanceOverrideAction(d(), "I", "MC", { geometry: { x: 60 } })).success).toBe(true);
        expect(dispatcher.dispatchAction(new SetInstanceOverrideAction(d(), "I", "MC", { geometry: { width: 44 } })).success).toBe(true);
        // MERGED, not replaced — the earlier x survives the later width.
        expect(d().nodes.get("I")!.overrides!.MC.geometry).toEqual({ x: 60, width: 44 });
        expect(expandInstances(d()).nodes.get("I::MC")!.geometry).toMatchObject({ x: 60, y: 5, width: 44 });
        dispatcher.dispatchAction(new SetInstanceOverrideAction(d(), "I", "MC", null)); // clear = reset to master
        expect(d().nodes.get("I")!.overrides!.MC).toBeUndefined();
        expect(expandInstances(d()).nodes.get("I::MC")!.geometry).toMatchObject({ x: 5, width: 20 });
        dispatcher.undo();
        expect(d().nodes.get("I")!.overrides!.MC.geometry).toEqual({ x: 60, width: 44 }); // undo restores it
    });

    test("SetInstanceOverrideAction rejects a non-instance target and an invalid value", () => {
        const dispatcher = new ActionDispatcher(doc2());
        const d = dispatcher.getDocument();
        expect(dispatcher.dispatchAction(new SetInstanceOverrideAction(d, "M", "MC", { text: "x" })).success).toBe(false);   // not an instance
        expect(dispatcher.dispatchAction(new SetInstanceOverrideAction(d, "nope", "MC", { text: "x" })).success).toBe(false);
        expect(dispatcher.dispatchAction(new SetInstanceOverrideAction(d, "I", "", { text: "x" })).success).toBe(false);
        expect(dispatcher.dispatchAction(new SetInstanceOverrideAction(d, "I", "MC", { style: { opacity: 9 } })).success).toBe(false); // shared styleError
        expect(dispatcher.canUndo()).toBe(false);
    });

    test("nodeEdit routes: a stored node edits directly, an instance COPY becomes an override", () => {
        const doc = doc2();
        const geoStored = geometryActionFor(doc, "MC", { x: 7 });
        const geoVirtual = geometryActionFor(doc, "I::MC", { x: 7 });
        expect(geoStored).toBeInstanceOf(UpdateNodeGeometryAction);
        expect(geoVirtual).toBeInstanceOf(SetInstanceOverrideAction);
        expect(styleActionFor(doc, "I::MC", { fill: "#abc" })).toBeInstanceOf(SetInstanceOverrideAction);
        // The override lands on the INSTANCE, keyed by the master node.
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(geometryActionFor(dispatcher.getDocument(), "I::MC", { x: 77 })!);
        expect(dispatcher.getDocument().nodes.get("I")!.overrides!.MC.geometry).toEqual({ x: 77 });
        // Unreachable targets return null rather than an action that would fail.
        expect(geometryActionFor(doc, "gone", { x: 1 })).toBeNull();
        // NESTED is expressible now (schema 28): the override lands on the stored instance
        // `I` under the path key `OI::deep`, which is the only node that can hold one.
        expect(geometryActionFor(doc, "I::OI::deep", { x: 1 })).not.toBeNull();
        expect(overrideTargetFor(doc, "I::OI::deep")).toEqual({ instanceId: "I", masterNodeId: "OI::deep" });
        expect(isEditableNode(doc, "I::MC")).toBe(true);
        expect(isEditableNode(doc, "I::OI::deep")).toBe(true);   // reachable via a path key
    });

    test("picking: a plain click selects the INSTANCE, an ALT (deep) pick selects the copy", () => {
        const cs = computeGeometry(doc2());
        expect(hitTest(cs, 310, 310)).toBe("I");                  // default: the instance
        expect(hitTest(cs, 310, 310, 0, true)).toBe("I::MC");      // deep: the copy under the pointer
        // A marquee never scatters into instance internals, deep or not.
        expect(nodesInRect(cs, { x: 290, y: 290, width: 200, height: 200 })).toEqual(["I"]);
    });

    test("MoveTool drags an instance COPY into an override (the master never moves)", () => {
        const dispatcher = new ActionDispatcher(doc2());
        const es = createEditorState(); es.selectedNodeIds = ["I::MC"];
        const tool = new MoveTool(dispatcher, es, () => { });
        const mev = (x: number, y: number) => ({ clientX: x, clientY: y } as unknown as MouseEvent);
        tool.onMouseDown(mev(0, 0));
        tool.onMouseMove(mev(30, 10));
        expect(es.pendingGeometry!.get("I::MC")).toEqual({ x: 35, y: 15 }); // preview on the VIRTUAL id
        tool.onMouseUp(mev(30, 10));
        expect(dispatcher.getDocument().nodes.get("I")!.overrides!.MC.geometry).toEqual({ x: 35, y: 15 });
        expect(dispatcher.getDocument().nodes.get("MC")!.geometry.x).toBe(5); // master untouched
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("I")!.overrides?.MC).toBeUndefined();
    });

    test("RESIZING an instance copy commits an override (the liveness check reads the EXPANDED tree)", () => {
        // The trap MoveTool's preview loop had, in the resize path: a virtual id is legitimately
        // absent from the stored map, so a stored-doc liveness check aborts on the FIRST frame.
        const doc = doc2();
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["I::MC"];
        const tc = new ToolController(dispatcher, es, () => { });
        const rect = { left: 0, top: 0 } as DOMRect;
        const md = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
        // The copy's world box is (305,305)-(325,325); grab its SE corner and drag +20,+20.
        tc.onMouseDown(md(325, 325), rect);
        tc.onMouseMove(md(345, 345), rect);
        expect(es.pendingGeometry!.get("I::MC")).toBeDefined(); // did NOT abort on the first move
        tc.onMouseUp(md(345, 345));
        expect(dispatcher.getDocument().nodes.get("I")!.overrides!.MC.geometry).toMatchObject({ width: 40, height: 40 });
        expect(dispatcher.getDocument().nodes.get("MC")!.geometry.width).toBe(20); // master untouched
    });

    test("a NEGATIVE override size is rejected — an override can't hold what no node may", () => {
        expect(overridesError("core.instance", { MC: { geometry: { width: -5 } } })).toMatch("width must be >= 0");
        expect(overridesError("core.instance", { MC: { geometry: { height: -1 } } })).toMatch("height must be >= 0");
        expect(overridesError("core.instance", { MC: { geometry: { width: 0 } } })).toBeNull(); // 0 is legal (a line axis)
        const dispatcher = new ActionDispatcher(doc2());
        expect(dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "I", "MC", { geometry: { width: -5 } })).success).toBe(false);
    });

    test("the master ROOT copy is not draggable (its position is the instance's, so a drag would revert)", () => {
        const dispatcher = new ActionDispatcher(doc2());
        const es = createEditorState(); es.selectedNodeIds = ["I::M"]; // the ROOT copy
        const tool = new MoveTool(dispatcher, es, () => { });
        const mev = (x: number, y: number) => ({ clientX: x, clientY: y } as unknown as MouseEvent);
        tool.onMouseDown(mev(0, 0));
        tool.onMouseMove(mev(40, 40));
        expect(es.pendingGeometry).toBeNull();          // no preview — the gesture never starts
        tool.onMouseUp(mev(40, 40));
        expect(dispatcher.canUndo()).toBe(false);       // and no no-op undo entry
    });

    test("a NESTED copy is editable too — the path key reaches through the inner instance", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("IM", { id: "IM", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#00f", opacity: 1 }, layout: {} });
        doc.nodes.set("OM", { id: "OM", type: "core.rectangle", parent: null, children: ["OI"], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("OI", { id: "OI", type: "core.instance", parent: "OM", children: [], geometry: { x: 5, y: 5, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "IM" });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 200, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "OM" });
        doc.rootNodeUuids = ["IM", "OM", "I"];
        expect(isEditableNode(doc, "I::OI::IM")).toBe(true);        // nested — key `OI::IM` on `I`
        expect(isEditableNode(doc, "I::OI")).toBe(true);            // …as is the direct copy
        expect(overrideTargetFor(doc, "I::OI::IM")).toEqual({ instanceId: "I", masterNodeId: "OI::IM" });
    });

    test("drawn, grabbable, and hovered agree — isHandleOffered is the ONE rule", () => {
        const doc = doc2();
        expect(isHandleOffered(doc, "MC", "rotate")).toBe(true);        // a stored node: everything
        expect(isHandleOffered(doc, "I::MC", "se")).toBe(true);         // a copy: resize corners…
        expect(isHandleOffered(doc, "I::MC", "rotate")).toBe(true);     // …and, since schema 26, the rotate knob
        expect(isHandleOffered(doc, "I::OI::deep", "se")).toBe(true);   // nested: reachable now
    });

    test("the hover cursor over a COPY's corner matches what a press would grab", () => {
        // The cursor resolved roots on the STORED document, where a virtual id doesn't exist, so
        // the pointer stayed an arrow over handles that were both drawn and grabbable.
        const dispatcher = new ActionDispatcher(doc2());
        const es = createEditorState(); es.selectedNodeIds = ["I::MC"];
        const tc = new ToolController(dispatcher, es, () => { });
        const rect = { left: 0, top: 0 } as DOMRect;
        const hover = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 0, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
        tc.onMouseMove(hover(325, 325), rect);   // the copy's SE corner (world box 305..325)
        expect(es.hoverCursor).toBe("nwse-resize");
        tc.onMouseMove(hover(500, 500), rect);   // empty space
        expect(es.hoverCursor).toBeNull();
    });

    test("a press on a NESTED copy's corner ARMS a resize — the handle now has a target", () => {
        // Before schema 28 this had to fall through: the renderer drew no handle and the picker
        // refused the grab, because a resize there could never commit. A path key gives it
        // somewhere to land, so the gesture is real and the two sites still agree.
        const doc = createEmptyDocument();
        doc.nodes.set("IM", { id: "IM", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#00f", opacity: 1 }, layout: {} });
        doc.nodes.set("OM", { id: "OM", type: "core.rectangle", parent: null, children: ["OI"], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("OI", { id: "OI", type: "core.instance", parent: "OM", children: [], geometry: { x: 5, y: 5, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "IM" });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 200, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "OM" });
        doc.rootNodeUuids = ["IM", "OM", "I"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["I::OI::IM"];
        let toolSawIt = false;
        const tc = new ToolController(dispatcher, es, () => { });
        tc.setTool({ onMouseDown: () => { toolSawIt = true; } });
        const rect = { left: 0, top: 0 } as DOMRect;
        const md = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
        // The nested copy's world box is (205,205)-(215,215); press its SE corner.
        tc.onMouseDown(md(215, 215), rect);
        tc.onMouseMove(md(235, 235), rect);
        expect(es.pendingGeometry).not.toBeNull();  // the resize IS armed
        expect(toolSawIt).toBe(false);              // …so the press did not fall through
    });

    test("EVERY editor entry point routes — no site dispatches a raw action at a virtual id", () => {
        // The failure mode this guards: a missed call site dispatches an action whose target
        // isn't in the stored document, `dispatchAction` returns success:false, and the control
        // silently does nothing. The App inspector was exactly such a site.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).not.toMatch(/new UpdateNodeGeometryAction\(/); // inspector routes via geometryActionFor
        expect(src).not.toMatch(/new UpdateNodeStyleAction\(/);    // …and styleActionFor
        const move = readFileSync(resolve(__dirname, "../../editor/tools/MoveTool.ts"), "utf8");
        expect(move).not.toMatch(/new UpdateNodeGeometryAction\(/);
        const tc = readFileSync(resolve(__dirname, "../../editor/tools/ToolController.ts"), "utf8");
        // The controller still constructs geometry actions for the GROUP-resize path (stored
        // roots only, never virtual), so assert the SINGLE-node resize commit is routed instead.
        expect(tc).toMatch(/geometryActionFor\(doc, this\.resizeNodeId/);
    });

    test("the TYPE-aware size rule applies to overrides too — the seam can't validate less", () => {
        // `overridesError` alone can't run `dimensionError` (it never sees the master's type), so
        // a 0-width copy of a RECTANGLE would slip through a check the stored node fails.
        const doc = doc2();
        expect(overrideAgainstMasterError(doc, doc.nodes.get("I")!)).toBeNull();          // no overrides
        const zero = doc2({ MC: { geometry: { width: 0 } } });
        expect(overrideAgainstMasterError(zero, zero.nodes.get("I")!)).toMatch("positive dimensions");
        // A partial override is judged against the master's OTHER axis — what expansion materializes.
        const partial = doc2({ MC: { geometry: { height: 0 } } });
        expect(overrideAgainstMasterError(partial, partial.nodes.get("I")!)).toMatch("positive dimensions");
        // A key resolving to no master stays inert, exactly like a dangling componentId.
        const dangling = doc2({ ghost: { geometry: { width: 0 } } });
        expect(overrideAgainstMasterError(dangling, dangling.nodes.get("I")!)).toBeNull();
        // EDIT path: the same patch is refused on the copy that is refused on the stored node.
        const dispatcher = new ActionDispatcher(doc2());
        expect(dispatcher.dispatchAction(geometryActionFor(dispatcher.getDocument(), "I::MC", { width: 0 })!).success).toBe(false);
        expect(dispatcher.dispatchAction(geometryActionFor(dispatcher.getDocument(), "MC", { width: 0 })!).success).toBe(false);
        // LOAD path: the identical document is rejected rather than materializing an illegal copy.
        expect(() => deserializeDocument(serializeDocument(zero))).toThrow("positive dimensions");
        // …and a type that legitimately allows a zero axis still may.
        const line = doc2({ MC: { geometry: { width: 0 } } });
        line.nodes.set("MC", { ...line.nodes.get("MC")!, type: "core.line" });
        expect(overrideAgainstMasterError(line, line.nodes.get("I")!)).toBeNull();
    });

    test("the ROOT copy's x/y is refused at the SEAM, not just by the tool that happens to check", () => {
        // Expansion discards a root override's x/y, so writing one dirties the document and pushes
        // an undo step for a gesture that changed nothing. Every edit site routes through here.
        const doc = doc2();
        expect(isMasterRootCopy(doc, "I::M")).toBe(true);
        expect(isMasterRootCopy(doc, "I::MC")).toBe(false);
        expect(isMasterRootCopy(doc, "M")).toBe(false);
        expect(geometryActionFor(doc, "I::M", { x: 40, y: 40 })).toBeNull();     // nothing left to write
        // A SIZE override on the root is honoured — only the position is dropped.
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(geometryActionFor(dispatcher.getDocument(), "I::M", { x: 40, width: 250 })!);
        expect(dispatcher.getDocument().nodes.get("I")!.overrides!.M.geometry).toEqual({ width: 250 });
    });

    test("an instance copy round-trips with its overrides", () => {
        const doc = doc2({ MC: { geometry: { x: 60 }, style: { fill: "#00f" }, text: "hello" } });
        const loaded = deserializeDocument(serializeDocument(doc));
        expect(loaded.nodes.get("I")!.overrides!.MC).toEqual({ geometry: { x: 60 }, style: { fill: "#00f" }, text: "hello" });
        expect(compareDocuments(doc, loaded)).toBe(true);
    });
});

// ─── M6 slice 3: detach — bake an instance into ordinary nodes ───
describe("Components: detach instance", () => {
    /** master M (100×50 at 10,20) with child MC (20×20 at 5,5); instance I at (300,300). */
    function doc3(overrides?: Record<string, import("../document/Components").InstanceOverride>): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: ["MC"], geometry: { x: 10, y: 20, width: 100, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("MC", { id: "MC", type: "core.rectangle", parent: "M", children: [], geometry: { x: 5, y: 5, width: 20, height: 20 }, style: { fill: "#0f0", opacity: 1 }, layout: {} });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 300, y: 300, width: 100, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M", ...(overrides ? { overrides } : {}) });
        doc.rootNodeUuids = ["M", "I"];
        return doc;
    }

    test("a detach bakes EXACTLY what the instance was drawing, in the same world positions", () => {
        // The whole promise of detach: the picture does not move. Compare the WORLD boxes of
        // the copies before against the stored nodes after.
        const dispatcher = new ActionDispatcher(doc3({ MC: { geometry: { x: 60 }, style: { fill: "#00f" } } }));
        const before = computeGeometry(dispatcher.getDocument());
        const rootBefore = before.nodes.get("I::M")!.bounds;
        const childBefore = before.nodes.get("I::MC")!.bounds;

        const action = new DetachInstanceAction(dispatcher.getDocument(), "I");
        expect(dispatcher.dispatchAction(action).success).toBe(true);
        const [newRoot, newChild] = action.getCreatedNodeIds();
        const d = dispatcher.getDocument();

        expect(d.nodes.has("I")).toBe(false);                       // the instance is gone…
        expect(d.nodes.get(newRoot)!.type).toBe("core.rectangle");  // …replaced by ordinary nodes
        expect(d.nodes.get(newRoot)!.componentId).toBeUndefined();  // …with no link to the master
        expect(d.nodes.get(newRoot)!.overrides).toBeUndefined();
        const after = computeGeometry(d);
        expect(after.nodes.get(newRoot)!.bounds).toEqual(rootBefore);
        expect(after.nodes.get(newChild)!.bounds).toEqual(childBefore);
        // The override is BAKED, not carried: the copy keeps the value, the master keeps its own.
        expect(d.nodes.get(newChild)!.style.fill).toBe("#00f");
        expect(d.nodes.get("MC")!.style.fill).toBe("#0f0");
        // The tree is well-formed and reloadable.
        expect(d.nodes.get(newChild)!.parent).toBe(newRoot);
        expect(d.nodes.get(newRoot)!.children).toEqual([newChild]);
        expect(() => deserializeDocument(serializeDocument(d))).not.toThrow();
    });

    test("the master goes on living: editing it no longer touches the detached copy", () => {
        const dispatcher = new ActionDispatcher(doc3());
        const action = new DetachInstanceAction(dispatcher.getDocument(), "I");
        dispatcher.dispatchAction(action);
        const [, newChild] = action.getCreatedNodeIds();
        dispatcher.dispatchAction(new UpdateNodeStyleAction(dispatcher.getDocument(), "MC", { fill: "#ff0" }));
        expect(dispatcher.getDocument().nodes.get(newChild)!.style.fill).toBe("#0f0"); // severed
    });

    test("the baked nodes own their objects — editing a copy never reaches back into the master", () => {
        // `materializeNode` shares style/layout by REFERENCE (safe for the read-only expanded
        // document); a detach produces MUTABLE stored nodes, so it must clone them.
        const dispatcher = new ActionDispatcher(doc3());
        const action = new DetachInstanceAction(dispatcher.getDocument(), "I");
        dispatcher.dispatchAction(action);
        const [, newChild] = action.getCreatedNodeIds();
        const d = dispatcher.getDocument();
        expect(d.nodes.get(newChild)!.style).not.toBe(d.nodes.get("MC")!.style);
        expect(d.nodes.get(newChild)!.layout).not.toBe(d.nodes.get("MC")!.layout);
        dispatcher.dispatchAction(new UpdateNodeStyleAction(dispatcher.getDocument(), newChild, { fill: "#abc" }));
        expect(dispatcher.getDocument().nodes.get("MC")!.style.fill).toBe("#0f0"); // master untouched
    });

    test("the baked root takes the instance's PLACE in the z-order, not the end of it", () => {
        const doc = doc3();
        doc.nodes.set("TOP", { id: "TOP", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#fff", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["M", "I", "TOP"];      // the instance sits BEHIND "TOP"
        const dispatcher = new ActionDispatcher(doc);
        const action = new DetachInstanceAction(dispatcher.getDocument(), "I");
        dispatcher.dispatchAction(action);
        const [newRoot] = action.getCreatedNodeIds();
        expect(dispatcher.getDocument().rootNodeUuids).toEqual(["M", newRoot, "TOP"]); // still behind
    });

    test("a NESTED instance survives as an instance — detaching the outer one is not recursive", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("IM", { id: "IM", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#00f", opacity: 1 }, layout: {} });
        doc.nodes.set("OM", { id: "OM", type: "core.rectangle", parent: null, children: ["OI"], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("OI", { id: "OI", type: "core.instance", parent: "OM", children: [], geometry: { x: 5, y: 5, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "IM" });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 200, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "OM" });
        doc.rootNodeUuids = ["IM", "OM", "I"];
        const dispatcher = new ActionDispatcher(doc);
        const action = new DetachInstanceAction(dispatcher.getDocument(), "I");
        dispatcher.dispatchAction(action);
        const [, nestedCopy] = action.getCreatedNodeIds();
        const d = dispatcher.getDocument();
        expect(d.nodes.get(nestedCopy)!.type).toBe("core.instance");
        expect(d.nodes.get(nestedCopy)!.componentId).toBe("IM");      // still linked to ITS master
        // …and it still expands, so the detached content keeps drawing the inner component.
        expect(expandInstances(d).nodes.has(`${nestedCopy}::IM`)).toBe(true);
        // Editing the INNER master still flows through, which is the point of not recursing.
        dispatcher.dispatchAction(new UpdateNodeStyleAction(dispatcher.getDocument(), "IM", { fill: "#0f0" }));
        expect(expandInstances(dispatcher.getDocument()).nodes.get(`${nestedCopy}::IM`)!.style.fill).toBe("#0f0");
    });

    test("detach is undoable — undo brings the instance back and takes the baked nodes away", () => {
        const dispatcher = new ActionDispatcher(doc3());
        const action = new DetachInstanceAction(dispatcher.getDocument(), "I");
        dispatcher.dispatchAction(action);
        const created = action.getCreatedNodeIds();
        dispatcher.undo();
        const undone = dispatcher.getDocument();
        expect(undone.nodes.has("I")).toBe(true);
        expect(undone.nodes.has(created[0])).toBe(false);
        expect(undone.rootNodeUuids).toEqual(["M", "I"]);
        dispatcher.redo();
        expect(dispatcher.getDocument().nodes.has(created[0])).toBe(true);
        expect(dispatcher.getDocument().nodes.has("I")).toBe(false);
    });

    test("executing the same detach twice yields the SAME ids (redo restores a snapshot, so this is the only path that re-runs it)", () => {
        // `getCreatedNodeIds()` is what the caller selects afterwards; a second run minting
        // fresh ids would strand that selection on nodes the document never received.
        const action = new DetachInstanceAction(doc3(), "I");
        const first = [...action.execute().propertyDeltas.keys()];
        const second = [...action.execute().propertyDeltas.keys()];
        expect(second).toEqual(first);
        expect(action.getCreatedNodeIds().length).toBe(2);
    });

    test("detach refuses what it cannot bake rather than deleting the node", () => {
        const doc = doc3();
        expect(new DetachInstanceAction(doc, "M").validate()).toBe(false);      // not an instance
        expect(new DetachInstanceAction(doc, "nope").validate()).toBe(false);
        // A DANGLING instance draws nothing, so there is nothing to bake — and the node stays.
        const dangling = doc3();
        dangling.nodes.set("I", { ...dangling.nodes.get("I")!, componentId: "ghost" });
        expect(new DetachInstanceAction(dangling, "I").validate()).toBe(false);
        const dispatcher = new ActionDispatcher(dangling);
        expect(dispatcher.dispatchAction(new DetachInstanceAction(dispatcher.getDocument(), "I")).success).toBe(false);
        expect(dispatcher.getDocument().nodes.has("I")).toBe(true);
        // A self-referential instance would copy itself into its own replacement.
        const selfRef = doc3();
        selfRef.nodes.set("I", { ...selfRef.nodes.get("I")!, componentId: "I" });
        expect(new DetachInstanceAction(selfRef, "I").validate()).toBe(false);
    });

    test("a detach INSIDE a container reparents onto the container, keeping the reflow", () => {
        const doc = doc3();
        doc.nodes.set("BOX", { id: "BOX", type: "core.rectangle", parent: null, children: ["I"], geometry: { x: 0, y: 0, width: 400, height: 400 }, style: { fill: "#111", opacity: 1 }, layout: { container: { direction: "row", gap: 10, padding: 5 } } });
        doc.nodes.set("I", { ...doc.nodes.get("I")!, parent: "BOX" });
        doc.rootNodeUuids = ["M", "BOX"];
        const dispatcher = new ActionDispatcher(doc);
        const action = new DetachInstanceAction(dispatcher.getDocument(), "I");
        const result = dispatcher.dispatchAction(action);
        const [newRoot] = action.getCreatedNodeIds();
        const d = dispatcher.getDocument();
        expect(d.nodes.get(newRoot)!.parent).toBe("BOX");
        expect(d.nodes.get("BOX")!.children).toEqual([newRoot]);
        expect(result.updatedNodeIds.has("BOX")).toBe(true);   // the container reflows around it
        expect(() => deserializeDocument(serializeDocument(d))).not.toThrow();
    });

    test("the App's Detach button is enabled exactly when the action would succeed", () => {
        // The button asks `validate()` rather than re-deriving the rule — the failure mode
        // being a control that looks available and silently does nothing.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/new DetachInstanceAction\(dispatcher\.getDocument\(\), sel\[0\]\)\.validate\(\)/);
    });

    test("an `add` delta places at its index, and still appends without one", () => {
        // The delta-layer capability detach needed: every other action appends.
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["A", "B"], geometry: { x: 0, y: 0, width: 99, height: 99 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        for (const id of ["A", "B"]) doc.nodes.set(id, { id, type: "core.rectangle", parent: "P", children: [], geometry: { x: 0, y: 0, width: 5, height: 5 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P"];
        const mk = (id: string): Node => ({ id, type: "core.rectangle", parent: "P", children: [], geometry: { x: 0, y: 0, width: 5, height: 5 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        applyMutationsToDocument(doc, new Map([["X", { kind: "add", node: mk("X"), index: 1 } as const]]));
        expect(doc.nodes.get("P")!.children).toEqual(["A", "X", "B"]);
        applyMutationsToDocument(doc, new Map([["Y", { kind: "add", node: mk("Y") } as const]]));
        expect(doc.nodes.get("P")!.children).toEqual(["A", "X", "B", "Y"]);   // no index = append
        // Out-of-range clamps rather than tearing a hole in the list.
        applyMutationsToDocument(doc, new Map([["Z", { kind: "add", node: mk("Z"), index: 99 } as const]]));
        expect(doc.nodes.get("P")!.children).toEqual(["A", "X", "B", "Y", "Z"]);
    });
});

// ─── Deferral: group RESIZE — pure scale math + eligibility ───
describe("GroupTransform (group resize math)", () => {
    test("scaleGroup scales positions about the fixed corner and sizes proportionally", () => {
        // Fixed corner (0,0), sx=2, sy=0.5. A at world (10,20) 30×40 (top-level: stored == world).
        const out = scaleGroup(0, 0, 2, 0.5, [
            { id: "A", startX: 10, startY: 20, worldX: 10, worldY: 20, startWidth: 30, startHeight: 40 }
        ]);
        expect(out[0]).toEqual({ id: "A", x: 20, y: 10, width: 60, height: 20 });
    });

    test("a NESTED root maps the world scale back to STORED coords (world ≠ stored)", () => {
        // Stored (10,10) under a parent at (500,500) → world (510,510). Fixed corner (500,500), sx=sy=2:
        // new world = 500 + (510−500)·2 = 520 → stored delta +10 → stored 20. A stored-space scale
        // (10 → 500 + (10−500)·2 = −480) would be wildly wrong — the far parent exposes any mixup.
        const out = scaleGroup(500, 500, 2, 2, [
            { id: "C", startX: 10, startY: 10, worldX: 510, worldY: 510, startWidth: 50, startHeight: 50 }
        ]);
        expect(out[0]).toEqual({ id: "C", x: 20, y: 20, width: 100, height: 100 });
    });

    test("sx=sy=1 is the identity (the Escape/no-move path)", () => {
        const input = { id: "A", startX: 7, startY: 9, worldX: 7, worldY: 9, startWidth: 30, startHeight: 40 };
        expect(scaleGroup(100, 100, 1, 1, [input])).toEqual([{ id: "A", x: 7, y: 9, width: 30, height: 40 }]);
    });

    test("isGroupResizable is STRICTER than rotatable: a rotated MEMBER disqualifies (shear)", () => {
        const doc = createEmptyDocument();
        const mk = (id: string, extra: object = {}) => doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {}, ...extra });
        mk("A"); mk("B");
        doc.rootNodeUuids = ["A", "B"];
        expect(isGroupResizable(doc, ["A", "B"])).toBe(true);
        expect(isGroupResizable(doc, [])).toBe(false);
        doc.nodes.get("A")!.transform = { rotation: 0.3 };
        expect(isGroupResizable(doc, ["A", "B"])).toBe(false); // rotated member → shear → ineligible
        expect(isGroupRotatable(doc, ["A", "B"])).toBe(true);  // …but still ROTATABLE (own rotation is fine there)
    });

    test("isGroupResizable rejects an in-flow auto-layout child (stored geometry is ignored)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("F", { id: "F", type: "core.rectangle", parent: null, children: ["A"], geometry: { x: 0, y: 0, width: 300, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: { container: { direction: "row" } } });
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: "F", children: [], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("B", { id: "B", type: "core.rectangle", parent: null, children: [], geometry: { x: 400, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["F", "B"];
        expect(isGroupResizable(doc, ["A", "B"])).toBe(false);
        doc.nodes.get("A")!.layout = { position: "absolute" }; // out of flow → stored x/y drives again
        expect(isGroupResizable(doc, ["A", "B"])).toBe(true);
    });

    test("groupCornerHandles sit on the union box; the knob wins an overlap in groupHandleAtPoint", () => {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number) => doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mk("A", 0, 0); mk("B", 100, 100); // union {0,0,150,150}
        doc.rootNodeUuids = ["A", "B"];
        const cs = computeGeometry(doc);
        const corners = groupCornerHandles(cs, ["A", "B"], 1);
        expect(corners.map(h => [h.handle, h.cx, h.cy])).toEqual([["nw", 0, 0], ["ne", 150, 0], ["sw", 0, 150], ["se", 150, 150]]);
        expect(corners.every(h => h.nodeId === "")).toBe(true);
        // Pick: corners only when includeCorners; the knob wins where both could match.
        expect(groupHandleAtPoint(cs, ["A", "B"], 150, 150, 1, true)!.handle).toBe("se");
        expect(groupHandleAtPoint(cs, ["A", "B"], 150, 150, 1)).toBeNull();          // corners excluded by default
        expect(groupHandleAtPoint(cs, ["A", "B"], 75, -ROTATE_OFFSET_PX, 1, true)!.handle).toBe("rotate");
    });
});

// ─── Deferral: ToolController group resize — a corner drag scales the whole group ───
describe("ToolController group resize", () => {
    const rect = { left: 0, top: 0 } as DOMRect;
    const md = (x: number, y: number) =>
        ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
    const key = (k: string) => ({ key: k, target: { tagName: "BODY", isContentEditable: false }, preventDefault() { } } as unknown as KeyboardEvent);

    function harness() {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number) => doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mk("A", 0, 0); mk("B", 100, 100); // union {0,0,150,150}
        doc.rootNodeUuids = ["A", "B"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tc = new ToolController(dispatcher, es, () => { });
        return { dispatcher, es, tc };
    }
    const geo = (d: ActionDispatcher, id: string) => d.getDocument().nodes.get(id)!.geometry;

    test("dragging the SE corner scales BOTH roots about the fixed NW corner, in ONE undo", () => {
        const { dispatcher, tc } = harness();
        tc.onMouseDown(md(150, 150), rect); // grab the group SE corner
        tc.onMouseMove(md(300, 225), rect); // +150,+75 → new extent 300×225 → sx=2, sy=1.5 about (0,0)
        tc.onMouseUp(md(300, 225));
        expect(geo(dispatcher, "A")).toEqual({ x: 0, y: 0, width: 100, height: 75 });
        expect(geo(dispatcher, "B")).toEqual({ x: 200, y: 150, width: 100, height: 75 });
        dispatcher.undo(); // ONE undo restores the whole group
        expect(geo(dispatcher, "A")).toEqual({ x: 0, y: 0, width: 50, height: 50 });
        expect(geo(dispatcher, "B")).toEqual({ x: 100, y: 100, width: 50, height: 50 });
        expect(dispatcher.canUndo()).toBe(false);
    });

    test("dragging the NW corner keeps the SE corner fixed", () => {
        const { dispatcher, tc } = harness();
        tc.onMouseDown(md(0, 0), rect);     // grab NW; fixed = (150,150)
        tc.onMouseMove(md(75, 75), rect);   // new extent 75×75 → sx=sy=0.5 about (150,150)
        tc.onMouseUp(md(75, 75));
        expect(geo(dispatcher, "A")).toEqual({ x: 75, y: 75, width: 25, height: 25 });
        expect(geo(dispatcher, "B")).toEqual({ x: 125, y: 125, width: 25, height: 25 });
    });

    test("Escape cancels the preview — nothing commits, no undo step", () => {
        const { dispatcher, es, tc } = harness();
        tc.onMouseDown(md(150, 150), rect);
        tc.onMouseMove(md(300, 300), rect);
        expect(es.pendingGeometry!.get("A")).toBeDefined(); // previewing
        tc.onKeyDown(key("Escape"));
        expect(es.pendingGeometry).toBeNull();
        tc.onMouseUp(md(300, 300));
        expect(geo(dispatcher, "A")).toEqual({ x: 0, y: 0, width: 50, height: 50 }); // untouched
        expect(dispatcher.canUndo()).toBe(false);
    });

    test("the extent clamps at 1 world unit — crossing the fixed corner cannot flip the group", () => {
        const { dispatcher, tc } = harness();
        tc.onMouseDown(md(150, 150), rect);   // SE grab, fixed (0,0)
        tc.onMouseMove(md(-200, -200), rect); // pointer far past the fixed corner
        tc.onMouseUp(md(-200, -200));
        const a = geo(dispatcher, "A"), b = geo(dispatcher, "B");
        expect(a.width).toBeGreaterThan(0);   // scaled tiny, never negative/flipped
        expect(b.x).toBeGreaterThanOrEqual(0); // B stays on A's far side (no mirror)
        expect(b.x).toBeLessThan(1.01);        // ≈ 150 · (1/150)
    });

    test("a corner press on an INELIGIBLE group (rotated member) does not resize", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {}, transform: { rotation: 0.3 } });
        doc.nodes.set("B", { id: "B", type: "core.rectangle", parent: null, children: [], geometry: { x: 100, y: 100, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["A", "B"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tc = new ToolController(dispatcher, es, () => { });
        const before = JSON.stringify(dispatcher.getDocument().nodes.get("B")!.geometry);
        tc.onMouseDown(md(150, 150), rect); // where the SE corner would be
        tc.onMouseMove(md(250, 250), rect);
        tc.onMouseUp(md(250, 250));
        expect(JSON.stringify(dispatcher.getDocument().nodes.get("B")!.geometry)).toBe(before);
        expect(dispatcher.canUndo()).toBe(false);
    });

    test("a ZERO-extent union axis locks at s=1 — the other axis still scales and COMMITS (no NaN)", () => {
        // Two horizontal lines at the same y: union height 0. Without the guard, sy = x/0 =
        // Infinity → NaN preview → every commit action fails validation → silent no-op drag.
        const doc = createEmptyDocument();
        const mkLine = (id: string, x: number) => doc.nodes.set(id, { id, type: "core.line", parent: null, children: [], geometry: { x, y: 100, width: 100, height: 0 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mkLine("L1", 0); mkLine("L2", 150); // union {0,100,250,0}
        doc.rootNodeUuids = ["L1", "L2"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["L1", "L2"];
        const tc = new ToolController(dispatcher, es, () => { });
        tc.onMouseDown(md(250, 100), rect);  // the degenerate box's SE corner
        tc.onMouseMove(md(375, 100), rect);  // stretch horizontally: extent 250→375 → sx=1.5
        tc.onMouseUp(md(375, 100));
        expect(geo(dispatcher, "L1")).toEqual({ x: 0, y: 100, width: 150, height: 0 });   // y/height LOCKED, x scaled
        expect(geo(dispatcher, "L2")).toEqual({ x: 225, y: 100, width: 150, height: 0 }); // 150·1.5
        expect(dispatcher.canUndo()).toBe(true); // the commit actually happened
    });

    test("a SUB-unit union axis is not force-grown by a drag on the OTHER axis", () => {
        // Two vertical lines 0.5 apart: union width 0.5. The old absolute-1 floor made
        // sx = 1/0.5 = 2 on a pure-vertical drag — unrequested horizontal growth that committed.
        const doc = createEmptyDocument();
        const mkV = (id: string, x: number) => doc.nodes.set(id, { id, type: "core.line", parent: null, children: [], geometry: { x, y: 0, width: 0, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mkV("V1", 10); mkV("V2", 10.5); // union {10,0,0.5,100}
        doc.rootNodeUuids = ["V1", "V2"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["V1", "V2"];
        const tc = new ToolController(dispatcher, es, () => { });
        tc.onMouseDown(md(10.5, 100), rect); // a bottom group corner (sw/se overlap within the grab square)
        tc.onMouseMove(md(10.5, 150), rect); // pure vertical drag: heights 100→150
        tc.onMouseUp(md(10.5, 150));
        // BOTH x positions untouched — assert the MOVING member too (the fixed-corner one is
        // trivially unchanged; a survived mutant taught that lesson).
        expect(geo(dispatcher, "V1").x).toBe(10);
        expect(geo(dispatcher, "V2").x).toBe(10.5);
        expect(geo(dispatcher, "V1").height).toBe(150);
        expect(geo(dispatcher, "V2").height).toBe(150);
    });

    test("idle hover over a GROUP corner shows its resize cursor (press/hover parity)", () => {
        const { es, tc } = harness();
        const hover = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 0, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
        tc.onMouseMove(hover(150, 150), rect); // the group SE corner
        expect(es.hoverCursor).toBe("nwse-resize");
        tc.onMouseMove(hover(150, 0), rect);   // NE corner
        expect(es.hoverCursor).toBe("nesw-resize");
    });

    test("a NESTED eligible root scales in world space (stored maps 1:1)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["C"], geometry: { x: 500, y: 500, width: 400, height: 400 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: "P", children: [], geometry: { x: 10, y: 10, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} }); // world (510,510)
        doc.nodes.set("B", { id: "B", type: "core.rectangle", parent: null, children: [], geometry: { x: 610, y: 610, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "B"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["C", "B"]; // union {510,510,150,150}
        const tc = new ToolController(dispatcher, es, () => { });
        tc.onMouseDown(md(660, 660), rect); // SE corner of the union
        tc.onMouseMove(md(810, 810), rect); // extent 150→300 → sx=sy=2 about world (510,510)
        tc.onMouseUp(md(810, 810));
        // C's world (510,510) is the fixed corner → stays; stored stays 10,10; size doubles.
        expect(geo(dispatcher, "C")).toEqual({ x: 10, y: 10, width: 100, height: 100 });
        // B world (610,610) → 510+100·2 = 710 (top-level stored == world).
        expect(geo(dispatcher, "B")).toEqual({ x: 710, y: 710, width: 100, height: 100 });
    });
});

// ─── M4: ToolController group rotate — the group knob spins every root about the box centre ───
describe("ToolController group rotate", () => {
    const rect = { left: 0, top: 0 } as DOMRect;
    const md = (x: number, y: number) =>
        ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
    const key = (k: string) => ({ key: k, target: { tagName: "BODY", isContentEditable: false }, preventDefault() { } } as unknown as KeyboardEvent);

    function harness() {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number) => doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mk("A", 0); mk("B", 200); // union {0,0,300,100}, centre (150,50); knob at (150,-ROTATE_OFFSET_PX)
        doc.rootNodeUuids = ["A", "B"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tc = new ToolController(dispatcher, es, () => { });
        return { dispatcher, es, tc };
    }
    const geoRot = (d: ActionDispatcher, id: string) => {
        const n = d.getDocument().nodes.get(id)!;
        return { x: n.geometry.x, y: n.geometry.y, rotation: n.transform?.rotation ?? 0 };
    };

    test("the group knob rotates every root rigidly about the group-box centre, in ONE coalesced undo", () => {
        const { dispatcher, tc } = harness();
        tc.onMouseDown(md(150, -ROTATE_OFFSET_PX), rect); // grab the group knob (straight up from the pivot)
        tc.onMouseMove(md(200, -30), rect);               // an intermediate frame
        tc.onMouseMove(md(230, 20), rect);                // another
        tc.onMouseMove(md(250, 50), rect);                // pointer due-right of pivot → +90° (π/2) total
        tc.onMouseUp(md(250, 50));
        const A = geoRot(dispatcher, "A"), B = geoRot(dispatcher, "B");
        expect(A.rotation).toBeCloseTo(Math.PI / 2, 9); expect(B.rotation).toBeCloseTo(Math.PI / 2, 9);
        expect(A.x).toBeCloseTo(100, 9); expect(A.y).toBeCloseTo(-100, 9); // left box orbits to the top
        expect(B.x).toBeCloseTo(100, 9); expect(B.y).toBeCloseTo(100, 9);  // right box orbits to the bottom
        dispatcher.undo(); // the 3 frames coalesced → ONE undo restores the whole group
        expect(geoRot(dispatcher, "A")).toEqual({ x: 0, y: 0, rotation: 0 });
        expect(geoRot(dispatcher, "B")).toEqual({ x: 200, y: 0, rotation: 0 });
        expect(dispatcher.canUndo()).toBe(false); // exactly one undo step for the whole drag
    });

    test("a press that is NOT on the group knob does not rotate (falls through to the tool)", () => {
        const { dispatcher, tc } = harness();
        tc.onMouseDown(md(150, 50), rect); // the group-box CENTRE, not the knob (which is above the box)
        tc.onMouseMove(md(250, 50), rect);
        tc.onMouseUp(md(250, 50));
        expect(geoRot(dispatcher, "A")).toEqual({ x: 0, y: 0, rotation: 0 }); // untouched
        expect(dispatcher.canUndo()).toBe(false);
    });

    test("Escape cancels an in-flight group rotate — reverts every root to its start pose", () => {
        const { dispatcher, es, tc } = harness();
        tc.onMouseDown(md(150, -ROTATE_OFFSET_PX), rect);
        tc.onMouseMove(md(250, 50), rect); // rotated +90°
        expect(geoRot(dispatcher, "A").rotation).toBeCloseTo(Math.PI / 2, 9);
        tc.onKeyDown(key("Escape"));
        expect(geoRot(dispatcher, "A")).toEqual({ x: 0, y: 0, rotation: 0 }); // A back to start
        expect(geoRot(dispatcher, "B")).toEqual({ x: 200, y: 0, rotation: 0 }); // B back to start
        expect(es.isDragging).toBe(false);
        tc.onMouseUp(md(250, 50)); // already cancelled → no further change
        expect(geoRot(dispatcher, "A")).toEqual({ x: 0, y: 0, rotation: 0 });
    });

    test("deleting a group member mid-drag ends the gesture and clears the drag-cursor flag", () => {
        const { dispatcher, es, tc } = harness();
        tc.onMouseDown(md(150, -ROTATE_OFFSET_PX), rect);
        expect(es.isDragging).toBe(true);
        // Delete BOTH roots mid-drag → the group is gone → the gesture must end cleanly.
        dispatcher.dispatchAction(new TransactionAction(dispatcher.getDocument(), "del", [
            new DeleteNodeAction(dispatcher.getDocument(), "A"), new DeleteNodeAction(dispatcher.getDocument(), "B")
        ]));
        tc.onMouseMove(md(250, 50), rect); // abort path: no root survives
        expect(es.isDragging).toBe(false);
    });

    test("group rotate is disabled when a root is NOT rotatable (a rotated parent) — the knob isn't grabbable", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["C"], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {}, transform: { rotation: 0.3 } });
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: "P", children: [], geometry: { x: 0, y: 0, width: 40, height: 40 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("R", { id: "R", type: "core.rectangle", parent: null, children: [], geometry: { x: 200, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "R"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["C", "R"]; // C sits under a ROTATED parent → not rotatable
        const tc = new ToolController(dispatcher, es, () => { });
        // Wherever the union knob would be, isGroupRotatable is false → no rotate gesture starts.
        tc.onMouseDown(md(0, -ROTATE_OFFSET_PX), rect);
        tc.onMouseMove(md(100, 100), rect);
        tc.onMouseUp(md(100, 100));
        expect(dispatcher.canUndo()).toBe(false); // nothing rotated
    });

    test("group rotate does not engage for an in-flow auto-layout group (orbit would be discarded)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("F", { id: "F", type: "core.rectangle", parent: null, children: ["A", "B"], geometry: { x: 0, y: 0, width: 300, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: { container: { direction: "row" } } });
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: "F", children: [], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("B", { id: "B", type: "core.rectangle", parent: "F", children: [], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["F"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tc = new ToolController(dispatcher, es, () => { });
        tc.onMouseDown(md(100, -ROTATE_OFFSET_PX), rect); // A,B are laid out → not rotatable → knob not grabbable
        tc.onMouseMove(md(200, 50), rect);
        tc.onMouseUp(md(200, 50));
        expect(dispatcher.canUndo()).toBe(false);
        expect(es.isDragging).toBe(false);
    });

    test("two group-rotate gestures on DIFFERENT selections do NOT coalesce (each is its own undo)", () => {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number) => doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y: 0, width: 100, height: 100 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mk("A", 0); mk("B", 200); mk("C", 500); mk("D", 700); // two DISJOINT pairs (gesture 1 doesn't disturb pair 2)
        doc.rootNodeUuids = ["A", "B", "C", "D"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState();
        const tc = new ToolController(dispatcher, es, () => { });
        es.selectedNodeIds = ["A", "B"]; // gesture 1: union {0,0,300,100}, knob (150,-off)
        tc.onMouseDown(md(150, -ROTATE_OFFSET_PX), rect); tc.onMouseMove(md(250, 50), rect); tc.onMouseUp(md(250, 50));
        es.selectedNodeIds = ["C", "D"]; // gesture 2 (same window): union {500,0,300,100}, knob (650,-off)
        tc.onMouseDown(md(650, -ROTATE_OFFSET_PX), rect); tc.onMouseMove(md(750, 50), rect); tc.onMouseUp(md(750, 50));
        // Names differ ("rotate-group:A,B" vs ":C,D") → they did NOT merge: TWO undo steps, not one.
        expect(dispatcher.canUndo()).toBe(true);
        dispatcher.undo(); expect(dispatcher.canUndo()).toBe(true);  // undid gesture 2 only
        dispatcher.undo(); expect(dispatcher.canUndo()).toBe(false); // undid gesture 1
    });

    test("idle hover over the group knob sets the grab cursor (the Canvas hover affordance)", () => {
        const { es, tc } = harness();
        const hover = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 0, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
        tc.onMouseMove(hover(150, -ROTATE_OFFSET_PX), rect); // idle over the group knob
        expect(es.hoverCursor).toBe("grab");
        tc.onMouseMove(hover(150, 50), rect); // idle over the box body (no handle)
        expect(es.hoverCursor).toBeNull();
    });

    test("Escape after a >coalesce-window pause fully cancels a group rotate — undo does not resurrect it", () => {
        const { dispatcher, tc } = harness();
        const nowSpy = jest.spyOn(Date, "now");
        try {
            nowSpy.mockReturnValue(1000);
            tc.onMouseDown(md(150, -ROTATE_OFFSET_PX), rect);
            tc.onMouseMove(md(200, -30), rect); // frame 1 @ t=1000
            nowSpy.mockReturnValue(2000);        // >window
            tc.onMouseMove(md(250, 50), rect);   // frame 2 @ t=2000 → a separate revision
            tc.onKeyDown(key("Escape"));         // rollback erases both
        } finally { nowSpy.mockRestore(); }
        expect(geoRot(dispatcher, "A")).toEqual({ x: 0, y: 0, rotation: 0 });   // fully reverted
        expect(geoRot(dispatcher, "B")).toEqual({ x: 200, y: 0, rotation: 0 });
        expect(dispatcher.canUndo()).toBe(false); // no resurrectable rotated revision via undo…
        expect(dispatcher.canRedo()).toBe(false); // …nor via redo (revisions truncated)
    });

    test("grabbing the group knob and pressing Escape with NO drag commits nothing", () => {
        const { dispatcher, tc } = harness();
        tc.onMouseDown(md(150, -ROTATE_OFFSET_PX), rect);
        tc.onKeyDown(key("Escape"));
        expect(dispatcher.canUndo()).toBe(false);
    });
});

// ─── M4: alignment snapping — the pure geometry behind smart guides ───
describe("computeSnap", () => {
    const A = { x: 100, y: 100, width: 50, height: 50 }; // X lines 100/125/150, Y lines 100/125/150

    test("snaps a near left edge and emits a vertical guide spanning both nodes", () => {
        // moving left 97 is within 6 of A's left 100 → dx +3; far in Y → dy 0.
        const r = computeSnap({ x: 97, y: 300, width: 20, height: 20 }, [A], 6);
        expect([r.dx, r.dy]).toEqual([3, 0]);
        expect(r.guides).toEqual([{ axis: "x", pos: 100, start: 100, end: 320 }]);
    });

    test("snaps both centres and emits a vertical + a horizontal guide", () => {
        // moving centre (124,124) within 6 of A's centre (125,125) → dx +1, dy +1.
        const r = computeSnap({ x: 112, y: 112, width: 24, height: 24 }, [A], 6);
        expect([r.dx, r.dy]).toEqual([1, 1]);
        expect(r.guides).toEqual([
            { axis: "x", pos: 125, start: 100, end: 150 },
            { axis: "y", pos: 125, start: 100, end: 150 }
        ]);
    });

    test("no alignment within threshold → no move, no guides", () => {
        const r = computeSnap({ x: 200, y: 300, width: 30, height: 30 }, [A], 6);
        expect([r.dx, r.dy, r.guides.length]).toEqual([0, 0, 0]);
    });

    test("chooses the CLOSEST alignment among several candidates", () => {
        // moving X 96/111/126: left→left is +4, but moving-right(126)→A-centre(125) is −1 (closer).
        const r = computeSnap({ x: 96, y: 300, width: 30, height: 20 }, [A], 6);
        expect(r.dx).toBe(-1); // the −1 candidate wins over +4
    });

    test("empty targets → zero snap, no guides", () => {
        expect(computeSnap(A, [], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
    });

    test("merges guides from multiple targets aligned at the same coordinate", () => {
        const B = { x: 100, y: 300, width: 50, height: 50 }; // same left edge (100) as A
        const r = computeSnap({ x: 97, y: 180, width: 20, height: 20 }, [A, B], 6);
        expect(r.dx).toBe(3);
        // ONE merged vertical guide at x=100, spanning A, B, and the moving node in y.
        expect(r.guides).toEqual([{ axis: "x", pos: 100, start: 100, end: 350 }]);
    });

    test("snapPoint snaps a POINT's x and y to target lines, independently", () => {
        expect(snapPoint(97, 300, [A], 6)).toEqual({ dx: 3, dy: 0 });   // x near A's left (100); y far
        expect(snapPoint(123, 148, [A], 6)).toEqual({ dx: 2, dy: 2 });  // x near A's centre (125); y near A's right (150)
        expect(snapPoint(200, 300, [A], 6)).toEqual({ dx: 0, dy: 0 });  // both far → no snap
    });

    test("guidesForRect emits a guide for a coincident edge (no snapping)", () => {
        const rect = { x: 100, y: 100, width: 50, height: 50 };  // x-lines 100/125/150
        const target = { x: 100, y: 300, width: 80, height: 50 }; // x-lines 100/140/180 — shares ONLY the left edge
        expect(guidesForRect(rect, [target])).toEqual([{ axis: "x", pos: 100, start: 100, end: 350 }]);
    });
});

describe("rulerTicks / niceStep", () => {
    test("niceStep rounds up to 1/2/5 × 10ᵏ", () => {
        expect(niceStep(80)).toBe(100);   // 8 → 10
        expect(niceStep(40)).toBe(50);     // 4 → 5
        expect(niceStep(160)).toBe(200);   // 1.6 → 2
        expect(niceStep(3)).toBe(5);
        expect(niceStep(0.4)).toBe(0.5);
        expect(niceStep(0)).toBe(1);       // guard: non-positive → 1
        expect(niceStep(NaN)).toBe(1);
    });

    test("emits ticks at a zoom-adaptive nice step across the visible range", () => {
        // zoom 1 → step niceStep(80) = 100.
        expect(rulerTicks(0, 250, 1)).toEqual([
            { world: 0, label: "0", major: true },
            { world: 100, label: "100", major: false },
            { world: 200, label: "200", major: false }
        ]);
        // zoom 2 → targetPx/zoom = 40 → step 50 (denser).
        expect(rulerTicks(0, 100, 2).map(t => t.world)).toEqual([0, 50, 100]);
        // every 5th tick is major (index 5 = world 500 here, not index 4).
        const big = rulerTicks(0, 600, 1); // step 100, indices 0..6
        expect(big.find(t => t.world === 500)!.major).toBe(true);
        expect(big.find(t => t.world === 400)!.major).toBe(false);
    });

    test("labels are integers for a ≥1 step and decimals for a sub-unit step", () => {
        expect(rulerTicks(0, 2, 200).map(t => t.label)).toEqual(["0.0", "0.5", "1.0", "1.5", "2.0"]); // step 0.5
    });

    test("degenerate / pathological ranges yield no ticks (never explode)", () => {
        expect(rulerTicks(50, 50, 1)).toEqual([]);   // empty range
        expect(rulerTicks(NaN, 100, 1)).toEqual([]); // non-finite
        expect(rulerTicks(0, 1e12, 0.001)).toEqual([]); // huge span → capped to []
    });
});

describe("isTranslationOnlyChain", () => {
    function chainDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        const mk = (id: string, parent: string | null, extra: Partial<Node> = {}) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, ...extra });
        mk("top", null);
        mk("Pt", null, { children: ["Ct"] }); mk("Ct", "Pt");                    // translated (no transform) parent + child
        mk("Pr", null, { children: ["Cr"], transform: { rotation: 0.1 } }); mk("Cr", "Pr"); // ROTATED parent + unrotated child
        mk("selfr", null, { transform: { scaleX: 2 } });                         // self scaled
        doc.rootNodeUuids = ["top", "Pt", "Pr", "selfr"];
        return doc;
    }

    test("true iff the node AND every ancestor are unrotated/unscaled", () => {
        const doc = chainDoc();
        expect(isTranslationOnlyChain(doc, "top")).toBe(true);   // top-level, no transform
        expect(isTranslationOnlyChain(doc, "Ct")).toBe(true);    // child of a translated parent
        expect(isTranslationOnlyChain(doc, "Cr")).toBe(false);   // child of a ROTATED parent — walks up and fails
        expect(isTranslationOnlyChain(doc, "selfr")).toBe(false); // self scaled
        expect(isTranslationOnlyChain(doc, "nope")).toBe(false);  // missing node
    });
});

describe("snapTargetsExcludingSubtree", () => {
    function doc3(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["C"], geometry: { x: 0, y: 0, width: 200, height: 200 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: "P", children: [], geometry: { x: 10, y: 10, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("T", { id: "T", type: "core.rectangle", parent: null, children: [], geometry: { x: 300, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "T"];
        return doc;
    }

    test("excludes the root AND its descendants; keeps everything else", () => {
        const doc = doc3();
        const cs = computeGeometry(doc);
        // Dragging P excludes P and its child C → only T remains.
        expect(snapTargetsExcludingSubtree(doc, cs, "P")).toEqual([{ x: 300, y: 0, width: 50, height: 50 }]);
        // Dragging the leaf C excludes only C → P and T remain.
        const forC = snapTargetsExcludingSubtree(doc, cs, "C");
        expect(forC.length).toBe(2);
        expect(forC).toContainEqual({ x: 300, y: 0, width: 50, height: 50 });   // T
        expect(forC).toContainEqual({ x: 0, y: 0, width: 200, height: 200 });   // P (world == stored, top-level)
    });

    test("snapTargetsExcludingSubtrees excludes EVERY listed root's subtree (group move)", () => {
        const doc = doc3();
        const cs = computeGeometry(doc);
        // A group of {P, T} moving together excludes P, its child C, AND T → nothing left to snap to.
        expect(snapTargetsExcludingSubtrees(doc, cs, ["P", "T"])).toEqual([]);
        // A duplicate id in the list is idempotent (a Set) → {T, T} still excludes just T's subtree.
        const forT = snapTargetsExcludingSubtrees(doc, cs, ["T", "T"]);
        expect(forT.length).toBe(2);
        expect(forT).toContainEqual({ x: 0, y: 0, width: 200, height: 200 });   // P
        expect(forT).toContainEqual({ x: 10, y: 10, width: 50, height: 50 });   // C (world == stored)
    });
});

// ─── M4: MoveTool folds snapping into the drag (single top-level node) ───
describe("MoveTool snapping", () => {
    const md = (x: number, y: number) => ({ clientX: x, clientY: y } as unknown as MouseEvent);

    function twoNodeDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number, w: number, h: number) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: w, height: h }, style: { fill: "#000", opacity: 1 }, layout: {} });
        mk("A", 0, 0, 50, 50); mk("B", 100, 100, 60, 60);
        doc.rootNodeUuids = ["A", "B"];
        return doc;
    }

    test("a single top-level node snaps its edge to another and shows a guide", () => {
        const doc = twoNodeDoc();
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(97, 0)); // drag A's left to 97 → within 6 of B's left (100) → snaps to 100
        expect(es.pendingGeometry!.get("A")).toEqual({ x: 100, y: 0 }); // 97 snapped to 100
        expect(es.snapGuides && es.snapGuides.length).toBeGreaterThan(0);
        tool.onMouseUp(md(97, 0));
        expect(dispatcher.getDocument().nodes.get("A")!.geometry.x).toBe(100); // committed at the snapped x
        expect(es.snapGuides).toBeNull(); // cleared on release
    });

    test("snaps on the Y axis too (a downward drag aligns top edges)", () => {
        const doc = twoNodeDoc(); // A{0,0,50,50}, B{100,100,60,60}
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(0, 97)); // A's top to y=97 → within 6 of B's top (100) → snaps to 100
        expect(es.pendingGeometry!.get("A")).toEqual({ x: 0, y: 100 }); // 97 snapped to 100 on Y
    });

    test("a zero-movement click does NOT snap or commit (a click is not a drag)", () => {
        const doc = twoNodeDoc();
        doc.nodes.get("A")!.geometry.x = 97; // A already sits within 6 of B's left edge (100)
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseUp(md(0, 0)); // no movement
        expect(dispatcher.getDocument().nodes.get("A")!.geometry.x).toBe(97); // NOT nudged to 100
        expect(dispatcher.canUndo()).toBe(false); // no action committed
    });

    test("a nested node (translated parent) snaps in WORLD space — the delta maps 1:1 to stored", () => {
        const doc = createEmptyDocument();
        // Parent far away so the snap ONLY works via the WORLD origin (the stored value 97 is near NO target).
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["C"], geometry: { x: 500, y: 500, width: 400, height: 400 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: "P", children: [], geometry: { x: 10, y: 10, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} }); // world (510,510)
        doc.nodes.set("T", { id: "T", type: "core.rectangle", parent: null, children: [], geometry: { x: 600, y: 510, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "T"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["C"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(87, 0)); // C's world left 510→597, within 6 of T's left (600) → snaps; stored += (87+3)
        expect(es.pendingGeometry!.get("C")).toEqual({ x: 100, y: 10 }); // stored 10 + 87 + 3(snap) — a stored-origin snap would give 97
        expect(es.snapGuides).toContainEqual(expect.objectContaining({ axis: "x", pos: 600 })); // guide at T's world edge
    });

    test("a transformed (rotated) node does not snap — its world delta ≠ its stored delta", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {}, transform: { rotation: 0.1 } });
        doc.nodes.set("T", { id: "T", type: "core.rectangle", parent: null, children: [], geometry: { x: 100, y: 100, width: 60, height: 60 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["C", "T"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["C"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(97, 0)); // near T's left (100), but C is rotated → snapping disabled
        expect(es.pendingGeometry!.get("C")).toEqual({ x: 97, y: 0 }); // raw 97, NOT snapped
        expect(es.snapGuides).toBeNull();
    });

    test("a dragged parent does not snap to its OWN child (the moving subtree is excluded)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["C"], geometry: { x: 0, y: 0, width: 200, height: 200 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: "P", children: [], geometry: { x: 10, y: 10, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} }); // world left 10
        doc.nodes.set("T", { id: "T", type: "core.rectangle", parent: null, children: [], geometry: { x: 300, y: 500, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "T"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["P"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(5, 0)); // P's left to 5 — within 6 of its child C's left (10), but C moves WITH P
        expect(es.pendingGeometry!.get("P")).toEqual({ x: 5, y: 0 }); // NOT snapped to the child's 10
        expect(es.snapGuides).toBeNull();
    });

    // ─── group (multi-root) move snapping: the union box snaps, all roots move together ───
    const mk = (doc: ProjectDocument, id: string, x: number, y: number, w: number, h: number, extra: Partial<import("../document/Node").Node> = {}) =>
        doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: w, height: h }, style: { fill: "#000", opacity: 1 }, layout: {}, ...extra });

    test("a group drag snaps the UNION box's left edge to a target and moves all roots together", () => {
        const doc = createEmptyDocument();
        mk(doc, "A", 0, 0, 50, 50); mk(doc, "B", 0, 60, 50, 50); // union {0,0,50,110}, left edge 0
        mk(doc, "T", 100, 0, 80, 50); // target left edge at 100
        doc.rootNodeUuids = ["A", "B", "T"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(97, 0)); // group left 0→97, within 6 of T's left (100) → snaps +3
        expect(es.pendingGeometry!.get("A")).toEqual({ x: 100, y: 0 });   // both get the SAME snapped dx (100)
        expect(es.pendingGeometry!.get("B")).toEqual({ x: 100, y: 60 });
        expect(es.snapGuides).toContainEqual(expect.objectContaining({ axis: "x", pos: 100 }));
        tool.onMouseUp(md(97, 0));
        expect(dispatcher.getDocument().nodes.get("A")!.geometry.x).toBe(100);
        expect(dispatcher.getDocument().nodes.get("B")!.geometry.x).toBe(100);
        expect(es.snapGuides).toBeNull();
    });

    test("group snap uses the UNION's far edge (from a non-first root), not just the first node's box", () => {
        const doc = createEmptyDocument();
        mk(doc, "A", 0, 0, 50, 50); mk(doc, "B", 0, 60, 50, 50); // union bottom (110) comes from B, not A (50)
        mk(doc, "T", 300, 200, 50, 50); // target top edge at 200 (x far, so no x-snap)
        doc.rootNodeUuids = ["A", "B", "T"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(0, 87)); // union bottom 110→197, within 6 of T's top (200) → snaps +3
        expect(es.pendingGeometry!.get("A")).toEqual({ x: 0, y: 90 });  // +90 = 87 + 3(snap); a first-node-only box (bottom 50) would NOT snap here
        expect(es.pendingGeometry!.get("B")).toEqual({ x: 0, y: 150 });
        expect(es.snapGuides).toContainEqual(expect.objectContaining({ axis: "y", pos: 200 }));
    });

    test("group snap uses the UNION's RIGHT edge (from a non-first root) on the X axis too", () => {
        const doc = createEmptyDocument();
        mk(doc, "A", 0, 0, 50, 50); mk(doc, "B", 80, 0, 50, 50); // union right (130) comes from B, not A (50)
        mk(doc, "T", 230, 200, 40, 50); // target LEFT edge at 230 (y far, so no y-snap)
        doc.rootNodeUuids = ["A", "B", "T"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(97, 0)); // union right 130→227, within 6 of T's left (230) → snaps +3
        expect(es.pendingGeometry!.get("A")).toEqual({ x: 100, y: 0 });  // +100 = 97+3; a first-node box (right 50) would NOT snap
        expect(es.pendingGeometry!.get("B")).toEqual({ x: 180, y: 0 });
        expect(es.snapGuides).toContainEqual(expect.objectContaining({ axis: "x", pos: 230 }));
    });

    test("a member deleted mid-drag stops snapping (no snap against a stale group box)", () => {
        const doc = createEmptyDocument();
        mk(doc, "A", 0, 0, 50, 50); mk(doc, "B", 0, 60, 50, 50); mk(doc, "T", 100, 0, 80, 50);
        doc.rootNodeUuids = ["A", "B", "T"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(97, 0)); // snaps normally: group left 0→97 → 100
        expect(es.pendingGeometry!.get("A")).toEqual({ x: 100, y: 0 });
        dispatcher.dispatchAction(new DeleteNodeAction(dispatcher.getDocument(), "A")); // A deleted mid-drag
        tool.onMouseMove(md(97, 0)); // the captured group box now includes a gone node → snapping stops
        expect(es.pendingGeometry!.get("B")).toEqual({ x: 97, y: 60 }); // raw 97, NOT snapped to 100
        expect(es.pendingGeometry!.has("A")).toBe(false);              // A dropped from the drag set
        expect(es.snapGuides).toBeNull();
    });

    test("a group drag does NOT snap to its own members (every moving subtree is excluded)", () => {
        const doc = twoNodeDoc(); // only A,B exist — both selected/moving, so there is no external target
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(97, 0));
        expect(es.pendingGeometry!.get("A")).toEqual({ x: 97, y: 0 });   // raw delta — nothing to snap to
        expect(es.pendingGeometry!.get("B")).toEqual({ x: 197, y: 100 }); // B shifts by the same raw delta
        expect(es.snapGuides).toBeNull();
    });

    test("group snap is disabled when ANY moving root is transformed (rotated)", () => {
        const doc = createEmptyDocument();
        mk(doc, "A", 0, 0, 50, 50, { transform: { rotation: 0.2 } }); // one rotated root disables the whole group
        mk(doc, "B", 0, 60, 50, 50);
        mk(doc, "T", 100, 0, 80, 50);
        doc.rootNodeUuids = ["A", "B", "T"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A", "B"];
        const tool = new MoveTool(dispatcher, es, () => { });
        tool.onMouseDown(md(0, 0));
        tool.onMouseMove(md(97, 0)); // near T's left (100), but A is rotated → snapping disabled
        expect(es.pendingGeometry!.get("B")).toEqual({ x: 97, y: 60 }); // raw 97, NOT snapped to 100
        expect(es.snapGuides).toBeNull();
    });
});

// ─── Undo/redo reports a real dirty set (Milestone 1 dirty-state tracking) ───
describe("Restore dirty set", () => {
    test("undo reports only the nodes that actually changed", () => {
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new MoveNodeAction(doc, "child-001", 999, 999));

        let seen: Set<string> | null = null;
        dispatcher.onChange(r => { if (r.fullReload) seen = r.updatedNodeIds; });
        dispatcher.undo();

        expect(seen).not.toBeNull();
        expect([...seen!]).toEqual(["child-001"]); // not all three nodes
    });

    test("undoing an add reports just the added node", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);
        const add = new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 10, "#fff", "n1");
        dispatcher.dispatchAction(add);

        let seen: Set<string> | null = null;
        dispatcher.onChange(r => { if (r.fullReload) seen = r.updatedNodeIds; });
        dispatcher.undo();

        expect([...seen!]).toEqual(["n1"]);
    });
});

// ─── Document integrity is enforced on the LOAD path, not just on edits ───
describe("Document integrity validation", () => {
    const envelope = (nodes: Record<string, any>, roots: string[]) => JSON.stringify({
        version: SCHEMA_VERSION,
        document: { metadata: {}, nodes, rootNodeUuids: roots, variables: {} }
    });
    const node = (id: string, over: Record<string, any> = {}) => ({
        id, type: "core.rectangle", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 10, height: 10 },
        style: { fill: "#000", opacity: 1 }, layout: {}, ...over
    });

    test("rejects opacity out of range", () => {
        expect(() => deserializeDocument(envelope({ a: node("a", { style: { fill: "#000", opacity: 5 } }) }, ["a"])))
            .toThrow("opacity must be within");
    });

    test("rejects negative dimensions", () => {
        expect(() => deserializeDocument(envelope({ a: node("a", { geometry: { x: 0, y: 0, width: -10, height: 5 } }) }, ["a"])))
            .toThrow("positive dimensions");
    });

    test("rejects a zero-height rectangle (the strict rule survives the line relaxation)", () => {
        expect(() => deserializeDocument(envelope({ a: node("a", { geometry: { x: 0, y: 0, width: 10, height: 0 } }) }, ["a"])))
            .toThrow("positive dimensions");
    });

    test("accepts an ellipse like a rectangle", () => {
        const doc = deserializeDocument(envelope({ a: node("a", { type: "core.ellipse" }) }, ["a"]));
        expect(doc.nodes.get("a")!.type).toBe("core.ellipse");
    });

    test("rejects a zero-height ellipse (ellipse needs a positive box)", () => {
        expect(() => deserializeDocument(envelope({ a: node("a", { type: "core.ellipse", geometry: { x: 0, y: 0, width: 10, height: 0 } }) }, ["a"])))
            .toThrow("positive dimensions");
    });

    test("accepts a horizontal line (height 0) and a vertical line (width 0)", () => {
        const h = deserializeDocument(envelope({ a: node("a", { type: "core.line", geometry: { x: 0, y: 0, width: 100, height: 0 } }) }, ["a"]));
        expect(h.nodes.get("a")!.geometry.height).toBe(0);
        const v = deserializeDocument(envelope({ a: node("a", { type: "core.line", geometry: { x: 0, y: 0, width: 0, height: 100 } }) }, ["a"]));
        expect(v.nodes.get("a")!.geometry.width).toBe(0);
    });

    test("rejects a zero-length line (a degenerate point) and a negative line", () => {
        expect(() => deserializeDocument(envelope({ a: node("a", { type: "core.line", geometry: { x: 0, y: 0, width: 0, height: 0 } }) }, ["a"])))
            .toThrow("non-zero extent");
        expect(() => deserializeDocument(envelope({ a: node("a", { type: "core.line", geometry: { x: 0, y: 0, width: -5, height: 10 } }) }, ["a"])))
            .toThrow("dimensions must be >= 0");
    });

    test("rejects a dangling parent", () => {
        expect(() => deserializeDocument(envelope({ a: node("a", { parent: "ghost" }) }, [])))
            .toThrow("dangling parent");
    });

    test("rejects a ghost root", () => {
        expect(() => deserializeDocument(envelope({}, ["ghost"])))
            .toThrow("rootNodeUuids references a missing node");
    });

    test("rejects a child whose parent does not claim it", () => {
        const nodes = { p: node("p", { children: ["c"] }), c: node("c", { parent: null }) };
        expect(() => deserializeDocument(envelope(nodes, ["p", "c"]))).toThrow("but its parent is");
    });

    test("rejects a parentless node missing from rootNodeUuids", () => {
        expect(() => deserializeDocument(envelope({ a: node("a") }, []))).toThrow("not in rootNodeUuids");
    });

    test("rejects a one-way parent link the parent does not claim", () => {
        // Passes every parent→children check, but deleting p would orphan c and
        // make the file unopenable. Must be caught at load.
        const nodes = { p: node("p", { children: [] }), c: node("c", { parent: "p" }) };
        expect(() => deserializeDocument(envelope(nodes, ["p"]))).toThrow("does not list it as a child");
    });

    test("accepts a well-formed nested document", () => {
        const nodes = {
            p: node("p", { children: ["c"] }),
            c: node("c", { parent: "p" })
        };
        const doc = deserializeDocument(envelope(nodes, ["p"]));
        expect(doc.nodes.size).toBe(2);
        expect(doc.nodes.get("c")!.parent).toBe("p");
    });
});

// ─── Scene graph: the engine can actually BUILD and reorder a tree ───
describe("Scene graph authoring", () => {
    test("AddNodeAction can create a nested node under a parent", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);

        const addParent = new AddNodeAction(doc, "core.rectangle", 0, 0, 100, 100, "#fff", "p1");
        dispatcher.dispatchAction(addParent);
        const addChild = new AddNodeAction(dispatcher.getDocument(), "core.rectangle", 5, 5, 10, 10, "#000", "c1", "p1");
        expect(dispatcher.dispatchAction(addChild).success).toBe(true);

        const live = dispatcher.getDocument();
        expect(live.nodes.get("c1")!.parent).toBe("p1");
        expect(live.nodes.get("p1")!.children).toEqual(["c1"]);
        expect(live.rootNodeUuids).toEqual(["p1"]); // the child is NOT a root
    });

    test("AddNodeAction rejects a duplicate explicit id", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 10, "#fff", "dup"));
        const second = new AddNodeAction(dispatcher.getDocument(), "core.rectangle", 9, 9, 20, 20, "#000", "dup");
        expect(dispatcher.dispatchAction(second).success).toBe(false);
        expect(dispatcher.getDocument().nodes.get("dup")!.geometry.x).toBe(0); // original intact
    });

    test("ReparentNodeAction moves a node into a parent and back to root", () => {
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);

        // child-001 -> root
        expect(dispatcher.dispatchAction(new ReparentNodeAction(doc, "child-001", null)).success).toBe(true);
        let live = dispatcher.getDocument();
        expect(live.nodes.get("child-001")!.parent).toBeNull();
        expect(live.nodes.get("parent-001")!.children).toEqual(["child-002"]);
        expect(live.rootNodeUuids).toContain("child-001");

        // undo restores the original tree
        dispatcher.undo();
        live = dispatcher.getDocument();
        expect(live.nodes.get("child-001")!.parent).toBe("parent-001");
        expect(live.nodes.get("parent-001")!.children).toEqual(["child-001", "child-002"]);
        expect(live.rootNodeUuids).not.toContain("child-001");
    });

    test("ReparentNodeAction honours an insertion index", () => {
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new ReparentNodeAction(doc, "child-002", "parent-001", 0));
        expect(dispatcher.getDocument().nodes.get("parent-001")!.children).toEqual(["child-002", "child-001"]);
    });

    test("ReparentNodeAction rejects self-parenting and cycles", () => {
        const doc = createDocWithParentChild();
        expect(new ReparentNodeAction(doc, "parent-001", "parent-001").validate()).toBe(false);
        // Moving a parent under its own child would create a cycle.
        expect(new ReparentNodeAction(doc, "parent-001", "child-001").validate()).toBe(false);
        expect(new ReparentNodeAction(doc, "child-001", "missing").validate()).toBe(false);
    });

    // "Group the selection": add a container, then reparent a node into it. The
    // __addNode already bakes the child into the new parent's children, so the
    // reparent must detach from the DESTINATION too or it duplicates the entry —
    // invisible on canvas (traversal dedupes) but the saved file won't reopen.
    test("add-then-reparent in one transaction does not duplicate the child", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);

        const result = dispatcher.dispatchAction(new TransactionAction(doc, "group", [
            new AddNodeAction(doc, "core.rectangle", 0, 0, 300, 300, "#fff", "group-1"),
            new ReparentNodeAction(doc, "rectangle-001", "group-1")
        ]));
        expect(result.success).toBe(true);

        const live = dispatcher.getDocument();
        expect(live.nodes.get("group-1")!.children).toEqual(["rectangle-001"]);
        expect(live.rootNodeUuids).toEqual(["group-1"]);
        // The real proof: it survives a save/load round-trip.
        expect(() => deserializeDocument(serializeDocument(live))).not.toThrow();
    });

    test("reparent and move in one transaction lands BOTH", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new AddNodeAction(doc, "core.rectangle", 0, 0, 100, 100, "#fff", "P"));
        dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", 50, 60, 10, 10, "#000", "N"));

        dispatcher.dispatchAction(new TransactionAction(dispatcher.getDocument(), "drop-into-frame", [
            new ReparentNodeAction(dispatcher.getDocument(), "N", "P"),
            new UpdateNodeGeometryAction(dispatcher.getDocument(), "N", { x: 5, y: 6 })
        ]));

        const n = dispatcher.getDocument().nodes.get("N")!;
        expect(n.parent).toBe("P");
        expect(n.geometry).toMatchObject({ x: 5, y: 6 }); // the move is not swallowed
    });

    test("a stale action (built before an undo) fails closed instead of half-applying", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new AddNodeAction(doc, "core.rectangle", 0, 0, 300, 300, "#fff", "group-1"));

        // Valid when constructed; group-1 disappears before it is dispatched.
        const stale = new ReparentNodeAction(dispatcher.getDocument(), "rectangle-001", "group-1");
        dispatcher.undo();

        expect(dispatcher.dispatchAction(stale).success).toBe(false);
        const live = dispatcher.getDocument();
        expect(live.nodes.get("rectangle-001")!.parent).toBeNull();
        expect(live.rootNodeUuids).toContain("rectangle-001"); // not orphaned
    });

    test("moving a parent together with its own child applies the delta once", () => {
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        // Both selected; only the selection ROOT may be patched.
        const roots = selectionRoots(doc, ["parent-001", "child-001"]);
        expect(roots).toEqual(["parent-001"]);

        const pending = new Map(roots.map(id => [id, { x: doc.nodes.get(id)!.geometry.x + 50 }]));
        const { nodes: rects } = computeGeometry(doc, pending);
        expect(rects.get("parent-001")!.bounds.x).toBe(50);
        expect(rects.get("child-001")!.bounds.x).toBe(60); // 50 + stored 10, NOT 110
    });

    test("traverseSceneGraph returns tree order, not Map insertion order", () => {
        const doc = createDocWithParentChild();
        expect(traverseSceneGraph(doc).map(n => n.id)).toEqual(["parent-001", "child-001", "child-002"]);
    });

    test("traverseSceneGraph is cycle-safe and still returns orphans", () => {
        const doc = createEmptyDocument();
        const mk = (id: string, parent: string | null, children: string[]): Node => ({
            id, type: "core.rectangle", parent, children,
            geometry: { x: 0, y: 0, width: 10, height: 10 },
            style: { fill: "#000", opacity: 1 }, layout: {}
        });
        // a <-> b cycle, plus an orphan unreachable from any root
        doc.nodes.set("a", mk("a", null, ["b"]));
        doc.nodes.set("b", mk("b", "a", ["a"]));
        doc.nodes.set("orphan", mk("orphan", null, []));
        doc.rootNodeUuids = ["a"];

        const ids = traverseSceneGraph(doc).map(n => n.id);
        expect(ids).toEqual(["a", "b", "orphan"]); // terminates, nothing dropped
    });
});

// ─── History flooding: coalescing + the INITIAL revision is never evicted ───
describe("History coalescing and retention", () => {
    test("a rapid run of style edits on one node collapses to a single undo step", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);

        // Simulates an opacity slider drag: one action per input event. Continuous
        // UI opts in explicitly — the history layer does not guess from action type.
        for (let i = 1; i <= 50; i++) {
            dispatcher.dispatchAction(
                new UpdateNodeStyleAction(dispatcher.getDocument(), "rectangle-001", { opacity: i / 50 }),
                { coalesce: true }
            );
        }
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.style.opacity).toBeCloseTo(1);

        // One undo returns to the pre-drag value, not 50 undos.
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.style.opacity).toBe(1);
        expect(dispatcher.canUndo()).toBe(false);
    });

    // A drag commits UpdateNodeGeometryAction on mouse-up — the SAME action class
    // the inspector uses. Coalescing must key on caller intent, not action type, or
    // two deliberate drags of one node collapse into a single undo step.
    test("a drag commit is NOT coalesced even though it is the same action class", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);

        // Two back-to-back "drags" (no coalesce opt-in), well inside the 400ms window.
        dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), "rectangle-001", { x: 10 }));
        dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), "rectangle-001", { x: 20 }));

        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.geometry.x).toBe(10); // not 0
    });

    test("discrete actions are NOT coalesced", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);
        for (let i = 0; i < 3; i++) {
            dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", i, 0, 10, 10));
        }
        expect(dispatcher.getDocument().nodes.size).toBe(3);
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.size).toBe(2); // one undo == one add
    });

    test("history is memory-bounded, so a long session does not truncate", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);

        for (let i = 0; i < 260; i++) {
            dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", i, 0, 10, 10));
        }
        expect(dispatcher.getDocument().nodes.size).toBe(260);
        expect(dispatcher.hasTruncatedHistory()).toBe(false); // well inside the byte budget

        while (dispatcher.canUndo()) dispatcher.undo();
        expect(dispatcher.getDocument().nodes.size).toBe(0);
    });

    test("when history DOES truncate, undo stops at the boundary instead of teleporting", () => {
        const doc = createEmptyDocument();
        // Tiny budget forces truncation deterministically.
        const dispatcher = new ActionDispatcher(doc, { maxBytes: 1, minEntries: 5, maxEntries: 10_000 });

        for (let i = 0; i < 20; i++) {
            dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", i, 0, 10, 10));
        }
        expect(dispatcher.hasTruncatedHistory()).toBe(true);

        while (dispatcher.canUndo()) dispatcher.undo();

        // Undo stopped at the oldest RETAINED step — it did not jump to the start.
        const afterUndoAll = dispatcher.getDocument().nodes.size;
        expect(afterUndoAll).toBeGreaterThan(0);
        expect(afterUndoAll).toBeLessThan(20);
    });

    test("revertToOriginal is the explicit way back, and is itself undoable", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc, { maxBytes: 1, minEntries: 5, maxEntries: 10_000 });

        for (let i = 0; i < 20; i++) {
            dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", i, 0, 10, 10));
        }
        while (dispatcher.canUndo()) dispatcher.undo();
        const strandedAt = dispatcher.getDocument().nodes.size;

        dispatcher.revertToOriginal();
        expect(dispatcher.getDocument().nodes.size).toBe(0); // the true starting document

        dispatcher.undo(); // the revert is a normal revision, so it can be undone
        expect(dispatcher.getDocument().nodes.size).toBe(strandedAt);
    });
});

// ─── Rule-audit follow-ups (medium/low findings) ───
describe("Rule-audit follow-ups", () => {
    test("an unknown node.type is rejected on load", () => {
        const bad = JSON.stringify({
            version: SCHEMA_VERSION,
            document: {
                metadata: {}, rootNodeUuids: ["n"], variables: {},
                nodes: { n: {
                    id: "n", type: "evil.node", parent: null, children: [],
                    geometry: { x: 0, y: 0, width: 10, height: 10 },
                    style: { fill: "#000", opacity: 1 }, layout: {}
                } }
            }
        });
        expect(() => deserializeDocument(bad)).toThrow("malformed");
    });

    test("a non-object layout is rejected on load", () => {
        const bad = JSON.stringify({
            version: SCHEMA_VERSION,
            document: {
                metadata: {}, rootNodeUuids: ["n"], variables: {},
                nodes: { n: {
                    id: "n", type: "core.rectangle", parent: null, children: [],
                    geometry: { x: 0, y: 0, width: 10, height: 10 },
                    style: { fill: "#000", opacity: 1 }, layout: "nope"
                } }
            }
        });
        expect(() => deserializeDocument(bad)).toThrow("malformed");
    });

    test("an unparseable metadata date falls back instead of becoming Invalid Date", () => {
        const doc = deserializeDocument(JSON.stringify({
            version: SCHEMA_VERSION,
            document: { metadata: { project_name: 42, date: "not-a-date" }, nodes: {}, rootNodeUuids: [], variables: {} }
        }));
        expect(Number.isNaN(doc.metadata.date.getTime())).toBe(false);
        expect(typeof doc.metadata.project_name).toBe("string");
    });

    test("fontSize is validated by UpdateNodeStyleAction", () => {
        const doc = createDocWithRectangle();
        expect(new UpdateNodeStyleAction(doc, "rectangle-001", { fontSize: 0 }).validate()).toBe(false);
        expect(new UpdateNodeStyleAction(doc, "rectangle-001", { fontSize: 12 }).validate()).toBe(true);
    });

    test("a node added and deleted in one transaction emits no delta", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const result = dispatcher.dispatchAction(new TransactionAction(doc, "add-then-remove", [
            new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 10, "#fff", "temp"),
            new DeleteNodeAction(doc, "temp")
        ]));
        expect(result.success).toBe(true);
        expect(result.propertyDeltas.has("temp")).toBe(false); // no __deleteNode for a node that never existed
        expect(dispatcher.getDocument().nodes.has("temp")).toBe(false);
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();
    });

    test("an edit after an undo starts a new undo step even if it would coalesce", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const style = (o: number) =>
            new UpdateNodeStyleAction(dispatcher.getDocument(), "rectangle-001", { opacity: o });

        dispatcher.dispatchAction(style(0.5), { coalesce: true });
        dispatcher.dispatchAction(style(0.6), { coalesce: true }); // coalesces
        dispatcher.undo();                                        // cursor moves
        dispatcher.dispatchAction(style(0.7), { coalesce: true }); // must NOT merge into it

        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.style.opacity).toBe(1);
    });

    test("a throwing validate() is contained, not propagated", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const bomb = new MoveNodeAction(doc, "rectangle-001", 5, 5);
        (bomb as any).validate = () => { throw new Error("boom"); };
        const spy = jest.spyOn(console, "error").mockImplementation(() => {});
        expect(() => dispatcher.dispatchAction(bomb)).not.toThrow();
        expect(dispatcher.dispatchAction(bomb).success).toBe(false);
        spy.mockRestore();
    });

    test("actions emit typed deltas (add / delete / patch)", () => {
        const doc = createDocWithParentChild();
        const add = new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 10, "#fff", "z");
        add.execute();
        expect(add.execute().propertyDeltas.get(add.getCreatedNodeId()!)!.kind).toBe("add");

        const del = new DeleteNodeAction(doc, "child-001");
        expect(del.execute().propertyDeltas.get("child-001")!.kind).toBe("delete");

        const move = new MoveNodeAction(doc, "child-001", 1, 2);
        const patch = move.execute().propertyDeltas.get("child-001")!;
        expect(patch.kind).toBe("patch");
        expect(patch.kind === "patch" && patch.geometry).toEqual({ x: 1, y: 2 });

        const rep = new ReparentNodeAction(doc, "child-001", null);
        const rp = rep.execute().propertyDeltas.get("child-001")!;
        expect(rp.kind === "patch" && rp.reparent).toEqual({ parent: null, index: undefined });
    });

    test("viewport pan limit scales with zoom so content stays reachable", () => {
        const vp = { x: 9000, y: 0, zoom: 20 };
        clampViewport(vp);
        expect(vp.x).toBe(9000); // previously clamped to 10000 screen px = world 500
    });

    test("panBy moves the viewport by a SCREEN delta (zoom-independent), then clamps", () => {
        const vp = { x: 0, y: 0, zoom: 1 };
        panBy(vp, 10, 5);
        expect(vp).toEqual({ x: -10, y: -5, zoom: 1 }); // content follows the +10,+5 pointer drag
        const vp2 = { x: 0, y: 0, zoom: 4 };
        panBy(vp2, 10, 5);
        expect(vp2.x).toBe(-10); // same screen px regardless of zoom
    });

    // The world point under the cursor must stay fixed across a zoom. screen = z·world − vp,
    // so world-at-cursor = (cursor + vp) / z; assert it's unchanged after zoomAt.
    const worldAtCursor = (vp: { x: number; y: number; zoom: number }, c: number, axis: "x" | "y") =>
        (c + vp[axis]) / vp.zoom;

    test("zoomAt keeps the world point under the cursor fixed", () => {
        const vp = { x: 0, y: 0, zoom: 1 };
        const wx = worldAtCursor(vp, 100, "x"), wy = worldAtCursor(vp, 50, "y");
        zoomAt(vp, 2, 100, 50);
        expect(vp.zoom).toBe(2);
        expect(worldAtCursor(vp, 100, "x")).toBeCloseTo(wx, 10);
        expect(worldAtCursor(vp, 50, "y")).toBeCloseTo(wy, 10);
    });

    test("zoomAt uses the ACTUAL post-clamp factor so a clamped zoom doesn't drift the anchor", () => {
        const vp = { x: 0, y: 0, zoom: 19 };
        const wx = worldAtCursor(vp, 200, "x");
        zoomAt(vp, 2, 200, 0);       // ×2 would be 38; clamps to MAX_ZOOM 20 (factor 20/19)
        expect(vp.zoom).toBe(20);
        expect(worldAtCursor(vp, 200, "x")).toBeCloseTo(wx, 10); // anchor still holds
    });

    test("ToolController pan mode: space+drag and middle-mouse pan; a plain drag does not", () => {
        const es = createEditorState();
        const tc = new ToolController(new ActionDispatcher(createEmptyDocument()), es, () => { });
        const rect = { left: 0, top: 0 } as DOMRect;
        const md = (x: number, y: number, button = 0) =>
            ({ clientX: x, clientY: y, button, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
        const key = (k: string) =>
            ({ key: k, target: { tagName: "BODY", isContentEditable: false }, preventDefault() { } } as unknown as KeyboardEvent);

        // A plain left-drag on empty canvas (no active tool) must NOT pan.
        tc.onMouseDown(md(0, 0), rect);
        tc.onMouseMove(md(30, 20), rect);
        expect(es.viewport).toMatchObject({ x: 0, y: 0 });
        tc.onMouseUp(md(30, 20));

        // Hold Space → the next drag pans; content follows the pointer, so vp = −delta.
        tc.onKeyDown(key(" "));
        tc.onMouseDown(md(0, 0), rect);
        tc.onMouseMove(md(30, 20), rect);
        expect(es.viewport).toMatchObject({ x: -30, y: -20 });
        tc.onMouseUp(md(30, 20));
        tc.onKeyUp(key(" "));

        // Middle mouse pans without Space (incremental from the current viewport).
        tc.onMouseDown(md(0, 0, 1), rect);
        tc.onMouseMove(md(5, 0, 1), rect);
        expect(es.viewport.x).toBe(-35);
        tc.onMouseUp(md(5, 0, 1));
    });
});

// ─── M1: matrix primitive ───
describe("Matrix", () => {
    const approx = (a: number, b: number) => expect(a).toBeCloseTo(b, 10);

    test("multiply is outer ∘ inner (inner applied first)", () => {
        const t = translation(10, 0);
        const r = compose(0, 0, Math.PI / 2, 1, 1, 0, 0); // 90° about the origin
        // inner=translate then outer=rotate: (1,0) -> (11,0) -> rotated -> (0,11)
        const p = applyToPoint(multiply(r, t), 1, 0);
        approx(p.x, 0); approx(p.y, 11);
        // Reversed order gives a different answer — proving order is not incidental.
        const q = applyToPoint(multiply(t, r), 1, 0);
        approx(q.x, 10); approx(q.y, 1);
    });

    test("invert round-trips a point, and returns null when singular", () => {
        const m = compose(30, 40, Math.PI / 3, 2, 0.5, 5, 5);
        const inv = invert(m)!;
        expect(inv).not.toBeNull();
        const p = applyToPoint(m, 7, -3);
        const back = applyToPoint(inv, p.x, p.y);
        approx(back.x, 7); approx(back.y, -3);

        // A zero scale collapses the space: it must report failure, not Infinity.
        expect(invert(compose(0, 0, 0, 0, 1, 0, 0))).toBeNull();

        // The guard honours its contract for the extreme cases too: a non-finite
        // translation and a subnormal determinant both return null, never a poisoned
        // (Infinity/NaN) matrix that would flow into toLocal / hit-testing.
        expect(invert({ a: 1, b: 0, c: 0, d: 1, e: Infinity, f: 0 })).toBeNull();
        expect(invert({ a: Number.MIN_VALUE, b: 0, c: 0, d: 1, e: 0, f: 0 })).toBeNull();
    });

    test("AABB of a rotated box uses all four corners", () => {
        // 45° rotation of a 10x10 box about its centre: the AABB grows to 10√2.
        const m = compose(0, 0, Math.PI / 4, 1, 1, 5, 5);
        const aabb = transformRectToAABB(m, { x: 0, y: 0, width: 10, height: 10 });
        approx(aabb.width, Math.SQRT2 * 10);
        approx(aabb.height, Math.SQRT2 * 10);
    });
});

// ─── M1: GeometryEngine — transforms, spaces, bounds, dirty reuse ───
describe("GeometryEngine", () => {
    const rotatedDoc = () => {
        const doc = createDocWithParentChild();
        doc.nodes.get("parent-001")!.transform = { rotation: Math.PI / 2 }; // 90° about centre
        return doc;
    };

    test("a parent's rotation propagates to its children", () => {
        const flat = computeGeometry(createDocWithParentChild());
        const rotated = computeGeometry(rotatedDoc());
        // The child moves because its parent's transform composes into it.
        expect(rotated.nodes.get("child-001")!.bounds)
            .not.toEqual(flat.nodes.get("child-001")!.bounds);
        // ...while its STORED geometry is untouched — world position is computed.
        expect(rotatedDoc().nodes.get("child-001")!.geometry.x).toBe(10);
    });

    test("toLocal / toWorld round-trip through a rotated ancestor", () => {
        const state = computeGeometry(rotatedDoc());
        const world = toWorld(state, "child-001", 3, 4)!;
        const local = toLocal(state, "child-001", world.x, world.y)!;
        expect(local.x).toBeCloseTo(3, 10);
        expect(local.y).toBeCloseTo(4, 10);
    });

    test("hit-testing a rotated node uses its true shape, not its AABB", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("r", {
            id: "r", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 100, height: 20 },
            style: { fill: "#000", opacity: 1 }, layout: {},
            transform: { rotation: Math.PI / 4 }
        });
        doc.rootNodeUuids = ["r"];
        const state = computeGeometry(doc);
        const b = state.nodes.get("r")!.bounds;

        // The AABB corner is well outside the rotated bar itself.
        expect(hitTest(state, b.x + 1, b.y + 1)).toBeNull();
        // The centre is inside it.
        expect(hitTest(state, b.x + b.width / 2, b.y + b.height / 2)).toBe("r");
    });

    test("subtree and selection bounds enclose descendants", () => {
        const doc = createDocWithParentChild();
        const state = computeGeometry(doc);
        const sub = subtreeBounds(doc, state, "parent-001")!;
        const child = state.nodes.get("child-002")!.bounds;
        expect(sub.x + sub.width).toBeGreaterThanOrEqual(child.x + child.width);

        const sel = selectionBounds(state, ["child-001", "child-002"])!;
        expect(sel.width).toBeGreaterThan(state.nodes.get("child-001")!.bounds.width);
        expect(selectionBounds(state, ["nope"])).toBeNull();
    });

    test("dirty tracking reuses clean entries and recomputes dirty subtrees", () => {
        const doc = createDocWithParentChild();
        const first = computeGeometry(doc);

        // Nothing dirty: every entry is reused BY REFERENCE.
        const reused = computeGeometry(doc, null, first, new Set<string>());
        expect(reused.nodes.get("child-002")).toBe(first.nodes.get("child-002"));

        // Dirtying the parent must invalidate its descendants too, since a parent's
        // transform composes downward.
        doc.nodes.get("parent-001")!.geometry.x = 999;
        const after = computeGeometry(doc, null, first, new Set(["parent-001"]));
        expect(after.nodes.get("child-001")).not.toBe(first.nodes.get("child-001"));
        expect(after.nodes.get("child-001")!.bounds.x)
            .toBe(computeGeometry(doc).nodes.get("child-001")!.bounds.x); // matches a full recompute
    });
});

// ─── M1: transform is authorable through the write path ───
describe("UpdateNodeTransformAction", () => {
    test("sets rotation/scale, is undoable, and round-trips", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const r = dispatcher.dispatchAction(
            new UpdateNodeTransformAction(doc, "rectangle-001", { rotation: Math.PI / 4, scaleX: 2 })
        );
        expect(r.success).toBe(true);
        const t = dispatcher.getDocument().nodes.get("rectangle-001")!.transform!;
        expect(t.rotation).toBeCloseTo(Math.PI / 4);
        expect(t.scaleX).toBe(2);
        // round-trips through the schema-2 loader
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();
        // undoable
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.transform).toBeUndefined();
    });

    test("rejects a zero scale (non-invertible) and non-finite rotation", () => {
        const doc = createDocWithRectangle();
        expect(new UpdateNodeTransformAction(doc, "rectangle-001", { scaleX: 0 }).validate()).toBe(false);
        expect(new UpdateNodeTransformAction(doc, "rectangle-001", { rotation: Infinity }).validate()).toBe(false);
        expect(new UpdateNodeTransformAction(doc, "rectangle-001", { rotation: NaN }).validate()).toBe(false);
        expect(new UpdateNodeTransformAction(doc, "rectangle-001", { scaleX: -1 }).validate()).toBe(true); // flip ok
    });

    // Round-trip closure for transform: the LOAD path must reject exactly what the
    // edit path rejects, or a hand-edited schema-2 file produces a NaN/un-selectable node.
    test("the load path rejects the same transforms the edit path does", () => {
        // Raw JSON text, not JSON.stringify — the real attack vector is a hand-edited
        // file, and stringify would coerce Infinity to null before it ever loaded.
        const bad = (transformJson: string) =>
            `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": {}, "transform": ${transformJson} } } } }`;

        expect(() => deserializeDocument(bad(`{ "scaleX": 0 }`))).toThrow("non-zero");
        expect(() => deserializeDocument(bad(`{ "rotation": 1e999 }`))).toThrow("finite"); // JSON 1e999 → Infinity
        expect(() => deserializeDocument(bad(`{ "origin": { "x": 0.5 } }`))).toThrow(); // caught by shape check
        // A valid transform still loads.
        expect(() => deserializeDocument(bad(`{ "rotation": 1, "scaleX": -2 }`))).not.toThrow();
    });

    test("composes with a move in one transaction (patch is composable)", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new TransactionAction(doc, "rotate+move", [
            new UpdateNodeTransformAction(doc, "rectangle-001", { rotation: 1 }),
            new MoveNodeAction(doc, "rectangle-001", 40, 50)
        ]));
        const n = dispatcher.getDocument().nodes.get("rectangle-001")!;
        expect(n.transform!.rotation).toBe(1);
        expect(n.geometry).toMatchObject({ x: 40, y: 50 }); // both landed
    });
});

// ─── M1: incremental (dirty) compute must equal a full recompute, always ───
describe("GeometryEngine dirty tracking", () => {
    type CS = ReturnType<typeof computeGeometry>;
    const statesEqual = (a: CS, b: CS): true | string => {
        if (a.order.join("|") !== b.order.join("|")) return `order: ${a.order} vs ${b.order}`;
        if (a.nodes.size !== b.nodes.size) return `size ${a.nodes.size} vs ${b.nodes.size}`;
        for (const [id, an] of a.nodes) {
            const bn = b.nodes.get(id);
            if (!bn) return `missing ${id}`;
            for (const k of ["a", "b", "c", "d", "e", "f"] as const) {
                if (Math.abs(an.world[k] - bn.world[k]) > 1e-9) return `${id}.world.${k}`;
            }
            for (const k of ["x", "y", "width", "height"] as const) {
                if (Math.abs(an.bounds[k] - bn.bounds[k]) > 1e-9) return `${id}.bounds.${k}`;
                if (Math.abs(an.local[k] - bn.local[k]) > 1e-9) return `${id}.local.${k}`;
            }
        }
        return true;
    };

    test("a dirty-set recompute matches a from-scratch recompute over a random sequence", () => {
        // Seeded LCG so any failure reproduces exactly.
        let seed = 0x9e3779b9;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];

        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));

        let prev = computeGeometry(dispatcher.getDocument());
        const ids: string[] = [];
        let counter = 0;

        for (let step = 0; step < 300; step++) {
            const doc = dispatcher.getDocument();
            const op = ids.length === 0 ? 0 : Math.floor(rnd() * 7);
            if (op === 0) {
                const id = "n" + (counter++);
                const parent = ids.length && rnd() < 0.4 ? pick(ids) : null;
                if (dispatcher.dispatchAction(new AddNodeAction(doc, "core.rectangle",
                    rnd() * 100, rnd() * 100, 1 + rnd() * 60, 1 + rnd() * 60, "#fff", id, parent)).success) ids.push(id);
            } else if (op === 1) {
                dispatcher.dispatchAction(new MoveNodeAction(doc, pick(ids), rnd() * 200 - 100, rnd() * 200 - 100));
            } else if (op === 2) {
                dispatcher.dispatchAction(new ResizeNodeAction(doc, pick(ids), 1 + rnd() * 80, 1 + rnd() * 80));
            } else if (op === 3) {
                // Rotation/scale through the write path — the thing that most stresses composition.
                dispatcher.dispatchAction(new UpdateNodeTransformAction(doc, pick(ids), {
                    rotation: rnd() * Math.PI * 2, scaleX: 0.5 + rnd() * 2, scaleY: 0.5 + rnd() * 2
                }));
            } else if (op === 4) {
                dispatcher.dispatchAction(new ReparentNodeAction(doc, pick(ids), rnd() < 0.5 ? null : pick(ids)));
            } else if (op === 5) {
                dispatcher.undo();
            } else {
                dispatcher.redo();
            }

            const live = dispatcher.getDocument();
            const full = computeGeometry(live);
            const incremental = computeGeometry(live, null, prev, dirty);
            const eq = statesEqual(incremental, full);
            expect(eq).toBe(true); // if this ever fails, `eq` names the exact node/field at seed-derived step

            prev = incremental;
            dirty.clear();
        }
    });

    // The App's real render path unions PENDING keys (current + previous) into the
    // dirty set; every test above passes pending=null, so that path was unguarded.
    test("the pending (drag-preview) path also matches full compute, incrementally", () => {
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());

        // Drag the parent via a pending patch (no dispatch), as MoveTool does.
        const pending = new Map([["parent-001", { x: 300 }]]);
        const duringDrag = computeGeometry(dispatcher.getDocument(), pending, base, new Set(["parent-001"]));
        expect(statesEqual(duringDrag, computeGeometry(dispatcher.getDocument(), pending))).toBe(true);

        // The engine's OWN guarantee: a currently-pending node is treated as dirty even
        // if the caller's dirty set omits it, so a live preview is never missed.
        const engineOnly = computeGeometry(dispatcher.getDocument(), pending, base, new Set<string>());
        expect(statesEqual(engineOnly, computeGeometry(dispatcher.getDocument(), pending))).toBe(true);

        // Escape-cancel: pending cleared, NOTHING dispatched. The App recomputes the
        // formerly-pending node only because it unions `prevPending` — verify the
        // incremental result matches a full recompute...
        const afterCancel = computeGeometry(dispatcher.getDocument(), null, duringDrag, new Set(["parent-001"]));
        const full = computeGeometry(dispatcher.getDocument(), null);
        expect(statesEqual(afterCancel, full)).toBe(true);

        // ...and that OMITTING prevPending would reuse the stale preview — proving the
        // prevPending union in App.tsx is load-bearing, not decoration.
        const wrong = computeGeometry(dispatcher.getDocument(), null, duringDrag, new Set<string>());
        expect(wrong.nodes.get("parent-001")!.world.e).not.toBe(full.nodes.get("parent-001")!.world.e);
    });

    test("an under-broad dirty set is CAUGHT (the test is not vacuous)", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const prev = computeGeometry(dispatcher.getDocument());

        dispatcher.dispatchAction(new MoveNodeAction(dispatcher.getDocument(), "rectangle-001", 500, 500));
        // Deliberately omit the changed node from the dirty set.
        const stale = computeGeometry(dispatcher.getDocument(), null, prev, new Set<string>());
        const full = computeGeometry(dispatcher.getDocument());
        // The stale entry is reused, so incremental DIVERGES — proving the equivalence
        // assertion above has teeth.
        expect(stale.nodes.get("rectangle-001")!.world.e).not.toBe(full.nodes.get("rectangle-001")!.world.e);
    });
});

// ─── M0 round-trip closure: the engine must not author what it cannot reopen ───
describe("Edit path and load path agree", () => {
    test("AddNodeAction rejects a node type outside NODE_TYPES", () => {
        const doc = createEmptyDocument();
        // TypeScript alone does not stop this — a cast, a plugin (M15) or an
        // AI-emitted action (M14) reaches validate() with an arbitrary string.
        const action = new AddNodeAction(doc, "core.bogus" as any, 0, 0, 10, 10);
        expect(action.validate()).toBe(false);
        expect(new ActionDispatcher(doc).dispatchAction(action).success).toBe(false);
    });

    test("anything the edit path accepts, the load path can reopen", () => {
        const doc = createEmptyDocument();
        const dispatcher = new ActionDispatcher(doc);
        for (const type of NODE_TYPES) {
            expect(dispatcher.dispatchAction(
                new AddNodeAction(dispatcher.getDocument(), type, 0, 0, 10, 10)
            ).success).toBe(true);
        }
        // The round trip is the actual guarantee, not the type check.
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();
    });

    test("loadDocument validates: the in-memory load path is guarded too", () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const ghostRoot = createEmptyDocument();
        ghostRoot.rootNodeUuids = ["does-not-exist"];

        expect(() => dispatcher.loadDocument(ghostRoot)).toThrow("missing node");
        // ...and the live document is untouched by the rejected load.
        expect(dispatcher.getDocument().rootNodeUuids).toEqual([]);
    });
});

// ─── Gaps found by mutation-testing the campaign's own guards ───
describe("Guards the suite did not previously protect", () => {
    // Mutation "MoveTool selectionRoots filter" SURVIVED: the existing test exercised
    // selectionRoots + computeGeometry directly, never MoveTool — so the CRITICAL
    // double-apply bug could have been reintroduced with no test failing.
    test("MoveTool patches only selection roots, so a parent+child drag applies once", () => {
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState();
        es.selectedNodeIds = ["parent-001", "child-001"]; // a parent AND its own child
        const tool = new MoveTool(dispatcher, es, () => { });

        const at = (x: number) => ({ clientX: x, clientY: 0 } as MouseEvent);
        tool.onMouseDown(at(0));
        tool.onMouseMove(at(50));

        // Only the root of the selection may be patched.
        expect([...(es.pendingGeometry?.keys() ?? [])]).toEqual(["parent-001"]);

        tool.onMouseUp(at(50));

        const live = dispatcher.getDocument();
        expect(live.nodes.get("child-001")!.geometry.x).toBe(10);           // stored: untouched
        expect(computeGeometry(live).nodes.get("child-001")!.bounds.x).toBe(60); // world: +50 once, not +100
    });

    // Mutation "RS-7 unresolved-parent skip" reported KILLED, but the suite had never
    // RUN — the mutation failed to compile, and the harness read a non-zero exit as
    // "a test caught it". Mutated validly (restoring the exact pre-fix code) it
    // SURVIVED: nothing protected this guard.
    test("a node whose parent is unresolved is skipped, not silently placed at the origin", () => {
        const doc = createEmptyDocument();
        const mk = (id: string, parent: string | null, children: string[], x: number, y: number): Node => ({
            id, type: "core.rectangle", parent, children,
            geometry: { x, y, width: 50, height: 50 },
            style: { fill: "#000", opacity: 1 }, layout: {}
        });
        // Q is the only root and does NOT list P, so P is reachable only via the
        // orphan tail — and traversal therefore emits C before its own parent.
        doc.nodes.set("Q", mk("Q", null, [], 0, 0));
        doc.nodes.set("C", mk("C", "P", [], 10, 10));
        doc.nodes.set("P", mk("P", "Q", ["C"], 100, 100));
        doc.rootNodeUuids = ["Q"];

        const computed = computeGeometry(doc);
        expect(computed.order.indexOf("C")).toBeLessThan(computed.order.indexOf("P"));

        // Absent rather than misplaced. Falling back to origin (0,0) would draw C at
        // (10,10) instead of (110,110) AND make hit-testing agree with the wrong
        // drawing — corruption with no visible symptom.
        expect(computed.nodes.has("C")).toBe(false);
        expect(hitTest(computed, 12, 12)).not.toBe("C");
        expect(computed.nodes.get("P")!.bounds).toMatchObject({ x: 100, y: 100 });
    });

    // Mutation "coalesce anchored to last commit" SURVIVED: the existing test happened
    // to land on currentIndex === 0, so it was gated by a different guard entirely.
    // This forces currentIndex > 0 after the undo, which is where the anchor matters.
    test("an edit after undo does not merge into the revision the cursor landed on", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        const style = (o: number) =>
            new UpdateNodeStyleAction(dispatcher.getDocument(), "rectangle-001", { opacity: o });

        dispatcher.dispatchAction(style(0.5), { coalesce: true });                 // revision 1
        dispatcher.dispatchAction(new MoveNodeAction(dispatcher.getDocument(), "rectangle-001", 7, 0)); // revision 2
        dispatcher.undo();                                                          // cursor -> revision 1
        dispatcher.dispatchAction(style(0.7), { coalesce: true });                  // must NOT overwrite it

        dispatcher.undo();
        // Revision 1 still exists, so we land on opacity 0.5 — not back at the start.
        expect(dispatcher.getDocument().nodes.get("rectangle-001")!.style.opacity).toBe(0.5);
    });

    // Mutation "legacy re-stamp straight to the current schema" would be invisible if
    // LEGACY_SCHEMA equalled SCHEMA_VERSION (as it did at schema 1) — the two behaviours
    // are indistinguishable then. Injecting a hypothetical next schema exposes it: a legacy
    // file must reach the current schema via the CHAIN, never by a direct re-stamp.
    test("a legacy file is normalised then run THROUGH the chain, not marked current", () => {
        const legacy = { version: "0.0.4", document: { metadata: {}, nodes: {}, rootNodeUuids: [], variables: {} } };

        // Pretending the build has moved to a schema "26" that has no 25→26 step: the
        // legacy file must be normalised to "1", carried through every real step
        // (1→2→…→25), and then REFUSED at "25" — never re-stamped straight to the current
        // schema. The error naming "25" (not "1") is the proof the chain actually ran.
        // (The boundary tracks the last IMPLEMENTED step, so it moves up by one each
        // time a real migration is added — most recently when 41→42 landed for lighting.)
        expect(() => migrateIfNeeded(legacy, "43")).toThrow('Migration not implemented for document schema "42"');

        // At the current schema it loads, having been migrated through the whole chain.
        expect(migrateIfNeeded(legacy).version).toBe(SCHEMA_VERSION);
    });

    test("a schema-1 document migrates forward and round-trips", () => {
        const v1 = JSON.stringify({
            version: "1",
            document: {
                metadata: { project_name: "Legacy v1" },
                nodes: { n: {
                    id: "n", type: "core.rectangle", parent: null, children: [],
                    geometry: { x: 5, y: 6, width: 10, height: 10 },
                    style: { fill: "#000", opacity: 1 }, layout: {}
                } },
                rootNodeUuids: ["n"], variables: {}
            }
        });
        const doc = deserializeDocument(v1);
        expect(doc.version).toBe(SCHEMA_VERSION);              // upgraded to the current schema
        expect(doc.nodes.get("n")!.transform).toBeUndefined();  // absent = identity
        expect(() => deserializeDocument(serializeDocument(doc))).not.toThrow();
    });
});

// ─── M19: load distinguishes empty vs corrupt ───
describe("Serializer.loadResult (localStorage)", () => {
    const store: Record<string, string> = {};
    beforeAll(() => {
        (global as any).localStorage = {
            getItem: (k: string) => (k in store ? store[k] : null),
            setItem: (k: string, v: string) => { store[k] = v; },
            removeItem: (k: string) => { delete store[k]; }
        };
    });
    beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

    test("empty when nothing is saved", () => {
        expect(Serializer.loadResult().status).toBe("empty");
        expect(Serializer.load()).toBeNull();
    });

    test("loaded round-trips a saved document", () => {
        const doc = createEmptyDocument();
        doc.metadata.project_name = "Saved";
        Serializer.save(doc);
        const r = Serializer.loadResult();
        expect(r.status).toBe("loaded");
        expect(r.document!.metadata.project_name).toBe("Saved");
    });

    test("corrupt is distinguished from empty and backed up", () => {
        store["vde-document"] = "{ not valid json";
        const spy = jest.spyOn(console, "error").mockImplementation(() => {});
        const r = Serializer.loadResult();
        spy.mockRestore();
        expect(r.status).toBe("corrupt");
        expect(Serializer.load()).toBeNull();
        expect(store["vde-document.corrupt-backup"]).toBe("{ not valid json");
    });
});

// ─── loadDocument replaces document + resets history ───
describe("ActionDispatcher.loadDocument", () => {
    test("replaces the document and resets history", () => {
        const doc = createDocWithRectangle();
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new MoveNodeAction(doc, "rectangle-001", 50, 0));
        expect(dispatcher.canUndo()).toBe(true);

        dispatcher.loadDocument(createEmptyDocument());
        expect(dispatcher.getDocument().nodes.size).toBe(0);
        expect(dispatcher.canUndo()).toBe(false);
        expect(dispatcher.canRedo()).toBe(false);
    });
});

// ─── T15: Metadata round-trip ───
describe("Metadata round-trip", () => {
    test("preserves project_name, created_by, and date through serialize/deserialize", () => {
        const doc = createEmptyDocument();
        doc.metadata.project_name = "Test Project";
        doc.metadata.created_by = "tester";
        const json = serializeDocument(doc);
        const loaded = deserializeDocument(json);
        expect(loaded.metadata.project_name).toBe("Test Project");
        expect(loaded.metadata.created_by).toBe("tester");
        expect(loaded.metadata.date).toBeInstanceOf(Date);
        expect(loaded.metadata.date.getTime()).toBe(doc.metadata.date.getTime());
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Milestone 2 — auto-layout containers
// ═══════════════════════════════════════════════════════════════════════════

type ContainerRule = NonNullable<Node["layout"]["container"]>;

/** A container `P` at (px,py) with two children of the given sizes. Children carry
 * DELIBERATELY ABSURD stored x/y so any test that reads a real position proves the
 * stored value was ignored in favour of the computed one. */
function mkContainerScene(
    container: ContainerRule,
    opts: { px?: number; py?: number; c1?: [number, number]; c2?: [number, number] } = {}
): ProjectDocument {
    const { px = 0, py = 0, c1 = [50, 50], c2 = [60, 40] } = opts;
    const doc = createEmptyDocument();
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });
    doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: px, y: py, width: 400, height: 300 }, { container }));
    doc.nodes.set("c1", mk("c1", "P", [], { x: 999, y: 999, width: c1[0], height: c1[1] }, {}));
    doc.nodes.set("c2", mk("c2", "P", [], { x: -999, y: -999, width: c2[0], height: c2[1] }, {}));
    doc.rootNodeUuids = ["P"];
    return doc;
}

describe("M2 LayoutEngine — the flex-stack math", () => {
    const kids = [{ id: "a", width: 50, height: 50 }, { id: "b", width: 60, height: 40 }];

    test("row packs along x; column packs along y; gap and padding both apply", () => {
        const row = layoutChildren({ direction: "row", gap: 10, padding: 20 }, { width: 400, height: 300 }, kids);
        expect(row.get("a")).toEqual({ x: 20, y: 20, width: 50, height: 50 });   // pad, then item
        expect(row.get("b")).toEqual({ x: 80, y: 20, width: 60, height: 40 });   // 20 + 50 + gap10

        const col = layoutChildren({ direction: "column", gap: 10, padding: 20 }, { width: 400, height: 300 }, kids);
        expect(col.get("a")).toEqual({ x: 20, y: 20, width: 50, height: 50 });
        expect(col.get("b")).toEqual({ x: 20, y: 80, width: 60, height: 40 });   // 20 + 50 + gap10 down
    });

    test("cross-axis alignment: start / center / end place the item, stretch resizes it", () => {
        // innerCross (row) = height 300 - 2*pad 20 = 260.
        const at = (align: ContainerRule["alignItems"]) =>
            layoutChildren({ direction: "row", padding: 20, alignItems: align }, { width: 400, height: 300 }, kids);

        expect(at("start").get("a")!.y).toBe(20);                    // padding edge
        expect(at("center").get("a")!.y).toBe(125);                  // 20 + (260-50)/2
        expect(at("end").get("a")!.y).toBe(230);                     // 20 + (260-50)
        // stretch fills the cross axis AND overrides the child's own cross-size.
        expect(at("stretch").get("a")).toEqual({ x: 20, y: 20, width: 50, height: 260 });
        expect(at("stretch").get("b")).toEqual({ x: 70, y: 20, width: 60, height: 260 });
    });

    test("defaults: no gap, no padding, alignItems 'start'", () => {
        const d = layoutChildren({ direction: "row" }, { width: 400, height: 300 }, kids);
        expect(d.get("a")).toEqual({ x: 0, y: 0, width: 50, height: 50 });
        expect(d.get("b")).toEqual({ x: 50, y: 0, width: 60, height: 40 });
    });

    test("isLayoutContainer recognises only nodes with a container", () => {
        expect(isLayoutContainer({ layout: { container: { direction: "row" } } })).toBe(true);
        expect(isLayoutContainer({ layout: {} })).toBe(false);
        expect(isLayoutContainer(undefined)).toBe(false);
    });
});

describe("M2 layout through computeGeometry", () => {
    test("a container computes its children's positions, replacing their stored x/y", () => {
        const doc = mkContainerScene({ direction: "row", gap: 10, padding: 20 }, { px: 100, py: 100 });
        const cs = computeGeometry(doc);
        // World = P's world (100,100) + computed local. The absurd stored 999/-999
        // never appears — position is a RESULT, not the stored intent.
        expect(cs.nodes.get("c1")!.bounds).toMatchObject({ x: 120, y: 120, width: 50, height: 50 });
        expect(cs.nodes.get("c2")!.bounds).toMatchObject({ x: 180, y: 120, width: 60, height: 40 });
    });

    test("stretch changes the rendered LOCAL size, and it hit-tests at that size", () => {
        const doc = mkContainerScene({ direction: "row", padding: 20, alignItems: "stretch" });
        const cs = computeGeometry(doc);
        expect(cs.nodes.get("c1")!.local).toEqual({ x: 20, y: 20, width: 50, height: 260 });
        // The stretched box is hit-testable along its full height (y up to 280).
        expect(hitTest(cs, 40, 270)).toBe("c1");
    });

    test("removing the container reverts children to their own stored geometry", () => {
        const doc = mkContainerScene({ direction: "row", padding: 20 }, { px: 100, py: 100 });
        const dispatcher = new ActionDispatcher(doc);
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("c1")!.bounds.x).toBe(120); // laid out
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "P", { container: undefined }));
        // Now the stored 999 is honoured again: world x = 100 + 999.
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("c1")!.bounds.x).toBe(1099);
    });

    test("nested containers: an inner container lays out within its stretched size", () => {
        // P (column, stretch) makes its child C fill P's inner width; C (row) then packs
        // ITS children across that stretched width.
        const doc = createEmptyDocument();
        const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
            ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });
        doc.nodes.set("P", mk("P", null, ["C"], { x: 0, y: 0, width: 200, height: 200 }, { container: { direction: "column", padding: 10, alignItems: "stretch" } }));
        doc.nodes.set("C", mk("C", "P", ["g"], { x: 0, y: 0, width: 1, height: 30 }, { container: { direction: "row", alignItems: "end" } }));
        doc.nodes.set("g", mk("g", "C", [], { x: 0, y: 0, width: 20, height: 10 }, {}));
        doc.rootNodeUuids = ["P"];

        const cs = computeGeometry(doc);
        // C is stretched to P's inner width 200 - 2*10 = 180, at local (10,10).
        expect(cs.nodes.get("C")!.local).toEqual({ x: 10, y: 10, width: 180, height: 30 });
        // g sits at C's world (10,10) plus its own local (x 0, y end-aligned within
        // height 30 → 20): world (10, 30).
        expect(cs.nodes.get("g")!.bounds).toMatchObject({ x: 10, y: 30, width: 20, height: 10 });
    });

    test("a laid-out child composes through its container's TRANSFORM, not around it", () => {
        // The doc claims a laid-out child still inherits the parent's matrix. Prove it:
        // a container scaled 2× about its own origin must scale its child's COMPUTED
        // position and size — layout does not bypass the transform pipeline.
        const doc = createEmptyDocument();
        const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], node: Partial<Node>): Node =>
            ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout: {}, ...node });
        doc.nodes.set("P", mk("P", null, ["c"], { x: 0, y: 0, width: 100, height: 100 },
            { layout: { container: { direction: "row", padding: 10 } }, transform: { scaleX: 2, scaleY: 2, origin: { x: 0, y: 0 } } }));
        doc.nodes.set("c", mk("c", "P", [], { x: 999, y: 999, width: 50, height: 50 }, {}));
        doc.rootNodeUuids = ["P"];

        const cs = computeGeometry(doc);
        // Child local from layout: padding 10 → (10,10,50,50). Under the container's
        // 2× scale about (0,0): position 10→20 and size 50→100.
        expect(cs.nodes.get("c")!.bounds).toEqual({ x: 20, y: 20, width: 100, height: 100 });
    });
});

describe("M2 layout dirty-tracking — the sibling ripple", () => {
    test("expandDirtyForLayout dirties a container when one of its children is dirty", () => {
        const withContainer = mkContainerScene({ direction: "row" });
        expect([...expandDirtyForLayout(withContainer, new Set(["c1"]))].sort()).toEqual(["P", "c1"]);

        // A plain (non-container) parent is NOT dragged in — only real layout parents.
        const plain = createDocWithParentChild();
        expect([...expandDirtyForLayout(plain, new Set(["child-001"]))]).toEqual(["child-001"]);
    });

    test("resizing one child reflows its sibling, incrementally, though only the resized child was reported", () => {
        const doc = mkContainerScene({ direction: "row" }, { c1: [50, 50], c2: [50, 50] });
        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("c2")!.bounds.x).toBe(50); // packed right after c1(width 50)

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new ResizeNodeAction(dispatcher.getDocument(), "c1", 80, 50));

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);

        expect(full.nodes.get("c2")!.bounds.x).toBe(80);          // the sibling genuinely MOVED (non-vacuous)
        expect(dirty.has("c2")).toBe(false);                      // ...yet nothing reported c2 as changed
        expect(incremental.nodes.get("c2")!.bounds.x).toBe(80);   // the ripple recomputed it anyway
    });

    // These two exercise the case expandDirtyForLayout CANNOT reach on its own — the
    // affected container is not the current parent of any reported node — so the
    // structural actions must report it. The fuzz does not reliably hit this exact
    // shape, so it is pinned deterministically.
    test("reparenting a child OUT of a container reflows the siblings it left behind", () => {
        const doc = mkContainerScene({ direction: "row" }, { c1: [50, 50], c2: [50, 50] });
        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("c2")!.bounds.x).toBe(50);

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        // Move c1 to the root; c2 is now the container's ONLY child and must slide to 0.
        dispatcher.dispatchAction(new ReparentNodeAction(dispatcher.getDocument(), "c1", null));

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("c2")!.bounds.x).toBe(0);           // sibling slid left (non-vacuous)
        expect(dirty.has("c2")).toBe(false);                      // c2 itself was never reported
        expect(statesEqualBounds(incremental, full)).toBe(true);  // the old container was dirtied anyway
    });

    test("deleting a child of a container reflows the surviving siblings", () => {
        const doc = mkContainerScene({ direction: "row" }, { c1: [50, 50], c2: [50, 50] });
        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new DeleteNodeAction(dispatcher.getDocument(), "c1"));

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("c2")!.bounds.x).toBe(0);           // c2 slid into c1's old slot
        expect(dirty.has("c2")).toBe(false);
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    // A resize handle on a laid-out child IS reachable (ToolController's resize mode
    // does not skip laid-out children — unlike MoveTool — because resizing one is
    // meaningful: its size is its own, only its position is computed). So the pending
    // size must feed the layout so siblings reflow in the LIVE preview, before commit.
    // This pins the `pending?.width` branch in layoutContainerPass, which every other
    // test reaches only through the committed `?? geometry.width` fallback.
    test("a PENDING resize of a laid-out child reflows its siblings in the live preview", () => {
        const doc = mkContainerScene({ direction: "row" }, { c1: [50, 50], c2: [50, 50] });
        const base = computeGeometry(doc);
        expect(base.nodes.get("c2")!.bounds.x).toBe(50);

        const pending = new Map([["c1", { width: 90 }]]); // as a resize-handle drag would produce
        const preview = computeGeometry(doc, pending);
        expect(preview.nodes.get("c1")!.bounds.width).toBe(90); // the previewed size
        expect(preview.nodes.get("c2")!.bounds.x).toBe(90);     // sibling slid right (was 50) — non-vacuous

        // App's render path unions pending keys into the dirty set; the incremental
        // result must equal a full recompute of the same pending state.
        const incremental = computeGeometry(doc, pending, base, new Set(["c1"]));
        expect(statesEqualBounds(incremental, preview)).toBe(true);
    });
});

/** Structural equality of two computed states over order + per-node bounds. */
function statesEqualBounds(a: ReturnType<typeof computeGeometry>, b: ReturnType<typeof computeGeometry>): true | string {
    if (a.order.join("|") !== b.order.join("|")) return `order: ${a.order} vs ${b.order}`;
    if (a.nodes.size !== b.nodes.size) return `size ${a.nodes.size} vs ${b.nodes.size}`;
    for (const [id, an] of a.nodes) {
        const bn = b.nodes.get(id);
        if (!bn) return `missing ${id}`;
        for (const k of ["x", "y", "width", "height"] as const) {
            if (Math.abs(an.bounds[k] - bn.bounds[k]) > 1e-9) return `${id}.bounds.${k}: ${an.bounds[k]} vs ${bn.bounds[k]}`;
        }
    }
    return true;
}

describe("M2 UpdateNodeLayoutAction — write path", () => {
    test("sets a container, is undoable, round-trips through the schema-3 loader", () => {
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        const rule: ContainerRule = { direction: "row", gap: 5, padding: 10, alignItems: "center" };
        expect(dispatcher.dispatchAction(new UpdateNodeLayoutAction(doc, "parent-001", { container: rule })).success).toBe(true);
        expect(dispatcher.getDocument().nodes.get("parent-001")!.layout.container).toEqual(rule);

        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();

        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("parent-001")!.layout.container).toBeUndefined();
    });

    test("rejects invalid containers on the EDIT path", () => {
        const doc = createDocWithParentChild();
        const bad = (c: any) => new UpdateNodeLayoutAction(doc, "parent-001", { container: c }).validate();
        expect(bad({ direction: "diagonal" })).toBe(false);
        expect(bad({ direction: "row", gap: -5 })).toBe(false);
        expect(bad({ direction: "row", padding: NaN })).toBe(false);
        expect(bad({ direction: "row", alignItems: "middle" })).toBe(false);
        expect(bad({ direction: "row", gap: 5, padding: 10, alignItems: "center" })).toBe(true);
        expect(new UpdateNodeLayoutAction(doc, "no-such-node", { container: { direction: "row" } }).validate()).toBe(false);
    });

    // Round-trip closure for layout: the LOAD path must reject exactly what the edit
    // path does, or a hand-edited schema-3 file yields a document the editor could
    // never have authored. Raw JSON (not JSON.stringify) is the real attack vector.
    test("the LOAD path rejects the same containers the edit path does", () => {
        const bad = (layoutJson: string) =>
            `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": ${layoutJson} } } } }`;

        expect(() => deserializeDocument(bad(`{ "container": { "direction": "diagonal" } }`))).toThrow();
        expect(() => deserializeDocument(bad(`{ "container": { "direction": "row", "gap": -5 } }`))).toThrow();
        expect(() => deserializeDocument(bad(`{ "container": { "direction": "row", "padding": 1e999 } }`))).toThrow("finite"); // JSON 1e999 → Infinity
        // A valid container still loads.
        expect(() => deserializeDocument(bad(`{ "container": { "direction": "row", "gap": 5, "alignItems": "center" } }`))).not.toThrow();
    });
});

describe("M2 MoveTool — laid-out children are not free-draggable", () => {
    const at = (x: number) => ({ clientX: x, clientY: 0 } as MouseEvent);

    test("dragging a container's child records no pending move (its position is computed)", () => {
        const doc = mkContainerScene({ direction: "row" });
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState();
        es.selectedNodeIds = ["c1"];
        const tool = new MoveTool(dispatcher, es, () => { });

        tool.onMouseDown(at(0));
        tool.onMouseMove(at(50));
        expect(es.pendingGeometry).toBeNull(); // the drag never armed — nothing to move
    });

    test("the container itself (not laid out by anyone) stays draggable", () => {
        const doc = mkContainerScene({ direction: "row" });
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState();
        es.selectedNodeIds = ["P"];
        const tool = new MoveTool(dispatcher, es, () => { });

        tool.onMouseDown(at(0));
        tool.onMouseMove(at(50));
        expect([...(es.pendingGeometry?.keys() ?? [])]).toEqual(["P"]);
    });
});

describe("M2 fuzz — incremental compute stays exact WITH auto-layout in the mix", () => {
    type CS = ReturnType<typeof computeGeometry>;
    const statesEqual = (a: CS, b: CS): true | string => {
        if (a.order.join("|") !== b.order.join("|")) return `order: ${a.order} vs ${b.order}`;
        if (a.nodes.size !== b.nodes.size) return `size ${a.nodes.size} vs ${b.nodes.size}`;
        for (const [id, an] of a.nodes) {
            const bn = b.nodes.get(id);
            if (!bn) return `missing ${id}`;
            for (const k of ["a", "b", "c", "d", "e", "f"] as const) {
                if (Math.abs(an.world[k] - bn.world[k]) > 1e-9) return `${id}.world.${k}`;
            }
            for (const k of ["x", "y", "width", "height"] as const) {
                if (Math.abs(an.bounds[k] - bn.bounds[k]) > 1e-9) return `${id}.bounds.${k}`;
                if (Math.abs(an.local[k] - bn.local[k]) > 1e-9) return `${id}.local.${k}`;
            }
        }
        return true;
    };

    test("300 random ops — add / move / resize / reparent / delete / toggle-container / undo / redo", () => {
        let seed = 0x1234abcd;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];

        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));

        let prev = computeGeometry(dispatcher.getDocument());
        const ids: string[] = [];
        let counter = 0;

        const dirs = ["row", "column"] as const;
        const aligns = ["start", "center", "end", "stretch"] as const;

        for (let step = 0; step < 300; step++) {
            const doc = dispatcher.getDocument();
            const op = ids.length === 0 ? 0 : Math.floor(rnd() * 8);
            if (op === 0) {
                const id = "n" + (counter++);
                const parent = ids.length && rnd() < 0.5 ? pick(ids) : null;
                if (dispatcher.dispatchAction(new AddNodeAction(doc, "core.rectangle",
                    rnd() * 100, rnd() * 100, 1 + rnd() * 60, 1 + rnd() * 60, "#fff", id, parent)).success) ids.push(id);
            } else if (op === 1) {
                dispatcher.dispatchAction(new MoveNodeAction(doc, pick(ids), rnd() * 200 - 100, rnd() * 200 - 100));
            } else if (op === 2) {
                dispatcher.dispatchAction(new ResizeNodeAction(doc, pick(ids), 1 + rnd() * 80, 1 + rnd() * 80));
            } else if (op === 3) {
                // Change a random node's layout: a flex container (with random HUG flags),
                // OR remove the container, OR set a flex `grow`, OR make it a GRID (which
                // clears any container — mutual exclusivity — and lays children into cells).
                const track = () => { const q = rnd(); return q < 0.4 ? { px: rnd() * 40 } : q < 0.7 ? { fr: 1 + rnd() * 2 } : { auto: true as const }; };
                const hMode = pick(["left", "right", "left-right", "center", "scale"]);
                const vMode = pick(["top", "bottom", "top-bottom", "center", "scale"]);
                const r = rnd();
                const rule = r < 0.3
                    ? { container: { direction: pick([...dirs]), gap: rnd() * 12, padding: rnd() * 12, alignItems: pick([...aligns]), hugWidth: rnd() < 0.5, hugHeight: rnd() < 0.5, wrap: rnd() < 0.5, alignContent: pick(["start", "center", "end", "space-between", "space-around", "stretch"]), wrapReverse: rnd() < 0.5 } }
                    : r < 0.42
                        ? { container: undefined }
                        : r < 0.55
                            // grow (free > 0) and shrink (free < 0) — op-2 resizes drive both signs.
                            // colSpan/rowSpan are grid-child hints (inert under a flex parent) — a
                            // node that later becomes a grid child then spans multiple cells.
                            // ...plus sometimes an EXPLICIT grid line pin (both axes) — auto items flow around it.
                            ? { grow: rnd() < 0.4 ? 0 : rnd() * 3, shrink: rnd() < 0.4 ? 0 : rnd() * 3, colSpan: 1 + Math.floor(rnd() * 3), rowSpan: 1 + Math.floor(rnd() * 3), gridColumn: rnd() < 0.7 ? undefined : [1 + Math.floor(rnd() * 2), 3 + Math.floor(rnd() * 2)] as [number, number], gridRow: rnd() < 0.7 ? undefined : [1 + Math.floor(rnd() * 3), 4 + Math.floor(rnd() * 3)] as [number, number] }
                            : r < 0.72
                                // grid: `track()` now also emits `auto` (content-sized) tracks, and
                            // the grid may HUG either axis — so a grid child's size feeds its
                            // track and the grid's own size, pulling grid into the measure pass.
                            // `rows` may be shorter/longer than the derived rows; all must
                            // reconcile incremental===full.
                            ? { grid: { columns: Array.from({ length: 1 + Math.floor(rnd() * 3) }, track), rowHeight: track(), rows: rnd() < 0.5 ? undefined : Array.from({ length: 1 + Math.floor(rnd() * 3) }, track), hugWidth: rnd() < 0.4, hugHeight: rnd() < 0.4, autoFlow: pick(["row", "row dense", "column", "column dense"]), columnGap: rnd() * 8, rowGap: rnd() * 8, padding: rnd() * 8 } }
                                : r < 0.86
                                    // constraints: the action auto-captures constraintRef; op-2 resizes
                                    // (source a) and op-3 toggles + a later resize (source b) drive it.
                                    ? { constraints: { horizontal: hMode, vertical: vMode } }
                                    // absolute-escape (out of flow) and/or a flex/grid margin —
                                    // sometimes a uniform number, sometimes a per-side object.
                                    : { position: rnd() < 0.5 ? "absolute" : undefined, margin: rnd() < 0.5 ? rnd() * 10 : { top: rnd() * 8, right: rnd() * 8, bottom: rnd() * 8, left: rnd() * 8 } };
                dispatcher.dispatchAction(new UpdateNodeLayoutAction(doc, pick(ids), rule as any));
            } else if (op === 4) {
                dispatcher.dispatchAction(new ReparentNodeAction(doc, pick(ids), rnd() < 0.5 ? null : pick(ids)));
            } else if (op === 5) {
                dispatcher.dispatchAction(new DeleteNodeAction(doc, pick(ids)));
                // The id may now be gone; prune lazily so later picks stay valid.
                for (let i = ids.length - 1; i >= 0; i--) if (!dispatcher.getDocument().nodes.has(ids[i])) ids.splice(i, 1);
            } else if (op === 6) {
                dispatcher.undo();
            } else {
                dispatcher.redo();
            }

            const live = dispatcher.getDocument();
            const full = computeGeometry(live);
            const incremental = computeGeometry(live, null, prev, dirty);
            const eq = statesEqual(incremental, full);
            expect(eq).toBe(true); // names the exact node/field/step on any divergence

            prev = incremental;
            dirty.clear();
        }
    });
});

describe("M2 intrinsic (hug) sizing", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("measureIntrinsicSizes folds a hug container's axis from its children", () => {
        // row, gap 10, pad 20: main(width) = 50+60 + 10 + 40 = 160; cross(height) = max(50,40) + 40 = 90.
        const doc = mkContainerScene({ direction: "row", gap: 10, padding: 20, hugWidth: true, hugHeight: true }, { c1: [50, 50], c2: [60, 40] });
        const m = measureIntrinsicSizes(traverseSceneGraph(doc), null);
        expect(m.get("P")).toEqual({ width: 160, height: 90 });
        expect(m.get("c1")).toEqual({ width: 50, height: 50 }); // a leaf measures to its own size

        // column, only hugHeight: main(height) = 50+40 + gap5 + pad20 = 115; width stays stored (400).
        const col = mkContainerScene({ direction: "column", gap: 5, padding: 10, hugHeight: true }, { c1: [50, 50], c2: [60, 40] });
        expect(measureIntrinsicSizes(traverseSceneGraph(col), null).get("P")).toEqual({ width: 400, height: 115 });

        // an empty hug container collapses to just its padding.
        const empty = createEmptyDocument();
        empty.nodes.set("E", mk("E", null, [], { x: 0, y: 0, width: 333, height: 333 }, { container: { direction: "row", padding: 12, hugWidth: true, hugHeight: true } }));
        empty.rootNodeUuids = ["E"];
        expect(measureIntrinsicSizes(traverseSceneGraph(empty), null).get("E")).toEqual({ width: 24, height: 24 });
    });

    test("a hug container is SIZED to its contents through computeGeometry (stored size ignored)", () => {
        const doc = mkContainerScene({ direction: "row", gap: 10, padding: 20, hugWidth: true, hugHeight: true }, { c1: [50, 50], c2: [60, 40] });
        const cs = computeGeometry(doc);
        expect(cs.nodes.get("P")!.local).toEqual({ x: 0, y: 0, width: 160, height: 90 }); // stored 400x300 vestigial
        expect(cs.nodes.get("c1")!.bounds).toMatchObject({ x: 20, y: 20, width: 50, height: 50 });
        expect(cs.nodes.get("c2")!.bounds).toMatchObject({ x: 80, y: 20, width: 60, height: 40 });
    });

    test("hug-cross + stretch is coherent (measure uses PRE-stretch sizes, so no cycle)", () => {
        const doc = mkContainerScene({ direction: "row", padding: 0, alignItems: "stretch", hugHeight: true }, { c1: [50, 50], c2: [60, 40] });
        const cs = computeGeometry(doc);
        // P hugs height to the max OWN (pre-stretch) cross = max(50,40) = 50; width unhugged.
        expect(cs.nodes.get("P")!.local.height).toBe(50);
        expect(cs.nodes.get("P")!.local.width).toBe(400);
        // children then stretch to fill that hugged inner-cross (c2 grows 40 -> 50). No cycle.
        expect(cs.nodes.get("c1")!.local.height).toBe(50);
        expect(cs.nodes.get("c2")!.local.height).toBe(50);
    });

    // A fixed root over a hug chain, with a SIBLING of the chain under the fixed
    // container: top(fixed) > fix(fixed)[hugB, sib] > hugB(hug) > hugA(hug) > leaf.
    // "sib" is what makes "add the first fixed container" load-bearing — it must reflow
    // when the hug chain grows, and it only recomputes if "fix" enters the dirty set.
    function hugChain(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("top", mk("top", null, ["fix"], { x: 0, y: 0, width: 500, height: 500 }, { container: { direction: "row" } }));
        doc.nodes.set("fix", mk("fix", "top", ["hugB", "sib"], { x: 0, y: 0, width: 300, height: 300 }, { container: { direction: "row" } }));
        doc.nodes.set("hugB", mk("hugB", "fix", ["hugA"], { x: 0, y: 0, width: 999, height: 100 }, { container: { direction: "row", hugWidth: true } }));
        doc.nodes.set("hugA", mk("hugA", "hugB", ["leaf"], { x: 0, y: 0, width: 999, height: 100 }, { container: { direction: "row", hugWidth: true } }));
        doc.nodes.set("leaf", mk("leaf", "hugA", [], { x: 0, y: 0, width: 30, height: 30 }, {}));
        doc.nodes.set("sib", mk("sib", "fix", [], { x: 0, y: 0, width: 40, height: 40 }, {}));
        doc.rootNodeUuids = ["top"];
        return doc;
    }

    test("a size change ripples up the whole hug chain, halts at the first FIXED container, and reflows its siblings", () => {
        const doc = hugChain();

        // The climb dirties every hug ancestor AND the first fixed container ("fix"),
        // and STOPS there — "top" above it is not dragged in. (The sibling "sib" is not
        // in the climb output; it recomputes by inheriting fix's dirtiness downward.)
        expect([...expandDirtyForLayout(doc, new Set(["leaf"]))].sort()).toEqual(["fix", "hugA", "hugB", "leaf"]);

        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("hugB")!.local.width).toBe(30); // hugged to leaf(30) two levels down
        expect(base.nodes.get("sib")!.bounds.x).toBe(30);      // packed right after hugB(30)

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new ResizeNodeAction(dispatcher.getDocument(), "leaf", 80, 30));

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("hugB")!.local.width).toBe(80);   // grew 30 -> 80, TWO levels up (non-vacuous)
        expect(full.nodes.get("sib")!.bounds.x).toBe(80);       // sibling slid right with the chain
        expect(dirty.has("hugB")).toBe(false);                  // only "leaf" was ever reported
        expect(dirty.has("sib")).toBe(false);
        expect(statesEqualBounds(incremental, full)).toBe(true);// the multi-level climb caught all of it
    });

    test("a PENDING resize of a hug chain's leaf resizes the whole chain in the live preview", () => {
        const doc = hugChain();
        const base = computeGeometry(doc);
        expect(base.nodes.get("hugB")!.local.width).toBe(30);

        // A live resize preview of the deep leaf: pending only, never dispatched, and
        // deliberately NOT reported in the dirty set. The chain must still hug to it,
        // which only works because pending keys join the climb seed.
        const pending = new Map([["leaf", { width: 80 }]]);
        const preview = computeGeometry(doc, pending);
        expect(preview.nodes.get("hugB")!.local.width).toBe(80);

        const incremental = computeGeometry(doc, pending, base, new Set<string>()); // empty dirty set
        expect(statesEqualBounds(incremental, preview)).toBe(true);
    });

    test("reparenting into and out of a hug container resizes it (both parent chains ripple)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("F", mk("F", null, ["H", "b"], { x: 0, y: 0, width: 400, height: 400 }, { container: { direction: "row" } }));
        doc.nodes.set("H", mk("H", "F", ["a"], { x: 0, y: 0, width: 999, height: 100 }, { container: { direction: "row", hugWidth: true } }));
        doc.nodes.set("a", mk("a", "H", [], { x: 0, y: 0, width: 30, height: 30 }, {}));
        doc.nodes.set("b", mk("b", "F", [], { x: 0, y: 0, width: 40, height: 40 }, {}));
        doc.rootNodeUuids = ["F"];

        const dispatcher = new ActionDispatcher(doc);
        let prev = computeGeometry(dispatcher.getDocument());
        expect(prev.nodes.get("H")!.local.width).toBe(30);

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));

        // INTO: b joins H -> H hugs to a(30) + b(40) = 70.
        dispatcher.dispatchAction(new ReparentNodeAction(dispatcher.getDocument(), "b", "H"));
        let full = computeGeometry(dispatcher.getDocument());
        let incremental = computeGeometry(dispatcher.getDocument(), null, prev, dirty);
        expect(full.nodes.get("H")!.local.width).toBe(70);
        expect(statesEqualBounds(incremental, full)).toBe(true);

        prev = incremental; dirty.clear();

        // OUT: b leaves H -> H shrinks back to 30. The OLD parent (H) chain must ripple.
        dispatcher.dispatchAction(new ReparentNodeAction(dispatcher.getDocument(), "b", "F"));
        full = computeGeometry(dispatcher.getDocument());
        incremental = computeGeometry(dispatcher.getDocument(), null, prev, dirty);
        expect(full.nodes.get("H")!.local.width).toBe(30);
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("measure stays TOTAL: a hug container with a missing child collapses to padding, no throw", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["ghost"], { x: 0, y: 0, width: 333, height: 333 }, { container: { direction: "row", padding: 5, hugWidth: true, hugHeight: true } }));
        doc.rootNodeUuids = ["P"];
        expect(() => computeGeometry(doc)).not.toThrow();
        expect(measureIntrinsicSizes(traverseSceneGraph(doc), null).get("P")).toEqual({ width: 10, height: 10 });
    });

    test("hug flags are write-path citizens: schema-4 round-trip + both-paths validation", () => {
        const d = createDocWithParentChild();
        expect(new UpdateNodeLayoutAction(d, "parent-001", { container: { direction: "row", hugWidth: "yes" as any } }).validate()).toBe(false);
        expect(new UpdateNodeLayoutAction(d, "parent-001", { container: { direction: "row", hugWidth: true, hugHeight: false } }).validate()).toBe(true);

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "parent-001", { container: { direction: "column", hugHeight: true } }));
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();

        // Load path rejects a non-boolean hug flag exactly as the edit path does.
        const bad = `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": { "container": { "direction": "row", "hugWidth": "yes" } } } } } }`;
        expect(() => deserializeDocument(bad)).toThrow("boolean");
    });
});

describe("M2 flex-grow", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("layoutChildren distributes leftover main-axis space in proportion to grow", () => {
        // One grower fills the rest: free = 200 - (50+50) = 100 -> b = 50 + 100 = 150.
        const one = layoutChildren({ direction: "row" }, { width: 200, height: 100 },
            [{ id: "a", width: 50, height: 50 }, { id: "b", width: 50, height: 50, grow: 1 }]);
        expect(one.get("a")).toMatchObject({ x: 0, width: 50 });
        expect(one.get("b")).toMatchObject({ x: 50, width: 150 });

        // Two growers split proportionally 1:3 of the free 100 -> +25 / +75.
        const two = layoutChildren({ direction: "row" }, { width: 200, height: 100 },
            [{ id: "a", width: 50, height: 50, grow: 1 }, { id: "b", width: 50, height: 50, grow: 3 }]);
        expect(two.get("a")).toMatchObject({ x: 0, width: 75 });
        expect(two.get("b")).toMatchObject({ x: 75, width: 125 });

        // Gap + padding are subtracted from the free space first: inner = 200-40 = 160,
        // used = 30+30+gap10 = 70, free = 90 -> b = 30 + 90 = 120 at x = 20+30+10 = 60.
        const padded = layoutChildren({ direction: "row", gap: 10, padding: 20 }, { width: 200, height: 100 },
            [{ id: "a", width: 30, height: 30 }, { id: "b", width: 30, height: 30, grow: 1 }]);
        expect(padded.get("a")).toMatchObject({ x: 20, width: 30 });
        expect(padded.get("b")).toMatchObject({ x: 60, width: 120 });
    });

    test("grow is inert with no leftover space (exact fit or overflow — no shrink)", () => {
        // Overflow: used 100 > inner 80 -> free < 0 -> b keeps its base size, overflows.
        const overflow = layoutChildren({ direction: "row" }, { width: 80, height: 100 },
            [{ id: "a", width: 50, height: 50 }, { id: "b", width: 50, height: 50, grow: 1 }]);
        expect(overflow.get("b")).toMatchObject({ x: 50, width: 50 });
    });

    test("a fixed container grows a child to fill; a hug-main container leaves nothing to grow", () => {
        // Fixed 200-wide row: c2 grows from 50 to 150.
        const fixed = createEmptyDocument();
        fixed.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 200, height: 100 }, { container: { direction: "row" } }));
        fixed.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 50, height: 50 }, {}));
        fixed.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 50, height: 50 }, { grow: 1 }));
        fixed.rootNodeUuids = ["P"];
        const cs = computeGeometry(fixed);
        expect(cs.nodes.get("c1")!.bounds).toMatchObject({ x: 0, width: 50 });
        expect(cs.nodes.get("c2")!.bounds).toMatchObject({ x: 50, width: 150 });

        // Same tree but the container HUGS its main axis: it sizes to content (100), so
        // there is zero free space and grow does nothing.
        const hug = createEmptyDocument();
        hug.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 999, height: 100 }, { container: { direction: "row", hugWidth: true } }));
        hug.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 50, height: 50 }, {}));
        hug.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 50, height: 50 }, { grow: 1 }));
        hug.rootNodeUuids = ["P"];
        const hcs = computeGeometry(hug);
        expect(hcs.nodes.get("P")!.local.width).toBe(100);        // hugged to content
        expect(hcs.nodes.get("c2")!.bounds).toMatchObject({ x: 50, width: 50 }); // grow inert
    });

    test("resizing one child reflows a growing SIBLING (free space shrinks), incrementally", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 200, height: 100 }, { container: { direction: "row" } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 50, height: 50 }, { grow: 1 }));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 50, height: 50 }, { grow: 1 }));
        doc.rootNodeUuids = ["P"];

        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("c2")!.bounds.width).toBe(100); // free 100 split evenly -> +50 each

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new ResizeNodeAction(dispatcher.getDocument(), "c1", 80, 50));

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        // free = 200 - (80+50) = 70, split evenly -> c2 = 50 + 35 = 85 (was 100).
        expect(full.nodes.get("c2")!.bounds.width).toBe(85); // growing sibling shrank (non-vacuous)
        expect(dirty.has("c2")).toBe(false);                 // only c1 was reported
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("a PENDING resize of a grow child previews the SAME layout as committing it (no double-apply)", () => {
        // P fixed row 200; c1 and c2 both base 50, grow 1. Resizing c1's base to 80 makes
        // free = 200-(80+50) = 70, split evenly -> c1 grows to 115, c2 to 85 at x=115.
        const build = (c1w: number) => {
            const doc = createEmptyDocument();
            doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 200, height: 100 }, { container: { direction: "row" } }));
            doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: c1w, height: 50 }, { grow: 1 }));
            doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 50, height: 50 }, { grow: 1 }));
            doc.rootNodeUuids = ["P"];
            return doc;
        };
        // The COMMITTED truth: c1's stored width is 80.
        const committed = computeGeometry(build(80));
        // The PREVIEW: c1 stored 50, pending resize to 80 (exactly what a resize handle passes).
        const preview = computeGeometry(build(50), new Map([["c1", { width: 80 }]]));

        // Preview must equal commit — a grow child is grown PAST its pending base (to 115),
        // not clamped back to 80 with a 35px hole before c2.
        expect(preview.nodes.get("c1")!.bounds).toEqual(committed.nodes.get("c1")!.bounds);
        expect(preview.nodes.get("c2")!.bounds).toEqual(committed.nodes.get("c2")!.bounds);
        expect(preview.nodes.get("c1")!.bounds).toMatchObject({ x: 0, width: 115 });
        expect(preview.nodes.get("c2")!.bounds).toMatchObject({ x: 115, width: 85 });
    });

    test("grow OVERRIDES hug on a node that is both a hug container and a grow child", () => {
        // C hugs its own content (a 20-wide leaf) but is ALSO a grow child of a fixed
        // parent. Intended (CSS-like) semantics: grow wins on the shared axis — C is
        // stretched to fill the parent (200), past its hugged content, and its own child
        // then lays out within the GROWN size. (Locks the semantics; not a bug.)
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["C"], { x: 0, y: 0, width: 200, height: 100 }, { container: { direction: "row" } }));
        doc.nodes.set("C", mk("C", "P", ["leaf"], { x: 0, y: 0, width: 999, height: 60 }, { container: { direction: "row", hugWidth: true }, grow: 1 }));
        doc.nodes.set("leaf", mk("leaf", "C", [], { x: 0, y: 0, width: 20, height: 20 }, {}));
        doc.rootNodeUuids = ["P"];

        const cs = computeGeometry(doc);
        expect(cs.nodes.get("C")!.local.width).toBe(200);              // grown to fill, NOT hugged to 20
        expect(cs.nodes.get("leaf")!.bounds).toMatchObject({ x: 0, width: 20 }); // content stays its own size
    });

    test("grow is a write-path citizen: schema-5 round-trip + both-paths validation", () => {
        const d = createDocWithParentChild();
        expect(new UpdateNodeLayoutAction(d, "child-001", { grow: -1 }).validate()).toBe(false);
        expect(new UpdateNodeLayoutAction(d, "child-001", { grow: NaN }).validate()).toBe(false);
        expect(new UpdateNodeLayoutAction(d, "child-001", { grow: 2 }).validate()).toBe(true);

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "child-001", { grow: 3 }));
        expect(dispatcher.getDocument().nodes.get("child-001")!.layout.grow).toBe(3);
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();

        // Load path rejects a negative grow exactly as the edit path does — and note the
        // patch has NO container, so this also guards the pre-container early return.
        const bad = `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": { "grow": -1 } } } } }`;
        expect(() => deserializeDocument(bad)).toThrow("grow");
    });
});

describe("M2 grid", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });
    // Grid children carry a size (used only by `auto` tracks); these px/fr cases don't hit an
    // auto track, so any size works. Auto-track tests pass real sizes explicitly.
    const kids = (...specs: (string | { id: string; width: number; height: number })[]) =>
        specs.map(s => typeof s === "string" ? { id: s, width: 0, height: 0 } : s);

    test("layoutGridChildren auto-flows row-major with fixed tracks, gaps and padding", () => {
        // 2 cols 40px, colGap 10, rowGap 8, pad 5, rowHeight 30; 4 items -> 2 rows.
        const cells = layoutGridChildren(
            { columns: [{ px: 40 }, { px: 40 }], rowHeight: { px: 30 }, columnGap: 10, rowGap: 8, padding: 5 },
            { width: 200, height: 200 }, kids("a", "b", "c", "d"));
        expect(cells.get("a")).toEqual({ x: 5, y: 5, width: 40, height: 30 });   // r0c0
        expect(cells.get("b")).toEqual({ x: 55, y: 5, width: 40, height: 30 });  // r0c1 (5+40+10)
        expect(cells.get("c")).toEqual({ x: 5, y: 43, width: 40, height: 30 });  // r1c0 (5+30+8)
        expect(cells.get("d")).toEqual({ x: 55, y: 43, width: 40, height: 30 }); // r1c1
    });

    test("fr column tracks share leftover inner width; fr rowHeight equal-shares inner height", () => {
        // [50px, 1fr, 1fr] over width 250 -> fr tracks split the leftover 200 -> 100 each.
        const frCols = layoutGridChildren(
            { columns: [{ px: 50 }, { fr: 1 }, { fr: 1 }], rowHeight: { px: 40 } },
            { width: 250, height: 100 }, kids("a", "b", "c"));
        expect(frCols.get("a")).toMatchObject({ x: 0, width: 50 });
        expect(frCols.get("b")).toMatchObject({ x: 50, width: 100 });
        expect(frCols.get("c")).toMatchObject({ x: 150, width: 100 });

        // rowHeight fr over height 120, 4 items in 2 cols -> 2 rows of 60 each.
        const frRows = layoutGridChildren(
            { columns: [{ px: 100 }, { px: 100 }], rowHeight: { fr: 1 } },
            { width: 200, height: 120 }, kids("a", "b", "c", "d"));
        expect(frRows.get("a")).toMatchObject({ y: 0, height: 60 });
        expect(frRows.get("c")).toMatchObject({ y: 60, height: 60 });
    });

    test("explicit per-row tracks size each row; rowHeight is the IMPLICIT fallback beyond the list", () => {
        // 1 col, 3 items -> 3 rows. rows sizes only the first two ([20px, 1fr]); the 3rd row
        // falls back to the implicit rowHeight (30px). Over height 200: fixed = 20 + 30, the
        // lone fr row takes the leftover 150. This single case pins THREE behaviours at once:
        //  - explicit wins   : row 0 is 20 (from rows[0]), NOT the 30px rowHeight;
        //  - implicit fallback: row 2 is 30 (rowHeight), NOT rows[0] (a repeat would give 20);
        //  - per-row Y is a PREFIX SUM: row 1 at y=20, row 2 at y=170 — not a uniform stride;
        //  - fr rows share the leftover AFTER the px rows: 200 − 20 − 30 = 150.
        const cells = layoutGridChildren(
            { columns: [{ px: 100 }], rowHeight: { px: 30 }, rows: [{ px: 20 }, { fr: 1 }] },
            { width: 100, height: 200 }, kids("a", "b", "c"));
        expect(cells.get("a")).toEqual({ x: 0, y: 0, width: 100, height: 20 });    // r0: rows[0]
        expect(cells.get("b")).toEqual({ x: 0, y: 20, width: 100, height: 150 });  // r1: lone fr = leftover
        expect(cells.get("c")).toEqual({ x: 0, y: 170, width: 100, height: 30 });  // r2: implicit rowHeight
    });

    test("rows absent reproduces the uniform-rowHeight layout (backward compat)", () => {
        // The refactor routes rows through resolveTracks; with `rows` absent every row track
        // IS rowHeight, so a mixed fixed+fr grid must produce the pre-tail layout. (The share
        // here is an exact 1/2, so the values are bit-exact; the equivalence is numerical —
        // within a ULP — for non-dyadic fr shares, which is invisible to determinism.)
        const g = { columns: [{ px: 100 }, { px: 100 }] as const, rowHeight: { fr: 1 } as const, rowGap: 10 };
        const cells = layoutGridChildren(g, { width: 200, height: 130 }, kids("a", "b", "c", "d"));
        // 2 rows, rowGap 10 -> inner 120 split equally = 60 each; row 1 at y = 60 + 10.
        expect(cells.get("a")).toMatchObject({ y: 0, height: 60 });
        expect(cells.get("c")).toMatchObject({ y: 70, height: 60 });
    });

    test("a grid sizes its children to cells through computeGeometry (stored size ignored)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 200, height: 80 }, { grid: { columns: [{ fr: 1 }, { fr: 1 }], rowHeight: { px: 40 } } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 999, y: 999, width: 5, height: 5 }, {}));
        doc.nodes.set("c2", mk("c2", "P", [], { x: -999, y: -999, width: 5, height: 5 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        expect(cs.nodes.get("c1")!.bounds).toEqual({ x: 0, y: 0, width: 100, height: 40 });   // fills cell
        expect(cs.nodes.get("c2")!.bounds).toEqual({ x: 100, y: 0, width: 100, height: 40 });
    });

    test("deleting a grid item reflows the survivors into earlier cells, incrementally", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["a", "b", "c", "d"], { x: 0, y: 0, width: 200, height: 200 }, { grid: { columns: [{ px: 100 }, { px: 100 }], rowHeight: { px: 50 } } }));
        for (const id of ["a", "b", "c", "d"]) doc.nodes.set(id, mk(id, "P", [], { x: 0, y: 0, width: 10, height: 10 }, {}));
        doc.rootNodeUuids = ["P"];

        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("b")!.bounds).toMatchObject({ x: 100, y: 0 }); // r0c1

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new DeleteNodeAction(dispatcher.getDocument(), "a")); // remove the first cell

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("b")!.bounds).toMatchObject({ x: 0, y: 0 }); // b slid into a's old cell (non-vacuous)
        expect(dirty.has("b")).toBe(false);                                // only "a" (+ parent) was reported
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("adding an item to an fr-row grid reflows every existing row's height, incrementally", () => {
        // fr rows => row height depends on the item COUNT. Adding an item (which reports
        // only the NEW node) must reflow existing items — which requires the dirty climb
        // to recognise the grid as a layout container. A px-row grid or a delete could not
        // catch this (delete reports the parent directly; px rows don't resize on count).
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["a", "b"], { x: 0, y: 0, width: 60, height: 90 }, { grid: { columns: [{ px: 60 }], rowHeight: { fr: 1 } } }));
        doc.nodes.set("a", mk("a", "P", [], { x: 0, y: 0, width: 10, height: 10 }, {}));
        doc.nodes.set("b", mk("b", "P", [], { x: 0, y: 0, width: 10, height: 10 }, {}));
        doc.rootNodeUuids = ["P"];

        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("a")!.bounds.height).toBe(45); // 2 rows over 90

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", 0, 0, 10, 10, "#fff", "c", "P"));

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("a")!.bounds.height).toBe(30); // 3 rows over 90 (non-vacuous: 45 -> 30)
        expect(dirty.has("a")).toBe(false);                  // only "c" was reported
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("resizing a grid item does not teleport it to its ignored stored x/y (pending absorbed)", () => {
        // Review-found bug: the resize tool emits a pending patch built from the item's
        // STORED geometry (x/y = 999), and a laid-out child must ignore it entirely — its
        // whole rect is the cell. Previously a pending patch leaked x/y and the item flew
        // off to (999,999) during the drag.
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1"], { x: 0, y: 0, width: 200, height: 80 }, { grid: { columns: [{ fr: 1 }, { fr: 1 }], rowHeight: { px: 40 } } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 999, y: 999, width: 5, height: 5 }, {}));
        doc.rootNodeUuids = ["P"];
        const pending = new Map([["c1", { x: 999, y: 999, width: 15, height: 15 }]]);
        expect(computeGeometry(doc, pending).nodes.get("c1")!.bounds).toEqual({ x: 0, y: 0, width: 100, height: 40 });
    });

    test("a transaction setting container THEN grid on one node keeps the GRID, not neither", () => {
        // Review-found bug: the merged delta carried BOTH, and the old post-hoc "clear
        // both" dropped both -> a silent empty layout. Exclusivity now lives in the delta
        // (each set clears the other), so the field-by-field merge is last-wins.
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        const tx = new TransactionAction(doc, "flex-then-grid", [
            new UpdateNodeLayoutAction(doc, "parent-001", { container: { direction: "row" } }),
            new UpdateNodeLayoutAction(doc, "parent-001", { grid: { columns: [{ px: 20 }], rowHeight: { px: 20 } } }),
        ]);
        expect(dispatcher.dispatchAction(tx).success).toBe(true);
        const p = dispatcher.getDocument().nodes.get("parent-001")!;
        expect(p.layout.grid).toBeDefined();       // last set wins
        expect(p.layout.container).toBeUndefined(); // not both — and crucially not NEITHER
    });

    test("a transaction that patches one node TWICE keeps both fields — including `path`", () => {
        // The merge was a hand-written allow-list of patch fields, so everything added to
        // `PatchDelta` afterwards was silently dropped whenever two actions patched the same
        // node inside one transaction. A vertex drag is exactly that shape — a geometry action
        // plus a path action — and it moved the node's BOX while leaving the ink behind.
        const doc = createEmptyDocument();
        doc.nodes.set("P", {
            id: "P", type: "core.path", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 40, height: 40 },
            style: { fill: "#111111", opacity: 1 }, layout: {},
            path: [{ c: "M", x: 0, y: 0 }, { c: "L", x: 40, y: 40 }]
        });
        doc.rootNodeUuids = ["P"];
        const dispatcher = new ActionDispatcher(doc);
        const next: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 60, y: 10 }];
        expect(dispatcher.dispatchAction(new TransactionAction(doc, "vertex:P", [
            new UpdateNodeGeometryAction(doc, "P", { x: 5, y: 7, width: 60, height: 10 }),
            new UpdateNodePathAction(doc, "P", next)
        ])).success).toBe(true);
        const p = dispatcher.getDocument().nodes.get("P")!;
        expect(p.path).toEqual(next);                                  // the field the merge dropped
        expect(p.geometry).toMatchObject({ x: 5, y: 7, width: 60 });   // and the one it always kept
    });

    test("…and an `in`-read layer flag survives the same merge", () => {
        // A second field family, dropped by the same allow-list: `hidden`/`locked` are read with
        // `in` (clearing is a real edit), so losing the KEY is what breaks them, not losing a value.
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new TransactionAction(doc, "hide-and-move", [
            new SetNodeFlagsAction(doc, "child-001", { hidden: true }),
            new MoveNodeAction(doc, "child-001", 12, 34)
        ])).success).toBe(true);
        const c = dispatcher.getDocument().nodes.get("child-001")!;
        expect(c.hidden).toBe(true);
        expect(c.geometry).toMatchObject({ x: 12, y: 34 });
    });

    test("a move and a resize in one transaction keep BOTH halves of the geometry", () => {
        // The two actions emit PARTIAL geometry — `{x,y}` and `{width,height}` — so the merge
        // has to go field by field. Whole-value last-wins would silently discard the move.
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new TransactionAction(doc, "move+resize", [
            new MoveNodeAction(doc, "child-001", 11, 22),
            new ResizeNodeAction(doc, "child-001", 33, 44)
        ])).success).toBe(true);
        expect(dispatcher.getDocument().nodes.get("child-001")!.geometry)
            .toEqual({ x: 11, y: 22, width: 33, height: 44 });
    });

    test("two layout edits in one transaction keep the field the second one never mentions", () => {
        // Same reason as geometry, and the case that actually reaches a user: set the spacing,
        // then set the grid. The grid patch carries only `grid` (plus the `container: undefined`
        // that expresses exclusivity), so a whole-value merge would drop the spacing.
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new TransactionAction(doc, "spacing-then-grid", [
            new UpdateNodeLayoutAction(doc, "parent-001", { spacing: 12 }),
            new UpdateNodeLayoutAction(doc, "parent-001", { grid: { columns: [{ px: 20 }], rowHeight: { px: 20 } } })
        ])).success).toBe(true);
        const p = dispatcher.getDocument().nodes.get("parent-001")!;
        expect(p.layout.grid).toBeDefined();
        expect(p.layout.spacing).toBe(12);
    });

    test("when both patches carry the same field, the LATER action wins", () => {
        // The direction of the merge, which the mixed-field tests above cannot see: they pass
        // whichever way the spread runs. A path edited twice in one transaction must end at the
        // second value — the reverse order would make a transaction read back-to-front.
        const doc = createEmptyDocument();
        doc.nodes.set("P", {
            id: "P", type: "core.path", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 40, height: 40 },
            style: { fill: "#111111", opacity: 1 }, layout: {},
            path: [{ c: "M", x: 0, y: 0 }, { c: "L", x: 40, y: 40 }]
        });
        doc.rootNodeUuids = ["P"];
        const dispatcher = new ActionDispatcher(doc);
        const second: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 2, y: 2 }];
        expect(dispatcher.dispatchAction(new TransactionAction(doc, "twice", [
            new UpdateNodePathAction(doc, "P", [{ c: "M", x: 0, y: 0 }, { c: "L", x: 1, y: 1 }]),
            new UpdateNodePathAction(doc, "P", second)
        ])).success).toBe(true);
        expect(dispatcher.getDocument().nodes.get("P")!.path).toEqual(second);
    });

    test("the patch merge is a SPREAD, so the NEXT field added cannot be dropped in silence", () => {
        // The behavioural tests above only cover the fields that exist today. This is the guard
        // that survives the next one: an allow-list would have to be edited to stay correct,
        // and nothing forces that edit — a spread is correct without being touched.
        const src = readFileSync(resolve(__dirname, "../actions/TransactionAction.ts"), "utf8");
        expect(src).toMatch(/function mergePatch[^{]*\{\s*return \{\s*\.\.\.target,\s*\.\.\.source,/);
    });

    test("isLayoutContainer recognises a grid; grid and flex-container are mutually exclusive", () => {
        expect(isLayoutContainer({ layout: { grid: { columns: [{ px: 10 }], rowHeight: { px: 10 } } } })).toBe(true);

        // Setting a grid clears an existing flex container (and vice versa).
        const doc = createDocWithParentChild();
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(doc, "parent-001", { container: { direction: "row" } }));
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(doc, "parent-001", { grid: { columns: [{ px: 20 }], rowHeight: { px: 20 } } }));
        let p = dispatcher.getDocument().nodes.get("parent-001")!;
        expect(p.layout.container).toBeUndefined();
        expect(p.layout.grid).toBeDefined();
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "parent-001", { container: { direction: "column" } }));
        p = dispatcher.getDocument().nodes.get("parent-001")!;
        expect(p.layout.grid).toBeUndefined();
        expect(p.layout.container).toBeDefined();

        // A single patch carrying BOTH is rejected on the edit path.
        expect(new UpdateNodeLayoutAction(doc, "parent-001", { container: { direction: "row" }, grid: { columns: [{ px: 10 }], rowHeight: { px: 10 } } }).validate()).toBe(false);
    });

    test("grid is a write-path citizen: validation, current-schema round-trip, both-paths rejection", () => {
        const d = createDocWithParentChild();
        const ok = (grid: any) => new UpdateNodeLayoutAction(d, "parent-001", { grid }).validate();
        expect(ok({ columns: [{ px: 50 }], rowHeight: { px: 40 } })).toBe(true);
        expect(ok({ columns: [], rowHeight: { px: 40 } })).toBe(false);                 // empty columns
        expect(ok({ columns: [{ px: -5 }], rowHeight: { px: 40 } })).toBe(false);       // px < 0
        expect(ok({ columns: [{ fr: 0 }], rowHeight: { px: 40 } })).toBe(false);        // fr must be > 0
        expect(ok({ columns: [{ px: 5, fr: 1 }], rowHeight: { px: 40 } })).toBe(false); // both px + fr
        expect(ok({ columns: [{ px: 50 }], rowHeight: { fr: -1 } })).toBe(false);       // bad rowHeight
        // explicit per-row tracks: valid list ok; empty or malformed rejected.
        expect(ok({ columns: [{ px: 50 }], rowHeight: { px: 40 }, rows: [{ px: 10 }, { fr: 1 }] })).toBe(true);
        expect(ok({ columns: [{ px: 50 }], rowHeight: { px: 40 }, rows: [] })).toBe(false);          // empty rows
        expect(ok({ columns: [{ px: 50 }], rowHeight: { px: 40 }, rows: [{ fr: 0 }] })).toBe(false);  // fr must be > 0
        expect(ok({ columns: [{ px: 50 }], rowHeight: { px: 40 }, rows: [{ px: -5 }] })).toBe(false); // px < 0

        const dispatcher = new ActionDispatcher(d);
        // Round-trip a grid WITH explicit per-row `rows` — a positive path through serialize →
        // deserialize → layoutError, not just the rejection cases below.
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "parent-001", { grid: { columns: [{ px: 50 }, { fr: 1 }], rowHeight: { px: 40 }, rows: [{ px: 30 }, { fr: 1 }], columnGap: 4 } }));
        const reloaded = deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(reloaded.nodes.get("parent-001")!.layout.grid!.rows).toEqual([{ px: 30 }, { fr: 1 }]);

        const envelope = (layout: string) => `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": ${layout} } } } }`;
        // Load path rejects a malformed track exactly as the edit path does.
        expect(() => deserializeDocument(envelope(`{ "grid": { "columns": [{ "fr": 0 }], "rowHeight": { "px": 10 } } }`))).toThrow();
        // ...an empty explicit-rows array (a present-but-meaningless list)...
        expect(() => deserializeDocument(envelope(`{ "grid": { "columns": [{ "px": 10 }], "rowHeight": { "px": 10 }, "rows": [] } }`))).toThrow();
        // ...and a document carrying BOTH grid and container.
        expect(() => deserializeDocument(envelope(`{ "container": { "direction": "row" }, "grid": { "columns": [{ "px": 10 }], "rowHeight": { "px": 10 } } }`))).toThrow("mutually exclusive");
    });
});

describe("M2 grid measure-integration (auto tracks + grid hug)", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("an auto column sizes to the MAX child own-width; a narrower child stretches to fill it", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 200, height: 100 }, { grid: { columns: [{ auto: true }], rowHeight: { px: 20 } } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 30, height: 5 }, {})); // col0 row0 — narrower
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 50, height: 5 }, {})); // col0 row1 — widest
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // Track = max(30, 50) = 50; the narrower child STRETCHES from its own 30 to the 50 cell.
        expect(cs.nodes.get("c1")!.bounds).toEqual({ x: 0, y: 0, width: 50, height: 20 });
        expect(cs.nodes.get("c2")!.bounds).toEqual({ x: 0, y: 20, width: 50, height: 20 });
    });

    test("auto and fr columns coexist: fr shares the leftover AFTER the auto track's content", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 200, height: 50 }, { grid: { columns: [{ auto: true }, { fr: 1 }], rowHeight: { px: 10 } } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 40, height: 5 }, {}));   // col0 (auto) -> track 40
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 999, height: 5 }, {}));  // col1 (fr) -> width ignored
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        expect(cs.nodes.get("c1")!.bounds.width).toBe(40);   // auto = content
        expect(cs.nodes.get("c2")!.bounds.x).toBe(40);
        expect(cs.nodes.get("c2")!.bounds.width).toBe(160);  // fr = 200 - 40 (auto counted into `fixed`)
    });

    test("hugWidth sizes the grid to 2·pad + Σtracks + gaps — and that equals the sum of the cells", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 999, height: 40 },
            { grid: { columns: [{ px: 20 }, { auto: true }], rowHeight: { px: 10 }, hugWidth: true, columnGap: 5, padding: 3 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 999, height: 5 }, {})); // col0 (px20) -> ignored
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 50, height: 5 }, {}));  // col1 (auto) -> 50
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // hug = 2*3 + (20 + 50) + 5*(2-1) = 81 — NOT the stored 999.
        expect(cs.nodes.get("P")!.bounds.width).toBe(81);
        expect(cs.nodes.get("c1")!.bounds.width).toBe(20);
        expect(cs.nodes.get("c2")!.bounds.width).toBe(50);
        // The fuzz-blind structural invariant: the container's own size == where the last cell ends + padding.
        const c2 = cs.nodes.get("c2")!.bounds;
        expect(c2.x + c2.width + 3).toBe(cs.nodes.get("P")!.bounds.width);
    });

    test("fr tracks collapse to 0 on a HUGGED axis (no definite size to share)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 999, height: 20 },
            { grid: { columns: [{ auto: true }, { fr: 1 }], rowHeight: { px: 10 }, hugWidth: true } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 40, height: 5 }, {}));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 999, height: 5 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // Without the fr->0-under-hug rule, fr would grab `stored - auto` = 959 and the grid would stay ~999.
        expect(cs.nodes.get("P")!.bounds.width).toBe(40);
        expect(cs.nodes.get("c2")!.bounds.width).toBe(0);
        expect(cs.nodes.get("c2")!.bounds.x).toBe(40);
    });

    test("hugHeight sizes the grid to its auto ROWS", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 30, height: 999 },
            { grid: { columns: [{ px: 10 }], rowHeight: { auto: true }, hugHeight: true, rowGap: 4 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 5, height: 20 }, {})); // row0 (auto) -> 20
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 5, height: 35 }, {})); // row1 (auto) -> 35
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // hug height = 0 + (20 + 35) + 4*(2-1) = 59.
        expect(cs.nodes.get("P")!.bounds.height).toBe(59);
        expect(cs.nodes.get("c1")!.bounds.height).toBe(20);
        expect(cs.nodes.get("c2")!.bounds.height).toBe(35);
    });

    test("an auto/hug grid nested in a hug FLEX ripples a child resize up to the flex root, incrementally", () => {
        // The keystone incremental test: a grid child resize changes the grid's OWN (hug) size,
        // which must ripple to the hug-flex grandparent. That climb only happens because
        // `containerHugs` recognises a grid's hug flags — without it the flex root reuses a stale
        // size on the incremental path while a full recompute grows it.
        const doc = createEmptyDocument();
        doc.nodes.set("Root", mk("Root", null, ["G"], { x: 0, y: 0, width: 0, height: 0 },
            { container: { direction: "row", hugWidth: true, hugHeight: true } }));
        doc.nodes.set("G", mk("G", "Root", ["c1"], { x: 0, y: 0, width: 999, height: 999 },
            { grid: { columns: [{ auto: true }], rowHeight: { px: 10 }, hugWidth: true, hugHeight: true } }));
        doc.nodes.set("c1", mk("c1", "G", [], { x: 0, y: 0, width: 30, height: 10 }, {}));
        doc.rootNodeUuids = ["Root"];

        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("Root")!.bounds.width).toBe(30); // G hugs to c1's 30; Root hugs to G

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new ResizeNodeAction(dispatcher.getDocument(), "c1", 70, 10));

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("Root")!.bounds.width).toBe(70); // non-vacuous: 30 -> 70, two hug levels up
        expect(dirty.has("Root")).toBe(false);                 // only c1 was reported; the climb found Root
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("a PENDING drag of a grid child in an auto column ripples the hug up, incrementally", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("Root", mk("Root", null, ["G"], { x: 0, y: 0, width: 0, height: 0 },
            { container: { direction: "row", hugWidth: true, hugHeight: true } }));
        doc.nodes.set("G", mk("G", "Root", ["c1"], { x: 0, y: 0, width: 999, height: 999 },
            { grid: { columns: [{ auto: true }], rowHeight: { px: 10 }, hugWidth: true, hugHeight: true } }));
        doc.nodes.set("c1", mk("c1", "G", [], { x: 0, y: 0, width: 30, height: 10 }, {}));
        doc.rootNodeUuids = ["Root"];

        const base = computeGeometry(doc);
        const pending = new Map([["c1", { x: 0, y: 0, width: 70, height: 10 }]]);
        const full = computeGeometry(doc, pending);
        // Non-null (empty) dirty so the pending keys join the seed and the grid-aware climb runs.
        const incremental = computeGeometry(doc, pending, base, new Set<string>());
        expect(full.nodes.get("Root")!.bounds.width).toBe(70); // the live drag grows the whole chain
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("resizing a child in an auto column of a NON-hug grid reflows the whole column, incrementally", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 200, height: 20 },
            { grid: { columns: [{ auto: true }, { fr: 1 }], rowHeight: { px: 10 } } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 30, height: 5 }, {}));  // col0 (auto)
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 5, height: 5 }, {}));   // col1 (fr)
        doc.rootNodeUuids = ["P"];

        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("c2")!.bounds).toMatchObject({ x: 30, width: 170 }); // fr = 200 - auto 30

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new ResizeNodeAction(dispatcher.getDocument(), "c1", 80, 5));

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("c2")!.bounds).toMatchObject({ x: 80, width: 120 }); // auto 30->80, fr 170->120
        expect(dirty.has("c2")).toBe(false);                                        // only c1 reported
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("an empty hugging grid sizes to its padding + fixed/auto tracks + gaps (total, no throw)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("G", mk("G", null, [], { x: 0, y: 0, width: 999, height: 999 },
            { grid: { columns: [{ px: 20 }, { auto: true }], rowHeight: { px: 10 }, hugWidth: true, hugHeight: true, padding: 3, columnGap: 5 } }));
        doc.rootNodeUuids = ["G"];
        const cs = computeGeometry(doc);
        // No children: auto col -> 0, rows = ceil(0/2) = 0. width = 2*3 + (20 + 0) + 5*(2-1) = 31; height = 2*3 = 6.
        expect(cs.nodes.get("G")!.bounds.width).toBe(31);
        expect(cs.nodes.get("G")!.bounds.height).toBe(6);
    });

    test("resolveGridTracks never throws on an auto track (the `\"px\" in t` footgun) and returns numbers", () => {
        // auto MUST be an object: `\"px\" in \"auto\"` would be a TypeError inside this must-never-throw path.
        expect(() => resolveGridTracks(
            { columns: [{ auto: true }, { px: 5 }], rowHeight: { auto: true } },
            [{ width: 7, height: 9 }], { width: 100, height: 100 })).not.toThrow();
        const r = resolveGridTracks({ columns: [{ auto: true }], rowHeight: { auto: true } }, [{ width: 7, height: 9 }], { width: 100, height: 100 });
        expect(r.colWidths[0]).toBe(7);   // auto col = child own-width
        expect(r.rowHeights[0]).toBe(9);  // auto row = child own-height
        // Totality: a damaged 0-column grid must not divide-by-zero (ceil(n/0) -> Infinity -> RangeError).
        expect(() => resolveGridTracks({ columns: [], rowHeight: { px: 1 } }, [{ width: 1, height: 1 }], { width: 10, height: 10 })).not.toThrow();
    });

    test("auto + hug are write-path citizens: validation, schema-11 round-trip, both-paths rejection", () => {
        const d = createDocWithParentChild();
        const ok = (grid: any) => new UpdateNodeLayoutAction(d, "parent-001", { grid }).validate();
        expect(ok({ columns: [{ auto: true }], rowHeight: { px: 10 } })).toBe(true);
        expect(ok({ columns: [{ px: 10 }], rowHeight: { auto: true } })).toBe(true);
        expect(ok({ columns: [{ px: 10 }], rowHeight: { px: 10 }, hugWidth: true, hugHeight: false })).toBe(true);
        expect(ok({ columns: [{ auto: false }], rowHeight: { px: 10 } })).toBe(false);          // auto must be true
        expect(ok({ columns: [{ auto: 1 }], rowHeight: { px: 10 } })).toBe(false);              // auto must be true
        expect(ok({ columns: [{ px: 1, auto: true }], rowHeight: { px: 10 } })).toBe(false);    // exactly one kind
        expect(ok({ columns: [{ px: 10 }], rowHeight: { px: 10 }, hugWidth: "yes" })).toBe(false); // non-boolean flag

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "parent-001", { grid: { columns: [{ auto: true }, { fr: 1 }], rowHeight: { auto: true }, hugWidth: true } }));
        const reloaded = deserializeDocument(serializeDocument(dispatcher.getDocument()));
        const g = reloaded.nodes.get("parent-001")!.layout.grid!;
        expect(g.columns[0]).toEqual({ auto: true });
        expect(g.hugWidth).toBe(true);

        const envelope = (layout: string) => `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": ${layout} } } } }`;
        // Load path rejects an `{auto:false}` track and a non-boolean hug flag, exactly as the edit path does.
        expect(() => deserializeDocument(envelope(`{ "grid": { "columns": [{ "auto": false }], "rowHeight": { "px": 10 } } }`))).toThrow();
        expect(() => deserializeDocument(envelope(`{ "grid": { "columns": [{ "px": 10 }], "rowHeight": { "px": 10 }, "hugWidth": "yes" } }`))).toThrow();
    });
});

describe("M2 grid spans", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("placeGridItems: sparse forward placement, skips occupied cells, derives the row count", () => {
        // cols 3, items A(1×1) B(colSpan1,rowSpan2) C D E(1×1) F(colSpan3). B's row-span pushes E
        // off (1,1); F's full-width span forces row 2 -> derived rows 3 > ceil(6/3) = 2.
        const { cells, rows } = placeGridItems([{}, { rowSpan: 2 }, {}, {}, {}, { colSpan: 3 }], 3);
        expect(cells.map(c => [c.col, c.row])).toEqual([[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2]]);
        expect(rows).toBe(3);
        // SPARSE (forward-only, no backfill): [colSpan2, colSpan2, 1] leaves a gap at (0,2) that the
        // 3rd item does NOT backfill — it lands at (1,2). (Dense packing would put it at (0,2).)
        expect(placeGridItems([{ colSpan: 2 }, { colSpan: 2 }, {}], 3).cells[2]).toEqual({ col: 2, row: 1, colSpan: 1, rowSpan: 1 });
        // colSpan > cols clamps to a full-width cell.
        expect(placeGridItems([{ colSpan: 99 }], 3).cells[0]).toEqual({ col: 0, row: 0, colSpan: 3, rowSpan: 1 });
        // fractional / non-positive spans clamp to 1; empty and 0-column grids are total.
        expect(placeGridItems([{ colSpan: 1.9, rowSpan: -5 }], 3).cells[0]).toMatchObject({ colSpan: 1, rowSpan: 1 });
        expect(placeGridItems([], 3)).toEqual({ cells: [], rows: 0, cols: 3 });
        expect(placeGridItems([{}], 0)).toEqual({ cells: [], rows: 0, cols: 0 });
        // OOM guard: a pathological rowSpan clamps to GRID_SPAN_MAX, never throws or explodes `rows`.
        const big = placeGridItems([{ rowSpan: 1e9 }], 1);
        expect(big.cells[0].rowSpan).toBe(GRID_SPAN_MAX);
        expect(big.rows).toBe(GRID_SPAN_MAX);
        // REVIEW REGRESSION: the occupancy set is Σ(colSpan·rowSpan), NOT the row count — so many
        // WIDE-spanning children in a WIDE grid used to blow the runtime `Set` cap (a hard throw
        // near ~17 items), even though every span is individually valid. The derived-row cap +
        // pile-into-last-band must keep it bounded and total (all items still placed, no throw).
        const wide = placeGridItems(Array.from({ length: 50 }, () => ({ colSpan: 1000, rowSpan: 1000 })), 1000);
        expect(wide.cells).toHaveLength(50);                 // every item placed
        expect(wide.rows).toBeLessThanOrEqual(GRID_MAX_TRACKS); // rows bounded (was ~50 000 pre-fix)
        // ...but a TALL thin grid is not over-restricted (cols=1 -> a generous row budget).
        expect(placeGridItems(Array.from({ length: 5000 }, () => ({})), 1).rows).toBe(5000);
    });

    test("a spanning cell covers its tracks plus the internal gaps", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2", "c3"], { x: 0, y: 0, width: 999, height: 999 },
            { grid: { columns: [{ px: 40 }, { px: 40 }, { px: 40 }], rowHeight: { px: 20 }, columnGap: 10, rowGap: 5 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 5, height: 5 }, { colSpan: 2 })); // cols 0-1
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 5, height: 5 }, {}));             // col 2
        doc.nodes.set("c3", mk("c3", "P", [], { x: 0, y: 0, width: 5, height: 5 }, {}));             // wraps to row 1
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // c1 spans cols 0+1: width = 40 + 40 + (2-1)·10 = 90; c2 at col 2 (x = 100); c3 on row 1 (y = 25).
        expect(cs.nodes.get("c1")!.bounds).toEqual({ x: 0, y: 0, width: 90, height: 20 });
        expect(cs.nodes.get("c2")!.bounds).toEqual({ x: 100, y: 0, width: 40, height: 20 });
        expect(cs.nodes.get("c3")!.bounds).toEqual({ x: 0, y: 25, width: 40, height: 20 });
    });

    test("a spanning item does NOT drive auto-track sizing (only single-span items fold in)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2", "c3"], { x: 0, y: 0, width: 999, height: 999 },
            { grid: { columns: [{ auto: true }, { auto: true }], rowHeight: { px: 10 }, hugWidth: true, columnGap: 0, padding: 0 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 100, height: 5 }, { colSpan: 2 })); // spans both cols
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 20, height: 5 }, {}));              // col 0, single
        doc.nodes.set("c3", mk("c3", "P", [], { x: 0, y: 0, width: 30, height: 5 }, {}));              // col 1, single
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // auto col0 = max single-span in col0 = 20; auto col1 = 30. c1's 100 does NOT inflate either
        // (it spans 2 tracks). hug width = 20 + 30 = 50; c1 fills both tracks = 50.
        expect(cs.nodes.get("P")!.bounds.width).toBe(50);
        expect(cs.nodes.get("c1")!.bounds.width).toBe(50);
    });

    test("a rowSpan pushes the derived row count, and a hugHeight grid sizes to it (== the cells)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["a", "b"], { x: 0, y: 0, width: 30, height: 999 },
            { grid: { columns: [{ px: 30 }], rowHeight: { px: 10 }, hugHeight: true, rowGap: 4 } }));
        doc.nodes.set("a", mk("a", "P", [], { x: 0, y: 0, width: 5, height: 5 }, { rowSpan: 3 })); // rows 0-2
        doc.nodes.set("b", mk("b", "P", [], { x: 0, y: 0, width: 5, height: 5 }, {}));             // pushed to row 3
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // 1 col, a spans rows 0-2, b lands at row 3 -> derived rows 4 (> ceil(2/1) = 2).
        // hugHeight = 4·10 + 4·rowGap = 40 + 12 = 52. a: rows 0-2 -> height 30 + 2·4 = 38.
        expect(cs.nodes.get("P")!.bounds.height).toBe(52);
        expect(cs.nodes.get("a")!.bounds).toMatchObject({ y: 0, height: 38 });
        expect(cs.nodes.get("b")!.bounds).toMatchObject({ y: 42, height: 10 });
        // FUZZ-BLIND structural check: the hugged height == the lowest cell edge + padding.
        const b = cs.nodes.get("b")!.bounds;
        expect(b.y + b.height + 0).toBe(cs.nodes.get("P")!.bounds.height);
    });

    test("deleting a spanning item reflows survivors and shrinks a hug grid, incrementally", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["a", "b", "c"], { x: 0, y: 0, width: 30, height: 999 },
            { grid: { columns: [{ px: 30 }], rowHeight: { px: 10 }, hugHeight: true, rowGap: 0 } }));
        doc.nodes.set("a", mk("a", "P", [], { x: 0, y: 0, width: 5, height: 5 }, { rowSpan: 2 })); // rows 0-1
        doc.nodes.set("b", mk("b", "P", [], { x: 0, y: 0, width: 5, height: 5 }, {}));             // row 2
        doc.nodes.set("c", mk("c", "P", [], { x: 0, y: 0, width: 5, height: 5 }, {}));             // row 3
        doc.rootNodeUuids = ["P"];

        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("P")!.bounds.height).toBe(40); // rows 0-3 -> 4·10

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new DeleteNodeAction(dispatcher.getDocument(), "a")); // remove the spanning item

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("P")!.bounds.height).toBe(20); // b,c now on rows 0,1 -> 2·10 (non-vacuous 40 -> 20)
        expect(full.nodes.get("c")!.bounds.y).toBe(10);      // c slid from row 3 (y 30) up to row 1 (non-vacuous)
        expect(dirty.has("c")).toBe(false);                  // the survivor "c" was never reported; it reflowed anyway
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("spans are write-path citizens: validation, schema-13 round-trip, both-paths rejection", () => {
        const d = createDocWithParentChild();
        const ok = (l: any) => new UpdateNodeLayoutAction(d, "child-001", l).validate();
        expect(ok({ colSpan: 2 })).toBe(true);
        expect(ok({ rowSpan: 3 })).toBe(true);
        expect(ok({ colSpan: 0 })).toBe(false);                 // < 1
        expect(ok({ rowSpan: -1 })).toBe(false);                // < 1
        expect(ok({ colSpan: 1.5 })).toBe(false);               // not an integer
        expect(ok({ rowSpan: GRID_SPAN_MAX + 1 })).toBe(false); // over the per-item span cap
        // The COLUMN count is capped too (bounds the placement occupancy set — review regression).
        const okGrid = (grid: any) => new UpdateNodeLayoutAction(d, "parent-001", { grid }).validate();
        expect(okGrid({ columns: Array.from({ length: GRID_MAX_TRACKS }, () => ({ px: 1 })), rowHeight: { px: 1 } })).toBe(true);
        expect(okGrid({ columns: Array.from({ length: GRID_MAX_TRACKS + 1 }, () => ({ px: 1 })), rowHeight: { px: 1 } })).toBe(false);

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "child-001", { colSpan: 2, rowSpan: 3 }));
        const reloaded = deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(reloaded.nodes.get("child-001")!.layout.colSpan).toBe(2);
        expect(reloaded.nodes.get("child-001")!.layout.rowSpan).toBe(3);

        const envelope = (layout: string) => `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": ${layout} } } } }`;
        expect(() => deserializeDocument(envelope(`{ "colSpan": 0 }`))).toThrow();
        expect(() => deserializeDocument(envelope(`{ "rowSpan": 1.5 }`))).toThrow();
    });
});

describe("M2 grid auto-flow (dense + column)", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("dense backfills an earlier gap that sparse leaves empty", () => {
        // cols 2, items [A 1×1, B colSpan2, C 1×1]. Sparse: A(0,0), B wraps to row 1 (won't fit beside A),
        // C flows forward to row 2 — the cell (0,1) beside A is left EMPTY. Dense re-scans from the origin,
        // so C backfills (0,1).
        expect(placeGridItems([{}, { colSpan: 2 }, {}], 2).cells[2]).toMatchObject({ col: 0, row: 2 }); // sparse: no backfill
        expect(placeGridItems([{}, { colSpan: 2 }, {}], 2, { dense: true }).cells[2]).toMatchObject({ col: 1, row: 0 }); // dense
    });

    test("column flow fills down each column then across, deriving the column count", () => {
        // 2 fixed rows, four 1×1 items -> col-major (0,0),(0,1),(1,0),(1,1); rows fixed 2, cols derived 2.
        const g = placeGridItems([{}, {}, {}, {}], 2, { columnFlow: true });
        expect(g.cells.map(c => [c.col, c.row])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
        expect(g.rows).toBe(2);
        expect(g.cols).toBe(2);
        // A `colSpan` in column flow must span COLUMNS (not rows) — this pins the transpose, which
        // 1×1 items cannot (the transpose of a 1×1 is itself).
        expect(placeGridItems([{ colSpan: 2 }], 2, { columnFlow: true }).cells[0]).toMatchObject({ col: 0, row: 0, colSpan: 2, rowSpan: 1 });
        // Empty column-flow grid → 0×0 (padding-only hug), mirroring row flow.
        expect(placeGridItems([], 2, { columnFlow: true })).toEqual({ cells: [], rows: 0, cols: 0 });
        // TOTAL/bounded: column flow's occupancy is fixedRows × rowsCap ≤ GRID_MAX_TRACKS² (same as
        // row flow), so a 1-row grid with a huge child count stays bounded — no throw, no hang.
        const big = placeGridItems(Array.from({ length: 3000 }, () => ({})), 1, { columnFlow: true });
        expect(big.cells).toHaveLength(3000);
        expect(big.cols).toBeLessThanOrEqual(GRID_MAX_TRACKS * GRID_MAX_TRACKS); // derived, bounded
        expect(big.rows).toBe(1);
    });

    test("a hugWidth column-flow grid derives auto columns from its children", () => {
        const doc = createEmptyDocument();
        // 1 fixed row (grid.rows absent), 3 items -> 3 derived columns, each auto-sized from its child.
        doc.nodes.set("P", mk("P", null, ["c1", "c2", "c3"], { x: 0, y: 0, width: 999, height: 10 },
            { grid: { columns: [{ auto: true }], rowHeight: { px: 10 }, autoFlow: "column", hugWidth: true, columnGap: 0, padding: 0 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 20, height: 5 }, {}));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 30, height: 5 }, {}));
        doc.nodes.set("c3", mk("c3", "P", [], { x: 0, y: 0, width: 25, height: 5 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        expect(cs.nodes.get("P")!.bounds.width).toBe(75); // 20 + 30 + 25 across 3 derived columns
        expect(cs.nodes.get("c3")!.bounds).toMatchObject({ x: 50, width: 25 }); // third column
    });

    test("auto-flow is a write-path citizen: validation + schema round-trip", () => {
        const d = createDocWithParentChild();
        const ok = (grid: any) => new UpdateNodeLayoutAction(d, "parent-001", { grid }).validate();
        expect(ok({ columns: [{ px: 1 }], rowHeight: { px: 1 }, autoFlow: "column dense" })).toBe(true);
        expect(ok({ columns: [{ px: 1 }], rowHeight: { px: 1 }, autoFlow: "diagonal" })).toBe(false); // not a flow

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "parent-001", { grid: { columns: [{ px: 10 }], rowHeight: { px: 10 }, autoFlow: "column" } }));
        expect(deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("parent-001")!.layout.grid!.autoFlow).toBe("column");
    });
});

describe("M2 grid explicit line placement", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("a fully-pinned item takes its lines (end-exclusive); auto items flow AROUND it", () => {
        // cols 3. Item at index 1 pinned to column line [2,3] (col 1) and row line [2,3] (row 1) -> (1,1).
        // Auto items A,C,D,E,F flow row-major; F would land at (1,1) but skips the pin to (1,2).
        const items = [{}, { gridColumn: [2, 3] as [number, number], gridRow: [2, 3] as [number, number] }, {}, {}, {}, {}];
        const { cells } = placeGridItems(items, 3);
        expect(cells[1]).toMatchObject({ col: 1, row: 1, colSpan: 1, rowSpan: 1 }); // the pin
        // [col,row] per index A,B,C,D,E,F: auto items fill row 0 (A,C,D), then row 1 flows AROUND the
        // pin at (col1,row1) — E takes col0, F skips the pin to col2.
        expect(cells.map(c => [c.col, c.row])).toEqual([[0, 0], [1, 1], [1, 0], [2, 0], [0, 1], [2, 1]]);
    });

    test("grid lines span the tracks between them (end - start)", () => {
        // gridColumn [1,3] -> col 0, colSpan 2; gridRow [1,2] -> row 0, rowSpan 1.
        const { cells } = placeGridItems([{ gridColumn: [1, 3] as [number, number], gridRow: [1, 2] as [number, number] }], 3);
        expect(cells[0]).toEqual({ col: 0, row: 0, colSpan: 2, rowSpan: 1 });
        // Single-axis placement is DEFERRED: a gridColumn WITHOUT gridRow auto-flows (colSpan 1), it
        // is NOT treated as explicit — and it must not throw on the missing axis.
        expect(placeGridItems([{ gridColumn: [2, 4] as [number, number] }], 3).cells[0]).toEqual({ col: 0, row: 0, colSpan: 1, rowSpan: 1 });
    });

    test("a pinned item grows a hugHeight grid to its row, and the hug equals the cells", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 20, height: 999 },
            { grid: { columns: [{ px: 20 }], rowHeight: { px: 10 }, hugHeight: true, rowGap: 0 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 5, height: 5 }, { gridColumn: [1, 2], gridRow: [4, 5] })); // pinned to row 3
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 5, height: 5 }, {}));                                     // auto -> row 0
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // c1 at row 3 -> rows = 4 -> hugHeight = 40. c1 y = 30, c2 y = 0. Structural: hug == lowest cell edge.
        expect(cs.nodes.get("P")!.bounds.height).toBe(40);
        expect(cs.nodes.get("c1")!.bounds.y).toBe(30);
        expect(cs.nodes.get("c2")!.bounds.y).toBe(0);
    });

    test("grid lines are write-path citizens: validation + schema round-trip", () => {
        const d = createDocWithParentChild();
        const ok = (l: any) => new UpdateNodeLayoutAction(d, "child-001", l).validate();
        expect(ok({ gridColumn: [1, 3] })).toBe(true);
        expect(ok({ gridRow: [2, 4] })).toBe(true);
        expect(ok({ gridColumn: [3, 1] })).toBe(false);                    // start >= end
        expect(ok({ gridColumn: [0, 2] })).toBe(false);                    // start < 1
        expect(ok({ gridColumn: [1] })).toBe(false);                       // wrong length
        expect(ok({ gridColumn: [1.5, 3] })).toBe(false);                  // non-integer
        expect(ok({ gridColumn: [1, GRID_MAX_TRACKS + 2] })).toBe(false);  // end past the cap

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "child-001", { gridColumn: [2, 4], gridRow: [1, 3] }));
        const l = deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("child-001")!.layout;
        expect(l.gridColumn).toEqual([2, 4]);
        expect(l.gridRow).toEqual([1, 3]);
        // Load path rejects a malformed pair exactly as the edit path does.
        const envelope = (layout: string) => `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": ${layout} } } } }`;
        expect(() => deserializeDocument(envelope(`{ "gridRow": [3, 1] }`))).toThrow();
    });
});

describe("M2 per-side + grid-cell margins", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("resolveMargin: a number is uniform; an object is per-side; omitted/negative sides are 0", () => {
        expect(resolveMargin(5)).toEqual({ top: 5, right: 5, bottom: 5, left: 5 });
        expect(resolveMargin({ top: 1, left: 2 })).toEqual({ top: 1, right: 0, bottom: 0, left: 2 });
        expect(resolveMargin(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
        expect(resolveMargin({ top: -3, right: 4 })).toEqual({ top: 0, right: 4, bottom: 0, left: 0 }); // negative clamps
    });

    test("per-side margins in a ROW map left/right to main and top/bottom to cross", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 200, height: 100 },
            { container: { direction: "row", gap: 0 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 30, height: 10 }, { margin: { left: 5, right: 15, top: 8, bottom: 0 } }));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 20, height: 10 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // main = left(5) before + right(15) after; cross = top(8). c1 x=5; c2 x = 5+30+15 = 50.
        expect(cs.nodes.get("c1")!.bounds).toEqual({ x: 5, y: 8, width: 30, height: 10 });
        expect(cs.nodes.get("c2")!.bounds).toEqual({ x: 50, y: 0, width: 20, height: 10 });
    });

    test("per-side margins in a COLUMN map top/bottom to main and left/right to cross", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 100, height: 200 },
            { container: { direction: "column", gap: 0 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 10, height: 30 }, { margin: { top: 5, bottom: 15, left: 8 } }));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 10, height: 20 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // main = top(5) before + bottom(15) after; cross = left(8). c1 y=5; c2 y = 5+30+15 = 50.
        expect(cs.nodes.get("c1")!.bounds).toEqual({ x: 8, y: 5, width: 10, height: 30 });
        expect(cs.nodes.get("c2")!.bounds).toEqual({ x: 0, y: 50, width: 10, height: 20 });
    });

    test("a hug row's main size includes the asymmetric per-side margins", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 999, height: 50 },
            { container: { direction: "row", hugWidth: true, gap: 0 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 30, height: 10 }, { margin: { left: 5, right: 15 } }));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 20, height: 10 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // hugWidth = (5 + 15 + 30) + (0 + 0 + 20) = 70.
        expect(cs.nodes.get("P")!.bounds.width).toBe(70);
    });

    test("a grid-cell margin insets the child within its cell", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1"], { x: 0, y: 0, width: 60, height: 40 },
            { grid: { columns: [{ px: 60 }], rowHeight: { px: 40 }, padding: 0 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 5, height: 5 }, { margin: { left: 5, right: 10, top: 8, bottom: 2 } }));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // cell 60×40; inset: x=5, y=8, width = 60-5-10 = 45, height = 40-8-2 = 30.
        expect(cs.nodes.get("c1")!.bounds).toEqual({ x: 5, y: 8, width: 45, height: 30 });
    });

    test("an auto grid track grows to fit the child PLUS its margins", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1"], { x: 0, y: 0, width: 999, height: 999 },
            { grid: { columns: [{ auto: true }], rowHeight: { px: 10 }, hugWidth: true, padding: 0 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 30, height: 5 }, { margin: { left: 5, right: 10 } }));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // auto col = child width 30 + left 5 + right 10 = 45; hugWidth = 45. c1 inset back to its own 30.
        expect(cs.nodes.get("P")!.bounds.width).toBe(45);
        expect(cs.nodes.get("c1")!.bounds).toMatchObject({ x: 5, width: 30 });
    });

    test("margins are write-path citizens: number + per-side, schema-14 round-trip, both-paths rejection", () => {
        const d = createDocWithParentChild();
        const ok = (l: any) => new UpdateNodeLayoutAction(d, "child-001", l).validate();
        expect(ok({ margin: 5 })).toBe(true);
        expect(ok({ margin: { top: 1, left: 2 } })).toBe(true);
        expect(ok({ margin: { top: -1 } })).toBe(false);   // negative side
        expect(ok({ margin: { top: "x" } })).toBe(false);  // non-number side
        expect(ok({ margin: "big" })).toBe(false);         // neither number nor object
        expect(ok({ margin: -5 })).toBe(false);            // negative number
        expect(ok({ margin: [1, 2, 3, 4] })).toBe(false);  // an array is not a Margins (review regression — would silently zero)

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "child-001", { margin: { top: 3, right: 4 } }));
        const reloaded = deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(reloaded.nodes.get("child-001")!.layout.margin).toEqual({ top: 3, right: 4 });

        const envelope = (layout: string) => `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": ${layout} } } } }`;
        expect(() => deserializeDocument(envelope(`{ "margin": { "top": -1 } }`))).toThrow();
        expect(() => deserializeDocument(envelope(`{ "margin": "big" }`))).toThrow();
        expect(() => deserializeDocument(envelope(`{ "margin": [1, 2, 3, 4] }`))).toThrow(); // array rejected on load, not silently zeroed
    });
});

describe("M2 flex wrap", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("breakFlexLines: break predicate, first-fits, margins, empty, nowrap", () => {
        // `margin` here is the per-axis TOTAL (before + after) — the old symmetric 2·margin.
        const it = (main: number, cross: number, margin = 0) => ({ main, cross, marginMain: 2 * margin, marginCross: 2 * margin });
        // innerMain 100, gap 10: [40,40] = 40+10+40 = 90 ≤ 100 stays; +40 -> 140 > 100 wraps.
        const l = breakFlexLines([it(40, 5), it(40, 8), it(40, 5)], 100, 10, true);
        expect(l.map(x => x.items)).toEqual([[0, 1], [2]]);
        expect(l[0].cross).toBe(8);   // max(5, 8) on line 0
        expect(l[1].cross).toBe(5);
        // exact fit stays on the line (strict `>`): 45 + 10 + 45 = 100, not > 100.
        expect(breakFlexLines([it(45, 1), it(45, 1)], 100, 10, true)).toHaveLength(1);
        // first child always fits even if it alone overflows.
        expect(breakFlexLines([it(200, 1)], 100, 0, true)).toEqual([{ items: [0], cross: 1 }]);
        // margins count into the item main and CHANGE the break: two 40-wide items fit bare
        // (80 ≤ 100), but with margin 10 (total 20) each item is 60, so 60+60=140 > 100 wraps.
        expect(breakFlexLines([it(40, 1), it(40, 1)], 100, 0, true).map(x => x.items)).toEqual([[0, 1]]);         // bare -> one line
        expect(breakFlexLines([it(40, 1, 10), it(40, 1, 10)], 100, 0, true).map(x => x.items)).toEqual([[0], [1]]); // margined -> wraps
        expect(breakFlexLines([], 100, 0, true)).toEqual([]);                       // empty -> []
        expect(breakFlexLines([it(40, 1), it(40, 1), it(40, 1)], 100, 10, false)).toHaveLength(1); // nowrap -> one line
    });

    test("a hugHeight wrap row sizes its height to the stacked lines — and that equals the cells", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2", "c3"], { x: 0, y: 0, width: 100, height: 999 },
            { container: { direction: "row", wrap: true, hugHeight: true, gap: 10 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 40, height: 20 }, {}));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 40, height: 30 }, {}));
        doc.nodes.set("c3", mk("c3", "P", [], { x: 0, y: 0, width: 40, height: 25 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // line0 = [c1,c2] (40+10+40=90 ≤ 100), line1 = [c3]. crossHug = (max(20,30)) + (25) + gap·1 = 30+25+10 = 65.
        expect(cs.nodes.get("P")!.bounds.height).toBe(65); // NOT the stored 999
        expect(cs.nodes.get("c2")!.bounds).toMatchObject({ y: 0, height: 30 });   // line 0
        expect(cs.nodes.get("c3")!.bounds).toMatchObject({ y: 40, height: 25 });  // line 1 (0 + 30 + gap 10)
        // FUZZ-BLIND structural check: the container's own height == the lowest cell edge + padding.
        const bottom = Math.max(...["c1", "c2", "c3"].map(id => { const b = cs.nodes.get(id)!.bounds; return b.y + b.height; }));
        expect(bottom + 0).toBe(cs.nodes.get("P")!.bounds.height);
    });

    test("grow is distributed PER LINE, not across the whole container", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2", "c3"], { x: 0, y: 0, width: 100, height: 100 },
            { container: { direction: "row", wrap: true, gap: 0 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 40, height: 10 }, { grow: 1 }));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 40, height: 10 }, { grow: 1 }));
        doc.nodes.set("c3", mk("c3", "P", [], { x: 0, y: 0, width: 40, height: 10 }, { grow: 1 }));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // line0 = [c1,c2] (free 20 shared -> 50 each); line1 = [c3] (free 60 -> fills to 100).
        // A whole-container computation would see free = 100 - 120 = -20 < 0 and grow NOTHING.
        expect(cs.nodes.get("c1")!.bounds.width).toBe(50);
        expect(cs.nodes.get("c2")!.bounds.width).toBe(50);
        expect(cs.nodes.get("c3")!.bounds.width).toBe(100);
    });

    test("a single wrap line still fills the container cross (nowrap-preserving band)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 100, height: 40 },
            { container: { direction: "row", wrap: true, alignItems: "stretch", gap: 0 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 30, height: 5 }, {}));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 30, height: 5 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // 60 ≤ 100 -> one line; the single line's band is innerCross (40), NOT its own cross (5),
        // so stretch fills the container exactly as a nowrap container does.
        expect(cs.nodes.get("c1")!.bounds.height).toBe(40);
        expect(cs.nodes.get("c2")!.bounds.height).toBe(40);
    });

    test("wrap is INERT when the main axis hugs (no definite main to wrap against)", () => {
        const doc = createEmptyDocument();
        // Small STORED width (50): if wrap were NOT disabled under hug-main, the measure fold
        // would break cross against 50 into 3 lines and mis-size the height, while the position
        // pass (breaking against the 140 hug width) stays one line — the exact measure/position
        // split the `!mainHugs` guard prevents. hugHeight makes that height observable.
        doc.nodes.set("P", mk("P", null, ["c1", "c2", "c3"], { x: 0, y: 0, width: 50, height: 999 },
            { container: { direction: "row", hugWidth: true, hugHeight: true, wrap: true, gap: 10 } }));
        for (const [id, w] of [["c1", 40], ["c2", 40], ["c3", 40]] as const) doc.nodes.set(id, mk(id, "P", [], { x: 0, y: 0, width: w, height: 10 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // hug-main -> single line -> width = 3·40 + 2·gap = 140; height = single-line max = 10.
        expect(cs.nodes.get("P")!.bounds.width).toBe(140);
        expect(cs.nodes.get("P")!.bounds.height).toBe(10); // NOT a 3-line stack
    });

    test("a grown wrap container wraps against its OWN main, not the stretched main", () => {
        // Consistency guard: the wrap container G is GROWN by its parent from 100 to 200, so
        // its computed local width (200) differs from its measured own width (100). Line-breaking
        // must use the measured own width in BOTH passes, or the cross-hug height (measured, 2
        // lines) would not match the laid-out stack (position). A fuzz-blind split — pinned here
        // by absolute geometry.
        const doc = createEmptyDocument();
        doc.nodes.set("O", mk("O", null, ["G"], { x: 0, y: 0, width: 200, height: 100 },
            { container: { direction: "row", gap: 0 } }));
        doc.nodes.set("G", mk("G", "O", ["c1", "c2"], { x: 0, y: 0, width: 100, height: 999 },
            { container: { direction: "row", wrap: true, hugHeight: true, gap: 0 }, grow: 1 }));
        doc.nodes.set("c1", mk("c1", "G", [], { x: 0, y: 0, width: 60, height: 10 }, {}));
        doc.nodes.set("c2", mk("c2", "G", [], { x: 0, y: 0, width: 60, height: 10 }, {}));
        doc.rootNodeUuids = ["O"];
        const cs = computeGeometry(doc);
        expect(cs.nodes.get("G")!.bounds.width).toBe(200);  // grown by O from its own 100
        expect(cs.nodes.get("G")!.bounds.height).toBe(20);  // but wraps against its OWN 100 -> 2 lines
        expect(cs.nodes.get("c2")!.bounds).toMatchObject({ x: 0, y: 10 }); // c2 wrapped to line 2, NOT beside c1
    });

    test("column-direction wrap is symmetric: hugWidth sizes to the stacked columns", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2", "c3"], { x: 0, y: 0, width: 999, height: 100 },
            { container: { direction: "column", wrap: true, hugWidth: true, gap: 10 } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 20, height: 40 }, {}));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 30, height: 40 }, {}));
        doc.nodes.set("c3", mk("c3", "P", [], { x: 0, y: 0, width: 25, height: 40 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        // line0 = [c1,c2] (40+10+40=90 ≤ 100), line1 = [c3]. hugWidth = max(20,30) + 25 + gap = 30+25+10 = 65.
        expect(cs.nodes.get("P")!.bounds.width).toBe(65);
        expect(cs.nodes.get("c3")!.bounds).toMatchObject({ x: 40, width: 25 }); // second column
    });

    test("re-wrapping (a resize that pushes a child onto a new line) grows the container, incrementally", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2", "c3"], { x: 0, y: 0, width: 100, height: 999 },
            { container: { direction: "row", wrap: true, hugHeight: true, gap: 0 } }));
        for (const id of ["c1", "c2", "c3"]) doc.nodes.set(id, mk(id, "P", [], { x: 0, y: 0, width: 30, height: 10 }, {}));
        doc.rootNodeUuids = ["P"];

        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("P")!.bounds.height).toBe(10); // 90 ≤ 100 -> one line

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new ResizeNodeAction(dispatcher.getDocument(), "c1", 60, 10)); // 60+30=90, +30 -> wraps

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("P")!.bounds.height).toBe(20); // non-vacuous: a new line, 10 -> 20
        expect(dirty.has("P")).toBe(false);                  // only c1 reported; the climb found P
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("a PENDING resize re-wraps in the live preview, incrementally", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2", "c3"], { x: 0, y: 0, width: 100, height: 999 },
            { container: { direction: "row", wrap: true, hugHeight: true, gap: 0 } }));
        for (const id of ["c1", "c2", "c3"]) doc.nodes.set(id, mk(id, "P", [], { x: 0, y: 0, width: 30, height: 10 }, {}));
        doc.rootNodeUuids = ["P"];

        const base = computeGeometry(doc);
        const pending = new Map([["c1", { x: 0, y: 0, width: 60, height: 10 }]]);
        const full = computeGeometry(doc, pending);
        const incremental = computeGeometry(doc, pending, base, new Set<string>());
        expect(full.nodes.get("P")!.bounds.height).toBe(20); // the drag pushes c3 to a new line, container grows
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("a grown hug-MAIN wrap container still grows its children (the override is gated on effectiveWrap)", () => {
        // Review-found: the position-pass measured-main override must fire only for a REALLY-
        // wrapping container (wrap AND main not hugged), NOT on `wrap === true`. G hugs its main
        // (hugWidth, row) so wrap is inert, but a growing parent enlarges it 120 -> 300. If the
        // override wrongly substituted G's un-grown intrinsic main (120), its grow child would be
        // scaled against 120 (free 0, stays 60) instead of the grown 300 (free 180, -> 240).
        const doc = createEmptyDocument();
        doc.nodes.set("O", mk("O", null, ["G"], { x: 0, y: 0, width: 300, height: 100 },
            { container: { direction: "row", gap: 0 } }));
        doc.nodes.set("G", mk("G", "O", ["c1", "c2"], { x: 0, y: 0, width: 100, height: 50 },
            { container: { direction: "row", wrap: true, hugWidth: true, gap: 0 }, grow: 1 }));
        doc.nodes.set("c1", mk("c1", "G", [], { x: 0, y: 0, width: 60, height: 10 }, { grow: 1 }));
        doc.nodes.set("c2", mk("c2", "G", [], { x: 0, y: 0, width: 60, height: 10 }, {}));
        doc.rootNodeUuids = ["O"];
        const cs = computeGeometry(doc);
        expect(cs.nodes.get("G")!.bounds.width).toBe(300); // O grows G from its 120 hug to 300
        expect(cs.nodes.get("c1")!.bounds.width).toBe(240); // c1 grows into the GROWN 300, not the 120 hug
        expect(cs.nodes.get("c2")!.bounds).toMatchObject({ x: 240, width: 60 });
    });

    test("wrap is a write-path citizen: validation, schema-12 round-trip, both-paths rejection", () => {
        const d = createDocWithParentChild();
        const ok = (container: any) => new UpdateNodeLayoutAction(d, "parent-001", { container }).validate();
        expect(ok({ direction: "row", wrap: true })).toBe(true);
        expect(ok({ direction: "row", wrap: false })).toBe(true);
        expect(ok({ direction: "row", wrap: "yes" })).toBe(false); // non-boolean

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "parent-001", { container: { direction: "row", wrap: true, hugHeight: true } }));
        const reloaded = deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(reloaded.nodes.get("parent-001")!.layout.container!.wrap).toBe(true);

        const envelope = (layout: string) => `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": ${layout} } } } }`;
        expect(() => deserializeDocument(envelope(`{ "container": { "direction": "row", "wrap": "yes" } }`))).toThrow();
    });
});

describe("M2 align-content + wrap-reverse", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });
    // A width-100 row that wraps each 60-wide child onto its own line (2 lines of cross 40, gap 10);
    // the FIXED height 200 leaves freeCross = 200 - (40+40+10) = 110 for align-content to distribute.
    const build = (extra: Partial<NonNullable<Node["layout"]["container"]>>) => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 100, height: 200 },
            { container: { direction: "row", wrap: true, gap: 10, ...extra } }));
        doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 60, height: 40 }, {}));
        doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 60, height: 40 }, {}));
        doc.rootNodeUuids = ["P"];
        return computeGeometry(doc);
    };

    test("align-content distributes the wrapped lines in the leftover cross space", () => {
        // start (default): lines pack at the top — c1 y=0, c2 y = 40+10 = 50.
        expect(build({}).nodes.get("c1")!.bounds.y).toBe(0);
        expect(build({}).nodes.get("c2")!.bounds.y).toBe(50);
        expect(build({ alignContent: "center" }).nodes.get("c1")!.bounds.y).toBe(55);          // leadOff 110/2
        expect(build({ alignContent: "center" }).nodes.get("c2")!.bounds.y).toBe(105);
        expect(build({ alignContent: "end" }).nodes.get("c1")!.bounds.y).toBe(110);            // leadOff 110
        expect(build({ alignContent: "space-between" }).nodes.get("c2")!.bounds.y).toBe(160);  // gap += 110
        expect(build({ alignContent: "space-around" }).nodes.get("c1")!.bounds.y).toBe(27.5);  // leadOff 110/4
    });

    test("align-content: stretch grows each line's band (feeding alignItems: stretch)", () => {
        const cs = build({ alignContent: "stretch", alignItems: "stretch" });
        // bandGrow = 110/2 = 55 -> band 95; alignItems:stretch fills it. c1 y=0 h95, c2 y = 95+10 = 105.
        expect(cs.nodes.get("c1")!.bounds).toMatchObject({ y: 0, height: 95 });
        expect(cs.nodes.get("c2")!.bounds).toMatchObject({ y: 105, height: 95 });
    });

    test("wrap-reverse reflects the lines across the container cross (line 0 to the far edge)", () => {
        const cs = build({ wrapReverse: true });
        // reflect: cross' = innerCross(200) - cross - crossSize. c1: 200-0-40 = 160; c2: 200-50-40 = 110.
        expect(cs.nodes.get("c1")!.bounds.y).toBe(160); // line 0 now at the bottom
        expect(cs.nodes.get("c2")!.bounds.y).toBe(110); // line 1 above it
    });

    test("align-content is a NO-OP on a cross-hug container (freeCross == 0) and on a single line", () => {
        const hug = (alignContent: any) => {
            const doc = createEmptyDocument();
            doc.nodes.set("P", mk("P", null, ["c1", "c2"], { x: 0, y: 0, width: 100, height: 999 },
                { container: { direction: "row", wrap: true, hugHeight: true, gap: 10, alignContent } }));
            doc.nodes.set("c1", mk("c1", "P", [], { x: 0, y: 0, width: 60, height: 40 }, {}));
            doc.nodes.set("c2", mk("c2", "P", [], { x: 0, y: 0, width: 60, height: 40 }, {}));
            doc.rootNodeUuids = ["P"];
            return computeGeometry(doc);
        };
        // hugHeight -> measured height == the lines (40+40+10 = 90) -> freeCross 0 -> every value identical.
        expect(hug("center").nodes.get("c1")!.bounds).toEqual(hug("space-between").nodes.get("c1")!.bounds);
        expect(hug("end").nodes.get("c2")!.bounds).toEqual(hug("start").nodes.get("c2")!.bounds);
        expect(hug("stretch").nodes.get("P")!.bounds.height).toBe(90); // hug == the cell union, unchanged
        // single line: `end` must not shift the lone line off the top.
        const single = createEmptyDocument();
        single.nodes.set("P", mk("P", null, ["a"], { x: 0, y: 0, width: 200, height: 100 },
            { container: { direction: "row", wrap: true, alignContent: "end" } }));
        single.nodes.set("a", mk("a", "P", [], { x: 0, y: 0, width: 30, height: 10 }, {}));
        single.rootNodeUuids = ["P"];
        expect(computeGeometry(single).nodes.get("a")!.bounds.y).toBe(0);
    });

    test("align-content / wrap-reverse are write-path citizens: validation + schema-15 round-trip", () => {
        const d = createDocWithParentChild();
        const ok = (container: any) => new UpdateNodeLayoutAction(d, "parent-001", { container }).validate();
        expect(ok({ direction: "row", alignContent: "space-around" })).toBe(true);
        expect(ok({ direction: "row", alignContent: "space-evenly" })).toBe(false); // not a supported value
        expect(ok({ direction: "row", wrapReverse: true })).toBe(true);
        expect(ok({ direction: "row", wrapReverse: 1 })).toBe(false);               // non-boolean

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "parent-001", { container: { direction: "row", alignContent: "center", wrapReverse: true } }));
        const c = deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("parent-001")!.layout.container!;
        expect(c.alignContent).toBe("center");
        expect(c.wrapReverse).toBe(true);
    });
});

describe("M2 constraints / anchors", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("resolveConstraints: per-mode math on a parent grown +100 wide / +60 tall", () => {
        const stored = { x: 10, y: 10, width: 50, height: 30 };
        const ref = { width: 100, height: 100 };
        const wide = { width: 200, height: 100 };   // width +100, height +0
        const tall = { width: 100, height: 160 };   // width +0,   height +60

        expect(resolveConstraints(stored, { horizontal: "left" }, ref, wide)).toEqual({ x: 10, y: 10, width: 50, height: 30 });
        expect(resolveConstraints(stored, { horizontal: "right" }, ref, wide)).toEqual({ x: 110, y: 10, width: 50, height: 30 });
        expect(resolveConstraints(stored, { horizontal: "left-right" }, ref, wide)).toEqual({ x: 10, y: 10, width: 150, height: 30 });
        expect(resolveConstraints(stored, { horizontal: "center" }, ref, wide)).toEqual({ x: 60, y: 10, width: 50, height: 30 });
        expect(resolveConstraints(stored, { horizontal: "scale" }, ref, wide)).toEqual({ x: 20, y: 10, width: 100, height: 30 });

        expect(resolveConstraints(stored, { vertical: "bottom" }, ref, tall)).toEqual({ x: 10, y: 70, width: 50, height: 30 });
        expect(resolveConstraints(stored, { vertical: "center" }, ref, tall)).toEqual({ x: 10, y: 40, width: 50, height: 30 });
        expect(resolveConstraints(stored, { vertical: "top-bottom" }, ref, tall)).toEqual({ x: 10, y: 10, width: 50, height: 90 });
    });

    test("resolveConstraints: absent constraints/ref, or R<=0, is static (returns stored)", () => {
        const stored = { x: 10, y: 10, width: 50, height: 30 };
        const ref = { width: 100, height: 100 };
        const P = { width: 200, height: 200 };
        expect(resolveConstraints(stored, undefined, ref, P)).toEqual(stored);
        expect(resolveConstraints(stored, { horizontal: "right" }, undefined, P)).toEqual(stored);
        // A zero-width reference cannot scale/inset horizontally -> static x/width (guards the divide).
        expect(resolveConstraints(stored, { horizontal: "scale" }, { width: 0, height: 100 }, P)).toEqual(stored);
    });

    test("source (a): directly resizing a plain parent moves its right-pinned child, incrementally", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["C"], { x: 0, y: 0, width: 100, height: 100 }, {})); // plain parent
        doc.nodes.set("C", mk("C", "P", [], { x: 20, y: 0, width: 30, height: 30 }, { constraints: { horizontal: "right" }, constraintRef: { width: 100, height: 100 } }));
        doc.rootNodeUuids = ["P"];

        const dispatcher = new ActionDispatcher(doc);
        const base = computeGeometry(dispatcher.getDocument());
        expect(base.nodes.get("C")!.bounds.x).toBe(20); // parent at reference -> no delta

        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new ResizeNodeAction(dispatcher.getDocument(), "P", 200, 100)); // +100 wide

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("C")!.bounds.x).toBe(120); // moved with the right edge (non-vacuous)
        expect(dirty.has("C")).toBe(false);              // only "P" was reported; C inherited
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("source (b): a layout-driven parent resize (flex-grow) moves its constrained grandchild", () => {
        // G (flex row) grows F to fill it; F is a PLAIN parent whose right-pinned child C
        // then responds to F's *computed* size — the responsive cascade, no direct resize.
        const doc = createEmptyDocument();
        doc.nodes.set("G", mk("G", null, ["F"], { x: 0, y: 0, width: 300, height: 100 }, { container: { direction: "row" } }));
        doc.nodes.set("F", mk("F", "G", ["C"], { x: 0, y: 0, width: 100, height: 100 }, { grow: 1 })); // grows in G; plain for C
        doc.nodes.set("C", mk("C", "F", [], { x: 20, y: 0, width: 30, height: 30 }, { constraints: { horizontal: "right" }, constraintRef: { width: 100, height: 100 } }));
        doc.rootNodeUuids = ["G"];

        const cs = computeGeometry(doc);
        expect(cs.nodes.get("F")!.local.width).toBe(300); // flex grew F from 100 to 300
        expect(cs.nodes.get("C")!.bounds.x).toBe(220);    // right-pinned: 20 + (300 - 100)
    });

    test("UpdateNodeLayoutAction auto-captures constraintRef from the parent's stored size", () => {
        const doc = createDocWithParentChild(); // parent-001 is 400x300
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(doc, "child-001", { constraints: { horizontal: "right" } }));
        expect(dispatcher.getDocument().nodes.get("child-001")!.layout.constraintRef).toEqual({ width: 400, height: 300 });
    });

    test("constraints are inert under a flex/grid parent (the child is laid out)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["C"], { x: 0, y: 0, width: 200, height: 100 }, { container: { direction: "row" } }));
        doc.nodes.set("C", mk("C", "P", [], { x: 20, y: 5, width: 30, height: 30 }, { constraints: { horizontal: "right" }, constraintRef: { width: 50, height: 50 } }));
        doc.rootNodeUuids = ["P"];
        // Flex places C at the padding edge (x=0); the constraint is ignored, not applied.
        expect(computeGeometry(doc).nodes.get("C")!.bounds.x).toBe(0);
    });

    test("a later constraints edit does NOT re-capture the frozen constraintRef (review regression)", () => {
        // Review-found bug: the auto-capture guard looked only at the incoming patch, so a
        // second mode edit re-captured ref from the parent's CURRENT (grown) size, zeroing
        // the delta and teleporting the anchored child back to its rest x.
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["C"], { x: 0, y: 0, width: 100, height: 100 }, {}));
        doc.nodes.set("C", mk("C", "P", [], { x: 20, y: 0, width: 30, height: 30 }, {}));
        doc.rootNodeUuids = ["P"];
        const dispatcher = new ActionDispatcher(doc);

        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "C", { constraints: { horizontal: "right" } }));
        expect(dispatcher.getDocument().nodes.get("C")!.layout.constraintRef).toEqual({ width: 100, height: 100 });

        dispatcher.dispatchAction(new ResizeNodeAction(dispatcher.getDocument(), "P", 300, 100)); // grow parent
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("C")!.bounds.x).toBe(220); // right-pinned: anchored

        // A second edit (change the mode) must NOT re-freeze the reference at the grown size.
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "C", { constraints: { horizontal: "right", vertical: "top" } }));
        expect(dispatcher.getDocument().nodes.get("C")!.layout.constraintRef).toEqual({ width: 100, height: 100 }); // still frozen at 100
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("C")!.bounds.x).toBe(220);                       // still anchored, not teleported to 20
    });

    test("a constrained child of a CONTAINER parent that does NOT lay it out stays static (gate)", () => {
        // Defensive: a container's child is normally laid out (computedLocal set), so the
        // constraint branch is only reached for a damaged tree — here C claims container P
        // but P does not list it, so P never lays C out. The `!isLayoutContainer` gate keeps
        // constraints OFF such a child (constraints are for PLAIN parents only), so it stays
        // at its stored x rather than being repositioned to P's 200-wide box.
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, [], { x: 0, y: 0, width: 200, height: 100 }, { container: { direction: "row" } }));
        doc.nodes.set("C", mk("C", "P", [], { x: 20, y: 0, width: 30, height: 30 }, { constraints: { horizontal: "right" }, constraintRef: { width: 100, height: 100 } }));
        doc.rootNodeUuids = ["P"];
        expect(computeGeometry(doc).nodes.get("C")!.bounds.x).toBe(20);
    });

    test("constraints are write-path citizens: schema-7 round-trip + both-paths validation", () => {
        const d = createDocWithParentChild();
        const ok = (l: any) => new UpdateNodeLayoutAction(d, "child-001", l).validate();
        expect(ok({ constraints: { horizontal: "right", vertical: "center" } })).toBe(true);
        expect(ok({ constraints: { horizontal: "bogus" } })).toBe(false);
        expect(ok({ constraints: { vertical: "sideways" } })).toBe(false);
        expect(ok({ constraintRef: { width: 0, height: 100 } })).toBe(false);   // width must be > 0
        expect(ok({ constraintRef: { width: 100, height: NaN } })).toBe(false);

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "child-001", { constraints: { horizontal: "scale" } }));
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();

        // Load path rejects a bad constraint even with no container (guards the early return).
        const bad = `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": { "constraints": { "horizontal": "bogus" } } } } } }`;
        expect(() => deserializeDocument(bad)).toThrow();
    });
});

describe("M2 margins + absolute-position escape", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("layoutChildren: uniform margin spaces on the main axis and insets on the cross axis", () => {
        // row, no gap/pad. a: margin 10; b: margin 5.
        const cells = layoutChildren({ direction: "row" }, { width: 300, height: 100 },
            [{ id: "a", width: 50, height: 30, margin: 10 }, { id: "b", width: 60, height: 40, margin: 5 }]);
        expect(cells.get("a")).toEqual({ x: 10, y: 10, width: 50, height: 30 });   // inset 10 on both axes
        expect(cells.get("b")).toEqual({ x: 75, y: 5, width: 60, height: 40 });    // 10+50+10 + 5 lead = 75

        // stretch insets the cross size by 2·margin.
        const s = layoutChildren({ direction: "row", alignItems: "stretch" }, { width: 300, height: 100 },
            [{ id: "a", width: 50, height: 30, margin: 10 }]);
        expect(s.get("a")).toEqual({ x: 10, y: 10, width: 50, height: 80 });       // 100 − 2·10

        // grow fills only the space margins leave: free = 200 − (2·10 + 50) = 130.
        const g = layoutChildren({ direction: "row" }, { width: 200, height: 100 },
            [{ id: "a", width: 50, height: 30, margin: 10, grow: 1 }]);
        expect(g.get("a")).toMatchObject({ x: 10, width: 180 });
    });

    test("a hug container's size includes its children's margins", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c"], { x: 0, y: 0, width: 999, height: 999 }, { container: { direction: "row", hugWidth: true, hugHeight: true } }));
        doc.nodes.set("c", mk("c", "P", [], { x: 0, y: 0, width: 50, height: 30 }, { margin: 10 }));
        doc.rootNodeUuids = ["P"];
        expect(computeGeometry(doc).nodes.get("P")!.local).toMatchObject({ width: 70, height: 50 }); // 2·10 + content
    });

    test("an absolute child is OUT of flow: siblings ignore it and it uses its stored geometry", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["abs", "b"], { x: 0, y: 0, width: 300, height: 100 }, { container: { direction: "row" } }));
        doc.nodes.set("abs", mk("abs", "P", [], { x: 100, y: 20, width: 30, height: 30 }, { position: "absolute" }));
        doc.nodes.set("b", mk("b", "P", [], { x: 0, y: 0, width: 50, height: 40 }, {}));
        doc.rootNodeUuids = ["P"];
        const cs = computeGeometry(doc);
        expect(cs.nodes.get("b")!.bounds.x).toBe(0);                                       // laid out first — abs took no slot
        expect(cs.nodes.get("abs")!.bounds).toEqual({ x: 100, y: 20, width: 30, height: 30 }); // its stored geometry
    });

    test("an absolute child does not contribute to a hug container's size", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["inflow", "abs"], { x: 0, y: 0, width: 999, height: 100 }, { container: { direction: "row", hugWidth: true } }));
        doc.nodes.set("inflow", mk("inflow", "P", [], { x: 0, y: 0, width: 50, height: 30 }, {}));
        doc.nodes.set("abs", mk("abs", "P", [], { x: 0, y: 0, width: 999, height: 30 }, { position: "absolute" }));
        doc.rootNodeUuids = ["P"];
        expect(computeGeometry(doc).nodes.get("P")!.local.width).toBe(50); // the absolute 999 is excluded
    });

    test("an absolute child of a CONTAINER can still be constrained (out of flow → pins to the parent box)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["abs"], { x: 0, y: 0, width: 100, height: 100 }, { container: { direction: "row" } }));
        doc.nodes.set("abs", mk("abs", "P", [], { x: 20, y: 0, width: 30, height: 30 }, { position: "absolute", constraints: { horizontal: "right" }, constraintRef: { width: 100, height: 100 } }));
        doc.rootNodeUuids = ["P"];
        const dispatcher = new ActionDispatcher(doc);
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("abs")!.bounds.x).toBe(20);
        dispatcher.dispatchAction(new ResizeNodeAction(dispatcher.getDocument(), "P", 200, 100));
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("abs")!.bounds.x).toBe(120); // right-pinned even under a flex parent
    });

    test("MoveTool: an absolute child of a container stays draggable; an in-flow sibling does not", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["abs", "inf"], { x: 0, y: 0, width: 200, height: 100 }, { container: { direction: "row" } }));
        doc.nodes.set("abs", mk("abs", "P", [], { x: 10, y: 10, width: 30, height: 30 }, { position: "absolute" }));
        doc.nodes.set("inf", mk("inf", "P", [], { x: 0, y: 0, width: 50, height: 40 }, {}));
        doc.rootNodeUuids = ["P"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState();
        const tool = new MoveTool(dispatcher, es, () => { });
        const at = (x: number) => ({ clientX: x, clientY: 0 } as MouseEvent);

        es.selectedNodeIds = ["abs"];
        tool.onMouseDown(at(0)); tool.onMouseMove(at(50));
        expect([...(es.pendingGeometry?.keys() ?? [])]).toEqual(["abs"]); // out of flow → draggable

        es.selectedNodeIds = ["inf"];
        tool.onMouseDown(at(0)); tool.onMouseMove(at(50));
        expect(es.pendingGeometry).toBeNull(); // in-flow (laid out) → not draggable
    });

    test("setting constraints on an absolute child of a HUG container does not auto-capture a bad ref (review regression)", () => {
        // Review-found: a container's STORED size ≠ its COMPUTED size (hug here: stored 400,
        // computed 50), so auto-capturing the ref from stored and resolving against computed
        // teleports the child at rest (x = 0 + (50 − 400) = −350). Auto-capture is now skipped
        // for container parents, so the absolute child stays put (constraint inert until a
        // tool provides a computed-derived ref).
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["inflow", "abs"], { x: 0, y: 0, width: 400, height: 100 }, { container: { direction: "row", hugWidth: true } }));
        doc.nodes.set("inflow", mk("inflow", "P", [], { x: 0, y: 0, width: 50, height: 30 }, {}));
        doc.nodes.set("abs", mk("abs", "P", [], { x: 0, y: 0, width: 30, height: 30 }, { position: "absolute" }));
        doc.rootNodeUuids = ["P"];
        const dispatcher = new ActionDispatcher(doc);
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("P")!.local.width).toBe(50); // hugs to inflow(50)

        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "abs", { constraints: { horizontal: "right" } }));
        expect(dispatcher.getDocument().nodes.get("abs")!.layout.constraintRef).toBeUndefined(); // NOT captured from the container's stored 400
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("abs")!.bounds.x).toBe(0);    // stays at rest, not teleported to −350
    });

    test("margin + position are write-path citizens: schema-8 round-trip + both-paths validation", () => {
        const d = createDocWithParentChild();
        const ok = (l: any) => new UpdateNodeLayoutAction(d, "child-001", l).validate();
        expect(ok({ margin: 5 })).toBe(true);
        expect(ok({ margin: -1 })).toBe(false);
        expect(ok({ margin: NaN })).toBe(false);
        expect(ok({ position: "absolute" })).toBe(true);
        expect(ok({ position: "fixed" })).toBe(false);

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "child-001", { position: "absolute", margin: 8 }));
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();

        const bad = `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": { "margin": -3 } } } } }`;
        expect(() => deserializeDocument(bad)).toThrow();
    });
});

describe("M2 flex-shrink", () => {
    const mk = (id: string, parent: string | null, children: string[], g: Node["geometry"], layout: Node["layout"]): Node =>
        ({ id, type: "core.rectangle", parent, children, geometry: g, style: { fill: "#000", opacity: 1 }, layout });

    test("layoutChildren shrinks overflow by shrink×base weight, clamped at 0", () => {
        // Two 80-wide items, shrink 1 each, into 100: deficit 60 split evenly -> 50 each.
        const even = layoutChildren({ direction: "row" }, { width: 100, height: 100 },
            [{ id: "a", width: 80, height: 30, shrink: 1 }, { id: "b", width: 80, height: 30, shrink: 1 }]);
        expect(even.get("a")).toMatchObject({ x: 0, width: 50 });
        expect(even.get("b")).toMatchObject({ x: 50, width: 50 });

        // Weighted: 100-wide items, shrink 1 vs 3, deficit 100 -> weights 100:300 -> −25 / −75.
        const weighted = layoutChildren({ direction: "row" }, { width: 100, height: 100 },
            [{ id: "a", width: 100, height: 30, shrink: 1 }, { id: "b", width: 100, height: 30, shrink: 3 }]);
        expect(weighted.get("a")).toMatchObject({ width: 75 });
        expect(weighted.get("b")).toMatchObject({ width: 25 });

        // The weight is shrink×BASE (CSS-style: a bigger item gives up more even at equal
        // shrink) — distinguishable only with UNEQUAL bases. width 150; a(100) b(200),
        // shrink 1 each: weights 100:200, deficit 150 -> −50 / −100 -> 50 / 100 (NOT 25/125).
        const byBase = layoutChildren({ direction: "row" }, { width: 150, height: 100 },
            [{ id: "a", width: 100, height: 30, shrink: 1 }, { id: "b", width: 200, height: 30, shrink: 1 }]);
        expect(byBase.get("a")).toMatchObject({ width: 50 });
        expect(byBase.get("b")).toMatchObject({ width: 100 });

        // Clamps at 0 (never negative) when a child's share exceeds its base.
        const clamped = layoutChildren({ direction: "row" }, { width: 5, height: 100 },
            [{ id: "a", width: 10, height: 30, shrink: 5 }, { id: "b", width: 10, height: 30, shrink: 0.1 }]);
        expect(clamped.get("a")!.width).toBe(0);
    });

    test("shrink is inert without overflow, and a child without a shrink factor overflows unchanged", () => {
        // Fits exactly / underflows: shrink does nothing.
        const fits = layoutChildren({ direction: "row" }, { width: 200, height: 100 },
            [{ id: "a", width: 50, height: 30, shrink: 1 }, { id: "b", width: 50, height: 30, shrink: 1 }]);
        expect(fits.get("a")).toMatchObject({ x: 0, width: 50 });
        expect(fits.get("b")).toMatchObject({ x: 50, width: 50 });

        // Overflow but no shrink factor -> keeps base size, overflows.
        const overflow = layoutChildren({ direction: "row" }, { width: 100, height: 100 },
            [{ id: "a", width: 80, height: 30 }, { id: "b", width: 80, height: 30 }]);
        expect(overflow.get("b")).toMatchObject({ x: 80, width: 80 });
    });

    test("grow and shrink are mutually exclusive by the sign of free space, incrementally", () => {
        // c has BOTH grow and shrink; the container's size decides which applies.
        const doc = createEmptyDocument();
        doc.nodes.set("P", mk("P", null, ["c"], { x: 0, y: 0, width: 100, height: 100 }, { container: { direction: "row" } }));
        doc.nodes.set("c", mk("c", "P", [], { x: 0, y: 0, width: 50, height: 30 }, { grow: 1, shrink: 1 }));
        doc.rootNodeUuids = ["P"];
        const dispatcher = new ActionDispatcher(doc);
        expect(computeGeometry(dispatcher.getDocument()).nodes.get("c")!.bounds.width).toBe(100); // free +50 -> grows to fill

        const base = computeGeometry(dispatcher.getDocument());
        const dirty = new Set<string>();
        dispatcher.onChange(r => r.updatedNodeIds.forEach(id => dirty.add(id)));
        dispatcher.dispatchAction(new ResizeNodeAction(dispatcher.getDocument(), "P", 30, 100)); // now free = -20

        const full = computeGeometry(dispatcher.getDocument());
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, dirty);
        expect(full.nodes.get("c")!.bounds.width).toBe(30); // free −20 -> shrinks to fit
        expect(statesEqualBounds(incremental, full)).toBe(true);
    });

    test("shrink is a write-path citizen: schema-9 round-trip + both-paths validation", () => {
        const d = createDocWithParentChild();
        const ok = (l: any) => new UpdateNodeLayoutAction(d, "child-001", l).validate();
        expect(ok({ shrink: 2 })).toBe(true);
        expect(ok({ shrink: -1 })).toBe(false);
        expect(ok({ shrink: NaN })).toBe(false);

        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(d, "child-001", { shrink: 3 }));
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();

        const bad = `{ "version": "${SCHEMA_VERSION}", "document": { "metadata": {}, "rootNodeUuids": ["n"], "variables": {},`
            + ` "nodes": { "n": { "id": "n", "type": "core.rectangle", "parent": null, "children": [],`
            + ` "geometry": { "x": 0, "y": 0, "width": 10, "height": 10 },`
            + ` "style": { "fill": "#000", "opacity": 1 }, "layout": { "shrink": -1 } } } } }`;
        expect(() => deserializeDocument(bad)).toThrow("shrink");
    });
});

// ─── Schema 16: core.ellipse + core.line node types ───
describe("Node types: ellipse + line (schema 16)", () => {
    test("NODE_TYPES includes the new shapes; isNodeType accepts them", () => {
        expect(NODE_TYPES).toContain("core.ellipse");
        expect(NODE_TYPES).toContain("core.line");
        expect(isNodeType("core.ellipse")).toBe(true);
        expect(isNodeType("core.line")).toBe(true);
        expect(isNodeType("core.bogus")).toBe(false);
    });

    test("dimensionError: rect/ellipse/text/image need a positive box", () => {
        for (const t of ["core.rectangle", "core.ellipse", "core.text", "core.image"] as const) {
            expect(dimensionError(t, 10, 10)).toBeNull();
            expect(dimensionError(t, 0, 10)).not.toBeNull();
            expect(dimensionError(t, 10, 0)).not.toBeNull();
            expect(dimensionError(t, -1, 10)).not.toBeNull();
        }
    });

    test("dimensionError: a line may collapse ONE axis, not both, and not go negative or non-finite", () => {
        expect(dimensionError("core.line", 100, 0)).toBeNull();  // horizontal
        expect(dimensionError("core.line", 0, 100)).toBeNull();  // vertical
        expect(dimensionError("core.line", 100, 50)).toBeNull(); // diagonal
        expect(dimensionError("core.line", 0, 0)).not.toBeNull();     // degenerate point
        expect(dimensionError("core.line", -1, 100)).not.toBeNull();  // negative
        expect(dimensionError("core.line", 100, NaN)).not.toBeNull(); // non-finite
    });

    test("AddNodeAction: ellipse/line create; a horizontal line is allowed; degenerate/strict rejected", () => {
        const doc = createEmptyDocument();
        expect(new AddNodeAction(doc, "core.ellipse", 0, 0, 20, 10).validate()).toBe(true);
        expect(new AddNodeAction(doc, "core.line", 0, 0, 100, 0).validate()).toBe(true);       // horizontal
        expect(new AddNodeAction(doc, "core.line", 0, 0, 0, 100).validate()).toBe(true);       // vertical
        expect(new AddNodeAction(doc, "core.line", 0, 0, 0, 0).validate()).toBe(false);        // degenerate point
        expect(new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 0).validate()).toBe(false);  // rect stays strict
        expect(new AddNodeAction(doc, "core.ellipse", 0, 0, 10, 0).validate()).toBe(false);    // ellipse stays strict
    });

    test("ResizeNodeAction: a line may collapse an axis, a rect may not", () => {
        const d = new ActionDispatcher(createEmptyDocument());
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.line", 0, 0, 50, 50, "#000", "L"));
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.rectangle", 0, 0, 50, 50, "#000", "R"));
        expect(new ResizeNodeAction(d.getDocument(), "L", 100, 0).validate()).toBe(true);
        expect(new ResizeNodeAction(d.getDocument(), "L", 0, 0).validate()).toBe(false);
        expect(new ResizeNodeAction(d.getDocument(), "R", 100, 0).validate()).toBe(false);
    });

    test("UpdateNodeGeometryAction merges the patch over current geometry for the per-type rule", () => {
        const d = new ActionDispatcher(createEmptyDocument());
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.line", 0, 0, 50, 50, "#000", "L"));
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.rectangle", 0, 0, 50, 50, "#000", "R"));
        expect(new UpdateNodeGeometryAction(d.getDocument(), "L", { width: 0 }).validate()).toBe(true);  // merged height 50 > 0
        expect(new UpdateNodeGeometryAction(d.getDocument(), "L", { width: 0, height: 0 }).validate()).toBe(false); // both zero
        expect(new UpdateNodeGeometryAction(d.getDocument(), "R", { height: 0 }).validate()).toBe(false); // rect strict
        expect(new UpdateNodeGeometryAction(d.getDocument(), "R", { width: undefined as any }).validate()).toBe(false); // present-undefined
    });

    test("ellipse, diagonal line, and horizontal line round-trip through serialize/deserialize", () => {
        const d = new ActionDispatcher(createEmptyDocument());
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.ellipse", 0, 0, 40, 20, "#f0f", "E"));
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.line", 0, 0, 60, 30, "#0ff", "D"));
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.line", 10, 10, 80, 0, "#00f", "H")); // horizontal
        const round = deserializeDocument(serializeDocument(d.getDocument()));
        expect(round.version).toBe(SCHEMA_VERSION);
        expect(round.nodes.get("E")!.type).toBe("core.ellipse");
        expect(round.nodes.get("H")!.geometry.height).toBe(0);
        expect(compareDocuments(d.getDocument(), round)).toBe(true);
    });

    test("ellipse/line participate in layout exactly like a rectangle (type-agnostic geometry)", () => {
        const doc = createEmptyDocument();
        const d = new ActionDispatcher(doc);
        d.dispatchAction(new AddNodeAction(doc, "core.rectangle", 0, 0, 300, 100, "#fff", "P"));
        d.dispatchAction(new UpdateNodeLayoutAction(d.getDocument(), "P", { container: { direction: "row", gap: 10, padding: 0 } }));
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.rectangle", 0, 0, 50, 40, "#f00", "a", "P"));
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.ellipse", 0, 0, 50, 40, "#0f0", "b", "P"));
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.line", 0, 0, 50, 40, "#00f", "c", "P"));
        const computed = computeGeometry(d.getDocument());
        expect(computed.nodes.get("a")!.bounds.x).toBe(0);
        expect(computed.nodes.get("b")!.bounds.x).toBe(60);  // 50 + gap 10
        expect(computed.nodes.get("c")!.bounds.x).toBe(120); // 110 + gap 10
    });
});

// ─── Schema 17: core.path node type ───
describe("Node type: path (schema 17)", () => {
    const M: PathCommand = { c: "M", x: 0, y: 0 };
    const L: PathCommand = { c: "L", x: 10, y: 10 };

    test("NODE_TYPES includes core.path; isNodeType accepts it", () => {
        expect(NODE_TYPES).toContain("core.path");
        expect(isNodeType("core.path")).toBe(true);
    });

    test("dimensionError treats core.path like a line — a flat bbox may collapse one axis", () => {
        expect(dimensionError("core.path", 100, 0)).toBeNull();
        expect(dimensionError("core.path", 0, 0)).not.toBeNull();
        expect(dimensionError("core.path", -1, 10)).not.toBeNull();
    });

    test("pathError: an absent path is fine on any node; only core.path may carry one", () => {
        expect(pathError("core.rectangle", undefined)).toBeNull();
        expect(pathError("core.path", undefined)).toBeNull();
        expect(pathError("core.rectangle", [M])).not.toBeNull(); // a rect must not carry path data
    });

    test("pathError: a present path must be a non-empty array opening with M, with finite coords", () => {
        expect(pathError("core.path", [M, L, { c: "Z" }])).toBeNull();
        expect(pathError("core.path", [M, { c: "C", x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 }, { c: "Q", x1: 1, y1: 2, x: 3, y: 4 }])).toBeNull();
        expect(pathError("core.path", "M 0 0")).not.toBeNull();            // not an array (rejects rep-A strings)
        expect(pathError("core.path", [])).toMatch(/at least one command/); // empty (specific message pins the guard)
        expect(pathError("core.path", [L])).not.toBeNull();                // must start with M
        expect(pathError("core.path", [M, { c: "A" }])).not.toBeNull();    // unknown command
        // A prototype-named command must be REJECTED cleanly, never crash the validator
        // (`in` would walk the prototype chain and then throw on the inherited member).
        expect(pathError("core.path", [M, { c: "toString", x: 0, y: 0 }])).toMatch(/unknown command/);
        expect(pathError("core.path", [M, { c: "__proto__" }])).toMatch(/unknown command/);
        expect(pathError("core.path", [M, { c: "L", x: NaN, y: 0 }])).not.toBeNull();     // non-finite coord
        expect(pathError("core.path", [M, { c: "L", x: 1 }])).not.toBeNull();             // missing a coord
    });

    test("pathError: the command count is capped (OOM guard)", () => {
        const huge = [M, ...Array.from({ length: PATH_MAX_COMMANDS }, () => L)]; // cap + 1
        expect(huge.length).toBe(PATH_MAX_COMMANDS + 1);
        expect(pathError("core.path", huge)).not.toBeNull();
        // Exactly at the cap is fine.
        expect(pathError("core.path", [M, ...Array.from({ length: PATH_MAX_COMMANDS - 1 }, () => L)])).toBeNull();
    });

    test("load path: a valid path loads; a bad path and a rect-with-path are rejected", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("p", { id: "p", type: "core.path", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {}, path: [M, L, { c: "Z" }] });
        doc.rootNodeUuids = ["p"];
        const round = deserializeDocument(serializeDocument(doc));
        expect(round.nodes.get("p")!.path).toEqual([M, L, { c: "Z" }]);
        expect(round.version).toBe(SCHEMA_VERSION);

        const badJson = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["p"], variables: {}, nodes: { p: { id: "p", type: "core.path", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {}, path: [{ c: "L", x: 1, y: 2 }] } } } });
        expect(() => deserializeDocument(badJson)).toThrow('must start with an "M"');

        const rectWithPath = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["r"], variables: {}, nodes: { r: { id: "r", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {}, path: [M] } } } });
        expect(() => deserializeDocument(rectWithPath)).toThrow("only a core.path node may carry path data");
    });

    test("AddNodeAction can create a core.path (empty path — a pen tool populates it later)", () => {
        const doc = createEmptyDocument();
        expect(new AddNodeAction(doc, "core.path", 0, 0, 40, 40).validate()).toBe(true);
        const d = new ActionDispatcher(doc);
        expect(d.dispatchAction(new AddNodeAction(d.getDocument(), "core.path", 0, 0, 40, 40, "#000", "P")).success).toBe(true);
        expect(d.getDocument().nodes.get("P")!.path).toBeUndefined(); // empty, renders nothing until edited
    });
});

// ─── Schema 18: Style effects (shadow + blur) ───
describe("Style effects: shadow + blur (schema 18)", () => {
    const SH: Shadow = { dx: 2, dy: 5, blur: 3, color: "#f00" };

    test("styleError: valid effects pass; invalid rejected", () => {
        expect(styleError({ shadow: SH, blur: 4 })).toBeNull();
        expect(styleError({ blur: -1 })).not.toBeNull();
        expect(styleError({ blur: NaN })).not.toBeNull();
        expect(styleError({ shadow: { dx: 2, dy: 5, blur: -1, color: "#f00" } })).not.toBeNull();       // shadow.blur < 0
        expect(styleError({ shadow: { dx: NaN, dy: 5, blur: 3, color: "#f00" } })).not.toBeNull();      // non-finite dx
        expect(styleError({ shadow: { dx: 2, dy: 5, blur: 3, color: 5 } as unknown as Shadow })).not.toBeNull(); // non-string color
        expect(styleError({ shadow: [] as unknown as Shadow })).not.toBeNull();                          // array
    });

    test("styleError still validates the pre-existing fields (closed inline duplication)", () => {
        expect(styleError({ opacity: 5 })).toMatch(/opacity must be within/);
        expect(styleError({ radius: -1 })).toMatch(/radius must be/);
        expect(styleError({ fontSize: 0 })).toMatch(/fontSize/);
        expect(styleError({ fill: 5 as unknown as string })).not.toBeNull();
    });

    test("load path accepts a node with effects and round-trips; rejects a bad blur", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("n", { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 20, height: 20 }, style: { fill: "#fff", opacity: 1, shadow: SH, blur: 4 }, layout: {} });
        doc.rootNodeUuids = ["n"];
        const round = deserializeDocument(serializeDocument(doc));
        expect(round.version).toBe(SCHEMA_VERSION);
        expect(round.nodes.get("n")!.style.shadow).toEqual(SH);
        expect(round.nodes.get("n")!.style.blur).toBe(4);
        expect(compareDocuments(doc, round)).toBe(true);

        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 20, height: 20 }, style: { fill: "#fff", opacity: 1, blur: -3 }, layout: {} } } } });
        expect(() => deserializeDocument(bad)).toThrow("blur must be finite");
    });

    test("UpdateNodeStyleAction validates effects via the shared styleError", () => {
        const d = new ActionDispatcher(createEmptyDocument());
        d.dispatchAction(new AddNodeAction(d.getDocument(), "core.rectangle", 0, 0, 20, 20, "#fff", "R"));
        expect(new UpdateNodeStyleAction(d.getDocument(), "R", { shadow: SH }).validate()).toBe(true);
        expect(new UpdateNodeStyleAction(d.getDocument(), "R", { blur: -1 }).validate()).toBe(false);
        expect(new UpdateNodeStyleAction(d.getDocument(), "R", { shadow: { dx: 1, dy: 1, blur: 1, color: 9 } as unknown as Shadow }).validate()).toBe(false);
    });
});

// ─── Basic shapes: one tool per drawable primitive, and content on the EDIT path ───
describe("ShapeTool: every basic shape draws", () => {
    const canvas = { left: 0, top: 0 } as DOMRect;
    const ev = (x: number, y: number) => ({ clientX: x, clientY: y } as unknown as MouseEvent);

    const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

    /** Drag a box with the given shape tool and return the node it committed (or undefined).
     *  `source` stands in for the app's file/URL picker (see `SourceResolver`). */
    function draw(kind: ShapeKind, x1: number, y1: number, x2: number, y2: number, source: string | null = PIXEL) {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const es = createEditorState();
        const tool = new ShapeTool(dispatcher, es, () => { }, kind, () => Promise.resolve(source));
        tool.onMouseDown(ev(x1, y1), canvas);
        tool.onMouseMove(ev(x2, y2), canvas);
        tool.onMouseUp();
        // An image resolves its source asynchronously; everything else has already committed.
        // Awaiting a resolved promise flushes that microtask, so one helper serves both.
        return Promise.resolve().then(() => {
            const doc = dispatcher.getDocument();
            const id = doc.rootNodeUuids[0];
            return { doc, dispatcher, node: id ? doc.nodes.get(id) : undefined, es };
        });
    }

    test("each kind commits its own node type, and the box is the drag", async () => {
        const expected: Record<ShapeKind, string> = {
            rectangle: "core.rectangle", ellipse: "core.ellipse", line: "core.line",
            text: "core.text", triangle: "core.path", polygon: "core.path", image: "core.image"
        };
        for (const kind of SHAPE_KINDS) {
            const { node } = await draw(kind, 10, 20, 110, 80);
            expect(node).toBeDefined();
            expect(node!.type).toBe(expected[kind]);
            expect(node!.geometry).toEqual({ x: 10, y: 20, width: 100, height: 60 });
        }
        // …and every kind the toolbar offers is covered by that map (no silent gap — adding a
        // ShapeKind without extending this map is a COMPILE error, which is how `image` was caught).
        expect(Object.keys(expected).sort()).toEqual([...SHAPE_KINDS].sort());
    });

    test("an image is created only once a SOURCE arrives — cancelling makes nothing", async () => {
        const withSource = await draw("image", 0, 0, 100, 60, PIXEL);
        expect(withSource.node!.src).toBe(PIXEL);
        // The user cancelled the file dialog: no node, and nothing to undo. (This outcome is
        // ALSO guaranteed by AddNodeAction refusing a null src, so it does not by itself prove
        // the tool's own null check runs — see the note there. It pins the BEHAVIOUR, which is
        // what matters here.)
        const cancelled = await draw("image", 0, 0, 100, 60, null);
        expect(cancelled.node).toBeUndefined();
        expect(cancelled.dispatcher.canUndo()).toBe(false);
        // A source the shared validator refuses never reaches the document either.
        const refused = await draw("image", 0, 0, 100, 60, "javascript:alert(1)");
        expect(refused.node).toBeUndefined();
    });

    test("an image node is NOT created synchronously — the drag alone commits nothing", () => {
        // The source dialog is async, so the node must not appear until it resolves; a
        // synchronous commit would create a source-less image that draws nothing.
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const es = createEditorState();
        const tool = new ShapeTool(dispatcher, es, () => { }, "image", () => Promise.resolve(PIXEL));
        tool.onMouseDown(ev(0, 0), canvas);
        tool.onMouseMove(ev(100, 60), canvas);
        tool.onMouseUp();
        expect(dispatcher.getDocument().rootNodeUuids).toEqual([]);
    });

    test("a drag in ANY direction normalizes to the same box", async () => {
        expect((await draw("rectangle", 110, 80, 10, 20)).node!.geometry).toEqual({ x: 10, y: 20, width: 100, height: 60 });
    });

    test("text arrives with content, and a triangle with PATH commands in local space", async () => {
        expect((await draw("text", 0, 0, 100, 40)).node!.text).toBe("Text");
        const drawn = await draw("triangle", 0, 0, 100, 40);
        const tri = drawn.node!;
        // Apex top-centre, base along the bottom — LOCAL coords, since the renderer emits
        // shapes at the local origin and places them by the world matrix.
        expect(tri.path).toEqual([
            { c: "M", x: 50, y: 0 }, { c: "L", x: 100, y: 40 }, { c: "L", x: 0, y: 40 }, { c: "Z" }
        ]);
        // The commands satisfy the SAME rule the loader applies, and the document reopens.
        expect(pathError("core.path", tri.path)).toBeNull();
        expect(() => deserializeDocument(serializeDocument(drawn.doc))).not.toThrow();
    });

    test("a LINE may collapse one axis; every other shape may not", async () => {
        // The tool's minimum-size rule has to agree with `dimensionError`, or it would commit
        // what validation rejects — a gesture that silently does nothing.
        expect((await draw("line", 10, 50, 210, 50)).node!.geometry).toMatchObject({ width: 200, height: 0 });
        expect((await draw("rectangle", 10, 50, 210, 50)).node).toBeUndefined();   // zero height: refused
        expect((await draw("ellipse", 10, 50, 210, 50)).node).toBeUndefined();
        expect((await draw("line", 10, 50, 10, 50)).node).toBeUndefined();          // a point is not a line
        // …and the TOOL's own floor still applies to a line: a sub-minimum but NON-zero drag is
        // an accidental twitch, not a shape. (The point case above is refused by `dimensionError`
        // inside the action, so it does not exercise this rule at all.)
        expect((await draw("line", 10, 50, 11, 50)).node).toBeUndefined();
        expect((await draw("line", 10, 50, 13, 50)).node).toBeDefined();            // 3px clears the 2px floor
    });

    test("a click (no drag) creates nothing, and Escape cancels an in-flight drag", async () => {
        expect((await draw("rectangle", 40, 40, 40, 40)).node).toBeUndefined();
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const es = createEditorState();
        const tool = new ShapeTool(dispatcher, es, () => { }, "ellipse");
        tool.onMouseDown(ev(0, 0), canvas);
        tool.onMouseMove(ev(80, 80), canvas);
        expect(es.previewRect).not.toBeNull();
        tool.onKeyDown({ key: "Escape" } as KeyboardEvent);
        expect(es.previewRect).toBeNull();
        tool.onMouseUp();
        expect(dispatcher.getDocument().rootNodeUuids).toEqual([]);
        expect(dispatcher.canUndo()).toBe(false);
    });

    test("the minimum size is in SCREEN px, so it means the same at every zoom", () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const es = createEditorState();
        es.viewport = { ...es.viewport, zoom: 20 };   // 3 screen px = 0.15 world units
        const tool = new ShapeTool(dispatcher, es, () => { }, "rectangle");
        tool.onMouseDown(ev(0, 0), canvas);
        tool.onMouseMove(ev(3, 3), canvas);
        tool.onMouseUp();
        expect(dispatcher.getDocument().rootNodeUuids.length).toBe(1); // committed despite a tiny world box
    });

    test("AddNodeAction validates CONTENT with the same rules the loader uses", () => {
        const doc = createEmptyDocument();
        const bad = [{ c: "L", x: 0, y: 0 }] as PathCommand[];           // must start with M
        expect(new AddNodeAction(doc, "core.path", 0, 0, 10, 10, "#fff", undefined, null, { path: bad }).validate()).toBe(false);
        // A path on a NON-path node is refused by the shared `pathError`, exactly as on load.
        expect(new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 10, "#fff", undefined, null, { path: [{ c: "M", x: 0, y: 0 }] }).validate()).toBe(false);
        expect(new AddNodeAction(doc, "core.path", 0, 0, 10, 10, "#fff", undefined, null, { path: [{ c: "M", x: 0, y: 0 }] }).validate()).toBe(true);
        // The action COPIES the caller's commands rather than aliasing them into the document.
        const commands: PathCommand[] = [{ c: "M", x: 1, y: 2 }];
        const action = new AddNodeAction(doc, "core.path", 0, 0, 10, 10, "#fff", undefined, null, { path: commands });
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(action);
        (commands[0] as { x: number }).x = 999;
        expect(dispatcher.getDocument().nodes.get(action.getCreatedNodeId()!)!.path![0]).toEqual({ c: "M", x: 1, y: 2 });
    });
});

// ─── Frame selection: the editor's only way to BUILD a hierarchy ───
describe("FrameSelectionAction (nesting)", () => {
    /** Three top-level rects: A(10,10,20×20) B(50,50,20×20) C(200,200,10×10). */
    function doc4(): ProjectDocument {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number, w: number, h: number) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: w, height: h }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        mk("A", 10, 10, 20, 20); mk("B", 50, 50, 20, 20); mk("C", 200, 200, 10, 10);
        doc.rootNodeUuids = ["A", "B", "C"];
        return doc;
    }

    test("the frame fits the selection, and framing does not MOVE anything on screen", () => {
        const dispatcher = new ActionDispatcher(doc4());
        const before = computeGeometry(dispatcher.getDocument());
        const boxA = before.nodes.get("A")!.bounds, boxB = before.nodes.get("B")!.bounds;
        const action = new FrameSelectionAction(dispatcher.getDocument(), ["A", "B"]);
        expect(dispatcher.dispatchAction(action).success).toBe(true);
        const d = dispatcher.getDocument();
        const frame = d.nodes.get(action.getFrameId()!)!;
        expect(frame.geometry).toEqual({ x: 10, y: 10, width: 60, height: 60 });   // union of A and B
        expect(frame.children).toEqual(["A", "B"]);
        expect(d.nodes.get("A")!.parent).toBe(action.getFrameId());
        // Rebased onto the frame: stored geometry is parent-relative…
        expect(d.nodes.get("A")!.geometry).toMatchObject({ x: 0, y: 0 });
        expect(d.nodes.get("B")!.geometry).toMatchObject({ x: 40, y: 40 });
        // …and the WORLD position is unchanged, which is the whole point.
        const after = computeGeometry(d);
        expect(after.nodes.get("A")!.bounds).toEqual(boxA);
        expect(after.nodes.get("B")!.bounds).toEqual(boxB);
        expect(() => deserializeDocument(serializeDocument(d))).not.toThrow();
    });

    test("the frame takes the FRONTMOST member's z-position, and members keep their order", () => {
        const dispatcher = new ActionDispatcher(doc4());
        const action = new FrameSelectionAction(dispatcher.getDocument(), ["A", "C"]); // A behind B, C in front
        dispatcher.dispatchAction(action);
        const d = dispatcher.getDocument();
        // Framing A and C must not drop C behind B — the frame lands at C's index.
        expect(d.rootNodeUuids).toEqual(["B", action.getFrameId()]);
        expect(d.nodes.get(action.getFrameId()!)!.children).toEqual(["A", "C"]);
    });

    test("framing NESTS: a frame can itself be framed, and its contents stay put", () => {
        const dispatcher = new ActionDispatcher(doc4());
        const first = new FrameSelectionAction(dispatcher.getDocument(), ["A", "B"]);
        dispatcher.dispatchAction(first);
        const before = computeGeometry(dispatcher.getDocument()).nodes.get("A")!.bounds;
        const second = new FrameSelectionAction(dispatcher.getDocument(), [first.getFrameId()!, "C"]);
        expect(dispatcher.dispatchAction(second).success).toBe(true);
        const d = dispatcher.getDocument();
        expect(d.nodes.get(first.getFrameId()!)!.parent).toBe(second.getFrameId());
        expect(d.nodes.get("A")!.parent).toBe(first.getFrameId());          // still two deep
        expect(computeGeometry(d).nodes.get("A")!.bounds).toEqual(before);  // and still in place
        expect(() => deserializeDocument(serializeDocument(d))).not.toThrow();
    });

    test("framing a selection that does NOT share a parent is refused", () => {
        const dispatcher = new ActionDispatcher(doc4());
        const first = new FrameSelectionAction(dispatcher.getDocument(), ["A", "B"]);
        dispatcher.dispatchAction(first);
        // "A" now lives inside the frame while "C" is still a root — no single space to rebase in.
        expect(new FrameSelectionAction(dispatcher.getDocument(), ["A", "C"]).validate()).toBe(false);
        expect(new FrameSelectionAction(dispatcher.getDocument(), []).validate()).toBe(false);
        expect(new FrameSelectionAction(dispatcher.getDocument(), ["nope"]).validate()).toBe(false);
        // An instance COPY has no stored geometry to rebase and cannot be reparented — caught by
        // the same existence check, since a virtual id is never in the stored map.
        expect(new FrameSelectionAction(dispatcher.getDocument(), ["I::MC"]).validate()).toBe(false);
    });

    test("a node with NON-FINITE geometry is refused rather than producing a NaN frame", () => {
        // Integrity and every action reject non-finite geometry, so this is defence against a
        // damaged/hand-built document — but an unguarded union would emit a NaN-sized frame,
        // which is exactly the kind of value that poisons layout silently.
        const doc = doc4();
        doc.nodes.set("A", { ...doc.nodes.get("A")!, geometry: { x: 0, y: 0, width: NaN, height: 10 } });
        expect(new FrameSelectionAction(doc, ["A", "B"]).validate()).toBe(false);
    });

    test("a frame around collinear zero-height lines is refused (a rectangle needs a box)", () => {
        const doc = createEmptyDocument();
        for (const id of ["L1", "L2"]) {
            doc.nodes.set(id, { id, type: "core.line", parent: null, children: [], geometry: { x: 0, y: 50, width: 100, height: 0 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        }
        doc.rootNodeUuids = ["L1", "L2"];
        expect(new FrameSelectionAction(doc, ["L1", "L2"]).validate()).toBe(false);
    });

    test("framing is one undo step", () => {
        const dispatcher = new ActionDispatcher(doc4());
        const action = new FrameSelectionAction(dispatcher.getDocument(), ["A", "B"]);
        dispatcher.dispatchAction(action);
        dispatcher.undo();
        const d = dispatcher.getDocument();
        expect(d.nodes.has(action.getFrameId()!)).toBe(false);
        expect(d.nodes.get("A")!.parent).toBeNull();
        expect(d.nodes.get("A")!.geometry).toMatchObject({ x: 10, y: 10 });
        expect(d.rootNodeUuids).toEqual(["A", "B", "C"]);
    });

    test("a DETACH of a multi-node master keeps every child in place (framing makes this reachable)", () => {
        // Before framing existed the editor could only draw ROOTS, so a component master with
        // children — and therefore the detach child-copy path — was unreachable by drawing.
        const dispatcher = new ActionDispatcher(doc4());
        const frame = new FrameSelectionAction(dispatcher.getDocument(), ["A", "B"]);
        dispatcher.dispatchAction(frame);
        const master = frame.getFrameId()!;
        const inst = new CreateInstanceAction(dispatcher.getDocument(), master, 300, 300);
        dispatcher.dispatchAction(inst);
        const instanceId = inst.getCreatedNodeId()!;
        const drawn = computeGeometry(dispatcher.getDocument());
        const copyBoxes = [master, "A", "B"].map(m => drawn.nodes.get(`${instanceId}::${m}`)!.bounds);

        const detach = new DetachInstanceAction(dispatcher.getDocument(), instanceId);
        expect(dispatcher.dispatchAction(detach).success).toBe(true);
        const baked = detach.getCreatedNodeIds();
        expect(baked.length).toBe(3);                     // the frame copy plus BOTH children
        const after = computeGeometry(dispatcher.getDocument());
        expect(baked.map(id => after.nodes.get(id)!.bounds)).toEqual(copyBoxes);
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();
    });
});

// ─── schema 23: `Node.src` gains a shared validator, and 22→23 sanitizes ───
describe("Image sources (srcError, schema 23)", () => {
    const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

    test("srcError: image-only, non-empty, bounded, and a scheme a renderer can draw", () => {
        expect(srcError("core.image", undefined)).toBeNull();          // absent is always fine
        expect(srcError("core.image", PIXEL)).toBeNull();
        expect(srcError("core.image", "https://example.com/a.png")).toBeNull();
        expect(srcError("core.image", "http://example.com/a.png")).toBeNull();
        expect(srcError("core.image", "blob:abc")).toBeNull();
        expect(srcError("core.image", "assets/logo.png")).toBeNull();  // relative: no scheme
        expect(srcError("core.image", "./a.png")).toBeNull();
        // Only an image may carry one — the same discipline componentId and path follow.
        expect(srcError("core.rectangle", PIXEL)).toMatch("only a core.image");
        expect(srcError("core.image", "")).toMatch("non-empty");
        expect(srcError("core.image", 7)).toMatch("non-empty");
        // A scheme no renderer could draw is refused rather than handed to the DOM.
        expect(srcError("core.image", "javascript:alert(1)")).toMatch("not allowed");
        expect(srcError("core.image", "file:///etc/passwd")).toMatch("not allowed");
        // A data: URL must actually be an image media type.
        expect(srcError("core.image", "data:text/html,<script>")).toMatch("image media type");
        expect(srcError("core.image", "data:image/svg+xml;base64,AAA")).toBeNull();
        // Bounded: a picked file is inlined, so one photo must not make an unsavable document.
        expect(srcError("core.image", "data:image/png;base64," + "A".repeat(IMAGE_SRC_MAX))).toMatch("at most");
    });

    test("the LOAD path enforces it, and the EDIT path cannot author what load would refuse", () => {
        const doc = createEmptyDocument();
        expect(new AddNodeAction(doc, "core.image", 0, 0, 10, 10, "#fff", undefined, null, { src: PIXEL }).validate()).toBe(true);
        expect(new AddNodeAction(doc, "core.image", 0, 0, 10, 10, "#fff", undefined, null, { src: "javascript:x" }).validate()).toBe(false);
        expect(new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 10, "#fff", undefined, null, { src: PIXEL }).validate()).toBe(false);
        // Round-trip closure: what the editor creates, the loader reopens.
        const dispatcher = new ActionDispatcher(doc);
        const action = new AddNodeAction(dispatcher.getDocument(), "core.image", 0, 0, 10, 10, "#fff", undefined, null, { src: PIXEL });
        dispatcher.dispatchAction(action);
        const loaded = deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(loaded.nodes.get(action.getCreatedNodeId()!)!.src).toBe(PIXEL);
        // …and a hand-edited file carrying a refused src fails the load loudly.
        const bad = JSON.stringify({
            version: SCHEMA_VERSION,
            document: {
                metadata: {}, rootNodeUuids: ["r"], variables: {},
                nodes: { r: { id: "r", type: "core.image", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, src: "javascript:alert(1)" } }
            }
        });
        expect(() => deserializeDocument(bad)).toThrow("not allowed");
    });

    test("22→23 DROPS a src the new rule refuses, so an older file still opens", () => {
        // The bump adds a CONSTRAINT, not a field: without sanitizing, a schema-22 document
        // that was perfectly loadable would become permanently unreadable.
        const legacy = JSON.stringify({
            version: "22",
            document: {
                metadata: {}, rootNodeUuids: ["bad", "good", "wrongType"], variables: {},
                nodes: {
                    bad: { id: "bad", type: "core.image", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, src: "javascript:alert(1)" },
                    good: { id: "good", type: "core.image", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, src: PIXEL },
                    wrongType: { id: "wrongType", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, src: PIXEL }
                }
            }
        });
        const loaded = deserializeDocument(legacy);
        expect(loaded.version).toBe(SCHEMA_VERSION);
        expect(loaded.nodes.get("bad")!.src).toBeUndefined();        // dropped: draws nothing
        expect(loaded.nodes.get("good")!.src).toBe(PIXEL);           // kept: still valid
        expect(loaded.nodes.get("wrongType")!.src).toBeUndefined();  // a src on a rect is dropped
    });
});

// ─── Adversarial-review fixes: detach fidelity, framing reference frames, override src ───
describe("Review fixes: what the instance contributed must survive a detach", () => {
    function mkRect(doc: ProjectDocument, id: string, x: number, y: number, w: number, h: number, parent: string | null = null) {
        doc.nodes.set(id, { id, type: "core.rectangle", parent, children: [], geometry: { x, y, width: w, height: h }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        if (parent) doc.nodes.get(parent)!.children.push(id); else doc.rootNodeUuids.push(id);
    }
    /** master M (100×50 at 10,20) + child MC; instance I at (300,300). */
    function doc5(): ProjectDocument {
        const doc = createEmptyDocument();
        mkRect(doc, "M", 10, 20, 100, 50);
        mkRect(doc, "MC", 5, 5, 20, 20, "M");
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 300, y: 300, width: 100, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids.push("I");
        return doc;
    }

    test("a ROTATED instance keeps its rotation when baked", () => {
        // The materialized root is a CHILD of the instance, so the instance's matrix composes
        // into what you see. Detach deletes the instance — without carrying the transform the
        // picture snapped upright the moment you clicked Detach.
        const doc = doc5();
        doc.nodes.set("I", { ...doc.nodes.get("I")!, transform: { rotation: Math.PI / 2 } });
        const dispatcher = new ActionDispatcher(doc);
        const before = computeGeometry(dispatcher.getDocument()).nodes.get("I::M")!.bounds;
        const action = new DetachInstanceAction(dispatcher.getDocument(), "I");
        expect(dispatcher.dispatchAction(action).success).toBe(true);
        const after = computeGeometry(dispatcher.getDocument()).nodes.get(action.getCreatedNodeIds()[0])!.bounds;
        expect(after.width).toBeCloseTo(before.width, 6);
        expect(after.height).toBeCloseTo(before.height, 6);
        expect(after.x).toBeCloseTo(before.x, 6);
    });

    test("two transforms cannot compose into one, so that detach is REFUSED rather than lossy", () => {
        const doc = doc5();
        doc.nodes.set("I", { ...doc.nodes.get("I")!, transform: { rotation: 0.4 } });
        doc.nodes.set("M", { ...doc.nodes.get("M")!, transform: { rotation: 0.3 } });
        expect(new DetachInstanceAction(doc, "I").validate()).toBe(false);
    });

    test("a CONSTRAINED instance keeps its position and goes on tracking its parent", () => {
        const doc = createEmptyDocument();
        mkRect(doc, "P", 0, 0, 600, 400);
        mkRect(doc, "M", 0, 0, 50, 50);
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: "P", children: [], geometry: { x: 300, y: 0, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: { constraints: { horizontal: "right" }, constraintRef: { width: 400, height: 400 } }, componentId: "M" });
        doc.nodes.get("P")!.children.push("I");
        const dispatcher = new ActionDispatcher(doc);
        const before = computeGeometry(dispatcher.getDocument()).nodes.get("I::M")!.bounds;
        const action = new DetachInstanceAction(dispatcher.getDocument(), "I");
        dispatcher.dispatchAction(action);
        const baked = action.getCreatedNodeIds()[0];
        expect(computeGeometry(dispatcher.getDocument()).nodes.get(baked)!.bounds.x).toBeCloseTo(before.x, 6);
        // …and it still RESPONDS to the parent, which the dropped constraints had ended.
        expect(dispatcher.getDocument().nodes.get(baked)!.layout.constraints).toEqual({ horizontal: "right" });
    });

    test("the master's CHILD-facing layout survives while the instance's PARENT-facing layout wins", () => {
        const doc = createEmptyDocument();
        mkRect(doc, "M", 0, 0, 100, 100);
        doc.nodes.set("M", { ...doc.nodes.get("M")!, layout: { container: { direction: "row", gap: 4 } } });
        mkRect(doc, "MC", 0, 0, 20, 20, "M");
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "none", opacity: 1 }, layout: { grow: 2, margin: 5 }, componentId: "M" });
        doc.rootNodeUuids.push("I");
        const dispatcher = new ActionDispatcher(doc);
        const action = new DetachInstanceAction(dispatcher.getDocument(), "I");
        dispatcher.dispatchAction(action);
        const root = dispatcher.getDocument().nodes.get(action.getCreatedNodeIds()[0])!;
        expect(root.layout.container).toEqual({ direction: "row", gap: 4 });  // arranges its own children
        expect(root.layout.grow).toBe(2);                                     // behaves as the instance did
        expect(root.layout.margin).toBe(5);
    });

    test("detaching an instance nested inside its OWN master is refused (it would edit the component)", () => {
        const doc = createEmptyDocument();
        mkRect(doc, "M", 0, 0, 200, 200);
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: "M", children: [], geometry: { x: 50, y: 50, width: 200, height: 200 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.nodes.get("M")!.children.push("I");
        doc.nodes.set("J", { id: "J", type: "core.instance", parent: null, children: [], geometry: { x: 400, y: 0, width: 200, height: 200 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids.push("J");
        // Baking it would parent the copies INSIDE the master, so every other instance of that
        // master — here J, which the user never touched — would gain the content.
        expect(new DetachInstanceAction(doc, "I").validate()).toBe(false);
    });
});

describe("Review fixes: framing must not silently change a reference frame", () => {
    function mkRect(doc: ProjectDocument, id: string, x: number, y: number, w: number, h: number, parent: string | null = null) {
        doc.nodes.set(id, { id, type: "core.rectangle", parent, children: [], geometry: { x, y, width: w, height: h }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        if (parent) doc.nodes.get(parent)!.children.push(id); else doc.rootNodeUuids.push(id);
    }

    test("framing inside an AUTO-LAYOUT parent is refused — stored x/y there is dead data", () => {
        const doc = createEmptyDocument();
        mkRect(doc, "P", 0, 0, 400, 200);
        doc.nodes.set("P", { ...doc.nodes.get("P")!, layout: { container: { direction: "row", gap: 10, padding: 0 } } });
        mkRect(doc, "A", 0, 0, 100, 100, "P");
        mkRect(doc, "B", 0, 0, 100, 100, "P");
        // The layout computes each child's position, so a frame built from stored x/y would put
        // both children at the same place and shrink the group to one child's box.
        expect(new FrameSelectionAction(doc, ["A", "B"]).validate()).toBe(false);
        const grid = createEmptyDocument();
        mkRect(grid, "G", 0, 0, 400, 200);
        grid.nodes.set("G", { ...grid.nodes.get("G")!, layout: { grid: { columns: [{ px: 50 }, { px: 50 }], rowHeight: { px: 50 } } } });
        mkRect(grid, "GA", 0, 0, 50, 50, "G");
        mkRect(grid, "GB", 0, 0, 50, 50, "G");
        expect(new FrameSelectionAction(grid, ["GA", "GB"]).validate()).toBe(false);
        // …but a PLAIN parent is still fine.
        const plain = createEmptyDocument();
        mkRect(plain, "Q", 0, 0, 400, 200);
        mkRect(plain, "QA", 10, 10, 50, 50, "Q");
        mkRect(plain, "QB", 100, 10, 50, 50, "Q");
        expect(new FrameSelectionAction(plain, ["QA", "QB"]).validate()).toBe(true);
    });

    test("a CONSTRAINED child is released from the old parent's frozen reference, so it stays put", () => {
        const doc = createEmptyDocument();
        mkRect(doc, "P", 0, 0, 400, 400);
        mkRect(doc, "A", 300, 0, 50, 50, "P");
        doc.nodes.set("A", { ...doc.nodes.get("A")!, layout: { constraints: { horizontal: "right" }, constraintRef: { width: 400, height: 400 } } });
        mkRect(doc, "B", 0, 0, 50, 50, "P");
        const dispatcher = new ActionDispatcher(doc);
        const boxA = computeGeometry(dispatcher.getDocument()).nodes.get("A")!.bounds;
        const action = new FrameSelectionAction(dispatcher.getDocument(), ["A", "B"]);
        expect(dispatcher.dispatchAction(action).success).toBe(true);
        const d = dispatcher.getDocument();
        // constraintRef pointed at the OLD parent's 400×400; the frame is 350 wide, so leaving
        // it would shift A by (350−400) and undo the rebase.
        expect(d.nodes.get("A")!.layout.constraints).toBeUndefined();
        expect(d.nodes.get("A")!.layout.constraintRef).toBeUndefined();
        expect(computeGeometry(d).nodes.get("A")!.bounds.x).toBeCloseTo(boxA.x, 6);
    });

    test("the frame FITS a rotated or scaled child, not just its untransformed box", () => {
        const doc = createEmptyDocument();
        mkRect(doc, "A", 0, 0, 100, 100);
        doc.nodes.set("A", { ...doc.nodes.get("A")!, transform: { rotation: Math.PI / 4 } });
        const dispatcher = new ActionDispatcher(doc);
        const childBox = computeGeometry(dispatcher.getDocument()).nodes.get("A")!.bounds;
        const action = new FrameSelectionAction(dispatcher.getDocument(), ["A"]);
        dispatcher.dispatchAction(action);
        const frameBox = computeGeometry(dispatcher.getDocument()).nodes.get(action.getFrameId()!)!.bounds;
        // A 100×100 square rotated 45° needs ~141.4 — the frame must cover all four corners.
        expect(frameBox.width).toBeCloseTo(Math.SQRT2 * 100, 4);
        expect(frameBox.x).toBeLessThanOrEqual(childBox.x + 1e-6);
        expect(frameBox.x + frameBox.width).toBeGreaterThanOrEqual(childBox.x + childBox.width - 1e-6);
        // …and the child still hasn't moved. (Compared with a tolerance, not exactly: the
        // rebase subtracts the frame origin and the engine adds it back, so the round trip is
        // equal to within floating-point noise — ~1e-14 — rather than bit-identical.)
        const moved = computeGeometry(dispatcher.getDocument()).nodes.get("A")!.bounds;
        expect(moved.x).toBeCloseTo(childBox.x, 9);
        expect(moved.y).toBeCloseTo(childBox.y, 9);
        expect(moved.width).toBeCloseTo(childBox.width, 9);
        expect(moved.height).toBeCloseTo(childBox.height, 9);
    });
});

describe("Review fixes: an override src obeys the same rule a stored src does (schema 24)", () => {
    function doc6(masterType: "core.rectangle" | "core.image" = "core.rectangle"): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: masterType, parent: null, children: [], geometry: { x: 0, y: 0, width: 100, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 300, y: 300, width: 100, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I"];
        return doc;
    }
    const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

    test("the document-free half runs in overridesError, the TYPE half against the master", () => {
        // Validating an override src as merely "a string" let it hold what no node may hold.
        expect(overridesError("core.instance", { M: { src: "javascript:alert(1)" } })).toMatch("not allowed");
        expect(overridesError("core.instance", { M: { src: "" } })).toMatch("non-empty");
        expect(overridesError("core.instance", { M: { src: PIXEL } })).toBeNull();
        // …and only an IMAGE master may take one, which needs the document to resolve.
        const onRect = doc6("core.rectangle");
        onRect.nodes.set("I", { ...onRect.nodes.get("I")!, overrides: { M: { src: PIXEL } } });
        expect(overrideAgainstMasterError(onRect, onRect.nodes.get("I")!)).toMatch("only a core.image");
        const onImage = doc6("core.image");
        onImage.nodes.set("I", { ...onImage.nodes.get("I")!, overrides: { M: { src: PIXEL } } });
        expect(overrideAgainstMasterError(onImage, onImage.nodes.get("I")!)).toBeNull();
    });

    test("the EDIT path refuses it, so a DETACH can no longer bake an unloadable document", () => {
        const dispatcher = new ActionDispatcher(doc6("core.rectangle"));
        expect(dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "I", "M", { src: "javascript:alert(1)" })).success).toBe(false);
        expect(dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "I", "M", { src: PIXEL })).success).toBe(false); // rect master
        // A legal one on an IMAGE master still works, and detach bakes it faithfully.
        const d2 = new ActionDispatcher(doc6("core.image"));
        expect(d2.dispatchAction(new SetInstanceOverrideAction(d2.getDocument(), "I", "M", { src: PIXEL })).success).toBe(true);
        const detach = new DetachInstanceAction(d2.getDocument(), "I");
        d2.dispatchAction(detach);
        expect(d2.getDocument().nodes.get(detach.getCreatedNodeIds()[0])!.src).toBe(PIXEL);
        expect(() => deserializeDocument(serializeDocument(d2.getDocument()))).not.toThrow();
    });

    test("23→24 drops an override src the new rule refuses, so an older file still opens", () => {
        const legacy = JSON.stringify({
            version: "23",
            document: {
                metadata: {}, rootNodeUuids: ["M", "I"], variables: {},
                nodes: {
                    M: { id: "M", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} },
                    I: { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M", overrides: { M: { src: "javascript:alert(1)", text: "kept" } } }
                }
            }
        });
        const loaded = deserializeDocument(legacy);
        expect(loaded.version).toBe(SCHEMA_VERSION);
        expect(loaded.nodes.get("I")!.overrides!.M.src).toBeUndefined();  // dropped
        expect(loaded.nodes.get("I")!.overrides!.M.text).toBe("kept");    // the rest survives
    });

    test("the app's URL fallback runs the SAME validator the file branch does", () => {
        // Without it a refused URL fell through to AddNodeAction, whose failure is silent —
        // the drag vanished with no explanation on exactly the inputs the file branch explains.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        const cancelBranch = src.slice(src.indexOf('addEventListener("cancel"'), src.indexOf('addEventListener("change"'));
        expect(cancelBranch).toMatch(/srcError\("core\.image"/);
        expect(cancelBranch).toMatch(/window\.alert/);
    });
});

// ─── Regular N-gons: pentagon, hexagon, octagon and the rest ───
describe("Polygon: regular N-gons fill the drawn box", () => {
    test("the polygon's OWN bounds exactly fill the box, for every side count", () => {
        // The invariant that makes an N-gon behave like every other shape here: the box you
        // drag is the box you get, so handles, culling and hit-testing need no special case.
        for (let n = POLYGON_MIN_SIDES; n <= POLYGON_MAX_SIDES; n++) {
            const pts = polygonPoints(n, 120, 80);
            const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
            expect(pts.length).toBe(n);
            expect(Math.min(...xs)).toBeCloseTo(0, 6);
            expect(Math.min(...ys)).toBeCloseTo(0, 6);
            expect(Math.max(...xs)).toBeCloseTo(120, 6);
            expect(Math.max(...ys)).toBeCloseTo(80, 6);
        }
    });

    test("the 3-gon IS the box-filling triangle, bit-for-bit", () => {
        // The generalization must not silently change a shape the editor already shipped.
        expect(polygonCommands(3, 100, 40)).toEqual([
            { c: "M", x: 50, y: 0 }, { c: "L", x: 100, y: 40 }, { c: "L", x: 0, y: 40 }, { c: "Z" }
        ]);
    });

    test("a 4-gon is a diamond, and even-sided polygons are symmetric about the centre", () => {
        expect(polygonPoints(4, 100, 100)).toEqual([
            { x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }
        ]);
        // A hexagon's opposite vertices mirror through the box centre.
        const hex = polygonPoints(6, 100, 100);
        for (let i = 0; i < 3; i++) {
            expect(hex[i].x + hex[i + 3].x).toBeCloseTo(100, 6);
            expect(hex[i].y + hex[i + 3].y).toBeCloseTo(100, 6);
        }
    });

    test("the first vertex is the TOP one and the winding is clockwise", () => {
        for (const n of [5, 6, 8]) {
            const pts = polygonPoints(n, 100, 100);
            expect(pts[0].y).toBeCloseTo(0, 6);             // starts at the top edge
            expect(pts[0].x).toBeCloseTo(50, 6);            // …at its centre
            // Shoelace: a clockwise winding in screen coords (y down) has POSITIVE area.
            let area = 0;
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                area += a.x * b.y - b.x * a.y;
            }
            expect(area).toBeGreaterThan(0);
        }
    });

    test("a non-square box gives an affine-stretched polygon, not a small centred one", () => {
        const wide = polygonPoints(5, 400, 50);
        expect(Math.max(...wide.map(p => p.x))).toBeCloseTo(400, 6);
        expect(Math.max(...wide.map(p => p.y))).toBeCloseTo(50, 6);
    });

    test("clampSides is the ONE rule the tool, the toolbar and the generator share", () => {
        expect(clampSides(5)).toBe(5);
        expect(clampSides(2)).toBe(POLYGON_MIN_SIDES);          // a 2-gon is a line
        expect(clampSides(0)).toBe(POLYGON_MIN_SIDES);
        expect(clampSides(-7)).toBe(POLYGON_MIN_SIDES);
        expect(clampSides(1e6)).toBe(POLYGON_MAX_SIDES);
        expect(clampSides(6.7)).toBe(7);                        // rounded, not truncated
        expect(clampSides(NaN)).toBe(POLYGON_MIN_SIDES);
        expect(clampSides(Infinity)).toBe(POLYGON_MIN_SIDES);
        // …and the generator obeys it rather than emitting a degenerate path.
        expect(polygonPoints(1, 10, 10).length).toBe(POLYGON_MIN_SIDES);
        expect(polygonPoints(1000, 10, 10).length).toBe(POLYGON_MAX_SIDES);
    });

    test("polygonCommands closes the outline and passes the shared pathError", () => {
        for (const n of [3, 5, 6, 8, 12, POLYGON_MAX_SIDES]) {
            const cmds = polygonCommands(n, 100, 100);
            expect(cmds.length).toBe(n + 1);                    // n vertices + Z
            expect(cmds[0].c).toBe("M");
            expect(cmds[cmds.length - 1].c).toBe("Z");
            expect(pathError("core.path", cmds)).toBeNull();
        }
    });
});

describe("ShapeTool: the polygon tool", () => {
    const canvas = { left: 0, top: 0 } as DOMRect;
    const ev = (x: number, y: number) => ({ clientX: x, clientY: y } as unknown as MouseEvent);

    /** Draw with the polygon tool, reading the side count through the injected getter. */
    function drawPolygon(sides: () => number, x1 = 0, y1 = 0, x2 = 100, y2 = 100) {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const es = createEditorState();
        const tool = new ShapeTool(dispatcher, es, () => { }, "polygon", undefined, sides);
        tool.onMouseDown(ev(x1, y1), canvas);
        tool.onMouseMove(ev(x2, y2), canvas);
        tool.onMouseUp();
        const doc = dispatcher.getDocument();
        return doc.nodes.get(doc.rootNodeUuids[0]);
    }

    test("a pentagon, a hexagon and an octagon each commit that many vertices", () => {
        expect(drawPolygon(() => 5)!.path!.length).toBe(6);   // 5 + Z
        expect(drawPolygon(() => 6)!.path!.length).toBe(7);
        expect(drawPolygon(() => 8)!.path!.length).toBe(9);
        expect(drawPolygon(() => 5)!.type).toBe("core.path");
    });

    test("the side count is read at COMMIT time, so changing it between drags takes effect", () => {
        // The tool is constructed ONCE; a captured value would freeze the count the toolbar
        // happened to hold when the app first rendered.
        let sides = 5;
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const es = createEditorState();
        const tool = new ShapeTool(dispatcher, es, () => { }, "polygon", undefined, () => sides);
        const draw = (x: number) => { tool.onMouseDown(ev(x, 0), canvas); tool.onMouseMove(ev(x + 80, 80), canvas); tool.onMouseUp(); };
        draw(0);
        sides = 8;
        draw(200);
        const d = dispatcher.getDocument();
        expect(d.nodes.get(d.rootNodeUuids[0])!.path!.length).toBe(6);   // pentagon
        expect(d.nodes.get(d.rootNodeUuids[1])!.path!.length).toBe(9);   // octagon
    });

    test("an out-of-range count is clamped rather than producing a degenerate path", () => {
        expect(drawPolygon(() => 2)!.path!.length).toBe(POLYGON_MIN_SIDES + 1);
        expect(drawPolygon(() => 9999)!.path!.length).toBe(POLYGON_MAX_SIDES + 1);
    });

    test("a drawn polygon round-trips", () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const es = createEditorState();
        const tool = new ShapeTool(dispatcher, es, () => { }, "polygon", undefined, () => 7);
        tool.onMouseDown(ev(10, 10), canvas);
        tool.onMouseMove(ev(110, 90), canvas);
        tool.onMouseUp();
        const doc = dispatcher.getDocument();
        expect(() => deserializeDocument(serializeDocument(doc))).not.toThrow();
        expect(compareDocuments(doc, deserializeDocument(serializeDocument(doc)))).toBe(true);
    });

    test("the toolbar's side control is bound to the SAME clamp the generator uses", () => {
        // A control that showed 100 while drawing a 64-gon would be lying about the result.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/clampSides\(raw\)/);
        expect(src).toMatch(/min=\{POLYGON_MIN_SIDES\}/);
        expect(src).toMatch(/max=\{POLYGON_MAX_SIDES\}/);
    });
});

// ─── Filled vs outline: the same shape drawn two ways ───
describe("ShapeTool: filled or outline", () => {
    const canvas = { left: 0, top: 0 } as DOMRect;
    const ev = (x: number, y: number) => ({ clientX: x, clientY: y } as unknown as MouseEvent);

    function draw(kind: ShapeKind, mode: PaintMode) {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const es = createEditorState();
        const tool = new ShapeTool(dispatcher, es, () => { }, kind, undefined, () => 6, () => mode);
        tool.onMouseDown(ev(0, 0), canvas);
        tool.onMouseMove(ev(100, 80), canvas);
        tool.onMouseUp();
        const doc = dispatcher.getDocument();
        return doc.nodes.get(doc.rootNodeUuids[0]);
    }

    test("OUTLINE gives no fill and a stroke; FILLED gives a fill and no stroke", () => {
        for (const kind of ["rectangle", "ellipse", "triangle", "polygon"] as ShapeKind[]) {
            const filled = draw(kind, "filled")!;
            expect(filled.style.fill).not.toBe("none");
            expect(filled.style.stroke).toBeUndefined();

            const outline = draw(kind, "outline")!;
            expect(outline.style.fill).toBe("none");
            expect(outline.style.stroke).toBe(filled.style.fill);   // same colour, drawn as a border
        }
    });

    test("the mode is IGNORED where it would make the shape invisible", () => {
        // A line is already nothing but a stroke; an image draws its own pixels. Forcing
        // `fill: "none"` on them would commit a node that renders nothing at all.
        for (const kind of ["line", "text"] as ShapeKind[]) {
            expect(supportsPaintMode(kind)).toBe(false);
            expect(draw(kind, "outline")!.style.fill).not.toBe("none");
        }
        expect(supportsPaintMode("image")).toBe(false);
        expect(supportsPaintMode("rectangle")).toBe(true);
        // The toolbar asks about the ACTIVE TOOL, which is often not a shape at all. Indexing
        // the table blindly threw during render and took the whole app down — the unit suite
        // never saw it because no test called this with a non-shape name.
        for (const notAShape of ["select", "move", "", "nonsense"]) {
            expect(supportsPaintMode(notAShape)).toBe(false);
        }
    });

    test("the mode is read at COMMIT time, so toggling between drags takes effect", () => {
        let mode: PaintMode = "filled";
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const es = createEditorState();
        const tool = new ShapeTool(dispatcher, es, () => { }, "rectangle", undefined, () => 6, () => mode);
        const go = (x: number) => { tool.onMouseDown(ev(x, 0), canvas); tool.onMouseMove(ev(x + 50, 50), canvas); tool.onMouseUp(); };
        go(0);
        mode = "outline";
        go(200);
        const d = dispatcher.getDocument();
        expect(d.nodes.get(d.rootNodeUuids[0])!.style.fill).not.toBe("none");
        expect(d.nodes.get(d.rootNodeUuids[1])!.style.fill).toBe("none");
    });

    test("an outline shape round-trips, and its style passes the shared styleError", () => {
        const outline = draw("polygon", "outline")!;
        expect(styleError(outline.style)).toBeNull();
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const tool = new ShapeTool(dispatcher, createEditorState(), () => { }, "ellipse", undefined, () => 6, () => "outline" as PaintMode);
        tool.onMouseDown(ev(0, 0), canvas); tool.onMouseMove(ev(60, 60), canvas); tool.onMouseUp();
        const doc = dispatcher.getDocument();
        expect(compareDocuments(doc, deserializeDocument(serializeDocument(doc)))).toBe(true);
    });

    test("AddNodeAction validates the style it assembles", () => {
        // A created node's style was never checked before — only edits to it were.
        const doc = createEmptyDocument();
        expect(new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 10, "#fff", undefined, null, undefined, "#000").validate()).toBe(true);
        const bad = new AddNodeAction(doc, "core.rectangle", 0, 0, 10, 10, "#fff", undefined, null, undefined, 42 as unknown as string);
        expect(bad.validate()).toBe(false);
    });

    test("the toolbar reads the SAME table the tool commits from", () => {
        // A control offered for a kind the tool ignores would be a lie; the app asks
        // `supportsPaintMode` rather than keeping its own list.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/supportsPaintMode\(toolName\)/);
    });
});

// ─── Stroke width (schema 25): outlines you can actually see ───
describe("Style.strokeWidth", () => {
    const canvas = { left: 0, top: 0 } as DOMRect;
    const ev = (x: number, y: number) => ({ clientX: x, clientY: y } as unknown as MouseEvent);
    const stateAt = (doc: ProjectDocument, zoom: number, selectedNodeIds: string[] = []) =>
        ({ viewport: { x: 0, y: 0, zoom }, selectedNodeIds, hoveredNodeId: null, computed: computeGeometry(doc) }) as unknown as import("../../renderer/RendererState").RendererState;

    function docWith(style: Record<string, unknown>): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("R", { id: "R", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: style as never, layout: {} });
        doc.rootNodeUuids = ["R"];
        return doc;
    }
    const widthAt = (doc: ProjectDocument, zoom: number) =>
        buildRenderModel({ width: 800, height: 600 }, doc, stateAt(doc, zoom))
            .content.find(i => i.nodeId === "R")!.paint.strokeWidth;

    test("styleError: >= 0, finite, or a $token — the same shape as the radius rule", () => {
        expect(styleError({ strokeWidth: 0 })).toBeNull();
        expect(styleError({ strokeWidth: 4 })).toBeNull();
        expect(styleError({ strokeWidth: "$stroke/thick" })).toBeNull();
        expect(styleError({ strokeWidth: -1 })).toMatch("strokeWidth must be >= 0");
        expect(styleError({ strokeWidth: Infinity })).toMatch("strokeWidth must be >= 0");
        expect(styleError({ strokeWidth: "12" })).toMatch("strokeWidth must be >= 0"); // a bare string is not a token
        // Shared: the LOAD path enforces the identical rule.
        const bad = JSON.stringify({
            version: SCHEMA_VERSION,
            document: { metadata: {}, rootNodeUuids: ["r"], variables: {}, nodes: { r: { id: "r", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1, strokeWidth: -3 }, layout: {} } } }
        });
        expect(() => deserializeDocument(bad)).toThrow("strokeWidth must be >= 0");
    });

    test("an ABSENT width renders the historic 1-screen-pixel hairline, unchanged", () => {
        // The point of the default: a document written before this field renders identically.
        const doc = docWith({ fill: "#f00", opacity: 1, stroke: "#0f0" });
        expect(widthAt(doc, 1)).toBe(1);        // 1 world unit at zoom 1 …
        expect(widthAt(doc, 4)).toBe(0.25);     // … still 1 SCREEN pixel at zoom 4
    });

    test("a SET width is in WORLD units, so the border thickens as you zoom in", () => {
        const doc = docWith({ fill: "none", opacity: 1, stroke: "#0f0", strokeWidth: 6 });
        expect(widthAt(doc, 1)).toBe(6);
        expect(widthAt(doc, 4)).toBe(6);
    });

    test("a broken token falls back to the hairline rather than vanishing", () => {
        const doc = docWith({ fill: "none", opacity: 1, stroke: "#0f0", strokeWidth: "$nope" });
        expect(widthAt(doc, 2)).toBe(0.5);
    });

    test("the SELECTION overlay stays screen-fixed, independent of the shape's border", () => {
        // Chrome is not part of the document: it must neither inherit a shape's stroke width
        // nor stop scaling with zoom. Asserted as INDEPENDENCE rather than a literal, so the
        // test says what matters instead of pinning the overlay's own chosen thickness.
        const outlineWidth = (style: Record<string, unknown>, zoom: number): number => {
            const doc = docWith(style);
            return buildRenderModel({ width: 800, height: 600 }, doc, stateAt(doc, zoom, ["R"]))
                .overlay.find(i => i.role === "outline")!.paint.strokeWidth!;
        };
        const plain = { fill: "#f00", opacity: 1, stroke: "#0f0" };
        const thick = { fill: "#f00", opacity: 1, stroke: "#0f0", strokeWidth: 20 };
        expect(outlineWidth(thick, 2)).toBe(outlineWidth(plain, 2));   // does not inherit the 20
        expect(outlineWidth(plain, 4)).toBeCloseTo(outlineWidth(plain, 2) / 2, 10); // still 1/zoom
    });

    test("the outline tool commits the toolbar's width, clamped by the shared rule", () => {
        const draw = (w: number) => {
            const dispatcher = new ActionDispatcher(createEmptyDocument());
            const tool = new ShapeTool(dispatcher, createEditorState(), () => { }, "rectangle", undefined, () => 6, () => "outline" as PaintMode, () => w);
            tool.onMouseDown(ev(0, 0), canvas); tool.onMouseMove(ev(80, 80), canvas); tool.onMouseUp();
            const d = dispatcher.getDocument();
            return d.nodes.get(d.rootNodeUuids[0])!.style.strokeWidth;
        };
        expect(draw(5)).toBe(5);
        expect(draw(-3)).toBe(0);                    // clamped, not rejected
        expect(draw(1e9)).toBe(STROKE_WIDTH_MAX);
        expect(draw(NaN)).toBe(DEFAULT_STROKE_WIDTH);
        expect(clampStrokeWidth(2.5)).toBe(2.5);     // fractional widths are legitimate
    });

    test("a FILLED shape carries no stroke and no width at all", () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const tool = new ShapeTool(dispatcher, createEditorState(), () => { }, "rectangle", undefined, () => 6, () => "filled" as PaintMode, () => 8);
        tool.onMouseDown(ev(0, 0), canvas); tool.onMouseMove(ev(80, 80), canvas); tool.onMouseUp();
        const d = dispatcher.getDocument();
        const node = d.nodes.get(d.rootNodeUuids[0])!;
        expect(node.style.strokeWidth).toBeUndefined();
        expect(node.style.stroke).toBeUndefined();
    });

    test("an outline shape with a width round-trips", () => {
        const dispatcher = new ActionDispatcher(createEmptyDocument());
        const tool = new ShapeTool(dispatcher, createEditorState(), () => { }, "polygon", undefined, () => 8, () => "outline" as PaintMode, () => 3);
        tool.onMouseDown(ev(0, 0), canvas); tool.onMouseMove(ev(90, 90), canvas); tool.onMouseUp();
        const doc = dispatcher.getDocument();
        const loaded = deserializeDocument(serializeDocument(doc));
        expect(loaded.nodes.get(doc.rootNodeUuids[0])!.style.strokeWidth).toBe(3);
        expect(compareDocuments(doc, loaded)).toBe(true);
    });

    test("24 to 25 is a pass-through: an older document still opens and still hairlines", () => {
        const legacy = JSON.stringify({
            version: "24",
            document: { metadata: {}, rootNodeUuids: ["r"], variables: {}, nodes: { r: { id: "r", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1, stroke: "#fff" }, layout: {} } } }
        });
        const loaded = deserializeDocument(legacy);
        expect(loaded.version).toBe(SCHEMA_VERSION);
        expect(loaded.nodes.get("r")!.style.strokeWidth).toBeUndefined();
    });
});

// ─── Align & distribute: the highest-leverage row in any design tool ───
describe("Alignment maths", () => {
    const box = (x: number, y: number, w = 10, h = 10) => ({ x, y, width: w, height: h });

    test("align references the SELECTION's own bounding box, not the canvas", () => {
        const boxes = [box(0, 0, 10, 10), box(50, 20, 30, 10), box(100, 40, 20, 10)];
        const left = alignBoxes(boxes, "left");
        expect([...left.values()].map(p => p.x)).toEqual([0, 0]);        // both move to x=0
        expect(left.has(0)).toBe(false);                                  // the leftmost never moves
        const right = alignBoxes(boxes, "right");
        // Union right edge is 120; each box's RIGHT edge lands there, so x = 120 - width.
        expect(right.get(0)!.x).toBe(110);
        expect(right.get(1)!.x).toBe(90);
        expect(right.has(2)).toBe(false);
    });

    test("centre alignment centres the BOX, so differing sizes still line up", () => {
        const boxes = [box(0, 0, 10, 10), box(0, 20, 40, 10)];
        const out = alignBoxes(boxes, "center-h");
        // Union spans 0..40, centre 20 — the 10-wide box goes to 15, the 40-wide one is already there.
        expect(out.get(0)!.x).toBe(15);
        expect(out.has(1)).toBe(false);
    });

    test("align is IDEMPOTENT — running it twice changes nothing the second time", () => {
        // Which is also why an already-aligned selection reports no movers and pushes no undo.
        const boxes = [box(0, 0), box(50, 30), box(90, 60)];
        const first = alignBoxes(boxes, "top");
        const moved = boxes.map((b, i) => first.has(i) ? { ...b, ...first.get(i)! } : b);
        expect(alignBoxes(moved, "top").size).toBe(0);
    });

    test("every edge moves only the axis it names", () => {
        const boxes = [box(0, 0), box(50, 30)];
        for (const edge of ["left", "center-h", "right"] as AlignEdge[]) {
            for (const [i, p] of alignBoxes(boxes, edge)) expect(p.y).toBe(boxes[i].y);
        }
        for (const edge of ["top", "center-v", "bottom"] as AlignEdge[]) {
            for (const [i, p] of alignBoxes(boxes, edge)) expect(p.x).toBe(boxes[i].x);
        }
    });

    test("distribute equalises the GAPS, not the centres", () => {
        // Boxes of DIFFERENT widths: equal centres would leave visibly uneven gaps, which is
        // the whole reason design tools distribute spacing instead.
        const boxes = [box(0, 0, 10, 10), box(20, 0, 40, 10), box(100, 0, 10, 10)];
        const out = distributeBoxes(boxes, "horizontal");
        const placed = boxes.map((b, i) => out.has(i) ? { ...b, ...out.get(i)! } : b);
        const gap1 = placed[1].x - (placed[0].x + placed[0].width);
        const gap2 = placed[2].x - (placed[1].x + placed[1].width);
        expect(gap1).toBeCloseTo(gap2, 10);
        // The extremes stay put.
        expect(placed[0].x).toBe(0);
        expect(placed[2].x).toBe(100);
    });

    test("distribute sorts by POSITION but reports against the caller's indices", () => {
        // The selection order is arbitrary; reordering it would assign positions to the wrong nodes.
        const boxes = [box(100, 0), box(0, 0), box(50, 0)];
        const out = distributeBoxes(boxes, "horizontal");
        const placed = boxes.map((b, i) => out.has(i) ? { ...b, ...out.get(i)! } : b);
        expect(placed[1].x).toBe(0);      // the leftmost by POSITION is index 1
        expect(placed[0].x).toBe(100);    // the rightmost is index 0
        expect(placed[2].x).toBeCloseTo(50, 10);
    });

    test("distribute needs THREE boxes; align needs two; non-finite input moves nothing", () => {
        expect(distributeBoxes([box(0, 0), box(50, 0)], "horizontal").size).toBe(0);
        expect(alignBoxes([box(0, 0)], "left").size).toBe(0);
        expect(alignBoxes([box(NaN, 0), box(50, 0)], "left").size).toBe(0);
        expect(distributeBoxes([box(0, 0), box(1, 0), box(Infinity, 0)], "horizontal").size).toBe(0);
    });

    test("an OVERLAPPING selection distributes to a negative gap rather than special-casing", () => {
        const boxes = [box(0, 0, 100, 10), box(10, 0, 100, 10), box(20, 0, 100, 10)];
        const out = distributeBoxes(boxes, "horizontal");
        const placed = boxes.map((b, i) => out.has(i) ? { ...b, ...out.get(i)! } : b);
        expect(placed[0].x).toBe(0);
        expect(placed[2].x).toBe(20);     // extremes still pinned; the middle sits between them
        expect(placed[1].x).toBeCloseTo(10, 10);
    });
});

describe("Align actions: which nodes actually move", () => {
    function scene(): ProjectDocument {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number, parent: string | null = null) => {
            doc.nodes.set(id, { id, type: "core.rectangle", parent, children: [], geometry: { x, y, width: 20, height: 20 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
            if (parent) doc.nodes.get(parent)!.children.push(id); else doc.rootNodeUuids.push(id);
        };
        mk("A", 0, 0); mk("B", 100, 50); mk("C", 200, 90);
        return doc;
    }

    test("aligning is ONE undo step for the whole selection", () => {
        const dispatcher = new ActionDispatcher(scene());
        const doc = dispatcher.getDocument();
        const action = alignAction(doc, computeGeometry(doc), ["A", "B", "C"], "top")!;
        expect(dispatcher.dispatchAction(action).success).toBe(true);
        const d = dispatcher.getDocument();
        expect(d.nodes.get("B")!.geometry.y).toBe(0);
        expect(d.nodes.get("C")!.geometry.y).toBe(0);
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.get("B")!.geometry.y).toBe(50);   // all of it, at once
        expect(dispatcher.getDocument().nodes.get("C")!.geometry.y).toBe(90);
    });

    test("an already-aligned selection produces NO action, so no empty undo step", () => {
        const doc = createEmptyDocument();
        for (const [id, x] of [["A", 0], ["B", 50]] as [string, number][]) {
            doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y: 0, width: 20, height: 20 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
            doc.rootNodeUuids.push(id);
        }
        expect(alignAction(doc, computeGeometry(doc), ["A", "B"], "top")).toBeNull();
    });

    test("only selection ROOTS move — a child would otherwise be moved twice", () => {
        const doc = scene();
        // Make C a child of A: selecting both must move only A, since C travels with it.
        doc.rootNodeUuids = ["A", "B"];
        doc.nodes.set("C", { ...doc.nodes.get("C")!, parent: "A" });
        doc.nodes.set("A", { ...doc.nodes.get("A")!, children: ["C"] });
        const dispatcher = new ActionDispatcher(doc);
        const d0 = dispatcher.getDocument();
        const before = d0.nodes.get("C")!.geometry.y;
        dispatcher.dispatchAction(alignAction(d0, computeGeometry(d0), ["A", "C", "B"], "top")!);
        expect(dispatcher.getDocument().nodes.get("C")!.geometry.y).toBe(before); // untouched
    });

    test("a LAID-OUT child is skipped: its stored x/y is dead data under a container", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["A", "B"], geometry: { x: 0, y: 0, width: 300, height: 100 }, style: { fill: "#111", opacity: 1 }, layout: { container: { direction: "row", gap: 10 } } });
        for (const id of ["A", "B"]) {
            doc.nodes.set(id, { id, type: "core.rectangle", parent: "P", children: [], geometry: { x: 0, y: 0, width: 20, height: 20 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        }
        doc.rootNodeUuids = ["P"];
        expect(alignAction(doc, computeGeometry(doc), ["A", "B"], "left")).toBeNull();
    });

    test("aligning an instance COPY writes a per-instance OVERRIDE, not a stored edit", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: ["MC"], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("MC", { id: "MC", type: "core.rectangle", parent: "M", children: [], geometry: { x: 10, y: 40, width: 20, height: 20 }, style: { fill: "#0f0", opacity: 1 }, layout: {} });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 300, y: 0, width: 100, height: 100 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.nodes.set("X", { id: "X", type: "core.rectangle", parent: null, children: [], geometry: { x: 500, y: 0, width: 20, height: 20 }, style: { fill: "#00f", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["M", "I", "X"];
        const dispatcher = new ActionDispatcher(doc);
        const d0 = dispatcher.getDocument();
        const action = alignAction(d0, computeGeometry(d0), ["I::MC", "X"], "top");
        expect(action).not.toBeNull();
        dispatcher.dispatchAction(action!);
        // Routed: the copy's move became an override on the instance; the master never moved.
        expect(dispatcher.getDocument().nodes.get("I")!.overrides!.MC.geometry).toMatchObject({ y: 0 });
        expect(dispatcher.getDocument().nodes.get("MC")!.geometry.y).toBe(40);
    });

    test("distribute needs three MOVABLE roots, and evens the gaps in the document", () => {
        const dispatcher = new ActionDispatcher(scene());
        const d0 = dispatcher.getDocument();
        expect(distributeAction(d0, computeGeometry(d0), ["A", "B"], "horizontal")).toBeNull();
        dispatcher.dispatchAction(distributeAction(d0, computeGeometry(d0), ["A", "B", "C"], "horizontal")!);
        const d = dispatcher.getDocument();
        const g = (id: string) => d.nodes.get(id)!.geometry;
        expect(g("A").x).toBe(0);
        expect(g("C").x).toBe(200);
        expect(g("B").x - (g("A").x + 20)).toBeCloseTo(g("C").x - (g("B").x + 20), 10);
    });
});

describe("Align actions: the world-to-stored seam", () => {
    test("a NESTED node aligns in WORLD space but is written in PARENT-relative stored units", () => {
        // Every earlier fixture was top-level at the origin, where world == stored — so the
        // conversion was never exercised and a mutant replacing it survived.
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["A"], geometry: { x: 300, y: 200, width: 400, height: 400 }, style: { fill: "#111", opacity: 1 }, layout: {} });
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: "P", children: [], geometry: { x: 50, y: 90, width: 20, height: 20 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("B", { id: "B", type: "core.rectangle", parent: null, children: [], geometry: { x: 100, y: 20, width: 20, height: 20 }, style: { fill: "#00f", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "B"];

        const dispatcher = new ActionDispatcher(doc);
        const d0 = dispatcher.getDocument();
        // A's WORLD top is 200 + 90 = 290; B's is 20. Aligning top pulls A up to world y=20…
        dispatcher.dispatchAction(alignAction(d0, computeGeometry(d0), ["A", "B"], "top")!);
        const d = dispatcher.getDocument();
        // …which is STORED y = 20 - 200 = -180 inside P, not 20.
        expect(d.nodes.get("A")!.geometry.y).toBe(-180);
        expect(d.nodes.get("B")!.geometry.y).toBe(20);
        // And the rendered result is what was asked for: both world tops equal.
        const after = computeGeometry(d);
        expect(after.nodes.get("A")!.bounds.y).toBeCloseTo(after.nodes.get("B")!.bounds.y, 10);
    });

    test("a ROTATED node is left alone — a world delta is not its stored delta", () => {
        // Same rule snapping and group-move obey: only a translation-only chain can take a
        // world-space result directly. Rotating breaks that, so the node is skipped rather
        // than moved to somewhere it was not asked to go.
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
            doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: 20, height: 20 }, style: { fill: "#f00", opacity: 1 }, layout: {}, ...extra });
            doc.rootNodeUuids.push(id);
        };
        mk("R", 0, 100, { transform: { rotation: Math.PI / 5 } });
        mk("A", 200, 40);
        mk("B", 400, 70);
        const dispatcher = new ActionDispatcher(doc);
        const d0 = dispatcher.getDocument();
        const before = d0.nodes.get("R")!.geometry.y;
        dispatcher.dispatchAction(alignAction(d0, computeGeometry(d0), ["R", "A", "B"], "top")!);
        const d = dispatcher.getDocument();
        expect(d.nodes.get("R")!.geometry.y).toBe(before);   // untouched
        // …while the others still align to each other (the rotated one is simply not in the set).
        expect(d.nodes.get("A")!.geometry.y).toBe(d.nodes.get("B")!.geometry.y);
    });

    test("an already-EVEN selection distributes to no action, so no empty undo step", () => {
        // The distribute counterpart of the align check. Without it, re-clicking distribute on
        // an even row would push an undo step that changes nothing.
        const doc = createEmptyDocument();
        for (const [id, x] of [["A", 0], ["B", 60], ["C", 120]] as [string, number][]) {
            doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y: 0, width: 20, height: 20 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
            doc.rootNodeUuids.push(id);
        }
        expect(distributeAction(doc, computeGeometry(doc), ["A", "B", "C"], "horizontal")).toBeNull();
        // …and it is idempotent through the dispatcher: distributing an UNEVEN row once makes
        // it even, and a second distribute then has nothing to do.
        const uneven = createEmptyDocument();
        for (const [id, x] of [["A", 0], ["B", 30], ["C", 200]] as [string, number][]) {
            uneven.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y: 0, width: 20, height: 20 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
            uneven.rootNodeUuids.push(id);
        }
        const dispatcher = new ActionDispatcher(uneven);
        const d0 = dispatcher.getDocument();
        dispatcher.dispatchAction(distributeAction(d0, computeGeometry(d0), ["A", "B", "C"], "horizontal")!);
        const d1 = dispatcher.getDocument();
        expect(distributeAction(d1, computeGeometry(d1), ["A", "B", "C"], "horizontal")).toBeNull();
    });

    test("a selection of ONLY untouchable nodes produces no action at all", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("R", { id: "R", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 100, width: 20, height: 20 }, style: { fill: "#f00", opacity: 1 }, layout: {}, transform: { rotation: 0.5 } });
        doc.nodes.set("S", { id: "S", type: "core.rectangle", parent: null, children: [], geometry: { x: 90, y: 10, width: 20, height: 20 }, style: { fill: "#f00", opacity: 1 }, layout: {}, transform: { rotation: 0.7 } });
        doc.rootNodeUuids = ["R", "S"];
        expect(alignAction(doc, computeGeometry(doc), ["R", "S"], "left")).toBeNull();
    });
});

// ─── Content edits: text, image source and display name were write-once until now ───
describe("UpdateNodeContentAction", () => {
    function doc7(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("T", { id: "T", type: "core.text", parent: null, children: [], geometry: { x: 0, y: 0, width: 100, height: 30 }, style: { fill: "#fff", opacity: 1 }, layout: {}, text: "Text" });
        doc.nodes.set("IMG", { id: "IMG", type: "core.image", parent: null, children: [], geometry: { x: 0, y: 50, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["T", "IMG"];
        return doc;
    }
    const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

    test("a text node's CONTENT can finally be changed, and it round-trips", () => {
        // It could be authored ("Text") and rendered, but no action touched `text` at all.
        const dispatcher = new ActionDispatcher(doc7());
        expect(dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(), "T", { text: "Hello" })).success).toBe(true);
        expect(dispatcher.getDocument().nodes.get("T")!.text).toBe("Hello");
        const loaded = deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(loaded.nodes.get("T")!.text).toBe("Hello");
        // An EMPTY string is a legitimate value (an empty text node), not a no-op.
        dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(), "T", { text: "" }));
        expect(dispatcher.getDocument().nodes.get("T")!.text).toBe("");
    });

    test("an omitted field is left alone — a patch is not a replace", () => {
        const dispatcher = new ActionDispatcher(doc7());
        dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(), "T", { name: "Heading" }));
        const d = dispatcher.getDocument();
        expect(d.nodes.get("T")!.name).toBe("Heading");
        expect(d.nodes.get("T")!.text).toBe("Text");     // untouched by a name-only patch
    });

    test("a src patch obeys the SHARED srcError, so the inspector cannot author an unloadable node", () => {
        const dispatcher = new ActionDispatcher(doc7());
        expect(dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(), "IMG", { src: PIXEL })).success).toBe(true);
        expect(dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(), "IMG", { src: "javascript:alert(1)" })).success).toBe(false);
        // …and a src on a node type that may not carry one is refused by the same rule.
        expect(dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(), "T", { src: PIXEL })).success).toBe(false);
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();
    });

    test("a name is bounded and must be a string", () => {
        const doc = doc7();
        expect(new UpdateNodeContentAction(doc, "T", { name: "x".repeat(NODE_NAME_MAX) }).validate()).toBe(true);
        expect(new UpdateNodeContentAction(doc, "T", { name: "x".repeat(NODE_NAME_MAX + 1) }).validate()).toBe(false);
        expect(new UpdateNodeContentAction(doc, "T", { name: 7 as unknown as string }).validate()).toBe(false);
        expect(new UpdateNodeContentAction(doc, "gone", { name: "x" }).validate()).toBe(false);
    });

    test("contentActionFor routes: a copy's TEXT becomes an override, its NAME is refused", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.text", parent: null, children: [], geometry: { x: 0, y: 0, width: 80, height: 20 }, style: { fill: "#fff", opacity: 1 }, layout: {}, text: "master" });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 0, width: 80, height: 20 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I"];
        const dispatcher = new ActionDispatcher(doc);
        const action = contentActionFor(dispatcher.getDocument(), "I::M", { text: "copy" });
        expect(action).toBeInstanceOf(SetInstanceOverrideAction);
        dispatcher.dispatchAction(action!);
        expect(dispatcher.getDocument().nodes.get("I")!.overrides!.M.text).toBe("copy");
        expect(dispatcher.getDocument().nodes.get("M")!.text).toBe("master");   // master untouched
        expect(expandInstances(dispatcher.getDocument()).nodes.get("I::M")!.text).toBe("copy");
        // A NAME has no override slot — refused rather than written where it cannot live.
        expect(contentActionFor(dispatcher.getDocument(), "I::M", { name: "nope" })).toBeNull();
        // A MIXED patch is refused WHOLE. Honouring the text and silently dropping the name is
        // the partial-application failure this codebase keeps designing against: the caller
        // would believe both landed.
        expect(contentActionFor(dispatcher.getDocument(), "I::M", { text: "x", name: "nope" })).toBeNull();
        // An empty patch asks for nothing, so it produces nothing rather than a no-op override.
        expect(contentActionFor(dispatcher.getDocument(), "I::M", {})).toBeNull();
        // …and a stored node routes to the direct action.
        expect(contentActionFor(dispatcher.getDocument(), "M", { text: "x" })).toBeInstanceOf(UpdateNodeContentAction);
        expect(contentActionFor(dispatcher.getDocument(), "gone", { text: "x" })).toBeNull();
    });

    test("the inspector reaches every Style field the schema defines", () => {
        // The audit that prompted this slice: the panel edited x/y/w/h, fill and opacity, and
        // nothing else — while the engine validated, rendered and round-tripped the rest.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        for (const field of ["fill", "stroke", "strokeWidth", "radius", "opacity", "fontSize", "shadow", "blur"]) {
            expect(src).toMatch(new RegExp(`style: \\{ ${field}`));
        }
        // …and the content fields, which had no write path at all before this commit.
        expect(src).toMatch(/editContent\(\{ text:/);
        expect(src).toMatch(/editContent\(\{ src:/);
        expect(src).toMatch(/editContent\(\{ name:/);
        expect(src).toMatch(/editTransform\(\{ rotation:/);
    });
});

// ─── Auto-layout reaches the UI: the engine's most capable subsystem, finally connected ───
describe("Inspector: layout controls", () => {
    function doc8(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["A", "B"], geometry: { x: 0, y: 0, width: 300, height: 120 }, style: { fill: "#111", opacity: 1 }, layout: {} });
        for (const id of ["A", "B"]) {
            doc.nodes.set(id, { id, type: "core.rectangle", parent: "P", children: [], geometry: { x: 0, y: 0, width: 40, height: 40 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        }
        doc.rootNodeUuids = ["P"];
        return doc;
    }

    test("turning a node into an auto-layout container LAYS OUT its children", () => {
        // The engine has done this since M2; nothing in the UI could switch it on.
        const dispatcher = new ActionDispatcher(doc8());
        const before = computeGeometry(dispatcher.getDocument());
        expect(before.nodes.get("A")!.bounds.x).toBe(0);
        expect(before.nodes.get("B")!.bounds.x).toBe(0);      // both at stored (0,0): overlapping

        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "P", {
            container: { direction: "row", gap: 8, padding: 8 }
        }));
        const after = computeGeometry(dispatcher.getDocument());
        expect(after.nodes.get("A")!.bounds.x).toBe(8);        // padding
        expect(after.nodes.get("B")!.bounds.x).toBe(56);       // 8 + 40 + gap 8
        expect(() => deserializeDocument(serializeDocument(dispatcher.getDocument()))).not.toThrow();
    });

    test("grow makes a child consume the row's free space", () => {
        const dispatcher = new ActionDispatcher(doc8());
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "P", { container: { direction: "row", gap: 0, padding: 0 } }));
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "A", { grow: 1 }));
        const after = computeGeometry(dispatcher.getDocument());
        // 300 wide, B keeps 40, so A grows to 260.
        expect(after.nodes.get("A")!.bounds.width).toBe(260);
        expect(after.nodes.get("B")!.bounds.x).toBe(260);
    });

    test("grid ⊕ container exclusivity is carried by the action, not the UI", () => {
        const dispatcher = new ActionDispatcher(doc8());
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "P", { container: { direction: "row" } }));
        expect(dispatcher.getDocument().nodes.get("P")!.layout.container).toBeDefined();
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "P", {
            grid: { columns: [{ px: 50 }, { px: 50 }], rowHeight: { px: 50 } }
        }));
        const l = dispatcher.getDocument().nodes.get("P")!.layout;
        expect(l.grid).toBeDefined();
        expect(l.container).toBeUndefined();     // the previous mode is cleared, not left dangling
    });

    test("the inspector offers CHILD-side layout only where it applies", () => {
        // Under a container: grow/shrink/margin/absolute. Under a plain parent: constraints.
        // Showing both would offer controls the engine ignores.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/parentIsContainer \?/);
        expect(src).toMatch(/editLayout\(\{ grow:/);
        expect(src).toMatch(/editLayout\(\{ shrink:/);
        expect(src).toMatch(/editLayout\(\{ margin:/);
        expect(src).toMatch(/editLayout\(\{ position:/);
        expect(src).toMatch(/editConstraint\("horizontal"/);
        expect(src).toMatch(/editConstraint\("vertical"/);
    });

    test("the inspector reaches the auto-layout CONTAINER fields the engine implements", () => {
        // The audit that prompted this slice, for Layout the way the Style one works.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        for (const field of ["direction", "gap", "padding", "alignItems", "wrap"]) {
            expect(src).toMatch(new RegExp(`editContainer\\(\\{ ${field}`));
        }
        expect(src).toMatch(/editLayout\(\{ container:/);
    });

    test("a copy's LAYOUT is now editable — the routing seam turns it into an override", () => {
        // Replaces the old "no override slot for layout" deferral (schema 26).
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I"];
        const action = layoutActionFor(doc, "I::M", { container: { direction: "column", gap: 0 } });
        expect(action).toBeInstanceOf(SetInstanceOverrideAction);
        // A NESTED copy is reachable too (schema 28) — the override lands on the stored
        // instance under a path key rather than being refused.
        expect(layoutActionFor(doc, "I::OI::deep", { container: { direction: "row" } })).toBeInstanceOf(SetInstanceOverrideAction);
        expect(transformActionFor(doc, "I::OI::deep", { rotation: 1 })).toBeInstanceOf(SetInstanceOverrideAction);
    });
});

// ─── Layout + transform overrides (schema 26): the last two fields a copy could not change ───
describe("Instance overrides: layout and transform", () => {
    /** A master that lays two children out in a ROW, instanced once. */
    function cardDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: ["C1", "C2"], geometry: { x: 0, y: 0, width: 100, height: 40 }, style: { fill: "#111111", opacity: 1 }, layout: { container: { direction: "row", gap: 0, padding: 0 } } });
        for (const id of ["C1", "C2"]) {
            doc.nodes.set(id, { id, type: "core.rectangle", parent: "M", children: [], geometry: { x: 0, y: 0, width: 20, height: 20 }, style: { fill: "#222222", opacity: 1 }, layout: {} });
        }
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 200, width: 100, height: 40 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I"];
        return doc;
    }
    const boundsOf = (doc: ReadonlyDocument, id: string) =>
        computeGeometry(expandInstances(doc) as ProjectDocument).nodes.get(id)!.bounds;

    test("ONE instance stacks in a column while the master keeps its row", () => {
        const dispatcher = new ActionDispatcher(cardDoc());
        dispatcher.dispatchAction(layoutActionFor(dispatcher.getDocument(), "I::M",
            { container: { direction: "column", gap: 0, padding: 0 } })!);
        const d = dispatcher.getDocument();

        // The COPY's children stack vertically…
        expect(boundsOf(d, "I::C1").y).toBe(200);
        expect(boundsOf(d, "I::C2").y).toBe(220);
        expect(boundsOf(d, "I::C1").x).toBe(boundsOf(d, "I::C2").x);
        // …while the MASTER is untouched, still laying its own children out in a row.
        expect(boundsOf(d, "C1").y).toBe(boundsOf(d, "C2").y);
        expect(boundsOf(d, "C2").x).toBe(20);
        expect(d.nodes.get("M")!.layout.container!.direction).toBe("row");
    });

    test("a transform override ROTATES a copy — the knob finally has somewhere to write", () => {
        const dispatcher = new ActionDispatcher(cardDoc());
        dispatcher.dispatchAction(transformActionFor(dispatcher.getDocument(), "I::M", { rotation: Math.PI / 2 })!);
        const expanded = expandInstances(dispatcher.getDocument());
        expect(expanded.nodes.get("I::M")!.transform!.rotation).toBeCloseTo(Math.PI / 2);
        expect(dispatcher.getDocument().nodes.get("M")!.transform).toBeUndefined();  // master unrotated
        // A rotated copy is still a legal node — the transform went through the stored validator.
        expect(transformError(expanded.nodes.get("I::M")!.transform!)).toBeNull();
    });

    test("the direct-edit path and the override path share ONE exclusivity rule", () => {
        // This is the claim `mergeLayout` was introduced to make true, and for one commit it
        // was not: the action kept its own copy of the rule. The two paths cannot be collapsed
        // into a single call — the action must emit a PARTIAL delta so a transaction merge
        // stays field-wise last-wins, while `mergeLayout` returns a whole Layout — so what
        // they share is `layoutExclusivity`, and this test is what holds them together.
        const gridPatch = { grid: { columns: [{ fr: 1 }], rowHeight: { px: 10 } } };

        // Direct edit, through the action, onto a node that IS a flex container.
        const doc = createEmptyDocument();
        doc.nodes.set("N", { id: "N", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#111111", opacity: 1 }, layout: { container: { direction: "row" } } });
        doc.rootNodeUuids = ["N"];
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "N", gridPatch));
        const direct = dispatcher.getDocument().nodes.get("N")!.layout;

        // The same patch through the OVERRIDE path, over the same base layout.
        const merged = mergeLayout({ container: { direction: "row" } }, gridPatch);

        // Same question, same answer — and both answers are loadable.
        expect(direct.container).toBeUndefined();
        expect(merged.container).toBeUndefined();
        expect(!!direct.grid).toBe(!!merged.grid);
        expect(layoutError(direct)).toBeNull();
        expect(layoutError(merged)).toBeNull();
    });

    test("the OVERRIDE wins grid ⊕ container, in both directions", () => {
        // A plain spread would leave a node carrying BOTH, which no loader accepts. `mergeLayout`
        // is the one place that rule lives, shared with UpdateNodeLayoutAction's delta.
        const flex: Layout = { container: { direction: "row" } };
        const gridded = mergeLayout(flex, { grid: { columns: [{ fr: 1 }], rowHeight: { px: 10 } } });
        expect(gridded.grid).toBeDefined();
        expect(gridded.container).toBeUndefined();
        expect(layoutError(gridded)).toBeNull();

        const grid: Layout = { grid: { columns: [{ fr: 1 }], rowHeight: { px: 10 } } };
        const flexed = mergeLayout(grid, { container: { direction: "column" } });
        expect(flexed.container).toBeDefined();
        expect(flexed.grid).toBeUndefined();
        expect(layoutError(flexed)).toBeNull();
    });

    test("an expanded copy with a layout override is a LOADABLE node, not just a drawable one", () => {
        // The closure that matters: detach bakes overrides into stored nodes, so anything
        // expansion can produce must be something the document can hold.
        const dispatcher = new ActionDispatcher(cardDoc());
        dispatcher.dispatchAction(layoutActionFor(dispatcher.getDocument(), "I::M",
            { grid: { columns: [{ fr: 1 }, { fr: 1 }], rowHeight: { px: 20 } } })!);
        const copy = expandInstances(dispatcher.getDocument()).nodes.get("I::M")!;
        expect(copy.layout.grid).toBeDefined();
        expect(copy.layout.container).toBeUndefined();   // the master's row did not survive
        expect(layoutError(copy.layout)).toBeNull();
    });

    test("a layout override may NOT smuggle constraints onto the master-root copy", () => {
        // The root copy's constraints are cleared because it no longer has the master's parent.
        // That clear runs AFTER the override merge, so an override cannot reintroduce them.
        const doc = cardDoc();
        doc.nodes.get("I")!.overrides = { M: { layout: { constraints: { horizontal: "right" }, constraintRef: { width: 10, height: 10 } } } };
        const copy = expandInstances(doc).nodes.get("I::M")!;
        expect(copy.layout.constraints).toBeUndefined();
        expect(copy.layout.constraintRef).toBeUndefined();
    });

    test("both new fields go through the SAME validators their stored counterparts use", () => {
        const bad = (o: unknown) => overridesError("core.instance", { M: o });
        expect(bad({ layout: { grow: -1 } })).not.toBeNull();              // layoutError
        expect(bad({ layout: { container: { direction: "sideways" } } })).not.toBeNull();
        expect(bad({ layout: "row" })).not.toBeNull();
        expect(bad({ transform: { scaleX: 0 } })).not.toBeNull();          // transformError: non-invertible
        expect(bad({ transform: { rotation: Number.NaN } })).not.toBeNull();
        expect(bad({ transform: 90 })).not.toBeNull();
        expect(bad({ layout: { grow: 2 }, transform: { rotation: 1 } })).toBeNull();   // …and the valid pair
    });

    test("a document carrying the new overrides round-trips at schema 26", () => {
        const dispatcher = new ActionDispatcher(cardDoc());
        dispatcher.dispatchAction(layoutActionFor(dispatcher.getDocument(), "I::M", { container: { direction: "column", gap: 4 } })!);
        dispatcher.dispatchAction(transformActionFor(dispatcher.getDocument(), "I::M", { rotation: 0.5, scaleX: 2 })!);
        const d = dispatcher.getDocument();
        const loaded = deserializeDocument(serializeDocument(d));
        expect(loaded.nodes.get("I")!.overrides).toEqual(d.nodes.get("I")!.overrides);
        expect(compareDocuments(d, loaded)).toBe(true);
    });

    test("DETACH bakes an overridden layout and transform into ordinary nodes", () => {
        const dispatcher = new ActionDispatcher(cardDoc());
        dispatcher.dispatchAction(layoutActionFor(dispatcher.getDocument(), "I::M", { container: { direction: "column", gap: 0, padding: 0 } })!);
        const detach = new DetachInstanceAction(dispatcher.getDocument(), "I");
        expect(dispatcher.dispatchAction(detach).success).toBe(true);
        const d = dispatcher.getDocument();
        const root = d.nodes.get(detach.getCreatedNodeIds()[0])!;   // detach mints fresh ids
        expect(root.type).not.toBe("core.instance");
        expect(root.layout.container!.direction).toBe("column");   // the override, now stored
        expect(() => deserializeDocument(serializeDocument(d))).not.toThrow();
    });
});

// ─── Capability scan: find what a codebase can do but offers no way to reach ───
describe("scanCapabilities", () => {
    const f = (path: string, content: string) => ({ path, content });

    test("an export USED by another file is not reported; an unused one is", () => {
        const wired = scanCapabilities([
            f("src/commands/save.ts", "export function handleSave() {}"),
            f("src/ui/Toolbar.tsx", "import { handleSave } from '../commands/save';\nhandleSave();")
        ]);
        expect(wired).toEqual([]);
        const unwired = scanCapabilities([
            f("src/commands/save.ts", "export function handleSave() {}"),
            // Toolbar IS referenced (by the app shell), so only the command is unwired — the
            // realistic shape of the problem: the button exists, nothing calls the command.
            f("src/ui/Toolbar.tsx", "export function Toolbar() { return null; }"),
            f("src/App.tsx", "import { Toolbar } from './ui/Toolbar';\nexport default function App() { return Toolbar(); }")
        ]);
        expect(unwired.map(c => c.name)).toEqual(["handleSave"]);
        expect(unwired[0].line).toBe(1);
        expect(unwired[0].path).toBe("src/commands/save.ts");
    });

    test("every export FORM is recognised, or the scan silently misses capabilities", () => {
        const caps = scanCapabilities([f("src/actions/all.ts", [
            "export function doA() {}",
            "export async function doB() {}",
            "export class DoC {}",
            "export const doD = () => {};",
            "let doE = 1; let renamed = 2;",
            "export { doE, renamed as doF };"
        ].join("\n"))]);
        expect(caps.map(c => c.name).sort()).toEqual(["DoC", "doA", "doB", "doD", "doE", "doF"]);
    });

    test("a symbol used only WITHIN its own file is still unwired", () => {
        // The point of the tool: something the product cannot reach, even if it is
        // internally self-consistent.
        const caps = scanCapabilities([
            f("src/commands/export.ts", "export function doExport() { helper(); }\nfunction helper() { doExport; }")
        ]);
        expect(caps.map(c => c.name)).toContain("doExport");
    });

    test("a symbol used only by a TEST is unwired from the product's point of view", () => {
        const caps = scanCapabilities([
            f("src/commands/share.ts", "export function doShare() {}"),
            f("src/commands/share.test.ts", "import { doShare } from './share'; doShare();")
        ]);
        expect(caps.map(c => c.name)).toEqual(["doShare"]);
    });

    test("build output and dependencies are never scanned", () => {
        const caps = scanCapabilities([
            f("node_modules/lib/index.js", "export function handleThing() {}"),
            f("dist/bundle.js", "export function handleOther() {}"),
            f("src/types.d.ts", "export function handleTyped(): void;")
        ]);
        expect(caps).toEqual([]);
    });

    test("ranking puts likely USER-FACING findings first, and is stable", () => {
        const caps = scanCapabilities([
            f("src/util/misc.ts", "export const somethingInternal = 1;"),
            f("src/lib/thing.ts", "export function toggleThing() {}"),
            f("src/commands/publish.ts", "export function doPublish() {}")
        ]);
        expect(caps.map(c => c.confidence)).toEqual(["high", "medium", "low"]);
        expect(caps[0].name).toBe("doPublish");
        expect(caps[0].kind).toBe("command");
        expect(caps[1].name).toBe("toggleThing");
        // Deterministic: the same input yields an identical list, so a re-scan does not churn.
        expect(scanCapabilities([
            f("src/commands/publish.ts", "export function doPublish() {}"),
            f("src/util/misc.ts", "export const somethingInternal = 1;"),
            f("src/lib/thing.ts", "export function toggleThing() {}")
        ])).toEqual(caps);
    });

    test("the reason given is checkable prose, not a score", () => {
        const caps = scanCapabilities([f("src/handlers/x.ts", "export function onSubmit() {}")]);
        expect(caps[0].reason).toMatch(/referenced nowhere else/);
        expect(caps[0].confidence).toBe("high");
    });

    test("a whole-word match, so a NAME is not counted as used by a longer one", () => {
        // `handleSaveAll` mentioning is not a use of `handleSave`.
        const caps = scanCapabilities([
            f("src/commands/save.ts", "export function handleSave() {}"),
            f("src/ui/x.ts", "export function handleSaveAll() {} // handleSaveAllTheThings")
        ]);
        expect(caps.map(c => c.name)).toContain("handleSave");
    });

    test("an ENTRY POINT may not DECLARE a capability, but its imports still count as uses", () => {
        // Two filters, not one. An entry is reached by the bundler, so being unreferenced is
        // its normal state and reporting it would top every scan with a false positive. But an
        // entry is also exactly where an app wires its parts together — excluding it from the
        // reference corpus made everything it imports look unwired.
        const caps = scanCapabilities([
            f("src/main.ts", "import { doThing } from './commands/thing';\nexport function main() { doThing(); }"),
            f("src/commands/thing.ts", "export function doThing() {}"),
            f("src/commands/other.ts", "export function doOther() {}")
        ]);
        expect(caps.map(c => c.name)).toEqual(["doOther"]);   // not `main`, and not `doThing`
    });

    test("a CONSTANT is never ranked as a user-facing capability, wherever it lives", () => {
        // Running this over its own repository put two exported constants at the TOP of the
        // list, purely because they sit in an actions/ directory. A tuning value is not
        // something a user triggers, and a noisy first result teaches people to ignore the list.
        const caps = scanCapabilities([
            f("src/actions/thing.ts", "export const FRAME_PADDING = 0;\nexport function doThing() {}")
        ]);
        const byName = Object.fromEntries(caps.map(c => [c.name, c]));
        expect(byName.FRAME_PADDING.confidence).toBe("low");
        expect(byName.FRAME_PADDING.kind).toBe("constant");
        expect(byName.doThing.confidence).toBe("high");
        expect(caps[0].name).toBe("doThing");   // the real capability ranks first
    });

    test("scanning nothing, or files with no exports, yields nothing", () => {
        expect(scanCapabilities([])).toEqual([]);
        expect(scanCapabilities([f("src/a.ts", "const x = 1;\nfunction y() {}")])).toEqual([]);
    });
});

// ─── SVG export: the artefact you hand to a developer ───
describe("exportSVG typography and line breaks", () => {
    const textDoc = (text: string, style: Record<string, unknown> = {}): ProjectDocument => {
        const doc = createEmptyDocument();
        doc.nodes.set("T", { id: "T", type: "core.text", parent: null, children: [], text,
            geometry: { x: 0, y: 0, width: 200, height: 100 }, layout: {},
            style: { fill: "#112233", opacity: 1, fontSize: 20, ...style } } as Node);
        doc.rootNodeUuids = ["T"];
        return doc;
    };

    test("the exported text carries the TYPOGRAPHY the editor draws", () => {
        // The gap this closes: the editor drew family, weight, alignment and spacing while the
        // exported file was one default-styled run. An exporter that silently drops features is
        // worse than none, because the difference only shows up in someone else's hands.
        const svg = exportSVG(textDoc("Hi", {
            fontFamily: "Inter, sans-serif", fontWeight: 700, letterSpacing: 1.5, textAlign: "center"
        }));
        expect(svg).toContain('font-family="Inter, sans-serif"');
        expect(svg).toContain('font-weight="700"');
        expect(svg).toContain('letter-spacing="1.5"');
        expect(svg).toContain('text-anchor="middle"');
        // Centre-anchored text anchors about a POINT, so the x moves to the box centre — the
        // same move the canvas backend makes for the same reason.
        expect(svg).toContain('<tspan x="100"');
    });

    test("alignment picks the anchor AND the x, on all three sides", () => {
        expect(exportSVG(textDoc("Hi"))).toContain('text-anchor="start"');
        expect(exportSVG(textDoc("Hi"))).toContain('<tspan x="0"');
        expect(exportSVG(textDoc("Hi", { textAlign: "right" }))).toContain('text-anchor="end"');
        expect(exportSVG(textDoc("Hi", { textAlign: "right" }))).toContain('<tspan x="200"');
        // `justify` has no SVG anchor either, so it falls back to the left — the same documented
        // fallback the canvas backend makes.
        expect(exportSVG(textDoc("Hi", { textAlign: "justify" }))).toContain('text-anchor="start"');
    });

    test("explicit newlines become tspans, stepped by the LINE HEIGHT", () => {
        const NL = String.fromCharCode(10);
        const svg = exportSVG(textDoc("one" + NL + "two" + NL + "three", { lineHeight: 2 }));
        // First baseline one font-size below the box top, then 20 x 2 per line.
        expect(svg).toContain('<tspan x="0" y="20">one</tspan>');
        expect(svg).toContain('<tspan x="0" y="60">two</tspan>');
        expect(svg).toContain('<tspan x="0" y="100">three</tspan>');
    });

    test("the hard-break rule is SHARED, so the exporter and both backends cannot disagree", () => {
        // Runs of spaces and tabs collapse; a newline is a break. One function, three consumers.
        const NL = String.fromCharCode(10), TAB = String.fromCharCode(9);
        expect(textParagraphs("a" + NL + "b")).toEqual(["a", "b"]);
        expect(textParagraphs("a  " + TAB + " b")).toEqual(["a b"]);
        expect(textParagraphs("")).toEqual([""]);
        expect(textParagraphs("a" + NL + NL + "b")).toEqual(["a", "", "b"]);
        const svg = exportSVG(textDoc("a  " + TAB + " b" + NL + "c"));
        expect(svg).toContain(">a b</tspan>");
        expect(svg).toContain(">c</tspan>");
    });

    test("letter-spacing is OMITTED when it is zero, so a plain export stays plain", () => {
        expect(exportSVG(textDoc("Hi"))).not.toContain("letter-spacing");
        expect(exportSVG(textDoc("Hi", { letterSpacing: -1 }))).toContain('letter-spacing="-1"');
    });

    test("the inspector can actually TYPE a newline, and the preview shows what will be written", () => {
        // Found by exporting from the real app: the export came back as one run because the
        // Content field was an `<input>`, which strips newlines — so multi-line text, which both
        // backends and the exporter support, could not be authored at all. A feature with no way
        // to reach it is not a feature.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/<textarea[\s\S]{0,200}value=\{node\.text \?\? ""\}/);
        // …and the export can be READ without a native dialog in the way, which is both a
        // usability win and the only way to verify the exporter end to end.
        expect(src).toMatch(/setPreview\(exportSVG\(getDocument\(\)\)\)/);
        expect(src).toMatch(/data-svg-preview="1"/);
    });

    test("the exported markup is well-formed, and escapes what it interpolates", () => {
        const svg = exportSVG(textDoc('a & b < c > "d"'));
        expect(svg).toContain("&amp;");
        expect(svg).toContain("&lt;");
        expect(svg).not.toMatch(/<tspan[^>]*>[^<]*&(?!amp;|lt;|gt;|quot;)/);
        // Every tspan opened is closed, and the text element wraps them.
        expect((svg.match(/<tspan/g) ?? []).length).toBe((svg.match(/<\/tspan>/g) ?? []).length);
        expect(svg).toMatch(/<text[^>]*>(<tspan[\s\S]*?<\/tspan>)+<\/text>/);
    });
});

describe("exportSVG", () => {
    function docWithNodes(...nodes: Partial<Node>[]): ProjectDocument {
        const doc = createEmptyDocument();
        nodes.forEach((n, i) => {
            const id = n.id ?? `N${i}`;
            doc.nodes.set(id, {
                id, type: "core.rectangle", parent: null, children: [],
                geometry: { x: 0, y: 0, width: 50, height: 50 },
                style: { fill: "#ff0000", opacity: 1 }, layout: {}, ...n
            } as Node);
            doc.rootNodeUuids.push(id);
        });
        return doc;
    }

    test("an empty document exports valid, empty SVG rather than nothing", () => {
        const svg = exportSVG(createEmptyDocument());
        expect(svg).toContain("<svg");
        expect(svg).toContain("</svg>");
        expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    });

    test("the export is framed to the CONTENT, not to the editor's viewport", () => {
        // A node far from the origin must still appear: the model culls to the viewport, and an
        // export that inherited the editor's view would silently drop off-screen work.
        const doc = docWithNodes({ id: "far", geometry: { x: 5000, y: 4000, width: 100, height: 80 } });
        const svg = exportSVG(doc);
        expect(svg).toContain("<rect");
        // viewBox carries the content's own origin (minus the margin), so coordinates are kept.
        expect(svg).toMatch(new RegExp(`viewBox="${5000 - EXPORT_MARGIN} ${4000 - EXPORT_MARGIN} `));
        expect(svg).toContain(`width="${100 + EXPORT_MARGIN * 2}"`);
    });

    test("every shape kind survives the export", () => {
        const doc = createEmptyDocument();
        const add = (id: string, type: Node["type"], extra: Partial<Node> = {}) => {
            doc.nodes.set(id, {
                id, type, parent: null, children: [],
                geometry: { x: 0, y: 0, width: 40, height: 40 },
                style: { fill: "#00ff00", opacity: 1 }, layout: {}, ...extra
            } as Node);
            doc.rootNodeUuids.push(id);
        };
        add("r", "core.rectangle");
        add("e", "core.ellipse");
        add("l", "core.line");
        add("t", "core.text", { text: "Hi" });
        add("p", "core.path", { path: [{ c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 10 }, { c: "Z" }] });
        add("i", "core.image", { src: "https://example.com/a.png" });
        const svg = exportSVG(doc);
        for (const tag of ["<rect", "<ellipse", "<line", "<text", "<path", "<image"]) {
            expect(svg).toContain(tag);
        }
        expect(svg).toContain(">Hi<");
        expect(svg).toContain('d="M 0 0 L 10 10 Z"');
    });

    test("editor CHROME is excluded — an export is the design, not the workspace", () => {
        const doc = docWithNodes({ id: "a" });
        const svg = exportSVG(doc);
        // The grid draws lines and the selection overlay draws handles; neither belongs in a
        // deliverable. One <rect> means the content only.
        expect((svg.match(/<rect/g) || []).length).toBe(1);
        expect(svg).not.toContain("#00bfff");   // the selection accent
    });

    test("text and colours are XML-escaped, so a stray character cannot break the file", () => {
        const doc = docWithNodes({ id: "t", type: "core.text", text: 'a < b & "c"' });
        const svg = exportSVG(doc);
        expect(svg).toContain("a &lt; b &amp; &quot;c&quot;");
        expect(svg).not.toMatch(/>a < b/);
    });

    test("an effect exports as a filter def AND a reference, with matching ids", () => {
        const doc = docWithNodes({ id: "s", style: { fill: "#fff", opacity: 1, shadow: { dx: 2, dy: 3, blur: 4, color: "#000000" } } });
        const svg = exportSVG(doc);
        const defId = (svg.match(/<filter id="([^"]+)"/) || [])[1];
        expect(defId).toBeTruthy();
        expect(svg).toContain(`filter="url(#${defId})"`);
        expect(svg).toContain('<feDropShadow dx="2" dy="3"');
    });

    test("a stroke exports with its WIDTH, and a fill-less shape as fill=none", () => {
        const doc = docWithNodes({ id: "o", style: { fill: "none", opacity: 1, stroke: "#123456", strokeWidth: 6 } });
        const svg = exportSVG(doc);
        expect(svg).toContain('stroke="#123456"');
        expect(svg).toContain('stroke-width="6"');
        expect(svg).toContain('fill="none"');
    });

    test("a design token resolves to a real colour — an export cannot carry a $reference", () => {
        const doc = docWithNodes({ id: "tok", style: { fill: "$color/brand", opacity: 1 } });
        doc.variables = { "color/brand": { type: "color", value: "#abcdef" } };
        const svg = exportSVG(doc);
        expect(svg).toContain("#abcdef");
        expect(svg).not.toContain("$color/brand");
    });

    test("instance content is expanded, so a component exports as what it draws", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 30, height: 30 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 0, width: 30, height: 30 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I"];
        const svg = exportSVG(doc);
        // The master AND the instance's materialized copy both draw.
        expect((svg.match(/<rect/g) || []).length).toBe(2);
    });

    test("the same document always exports identically", () => {
        const doc = docWithNodes({ id: "a" }, { id: "b", geometry: { x: 90, y: 10, width: 20, height: 20 } });
        expect(exportSVG(doc)).toBe(exportSVG(doc));
    });
});

// ─── Keyboard shortcuts: the muscle-memory layer ───
describe("resolveShortcut", () => {
    test("arrows nudge by one, with Shift by ten", () => {
        expect(resolveShortcut({ key: "ArrowLeft" })).toEqual({ kind: "nudge", dx: -NUDGE_STEP, dy: 0 });
        expect(resolveShortcut({ key: "ArrowRight" })).toEqual({ kind: "nudge", dx: NUDGE_STEP, dy: 0 });
        expect(resolveShortcut({ key: "ArrowUp" })).toEqual({ kind: "nudge", dx: 0, dy: -NUDGE_STEP });
        expect(resolveShortcut({ key: "ArrowDown" })).toEqual({ kind: "nudge", dx: 0, dy: NUDGE_STEP });
        expect(resolveShortcut({ key: "ArrowUp", shiftKey: true })).toEqual({ kind: "nudge", dx: 0, dy: -NUDGE_STEP_LARGE });
    });

    test("Y is DOWN — the screen axis, not the maths one", () => {
        // Getting this backwards is the classic bug, and it is invisible until someone uses it.
        expect((resolveShortcut({ key: "ArrowDown" }) as { dy: number }).dy).toBeGreaterThan(0);
        expect((resolveShortcut({ key: "ArrowUp" }) as { dy: number }).dy).toBeLessThan(0);
    });

    test("Ctrl and Cmd are interchangeable, so one build suits both platforms", () => {
        expect(resolveShortcut({ key: "d", ctrlKey: true })).toEqual({ kind: "duplicate" });
        expect(resolveShortcut({ key: "d", metaKey: true })).toEqual({ kind: "duplicate" });
        expect(resolveShortcut({ key: "D", metaKey: true })).toEqual({ kind: "duplicate" });   // caps-lock / shift
        expect(resolveShortcut({ key: "g", ctrlKey: true })).toEqual({ kind: "group" });
        expect(resolveShortcut({ key: "a", metaKey: true })).toEqual({ kind: "select-all" });
    });

    test("undo, redo, and both redo spellings", () => {
        expect(resolveShortcut({ key: "z", ctrlKey: true })).toEqual({ kind: "undo" });
        expect(resolveShortcut({ key: "z", ctrlKey: true, shiftKey: true })).toEqual({ kind: "redo" });
        expect(resolveShortcut({ key: "y", ctrlKey: true })).toEqual({ kind: "redo" });
    });

    test("Delete and Backspace both delete; Escape deselects", () => {
        expect(resolveShortcut({ key: "Delete" })).toEqual({ kind: "delete" });
        expect(resolveShortcut({ key: "Backspace" })).toEqual({ kind: "delete" });
        expect(resolveShortcut({ key: "Escape" })).toEqual({ kind: "deselect" });
    });

    test("a MODIFIED arrow is left to the platform, not stolen as a nudge", () => {
        // Ctrl/Cmd+arrow means word-jump or desktop-switch; quietly consuming it is hostile.
        expect(resolveShortcut({ key: "ArrowLeft", ctrlKey: true })).toBeNull();
        expect(resolveShortcut({ key: "ArrowLeft", metaKey: true })).toBeNull();
    });

    test("unbound keys resolve to nothing", () => {
        expect(resolveShortcut({ key: "q" })).toBeNull();
        expect(resolveShortcut({ key: "d" })).toBeNull();          // needs the modifier
        expect(resolveShortcut({ key: "Delete", ctrlKey: true })).toBeNull();
    });

    test("typing in a field is never a shortcut", () => {
        // Otherwise Delete destroys the selection while renaming a layer.
        expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
        expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
        expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
        expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
        expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
        expect(isTypingTarget(null)).toBe(false);
    });
});

describe("DuplicateNodesAction", () => {
    function doc9(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["C"], geometry: { x: 10, y: 20, width: 80, height: 60 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: "P", children: [], geometry: { x: 5, y: 5, width: 20, height: 20 }, style: { fill: "#0f0", opacity: 1 }, layout: {} });
        doc.nodes.set("S", { id: "S", type: "core.rectangle", parent: null, children: [], geometry: { x: 200, y: 0, width: 30, height: 30 }, style: { fill: "#00f", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "S"];
        return doc;
    }

    test("a duplicate copies the whole SUBTREE, offset, with links pointing inside the copy", () => {
        const dispatcher = new ActionDispatcher(doc9());
        const action = new DuplicateNodesAction(dispatcher.getDocument(), ["P"]);
        expect(dispatcher.dispatchAction(action).success).toBe(true);
        const d = dispatcher.getDocument();
        const newRoot = action.getCreatedRootIds()[0];
        const copy = d.nodes.get(newRoot)!;
        expect(copy.geometry).toMatchObject({ x: 10 + DUPLICATE_OFFSET, y: 20 + DUPLICATE_OFFSET });
        expect(copy.children.length).toBe(1);
        const childCopy = d.nodes.get(copy.children[0])!;
        expect(childCopy.id).not.toBe("C");                  // a NEW id…
        expect(childCopy.parent).toBe(newRoot);              // …pointing into the copy
        expect(childCopy.geometry).toMatchObject({ x: 5, y: 5 });  // children are NOT offset again
        expect(d.nodes.get("P")!.children).toEqual(["C"]);   // the original is untouched
        expect(() => deserializeDocument(serializeDocument(d))).not.toThrow();
    });

    test("the copy lands directly AFTER the original, not on top of the stack", () => {
        const dispatcher = new ActionDispatcher(doc9());
        const action = new DuplicateNodesAction(dispatcher.getDocument(), ["P"]);
        dispatcher.dispatchAction(action);
        expect(dispatcher.getDocument().rootNodeUuids).toEqual(["P", action.getCreatedRootIds()[0], "S"]);
    });

    test("selecting a parent AND its child duplicates the parent once", () => {
        // The child rides along inside the parent's copy; duplicating both would produce it twice.
        const dispatcher = new ActionDispatcher(doc9());
        const before = dispatcher.getDocument().nodes.size;
        const action = new DuplicateNodesAction(dispatcher.getDocument(), ["P", "C"]);
        dispatcher.dispatchAction(action);
        expect(action.getCreatedRootIds().length).toBe(1);
        expect(dispatcher.getDocument().nodes.size).toBe(before + 2);   // P' and C' only
    });

    test("the copy owns its objects — editing it never reaches the original", () => {
        const dispatcher = new ActionDispatcher(doc9());
        const action = new DuplicateNodesAction(dispatcher.getDocument(), ["S"]);
        dispatcher.dispatchAction(action);
        const newId = action.getCreatedRootIds()[0];
        dispatcher.dispatchAction(new UpdateNodeStyleAction(dispatcher.getDocument(), newId, { fill: "#abcdef" }));
        expect(dispatcher.getDocument().nodes.get("S")!.style.fill).toBe("#00f");
    });

    test("an instance COPY cannot be duplicated — duplicate the instance instead", () => {
        const doc = doc9();
        expect(new DuplicateNodesAction(doc, ["I::M"]).validate()).toBe(false);
        expect(new DuplicateNodesAction(doc, []).validate()).toBe(false);
        expect(new DuplicateNodesAction(doc, ["gone"]).validate()).toBe(false);
    });

    test("duplicating is one undo step", () => {
        const dispatcher = new ActionDispatcher(doc9());
        const before = dispatcher.getDocument().nodes.size;
        dispatcher.dispatchAction(new DuplicateNodesAction(dispatcher.getDocument(), ["P"]));
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.size).toBe(before);
        expect(dispatcher.getDocument().rootNodeUuids).toEqual(["P", "S"]);
    });
});


// ─── Design tokens reach the UI: the last engine subsystem with no way in ───
describe("Tokens: authored, assigned, themed", () => {
    function tokenDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("R", { id: "R", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["R"];
        return doc;
    }
    const stateFor = (doc: ProjectDocument) =>
        ({ viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(doc) }) as unknown as import("../../renderer/RendererState").RendererState;
    const fillOf = (doc: ProjectDocument) =>
        buildRenderModel({ width: 400, height: 300 }, doc, stateFor(doc)).content.find(i => i.nodeId === "R")!.paint.fill;

    test("a token authored through the action is usable as a fill, and RESOLVES when rendered", () => {
        // End to end: create the token, point a node's fill at it, and the renderer shows the colour.
        const dispatcher = new ActionDispatcher(tokenDoc());
        dispatcher.dispatchAction(new SetVariableAction(dispatcher.getDocument(), "color/brand", { type: "color", value: "#ff8800" }));
        dispatcher.dispatchAction(styleActionFor(dispatcher.getDocument(), "R", { fill: "$color/brand" })!);
        const d = dispatcher.getDocument() as ProjectDocument;
        expect(d.nodes.get("R")!.style.fill).toBe("$color/brand");   // the DOCUMENT keeps the reference…
        expect(fillOf(d)).toBe("#ff8800");                            // …and the RENDER resolves it
    });

    test("a per-theme value is what makes a token more than a constant", () => {
        const dispatcher = new ActionDispatcher(tokenDoc());
        dispatcher.dispatchAction(new SetVariableAction(dispatcher.getDocument(), "color/bg",
            { type: "color", value: "#ffffff", modes: { dark: "#000000" } }));
        dispatcher.dispatchAction(styleActionFor(dispatcher.getDocument(), "R", { fill: "$color/bg" })!);
        expect(fillOf(dispatcher.getDocument() as ProjectDocument)).toBe("#ffffff");
        dispatcher.dispatchAction(new SetActiveThemeAction(dispatcher.getDocument(), "dark"));
        // ONE theme switch repaints every node that uses the token.
        expect(fillOf(dispatcher.getDocument() as ProjectDocument)).toBe("#000000");
    });

    test("deleting a token in use is ALLOWED and renders the visible fallback", () => {
        // A dangling reference is valid at rest — the same rule a dangling componentId follows.
        // Refusing the delete would leave no way to remove a token you no longer want.
        const dispatcher = new ActionDispatcher(tokenDoc());
        dispatcher.dispatchAction(new SetVariableAction(dispatcher.getDocument(), "color/gone", { type: "color", value: "#123456" }));
        dispatcher.dispatchAction(styleActionFor(dispatcher.getDocument(), "R", { fill: "$color/gone" })!);
        dispatcher.dispatchAction(new DeleteVariableAction(dispatcher.getDocument(), "color/gone"));
        const d = dispatcher.getDocument() as ProjectDocument;
        expect(fillOf(d)).toBe(VARIABLE_FALLBACK_COLOR);
        expect(() => deserializeDocument(serializeDocument(d))).not.toThrow();   // still loadable
    });

    test("a token document round-trips with its per-theme values", () => {
        const dispatcher = new ActionDispatcher(tokenDoc());
        dispatcher.dispatchAction(new SetVariableAction(dispatcher.getDocument(), "space/gutter",
            { type: "spacing", value: 8, modes: { dark: 12 } }));
        const doc = dispatcher.getDocument();
        const loaded = deserializeDocument(serializeDocument(doc));
        expect(loaded.variables["space/gutter"]).toEqual({ type: "spacing", value: 8, modes: { dark: 12 } });
        expect(compareDocuments(doc, loaded)).toBe(true);
    });

    test("the panel refuses a reserved token name through the SHARED validator", () => {
        // `variableKeyError` is the authority; the field only explains the refusal.
        expect(variableKeyError("__proto__")).not.toBeNull();
        expect(variableKeyError("")).not.toBeNull();
        expect(variableKeyError("color/ok")).toBeNull();
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/variableKeyError\(key\)/);
    });

    test("the picker's key⇄reference pair round-trips, and a bare key is NOT a reference", () => {
        // The live app caught this: the picker wrote `color/brand` instead of `$color/brand`,
        // which is neither a reference nor a colour, so the shape painted an invalid fill.
        // The sigil is engine grammar, so it is tested here rather than grepped for in the UI.
        expect(tokenRefFor("color/brand")).toBe("$color/brand");
        expect(isTokenRef(tokenRefFor("color/brand"))).toBe(true);
        expect(isTokenRef("color/brand")).toBe(false);          // the defect, stated directly
        expect(tokenKeyOf("$color/brand")).toBe("color/brand"); // …and back again
        expect(tokenKeyOf("#ff8800")).toBe("");                 // a concrete colour selects nothing
        expect(tokenRefFor("")).toBe("");                       // "no token" clears rather than making "$"
    });

    test("a reference built by the picker actually RESOLVES — the end the defect broke", () => {
        const dispatcher = new ActionDispatcher(tokenDoc());
        dispatcher.dispatchAction(new SetVariableAction(dispatcher.getDocument(), "color/brand", { type: "color", value: "#22cc88" }));
        dispatcher.dispatchAction(styleActionFor(dispatcher.getDocument(), "R", { fill: tokenRefFor("color/brand") })!);
        expect(fillOf(dispatcher.getDocument() as ProjectDocument)).toBe("#22cc88");
    });

    test("the UI can both AUTHOR a token and ASSIGN one — either alone is useless", () => {
        // The audit that prompted this slice, for tokens the way it exists for Style and Layout.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/new SetVariableAction\(/);      // author
        expect(src).toMatch(/new DeleteVariableAction\(/);   // remove
        expect(src).toMatch(/<TokenSelect/);                 // assign
        expect(src).toMatch(/style: \{ fill: v \|\|/);       // …to a fill
        expect(src).toMatch(/style: \{ stroke: v \|\|/);     // …and a stroke
    });
});


// ─── Grid track editing reaches the UI: the last engine subsystem with no way in ───
describe("Track lists: the authoring form of TrackSize[]", () => {
    test("the three track forms parse, and a bare number is pixels", () => {
        expect(parseTrackList("1fr 1fr 200px").tracks).toEqual([{ fr: 1 }, { fr: 1 }, { px: 200 }]);
        expect(parseTrackList("auto").tracks).toEqual([{ auto: true }]);
        expect(parseTrackList("120 80").tracks).toEqual([{ px: 120 }, { px: 80 }]);  // the unit people omit
        expect(parseTrackList("AUTO 2FR 10PX").tracks).toEqual([{ auto: true }, { fr: 2 }, { px: 10 }]);
        expect(parseTrackList("  1fr,2fr ,  auto ").tracks).toEqual([{ fr: 1 }, { fr: 2 }, { auto: true }]);
    });

    test("format is the inverse of parse, for every track kind and at the exponent boundary", () => {
        const lists: TrackSize[][] = [
            [{ fr: 1 }, { px: 200 }, { auto: true }],
            [{ px: 0 }],                    // a zero-width track is legal
            [{ px: 12.5 }, { fr: 0.25 }],
            [{ px: 1e21 }]                  // String(1e21) is "1e+21" — the formatter must re-parse
        ];
        for (const list of lists) {
            expect(parseTrackList(formatTrackList(list)).tracks).toEqual(list);
        }
        // …and the other direction: parsing then formatting is canonical text.
        expect(formatTrackList(parseTrackList("120  auto,1fr").tracks!)).toBe("120px auto 1fr");
    });

    test("the parser REFUSES exactly what the document refuses — it does not restate the rules", () => {
        // Each rejection below is `trackError`'s rule, reached through the parser.
        expect(parseTrackList("-5px").error).not.toBeNull();     // px must be >= 0
        expect(parseTrackList("0fr").error).not.toBeNull();      // fr must be > 0
        expect(parseTrackList("-1fr").error).not.toBeNull();
        expect(parseTrackList("1em").error).not.toBeNull();      // not a unit this engine has
        expect(parseTrackList("wide").error).not.toBeNull();
        expect(parseTrackList("").error).not.toBeNull();         // "no tracks" is never meant
        expect(parseTrackList("   ").error).not.toBeNull();
        expect(parseTrackList("1fr px").error).not.toBeNull();   // a bare unit is not a track
        expect(parseTrackList(new Array(GRID_MAX_TRACKS + 1).fill("1fr").join(" ")).error).not.toBeNull();
    });

    test("anything the parser ACCEPTS, a grid will hold — the closure that makes the field safe", () => {
        // The field cannot author a layout the loader would refuse, because a parsed list is
        // fed straight to the same `layoutError` the load path uses.
        for (const text of ["1fr", "auto", "0px", "1fr 2fr auto 100px", "0.5fr", "1e3px"]) {
            const tracks = parseTrackList(text).tracks!;
            expect(tracks).not.toBeNull();
            expect(layoutError({ grid: { columns: tracks, rowHeight: tracks[0] } })).toBeNull();
        }
    });

    test("a grid authored from parsed text lays out — the tracks reach real geometry", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("G", { id: "G", type: "core.rectangle", parent: null, children: ["a", "b"], geometry: { x: 0, y: 0, width: 220, height: 100 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        for (const id of ["a", "b"]) {
            doc.nodes.set(id, { id, type: "core.rectangle", parent: "G", children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#222222", opacity: 1 }, layout: {} });
        }
        doc.rootNodeUuids = ["G"];

        const dispatcher = new ActionDispatcher(doc);
        const columns = parseTrackList("100px 1fr").tracks!;
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "G",
            { grid: { columns, rowHeight: { px: 40 }, columnGap: 20, padding: 0 } }));

        const computed = computeGeometry(dispatcher.getDocument() as ProjectDocument);
        // 220 inner − 20 gap − 100 fixed = 100 left for the single `fr`.
        expect(computed.nodes.get("a")!.bounds.width).toBe(100);
        expect(computed.nodes.get("b")!.bounds.width).toBe(100);
        expect(computed.nodes.get("b")!.bounds.x).toBe(120);   // 100 + the gap
        expect(computed.nodes.get("a")!.bounds.height).toBe(40);
    });

    test("a grid document round-trips, tracks and all", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("G", { id: "G", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 200, height: 100 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["G"];
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "G", {
            grid: {
                columns: parseTrackList("1fr auto 50px").tracks!,
                rows: parseTrackList("auto 1fr").tracks!,
                rowHeight: { px: 30 }, autoFlow: "column dense", hugHeight: true, columnGap: 4, rowGap: 6, padding: 2
            }
        }));
        const d = dispatcher.getDocument();
        const loaded = deserializeDocument(serializeDocument(d));
        expect(loaded.nodes.get("G")!.layout.grid).toEqual(d.nodes.get("G")!.layout.grid);
        expect(compareDocuments(d, loaded)).toBe(true);
    });

    test("becoming a grid REPLACES auto-layout — the patch clears the container it excludes", () => {
        // Dispatching the REAL patch on a node that is already a flex container. Grid and
        // container are mutually exclusive, so if the pair ever both survived a patch,
        // `layoutError` would refuse it and the checkbox would do nothing at all — a failure
        // with no error message anywhere. The action clears the loser; this proves it end to end.
        const doc = createEmptyDocument();
        doc.nodes.set("F", { id: "F", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#111111", opacity: 1 }, layout: { container: { direction: "row", gap: 8 } } });
        doc.rootNodeUuids = ["F"];

        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new UpdateNodeLayoutAction(dispatcher.getDocument(), "F", newGridPatch()));

        const after = dispatcher.getDocument().nodes.get("F")!.layout;
        expect(after.grid).toBeDefined();
        expect(after.container).toBeUndefined();          // the flex layout is GONE, not shadowed
        expect(layoutError(after)).toBeNull();            // …and the result is a legal layout
    });

    test("the default grid patch is a COMPLETE grid — columns and rowHeight are mandatory", () => {
        const patch = newGridPatch();
        expect(layoutError(patch)).toBeNull();
        expect(patch.grid!.columns.length).toBeGreaterThan(0);
        expect(patch.grid!.rowHeight).toBeDefined();
        // Its tracks must survive the same text round trip every other track list does.
        expect(parseTrackList(formatTrackList(patch.grid!.columns)).tracks).toEqual(patch.grid!.columns);
    });

    test("the UI can CREATE a grid and edit every track field", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/<TrackListInput/);
        expect(src).toMatch(/editGrid\(\{ columns: t \}\)/);      // columns
        expect(src).toMatch(/editGrid\(\{ rows: t \?\? undefined \}\)/);  // the OPTIONAL rows list
        expect(src).toMatch(/editGrid\(\{ rowHeight: t\[0\] \}\)/);
        expect(src).toMatch(/editGrid\(\{ autoFlow:/);
        expect(src).toMatch(/editGrid\(\{ hugWidth:/);
        expect(src).toMatch(/colSpan: Math\.max\(1/);            // the child half
        expect(src).toMatch(/formatTrackList\(node\.layout\.grid\.columns\)/);
    });
});


// ─── Variants (schema 27): one instance, many masters, switched by named properties ───
describe("Variants: a set is just the masters that name it", () => {
    /** A "Button" set with four members: size × state. Each master is an ordinary node. */
    function buttonSet(): ProjectDocument {
        const doc = createEmptyDocument();
        const mk = (id: string, size: string, state: string, w: number) =>
            doc.nodes.set(id, {
                id, type: "core.rectangle", parent: null, children: [],
                geometry: { x: 0, y: 0, width: w, height: 20 },
                style: { fill: state === "hover" ? "#00ff00" : "#0000ff", opacity: 1 }, layout: {},
                variant: { set: "Button", values: { size, state } }
            });
        mk("b-sm-def", "small", "default", 40);
        mk("b-sm-hov", "small", "hover", 40);
        mk("b-lg-def", "large", "default", 90);
        mk("b-lg-hov", "large", "hover", 90);
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 300, y: 300, width: 40, height: 20 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "b-sm-def" });
        doc.rootNodeUuids = ["b-sm-def", "b-sm-hov", "b-lg-def", "b-lg-hov", "I"];
        return doc;
    }

    test("switching ONE property picks the master carrying that combination", () => {
        const dispatcher = new ActionDispatcher(buttonSet());
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", "large"));
        const d = dispatcher.getDocument();
        // size=large, state=default (inherited from the pointed-at master) → b-lg-def.
        expect(resolveVariantMaster(d, d.nodes.get("I")!)).toBe("b-lg-def");
        // …and the SELECTION is sparse: only what was changed is stored.
        expect(d.nodes.get("I")!.variants).toEqual({ size: "large" });
    });

    test("selections MERGE — choosing a second property does not forget the first", () => {
        const dispatcher = new ActionDispatcher(buttonSet());
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", "large"));
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "state", "hover"));
        const d = dispatcher.getDocument();
        expect(resolveVariantMaster(d, d.nodes.get("I")!)).toBe("b-lg-hov");
        // Clearing one property falls back to the master's own value, and an EMPTY selection
        // is absent rather than `{}` — two equal documents must compare equal.
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", null));
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "state", null));
        expect(dispatcher.getDocument().nodes.get("I")!.variants).toBeUndefined();
    });

    test("the SWITCH actually redraws — the expansion copies the new master's subtree", () => {
        const dispatcher = new ActionDispatcher(buttonSet());
        const widthOf = (d: ReadonlyDocument) => {
            const x = expandInstances(d);
            const copyId = [...x.nodes.keys()].find(id => id.startsWith("I::"))!;
            return x.nodes.get(copyId)!.geometry.width;
        };
        expect(widthOf(dispatcher.getDocument())).toBe(40);          // small
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", "large"));
        expect(widthOf(dispatcher.getDocument())).toBe(90);          // large — a different master
    });

    test("resolution is TOTAL: every failure draws what you pointed at", () => {
        const doc = buttonSet();
        // A property the set never defines.
        expect(resolveVariantMaster(doc, { componentId: "b-sm-def", variants: { flavour: "salty" } })).toBe("b-sm-def");
        // A value no member carries.
        expect(resolveVariantMaster(doc, { componentId: "b-sm-def", variants: { size: "enormous" } })).toBe("b-sm-def");
        // A master that is not in any set at all.
        doc.nodes.set("plain", { id: "plain", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 5, height: 5 }, style: { fill: "#fff", opacity: 1 }, layout: {} });
        expect(resolveVariantMaster(doc, { componentId: "plain", variants: { size: "large" } })).toBe("plain");
        // A dangling componentId, and none at all.
        expect(resolveVariantMaster(doc, { componentId: "ghost" })).toBe("ghost");
        expect(resolveVariantMaster(doc, {})).toBeNull();
    });

    test("a match must agree on the property COUNT, not just on the properties asked for", () => {
        // Sorted-id order puts the fuller members FIRST here, so without the count check the
        // four-property members would satisfy a one-property request by accident and the
        // half-tagged master that actually matches would never be reached.
        const doc = buttonSet();
        doc.nodes.set("z-partial", { id: "z-partial", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 7, height: 7 }, style: { fill: "#fff", opacity: 1 }, layout: {}, variant: { set: "Button", values: { size: "small" } } });
        // `z-partial` defines only `size`, so asking it for size=small is asking for ITSELF —
        // not for `b-sm-def`, which also pins a `state` nobody mentioned.
        expect(resolveVariantMaster(doc, { componentId: "z-partial", variants: { size: "small" } })).toBe("z-partial");
    });

    test("member order is DETERMINISTIC, independent of insertion order", () => {
        // Map iteration is insertion order, which does not survive a save and reload — so the
        // scan sorts, and two documents with the same nodes resolve the same way.
        const a = buttonSet();
        const b = createEmptyDocument();
        for (const id of ["b-lg-hov", "b-lg-def", "b-sm-hov", "b-sm-def"]) b.nodes.set(id, a.nodes.get(id)!);
        expect(variantMembers(b, "Button")).toEqual(variantMembers(a, "Button"));
        expect(variantMembers(a, "Button")).toEqual(["b-lg-def", "b-lg-hov", "b-sm-def", "b-sm-hov"]);
    });

    test("variantProperties is what a picker offers — sorted names, sorted values", () => {
        const doc = buttonSet();
        expect(variantProperties(doc, "Button")).toEqual({ size: ["large", "small"], state: ["default", "hover"] });
        expect(variantProperties(doc, "NoSuchSet")).toEqual({});
    });

    test("both variant maps are validated on the SAME rules the loader runs", () => {
        expect(variantError({ set: "", values: {} })).not.toBeNull();
        expect(variantError({ set: "S" })).not.toBeNull();                        // values required
        expect(variantError({ set: "S", values: { size: "" } })).not.toBeNull();  // empty value
        // Built the way the LOAD path builds it. In an object literal `__proto__:` sets the
        // prototype and creates no own property at all, so a literal cannot even express this
        // hazard — `JSON.parse` can, and that is precisely where a hand-edited file comes from.
        expect(variantError(JSON.parse('{"set":"S","values":{"__proto__":"x"}}'))).not.toBeNull();
        expect(variantSelectionError("core.instance", JSON.parse('{"__proto__":"x"}'))).not.toBeNull();
        expect(variantError({ set: "S", values: {} })).toBeNull();                // a set of one is fine
        expect(variantSelectionError("core.rectangle", { size: "large" })).not.toBeNull(); // instances only
        expect(variantSelectionError("core.instance", { size: "large" })).toBeNull();

        // …and the ACTIONS run those rules, rather than merely sharing a file with them. A test
        // that only calls the validator proves nothing about the write path that must call it.
        const dispatcher = new ActionDispatcher(buttonSet());
        expect(dispatcher.dispatchAction(new SetVariantAction(dispatcher.getDocument(), "I", { set: "", values: {} } as never)).success).toBe(false);
        expect(dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", "")).success).toBe(false);
        expect(dispatcher.getDocument().nodes.get("I")!.variants).toBeUndefined();   // nothing was written
        expect(dispatcher.dispatchAction(new SetVariantAction(dispatcher.getDocument(), "I", { set: "Other", values: { x: "y" } })).success).toBe(true);
    });

    test("a document with variants round-trips, and an untagged node stays untagged", () => {
        const dispatcher = new ActionDispatcher(buttonSet());
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "state", "hover"));
        const d = dispatcher.getDocument();
        const loaded = deserializeDocument(serializeDocument(d));
        expect(loaded.nodes.get("b-sm-def")!.variant).toEqual({ set: "Button", values: { size: "small", state: "default" } });
        expect(loaded.nodes.get("I")!.variants).toEqual({ state: "hover" });
        expect(compareDocuments(d, loaded)).toBe(true);
    });

    test("untagging a master through the action REMOVES the field, not just its contents", () => {
        // The delta is read with `in` rather than `!== undefined`, because clearing is a real edit.
        const dispatcher = new ActionDispatcher(buttonSet());
        dispatcher.dispatchAction(new SetVariantAction(dispatcher.getDocument(), "b-sm-def", null));
        const d = dispatcher.getDocument();
        expect(d.nodes.get("b-sm-def")!.variant).toBeUndefined();
        expect(variantMembers(d, "Button")).toEqual(["b-lg-def", "b-lg-hov", "b-sm-hov"]);
        expect(() => deserializeDocument(serializeDocument(d))).not.toThrow();
    });

    test("DETACH bakes the SWITCHED variant, not the one componentId names", () => {
        const dispatcher = new ActionDispatcher(buttonSet());
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", "large"));
        const detach = new DetachInstanceAction(dispatcher.getDocument(), "I");
        expect(dispatcher.dispatchAction(detach).success).toBe(true);
        const root = dispatcher.getDocument().nodes.get(detach.getCreatedNodeIds()[0])!;
        expect(root.geometry.width).toBe(90);   // the LARGE master — what was on screen
    });

    test("switching RESIZES the instance to the new variant — unless it was resized on purpose", () => {
        // The limitation the first variants commit shipped: the box stayed 40 wide while the
        // content drew 90, so the selection rectangle stopped matching what was on screen.
        const dispatcher = new ActionDispatcher(buttonSet());
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", "large"));
        expect(dispatcher.getDocument().nodes.get("I")!.geometry.width).toBe(90);

        // …but a DELIBERATE resize is a decision, and switching a different property is not a
        // request to discard it.
        const d2 = new ActionDispatcher(buttonSet());
        d2.dispatchAction(new UpdateNodeGeometryAction(d2.getDocument(), "I", { width: 55 }));
        d2.dispatchAction(new SetInstanceVariantAction(d2.getDocument(), "I", "size", "large"));
        expect(d2.getDocument().nodes.get("I")!.geometry.width).toBe(55);   // left alone
    });

    test("overrides SURVIVE a switch, carried to the matching node of the new variant", () => {
        // Keyed by master node id, and every variant is a different node — so without a remap
        // every edit made to the copy vanished the moment someone switched.
        const doc = buttonSet();
        // Give both variants a named child, so there is something to match ACROSS the switch.
        for (const [master, child] of [["b-sm-def", "sm-label"], ["b-lg-def", "lg-label"]]) {
            doc.nodes.set(child, { id: child, type: "core.text", parent: master, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000000", opacity: 1 }, layout: {}, name: "Label", text: "hi" });
            doc.nodes.get(master)!.children = [child];
        }
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "I", "sm-label", { text: "Buy now" }));
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", "large"));

        const after = dispatcher.getDocument().nodes.get("I")!.overrides!;
        expect(after["lg-label"]).toEqual({ text: "Buy now" });   // moved to the new variant's node
        expect(after["sm-label"]).toBeUndefined();
        // …and it is really on screen, not just in the map.
        const x = expandInstances(dispatcher.getDocument());
        expect(x.nodes.get("I::lg-label")!.text).toBe("Buy now");
    });

    test("an override on the master ROOT follows the root, which has no name to match on", () => {
        const dispatcher = new ActionDispatcher(buttonSet());
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "I", "b-sm-def", { style: { fill: "#abcdef" } }));
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", "large"));
        expect(dispatcher.getDocument().nodes.get("I")!.overrides!["b-lg-def"]).toEqual({ style: { fill: "#abcdef" } });
    });

    test("an AMBIGUOUS name is not guessed at — the entry stays put and stays inert", () => {
        // Moving someone's edit onto the wrong element is worse than not moving it. An unmatched
        // entry is kept rather than dropped, so switching BACK restores it.
        const doc = buttonSet();
        for (const [master, kids] of [["b-sm-def", ["s1", "s2"]], ["b-lg-def", ["l1", "l2"]]]) {
            for (const k of kids as string[]) {
                doc.nodes.set(k, { id: k, type: "core.text", parent: master as string, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000000", opacity: 1 }, layout: {}, name: "Row" });
            }
            doc.nodes.get(master as string)!.children = kids as string[];
        }
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "I", "s1", { text: "kept" }));
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", "large"));
        const after = dispatcher.getDocument().nodes.get("I")!.overrides!;
        expect(after["s1"]).toEqual({ text: "kept" });      // untouched, not guessed
        expect(after["l1"]).toBeUndefined();
        expect(after["l2"]).toBeUndefined();

        // Switching BACK makes it live again — a round trip loses nothing.
        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), "I", "size", "small"));
        expect(expandInstances(dispatcher.getDocument()).nodes.get("I::s1")!.text).toBe("kept");
    });

    test("the shared subtree walk TERMINATES on a damaged, cyclic document", () => {
        // A parent/child cycle is not reachable through the actions, but it IS reachable by
        // hand-editing a file, and this walk runs on the load-adjacent paths (detach, override
        // remap). Without the visited set it recurses until the stack gives out, which is a
        // crash rather than a refusal — so the guard is load-bearing and now has a test.
        const doc = createEmptyDocument();
        const mk = (id: string, kids: string[], parent: string | null) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent, children: kids, geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        mk("A", ["B"], null);
        mk("B", ["A"], "A");          // …and back to A
        doc.rootNodeUuids = ["A"];
        expect(masterSubtreeIds(doc, "A")).toEqual(["A", "B"]);   // each node ONCE, and it returns
        expect(masterSubtreeIds(doc, "nope")).toEqual([]);
    });

    test("the UI can TAG a master and SWITCH an instance — either alone is useless", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/<VariantSection/);
        expect(src).toMatch(/new SetVariantAction\(/);            // tag
        expect(src).toMatch(/new SetInstanceVariantAction\(/);    // switch
        expect(src).toMatch(/variantProperties\(doc, masterSet\)/); // …offering what the set defines
        expect(src).toMatch(/variantError\(candidate\)/);          // the shared validator is the authority
    });
});


// ─── Overriding THROUGH a nested instance (schema 28): the last "cannot edit this at all" hole ───
describe("Nested overrides: reaching inside an instance inside an instance", () => {
    /** A Card master containing a Button INSTANCE, and two Cards on the canvas. */
    function cardDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        // The inner component: a button whose label is a text node.
        doc.nodes.set("BM", { id: "BM", type: "core.rectangle", parent: null, children: ["BL"], geometry: { x: 0, y: 0, width: 60, height: 20 }, style: { fill: "#3366ff", opacity: 1 }, layout: {} });
        doc.nodes.set("BL", { id: "BL", type: "core.text", parent: "BM", children: [], geometry: { x: 0, y: 0, width: 60, height: 20 }, style: { fill: "#ffffff", opacity: 1 }, layout: {}, text: "Click" });
        // The outer component: a card containing an INSTANCE of the button.
        doc.nodes.set("CM", { id: "CM", type: "core.rectangle", parent: null, children: ["CB"], geometry: { x: 0, y: 0, width: 200, height: 80 }, style: { fill: "#eeeeee", opacity: 1 }, layout: {} });
        doc.nodes.set("CB", { id: "CB", type: "core.instance", parent: "CM", children: [], geometry: { x: 10, y: 10, width: 60, height: 20 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "BM" });
        // Two cards.
        doc.nodes.set("C1", { id: "C1", type: "core.instance", parent: null, children: [], geometry: { x: 0, y: 0, width: 200, height: 80 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "CM" });
        doc.nodes.set("C2", { id: "C2", type: "core.instance", parent: null, children: [], geometry: { x: 0, y: 200, width: 200, height: 80 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "CM" });
        doc.rootNodeUuids = ["BM", "CM", "C1", "C2"];
        return doc;
    }
    const textAt = (doc: ReadonlyDocument, id: string) => expandInstances(doc).nodes.get(id)?.text;

    test("ONE card can rename the button inside it, and no other card changes", () => {
        // This is the whole point: `C1::CB::BL` is a copy two instances deep. Before schema 28
        // it could not be edited at all — the routing seam refused it, so the inspector offered
        // nothing and the handles were withheld.
        const dispatcher = new ActionDispatcher(cardDoc());
        const action = contentActionFor(dispatcher.getDocument(), "C1::CB::BL", { text: "Buy now" })!;
        expect(action).toBeInstanceOf(SetInstanceOverrideAction);
        dispatcher.dispatchAction(action);
        const d = dispatcher.getDocument();

        expect(textAt(d, "C1::CB::BL")).toBe("Buy now");
        expect(textAt(d, "C2::CB::BL")).toBe("Click");     // the OTHER card is untouched
        expect(d.nodes.get("BL")!.text).toBe("Click");     // …as is the master
        // The override lives on the STORED instance, under the path from it to the copy.
        expect(Object.keys(d.nodes.get("C1")!.overrides!)).toEqual(["CB::BL"]);
    });

    test("the OUTER instance's override wins over one the master's nested instance carries", () => {
        // The card's own Button instance sets a default label; this card overrides it. The outer
        // statement is the more specific one — it is about THIS card, not about every card.
        const doc = cardDoc();
        doc.nodes.get("CB")!.overrides = { BL: { text: "Default", style: { opacity: 0.5 } } };
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "C1", "CB::BL", { text: "Specific" }));
        const d = dispatcher.getDocument();

        expect(textAt(d, "C1::CB::BL")).toBe("Specific");
        expect(textAt(d, "C2::CB::BL")).toBe("Default");   // the master's own default still applies
        // The two MERGE rather than replace: the opacity the master set survives the text override.
        expect(expandInstances(d).nodes.get("C1::CB::BL")!.style.opacity).toBe(0.5);
    });

    test("a path key resolves to the right master node — or to nothing, which is inert", () => {
        const doc = cardDoc();
        const c1 = doc.nodes.get("C1")!;
        expect(resolveOverridePath(doc, c1, "CB::BL")!.id).toBe("BL");
        expect(resolveOverridePath(doc, c1, "CB")!.id).toBe("CB");
        // A segment that names nothing in the scope, and a path that walks THROUGH a non-instance.
        expect(resolveOverridePath(doc, c1, "CB::nope")).toBeNull();
        expect(resolveOverridePath(doc, c1, "nope::BL")).toBeNull();
        // `CM` resolves (it is the root of its own subtree) but is not an INSTANCE, so the walk
        // cannot descend into it and the next segment has no scope to be looked up in.
        expect(resolveOverridePath(doc, c1, "CM::CB")).toBeNull();
        expect(resolveOverridePath(doc, c1, "CB::BL::deeper")).toBeNull(); // BL is not an instance either
        // The case that needs the SCOPE check rather than a mere existence check: `BL` is a real
        // node, but it belongs to the button's master, not to anything this card draws directly.
        // Resolving it would let a key reach a node the instance does not contain — and then a
        // type-aware check would run against the wrong master.
        expect(resolveOverridePath(doc, c1, "BL")).toBeNull();
        expect(resolveOverridePath(doc, c1, "CB::CM")).toBeNull();
    });

    test("type-aware validation follows the path — a src override still needs an image", () => {
        // `overrideAgainstMasterError` resolves each key's master; with paths it must walk, or a
        // nested key would skip the check entirely and bake an illegal node on detach.
        const doc = cardDoc();
        doc.nodes.get("C1")!.overrides = { "CB::BL": { src: "https://example.com/a.png" } };
        expect(overrideAgainstMasterError(doc, doc.nodes.get("C1")!)).toMatch("only a core.image");
        // …and a size that the nested master's own type forbids.
        doc.nodes.get("C1")!.overrides = { "CB::BL": { geometry: { width: 0, height: 0 } } };
        expect(overrideAgainstMasterError(doc, doc.nodes.get("C1")!)).not.toBeNull();
    });

    test("a nested override round-trips, and its key survives as a path", () => {
        const dispatcher = new ActionDispatcher(cardDoc());
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "C1", "CB::BL", { text: "Buy now" }));
        const d = dispatcher.getDocument();
        const loaded = deserializeDocument(serializeDocument(d));
        expect(loaded.nodes.get("C1")!.overrides).toEqual({ "CB::BL": { text: "Buy now" } });
        expect(compareDocuments(d, loaded)).toBe(true);
    });

    test("DETACH pushes a path override down onto the nested instance it reached through", () => {
        // Detaching the card leaves the Button as an instance node, so `CB::BL` on the card must
        // become `BL` on that copy — otherwise the label silently reverts the moment you detach.
        const dispatcher = new ActionDispatcher(cardDoc());
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "C1", "CB::BL", { text: "Buy now" }));
        const detach = new DetachInstanceAction(dispatcher.getDocument(), "C1");
        expect(dispatcher.dispatchAction(detach).success).toBe(true);
        const d = dispatcher.getDocument();

        const bakedButton = detach.getCreatedNodeIds().map(id => d.nodes.get(id)!).find(n => n.type === "core.instance")!;
        expect(bakedButton.overrides).toEqual({ BL: { text: "Buy now" } });
        // …and it still draws that way.
        const copyId = [...expandInstances(d).nodes.keys()].find(id => id.startsWith(bakedButton.id + "::") && id.endsWith("::BL"))!;
        expect(expandInstances(d).nodes.get(copyId)!.text).toBe("Buy now");
    });

    test("the shared override merge keeps LAYOUT and TRANSFORM, which its old copy dropped", () => {
        // SetInstanceOverrideAction had its own merge that only knew geometry and style, so a
        // layout override followed by a style edit silently lost the layout (schema 26 added the
        // fields and the merge was never told).
        const dispatcher = new ActionDispatcher(cardDoc());
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "C1", "CB", { layout: { grow: 2 }, transform: { rotation: 0.5 } }));
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "C1", "CB", { style: { opacity: 0.25 } }));
        const o = dispatcher.getDocument().nodes.get("C1")!.overrides!["CB"];
        expect(o.layout).toEqual({ grow: 2 });
        expect(o.transform).toEqual({ rotation: 0.5 });
        expect(o.style).toEqual({ opacity: 0.25 });
    });
});


// ─── Instance-content overflow picking: a copy drawn outside its instance's box ───
describe("Picking instance content that overflows the instance box", () => {
    /** The instance's own box is 20×20; the master it draws is 100×100, so the copy spills. */
    function overflowDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 300, y: 300, width: 20, height: 20 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I"];
        return doc;
    }

    test("a click on the OVERFLOWING part selects the instance — it used to hit nothing", () => {
        // The copy covers (300,300)-(400,400); the instance's own box only (300,300)-(320,320).
        // Skipping virtual ids meant every pixel past 320 was visible but dead.
        const cs = computeGeometry(overflowDoc());
        expect(hitTest(cs, 310, 310)).toBe("I");    // inside the instance's own box (always worked)
        expect(hitTest(cs, 380, 380)).toBe("I");    // …and out in the overflow
        expect(hitTest(cs, 500, 500)).toBeNull();   // genuinely empty space is still empty
    });

    test("the deep pick still reaches the COPY itself, overflow included", () => {
        const cs = computeGeometry(overflowDoc());
        expect(hitTest(cs, 380, 380, 0, true)).toBe("I::M");
    });

    test("a marquee touching only the overflow grabs the INSTANCE, once", () => {
        const cs = computeGeometry(overflowDoc());
        // A rect entirely past the instance's own 20×20 box, over the copy.
        expect(nodesInRect(cs, { x: 350, y: 350, width: 20, height: 20 })).toEqual(["I"]);
        // Overlapping both the box and the copy still yields ONE entry, not two.
        expect(nodesInRect(cs, { x: 290, y: 290, width: 200, height: 200 })).toEqual(["I"]);
    });

    test("resolving a copy to its owner never reorders the result", () => {
        // `order` stays the authority: a marquee over both returns them back-to-front.
        const doc = overflowDoc();
        doc.nodes.set("Z", { id: "Z", type: "core.rectangle", parent: null, children: [], geometry: { x: 300, y: 300, width: 400, height: 400 }, style: { fill: "#00f", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["M", "I", "Z"];
        const cs = computeGeometry(doc);
        expect(nodesInRect(cs, { x: 350, y: 350, width: 20, height: 20 })).toEqual(["I", "Z"]);
        // …and the topmost node still wins a click, even over an instance's overflow.
        expect(hitTest(cs, 380, 380)).toBe("Z");
    });

    test("a copy whose owning instance has vanished is not selectable", () => {
        // Defensive: `ownerInstanceOf` names a stored id, but a damaged state could hold a
        // virtual node whose owner is gone. Returning it would hand the editor an id that
        // isn't in the document — the exact failure the routing seam exists to prevent.
        const cs = computeGeometry(overflowDoc());
        const damaged: typeof cs = { order: cs.order, nodes: new Map(cs.nodes), locked: new Set<string>() };
        damaged.nodes.delete("I");
        expect(hitTest(damaged, 380, 380)).toBeNull();
        expect(nodesInRect(damaged, { x: 350, y: 350, width: 20, height: 20 })).toEqual([]);
    });
});


// ─── Slots (schema 29): a named hole a master leaves for its instances to fill ───
describe("Slots: content an instance supplies", () => {
    /** A Card master with a slot named "body", whose default child says "empty". */
    function slotDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("CM", { id: "CM", type: "core.rectangle", parent: null, children: ["SLOT"], geometry: { x: 0, y: 0, width: 200, height: 100 }, style: { fill: "#eeeeee", opacity: 1 }, layout: {} });
        doc.nodes.set("SLOT", { id: "SLOT", type: "core.rectangle", parent: "CM", children: ["DEF"], geometry: { x: 10, y: 10, width: 180, height: 80 }, style: { fill: "#dddddd", opacity: 1 }, layout: {}, slot: "body" });
        doc.nodes.set("DEF", { id: "DEF", type: "core.text", parent: "SLOT", children: [], geometry: { x: 0, y: 0, width: 50, height: 20 }, style: { fill: "#999999", opacity: 1 }, layout: {}, text: "empty" });
        // Two things that could go IN the slot.
        doc.nodes.set("PHOTO", { id: "PHOTO", type: "core.rectangle", parent: null, children: [], geometry: { x: 500, y: 500, width: 40, height: 40 }, style: { fill: "#ff0000", opacity: 1 }, layout: {} });
        doc.nodes.set("CHART", { id: "CHART", type: "core.rectangle", parent: null, children: [], geometry: { x: 600, y: 500, width: 70, height: 30 }, style: { fill: "#0000ff", opacity: 1 }, layout: {} });
        doc.nodes.set("C1", { id: "C1", type: "core.instance", parent: null, children: [], geometry: { x: 0, y: 0, width: 200, height: 100 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "CM" });
        doc.nodes.set("C2", { id: "C2", type: "core.instance", parent: null, children: [], geometry: { x: 0, y: 300, width: 200, height: 100 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "CM" });
        doc.rootNodeUuids = ["CM", "PHOTO", "CHART", "C1", "C2"];
        return doc;
    }
    /** What the slot copy actually holds — its children in the expanded document. Note the
     *  ids: ordinary descendants keep the instance's path (`C1::DEF`), while a FILL opens a
     *  new one (`C1::SLOT::PHOTO`), exactly as a nested instance does. */
    const slotChildren = (doc: ReadonlyDocument, slotCopyId: string) =>
        [...(expandInstances(doc).nodes.get(slotCopyId)?.children ?? [])].sort();

    test("an UNFILLED slot draws its own default children", () => {
        const x = expandInstances(slotDoc());
        expect(x.nodes.get("C1::SLOT")!.children).toEqual(["C1::DEF"]);
        expect(x.nodes.get("C1::DEF")!.text).toBe("empty");
    });

    test("a FILLED slot draws the supplied node instead — and only for that instance", () => {
        const dispatcher = new ActionDispatcher(slotDoc());
        dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), "C1", "body", "PHOTO"));
        const d = dispatcher.getDocument();

        // C1 draws the photo IN the slot; its default child is gone.
        expect(slotChildren(d, "C1::SLOT")).toEqual(["C1::SLOT::PHOTO"]);
        // C2 is untouched, and the PHOTO still lives where it always did.
        expect(slotChildren(d, "C2::SLOT")).toEqual(["C2::DEF"]);
        expect(d.nodes.get("PHOTO")!.parent).toBeNull();
    });

    test("the SLOT places the fill — content is re-origined into it, not left where it lives", () => {
        // PHOTO sits at (500,500) in the document; inside the slot it must sit at the slot's
        // origin, exactly as a master root does inside its instance.
        const dispatcher = new ActionDispatcher(slotDoc());
        dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), "C1", "body", "PHOTO"));
        const computed = computeGeometry(dispatcher.getDocument() as ProjectDocument);
        // C1 at (0,0) → slot at (10,10) → the fill at the slot's origin.
        expect(computed.nodes.get("C1::SLOT::PHOTO")!.bounds).toMatchObject({ x: 10, y: 10, width: 40, height: 40 });
    });

    test("two instances can hold DIFFERENT content in the same slot", () => {
        const dispatcher = new ActionDispatcher(slotDoc());
        dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), "C1", "body", "PHOTO"));
        dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), "C2", "body", "CHART"));
        const d = dispatcher.getDocument();
        expect(slotChildren(d, "C1::SLOT")).toEqual(["C1::SLOT::PHOTO"]);
        expect(slotChildren(d, "C2::SLOT")).toEqual(["C2::SLOT::CHART"]);
    });

    test("a fill that names nothing falls back to the default — inert, not broken", () => {
        const doc = slotDoc();
        doc.nodes.get("C1")!.slotContent = { body: "ghost", nosuchslot: "PHOTO" };
        const x = expandInstances(doc);
        expect(x.nodes.get("C1::SLOT")!.children).toEqual(["C1::DEF"]);
        expect(() => deserializeDocument(serializeDocument(doc))).not.toThrow();
    });

    test("filling a slot with content that contains the card cannot expand forever", () => {
        // PHOTO becomes a parent of an instance of the very card being filled. The chain guard
        // has to stop it — and stop it by drawing nothing, never by throwing mid-render.
        const doc = slotDoc();
        doc.nodes.set("INNER", { id: "INNER", type: "core.instance", parent: "PHOTO", children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "CM" });
        doc.nodes.get("PHOTO")!.children = ["INNER"];
        doc.nodes.get("C1")!.slotContent = { body: "PHOTO" };
        expect(() => expandInstances(doc)).not.toThrow();
        const x = expandInstances(doc);
        expect(x.nodes.size).toBeLessThan(INSTANCE_MAX_NODES);
    });

    test("slot fills MERGE, and an emptied map is stored ABSENT", () => {
        const doc = slotDoc();
        doc.nodes.get("CM")!.children = ["SLOT", "SLOT2"];
        doc.nodes.set("SLOT2", { id: "SLOT2", type: "core.rectangle", parent: "CM", children: [], geometry: { x: 10, y: 60, width: 50, height: 20 }, style: { fill: "#cccccc", opacity: 1 }, layout: {}, slot: "footer" });
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), "C1", "body", "PHOTO"));
        dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), "C1", "footer", "CHART"));
        expect(dispatcher.getDocument().nodes.get("C1")!.slotContent).toEqual({ body: "PHOTO", footer: "CHART" });
        dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), "C1", "body", null));
        dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), "C1", "footer", null));
        expect(dispatcher.getDocument().nodes.get("C1")!.slotContent).toBeUndefined();
    });

    test("an instance may not fill a slot with ITSELF", () => {
        // The one fill that can never draw: expansion would re-enter the instance, the chain
        // guard would stop it, and the slot would sit empty with no explanation.
        const dispatcher = new ActionDispatcher(slotDoc());
        expect(dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), "C1", "body", "C1")).success).toBe(false);
        expect(dispatcher.getDocument().nodes.get("C1")!.slotContent).toBeUndefined();
    });

    test("both slot fields go through the SAME validators the loader runs", () => {
        expect(slotError("")).not.toBeNull();
        expect(slotError("body")).toBeNull();
        expect(slotContentError("core.rectangle", { body: "PHOTO" })).not.toBeNull();  // instances only
        expect(slotContentError("core.instance", { "": "PHOTO" })).not.toBeNull();
        expect(slotContentError("core.instance", { body: "" })).not.toBeNull();
        expect(slotContentError("core.instance", JSON.parse('{"__proto__":"PHOTO"}'))).not.toBeNull();
        expect(slotContentError("core.instance", { body: "PHOTO" })).toBeNull();
        // …and the ACTIONS run them, rather than merely sharing a file with them.
        const dispatcher = new ActionDispatcher(slotDoc());
        expect(dispatcher.dispatchAction(new SetSlotAction(dispatcher.getDocument(), "SLOT", "")).success).toBe(false);
        expect(dispatcher.getDocument().nodes.get("SLOT")!.slot).toBe("body");
    });

    test("a slot document round-trips, and un-slotting REMOVES the field", () => {
        const dispatcher = new ActionDispatcher(slotDoc());
        dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), "C1", "body", "PHOTO"));
        const d = dispatcher.getDocument();
        const loaded = deserializeDocument(serializeDocument(d));
        expect(loaded.nodes.get("SLOT")!.slot).toBe("body");
        expect(loaded.nodes.get("C1")!.slotContent).toEqual({ body: "PHOTO" });
        expect(compareDocuments(d, loaded)).toBe(true);

        dispatcher.dispatchAction(new SetSlotAction(dispatcher.getDocument(), "SLOT", null));
        expect(dispatcher.getDocument().nodes.get("SLOT")!.slot).toBeUndefined();
    });

    test("an OUTER instance can fill a slot inside a NESTED one, via a slotContent override", () => {
        // The card is itself instanced inside a Page. The page's instance overrides the nested
        // card instance's slotContent — the same path-keyed machinery nested overrides use, so
        // slots needed no second addressing scheme.
        const doc = slotDoc();
        doc.nodes.set("PM", { id: "PM", type: "core.rectangle", parent: null, children: ["PC"], geometry: { x: 0, y: 0, width: 400, height: 300 }, style: { fill: "#ffffff", opacity: 1 }, layout: {} });
        doc.nodes.set("PC", { id: "PC", type: "core.instance", parent: "PM", children: [], geometry: { x: 20, y: 20, width: 200, height: 100 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "CM" });
        doc.nodes.set("P1", { id: "P1", type: "core.instance", parent: null, children: [], geometry: { x: 0, y: 700, width: 400, height: 300 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "PM" });
        doc.rootNodeUuids = [...doc.rootNodeUuids, "PM", "P1"];

        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "P1", "PC", { slotContent: { body: "CHART" } }));
        expect(slotChildren(dispatcher.getDocument(), "P1::PC::SLOT")).toEqual(["P1::PC::SLOT::CHART"]);
    });

    test("a slot fill that reaches ITSELF again is stopped by the chain, not by luck", () => {
        // The construction that actually needs `chain.add(filledId)`: the slot node is itself an
        // INSTANCE carrying slot content, so content materialized inside it looks up fills on
        // that copy — and if those fills name a node already being filled, the walk re-enters.
        // The master chain cannot catch this: no master repeats, only the FILL does.
        const doc = createEmptyDocument();
        const mk = (id: string, extra: Record<string, unknown> = {}, kids: string[] = [], parent: string | null = null) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent, children: kids, geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {}, ...extra } as never);
        mk("IM");                                                        // a tiny master for the slot instance
        mk("CM", {}, ["S"]);                                             // the card
        // The slot node IS an instance, and it carries slot content naming X.
        doc.nodes.set("S", { id: "S", type: "core.instance", parent: "CM", children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, slot: "body", componentId: "IM", slotContent: { body: "X" } });
        mk("X", {}, ["Y"]);
        // Y must carry slot content TOO, or the walk runs out of fills after one level:
        // each level looks up its fill on the copy that opened the path, so a level whose
        // opener has no slotContent simply stops. With both S and Y carrying it, every
        // level names X again and only the chain can end it.
        doc.nodes.set("Y", { id: "Y", type: "core.instance", parent: "X", children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, slot: "body", slotContent: { body: "X" } });
        doc.nodes.set("C1", { id: "C1", type: "core.instance", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "CM", slotContent: { body: "X" } });
        doc.rootNodeUuids = ["IM", "CM", "X", "C1"];

        expect(() => expandInstances(doc)).not.toThrow();
        // Bounded, and nowhere near the OOM cap — the chain stops it immediately, rather than
        // the node cap stopping it after fifty thousand copies.
        expect(expandInstances(doc).nodes.size).toBeLessThan(50);
    });

    test("a slotContent override MERGES with what is already there", () => {
        // The shared merge has to know the field, or setting slot content after any other
        // override silently replaces the fills instead of adding to them — the schema-26
        // layout/transform bug, one field later.
        const dispatcher = new ActionDispatcher(slotDoc());
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "C1", "SLOT", { slotContent: { body: "PHOTO" } }));
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "C1", "SLOT", { slotContent: { footer: "CHART" } }));
        expect(dispatcher.getDocument().nodes.get("C1")!.overrides!["SLOT"].slotContent)
            .toEqual({ body: "PHOTO", footer: "CHART" });
    });

    test("the UI can NAME a slot and FILL one — either alone is useless", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/<SlotSection/);
        expect(src).toMatch(/e\.target\.checked \? "content" : null/);  // become a slot
        expect(src).toMatch(/new SetSlotAction\(dispatcher\.getDocument\(\), node\.id, v\)/); // …and rename it
        expect(src).toMatch(/new SetSlotContentAction\(/);   // fill
        expect(src).toMatch(/masterSubtreeIds\(doc, masterId\)/);  // …offering the slots the master defines
        expect(src).toMatch(/slotError\(v\) !== null/);      // the shared validator is the authority
    });
});


// ─── Dirty-tracking reuse for INSTANCED documents (the last M6 deferral) ───
describe("GeometryEngine dirty tracking with instances", () => {
    type CS = ReturnType<typeof computeGeometry>;
    const same = (a: CS, b: CS): true | string => {
        if (a.order.join("|") !== b.order.join("|")) return `order: ${a.order} vs ${b.order}`;
        if (a.nodes.size !== b.nodes.size) return `size ${a.nodes.size} vs ${b.nodes.size}`;
        for (const [id, an] of a.nodes) {
            const bn = b.nodes.get(id);
            if (!bn) return `missing ${id}`;
            for (const k of ["a", "b", "c", "d", "e", "f"] as const) {
                if (Math.abs(an.world[k] - bn.world[k]) > 1e-9) return `${id}.world.${k}`;
            }
            for (const k of ["x", "y", "width", "height"] as const) {
                if (Math.abs(an.bounds[k] - bn.bounds[k]) > 1e-9) return `${id}.bounds.${k}`;
            }
        }
        return true;
    };

    /** A master with a child, a nested instance inside it, and two outer instances. */
    function instancedDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("IM", { id: "IM", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 20, height: 20 }, style: { fill: "#00ff00", opacity: 1 }, layout: {} });
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: ["MC", "OI"], geometry: { x: 5, y: 5, width: 100, height: 60 }, style: { fill: "#ff0000", opacity: 1 }, layout: {} });
        doc.nodes.set("MC", { id: "MC", type: "core.rectangle", parent: "M", children: [], geometry: { x: 4, y: 4, width: 30, height: 30 }, style: { fill: "#0000ff", opacity: 1 }, layout: {} });
        doc.nodes.set("OI", { id: "OI", type: "core.instance", parent: "M", children: [], geometry: { x: 40, y: 8, width: 20, height: 20 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "IM" });
        doc.nodes.set("I1", { id: "I1", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 200, width: 100, height: 60 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.nodes.set("I2", { id: "I2", type: "core.instance", parent: null, children: [], geometry: { x: 400, y: 200, width: 100, height: 60 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["IM", "M", "I1", "I2"];
        return doc;
    }

    test("editing a MASTER node updates every copy — reuse no longer renders a stale one", () => {
        // The deferral this closes: the dirty set names `MC`, but the nodes that MOVE are
        // `I1::MC` and `I2::MC`, which no action will ever mention.
        const dispatcher = new ActionDispatcher(instancedDoc());
        const base = computeGeometry(dispatcher.getDocument());
        dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), "MC", { x: 44 }));
        const live = dispatcher.getDocument();

        const incremental = computeGeometry(live, null, base, new Set(["MC"]));
        expect(same(incremental, computeGeometry(live))).toBe(true);
        expect(incremental.nodes.get("I1::MC")!.bounds.x).toBe(244);   // actually moved
    });

    test("…and reuse really happens: untouched copies keep their PREVIOUS entry by reference", () => {
        // Correctness alone could be had by recomputing everything, which is what the old code
        // did. The point of the change is that unaffected copies are reused.
        const dispatcher = new ActionDispatcher(instancedDoc());
        const base = computeGeometry(dispatcher.getDocument());
        dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), "I1", { x: 250 }));
        const incremental = computeGeometry(dispatcher.getDocument(), null, base, new Set(["I1"]));

        expect(incremental.nodes.get("I2::MC")).toBe(base.nodes.get("I2::MC"));      // untouched — reused
        expect(incremental.nodes.get("I1::MC")).not.toBe(base.nodes.get("I1::MC"));  // on the changed path
    });

    test("a NESTED copy is dirtied by any master on its path", () => {
        const dispatcher = new ActionDispatcher(instancedDoc());
        const base = computeGeometry(dispatcher.getDocument());
        // `IM` is two levels down: the copies are `I1::OI::IM` and `I2::OI::IM`.
        dispatcher.dispatchAction(new UpdateNodeGeometryAction(dispatcher.getDocument(), "IM", { width: 35 }));
        const live = dispatcher.getDocument();
        const incremental = computeGeometry(live, null, base, new Set(["IM"]));
        expect(same(incremental, computeGeometry(live))).toBe(true);
        expect(incremental.nodes.get("I1::OI::IM")!.bounds.width).toBe(35);
    });

    test("an OVERRIDE dirties only its own instance's copies", () => {
        const dispatcher = new ActionDispatcher(instancedDoc());
        const base = computeGeometry(dispatcher.getDocument());
        dispatcher.dispatchAction(new SetInstanceOverrideAction(dispatcher.getDocument(), "I1", "MC", { geometry: { x: 50 } }));
        const live = dispatcher.getDocument();
        const incremental = computeGeometry(live, null, base, new Set(["I1"]));
        expect(same(incremental, computeGeometry(live))).toBe(true);
        expect(incremental.nodes.get("I1::MC")!.bounds.x).toBe(250);
        expect(incremental.nodes.get("I2::MC")!.bounds.x).toBe(404);   // 400 + MC's own 4 — the root copy is re-origined, so M's own x never counts
    });

    test("incremental === full over a random sequence of edits to an INSTANCED document", () => {
        // The same property the instance-free engine has been held to since M1, now covering
        // the expansion. Seeded, so any failure reproduces exactly.
        let seed = 0x5bf03635;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
        const dispatcher = new ActionDispatcher(instancedDoc());
        const editable = ["IM", "M", "MC", "OI", "I1", "I2"];
        const pick = () => editable[Math.floor(rnd() * editable.length)];

        let prev = computeGeometry(dispatcher.getDocument());
        const dirty = new Set<string>();
        for (let step = 0; step < 120; step++) {
            const doc = dispatcher.getDocument();
            const target = pick();
            const op = Math.floor(rnd() * 5);
            if (op === 0) {
                dispatcher.dispatchAction(new UpdateNodeGeometryAction(doc, target, { x: rnd() * 300, y: rnd() * 300 }));
                dirty.add(target);
            } else if (op === 1) {
                dispatcher.dispatchAction(new UpdateNodeGeometryAction(doc, target, { width: 1 + rnd() * 120, height: 1 + rnd() * 120 }));
                dirty.add(target);
            } else if (op === 2) {
                dispatcher.dispatchAction(new UpdateNodeTransformAction(doc, target, { rotation: rnd() * Math.PI * 2, scaleX: 0.5 + rnd() * 2 }));
                dirty.add(target);
            } else if (op === 3) {
                // An OVERRIDE — the edit that only exists because of instances.
                const inst = rnd() < 0.5 ? "I1" : "I2";
                dispatcher.dispatchAction(new SetInstanceOverrideAction(doc, inst, rnd() < 0.5 ? "MC" : "M", { geometry: { width: 5 + rnd() * 90 } }));
                dirty.add(inst);
            } else {
                dispatcher.dispatchAction(new UpdateNodeLayoutAction(doc, "M", rnd() < 0.5 ? { container: { direction: rnd() < 0.5 ? "row" : "column", gap: rnd() * 10 } } : { container: undefined }));
                dirty.add("M");
            }

            const live = dispatcher.getDocument();
            const incremental = computeGeometry(live, null, prev, dirty);
            expect(same(incremental, computeGeometry(live))).toBe(true);
            prev = incremental;
            dirty.clear();
        }
    });
});


// ─── States (Milestone 7, schema 30): what a node looks like in a named context ───
describe("States: a document-level selection, like the theme", () => {
    function stateDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 40, height: 20 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        doc.nodes.set("B", { id: "B", type: "core.rectangle", parent: null, children: [], geometry: { x: 100, y: 0, width: 40, height: 20 }, style: { fill: "#222222", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["A", "B"];
        return doc;
    }
    const resolved = (doc: ReadonlyDocument, id: string) => resolveScene(doc).nodes.get(id)!;

    test("a node shows its state only while that state is ACTIVE", () => {
        const dispatcher = new ActionDispatcher(stateDoc());
        dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), "A", "hover", { style: { fill: "#ff0000" }, geometry: { width: 80 } }));

        // Defined but not active: nothing changes.
        expect(resolved(dispatcher.getDocument(), "A").style.fill).toBe("#111111");
        dispatcher.dispatchAction(new SetActiveStateAction(dispatcher.getDocument(), "hover"));
        expect(resolved(dispatcher.getDocument(), "A").style.fill).toBe("#ff0000");
        expect(resolved(dispatcher.getDocument(), "A").geometry.width).toBe(80);
        // A node that does not define it is untouched, and returned BY REFERENCE.
        const d = dispatcher.getDocument();
        expect(resolveScene(d).nodes.get("B")).toBe(d.nodes.get("B"));
        // …and back to base.
        dispatcher.dispatchAction(new SetActiveStateAction(dispatcher.getDocument(), null));
        expect(resolved(dispatcher.getDocument(), "A").style.fill).toBe("#111111");
    });

    test("the STORED document never changes — a state is resolved, not applied", () => {
        const dispatcher = new ActionDispatcher(stateDoc());
        dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), "A", "hover", { style: { fill: "#ff0000" } }));
        dispatcher.dispatchAction(new SetActiveStateAction(dispatcher.getDocument(), "hover"));
        expect(dispatcher.getDocument().nodes.get("A")!.style.fill).toBe("#111111");   // still the base
        expect(dispatcher.getDocument().activeState).toBe("hover");
    });

    test("a state-free document is returned UNCHANGED — it pays nothing", () => {
        const doc = stateDoc();
        expect(resolveScene(doc)).toBe(doc);
        doc.activeState = "hover";                 // active, but nothing defines it
        expect(resolveScene(doc)).toBe(doc);
    });

    test("a stated node KEEPS its children — the state changes it, not its subtree", () => {
        // `materializeNode` returns a node with EMPTY children (the caller wires the tree), so
        // applying a state has to put them back. Without that, styling a container in its hover
        // state would make everything inside it vanish the moment the state was activated.
        const doc = stateDoc();
        doc.nodes.get("A")!.children = ["B"];
        doc.nodes.get("B")!.parent = "A";
        doc.rootNodeUuids = ["A"];
        doc.nodes.get("A")!.states = { hover: { style: { fill: "#00ff00" } } };
        doc.activeState = "hover";

        const scene = resolveScene(doc);
        expect(scene.nodes.get("A")!.children).toEqual(["B"]);
        expect(scene.nodes.get("A")!.style.fill).toBe("#00ff00");
        // …and the child is really reachable through the scene walk, not merely listed.
        expect(computeGeometry(doc).nodes.has("B")).toBe(true);
    });

    test("states reach INSTANCE copies: a master in its hover state makes hovered copies", () => {
        // The ordering `resolveScene` fixes — states resolve on STORED nodes BEFORE expansion.
        // Expanding first would leave every copy showing the base.
        const doc = stateDoc();
        doc.nodes.get("A")!.states = { hover: { style: { fill: "#00ff00" } } };
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 300, y: 0, width: 40, height: 20 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "A" });
        doc.rootNodeUuids = [...doc.rootNodeUuids, "I"];
        doc.activeState = "hover";
        expect(resolveScene(doc).nodes.get("I::A")!.style.fill).toBe("#00ff00");
    });

    test("switching state reports every AFFECTED node, so incremental compute cannot go stale", () => {
        // A document-level change with per-node consequences: the caller's dirty set is built
        // from `updatedNodeIds`, so an action that reported none would leave the geometry
        // engine reusing stale entries and the switch invisible until something else moved.
        const doc = stateDoc();
        doc.nodes.get("A")!.states = { hover: { geometry: { width: 90 } } };
        const dispatcher = new ActionDispatcher(doc);
        const action = new SetActiveStateAction(dispatcher.getDocument(), "hover");
        const result = action.execute();
        expect([...result.updatedNodeIds]).toEqual(["A"]);      // B defines nothing — not reported

        // …and the engine, given exactly that set, agrees with a full recompute.
        const base = computeGeometry(dispatcher.getDocument());
        dispatcher.dispatchAction(new SetActiveStateAction(dispatcher.getDocument(), "hover"));
        const live = dispatcher.getDocument();
        const incremental = computeGeometry(live, null, base, new Set(["A"]));
        expect(incremental.nodes.get("A")!.bounds.width).toBe(90);
        expect(incremental.nodes.get("A")!.bounds.width).toBe(computeGeometry(live).nodes.get("A")!.bounds.width);
    });

    test("a state obeys the SAME field rules an instance override does", () => {
        expect(statesError({ hover: { style: { opacity: 5 } } })).toMatch("opacity must be within");
        expect(statesError({ hover: { bogus: 1 } })).toMatch('unknown field "bogus"');
        expect(statesError({ hover: { geometry: { width: -1 } } })).toMatch("must be >= 0");
        expect(statesError({ "": {} })).not.toBeNull();
        expect(statesError(JSON.parse('{"__proto__":{}}'))).not.toBeNull();
        expect(statesError({ hover: { style: { fill: "#fff" }, layout: { grow: 1 } } })).toBeNull();
        // …and the ACTION runs them, rather than merely sharing a file with them.
        const dispatcher = new ActionDispatcher(stateDoc());
        expect(dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), "A", "hover", { style: { opacity: 5 } } as never)).success).toBe(false);
        expect(dispatcher.getDocument().nodes.get("A")!.states).toBeUndefined();
    });

    test("state definitions MERGE, and removing the last one drops the field", () => {
        const dispatcher = new ActionDispatcher(stateDoc());
        dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), "A", "hover", { style: { fill: "#ff0000" } }));
        dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), "A", "hover", { geometry: { width: 60 } }));
        expect(dispatcher.getDocument().nodes.get("A")!.states!.hover).toEqual({ style: { fill: "#ff0000" }, geometry: { width: 60 } });
        dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), "A", "hover", null));
        expect(dispatcher.getDocument().nodes.get("A")!.states).toBeUndefined();
    });

    test("a state document round-trips, active state included", () => {
        const dispatcher = new ActionDispatcher(stateDoc());
        dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), "A", "hover", { style: { fill: "#ff0000" } }));
        dispatcher.dispatchAction(new SetActiveStateAction(dispatcher.getDocument(), "hover"));
        const d = dispatcher.getDocument();
        const loaded = deserializeDocument(serializeDocument(d));
        expect(loaded.nodes.get("A")!.states).toEqual({ hover: { style: { fill: "#ff0000" } } });
        expect(loaded.activeState).toBe("hover");
        expect(compareDocuments(d, loaded)).toBe(true);
    });

    test("the 29→30 migration SANITIZES the old anything-goes states field", () => {
        // `states` was `{ [key: string]: any }` and validated by nothing, so a file may hold any
        // shape at all. Rejecting those now would brick documents that used a field nobody could
        // read; dropping the unreadable entries opens them instead.
        const legacy = {
            version: "29",
            document: {
                metadata: { project_name: "p", created_by: "c", date: new Date().toISOString() },
                nodes: {
                    A: { id: "A", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#fff", opacity: 1 }, layout: {}, states: { hover: { style: { fill: "#f00" } }, junk: { scale: 1.5 }, alsoJunk: "not an object" } },
                    B: { id: "B", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#fff", opacity: 1 }, layout: {}, states: { onlyJunk: { nope: true } } },
                    C: { id: "C", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#fff", opacity: 1 }, layout: {}, states: "not even a map" }
                },
                rootNodeUuids: ["A", "B", "C"], variables: {}, activeTheme: "light"
            }
        };
        const loaded = deserializeDocument(JSON.stringify(legacy));
        expect(loaded.nodes.get("A")!.states).toEqual({ hover: { style: { fill: "#f00" } } });  // the valid one survives
        expect(loaded.nodes.get("B")!.states).toBeUndefined();   // nothing valid left → field gone
        expect(loaded.nodes.get("C")!.states).toBeUndefined();   // not even a map
    });

    test("resolveScene is the ONE seam — nothing outside Components expands instances directly", () => {
        // Calling `expandInstances` straight would silently skip states, which is exactly the
        // kind of miss that shows up as "the feature works everywhere except one panel".
        const roots = ["../../app/App.tsx", "../../renderer/RenderModel.ts", "../../editor/tools/ToolController.ts",
            "../../editor/tools/MoveTool.ts", "../../core/geometry/GeometryEngine.ts", "../../core/actions/alignActions.ts"];
        for (const rel of roots) {
            const src = readFileSync(resolve(__dirname, rel), "utf8");
            expect({ file: rel, calls: /\bexpandInstances\s*\(/.test(src) }).toEqual({ file: rel, calls: false });
            expect(src).toMatch(/resolveScene\s*\(/);
        }
    });

    test("the UI can DEFINE a state and SHOW one — either alone is useless", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/<StatesSection/);
        // TWO call sites use the same constructor (re-capture and capture-new), so the
        // audit must name something unique to each or deleting one still passes.
        expect(src).toMatch(/setNewState\(""\)/);                    // capture NEW
        expect((src.match(/new SetNodeStateAction\(/g) ?? []).length).toBe(3);  // capture, re-capture, remove
        expect(src).toMatch(/new SetActiveStateAction\(/);          // show
        expect(src).toMatch(/variantNameError\("state name", name, true\)/); // the shared rule is the authority
    });
});


// ─── Layer flags (schema 31): hide and lock, with real engine consequences ───
describe("Layers: hidden and locked", () => {
    /** A locked background, a group holding two children, and a plain node on top. */
    function layerDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        doc.nodes.set("BG", { id: "BG", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 200, height: 200 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        doc.nodes.set("G", { id: "G", type: "core.rectangle", parent: null, children: ["C1", "C2"], geometry: { x: 0, y: 0, width: 120, height: 40 }, style: { fill: "none", opacity: 1 }, layout: {} });
        doc.nodes.set("C1", { id: "C1", type: "core.rectangle", parent: "G", children: [], geometry: { x: 0, y: 0, width: 40, height: 40 }, style: { fill: "#ff0000", opacity: 1 }, layout: {} });
        doc.nodes.set("C2", { id: "C2", type: "core.rectangle", parent: "G", children: [], geometry: { x: 60, y: 0, width: 40, height: 40 }, style: { fill: "#00ff00", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["BG", "G"];
        return doc;
    }

    test("HIDING a node removes it from the displayed scene, with its whole subtree", () => {
        const dispatcher = new ActionDispatcher(layerDoc());
        dispatcher.dispatchAction(new SetNodeFlagsAction(dispatcher.getDocument(), "G", { hidden: true }));
        const scene = resolveScene(dispatcher.getDocument());

        expect(scene.nodes.has("G")).toBe(false);
        expect(scene.nodes.has("C1")).toBe(false);      // the subtree goes with it
        expect(scene.nodes.has("BG")).toBe(true);
        expect(scene.rootNodeUuids).toEqual(["BG"]);
        // …and it is STILL in the stored document, which is the whole difference from deleting.
        expect(dispatcher.getDocument().nodes.has("G")).toBe(true);
    });

    test("a hidden node is not drawn, not picked, and takes no auto-layout space", () => {
        // One flag, three consequences — which is why hiding REMOVES the node from the scene
        // rather than setting something each consumer has to remember to check.
        const doc = layerDoc();
        doc.nodes.get("G")!.layout = { container: { direction: "row", gap: 0, padding: 0 } };
        doc.nodes.get("C1")!.hidden = true;

        const computed = computeGeometry(doc);
        expect(computed.nodes.has("C1")).toBe(false);
        expect(hitTest(computed, 20, 20)).not.toBe("C1");
        // C2 slides into the space C1 would have taken.
        expect(computed.nodes.get("C2")!.bounds.x).toBe(0);
    });

    test("LOCKING a node keeps it drawn but not selectable — clicks pass THROUGH", () => {
        // Passing through matters: locking a background is only useful if it stops swallowing
        // clicks meant for what sits on top of it.
        const doc = layerDoc();
        doc.nodes.get("BG")!.locked = true;
        const computed = computeGeometry(doc);

        expect(computed.nodes.has("BG")).toBe(true);           // still drawn
        expect(computed.locked.has("BG")).toBe(true);
        expect(hitTest(computed, 20, 20)).toBe("C1");          // the click reaches what is on top
        expect(hitTest(computed, 180, 180)).toBeNull();        // over ONLY the locked node: nothing
        expect(nodesInRect(computed, { x: 0, y: 0, width: 300, height: 300 })).not.toContain("BG");
    });

    test("lock INHERITS — locking a group locks everything inside it", () => {
        const doc = layerDoc();
        doc.nodes.get("G")!.locked = true;
        const computed = computeGeometry(doc);
        expect(computed.locked.has("C1")).toBe(true);
        expect(computed.locked.has("C2")).toBe(true);
        expect(computed.locked.has("BG")).toBe(false);
        expect(hitTest(computed, 20, 20)).toBe("BG");          // straight through the locked group
    });

    test("a document with no flags is returned UNCHANGED — it pays nothing", () => {
        const doc = layerDoc();
        expect(resolveScene(doc)).toBe(doc);
        expect(computeGeometry(doc).locked.size).toBe(0);
    });

    test("clearing a flag stores it ABSENT, so an untouched document stays identical", () => {
        const dispatcher = new ActionDispatcher(layerDoc());
        const before = serializeDocument(dispatcher.getDocument());
        dispatcher.dispatchAction(new SetNodeFlagsAction(dispatcher.getDocument(), "BG", { hidden: true, locked: true }));
        dispatcher.dispatchAction(new SetNodeFlagsAction(dispatcher.getDocument(), "BG", { hidden: false, locked: false }));
        const node = dispatcher.getDocument().nodes.get("BG")!;
        expect(node.hidden).toBeUndefined();
        expect(node.locked).toBeUndefined();
        expect(serializeDocument(dispatcher.getDocument())).toBe(before);
    });

    test("the flags patch is PARTIAL — toggling one never disturbs the other", () => {
        const dispatcher = new ActionDispatcher(layerDoc());
        dispatcher.dispatchAction(new SetNodeFlagsAction(dispatcher.getDocument(), "BG", { locked: true }));
        dispatcher.dispatchAction(new SetNodeFlagsAction(dispatcher.getDocument(), "BG", { hidden: true }));
        expect(dispatcher.getDocument().nodes.get("BG")!.locked).toBe(true);
        expect(dispatcher.getDocument().nodes.get("BG")!.hidden).toBe(true);
    });

    test("flags round-trip", () => {
        const dispatcher = new ActionDispatcher(layerDoc());
        dispatcher.dispatchAction(new SetNodeFlagsAction(dispatcher.getDocument(), "BG", { locked: true }));
        dispatcher.dispatchAction(new SetNodeFlagsAction(dispatcher.getDocument(), "G", { hidden: true }));
        const d = dispatcher.getDocument();
        const loaded = deserializeDocument(serializeDocument(d));
        expect(loaded.nodes.get("BG")!.locked).toBe(true);
        expect(loaded.nodes.get("G")!.hidden).toBe(true);
        expect(compareDocuments(d, loaded)).toBe(true);
    });

    test("the derived scene has NO dangling child references", () => {
        // Dropping a node without unlisting it from its parent leaves a derived document that
        // `validateDocumentIntegrity` would refuse — and nothing validates a derived document, so
        // the inconsistency would just sit there waiting for a consumer that trusts `children`.
        // Expansion states the same rule about itself; hiding has to hold to it too.
        const doc = layerDoc();
        doc.nodes.get("C1")!.hidden = true;
        const scene = resolveScene(doc);
        scene.nodes.forEach(n => {
            for (const childId of n.children) {
                expect({ parent: n.id, child: childId, present: scene.nodes.has(childId) })
                    .toEqual({ parent: n.id, child: childId, present: true });
            }
        });
        expect(scene.rootNodeUuids.every(id => scene.nodes.has(id))).toBe(true);
    });

    test("hiding TERMINATES on a damaged, cyclic document", () => {
        // Not reachable through the actions, but reachable by hand-editing a file — and this walk
        // runs on the display path, so without the visited set it recurses until the stack dies.
        const doc = createEmptyDocument();
        const mk = (id: string, kids: string[], parent: string | null, extra: Record<string, unknown> = {}) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent, children: kids, geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {}, ...extra } as never);
        mk("A", ["B"], null, { hidden: true });
        mk("B", ["A"], "A");                       // …and back to A
        doc.rootNodeUuids = ["A"];
        expect(() => resolveScene(doc)).not.toThrow();
        expect(resolveScene(doc).nodes.size).toBe(0);   // both buried, once each
    });

    test("the panel offers both toggles, and shows an INHERITED flag without pretending it is set", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/onFlag\(\{ hidden: !node\.hidden \}\)/);
        expect(src).toMatch(/onFlag\(\{ locked: !node\.locked \}\)/);
        expect(src).toMatch(/inheritedHidden \? "default" : "pointer"/);   // an inherited flag is not clickable here
        expect(src).toMatch(/walk\(n\.children, depth \+ 1, hiddenAbove \|\| !!n\.hidden, lockedAbove \|\| !!n\.locked\)/);
    });
});


// ─── Layer drag: the arithmetic a drop resolves to ───
describe("resolveLayerDrop", () => {
    /** Roots [A, B, C]; B holds [B1, B2]; I is an instance. */
    function dropDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        const mk = (id: string, kids: string[], parent: string | null, type = "core.rectangle") =>
            doc.nodes.set(id, { id, type, parent, children: kids, geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {} } as never);
        mk("A", [], null); mk("B", ["B1", "B2"], null); mk("C", [], null);
        mk("B1", [], "B"); mk("B2", [], "B");
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "A" });
        doc.rootNodeUuids = ["A", "B", "C", "I"];
        return doc;
    }

    test("dropping on a row's EDGE reorders among that row's siblings", () => {
        const doc = dropDoc();
        expect(resolveLayerDrop(doc, "C", "A", "before")).toEqual({ parent: null, index: 0 });
        expect(resolveLayerDrop(doc, "A", "C", "after")).toEqual({ parent: null, index: 2 });
    });

    test("moving DOWN within one list accounts for the node being detached first", () => {
        // The off-by-one this function exists for: `applyMutations` removes the node before
        // inserting it, so an index measured against the list as it looks NOW is one too high
        // whenever the node is moving downwards. Dragging A after B must land it at 1, not 2.
        const doc = dropDoc();
        expect(resolveLayerDrop(doc, "A", "B", "after")).toEqual({ parent: null, index: 1 });
        // …and moving UP needs no adjustment.
        expect(resolveLayerDrop(doc, "C", "B", "before")).toEqual({ parent: null, index: 1 });
    });

    test("dropping in a row's MIDDLE reparents INTO it, appended", () => {
        const doc = dropDoc();
        expect(resolveLayerDrop(doc, "A", "B", "inside")).toEqual({ parent: "B", index: 2 });
        expect(resolveLayerDrop(doc, "B1", "A", "inside")).toEqual({ parent: "A", index: 0 });
    });

    test("a move that changes nothing is REFUSED, so no undo step is pushed for it", () => {
        const doc = dropDoc();
        expect(resolveLayerDrop(doc, "A", "B", "before")).toBeNull();   // A is already right there
        expect(resolveLayerDrop(doc, "A", "A", "after")).toBeNull();    // onto itself
    });

    test("dropping a node into its own subtree is refused — that is the cycle", () => {
        const doc = dropDoc();
        expect(resolveLayerDrop(doc, "B", "B1", "inside")).toBeNull();
        expect(resolveLayerDrop(doc, "B", "B2", "before")).toBeNull();
        // …and the ACTION refuses it too, which is the real guarantee.
        const dispatcher = new ActionDispatcher(dropDoc());
        expect(dispatcher.dispatchAction(new ReparentNodeAction(dispatcher.getDocument(), "B", "B1", 0)).success).toBe(false);
    });

    test("dropping INSIDE an instance is refused — it has no stored children to join", () => {
        // An instance draws its master's subtree; a node parented to it would vanish from the
        // picture entirely. Refusing beats swallowing it.
        const doc = dropDoc();
        expect(resolveLayerDrop(doc, "A", "I", "inside")).toBeNull();
        expect(resolveLayerDrop(doc, "A", "I", "after")).toEqual({ parent: null, index: 3 });  // beside it is fine
    });

    test("a resolved drop, dispatched, produces exactly the order it promised", () => {
        // The arithmetic is only right if the document ends up looking like the indicator said.
        const dispatcher = new ActionDispatcher(dropDoc());
        const drop = resolveLayerDrop(dispatcher.getDocument(), "A", "C", "after")!;
        dispatcher.dispatchAction(new ReparentNodeAction(dispatcher.getDocument(), "A", drop.parent, drop.index));
        expect(dispatcher.getDocument().rootNodeUuids).toEqual(["B", "C", "A", "I"]);

        const into = resolveLayerDrop(dispatcher.getDocument(), "A", "B", "inside")!;
        dispatcher.dispatchAction(new ReparentNodeAction(dispatcher.getDocument(), "A", into.parent, into.index));
        expect(dispatcher.getDocument().nodes.get("B")!.children).toEqual(["B1", "B2", "A"]);
        expect(dispatcher.getDocument().rootNodeUuids).toEqual(["B", "C", "I"]);
    });

    test("a damaged tree is refused rather than guessed at", () => {
        const doc = dropDoc();
        expect(resolveLayerDrop(doc, "A", "ghost", "before")).toBeNull();
        expect(resolveLayerDrop(doc, "ghost", "A", "before")).toBeNull();
    });

    test("a cyclic PARENT chain does not hang the drop resolver", () => {
        // The ancestor walk climbs `parent` links, which a hand-edited file can make circular.
        // Not reachable through the actions, but this runs on every dragover — a hang here is a
        // frozen app, not a wrong answer.
        const doc = dropDoc();
        doc.nodes.get("A")!.parent = "C";
        doc.nodes.get("C")!.parent = "A";
        expect(() => resolveLayerDrop(doc, "B", "A", "inside")).not.toThrow();
        expect(resolveLayerDrop(doc, "B", "A", "inside")).toEqual({ parent: "A", index: 0 });
    });

    test("the panel offers drag AND rename, and shows only drops it would take", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/draggable=\{!renaming\}/);
        expect(src).toMatch(/new ReparentNodeAction\(dispatcher\.getDocument\(\), layerDrag\.id, drop\.parent, drop\.index\)/);
        // The indicator is gated on the SAME resolver the drop uses, so the two cannot disagree.
        expect(src).toMatch(/const ok = layerDrag\.id && layerDrag\.id !== id[\s\S]{0,160}resolveLayerDrop\(/);
        expect(src).toMatch(/onDoubleClick=\{e => \{ e\.stopPropagation\(\); setRenaming\(true\); \}\}/);
        expect(src).toMatch(/contentActionFor\(dispatcher\.getDocument\(\), id, \{ name \}\)/);
    });
});


// ─── Opacity inherits (schema 32), and the layer panel can set it ───
describe("Opacity: a group's fade reaches its contents", () => {
    /** Deliberately THREE levels deep: a two-level fixture cannot tell "multiply by the parent"
     *  apart from "multiply by every ancestor", which is the mistake a shallow fixture hides. */
    function nestedDoc(outer = 1, middle = 1, leaf = 1): ProjectDocument {
        const doc = createEmptyDocument();
        const mk = (id: string, kids: string[], parent: string | null, opacity: number) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent, children: kids, geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#4a90d9", opacity }, layout: {} });
        mk("OUT", ["MID"], null, outer);
        mk("MID", ["LEAF"], "OUT", middle);
        mk("LEAF", [], "MID", leaf);
        doc.rootNodeUuids = ["OUT"];
        return doc;
    }
    const stateFor = (doc: ProjectDocument) =>
        ({ viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(doc) }) as unknown as import("../../renderer/RendererState").RendererState;
    const modelFor = (doc: ProjectDocument) => buildRenderModel({ width: 800, height: 600 }, doc, stateFor(doc));
    const itemFor = (doc: ProjectDocument, id: string) => modelFor(doc).content.find(i => i.nodeId === id)!;
    /** What the picture ends up at: the item's own alpha times every group around it. */
    const composited = (doc: ProjectDocument, id: string) => {
        const model = modelFor(doc);
        const alpha = new Map(model.groups.map(g => [g.id, g.opacity]));
        const item = model.content.find(i => i.nodeId === id)!;
        return (item.groups ?? []).reduce((a, g) => a * (alpha.get(g) ?? 1), item.paint.opacity ?? 1);
    };

    test("a node is inside EVERY enclosing group, outermost first — not just its parent's", () => {
        const doc = nestedDoc(0.5, 0.5, 0.5);
        // OUT and MID have children and opacity < 1, so both composite as groups. LEAF has no
        // children, so it needs none: fading it alone is the same picture.
        expect(itemFor(doc, "LEAF").groups).toEqual(["OUT", "MID"]);
        // A group draws INSIDE its own group — its fill has to fade together with its
        // children, not separately — so MID lists itself, and its item alpha is 1.
        expect(itemFor(doc, "MID").groups).toEqual(["OUT", "MID"]);
        expect(itemFor(doc, "MID").paint.opacity).toBe(1);
        expect(composited(doc, "MID")).toBeCloseTo(0.25);
        expect(itemFor(doc, "LEAF").paint.opacity).toBe(0.5);  // a leaf keeps its own
        expect(modelFor(doc).groups).toEqual([{ id: "OUT", opacity: 0.5 }, { id: "MID", opacity: 0.5 }]);
        // A two-level fixture could not tell this apart from "just the parent": 0.5³.
        expect(composited(doc, "LEAF")).toBeCloseTo(0.125);
    });

    test("fading a GROUP fades its contents — the thing that used to do nothing", () => {
        const opaque = nestedDoc(1, 1, 1);
        expect(opaque.nodes.get("OUT")!.style.opacity).toBe(1);
        expect(modelFor(opaque).groups).toEqual([]);            // nothing translucent: no groups at all
        expect(itemFor(opaque, "LEAF").groups).toBeUndefined(); // …and no per-item overhead
        expect(composited(opaque, "LEAF")).toBeCloseTo(1);

        const faded = nestedDoc(0.4, 1, 1);                     // only the OUTER changed
        expect(modelFor(faded).groups).toEqual([{ id: "OUT", opacity: 0.4 }]);
        expect(composited(faded, "LEAF")).toBeCloseTo(0.4);
    });

    test("a translucent group composites ONCE — that is why it is structure, not a number", () => {
        // The bug this replaces: multiplying the alpha into each child makes two overlapping
        // children inside a 50% group read as three tones instead of one. Both children carry
        // their OWN alpha and sit in the same group, so the backend fades the result once.
        const doc = createEmptyDocument();
        const mk = (id: string, kids: string[], parent: string | null, opacity: number) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent, children: kids, geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#4a90d9", opacity }, layout: {} });
        mk("G", ["A", "B"], null, 0.5); mk("A", [], "G", 1); mk("B", [], "G", 1);
        doc.rootNodeUuids = ["G"];
        expect(itemFor(doc, "A").paint.opacity).toBe(1);
        expect(itemFor(doc, "B").paint.opacity).toBe(1);
        expect(itemFor(doc, "A").groups).toEqual(["G"]);
        expect(itemFor(doc, "B").groups).toEqual(["G"]);
        expect(modelFor(doc).groups).toEqual([{ id: "G", opacity: 0.5 }]);
    });

    test("the STORED value stays the node's own — the inspector must not show the product", () => {
        // Computed in the render model precisely so this stays true; baking it into the scene
        // would make the inspector read back a number nobody typed.
        const doc = nestedDoc(0.5, 0.5, 0.5);
        expect(doc.nodes.get("LEAF")!.style.opacity).toBe(0.5);
        expect(resolveScene(doc).nodes.get("LEAF")!.style.opacity).toBe(0.5);
    });

    test("a cyclic parent chain renders NOTHING, so the opacity climb never meets one", () => {
        // My first version of this asserted `not.toThrow()` and passed whether or not the
        // climb was guarded — a test that looks like coverage and is not. What actually
        // happens is that the scene walk drops the whole cycle, so `buildContent` never
        // reaches such a node. The guard in `effectiveOpacity` is therefore defence in
        // depth against a FUTURE caller, and cannot be killed by mutation through this one.
        const doc = nestedDoc(0.5, 0.5, 0.5);
        doc.nodes.get("OUT")!.parent = "LEAF";
        const model = buildRenderModel({ width: 800, height: 600 }, doc, stateFor(doc));
        expect(model.content).toEqual([]);
    });

    test("opacity from the layer panel is ROUTED, so a copy gets an override", () => {
        // The fault this avoids: dispatching a raw action at a virtual id fails validation and
        // the control silently does nothing.
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 40, height: 40 }, style: { fill: "#4a90d9", opacity: 1 }, layout: {} });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 100, y: 0, width: 40, height: 40 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I"];
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(styleActionFor(dispatcher.getDocument(), "I::M", { opacity: 0.3 })!);
        expect(resolveScene(dispatcher.getDocument()).nodes.get("I::M")!.style.opacity).toBe(0.3);
        expect(dispatcher.getDocument().nodes.get("M")!.style.opacity).toBe(1);   // master untouched
    });

    test("the panel's opacity field edits THIS node and routes through the seam", () => {
        // Counting the call site: `styleActionFor` appears many times in App.tsx, so matching the
        // bare name would pass with the layer control deleted — the audit fault from the slots
        // and states slices, twice recorded and twice repeated.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/onOpacity=\{opacity => \{/);
        expect(src).toMatch(/styleActionFor\(dispatcher\.getDocument\(\), id, \{ opacity \}\)/);
        expect(src).toMatch(/onOpacity\(Math\.min\(1, Math\.max\(0, pct \/ 100\)\)\)/);
        // …and it refuses a half-typed value rather than snapping the node to invisible.
        expect(src).toMatch(/if \(!Number\.isFinite\(pct\)\) return;/);
    });
});


// ─── Layer panel: multi-select and search ───
describe("selectionForRowClick", () => {
    const rows = ["A", "B", "C", "D", "E"];

    test("a plain click selects one row and becomes the anchor", () => {
        expect(selectionForRowClick(rows, ["A", "B"], "A", "D")).toEqual({ selected: ["D"], anchor: "D" });
    });

    test("ctrl/cmd TOGGLES without disturbing the rest", () => {
        expect(selectionForRowClick(rows, ["A"], "A", "C", { ctrl: true })).toEqual({ selected: ["A", "C"], anchor: "C" });
        expect(selectionForRowClick(rows, ["A", "C"], "C", "A", { meta: true })).toEqual({ selected: ["C"], anchor: "A" });
        // Toggling the last one off leaves an empty selection rather than snapping back to one.
        expect(selectionForRowClick(rows, ["A"], "A", "A", { ctrl: true })).toEqual({ selected: [], anchor: "A" });
    });

    test("shift selects the contiguous range, in either direction", () => {
        expect(selectionForRowClick(rows, ["B"], "B", "D", { shift: true }).selected).toEqual(["B", "C", "D"]);
        expect(selectionForRowClick(rows, ["D"], "D", "B", { shift: true }).selected).toEqual(["B", "C", "D"]);
    });

    test("the anchor does NOT move on shift, so the range can be grown and shrunk", () => {
        // The bug this avoids: moving the anchor to the clicked row makes each shift-click walk
        // the range down the list instead of resizing it from a fixed end.
        const first = selectionForRowClick(rows, ["B"], "B", "D", { shift: true });
        expect(first.anchor).toBe("B");
        const grown = selectionForRowClick(rows, first.selected, first.anchor, "E", { shift: true });
        expect(grown.selected).toEqual(["B", "C", "D", "E"]);
        const shrunk = selectionForRowClick(rows, grown.selected, grown.anchor, "C", { shift: true });
        expect(shrunk.selected).toEqual(["B", "C"]);
    });

    test("shift with no usable anchor falls back to a plain click rather than guessing", () => {
        expect(selectionForRowClick(rows, [], null, "C", { shift: true })).toEqual({ selected: ["C"], anchor: "C" });
        // An anchor that is no longer visible (collapsed away, or filtered out) is not a range.
        expect(selectionForRowClick(rows, ["C"], "GONE", "C", { shift: true })).toEqual({ selected: ["C"], anchor: "C" });
    });

    test("a range spans the VISIBLE order, not the document order", () => {
        // Rows the user cannot see are not between anything — selecting them would pick up nodes
        // that were never on screen, which is the whole reason the caller passes what it rendered.
        const visible = ["A", "D", "E"];                 // B and C are collapsed or filtered away
        expect(selectionForRowClick(visible, ["A"], "A", "E", { shift: true }).selected).toEqual(["A", "D", "E"]);
    });
});

describe("filterLayers", () => {
    /** Three levels, so "keeps the parent" and "keeps every ancestor" are distinguishable. */
    function treeDoc(): ProjectDocument {
        const doc = createEmptyDocument();
        const mk = (id: string, kids: string[], parent: string | null, name?: string) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent, children: kids, geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {}, ...(name ? { name } : {}) });
        mk("PAGE", ["CARD", "ASIDE"], null, "Page");
        mk("CARD", ["TITLE"], "PAGE", "Card");
        mk("TITLE", [], "CARD", "Headline");
        mk("ASIDE", [], "PAGE", "Sidebar");
        doc.rootNodeUuids = ["PAGE"];
        return doc;
    }
    const labelOf = (doc: ProjectDocument) => (id: string) => doc.nodes.get(id)?.name ?? id;

    test("an empty query is INACTIVE, so the caller skips filtering entirely", () => {
        const doc = treeDoc();
        expect(filterLayers(doc, "", labelOf(doc)).inactive).toBe(true);
        expect(filterLayers(doc, "   ", labelOf(doc)).inactive).toBe(true);
    });

    test("a match keeps EVERY ancestor, not just its parent", () => {
        // Two levels of ancestry: keeping only the parent would leave CARD visible at depth 1
        // with no PAGE above it — a row at the wrong depth, belonging to nothing.
        const doc = treeDoc();
        const f = filterLayers(doc, "headline", labelOf(doc));
        expect(f.matched).toEqual(new Set(["TITLE"]));
        expect(f.visible).toEqual(new Set(["TITLE", "CARD", "PAGE"]));
        expect(f.visible.has("ASIDE")).toBe(false);       // an unrelated branch is gone
    });

    test("matching is case-insensitive and substring, on the label the row SHOWS", () => {
        const doc = treeDoc();
        expect(filterLayers(doc, "CARD", labelOf(doc)).matched).toEqual(new Set(["CARD"]));
        expect(filterLayers(doc, "ead", labelOf(doc)).matched).toEqual(new Set(["TITLE"]));
        expect(filterLayers(doc, "nothing here", labelOf(doc)).visible.size).toBe(0);
    });

    test("a matching ANCESTOR does not drag its children back in", () => {
        // Searching "Card" should show the path to Card, not everything under it — otherwise a
        // query near the root just redraws the whole tree.
        const doc = treeDoc();
        const f = filterLayers(doc, "card", labelOf(doc));
        expect(f.visible).toEqual(new Set(["CARD", "PAGE"]));
        expect(f.visible.has("TITLE")).toBe(false);
    });

    test("a cyclic parent chain does not hang the climb", () => {
        // Runs on every keystroke, so a loop here freezes the app while typing.
        const doc = treeDoc();
        doc.nodes.get("PAGE")!.parent = "TITLE";
        expect(() => filterLayers(doc, "headline", labelOf(doc))).not.toThrow();
        expect(filterLayers(doc, "headline", labelOf(doc)).visible.has("PAGE")).toBe(true);
    });

    test("the panel wires BOTH — searching and multi-select, each at its own call site", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/filterLayers\(doc, layerQuery, labelOf\)/);
        expect(src).toMatch(/selectionForRowClick\(visibleOrder, es\.selectedNodeIds, layerAnchorRef\.current, id, mods\)/);
        // Filtering must IGNORE the collapsed state, or search only finds what was already open.
        expect(src).toMatch(/filter\.inactive \? collapsedLayers\.has\(id\) : false/);
        // …and a filtered-out row is skipped before it is rendered or added to the order.
        expect(src).toMatch(/if \(!filter\.inactive && !filter\.visible\.has\(id\)\) continue;/);
    });
});


// ─── The pen: turning points into a core.path node ───
describe("PathBuilder", () => {
    const P = (x: number, y: number, hx?: number, hy?: number): PenPoint =>
        hx === undefined ? { x, y } : { x, y, hx, hy };

    test("a segment with no handles is a LINE, not a degenerate curve", () => {
        // Emitting a cubic for everything would draw identically and turn a plain polygon into
        // coincident control points nobody can edit.
        expect(penCommands([P(0, 0), P(10, 0), P(10, 10)], false)).toEqual([
            { c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "L", x: 10, y: 10 }
        ]);
    });

    test("a handle on EITHER end makes the segment a cubic", () => {
        // The out handle of the start, and the IN handle of the end — which is the end's own
        // handle mirrored, so a curve is smooth by construction.
        expect(penCommands([P(0, 0, 5, -5), P(10, 0)], false)).toEqual([
            { c: "M", x: 0, y: 0 },
            { c: "C", x1: 5, y1: -5, x2: 10, y2: 0, x: 10, y: 0 }
        ]);
        expect(penCommands([P(0, 0), P(10, 0, 15, 5)], false)).toEqual([
            { c: "M", x: 0, y: 0 },
            { c: "C", x1: 0, y1: 0, x2: 5, y2: -5, x: 10, y: 0 }   // in-handle = mirror of (15,5)
        ]);
    });

    test("closing adds the wrap-around segment AND a Z", () => {
        const open = penCommands([P(0, 0), P(10, 0), P(10, 10)], false);
        const closed = penCommands([P(0, 0), P(10, 0), P(10, 10)], true);
        expect(closed.slice(0, open.length)).toEqual(open);
        expect(closed.slice(open.length)).toEqual([{ c: "L", x: 0, y: 0 }, { c: "Z" }]);
    });

    test("bounds are TIGHT around the ink — a control point outside the curve is not in the box", () => {
        // `M 0 0 C 0 -50 10 0 10 0`: the handle reaches y = -50, but the curve it shapes peaks
        // at t = 1/3, where y = 3(2/3)²(1/3)(-50) = -200/9 ≈ -22.22. The old bounds took the
        // control HULL and returned -50, so a curved node's frame carried 27.8 units of empty
        // margin — the selection box visibly did not match the shape, and every consumer of
        // bounds (snapping, culling, alignment, the marquee) worked from that phantom.
        const cmds = penCommands([P(0, 0, 0, -50), P(10, 0)], false);
        const b = pathBounds(cmds);
        expect(b.x).toBe(0);
        expect(b.width).toBe(10);
        expect(b.y).toBeCloseTo(-200 / 9, 10);
        expect(b.height).toBeCloseTo(200 / 9, 10);
        expect(pathBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
        // The same curve moved off the origin. A curve's extrema depend on where it STARTS,
        // which is the one thing a per-command scan cannot see — carrying the current point
        // wrongly would leave this box measured from (0,0) and wildly too tall.
        const moved = pathBounds([{ c: "M", x: 100, y: 100 }, { c: "C", x1: 100, y1: 50, x2: 110, y2: 100, x: 110, y: 100 }]);
        expect(moved.x).toBe(100);
        expect(moved.width).toBe(10);
        expect(moved.y).toBeCloseTo(100 - 200 / 9, 10);
        expect(moved.height).toBeCloseTo(200 / 9, 10);
    });

    test("a curve that never turns is bounded by its endpoints alone", () => {
        // The degenerate branch: evenly spaced controls make the derivative LINEAR, so the
        // quadratic formula would divide by zero. A monotonic curve's extremes ARE its ends.
        const straightish: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "C", x1: 10, y1: 10, x2: 20, y2: 20, x: 30, y: 30 }];
        expect(pathBounds(straightish)).toEqual({ x: 0, y: 0, width: 30, height: 30 });
        // …but a LINEAR derivative is not the same as NO turn. With y running 0,-40,-40,0 the
        // quadratic's leading term vanishes while a real root survives at t = 1/2, where the
        // curve reaches -30. Falling through to the quadratic formula divides by zero and loses
        // it — the box would collapse to the endpoints and clip 30 units of visible ink.
        const flatDeriv: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "C", x1: 0, y1: -40, x2: 60, y2: -40, x: 60, y: 0 }];
        expect(pathBounds(flatDeriv)).toEqual({ x: 0, y: -30, width: 60, height: 30 });
        // A QUADRATIC turns too, and its single root is (p0−p1)/(p0−2p1+p2) = 1/2 here,
        // where y = 25 — half of the handle's 50, and the whole reason the hull was wrong.
        const quad: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "Q", x1: 10, y1: 50, x: 20, y: 0 }];
        expect(pathBounds(quad)).toEqual({ x: 0, y: 0, width: 20, height: 25 });
    });

    test("translate moves every coordinate, control points included", () => {
        const cmds: PathCommand[] = [
            { c: "M", x: 1, y: 2 },
            { c: "C", x1: 3, y1: 4, x2: 5, y2: 6, x: 7, y: 8 },
            { c: "Q", x1: 9, y1: 10, x: 11, y: 12 },
            { c: "Z" }
        ];
        expect(translatePath(cmds, 100, 200)).toEqual([
            { c: "M", x: 101, y: 202 },
            { c: "C", x1: 103, y1: 204, x2: 105, y2: 206, x: 107, y: 208 },
            { c: "Q", x1: 109, y1: 210, x: 111, y: 212 },
            { c: "Z" }
        ]);
    });

    test("a finished stroke becomes a BOX plus commands LOCAL to it", () => {
        // The thing that made `core.path` unauthorable: commands are stored local to the node's
        // box, but a pen draws in world space.
        const built = penNodeFrom([P(100, 100), P(140, 100), P(140, 130)], true)!;
        expect(built.geometry).toEqual({ x: 100, y: 100, width: 40, height: 30 });
        expect(built.path).toEqual([
            { c: "M", x: 0, y: 0 }, { c: "L", x: 40, y: 0 }, { c: "L", x: 40, y: 30 },
            { c: "L", x: 0, y: 0 }, { c: "Z" }
        ]);
    });

    test("it refuses exactly what the document would refuse", () => {
        // Checked before an action is built, so a stray click leaves nothing behind rather than
        // failing validation somewhere the user cannot see.
        expect(penNodeFrom([], false)).toBeNull();
        expect(penNodeFrom([P(5, 5)], false)).toBeNull();              // one point is not a path
        expect(penNodeFrom([P(5, 5), P(5, 5)], false)).toBeNull();     // no extent on EITHER axis
        // …but a single-axis collapse is legal for a path, so a flat stroke must survive.
        const flat = penNodeFrom([P(0, 0), P(50, 0)], false)!;
        expect(flat.geometry).toEqual({ x: 0, y: 0, width: 50, height: 0 });
        expect(dimensionError("core.path", flat.geometry.width, flat.geometry.height)).toBeNull();
    });

    test("everything the pen builds is a path the LOADER accepts", () => {
        // The closure that matters: `pathError` is the loader's rule, and the pen must not be
        // able to author something a reload refuses.
        const cases: Array<[PenPoint[], boolean]> = [
            [[P(0, 0), P(10, 10)], false],
            [[P(0, 0, 5, 5), P(10, 10, 15, 5)], true],
            [[P(0, 0), P(10, 0), P(10, 10), P(0, 10)], true]
        ];
        for (const [pts, closed] of cases) {
            const built = penNodeFrom(pts, closed)!;
            expect(built).not.toBeNull();
            expect(pathError("core.path", built.path)).toBeNull();
        }
    });

    test("a pen path dispatched through the ACTION lands in the document and round-trips", () => {
        const doc = createEmptyDocument();
        const built = penNodeFrom([P(20, 20), P(60, 20), P(60, 50)], true)!;
        const dispatcher = new ActionDispatcher(doc);
        const id = "pen-1";
        dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.path",
            built.geometry.x, built.geometry.y, built.geometry.width, built.geometry.height, "#4a90d9", id));
        dispatcher.dispatchAction(new UpdateNodePathAction(dispatcher.getDocument(), id, built.path));

        const d = dispatcher.getDocument();
        expect(d.nodes.get(id)!.path).toEqual(built.path);
        const loaded = deserializeDocument(serializeDocument(d));
        expect(loaded.nodes.get(id)!.path).toEqual(built.path);
        expect(compareDocuments(d, loaded)).toBe(true);
    });

    test("the path action refuses what the loader refuses, and refuses a non-path node", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("R", { id: "R", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        doc.nodes.set("P", { id: "P", type: "core.path", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["R", "P"];
        const dispatcher = new ActionDispatcher(doc);
        // Not opening with M — the loader's rule, reached through the action.
        expect(dispatcher.dispatchAction(new UpdateNodePathAction(dispatcher.getDocument(), "P", [{ c: "L", x: 1, y: 1 }] as never)).success).toBe(false);
        // Path data on a rectangle.
        expect(dispatcher.dispatchAction(new UpdateNodePathAction(dispatcher.getDocument(), "R", [{ c: "M", x: 0, y: 0 }])).success).toBe(false);
        expect(dispatcher.getDocument().nodes.get("P")!.path).toBeUndefined();
    });

    test("the pen is wired as a tool and previews before it commits", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/pen: new PenTool\(/);
        expect(src).toMatch(/pendingPath: es\.pendingPath/);
        // Switching tools mid-stroke must abandon it, or the preview outlives the tool.
        expect(src).toMatch(/if \(name !== "pen" && leaving\) leaving\.cancel\(\)/);
        const model = readFileSync(resolve(__dirname, "../../renderer/RenderModel.ts"), "utf8");
        expect(model).toMatch(/state\.pendingPath && state\.pendingPath\.length > 1/);
    });
});


// ─── Vertex editing: moving the ink inside a path's box ───
describe("Path vertex editing", () => {
    /** An OPEN cubic path: M, C, C — so a middle vertex has a handle on both sides of it. */
    const curve: PathCommand[] = [
        { c: "M", x: 0, y: 0 },
        { c: "C", x1: 10, y1: -10, x2: 30, y2: -10, x: 40, y: 0 },
        { c: "C", x1: 50, y1: 10, x2: 70, y2: 10, x: 80, y: 0 }
    ];

    test("vertices are the ON-CURVE points — Z contributes none", () => {
        // Z closes back to the start, which is already listed; a handle there would be a second
        // draggable dot on one position, and dragging the phantom would do nothing.
        const closed: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "L", x: 10, y: 10 }, { c: "Z" }];
        expect(pathVertices(closed)).toEqual([
            { index: 0, x: 0, y: 0 }, { index: 1, x: 10, y: 0 }, { index: 2, x: 10, y: 10 }
        ]);

        // A path CLOSED by a drawing command back to the start stores that point twice —
        // the `M` and the final `L` are the same place. Listing both stacks two draggable
        // dots on one position, and since `movePathVertex` moves the pair together, the
        // duplicate would look like a handle that does nothing while its twin works.
        // Live verification found this; a node test asserting a count would not have.
        const drawnClosed: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "L", x: 10, y: 10 },
            { c: "L", x: 0, y: 0 }, { c: "Z" }
        ];
        expect(pathVertices(drawnClosed).map(v => v.index)).toEqual([0, 1, 2]);

        // …but a path closed by `Z` ALONE keeps all three: `Z` draws the closing line itself,
        // so no point is stored twice. Treating every closed path as having a duplicate drops
        // a real vertex from the more common shape — which is why the check compares POSITIONS
        // rather than assuming from the presence of a Z.
        expect(pathVertices(closed).map(v => v.index)).toEqual([0, 1, 2]);
        // And moving the start of a Z-closed path must not drag the unrelated last point.
        const movedZ = movePathVertex(closed, 0, 3, 3);
        expect(movedZ[0]).toEqual({ c: "M", x: 3, y: 3 });
        expect(movedZ[2]).toEqual({ c: "L", x: 10, y: 10 });
    });

    test("moving a vertex carries BOTH of its handles, so the curve translates rather than warps", () => {
        // The middle point (index 1) owns the IN handle on its own command (x2,y2) and the OUT
        // handle on the NEXT one (x1,y1). Moving the point alone would anchor the curve to where
        // the point used to be — the most obvious way for a vertex editor to feel broken.
        const moved = movePathVertex(curve, 1, 5, 5);
        expect(moved[1]).toEqual({ c: "C", x1: 10, y1: -10, x2: 35, y2: -5, x: 45, y: 5 });
        expect(moved[2]).toEqual({ c: "C", x1: 55, y1: 15, x2: 70, y2: 10, x: 80, y: 0 });
        expect(moved[0]).toEqual({ c: "M", x: 0, y: 0 });   // untouched
    });

    test("on a CLOSED path the first vertex moves its twin too, or the shape tears open", () => {
        const closed: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "L", x: 10, y: 10 },
            { c: "L", x: 0, y: 0 }, { c: "Z" }
        ];
        const moved = movePathVertex(closed, 0, -4, -4);
        expect(moved[0]).toEqual({ c: "M", x: -4, y: -4 });
        expect(moved[3]).toEqual({ c: "L", x: -4, y: -4 });   // the closing command followed it
        expect(moved[1]).toEqual({ c: "L", x: 10, y: 0 });    // and nothing else did
    });

    test("moving a vertex that does not exist changes nothing", () => {
        expect(movePathVertex(curve, 99, 5, 5)).toEqual(curve);
        const closed: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 5, y: 5 }, { c: "Z" }];
        expect(movePathVertex(closed, 2, 5, 5)).toEqual(closed);   // index 2 is the Z
        // `pathError` only requires the path to OPEN with an M, so a Z followed directly by
        // a curve is a document that loads. Without the Z guard, asking to move the Z would
        // treat the following command as "the next point" and drag its control handle — a
        // real edit to a curve nobody touched.
        const afterZ: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 5, y: 0 }, { c: "Z" },
            { c: "C", x1: 25, y1: 5, x2: 30, y2: 5, x: 35, y: 0 }
        ];
        expect(pathError("core.path", afterZ)).toBeNull();   // it really does load
        expect(movePathVertex(afterZ, 2, 7, 7)).toEqual(afterZ);
    });

    test("re-normalizing moves the BOX so it still contains the ink", () => {
        // Dragging outward leaves negative coordinates inside a box that no longer holds them.
        // The node would still DRAW correctly — the commands are placed by the world matrix —
        // but its bounds would be wrong, and bounds are what selection, snapping, culling and
        // hit-testing all read.
        const box = { x: 100, y: 100, width: 80, height: 10 };
        const dragged = movePathVertex(curve, 0, -20, -30);
        const norm = normalizePathNode(box, dragged);
        // x is exact from the endpoints (-20 → 80, so the box starts 20 to the LEFT of 100).
        expect(norm.geometry.x).toBe(80);
        expect(norm.geometry.width).toBe(100);
        // y is where the curve actually turns, NOT where its handles reach. Moving the point
        // dragged its OUT handle from (10,-10) to (-10,-40), and the old control-hull bounds
        // put the box top at that -40 — 8 units of empty margin above ink that only reaches
        // -32.01. The curve's own minimum is the root of its derivative, which is the number
        // the frame has to agree with if it is to hug the shape.
        expect(norm.geometry.y).toBeCloseTo(67.987, 3);
        expect(norm.geometry.height).toBeCloseTo(39.513, 3);
        // …and re-basing puts that same tight box at the origin.
        const rebased = pathBounds(norm.path);
        expect(rebased.x).toBe(0);
        expect(rebased.y).toBeCloseTo(0, 10);
        expect(rebased.height).toBeCloseTo(39.513, 3);
    });

    test("a normalized path is still one the LOADER accepts", () => {
        const norm = normalizePathNode({ x: 0, y: 0, width: 80, height: 10 }, movePathVertex(curve, 2, 15, -25));
        expect(pathError("core.path", norm.path)).toBeNull();
        expect(dimensionError("core.path", norm.geometry.width, norm.geometry.height)).toBeNull();
    });

    test("a selected path shows a handle per vertex, named by command index", () => {
        // The index is in the HANDLE, not re-derived from a position — two vertices can sit on
        // the same point (a closed path's first and last), and a position could not tell them apart.
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.path", parent: null, children: [], geometry: { x: 100, y: 50, width: 80, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {}, path: curve });
        doc.rootNodeUuids = ["P"];
        const handles = pathVertexHandles(doc, computeGeometry(doc), ["P"]);
        expect(handles.map(h => h.handle)).toEqual(["vertex:0", "vertex:1", "vertex:2"]);
        expect(handles[0]).toMatchObject({ nodeId: "P", cx: 100, cy: 50 });   // WORLD space
        expect(vertexIndexOf("vertex:2")).toBe(2);
        expect(vertexIndexOf("se")).toBeNull();
        // A non-path node contributes none.
        doc.nodes.set("R", { id: "R", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "R"];
        expect(pathVertexHandles(doc, computeGeometry(doc), ["R"])).toEqual([]);
    });

    test("a vertex handle is GRABBABLE, from the same list the renderer draws", () => {
        // The drift this closes: the handles were added to the renderer only, so they
        // appeared on screen and dragging one did nothing. Both sides now read one producer.
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.path", parent: null, children: [], geometry: { x: 100, y: 50, width: 80, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {}, path: curve });
        doc.rootNodeUuids = ["P"];
        const computed = computeGeometry(doc);
        const drawn = pathVertexHandles(doc, computed, ["P"]);
        for (const h of drawn) {
            expect(vertexHandleAtPoint(doc, computed, ["P"], h.cx, h.cy, 1)).toMatchObject({ handle: h.handle });
        }
        expect(vertexHandleAtPoint(doc, computed, ["P"], 9999, 9999, 1)).toBeNull();
        // …and the controller checks vertices BEFORE box corners, which sit around them.
        const src = readFileSync(resolve(__dirname, "../../editor/tools/ToolController.ts"), "utf8");
        expect(src).toMatch(/vertexHandleAtPoint\(doc, computed, roots, w\.x, w\.y, vp\.zoom\)[\s\S]{0,40}\?\?[\s\S]{0,20}handleAtPoint\(/);
    });

    test("the controller drags a vertex through the path action, box and all", () => {
        const src = readFileSync(resolve(__dirname, "../../editor/tools/ToolController.ts"), "utf8");
        expect(src).toMatch(/const vi = vertexIndexOf\(hit\.handle\);/);
        expect(src).toMatch(/movePathVertex\(node\.path, this\.vertexIndex, dx, dy\)/);
        // The BOX has to move with the ink, or bounds go stale.
        expect(src).toMatch(/normalizePathNode\(node\.geometry, moved\)/);
        // …and both halves land as ONE transaction, so a drag is one undo.
        expect(src).toMatch(/new TransactionAction\(doc, `vertex:\$\{this\.vertexNodeId\}`, actions\)/);
    });
});

// ─── Picking the SHAPE, not the box it lives in ───
describe("Shape-accurate hit-testing", () => {
    /** A node of any type with an explicit box, and optional path/style extras. */
    const shapeNode = (id: string, type: string, box: { x: number; y: number; width: number; height: number }, extra: Partial<Node> = {}): Node =>
        ({ id, type, parent: null, children: [], geometry: box, style: { fill: "#111111", opacity: 1 }, layout: {}, ...extra } as Node);

    const docWith = (...nodes: Node[]): ProjectDocument => {
        const doc = createEmptyDocument();
        for (const n of nodes) doc.nodes.set(n.id, n);
        doc.rootNodeUuids = nodes.map(n => n.id);
        return doc;
    };

    /** A right triangle filling a 100x100 box: the hypotenuse runs (0,100) to (100,0). */
    const TRIANGLE: PathCommand[] = [{ c: "M", x: 0, y: 100 }, { c: "L", x: 100, y: 100 }, { c: "L", x: 100, y: 0 }, { c: "Z" }];

    test("a triangle's EMPTY corner is not part of the triangle", () => {
        // The whole point. (10,10) is inside the node's box and nowhere near its ink — the
        // hypotenuse is x + y = 100, and the shape is the x + y > 100 side.
        const doc = docWith(shapeNode("T", "core.path", { x: 0, y: 0, width: 100, height: 100 }, { path: TRIANGLE }));
        const cs = computeGeometry(doc);
        expect(hitTest(cs, 80, 80)).toBe("T");    // inside the ink
        expect(hitTest(cs, 99, 1)).toBe("T");     // the far corner IS part of this triangle
        expect(hitTest(cs, 10, 10)).toBeNull();   // in the box, not in the shape
    });

    test("the click that misses a shape reaches what is drawn BEHIND it", () => {
        // The cost of box-picking was never the wrong selection alone — it was that the empty
        // corner of a shape on top swallowed clicks meant for the thing underneath.
        const doc = docWith(
            shapeNode("BG", "core.rectangle", { x: 0, y: 0, width: 200, height: 200 }),
            shapeNode("T", "core.path", { x: 0, y: 0, width: 100, height: 100 }, { path: TRIANGLE })
        );
        const cs = computeGeometry(doc);
        expect(hitTest(cs, 80, 80)).toBe("T");    // the triangle is in front where it has ink
        expect(hitTest(cs, 10, 10)).toBe("BG");   // and passes the click through where it has none
    });

    test("an ellipse is picked as an ellipse, corners and all", () => {
        const doc = docWith(shapeNode("E", "core.ellipse", { x: 0, y: 0, width: 100, height: 60 }));
        const cs = computeGeometry(doc);
        expect(hitTest(cs, 50, 30)).toBe("E");    // centre
        expect(hitTest(cs, 99, 1)).toBeNull();    // box corner, outside the curve
        expect(hitTest(cs, 1, 30)).toBe("E");     // on the horizontal axis, just inside the left edge
    });

    test("a line is its diagonal, not its bounding box", () => {
        const doc = docWith(shapeNode("L", "core.line", { x: 0, y: 0, width: 100, height: 100 }));
        const cs = computeGeometry(doc);
        expect(hitTest(cs, 50, 51, 2)).toBe("L");   // ~0.7 from the diagonal
        expect(hitTest(cs, 90, 10, 2)).toBeNull();  // the far corner of the box, 56 away from the ink
        // A SEGMENT, not the infinite line through it: (-20,-20) sits exactly on the diagonal's
        // extension, 28 beyond the end. Without the clamp it would measure as distance zero and
        // a line would be grabbable from anywhere along the ray it points down.
        expect(hitsShape({ kind: "line" }, 100, 100, -20, -20, 2)).toBe(false);
    });

    test("a rounded rectangle's cut-off corner is outside it", () => {
        const round = docWith(shapeNode("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }, { style: { fill: "#111111", opacity: 1, radius: 20 } }));
        const square = docWith(shapeNode("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }));
        // (2,2) is 18,18 past the corner arc's centre: 18^2 + 18^2 = 648 > 20^2.
        expect(hitTest(computeGeometry(round), 2, 2)).toBeNull();
        expect(hitTest(computeGeometry(square), 2, 2)).toBe("R");   // same point, no radius
        expect(hitTest(computeGeometry(round), 50, 2)).toBe("R");   // the straight edge between the arcs
    });

    test("a radius past half the shorter side draws a circle, and picks like one", () => {
        // The clamp. An unclamped 200 on a 100x100 box would put the arc centres 200 in from
        // each edge — outside the box entirely — and shrink the pickable region to nothing,
        // while the renderer draws a plain circle. (20,20) is 42.4 from the centre, inside a
        // radius-50 circle and nowhere near an arc centred at (200,200).
        const doc = docWith(shapeNode("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }, { style: { fill: "#111111", opacity: 1, radius: 200 } }));
        expect(hitTest(computeGeometry(doc), 20, 20)).toBe("R");
        expect(hitTest(computeGeometry(doc), 5, 5)).toBeNull();   // still outside the circle
    });

    test("an UNFILLED path is only its stroke", () => {
        // Three sides of a square, never closed, painted with no fill: the middle is air, and
        // a click there has to reach whatever is behind rather than grabbing the stroke's node.
        const open: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 100 }, { c: "L", x: 0, y: 100 }];
        const doc = docWith(shapeNode("O", "core.path", { x: 0, y: 0, width: 100, height: 100 }, { path: open, style: { fill: "none", opacity: 1 } }));
        const cs = computeGeometry(doc);
        expect(hitTest(cs, 50, 1, 2)).toBe("O");     // on the stroke
        expect(hitTest(cs, 50, 50, 2)).toBeNull();   // in the middle: 50 from every segment
    });

    test("…but a FILLED path is picked over its fill, closed or not", () => {
        // Found in the live app: a pen stroke finished with Enter is OPEN, and both backends
        // close it implicitly when they fill it — so it paints a solid region. Gating the
        // interior on an explicit `Z` made that shape selectable only along its own edge,
        // while it drew as a solid lump. Picking follows the PAINT, not the punctuation.
        const open: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 100 }, { c: "L", x: 0, y: 100 }];
        const doc = docWith(shapeNode("F", "core.path", { x: 0, y: 0, width: 100, height: 100 }, { path: open }));
        expect(hitTest(computeGeometry(doc), 50, 50, 2)).toBe("F");
        // "none", "" and "transparent" are the three ways a document says "no paint".
        expect(isPaintBearing("#ff0000")).toBe(true);
        expect(isPaintBearing("  NONE ")).toBe(false);
        expect(isPaintBearing("")).toBe(false);
        expect(isPaintBearing("transparent")).toBe(false);
    });

    test("a rotated shape hits where it is DRAWN", () => {
        // The test runs in local space through the inverse world matrix, so rotation needs no
        // special case — but it is the case that proves the shape travels with the node.
        const doc = docWith(shapeNode("T", "core.path", { x: 0, y: 0, width: 100, height: 100 }, { path: TRIANGLE, transform: { rotation: Math.PI } }));
        const cs = computeGeometry(doc);
        // A half-turn about the box centre maps local (80,80) to world (20,20) and back.
        expect(hitTest(cs, 20, 20)).toBe("T");
        expect(hitTest(cs, 90, 90)).toBeNull();
    });

    test("a donut has a HOLE: opposite windings cancel", () => {
        // Two closed subpaths wound in opposite directions. Nonzero — the rule both backends
        // fill with — cancels them to 0 in the middle, so the hole is not clickable, which is
        // the only answer that matches what is painted.
        const donut: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 100 }, { c: "L", x: 0, y: 100 }, { c: "Z" },
            { c: "M", x: 30, y: 30 }, { c: "L", x: 30, y: 70 }, { c: "L", x: 70, y: 70 }, { c: "L", x: 70, y: 30 }, { c: "Z" }
        ];
        const doc = docWith(shapeNode("D", "core.path", { x: 0, y: 0, width: 100, height: 100 }, { path: donut }));
        const cs = computeGeometry(doc);
        expect(hitTest(cs, 10, 50)).toBe("D");     // the ring
        expect(hitTest(cs, 50, 50)).toBeNull();    // the hole
    });

    test("nonzero, not even-odd: a doubly-wound region is solid", () => {
        // The same square traced twice in the same direction. Even-odd counts two crossings and
        // calls the middle a hole; nonzero counts winding 2 and calls it solid — and solid is
        // what SVG's default fill-rule and Canvas's fill() both paint.
        const twice: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 100 }, { c: "L", x: 0, y: 100 },
            { c: "L", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 100 }, { c: "L", x: 0, y: 100 }, { c: "Z" }
        ];
        expect(hitsShape({ kind: "path", commands: twice, filled: true }, 100, 100, 50, 50, 0)).toBe(true);
    });

    test("flattening splits at every M and closes only on Z", () => {
        const cmds: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "Z" },
            { c: "M", x: 20, y: 0 }, { c: "L", x: 30, y: 0 }
        ];
        const subs = flattenPath(cmds);
        expect(subs.map(s => s.closed)).toEqual([true, false]);
        expect(subs.map(s => s.points.length)).toEqual([2, 2]);
        // An `M` with no `Z` before it STILL starts a new run — otherwise two separate strokes
        // join into one, and the phantom segment between them is pickable ink nobody drew.
        const noZ = flattenPath([{ c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "M", x: 90, y: 0 }, { c: "L", x: 99, y: 0 }]);
        expect(noZ.map(s => s.points.length)).toEqual([2, 2]);
        // A curve becomes a polyline of fixed length — deterministic, so a pick cannot depend
        // on the zoom it happened to be taken at.
        const curved = flattenPath([{ c: "M", x: 0, y: 0 }, { c: "C", x1: 0, y1: 10, x2: 10, y2: 10, x: 10, y: 0 }]);
        expect(curved[0].points.length).toBe(17);          // the start point + 16 segments
        expect(curved[0].points[16]).toEqual({ x: 10, y: 0 });  // and it lands exactly on the endpoint
    });

    test("the pick halo still reaches a zero-extent node", () => {
        // The tolerance's original job, unchanged by the shape test: an axis-aligned line has
        // no area at all, so without a halo only a mathematically exact click could select it.
        const doc = docWith(shapeNode("H", "core.line", { x: 0, y: 50, width: 100, height: 0 }));
        const cs = computeGeometry(doc);
        expect(hitTest(cs, 50, 52, 3)).toBe("H");
        expect(hitTest(cs, 50, 52, 0)).toBeNull();
    });
});

// ─── The selection frame is the node's OWN box, turned with it ───
describe("Oriented selection frame", () => {
    const mkNode = (id: string, box: { x: number; y: number; width: number; height: number }, transform?: Node["transform"]): Node =>
        ({ id, type: "core.rectangle", parent: null, children: [], geometry: box, style: { fill: "#111111", opacity: 1 }, layout: {}, ...(transform ? { transform } : {}) } as Node);
    const docOf = (n: Node): ProjectDocument => {
        const doc = createEmptyDocument();
        doc.nodes.set(n.id, n);
        doc.rootNodeUuids = [n.id];
        return doc;
    };

    test("a 45°-turned square's frame is a diamond, not the square that contains it", () => {
        // The AABB of a 100x100 square turned 45° is 141.42 on a side, and NONE of its corners
        // touch the node. That box was the old selection frame: visibly bigger than the shape,
        // with four handles floating in empty space.
        const doc = docOf(mkNode("A", { x: 0, y: 0, width: 100, height: 100 }, { rotation: Math.PI / 4 }));
        const cs = computeGeometry(doc);
        const q = selectionFrame(cs, "A")!;
        const d = 50 * Math.SQRT2;                       // half-diagonal: 70.71
        expect(q[0].x).toBeCloseTo(50, 6); expect(q[0].y).toBeCloseTo(50 - d, 6);   // nw → top point
        expect(q[1].x).toBeCloseTo(50 + d, 6); expect(q[1].y).toBeCloseTo(50, 6);   // ne → right point
        expect(q[2].x).toBeCloseTo(50, 6); expect(q[2].y).toBeCloseTo(50 + d, 6);   // se → bottom point
        expect(q[3].x).toBeCloseTo(50 - d, 6); expect(q[3].y).toBeCloseTo(50, 6);   // sw → left point
        // The AABB's own corner, for contrast — a point the frame no longer visits.
        expect(cs.nodes.get("A")!.bounds.x).toBeCloseTo(50 - d, 6);
    });

    test("handles sit on those corners, and each cursor points the way its corner does", () => {
        const doc = docOf(mkNode("A", { x: 0, y: 0, width: 100, height: 100 }, { rotation: Math.PI / 4 }));
        const hs = selectionHandles(computeGeometry(doc), ["A"], 1);
        const d = 50 * Math.SQRT2;
        expect(hs.map(h => h.handle)).toEqual(["nw", "ne", "sw", "se", "rotate"]);
        expect(hs[0].cx).toBeCloseTo(50, 6);
        expect(hs[0].cy).toBeCloseTo(50 - d, 6);
        // `nw` is still the box's top-left, but on screen it now points straight UP — so the
        // cursor has to be the vertical one, not the fixed diagonal it used to carry.
        expect(hs[0].cursor).toBe("ns-resize");
        expect(hs[1].cursor).toBe("ew-resize");   // `ne` points right
        // …and the knob rides the TURNED top edge: its midpoint is (50 + d/2, 50 − d/2), and the
        // knob sits ROTATE_OFFSET_PX further out along that same up-and-right diagonal.
        const off = ROTATE_OFFSET_PX * Math.SQRT1_2;
        expect(hs[4].cx).toBeCloseTo(50 + d / 2 + off, 6);
        expect(hs[4].cy).toBeCloseTo(50 - d / 2 - off, 6);
    });

    test("the frame's padding is the same distance off every edge, whatever the scale", () => {
        // The pad is a SCREEN distance, so it converts into local units per axis. A node scaled
        // 2x horizontally needs half as much local padding on that axis to sit the same distance
        // away on screen — a single local pad would show a fat gap on one side and a thin one on
        // the other.
        const doc = docOf(mkNode("A", { x: 0, y: 0, width: 100, height: 100 }, { scaleX: 2, scaleY: 1 }));
        const cs = computeGeometry(doc);
        const bare = selectionFrame(cs, "A")!;
        const padded = selectionFrame(cs, "A", 4)!;
        expect(padded[0].x).toBeCloseTo(bare[0].x - 4, 6);   // 4 world units left of the corner
        expect(padded[0].y).toBeCloseTo(bare[0].y - 4, 6);   // …and 4 above it
        expect(padded[2].x).toBeCloseTo(bare[2].x + 4, 6);
        expect(padded[2].y).toBeCloseTo(bare[2].y + 4, 6);

        // Rotation AND non-uniform scale together, which is the only arrangement that tells the
        // matrix's COLUMNS (the transformed axes — what an axis length is) apart from its rows.
        // A quarter turn with scaleX 2 sends local +x down at double length and local +y left at
        // single, so the frame's corner steps 4 world units along each of those two directions.
        const skewed = docOf(mkNode("B", { x: 0, y: 0, width: 100, height: 100 }, { rotation: Math.PI / 2, scaleX: 2, scaleY: 1 }));
        const cs2 = computeGeometry(skewed);
        const b2 = selectionFrame(cs2, "B")!, p2 = selectionFrame(cs2, "B", 4)!;
        expect(p2[0].x).toBeCloseTo(b2[0].x + 4, 6);
        expect(p2[0].y).toBeCloseTo(b2[0].y - 4, 6);
    });

    test("a degenerate node contributes no frame rather than NaN corners", () => {
        const doc = docOf(mkNode("A", { x: 0, y: 0, width: 10, height: 10 }));
        const cs = computeGeometry(doc);
        cs.nodes.get("A")!.bounds.width = NaN;
        expect(selectionFrame(cs, "A")).toBeNull();
        expect(selectionFrame(cs, "missing")).toBeNull();
    });
});

// ─── Resizing runs along the node's OWN axes ───
describe("Oriented resize", () => {
    const rect = { left: 0, top: 0 } as DOMRect;
    const md = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);

    /** A 100x50 node turned a quarter turn: its local +x axis points DOWN in world. */
    const turned = () => {
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 100, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {}, transform: { rotation: Math.PI / 2 } });
        doc.rootNodeUuids = ["A"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A"];
        return { dispatcher, es, tc: new ToolController(dispatcher, es, () => { }) };
    };

    test("dragging a corner grows the axis the user is pulling along, not the world one", () => {
        // The quarter turn puts the box's WIDTH axis along world +y. Pulling the `se` handle
        // DOWNWARD must therefore make the node wider, not taller. Applying the world delta
        // straight to width/height — what it used to do — grew the wrong side entirely.
        const { dispatcher, tc } = turned();
        tc.onMouseDown(md(25, 75), rect);    // the `se` corner in world
        tc.onMouseMove(md(25, 95), rect);    // 20 world units DOWN = +20 along the node's width
        tc.onMouseUp(md(25, 95));
        const g = dispatcher.getDocument().nodes.get("A")!.geometry;
        expect(g.width).toBeCloseTo(120, 6);
        expect(g.height).toBeCloseTo(50, 6);
    });

    test("…and the opposite corner stays exactly where it is drawn", () => {
        // The compensation that makes the drag feel anchored. A node rotates about a point given
        // as a FRACTION of its size, so changing the size moves that point and swings the whole
        // box; without correcting the stored position for it, the corner the user is not touching
        // slides out from under itself as soon as the drag starts.
        const { dispatcher, tc } = turned();
        const before = selectionFrame(computeGeometry(dispatcher.getDocument()), "A")![0];
        expect(before.x).toBeCloseTo(75, 6);
        expect(before.y).toBeCloseTo(-25, 6);
        tc.onMouseDown(md(25, 75), rect);
        tc.onMouseMove(md(25, 95), rect);
        tc.onMouseUp(md(25, 95));
        const after = selectionFrame(computeGeometry(dispatcher.getDocument()), "A")![0];
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
        // The stored box moved to pay for the origin shift — the corner staying put is the point.
        expect(dispatcher.getDocument().nodes.get("A")!.geometry).toMatchObject({ x: -10, y: 10 });
    });

    test("dragging a corner past its opposite CLAMPS instead of flipping the box", () => {
        // A deliberate change: the old world-space maths let the box invert through the fixed
        // corner (min/max on the two x's). Under a rotation-origin that is a confusing state to
        // land in, and the minimum was already being clamped to 1 — so it now stops there.
        const { dispatcher, tc } = turned();
        tc.onMouseDown(md(25, 75), rect);
        tc.onMouseMove(md(25, -500), rect);   // far past the fixed corner
        tc.onMouseUp(md(25, -500));
        const g = dispatcher.getDocument().nodes.get("A")!.geometry;
        expect(g.width).toBe(1);
        expect(g.height).toBeGreaterThan(0);
    });

    test("an unrotated node resizes exactly as before", () => {
        // The identity case has to be untouched: `m = I` collapses the compensation to the
        // familiar "move the origin by the corner delta", which is what every existing test asserts.
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: [], geometry: { x: 10, y: 20, width: 100, height: 50 }, style: { fill: "#000", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["A"];
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState(); es.selectedNodeIds = ["A"];
        const tc = new ToolController(dispatcher, es, () => { });
        tc.onMouseDown(md(10, 20), rect);     // the `nw` corner
        tc.onMouseMove(md(0, 10), rect);      // out and up by 10
        tc.onMouseUp(md(0, 10));
        expect(dispatcher.getDocument().nodes.get("A")!.geometry).toEqual({ x: 0, y: 10, width: 110, height: 60 });
    });

    test("worldDeltaToLocal and localLinear invert the frame they are given", () => {
        const w = compose(0, 0, Math.PI / 2, 1, 1, 50, 25);
        const d = worldDeltaToLocal(w, 0, 20);            // straight down in world
        expect(d.x).toBeCloseTo(20, 10);                  // = along the node's +x
        expect(d.y).toBeCloseTo(0, 10);
        // SCALE is what makes the determinant matter: 20 world units along an axis drawn at 2x
        // is only 10 of the node's own units, and a drag that skipped the division would grow
        // the box twice as fast as the pointer moved.
        const scaled = compose(0, 0, 0, 2, 1, 0, 0);
        expect(worldDeltaToLocal(scaled, 20, 0).x).toBeCloseTo(10, 10);
        expect(worldDeltaToLocal(scaled, 0, 20).y).toBeCloseTo(20, 10);
        // A collapsed transform has no invertible direction; answer zero rather than Infinity.
        expect(worldDeltaToLocal({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, 5, 5)).toEqual({ x: 0, y: 0 });
        // localLinear strips the PARENT: a child of a turned parent, itself unturned, is identity.
        const parent = compose(0, 0, Math.PI / 2, 1, 1, 0, 0);
        const l = localLinear(parent, parent);
        expect(l.a).toBeCloseTo(1, 10); expect(l.b).toBeCloseTo(0, 10);
        expect(l.c).toBeCloseTo(0, 10); expect(l.d).toBeCloseTo(1, 10);
    });

    test("cursorForDirection names the nearest of the four CSS resize cursors", () => {
        expect(cursorForDirection(1, 1)).toBe("nwse-resize");
        expect(cursorForDirection(1, -1)).toBe("nesw-resize");
        expect(cursorForDirection(-1, -1)).toBe("nwse-resize");   // opposite directions share one
        expect(cursorForDirection(1, 0)).toBe("ew-resize");
        expect(cursorForDirection(0, 1)).toBe("ns-resize");
        expect(cursorForDirection(0, 0)).toBe("nwse-resize");     // no direction → a stable default
    });
});

// ─── Boolean operations on closed shapes ───
describe("Path booleans", () => {
    /** A square as a ring, clockwise on screen (y down) — the winding `ringsToCommands` emits. */
    const sq = (x: number, y: number, w: number, h: number) =>
        [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

    /** A point as a stable string, for counting distinct edges. */
    const key2 = (p: { x: number; y: number }): string => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;

    /** Signed area by the shoelace formula, summed over rings — a hole subtracts. */
    const area = (rings: { x: number; y: number }[][]): number =>
        rings.reduce((sum, r) => {
            let a = 0;
            for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j].x * r[i].y - r[i].x * r[j].y;
            return sum + a / 2;
        }, 0);

    // Two 100×100 squares overlapping in a 50×50 corner: the areas are all exact integers, which
    // is what makes every operation checkable by one number instead of by vertex lists.
    const A = [sq(0, 0, 100, 100)];
    const B = [sq(50, 50, 100, 100)];

    test("union keeps both, minus the seam through the overlap", () => {
        const r = booleanRings(A, B, "union");
        expect(area(r)).toBeCloseTo(17500, 6);   // 10000 + 10000 − 2500 counted twice
        expect(r.length).toBe(1);                 // one L-shaped ring, not two squares
        // EIGHT vertices — the L's own corners and no others. An edge must only be split where
        // it actually meets the other SEGMENT, not where it meets the infinite line through it:
        // those phantom cuts leave the area right and litter the result with collinear vertices,
        // which every later operation then has to carry.
        expect(r[0].length).toBe(8);
    });

    test("an edge that crosses the other shape TWICE is split in order along itself", () => {
        // A bar straight through the square: each of its long edges meets the square twice, so
        // the crossing list per edge has two entries and the pieces are only contiguous if that
        // list is sorted. Unsorted, the splits interleave and the walk chains the wrong ends.
        const bar = [sq(-50, 40, 200, 20)];
        expect(area(booleanRings(A, bar, "union"))).toBeCloseTo(12000, 6);   // 10000 + 4000 − 2000
        const x = booleanRings(A, bar, "exclude");
        expect(area(x)).toBeCloseTo(10000, 6);   // the square in two halves + the bar's two ends
        // The four surviving regions touch at the crossing points, so they come back CONNECTED
        // through those vertices rather than as four separate rings — same region either way, and
        // the region is what matters, so it is sampled directly rather than counted.
        expect(insideRings(x, 50, 50)).toBe(false);   // the overlap: excluded
        expect(insideRings(x, 50, 20)).toBe(true);    // the square above the bar
        expect(insideRings(x, 50, 80)).toBe(true);    // …and below it
        expect(insideRings(x, -25, 50)).toBe(true);   // the bar's left end, outside the square
    });

    test("a vertex where several pieces meet hands out each continuation exactly once", () => {
        // Four pieces meet at each of the bar's crossing points. A walk that re-read a piece
        // instead of consuming it would either loop on one edge or leave another ring unclosed.
        const bar = [sq(-50, 40, 200, 20)];
        const rings = booleanRings(A, bar, "exclude");
        const edges = rings.flatMap(r => r.map((p, i) => `${key2(p)}->${key2(r[(i + 1) % r.length])}`));
        expect(new Set(edges).size).toBe(edges.length);   // no edge appears twice
    });

    test("the output has no zero-length edges, even when the input had a repeated vertex", () => {
        // A repeated vertex is a directionless edge: it chains to itself, and it is a latent
        // zero-length edge for whatever operation runs on the result next.
        const doubled = [[{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]];
        const r = booleanRings(doubled, B, "union");
        expect(area(r)).toBeCloseTo(17500, 6);
        for (const ring of r) {
            for (let i = 0; i < ring.length; i++) {
                const next = ring[(i + 1) % ring.length];
                expect(Math.hypot(ring[i].x - next.x, ring[i].y - next.y)).toBeGreaterThan(1e-9);
            }
        }
    });

    test("intersect keeps only the overlap", () => {
        const r = booleanRings(A, B, "intersect");
        expect(area(r)).toBeCloseTo(2500, 6);
        expect(r.length).toBe(1);
    });

    test("subtract removes B from A, and is not symmetric", () => {
        expect(area(booleanRings(A, B, "subtract"))).toBeCloseTo(7500, 6);
        expect(area(booleanRings(B, A, "subtract"))).toBeCloseTo(7500, 6);
        // …but they are different shapes: A−B keeps A's top-left corner, B−A keeps B's bottom-right.
        const ab = booleanRings(A, B, "subtract")[0];
        const ba = booleanRings(B, A, "subtract")[0];
        expect(ab.some(p => p.x === 0 && p.y === 0)).toBe(true);
        expect(ba.some(p => p.x === 0 && p.y === 0)).toBe(false);
    });

    test("exclude keeps both minus the overlap", () => {
        const r = booleanRings(A, B, "exclude");
        expect(area(r)).toBeCloseTo(15000, 6);   // 17500 − 2500
    });

    test("shapes that do not touch are returned unchanged by union, and vanish under intersect", () => {
        const far = [sq(500, 500, 10, 10)];
        expect(area(booleanRings(A, far, "union"))).toBeCloseTo(10100, 6);
        expect(booleanRings(A, far, "intersect")).toEqual([]);
        expect(area(booleanRings(A, far, "subtract"))).toBeCloseTo(10000, 6);
    });

    test("a shape fully inside another becomes a HOLE when subtracted", () => {
        // The reversal that makes subtract work: the inner ring must run the opposite way, or
        // the nonzero rule fills the hole straight back in.
        const outer = [sq(0, 0, 100, 100)];
        const inner = [sq(25, 25, 50, 50)];
        const r = booleanRings(outer, inner, "subtract");
        expect(area(r)).toBeCloseTo(10000 - 2500, 6);
        expect(r.length).toBe(2);                                  // the outline and the hole
        // …and the hole is genuinely a hole: a point in the middle is no longer inside.
        expect(insideRings(r, 50, 50)).toBe(false);
        expect(insideRings(r, 5, 5)).toBe(true);
    });

    test("the result round-trips through commands and back", () => {
        const cmds = booleanPaths(ringsToCommands(A), ringsToCommands(B), "union");
        expect(pathError("core.path", cmds)).toBeNull();           // the LOADER would accept it
        expect(cmds[0].c).toBe("M");
        expect(cmds[cmds.length - 1].c).toBe("Z");
        expect(area(commandsToRings(cmds))).toBeCloseTo(17500, 6);
    });

    test("an open subpath is treated as closed, like the fill that paints it", () => {
        const open: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 100 }, { c: "L", x: 0, y: 100 }];
        expect(area(commandsToRings(open))).toBeCloseTo(10000, 6);
        // …and a closing point that repeats the start is not stored twice (it would be a
        // zero-length edge, which carries no direction to chain by).
        const closed: PathCommand[] = [...open, { c: "L", x: 0, y: 0 }, { c: "Z" }];
        expect(commandsToRings(closed)[0].length).toBe(4);
    });

    test("curves are flattened, so a boolean on them is polygonal — and says so by its point count", () => {
        // A circle-ish shape made of two cubics. The result is a polyline, not curves — this
        // records the LOSS honestly rather than pretending the curve survives a boolean.
        const blob: PathCommand[] = [
            { c: "M", x: 0, y: 50 },
            { c: "C", x1: 0, y1: 0, x2: 100, y2: 0, x: 100, y: 50 },
            { c: "C", x1: 100, y1: 100, x2: 0, y2: 100, x: 0, y: 50 },
            { c: "Z" }
        ];
        const rings = commandsToRings(blob);
        expect(rings.length).toBe(1);
        // The point count is no longer a constant to pin: subdivision follows the curve's own
        // flatness, so a 100-unit blob takes what it takes. What is worth asserting is that it
        // IS a polyline of real segments, and that the shape survives — see the flattening
        // tolerance tests for the accuracy claim itself.
        expect(rings[0].length).toBeGreaterThan(4);
        const cut = booleanPaths(blob, ringsToCommands([sq(-10, -10, 60, 200)]), "subtract");
        expect(cut.length).toBeGreaterThan(3);
        expect(pathError("core.path", cut)).toBeNull();
    });

    test("a run that cannot be closed is dropped, never emitted as an open ring", () => {
        // Degenerate input: a "ring" of two points has no area and no third vertex to chain
        // through. It must not produce a phantom shape.
        const degenerate = [[{ x: 0, y: 0 }, { x: 10, y: 10 }]];
        expect(booleanRings(degenerate, A, "union").every(r => r.length >= 3)).toBe(true);
        expect(booleanRings(A, degenerate, "intersect")).toEqual([]);
    });
});

// ─── Any shape as a path, and the combine that uses it ───
describe("Shape to path, and boolean actions", () => {
    const mk = (id: string, type: string, box: { x: number; y: number; width: number; height: number }, extra: Partial<Node> = {}): Node =>
        ({ id, type, parent: null, children: [], geometry: box, style: { fill: "#111111", opacity: 1 }, layout: {}, ...extra } as Node);
    const docOf = (...nodes: Node[]): ProjectDocument => {
        const doc = createEmptyDocument();
        for (const n of nodes) doc.nodes.set(n.id, n);
        doc.rootNodeUuids = nodes.map(n => n.id);
        return doc;
    };
    const area = (rings: { x: number; y: number }[][]): number =>
        rings.reduce((sum, r) => {
            let a = 0;
            for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j].x * r[i].y - r[i].x * r[j].y;
            return sum + a / 2;
        }, 0);

    test("an ellipse converts to four cubics that trace the same curve the renderer draws", () => {
        const cmds = ellipseCommands(100, 60);
        expect(cmds.map(c => c.c)).toEqual(["M", "C", "C", "C", "C", "Z"]);
        // The four quadrant points are exact; only the control points are the approximation.
        expect(cmds[0]).toEqual({ c: "M", x: 50, y: 0 });
        expect(cmds[1]).toMatchObject({ x: 100, y: 30 });
        expect(cmds[2]).toMatchObject({ x: 50, y: 60 });
        expect(cmds[3]).toMatchObject({ x: 0, y: 30 });
        // Measured as a region it comes out 0.13% under πab. That deficit is the FLATTENING —
        // 64 chords inscribed in the curve, which a 64-gon's (n/2)r²sin(2π/n) predicts to 0.16%
        // — not the kappa cubic, whose own error is an order of magnitude smaller. Asserted as a
        // ratio so the claim is about relative accuracy rather than about a scale-dependent gap.
        expect(area(commandsToRings(cmds)) / (Math.PI * 50 * 30)).toBeCloseTo(1, 2);
        expect(pathError("core.path", cmds)).toBeNull();
    });

    test("a rectangle converts to four lines, and a ROUNDED one to lines plus corner arcs", () => {
        expect(rectCommands(80, 40).map(c => c.c)).toEqual(["M", "L", "L", "L", "Z"]);
        expect(rectCommands(80, 40, 10).map(c => c.c)).toEqual(["M", "L", "C", "L", "C", "L", "C", "L", "C", "Z"]);
        // A zero radius must NOT emit four degenerate curves collapsed onto their endpoints.
        expect(rectCommands(80, 40, 0).length).toBe(5);
        // The radius is clamped exactly as picking and drawing clamp it: past half the shorter
        // side a rectangle IS a stadium, and three different answers would be three shapes.
        const stadium = rectCommands(80, 40, 999);
        expect(area(commandsToRings(stadium))).toBeCloseTo(Math.PI * 20 * 20 + 40 * 40, -1);
    });

    test("a line has no interior, so it converts to nothing rather than a sliver", () => {
        expect(shapeToCommands({ kind: "line" }, 100, 100)).toBeNull();
        expect(shapeToCommands({ kind: "path", commands: [], filled: true }, 10, 10)).toBeNull();
    });

    test("transformCommands carries control points through the matrix too", () => {
        const m = compose(10, 20, 0, 2, 1, 0, 0);
        const out = transformCommands(m, [{ c: "M", x: 0, y: 0 }, { c: "C", x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 }, { c: "Z" }]);
        expect(out[0]).toEqual({ c: "M", x: 10, y: 20 });
        expect(out[1]).toEqual({ c: "C", x1: 12, y1: 22, x2: 16, y2: 24, x: 20, y: 26 });
        expect(out[2]).toEqual({ c: "Z" });
    });

    test("a rectangle and an ellipse can be combined, because both become paths first", () => {
        // The reason the conversion exists: a boolean is defined on outlines, not node types.
        const doc = docOf(
            mk("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }),
            mk("E", "core.ellipse", { x: 50, y: 50, width: 100, height: 100 })
        );
        const dispatcher = new ActionDispatcher(doc);
        const action = booleanAction(doc, computeGeometry(doc), ["R", "E"], "union", "OUT")!;
        expect(action).not.toBeNull();
        expect(dispatcher.dispatchAction(action).success).toBe(true);
        const after = dispatcher.getDocument();
        expect(after.nodes.has("R")).toBe(false);          // the operands are consumed
        expect(after.nodes.has("E")).toBe(false);
        const out = after.nodes.get("OUT")!;
        expect(out.type).toBe("core.path");
        expect(out.path!.length).toBeGreaterThan(4);
        // Union of a 100x100 square and a circle of radius 50 overlapping in one corner.
        expect(area(commandsToRings(out.path!))).toBeGreaterThan(10000);
        expect(pathError("core.path", out.path!)).toBeNull();
    });

    test("the whole combine is ONE undo, and undo brings both operands back", () => {
        const doc = docOf(
            mk("A", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }),
            mk("B", "core.rectangle", { x: 50, y: 50, width: 100, height: 100 })
        );
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(booleanAction(doc, computeGeometry(doc), ["A", "B"], "union", "U")!);
        // The combine has to have HAPPENED before the undo means anything: the operands gone,
        // the result there. Checking only the post-undo state would pass for an action that
        // created the result and never removed what it replaced.
        const mid = dispatcher.getDocument();
        expect(mid.nodes.has("A")).toBe(false);
        expect(mid.nodes.has("B")).toBe(false);
        expect(mid.nodes.has("U")).toBe(true);
        dispatcher.undo();
        const back = dispatcher.getDocument();
        expect(back.nodes.has("A")).toBe(true);
        expect(back.nodes.has("B")).toBe(true);
        expect(back.nodes.has("U")).toBe(false);
    });

    test("the result is re-based onto its own box, and inherits the BOTTOM shape's paint", () => {
        const doc = docOf(
            mk("A", "core.rectangle", { x: 200, y: 300, width: 100, height: 100 }, { style: { fill: "#ff0000", opacity: 1 } }),
            mk("B", "core.rectangle", { x: 250, y: 350, width: 100, height: 100 }, { style: { fill: "#00ff00", opacity: 1 } })
        );
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(booleanAction(doc, computeGeometry(doc), ["A", "B"], "union", "U")!);
        const out = dispatcher.getDocument().nodes.get("U")!;
        expect(out.geometry).toMatchObject({ x: 200, y: 300, width: 150, height: 150 });
        expect(pathBounds(out.path!)).toEqual({ x: 0, y: 0, width: 150, height: 150 });  // local to its box
        expect(out.style.fill).toBe("#ff0000");   // A is bottom-most in draw order
    });

    test("subtract cuts the shapes ABOVE out of the bottom one, whatever order they were clicked", () => {
        const doc = docOf(
            mk("A", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }),
            mk("B", "core.rectangle", { x: 50, y: 50, width: 100, height: 100 })
        );
        const forwards = new ActionDispatcher(docOf(
            mk("A", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }),
            mk("B", "core.rectangle", { x: 50, y: 50, width: 100, height: 100 })
        ));
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(booleanAction(doc, computeGeometry(doc), ["B", "A"], "subtract", "U")!);   // clicked top-first
        forwards.dispatchAction(booleanAction(forwards.getDocument(), computeGeometry(forwards.getDocument()), ["A", "B"], "subtract", "U")!);
        // Both keep A (the bottom shape) minus B: 7500, and the box starts at A's origin.
        expect(area(commandsToRings(dispatcher.getDocument().nodes.get("U")!.path!))).toBeCloseTo(7500, 3);
        expect(dispatcher.getDocument().nodes.get("U")!.geometry).toMatchObject({ x: 0, y: 0 });
        expect(forwards.getDocument().nodes.get("U")!.geometry).toMatchObject({ x: 0, y: 0 });
    });

    test("an impossible combine changes nothing at all", () => {
        const apart = docOf(
            mk("A", "core.rectangle", { x: 0, y: 0, width: 10, height: 10 }),
            mk("B", "core.rectangle", { x: 500, y: 500, width: 10, height: 10 })
        );
        // Intersecting shapes that do not overlap would otherwise delete both and leave a
        // zero-area node — work destroyed to produce nothing.
        expect(booleanAction(apart, computeGeometry(apart), ["A", "B"], "intersect", "U")).toBeNull();
        // One node is not a combine, and neither is a node with no interior.
        const one = docOf(mk("A", "core.rectangle", { x: 0, y: 0, width: 10, height: 10 }));
        expect(booleanAction(one, computeGeometry(one), ["A"], "union", "U")).toBeNull();
        const withLine = docOf(
            mk("A", "core.rectangle", { x: 0, y: 0, width: 10, height: 10 }),
            mk("L", "core.line", { x: 0, y: 0, width: 10, height: 10 })
        );
        expect(booleanAction(withLine, computeGeometry(withLine), ["A", "L"], "union", "U")).toBeNull();
    });

    test("the toolbar's boolean buttons combine the selection and select the result", () => {
        // The row is gated on a MULTI-selection, like align — and the result must become the
        // selection, or the user is left holding ids for shapes the combine just deleted.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/BOOLEAN_BUTTONS\.map\(\(\[op, glyph, label\]\)/);
        // Tied together in ONE match: `es.selectedNodeIds = [id]` also appears in the asset
        // placer, so asserting it alone would pass even with the boolean handler's copy deleted.
        expect(src).toMatch(/booleanAction\(doc, computeGeometry\(doc\), es\.selectedNodeIds, op, id\)[\s\S]{0,240}es\.selectedNodeIds = \[id\]/);
        // All four operations are offered, not a subset.
        for (const op of ["union", "subtract", "intersect", "exclude"]) expect(src).toContain(`"${op}"`);
    });

    test("a ROTATED operand is combined where it is drawn", () => {
        // World space is the only space two nodes with different transforms share. Combining in
        // stored coordinates would use the un-rotated boxes — shapes that are not on screen.
        const doc = docOf(
            mk("A", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }),
            mk("B", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }, { transform: { rotation: Math.PI / 4 } })
        );
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(booleanAction(doc, computeGeometry(doc), ["A", "B"], "union", "U")!);
        const g = dispatcher.getDocument().nodes.get("U")!.geometry;
        // The turned square reaches 50·√2 from the centre, so the union is wider than 100.
        expect(g.width).toBeCloseTo(100 * Math.SQRT2, 3);
        expect(g.x).toBeCloseTo(50 - 50 * Math.SQRT2, 3);
    });
});

// ─── A LIVE boolean: the operands stay, the shape is derived ───
describe("core.boolean — the non-destructive combine", () => {
    const mk = (id: string, box: { x: number; y: number; width: number; height: number }, extra: Partial<Node> = {}): Node =>
        ({ id, type: "core.rectangle", parent: null, children: [], geometry: box, style: { fill: "#111111", opacity: 1 }, layout: {}, ...extra } as Node);
    const docOf = (...nodes: Node[]): ProjectDocument => {
        const doc = createEmptyDocument();
        for (const n of nodes) doc.nodes.set(n.id, n);
        doc.rootNodeUuids = nodes.filter(n => n.parent == null).map(n => n.id);
        return doc;
    };
    const area = (rings: { x: number; y: number }[][]): number =>
        rings.reduce((sum, r) => {
            let a = 0;
            for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j].x * r[i].y - r[i].x * r[j].y;
            return sum + a / 2;
        }, 0);

    /** Two overlapping 100×100 squares wrapped in a live boolean, children re-based onto it. */
    const liveDoc = (op?: BooleanOp): ProjectDocument => {
        const doc = docOf(
            { id: "B", type: "core.boolean", parent: null, children: ["A1", "A2"],
              geometry: { x: 0, y: 0, width: 150, height: 150 },
              style: { fill: "#ff0000", opacity: 1 }, layout: {}, ...(op ? { booleanOp: op } : {}) } as Node,
            mk("A1", { x: 0, y: 0, width: 100, height: 100 }, { parent: "B" }),
            mk("A2", { x: 50, y: 50, width: 100, height: 100 }, { parent: "B" })
        );
        doc.rootNodeUuids = ["B"];
        return doc;
    };

    test("resolves to a PATH carrying the combined shape, with the operands gone from the scene", () => {
        const scene = resolveBooleans(liveDoc());
        const node = scene.nodes.get("B")!;
        expect(node.type).toBe("core.path");
        expect(scene.nodes.has("A1")).toBe(false);   // the operands are not drawn separately
        expect(scene.nodes.has("A2")).toBe(false);
        expect(node.children).toEqual([]);
        expect(area(commandsToRings(node.path!))).toBeCloseTo(17500, 3);   // the union
        expect(node.style.fill).toBe("#ff0000");     // the BOOLEAN's paint, not an operand's
    });

    test("the operation is what changes the shape — and it stays an edit, not a bake", () => {
        expect(area(commandsToRings(resolveBooleans(liveDoc("union")).nodes.get("B")!.path!))).toBeCloseTo(17500, 3);
        expect(area(commandsToRings(resolveBooleans(liveDoc("intersect")).nodes.get("B")!.path!))).toBeCloseTo(2500, 3);
        expect(area(commandsToRings(resolveBooleans(liveDoc("subtract")).nodes.get("B")!.path!))).toBeCloseTo(7500, 3);
        expect(area(commandsToRings(resolveBooleans(liveDoc("exclude")).nodes.get("B")!.path!))).toBeCloseTo(15000, 3);
        // Absent means union, which is what makes every pre-33 document valid for this field.
        expect(area(commandsToRings(resolveBooleans(liveDoc()).nodes.get("B")!.path!))).toBeCloseTo(17500, 3);
    });

    test("MOVING an operand re-derives the result — the point of keeping them", () => {
        const doc = liveDoc("intersect");
        const before = area(commandsToRings(resolveBooleans(doc).nodes.get("B")!.path!));
        doc.nodes.get("A2")!.geometry.x = 75;      // slide the overlap from 50×50 to 25×50
        const after = area(commandsToRings(resolveBooleans(doc).nodes.get("B")!.path!));
        expect(before).toBeCloseTo(2500, 3);
        expect(after).toBeCloseTo(1250, 3);
    });

    test("the resolved box is the RESULT's tight bounds, not the stored one", () => {
        // The stored box is derived data — a stale save must not place the shape. The union of
        // the two squares spans 150×150 from the boolean's own origin.
        const doc = liveDoc();
        doc.nodes.get("B")!.geometry = { x: 10, y: 20, width: 9999, height: 1 };
        const node = resolveBooleans(doc).nodes.get("B")!;
        expect(node.geometry).toMatchObject({ x: 10, y: 20, width: 150, height: 150 });
        expect(pathBounds(node.path!)).toEqual({ x: 0, y: 0, width: 150, height: 150 });
    });

    test("a rotated operand is combined where it is DRAWN inside the boolean", () => {
        const doc = liveDoc();
        doc.nodes.get("A2")!.transform = { rotation: Math.PI / 4 };
        const node = resolveBooleans(doc).nodes.get("B")!;
        // The turned square reaches 50·√2 from its own centre, past the un-turned 150.
        expect(node.geometry.width).toBeGreaterThan(150);
    });

    test("a boolean of BOOLEANS resolves innermost first", () => {
        const doc = docOf(
            { id: "OUT", type: "core.boolean", parent: null, children: ["IN", "C"],
              geometry: { x: 0, y: 0, width: 200, height: 200 }, style: { fill: "#111111", opacity: 1 }, layout: {},
              booleanOp: "subtract" } as Node,
            { id: "IN", type: "core.boolean", parent: "OUT", children: ["A1", "A2"],
              geometry: { x: 0, y: 0, width: 150, height: 150 }, style: { fill: "#111111", opacity: 1 }, layout: {},
              booleanOp: "union" } as Node,
            mk("A1", { x: 0, y: 0, width: 100, height: 100 }, { parent: "IN" }),
            mk("A2", { x: 50, y: 50, width: 100, height: 100 }, { parent: "IN" }),
            mk("C", { x: 0, y: 0, width: 50, height: 50 }, { parent: "OUT" })
        );
        doc.rootNodeUuids = ["OUT"];
        const scene = resolveBooleans(doc);
        expect(scene.nodes.get("OUT")!.type).toBe("core.path");
        expect(scene.nodes.has("IN")).toBe(false);
        // (A1 ∪ A2) minus the 50×50 corner square: 17500 − 2500.
        expect(area(commandsToRings(scene.nodes.get("OUT")!.path!))).toBeCloseTo(15000, 3);
    });

    test("a boolean with nothing usable resolves to an EMPTY path, not to nothing", () => {
        // It must stay in the scene and stay selectable, or an empty one could never be filled.
        const doc = docOf({ id: "B", type: "core.boolean", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {} } as Node);
        const node = resolveBooleans(doc).nodes.get("B")!;
        expect(node.type).toBe("core.path");
        expect(node.path).toBeUndefined();
    });

    test("a cycle resolves to nothing rather than recursing forever", () => {
        const doc = docOf({ id: "B", type: "core.boolean", parent: null, children: ["B"],
            geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#111111", opacity: 1 }, layout: {} } as Node);
        expect(() => resolveBooleans(doc)).not.toThrow();
    });

    test("everything downstream sees the resolved path — geometry, picking and the renderer", () => {
        // The reason resolution lives at the display seam: no consumer needs to know booleans
        // exist. `computeGeometry` calls `resolveScene`, so this is the whole pipeline at once.
        const cs = computeGeometry(liveDoc());
        expect(cs.nodes.get("B")!.shape.kind).toBe("path");
        expect(cs.nodes.has("A1")).toBe(false);
        expect(cs.nodes.get("B")!.bounds).toEqual({ x: 0, y: 0, width: 150, height: 150 });
        // A click in the union's L-shaped arm hits it; one in the corner it does not cover misses.
        expect(hitTest(cs, 120, 120)).toBe("B");
        expect(hitTest(cs, 130, 20)).toBeNull();
    });

    test("a live boolean round-trips through save and load", () => {
        const doc = liveDoc("subtract");
        const loaded = deserializeDocument(serializeDocument(doc));
        expect(loaded.nodes.get("B")!.type).toBe("core.boolean");
        expect(loaded.nodes.get("B")!.booleanOp).toBe("subtract");
        expect(loaded.nodes.get("B")!.children).toEqual(["A1", "A2"]);   // the operands survive
        expect(area(commandsToRings(resolveBooleans(loaded).nodes.get("B")!.path!))).toBeCloseTo(7500, 3);
    });

    test("the LOADER refuses a bad operation, and one on the wrong node type", () => {
        expect(booleanOpError("core.boolean", undefined)).toBeNull();
        expect(booleanOpError("core.boolean", "union")).toBeNull();
        expect(booleanOpError("core.boolean", "substract")).toContain("must be one of");
        expect(booleanOpError("core.rectangle", "union")).toContain("only a core.boolean");
        const doc = liveDoc();
        (doc.nodes.get("B") as Node).booleanOp = "nonsense" as BooleanOp;
        expect(() => deserializeDocument(serializeDocument(doc))).toThrow(/must be one of/);
    });

    test("the action wraps a selection into a live node, re-basing each child onto it", () => {
        const doc = docOf(
            mk("A", { x: 200, y: 300, width: 100, height: 100 }),
            mk("B", { x: 250, y: 350, width: 100, height: 100 })
        );
        const dispatcher = new ActionDispatcher(doc);
        const action = makeBooleanNodeAction(doc, computeGeometry(doc), ["A", "B"], "subtract", "BOOL")!;
        expect(dispatcher.dispatchAction(action).success).toBe(true);
        const after = dispatcher.getDocument();
        const node = after.nodes.get("BOOL")!;
        expect(node.type).toBe("core.boolean");
        expect(node.booleanOp).toBe("subtract");
        expect(node.geometry).toMatchObject({ x: 200, y: 300, width: 150, height: 150 });
        expect([...node.children].sort()).toEqual(["A", "B"]);
        expect(after.nodes.get("A")!.parent).toBe("BOOL");
        // Re-based: A sat at the union's origin, B 50 in from it — so they land where they were.
        expect(after.nodes.get("A")!.geometry).toMatchObject({ x: 0, y: 0 });
        expect(after.nodes.get("B")!.geometry).toMatchObject({ x: 50, y: 50 });
        // …and the whole wrap is ONE undo.
        dispatcher.undo();
        expect(dispatcher.getDocument().nodes.has("BOOL")).toBe(false);
        expect(dispatcher.getDocument().nodes.get("A")!.geometry).toMatchObject({ x: 200, y: 300 });
    });

    test("switching the operation is a single undoable edit", () => {
        const doc = liveDoc("union");
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new SetBooleanOpAction(doc, "B", "intersect")).success).toBe(true);
        expect(area(commandsToRings(resolveBooleans(dispatcher.getDocument()).nodes.get("B")!.path!))).toBeCloseTo(2500, 3);
        dispatcher.undo();
        expect(area(commandsToRings(resolveBooleans(dispatcher.getDocument()).nodes.get("B")!.path!))).toBeCloseTo(17500, 3);
        // The operands were never touched by either direction.
        expect(dispatcher.getDocument().nodes.has("A1")).toBe(true);
    });

    test("the wrap refuses what it cannot re-base", () => {
        const one = docOf(mk("A", { x: 0, y: 0, width: 10, height: 10 }));
        expect(makeBooleanNodeAction(one, computeGeometry(one), ["A"], "union", "X")).toBeNull();
        // Different parents: each child would need re-expressing through a different chain.
        const split = docOf(
            mk("P", { x: 0, y: 0, width: 500, height: 500 }, { children: ["A"] }),
            mk("A", { x: 0, y: 0, width: 10, height: 10 }, { parent: "P" }),
            mk("B", { x: 100, y: 100, width: 10, height: 10 })
        );
        split.rootNodeUuids = ["P", "B"];
        expect(makeBooleanNodeAction(split, computeGeometry(split), ["A", "B"], "union", "X")).toBeNull();
        // A laid-out child's stored x/y is dead data the container computes.
        const flex = docOf(
            mk("P", { x: 0, y: 0, width: 500, height: 500 }, { children: ["A", "B"], layout: { container: { direction: "row" } } }),
            mk("A", { x: 0, y: 0, width: 10, height: 10 }, { parent: "P" }),
            mk("B", { x: 0, y: 0, width: 10, height: 10 }, { parent: "P" })
        );
        flex.rootNodeUuids = ["P"];
        expect(makeBooleanNodeAction(flex, computeGeometry(flex), ["A", "B"], "union", "X")).toBeNull();
    });

    test("the toolbar offers the live combine, the flatten, and the operation switcher", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        // A plain click builds the LIVE node; Alt flattens. Both from one handler.
        expect(src).toMatch(/onClick=\{e => runBoolean\(op, !e\.altKey\)\}/);
        expect(src).toMatch(/live[\s\S]{0,200}makeBooleanNodeAction\(doc, computeGeometry\(doc\), es\.selectedNodeIds, op, id\)[\s\S]{0,120}booleanAction\(/);
        // …and a selected boolean node offers its operation, with the current one marked.
        expect(src).toMatch(/type === "core\.boolean" && \(/);
        expect(src).toMatch(/onClick=\{\(\) => setBooleanOp\(op\)\}/);
    });
});

// ─── Typography (schema 34) ───
describe("Typography", () => {
    test("every field is validated on BOTH paths, with the ranges the inspector clamps to", () => {
        const ok = (patch: object) => styleError({ fill: "#000", opacity: 1, ...patch });
        expect(ok({})).toBeNull();
        expect(ok({ fontFamily: "Inter, sans-serif", fontWeight: 700, textAlign: "center", lineHeight: 1.5, letterSpacing: -0.5 })).toBeNull();
        // Tokens are legal in every NUMBER slot, exactly like fontSize and radius.
        expect(ok({ fontWeight: "$type/bold", lineHeight: "$type/tight", letterSpacing: "$type/loose" })).toBeNull();

        expect(ok({ fontFamily: "x".repeat(FONT_FAMILY_MAX + 1) })).toContain("fontFamily");
        expect(ok({ fontFamily: 12 })).toContain("fontFamily");
        expect(ok({ fontWeight: 0 })).toContain("fontWeight");
        expect(ok({ fontWeight: 1001 })).toContain("fontWeight");
        expect(ok({ textAlign: "middle" })).toContain("textAlign");
        expect(ok({ lineHeight: 0 })).toContain("lineHeight");       // a zero-height line is not a choice
        expect(ok({ letterSpacing: Infinity })).toContain("letterSpacing");
        // …but letter spacing may be NEGATIVE: tightening is a real typographic decision.
        expect(ok({ letterSpacing: -2 })).toBeNull();
    });

    test("a typographic style round-trips, and a bad one is refused by the LOADER", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("T", { id: "T", type: "core.text", parent: null, children: [], text: "Hi",
            geometry: { x: 0, y: 0, width: 100, height: 40 }, layout: {},
            style: { fill: "#111111", opacity: 1, fontFamily: "Inter", fontWeight: 600, textAlign: "right", lineHeight: 1.4, letterSpacing: 1.5 } });
        doc.rootNodeUuids = ["T"];
        const loaded = deserializeDocument(serializeDocument(doc));
        expect(loaded.nodes.get("T")!.style).toMatchObject({
            fontFamily: "Inter", fontWeight: 600, textAlign: "right", lineHeight: 1.4, letterSpacing: 1.5
        });
        (doc.nodes.get("T")!.style as { textAlign?: string }).textAlign = "middle";
        expect(() => deserializeDocument(serializeDocument(doc))).toThrow(/textAlign/);
    });

    test("the render model RESOLVES every slot — tokens, ranges and defaults — so backends decide nothing", () => {
        const doc = createEmptyDocument();
        doc.variables = {
            "type/bold": { type: "font", value: 800 },
            "type/loose": { type: "spacing", value: 3 },
            "type/broken": { type: "font", value: 99999 }        // resolves, but out of range
        } as unknown as typeof doc.variables;
        doc.nodes.set("T", { id: "T", type: "core.text", parent: null, children: [], text: "Hi",
            geometry: { x: 0, y: 0, width: 100, height: 40 }, layout: {},
            style: { fill: "#111111", opacity: 1, fontWeight: "$type/bold", letterSpacing: "$type/loose", lineHeight: "$type/broken" } });
        doc.rootNodeUuids = ["T"];
        const state = ({ selectedNodeIds: [], hoveredNodeId: null, previewRect: null, computed: computeGeometry(doc), viewport: { x: 0, y: 0, zoom: 1 } }) as unknown as import("../../renderer/RendererState").RendererState;
        const shape = buildRenderModel({ width: 800, height: 600 }, doc, state).content[0].shape as { fontWeight: number; letterSpacing: number; lineHeight: number; fontFamily: string };
        expect(shape.fontWeight).toBe(800);
        expect(shape.letterSpacing).toBe(3);
        // An out-of-RANGE resolved token falls back visibly-but-harmlessly, like radius/fontSize:
        // the store only promises a finite number, and a legal `spacing` is an illegal line height.
        expect(shape.lineHeight).toBe(1.2);
        expect(shape.fontFamily).toBe("sans-serif");   // absent → the default stack
    });

    test("an empty font family falls back rather than emitting an empty CSS stack", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("T", { id: "T", type: "core.text", parent: null, children: [], text: "Hi",
            geometry: { x: 0, y: 0, width: 100, height: 40 }, layout: {},
            style: { fill: "#111111", opacity: 1, fontFamily: "   " } });
        doc.rootNodeUuids = ["T"];
        const state = ({ selectedNodeIds: [], hoveredNodeId: null, previewRect: null, computed: computeGeometry(doc), viewport: { x: 0, y: 0, zoom: 1 } }) as unknown as import("../../renderer/RendererState").RendererState;
        const shape = buildRenderModel({ width: 800, height: 600 }, doc, state).content[0].shape as { fontFamily: string };
        expect(shape.fontFamily).toBe("sans-serif");
    });

    test("the SVG backend keeps explicit newlines and applies every typography slot", () => {
        // `emitSVG` needs a DOM, so it is asserted at the source like the other DOM-only rules.
        // `pre-wrap` is the load-bearing one: the default `normal` collapses a newline to a
        // space, which is why two-line text was impossible to author before schema 34.
        const src = readFileSync(resolve(__dirname, "../../renderer/emitSVG.ts"), "utf8");
        expect(src).toMatch(/div\.style\.whiteSpace = "pre-wrap";/);
        expect(src).toMatch(/div\.style\.fontFamily = shape\.fontFamily;/);
        expect(src).toMatch(/div\.style\.fontWeight = String\(shape\.fontWeight\);/);
        expect(src).toMatch(/div\.style\.textAlign = shape\.textAlign;/);
        // Unitless line-height is the CSS meaning of a MULTIPLE — appending "px" would make 1.4
        // a 1.4-pixel line and collapse the text into one band.
        expect(src).toMatch(/div\.style\.lineHeight = String\(shape\.lineHeight\);/);
        expect(src).toMatch(/div\.style\.letterSpacing = `\$\{shape\.letterSpacing\}px`;/);
    });

    test("the inspector offers every control, clamped to the validator's own ranges", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/style: \{ fontFamily: v \}/);
        expect(src).toMatch(/fontWeight: Math\.min\(1000, Math\.max\(1, v\)\)/);
        expect(src).toMatch(/lineHeight: Math\.max\(0\.01, v\)/);
        expect(src).toMatch(/style: \{ letterSpacing: v \}/);       // NOT clamped: negative is legal
        expect(src).toMatch(/TEXT_ALIGNS\.map\(a =>/);
        expect(src).toMatch(/if \(v\.length > FONT_FAMILY_MAX\) return;/);
    });
});

// ─── Prototyping (M7, schema 35): interactions and state transitions ───
describe("Prototype interactions and transitions", () => {
    /** A red 100x100 square with a "big" state that doubles it and turns it blue. */
    const protoDoc = (interactions?: Interaction[]): ProjectDocument => {
        const doc = createEmptyDocument();
        doc.nodes.set("A", {
            id: "A", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 100, height: 100 },
            style: { fill: "#ff0000", opacity: 1 }, layout: {},
            states: { big: { geometry: { x: 40, y: 80, width: 200, height: 200 }, text: "after", style: { fill: "#0000ff", opacity: 0.5 } } },
            ...(interactions ? { interactions } : {})
        } as Node);
        doc.rootNodeUuids = ["A"];
        return doc;
    };

    test("the validator shares one rule with the loader, and a dangling state stays legal", () => {
        expect(interactionsError(undefined)).toBeNull();
        expect(interactionsError([{ trigger: "click", state: "big", duration: 200, easing: "ease-out" }])).toBeNull();
        expect(interactionsError([{ trigger: "hover", state: null }])).toBeNull();
        // A state that does not exist is INERT, not invalid — deleting a state must never make a
        // document unloadable, the same rule componentId and $token aliases follow.
        expect(interactionsError([{ trigger: "click", state: "never-defined" }])).toBeNull();

        expect(interactionsError("nope")).toContain("must be an array");
        expect(interactionsError([{ trigger: "swipe", state: null }])).toContain("trigger");
        expect(interactionsError([{ trigger: "click", state: 7 }])).toContain("state");
        expect(interactionsError([{ trigger: "click", state: null, duration: -1 }])).toContain("duration");
        expect(interactionsError([{ trigger: "click", state: null, duration: TRANSITION_MAX_MS + 1 }])).toContain("duration");
        expect(interactionsError([{ trigger: "click", state: null, easing: "bouncy" }])).toContain("easing");
        expect(interactionsError(new Array(INTERACTIONS_MAX + 1).fill({ trigger: "click", state: null }))).toContain("at most");
    });

    test("interactions round-trip, and a bad one is refused by the LOADER", () => {
        const doc = protoDoc([{ trigger: "click", state: "big", duration: 250, easing: "ease-in-out" }]);
        const loaded = deserializeDocument(serializeDocument(doc));
        expect(loaded.nodes.get("A")!.interactions).toEqual([{ trigger: "click", state: "big", duration: 250, easing: "ease-in-out" }]);
        (doc.nodes.get("A")!.interactions as Interaction[])[0].trigger = "swipe" as Trigger;
        expect(() => deserializeDocument(serializeDocument(doc))).toThrow(/trigger/);
    });

    test("easing clamps rather than extrapolates, so an overshooting clock lands on the end", () => {
        expect(easingAt("linear", 0.25)).toBeCloseTo(0.25, 10);
        expect(easingAt("ease-in", 0.5)).toBeCloseTo(0.25, 10);
        expect(easingAt("ease-out", 0.5)).toBeCloseTo(0.75, 10);
        expect(easingAt("ease-in-out", 0.5)).toBeCloseTo(0.5, 10);
        expect(easingAt("ease-in-out", 0.25)).toBeCloseTo(0.125, 10);
        // A frame that arrives late must not push the animation PAST its target.
        expect(easingAt("ease-out", 1.4)).toBe(1);
        expect(easingAt("linear", -3)).toBe(0);
        expect(easingAt(undefined, 0.3)).toBeCloseTo(0.3, 10);   // absent = linear
    });

    test("colours blend per channel, and anything unresolvable SNAPS at the halfway point", () => {
        expect(blendColor("#000000", "#ffffff", 0.5)).toBe("#808080");
        expect(blendColor("#f00", "#00f", 0.5)).toBe("#800080");    // short hex expands first
        expect(blendColor("#ff0000", "#0000ff", 0)).toBe("#ff0000");
        // A token has no channels to mix before the render model resolves it, so it snaps —
        // visible and explainable, rather than a silently wrong colour.
        expect(blendColor("$color/a", "#ffffff", 0.4)).toBe("$color/a");
        expect(blendColor("$color/a", "#ffffff", 0.6)).toBe("#ffffff");
    });

    test("blendStates is a pure function of time — the frame part-way between two states", () => {
        const doc = protoDoc();
        const at = (t: number) => blendStates(doc, null, "big", t, applyActiveState).nodes.get("A")!;
        // The ENDS are exactly the states themselves, so a finished transition is
        // indistinguishable from having simply selected that state.
        expect(at(0).geometry).toEqual({ x: 0, y: 0, width: 100, height: 100 });
        expect(at(0).style.fill).toBe("#ff0000");
        expect(at(1).geometry).toEqual({ x: 40, y: 80, width: 200, height: 200 });
        expect(at(1).style.fill).toBe("#0000ff");
        // …and the middle is the interpolation, on every animatable field at once.
        const mid = at(0.5);
        expect(mid.geometry).toEqual({ x: 20, y: 40, width: 150, height: 150 });
        expect(mid.style.opacity).toBeCloseTo(0.75, 10);
        expect(mid.style.fill).toBe("#800080");
        // A field that cannot be interpolated (text) proves the ENDS are the states themselves
        // rather than the target blended at t=0 — at 0 the text is still the one being left.
        expect(at(0).text).toBeUndefined();
        expect(at(1).text).toBe("after");
        // The document is untouched: an animation is a derivation, not a mutation.
        expect(doc.nodes.get("A")!.geometry.width).toBe(100);
    });

    test("the blended document survives the PIPELINE — it must not ask to be resolved twice", () => {
        // Found live, and invisible to every test that read the blend's own nodes: the returned
        // document named the TARGET as its active state, and `computeGeometry` resolves through
        // `resolveScene`, which applies that state again — overwriting the interpolation with the
        // target's own geometry. A 2-second transition landed on its end state in the first frame.
        // The assertion therefore goes through the engine, which is what the app actually draws.
        const doc = protoDoc();
        const half = blendStates(doc, null, "big", 0.5, applyActiveState);
        expect(half.activeState).toBeUndefined();
        expect(computeGeometry(half).nodes.get("A")!.bounds).toEqual({ x: 20, y: 40, width: 150, height: 150 });
        // …and the ends still resolve to the ends.
        expect(computeGeometry(blendStates(doc, null, "big", 0, applyActiveState)).nodes.get("A")!.bounds)
            .toEqual({ x: 0, y: 0, width: 100, height: 100 });
        expect(computeGeometry(blendStates(doc, null, "big", 1, applyActiveState)).nodes.get("A")!.bounds)
            .toEqual({ x: 40, y: 80, width: 200, height: 200 });
    });

    test("a transition blends the transform too, from the identity when one side has none", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("A", {
            id: "A", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000000", opacity: 1 }, layout: {},
            states: { spun: { transform: { rotation: Math.PI, scaleX: 3 } } }
        } as Node);
        doc.rootNodeUuids = ["A"];
        const mid = blendStates(doc, null, "spun", 0.5, applyActiveState).nodes.get("A")!;
        expect(mid.transform!.rotation).toBeCloseTo(Math.PI / 2, 10);
        expect(mid.transform!.scaleX).toBeCloseTo(2, 10);   // 1 (absent = identity) → 3
        expect(mid.transform!.scaleY).toBeCloseTo(1, 10);
    });

    test("a numeric style slot interpolates only when BOTH ends are concrete", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("A", {
            id: "A", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 10, height: 10 },
            style: { fill: "#000000", opacity: 1, radius: 0, strokeWidth: "$size/hair" }, layout: {},
            states: { r: { style: { radius: 20, strokeWidth: 8 } } }
        } as Node);
        doc.rootNodeUuids = ["A"];
        const mid = blendStates(doc, null, "r", 0.5, applyActiveState).nodes.get("A")!;
        expect(mid.style.radius).toBe(10);
        // A token is a REFERENCE; averaging it with a number would produce neither, so the
        // target's value stands and the change is a switch rather than a blend.
        expect(mid.style.strokeWidth).toBe(8);
    });

    test("interactionFor picks the first match for a trigger", () => {
        const node = { interactions: [
            { trigger: "hover", state: "a" }, { trigger: "click", state: "b" }, { trigger: "click", state: "c" }
        ] as Interaction[] };
        expect(interactionFor(node, "click")!.state).toBe("b");
        expect(interactionFor(node, "hover")!.state).toBe("a");
        expect(interactionFor(node, "press")).toBeNull();
        expect(interactionFor({}, "click")).toBeNull();
    });

    test("PLAY MODE: a click fires the interaction under the pointer instead of selecting", () => {
        const doc = protoDoc([{ trigger: "click", state: "big", duration: 300, easing: "ease-out" }]);
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState();
        const tc = new ToolController(dispatcher, es, () => { });
        const rect = { left: 0, top: 0 } as DOMRect;
        const md = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);

        es.playing = true;
        tc.onMouseDown(md(50, 50), rect);
        expect(es.playState).toBe("big");
        expect(es.transition).toMatchObject({ from: null, to: "big", duration: 300, easing: "ease-out" });
        // Nothing was selected, and — the point — the DOCUMENT did not change.
        expect(es.selectedNodeIds).toEqual([]);
        expect(dispatcher.getDocument().nodes.get("A")!.geometry.width).toBe(100);
    });

    test("PLAY MODE: a click on empty canvas, or on a node with no interaction, does nothing", () => {
        const doc = protoDoc();                      // no interactions at all
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState();
        const tc = new ToolController(dispatcher, es, () => { });
        const rect = { left: 0, top: 0 } as DOMRect;
        const md = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
        es.playing = true;
        tc.onMouseDown(md(50, 50), rect);            // on the node, but it has nothing to say
        expect(es.playState).toBeNull();
        tc.onMouseDown(md(900, 900), rect);          // empty canvas
        expect(es.playState).toBeNull();
        expect(es.selectedNodeIds).toEqual([]);      // and STILL nothing is selected
    });

    test("PLAY MODE: a transition runs FROM wherever the screen currently is", () => {
        // Two clicks in a row must animate from the state the last one left, not from the base —
        // otherwise a second click restarts the animation from the beginning of the first.
        const doc = protoDoc([{ trigger: "click", state: "big", duration: 100 }]);
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState();
        const tc = new ToolController(dispatcher, es, () => { });
        const rect = { left: 0, top: 0 } as DOMRect;
        const md = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);
        es.playing = true;
        tc.onMouseDown(md(50, 50), rect);
        tc.onMouseDown(md(50, 50), rect);
        expect(es.transition).toMatchObject({ from: "big", to: "big" });
    });

    test("PLAY MODE: a zero-duration interaction switches with no transition at all", () => {
        const doc = protoDoc([{ trigger: "click", state: "big" }]);
        const dispatcher = new ActionDispatcher(doc);
        const es = createEditorState();
        const tc = new ToolController(dispatcher, es, () => { });
        const rect = { left: 0, top: 0 } as DOMRect;
        es.playing = true;
        tc.onMouseDown({ clientX: 50, clientY: 50, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent, rect);
        expect(es.playState).toBe("big");
        expect(es.transition).toBeNull();
    });

    test("the interactions action replaces the whole list, and stores an empty one as ABSENT", () => {
        const doc = protoDoc();
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new SetInteractionsAction(doc, "A", [{ trigger: "click", state: "big" }])).success).toBe(true);
        expect(dispatcher.getDocument().nodes.get("A")!.interactions).toEqual([{ trigger: "click", state: "big" }]);
        expect(dispatcher.dispatchAction(new SetInteractionsAction(dispatcher.getDocument(), "A", [])).success).toBe(true);
        // ABSENT, not `[]` — a node that lost its last interaction equals one that never had any.
        expect(dispatcher.getDocument().nodes.get("A")!.interactions).toBeUndefined();
        // …and an invalid list is refused by the same rule the loader uses.
        expect(new SetInteractionsAction(dispatcher.getDocument(), "A", [{ trigger: "swipe" } as unknown as Interaction]).validate()).toBe(false);
    });

    test("a CAPTURED state records the node's look — geometry and transform, not just paint", () => {
        // Style alone was the original capture, and it made most of the transition machinery
        // unreachable: `blendStates` interpolates geometry and transform, so a prototype could
        // change colour but could never move, grow or turn anything. The animation existed and
        // nothing could author an input for it.
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/function captureLook\(node: Node\): StateDefinition \{[\s\S]{0,300}geometry: \{ \.\.\.node\.geometry \}/);
        expect(src).toMatch(/\.\.\.\(node\.transform \? \{ transform: \{ \.\.\.node\.transform \} \} : \{\}\)/);
        // BOTH capture buttons (re-capture and capture-as) go through the one helper, so the
        // two cannot record different things.
        expect(src.match(/captureLook\(node\)/g)!.length).toBe(2);
    });

    test("a state captured from a moved node animates it — the whole point of the blend", () => {
        // The end-to-end shape of a prototype: a node is arranged, captured under a name, then
        // moved back; the interaction animates between the two. This is what style-only capture
        // could not express at all.
        const doc = createEmptyDocument();
        const captured = { x: 300, y: 400, width: 200, height: 200 };
        doc.nodes.set("A", {
            id: "A", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 100, height: 100 },
            style: { fill: "#ff0000", opacity: 1 }, layout: {},
            // Exactly what `captureLook` produces: the look at the moment of capture.
            states: { big: { style: { fill: "#ff0000", opacity: 1 }, geometry: captured } },
            interactions: [{ trigger: "click", state: "big", duration: 400, easing: "ease-out" }]
        } as Node);
        doc.rootNodeUuids = ["A"];

        const mid = blendStates(doc, null, "big", 0.5, applyActiveState).nodes.get("A")!;
        expect(mid.geometry).toEqual({ x: 150, y: 200, width: 150, height: 150 });
        const end = blendStates(doc, null, "big", 1, applyActiveState).nodes.get("A")!;
        expect(end.geometry).toEqual(captured);
        // …and the stored document still has the node where it was authored.
        expect(doc.nodes.get("A")!.geometry).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    });

    test("the app plays through the pure blend and stops without touching the document", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        // The scene shown while playing is a DERIVED document, not an edited one.
        expect(src).toMatch(/blendStates\(stored, es\.transition\.from, es\.transition\.to,/);
        expect(src).toMatch(/easingAt\(es\.transition\.easing, \(Date\.now\(\) - es\.transition\.startedAt\) \/ es\.transition\.duration\)/);
        // The clock re-derives from a TIMESTAMP each frame rather than accumulating.
        expect(src).toMatch(/requestAnimationFrame\(\(\) => refresh\(\)\)/);
        // A prototype frame is a DIFFERENT document, and the dirty set only names nodes an
        // ACTION touched — so the incremental path must be skipped while playing, and the reuse
        // chain broken across it. Reusing it drew the animation with stale geometry: the state
        // applied, the clock ran, and the shape did not move.
        expect(src).toMatch(/const computed = !es\.playing && prevComputedRef\.current/);
        expect(src).toMatch(/prevComputedRef\.current = es\.playing \? null : computed;/);
        // Stopping clears the run's state, so the document is exactly as it was.
        expect(src).toMatch(/es\.playing = !es\.playing;[\s\S]{0,120}es\.playState = null;[\s\S]{0,60}es\.transition = null;/);
    });
});

// ─── Prototype NAVIGATION (schema 36): a click can change the screen ───
describe("Prototype navigation", () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 } as DOMRect;
    const md = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1, preventDefault() { }, target: { getAttribute: () => null } } as unknown as MouseEvent);

    /** Two screens side by side; the first has a button that navigates to the second. */
    const twoScreens = (interaction: Interaction): ProjectDocument => {
        const doc = createEmptyDocument();
        doc.nodes.set("S1", { id: "S1", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 400, height: 300 }, style: { fill: "#111111", opacity: 1 }, layout: {}, interactions: [interaction] } as Node);
        doc.nodes.set("S2", { id: "S2", type: "core.rectangle", parent: null, children: [], geometry: { x: 1000, y: 500, width: 400, height: 300 }, style: { fill: "#222222", opacity: 1 }, layout: {} } as Node);
        doc.rootNodeUuids = ["S1", "S2"];
        return doc;
    };

    test("viewportToFit centres a rect and picks the tighter axis", () => {
        // screen = z·world − vp, so fitting means: the tighter axis sets the zoom, and the offset
        // puts the rect's world centre at the canvas centre.
        const vp = viewportToFit({ x: 0, y: 0, width: 400, height: 200 }, { width: 800, height: 600 }, 0, 1);
        expect(vp.zoom).toBe(2);                    // 800/400 = 2 beats 600/200 = 3
        expect(vp.x).toBe(2 * 200 - 400);           // z·cx − size/2
        expect(vp.y).toBe(2 * 100 - 300);
        // Padding shrinks the fit on both axes.
        expect(viewportToFit({ x: 0, y: 0, width: 400, height: 200 }, { width: 800, height: 600 }, 100, 1).zoom)
            .toBeCloseTo(800 / 600, 10);
        // A degenerate rect falls back to the current zoom rather than dividing by zero.
        const flat = viewportToFit({ x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 }, 0, 3);
        expect(flat.zoom).toBe(3);
        expect(Number.isFinite(flat.x) && Number.isFinite(flat.y)).toBe(true);
        // …and the result is CLAMPED like every other viewport change.
        expect(viewportToFit({ x: 0, y: 0, width: 1, height: 1 }, { width: 800, height: 600 }, 0, 1).zoom).toBeLessThanOrEqual(20);
    });

    test("a viewport blend moves the offsets linearly and the zoom GEOMETRICALLY", () => {
        const a = { x: 0, y: 0, zoom: 1 }, b = { x: 100, y: 200, zoom: 4 };
        expect(lerpViewport(a, b, 0)).toEqual(a);
        expect(lerpViewport(a, b, 1)).toEqual(b);
        const mid = lerpViewport(a, b, 0.5);
        expect(mid.x).toBe(50);
        expect(mid.y).toBe(100);
        // Geometric: the halfway point of 1→4 is 2, not 2.5. Linear zoom spends most of a big
        // range barely moving and then lurches.
        expect(mid.zoom).toBeCloseTo(2, 10);
        expect(lerpViewport(a, b, 1.5)).toEqual(b);   // clamped, like the state blend
    });

    test("a click NAVIGATES: the viewport ends up fitting the target", () => {
        const doc = twoScreens({ trigger: "click", state: null, target: "S2" });
        const es = createEditorState();
        const tc = new ToolController(new ActionDispatcher(doc), es, () => { });
        es.playing = true;
        tc.onMouseDown(md(200, 150), rect);          // on the first screen
        // Instant (no duration): the viewport is already there, with no transition left running.
        expect(es.viewportTransition).toBeNull();
        const expected = viewportToFit({ x: 1000, y: 500, width: 400, height: 300 }, { width: 800, height: 600 }, 24, 1);
        expect(es.viewport.zoom).toBeCloseTo(expected.zoom, 10);
        expect(es.viewport.x).toBeCloseTo(expected.x, 10);
        expect(es.viewport.y).toBeCloseTo(expected.y, 10);
    });

    test("with a duration the navigation is an ANIMATION, starting where the viewport was", () => {
        const doc = twoScreens({ trigger: "click", state: null, target: "S2", duration: 500, easing: "ease-out" });
        const es = createEditorState();
        es.viewport = { x: 7, y: 9, zoom: 1.5 };
        const tc = new ToolController(new ActionDispatcher(doc), es, () => { });
        es.playing = true;
        tc.onMouseDown(md(200, 150), rect);
        expect(es.viewportTransition).toMatchObject({ from: { x: 7, y: 9, zoom: 1.5 }, duration: 500, easing: "ease-out" });
        // The viewport itself has NOT jumped — the app's clock moves it frame by frame.
        expect(es.viewport).toEqual({ x: 7, y: 9, zoom: 1.5 });
    });

    test("a DANGLING target does not navigate, and does not break the interaction", () => {
        // Deleting a frame must degrade the prototype, not break the document — the same inert
        // rule the state name follows.
        const doc = twoScreens({ trigger: "click", state: "big", target: "deleted-screen" });
        const es = createEditorState();
        const before = { ...es.viewport };
        const tc = new ToolController(new ActionDispatcher(doc), es, () => { });
        es.playing = true;
        tc.onMouseDown(md(200, 150), rect);
        expect(es.viewport).toEqual(before);      // nowhere to go
        expect(es.viewportTransition).toBeNull();
        expect(es.playState).toBe("big");         // …but the STATE half still fired
    });

    test("the target is validated like every other reference, and round-trips", () => {
        expect(interactionsError([{ trigger: "click", state: null, target: "S2" }])).toBeNull();
        expect(interactionsError([{ trigger: "click", state: null, target: "" }])).toContain("target");
        expect(interactionsError([{ trigger: "click", state: null, target: 5 }])).toContain("target");
        const doc = twoScreens({ trigger: "click", state: null, target: "S2", duration: 300 });
        const loaded = deserializeDocument(serializeDocument(doc));
        expect(loaded.nodes.get("S1")!.interactions![0]).toEqual({ trigger: "click", state: null, target: "S2", duration: 300 });
    });

    test("stopping play clears a running navigation, and the app drives it on the LIVE viewport", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(src).toMatch(/Object\.assign\(es\.viewport, lerpViewport\(vt\.from, vt\.to, k\)\)/);
        // The rAF loop must stay alive while EITHER transition runs, or a navigation with no
        // state change would render one frame and stop halfway.
        expect(src).toMatch(/es\.playing && \(es\.transition \|\| es\.viewportTransition\)/);
        expect(src).toMatch(/es\.viewportTransition = null;/);
        // Starting REMEMBERS the viewport and stopping restores it: a prototype run navigates,
        // and "playing is not editing" has to cover where you are looking, not just the document.
        expect(src).toMatch(/es\.playReturnViewport = \{ \.\.\.es\.viewport \};/);
        expect(src).toMatch(/Object\.assign\(es\.viewport, es\.playReturnViewport\);/);
    });
});

// ─── Scripting (M15): the boundary between a program and the document ───
describe("Script API", () => {
    const scriptDoc = (): ProjectDocument => {
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: [], name: "Box",
            geometry: { x: 10, y: 20, width: 100, height: 50 }, style: { fill: "#ff0000", opacity: 1 }, layout: {} } as Node);
        doc.nodes.set("T", { id: "T", type: "core.text", parent: null, children: [], text: "hi",
            geometry: { x: 0, y: 0, width: 80, height: 20 }, style: { fill: "#111111", opacity: 1 }, layout: {} } as Node);
        doc.rootNodeUuids = ["A", "T"];
        return doc;
    };
    const ids = (() => { let n = 0; return () => `new-${n++}`; })();

    test("the snapshot is PLAIN, FROZEN data — no document, no methods, no live reference", () => {
        // The first half of the guarantee: a script cannot reach the document because it is never
        // given anything connected to it.
        const doc = scriptDoc();
        const snap = snapshotFor(doc);
        expect(Object.isFrozen(snap)).toBe(true);
        expect(Object.isFrozen(snap.nodes[0])).toBe(true);
        const a = snap.nodes.find(n => n.id === "A")!;
        expect(a).toEqual({
            id: "A", type: "core.rectangle", name: "Box", parent: null, children: [],
            x: 10, y: 20, width: 100, height: 50, fill: "#ff0000", opacity: 1, text: null
        });
        // Everything survives a JSON round trip, which is what "plain" means in practice.
        expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    });

    test("requests are shape-checked, and an unknown operation is simply not one", () => {
        expect(actionRequestError({ op: "move", id: "A", x: 1, y: 2 })).toBeNull();
        expect(actionRequestError({ op: "evil", id: "A" })).toContain("unknown operation");
        expect(actionRequestError("move A 1 2")).toContain("must be an object");
        expect(actionRequestError({ op: "move", id: "A", x: "1", y: 2 })).toContain("move needs");
        expect(actionRequestError({ op: "move", id: "A", x: NaN, y: 2 })).toContain("move needs");
        expect(actionRequestError({ op: "create", nodeType: "core.evil", x: 0, y: 0, width: 1, height: 1 })).toContain("create needs");
        expect(actionRequestError({ op: "style", id: "A", style: [] })).toContain("style needs");
        expect(actionRequestError({ op: "delete", id: "" })).toContain("delete needs");
    });

    test("a script's requests become ONE transaction — the whole run is a single undo", () => {
        const doc = scriptDoc();
        const dispatcher = new ActionDispatcher(doc);
        const { action, refusals } = compileScript(doc, [
            { op: "move", id: "A", x: 200, y: 300 },
            { op: "style", id: "A", style: { fill: "#00ff00" } },
            { op: "text", id: "T", text: "changed" }
        ], ids);
        expect(refusals).toEqual([]);
        expect(dispatcher.dispatchAction(action!).success).toBe(true);
        const after = dispatcher.getDocument();
        expect(after.nodes.get("A")!.geometry).toMatchObject({ x: 200, y: 300 });
        expect(after.nodes.get("A")!.style.fill).toBe("#00ff00");
        expect(after.nodes.get("T")!.text).toBe("changed");
        // ONE undo puts all three back: a script that half-ran would be worse than one that did not.
        dispatcher.undo();
        const back = dispatcher.getDocument();
        expect(back.nodes.get("A")!.geometry).toMatchObject({ x: 10, y: 20 });
        expect(back.nodes.get("A")!.style.fill).toBe("#ff0000");
        expect(back.nodes.get("T")!.text).toBe("hi");
    });

    test("a request cannot author anything the SCHEMA refuses — the Action's own validator decides", () => {
        // The load-bearing property: this module holds no copy of the schema's rules, so a script
        // is bounded by exactly the same validators the inspector and the loader run.
        const doc = scriptDoc();
        // The legal request comes FIRST, so a refusal that discarded what was already queued
        // would be caught: "one bad line kills the run" is a different, much worse behaviour.
        const { action, refusals } = compileScript(doc, [
            { op: "move", id: "A", x: 1, y: 1 },                    // legal, and must survive
            { op: "resize", id: "A", width: 0, height: 0 },         // a rectangle needs positive dimensions
            { op: "style", id: "A", style: { opacity: 5 } }         // out of [0,1]
        ], ids);
        expect(refusals.length).toBe(2);
        expect(refusals[0]).toContain("resize refused");
        expect(refusals[1]).toContain("style refused");
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(action!);
        expect(dispatcher.getDocument().nodes.get("A")!.geometry).toMatchObject({ x: 1, y: 1, width: 100 });
    });

    test("a request naming a node that is not EDITABLE is refused, not guessed at", () => {
        const doc = scriptDoc();
        const { action, refusals } = compileScript(doc, [{ op: "move", id: "nope", x: 0, y: 0 }], ids);
        expect(action).toBeNull();
        expect(refusals[0]).toContain('no editable node "nope"');
        // An instance COPY has no stored identity — editing one means writing an override, which
        // is a different operation with different rules. Inventing it here would let a script
        // reach through a component silently.
        const withCopy = compileScript(doc, [{ op: "move", id: "I::MC", x: 0, y: 0 }], ids);
        expect(withCopy.action).toBeNull();
        expect(withCopy.refusals[0]).toContain("no editable node");
    });

    test("create and delete work, and a bad request never blocks the good ones", () => {
        const doc = scriptDoc();
        const dispatcher = new ActionDispatcher(doc);
        const { action, refusals } = compileScript(doc, [
            { op: "create", nodeType: "core.ellipse", x: 5, y: 5, width: 30, height: 30, fill: "#0000ff" },
            { op: "nonsense" },
            { op: "delete", id: "T" }
        ], () => "made");
        expect(refusals.length).toBe(1);
        expect(dispatcher.dispatchAction(action!).success).toBe(true);
        expect(dispatcher.getDocument().nodes.get("made")!.type).toBe("core.ellipse");
        expect(dispatcher.getDocument().nodes.has("T")).toBe(false);
    });

    test("an empty or entirely-refused run produces NO action, so it pushes no undo step", () => {
        const doc = scriptDoc();
        expect(compileScript(doc, [], ids).action).toBeNull();
        expect(compileScript(doc, [{ op: "move", id: "ghost", x: 0, y: 0 }], ids).action).toBeNull();
    });

    test("a runaway script is bounded by a request cap, reported rather than silently truncated", () => {
        const doc = scriptDoc();
        const many = new Array(SCRIPT_MAX_REQUESTS + 1).fill({ op: "move", id: "A", x: 1, y: 1 });
        const { action, refusals } = compileScript(doc, many, ids);
        expect(action).toBeNull();
        expect(refusals[0]).toContain("at most");
    });

    test("the SANDBOX removes what a worker still has, and cannot be reached from user code", () => {
        // `runScript` needs a Worker, which the node test env has none of — so the bootstrap is
        // asserted as source, the same way the DOM-only backend rules are.
        for (const global of ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "indexedDB"]) {
            expect(WORKER_BOOTSTRAP).toContain(`self.${global} = undefined`);
        }
        // User code is compiled in its OWN scope, so it cannot see the requests array it feeds.
        expect(WORKER_BOOTSTRAP).toContain('new Function("api", source)(api)');
        // …and the api it is given cannot be swapped out from under the host.
        expect(WORKER_BOOTSTRAP).toContain("Object.freeze({");
    });

    test("the panel compiles against the CURRENT document and shows every refusal", () => {
        const src = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        // The script ran against a SNAPSHOT; anything that changed underneath it must be caught
        // by the validators rather than assumed away.
        expect(src).toMatch(/compileScript\(dispatcher\.getDocument\(\), result\.requests,/);
        expect(src).toMatch(/lines\.push\(\.\.\.compiled\.refusals\.map/);
        // One dispatch, so one undo.
        expect(src).toMatch(/dispatcher\.dispatchAction\(compiled\.action\)\.success/);
    });
});

// ─── Tessellation: how a curve becomes a polyline ───
describe("Adaptive curve flattening", () => {
    /** The exact point on a cubic at t — the truth a flattening is measured against. */
    const cubicPoint = (p: number[][], t: number): { x: number; y: number } => {
        const u = 1 - t;
        const at = (i: number) => u * u * u * p[0][i] + 3 * u * u * t * p[1][i] + 3 * u * t * t * p[2][i] + t * t * t * p[3][i];
        return { x: at(0), y: at(1) };
    };
    /** Worst distance from the true curve to the flattened polyline — the number the tolerance promises. */
    const maxDeviation = (p: number[][], pts: { x: number; y: number }[]): number => {
        let worst = 0;
        for (let i = 0; i <= 500; i++) {
            const q = cubicPoint(p, i / 500);
            let best = Infinity;
            for (let j = 1; j < pts.length; j++) {
                const a = pts[j - 1], b = pts[j];
                const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
                const u = len === 0 ? 0 : Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len));
                best = Math.min(best, Math.hypot(a.x + u * dx - q.x, a.y + u * dy - q.y));
            }
            worst = Math.max(worst, best);
        }
        return worst;
    };
    /** A circular quadrant of radius r as a cubic — the shape an ellipse is made of. */
    const K = 0.5522847498307936;
    const quadrant = (r: number): number[][] => [[r, 0], [r, r * K], [r * K, r], [0, r]];
    const asCommands = (p: number[][]): PathCommand[] => [
        { c: "M", x: p[0][0], y: p[0][1] },
        { c: "C", x1: p[1][0], y1: p[1][1], x2: p[2][0], y2: p[2][1], x: p[3][0], y: p[3][1] }
    ];

    test("the flattening HOLDS its tolerance, at every size", () => {
        // The property the whole change is for. A fixed segment count cannot state this at all:
        // its error is proportional to the shape, so it is only ever true for one size.
        // SUB-UNIT radii included on purpose: a flatness measured as a raw cross product instead
        // of a distance is an area, and an area UNDER-reports once the chord is shorter than a
        // unit — so a tiny curve would quietly stop subdividing while a large one over-subdivided.
        for (const r of [0.5, 2, 10, 50, 200, 1000, 5000]) {
            const p = quadrant(r);
            const pts = flattenPath(asCommands(p))[0].points;
            expect(maxDeviation(p, pts)).toBeLessThanOrEqual(FLATTEN_TOLERANCE);
        }
        // ASYMMETRIC, so the two inner controls sit at different distances from the chord and
        // only the FARTHER one bounds the curve. A test that looks at one control point passes
        // every symmetric curve and fails exactly here.
        const lopsided = [[0, 0], [10, 0], [900, 400], [1000, 0]];
        expect(maxDeviation(lopsided, flattenPath(asCommands(lopsided))[0].points)).toBeLessThanOrEqual(FLATTEN_TOLERANCE);
        const mirrored = [[0, 0], [100, 400], [990, 0], [1000, 0]];
        expect(maxDeviation(mirrored, flattenPath(asCommands(mirrored))[0].points)).toBeLessThanOrEqual(FLATTEN_TOLERANCE);

        // A TINY, sharply curved case: the chord is a fifth of a unit while the controls stand
        // well off it. This is the only arrangement where a flatness measured as a raw cross
        // product (a distance times a length) comes out SMALLER than the true distance, so the
        // curve is called flat when it is not. Every larger curve hides the error by
        // over-subdividing instead.
        const tiny = [[0, 0], [0.2, 0.15], [-0.2, 0.15], [0.2, 0]];
        expect(maxDeviation(tiny, flattenPath(asCommands(tiny))[0].points)).toBeLessThanOrEqual(FLATTEN_TOLERANCE);

        // The DEFAULT tolerance is pinned to a literal, not to the constant under test: a test
        // that reads `FLATTEN_TOLERANCE` moves with it, so loosening the default would go unnoticed.
        expect(maxDeviation(quadrant(1000), flattenPath(asCommands(quadrant(1000)))[0].points)).toBeLessThanOrEqual(0.05);
    });

    test("a SMALL curve costs fewer segments than a large one — the work follows the need", () => {
        const small = flattenPath(asCommands(quadrant(10)))[0].points.length;
        const large = flattenPath(asCommands(quadrant(1000)))[0].points.length;
        expect(small).toBeLessThan(large);
        // The old fixed 16 spent the same on both: too coarse at 1000 (1.3 units of error) and
        // wasteful at 10, where the curve is already flat to well inside the tolerance.
        expect(small).toBeLessThan(16);
        expect(large).toBeGreaterThan(16);
    });

    test("a straight 'curve' is ONE segment — a flat cubic needs no subdivision at all", () => {
        const straight: PathCommand[] = [
            { c: "M", x: 0, y: 0 },
            { c: "C", x1: 10, y1: 0, x2: 20, y2: 0, x: 30, y: 0 }
        ];
        expect(flattenPath(straight)[0].points).toEqual([{ x: 0, y: 0 }, { x: 30, y: 0 }]);
    });

    test("a coarser tolerance buys fewer points, and still holds", () => {
        const p = quadrant(200);
        const fine = flattenPath(asCommands(p), 0.01)[0].points;
        const coarse = flattenPath(asCommands(p), 1)[0].points;
        expect(coarse.length).toBeLessThan(fine.length);
        expect(maxDeviation(p, fine)).toBeLessThanOrEqual(0.01);
        expect(maxDeviation(p, coarse)).toBeLessThanOrEqual(1);
    });

    test("it is DETERMINISTIC and viewport-independent — the same curve, always the same points", () => {
        // The property the fixed count was defending, and the one that must survive: picking
        // cannot depend on zoom, or the same click would hit at one magnification and miss at
        // another. The input is the curve's own numbers and nothing else.
        const p = quadrant(137.5);
        const a = flattenPath(asCommands(p))[0].points;
        const b = flattenPath(asCommands(p))[0].points;
        expect(a).toEqual(b);
        // Splitting at the midpoint means the halves are the SAME curve, so the flattening of a
        // curve and of its two halves agree on the shared point.
        expect(a[a.length - 1]).toEqual({ x: 0, y: 137.5 });
    });

    test("a pathological curve terminates against the depth cap", () => {
        // Coincident control points defeat a flatness test; the cap is what stops a hot path
        // reached on every hit test from becoming a hang.
        // A ONE-SIDED curve with coincident endpoints: the chord is degenerate, so the hull
        // distance stays enormous for many levels. Measured, it takes 7486 segments uncapped and
        // stops at the cap's 1024 — a symmetric spike, by contrast, collapses in four and proves
        // nothing, which is what an earlier version of this test used.
        const evil: PathCommand[] = [
            { c: "M", x: 0, y: 0 },
            { c: "C", x1: 1e6, y1: 1e6, x2: 1e6, y2: -1e6, x: 0, y: 0 }
        ];
        const pts = flattenPath(evil)[0].points;
        expect(pts.length).toBeLessThanOrEqual(Math.pow(2, FLATTEN_MAX_DEPTH) + 1);
        expect(pts.every(q => Number.isFinite(q.x) && Number.isFinite(q.y))).toBe(true);

        // …and a curve whose ENDS coincide but which really does enclose area must still be
        // traced, not collapsed to a point: a degenerate chord means "no line to measure
        // against", not "flat".
        const teardrop: PathCommand[] = [
            { c: "M", x: 0, y: 0 },
            { c: "C", x1: 100, y1: 0, x2: 100, y2: 100, x: 0, y: 0 }
        ];
        const loop = flattenPath(teardrop)[0].points;
        expect(loop.length).toBeGreaterThan(8);
        expect(Math.max(...loop.map(q => q.x))).toBeGreaterThan(50);
    });

    test("a QUADRATIC is flattened by the same rule, through its cubic equivalent", () => {
        // One flatness measure, not two: a quadratic IS a cubic with its controls at the 2/3
        // points, so a second formula would only be a copy to keep in step.
        const q: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "Q", x1: 500, y1: 1000, x: 1000, y: 0 }];
        const pts = flattenPath(q)[0].points;
        expect(pts.length).toBeGreaterThan(4);
        expect(pts[pts.length - 1]).toEqual({ x: 1000, y: 0 });
        // The conversion has to be RIGHT, and THIS is the assertion that can tell. The ratio only
        // feeds the flatness TEST — the points themselves are generated by splitting the
        // quadratic — so a wrong ratio never moves a point off the curve; it changes how soon
        // subdivision stops. The elevated cubic is the SAME curve, so it must tessellate to the
        // same points, and a wrong ratio breaks that equality while every deviation check passes.
        const equivalent: PathCommand[] = [
            { c: "M", x: 0, y: 0 },
            { c: "C", x1: (2 / 3) * 500, y1: (2 / 3) * 1000, x2: 1000 + (2 / 3) * (500 - 1000), y2: (2 / 3) * 1000, x: 1000, y: 0 }
        ];
        // Same COUNT — that is the part the ratio decides — and the same points to within
        // floating-point noise. Not bit-identical: splitting a quadratic and splitting its
        // elevated cubic are the same curve computed two different ways, and they land a few
        // ulps apart (15.502929687499996 against 15.5029296875).
        const viaQuad = flattenPath(q)[0].points;
        const viaCubic = flattenPath(equivalent)[0].points;
        expect(viaQuad.length).toBe(viaCubic.length);
        viaQuad.forEach((pt, i) => {
            expect(pt.x).toBeCloseTo(viaCubic[i].x, 9);
            expect(pt.y).toBeCloseTo(viaCubic[i].y, 9);
        });
        const flat: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "Q", x1: 5, y1: 0, x: 10, y: 0 }];
        expect(flattenPath(flat)[0].points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    });

    test("the ELLIPSE a boolean sees is now accurate to its tolerance, not to a segment count", () => {
        // Two different errors live here and they must not be conflated. The FLATTENING error is
        // measured against the curve it approximates — so compare the default tolerance to a
        // near-exact one, not to the circle.
        const big = ellipseCommands(2000, 2000);
        const areaOf = (rings: { x: number; y: number }[][]) => Math.abs(rings.reduce((sum, r) => {
            let a = 0;
            for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j].x * r[i].y - r[i].x * r[j].y;
            return sum + a / 2;
        }, 0));
        const coarse = areaOf(flattenPath(big).map(sp => sp.points));
        const nearExact = areaOf(flattenPath(big, 0.0005).map(sp => sp.points));
        // Bounded by the TOLERANCE, not by a precision digit picked to make the test pass: an
        // inscribed polygon loses area in proportion to how far its chords sit inside the curve,
        // so a 0.05 chord bound on a radius-1000 circle can cost at most ~0.05/1000 of the area.
        // The measured deficit is 0.0025%, comfortably inside that.
        expect(Math.abs(1 - coarse / nearExact)).toBeLessThan(FLATTEN_TOLERANCE / 1000);
        expect(coarse).toBeLessThan(nearExact);            // inscribed: always a little short

        // The RESIDUAL against a true circle is the KAPPA cubic's own error — four cubics bulge
        // about 0.027% outside the circle they approximate — and no amount of subdivision removes
        // it. Stating which error is which is the point: one is ours to fix, the other is the
        // representation, and the old fixed-count flattening hid both in one number.
        const ratio = nearExact / (Math.PI * 1000 * 1000);
        expect(ratio).toBeGreaterThan(1);
        expect(ratio).toBeCloseTo(1.00027, 4);
    });
});

// ─── Triangulation: a fill as the GPU sees it ───
describe("Marquee selection follows the INK", () => {
    const doc = (...nodes: Node[]): ProjectDocument => {
        const d = createEmptyDocument();
        for (const n of nodes) d.nodes.set(n.id, n);
        d.rootNodeUuids = nodes.map(n => n.id);
        return d;
    };
    const node = (id: string, type: Node["type"], box: { x: number; y: number; width: number; height: number }, extra: Partial<Node> = {}): Node =>
        ({ id, type, parent: null, children: [], geometry: box,
           style: { fill: "#000", opacity: 1 }, layout: {}, ...extra } as Node);
    const inRect = (d: ProjectDocument, r: { x: number; y: number; width: number; height: number }): string[] =>
        nodesInRect(computeGeometry(d), r);

    test("a ROTATED rectangle is not selected through the empty corner of its box", () => {
        // The case that makes the point on its own. A square rotated 45 degrees has a bounding box
        // whose corners are entirely outside the shape — nearly 30% of the box is empty — and a
        // marquee dragged through one of those corners used to select it. Clicks stopped trusting
        // the box when `ShapeHit` landed; the marquee had not.
        const d = doc(node("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 },
            { transform: { rotation: 45 } }));
        // The rotated square spans roughly x,y in [-20.7, 120.7]; its box corner region near
        // (-18, -18) is inside the AABB and outside the shape.
        expect(inRect(d, { x: -20, y: -20, width: 8, height: 8 })).toEqual([]);
        // Through the middle it still selects, and grazing an edge still counts (touch semantics).
        expect(inRect(d, { x: 40, y: 40, width: 20, height: 20 })).toEqual(["R"]);
        expect(inRect(d, { x: 45, y: -30, width: 10, height: 40 })).toEqual(["R"]);
    });

    test("a marquee in the NOTCH of a concave path selects nothing", () => {
        // An L's bounding box contains a quadrant the shape does not. This is the same claim the
        // decomposition test makes about rings, reached through the engine instead.
        const L: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 40 },
            { c: "L", x: 40, y: 40 }, { c: "L", x: 40, y: 100 }, { c: "L", x: 0, y: 100 }, { c: "Z" }
        ];
        const d = doc(node("P", "core.path", { x: 0, y: 0, width: 100, height: 100 }, { path: L }));
        expect(inRect(d, { x: 60, y: 60, width: 20, height: 20 })).toEqual([]);   // the notch
        expect(inRect(d, { x: 60, y: 10, width: 20, height: 20 })).toEqual(["P"]);  // the arm
        expect(inRect(d, { x: 10, y: 60, width: 20, height: 20 })).toEqual(["P"]);  // the other arm
    });

    test("an ELLIPSE is not selected through the corner of its box", () => {
        // A quarter of an ellipse's box is outside it, at every corner.
        const d = doc(node("E", "core.ellipse", { x: 0, y: 0, width: 100, height: 100 }));
        expect(inRect(d, { x: 0, y: 0, width: 8, height: 8 })).toEqual([]);
        expect(inRect(d, { x: 40, y: 40, width: 20, height: 20 })).toEqual(["E"]);
    });

    test("a diagonal LINE is not selected through the corners its diagonal misses", () => {
        // A line's box is entirely empty except along one diagonal. Its ink has no AREA, so it
        // takes the segment branch rather than the decomposition — the same split `hitsShape`
        // makes for a click.
        const d = doc(node("L", "core.line", { x: 0, y: 0, width: 100, height: 100 }));
        expect(inRect(d, { x: 80, y: 0, width: 15, height: 15 })).toEqual([]);    // above the diagonal
        expect(inRect(d, { x: 0, y: 80, width: 15, height: 15 })).toEqual([]);    // below it
        expect(inRect(d, { x: 45, y: 45, width: 10, height: 10 })).toEqual(["L"]);
    });

    test("an OPEN pen stroke stays selectable — it is its outline, not an empty region", () => {
        // The failure this had to avoid. An unfilled path encloses no area, so decomposing it
        // gives nothing; treating "no pieces" as "no overlap" would have made every pen stroke
        // impossible to marquee, exactly as an earlier rule once made one impossible to click.
        const zigzag: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 50, y: 100 }, { c: "L", x: 100, y: 0 }
        ];
        const d = doc(node("S", "core.path", { x: 0, y: 0, width: 100, height: 100 },
            { path: zigzag, style: { fill: "none", stroke: "#fff", opacity: 1 } }));
        expect(inRect(d, { x: 45, y: 90, width: 10, height: 10 })).toEqual(["S"]);   // on the stroke
        expect(inRect(d, { x: 40, y: 10, width: 20, height: 20 })).toEqual([]);      // inside the V
    });

    test("an open stroke gains no PHANTOM edge between its two ends", () => {
        // Closing an open subpath would draw a line from the last point back to the first, and a
        // marquee over that line would select a shape with nothing there. On a V that phantom
        // edge runs straight across the gap between the two arms.
        const v: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 50, y: 100 }, { c: "L", x: 100, y: 0 }
        ];
        const d = doc(node("V", "core.path", { x: 0, y: 0, width: 100, height: 100 },
            { path: v, style: { fill: "none", stroke: "#fff", opacity: 1 } }));
        // Straight along where the closing edge WOULD be, and clear of both real arms.
        expect(inRect(d, { x: 40, y: -3, width: 20, height: 6 })).toEqual([]);
        // The real ends are still there, so a marquee on one of them still hits.
        expect(inRect(d, { x: -3, y: -3, width: 6, height: 6 })).toEqual(["V"]);
    });

    test("a shape that encloses NO area is not selected by a marquee over it", () => {
        // A filled path of two points draws nothing at all — SVG fills no area for it — so
        // decomposing it yields no pieces. "No pieces" has to mean "meets nothing"; treating it
        // as a hit would make an invisible node catch marquees across its whole bounding box.
        const sliver: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 100 }, { c: "Z" }];
        const d = doc(node("N", "core.path", { x: 0, y: 0, width: 100, height: 100 },
            { path: sliver, style: { fill: "#fff", opacity: 1 } }));
        expect(inRect(d, { x: 40, y: 40, width: 20, height: 20 })).toEqual([]);
        expect(inRect(d, { x: -50, y: -50, width: 400, height: 400 })).toEqual([]);
    });

    test("containment in either direction still selects, with no case for it anywhere", () => {
        // SAT reports overlap when one operand is inside the other, so the two containment cases
        // the old bounds test spelled out are simply gone from the code.
        const d = doc(node("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }));
        expect(inRect(d, { x: -50, y: -50, width: 400, height: 400 })).toEqual(["R"]);  // marquee holds it
        expect(inRect(d, { x: 40, y: 40, width: 5, height: 5 })).toEqual(["R"]);        // it holds marquee
        // A zero-size marquee is a point, and a point inside the shape is still inside it.
        expect(inRect(d, { x: 50, y: 50, width: 0, height: 0 })).toEqual(["R"]);
    });

    test("the decomposition cache cannot go STALE across an edit", () => {
        // The pieces are memoised on the `HitShape` object they came from, which is the whole
        // invalidation story: an edit derives a new one, so the old entry is unreachable. A cache
        // keyed on the node ID instead would answer the second marquee with the first shape.
        const notch: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 40 },
            { c: "L", x: 40, y: 40 }, { c: "L", x: 40, y: 100 }, { c: "L", x: 0, y: 100 }, { c: "Z" }
        ];
        const d = doc(node("P", "core.path", { x: 0, y: 0, width: 100, height: 100 }, { path: notch }));
        const probe = { x: 60, y: 60, width: 20, height: 20 };
        expect(inRect(d, probe)).toEqual([]);                       // the notch is empty
        // Fill the notch in: the very same probe must now hit.
        d.nodes.get("P")!.path = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 },
            { c: "L", x: 100, y: 100 }, { c: "L", x: 0, y: 100 }, { c: "Z" }
        ];
        expect(inRect(d, probe)).toEqual(["P"]);
    });

    test("the BOUNDS test still runs first, and still decides most nodes", () => {
        // The exact test is the expensive one, so it must never be the first thing asked. A node
        // whose box is nowhere near the marquee is rejected before its outline is ever built —
        // asserted here as behaviour (far-away nodes are absent) rather than as a timing.
        const d = doc(
            node("A", "core.rectangle", { x: 0, y: 0, width: 50, height: 50 }),
            node("B", "core.rectangle", { x: 1000, y: 1000, width: 50, height: 50 })
        );
        expect(inRect(d, { x: 10, y: 10, width: 10, height: 10 })).toEqual(["A"]);
        expect(inRect(d, { x: 5000, y: 5000, width: 10, height: 10 })).toEqual([]);
    });

    test("a TEXT or IMAGE box is its own rectangle, so the box is not a lie for it", () => {
        // These have no outline finer than their box — the answer is the same either way, and
        // that is the reason they are allowed through rather than an oversight.
        const d = doc(
            node("T", "core.text", { x: 0, y: 0, width: 100, height: 20 }, { text: "hello" }),
            node("I", "core.image", { x: 200, y: 0, width: 100, height: 100 }, { src: "x.png" })
        );
        expect(inRect(d, { x: 10, y: 5, width: 5, height: 5 })).toEqual(["T"]);
        expect(inRect(d, { x: 205, y: 5, width: 5, height: 5 })).toEqual(["I"]);
        expect(inRect(d, { x: 500, y: 500, width: 5, height: 5 })).toEqual([]);
    });
});

describe("The FILL RULE reaches every consumer (schema 38)", () => {
    /** The classic {5/2} star: five points visited two apart, drawn as ONE crossing contour. */
    const star = (R: number): PathCommand[] => {
        const cmds: PathCommand[] = [];
        for (let k = 0; k < 5; k++) {
            const a = (2 * Math.PI * ((k * 2) % 5)) / 5 - Math.PI / 2;
            cmds.push({ c: k === 0 ? "M" : "L", x: R * Math.cos(a) + R, y: R * Math.sin(a) + R });
        }
        cmds.push({ c: "Z" });
        return cmds;
    };

    test("it is a closed vocabulary on BOTH paths", () => {
        expect(styleError({ fillRule: "evenodd" })).toBeNull();
        expect(styleError({ fillRule: "nonzero" })).toBeNull();
        expect(styleError({ fillRule: "even-odd" as never })).toMatch("fillRule");
        expect(styleError({})).toBeNull();                    // absent stays absent

        const doc = createEmptyDocument();
        doc.nodes.set("n", { id: "n", type: "core.path", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, path: star(5) });
        doc.rootNodeUuids = ["n"];
        const dispatcher = new ActionDispatcher(doc);
        expect(dispatcher.dispatchAction(new UpdateNodeStyleAction(dispatcher.getDocument(), "n", { fillRule: "evenodd" })).success).toBe(true);
        expect(dispatcher.dispatchAction(new UpdateNodeStyleAction(dispatcher.getDocument(), "n", { fillRule: "winding" as never })).success).toBe(false);
        expect(deserializeDocument(serializeDocument(dispatcher.getDocument())).nodes.get("n")!.style.fillRule).toBe("evenodd");
        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1, fillRule: "winding" }, layout: {} } } } });
        expect(() => deserializeDocument(bad)).toThrow("fillRule");
    });

    test("a schema-37 document migrates to 38 and draws identically", () => {
        // Additive, and absent is what every backend already applied. The bump is required for
        // the stronger reason: an old build IGNORES the field and fills a self-crossing path
        // solid where the author asked for a hole.
        const v37 = { version: "37", document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} } } } };
        const loaded = deserializeDocument(JSON.stringify(v37));
        expect(loaded.nodes.get("n")!.style.fillRule).toBeUndefined();
        expect(JSON.parse(serializeDocument(loaded)).version).toBe(SCHEMA_VERSION);
    });

    test("a CLICK in the middle of a star obeys the rule the document chose", () => {
        // The cardinal rule of this codebase: the hit test and the paint must agree. Under
        // even-odd the centre of a self-crossing star is a HOLE, and a picker still applying
        // nonzero would swallow clicks meant for whatever shows through it.
        const cmds = star(100);
        const solid = { kind: "path" as const, commands: cmds, filled: true, fillRule: "nonzero" as const };
        const holed = { kind: "path" as const, commands: cmds, filled: true, fillRule: "evenodd" as const };
        expect(hitsShape(solid, 200, 200, 100, 100, 0)).toBe(true);
        expect(hitsShape(holed, 200, 200, 100, 100, 0)).toBe(false);
        // A point in one of the star's POINTS is filled either way — the rules only differ where
        // the contour has wrapped more than once.
        expect(hitsShape(solid, 200, 200, 100, 12, 0)).toBe(true);
        expect(hitsShape(holed, 200, 200, 100, 12, 0)).toBe(true);
        // Absent means nonzero, so an older document picks exactly as it always did.
        expect(hitsShape({ kind: "path", commands: cmds, filled: true }, 200, 200, 100, 100, 0)).toBe(true);
    });

    test("under NONZERO, opposite-wound contours cancel — counting crossings would not", () => {
        // The two rules are not "signed" and "unsigned" versions of one test; they disagree about
        // what to accumulate. Two overlapping contours wound OPPOSITE ways cancel to zero where
        // they overlap, so nonzero leaves that part unfilled — while their crossing count there is
        // two, which is even, and a picker that summed crossings for both rules would call the
        // same spot filled. A donut cannot show this: there the two agree.
        const cw: PathCommand[] = [
            { c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 100 }, { c: "L", x: 0, y: 100 }, { c: "Z" },
            { c: "M", x: 50, y: 50 }, { c: "L", x: 50, y: 150 }, { c: "L", x: 150, y: 150 }, { c: "L", x: 150, y: 50 }, { c: "Z" }
        ];
        const shape = { kind: "path" as const, commands: cw, filled: true, fillRule: "nonzero" as const };
        // In the OVERLAP the two windings cancel: not filled, and so not clickable.
        expect(hitsShape(shape, 200, 200, 75, 75, 0)).toBe(false);
        // Outside the overlap each contour fills on its own.
        expect(hitsShape(shape, 200, 200, 20, 20, 0)).toBe(true);
        expect(hitsShape(shape, 200, 200, 130, 130, 0)).toBe(true);
    });

    test("`hitShapeOf` carries the node's rule, so the engine derives it once", () => {
        const node = { type: "core.path", path: star(10), style: { fill: "#fff", fillRule: "evenodd" as const } };
        const shape = hitShapeOf(node, 0);
        expect(shape.kind === "path" && shape.fillRule).toBe("evenodd");
        expect((hitShapeOf({ type: "core.path", path: [], style: { fill: "#fff" } }, 0) as { fillRule?: string }).fillRule).toBeUndefined();
    });

    test("the GPU turns the rule into GEOMETRY, having nothing to hand it to", () => {
        // SVG and Canvas take a `fill-rule` and apply it themselves. A GPU takes triangles, so on
        // that backend the rule has to be resolved into the shape before tessellation — which is
        // also what makes a self-crossing path come out right there at all.
        const item = (fillRule?: string) => ({
            shape: { kind: "path", commands: star(100) }, world: null, nodeId: null, role: "content",
            paint: { fill: "#ff0000", opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
                     radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null, fillRule }
        }) as never;
        const area = (t: number[]): number => {
            let a = 0;
            for (let i = 0; i < t.length; i += 6) {
                a += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
            }
            return a;
        };
        const [solid] = itemDraws(item("nonzero"));
        const [holed] = itemDraws(item("evenodd"));
        // The difference is the central pentagon, whose circumradius is R/phi^2.
        const phi = (1 + Math.sqrt(5)) / 2, r = 100 / (phi * phi);
        expect(area(solid.vertices) - area(holed.vertices)).toBeCloseTo(2.5 * r * r * Math.sin((2 * Math.PI) / 5), 4);
        // Absent = nonzero, so an older document draws on the GPU exactly as before.
        const [dflt] = itemDraws(item(undefined));
        expect(area(dflt.vertices)).toBeCloseTo(area(solid.vertices), 6);
    });

    test("the GPU draws a self-crossing path CORRECTLY, which it could not before", () => {
        // Ear clipping is defined on simple polygons; handed a crossing contour it emitted
        // overlapping triangles. Resolving first is what closes that, and the measure is that the
        // triangles now cover the region's own area rather than a larger, double-counted one.
        const item = {
            shape: { kind: "path", commands: star(100) }, world: null, nodeId: null, role: "content",
            paint: { fill: "#ff0000", opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
                     radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null }
        } as never;
        const [draw] = itemDraws(item);
        let a = 0;
        for (let i = 0; i < draw.vertices.length; i += 6) {
            a += Math.abs((draw.vertices[i + 2] - draw.vertices[i]) * (draw.vertices[i + 5] - draw.vertices[i + 1])
                - (draw.vertices[i + 4] - draw.vertices[i]) * (draw.vertices[i + 3] - draw.vertices[i + 1])) / 2;
        }
        const resolved = resolveRings(commandsToRings(star(100)), "nonzero");
        const truth = Math.abs(resolved.reduce((sum, ring) => {
            let s = 0;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
            return sum + s;
        }, 0)) / 2;
        expect(a).toBeCloseTo(truth, 6);
    });
});

describe("Lighting — normals from the mesh, Lambert on the GPU (schema 42)", () => {
    const box = { width: 100, height: 100 };
    const doc = (...nodes: Node[]): ProjectDocument => {
        const d = createEmptyDocument();
        for (const n of nodes) d.nodes.set(n.id, n);
        d.rootNodeUuids = nodes.map(n => n.id);
        return d;
    };
    const node = (id: string, mesh?: Mesh): Node =>
        ({ id, type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 100, height: 100 },
           style: { fill: "#808080", opacity: 1 }, layout: {}, ...(mesh ? { mesh } : {}) } as Node);
    /** A rest grid with one corner RAISED — the smallest thing a light can find. */
    const raised = (z: number): Mesh => {
        const m = restMesh(1, 1, box);
        m.points[3] = { ...m.points[3], z };
        return m;
    };
    const light = (x: number, y: number, z: number, intensity = 1): Light =>
        ({ x, y, z, color: "#ffffff", intensity });

    test("a FLAT mesh faces the viewer exactly, so an unlit shape stays unlit-looking", () => {
        // Exact, not nearly: a lighting term multiplied by an almost-normalised normal is how a
        // flat fill acquires a faint gradient nobody asked for.
        const flat = restMesh(2, 2, box);
        expect(isFlatMesh(flat)).toBe(true);
        expect(normalAt(flat, box, 50, 50)).toEqual({ x: 0, y: 0, z: 1 });
        expect(normalAt(flat, box, 0, 0)).toEqual({ x: 0, y: 0, z: 1 });
        // An in-plane WARP is still flat: bending a shape sideways tilts nothing.
        const warped = restMesh(1, 1, box);
        warped.points[3] = { x: 160, y: 100 };
        expect(isFlatMesh(warped)).toBe(true);
        expect(normalAt(warped, box, 50, 50)).toEqual({ x: 0, y: 0, z: 1 });
    });

    test("raising a control point TILTS the surface, and always toward the viewer", () => {
        const m = raised(40);
        const n = normalAt(m, box, 90, 90);
        expect(n.z).toBeGreaterThan(0);              // never lit from behind
        expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 9);
        // The corner rises as x and y increase, so the surface leans back the other way.
        expect(n.x).toBeLessThan(0);
        expect(n.y).toBeLessThan(0);
        // Raising it FURTHER tilts it further — the normal leans off the viewer axis.
        expect(normalAt(raised(200), box, 90, 90).z).toBeLessThan(n.z);
    });

    test("a MIRRORED patch still faces the viewer", () => {
        // The sign guard's only reachable case, and it is reachable: drag two control points past
        // each other and the patch turns inside out, which flips the cross product. Without the
        // guard those shapes would be lit from behind — dark where every neighbour is bright.
        const m = restMesh(1, 1, box);
        const [a, b, c, d] = m.points.map(p => ({ ...p }));
        m.points[0] = { ...b }; m.points[1] = { ...a };     // swap the top row: the patch mirrors
        m.points[2] = { ...d }; m.points[3] = { ...c };
        m.points[3].z = 40;
        expect(normalAt(m, box, 50, 50).z).toBeGreaterThan(0);
    });

    test("a COLLAPSED shape has no surface, and says so as flat", () => {
        // Two tangents that are zero or parallel give no normal at all. A shape with no width is
        // a legitimate mid-edit state — a drag that has not moved yet — so it reports facing the
        // viewer rather than producing a direction from nothing.
        const m = raised(40);
        expect(normalAt(m, { width: 0, height: 0 }, 0, 0)).toEqual({ x: 0, y: 0, z: 1 });
        expect(normalAt(m, { width: 0, height: 100 }, 0, 50)).toEqual({ x: 0, y: 0, z: 1 });
    });

    test("height blends between control points like the warp does", () => {
        const m = raised(80);
        expect(warpHeight(m, box, 0, 0)).toBe(0);
        expect(warpHeight(m, box, 100, 100)).toBeCloseTo(80, 9);
        // The centre takes the average of all four corners, as the position does.
        expect(warpHeight(m, box, 50, 50)).toBeCloseTo(20, 9);
    });

    test("LAMBERT: a face lit head-on gets full light, one edge-on gets none, one behind gets none", () => {
        const straightOn = { x: 0, y: 0, z: 1 };
        // A light travelling INTO the screen arrives on a face pointing out of it.
        expect(lambert(straightOn, light(0, 0, -1))).toBeCloseTo(1, 9);
        expect(lambert(straightOn, light(1, 0, 0))).toBeCloseTo(0, 9);
        // CLAMPED, not negative: a light from behind must not subtract. Unclamped, a second light
        // could make a shape darker, which is the least explicable thing a lighting model can do.
        expect(lambert(straightOn, light(0, 0, 1))).toBe(0);
        // Intensity scales it; a longer direction vector does NOT, being normalised first.
        expect(lambert(straightOn, light(0, 0, -1, 0.5))).toBeCloseTo(0.5, 9);
        expect(lambert(straightOn, light(0, 0, -7))).toBeCloseTo(1, 9);
        // A direction of zero is not a direction, so it lights nothing rather than picking an axis.
        expect(lambert(straightOn, { x: 0, y: 0, z: 0, color: "#fff", intensity: 1 })).toBe(0);
    });

    test("the SHADOW a light casts is derived, not typed in", () => {
        // The only shadow a renderer with no depth texture can honestly cast: a shape floating
        // above the page throws its outline away from the light, further the higher it is.
        expect(shadowOffset(light(1, 0, -1), 0)).toEqual({ x: 0, y: 0 });   // on the page: nothing to cast
        // EXACTLY positive zero, from the short-circuit rather than the arithmetic: a NEGATIVE
        // direction times a zero depth gives -0, which differs under `Object.is` and would make
        // "has this shadow moved?" comparisons answer wrongly. The same trap parallax had.
        const back = shadowOffset(light(-1, -1, 0), 0);
        expect(Object.is(back.x, 0)).toBe(true);
        expect(Object.is(back.y, 0)).toBe(true);
        // RAISED is NEGATIVE depth, and this is the whole correction. `depth` counts AWAY from the
        // viewer — its three other consumers all agree: positive lags the pan, draws first, takes
        // a larger clip z. So the shape that floats above the page and throws a shadow is the one
        // at negative depth, and height is `-depth`.
        const near = shadowOffset(light(1, 0, 0), -10);
        const far = shadowOffset(light(1, 0, 0), -40);
        expect(near).toEqual({ x: 10, y: 0 });
        expect(far.x).toBe(4 * near.x);
        expect(heightAbovePage(-10)).toBe(10);
        // A SUNK shape casts nothing. It is below the page, so there is nothing between it and
        // the page to cast onto — and the version that shipped for two commits threw its shadow
        // backwards INTO the light here, which is the least physical thing a shadow can do.
        expect(shadowOffset(light(1, 0, 0), 10)).toEqual({ x: 0, y: 0 });
        expect(heightAbovePage(10)).toBe(0);
        expect(heightAbovePage(0)).toBe(0);
        // It follows the light's DIRECTION, so moving the light moves every shadow together.
        expect(shadowOffset(light(0, 1, 0), -10)).toEqual({ x: 0, y: 10 });
        expect(shadowOffset({ x: 0, y: 0, z: 0, color: "#fff", intensity: 1 }, -10)).toEqual({ x: 0, y: 0 });

        // The length is set by the GAP the light crosses, not by how high the caster is. A card
        // 40 above the page throws 40 onto the page and only 20 onto a card floating at 20 —
        // there is only 20 of air between them. With one raised shape and a flat page the two
        // formulas are identical, which is why this shipped wrong and no test noticed.
        expect(shadowOffset(light(1, 0, 0), -40, 0)).toEqual({ x: 40, y: 0 });
        expect(shadowOffset(light(1, 0, 0), -40, -20)).toEqual({ x: 20, y: 0 });
        expect(shadowOffset(light(1, 0, 0), -40, -40)).toEqual({ x: 0, y: 0 });   // same plane
        // A receiver ABOVE the caster gets nothing; a negative gap would throw the shadow toward
        // the light, which is the one direction a shadow never goes.
        expect(shadowOffset(light(1, 0, 0), -20, -40)).toEqual({ x: 0, y: 0 });
        // A receiver SUNK behind the page is no further away than the page itself — the caster is
        // not casting through it, so the gap floors at the page.
        expect(shadowOffset(light(1, 0, 0), -40, 25)).toEqual({ x: 40, y: 0 });
    });

    test("the GPU gets ONE NORMAL PER VERTEX, and flat ones when there is no surface", () => {
        // Per vertex is the whole point: a mesh raised in the middle faces a different way there
        // than at its edges, and one normal for the shape would light a dome like a flat card.
        const [flat] = itemDraws({
            shape: { kind: "rect", x: 0, y: 0, width: 100, height: 100 }, world: null, nodeId: null, role: "content",
            paint: { fill: "#ffffff", opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
                     radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null }
        } as never);
        expect(flat.normals.length).toBe((flat.vertices.length / 2) * 3);
        for (let i = 0; i < flat.normals.length; i += 3) {
            expect([flat.normals[i], flat.normals[i + 1], flat.normals[i + 2]]).toEqual([0, 0, 1]);
        }
        // With a SURFACE, they are not all the same any more.
        const [lit] = itemDraws({
            shape: { kind: "rect", x: 0, y: 0, width: 100, height: 100 }, world: null, nodeId: null, role: "content",
            surface: { mesh: raised(60), box },
            paint: { fill: "#ffffff", opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
                     radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null }
        } as never);
        expect(lit.normals.length).toBe((lit.vertices.length / 2) * 3);
        const xs = new Set<number>();
        for (let i = 0; i < lit.normals.length; i += 3) xs.add(Math.round(lit.normals[i] * 1000));
        expect(xs.size).toBeGreaterThan(1);
        // …and they are NOT unit vectors. The raw length is what makes them survive the GPU's
        // linear interpolation, and the fragment shader normalises what arrives — see the note on
        // `surfaceNormal`. At least one is longer than 1, which no unit vector ever is.
        let longest = 0;
        for (let i = 0; i < lit.normals.length; i += 3) {
            longest = Math.max(longest, Math.hypot(lit.normals[i], lit.normals[i + 1], lit.normals[i + 2]));
        }
        expect(longest).toBeGreaterThan(1.01);
        // Their DIRECTION is still the surface's own, so nothing about the lighting has moved —
        // only where the division by the length happens.
        const surface = raised(60);
        for (let i = 0, v = 0; i < lit.normals.length; i += 3, v += 2) {
            const unit = normalAt(surface, box, lit.vertices[v], lit.vertices[v + 1]);
            const len = Math.hypot(lit.normals[i], lit.normals[i + 1], lit.normals[i + 2]);
            expect(lit.normals[i] / len).toBeCloseTo(unit.x, 9);
            expect(lit.normals[i + 2] / len).toBeCloseTo(unit.z, 9);
        }
    });

    test("a RAW normal survives interpolation exactly, where a unit one does not", () => {
        // The reason the GPU is handed un-normalised normals, measured rather than asserted.
        //
        // Between two vertices a GPU interpolates linearly, and inside one cell the raw normal is
        // an affine function of position — so the interpolation IS the surface. Normalising first
        // is a nonlinear step, and what interpolates afterwards is a different function that meets
        // the truth only at the corners. The gap between the two is the faceting.
        const m = raised(100);                            // h = x·y/100 over a single 100×100 cell
        const corners: [number, number][] = [[0, 0], [100, 0], [0, 100]];
        const mid = { x: (0 + 100 + 0) / 3, y: (0 + 0 + 100) / 3 };
        const blend = (f: (x: number, y: number) => { x: number; y: number; z: number }) => {
            const s = corners.map(([x, y]) => f(x, y));
            const avg = { x: (s[0].x + s[1].x + s[2].x) / 3, y: (s[0].y + s[1].y + s[2].y) / 3, z: (s[0].z + s[1].z + s[2].z) / 3 };
            const len = Math.hypot(avg.x, avg.y, avg.z);
            return { x: avg.x / len, y: avg.y / len, z: avg.z / len };
        };
        const truth = normalAt(m, box, mid.x, mid.y);
        const fromRaw = blend((x, y) => surfaceNormal(m, box, x, y));
        const fromUnit = blend((x, y) => normalAt(m, box, x, y));
        // EXACT, to every digit a double carries — not merely closer.
        expect(fromRaw.x).toBeCloseTo(truth.x, 12);
        expect(fromRaw.y).toBeCloseTo(truth.y, 12);
        expect(fromRaw.z).toBeCloseTo(truth.z, 12);
        // The unit one is wrong by degrees, which is what a facet edge is.
        expect(Math.abs(fromUnit.x - truth.x)).toBeGreaterThan(0.02);
        expect(Math.abs(fromUnit.z - truth.z)).toBeGreaterThan(0.01);
    });

    test("the raw normal's LENGTH does not depend on where in the box it was sampled", () => {
        // The tangents are divided by their own step. The samples are clamped inside the box, so
        // at an edge the step is half what it is inland — left in, the vector's length would say
        // more about the sampling than about the surface, and the affine property the GPU relies
        // on would hold everywhere except the rim, which is where a shape's vertices mostly are.
        // h = x·y/100 over one cell, so the surface's own normal is exactly (−y/100, −x/100, 1).
        const m = raised(100);
        // ON THE EDGE y = 0, where the centred difference is clamped to HALF its usual span. The
        // slope must still come out at its full value: undivided, this would read −0.25.
        expect(surfaceNormal(m, box, 50, 0)).toEqual({ x: 0, y: -0.5, z: 1 });
        // The corner, where BOTH steps are clamped — the case that made every rectangle vertex
        // report itself flat once before.
        expect(surfaceNormal(m, box, 0, 0)).toEqual({ x: 0, y: 0, z: 1 });
        expect(surfaceNormal(m, box, 100, 0)).toEqual({ x: 0, y: -1, z: 1 });
        // INLAND, where nothing is clamped, the same rule gives the same kind of answer — so an
        // edge sample and an interior one are on one scale rather than two.
        expect(surfaceNormal(m, box, 50, 50).x).toBeCloseTo(-0.5, 9);
        expect(surfaceNormal(m, box, 50, 50).y).toBeCloseTo(-0.5, 9);
        // The z component is the in-plane Jacobian, which this mesh leaves at 1 everywhere.
        expect(surfaceNormal(m, box, 100, 50).z).toBeCloseTo(1, 12);
        expect(surfaceNormal(m, box, 50, 50).z).toBeCloseTo(1, 12);
        // A collapsed surface answers ZERO rather than picking a direction — the GPU path
        // substitutes a flat normal, because a shader normalising zero produces NaN.
        expect(surfaceNormal(m, { width: 0, height: 100 }, 0, 50)).toEqual({ x: 0, y: 0, z: 0 });
    });

    test("a COLLAPSED cell never reaches the GPU as a zero normal", () => {
        // Reachable by dragging: two control points pulled onto each other leave a cell with no
        // width, so it has no tangents and genuinely no normal. `surfaceNormal` says so. The
        // shader normalises whatever it is handed, and normalising zero is NaN — which is not a
        // dark shape, it is a hole.
        const collapsed = restMesh(2, 1, box);
        collapsed.points[1] = { ...collapsed.points[0] };     // top-middle onto top-left
        collapsed.points[4] = { ...collapsed.points[3], z: 40 };
        collapsed.points[3] = { ...collapsed.points[3], z: 40 };
        expect(surfaceNormal(collapsed, box, 10, 50)).toEqual({ x: 0, y: 0, z: 0 });
        const [d] = itemDraws({
            shape: { kind: "rect", x: 0, y: 0, width: 100, height: 100 }, world: null, nodeId: null, role: "content",
            surface: { mesh: collapsed, box },
            paint: { fill: "#ffffff", opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
                     radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null }
        } as never);
        for (let i = 0; i < d.normals.length; i += 3) {
            const len = Math.hypot(d.normals[i], d.normals[i + 1], d.normals[i + 2]);
            expect(len).toBeGreaterThan(0);
            expect(Number.isFinite(len)).toBe(true);
        }
    });

    test("the GPU gets the surface as a TEXTURE, and each vertex's place on it", () => {
        // What replaced a per-vertex shadow term. The fragment stage marches for itself, so what
        // it needs is the heightfield and a position — not an answer computed at three corners.
        const ridge = (): Mesh => {
            const m = restMesh(4, 1, box);
            m.points[1] = { ...m.points[1], z: 120 };
            m.points[6] = { ...m.points[6], z: 120 };
            return m;
        };
        const item = (mesh?: Mesh) => itemDraws({
            shape: { kind: "rect", x: 0, y: 0, width: 100, height: 100 }, world: null, nodeId: null, role: "content",
            ...(mesh ? { surface: { mesh, box } } : {}),
            paint: { fill: "#ffffff", opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
                     radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null }
        } as never)[0];

        const lit = item(ridge());
        // A LOCAL position per vertex. With no world matrix these are the vertices themselves,
        // which is the cheapest possible check that they are not the world ones by accident.
        expect(lit.locals.length).toBe(lit.vertices.length);
        expect(lit.locals).toEqual(lit.vertices);
        expect(lit.height).not.toBeNull();
        expect(lit.height!.size).toBe(HEIGHT_TEX_SIZE);
        expect(lit.height!.data.length).toBe(HEIGHT_TEX_SIZE * HEIGHT_TEX_SIZE * 4);
        expect(lit.height!.max).toBe(120);
        expect(lit.height!.min).toBe(0);
        // A FLAT mesh has no relief and no range to pack against, so there is no texture and the
        // shader is told to skip the march entirely.
        expect(item(restMesh(2, 2, box)).height).toBeNull();
        // …and a shape with no surface at all pays nothing.
        expect(item().height).toBeNull();
        expect(item().locals.length).toBe(item().vertices.length);
    });

    test("a decoded image advances the GENERATION, which is what re-uploads the texture", () => {
        // The GPU needs this and Canvas does not, which is why it exists and why it is easy to
        // leave out. Canvas hands `drawImage` a live element every frame; a texture is a COPY, so
        // without a version number the backend either re-encodes every image every frame or keeps
        // forever the blank bitmap that existed before the load finished.
        const before = imageGeneration();
        // No DOM in this environment, so `Image` is supplied — and its `src` setter decodes
        // immediately, which is the whole event this is about.
        class FakeImage {
            onload: (() => void) | null = null;
            set src(_href: string) { this.onload?.(); }
        }
        const had = (globalThis as { Image?: unknown }).Image;
        (globalThis as { Image?: unknown }).Image = FakeImage;
        try {
            expect(resolveImage("gen-test-a.png")).not.toBeNull();
            expect(imageGeneration()).toBe(before + 1);
            // CACHED: asking again is not a second decode, so the generation must not move — a
            // backend keyed on it would otherwise re-upload on every frame that draws the image.
            expect(resolveImage("gen-test-a.png")).not.toBeNull();
            expect(imageGeneration()).toBe(before + 1);
            // A DIFFERENT href is a different decode.
            expect(resolveImage("gen-test-b.png")).not.toBeNull();
            expect(imageGeneration()).toBe(before + 2);
        } finally {
            if (had === undefined) delete (globalThis as { Image?: unknown }).Image;
            else (globalThis as { Image?: unknown }).Image = had;
        }
        // With no DOM at all it answers null and stays quiet, which is what every other test in
        // this file relies on.
        expect(resolveImage("gen-test-c.png")).toBeNull();
        expect(imageGeneration()).toBe(before + 2);
    });

    test("the text RASTER scale is quantised, and its key ignores position", () => {
        // Quantised for the same reason `displayTolerance` is: a raster keyed on the exact zoom
        // is rebuilt on every wheel tick, and rebuilding a bitmap mid-gesture is what a canvas
        // hitching while you scroll actually is.
        expect(textRasterScale(1)).toBe(1);
        expect(textRasterScale(1.3)).toBe(2);
        expect(textRasterScale(2)).toBe(2);
        expect(textRasterScale(2.1)).toBe(4);
        // A whole zoom range crosses only a handful of rebuild boundaries.
        expect(new Set([1.1, 1.5, 1.9, 2].map(textRasterScale)).size).toBe(1);
        // BOUNDED both ways: below 1 there is nothing finer than the screen to resolve, and the
        // ceiling is what stops a deep zoom asking for a bitmap the GPU will refuse.
        expect(textRasterScale(0.2)).toBe(TEXT_RASTER_MIN);
        expect(textRasterScale(1000)).toBe(TEXT_RASTER_MAX);
        expect(textRasterScale(0)).toBe(TEXT_RASTER_MIN);
        expect(textRasterScale(NaN)).toBe(TEXT_RASTER_MIN);

        const shape = { kind: "text", x: 5, y: 7, width: 100, height: 40, text: "hello there",
                        fontSize: 14, fontFamily: "sans-serif", fontWeight: 400, textAlign: "left",
                        lineHeight: 1.2, letterSpacing: 0 } as never;
        const moved = { ...(shape as object), x: 900, y: 900 } as never;
        const paint = { fill: "#000000", opacity: null } as never;
        // POSITION is absent from the key, because the raster is drawn in local coordinates and
        // placed by the geometry. Getting this wrong is invisible — the text still looks right, it
        // is just re-rasterised on every frame of a drag.
        expect(textRasterKey(shape, paint, 2)).toBe(textRasterKey(moved, paint, 2));
        // Everything that DOES change the pixels changes the key.
        expect(textRasterKey(shape, paint, 2)).not.toBe(textRasterKey(shape, paint, 4));
        expect(textRasterKey(shape, paint, 2))
            .not.toBe(textRasterKey({ ...(shape as object), text: "hello" } as never, paint, 2));
        expect(textRasterKey(shape, paint, 2))
            .not.toBe(textRasterKey({ ...(shape as object), fontSize: 15 } as never, paint, 2));
        expect(textRasterKey(shape, paint, 2))
            .not.toBe(textRasterKey({ ...(shape as object), width: 101 } as never, paint, 2));
        expect(textRasterKey(shape, paint, 2))
            .not.toBe(textRasterKey(shape, { fill: "#ff0000", opacity: null } as never, 2));
        // The separator is a NUL, and this is the case that needs it: `text` is followed by
        // `width`, so a digit can migrate across the boundary. Text "a" in a 12-wide box and text
        // "a1" in a 2-wide box are different pixels and would share a key if the fields were
        // simply concatenated — the sort of collision that shows up as one text node wearing
        // another's bitmap.
        expect(textRasterKey({ ...(shape as object), text: "a", width: 12 } as never, paint, 1))
            .not.toBe(textRasterKey({ ...(shape as object), text: "a1", width: 2 } as never, paint, 1));
    });

    test("an IMAGE reaches the GPU backend instead of being silently dropped", () => {
        // The gap this backend's own header called out: a document that loses content when you
        // switch to it. An image is now the same triangles as any other rect with a picture over
        // them, which is what the heightfield's texture path bought.
        const img = (href: string | null) => itemDraws({
            shape: { kind: "image", x: 10, y: 20, width: 80, height: 40, href },
            world: null, nodeId: "i", role: "content",
            paint: { fill: null, opacity: 0.5, stroke: null, strokeWidth: null, strokeDash: null,
                     radius: null, cursor: "pointer", pointerEvents: true, shadow: null, blur: null }
        } as never);

        const [picture] = img("cat.png");
        expect(picture).toBeDefined();
        expect(picture.vertices.length).toBeGreaterThan(0);
        expect(picture.image).toEqual({ href: "cat.png", x: 10, y: 20, width: 80, height: 40 });
        // The rect it reports is the one the shader turns into texture coordinates, so it has to
        // be the shape's OWN rect — not the box at the origin the triangles happen to start from.
        expect(shapeToLocalCommands({ kind: "image", x: 10, y: 20, width: 80, height: 40, href: "c" }, null))
            .not.toBeNull();
        // The item's OPACITY rides in the colour's alpha, because an image has no fill of its own
        // and the shader multiplies the sampled alpha by it.
        expect(picture.color[3]).toBeCloseTo(0.5, 9);
        // An image with NO href is a node with nothing in it — no draw at all rather than a white
        // rectangle, which is a worse lie than nothing.
        expect(img(null)).toEqual([]);
        // An ordinary shape carries no image, so nothing about the existing path changed.
        const [plain] = itemDraws({
            shape: { kind: "rect", x: 0, y: 0, width: 10, height: 10 }, world: null, nodeId: null, role: "content",
            paint: { fill: "#ffffff", opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
                     radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null }
        } as never);
        expect(plain.image).toBeNull();
    });

    test("the packed heightfield ROUND-TRIPS, and its texels sit where the GPU reads them", () => {
        // The fragment shader contains this decode and cannot be tested, so pinning the round trip
        // here is the only checked definition the packing has. An error is not a crash — it is a
        // surface subtly the wrong height, which looks like a lighting bug forever.
        const m = restMesh(1, 1, box);
        m.points[3] = { ...m.points[3], z: 260 };
        const tex = heightTexture(m, box)!;
        expect(tex.min).toBe(0);
        expect(tex.max).toBe(260);
        // Sampled at TEXEL CENTRES, which is where `texture2D` reads. Checking the corner texel
        // against `warpHeight` at that exact point is what catches an off-by-half-a-texel — the
        // error that reads as the whole surface sliding under its own lighting.
        const at = (t: typeof tex, col: number, row: number) => {
            const i = (row * t.size + col) * 4;
            return decodeHeight(t.data[i], t.data[i + 1], t.min, t.max);
        };
        for (const [col, row] of [[0, 0], [63, 63], [31, 17], [63, 0]]) {
            const x = ((col + 0.5) / tex.size) * box.width;
            const y = ((row + 0.5) / tex.size) * box.height;
            // 16 bits over a 260-unit range resolves to 0.004; eight would have been one unit,
            // and one-unit steps in the surface become visible steps in the shadow's edge.
            expect(at(tex, col, row)).toBeCloseTo(warpHeight(m, box, x, y), 2);
        }
        expect(decodeHeight(0, 0, 0, 260)).toBe(0);
        expect(decodeHeight(255, 255, 0, 260)).toBe(260);
        // NEGATIVE relief packs against its own range, so all sixteen bits go on what exists.
        const dip = restMesh(1, 1, box);
        dip.points[0] = { ...dip.points[0], z: -40 };
        const dipTex = heightTexture(dip, box)!;
        expect([dipTex.min, dipTex.max]).toEqual([-40, 0]);
        // Decoded against ITS OWN range, so the deepest texel comes back at -40 rather than at
        // whatever an absolute scale would have made of it. This is what catches a packing that
        // normalises by the span but forgets to subtract the floor: with a min of 0 — every case
        // above — the two are identical, and only a surface that goes BELOW the page tells them
        // apart.
        expect(at(dipTex, 0, 0)).toBeCloseTo(warpHeight(dip, box, box.width / 128, box.height / 128), 1);
        expect(at(dipTex, 0, 0)).toBeLessThan(-38);
        expect(at(dipTex, 63, 63)).toBeCloseTo(0, 2);
        expect(heightTexture(restMesh(2, 2, box), box)).toBeNull();
    });

    test("heightRange reads the CONTROL POINTS, which bounds the ray exactly", () => {
        // Exact rather than sampled: a bilinear patch blends its four corners, so nothing inside a
        // cell is higher than the highest of them. That is what makes the grid a sound bound on
        // the march — and a bound that is too small silently shortens the ray.
        expect(heightRange(restMesh(2, 2, box))).toEqual({ min: 0, max: 0 });
        const m = restMesh(1, 1, box);
        m.points[3] = { ...m.points[3], z: 55 };
        m.points[0] = { ...m.points[0], z: -20 };
        expect(heightRange(m)).toEqual({ min: -20, max: 55 });
    });

    test("the model carries the surface only when a mesh has HEIGHT", () => {
        // A purely in-plane warp faces the viewer everywhere, so shipping its normals would cost
        // a buffer per frame to say "flat" three times per triangle.
        const bent = restMesh(1, 1, box);
        bent.points[3] = { x: 160, y: 100 };
        const modelOf = (n: Node) => buildRenderModel({ width: 800, height: 600 }, doc(n),
            { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(doc(n)), viewport: { x: 0, y: 0, zoom: 1 } });
        expect(modelOf(node("A", bent)).content[0].surface).toBeUndefined();
        expect(modelOf(node("A", raised(30))).content[0].surface).toBeDefined();
        expect(modelOf(node("A")).content[0].surface).toBeUndefined();
    });

    test("SUBDIVISION splits until every edge fits, four ways, and stays bounded", () => {
        // One big triangle, split until nothing is longer than 30.
        const big = [0, 0, 240, 0, 0, 240];
        const fine = subdivideTriangles(big, 30);
        expect(fine.length / 6).toBeGreaterThan(1);
        for (let i = 0; i + 5 < fine.length; i += 6) {
            const e = Math.max(
                Math.hypot(fine[i + 2] - fine[i], fine[i + 3] - fine[i + 1]),
                Math.hypot(fine[i + 4] - fine[i + 2], fine[i + 5] - fine[i + 3]),
                Math.hypot(fine[i] - fine[i + 4], fine[i + 1] - fine[i + 5]));
            expect(e).toBeLessThanOrEqual(30 * 1.0001);
        }
        // FOUR ways, not three: the middle piece is what stops the split leaving a hole exactly
        // the size of the triangle's own middle. Area is conserved, which is how that shows.
        const area = (t: readonly number[]): number => {
            let a = 0;
            for (let i = 0; i + 5 < t.length; i += 6) {
                a += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
            }
            return a;
        };
        expect(area(fine)).toBeCloseTo(area(big), 6);
        // BOUNDED twice: by the depth cap, since `maxEdge` comes from a mesh a document controls.
        const absurd = subdivideTriangles(big, 1e-9);
        expect(absurd.length / 6).toBeLessThanOrEqual(Math.pow(4, SUBDIVIDE_MAX_DEPTH));
        expect(area(absurd)).toBeCloseTo(area(big), 6);
        // A triangle already small enough is returned untouched, so a flat fill pays nothing.
        expect(subdivideTriangles(big, 1000)).toEqual(big);
        expect(subdivideTriangles(big, 0)).toEqual(big);
        expect(subdivideTriangles([], 10)).toEqual([]);
    });

    test("subdivision happens ONLY where there is a surface to shade", () => {
        // A flat fill needs no interior detail and every extra triangle is waste, so the cost is
        // paid exactly where it buys something.
        const box = { width: 280, height: 280 };
        const flatItem = {
            shape: { kind: "rect", x: 0, y: 0, width: 280, height: 280 }, world: null, nodeId: null, role: "content",
            paint: { fill: "#ffffff", opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
                     radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null }
        } as never;
        const [plain] = itemDraws(flatItem);
        expect(plain.vertices.length / 2).toBe(6);           // two triangles, and no more
        const dome = restMesh(4, 4, box);
        dome.points = dome.points.map((p, i) => {
            const col = i % 5, row = Math.floor(i / 5);
            const edge = col === 0 || row === 0 || col === 4 || row === 4;
            return { ...p, z: edge ? 0 : 150 };
        });
        const [lit] = itemDraws({ ...(flatItem as object), surface: { mesh: dome, box } } as never);
        expect(lit.vertices.length / 2).toBeGreaterThan(plain.vertices.length / 2);
    });

    test("a raised shape reaches the GPU with normals that actually VARY", () => {
        // The end-to-end claim, and the one that was missing: unit tests fed `itemDraws` a surface
        // directly and passed, while nothing checked that a document produces vertices the surface
        // can be sampled AT. It did not. A rectangle tessellates to two triangles whose vertices
        // are only its four CORNERS, and at the rim of a raised mesh the gradient is zero — so
        // every normal came out (0,0,1) and the Lambert term had nothing to do. Measured live as
        // 96 normal buffers uploaded and zero of them non-flat.
        //
        // The fix is that HEIGHT now subdivides the outline, so the shading has somewhere to live.
        const raisedDome = restMesh(4, 4, { width: 280, height: 280 });
        raisedDome.points = raisedDome.points.map((p, i) => {
            const col = i % 5, row = Math.floor(i / 5);
            const edge = col === 0 || row === 0 || col === 4 || row === 4;
            return { ...p, z: edge ? 0 : 150 };
        });
        const d = doc({ id: "A", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 280, height: 280 },
            style: { fill: "#808080", opacity: 1 }, layout: {}, mesh: raisedDome } as Node);
        const model = buildRenderModel({ width: 800, height: 600 }, d,
            { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(d), viewport: { x: 0, y: 0, zoom: 1 } });
        const item = model.content[0];
        expect(item.surface).toBeDefined();
        const [drawn] = itemDraws(item);
        // Enough vertices to sample a surface with, rather than the four a rectangle would give.
        expect(drawn.vertices.length / 2).toBeGreaterThan(8);
        const nonFlat = [];
        for (let i = 0; i < drawn.normals.length; i += 3) {
            if (Math.abs(drawn.normals[i]) > 1e-3 || Math.abs(drawn.normals[i + 1]) > 1e-3) nonFlat.push(i);
        }
        expect(nonFlat.length).toBeGreaterThan(0);
    });

    test("a raised shape CASTS a drop shadow, derived from the light rather than typed in", () => {
        // `shadowOffset` existed and nothing used it, which is a feature without a consumer — the
        // rule this codebase applies to everything else. This is the consumer: move the light and
        // every shadow moves together, which hand-set ones cannot do.
        const lit = (depth: number, light?: Light) => {
            const d = doc({ id: "A", type: "core.rectangle", parent: null, children: [],
                geometry: { x: 0, y: 0, width: 100, height: 100 },
                style: { fill: "#808080", opacity: 1 }, layout: {}, ...(depth ? { depth } : {}) } as Node);
            if (light) d.lights = [light];
            return buildRenderModel({ width: 800, height: 600 }, d,
                { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(d), viewport: { x: 0, y: 0, zoom: 1 } })
                .content[0].paint.shadow;
        };
        const key: Light = { x: 1, y: 0, z: -1, color: "#ffffff", intensity: 1 };
        // On the page there is nothing to cast onto, so no shadow at all.
        expect(lit(0, key)).toBeNull();
        // Unlit, a raised shape still casts nothing: a shadow needs a light to be cast BY.
        expect(lit(-20, undefined)).toBeNull();
        // RAISED is NEGATIVE depth — depth counts away from the viewer, so the shape that floats
        // above the page is the one in FRONT of it. A shape SUNK behind the page casts nothing.
        expect(lit(20, key)).toBeNull();
        const near = lit(-10, key)!;
        const far = lit(-40, key)!;
        expect(near.dx).toBeGreaterThan(0);
        // HIGHER above the page throws further, and softer — the difference between a card lying
        // on the page and one held above it.
        expect(far.dx).toBe(4 * near.dx);
        expect(far.blur).toBeGreaterThan(near.blur);
        // It follows the light's DIRECTION, so the whole scene agrees about where "away" is.
        const fromBelow = lit(-10, { x: 0, y: -1, z: 0, color: "#fff", intensity: 1 })!;
        expect(fromBelow.dy).toBeLessThan(0);
        expect(Math.abs(fromBelow.dx)).toBeCloseTo(0, 9);
    });

    test("RAY CASTING: a raised edge shadows the ground beside it", () => {
        // The question a normal cannot answer. The ground next to a step faces the light squarely
        // — its normal is straight up — and is still in shadow, because the step is in the way.
        // A surface whose shadowing can be worked out on paper: a wall at x = 50, 100 tall.
        const step = (x: number) => (x < 50 ? 0 : 100);
        const h = (x: number, _y: number) => step(x);
        const s = Math.SQRT1_2;
        const fromRight = { x: s, y: 0, z: s };      // light over the +x side, 45° up
        const fromLeft = { x: -s, y: 0, z: s };
        // At x = 40 the wall is 10 away and 100 tall; a 45° ray has climbed 10 by the time it
        // reaches it, so the wall is 90 above the ray. Shadowed.
        expect(marchOccluded(h, 40, 0, fromRight, 100)).toBe(true);
        // The SAME point with the light on the other side sees nothing but flat ground.
        expect(marchOccluded(h, 40, 0, fromLeft, 100)).toBe(false);
        // Far away, still shadowed: at x = 0 the ray has climbed 50 by the wall, which is 100.
        expect(marchOccluded(h, 0, 0, fromRight, 100)).toBe(true);
        // ON TOP of the step there is nothing higher, so the march never starts.
        expect(marchOccluded(h, 60, 0, fromRight, 100)).toBe(false);
        // A steep enough light clears it — but "steep" has to be measured against the wall, not
        // guessed. The wall is 100 tall and 10 away, so the ray must gain more than 10 per unit of
        // run to get over it; at 80° it gains 5.8 and is still 42 short when it arrives, which is
        // shadowed. At this slope it is above everything before it ever gets there, and the march
        // stops at that altitude because nothing past it can occlude.
        expect(marchOccluded(h, 40, 0, { x: 0.17, y: 0, z: 0.985 }, 100)).toBe(true);
        expect(marchOccluded(h, 40, 0, { x: 0.05, y: 0, z: 0.99875 }, 100)).toBe(false);
    });

    test("a FLAT surface never shadows itself, whatever the light does", () => {
        // The property that lets the march run unconditionally. Every fragment of every unmeshed
        // shape takes this path, and a flat shape that came out uniformly dark would be the most
        // visible bug lighting could have.
        const flat = () => 0;
        const s = Math.SQRT1_2;
        for (const dir of [{ x: s, y: 0, z: s }, { x: 0, y: s, z: s }, { x: 0, y: 0, z: 1 }, { x: -0.6, y: -0.6, z: 0.53 }]) {
            expect(marchOccluded(flat, 10, 10, dir, 0)).toBe(false);
            // …and still not, when something ELSEWHERE is tall so the march genuinely runs. This
            // is the "strictly above" comparison doing the work: a surface exactly level with the
            // ray is the ray grazing it, not an occlusion.
            expect(marchOccluded(flat, 10, 10, dir, 100)).toBe(false);
        }
    });

    test("a light at or below the HORIZON is refused rather than marched", () => {
        // A ray that does not climb never leaves the surface, so the march would either run along
        // it forever or call everything shadowed. `lambert` has already taken those faces to zero,
        // which is both the right answer and a cheaper one.
        const step = (x: number, _y: number) => (x < 50 ? 0 : 100);
        expect(marchOccluded(step, 40, 0, { x: 1, y: 0, z: 0 }, 100)).toBe(false);
        // Pointed AT the wall as well as downward — the direction that catches a missing guard.
        // Without it the march runs backwards along a negative distance, walks into the wall from
        // the far side and reports the ground shadowed by a light that is underneath it.
        expect(marchOccluded(step, 40, 0, { x: -0.7, y: 0, z: -0.7 }, 100)).toBe(false);
        expect(marchOccluded(step, 40, 0, { x: 0.7, y: 0, z: -0.7 }, 100)).toBe(false);
    });

    test("the ray CLIMBS, so a steep light clears a low obstacle", () => {
        // The difference between a ray and a nearest-neighbour test. A bump 20 tall between the
        // point and the light blocks nothing if the ray is 60 up by the time it gets there — and
        // a march that compared heights against the STARTING height instead of the ray's would
        // call it shadowed, which is a shape permanently dark under a light directly above it.
        const bump = (x: number, _y: number) => (x > 50 && x < 60 ? 20 : 0);
        expect(marchOccluded(bump, 40, 0, { x: 0.3, y: 0, z: 0.954 }, 100)).toBe(false);
        // Lower the light and the same bump does block it.
        expect(marchOccluded(bump, 40, 0, { x: 0.95, y: 0, z: 0.312 }, 100)).toBe(true);
    });

    test("a surface lit exactly along its OWN SLOPE is grazed, not shadowed", () => {
        // The measure-zero case that is not measure-zero in a design tool: a bevel lit exactly
        // down its own face. Every sample along the ray sits precisely ON it, so a comparison
        // written `>=` rather than `>` would take the whole face to black — and the flat-surface
        // test cannot catch that, because the short-circuit above returns before the loop runs.
        const ramp = (x: number, _y: number) => x;                 // a 45° slope
        const s = Math.SQRT1_2;
        expect(marchOccluded(ramp, 0, 0, { x: s, y: 0, z: s }, 100)).toBe(false);
        // A shade steeper than the slope and it is clear of the surface; a shade shallower and the
        // surface genuinely is above the ray.
        expect(marchOccluded(ramp, 0, 0, { x: 0.6, y: 0, z: 0.8 }, 100)).toBe(false);
        expect(marchOccluded(ramp, 0, 0, { x: 0.8, y: 0, z: 0.6 }, 100)).toBe(true);
    });

    test("the march is SAMPLED, and a spike thinner than its step spacing is missed", () => {
        // Stated rather than discovered. Sixteen samples over the ray resolve relief at about the
        // scale a mesh cell holds; a feature finer than that is below what the surface can carry
        // in the first place. This pins the limit so nobody later reads the module note as
        // pessimism and quietly halves the step count.
        // Placed BETWEEN samples on purpose. The ray's samples land at exactly x = 6.25i here
        // (the march length is maxHeight/z and the step is that over 16, so the horizontal
        // spacing is maxHeight/16 whatever the angle) — a spike at 50 would sit on one and be
        // found by luck, which would test nothing.
        const spike = (x: number, _y: number) => (x > 52.95 && x < 53.05 ? 100 : 0);
        const s = Math.SQRT1_2;
        expect(marchOccluded(spike, 0, 0, { x: s, y: 0, z: s }, 100)).toBe(false);
        // Enough samples and it IS found — so the miss is the sampling rate, not the algorithm.
        expect(marchOccluded(spike, 0, 0, { x: s, y: 0, z: s }, 100, 20000)).toBe(true);
        expect(RAY_STEPS).toBe(16);
    });

    test("a shape's shadow LANDS ON another shape, and only where it overlaps", () => {
        // The gap the lighting notes have named since lighting existed. A shadow map was the wrong
        // technique for it: every occluder here is a flat shape at a known height under a
        // directional light, so its shadow IS its own outline translated — a boolean, not a pass.
        const sq = (x: number, y: number): Ring => [
            { x, y }, { x: x + 100, y }, { x: x + 100, y: y + 100 }, { x, y: y + 100 }];
        const patch = shadowPatch([sq(0, 0)], [sq(50, 0)], { x: 40, y: 0 });
        expect(patch.length).toBe(1);
        // The caster spans x 40..140 after the throw; the receiver spans 50..150. The overlap is
        // 50..140 — 90 wide, full height. Area is the check that survives any winding order.
        expect(Math.abs(signedArea2(patch[0])) / 2).toBeCloseTo(90 * 100, 6);
        // MISSES entirely once the throw carries it past the receiver — an empty result rather
        // than a zero-area ring, so nothing downstream has to filter degenerate shapes.
        expect(shadowPatch([sq(0, 0)], [sq(50, 0)], { x: 200, y: 0 })).toEqual([]);
        // A zero offset is a shape ON the page: its shadow sits exactly under itself, where the
        // shape hides it, so it is refused rather than computed once per pair per frame.
        expect(shadowPatch([sq(0, 0)], [sq(50, 0)], { x: 0, y: 0 })).toEqual([]);
    });

    test("BOOLEANS survive shapes that share an edge — the case that returned nothing", () => {
        // Found by the cast shadows: the first patch computed came back empty for two rectangles
        // at the same y, which is the arrangement a design tool is made of. The old boolean
        // classified each edge piece by whether its MIDPOINT was inside the other shape, and a
        // midpoint lying exactly ON the other's boundary has no answer — a ray cast from a
        // boundary point lands on the parity of its own rounding.
        const sq = (x: number, y: number, w = 100, h = 100): Ring =>
            [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
        const area = (rs: Ring[]) => rs.reduce((s, r) => s + Math.abs(signedArea2(r)) / 2, 0);

        // ALIGNED, overlapping. Union spans x 40..150, intersection 50..140, both full height.
        expect(area(resolveBoolean([sq(40, 0)], [sq(50, 0)], "union"))).toBeCloseTo(110 * 100, 6);
        expect(area(resolveBoolean([sq(40, 0)], [sq(50, 0)], "intersect"))).toBeCloseTo(90 * 100, 6);
        // TOUCHING edge-to-edge: all four operations returned nothing before, including the union
        // of two rectangles laid side by side, which is how anybody builds a bar out of blocks.
        expect(area(resolveBoolean([sq(0, 0)], [sq(100, 0)], "union"))).toBeCloseTo(20000, 6);
        expect(area(resolveBoolean([sq(0, 0)], [sq(100, 0)], "subtract"))).toBeCloseTo(10000, 6);
        expect(resolveBoolean([sq(0, 0)], [sq(100, 0)], "intersect")).toEqual([]);   // they only touch
        // IDENTICAL shapes: a shape unioned with itself is itself, and subtracted from itself is
        // nothing. Every edge here is coincident, so this is the degenerate case at its purest.
        expect(area(resolveBoolean([sq(0, 0)], [sq(0, 0)], "union"))).toBeCloseTo(10000, 6);
        expect(area(resolveBoolean([sq(0, 0)], [sq(0, 0)], "intersect"))).toBeCloseTo(10000, 6);
        expect(resolveBoolean([sq(0, 0)], [sq(0, 0)], "subtract")).toEqual([]);
        expect(resolveBoolean([sq(0, 0)], [sq(0, 0)], "exclude")).toEqual([]);
        // NOT a regression: the general, non-degenerate case is unchanged to the digit, which is
        // what says this replaced a broken classifier rather than a working one.
        for (const op of ["union", "intersect", "subtract", "exclude"] as const) {
            expect(area(resolveBoolean([sq(40, 20)], [sq(50, 55)], op)))
                .toBeCloseTo(area(booleanRings([sq(40, 20)], [sq(50, 55)], op)), 6);
        }
        // DISJOINT shapes never touched the degeneracy and still do not.
        expect(area(resolveBoolean([sq(0, 0)], [sq(500, 0)], "union"))).toBeCloseTo(20000, 6);
        expect(resolveBoolean([sq(0, 0)], [sq(500, 0)], "intersect")).toEqual([]);
    });

    test("only a NEARER shape casts onto a further one, and never onto its own plane", () => {
        const sq = (x: number): Ring => [{ x, y: 0 }, { x: x + 100, y: 0 }, { x: x + 100, y: 100 }, { x, y: 100 }];
        const at = (id: string, x: number, depth: number): ShadowShape => ({ id, rings: [sq(x)], depth });
        const throwBy = (d: number) => ({ x: d < 0 ? -d : 0, y: 0 });
        // "A" floats above the page (negative depth); "B" lies on it. The shadow goes one way.
        const one = castShadows([at("A", 0, -40), at("B", 50, 0)], throwBy);
        expect(one.length).toBe(1);
        expect(one[0]).toMatchObject({ casterId: "A", receiverId: "B" });
        // SAME plane: neither is above the other, so neither shadows the other. A `<=` here would
        // have every raised shape in a stack darken every sibling it overlaps.
        expect(castShadows([at("A", 0, -40), at("B", 50, -40)], throwBy)).toEqual([]);
        // And the FURTHER shape never casts forward onto the nearer one.
        const rev = castShadows([at("A", 0, 0), at("B", 50, -40)], throwBy);
        expect(rev.map(p => p.casterId)).toEqual(["B"]);
        // A scene with nothing raised does no work at all — the common case, run every frame.
        expect(castShadows([at("A", 0, 0), at("B", 50, 0)], throwBy)).toEqual([]);
        // BOUNDED, and it stops rather than truncating a shape's shadow halfway.
        const many = [at("A", 0, -40), at("B", 10, -40), ...Array.from({ length: 6 }, (_, i) => at("r" + i, 20, 0))];
        expect(castShadows(many, throwBy, 3).length).toBeLessThanOrEqual(3);
        expect(castShadows(many, throwBy).length).toBe(12);
    });

    test("one caster throws a SHORTER shadow on a raised receiver than on the page", () => {
        // The defect the suite could not see, because every test had exactly one raised shape.
        // Two cards under one card: the shadow on the lower card is longer than the shadow on the
        // higher one, and getting this wrong makes a whole stack read as one flat layer.
        const sq = (x: number): Ring => [{ x, y: 0 }, { x: x + 100, y: 0 }, { x: x + 100, y: 100 }, { x, y: 100 }];
        const key = light(1, 0, 0);
        const at = (id: string, depth: number): ShadowShape => ({ id, rings: [sq(0)], depth });
        const patches = castShadows(
            [at("high", -40), at("mid", -20), at("page", 0)],
            (c, r) => shadowOffset(key, c, r));
        const area = (rs: Ring[]) => rs.reduce((n, ring) => n + Math.abs(signedArea2(ring)) / 2, 0);
        const of = (receiver: string) => area(patches.find(p => p.casterId === "high" && p.receiverId === receiver)!.rings);
        // Onto the page: thrown 40, so 60 of the 100-wide receiver is covered.
        expect(of("page")).toBeCloseTo(60 * 100, 6);
        // Onto the card at 20: only 20 of air between them, so 80 is covered — MORE, not the same.
        expect(of("mid")).toBeCloseTo(80 * 100, 6);
        // …and the middle card throws its own, shorter still, onto the page only.
        expect(patches.filter(p => p.casterId === "mid").map(p => p.receiverId)).toEqual(["page"]);
        expect(area(patches.find(p => p.casterId === "mid")!.rings)).toBeCloseTo(80 * 100, 6);
    });

    test("the cast shadow reaches the display list, ABOVE its receiver and below its caster", () => {
        // Paint order is the whole of it: before the receiver, the receiver paints over its own
        // shadow; after the caster, the shadow darkens the shape that threw it.
        const d = doc(
            { id: "under", type: "core.rectangle", parent: null, children: [],
              geometry: { x: 50, y: 0, width: 100, height: 100 },
              style: { fill: "#ffffff", opacity: 1 }, layout: {} } as Node,
            { id: "over", type: "core.rectangle", parent: null, children: [],
              geometry: { x: 0, y: 0, width: 100, height: 100 },
              style: { fill: "#808080", opacity: 1 }, layout: {}, depth: -40 } as Node);
        d.lights = [{ x: 1, y: 0, z: -1, color: "#ffffff", intensity: 1 }];
        const model = buildRenderModel({ width: 800, height: 600 }, d,
            { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(d), viewport: { x: 0, y: 0, zoom: 1 } });
        const roles = model.content.map(i => `${i.role}:${i.nodeId ?? "-"}`);
        expect(roles).toEqual(["content:under", "shadow:-", "content:over"]);
        const patch = model.content[1];
        // UNPICKABLE and idless. A shadow is not a thing you can select; a click has to fall
        // through to the receiver underneath it.
        expect(patch.nodeId).toBeNull();
        expect(patch.paint.pointerEvents).toBe(false);
        // WORLD-space with no transform: the patch is the intersection of two shapes from
        // different local spaces, so there is no local space left for it to be in.
        expect(patch.world).toBeNull();
        expect(patch.shape.kind).toBe("path");
        expect(patch.paint.fill).toBe(SHADOW_ALPHA);
        // An UNLIT document casts nothing, even with a shape RAISED right over another. A shadow
        // needs a light to be cast BY, and the scene has to be asked before any of the quadratic
        // work is done — this runs on every frame.
        const unlit = doc(
            { id: "under", type: "core.rectangle", parent: null, children: [],
              geometry: { x: 50, y: 0, width: 100, height: 100 },
              style: { fill: "#ffffff", opacity: 1 }, layout: {} } as Node,
            { id: "over", type: "core.rectangle", parent: null, children: [],
              geometry: { x: 0, y: 0, width: 100, height: 100 },
              style: { fill: "#808080", opacity: 1 }, layout: {}, depth: -40 } as Node);
        expect(buildRenderModel({ width: 800, height: 600 }, unlit,
            { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(unlit), viewport: { x: 0, y: 0, zoom: 1 } })
            .content.every(i => i.role === "content")).toBe(true);
    });

    test("an EXPLICIT shadow still wins over the scene's light", () => {
        // Somebody who set a shadow meant it. A scene light silently overruling a per-shape
        // decision would be the tool arguing with its user.
        const d = doc({ id: "A", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 100, height: 100 }, depth: 30,
            style: { fill: "#808080", opacity: 1, shadow: { dx: 3, dy: 4, blur: 5, color: "#ff0000" } },
            layout: {} } as Node);
        d.lights = [{ x: 1, y: 0, z: -1, color: "#ffffff", intensity: 1 }];
        const shadow = buildRenderModel({ width: 800, height: 600 }, d,
            { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(d), viewport: { x: 0, y: 0, zoom: 1 } })
            .content[0].paint.shadow!;
        expect(shadow).toEqual({ dx: 3, dy: 4, blur: 5, color: "#ff0000" });
    });

    test("the scene's lights reach the display list, and an unlit document carries none", () => {
        const d = doc(node("A"));
        d.lights = [light(1, 0, -1)];
        d.ambient = 0.2;
        const model = buildRenderModel({ width: 800, height: 600 }, d,
            { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(d), viewport: { x: 0, y: 0, zoom: 1 } });
        expect(model.lights).toEqual([light(1, 0, -1)]);
        expect(model.ambient).toBe(0.2);
        const plain = doc(node("B"));
        const unlit = buildRenderModel({ width: 800, height: 600 }, plain,
            { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(plain), viewport: { x: 0, y: 0, zoom: 1 } });
        expect(unlit.lights).toBeUndefined();
        expect(unlit.ambient).toBeUndefined();
    });

    test("lights and ambient are validated on BOTH paths", () => {
        expect(lightsError(undefined)).toBeNull();
        expect(lightsError([light(1, 0, -1)])).toBeNull();
        expect(lightsError("bright")).toMatch("array");
        expect(lightsError(new Array(LIGHTS_MAX + 1).fill(light(1, 0, 0)))).toMatch("at most");
        // A ZERO direction is a light nobody has aimed yet — refused rather than given an axis.
        expect(lightsError([light(0, 0, 0)])).toMatch("must not be zero");
        expect(lightsError([{ ...light(1, 0, 0), intensity: -1 }])).toMatch("intensity");
        expect(lightsError([{ ...light(1, 0, 0), color: 5 as never }])).toMatch("color");
        expect(ambientError(undefined)).toBeNull();
        expect(ambientError(0.5)).toBeNull();
        expect(ambientError(1.5)).toMatch("ambient");
        expect(ambientError(-0.1)).toMatch("ambient");

        const d = doc(node("A"));
        d.lights = [light(1, 0, -1)];
        d.ambient = 0.3;
        const back = deserializeDocument(serializeDocument(d));
        expect(back.lights).toEqual(d.lights);
        expect(back.ambient).toBe(0.3);
        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: [], variables: {}, nodes: {}, ambient: 4 } });
        expect(() => deserializeDocument(bad)).toThrow("ambient");
    });

    test("a mesh point's HEIGHT survives a round trip, and a schema-41 file has none", () => {
        const d = doc(node("A", raised(25)));
        expect(deserializeDocument(serializeDocument(d)).nodes.get("A")!.mesh!.points[3].z).toBe(25);
        expect(meshError({ cols: 1, rows: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1, z: NaN }] })).toMatch("z must be finite");
        const v41 = { version: "41", document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} } } } };
        const loaded = deserializeDocument(JSON.stringify(v41));
        expect(loaded.lights).toBeUndefined();
        expect(JSON.parse(serializeDocument(loaded)).version).toBe(SCHEMA_VERSION);
    });
});

describe("Mesh — bending a shape (schema 41)", () => {
    const box = { width: 100, height: 100 };
    const doc = (...nodes: Node[]): ProjectDocument => {
        const d = createEmptyDocument();
        for (const n of nodes) d.nodes.set(n.id, n);
        d.rootNodeUuids = nodes.map(n => n.id);
        return d;
    };
    const node = (id: string, mesh?: Mesh): Node =>
        ({ id, type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 100, height: 100 },
           style: { fill: "#000", opacity: 1 }, layout: {}, ...(mesh ? { mesh } : {}) } as Node);
    /** A rest mesh with one corner dragged, which is the smallest real warp. */
    const pulled = (dx: number, dy: number): Mesh => {
        const m = restMesh(1, 1, box);
        m.points[3] = { x: m.points[3].x + dx, y: m.points[3].y + dy };   // bottom-right
        return m;
    };

    test("a point lands EXACTLY on the control point it is dragged to", () => {
        // The property a person dragging a handle actually checks, and the reason bilinear is
        // enough: it is exact at the corners whatever it does in between.
        const m = pulled(40, 20);
        expect(warpPoint(m, box, 100, 100)).toEqual({ x: 140, y: 120 });
        expect(warpPoint(m, box, 0, 0)).toEqual({ x: 0, y: 0 });
        expect(warpPoint(m, box, 100, 0)).toEqual({ x: 100, y: 0 });
        expect(warpPoint(m, box, 0, 100)).toEqual({ x: 0, y: 100 });
    });

    test("between control points it blends, in both directions", () => {
        const m = pulled(40, 0);
        // The bottom edge now runs from (0,100) to (140,100), so its MIDPOINT sits at 70 — it
        // moved by half the pull, which is not the same as sitting half way along the pull.
        expect(warpPoint(m, box, 50, 100).x).toBeCloseTo(70, 9);
        // The right edge runs from (100,0) to (140,100): its midpoint is 120.
        expect(warpPoint(m, box, 100, 50).x).toBeCloseTo(120, 9);
        // The dead centre is the average of all four corners: (0 + 100 + 0 + 140) / 4.
        expect(warpPoint(m, box, 50, 50).x).toBeCloseTo(60, 9);
        // The far corner is untouched, so a warp is LOCAL rather than a whole-shape transform.
        expect(warpPoint(m, box, 0, 0)).toEqual({ x: 0, y: 0 });
    });

    test("a rest mesh is the IDENTITY and is skipped, not applied", () => {
        // An untouched mesh must cost nothing: a user who turns the tool on and drags nothing
        // should have the same document they started with.
        const m = restMesh(3, 2, box);
        expect(isIdentityMesh(m, box)).toBe(true);
        expect(warpPoint(m, box, 37, 61).x).toBeCloseTo(37, 9);
        expect(warpPoint(m, box, 37, 61).y).toBeCloseTo(61, 9);
        m.points[4] = { x: m.points[4].x + 1, y: m.points[4].y };
        expect(isIdentityMesh(m, box)).toBe(false);
    });

    test("points OUTSIDE the box are clamped, not extrapolated", () => {
        // A shape's ink is not obliged to fit its box, and a bilinear patch diverges fast beyond
        // its corners — an overhanging outline would be flung across the canvas rather than
        // following the edge it is near.
        const m = pulled(40, 0);
        const far = warpPoint(m, box, 1000, 1000);
        const corner = warpPoint(m, box, 100, 100);
        expect(far).toEqual(corner);
        expect(warpPoint(m, box, -50, -50)).toEqual({ x: 0, y: 0 });
    });

    test("a warped node resolves into an ordinary PATH, so everything downstream is unchanged", () => {
        // The whole reason a warp costs so little. Picking, marquee, snapping, tessellation, the
        // decomposition and all three backends see a path.
        const d = doc(node("A", pulled(60, 0)));
        const scene = resolveScene(d);
        const out = scene.nodes.get("A")!;
        expect(out.type).toBe("core.path");
        expect(out.path!.length).toBeGreaterThan(4);
        expect(pathError("core.path", out.path!)).toBeNull();
        // The bend is IN the commands now, and the mesh is gone from the derived node — leaving
        // it on would warp an already-warped outline the next time anything resolved, which is
        // the `activeState` trap in a new costume.
        expect(out.mesh).toBeUndefined();
        const twice = resolveScene(scene);
        expect(twice.nodes.get("A")!.path!.length).toBe(out.path!.length);
    });

    test("a warp is CLICKABLE where it is drawn", () => {
        // The cardinal rule. A deformation applied in a renderer could never satisfy it.
        // Pulled INWARD, so the test needs no opinion about ink that leaves the box: a point that
        // used to be well inside the rectangle is now outside the bent shape, and the click passes
        // through to whatever is behind it.
        const d = doc(node("A", pulled(-60, 0)));
        const computed = computeGeometry(d);
        expect(hitTest(computed, 80, 96)).toBeNull();
        const rigid = computeGeometry(doc(node("A")));
        expect(hitTest(rigid, 80, 96)).toBe("A");
        // …while a point still inside the bent shape keeps hitting it.
        expect(hitTest(computed, 20, 96)).toBe("A");
    });

    test("a STRAIGHT edge crossing a bend follows it rather than chording across", () => {
        // A warp bends the space BETWEEN two points, so a segment that kept only its ends would
        // cut the corner off every bend. Segments are subdivided at the grid's own resolution.
        const m = restMesh(2, 1, box);
        m.points[1] = { x: 50, y: -60 };                 // pull the TOP-MIDDLE control point up
        const d = doc(node("A", m));
        const out = resolveScene(d).nodes.get("A")!;
        const top = Math.min(...out.path!.filter(c => c.c !== "Z").map(c => (c as { y: number }).y));
        // The outline reaches up toward the dragged point; a chord between the two top corners
        // would have stayed at y = 0.
        expect(top).toBeLessThan(-30);
    });

    test("an unmeshed document is returned BY REFERENCE", () => {
        const flat = doc(node("A"), node("B"));
        expect(resolveMeshes(flat)).toBe(flat);
        // …and a mesh still at rest changes nothing either.
        const rested = doc(node("A", restMesh(2, 2, box)));
        expect(resolveMeshes(rested).nodes.get("A")!.type).toBe("core.rectangle");
    });

    test("mesh HANDLES name the control points, not the bent outline's vertices", () => {
        // The distinction the whole interaction turns on. A warped node resolves to a `core.path`,
        // so it also grows vertex handles for the RESULT — and dragging one of those would edit
        // the bend rather than the thing causing it. These come from the node's own mesh.
        const d = doc(node("A", pulled(40, 0)));
        const computed = computeGeometry(d);
        const handles = meshHandles(d, computed, ["A"]);
        expect(handles.length).toBe(4);                       // a 1x1 grid is four corners
        expect(handles.map(h => h.handle)).toEqual(["mesh:0", "mesh:1", "mesh:2", "mesh:3"]);
        // The dragged corner's handle sits where it was dragged TO.
        expect(handles[3].cx).toBeCloseTo(140, 6);
        // A node with no mesh grows none, so nothing appears on an ordinary shape.
        expect(meshHandles(doc(node("B")), computeGeometry(doc(node("B"))), ["B"]).length).toBe(0);
    });

    test("the picker reads the SAME producer the renderer draws from", () => {
        // The drift `pathVertexHandles` was written to avoid: handles that appear and do nothing
        // when pressed. Asserted by grabbing at a handle's own drawn position.
        const d = doc(node("A", pulled(40, 0)));
        const computed = computeGeometry(d);
        const drawn = meshHandles(d, computed, ["A"]);
        for (const h of drawn) {
            expect(meshHandleAtPoint(d, computed, ["A"], h.cx, h.cy, 1)?.handle).toBe(h.handle);
        }
        // …and a point well away from every one of them grabs nothing.
        expect(meshHandleAtPoint(d, computed, ["A"], 60, 60, 1)).toBeNull();
        expect(meshIndexOf("mesh:7")).toBe(7);
        expect(meshIndexOf("vertex:7")).toBeNull();
        expect(meshIndexOf("se")).toBeNull();
    });

    test("the controller checks MESH handles before vertex handles", () => {
        // A structural assertion, because the ORDER is the whole point and no unit test of the
        // pickers can see it: a warped node offers both kinds at once, and whichever is asked
        // first wins. The same technique the vertex handling is pinned with.
        const src = readFileSync(resolve(__dirname, "../../editor/tools/ToolController.ts"), "utf8");
        const press = src.indexOf("const hit = meshHandleAtPoint(");
        expect(press).toBeGreaterThan(-1);
        // The vertex picker is the FALLBACK of that same expression, not a separate earlier one.
        expect(src.slice(press, press + 400)).toContain("?? vertexHandleAtPoint(");
        expect(src).toContain("const mi = meshIndexOf(hit.handle);");
        // …and the mesh branch returns before the vertex branch is reached.
        expect(src.indexOf("const mi = meshIndexOf(")).toBeLessThan(src.indexOf("const vi = vertexIndexOf("));
    });

    test("a mesh is validated on BOTH paths, and its point count must match its grid", () => {
        expect(meshError(undefined)).toBeNull();
        expect(meshError(restMesh(2, 3, box))).toBeNull();
        expect(meshError({ cols: 0, rows: 1, points: [] })).toMatch("cols");
        expect(meshError({ cols: 1, rows: 1.5, points: [] })).toMatch("rows");
        expect(meshError({ cols: MESH_MAX_DIVISIONS + 1, rows: 1, points: [] })).toMatch("cols");
        // The count is DERIVED from the grid, so a mismatch is not a detail: every lookup indexes
        // by row and column, and a short array would read `undefined` as a coordinate.
        expect(meshError({ cols: 1, rows: 1, points: [{ x: 0, y: 0 }] })).toMatch("exactly 4");
        expect(meshError({ cols: 1, rows: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: NaN, y: 1 }] })).toMatch("finite");

        const d = doc(node("A", pulled(10, 10)));
        expect(deserializeDocument(serializeDocument(d)).nodes.get("A")!.mesh).toEqual(d.nodes.get("A")!.mesh);
        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, mesh: { cols: 1, rows: 1, points: [] } } } } });
        expect(() => deserializeDocument(bad)).toThrow("exactly 4");
    });

    test("a schema-40 document migrates to 41 and draws identically", () => {
        const v40 = { version: "40", document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} } } } };
        const loaded = deserializeDocument(JSON.stringify(v40));
        expect(loaded.nodes.get("n")!.mesh).toBeUndefined();
        expect(JSON.parse(serializeDocument(loaded)).version).toBe(SCHEMA_VERSION);
    });
});

describe("Depth — order, the z-buffer and parallax from one number (schema 40)", () => {
    const doc = (...nodes: Node[]): ProjectDocument => {
        const d = createEmptyDocument();
        for (const n of nodes) d.nodes.set(n.id, n);
        d.rootNodeUuids = nodes.map(n => n.id);
        return d;
    };
    const node = (id: string, depth?: number): Node =>
        ({ id, type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 },
           style: { fill: "#000", opacity: 1 }, layout: {}, ...(depth !== undefined ? { depth } : {}) } as Node);

    test("FAR draws first, and the tree's own order breaks ties", () => {
        // A layer panel says which sibling is on top of which; depth says which is nearer the
        // viewer. Two different questions, and depth is asked first.
        const d = doc(node("near", 0), node("far", 5), node("mid", 1));
        const order = buildRenderModel({ width: 800, height: 600 },
            d, { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(d), viewport: { x: 0, y: 0, zoom: 1 } })
            .content.map(i => i.nodeId);
        expect(order).toEqual(["far", "mid", "near"]);
    });

    test("a document that never mentions depth draws in exactly the order it always did", () => {
        // The property that lets the sort run unconditionally. Equal depths compare zero, and a
        // stable sort then leaves the tree alone.
        const d = doc(node("a"), node("b"), node("c"));
        const order = buildRenderModel({ width: 800, height: 600 },
            d, { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(d), viewport: { x: 0, y: 0, zoom: 1 } })
            .content.map(i => i.nodeId);
        expect(order).toEqual(["a", "b", "c"]);
        // …and carries no depth at all, so nothing downstream can mistake 0 for "layered".
        expect(buildRenderModel({ width: 800, height: 600 },
            d, { selectedNodeIds: [], hoveredNodeId: null, computed: computeGeometry(d), viewport: { x: 0, y: 0, zoom: 1 } })
            .content.every(i => i.depth === undefined)).toBe(true);
    });

    test("the Z a vertex carries DECREASES with depth, and is clamped inside the clip volume", () => {
        // A depth buffer keeps the smallest z, so "nearer wins" only holds if the mapping falls.
        expect(depthToClipZ(-5)).toBeLessThan(depthToClipZ(0));
        expect(depthToClipZ(0)).toBeLessThan(depthToClipZ(5));
        // Clamped rather than wrapped: a z outside [-1, 1] is CULLED, and a node that vanished
        // because somebody typed a big number would look like a bug in everything except the
        // number.
        expect(depthToClipZ(1e9)).toBeLessThanOrEqual(0.999);
        expect(depthToClipZ(-1e9)).toBeGreaterThanOrEqual(-0.999);
        expect(Math.abs(depthToClipZ(DEPTH_MAX))).toBeLessThan(1);
        expect(Math.abs(depthToClipZ(DEPTH_MIN))).toBeLessThan(1);
    });

    test("PARALLAX: a distant layer lags the pan, a near one outruns it, the page does neither", () => {
        const vp = { x: 200, y: 100, zoom: 1 };
        // Depth 0 is the page: it tracks the canvas exactly, so the offset is EXACTLY zero — not
        // nearly zero, because a document with no depth must be untouched.
        expect(parallaxOffset(0, vp)).toEqual({ x: 0, y: 0 });
        // EXACTLY positive zero, from a short-circuit rather than from the arithmetic. Multiplying
        // a NEGATIVE pan by a zero lag gives -0, which is a different value to every strict
        // comparison and to `Object.is` — and `applyParallax` uses exactly such a comparison to
        // decide a node needs no new object at all. A -0 there would rebuild every node on every
        // pan of a canvas scrolled up or left, silently.
        const negative = parallaxOffset(0, { x: -200, y: -100, zoom: 1 });
        expect(Object.is(negative.x, 0)).toBe(true);
        expect(Object.is(negative.y, 0)).toBe(true);
        // Depth 1 follows half the pan, so it lags by half of it.
        expect(parallaxRate(1)).toBeCloseTo(0.5, 12);
        expect(parallaxOffset(1, vp)).toEqual({ x: 100, y: 50 });
        // Further back lags more, and approaches the full pan without ever reaching it — an
        // asymptote, so no depth is the one where a layer suddenly pins.
        expect(parallaxOffset(9, vp).x).toBeCloseTo(180, 9);
        expect(parallaxOffset(1e6, vp).x).toBeLessThan(200);
        // NEGATIVE depth is the foreground: it outruns the canvas, so the offset goes the other way.
        expect(parallaxRate(-1)).toBe(2);
        expect(parallaxOffset(-1, vp)).toEqual({ x: -200, y: -100 });
    });

    test("parallax is measured in WORLD units, so zoom does not change the layering", () => {
        // The offset is added to a node's own position, which is in world units — so it has to be
        // divided by the zoom. Getting this wrong would make layers drift apart as you zoomed,
        // which reads as the drawing coming unstuck rather than as depth.
        const a = parallaxOffset(1, { x: 200, y: 0, zoom: 1 });
        const b = parallaxOffset(1, { x: 200, y: 0, zoom: 4 });
        expect(a.x).toBe(100);
        expect(b.x).toBe(25);
        expect(parallaxOffset(1, { x: 200, y: 0, zoom: 0 })).toEqual({ x: 0, y: 0 });   // no divide by zero
    });

    test("parallax moves the node BEFORE geometry, so it can be clicked where it is drawn", () => {
        // The rule this codebase has already had to learn twice. A shape shifted in the renderer
        // alone would draw in one place and pick in another.
        const d = doc(node("bg", 1));
        const shifted = applyParallax(d, { x: 200, y: 100, zoom: 1 });
        expect(shifted.nodes.get("bg")!.geometry.x).toBe(100);
        const computed = computeGeometry(shifted as ProjectDocument);
        // …and the hit test agrees, because it reads that same geometry.
        expect(hitTest(computed, 120, 60)).toBe("bg");
        expect(hitTest(computed, 20, 10)).toBeNull();     // where it would have been unlayered
    });

    test("an unlayered document is returned BY REFERENCE — a pan must cost nothing", () => {
        // This runs on every pan, which is the most frequent thing anybody does to a canvas.
        const flat = doc(node("a"), node("b"));
        expect(applyParallax(flat, { x: 500, y: 500, zoom: 2 })).toBe(flat);
        // And a node at depth 0 inside a layered document is passed through untouched.
        const mixed = doc(node("a"), node("bg", 2));
        const out = applyParallax(mixed, { x: 200, y: 0, zoom: 1 });
        expect(out.nodes.get("a")).toBe(mixed.nodes.get("a"));
        expect(out.nodes.get("bg")).not.toBe(mixed.nodes.get("bg"));
    });

    test("parallax moves a layer WITHOUT resizing it", () => {
        // A layer that shrank with distance would read as the shape resizing itself, and a
        // designer who set a width would find the document disagreeing with them.
        const d = doc(node("bg", 3));
        const out = applyParallax(d, { x: 400, y: 400, zoom: 1 });
        expect(out.nodes.get("bg")!.geometry.width).toBe(50);
        expect(out.nodes.get("bg")!.geometry.height).toBe(50);
    });

    test("depth is validated on BOTH paths, and bounded", () => {
        expect(depthError(undefined)).toBeNull();
        expect(depthError(0)).toBeNull();
        expect(depthError(-3.5)).toBeNull();
        expect(depthError("far")).toMatch("depth");
        expect(depthError(NaN)).toMatch("depth");
        expect(depthError(Infinity)).toMatch("depth");
        // Bounded because it scales a divisor and reaches a clip coordinate.
        expect(depthError(DEPTH_MAX + 1)).toMatch("depth");
        expect(depthError(DEPTH_MIN - 1)).toMatch("depth");

        const d = doc(node("A", 2));
        expect(deserializeDocument(serializeDocument(d)).nodes.get("A")!.depth).toBe(2);
        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, depth: "far" } } } });
        expect(() => deserializeDocument(bad)).toThrow("depth");
    });

    test("a schema-39 document migrates to 40 and draws identically", () => {
        const v39 = { version: "39", document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {} } } } };
        const loaded = deserializeDocument(JSON.stringify(v39));
        expect(loaded.nodes.get("n")!.depth).toBeUndefined();
        expect(depthOf(loaded.nodes.get("n")!)).toBe(0);
        expect(JSON.parse(serializeDocument(loaded)).version).toBe(SCHEMA_VERSION);
    });
});

describe("Timeline — cutout, frame-by-frame, tweening, onion skinning (schema 39)", () => {
    const doc = (...nodes: Node[]): ProjectDocument => {
        const d = createEmptyDocument();
        for (const n of nodes) d.nodes.set(n.id, n);
        d.rootNodeUuids = nodes.filter(n => !n.parent).map(n => n.id);
        return d;
    };
    const node = (id: string, x: number, extra: Partial<Node> = {}): Node =>
        ({ id, type: "core.rectangle", parent: null, children: [], geometry: { x, y: 0, width: 50, height: 50 },
           style: { fill: "#000", opacity: 1 }, layout: {}, ...extra } as Node);
    const at = (d: ProjectDocument, frame: number): ReadonlyDocument => { d.frame = frame; return resolveScene(d); };
    const xOf = (d: ReadonlyDocument, id: string): number => d.nodes.get(id)!.geometry.x;

    test("TWEENING: between two keyframes a node is interpolated", () => {
        // The arithmetic is `blendNode`, written for state transitions and reused verbatim. Two
        // copies of it would drift the first time a field learned to interpolate.
        const d = doc(node("A", 0, { track: [
            { frame: 0, values: { geometry: { x: 0 } } },
            { frame: 10, values: { geometry: { x: 100 } } }
        ] }));
        expect(xOf(at(d, 0), "A")).toBeCloseTo(0, 9);
        expect(xOf(at(d, 5), "A")).toBeCloseTo(50, 9);
        expect(xOf(at(d, 10), "A")).toBeCloseTo(100, 9);
    });

    test("FRAME BY FRAME: a held keyframe stays put until the next replaces it", () => {
        // Not a different animation model — a flag. A held keyframe is a drawing that stays on
        // screen until the next drawing appears, which is what a sequence of cels is.
        const d = doc(node("A", 0, { track: [
            { frame: 0, hold: true, values: { geometry: { x: 0 } } },
            { frame: 10, hold: true, values: { geometry: { x: 100 } } }
        ] }));
        expect(xOf(at(d, 0), "A")).toBe(0);
        expect(xOf(at(d, 9), "A")).toBe(0);      // no drift whatsoever between the two
        expect(xOf(at(d, 10), "A")).toBe(100);   // and then it snaps
    });

    test("EASING shapes the tween, and only when it is not held", () => {
        const eased = doc(node("A", 0, { track: [
            { frame: 0, easing: "ease-in", values: { geometry: { x: 0 } } },
            { frame: 10, values: { geometry: { x: 100 } } }
        ] }));
        const linear = doc(node("A", 0, { track: [
            { frame: 0, values: { geometry: { x: 0 } } },
            { frame: 10, values: { geometry: { x: 100 } } }
        ] }));
        expect(xOf(at(eased, 3), "A")).toBeLessThan(xOf(at(linear, 3), "A"));   // slow to start
        expect(xOf(at(eased, 0), "A")).toBeCloseTo(0, 9);
        expect(xOf(at(eased, 10), "A")).toBeCloseTo(100, 9);
    });

    test("CUTOUT: animating a parent carries its children, with no rig code anywhere", () => {
        // The scene graph already composes a parent's matrix into its children, so a keyframe on
        // an upper arm moves the forearm and the hand. This module knows nothing about limbs, and
        // that is the point of applying time at the display seam.
        const upper = node("UPPER", 0, { children: ["FORE"], track: [
            { frame: 0, values: { transform: { rotation: 0 } } },
            { frame: 10, values: { transform: { rotation: 90 } } }
        ] });
        const fore = node("FORE", 60, { parent: "UPPER" });
        const d = doc(upper, fore);
        const world = (frame: number) => {
            d.frame = frame;
            return computeGeometry(d).nodes.get("FORE")!.world;
        };
        const a = world(0), b = world(10);
        // The child never received a keyframe, and yet it has moved — through its parent.
        expect(Math.abs(a.e - b.e) + Math.abs(a.f - b.f)).toBeGreaterThan(1);
        expect(d.nodes.get("FORE")!.track).toBeUndefined();
    });

    test("outside the track's range the nearest keyframe is HELD, not extrapolated", () => {
        // Extrapolating would send a shape flying off in both directions from a two-keyframe
        // track. Before the first keyframe the animation has not started; after the last it has
        // finished.
        const d = doc(node("A", 0, { track: [
            { frame: 5, values: { geometry: { x: 20 } } },
            { frame: 10, values: { geometry: { x: 40 } } }
        ] }));
        expect(xOf(at(d, 0), "A")).toBe(20);
        expect(xOf(at(d, 4), "A")).toBe(20);
        expect(xOf(at(d, 99), "A")).toBe(40);
    });

    test("a document nobody animated is returned BY REFERENCE", () => {
        // `resolveScene` runs on every derivation, so a document with no track must cost exactly
        // what it did before the timeline existed — not a rebuilt node map every frame.
        const plain = doc(node("A", 0));
        expect(applyFrame(plain, 7)).toBe(plain);
        expect(applyFrame(plain, undefined)).toBe(plain);
        // And a frame that is not a number changes nothing rather than throwing.
        expect(applyFrame(plain, NaN as number)).toBe(plain);
    });

    test("the derived document does NOT name the frame it was derived at", () => {
        // `resolveScene` applies the track to whatever it is given. A derived document that still
        // named its frame would be re-animated on the next pass — the exact trap `blendStates`
        // fell into with `activeState`, where a two-second transition landed in one frame.
        const d = doc(node("A", 0, { track: [
            { frame: 0, values: { geometry: { x: 0 } } },
            { frame: 10, values: { geometry: { x: 100 } } }
        ] }));
        d.frame = 5;
        const once = applyFrame(d, 5);
        expect(once.frame).toBeUndefined();
        expect(xOf(applyFrame(once, 5) as ReadonlyDocument, "A")).toBeCloseTo(50, 9);
    });

    test("a track is validated by the SAME rules on both paths", () => {
        const values = (v: unknown) => overrideValueError("keyframe", v);
        expect(trackError([{ frame: 0, values: {} }], values)).toBeNull();
        expect(trackError(undefined, values)).toBeNull();
        // TIMING is what this rule adds; the values are `overrideValueError`'s business.
        expect(trackError([{ frame: 1.5, values: {} }], values)).toMatch("whole number");
        expect(trackError([{ frame: -1, values: {} }], values)).toMatch("whole number");
        expect(trackError([{ frame: 5, values: {} }, { frame: 2, values: {} }], values)).toMatch("ascending");
        expect(trackError([{ frame: 5, values: {} }, { frame: 5, values: {} }], values)).toMatch("ascending");
        expect(trackError([{ frame: 0, easing: "boing", values: {} }], values)).toMatch("easing");
        expect(trackError([{ frame: 0, hold: "yes", values: {} }], values)).toMatch("hold");
        expect(trackError("nope", values)).toMatch("array");
        // A bad VALUE is refused by the shared rule, not by a second copy of it here.
        expect(trackError([{ frame: 0, values: { style: { opacity: 5 } } }], values)).toMatch("opacity");

        // EDIT path: the dispatcher refuses exactly what the loader would.
        const d = doc(node("A", 0));
        const dispatcher = new ActionDispatcher(d);
        expect(dispatcher.dispatchAction(new SetTrackAction(dispatcher.getDocument(), "A",
            [{ frame: 0, values: { geometry: { x: 5 } } }])).success).toBe(true);
        expect(dispatcher.dispatchAction(new SetTrackAction(dispatcher.getDocument(), "A",
            [{ frame: 2, values: {} }, { frame: 1, values: {} }] as never)).success).toBe(false);
        // LOAD path: a hand-edited file cannot say what the editor could not.
        const bad = JSON.stringify({ version: SCHEMA_VERSION, document: { metadata: {}, rootNodeUuids: ["n"], variables: {}, nodes: { n: { id: "n", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {}, track: [{ frame: 2, values: {} }, { frame: 1, values: {} }] } } } });
        expect(() => deserializeDocument(bad)).toThrow("ascending");
    });

    test("an EMPTY track removes the field rather than storing nothing twice", () => {
        // A node whose animation was deleted must serialise exactly like one that was never
        // animated — the discipline `SetInteractionsAction` and Outline Stroke both follow.
        const d = doc(node("A", 0, { track: [{ frame: 0, values: { geometry: { x: 5 } } }] }));
        const dispatcher = new ActionDispatcher(d);
        dispatcher.dispatchAction(new SetTrackAction(dispatcher.getDocument(), "A", []));
        expect(dispatcher.getDocument().nodes.get("A")!.track).toBeUndefined();
        expect(JSON.parse(JSON.stringify(dispatcher.getDocument().nodes.get("A")))).not.toHaveProperty("track");
    });

    test("the CLOCK is validated, and a playhead past the end is not an error", () => {
        expect(timelineError(undefined)).toBeNull();
        expect(timelineError({ frames: 24, fps: 12 })).toBeNull();
        expect(timelineError({ frames: 0, fps: 12 })).toMatch("frames");
        expect(timelineError({ frames: 1.5, fps: 12 })).toMatch("frames");
        expect(timelineError({ frames: TIMELINE_MAX_FRAMES + 1, fps: 12 })).toMatch("frames");
        expect(timelineError({ frames: 10, fps: 0 })).toMatch("fps");
        expect(timelineError({ frames: 10, fps: FPS_MAX + 1 })).toMatch("fps");
        // A frame beyond the end holds the last keyframe, so refusing to OPEN such a file would
        // be a cure worse than the disease.
        const d = doc(node("A", 0, { track: [{ frame: 0, values: { geometry: { x: 7 } } }] }));
        d.timeline = { frames: 5, fps: 12 };
        d.frame = 900;
        expect(xOf(resolveScene(d), "A")).toBe(7);
        expect(deserializeDocument(serializeDocument(d)).frame).toBe(900);
    });

    test("EVERY field of a patch delta reaches the node — structurally, not by example", () => {
        // `applyMutations` applies a patch by a hand-written list of fields, and a hand-written
        // list over a growing union is a latent field-eater: `track` was dropped by it while the
        // dispatch still reported success, exactly as `TransactionAction.mergePatch` once dropped
        // `path`. Behavioural tests only ever cover the fields that exist today, so this one is
        // STRUCTURAL — it names every field at once and fails the moment a new one is added
        // without being wired, which is the only kind of test that can catch the next occurrence.
        const d = doc(node("A", 0));
        const delta = {
            kind: "patch" as const,
            geometry: { x: 11 }, transform: { rotation: 12 }, style: { opacity: 0.5 },
            layout: { horizontalAlignment: "right" as const },
            name: "renamed", text: "hi", src: "x.png", path: [{ c: "M" as const, x: 1, y: 2 }],
            hidden: true, locked: true, variant: "v", variants: ["v"], slot: "s",
            slotContent: { s: "A" }, states: { hover: {} }, booleanOp: "union" as const,
            interactions: [{ trigger: "click" as const, state: "hover" }],
            track: [{ frame: 0, values: {} }], depth: 3,
            mesh: { cols: 1, rows: 1, points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 50 }, { x: 50, y: 50 }] }
        };
        // Applied DIRECTLY, with no action or transaction in between: the thing under test is the
        // field list itself, and routing through a dispatcher would only add ways to be wrong.
        applyMutationsToDocument(d, new Map([["A", delta as never]]));
        const after = d.nodes.get("A")! as unknown as Record<string, unknown>;
        // Every key of the delta except its tag must be observable on the node afterwards.
        for (const key of Object.keys(delta)) {
            if (key === "kind") continue;
            expect([key, after[key] !== undefined]).toEqual([key, true]);
        }
        expect(after.name).toBe("renamed");
        expect((after.track as unknown[]).length).toBe(1);
    });

    test("a transaction carrying TWO document-level changes is refused, not half-applied", () => {
        // The variable store, the active state and the clock all travel under one key, so only one
        // can occupy it. Losing the others would be invisible — the dispatch would report success
        // and the document would simply not say what it was told to. The guard existed for two
        // claimants and had no test; the timeline is the third, and a pairwise comparison would
        // have quietly stopped covering them all the moment it arrived.
        const d = doc(node("A", 0));
        const dispatcher = new ActionDispatcher(d);
        const live = dispatcher.getDocument();
        const both = new TransactionAction(live, "two document deltas", [
            new SetActiveStateAction(live, "hover"),
            new SetTimelineAction(live, { frames: 24, fps: 12 })
        ]);
        expect(dispatcher.dispatchAction(both).success).toBe(false);
        // …and NEITHER landed: a refusal that half-applied would be worse than the loss it prevents.
        expect(dispatcher.getDocument().timeline).toBeUndefined();
        expect(dispatcher.getDocument().activeState).toBeUndefined();
        // ONE of them inside a transaction is fine — the guard bounds the collision, it does not
        // ban document-level changes from transactions altogether.
        const single = dispatcher.getDocument();
        expect(dispatcher.dispatchAction(new TransactionAction(single, "one document delta", [
            new SetTimelineAction(single, { frames: 24, fps: 12 })
        ])).success).toBe(true);
        expect(dispatcher.getDocument().timeline).toEqual({ frames: 24, fps: 12 });
    });

    test("ONION SKINNING picks the neighbours and never the current frame", () => {
        // A ghost of the frame you are on would only darken it. The choice of frames is a
        // decision and lives here; drawing them faintly is plumbing and lives in the renderer.
        expect(onionFrames(5, 2, 2, 24)).toEqual([3, 4, 6, 7]);
        expect(onionFrames(0, 3, 1, 24)).toEqual([1]);          // clamped at the start
        expect(onionFrames(23, 1, 5, 24)).toEqual([22]);        // and at the end
        expect(onionFrames(5, 0, 0, 24)).toEqual([]);
    });

    test("a timeline SURVIVES a round trip, and an unanimated document is untouched by it", () => {
        const d = doc(node("A", 0, { track: [
            { frame: 0, hold: true, values: { geometry: { x: 0 } } },
            { frame: 8, easing: "ease-out", values: { geometry: { x: 60 } } }
        ] }));
        d.timeline = { frames: 24, fps: 12 };
        d.frame = 3;
        const back = deserializeDocument(serializeDocument(d));
        expect(back.timeline).toEqual({ frames: 24, fps: 12 });
        expect(back.frame).toBe(3);
        expect(back.nodes.get("A")!.track).toEqual(d.nodes.get("A")!.track);
        // A document with no animation serialises without any of the three fields at all.
        const plain = JSON.parse(serializeDocument(doc(node("B", 0))));
        expect(plain.document).not.toHaveProperty("timeline");
        expect(plain.document).not.toHaveProperty("frame");
    });
});

describe("Resolve — contours made simple under a fill rule", () => {
    const signed2 = (r: { x: number; y: number }[]): number => {
        let a = 0;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j].x * r[i].y - r[i].x * r[j].y;
        return a;
    };
    /**
     * Area of the region a resolved ring set describes.
     *
     * The SIGNED sum, not "the biggest less the rest": resolution directs every boundary with the
     * filled side on its left, so a hole is wound the other way and subtracts itself, and separate
     * islands are wound the same way and add. That one formula covers a donut and five loose
     * triangles alike — which the outer-minus-inner shortcut does not, and getting it wrong is how
     * five triangles came out as one triangle minus four.
     */
    const net = (rings: { x: number; y: number }[][]): number =>
        Math.abs(rings.reduce((sum, r) => sum + signed2(r), 0)) / 2;
    const sq = (x: number, y: number, w: number, h: number) =>
        [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    /** Do any two non-adjacent edges of a ring cross? The definition of "not simple". */
    const selfCrossings = (r: { x: number; y: number }[]): number => {
        const cr = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number =>
            (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        let n = 0;
        for (let i = 0; i < r.length; i++) {
            for (let j = i + 2; j < r.length; j++) {
                if (i === 0 && j === r.length - 1) continue;
                const a = r[i], b = r[(i + 1) % r.length], c = r[j], d = r[(j + 1) % r.length];
                const d1 = cr(a, b, c), d2 = cr(a, b, d), d3 = cr(c, d, a), d4 = cr(c, d, b);
                if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) n++;
            }
        }
        return n;
    };
    /** The classic {5/2} star: five points visited two apart, drawn as ONE crossing contour. */
    const pentagram = (R: number): { x: number; y: number }[] => {
        const pts: { x: number; y: number }[] = [];
        for (let k = 0; k < 5; k++) {
            const a = (2 * Math.PI * ((k * 2) % 5)) / 5 - Math.PI / 2;
            pts.push({ x: R * Math.cos(a), y: R * Math.sin(a) });
        }
        return pts;
    };

    test("a simple ring is returned unchanged — resolving is idempotent", () => {
        // Callers resolve indiscriminately rather than testing whether they need to, because
        // detecting self-intersection costs the same O(n^2) as fixing it. That is only safe if
        // resolving something already simple is a no-op.
        const once = resolveRings([sq(0, 0, 100, 50)]);
        expect(once.length).toBe(1);
        expect(net(once)).toBeCloseTo(5000, 6);
        expect(net(resolveRings(once))).toBeCloseTo(5000, 6);
        // …and it does not care which way the input was wound.
        expect(net(resolveRings([[...sq(0, 0, 100, 50)].reverse()]))).toBeCloseTo(5000, 6);
    });

    test("a PENTAGRAM means two different shapes, and the rule is which", () => {
        // The case the whole module exists for. Five points drawn as one self-crossing contour —
        // the way anyone actually draws a star — winds TWICE around its centre. Under nonzero
        // that centre is filled and the star is solid; under even-odd two boundaries lie between
        // it and infinity, so it is a hole. Both are correct; neither is expressible without a
        // rule, and neither was expressible at all before this.
        const star = pentagram(100);
        expect(insideRule([star], 0, 0, "nonzero")).toBe(true);
        expect(insideRule([star], 0, 0, "evenodd")).toBe(false);

        const solid = resolveRings([star], "nonzero");
        const holed = resolveRings([star], "evenodd");
        expect(solid.length).toBe(1);            // one outline, and it is the star's silhouette
        // Under even-odd the region is FIVE separate triangles meeting at the pentagon's corners
        // — not one loop pinched five times. Both describe the same area; only this one is made
        // of simple rings, and only simple rings can be ear-clipped.
        expect(holed.length).toBe(5);
        expect(holed.every(r => r.length === 3)).toBe(true);
        const areas = holed.map(r => Math.abs(signed2(r)) / 2);
        for (const a of areas) expect(a).toBeCloseTo(areas[0], 6);      // congruent, by symmetry

        // The difference between the two regions is exactly the central pentagon, whose
        // circumradius is R/phi^2 — derived from the geometry rather than read off the output.
        const phi = (1 + Math.sqrt(5)) / 2;
        const r = 100 / (phi * phi);
        const pentagon = 2.5 * r * r * Math.sin((2 * Math.PI) / 5);
        expect(net(solid) - net(holed)).toBeCloseTo(pentagon, 6);
    });

    test("what comes out does not cross itself, which is what ear clipping needs", () => {
        // `Tessellate` is defined only on simple polygons and said so; this is the promise that
        // makes the caveat unnecessary. Asserted directly rather than through an area, because a
        // partial fan can still sum to a plausible number.
        for (const rule of FILL_RULES) {
            for (const ring of resolveRings([pentagram(100)], rule)) {
                expect(selfCrossings(ring)).toBe(0);
            }
        }
    });

    test("a self-crossing star TESSELLATES correctly once resolved", () => {
        // The payoff, measured where it shows: triangles covering the region, not a partial fan.
        // The area is not hard-coded — it is the resolved rings' own, which the previous test has
        // already established are simple.
        const star = pentagram(100);
        for (const rule of FILL_RULES) {
            const rings = resolveRings([star], rule);
            const t = triangulate(rings);
            let a = 0;
            for (let i = 0; i < t.length; i += 6) {
                a += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
            }
            expect(a).toBeCloseTo(net(rings), 6);
        }
        // And the unresolved contour is what it could not do. The failure is not that clipping
        // stops early — it is that the triangles OVERLAP: a crossing makes vertices reflex that
        // the ear test reads as convex, so pieces get emitted over each other and the covered
        // area comes out far ABOVE the shape's, not below it. Asserted as "not the right number
        // by a wide margin", which is the honest claim; the exact wrong number is not a contract.
        const raw = triangulate([star]);
        let rawArea = 0;
        for (let i = 0; i < raw.length; i += 6) {
            rawArea += Math.abs((raw[i + 2] - raw[i]) * (raw[i + 5] - raw[i + 1]) - (raw[i + 4] - raw[i]) * (raw[i + 3] - raw[i + 1])) / 2;
        }
        const truth = net(resolveRings([star], "nonzero"));
        expect(Math.abs(rawArea - truth)).toBeGreaterThan(truth * 0.1);
    });

    test("two OVERLAPPING contours merge or punch a hole, by the rule", () => {
        // The same distinction on separate contours rather than one crossing itself. Under
        // nonzero, two squares wound the same way are a union; under even-odd their overlap
        // cancels and becomes a hole.
        const two = [sq(0, 0, 100, 100), sq(50, 50, 100, 100)];
        expect(net(resolveRings(two, "nonzero"))).toBeCloseTo(10000 + 10000 - 2500, 6);
        expect(net(resolveRings(two, "evenodd"))).toBeCloseTo(10000 + 10000 - 2 * 2500, 6);
    });

    test("opposite windings cancel to NOTHING, and that is an answer", () => {
        // A ring and its reverse enclose no region under nonzero. Returning an empty list is
        // correct and has to be, because the alternative is emitting a boundary with fill on
        // neither side — a shape that draws as a hairline nobody asked for.
        const ring = sq(0, 0, 100, 100);
        expect(resolveRings([ring, [...ring].reverse()], "nonzero")).toEqual([]);
        // Even-odd agrees here for its own reason: two boundaries, so the middle is out.
        expect(net(resolveRings([ring, [...ring].reverse()], "evenodd"))).toBeCloseTo(0, 6);
    });

    test("a ring INSIDE another is a hole under both rules", () => {
        // The one case where the rules agree only if the inner ring is wound the other way for
        // nonzero — and where even-odd needs no winding at all. Both must survive resolution as
        // an outline plus a hole, not as two stacked discs.
        const donutNonzero = resolveRings([sq(0, 0, 100, 100), [...sq(25, 25, 50, 50)].reverse()], "nonzero");
        expect(donutNonzero.length).toBe(2);
        expect(net(donutNonzero)).toBeCloseTo(10000 - 2500, 6);
        // Same winding, even-odd: still a donut, because the count is what matters.
        const donutEvenOdd = resolveRings([sq(0, 0, 100, 100), sq(25, 25, 50, 50)], "evenodd");
        expect(donutEvenOdd.length).toBe(2);
        expect(net(donutEvenOdd)).toBeCloseTo(10000 - 2500, 6);
    });

    test("the hole comes out wound OPPOSITE, whatever rule went in", () => {
        // The output is always nonzero-fillable — that is what lets every consumer downstream
        // stop carrying the rule. A hole that came out the same way round would fill solid.
        const rings = resolveRings([sq(0, 0, 100, 100), sq(25, 25, 50, 50)], "evenodd");
        const [outer, inner] = rings.slice().sort((a, b) => Math.abs(signed2(b)) - Math.abs(signed2(a)));
        expect(Math.sign(signed2(outer))).not.toBe(Math.sign(signed2(inner)));
        expect(insideRings(rings, 50, 50)).toBe(false);      // the middle reads as EMPTY under nonzero
        expect(insideRings(rings, 5, 50)).toBe(true);
    });

    test("a piece far shorter than the probe is still classified correctly", () => {
        // The side-probe steps a fixed 1e-6 off each edge to see what is on either side of it,
        // which is fine until an edge is shorter than that. A square with a vertex a
        // ten-millionth of a unit from its corner has one, and must still resolve to the square —
        // the probe is perpendicular, so a short edge is not by itself a problem, and this pins
        // that rather than the cap (which no producible input reaches; see the module note).
        const tiny = [
            { x: 0, y: 0 }, { x: 1e-7, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }
        ];
        const out = resolveRings([tiny], "nonzero");
        expect(out.length).toBe(1);
        expect(net(out)).toBeCloseTo(10000, 6);
    });

    test("a hole that TOUCHES its outline still tessellates", () => {
        // Resolution routinely produces this: a region whose inner boundary meets its outer one
        // at a vertex. Bridging such a hole makes a zero-length bridge, and a zero-length edge is
        // never an ear — so the ring is re-deduped after bridging, which turns the degenerate
        // bridge into the splice one would write by hand for that case.
        const outer = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
        const hole = [{ x: 100, y: 0 }, { x: 60, y: 20 }, { x: 80, y: 60 }];   // shares the corner
        const t = triangulate([outer, hole]);
        let a = 0;
        for (let i = 0; i < t.length; i += 6) {
            a += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
        }
        // The triangle cut out is (100,0),(60,20),(80,60):
        //   |100(20-60) + 60(60-0) + 80(0-20)| / 2 = |-4000 + 3600 - 1600| / 2 = 1000.
        expect(a).toBeCloseTo(10000 - 1000, 6);
    });

    test("degenerate input resolves to nothing rather than throwing", () => {
        expect(resolveRings([])).toEqual([]);
        expect(resolveRings([[{ x: 0, y: 0 }, { x: 1, y: 1 }]])).toEqual([]);
        expect(crossingCount([], 0, 0)).toBe(0);
    });

    test("the two rules are spelled the way SVG and Canvas spell them", () => {
        // They reach `fill-rule` and `ctx.fill(...)` verbatim, like the join and cap names.
        expect(FILL_RULES).toEqual(["nonzero", "evenodd"]);
    });
});

describe("ConvexDecompose", () => {
    const sq = (x: number, y: number, w: number, h: number): { x: number; y: number }[] =>
        [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    /** Every piece convex, and their areas summing to the shape's — the two halves of "covers it". */
    const allConvex = (pieces: { x: number; y: number }[][]): boolean => pieces.every(isConvexRing);

    test("a convex shape comes back as ONE piece", () => {
        // The merging has to actually merge. A square triangulates into two, and if the two are
        // not put back together then nothing else in this module is doing its job either.
        const pieces = convexPieces([sq(0, 0, 100, 50)]);
        expect(pieces.length).toBe(1);
        expect(allConvex(pieces)).toBe(true);
        expect(piecesArea(pieces)).toBeCloseTo(5000, 6);
    });

    test("a CONCAVE shape splits at its reflex corner and nowhere else", () => {
        // An L cannot be one convex piece, and it does not need three: the fewest is two, and
        // Hertel-Mehlhorn finds it here. What is asserted is both halves of correctness — every
        // piece convex, and the total area unchanged.
        const L = [
            { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 },
            { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 }
        ];
        const pieces = convexPieces([L]);
        expect(allConvex(pieces)).toBe(true);
        expect(piecesArea(pieces)).toBeCloseTo(100 * 40 + 40 * 60, 6);
        expect(pieces.length).toBe(2);
    });

    test("a STAR needs one piece per point, and every piece is convex", () => {
        // Five reflex corners, so no merging can get below six pieces (a core plus five points).
        // The number matters less than the two invariants, which hold whatever the merge order.
        const star: { x: number; y: number }[] = [];
        for (let i = 0; i < 10; i++) {
            const a = (Math.PI / 5) * i - Math.PI / 2;
            const r = i % 2 === 0 ? 100 : 40;
            star.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
        }
        const pieces = convexPieces([star]);
        expect(allConvex(pieces)).toBe(true);
        expect(piecesArea(pieces)).toBeCloseTo(10 * 0.5 * 100 * 40 * Math.sin(Math.PI / 5), 4);
        // Fewer than the 8 triangles it started as, and never below what the reflex corners force.
        expect(pieces.length).toBeLessThan(8);
        expect(pieces.length).toBeGreaterThanOrEqual(5);
    });

    test("a HOLE stays a hole, without this module knowing what a hole is", () => {
        // `triangulate` already resolves rings by signed area, and a triangle list has no memory
        // of which ring a triangle came from — so the decomposition inherits holes for free. The
        // area is the proof: a donut's pieces cover the ring, not the disc.
        const pieces = convexPieces([sq(0, 0, 100, 100), [...sq(25, 25, 50, 50)].reverse()]);
        expect(allConvex(pieces)).toBe(true);
        expect(piecesArea(pieces)).toBeCloseTo(10000 - 2500, 6);
    });

    test("merging invents no points — every vertex came from the input", () => {
        // The same promise flattening and the booleans make. A decomposition that rounded or
        // averaged coordinates would drift away from the outline picking tests against.
        const L = [
            { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 },
            { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 }
        ];
        const source = new Set(L.map(p => `${p.x},${p.y}`));
        for (const piece of convexPieces([L])) {
            for (const p of piece) expect(source.has(`${p.x},${p.y}`)).toBe(true);
        }
    });

    test("a merge that would make a reflex corner is REFUSED", () => {
        // The whole of Hertel-Mehlhorn is this one decision. Two triangles that share an edge but
        // whose union bends the wrong way must stay apart — merging them would produce a piece
        // that is not convex, and every consumer here treats convexity as a promise.
        const a = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }];
        const b = [{ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 5, y: -1 }];   // shares 0,0 -> 10,0 reversed
        expect(isConvexRing(a)).toBe(true);
        expect(isConvexRing(b)).toBe(true);
        // Their union is a dart: convex at three corners, reflex nowhere it can hide.
        expect(isConvexRing([{ x: 0, y: 0 }, { x: 5, y: -1 }, { x: 10, y: 0 }, { x: 5, y: 5 }])).toBe(true);
        expect(isConvexRing([{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 10, y: 0 }, { x: 5, y: 5 }])).toBe(false);
    });

    test("collinear corners do not count as a bend", () => {
        // A merge often leaves three points in a line. Calling that non-convex would split shapes
        // at corners that are not corners, and every path with a redundant vertex has them.
        expect(isConvexRing([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])).toBe(true);
        expect(isConvexRing([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(false);   // not a ring at all
    });

    test("SAT answers overlap, touching and containment with ONE test", () => {
        // This is what the decomposition buys. Containment is not a case that had to be
        // remembered — a region inside a shape admits no separating axis, so it simply reports
        // overlap like everything else.
        const shape = rectRing(0, 0, 100, 100);
        expect(convexOverlaps(shape, rectRing(50, 50, 200, 200))).toBe(true);    // partial
        expect(convexOverlaps(shape, rectRing(20, 20, 10, 10))).toBe(true);      // region INSIDE shape
        expect(convexOverlaps(rectRing(20, 20, 10, 10), shape)).toBe(true);      // shape inside region
        expect(convexOverlaps(shape, rectRing(100, 0, 50, 50))).toBe(true);      // edge-to-edge TOUCH
        expect(convexOverlaps(shape, rectRing(101, 0, 50, 50))).toBe(false);     // a gap is a gap
        expect(convexOverlaps(shape, rectRing(0, -50, 100, 49))).toBe(false);
    });

    test("a rotated region separates on an axis neither shape is aligned to", () => {
        // The reason SAT and not two bounding-box comparisons: a diamond past the square's CORNER
        // misses it entirely, while their axis-aligned extents overlap on both x and y — so the
        // only axis that separates them is one neither shape has an edge parallel to the axes on.
        const square = rectRing(0, 0, 100, 100);
        const diamondAt = (cx: number, cy: number) =>
            [{ x: cx, y: cy - 100 }, { x: cx + 100, y: cy }, { x: cx, y: cy + 100 }, { x: cx - 100, y: cy }];
        const clear = diamondAt(170, 170);
        // Extents overlap on BOTH axes: x [70,270] vs [0,100], y [70,270] vs [0,100].
        expect(Math.min(...clear.map(p => p.x))).toBeLessThan(100);
        expect(Math.min(...clear.map(p => p.y))).toBeLessThan(100);
        // …and yet nothing is shared: |100-170| + |100-170| = 140 > 100, so the square's nearest
        // corner is outside the diamond, and the separating axis is the diamond's own edge normal.
        expect(convexOverlaps(square, clear)).toBe(false);
        expect(convexOverlaps(square, diamondAt(140, 140))).toBe(true);   // 80 <= 100: it reaches
    });

    test("SAT projects onto edge NORMALS — directions are a different set, and a wrong one", () => {
        // A rectangle cannot show the difference: its edge directions and its edge normals are
        // the same four axes, so projecting onto either answers alike. A TRIANGLE separates them.
        // These two are disjoint — the second lies entirely beyond the first's hypotenuse — and
        // the only axis that says so is that hypotenuse's NORMAL. On all three edge directions
        // their projections overlap, so a version that used directions would report a hit.
        const a = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];      // x + y <= 10
        const clear = [{ x: 7, y: 7 }, { x: 17, y: 7 }, { x: 7, y: 17 }];  // x + y >= 14
        expect(convexOverlaps(a, clear)).toBe(false);
        // Its axis-aligned extents overlap on both x and y, so this is not a bounding-box result.
        expect(Math.min(...clear.map(p => p.x))).toBeLessThan(10);
        expect(Math.min(...clear.map(p => p.y))).toBeLessThan(10);
        // Slide it in until it crosses the hypotenuse and the same test says yes.
        expect(convexOverlaps(a, [{ x: 4, y: 4 }, { x: 14, y: 4 }, { x: 4, y: 14 }])).toBe(true);
    });

    test("the decomposition is what makes a CONCAVE overlap exact", () => {
        // The payoff, stated as the thing a bounding box gets wrong: a region sitting in the
        // notch of an L overlaps its BOX completely and its INK not at all.
        const L = [
            { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 },
            { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 }
        ];
        const pieces = convexPieces([L]);
        const inNotch = rectRing(60, 60, 20, 20);
        expect(piecesOverlap(pieces, inNotch)).toBe(false);
        // …while the same-sized region over the arm hits.
        expect(piecesOverlap(pieces, rectRing(60, 10, 20, 20))).toBe(true);
        // And a region containing the whole shape hits, containment being no special case.
        expect(piecesOverlap(pieces, rectRing(-50, -50, 400, 400))).toBe(true);
    });

    test("degenerate input decomposes to nothing rather than throwing", () => {
        expect(convexPieces([])).toEqual([]);
        expect(convexPieces([[{ x: 0, y: 0 }, { x: 1, y: 1 }]])).toEqual([]);
        expect(convexOverlaps([], rectRing(0, 0, 10, 10))).toBe(false);
        expect(piecesOverlap([], rectRing(0, 0, 10, 10))).toBe(false);
    });
});

describe("Tessellate", () => {
    /** Total area of a triangle list — the number that must match the shape it came from. */
    const triArea = (t: number[]): number => {
        let a = 0;
        for (let i = 0; i < t.length; i += 6) {
            a += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
        }
        return a;
    };
    const tris = (t: number[]): number => t.length / 6;
    const sq = (x: number, y: number, w: number, h: number) =>
        [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

    test("a square becomes two triangles covering exactly its area", () => {
        const t = triangulate([sq(0, 0, 100, 50)]);
        expect(tris(t)).toBe(2);                 // n − 2 triangles for an n-gon
        expect(triArea(t)).toBeCloseTo(5000, 6);
    });

    test("a CONCAVE shape is clipped correctly — the notch is not filled in", () => {
        // An L. A naive fan from one vertex would cover the notch; ear clipping must not.
        const L = [
            { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 },
            { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 }
        ];
        const t = triangulate([L]);
        expect(tris(t)).toBe(4);                 // 6 vertices → 4 triangles
        expect(triArea(t)).toBeCloseTo(100 * 40 + 40 * 60, 6);
        // Area alone cannot tell a tessellation from an overlapping fan — `triArea` sums
        // ABSOLUTE areas, so a triangle covering the notch adds to the total just like a real
        // one. Every triangle's CENTROID must be inside the shape; that is what "these triangles
        // are the fill" means, and it is the assertion a fan fails.
        for (let i = 0; i < t.length; i += 6) {
            const cx = (t[i] + t[i + 2] + t[i + 4]) / 3, cy = (t[i + 1] + t[i + 3] + t[i + 5]) / 3;
            expect(insideRings([L], cx, cy)).toBe(true);
        }
    });

    test("a STAR — five reflex corners — is clipped, not fanned", () => {
        // An L has one reflex corner and it happens never to come up first, so dropping either
        // ear condition still produced the right answer there. A star cannot be fanned by
        // accident: every other vertex is reflex, so a triangulator that ignores convexity, or
        // that ignores whether a vertex sits inside the candidate ear, spills triangles outside
        // the shape immediately.
        const star: { x: number; y: number }[] = [];
        for (let i = 0; i < 10; i++) {
            const a = (Math.PI / 5) * i - Math.PI / 2;
            const r = i % 2 === 0 ? 100 : 40;
            star.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
        }
        const t = triangulate([star]);
        expect(tris(t)).toBe(8);                                   // 10 vertices → 8 triangles
        // Ten identical spikes: 10 x (1/2)·R·r·sin(36 degrees).
        expect(triArea(t)).toBeCloseTo(10 * 0.5 * 100 * 40 * Math.sin(Math.PI / 5), 4);
        for (let i = 0; i < t.length; i += 6) {
            const cx = (t[i] + t[i + 2] + t[i + 4]) / 3, cy = (t[i + 1] + t[i + 3] + t[i + 5]) / 3;
            expect(insideRings([star], cx, cy)).toBe(true);
        }
    });

    test("a SLIT reaching across the shape is not tessellated over", () => {
        // The containment half of the ear test only bites when a reflex vertex intrudes from FAR
        // AWAY — in a star every reflex corner is the candidate ear's own neighbour, so it is
        // excluded from the scan and convexity alone gets the right answer. Here a thin slit is
        // cut up from the bottom edge, and its tip sits inside the ear of the top-right corner:
        // the two vertices are five steps apart in the ring. Without containment that corner is
        // clipped and the triangle covers the slit, which is a hole in the shape.
        const slit = [
            { x: 0, y: 0 }, { x: 85, y: 0 }, { x: 88, y: 90 }, { x: 91, y: 0 },
            { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }
        ];
        const t = triangulate([slit]);
        expect(tris(t)).toBe(5);                                   // 7 vertices → 5 triangles
        // The square less the slit: 100x100 minus a 6-wide, 90-tall triangle.
        expect(triArea(t)).toBeCloseTo(100 * 100 - (6 * 90) / 2, 6);
        for (let i = 0; i < t.length; i += 6) {
            const cx = (t[i] + t[i + 2] + t[i + 4]) / 3, cy = (t[i + 1] + t[i + 3] + t[i + 5]) / 3;
            expect(insideRings([slit], cx, cy)).toBe(true);
        }
    });

    test("a COLLINEAR corner is never clipped into a zero-area triangle", () => {
        // Real paths carry redundant vertices constantly — a midpoint on a straight edge, a
        // rectangle drawn as five points. Such a corner turns neither way, and a triangle built on
        // it has no area: it paints nothing, costs a draw, and is the degenerate input every
        // downstream consumer has to special-case. So the ear test rejects a corner that is merely
        // NOT reflex; it demands a genuine turn.
        const square = [
            { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
            { x: 0, y: 50 }                                      // collinear on the left edge
        ];
        const t = triangulate([square]);
        expect(triArea(t)).toBeCloseTo(10000, 6);
        for (let i = 0; i < t.length; i += 6) {
            const a = Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1])
                - (t[i + 3] - t[i + 1]) * (t[i + 4] - t[i])) / 2;
            expect(a).toBeGreaterThan(0);
        }
    });

    test("a HOLE is a hole: the triangles cover the ring, not the disc", () => {
        // The property that makes this usable at all. Bridging joins the hole to the outline with
        // a doubled edge, which encloses no area — so the total is outer minus inner exactly.
        const outer = sq(0, 0, 100, 100);
        const inner = [...sq(25, 25, 50, 50)].reverse();     // opposite winding = a hole
        const t = triangulate([outer, inner]);
        expect(triArea(t)).toBeCloseTo(10000 - 2500, 6);
        expect(tris(t)).toBeGreaterThan(4);
    });

    test("winding does not matter — the same shape tessellates to the same area either way", () => {
        // Rings arrive from `commandsToRings` in whatever direction the author drew, so a
        // triangulator that only worked for one winding would fill some shapes and not others.
        const cw = triangulate([sq(0, 0, 60, 30)]);
        const ccw = triangulate([[...sq(0, 0, 60, 30)].reverse()]);
        expect(triArea(cw)).toBeCloseTo(1800, 6);
        expect(triArea(ccw)).toBeCloseTo(1800, 6);
    });

    test("the OUTLINE is the largest ring, not the first one given", () => {
        // Order is an accident of how a path was written; area is a fact about the shape.
        const inner = [...sq(25, 25, 50, 50)].reverse();
        const outer = sq(0, 0, 100, 100);
        expect(triArea(triangulate([inner, outer]))).toBeCloseTo(7500, 6);
    });

    test("two SAME-winding rings are separate islands, both filled", () => {
        const t = triangulate([sq(0, 0, 40, 40), sq(200, 200, 20, 20)]);
        expect(triArea(t)).toBeCloseTo(1600 + 400, 6);
    });

    test("a flattened CURVE tessellates to its own area", () => {
        // The path this actually takes in the app: commands → rings → triangles. The area is the
        // flattened ellipse's, so it is compared against the polygon, not against pi·ab — the
        // tessellation must add nothing and lose nothing.
        const rings = commandsToRings(ellipseCommands(200, 120));
        const polygonArea = Math.abs(rings.reduce((sum, r) => sum + signedArea2(r) / 2, 0));
        expect(triArea(triangulate(rings))).toBeCloseTo(polygonArea, 6);
    });

    test("degenerate input yields no triangles rather than throwing", () => {
        // A shape mid-edit is a legitimate thing to have on a canvas; a renderer must not fall
        // over on one.
        expect(triangulate([])).toEqual([]);
        expect(triangulate([[{ x: 0, y: 0 }, { x: 1, y: 1 }]])).toEqual([]);          // two points
        expect(triangulate([[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]))       // collinear
            .toHaveLength(6);                                                          // one zero-area triangle
        expect(triArea(triangulate([[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]))).toBeCloseTo(0, 9);
    });

    test("REPEATED vertices do not stall the clipping — the whole shape is still covered", () => {
        // Found by tessellating a fully-rounded rectangle: the radius clamp turns its straight
        // edges into zero-length `L`s, so the ring carries doubled points. A zero-length edge is
        // never an ear (its corner is degenerate), so clipping found none and stopped with a
        // partial fan — 116 triangles of 130, covering 2365 units of 7853.
        const rings = commandsToRings(rectCommands(100, 100, 50));
        const polygon = Math.abs(signedArea2(rings[0]) / 2);
        expect(triArea(triangulate(rings))).toBeCloseTo(polygon, 6);

        // The same thing stated in the smallest possible way: a square with every corner doubled.
        const doubled = [
            { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 },
            { x: 10, y: 10 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 10 }
        ];
        expect(triArea(triangulate([doubled]))).toBeCloseTo(100, 6);
    });

    test("a vertex budget bounds the work, because this runs on document data", () => {
        const huge = [Array.from({ length: TESSELLATE_MAX_VERTICES + 1 }, (_, i) => ({ x: i, y: i % 2 }))];
        expect(triangulate(huge)).toEqual([]);
    });

    test("a self-intersecting ring stops instead of spinning", () => {
        // A bowtie has no ear at some stage; the guard emits what it has rather than looping.
        const bowtie = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
        const t = triangulate([bowtie]);
        expect(Number.isFinite(triArea(t))).toBe(true);
        expect(t.length % 6).toBe(0);
    });
});

// ─── The GPU backend's pure half ───
describe("Outline stroke", () => {
    const mk = (id: string, type: Node["type"], box: { x: number; y: number; width: number; height: number }, style: object = {}): Node =>
        ({ id, type, parent: null, children: [], geometry: box,
           style: { fill: "#0000ff", opacity: 1, ...style } as Node["style"], layout: {} });
    const docOf = (...nodes: Node[]): ProjectDocument => {
        const doc = createEmptyDocument();
        for (const n of nodes) doc.nodes.set(n.id, n);
        doc.rootNodeUuids = nodes.map(n => n.id);
        return doc;
    };
    const area = (rings: { x: number; y: number }[][]): number => {
        const a = rings.map(r => {
            let s = 0;
            for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j].x * r[i].y - r[i].x * r[j].y;
            return Math.abs(s) / 2;
        }).sort((x, y) => y - x);
        return a.length === 0 ? 0 : a[0] - a.slice(1).reduce((n, x) => n + x, 0);
    };

    test("a border becomes a path, and the shape keeps its fill without one", () => {
        // Outlining a border must not throw away the shape it went round: what changes is that
        // the border stops being a parameter and starts being geometry you can select and cut.
        const doc = docOf(mk("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 },
            { stroke: "#ff0000", strokeWidth: 10 }));
        const dispatcher = new ActionDispatcher(doc);
        const action = outlineStrokeAction(doc, computeGeometry(doc), ["R"], ["OUT"])!;
        expect(action).not.toBeNull();
        expect(dispatcher.dispatchAction(action).success).toBe(true);
        const after = dispatcher.getDocument();

        const out = after.nodes.get("OUT")!;
        expect(out.type).toBe("core.path");
        expect(out.style.fill).toBe("#ff0000");             // the BORDER's colour becomes the fill
        expect(area(commandsToRings(out.path!))).toBeCloseTo(110 * 110 - 90 * 90, 4);
        expect(pathError("core.path", out.path!)).toBeNull();

        // The original survives, minus its border — and the fields are GONE, not blanked, so it
        // serialises exactly like a node that never had one.
        const src = after.nodes.get("R")!;
        expect(src.style.fill).toBe("#0000ff");
        expect(src.style.stroke).toBeUndefined();
        expect(src.style.strokeWidth).toBeUndefined();
        expect(JSON.parse(JSON.stringify(src.style))).not.toHaveProperty("stroke");
    });

    test("outlining twice is a no-op the second time", () => {
        // The new path carries no stroke of its own and the source has lost its one, so there is
        // nothing left to outline. Without that, the command would keep producing new geometry
        // from geometry it just produced.
        const doc = docOf(mk("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 },
            { stroke: "#ff0000", strokeWidth: 10 }));
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(outlineStrokeAction(doc, computeGeometry(doc), ["R"], ["OUT"])!);
        const after = dispatcher.getDocument();
        expect(outlineStrokeAction(after, computeGeometry(after), ["R", "OUT"], ["X", "Y"])).toBeNull();
    });

    test("ALIGNMENT is the command's argument, and inner keeps the silhouette", () => {
        // It is not a document field precisely because no backend could draw it. As an argument
        // to a conversion it is exact — what comes out is a fill, which all three draw alike.
        // A FRESH document per case: the dispatcher mutates the one it is given, so a shared doc
        // would lose its border to the first conversion and the next two would read the first
        // one's result back — three identical numbers and a test that proves nothing.
        const outlineWith = (align: StrokeAlign): { x: number; y: number }[][] => {
            const doc = docOf(mk("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 },
                { stroke: "#ff0000", strokeWidth: 10 }));
            const d = new ActionDispatcher(doc);
            d.dispatchAction(outlineStrokeAction(doc, computeGeometry(doc), ["R"], ["OUT"], align)!);
            return commandsToRings(d.getDocument().nodes.get("OUT")!.path!);
        };
        // Asserted as AREA, not as a coordinate: the new path is re-based onto its own tight box
        // (`normalizePathNode`), so its numbers are relative to that box and only the region it
        // covers is comparable across the three.
        expect(area(outlineWith("inner"))).toBeCloseTo(100 * 100 - 80 * 80, 4);     // silhouette kept
        expect(area(outlineWith("outer"))).toBeCloseTo(120 * 120 - 100 * 100, 4);   // grown, shape whole
        expect(area(outlineWith("center"))).toBeCloseTo(110 * 110 - 90 * 90, 4);    // straddling
    });

    test("the JOIN the node was drawn with is the join it is outlined with", () => {
        // Otherwise the conversion would change the picture: a rounded corner would come back
        // mitred, which is the one thing an "outline" must never do.
        const box = { x: 0, y: 0, width: 100, height: 100 };
        const outlineJoin = (join: string | undefined): number => {
            const doc = docOf(mk("R", "core.rectangle", box, { stroke: "#f00", strokeWidth: 10, strokeJoin: join }));
            const d = new ActionDispatcher(doc);
            d.dispatchAction(outlineStrokeAction(doc, computeGeometry(doc), ["R"], ["OUT"])!);
            return area(commandsToRings(d.getDocument().nodes.get("OUT")!.path!));
        };
        // Four corner triangles of half-width 5 — the same difference `StrokeOutline` asserts.
        expect(outlineJoin("miter") - outlineJoin("bevel")).toBeCloseTo(4 * (5 * 5) / 2, 4);
        expect(outlineJoin(undefined)).toBeCloseTo(outlineJoin("miter"), 6);   // absent = miter
    });

    test("a scaled node's border is outlined at the thickness it is DRAWN at", () => {
        // `stroke-width` is in local units and the transform scales it, on every backend. An
        // outline computed in world space would come back a uniform width and match nothing on
        // screen.
        const node = mk("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 },
            { stroke: "#f00", strokeWidth: 10 });
        const doc = docOf({ ...node, transform: { scaleX: 3, scaleY: 3 } } as Node);
        const d = new ActionDispatcher(doc);
        d.dispatchAction(outlineStrokeAction(doc, computeGeometry(doc), ["R"], ["OUT"])!);
        expect(area(commandsToRings(d.getDocument().nodes.get("OUT")!.path!))).toBeCloseTo((110 * 110 - 90 * 90) * 9, 3);
    });

    test("a HAIRLINE cannot be outlined, and says so by declining", () => {
        // An absent width is one SCREEN pixel at any zoom. It has no world-unit thickness, so
        // there is no fixed area to turn into a shape — outlining it would bake in whatever zoom
        // happened to be current, which is exactly the zoom-dependence the rest of the geometry
        // is built to avoid.
        const doc = docOf(mk("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }, { stroke: "#f00" }));
        expect(outlineStrokeAction(doc, computeGeometry(doc), ["R"], ["OUT"])).toBeNull();
        // Nor a zero width, nor a shape with no stroke colour at all.
        const zero = docOf(mk("Z", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }, { stroke: "#f00", strokeWidth: 0 }));
        expect(outlineStrokeAction(zero, computeGeometry(zero), ["Z"], ["OUT"])).toBeNull();
        const bare = docOf(mk("B", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }));
        expect(outlineStrokeAction(bare, computeGeometry(bare), ["B"], ["OUT"])).toBeNull();
    });

    test("a stroke WIDTH TOKEN resolves before it is outlined", () => {
        // The width on screen is the token's value, so the outline has to be too — reading the
        // raw "$size/border" string would be a silent no-op.
        const doc = docOf(mk("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 },
            { stroke: "#f00", strokeWidth: "$size/border" }));
        doc.variables["size/border"] = { type: "spacing", value: 10 };
        expect(strokeWidthOf(doc, "R")).toBe(10);
        const d = new ActionDispatcher(doc);
        d.dispatchAction(outlineStrokeAction(doc, computeGeometry(doc), ["R"], ["OUT"])!);
        expect(area(commandsToRings(d.getDocument().nodes.get("OUT")!.path!))).toBeCloseTo(110 * 110 - 90 * 90, 4);
    });

    test("the whole conversion is ONE undo", () => {
        // Three actions per node — create the path, set its commands, strip the border — and a
        // user who presses undo once expects the border back, not two thirds of it.
        const doc = docOf(mk("R", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 },
            { stroke: "#ff0000", strokeWidth: 10 }));
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(outlineStrokeAction(doc, computeGeometry(doc), ["R"], ["OUT"])!);
        dispatcher.undo();
        const back = dispatcher.getDocument();
        expect(back.nodes.has("OUT")).toBe(false);
        expect(back.nodes.get("R")!.style.stroke).toBe("#ff0000");
        expect(back.nodes.get("R")!.style.strokeWidth).toBe(10);
    });

    test("a whole selection converts in one transaction, skipping what it cannot", () => {
        const doc = docOf(
            mk("A", "core.rectangle", { x: 0, y: 0, width: 100, height: 100 }, { stroke: "#f00", strokeWidth: 10 }),
            mk("B", "core.ellipse", { x: 200, y: 0, width: 100, height: 100 }, { stroke: "#0f0", strokeWidth: 4 }),
            mk("C", "core.rectangle", { x: 400, y: 0, width: 100, height: 100 })          // no border
        );
        const dispatcher = new ActionDispatcher(doc);
        dispatcher.dispatchAction(outlineStrokeAction(doc, computeGeometry(doc), ["A", "B", "C"], ["P", "Q", "R"])!);
        const after = dispatcher.getDocument();
        expect(after.nodes.has("P")).toBe(true);
        expect(after.nodes.has("Q")).toBe(true);
        expect(after.nodes.has("R")).toBe(false);      // C had nothing to outline, so no id was spent
        expect(after.nodes.get("C")!.style.fill).toBe("#0000ff");
    });
});

describe("StrokeOutline", () => {
    /** Signed twice-area of a ring — winding and size in one number. */
    const signed2 = (r: { x: number; y: number }[]): number => {
        let a = 0;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j].x * r[i].y - r[i].x * r[j].y;
        return a;
    };
    const ringArea = (r: { x: number; y: number }[]): number => Math.abs(signed2(r)) / 2;
    /** What the stroke actually covers: the outer ring less every ring it encloses. */
    const covered = (rings: { x: number; y: number }[][]): number => {
        const areas = rings.map(ringArea).sort((a, b) => b - a);
        return areas.length === 0 ? 0 : areas[0] - areas.slice(1).reduce((n, a) => n + a, 0);
    };
    const line = (x1: number, y1: number, x2: number, y2: number): PathCommand[] =>
        [{ c: "M", x: x1, y: y1 }, { c: "L", x: x2, y: y2 }];
    const closedSquare = (s: number, anticlockwise = false): PathCommand[] => {
        const pts = [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];
        const order = anticlockwise ? [...pts].reverse() : pts;
        return [{ c: "M" as const, x: order[0].x, y: order[0].y },
            ...order.slice(1).map(p => ({ c: "L" as const, x: p.x, y: p.y })), { c: "Z" as const }];
    };

    test("a straight line with butt caps is exactly a rectangle", () => {
        // The simplest possible claim, and the one every other case is measured against: a
        // stroke of width w along a length L covers L*w and nothing more.
        const rings = strokeOutline(line(0, 0, 100, 0), { width: 10 });
        expect(rings.length).toBe(1);                    // an OPEN subpath is one ring, not two
        expect(rings[0].length).toBe(4);
        expect(covered(rings)).toBeCloseTo(100 * 10, 6);
    });

    test("a SQUARE cap extends the stroke by half a width at each end", () => {
        const rings = strokeOutline(line(0, 0, 100, 0), { width: 10, cap: "square" });
        expect(covered(rings)).toBeCloseTo((100 + 10) * 10, 6);
    });

    test("a ROUND cap adds a half-disc at each end", () => {
        const rings = strokeOutline(line(0, 0, 100, 0), { width: 10, cap: "round" });
        // Two half-discs of radius 5 = one whole disc. An inscribed polygon is always SMALLER
        // than its circle, and short by at most a band of `tol` around the circumference — that
        // is the bound the tolerance implies, and the honest one to assert. (A flat "within 1%"
        // fails here for a real reason: at r = 5 a 0.05 sagitta is 1.1% of the area.)
        const slack = 2 * Math.PI * 5 * FLATTEN_TOLERANCE;
        expect(covered(rings)).toBeLessThanOrEqual(100 * 10 + Math.PI * 25);
        expect(covered(rings)).toBeGreaterThan(100 * 10 + Math.PI * 25 - slack);
    });

    test("a closed shape is TWO rings — an outer edge and a hole", () => {
        // This is what makes a border a border rather than a filled blob: the middle must be left
        // empty, by the same nonzero rule every other consumer already uses.
        const rings = strokeOutline(closedSquare(100), { width: 10 });
        expect(rings.length).toBe(2);
        const areas = rings.map(ringArea).sort((a, b) => b - a);
        expect(areas[0]).toBeCloseTo(110 * 110, 6);      // 5 outside each edge
        expect(areas[1]).toBeCloseTo(90 * 90, 6);        // 5 inside each edge
    });

    test("the hole winds OPPOSITE the outer ring", () => {
        // Same winding would make the nonzero rule fill straight through the middle, and would
        // make `triangulate` read the inner ring as a separate island rather than as a hole.
        const rings = strokeOutline(closedSquare(100), { width: 10 });
        expect(Math.sign(signed2(rings[0]))).not.toBe(Math.sign(signed2(rings[1])));
    });

    test("INNER alignment keeps the shape's silhouette exactly", () => {
        // The reason this module produces geometry rather than two more style attributes:
        // neither SVG nor Canvas can draw a border that stays inside the shape, and a UI frame
        // almost always wants one — an outer border grows the box it is supposed to outline.
        const rings = strokeOutline(closedSquare(100), { width: 10, align: "inner" });
        const areas = rings.map(ringArea).sort((a, b) => b - a);
        expect(areas[0]).toBeCloseTo(100 * 100, 6);      // the silhouette is untouched
        expect(areas[1]).toBeCloseTo(80 * 80, 6);
    });

    test("OUTER alignment grows the shape and leaves it whole", () => {
        const rings = strokeOutline(closedSquare(100), { width: 10, align: "outer" });
        const areas = rings.map(ringArea).sort((a, b) => b - a);
        expect(areas[0]).toBeCloseTo(120 * 120, 6);
        expect(areas[1]).toBeCloseTo(100 * 100, 6);
    });

    test("alignment follows the SHAPE's winding, not the drawing direction", () => {
        // An author does not choose a winding, they drag a mouse. If "inner" meant "left of
        // travel" the same border would land inside one rectangle and outside its mirror image.
        const cw = strokeOutline(closedSquare(100), { width: 10, align: "inner" });
        const ccw = strokeOutline(closedSquare(100, true), { width: 10, align: "inner" });
        expect(covered(ccw)).toBeCloseTo(covered(cw), 6);
        expect(Math.max(...ccw.map(ringArea))).toBeCloseTo(100 * 100, 6);
    });

    test("a MITER join fills the corner square; a BEVEL cuts it off", () => {
        // The difference between them is exactly the little triangle outside the bevel, and on a
        // right angle that triangle is half the square of the half-width — at all four corners.
        const miter = strokeOutline(closedSquare(100), { width: 10, join: "miter" });
        const bevel = strokeOutline(closedSquare(100), { width: 10, join: "bevel" });
        expect(covered(miter) - covered(bevel)).toBeCloseTo(4 * (5 * 5) / 2, 6);
    });

    test("a ROUND join replaces the corner with a quarter disc", () => {
        const round = strokeOutline(closedSquare(100), { width: 10, join: "round" });
        const bevel = strokeOutline(closedSquare(100), { width: 10, join: "bevel" });
        // Four quarter-discs of radius 5 — one whole disc — less the four bevel triangles
        // already counted. Bounded by the same circumference band as the round cap.
        const expected = Math.PI * 25 - 4 * (5 * 5) / 2;
        const slack = 2 * Math.PI * 5 * FLATTEN_TOLERANCE;
        expect(round.length).toBe(2);
        expect(covered(round) - covered(bevel)).toBeLessThanOrEqual(expected);
        expect(covered(round) - covered(bevel)).toBeGreaterThan(expected - slack);
    });

    test("the MITER LIMIT turns a spike into a bevel", () => {
        // A nearly doubled-back corner has an unbounded miter — without the limit a thin wedge
        // throws a spike far past the shape. SVG measures the limit as miter length over stroke
        // WIDTH, and past it the join must become exactly a bevel, not something in between.
        const wedge: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 200, y: 2 }, { c: "L", x: 0, y: 4 }];
        const far = (rings: { x: number; y: number }[][]): number => Math.max(...rings.flat().map(p => p.x));
        const limited = strokeOutline(wedge, { width: 10, join: "miter", miterLimit: DEFAULT_MITER_LIMIT });
        const generous = strokeOutline(wedge, { width: 10, join: "miter", miterLimit: 1000 });
        const bevelled = strokeOutline(wedge, { width: 10, join: "bevel" });
        expect(far(generous)).toBeGreaterThan(far(limited));
        expect(far(limited)).toBeCloseTo(far(bevelled), 6);
    });

    test("the INNER side of a corner is TRIMMED, not folded over itself", () => {
        // The two offset edges overlap on the inside of a turn. Emitting them untrimmed makes a
        // self-intersecting ring, which the nonzero rule hides on SVG and Canvas and the
        // triangulator cannot — the same stroke would look right on two backends and wrong on
        // the third. The trim keeps the ring simple, so its own area IS the covered area.
        const elbow: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 100 }];
        const rings = strokeOutline(elbow, { width: 10, join: "miter" });
        expect(rings.length).toBe(1);
        // Each arm runs from its butt cap to the MITER point, so each is 105 x 10, and they
        // share the 10 x 10 square at the corner: 1050 + 1050 - 100.
        expect(covered(rings)).toBeCloseTo(105 * 10 + 105 * 10 - 100, 6);
    });

    test("a stroke wider than the shape stays BOUNDED — the fallback never spikes", () => {
        // When the offsets cross beyond the segments themselves there is no trim point, and the
        // fallback runs the outline through the centreline vertex. What that buys is not a simple
        // ring — a stroke this wide covers itself, and no single ring can describe a region that
        // overlaps itself — it is that the corner does not throw a spike. Every join is capped at
        // `miterLimit` half-widths from a centreline vertex, so the whole outline stays inside
        // the path's own box grown by that much, and nothing is NaN.
        const tight: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 6, y: 0 }, { c: "L", x: 6, y: 6 }];
        const half = 20;
        const rings = strokeOutline(tight, { width: half * 2, join: "miter" });
        expect(rings.length).toBe(1);
        const reach = DEFAULT_MITER_LIMIT * half;
        for (const p of rings.flat()) {
            expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
            expect(p.x).toBeGreaterThanOrEqual(0 - reach);
            expect(p.x).toBeLessThanOrEqual(6 + reach);
            expect(p.y).toBeGreaterThanOrEqual(0 - reach);
            expect(p.y).toBeLessThanOrEqual(6 + reach);
        }
    });

    test("the miter limit is a ratio to the STROKE WIDTH, and it flips at exactly that ratio", () => {
        // SVG defines the limit as miter length / stroke WIDTH, and for a corner of angle t the
        // miter length is width / sin(t/2) — so the ratio is 1/sin(t/2) and nothing else. A right
        // angle gives sqrt(2) = 1.41421..., which is a number the join must flip either side of.
        // Measuring against the HALF width instead would silently double every limit, and would
        // be invisible to any test that only used the default 4 on a shape far from the boundary.
        const ratio = 1 / Math.sin(Math.PI / 4);
        const at = (miterLimit: number): number => covered(strokeOutline(closedSquare(100), { width: 10, join: "miter", miterLimit }));
        const bevel = covered(strokeOutline(closedSquare(100), { width: 10, join: "bevel" }));
        expect(at(ratio + 0.01) - bevel).toBeCloseTo(4 * (5 * 5) / 2, 6);   // just above: mitred
        expect(at(ratio - 0.01)).toBeCloseTo(bevel, 6);                      // just below: bevelled
    });

    test("an overshooting inner trim is REFUSED, and the fallback is the centreline vertex", () => {
        // The trim point is only the outline where it lies within both edges. On a corner too
        // tight for the width it lands beyond them, and using it anyway pulls the inner boundary
        // out past where the stroke reaches. The documented fallback runs through the vertex, and
        // that gives a region computable by hand — which is how this number was arrived at rather
        // than by reading it off the implementation.
        //
        // Arms 10 long, width 30, so the outline folds over itself at the corner and the result
        // is RESOLVED before it is returned. What that means for the number: the region is the
        // UNION of the parts, computed here as two arms plus the join.
        //   arm 1  (0,0)->(10,0)  band y in [-15,15], x in [0,10]      = 300
        //   arm 2  (10,0)->(10,10) band x in [-5,25], y in [0,10]      = 300
        //   they share x,y in [0,10] x [0,10]                          = -100
        //   the miter wedge at the outer corner, (10,-15)..(25,0)      = +225
        // The shoelace of the unresolved ring is 825, and that is NOT this number — the shoelace
        // of a ring that crosses itself never is the area it covers, which is the whole reason
        // resolving happens before the rings are handed out.
        const elbow: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "L", x: 10, y: 10 }];
        const rings = strokeOutline(elbow, { width: 30, join: "miter" });
        expect(rings.length).toBe(1);
        expect(covered(rings)).toBeCloseTo(300 + 300 - 100 + 225, 6);
    });

    test("a round cap bulges PAST the end, not back over the stroke", () => {
        // Both arcs have the same two endpoints; only the direction of sweep says which side of
        // the chord they bulge to. Taking the wrong one draws a cap folded back over the stroke —
        // and the two errors can cancel in a total area, so this is asserted as REACH: the
        // outline must extend half a width beyond each end of the line and no less.
        const rings = strokeOutline(line(0, 0, 100, 0), { width: 10, cap: "round" });
        const xs = rings.flat().map(p => p.x);
        expect(Math.min(...xs)).toBeCloseTo(-5, 6);
        expect(Math.max(...xs)).toBeCloseTo(105, 6);
        // A butt cap, by contrast, stops dead at the ends.
        const butt = strokeOutline(line(0, 0, 100, 0), { width: 10 }).flat().map(p => p.x);
        expect(Math.min(...butt)).toBeCloseTo(0, 6);
        expect(Math.max(...butt)).toBeCloseTo(100, 6);
    });

    test("an UNEQUAL corner refuses the trim from either side", () => {
        // The trim has to lie within BOTH offset edges, and a corner can fail that in two
        // independent ways: the crossing can land before the incoming edge began, or past where
        // the outgoing one ends. An L with equal arms fails both at once, so either bound alone
        // still looks sufficient — only an L with a LONG arm and a SHORT one separates them.
        //
        // Asserted as AREA rather than as the fallback's vertex: resolving the result erases the
        // evidence of HOW the corner was built, and rightly so — what a caller is owed is the
        // region, not the route. An accepted-but-overshooting trim pulls the inner boundary
        // outside the shape and changes that region, which is what these numbers catch.
        //
        // Arms 100 and 5, width 30, right-angled:
        //   arm 1  band y in [-15,15], x in [0,100]                    = 3000
        //   arm 2  band x in [85,115], y in [0,5]                      =  150
        //   shared x in [85,100], y in [0,5]                           =  -75
        //   miter wedge at the outer corner, (100,-15)..(115,0)        = +225
        const expected = 3000 + 150 - 75 + 225;
        // Long arm in, short arm out: the crossing overshoots the OUTGOING edge.
        const longThenShort: PathCommand[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 100, y: 5 }];
        expect(covered(strokeOutline(longThenShort, { width: 30 }))).toBeCloseTo(expected, 6);
        // Short arm in, long arm out: it starts before the INCOMING edge. Same shape, drawn the
        // other way round, so it must come out to the same area.
        const shortThenLong: PathCommand[] = [{ c: "M", x: 100, y: 5 }, { c: "L", x: 100, y: 0 }, { c: "L", x: 0, y: 0 }];
        expect(covered(strokeOutline(shortThenLong, { width: 30 }))).toBeCloseTo(expected, 6);
    });

    test("a CURVE is stroked at the flattening tolerance, not at a fixed segment count", () => {
        // A stroked circle is the case that shows the flattener is being read: the band between
        // the two offsets must have the area of an annulus, which a fixed segment count would be
        // visibly short of on a large radius.
        const r = 200, k = 0.5522847498307936 * r;
        const circle: PathCommand[] = [
            { c: "M", x: -r, y: 0 },
            { c: "C", x1: -r, y1: -k, x2: -k, y2: -r, x: 0, y: -r },
            { c: "C", x1: k, y1: -r, x2: r, y2: -k, x: r, y: 0 },
            { c: "C", x1: r, y1: k, x2: k, y2: r, x: 0, y: r },
            { c: "C", x1: -k, y1: r, x2: -r, y2: k, x: -r, y: 0 },
            { c: "Z" }
        ];
        const rings = strokeOutline(circle, { width: 20 });
        expect(rings.length).toBe(2);
        // pi(210^2 - 190^2). The residual is the KAPPA circle's own 0.027% bulge plus the
        // flattening chord, so this is a tight RELATIVE bound rather than an exact equality.
        const expected = Math.PI * (210 * 210 - 190 * 190);
        expect(covered(rings) / expected).toBeGreaterThan(0.999);
        expect(covered(rings) / expected).toBeLessThan(1.001);
    });

    test("a zero or unusable width draws nothing", () => {
        // Legitimate mid-edit states, not errors — the same answer `triangulate` gives for a
        // degenerate ring.
        expect(strokeOutline(line(0, 0, 100, 0), { width: 0 })).toEqual([]);
        expect(strokeOutline(line(0, 0, 100, 0), { width: -5 })).toEqual([]);
        expect(strokeOutline(line(0, 0, 100, 0), { width: NaN })).toEqual([]);
        expect(strokeOutline([{ c: "M", x: 0, y: 0 }], { width: 10 })).toEqual([]);
    });

    test("an OPEN subpath ignores alignment rather than picking a side", () => {
        // There is no inside to be inside of. Silently offsetting to one side would put a
        // "border" somewhere the author never asked for and could not predict.
        const centre = covered(strokeOutline(line(0, 0, 100, 0), { width: 10 }));
        for (const align of STROKE_ALIGNS) {
            expect(covered(strokeOutline(line(0, 0, 100, 0), { width: 10, align }))).toBeCloseTo(centre, 6);
        }
    });

    test("the stroke of a shape is a fill the OTHER consumers can take", () => {
        // The whole point of producing geometry: what comes out must be usable by the pieces that
        // already exist, with no special case for "this one came from a stroke".
        const rings = strokeOutline(closedSquare(100), { width: 10 });
        const t = triangulate(rings);
        let a = 0;
        for (let i = 0; i < t.length; i += 6) {
            a += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
        }
        expect(a).toBeCloseTo(110 * 110 - 90 * 90, 6);
        expect(commandsToRings(ringsToCommands(rings)).length).toBe(2);
    });

    test("the join, cap and align vocabularies are the SVG ones", () => {
        // These strings reach `stroke-linejoin`/`stroke-linecap` and Canvas's `lineJoin`/
        // `lineCap` verbatim. A private spelling would need a translation table in every
        // backend, which is exactly the drift this codebase designs out.
        expect(STROKE_JOINS).toEqual(["miter", "round", "bevel"]);
        expect(STROKE_CAPS).toEqual(["butt", "round", "square"]);
        expect(STROKE_ALIGNS).toEqual(["center", "inner", "outer"]);
        expect(DEFAULT_MITER_LIMIT).toBe(4);
    });
});

describe("Adaptive decomposition — curves cut to what the screen can show", () => {
    const circle = (r: number): PathCommand[] => {
        const k = 0.5522847498307936 * r;
        return [
            { c: "M", x: -r, y: 0 },
            { c: "C", x1: -r, y1: -k, x2: -k, y2: -r, x: 0, y: -r },
            { c: "C", x1: k, y1: -r, x2: r, y2: -k, x: r, y: 0 },
            { c: "C", x1: r, y1: k, x2: k, y2: r, x: 0, y: r },
            { c: "C", x1: -k, y1: r, x2: -r, y2: k, x: -r, y: 0 },
            { c: "Z" }
        ];
    };
    const item = (tol: number, world: unknown = null) => ({
        shape: { kind: "path", commands: circle(100) }, world, nodeId: null, role: "content",
        paint: { fill: "#ff0000", opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
                 radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null }
    }) as never;
    const tris = (tol: number, world: unknown = null): number => {
        const [d] = itemDraws(item(tol, world), tol);
        return d.vertices.length / 6;
    };

    test("a curve is cut FINER on screen and COARSER off it", () => {
        // The whole point. A fixed world tolerance is wrong in both directions at once: zoomed in
        // it facets a silhouette, zoomed out it spends a hundred segments on a curve three pixels
        // long. Neither is a judgement call — both are measured against the same fifth of a pixel.
        const wayOut = tris(displayTolerance(0.05));     // one world unit = a twentieth of a pixel
        const normal = tris(displayTolerance(1));
        const zoomedIn = tris(displayTolerance(20));
        expect(wayOut).toBeLessThan(normal);
        expect(normal).toBeLessThan(zoomedIn);
        // …and the cheap end really is cheap, not merely cheaper.
        expect(wayOut).toBeLessThan(zoomedIn / 4);
    });

    test("the tolerance is QUANTISED, so a small zoom change re-cuts nothing", () => {
        // A tolerance tracking the zoom continuously would change the vertex count every frame of
        // a pinch, and a silhouette whose vertex count changes every frame shimmers. Stepping only
        // at doublings means neighbouring zooms agree exactly.
        // The precise claim is not "neighbouring zooms agree" — two zooms either side of a
        // doubling do not, and must not. It is that the number of distinct answers is set by the
        // ZOOM RANGE and not by how many zooms are visited: sweeping two octaves continuously,
        // two hundred different magnifications produce three tessellations between them.
        const sweep = new Set<number>();
        for (let i = 0; i <= 200; i++) sweep.add(displayTolerance(0.5 + (1.5 * i) / 200));
        expect(sweep.size).toBeLessThanOrEqual(3);
        expect(displayTolerance(1.01)).toBe(displayTolerance(1));
        expect(tris(displayTolerance(1.01))).toBe(tris(displayTolerance(1)));
        // Every value it returns is a power of two, which is what "stepped" means here.
        for (const s of [0.3, 1, 2.5, 7, 33, 100]) {
            const t = displayTolerance(s);
            expect(Math.log2(t)).toBeCloseTo(Math.round(Math.log2(t)), 12);
        }
        // And it does step eventually — quantising is not the same as ignoring.
        expect(displayTolerance(64)).toBeLessThan(displayTolerance(1));
    });

    test("what it buys is measured in PIXELS, and it holds across the range", () => {
        // The promise is a fifth of a device pixel of silhouette error, and quantisation may
        // double it. An inscribed polygon's sagitta on radius r with n sides is r(1 - cos(pi/n)),
        // so the deviation is computable and can be checked against the budget rather than eyed.
        for (const scale of [0.5, 1, 4, 20]) {
            const n = tris(displayTolerance(scale)) + 2;         // an n-gon gives n-2 triangles
            const sagittaWorld = 100 * (1 - Math.cos(Math.PI / n));
            expect(sagittaWorld * scale).toBeLessThan(DISPLAY_DEVIATION_PX * 2);
        }
    });

    test("a node's OWN scale counts as much as the zoom", () => {
        // Flattening happens in local space, so a node scaled 10x needs a tolerance ten times
        // finer to look equally smooth. Reading only the viewport would leave every enlarged
        // shape faceted no matter how far in you zoomed.
        const m = { a: 10, b: 0, c: 0, d: 10 };
        expect(localScaleOf(m, 1)).toBeCloseTo(10, 12);
        expect(localScaleOf({ a: 1, b: 0, c: 0, d: 1 }, 10)).toBeCloseTo(10, 12);
        // A ROTATION is not a scale, however much it mixes the terms.
        const t = Math.PI / 6;
        const rot = { a: Math.cos(t), b: Math.sin(t), c: -Math.sin(t), d: Math.cos(t) };
        expect(localScaleOf(rot, 1)).toBeCloseTo(1, 12);
        // Under a NON-UNIFORM scale it follows the larger axis: erring toward more detail is the
        // error nobody can see, while averaging the two would under-cut the stretched one.
        expect(localScaleOf({ a: 1, b: 0, c: 0, d: 9 }, 1)).toBeCloseTo(9, 12);
    });

    test("absurd scales are CLAMPED rather than trusted", () => {
        // `scale` comes from a matrix the document controls. A node scaled by a billion must not
        // ask for a tolerance of zero and drive the flattener into its depth limit on every frame.
        expect(displayTolerance(1e9)).toBe(DISPLAY_TOLERANCE_MIN);
        expect(displayTolerance(1e-9)).toBe(DISPLAY_TOLERANCE_MAX);
        // A collapsed or broken matrix falls back to the fixed tolerance rather than to nothing.
        expect(displayTolerance(0)).toBe(FLATTEN_TOLERANCE);
        expect(displayTolerance(-4)).toBe(FLATTEN_TOLERANCE);
        expect(displayTolerance(NaN)).toBe(FLATTEN_TOLERANCE);
    });

    test("each ITEM gets its own tolerance, from its own matrix", () => {
        // The per-item decision is a decision, so it lives in the pure half rather than inside the
        // draw loop where only a GPU could reach it. A node scaled up needs a finer cut than the
        // viewport alone would ask for; using the view scale for everything leaves every enlarged
        // shape faceted however far in you zoom.
        const plain = { shape: { kind: "rect", x: 0, y: 0, width: 10, height: 10 }, world: null,
                        nodeId: null, role: "content", paint: {} } as never;
        const scaled = { shape: { kind: "rect", x: 0, y: 0, width: 10, height: 10 },
                         world: compose(0, 0, 0, 16, 16, 0, 0), nodeId: null, role: "content", paint: {} } as never;
        expect(itemTolerance(scaled, 1)).toBeLessThan(itemTolerance(plain, 1));
        expect(itemTolerance(scaled, 1)).toBe(displayTolerance(16));
        // No matrix at all — the grid — is drawn at the view scale, not refused.
        expect(itemTolerance(plain, 4)).toBe(displayTolerance(4));
    });

    test("the tolerance reaches a STROKE through itemDraws, not just a fill", () => {
        // Threading it into the fill and forgetting the border would give a shape whose outline
        // and whose rim were cut to different budgets — visible as a rim that fits at one zoom
        // and not another.
        const stroked = (tol: number) => {
            const [d] = itemDraws({
                shape: { kind: "ellipse", cx: 100, cy: 100, rx: 100, ry: 100 }, world: null,
                nodeId: null, role: "content",
                paint: { fill: null, opacity: null, stroke: "#ffffff", strokeWidth: 8, strokeDash: null,
                         radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null }
            } as never, tol);
            return d.vertices.length;
        };
        expect(stroked(displayTolerance(0.25))).toBeLessThan(stroked(displayTolerance(16)));
    });

    test("PICKING does not become adaptive, and that is the point of two numbers", () => {
        // Drawing wants the error a person can see; picking wants an answer that does not depend
        // on the zoom, because a click that landed at one magnification and missed at another
        // would be unexplainable. The two tolerances are different KINDS of number, so the
        // display one must not have leaked into the hit test.
        const shape = { kind: "path" as const, commands: circle(100), filled: true };
        // A point just inside the rim, at every magnification the same answer.
        expect(hitsShape(shape, 200, 200, 99, 0, 0)).toBe(hitsShape(shape, 200, 200, 99, 0, 0));
        expect(FLATTEN_TOLERANCE).toBe(0.05);
        expect(flattenPath(circle(100)).length).toBe(flattenPath(circle(100)).length);
        // The default is the FIXED one: an `itemDraws` called without a tolerance must not
        // silently pick a screen-dependent one either.
        const [byDefault] = itemDraws(item(0));
        const [explicit] = itemDraws(item(0), FLATTEN_TOLERANCE);
        expect(byDefault.vertices.length).toBe(explicit.vertices.length);
    });

    test("the STROKE outline is cut to the same budget as the fill", () => {
        // A border is a curve too, and one cut at a different tolerance from the shape it goes
        // round would show as a rim that fits at one zoom and not another.
        const coarse = strokeOutline(circle(100), { width: 10 }, displayTolerance(0.25));
        const fine = strokeOutline(circle(100), { width: 10 }, displayTolerance(16));
        expect(coarse.flat().length).toBeLessThan(fine.flat().length);
        // Both still describe the same annulus, to their own accuracy.
        const area = (rings: { x: number; y: number }[][]): number => Math.abs(rings.reduce((s, r) => {
            let a = 0;
            for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j].x * r[i].y - r[i].x * r[j].y;
            return s + a;
        }, 0)) / 2;
        const truth = Math.PI * (105 * 105 - 95 * 95);
        expect(area(fine) / truth).toBeGreaterThan(0.999);
        expect(area(coarse) / truth).toBeGreaterThan(0.95);
    });
});

describe("emitWebGL geometry", () => {
    const item = (shape: unknown, paint: Record<string, unknown> = {}, world: unknown = null) => ({
        shape, world, nodeId: null, role: "content",
        paint: { fill: "#ff0000", opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
                 radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null, ...paint }
    }) as never;
    const area = (t: number[]): number => {
        let a = 0;
        for (let i = 0; i < t.length; i += 6) {
            a += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
        }
        return a;
    };

    test("a shape becomes triangles covering its own area, in WORLD space", () => {
        const world = compose(100, 200, 0, 1, 1, 0, 0);
        const [fill] = itemDraws(item({ kind: "rect", x: 0, y: 0, width: 40, height: 20 }, {}, world));
        expect(area(fill.vertices)).toBeCloseTo(800, 6);
        // Placed by the item's matrix, not left at the local origin.
        expect(Math.min(...fill.vertices.filter((_, i) => i % 2 === 0))).toBeCloseTo(100, 6);
        expect(Math.min(...fill.vertices.filter((_, i) => i % 2 === 1))).toBeCloseTo(200, 6);
    });

    test("the shapes it fills come from the SAME conversions picking and booleans use", () => {
        // A rounded rect and an ellipse must fill exactly the outline the hit test accepts,
        // otherwise the GPU draws one shape and the pointer finds another.
        const [rounded] = itemDraws(item({ kind: "rect", x: 0, y: 0, width: 100, height: 100 }, { radius: 50 }));
        expect(area(rounded.vertices)).toBeCloseTo(Math.PI * 50 * 50, -1);   // a radius-50 round rect IS a circle
        const [ell] = itemDraws(item({ kind: "ellipse", cx: 50, cy: 30, rx: 50, ry: 30 }));
        expect(area(ell.vertices)).toBeCloseTo(Math.PI * 50 * 30, -1);
    });

    test("a bordered shape is TWO draws — fill then stroke, in that order", () => {
        // The other two backends fill an element and then stroke it. Returning only the fill was
        // why a border could not appear on this backend at all.
        const draws = itemDraws(item({ kind: "rect", x: 0, y: 0, width: 100, height: 100 },
            { fill: "#ff0000", stroke: "#00ff00", strokeWidth: 10 }));
        expect(draws.length).toBe(2);
        expect(draws[0].color).toEqual([1, 0, 0, 1]);
        expect(area(draws[0].vertices)).toBeCloseTo(10000, 6);
        expect(draws[1].color).toEqual([0, 1, 0, 1]);
        // A centred 10-wide border on a 100 square: 110^2 - 90^2.
        expect(area(draws[1].vertices)).toBeCloseTo(110 * 110 - 90 * 90, 6);
    });

    test("an OUTLINE item draws its border and NOT a block over the shape", () => {
        // The selection frame is `fill: "none"` plus a stroke. Filling it would paint a solid
        // block over the very shape it outlines; skipping the item entirely (which is what this
        // backend used to do) loses the frame. It is one draw, and it is the border.
        const draws = itemDraws(item({ kind: "rect", x: 0, y: 0, width: 100, height: 100 },
            { fill: "none", stroke: "#ffffff", strokeWidth: 2 }));
        expect(draws.length).toBe(1);
        expect(area(draws[0].vertices)).toBeCloseTo(102 * 102 - 98 * 98, 6);
    });

    test("a stroke is offset in LOCAL space, so a scaled node's border scales too", () => {
        // SVG puts the element inside a transform and Canvas strokes under the CTM, so both
        // thicken a scaled node's border. Offsetting after the transform would hold the width
        // constant in world units and this backend alone would disagree.
        const world = compose(0, 0, 0, 3, 3, 0, 0);
        const [stroke] = itemDraws(item({ kind: "rect", x: 0, y: 0, width: 100, height: 100 },
            { fill: null, stroke: "#ffffff", strokeWidth: 10 }, world));
        expect(area(stroke.vertices)).toBeCloseTo((110 * 110 - 90 * 90) * 9, 6);
    });

    test("a LINE is stroked with its caps, because it has no interior to fill", () => {
        const [tri] = itemDraws(item({ kind: "line", x1: 0, y1: 0, x2: 100, y2: 0 },
            { fill: null, stroke: "#00ff00", strokeWidth: 4 }));
        expect(area(tri.vertices)).toBeCloseTo(400, 6);
        expect(tri.color).toEqual([0, 1, 0, 1]);
        // Caps are the document's now, not hard-coded: a square cap adds half a width at each end.
        const [capped] = itemDraws(item({ kind: "line", x1: 0, y1: 0, x2: 100, y2: 0 },
            { fill: null, stroke: "#00ff00", strokeWidth: 4, strokeCap: "square" }));
        expect(area(capped.vertices)).toBeCloseTo(104 * 4, 6);
        // A zero-length line draws nothing rather than a degenerate sliver.
        expect(itemDraws(item({ kind: "line", x1: 5, y1: 5, x2: 5, y2: 5 },
            { fill: null, stroke: "#00ff00", strokeWidth: 4 }))).toEqual([]);
    });

    test("the JOIN reaches the GPU, so a rounded corner is round there too", () => {
        const square = { kind: "rect" as const, x: 0, y: 0, width: 100, height: 100 };
        const paint = { fill: null, stroke: "#ffffff", strokeWidth: 10 };
        const [miter] = itemDraws(item(square, { ...paint, strokeJoin: "miter" }));
        const [bevel] = itemDraws(item(square, { ...paint, strokeJoin: "bevel" }));
        // Four corner triangles of half-width 5 — the same difference `StrokeOutline` asserts.
        expect(area(miter.vertices) - area(bevel.vertices)).toBeCloseTo(4 * (5 * 5) / 2, 6);
    });

    test("a shape offset from the ORIGIN carries its control points with it", () => {
        // The bug that drew a spike from every selection to the origin. A hand-written translation
        // moved each command's endpoint and left its CONTROL POINTS behind, so a curve offset away
        // from the origin stretched back to it. It hid because the shapes that usually go through
        // here are offset by nothing — a content rect has x = 0, a content ellipse has cx - rx = 0
        // — and the one that is not is the rotate KNOB, a small circle a long way out.
        const knob = shapeToLocalCommands({ kind: "ellipse", cx: 400, cy: 300, rx: 6, ry: 6 } as never, null)!;
        for (const c of knob) {
            if (c.c === "Z") continue;
            // EVERY point of every command — endpoints and control points alike — must sit NEAR
            // the knob. A control point left at the origin is 500 units away, which is the spike.
            // The bound is not the radius itself: a cubic circle's control points legitimately sit
            // OUTSIDE it, at r·sqrt(1 + kappa²) ≈ 1.142r, which is what pulls the curve out to
            // meet the arc. 1.2r clears that comfortably and is still two orders below the bug.
            const pts: { x: number; y: number }[] = [{ x: c.x, y: c.y }];
            if (c.c === "C") pts.push({ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 });
            for (const p of pts) {
                expect(Math.hypot(p.x - 400, p.y - 300)).toBeLessThanOrEqual(6 * 1.2);
            }
        }
        // A ROUNDED rect has the same hazard: its corners are curves, and its offset is its x/y.
        const rounded = shapeToLocalCommands({ kind: "rect", x: 500, y: 400, width: 40, height: 40 } as never, 12)!;
        for (const c of rounded) {
            if (c.c === "Z") continue;
            const pts: { x: number; y: number }[] = [{ x: c.x, y: c.y }];
            if (c.c === "C") pts.push({ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 });
            for (const p of pts) {
                expect(p.x).toBeGreaterThanOrEqual(500 - 1e-9);
                expect(p.y).toBeGreaterThanOrEqual(400 - 1e-9);
            }
        }
    });

    test("what it CANNOT draw, it declines to draw — no silent wrong output", () => {
        // TEXT no longer declines either. It is its box with a bitmap over it, typeset by the
        // SAME function the Canvas backend calls — so the GPU cannot break a line in a different
        // place, which a glyph atlas in here could never promise.
        const typed = itemDraws(item({ kind: "text", x: 0, y: 0, width: 10, height: 10, text: "hi", fontSize: 10, fontFamily: "sans-serif", fontWeight: 400, textAlign: "left", lineHeight: 1.2, letterSpacing: 0 }));
        expect(typed.length).toBe(1);
        expect(typed[0].text).toMatchObject({ kind: "text", text: "hi" });
        // ONE draw, though this helper supplies a fill: on a text node `fill` is the GLYPH colour,
        // so filling the box would paint a solid rectangle over whatever is behind it.
        expect(typed[0].image).toBeNull();
        // EMPTY text is a node with nothing in it — no draw, rather than an invisible quad
        // uploaded and blended every frame.
        expect(itemDraws(item({ kind: "text", x: 0, y: 0, width: 10, height: 10, text: "", fontSize: 10, fontFamily: "sans-serif", fontWeight: 400, textAlign: "left", lineHeight: 1.2, letterSpacing: 0 }))).toEqual([]);
        // IMAGES no longer decline: this assertion was the gap, written down as a test. The
        // heightfield gave this backend a texture path and an image is that path with a picture
        // in it, so a document no longer loses content when the backend is switched.
        const pic = itemDraws(item({ kind: "image", x: 0, y: 0, width: 10, height: 10, href: "x.png" }));
        expect(pic.length).toBe(1);
        // ONE draw even though this helper supplies a fill: the picture REPLACES the fill rather
        // than covering it, because a colour under a transparent PNG shows through and Canvas
        // does not paint one.
        expect(pic[0].image).not.toBeNull();
        // …but one with no href still does, because there is nothing to draw.
        expect(itemDraws(item({ kind: "image", x: 0, y: 0, width: 10, height: 10, href: null }))).toEqual([]);
        // A colour it cannot parse is skipped rather than drawn in the wrong one.
        expect(itemDraws(item({ kind: "rect", x: 0, y: 0, width: 10, height: 10 }, { fill: "rebeccapurple" }))).toEqual([]);
        // A stroke with no width is not a hairline guess — the model resolves widths, and a null
        // one means nothing was asked for.
        expect(itemDraws(item({ kind: "rect", x: 0, y: 0, width: 10, height: 10 },
            { fill: null, stroke: "#fff", strokeWidth: null }))).toEqual([]);
    });

    test("colours and opacity reach the GPU as components", () => {
        expect(parseColor("#f00")).toEqual([1, 0, 0, 1]);
        expect(parseColor("#00ff0080")![3]).toBeCloseTo(128 / 255, 6);
        expect(parseColor("nonsense")).toBeNull();
        // Item opacity MULTIPLIES the colour's own alpha — one blend, not two.
        const [tri] = itemDraws(item({ kind: "rect", x: 0, y: 0, width: 4, height: 4 }, { fill: "#ffffff80", opacity: 0.5 }));
        expect(tri.color[3]).toBeCloseTo((128 / 255) * 0.5, 6);
    });

    test("the view matrix maps world to clip exactly as the other backends map it to screen", () => {
        // screen = z·world − vp, then screen → clip. A world point at the viewport origin must
        // land at the top-left of clip space, and one canvas-width away at the right edge.
        const m = viewMatrix(800, 600, 0, 0, 1);
        const apply = (x: number, y: number) => [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]];
        expect(apply(0, 0)[0]).toBeCloseTo(-1, 9);
        expect(apply(0, 0)[1]).toBeCloseTo(1, 9);
        expect(apply(800, 600)[0]).toBeCloseTo(1, 9);
        expect(apply(800, 600)[1]).toBeCloseTo(-1, 9);
        // Zoom and pan compose the same way they do on screen.
        const z = viewMatrix(800, 600, 100, 50, 2);
        const applyZ = (x: number, y: number) => [z[0] * x + z[3] * y + z[6], z[1] * x + z[4] * y + z[7]];
        // Clip ORIGIN is the canvas CENTRE, not the viewport origin: at zoom 2 with the viewport
        // at (100,50), the world point that lands mid-canvas is (250,175) — 2x−100 = 400 and
        // 2y−50 = 300, the middle of an 800x600 canvas.
        expect(applyZ(250, 175)[0]).toBeCloseTo(0, 9);
        expect(applyZ(250, 175)[1]).toBeCloseTo(0, 9);
    });
});
