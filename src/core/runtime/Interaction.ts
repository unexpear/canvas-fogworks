/** @module Interaction @description Stable nearest-target selection shared by 2D and 3D; hidden/despawned targets are supplied as absent positions. */
import type { ReadonlyDocument } from "../document/Document";
import { dropHidden } from "../document/Components";
import { behaviorEvents } from "../document/BehaviorGraph";
import { resolveBehavior } from "../document/BehaviorAssets";
export interface Position { x: number; y: number; z: number }
export function interactionTarget(doc: ReadonlyDocument, controlled: string, position: (id: string) => Position | undefined, defaultRange: number): string | null {
    doc = dropHidden(doc);
    if (!doc.nodes.has(controlled)) return null;
    const origin = position(controlled); if (!origin) return null;
    let nearest: string | null = null, distance = Infinity;
    for (const node of doc.nodes.values()) {
        if (node.id === controlled || node.hidden) continue;
        const rules = [...(node.entity?.rules ?? []),...behaviorEvents(resolveBehavior(doc, node.entity))].filter(rule => rule.event === "interact");
        const point = position(node.id); if (!point || !rules.length) continue;
        const d = Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z);
        if (!rules.some(rule => d <= (rule.range ?? defaultRange))) continue;
        if (d < distance || (d === distance && (nearest === null || node.id < nearest))) { nearest = node.id; distance = d; }
    }
    return nearest;
}
