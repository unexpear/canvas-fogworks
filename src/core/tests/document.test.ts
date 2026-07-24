/**
 * Document Engine Tests
 * Covers: document model, serialization, action system, dispatcher, history.
 */

import { createEmptyDocument, ProjectDocument, CURRENT_VERSION, SCHEMA_VERSION } from "../document/Document";
import { serializeDocument, deserializeDocument, compareDocuments, Serializer, migrateIfNeeded } from "../document/Serializer";
import { ActionDispatcher } from "../actions/ActionDispatcher";
import { MoveNodeAction } from "../actions/MoveNodeAction";
import { AddNodeAction } from "../actions/AddNodeAction";
import { DeleteNodeAction } from "../actions/DeleteNodeAction";
import { ResizeNodeAction } from "../actions/ResizeNodeAction";
import { UpdateNodeGeometryAction } from "../actions/UpdateNodeGeometryAction";
import { UpdateNodeStyleAction } from "../actions/UpdateNodeStyleAction";
import { TransactionAction } from "../actions/TransactionAction";
import { ReparentNodeAction } from "../actions/ReparentNodeAction";
import { traverseSceneGraph, selectionRoots } from "../document/SceneGraph";
import { computeGeometry, hitTest, toLocal, toWorld, subtreeBounds, selectionBounds } from "../geometry/GeometryEngine";
import { translation, compose, multiply, invert, applyToPoint, transformRectToAABB } from "../geometry/Matrix";
import { clampViewport, createEditorState } from "../../editor/EditorState";
import { MoveTool } from "../../editor/tools/MoveTool";
import { Node, NODE_TYPES } from "../document/Node";

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
    test("preserves variables (real VariableStore shape) through serialize/deserialize", () => {
        const doc = createEmptyDocument();
        doc.variables = {
            primary: { type: "color", value: "#ff0000", modes: { light: "#ff0000", dark: "#cc0000" } },
            gap: { type: "spacing", value: "8" }
        };
        const json = serializeDocument(doc);
        const loaded = deserializeDocument(json);
        expect(loaded.variables).toEqual(doc.variables);
        // Nested mode map survives the round-trip.
        expect(loaded.variables.primary.modes!.dark).toBe("#cc0000");
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

    // Mutation "legacy re-stamp to schema 1" SURVIVED: today LEGACY_SCHEMA and
    // SCHEMA_VERSION are both "1", so the two behaviours are indistinguishable until a
    // future bump — exactly when the bug would bite. Injecting the schema exposes it now.
    test("a legacy file is normalised then run THROUGH the chain, not marked current", () => {
        const legacy = { version: "0.0.4", document: { metadata: {}, nodes: {}, rootNodeUuids: [], variables: {} } };

        // Pretending the build has moved to a schema "3" that has no 2→3 step: the
        // legacy file must be normalised to "1", carried through the real 1→2 step,
        // and then REFUSED at "2" — never re-stamped straight to the current schema.
        // The error naming "2" (not "1") is the proof the chain actually ran.
        expect(() => migrateIfNeeded(legacy, "3")).toThrow('Migration not implemented for document schema "2"');

        // At the current schema it loads, having been migrated 0.0.4 → 1 → 2.
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
        expect(doc.version).toBe(SCHEMA_VERSION);              // upgraded to "2"
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
