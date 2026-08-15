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
        expect(partOf(node({ bodyType: prop("dynamic") }))).toEqual({ stompable: false, patrol: null });
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
