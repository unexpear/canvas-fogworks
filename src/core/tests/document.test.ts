/**
 * Document Engine Tests
 * Covers: document model, serialization, action system, dispatcher, history.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { createEmptyDocument, ProjectDocument, CURRENT_VERSION, SCHEMA_VERSION } from "../document/Document";
import { variableStoreError, variableKeyError, resolveVariable, resolveColor, resolveNumber, Variable, VariableStore, VARIABLES_MAX, VARIABLE_FALLBACK_COLOR } from "../document/Variables";
import { SetVariableAction, DeleteVariableAction, SetActiveThemeAction } from "../actions/VariableActions";
import { CreateInstanceAction } from "../actions/CreateInstanceAction";
import { expandInstances, componentError, overridesError, overrideDimensionError, isVirtualId, splitVirtualId, INSTANCE_MAX_DEPTH, INSTANCE_MAX_NODES, INSTANCE_MAX_OVERRIDES } from "../document/Components";
import { SetInstanceOverrideAction } from "../actions/SetInstanceOverrideAction";
import { DetachInstanceAction } from "../actions/DetachInstanceAction";
import { applyMutationsToDocument } from "../actions/applyMutations";
import { geometryActionFor, styleActionFor, isEditableNode, isHandleOffered, isMasterRootCopy } from "../actions/nodeEdit";
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
import { layoutChildren, layoutGridChildren, resolveGridTracks, placeGridItems, breakFlexLines, resolveMargin, expandDirtyForLayout, isLayoutContainer, measureIntrinsicSizes, resolveConstraints } from "../geometry/LayoutEngine";
import { translation, compose, multiply, invert, applyToPoint, transformRectToAABB, IDENTITY } from "../geometry/Matrix";
import { clampViewport, createEditorState, panBy, zoomAt, screenToWorld } from "../../editor/EditorState";
import { selectionHandles, handleAtPoint, groupRotateHandle, groupHandleAtPoint, groupCornerHandles, HANDLE_SIZE_PX, ROTATE_OFFSET_PX } from "../geometry/SelectionHandles";
import { rotateGroup, isGroupRotatable, scaleGroup, isGroupResizable } from "../geometry/GroupTransform";
import { computeSnap, snapPoint, guidesForRect, snapTargetsExcludingSubtree, snapTargetsExcludingSubtrees, isTranslationOnlyChain } from "../geometry/Snapping";
import { rulerTicks, niceStep } from "../geometry/Ruler";
import { MoveTool } from "../../editor/tools/MoveTool";
import { ShapeTool, SHAPE_KINDS, ShapeKind } from "../../editor/tools/ShapeTool";
import { FrameSelectionAction } from "../actions/FrameSelectionAction";
import { SelectTool } from "../../editor/tools/SelectTool";
import { ToolController } from "../../editor/tools/ToolController";
import { Node, NODE_TYPES, nodeIdError, srcError, IMAGE_SRC_MAX, GRID_SPAN_MAX, GRID_MAX_TRACKS, dimensionError, isNodeType, pathError, PATH_MAX_COMMANDS, PathCommand, styleError, Shadow } from "../document/Node";

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
        const ok: ComputedNode = { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: 0, y: 0, width: 10, height: 10 } };
        const bad: ComputedNode = { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: NaN, y: 0, width: 10, height: 10 } };
        const cs: ComputedState = { order: ["bad", "ok"], nodes: new Map([["bad", bad], ["ok", ok]]) };
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
        const ok: ComputedNode = { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: 0, y: 0, width: 10, height: 10 } };
        const bad: ComputedNode = { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: NaN, y: 0, width: 10, height: 10 } };
        const cs: ComputedState = { order: ["bad", "ok"], nodes: new Map([["bad", bad], ["ok", ok]]) };
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
        expect(dispatcher.getDocument().nodes.get("A")!.geometry.width).toBe(97); // raw 97, NOT snapped
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
        const { dispatcher, tc } = harness(Math.PI / 2); // a 100×100 square rotated 90° has the same AABB
        tc.onMouseDown(md(50, -ROTATE_OFFSET_PX), rect); // knob still at (50,−off) since the AABB is unchanged
        tc.onMouseMove(md(100, 50), rect);               // +90° drag
        tc.onMouseUp(md(100, 50));
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
        tc.onMouseDown(md(50, -ROTATE_OFFSET_PX), rect);
        tc.onMouseMove(md(100, 50), rect); // +90° → ~π
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
        expect(overridesError("core.instance", { "a::b": {} })).toMatch('must not contain "::"');
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
        expect(geometryActionFor(doc, "I::OI::deep", { x: 1 })).toBeNull(); // nested — deferred
        expect(isEditableNode(doc, "I::MC")).toBe(true);
        expect(isEditableNode(doc, "I::OI::deep")).toBe(false);
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

    test("a NESTED copy shows no handles at all (it cannot hold an override yet)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("IM", { id: "IM", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#00f", opacity: 1 }, layout: {} });
        doc.nodes.set("OM", { id: "OM", type: "core.rectangle", parent: null, children: ["OI"], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("OI", { id: "OI", type: "core.instance", parent: "OM", children: [], geometry: { x: 5, y: 5, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "IM" });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 200, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "OM" });
        doc.rootNodeUuids = ["IM", "OM", "I"];
        expect(isEditableNode(doc, "I::OI::IM")).toBe(false);       // nested — no override target
        expect(isEditableNode(doc, "I::OI")).toBe(true);            // …but a direct copy is fine
    });

    test("drawn, grabbable, and hovered agree — isHandleOffered is the ONE rule", () => {
        const doc = doc2();
        expect(isHandleOffered(doc, "MC", "rotate")).toBe(true);        // a stored node: everything
        expect(isHandleOffered(doc, "I::MC", "se")).toBe(true);         // a copy: resize corners…
        expect(isHandleOffered(doc, "I::MC", "rotate")).toBe(false);    // …but no rotate knob
        expect(isHandleOffered(doc, "I::OI::deep", "se")).toBe(false);  // nested: nothing
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

    test("a press on a NESTED copy's corner falls through — no dead resize gesture", () => {
        // The renderer draws no handle there; the picker must refuse the same grab, or the user
        // would start a resize that can never commit (no override target).
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
        expect(es.pendingGeometry).toBeNull();   // no resize armed
        expect(toolSawIt).toBe(true);            // …the press reached the tool instead
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
        expect(overrideDimensionError(doc, doc.nodes.get("I")!)).toBeNull();          // no overrides
        const zero = doc2({ MC: { geometry: { width: 0 } } });
        expect(overrideDimensionError(zero, zero.nodes.get("I")!)).toMatch("positive dimensions");
        // A partial override is judged against the master's OTHER axis — what expansion materializes.
        const partial = doc2({ MC: { geometry: { height: 0 } } });
        expect(overrideDimensionError(partial, partial.nodes.get("I")!)).toMatch("positive dimensions");
        // A key resolving to no master stays inert, exactly like a dangling componentId.
        const dangling = doc2({ ghost: { geometry: { width: 0 } } });
        expect(overrideDimensionError(dangling, dangling.nodes.get("I")!)).toBeNull();
        // EDIT path: the same patch is refused on the copy that is refused on the stored node.
        const dispatcher = new ActionDispatcher(doc2());
        expect(dispatcher.dispatchAction(geometryActionFor(dispatcher.getDocument(), "I::MC", { width: 0 })!).success).toBe(false);
        expect(dispatcher.dispatchAction(geometryActionFor(dispatcher.getDocument(), "MC", { width: 0 })!).success).toBe(false);
        // LOAD path: the identical document is rejected rather than materializing an illegal copy.
        expect(() => deserializeDocument(serializeDocument(zero))).toThrow("positive dimensions");
        // …and a type that legitimately allows a zero axis still may.
        const line = doc2({ MC: { geometry: { width: 0 } } });
        line.nodes.set("MC", { ...line.nodes.get("MC")!, type: "core.line" });
        expect(overrideDimensionError(line, line.nodes.get("I")!)).toBeNull();
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

        // Pretending the build has moved to a schema "24" that has no 23→24 step: the
        // legacy file must be normalised to "1", carried through every real step
        // (1→2→…→23), and then REFUSED at "23" — never re-stamped straight to the current
        // schema. The error naming "23" (not "1") is the proof the chain actually ran.
        // (The boundary tracks the last IMPLEMENTED step, so it moves up by one each
        // time a real migration is added — here, when 22→23 landed for the image `src` rule.)
        expect(() => migrateIfNeeded(legacy, "24")).toThrow('Migration not implemented for document schema "23"');

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
            text: "core.text", triangle: "core.path", image: "core.image"
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
