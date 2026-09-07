/**
 * @module asepriteImport.test
 * @description Multiple imports preserve clocks and clips, rename collisions and undo as one transaction; incompatible timing is refused before mutation.
 */
import { createEmptyDocument } from "../document/Document";
import { deserializeDocument, serializeDocument } from "../document/Serializer";
import { asepriteImportActions, AsepritePlacement } from "./asepriteImport";
import { ActionDispatcher } from "./ActionDispatcher";
import { TransactionAction } from "./TransactionAction";
import { SetAnimationControllerAction } from "./SetAnimationControllerAction";

const placement = (fps: number): AsepritePlacement => ({ name: "actor", first: "data:image/png;base64,AA==",
    track: [{ frame: 0, hold: true, values: { src: "data:image/png;base64,AA==" } },
        { frame: 1, hold: true, values: { src: "data:image/png;base64,AQ==" } }],
    timeline: { frames: 2, fps }, clips: [{ name: "idle", from: 0, to: 1 }], x: 0, y: 0, width: 2, height: 2 });

test("two imports preserve old clips/timing, survive reload and undo together", () => {
    const dispatcher = new ActionDispatcher(createEmptyDocument());
    const first = asepriteImportActions(dispatcher.getDocument(), placement(24));
    expect(dispatcher.dispatchAction(new TransactionAction(dispatcher.getDocument(), "Import first", first.actions)).success).toBe(true);
    dispatcher.dispatchAction(new SetAnimationControllerAction(dispatcher.getDocument(), first.id,
        { initial: "idle", states: [{ name: "idle", clip: "idle" }], transitions: [] }));
    const before = serializeDocument(dispatcher.getDocument());
    const second = asepriteImportActions(dispatcher.getDocument(), placement(12));
    expect(dispatcher.dispatchAction(new TransactionAction(dispatcher.getDocument(), "Import second", second.actions)).success).toBe(true);
    const doc = deserializeDocument(serializeDocument(dispatcher.getDocument()));
    expect(doc.timeline).toEqual({ frames: 4, fps: 24 });
    expect(doc.clips).toEqual([{ name: "idle", from: 0, to: 1 }, { name: "idle (2)", from: 0, to: 3 }]);
    expect(doc.nodes.get(first.id)?.track?.map(k => k.frame)).toEqual([0, 1]);
    expect(doc.nodes.get(first.id)?.animation?.states[0].clip).toBe("idle");
    expect(doc.nodes.get(second.id)?.track?.map(k => k.frame)).toEqual([0, 2]);
    dispatcher.undo(); expect(serializeDocument(dispatcher.getDocument())).toBe(before);
});

test("an import without tags keeps all existing clips and never shortens the clock", () => {
    const doc = createEmptyDocument(); doc.timeline = { frames: 48, fps: 24 };
    doc.clips = [{ name: "walk", from: 24, to: 47 }];
    const dispatcher = new ActionDispatcher(doc);
    const result = asepriteImportActions(doc, { ...placement(24), clips: [] });
    expect(dispatcher.dispatchAction(new TransactionAction(doc, "Import", result.actions)).success).toBe(true);
    expect(dispatcher.getDocument().timeline).toEqual({ frames: 48, fps: 24 });
    expect(dispatcher.getDocument().clips).toEqual([{ name: "walk", from: 24, to: 47 }]);
});

test("unrepresentable timing is refused instead of rounding or changing existing animation", () => {
    const doc = createEmptyDocument(); doc.timeline = { frames: 48, fps: 12 };
    const before = serializeDocument(doc);
    expect(() => asepriteImportActions(doc, placement(24))).toThrow("cannot be represented exactly");
    expect(serializeDocument(doc)).toBe(before);
});
