/** @module RunFlow.test @description Restart, respawn, and typed transition lifecycle coverage. */

import { createEmptyDocument } from "../document/Document";
import { Node } from "../document/Node";
import { marioRules } from "./Rules";
import { respawnRun, restartRun } from "./RunFlow";

function node(id: string, x: number, y: number, entity?: Node["entity"]): Node {
    return { id, type: "core.rectangle", parent: null, children: [],
        geometry: { x, y, width: 10, height: 10 }, style: { fill: "#000", opacity: 1 }, layout: {},
        ...(entity ? { entity } : {}) };
}

describe("run flow", () => {
    test("restart clears all mutable run state", () => {
        const doc = createEmptyDocument();
        const hero = node("hero", 4, 8, { body: "dynamic", player: true });
        doc.nodes.set(hero.id, hero); doc.rootNodeUuids.push(hero.id);
        const fresh = restartRun(doc);
        expect(fresh.bodies.get("hero")).toMatchObject({ x: 4, y: 8, power: 0 });
        expect(fresh.outcome).toBe("running");
        expect(fresh.transitionTo).toBeNull();
    });

    test("respawn uses the typed anchor and retains tallies and power", () => {
        const doc = createEmptyDocument();
        const hero = node("hero", 4, 8, { body: "dynamic", player: true, respawnAt: "checkpoint" });
        const checkpoint = node("checkpoint", 100, 80);
        doc.nodes.set(hero.id, hero); doc.nodes.set(checkpoint.id, checkpoint);
        doc.rootNodeUuids.push(hero.id, checkpoint.id);
        const initial = restartRun(doc);
        const bodies = new Map(initial.bodies);
        bodies.set("hero", { ...bodies.get("hero")!, x: 500, power: 2 });
        const next = respawnRun(doc, { ...initial, bodies, tallies: new Map([["coin", 3]]), outcome: "lost" }, "hero");
        expect(next.bodies.get("hero")).toMatchObject({ x: 100, y: 70, power: 2 });
        expect(next.tallies.get("coin")).toBe(3);
        expect(next.outcome).toBe("running");
    });

    test("a typed goal requests its next project instead of ending the run", () => {
        const doc = createEmptyDocument();
        const hero = node("hero", 0, 0, { body: "dynamic" });
        const exit = node("exit", 0, 0, { goal: true, transitionTo: "level-2.vde" });
        doc.nodes.set(hero.id, hero); doc.nodes.set(exit.id, exit); doc.rootNodeUuids.push(hero.id, exit.id);
        const world = { ...restartRun(doc), events: [{ kind: "enter" as const, bodyId: "hero", nodeId: "exit", className: "exit", side: "inside" as const }] };
        expect(marioRules(doc, world, { controlled: "hero" })).toEqual([
            { kind: "transition", target: "level-2.vde" }
        ]);
    });
});
