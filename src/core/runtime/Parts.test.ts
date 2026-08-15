import { createEmptyDocument, ProjectDocument } from "../document/Document";
import { Node, UserData } from "../document/Node";
import { worldFrom, stepWorld, applyCommands, MOVE_SPEED, FIXED_STEP } from "./World";
import { partOf, hasParts, INERT, PART_PREFIX } from "./Parts";
import { marioRules } from "./Rules";

const prop = (v: string) => ({ type: "string", value: v });
const node = (userData?: UserData) => ({ userData });

function docWith(nodes: { id: string; x: number; y: number; w?: number; h?: number;
                          userData?: UserData }[]): ProjectDocument {
    const doc = createEmptyDocument();
    for (const n of nodes) {
        doc.nodes.set(n.id, {
            id: n.id, type: "core.rectangle", parent: null, children: [],
            geometry: { x: n.x, y: n.y, width: n.w ?? 10, height: n.h ?? 10 },
            style: { fill: "#888", opacity: 1 }, layout: {},
            ...(n.userData ? { userData: n.userData } : {})
        } as Node);
        doc.rootNodeUuids.push(n.id);
    }
    return doc;
}

describe("the vocabulary a part declares about itself", () => {
    it("A NODE THAT SAYS NOTHING IS INERT — which is every node in the corpus", () => {
        // The whole safety argument: a document written before this vocabulary existed plays exactly
        // as it did, because "declares nothing" is the default and the default does nothing.
        expect(partOf(node(undefined))).toEqual(INERT);
        expect(partOf(node({ bodyType: prop("dynamic"), friction: prop("0.45") }))).toEqual(INERT);
        // …including a node carrying a CLASS, which is what slice 10 read as "actor" and no longer does.
        expect(partOf(node({ bodyType: prop("dynamic") }))).toEqual({ stompable: false, patrol: null, deadly: false, goal: false });
    });

    it("reads stompable leniently, and reads the words that mean NO as no", () => {
        const stomp = (v: string) => partOf(node({ [PART_PREFIX + "stompable"]: prop(v) })).stompable;
        expect(stomp("true")).toBe(true);
        expect(stomp("TRUE")).toBe(true);
        expect(stomp("1")).toBe(true);
        expect(stomp("yes")).toBe(true);
        expect(stomp("false")).toBe(false);
        expect(stomp("0")).toBe(false);
        expect(stomp("no")).toBe(false);
        expect(stomp("")).toBe(false);
    });

    it("an EMPTY patrol is not a speed of zero — the `Number(\"\")` trap, paid for once already", () => {
        // `Number("")` is 0 and FINITE, which is how an empty `friction` once became ice. A part that
        // failed to say anything has not asked to stand still.
        const patrol = (v: string) => partOf(node({ [PART_PREFIX + "patrol"]: prop(v) })).patrol;
        expect(patrol("")).toBeNull();
        expect(patrol("   ")).toBeNull();
        expect(patrol("banana")).toBeNull();
        expect(patrol("0")).toBe(0);          // an explicit zero IS a declaration: stand still
        expect(patrol("40")).toBe(40);
        expect(patrol("-40")).toBe(-40);      // a negative speed is a DIRECTION, not an error
    });

    it("hasParts answers for a whole document in one pass", () => {
        expect(hasParts([node(undefined), node({ bodyType: prop("static") })])).toBe(false);
        expect(hasParts([node(undefined), node({ [PART_PREFIX + "patrol"]: prop("40") })])).toBe(true);
    });
});

describe("a part that WALKS", () => {
    /** A 200-wide floor with walls at each end, and a patrolling part on it. */
    const pen = (speed: string) => docWith([
        { id: "floor", x: 0, y: 100, w: 200, h: 20, userData: { bodyType: prop("static") } },
        { id: "wallL", x: -20, y: 0, w: 20, h: 120, userData: { bodyType: prop("static") } },
        { id: "wallR", x: 200, y: 0, w: 20, h: 120, userData: { bodyType: prop("static") } },
        { id: "goomba", x: 90, y: 90, w: 10, h: 10,
          userData: { bodyType: prop("dynamic"), [PART_PREFIX + "patrol"]: prop(speed) } }
    ]);

    /** Step with the rules applied per step, exactly as the app does. */
    const run = (doc: ProjectDocument, n: number) => {
        let w = worldFrom(doc);
        const xs: number[] = [];
        for (let i = 0; i < n; i++) {
            w = stepWorld(doc, w);
            w = applyCommands(w, marioRules(doc, w, { controlled: null }));
            xs.push(w.bodies.get("goomba")!.x);
        }
        return { world: w, xs };
    };

    it("MOVES ON ITS OWN, at the declared speed, with nothing driving it", () => {
        // `controlled` is null: nothing is being driven, and it still walks. That is the gap this
        // closes — before it, `worldFrom` started every body at rest and nothing could ever move one.
        const { xs } = run(pen("60"), 5);
        // TWO THINGS THE DECLARED NUMBER DOES NOT SAY, both measured here rather than assumed.
        // (1) The first step produces NO movement: the rules run AFTER the step, so the velocity a
        //     part is given is spent on the step that follows.
        // (2) A part declaring 60 walks at 45. Friction is the GROUND's property and applies to
        //     every body, and a velocity re-set once per step loses exactly one step of it before
        //     the move: mu*g*dt = 1*900/60 = 15. The player escapes this only because input re-sets
        //     vx INSIDE the step. So the declared speed is the velocity the part is GIVEN, not the
        //     speed it travels; on ice (friction 0) they would be the same number.
        expect(xs.slice(0, 5)).toEqual([90, 90.75, 91.5, 92.25, 93]);
        expect(60 - 1 * 900 * FIXED_STEP).toBe(45);
        expect(45 * FIXED_STEP).toBe(0.75);
    });

    it("TURNS AROUND at a wall, and keeps its speed", () => {
        // Right edge is 200; a 10-wide body starting at 90 has 100px to cover at 1px a step.
        const { world, xs } = run(pen("60"), 140);
        expect(Math.max(...xs)).toBe(190);          // it reaches the wall and no further
        expect(world.bodies.get("goomba")!.vx).toBe(-60);   // …and is now walking the other way
        expect(xs[xs.length - 1]).toBeLessThan(190);
    });

    it("a NEGATIVE declared speed starts it walking LEFT", () => {
        const { xs } = run(pen("-60"), 3);
        expect(xs).toEqual([90, 89.25, 88.5]);
    });

    it("a part declaring ZERO stands still, and is not confused with one declaring nothing", () => {
        expect(run(pen("0"), 30).xs.every(x => x === 90)).toBe(true);
        const silent = docWith([
            { id: "floor", x: 0, y: 100, w: 200, h: 20, userData: { bodyType: prop("static") } },
            { id: "goomba", x: 90, y: 90, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = worldFrom(silent);
        w = stepWorld(silent, w);
        // No command is issued at all for a part that declares nothing.
        expect(marioRules(silent, w, { controlled: null })).toEqual([]);
    });

    it("is SLOWER than the player, which is what makes it catchable", () => {
        // Not a rule, a sanity check on the numbers a level author will pick: the walk this level
        // uses is well under MOVE_SPEED, so a player can always outrun and reach it.
        expect(60).toBeLessThan(MOVE_SPEED);
        // …and the speed it ACTUALLY travels, after the friction above, is lower still.
        expect(45).toBeLessThan(MOVE_SPEED);
    });
});

describe("the run lifecycle — a run that can be lost, won and ended", () => {
    const LEVEL = { x: 0, y: 0, width: 400, height: 120 };
    const world = (doc: ProjectDocument, n: number, controlled: string | null = "hero") => {
        let w = worldFrom(doc);
        for (let i = 0; i < n; i++) {
            if (w.outcome !== "running") break;
            w = stepWorld(doc, w, { controlled });
            w = applyCommands(w, marioRules(doc, w, { controlled, bounds: LEVEL }));
        }
        return w;
    };

    it("STARTS running, which is what every earlier slice assumed and none could say", () => {
        expect(worldFrom(docWith([])).outcome).toBe("running");
    });

    it("FALLING OUT OF THE WORLD loses the run", () => {
        // No floor at all: the hero falls past the level's bottom (120) plus its own height.
        const doc = docWith([{ id: "hero", x: 50, y: 0, userData: { bodyType: prop("dynamic") } }]);
        expect(world(doc, 600).outcome).toBe("lost");
    });

    it("…but standing on the lowest floor does NOT, which is the slack the rule allows for", () => {
        const doc = docWith([
            { id: "floor", x: 0, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "hero", x: 50, y: 80, userData: { bodyType: prop("dynamic") } }
        ]);
        const w = world(doc, 600);
        expect(w.outcome).toBe("running");
        expect(w.bodies.get("hero")!.y).toBe(90);
    });

    it("with NO bounds it cannot fall out, which is exactly what the runtime did before", () => {
        const doc = docWith([{ id: "hero", x: 50, y: 0, userData: { bodyType: prop("dynamic") } }]);
        let w = worldFrom(doc);
        for (let i = 0; i < 600; i++) {
            w = stepWorld(doc, w, { controlled: "hero" });
            w = applyCommands(w, marioRules(doc, w, { controlled: "hero", bounds: null }));
        }
        expect(w.outcome).toBe("running");
        expect(w.bodies.get("hero")!.y).toBeGreaterThan(4000);   // the measured runaway, preserved
    });

    it("TOUCHING A DEADLY PART from the side loses the run", () => {
        const doc = docWith([
            { id: "floor", x: 0, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "spike", x: 120, y: 90, userData: { bodyType: prop("dynamic"),
                [PART_PREFIX + "deadly"]: prop("true") } },
            { id: "hero", x: 50, y: 90, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = worldFrom(doc);
        for (let i = 0; i < 200 && w.outcome === "running"; i++) {
            w = stepWorld(doc, w, { input: { left: false, right: true, jump: false }, controlled: "hero" });
            w = applyCommands(w, marioRules(doc, w, { controlled: "hero", bounds: LEVEL }));
        }
        expect(w.outcome).toBe("lost");
    });

    it("STOMPING a part that is deadly AND stompable wins the exchange — a Goomba, exactly", () => {
        // The ordering rule: the stomp is read first, and a part it despawned cannot then kill.
        const doc = docWith([
            { id: "floor", x: 0, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "goomba", x: 50, y: 92, w: 10, h: 8, userData: { bodyType: prop("dynamic"),
                [PART_PREFIX + "deadly"]: prop("true"), [PART_PREFIX + "stompable"]: prop("true") } },
            { id: "hero", x: 51, y: 20, w: 8, h: 10, userData: { bodyType: prop("dynamic") } }
        ]);
        const w = world(doc, 200);
        expect(w.outcome).toBe("running");            // it lived
        expect([...w.despawned]).toEqual(["goomba"]); // …and the goomba did not
    });

    it("REACHING A GOAL wins, whether it is a body or a region", () => {
        const asRegion = docWith([
            { id: "floor", x: 0, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "flag", x: 120, y: 60, w: 10, h: 40, userData: { [PART_PREFIX + "goal"]: prop("true") } },
            { id: "hero", x: 50, y: 90, userData: { bodyType: prop("dynamic") } }
        ]);
        // A goal with no bodyType is a REGION, so it is entered rather than contacted.
        asRegion.nodes.set("flag", { ...(asRegion.nodes.get("flag")!), className: "exit" } as Node);
        let w = worldFrom(asRegion);
        for (let i = 0; i < 200 && w.outcome === "running"; i++) {
            w = stepWorld(asRegion, w, { input: { left: false, right: true, jump: false }, controlled: "hero" });
            w = applyCommands(w, marioRules(asRegion, w, { controlled: "hero", bounds: LEVEL }));
        }
        expect(w.outcome).toBe("won");
    });

    it("A FINISHED RUN DECIDES NOTHING FURTHER", () => {
        const doc = docWith([
            { id: "floor", x: 0, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "walker", x: 50, y: 90, userData: { bodyType: prop("dynamic"),
                [PART_PREFIX + "patrol"]: prop("60") } },
            { id: "hero", x: 200, y: 90, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = applyCommands(worldFrom(doc), [{ kind: "endRun", outcome: "lost" }]);
        w = stepWorld(doc, w, { controlled: "hero" });
        // Not even the patrol, which otherwise runs on every step regardless of events.
        expect(marioRules(doc, w, { controlled: "hero", bounds: LEVEL })).toEqual([]);
    });

    it("an ending is MONOTONIC — nothing un-ends a run, and the first one wins", () => {
        const w0 = worldFrom(docWith([]));
        const lost = applyCommands(w0, [{ kind: "endRun", outcome: "lost" }]);
        expect(lost.outcome).toBe("lost");
        expect(applyCommands(lost, [{ kind: "endRun", outcome: "won" }]).outcome).toBe("lost");
        // …and within one batch, the first wins too.
        expect(applyCommands(w0, [{ kind: "endRun", outcome: "won" },
                                  { kind: "endRun", outcome: "lost" }]).outcome).toBe("won");
    });
});

describe("the two lifecycle fixtures that were BLIND, and what they could not see", () => {
    const LEVEL = { x: 0, y: 0, width: 400, height: 120 };

    it("LANDING ON A DEADLY PART THAT IS NOT STOMPABLE does not kill you", () => {
        // THE FIXTURE THE GOOMBA TEST COULD NOT BE. That one declared deadly AND stompable, so the
        // stomp despawned the part and either half of the guard suppressed the death on its own —
        // the mutant deleting the side check survived, masked by the other clause. Here the part is
        // deadly ONLY: nothing despawns it, so the side test is the only thing standing between the
        // player and a death it did not earn.
        const doc = docWith([
            { id: "floor", x: 0, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "spikeTop", x: 50, y: 92, w: 10, h: 8, userData: { bodyType: prop("dynamic"),
                [PART_PREFIX + "deadly"]: prop("true") } },
            { id: "hero", x: 51, y: 20, w: 8, h: 10, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = worldFrom(doc);
        let landed = false;
        for (let i = 0; i < 200 && w.outcome === "running"; i++) {
            w = stepWorld(doc, w, { controlled: "hero" });
            if (w.events.some(e => e.kind === "contact" && e.bodyId === "hero" && e.side === "below")) {
                landed = true;
            }
            w = applyCommands(w, marioRules(doc, w, { controlled: "hero", bounds: LEVEL }));
        }
        expect(landed).toBe(true);            // the contact really happened, or this proves nothing
        expect(w.outcome).toBe("running");    // …and it did not end the run
        expect(w.despawned.size).toBe(0);     // …and nothing was stomped, since it is not stompable
    });

    it("THE FALL IS DETECTED AT THE SLACK LINE, not one body-height early", () => {
        // Asserting only "it is lost" cannot see the sign of the slack: both the rule and its
        // inversion lose the run, a couple of steps apart. The STEP is what distinguishes them.
        // Free fall from 0 is y(n) = 0.125*n*(n+1). The level's bottom is 120 and the body is 10
        // high, so the line is 130: n(n+1) > 1040 first holds at n=32, where y=132.
        const doc = docWith([{ id: "hero", x: 50, y: 0, userData: { bodyType: prop("dynamic") } }]);
        let w = worldFrom(doc);
        let steps = 0;
        for (let i = 0; i < 200 && w.outcome === "running"; i++) {
            w = stepWorld(doc, w, { controlled: "hero" });
            w = applyCommands(w, marioRules(doc, w, { controlled: "hero", bounds: LEVEL }));
            steps++;
        }
        expect(w.outcome).toBe("lost");
        expect(steps).toBe(32);
        expect(0.125 * 32 * 33).toBe(132);
        // Subtracting the slack instead of adding it would fire at 110, which is step 30.
        expect(0.125 * 30 * 31).toBe(116.25);
    });
});
