/**
 * @module ReferenceProjects
 * @description Original geometric visual and playable fixtures, maintained in code and free of third-party artwork.
 */
import { createEmptyDocument } from "../document/Document";
import { Node } from "../document/Node";
const rectangle = (id: string, x: number, y: number, width: number, height: number, fill: string): Node => ({
    id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width, height }, style: { fill, opacity: 1 }, layout: {}
});
export function visualReference() {
    const doc = createEmptyDocument(); doc.metadata.project_name = "Fogworks visual reference"; doc.metadata.date = new Date("2026-09-05T00:00:00Z");
    doc.background = "#162337";
    for (let i = 0; i < 12; i++) {
        const node = rectangle(`tile-${i}`, (i % 4) * 32, Math.floor(i / 4) * 32, 24, 24, ["#e85955", "#58bfa8", "#eebc55"][i % 3]);
        doc.nodes.set(node.id, node); doc.rootNodeUuids.push(node.id);
    }
    return doc;
}
export function gameReference() {
    const doc = createEmptyDocument(); doc.metadata.project_name = "Fogworks reach the green gate"; doc.metadata.date = new Date("2026-09-05T00:00:00Z");
    doc.background = "#142338"; doc.screen = { width: 640, height: 360 };
    const player = rectangle("player", 40, 280, 24, 24, "#efbe50");
    player.entity = { body: "dynamic", player: true, rulePolicy: "authored" };
    const floor = rectangle("floor", 0, 320, 640, 40, "#425876"); floor.entity = { body: "static" };
    const goal = rectangle("goal", 560, 240, 40, 80, "#58bfa8");
    goal.entity = { rules: [{ event: "enter", other: "player", target: "self", action: { kind: "win" } }] };
    for (const node of [player, floor, goal]) { doc.nodes.set(node.id, node); doc.rootNodeUuids.push(node.id); }
    return doc;
}
