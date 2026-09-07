/**
 * @module CanvasExport.test
 * @description Whole-canvas export framing and allocation guards; grids and selection never become artwork.
 */
import { planCanvasExport } from "./CanvasExport";
import { createEmptyDocument } from "../core/document/Document";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { AddNodeAction } from "../core/actions/AddNodeAction";

test("frames all content independently of editor pan and removes the grid", () => {
    const dispatcher = new ActionDispatcher(createEmptyDocument());
    dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", -20, 50, 40, 30, "#ff0000"));
    const result = planCanvasExport(dispatcher.getDocument());
    expect(result.width).toBe(56); expect(result.height).toBe(46);
    expect(result.model.viewport).toEqual({ x: -28, y: 42, zoom: 1 });
    expect(result.model.grid.lines).toEqual([]); expect(result.model.overlay).toEqual([]);
    expect(result.model.content).toHaveLength(1);
});
test("empty and oversized exports are refused before allocating a canvas", () => {
    const dispatcher = new ActionDispatcher(createEmptyDocument());
    expect(() => planCanvasExport(dispatcher.getDocument())).toThrow("no visible content");
    dispatcher.dispatchAction(new AddNodeAction(dispatcher.getDocument(), "core.rectangle", 0, 0, 10000, 10000, "#000000"));
    expect(() => planCanvasExport(dispatcher.getDocument())).toThrow("limit");
});
