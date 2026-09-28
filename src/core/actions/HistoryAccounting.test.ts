/** @module HistoryAccounting.test @description Exact serialized retention of undo history, including the pinned original after trim. */
import { createEmptyDocument } from "../document/Document";
import { Node } from "../document/Node";
import { ActionDispatcher } from "./ActionDispatcher";
import { AddNodeAction } from "./AddNodeAction";
import { HistoryManager } from "./HistoryManager";
import { MoveNodeAction } from "./MoveNodeAction";

function namedDocument(name: string) {
    const doc = createEmptyDocument();
    doc.metadata.date = new Date("2026-09-28T00:00:00.000Z");
    doc.metadata.project_name = name;
    const node: Node = {
        id: "n", type: "core.rectangle", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 10, height: 10 },
        style: { fill: "#000000", opacity: 1 }, layout: {}
    };
    doc.nodes.set(node.id, node);
    doc.rootNodeUuids = [node.id];
    return doc;
}

test("an untrimmed stack counts the pinned original once", () => {
    const doc = namedDocument("Signal");
    const accounting = new HistoryManager(doc).retainedAccounting();
    expect(accounting.revisionCount).toBe(1);
    expect(accounting.uniqueSnapshots).toBe(1);
    expect(accounting.truncated).toBe(false);
    expect(accounting.payloadUtf8Bytes).toBeGreaterThan(0);
    // ASCII JSON: the trim estimate is exactly two bytes per UTF-8 byte.
    expect(accounting.budgetEstimateBytes).toBe(accounting.serializedUtf8Bytes * 2);
    expect(accounting.stackBudgetEstimateBytes).toBe(accounting.budgetEstimateBytes);
});

test("non-ASCII snapshot text is counted in UTF-8, not as the trim estimate", () => {
    const accounting = new HistoryManager(namedDocument("é🙂")).retainedAccounting();
    expect(accounting.serializedUtf8Bytes).toBeGreaterThan(accounting.budgetEstimateBytes / 2);
});

test("coalesced edits replace one snapshot instead of retaining both", () => {
    const dispatcher = new ActionDispatcher(namedDocument("Signal"));
    expect(dispatcher.dispatchAction(new MoveNodeAction(dispatcher.getDocument(), "n", 1, 0)).success).toBe(true);
    const after = dispatcher.retainedHistoryAccounting();
    expect(dispatcher.dispatchAction(new MoveNodeAction(dispatcher.getDocument(), "n", 2, 0), { coalesce: true }).success).toBe(true);
    const coalesced = dispatcher.retainedHistoryAccounting();
    expect(coalesced.revisionCount).toBe(after.revisionCount);
    expect(coalesced.uniqueSnapshots).toBe(after.uniqueSnapshots);
    expect(coalesced.serializedUtf8Bytes).toBeGreaterThan(0);
});

test("after trim the detached original is still in the retained total", () => {
    const dispatcher = new ActionDispatcher(namedDocument("Signal"), { maxBytes: 1, minEntries: 5, maxEntries: 10_000 });
    for (let i = 0; i < 20; i++) {
        expect(dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", i, 0, 8, 8)).success).toBe(true);
    }
    const trimmed = dispatcher.retainedHistoryAccounting();
    expect(trimmed.truncated).toBe(true);
    expect(trimmed.uniqueSnapshots).toBe(trimmed.revisionCount + 1);
    expect(trimmed.budgetEstimateBytes).toBeGreaterThan(trimmed.stackBudgetEstimateBytes);
    expect(trimmed.serializedUtf8Bytes).toBeGreaterThan(0);
    expect(trimmed.payloadUtf8Bytes).toBeGreaterThan(0);
});
