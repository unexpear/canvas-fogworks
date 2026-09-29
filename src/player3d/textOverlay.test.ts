/** @module textOverlay.test @description Screen-space text selection for the packaged 3D view. */
import { createEmptyDocument } from "../core/document/Document";
import type { Node } from "../core/document/Node";
import { playerTextPlan } from "./textOverlay";

function label(id: string, text: string, x: number, extra: Partial<Node> = {}): Node {
    return { id, type: "core.text", parent: null, children: [], geometry: { x, y: 8, width: 80, height: 40 },
        style: { fill: "#ffffff", opacity: 1, fontFamily: "\"Owned Face\", sans-serif", fontSize: 32 },
        layout: {}, text, ...extra };
}

test("screen-space text is planned and spatial, hidden and offscreen text is not", () => {
    const doc = createEmptyDocument();
    const shown = label("shown", "A", 8);
    const blank = label("blank", "   ", 8);
    const away = label("away", "A", 5000);
    const spatial = label("spatial", "A", 8, { spatial3d: { transform: {
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } } });
    const hidden = label("hidden", "A", 8, { hidden: true });
    const frame: Node = { id: "frame", type: "core.rectangle", parent: null, children: ["child"],
        geometry: { x: 0, y: 0, width: 100, height: 40 }, style: { fill: "#000000", opacity: 0.5 }, layout: {} };
    const child = label("child", "B", 4);
    child.parent = "frame";
    for (const node of [shown, blank, away, spatial, hidden, frame, child]) doc.nodes.set(node.id, node);
    doc.rootNodeUuids = ["shown", "blank", "away", "spatial", "hidden", "frame"];
    doc.screen = { width: 200, height: 100 };
    const plan = playerTextPlan(doc, 400, 200);
    expect(plan.map(item => item.shape.text)).toEqual(["A", "B"]);
    expect(plan[0].shape.fontFamily).toContain("Owned Face");
    expect(plan[0].shape.fontSize).toBe(32);
    expect(plan[0].world.e).toBe(8);
    expect(plan[1].paint.opacity).toBeCloseTo(0.5);
    expect(plan[1].world.e).toBe(4);
});
