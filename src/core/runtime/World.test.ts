/**
 * @module World.test
 * @description The runtime's first slice — every number here is hand-computed from the constants.
 *
 * WHY HAND-COMPUTED: the alternative is asserting whatever the implementation printed, which agrees
 * with a wrong implementation by construction. Gravity is 900 px/s² and a step is 1/60s, so one step
 * adds exactly 15 px/s of downward speed and moves a resting body 0.25 px. Those two numbers are the
 * whole of the arithmetic and every expectation below is built from them.
 */
import { createEmptyDocument, ProjectDocument } from "../document/Document";
import { Node, UserData } from "../document/Node";
import {
    FIXED_STEP, MAX_STEPS_PER_FRAME, DEFAULT_GRAVITY, MAX_FALL_SPEED, MOVE_SPEED, JUMP_HEIGHT,
    NO_INPUT, Input, WorldState, jumpSpeedFor, jumpLaunchSpeed, HELD_JUMP_GRAVITY,
    SKID_TURN, walkAccel, skidAccel, walkRunup, skidDistance,
    bodyTypeOf, worldFrom, solidsOf, stepWorld, applyWorld, movedIds, stepsFor, propertyOf,
    tileIsSolid, tileSolidsNear, documentHasSolidTiles, frictionOf, regionsOf,
    worldOffsetOf, runtimeRefusal, runtimeExclusions, applyWorld as applyWorldFn,
    sideOf, ContactSide, oppositeSide
} from "./World";
import { RUN_SPEED, RUN_ACCEL, RUN_JUMP_BOOST } from "./World";

const prop = (v: string, type = "string") => ({ type, value: v });

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

/** Run `n` steps, which is what a caller's accumulator does. */
function steps(doc: ProjectDocument, world: WorldState, n: number): WorldState {
    let w = world;
    for (let i = 0; i < n; i++) w = stepWorld(doc, w);
    return w;
}

/**
 * The same world with `id` ALREADY MOVING at walking speed.
 *
 * For fixtures that are about COLLISION — seams, walls, one-way slabs, contact sides — and merely
 * need a body crossing the level to test it. How a body gets up to speed is the INPUT model's
 * business, and a collision fixture that starts from a standstill silently measures both.
 */
const atWalk = (w: WorldState, id: string, vx = MOVE_SPEED): WorldState =>
    ({ ...w, bodies: new Map(w.bodies).set(id, { ...w.bodies.get(id)!, vx }) });

describe("the RUN tier (M18 slice 38) — chosen by the button, in the era's own ratios", () => {
    const prop2 = (v: string) => ({ type: "string", value: v });
    const track = () => {
        const doc = createEmptyDocument();
        doc.nodes.set("floor", { id: "floor", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 400, width: 100000, height: 20 },
            style: { fill: "#888", opacity: 1 }, layout: {},
            userData: { bodyType: prop2("static") } } as unknown as Node);
        doc.nodes.set("hero", { id: "hero", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 384, width: 12, height: 16 },
            style: { fill: "#888", opacity: 1 }, layout: {},
            userData: { bodyType: prop2("dynamic") } } as unknown as Node);
        doc.rootNodeUuids.push("floor", "hero");
        return doc;
    };
    const held = (run: boolean, jump = false) => ({ left: false, right: true, jump, run });

    it("caps at 5/3 of the walk with run held, and at the walk without — the $18/$28 ratio", () => {
        expect(RUN_SPEED).toBeCloseTo(MOVE_SPEED * 5 / 3, 9);
        const doc = track();
        let walk = worldFrom(doc), run = worldFrom(doc);
        for (let i = 0; i < 120; i++) {
            walk = stepWorld(doc, walk, { controlled: "hero", input: held(false) });
            run = stepWorld(doc, run, { controlled: "hero", input: held(true) });
        }
        expect(walk.bodies.get("hero")!.vx).toBe(MOVE_SPEED);
        expect(run.bodies.get("hero")!.vx).toBe(RUN_SPEED);
    });

    it("accelerates at 3/2 the walk rate — the $98/$e4 ratio, read below both caps", () => {
        const doc = track();
        let walk = worldFrom(doc), run = worldFrom(doc);
        for (let i = 0; i < 6; i++) {
            walk = stepWorld(doc, walk, { controlled: "hero", input: held(false) });
            run = stepWorld(doc, run, { controlled: "hero", input: held(true) });
        }
        const w = walk.bodies.get("hero")!.vx, r = run.bodies.get("hero")!.vx;
        expect(w).toBeGreaterThan(0);
        expect(r / w).toBeCloseTo(RUN_ACCEL, 9);
    });

    it("releasing run EASES back to the walk cap — never a slam, never unbounded", () => {
        // The clamp only catches the step that CROSSES a cap, so before this rule a walker who had
        // ever run sat above a cap the clamp never re-checked and accelerated without bound —
        // found by asking what the clamp does the step after.
        const doc = track();
        let w = worldFrom(doc);
        for (let i = 0; i < 120; i++) w = stepWorld(doc, w, { controlled: "hero", input: held(true) });
        expect(w.bodies.get("hero")!.vx).toBe(RUN_SPEED);
        const eased: number[] = [];
        for (let i = 0; i < 15; i++) {
            w = stepWorld(doc, w, { controlled: "hero", input: held(false) });
            eased.push(w.bodies.get("hero")!.vx);
        }
        // Monotone descent, one walk-accel step at a time, landing EXACTLY on the cap and staying.
        for (let i = 1; i < eased.length; i++) expect(eased[i]).toBeLessThanOrEqual(eased[i - 1]);
        expect(eased[eased.length - 1]).toBe(MOVE_SPEED);
        expect(Math.min(...eased)).toBeGreaterThanOrEqual(MOVE_SPEED);
    });

    it("a FULL-RUN jump is 25% taller — the boost gates on the walk cap, a run-only speed", () => {
        const doc = track();
        let w = worldFrom(doc);
        for (let i = 0; i < 120; i++) w = stepWorld(doc, w, { controlled: "hero", input: held(true) });
        w = stepWorld(doc, w, { controlled: "hero", input: held(true, true) });
        expect(w.bodies.get("hero")!.vy)
            .toBeCloseTo(-jumpLaunchSpeed(undefined, JUMP_HEIGHT * RUN_JUMP_BOOST), 6);
        // …and at walking speed the launch is exactly what it always was.
        let w2 = worldFrom(doc);
        for (let i = 0; i < 120; i++) w2 = stepWorld(doc, w2, { controlled: "hero", input: held(false) });
        w2 = stepWorld(doc, w2, { controlled: "hero", input: held(false, true) });
        expect(w2.bodies.get("hero")!.vy).toBeCloseTo(-jumpLaunchSpeed(), 6);
    });
});

describe("what counts as a body", () => {
    it("reads bodyType from userData — the field the art already uses", () => {
        // MEASURED: `bodyType` is the most-declared property in the corpus (51 of 138), and the
        // level's real collision geometry carries nothing else at all.
        expect(bodyTypeOf({ userData: { bodyType: prop("static") } })).toBe("static");
        expect(bodyTypeOf({ userData: { bodyType: prop("dynamic") } })).toBe("dynamic");
        // 216 of the corpus's 248 objects say nothing — they must cost nothing and be no body.
        expect(bodyTypeOf({})).toBeNull();
        expect(bodyTypeOf({ userData: { friction: prop("1.00") } })).toBeNull();
        // A VALUE THAT IS NOT A BODY TYPE is not a body either, rather than a third kind.
        expect(bodyTypeOf({ userData: { bodyType: prop("kinematic") } })).toBeNull();
    });

    it("reads the value however the file declared it — the corpus disagrees with itself", () => {
        // The same NAME is declared with two types inside one map: friction is `type="float"` 17
        // times and untyped 28 times. A reader keyed on the declared type drops most of the data.
        expect(propertyOf({ friction: prop("0.45", "float") }, "friction")).toBe("0.45");
        expect(propertyOf({ friction: prop("0.45") }, "friction")).toBe("0.45");
        expect(propertyOf(undefined, "friction")).toBeNull();
        // …and casing and stray space are the author's, not the runtime's business.
        expect(bodyTypeOf({ userData: { bodyType: prop(" Static ") } })).toBe("static");
    });

    it("puts only DYNAMIC bodies in the world, and only STATIC ones in the solids", () => {
        const doc = docWith([
            { id: "crate", x: 10, y: 20, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: 0, y: 100, w: 200, h: 10, userData: { bodyType: prop("static") } },
            { id: "decor", x: 5, y: 5 }
        ]);
        const world = worldFrom(doc);
        expect([...world.bodies.keys()]).toEqual(["crate"]);
        // AT REST, WHERE THE DOCUMENT PUTS IT — the world does not invent a position.
        expect(world.bodies.get("crate"))
            .toEqual({ x: 10, y: 20, vx: 0, vy: 0, onGround: false, groundFriction: 1, blockedX: false, facing: 1,
                       travelled: 0, power: 0, star: 0 });
        expect(world.time).toBe(0);
        // A STATIC BODY IS NOT IN THE WORLD, because its position is the document's to state and
        // two copies of one fact can disagree the moment somebody edits the level.
        expect(solidsOf(doc)).toEqual([{ x: 0, y: 100, width: 200, height: 10, friction: 1, oneWay: false }]);
    });

    it("ignores a zero-area solid, which an author passes through while dragging one out", () => {
        const doc = docWith([{ id: "flat", x: 0, y: 0, w: 100, h: 0,
            userData: { bodyType: prop("static") } }]);
        expect(solidsOf(doc)).toEqual([]);
    });
});

describe("one step of gravity", () => {
    it("adds exactly g*dt to the speed and moves by the NEW speed", () => {
        // 900 * 1/60 = 15 px/s after one step; the position moves by 15 * 1/60 = 0.25 px.
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        const one = stepWorld(doc, worldFrom(doc));
        expect(one.bodies.get("b")!.vy).toBeCloseTo(15, 10);
        expect(one.bodies.get("b")!.y).toBeCloseTo(0.25, 10);
        expect(one.time).toBeCloseTo(FIXED_STEP, 10);
        // …and a second step: 30 px/s, and 0.25 + 0.5 = 0.75 px down.
        const two = stepWorld(doc, one);
        expect(two.bodies.get("b")!.vy).toBeCloseTo(30, 10);
        expect(two.bodies.get("b")!.y).toBeCloseTo(0.75, 10);
    });

    it("is FRAME-RATE INDEPENDENT, which is the whole reason the step is fixed", () => {
        // Sixty steps is one second whoever asked for them. A variable delta would make this
        // depend on how the caller chopped the second up — the classic way a game plays
        // differently on a fast machine.
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        const after = steps(doc, worldFrom(doc), 60);
        expect(after.bodies.get("b")!.vy).toBeCloseTo(DEFAULT_GRAVITY, 6);
        expect(after.time).toBeCloseTo(1, 10);
        // Sum of 0.25*k for k=1..60 = 0.25 * 60*61/2 = 457.5 — the discrete integral, not 450.
        // Stating the DISCRETE answer is the point: 450 would be the continuous one, and a test
        // asserting it would be quietly wrong about what a fixed step does.
        expect(after.bodies.get("b")!.y).toBeCloseTo(457.5, 6);
    });

    it("takes the gravity it is given, so a test is not hostage to the default", () => {
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        expect(stepWorld(doc, worldFrom(doc), { gravity: 0 }).bodies.get("b")!.vy).toBe(0);
        expect(stepWorld(doc, worldFrom(doc), { gravity: 600 }).bodies.get("b")!.vy).toBeCloseTo(10, 10);
    });
});

describe("landing on something solid", () => {
    /** A 10x10 body 100 above a floor at y=100. */
    const level = () => docWith([
        { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
        { id: "floor", x: -100, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } }
    ]);

    it("stops ON the floor rather than in it, and says it is on the ground", () => {
        const doc = level();
        const after = steps(doc, worldFrom(doc), 120);       // two seconds: long past landing
        const b = after.bodies.get("b")!;
        // THE BODY'S BOTTOM IS THE FLOOR'S TOP: y = 100 - 10. Not 100, which would bury it by its
        // own height, and not 90.25, which would be "stopped near the floor".
        expect(b.y).toBe(90);
        expect(b.vy).toBe(0);
        expect(b.onGround).toBe(true);
    });

    it("does not fall THROUGH the floor at speed", () => {
        // A DEEP-ENOUGH floor, which is the case that must work: by impact the body is doing about
        // 1200 px/s — 20 px per step — and the floor is 20 px thick, so the overlap is caught. The
        // test below pins what happens when a floor is THINNER than that.
        const doc = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -100, y: 800, w: 400, h: 20, userData: { bodyType: prop("static") } }
        ]);
        const after = steps(doc, worldFrom(doc), 300);
        expect(after.bodies.get("b")!.y).toBe(790);
        expect(after.bodies.get("b")!.onGround).toBe(true);
    });

    it("TUNNELS through a solid thinner than one step's travel — a known, measured limit", () => {
        // Collision here is discrete: move, then resolve. Nothing sweeps the path, so a solid
        // thinner than the distance covered in one step is never overlapped and never seen. This
        // test exists so the limit is a KNOWN SHAPE rather than something found in a level later.
        const doc = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "hairline", x: -100, y: 800, w: 400, h: 2, userData: { bodyType: prop("static") } }
        ]);
        const after = steps(doc, worldFrom(doc), 300);
        expect(after.bodies.get("b")!.y).toBeGreaterThan(800);      // straight through it
        expect(after.bodies.get("b")!.onGround).toBe(false);

        // AND THE RULE THAT MAKES A LEVEL SAFE, asserted rather than described: the same fall onto
        // a solid DEEPER than the per-step travel lands. At impact the body is doing about
        // sqrt(2*900*800) = 1200 px/s, which is 20px per step — so 24px is enough and 2px is not.
        const thick = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -100, y: 800, w: 400, h: 24, userData: { bodyType: prop("static") } }
        ]);
        const landed = steps(thick, worldFrom(thick), 300);
        expect(landed.bodies.get("b")!.y).toBe(790);
        expect(landed.bodies.get("b")!.onGround).toBe(true);
        // Every solid in the measured corpus is thicker than this — the `bounds` rectangles are
        // 32px and up — so real levels are inside the rule and a hairline drawn by hand is not.
    });

    it("a body that is NOT resting says so, which is what a jump would ask", () => {
        const doc = level();
        const one = stepWorld(doc, worldFrom(doc));
        expect(one.bodies.get("b")!.onGround).toBe(false);
    });

    it("resolves the two axes separately, so a body slides along a seam", () => {
        // TWO FLOOR TILES SIDE BY SIDE with a shared edge at x=100 — the ordinary way a level is
        // built. A body moving right along them must not catch on the seam. Resolving both axes at
        // once cannot tell which one caused an overlap, and snags here.
        const doc = docWith([
            { id: "b", x: 90, y: 90, userData: { bodyType: prop("dynamic") } },
            { id: "t1", x: 0, y: 100, w: 100, h: 20, userData: { bodyType: prop("static") } },
            { id: "t2", x: 100, y: 100, w: 100, h: 20, userData: { bodyType: prop("static") } }
        ]);
        // DRIVEN, not shoved: a one-off `vx` is now decelerated by the ground's friction, and the
        // subject of this test is the SEAM rather than the speed. Holding right is also what a
        // player does, so the fixture and the real thing agree.
        let w = steps(doc, worldFrom(doc), 5);
        // TWENTY STEPS, not sixty: at 220 px/s a second would carry it off the end of a 200-wide
        // floor and the test would be measuring a fall.
        w = atWalk(w, "b");
        for (let i = 0; i < 20; i++) {
            w = stepWorld(doc, w, { input: { left: false, right: true, jump: false }, controlled: "b" });
        }
        const b = w.bodies.get("b")!;
        expect(b.onGround).toBe(true);
        expect(b.y).toBe(90);
        // 73px, straight across the seam at x=100 without catching on it.
        expect(b.x).toBeCloseTo(90 + 20 * MOVE_SPEED * FIXED_STEP, 6);
        expect(b.vx).toBe(MOVE_SPEED);
    });

    it("stops against a WALL and keeps its footing", () => {
        const doc = docWith([
            { id: "b", x: 0, y: 90, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -100, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "wall", x: 50, y: 0, w: 20, h: 120, userData: { bodyType: prop("static") } }
        ]);
        let w = worldFrom(doc);
        w = { ...w, bodies: new Map(w.bodies).set("b", { ...w.bodies.get("b")!, vx: 300 }) };
        w = steps(doc, w, 60);
        const b = w.bodies.get("b")!;
        // Its right edge meets the wall's left: x = 50 - 10.
        expect(b.x).toBe(40);
        expect(b.vx).toBe(0);
        expect(b.onGround).toBe(true);
    });
});

describe("the world reaches the document without touching it", () => {
    it("returns a NEW document, leaves the stored one alone, and copies only what moved", () => {
        const doc = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "still", x: 7, y: 7 }
        ]);
        const world = steps(doc, worldFrom(doc), 4);          // 0.25+0.5+0.75+1.0 = 2.5 px down
        const shown = applyWorld(doc, world);
        expect(shown).not.toBe(doc);
        expect(shown.nodes.get("b")!.geometry.y).toBeCloseTo(2.5, 10);
        // THE STORED DOCUMENT IS UNTOUCHED — this is the whole bargain, and undo depends on it.
        expect(doc.nodes.get("b")!.geometry.y).toBe(0);
        // AND THE NODE THAT DID NOT MOVE IS THE SAME OBJECT, which is what lets the caller hand
        // `computeGeometry` a dirty set and reuse everything else — measured at 3-4.6x.
        expect(shown.nodes.get("still")).toBe(doc.nodes.get("still"));
        expect(movedIds(doc, world)).toEqual(new Set(["b"]));
    });

    it("hands BACK THE SAME DOCUMENT when nothing moved, so an idle run costs nothing", () => {
        const doc = docWith([{ id: "still", x: 7, y: 7 }]);
        const world = worldFrom(doc);
        expect(world.bodies.size).toBe(0);
        expect(applyWorld(doc, world)).toBe(doc);
        expect(movedIds(doc, world).size).toBe(0);
        // …and a body that has not yet moved is the same case, not a copy of the whole map.
        const resting = docWith([{ id: "b", x: 1, y: 2, userData: { bodyType: prop("dynamic") } }]);
        expect(applyWorld(resting, worldFrom(resting))).toBe(resting);
    });

    it("a body whose node was deleted mid-run freezes rather than taking the run down", () => {
        // The inert-reference rule this schema follows everywhere: a reference that stops resolving
        // does nothing. Deleting a node while playing must not throw.
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        const world = steps(doc, worldFrom(doc), 3);
        const gone = docWith([]);
        const after = stepWorld(gone, world);
        expect(after.bodies.get("b")).toEqual(world.bodies.get("b"));
        expect(applyWorld(gone, after)).toBe(gone);
    });
});

describe("the accumulator", () => {
    it("spends whole steps and CARRIES the remainder", () => {
        // A 59.94Hz display gives 16.68ms frames. Dropping the remainder each time makes the world
        // run measurably slow; carrying it spends a whole extra step every few seconds.
        const a = stepsFor(0, 0.01668);
        expect(a.steps).toBe(1);
        expect(a.accumulator).toBeCloseTo(0.01668 - FIXED_STEP, 10);
        const b = stepsFor(a.accumulator, 0.01668);
        expect(b.steps).toBe(1);
        expect(b.accumulator).toBeCloseTo(2 * 0.01668 - 2 * FIXED_STEP, 10);
        // A gap shorter than a step spends nothing and owes it forward.
        const c = stepsFor(0, 0.001);
        expect(c.steps).toBe(0);
        expect(c.accumulator).toBeCloseTo(0.001, 10);
    });

    it("CAPS a long gap and reports what it dropped, rather than spiralling", () => {
        // A backgrounded tab: ten seconds is 600 steps, each of which costs a derivation. Running
        // them all would hang the frame that resumes and earn an even bigger gap next time.
        const r = stepsFor(0, 10);
        expect(r.steps).toBe(MAX_STEPS_PER_FRAME);
        expect(r.dropped).toBe(600 - MAX_STEPS_PER_FRAME);
        // THE DEBT IS NOT OWED BACK. Keeping it would spend the cap again next frame, for as many
        // frames as it takes — the same spiral, in instalments.
        expect(r.accumulator).toBe(0);
    });

    it("refuses a clock that went backwards or produced nonsense", () => {
        // `Date.now()` can step backwards over an NTP correction, and a first frame can arrive with
        // no previous timestamp at all. Neither may run the world in reverse.
        expect(stepsFor(0.005, -1)).toEqual({ steps: 0, accumulator: 0.005, dropped: 0 });
        expect(stepsFor(0.005, Number.NaN)).toEqual({ steps: 0, accumulator: 0.005, dropped: 0 });
    });
});

describe("input — the controlled body, and only it", () => {
    /** Two dynamic bodies on a wide floor, so "only the controlled one" is checkable. */
    const level = () => docWith([
        { id: "hero", x: 100, y: 90, userData: { bodyType: prop("dynamic") } },
        { id: "other", x: 300, y: 90, userData: { bodyType: prop("dynamic") } },
        { id: "floor", x: -500, y: 100, w: 2000, h: 20, userData: { bodyType: prop("static") } }
    ]);
    /** Settle onto the floor first, so `onGround` is true before any input arrives. */
    const grounded = (doc: ProjectDocument) => steps(doc, worldFrom(doc), 5);
    const drive = (doc: ProjectDocument, w: WorldState, input: Input, n: number) => {
        let out = w;
        for (let i = 0; i < n; i++) out = stepWorld(doc, out, { input, controlled: "hero" });
        return out;
    };

    it("BUILDS UP to its top speed over a stated RUN-UP, and stops the moment it is not held", () => {
        const doc = level();
        const w = grounded(doc);
        expect(w.bodies.get("hero")!.onGround).toBe(true);
        // THE RUN-UP IS THE CONSTANT AND THE RATE IS DERIVED: `a = v^2 / 2d`. Held long enough the
        // body arrives at exactly MOVE_SPEED and stays there — the cap is a cap, not a target it
        // oscillates around.
        expect(walkAccel()).toBe(DEFAULT_GRAVITY);                 // ONE gravity, no new number
        expect(walkRunup()).toBeCloseTo(MOVE_SPEED * MOVE_SPEED / (2 * walkAccel()), 10);
        const walked = drive(doc, w, { left: false, right: true, jump: false }, 240);
        expect(walked.bodies.get("hero")!.vx).toBe(MOVE_SPEED);
        // AND IT COVERS THE RUN-UP GETTING THERE, which is the number a level is drawn against: the
        // distance to top speed is `walkRunup()`, within the step the discrete integrator overshoots by.
        const reached = (() => {
            let out = grounded(doc);
            const x0 = out.bodies.get("hero")!.x;
            for (let i = 0; i < 600; i++) {
                out = stepWorld(doc, out, { input: { left: false, right: true, jump: false }, controlled: "hero" });
                if (out.bodies.get("hero")!.vx === MOVE_SPEED) return out.bodies.get("hero")!.x - x0;
            }
            return -1;
        })();
        // BOUNDED BY THE INTEGRATOR, not by a tolerance I liked the look of. `walkRunup()` is the
        // continuous answer and a discrete sum overshoots it: the step that reaches the cap is
        // travelled at the NEW speed, and the final one is clamped rather than exact. Two steps at
        // top speed is the honest ceiling.
        expect(reached).toBeGreaterThan(walkRunup());
        expect(reached).toBeLessThan(walkRunup() + 2 * MOVE_SPEED * FIXED_STEP);
        // …and a SINGLE step is emphatically not the top speed, which is the whole difference from
        // the set speed this replaced.
        expect(drive(doc, w, { left: false, right: true, jump: false }, 1).bodies.get("hero")!.vx)
            .toBeCloseTo(walkAccel() * FIXED_STEP, 10);
        // RELEASED, THE GROUND TAKES OVER. It does not snap to zero — that was the behaviour before
        // friction existed, and it made an icy surface meaningless for the body a player drives.
        // One step on grip (mu=1, so 900 px/s^2) sheds exactly 15 px/s.
        expect(drive(doc, walked, NO_INPUT, 1).bodies.get("hero")!.vx).toBeCloseTo(MOVE_SPEED - 15, 6);
        // …and it does stop, in the distance Coulomb says rather than instantly.
        expect(drive(doc, walked, NO_INPUT, 60).bodies.get("hero")!.vx).toBe(0);
        // …and left MIRRORS right, which is what makes these speeds rather than offsets — asserted
        // as a mirror rather than as a number, so it stays true whatever the run-up is set to.
        const goneRight = drive(doc, w, { left: false, right: true, jump: false }, 40).bodies.get("hero")!;
        const goneLeft = drive(doc, w, { left: true, right: false, jump: false }, 40).bodies.get("hero")!;
        expect(goneLeft.x - 100).toBeCloseTo(-(goneRight.x - 100), 10);
        expect(goneLeft.vx).toBeCloseTo(-goneRight.vx, 10);
        // BOTH AT ONCE cancels, rather than one winning by an accident of evaluation order.
        expect(drive(doc, w, { left: true, right: true, jump: false }, 10).bodies.get("hero")!.vx).toBe(0);
    });

    it("SKIDS: turning round costs its own distance, and a much shorter one than starting", () => {
        const doc = level();
        // At top speed going right, ask for left. The body must carry FORWARD while it turns — that
        // carry is the skid, and its length is the constant.
        const running = atWalk(grounded(doc), "hero");
        const x0 = running.bodies.get("hero")!.x;
        let w = running, furthest = x0, turnedAt = -1;
        for (let i = 0; i < 240; i++) {
            w = stepWorld(doc, w, { input: { left: true, right: false, jump: false }, controlled: "hero" });
            const b = w.bodies.get("hero")!;
            furthest = Math.max(furthest, b.x);
            if (turnedAt < 0 && b.vx < 0) turnedAt = i;
        }
        expect(turnedAt).toBeGreaterThan(0);
        // BOUNDED THE OTHER WAY ROUND FROM THE RUN-UP, and the asymmetry is the integrator rather
        // than a fudge: a discrete sum travels each step at the NEW velocity, so accelerating
        // OVERSHOOTS the continuous distance and decelerating UNDERSHOOTS it. One step at top speed
        // is the gap either way — measured 11.67 against a continuous 13.44.
        expect(furthest - x0).toBeGreaterThan(skidDistance() - MOVE_SPEED * FIXED_STEP);
        expect(furthest - x0).toBeLessThan(skidDistance());
        // AND IT IS EXACTLY HALF THE RUN-UP, because the turn is exactly twice the push — a bit
        // shift in the original, so the ratio is 2 rather than about 2.
        expect(skidAccel()).toBe(walkAccel() * SKID_TURN);
        expect(skidDistance()).toBeCloseTo(walkRunup() / SKID_TURN, 10);
        // AND IT IS THE SHORTER RATE OF THE TWO, which is the whole reason skid is a separate
        // number: turning at the walking rate would carry the player a full run-up past the ledge.
        expect(skidAccel()).toBeGreaterThan(walkAccel());
        expect(furthest - x0).toBeLessThan(walkRunup());
        // …and it does come out the other side at full speed, so a skid is a TURN and not a brake.
        expect(w.bodies.get("hero")!.vx).toBe(-MOVE_SPEED);

        // A STANDING START IS NOT A SKID — the rate is chosen from the sign of the motion, and a
        // body at rest has none. Without `vx !== 0` the first step off the mark would use the skid
        // rate and the walk would begin three times too fast.
        const off = drive(doc, grounded(doc), { left: false, right: true, jump: false }, 1);
        expect(off.bodies.get("hero")!.vx).toBeCloseTo(walkAccel() * FIXED_STEP, 10);
    });

    it("skids in the AIR at the SAME rate, which is a stated DIVERGENCE from the original", () => {
        const doc = level();
        // Jump at full speed, then ask for the other way mid-flight. The body turns, and it turns at
        // the same rate it would on the ground.
        //
        // THE ORIGINAL DOES NOT, and the reason is worth writing down because it is not a tuning
        // choice. Its doubling fires on the frames FACING and MOVING disagree, and it only ever
        // writes facing from the D-pad while GROUNDED — so a midair turn is undoubled and weaker,
        // and once the speed crosses zero the cap has already dropped out of run physics, which is
        // why you cannot recover run speed in the air after reversing. Reproducing that needs a
        // facing that comes from the KEY and freezes in flight; `Body.facing` comes from the
        // VELOCITY and therefore can never disagree with it. Recorded rather than faked.
        let w = stepWorld(doc, atWalk(grounded(doc), "hero"),
            { input: { left: false, right: true, jump: true }, controlled: "hero" });
        expect(w.bodies.get("hero")!.onGround).toBe(false);
        const vx0 = w.bodies.get("hero")!.vx;
        w = stepWorld(doc, w, { input: { left: true, right: false, jump: true }, controlled: "hero" });
        expect(w.bodies.get("hero")!.onGround).toBe(false);
        expect(w.bodies.get("hero")!.vx).toBeCloseTo(vx0 - skidAccel() * FIXED_STEP, 10);
    });

    it("ONLY the controlled body is driven — the rest fall as they always did", () => {
        const doc = level();
        const w = drive(doc, grounded(doc), { left: false, right: true, jump: true }, 240);
        expect(w.bodies.get("hero")!.vx).toBe(MOVE_SPEED);
        // The other dynamic body took no input at all: still where it landed, still grounded.
        expect(w.bodies.get("other")!.vx).toBe(0);
        expect(w.bodies.get("other")!.x).toBe(300);
        expect(w.bodies.get("other")!.onGround).toBe(true);
    });

    /**
     * Jump, holding the key for `hold` steps, and report how high it got and where it ended.
     *
     * THE HOLD IS COUNTED FROM THE LAUNCH STEP INCLUSIVE, so `hold = 1` is the shortest press the
     * runtime can represent — one step down, released on the next — and that is the "tap" every
     * assertion below means.
     */
    const jumpHolding = (doc: ProjectDocument, hold: number, total = 240) => {
        const w = grounded(doc);
        const y0 = w.bodies.get("hero")!.y;
        const DOWN = { left: false, right: false, jump: true };
        let out = w, peak = y0, launch = 0;
        for (let i = 0; i < total; i++) {
            out = stepWorld(doc, out, { input: i < hold ? DOWN : NO_INPUT, controlled: "hero" });
            if (i === 0) launch = out.bodies.get("hero")!.vy;
            peak = Math.min(peak, out.bodies.get("hero")!.y);
        }
        return { rise: y0 - peak, launch, end: out.bodies.get("hero")!, y0 };
    };

    it("jumps to the stated HEIGHT when the key is HELD, which is the number a level is built from", () => {
        const doc = level();
        // v = sqrt(2*g*h) is still the kinematic identity, and 360 px/s is still what reaches 72px
        // under a full 900 — it is simply no longer the speed a jump starts at, because a held jump
        // does not rise under a full 900.
        expect(jumpSpeedFor(72, 900)).toBeCloseTo(360, 6);
        const held = jumpHolding(doc, 200);
        // EXACTLY the launch speed: the jump SETS vy rather than adding to it, so that step's
        // gravity is discarded. That is what makes the launch speed mean what it says — adding would
        // make the real one depend on the step size, and the peak below would drift.
        expect(held.launch).toBeCloseTo(-jumpLaunchSpeed(), 6);
        expect(jumpLaunchSpeed(900, 72)).toBe(Math.sqrt(2 * 900 * 25.92));   // 9/25 of 72 is 25.92
        expect(jumpLaunchSpeed(900, 72)).toBe(216);
        // WITHIN A STEP'S WORTH of the stated height: a discrete integrator overshoots slightly,
        // and asserting the exact continuous number would be asserting the wrong model.
        expect(held.rise).toBeGreaterThan(JUMP_HEIGHT - 6);
        expect(held.rise).toBeLessThan(JUMP_HEIGHT + 6);
        // …and it comes back down to exactly where it started, on the ground.
        expect(held.end.y).toBe(held.y0);
        expect(held.end.onGround).toBe(true);
    });

    it("a TAP is a SHORT jump — the height is the hold, which is the era's signature rule", () => {
        const doc = level();
        const tap = jumpHolding(doc, 1);
        const held = jumpHolding(doc, 200);
        // THE SHORTEST PRESS RISES `HELD_JUMP_GRAVITY` OF THE FULL HEIGHT, and that identity is the
        // reason the constant is a fraction rather than a second speed: same launch, full gravity.
        expect(tap.launch).toBeCloseTo(held.launch, 10);          // the LAUNCH is not what differs
        expect(tap.rise).toBeGreaterThan(JUMP_HEIGHT * HELD_JUMP_GRAVITY - 2);
        expect(tap.rise).toBeLessThan(JUMP_HEIGHT * HELD_JUMP_GRAVITY + 2);
        // On this project's 18px grid that is 1.44 tiles against 4 — a tap clears a block and a hold
        // clears a wall, which is the whole of what a level author is being handed, and it is the
        // shape the era's own level-design writing describes: "a little over one block" and
        // "almost exactly 4 blocks".
        expect(tap.rise / 18).toBeGreaterThan(1.4);
        expect(tap.rise / 18).toBeLessThan(1.55);
        expect(held.rise / 18).toBeGreaterThan(3.7);
        // …and BOTH land back where they started, so a short jump is a shorter arc, not a broken one.
        expect(tap.end.y).toBe(tap.y0);
        expect(held.end.y).toBe(held.y0);
    });

    it("every hold in between gives its OWN height — VARIABLE, not two settings", () => {
        const doc = level();
        // A two-height jump would pass both assertions above and be a lie about what this is. The
        // claim is that the arc answers the KEY continuously, so the whole ramp is asserted.
        // 40 IS THE LAST HOLD THAT BUYS ANYTHING — the apex is exactly there — so the ramp stops at
        // 39 and saturation is asserted separately below rather than being smuggled into the ramp.
        const rises = [1, 5, 10, 20, 30, 39].map(h => jumpHolding(doc, h).rise);
        for (let i = 1; i < rises.length; i++) expect(rises[i]).toBeGreaterThan(rises[i - 1]);
        // …and it SATURATES rather than growing without bound: past the apex the key buys nothing,
        // because there is no rise left to weaken the gravity on.
        expect(jumpHolding(doc, 60).rise).toBeCloseTo(jumpHolding(doc, 200).rise, 10);
    });

    it("holding the key does NOT slow the FALL, or a jump would be a glide", () => {
        const doc = level();
        const DOWN = { left: false, right: false, jump: true };
        // The same jump, held all the way up; the only difference is whether the key stays down
        // AFTER the apex. `was.vy < 0` is the line that makes these identical, and without it a
        // player could hover by never letting go.
        // The apex is at `v0 / (g*9/25)` = 216/324 = 2/3s = 40 steps exactly, so 55 is just past it.
        const upOnly = jumpHolding(doc, 55);
        const throughout = jumpHolding(doc, 200);
        expect(throughout.rise).toBeCloseTo(upOnly.rise, 10);
        // Landing at the same STEP is the sharp half: a weaker gravity on the way down would land
        // late even with an identical apex.
        const landStep = (hold: number) => {
            const w = grounded(doc);
            const y0 = w.bodies.get("hero")!.y;
            let out = w;
            for (let i = 0; i < 240; i++) {
                out = stepWorld(doc, out, {
                    input: i < hold ? { left: false, right: false, jump: true } : NO_INPUT,
                    controlled: "hero" });
                if (i > 5 && out.bodies.get("hero")!.onGround && out.bodies.get("hero")!.y === y0) return i;
            }
            return -1;
        };
        expect(landStep(200)).toBeGreaterThan(0);
        expect(landStep(200)).toBe(landStep(55));

        // AND THE STEP THE RISE ENDS IS THE STEP THE KEY STOPS MATTERING — asserted on its own,
        // because everything above is blind to it. A SURVIVING MUTANT SAID SO: dropping `was.vy < 0`
        // and leaning on the latch alone reads almost the same, since the latch also closes at the
        // apex — but it closes ONE STEP LATER, because it is computed from the velocity entering the
        // PREVIOUS step. That leaves a single step where a descending body would still get the weak
        // gravity, and one step is invisible to any apex or landing-step comparison where both arms
        // hold the key across the apex.
        //
        // 216 / 5.4 is 40 steps to the top, so step 40 is where vy reaches zero and step 41 is the
        // first of the fall: 15 px/s, which is a FULL 900 for a sixtieth of a second, with the key
        // still down the whole time. Under the mutant it is 5.4.
        let held = grounded(doc);
        const vys: number[] = [];
        for (let i = 0; i <= 41; i++) {
            held = stepWorld(doc, held, { input: DOWN, controlled: "hero" });
            vys.push(held.bodies.get("hero")!.vy);
        }
        expect(vys[0]).toBe(-jumpLaunchSpeed());                  // -216
        expect(vys[39]).toBeCloseTo(-DEFAULT_GRAVITY * HELD_JUMP_GRAVITY * FIXED_STEP, 10);   // -5.4
        expect(vys[40]).toBeCloseTo(0, 10);                       // the apex, exactly on a step
        expect(vys[41]).toBeCloseTo(DEFAULT_GRAVITY * FIXED_STEP, 10);                        // 15
        expect(vys[41]).not.toBeCloseTo(DEFAULT_GRAVITY * HELD_JUMP_GRAVITY * FIXED_STEP, 10);
    });

    it("LATCHES: letting go commits the arc, so fluttering the key is not a higher jump", () => {
        const doc = level();
        const DOWN = { left: false, right: false, jump: true };
        // Hold for 10 steps, release for 3, then hold again for the rest of the rise. Without the
        // latch the second press buys the weak gravity back and this out-jumps the honest 10-step
        // hold; with it, the arc was decided the moment the key came up.
        const flutter = (() => {
            let out = grounded(doc);
            const y0 = out.bodies.get("hero")!.y;
            let peak = y0;
            for (let i = 0; i < 120; i++) {
                const down = i < 10 || i >= 13;
                out = stepWorld(doc, out, { input: down ? DOWN : NO_INPUT, controlled: "hero" });
                peak = Math.min(peak, out.bodies.get("hero")!.y);
            }
            return y0 - peak;
        })();
        expect(flutter).toBeCloseTo(jumpHolding(doc, 10).rise, 10);
        // …and it is strictly SHORTER than never letting go, or the assertion above would also pass
        // on a runtime where the key did nothing at all after the tenth step.
        expect(flutter).toBeLessThan(jumpHolding(doc, 200).rise);
        // THE OTHER JAW OF THE LATCH is the apex: past it the key is spent even if it was never
        // released, which is what makes an upward push DURING a jump — a stomp bounce — rise under
        // full gravity. Nothing else in this runtime can express that, so it is asserted here.
        let w = grounded(doc);
        for (let i = 0; i < 50; i++) w = stepWorld(doc, w, { input: DOWN, controlled: "hero" });
        expect(w.bodies.get("hero")!.vy).toBeGreaterThan(0);          // past the apex, still held
        expect(w.jumpCut).toBe(true);
        const bodies = new Map(w.bodies);
        bodies.set("hero", { ...bodies.get("hero")!, vy: -jumpLaunchSpeed() });
        const bounced = stepWorld(doc, { ...w, bodies }, { input: DOWN, controlled: "hero" });
        // FULL gravity on the way back up: -216 + 15, not -216 + 5.4.
        expect(bounced.bodies.get("hero")!.vy).toBeCloseTo(-jumpLaunchSpeed() + DEFAULT_GRAVITY * FIXED_STEP, 10);
    });

    it("holds only the CONTROLLED body up — the rest are not holding anything", () => {
        const doc = level();
        // Both bodies are given the SAME upward velocity and the player holds jump the whole time.
        // Without `id === controlled` the second one rises just as far, which is every enemy in the
        // level floating the moment the player jumps.
        const w = grounded(doc);
        const bodies = new Map(w.bodies);
        for (const id of ["hero", "other"]) {
            bodies.set(id, { ...bodies.get(id)!, vy: -jumpLaunchSpeed(), onGround: false });
        }
        // `jumpCut: false` because these bodies were PLACED in flight rather than launched, and the
        // five settling steps that grounded them closed the latch. Without this the hero gets full
        // gravity too, both bodies rise the same distance, and the test passes for the wrong reason.
        const launched: WorldState = { ...w, bodies, jumpCut: false };
        let out = launched;
        const peak = { hero: launched.bodies.get("hero")!.y, other: launched.bodies.get("other")!.y };
        for (let i = 0; i < 60; i++) {
            out = stepWorld(doc, out, {
                input: { left: false, right: false, jump: true }, controlled: "hero" });
            peak.hero = Math.min(peak.hero, out.bodies.get("hero")!.y);
            peak.other = Math.min(peak.other, out.bodies.get("other")!.y);
        }
        const rose = (id: "hero" | "other") => launched.bodies.get(id)!.y - peak[id];
        expect(rose("hero")).toBeGreaterThan(JUMP_HEIGHT - 6);
        expect(rose("other")).toBeLessThan(JUMP_HEIGHT * HELD_JUMP_GRAVITY + 2);
    });

    it("a HELD jump is ONE jump — the press is an edge, not a state", () => {
        const doc = level();
        const w = grounded(doc);
        const y0 = w.bodies.get("hero")!.y;
        // Hold it for two seconds. Without the edge the body re-launches on every grounded step
        // and bunny-hops for as long as the button is down.
        let held = w;
        let landings = 0, wasAir = false;
        for (let i = 0; i < 120; i++) {
            held = stepWorld(doc, held, {
                input: { left: false, right: false, jump: true }, controlled: "hero" });
            const b = held.bodies.get("hero")!;
            if (wasAir && b.onGround) landings++;
            wasAir = !b.onGround;
        }
        expect(landings).toBe(1);
        expect(held.bodies.get("hero")!.y).toBe(y0);

        // RELEASE AND PRESS AGAIN jumps a second time, or the edge would be a one-shot.
        let again = stepWorld(doc, held, { input: NO_INPUT, controlled: "hero" });
        again = stepWorld(doc, again, {
            input: { left: false, right: false, jump: true }, controlled: "hero" });
        expect(again.bodies.get("hero")!.vy).toBeCloseTo(-jumpLaunchSpeed(), 6);
    });

    it("cannot jump in mid-air, which is what `onGround` was for", () => {
        const doc = level();
        let w = grounded(doc);
        w = stepWorld(doc, w, { input: { left: false, right: false, jump: true }, controlled: "hero" });
        const rising = w.bodies.get("hero")!.vy;
        for (let i = 0; i < 10; i++) {
            w = stepWorld(doc, w, { input: NO_INPUT, controlled: "hero" });
            w = stepWorld(doc, w, {
                input: { left: false, right: false, jump: true }, controlled: "hero" });
        }
        // Still falling under gravity from the ONE jump — never re-launched mid-air.
        expect(w.bodies.get("hero")!.vy).toBeGreaterThan(rising);
        expect(w.bodies.get("hero")!.onGround).toBe(false);
    });

    it("no controlled id means nothing is driven, which is the default", () => {
        const doc = level();
        const w = stepWorld(doc, grounded(doc), { input: { left: false, right: true, jump: true } });
        expect(w.bodies.get("hero")!.vx).toBe(0);
    });
});

describe("terminal velocity, a COLLISION bound before it is a feel decision", () => {
    it("caps the fall, so one step's travel is a constant rather than a function of the drop", () => {
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        // Uncapped, ten seconds of falling is 9,000 px/s — 150 px a step, and a solid would need to
        // be 150 px thick to catch it. Capped, the travel is 20 px however long the fall.
        expect(steps(doc, worldFrom(doc), 600).bodies.get("b")!.vy).toBe(MAX_FALL_SPEED);
        expect(MAX_FALL_SPEED * FIXED_STEP).toBe(20);
    });

    it("makes a 20px solid safe at ANY speed, which the 2px one still is not", () => {
        // Slice 1's limit was "as deep as the fastest body's travel", which grew with the fall.
        // It is now a constant, and this is the pair that says so.
        const deep = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -100, y: 4000, w: 400, h: 20, userData: { bodyType: prop("static") } }
        ]);
        const landed = steps(deep, worldFrom(deep), 1200);      // twenty seconds of falling
        expect(landed.bodies.get("b")!.y).toBe(3990);
        expect(landed.bodies.get("b")!.onGround).toBe(true);
        // …and the hairline is still passed through, which is the honest half of the same rule.
        const thin = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "hair", x: -100, y: 4000, w: 400, h: 2, userData: { bodyType: prop("static") } }
        ]);
        expect(steps(thin, worldFrom(thin), 1200).bodies.get("b")!.y).toBeGreaterThan(4000);
    });

    it("does not cap the RISE, or a falling rule would clip a jump", () => {
        const doc = docWith([
            { id: "b", x: 0, y: 90, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -100, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } }
        ]);
        const w = stepWorld(doc, steps(doc, worldFrom(doc), 5),
            { input: { left: false, right: false, jump: true }, controlled: "b" });
        expect(w.bodies.get("b")!.vy).toBeCloseTo(-jumpLaunchSpeed(), 6);

        // AND THE CAP MUST BE DIRECTIONAL, which the assertion above CANNOT see: the ordinary jump
        // launches at 216 px/s and the cap is 1200, so a cap written `Math.abs(vy) > MAX` never
        // fires and survives. A mutant said so. Seeing it needs a rise FASTER than the cap, which
        // a strong gravity produces — sqrt(2 * 70000 * 72 * 2/7) is about 1697 px/s. Applied to the
        // rise, the cap would turn that launch into a fall at +1200 on the very step it happened.
        //
        // THE GRAVITY HERE WENT 20,000 -> 30,000 WITH SLICE 16, because a launch is now sized for
        // `HELD_JUMP_GRAVITY` of the height rather than all of it: at 20,000 it is 1,018 px/s, UNDER
        // the cap, and this test would have gone on passing while asserting nothing about direction
        // at all. The control below is what says so out loud, rather than leaving the reader to
        // recompute it — a fixture that cannot see the mutant is the failure this project keeps
        // finding, and a number that quietly slipped under a threshold is how it happens.
        const strong = { gravity: 30000, input: { left: false, right: false, jump: true },
            controlled: "b" };
        const hard = stepWorld(doc, steps(doc, worldFrom(doc), 5), strong);
        expect(jumpLaunchSpeed(20000)).toBeLessThan(MAX_FALL_SPEED);      // the control: 1,018 px/s
        expect(jumpLaunchSpeed(30000)).toBeGreaterThan(MAX_FALL_SPEED);   // …against 1,247
        expect(hard.bodies.get("b")!.vy).toBeCloseTo(-jumpLaunchSpeed(30000), 6);
        expect(hard.bodies.get("b")!.vy).toBeLessThan(-MAX_FALL_SPEED);
    });
});

describe("a level made of TILES, not rectangles", () => {
    const CELL = 16;
    /**
     * A 6x4 grid at (0,100) whose bottom row is solid — except column 3, which is a HOLE.
     *
     * The hole is the whole design of this fixture: a tilemap is ONE node, so a body that fell
     * through it would prove the collision reads CELLS, and a body that stood over it would prove
     * the opposite. Tile 1 is solid, tile 0 is not, and the tileset says so through
     * `TilesetTile.userData` — a field that has existed since schema 67 and had no reader.
     */
    const level = (rows: number[][], extra: { id: string; x: number; y: number }[] = []) => {
        const doc = createEmptyDocument();
        doc.tilesets = [{
            id: "ts", name: "T", src: "t.png",
            sheet: { columns: 4, tileWidth: CELL, tileHeight: CELL, spacing: 0, margin: 0 },
            tiles: [{ id: 1, userData: { bodyType: prop("static") } },
                    // A tile with a property that is NOT a body type must not become solid.
                    { id: 2, userData: { door: prop("true") } }],
            offsetX: 0, offsetY: 0
        }];
        doc.nodes.set("map", {
            id: "map", type: "core.tilemap", parent: null, children: [], name: "level",
            geometry: { x: 0, y: 100, width: rows[0].length * CELL, height: rows.length * CELL },
            style: { fill: "none", opacity: 1 }, layout: {},
            tilemap: { cols: rows[0].length, rows: rows.length, tileWidth: CELL, tileHeight: CELL,
                tilesetId: "ts", tiles: rows.flat() }
        } as unknown as Node);
        doc.rootNodeUuids.push("map");
        for (const e of extra) {
            doc.nodes.set(e.id, {
                id: e.id, type: "core.rectangle", parent: null, children: [],
                geometry: { x: e.x, y: e.y, width: 10, height: 10 },
                style: { fill: "#888", opacity: 1 }, layout: {},
                userData: { bodyType: prop("dynamic") }
            } as Node);
            doc.rootNodeUuids.push(e.id);
        }
        return doc;
    };
    const FLOOR = [[0, 0, 0, 0, 0, 0],
                   [0, 0, 0, 0, 0, 0],
                   [0, 0, 0, 0, 0, 0],
                   [1, 1, 1, 0, 1, 1]];      // column 3 is a hole

    it("asks the TILESET which tiles are solid — a field with no reader until now", () => {
        const doc = level(FLOOR);
        const set = doc.tilesets![0];
        expect(tileIsSolid(set, 1)).toBe(true);
        expect(tileIsSolid(set, 0)).toBe(false);        // no record at all
        expect(tileIsSolid(set, 2)).toBe(false);        // a record, but not a body type
        expect(tileIsSolid(set, -1)).toBe(false);       // TILE_EMPTY is not a tile
        expect(tileIsSolid(null, 1)).toBe(false);
        expect(documentHasSolidTiles(doc)).toBe(true);
        // …and a document whose tiles say nothing must pay nothing.
        const plain = level(FLOOR);
        plain.tilesets = [{ ...plain.tilesets![0], tiles: [] }];
        expect(documentHasSolidTiles(plain)).toBe(false);
    });

    it("only reports the cells the BOX can reach, not the whole level", () => {
        const doc = level(FLOOR);
        // The bottom row starts at y = 100 + 3*16 = 148. A box over columns 0-1 sees two cells.
        const near = tileSolidsNear(doc, { x: 0, y: 148, width: 20, height: 10 });
        // AND EACH NAMES THE CELL IT CAME FROM (M18). A solid used to be a bare box, which is why a
        // block could not be hit: every collision here was reported against a node, and a level made
        // of tiles collided perfectly while saying nothing about WHICH tile.
        expect(near).toEqual([
            { x: 0, y: 148, width: CELL, height: CELL, friction: 1, oneWay: false,
              nodeId: "map", cell: { col: 0, row: 3 } },
            { x: 16, y: 148, width: CELL, height: CELL, friction: 1, oneWay: false,
              nodeId: "map", cell: { col: 1, row: 3 } }
        ]);
        // OVER THE HOLE it sees nothing, which is what makes this a cell question and not a node one.
        expect(tileSolidsNear(doc, { x: 50, y: 148, width: 10, height: 10 })).toEqual([]);
        // Away from the grid entirely: nothing, and no throw.
        expect(tileSolidsNear(doc, { x: 900, y: 900, width: 10, height: 10 })).toEqual([]);
    });

    it("a body STANDS on a tile floor", () => {
        const doc = level(FLOOR, [{ id: "b", x: 0, y: 0 }]);
        const after = steps(doc, worldFrom(doc), 120);
        // The floor's top is y = 100 + 3*16 = 148, so a 10-high body rests at 138.
        expect(after.bodies.get("b")!.y).toBe(138);
        expect(after.bodies.get("b")!.onGround).toBe(true);
    });

    it("and falls through the HOLE, which is what proves it reads cells", () => {
        // Column 3 spans x = 48..64. A body at x=50 is over the gap and must keep going.
        const doc = level(FLOOR, [{ id: "b", x: 50, y: 0 }]);
        const after = steps(doc, worldFrom(doc), 120);
        expect(after.bodies.get("b")!.y).toBeGreaterThan(200);
        expect(after.bodies.get("b")!.onGround).toBe(false);
    });

    it("walks ALONG a tile floor without snagging on the seams", () => {
        // Every cell boundary is a seam between two separate solids — the case that made axis
        // separation necessary in slice 1, now multiplied by a cell every 16px.
        const doc = level([[0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1]], [{ id: "b", x: 0, y: 100 }]);
        // LAND FIRST, and 5 steps is not enough: the drop is 6px and five steps of gravity is
        // 3.75px. A fixture that asserted `onGround` before the body arrived would be asserting
        // its own impatience.
        let w = steps(doc, worldFrom(doc), 20);
        expect(w.bodies.get("b")!.onGround).toBe(true);
        const y = w.bodies.get("b")!.y;
        w = atWalk(w, "b");
        for (let i = 0; i < 20; i++) {
            w = stepWorld(doc, w, { input: { left: false, right: true, jump: false }, controlled: "b" });
        }
        // 20 steps at 220 px/s is 73.3px — four seams crossed, never caught on one.
        expect(w.bodies.get("b")!.x).toBeCloseTo(20 * MOVE_SPEED * FIXED_STEP, 6);
        expect(w.bodies.get("b")!.y).toBe(y);
        expect(w.bodies.get("b")!.onGround).toBe(true);
    });

    it("stops against a tile WALL", () => {
        // A column of solid tiles at column 4 (x = 64..80), floor beneath.
        const doc = level([[0, 0, 0, 0, 1, 0],
                           [0, 0, 0, 0, 1, 0],
                           [0, 0, 0, 0, 1, 0],
                           [1, 1, 1, 1, 1, 1]], [{ id: "b", x: 0, y: 100 }]);
        let w = steps(doc, worldFrom(doc), 5);
        for (let i = 0; i < 60; i++) {
            w = stepWorld(doc, w, { input: { left: false, right: true, jump: false }, controlled: "b" });
        }
        // Its right edge meets the wall's left: 64 - 10.
        expect(w.bodies.get("b")!.x).toBe(54);
        expect(w.bodies.get("b")!.vx).toBe(0);
        expect(w.bodies.get("b")!.onGround).toBe(true);
    });

    it("places a solid cell with the RIGHT dimension on each axis — a NON-SQUARE grid", () => {
        // EVERY OTHER FIXTURE HERE IS 16x16, which cannot tell `col * tileWidth` from
        // `col * tileHeight`. That swap is the whole reason this battery is called
        // `mutate-dimensions`, and a square fixture is the classic way to be blind to it.
        // 32 wide by 8 high: a mistake on either axis moves a cell by 24px.
        const doc = createEmptyDocument();
        doc.tilesets = [{
            id: "ts", name: "T", src: "t.png",
            sheet: { columns: 4, tileWidth: 32, tileHeight: 8, spacing: 0, margin: 0 },
            tiles: [{ id: 1, userData: { bodyType: prop("static") } }], offsetX: 0, offsetY: 0
        }];
        doc.nodes.set("map", {
            id: "map", type: "core.tilemap", parent: null, children: [], name: "wide",
            geometry: { x: 0, y: 0, width: 96, height: 16 },
            style: { fill: "none", opacity: 1 }, layout: {},
            tilemap: { cols: 3, rows: 2, tileWidth: 32, tileHeight: 8, tilesetId: "ts",
                tiles: [0, 0, 0, 0, 1, 0] }        // the ONE solid cell is col 1, row 1
        } as unknown as Node);
        doc.rootNodeUuids.push("map");
        // Col 1 row 1 of a 32x8 grid sits at (32, 8) and is 32 by 8. Swap either dimension and it
        // lands at (8, 8), (32, 32) or with the wrong size — all four are different numbers here.
        expect(tileSolidsNear(doc, { x: 0, y: 0, width: 96, height: 16 }))
            .toEqual([{ x: 32, y: 8, width: 32, height: 8, friction: 1, oneWay: false,
                        nodeId: "map", cell: { col: 1, row: 1 } }]);
    });

    it("a dangling tilesetId collides with NOTHING, rather than becoming an invisible wall", () => {
        const doc = level(FLOOR, [{ id: "b", x: 0, y: 0 }]);
        (doc.nodes.get("map") as unknown as { tilemap: { tilesetId: string } }).tilemap.tilesetId = "gone";
        expect(tileSolidsNear(doc, { x: 0, y: 148, width: 20, height: 10 })).toEqual([]);
        const after = steps(doc, worldFrom(doc), 120);
        expect(after.bodies.get("b")!.y).toBeGreaterThan(200);
    });
});

describe("surface friction — the ground's property, not the body's", () => {
    /** A floor with a stated friction, and a body already standing on it. */
    const on = (friction: string | null) => {
        const doc = docWith([
            { id: "b", x: 0, y: 90, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -500, y: 100, w: 2000, h: 20,
              userData: friction === null
                ? { bodyType: prop("static") }
                : { bodyType: prop("static"), friction: prop(friction) } }
        ]);
        return { doc, world: steps(doc, worldFrom(doc), 5) };
    };
    /** Give it a shove and let it run until it stops or 3 seconds pass. */
    const shove = (doc: ProjectDocument, world: WorldState, vx: number) => {
        let w: WorldState = { ...world,
            bodies: new Map(world.bodies).set("b", { ...world.bodies.get("b")!, vx }) };
        for (let i = 0; i < 180; i++) w = stepWorld(doc, w);
        return w.bodies.get("b")!;
    };

    it("reads the coefficient the way the corpus writes it", () => {
        // The corpus writes `1`, `1.00`, `0.45` — and one property with an EMPTY value.
        expect(frictionOf({ userData: { friction: prop("1") } })).toBe(1);
        expect(frictionOf({ userData: { friction: prop("1.00", "float") } })).toBe(1);
        expect(frictionOf({ userData: { friction: prop("0.45", "float") } })).toBe(0.45);
        // A SURFACE THAT SAYS NOTHING IS GRIPPY, not ice — the measured default, since 44 of the
        // 45 declared values are 1. Getting this backwards would make every level in the tree
        // frictionless, which is the loudest possible wrong default and the easiest to ship.
        expect(frictionOf({})).toBe(1);
        expect(frictionOf({ userData: { friction: prop("") } })).toBe(1);
        expect(frictionOf({ userData: { friction: prop("nonsense") } })).toBe(1);
        // …and it is a coefficient, so it is clamped rather than trusted.
        expect(frictionOf({ userData: { friction: prop("-3") } })).toBe(0);
        expect(frictionOf({ userData: { friction: prop("50") } })).toBe(1);
    });

    it("stops a shoved body in the distance COULOMB says, not a distance I chose", () => {
        // a = mu*g = 900 px/s^2; a body at 220 px/s covers v^2/(2a) = 26.9px before stopping.
        // The number comes from the model, which is the whole reason there is no new constant.
        const { doc, world } = on("1");
        const b = shove(doc, world, MOVE_SPEED);
        expect(b.vx).toBe(0);
        expect(b.x).toBeGreaterThan(24);
        expect(b.x).toBeLessThan(30);
    });

    it("slides further on a slippier surface, which is what makes 0.45 mean anything", () => {
        // The corpus's one non-1 value, on the block a player pushes: 220^2/(2*0.45*900) = 59.8px.
        const slip = on("0.45");
        const slippy = shove(slip.doc, slip.world, MOVE_SPEED);
        expect(slippy.x).toBeGreaterThan(55);
        expect(slippy.x).toBeLessThan(65);
        // …and ICE never stops it at all.
        const icy = on("0");
        const ice = shove(icy.doc, icy.world, MOVE_SPEED);
        expect(ice.vx).toBe(MOVE_SPEED);
        expect(ice.x).toBeCloseTo(MOVE_SPEED * 180 * FIXED_STEP, 6);
    });

    it("does NOT apply in the air, which is what air control means", () => {
        const { doc, world } = on("1");
        // Jump ALREADY AT WALKING SPEED, then check the horizontal speed survives the flight. What
        // is being tested is that the AIR does not take it away, so the body is handed the speed
        // rather than made to build it up — that is the input model's business, not friction's.
        let w = stepWorld(doc, atWalk(world, "b"),
            { input: { left: false, right: true, jump: true }, controlled: "b" });
        const vx = w.bodies.get("b")!.vx;
        expect(vx).toBe(MOVE_SPEED);
        for (let i = 0; i < 10; i++) w = stepWorld(doc, w, { input: NO_INPUT, controlled: "b" });
        expect(w.bodies.get("b")!.onGround).toBe(false);
        // A grippy floor would have killed this in a quarter second on the ground; in the air the
        // body keeps every pixel of it.
        expect(w.bodies.get("b")!.vx).toBe(MOVE_SPEED);
    });

    it("a held key SUPPRESSES the ground, or walking on grip would be walking uphill", () => {
        // THE ARITHMETIC IS THE ARGUMENT. Compose friction with the walk and the effective
        // acceleration is `a - mu*g`; on the default surface that is `a - 900`, and any run-up
        // longer than 26.9px puts `a` below 900 — so the player would not move AT ALL on the
        // surface 44 of the corpus's 45 declare. Suppressed instead, grip and ICE accelerate
        // IDENTICALLY while the key is down, and the surface is felt only when it is released.
        const grip = on("1"), ice = on("0");
        const push = (o: { doc: ProjectDocument; world: WorldState }, n: number) => {
            let w = o.world;
            for (let i = 0; i < n; i++) {
                w = stepWorld(o.doc, w, { input: { left: false, right: true, jump: false }, controlled: "b" });
            }
            return w.bodies.get("b")!;
        };
        expect(push(grip, 20).vx).toBeCloseTo(push(ice, 20).vx, 10);
        expect(push(grip, 20).x).toBeCloseTo(push(ice, 20).x, 10);
        // …and both do reach the top speed, rather than agreeing at zero.
        expect(push(grip, 240).vx).toBe(MOVE_SPEED);
        // ON RELEASE THEY PART, which is what makes the coefficient mean anything again.
        let g = push(grip, 240) && (() => { let w = grip.world;
            for (let i = 0; i < 240; i++) w = stepWorld(grip.doc, w, { input: { left: false, right: true, jump: false }, controlled: "b" });
            for (let i = 0; i < 30; i++) w = stepWorld(grip.doc, w, { input: NO_INPUT, controlled: "b" });
            return w.bodies.get("b")!; })();
        const i2 = (() => { let w = ice.world;
            for (let i = 0; i < 240; i++) w = stepWorld(ice.doc, w, { input: { left: false, right: true, jump: false }, controlled: "b" });
            for (let i = 0; i < 30; i++) w = stepWorld(ice.doc, w, { input: NO_INPUT, controlled: "b" });
            return w.bodies.get("b")!; })();
        expect(g.vx).toBe(0);                 // grip: 220 px/s is gone inside half a second
        expect(i2.vx).toBe(MOVE_SPEED);       // ice: every pixel of it kept
    });

    it("a TILE carries its own friction, and falls back to the layer's", () => {
        const doc = createEmptyDocument();
        doc.tilesets = [{
            id: "ts", name: "T", src: "t.png",
            sheet: { columns: 4, tileWidth: 16, tileHeight: 16, spacing: 0, margin: 0 },
            tiles: [
                { id: 1, userData: { bodyType: prop("static") } },                       // says nothing
                { id: 2, userData: { bodyType: prop("static"), friction: prop("0") } }   // ice
            ], offsetX: 0, offsetY: 0
        }];
        doc.nodes.set("map", {
            id: "map", type: "core.tilemap", parent: null, children: [], name: "level",
            geometry: { x: 0, y: 0, width: 32, height: 16 },
            style: { fill: "none", opacity: 1 }, layout: {},
            // THE LAYER says 0.5, so the tile that states nothing inherits it and the tile that
            // states 0 does not — one fixture, both directions.
            userData: { friction: prop("0.5") },
            tilemap: { cols: 2, rows: 1, tileWidth: 16, tileHeight: 16, tilesetId: "ts",
                tiles: [1, 2] }
        } as unknown as Node);
        doc.rootNodeUuids.push("map");
        const solids = tileSolidsNear(doc, { x: 0, y: 0, width: 32, height: 16 });
        expect(solids.map(s => s.friction)).toEqual([0.5, 0]);
    });
});

describe("regions — the world reports, it does not act", () => {
    /** A classed node with no bodyType is a region; the corpus splits exactly that way. */
    const withRegion = (className: string | undefined, box: { x: number; y: number; w: number; h: number },
                        extra: Record<string, unknown> = {}) => {
        const doc = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -500, y: 200, w: 2000, h: 20, userData: { bodyType: prop("static") } }
        ]);
        doc.nodes.set("r", {
            id: "r", type: "core.rectangle", parent: null, children: [], name: "region",
            geometry: { x: box.x, y: box.y, width: box.w, height: box.h },
            style: { fill: "none", opacity: 1 }, layout: {},
            ...(className !== undefined ? { className } : {}), ...extra
        } as unknown as Node);
        doc.rootNodeUuids.push("r");
        return doc;
    };

    it("is a classed node that is NOT a body — the split the corpus already makes", () => {
        // 26 objects in the tree carry a class and no bodyType; 51 carry a bodyType and no class;
        // NONE carry both. This reads that split rather than inventing one.
        const doc = withRegion("coin", { x: 0, y: 0, w: 20, h: 20 });
        expect(regionsOf(doc)).toEqual([
            { nodeId: "r", className: "coin", x: 0, y: 0, width: 20, height: 20 }
        ]);
        // A CLASSED BODY IS A BODY, not a region — or the level's collision geometry would start
        // firing enter events at itself.
        const bodyToo = withRegion("coin", { x: 0, y: 0, w: 20, h: 20 },
            { userData: { bodyType: prop("static") } });
        expect(regionsOf(bodyToo)).toEqual([]);
        // …and an unclassed node is nothing at all, which is 225 of the corpus's 251 objects.
        expect(regionsOf(withRegion(undefined, { x: 0, y: 0, w: 20, h: 20 }))).toEqual([]);
    });

    it("skips a ZERO-AREA region, which the corpus really has", () => {
        // `player-start` is a POINT object with no width or height: somewhere to put something,
        // not a volume to be inside. Given an overlap it could never be entered or left.
        expect(regionsOf(withRegion("Location", { x: 10, y: 10, w: 0, h: 0 }))).toEqual([]);
    });

    it("reports ENTER once, not on every frame the body spends inside", () => {
        // A coin is collected once. The whole reason the overlap set is carried on the world is
        // that a game wants the EDGE, and a body sits inside a region for sixty frames a second.
        const doc = withRegion("coin", { x: -20, y: 40, w: 60, h: 60 });
        let w = worldFrom(doc);
        const seen: string[] = [];
        for (let i = 0; i < 90; i++) {
            w = stepWorld(doc, w);
            for (const e of w.events) seen.push(`${e.kind}:${e.className}:${e.bodyId}`);
        }
        // It falls in, then out the bottom on its way to the floor — exactly one of each.
        expect(seen).toEqual(["enter:coin:b", "leave:coin:b"]);
    });

    it("carries the class straight through and interprets NOTHING", () => {
        // `exit` with a `map` property is the corpus's level transition; this module's whole job is
        // to say a body reached it. Loading `sandbox2.json` is the app's decision, not physics.
        const doc = withRegion("exit", { x: -20, y: 40, w: 60, h: 60 },
            { userData: { map: prop("scene/game/map/sandbox2.json") } });
        let w = worldFrom(doc);
        let first = null as null | { kind: string; className: string; nodeId: string };
        for (let i = 0; i < 30 && !first; i++) {
            w = stepWorld(doc, w);
            if (w.events.length > 0) first = w.events[0];
        }
        // The SIDE says how it arrived, and it is the region that is `below`: the body is 10 wide
        // inside the region's 60-wide span, so the contact axis cannot be horizontal, and it fell
        // in through the top. That is the difference between dropping into an exit and walking
        // into a spike, on the nine classed actors the corpus actually declares.
        expect(first).toEqual({ kind: "enter", bodyId: "b", nodeId: "r", className: "exit",
            side: "below" });
    });

    it("reports LEAVE when the region is DELETED under the body", () => {
        // A coin that is collected and removed must still report the leave, or a game counting
        // "how many am I inside" drifts up by one every time something vanishes under a player.
        const doc = withRegion("coin", { x: -20, y: -20, w: 200, h: 400 });
        let w = stepWorld(doc, worldFrom(doc));
        expect(w.events.map(e => e.kind)).toEqual(["enter"]);
        const gone = withRegion(undefined, { x: 0, y: 0, w: 0, h: 0 });
        gone.nodes.delete("r");
        w = stepWorld(gone, w);
        expect(w.events).toEqual([
            { kind: "leave", bodyId: "b", nodeId: "r", className: "" }
        ]);
        expect(w.overlaps.size).toBe(0);
    });

    it("a region does NOT stop a body — reporting is not colliding", () => {
        const doc = withRegion("spikes", { x: -50, y: 40, w: 200, h: 20 });
        const after = steps(doc, worldFrom(doc), 120);
        // Straight through it and onto the floor at y=200: a region is a volume, not a wall.
        expect(after.bodies.get("b")!.y).toBe(190);
        expect(after.bodies.get("b")!.onGround).toBe(true);
    });

    it("costs nothing when a document has no regions at all", () => {
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        expect(regionsOf(doc)).toEqual([]);
        const w = stepWorld(doc, worldFrom(doc));
        expect(w.events).toEqual([]);
        expect(w.overlaps.size).toBe(0);
    });
});

describe("world space — a node's geometry is its PARENT's, not the world's", () => {
    /**
     * A frame at (100,50) with things inside it — which is exactly what the Tiled importer builds
     * for an object layer, so this is the shape the corpus's own collision geometry arrives in.
     */
    const nested = (extra: Partial<Node> = {}) => {
        const doc = createEmptyDocument();
        doc.nodes.set("frame", {
            id: "frame", type: "core.rectangle", parent: null, children: ["floor", "coin"],
            geometry: { x: 100, y: 50, width: 400, height: 300 },
            style: { fill: "none", opacity: 1 }, layout: {}, name: "objects", ...extra
        } as unknown as Node);
        doc.nodes.set("floor", {
            id: "floor", type: "core.rectangle", parent: "frame", children: [],
            geometry: { x: 10, y: 200, width: 200, height: 20 },
            style: { fill: "#888", opacity: 1 }, layout: {}, name: "bounds",
            userData: { bodyType: prop("static") }
        } as unknown as Node);
        doc.nodes.set("coin", {
            id: "coin", type: "core.rectangle", parent: "frame", children: [],
            geometry: { x: 20, y: 100, width: 24, height: 24 },
            style: { fill: "#ff0", opacity: 1 }, layout: {}, className: "coin"
        } as unknown as Node);
        doc.rootNodeUuids = ["frame"];
        return doc;
    };

    it("composes the ancestors' offsets — the defect this replaced was 50px of phantom floor", () => {
        const doc = nested();
        expect(worldOffsetOf(doc, "floor")).toEqual({ dx: 100, dy: 50 });
        expect(worldOffsetOf(doc, "frame")).toEqual({ dx: 0, dy: 0 });
        // STORED (10,200) — WORLD (110,250). Reading the stored number as the world's is what put
        // a body's collision fifty pixels above the floor it could see.
        expect(solidsOf(doc)).toEqual([{ x: 110, y: 250, width: 200, height: 20, friction: 1, oneWay: false }]);
        expect(regionsOf(doc)).toEqual([
            { nodeId: "coin", className: "coin", x: 120, y: 150, width: 24, height: 24 }
        ]);
    });

    it("a body DROPS ONTO THE FLOOR IT CAN SEE, which is the whole point", () => {
        const doc = nested();
        doc.nodes.set("b", {
            id: "b", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 120, y: 0, width: 10, height: 10 },
            style: { fill: "#f00", opacity: 1 }, layout: {},
            userData: { bodyType: prop("dynamic") }
        } as unknown as Node);
        doc.rootNodeUuids.push("b");
        const after = steps(doc, worldFrom(doc), 120);
        // The floor's real top is 250, so a 10-high body rests at 240 — NOT 190, which is where the
        // stored-as-world reading put it.
        expect(after.bodies.get("b")!.y).toBe(240);
        expect(after.bodies.get("b")!.onGround).toBe(true);
    });

    it("sums TWO levels, because one is the case that passes by accident", () => {
        const doc = nested();
        doc.nodes.set("inner", {
            id: "inner", type: "core.rectangle", parent: "frame", children: ["deep"],
            geometry: { x: 7, y: 3, width: 100, height: 100 },
            style: { fill: "none", opacity: 1 }, layout: {}, name: "inner"
        } as unknown as Node);
        doc.nodes.set("deep", {
            id: "deep", type: "core.rectangle", parent: "inner", children: [],
            geometry: { x: 1, y: 2, width: 10, height: 10 },
            style: { fill: "#0f0", opacity: 1 }, layout: {}, className: "deep"
        } as unknown as Node);
        expect(worldOffsetOf(doc, "deep")).toEqual({ dx: 107, dy: 53 });
        expect(regionsOf(doc).find(r => r.nodeId === "deep"))
            .toEqual({ nodeId: "deep", className: "deep", x: 108, y: 55, width: 10, height: 10 });
    });

    it("WRITES BACK into parent space, or a nested body would accelerate away", () => {
        // The symmetric half. Writing a WORLD position into a nested node's geometry adds the
        // frame's offset a second time — and it does it every frame, so the body runs off.
        const doc = nested();
        doc.nodes.set("b", {
            id: "b", type: "core.rectangle", parent: "frame", children: [],
            geometry: { x: 10, y: 0, width: 10, height: 10 },
            style: { fill: "#f00", opacity: 1 }, layout: {},
            userData: { bodyType: prop("dynamic") }
        } as unknown as Node);
        doc.rootNodeUuids.push("b");
        const world = worldFrom(doc);
        // It STARTS at its world position: 10 + 100, 0 + 50.
        expect(world.bodies.get("b")).toMatchObject({ x: 110, y: 50 });
        const moved = steps(doc, world, 4);         // 2.5px down
        const shown = applyWorldFn(doc, moved);
        // …and the STORED number is back in the frame's space: 0 + 2.5, not 50 + 2.5.
        expect(shown.nodes.get("b")!.geometry.x).toBe(10);
        expect(shown.nodes.get("b")!.geometry.y).toBeCloseTo(2.5, 10);
        // The document itself is untouched, as always.
        expect(doc.nodes.get("b")!.geometry.y).toBe(0);
    });

    it("REFUSES what it cannot sum, and says which and why", () => {
        // A rotation cannot be summed as an offset. Half-composing would put the art in one place
        // and its collision in another — the very defect this replaced.
        const turned = nested({ transform: { rotation: 0.3 } } as Partial<Node>);
        expect(worldOffsetOf(turned, "floor")).toBeNull();
        expect(runtimeRefusal(turned, "floor")).toMatch(/rotated or scaled/);
        expect(solidsOf(turned)).toEqual([]);
        expect(regionsOf(turned)).toEqual([]);
        expect(runtimeExclusions(turned).map(e => e.nodeId).sort()).toEqual(["coin", "floor"]);
        expect(runtimeExclusions(turned)[0].why).toContain("objects");

        // A SCALE is the same problem.
        const scaled = nested({ transform: { scaleX: 2 } } as Partial<Node>);
        expect(runtimeRefusal(scaled, "floor")).toMatch(/rotated or scaled/);

        // AND AN AUTO-LAYOUT CONTAINER, where a stored x/y is dead data the layout overwrites.
        const laid = nested({ layout: { container: { direction: "row" } } } as unknown as Partial<Node>);
        expect(runtimeRefusal(laid, "floor")).toMatch(/auto-layout/);
        expect(worldOffsetOf(laid, "floor")).toBeNull();

        // A ROOT node is never refused, which is every fixture in this file and most documents.
        expect(runtimeRefusal(nested(), "frame")).toBeNull();
        expect(runtimeExclusions(nested())).toEqual([]);
    });

    it("does not hang on a parent that is missing or circular", () => {
        // `Integrity` refuses a cycle at rest, but a document is edited between loads and this runs
        // sixty times a second.
        const orphan = nested();
        (orphan.nodes.get("floor") as unknown as { parent: string }).parent = "nowhere";
        expect(runtimeRefusal(orphan, "floor")).toMatch(/not in the document/);
        expect(solidsOf(orphan)).toEqual([]);

        const loop = nested();
        (loop.nodes.get("frame") as unknown as { parent: string }).parent = "floor";
        expect(runtimeRefusal(loop, "floor")).toMatch(/64 parents, or in a cycle/);
    });

    it("a TILEMAP inside a frame collides where its art is", () => {
        const doc = createEmptyDocument();
        doc.tilesets = [{
            id: "ts", name: "T", src: "t.png",
            sheet: { columns: 4, tileWidth: 16, tileHeight: 16, spacing: 0, margin: 0 },
            tiles: [{ id: 1, userData: { bodyType: prop("static") } }], offsetX: 0, offsetY: 0
        }];
        doc.nodes.set("frame", {
            id: "frame", type: "core.rectangle", parent: null, children: ["map"],
            geometry: { x: 200, y: 300, width: 400, height: 300 },
            style: { fill: "none", opacity: 1 }, layout: {}, name: "level holder"
        } as unknown as Node);
        doc.nodes.set("map", {
            id: "map", type: "core.tilemap", parent: "frame", children: [], name: "level",
            geometry: { x: 5, y: 7, width: 32, height: 16 },
            style: { fill: "none", opacity: 1 }, layout: {},
            tilemap: { cols: 2, rows: 1, tileWidth: 16, tileHeight: 16, tilesetId: "ts",
                tiles: [1, 0] }
        } as unknown as Node);
        doc.rootNodeUuids = ["frame"];
        // The solid cell is col 0 of a grid whose origin is 200+5, 300+7.
        expect(tileSolidsNear(doc, { x: 200, y: 300, width: 60, height: 40 }))
            .toEqual([{ x: 205, y: 307, width: 16, height: 16, friction: 1, oneWay: false,
                        nodeId: "map", cell: { col: 0, row: 0 } }]);
    });
});

describe("one-way platforms — the first thing here that is an INVENTION", () => {
    /**
     * The corpus declares nothing about platforms you jump up through, so `bodyType=oneway` is a
     * choice rather than a measurement — said here as plainly as the module header says it.
     *
     * A platform at y=100, and a body that can be put above or below it.
     */
    const level = (bodyY: number) => docWith([
        { id: "b", x: 20, y: bodyY, userData: { bodyType: prop("dynamic") } },
        { id: "plat", x: 0, y: 100, w: 200, h: 10, userData: { bodyType: prop("oneway") } },
        { id: "ground", x: -500, y: 400, w: 2000, h: 20, userData: { bodyType: prop("static") } }
    ]);

    it("is a body type an older build simply does not know", () => {
        // A NEW VALUE ON AN EXISTING FIELD costs nothing to a reader that never met it: an unknown
        // word is not a body, so a level written before this behaves exactly as it did.
        expect(bodyTypeOf({ userData: { bodyType: prop("oneway") } })).toBe("oneway");
        expect(bodyTypeOf({ userData: { bodyType: prop("ONEWAY") } })).toBe("oneway");
        expect(bodyTypeOf({ userData: { bodyType: prop("one-way") } })).toBeNull();
        const doc = level(0);
        expect(solidsOf(doc).map(s => [s.y, s.oneWay])).toEqual([[100, true], [400, false]]);
    });

    it("LANDS on it from above", () => {
        const doc = level(0);
        const after = steps(doc, worldFrom(doc), 120);
        // Its top is 100, so a 10-high body rests at 90 — not on the ground far below.
        expect(after.bodies.get("b")!.y).toBe(90);
        expect(after.bodies.get("b")!.onGround).toBe(true);
    });

    it("PASSES UP THROUGH IT FROM BELOW, which is the entire point", () => {
        // FROM BELOW, and that word is the test. The first version of this jumped from ON TOP of
        // the platform — where the body starts exactly on the surface and moves AWAY from it, so
        // nothing ever overlaps and the rule is never asked. A mutant deleting the falling check
        // survived it untouched. The body has to rise INTO the slab for the case to exist.
        const doc = docWith([
            { id: "b", x: 20, y: 140, userData: { bodyType: prop("dynamic") } },
            { id: "plat", x: 0, y: 100, w: 200, h: 10, userData: { bodyType: prop("oneway") } },
            { id: "floor", x: -500, y: 150, w: 2000, h: 20, userData: { bodyType: prop("static") } }
        ]);
        let w = steps(doc, worldFrom(doc), 20);
        expect(w.bodies.get("b")!.y).toBe(140);            // on the floor, UNDER the platform
        expect(w.bodies.get("b")!.onGround).toBe(true);

        // THE KEY IS HELD ALL THE WAY UP, and since slice 16 that is what makes this a jump that
        // reaches the slab at all: a tap now rises 18px, and the platform's underside is 30px above
        // this body's head. Released, the body would stop short of the case this test exists for and
        // the assertion below would fail for a reason that has nothing to do with one-way platforms.
        const HELD = { left: false, right: false, jump: true };
        w = stepWorld(doc, w, { input: HELD, controlled: "b" });
        let peak = w.bodies.get("b")!.y;
        for (let i = 0; i < 25; i++) {
            w = stepWorld(doc, w, { input: HELD, controlled: "b" });
            peak = Math.min(peak, w.bodies.get("b")!.y);
        }
        // IT WENT THROUGH: the peak is above the platform's top rather than stopped under its
        // underside at 110, which is where a two-way solid would have caught it.
        expect(peak).toBeLessThan(100);
        // …and on the way down it LANDS on it, which is the other half of one-way.
        for (let i = 0; i < 60; i++) w = stepWorld(doc, w, { input: NO_INPUT, controlled: "b" });
        expect(w.bodies.get("b")!.y).toBe(90);
        expect(w.bodies.get("b")!.onGround).toBe(true);
    });

    it("does not stop a body rising into it, even one that never lands", () => {
        // The narrowest statement of the same rule: shove a body straight up into the underside.
        const doc = docWith([
            { id: "b", x: 20, y: 140, userData: { bodyType: prop("dynamic") } },
            { id: "plat", x: 0, y: 100, w: 200, h: 10, userData: { bodyType: prop("oneway") } }
        ]);
        let w: WorldState = { ...worldFrom(doc),
            bodies: new Map(worldFrom(doc).bodies).set("b",
                { ...worldFrom(doc).bodies.get("b")!, vy: -600 }) };
        for (let i = 0; i < 5; i++) w = stepWorld(doc, w);
        // Straight past 110 and 100 without being caught by either edge.
        expect(w.bodies.get("b")!.y).toBeLessThan(100);
        expect(w.bodies.get("b")!.vy).toBeLessThan(0);
    });

    it("a body starting INSIDE it falls out rather than being launched to its surface", () => {
        // The test is where the body WAS at the start of the step, not where it is: a body that
        // began overlapping was never above, so nothing catches it.
        const doc = level(102);                    // its box is 102..112, inside the 100..110 slab
        const after = steps(doc, worldFrom(doc), 200);
        // Straight down to the real ground at 400.
        expect(after.bodies.get("b")!.y).toBe(390);
        expect(after.bodies.get("b")!.onGround).toBe(true);
    });

    it("has NO SIDES — walking into its edge does not stop a body", () => {
        // A one-way platform is a floor that is only a floor from above; a body at the same height
        // must pass straight through where a static solid would block it.
        const doc = docWith([
            { id: "b", x: -40, y: 100, userData: { bodyType: prop("dynamic") } },
            { id: "plat", x: 0, y: 100, w: 100, h: 10, userData: { bodyType: prop("oneway") } },
            { id: "ground", x: -500, y: 400, w: 2000, h: 20, userData: { bodyType: prop("static") } }
        ]);
        let w = atWalk(worldFrom(doc), "b");
        for (let i = 0; i < 30; i++) {
            w = stepWorld(doc, w, { input: { left: false, right: true, jump: false }, controlled: "b" });
        }
        // 30 steps at 220 px/s is 110px: from -40 to 70, straight through where the slab is.
        expect(w.bodies.get("b")!.x).toBeCloseTo(-40 + 30 * MOVE_SPEED * FIXED_STEP, 6);
        expect(w.bodies.get("b")!.vx).toBe(MOVE_SPEED);
    });

    it("works as a TILE too, so a level can be built out of them", () => {
        const doc = createEmptyDocument();
        doc.tilesets = [{
            id: "ts", name: "T", src: "t.png",
            sheet: { columns: 4, tileWidth: 16, tileHeight: 16, spacing: 0, margin: 0 },
            tiles: [{ id: 1, userData: { bodyType: prop("oneway") } },
                    { id: 2, userData: { bodyType: prop("static") } }],
            offsetX: 0, offsetY: 0
        }];
        doc.nodes.set("map", {
            id: "map", type: "core.tilemap", parent: null, children: [], name: "level",
            geometry: { x: 0, y: 100, width: 64, height: 32 },
            style: { fill: "none", opacity: 1 }, layout: {},
            tilemap: { cols: 4, rows: 2, tileWidth: 16, tileHeight: 16, tilesetId: "ts",
                tiles: [1, 1, 1, 1, 2, 2, 2, 2] }
        } as unknown as Node);
        doc.nodes.set("b", {
            id: "b", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 20, y: 0, width: 10, height: 10 },
            style: { fill: "#f00", opacity: 1 }, layout: {},
            userData: { bodyType: prop("dynamic") }
        } as unknown as Node);
        doc.rootNodeUuids = ["map", "b"];
        // Both rows are solid to a falling body, and the one-way row is the one it meets first.
        expect(tileSolidsNear(doc, { x: 16, y: 100, width: 16, height: 32 }).map(s => [s.y, s.oneWay]))
            .toEqual([[100, true], [116, false]]);
        const after = steps(doc, worldFrom(doc), 120);
        expect(after.bodies.get("b")!.y).toBe(90);
        expect(after.bodies.get("b")!.onGround).toBe(true);
    });
});

describe("sideOf — where the other thing sits", () => {
    /**
     * Literal boxes and literal answers. This is the only genuinely new INFORMATION in the contact
     * slice, so it is pinned on its own before anything asks it about a body.
     */
    const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

    it("names the vertical side from the reporter's point of view, both ways round", () => {
        // A stomp: the thing met is UNDER the reporter.
        expect(sideOf(box(0, 0, 10, 10), box(0, 8, 10, 10))).toBe("below");
        // …and the same pair asked from the other side is the opposite word, which is what tells
        // a stomp from being stomped.
        expect(sideOf(box(0, 8, 10, 10), box(0, 0, 10, 10))).toBe("above");
    });

    it("names the horizontal side", () => {
        expect(sideOf(box(0, 0, 10, 10), box(8, 0, 10, 10))).toBe("right");
        expect(sideOf(box(8, 0, 10, 10), box(0, 0, 10, 10))).toBe("left");
    });

    it("A SPANNED AXIS CANNOT BE THE CONTACT AXIS — the case a shallowest-overlap test gets wrong", () => {
        // A 4-wide body standing on a 100-wide floor. The horizontal overlap (4) is SHALLOWER than
        // the vertical one (10), so picking the shallower axis answers "left" — a body reporting it
        // walked into the floor it is standing on. Being entirely inside the floor's x span settles
        // it: there is no left or right to report.
        const thin = box(0, 0, 4, 100), wide = box(-50, 90, 100, 20);
        expect(sideOf(thin, wide)).toBe("below");
        // The naive rule really would have said otherwise, which is what makes this test worth having.
        const ox = Math.min(4, 50) - Math.max(0, -50);
        const oy = Math.min(100, 110) - Math.max(0, 90);
        expect(ox).toBe(4);
        expect(oy).toBe(10);
        expect(ox < oy).toBe(true);
    });

    it("breaks an exact tie VERTICALLY, because a platformer's commonest contact is a landing", () => {
        // A perfect corner: 5px of overlap on each axis, neither box spanned.
        expect(sideOf(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe("below");
        expect(sideOf(box(5, 5, 10, 10), box(0, 0, 10, 10))).toBe("above");
    });

    it("REFUSES rather than guesses when one box is wholly inside the other", () => {
        expect(sideOf(box(5, 5, 2, 2), box(0, 0, 20, 20))).toBe("inside");
        // …and refuses for boxes that do not touch at all, which no caller here asks about.
        expect(sideOf(box(0, 0, 10, 10), box(100, 100, 10, 10))).toBe("inside");
        // Touching edges are not an overlap, the same rule the collision test uses.
        expect(sideOf(box(0, 0, 10, 10), box(0, 10, 10, 10))).toBe("inside");
    });
});

describe("body meets body — REPORTED, never resolved", () => {
    /**
     * THE FIXTURES ARE NOT AT THE ORIGIN AND THE BODIES ARE NOT THE SAME SIZE, both deliberately.
     * Every other dynamic body in this file is 10x10 at small coordinates, which cannot tell a
     * width from a height nor see anything proportional to position. Here the hero is 12x16, the
     * blob 20x8, and the level sits at x=1000, y=700.
     */
    const FLOOR_TOP = 700;
    const level = (extra: { id: string; x: number; y: number; w?: number; h?: number;
                            userData?: UserData }[]) =>
        docWith([
            { id: "floor", x: 900, y: FLOOR_TOP, w: 400, h: 20, userData: { bodyType: prop("static") } },
            ...extra
        ]);
    const classed = (doc: ProjectDocument, id: string, className: string) => {
        const n = doc.nodes.get(id)!;
        doc.nodes.set(id, { ...n, className } as Node);
        return doc;
    };
    const contacts = (w: WorldState) => w.events.filter(e => e.kind === "contact" || e.kind === "separate");

    it("A STOMP: the one that landed reads `below`, the one landed on reads `above`", () => {
        // Blob 20x8 resting on the floor: its bottom is 700, so it sits at 692.
        // Hero 12x16 dropped from 600, horizontally INSIDE the blob's 20-wide span (1004..1016
        // within 1000..1020) so the contact axis cannot be horizontal.
        const doc = classed(level([
            { id: "blob", x: 1000, y: 692, w: 20, h: 8, userData: { bodyType: prop("dynamic") } },
            { id: "hero", x: 1004, y: 600, w: 12, h: 16, userData: { bodyType: prop("dynamic") } }
        ]), "blob", "enemy");
        let w = worldFrom(doc);
        // Free fall from 600 is y(n) = 600 + 0.125*n*(n+1). At step 24 the hero's box is
        // 675..691, clear of the blob's 692..700; at step 25 it is 681.25..697.25, which overlaps.
        for (let i = 0; i < 24; i++) w = stepWorld(doc, w);
        expect(w.bodies.get("hero")!.y).toBe(675);
        expect(contacts(w)).toEqual([]);
        w = stepWorld(doc, w);
        expect(w.bodies.get("hero")!.y).toBe(681.25);
        expect(contacts(w)).toEqual([
            { kind: "contact", bodyId: "blob", nodeId: "hero", className: "", side: "above" },
            { kind: "contact", bodyId: "hero", nodeId: "blob", className: "enemy", side: "below" }
        ]);
    });

    it("REPORTING IS NOT COLLIDING — the hero falls straight through and lands on the FLOOR", () => {
        // The entire design in one assertion. If a contact ever moved a body this fails, and it is
        // the reason none of the resolving design's failures can occur here.
        const doc = level([
            { id: "blob", x: 1000, y: 692, w: 20, h: 8, userData: { bodyType: prop("dynamic") } },
            { id: "hero", x: 1004, y: 600, w: 12, h: 16, userData: { bodyType: prop("dynamic") } }
        ]);
        const after = steps(doc, worldFrom(doc), 120);
        // Hero is 16 high and the floor's top is 700, so it rests at 684 — THROUGH the blob, whose
        // box it still overlaps, and which has not been pushed anywhere either.
        expect(after.bodies.get("hero")!.y).toBe(684);
        expect(after.bodies.get("hero")!.onGround).toBe(true);
        expect(after.bodies.get("blob")!.y).toBe(692);
        expect(after.bodies.get("blob")!.x).toBe(1000);
        // …and they are still touching, so nothing separated when it settled.
        expect(after.contacts.size).toBe(1);
    });

    it("WALKING INTO IT reads `right`, not `below` — the distinction this slice exists for", () => {
        // Both rest on the floor: hero 12x16 at 684, blob 20x8 at 692, so they share the floor's
        // top plane and the vertical overlap is 8 the whole way. The hero walks right at 220 px/s.
        const doc = level([
            { id: "blob", x: 1102, y: 692, w: 20, h: 8, userData: { bodyType: prop("dynamic") } },
            { id: "hero", x: 1000, y: 684, w: 12, h: 16, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = atWalk(worldFrom(doc), "hero");
        const RIGHT = { left: false, right: true, jump: false };
        // 220/60 is 11/3 px a step, and the hero's right edge starts at 1012. THE GAP IS 90, NOT 88,
        // and the two extra pixels are the point: at 88 the crossing lands exactly on the boundary,
        // where twenty-four accumulated additions of 11/3 give 88.00000000000001 rather than 88 and
        // the contact fires a step early. A position here is a running SUM, so a closed-form
        // hand-computation and the code can disagree in the last bit — put the fixture where the
        // answer does not depend on which of them is right. 90 / (11/3) = 24.5, so step 25.
        for (let i = 0; i < 24; i++) w = stepWorld(doc, w, { input: RIGHT, controlled: "hero" });
        expect(contacts(w)).toEqual([]);
        w = stepWorld(doc, w, { input: RIGHT, controlled: "hero" });
        expect(w.bodies.get("hero")!.x).toBeCloseTo(1000 + 25 * MOVE_SPEED * FIXED_STEP, 9);
        expect(contacts(w).map(e => [e.bodyId, e.side])).toEqual([
            ["blob", "left"], ["hero", "right"]
        ]);
    });

    it("is an EDGE: contact fires once, and separate fires when it walks out the far side", () => {
        const doc = level([
            { id: "blob", x: 1102, y: 692, w: 20, h: 8, userData: { bodyType: prop("dynamic") } },
            { id: "hero", x: 1000, y: 684, w: 12, h: 16, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = atWalk(worldFrom(doc), "hero");
        const RIGHT = { left: false, right: true, jump: false };
        const seen: string[] = [];
        for (let i = 0; i < 40; i++) {
            w = stepWorld(doc, w, { input: RIGHT, controlled: "hero" });
            for (const e of contacts(w)) seen.push(`${e.kind}:${e.bodyId}`);
        }
        // Exactly one of each per body across forty steps, not one per frame spent overlapping.
        expect(seen).toEqual([
            "contact:blob", "contact:hero", "separate:blob", "separate:hero"
        ]);
    });

    it("SEPARATES when the other body is DELETED under it, as leaving survives a deleted region", () => {
        const doc = level([
            { id: "blob", x: 1000, y: 692, w: 20, h: 8, userData: { bodyType: prop("dynamic") } },
            { id: "hero", x: 1004, y: 684, w: 12, h: 16, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = stepWorld(doc, worldFrom(doc));
        expect(contacts(w).map(e => e.kind)).toEqual(["contact", "contact"]);
        const gone = level([
            { id: "hero", x: 1004, y: 684, w: 12, h: 16, userData: { bodyType: prop("dynamic") } }
        ]);
        w = stepWorld(gone, w);
        expect(contacts(w)).toEqual([
            { kind: "separate", bodyId: "blob", nodeId: "hero", className: "" },
            { kind: "separate", bodyId: "hero", nodeId: "blob", className: "" }
        ]);
        expect(w.contacts.size).toBe(0);
    });

    it("THE EVENT ORDER IS A FUNCTION OF THE DOCUMENT, not of node insertion order", () => {
        // Nothing in this file tested body iteration order before, and the order really does move:
        // undoing a DELETE re-appends the node, permuting the map without changing the content.
        // `m` overlaps BOTH `a` and `z` in one step, so there is a real ordering choice to get wrong
        // — with one pair there is nothing to order and the test would be blind.
        const bodies = [
            { id: "m", x: 1000, y: 690, w: 40, h: 10, userData: { bodyType: prop("dynamic") } },
            { id: "a", x: 1005, y: 692, w: 10, h: 10, userData: { bodyType: prop("dynamic") } },
            { id: "z", x: 1025, y: 692, w: 10, h: 10, userData: { bodyType: prop("dynamic") } }
        ];
        const run = (order: typeof bodies) => {
            const doc = docWith(order);
            return stepWorld(doc, worldFrom(doc));
        };
        const forward = run([bodies[0], bodies[1], bodies[2]]);
        const backward = run([bodies[2], bodies[1], bodies[0]]);
        expect(forward.events).toEqual(backward.events);
        expect([...forward.contacts]).toEqual([...backward.contacts]);
        // …and it really did see two pairs, or the fixture proves nothing. `a` and `z` are 10px
        // apart so they do NOT touch each other; both touch `m`.
        expect(forward.events.map(e => `${e.bodyId}>${e.nodeId}`)).toEqual([
            "a>m", "m>a", "m>z", "z>m"
        ]);
    });

    it("skips a ZERO-AREA body, the same refusal solidsOf and regionsOf already make", () => {
        // An author dragging a new node out passes through 0x0, and a point is not a volume.
        const doc = docWith([
            { id: "ghost", x: 1005, y: 695, w: 0, h: 0, userData: { bodyType: prop("dynamic") } },
            { id: "real", x: 1000, y: 690, w: 40, h: 10, userData: { bodyType: prop("dynamic") } }
        ]);
        const w = stepWorld(doc, worldFrom(doc));
        expect(w.events).toEqual([]);
        expect(w.contacts.size).toBe(0);
    });

    it("skips a body REFUSED MID-RUN — it is no longer drawn where it is simulated", () => {
        // THE FIRST VERSION OF THIS TEST WAS BLIND AND THE MUTANT SURVIVED. It refused the body
        // from the start, and `worldFrom` ALREADY skips a refused body — so the body never entered
        // the world at all and the guard in the contact pass was never reached. The reachable case
        // is a refusal that appears MID-RUN: the body is in `world.bodies` from Play, and the app
        // steps against the LIVE stored document, so rotating its frame while the run is going
        // makes `worldOffsetOf` start answering null for a body that is already moving.
        const build = (turned: boolean) => {
            const doc = createEmptyDocument();
            doc.nodes.set("frame", {
                id: "frame", type: "core.rectangle", parent: null, children: ["hidden"],
                geometry: { x: 1000, y: 690, width: 400, height: 300 },
                style: { fill: "none", opacity: 1 }, layout: {},
                ...(turned ? { transform: { rotation: 0.3 } } : {})
            } as unknown as Node);
            doc.nodes.set("hidden", {
                id: "hidden", type: "core.rectangle", parent: "frame", children: [],
                geometry: { x: 0, y: 0, width: 40, height: 10 },
                style: { fill: "#888", opacity: 1 }, layout: {},
                userData: { bodyType: prop("dynamic") }
            } as unknown as Node);
            doc.nodes.set("free", {
                id: "free", type: "core.rectangle", parent: null, children: [],
                geometry: { x: 1005, y: 692, width: 10, height: 10 },
                style: { fill: "#888", opacity: 1 }, layout: {},
                userData: { bodyType: prop("dynamic") }
            } as unknown as Node);
            doc.rootNodeUuids = ["frame", "free"];
            return doc;
        };
        const upright = build(false);
        const w = worldFrom(upright);
        expect(w.bodies.has("hidden")).toBe(true);
        // THE POSITIVE CONTROL, without which the assertion below passes for the wrong reason:
        // these two really do touch, and really do report it, while the frame is composable.
        expect(stepWorld(upright, w).events.filter(e => e.kind === "contact"))
            .toHaveLength(2);
        // Now the frame is rotated under the running world — a legal edit, and one App.tsx picks up
        // on the next step because it steps against the stored document.
        const turned = build(true);
        expect(runtimeRefusal(turned, "hidden")).not.toBeNull();
        expect(stepWorld(turned, w).events.filter(e => e.kind === "contact")).toEqual([]);
    });

    it("costs nothing on a document with one body, which is 24 of this file's 25 fixtures", () => {
        const doc = level([
            { id: "hero", x: 1004, y: 684, w: 12, h: 16, userData: { bodyType: prop("dynamic") } }
        ]);
        const w = stepWorld(doc, worldFrom(doc));
        expect(w.contacts.size).toBe(0);
        expect(w.events).toEqual([]);
    });
});

describe("the reciprocal side is DERIVED, because sideOf is not antisymmetric", () => {
    it("sideOf really does answer `inside` for the contained box — the reason this exists", () => {
        // A 32x8 enemy standing where a 32x32 hero lands is ENTIRELY inside the hero's box, so
        // asking sideOf the other way round is not wrong about the geometry — it is just useless as
        // a pair, and it made every rule keyed on the STOMPED body unreachable.
        const H = { x: 100, y: 368, width: 32, height: 32 };
        const E = { x: 100, y: 392, width: 32, height: 8 };
        expect(sideOf(H, E)).toBe("below");
        expect(sideOf(E, H)).toBe("inside");
        expect(oppositeSide(sideOf(H, E))).toBe("above");
    });

    it("inverts each axis and leaves a refusal alone", () => {
        expect(oppositeSide("above")).toBe("below");
        expect(oppositeSide("below")).toBe("above");
        expect(oppositeSide("left")).toBe("right");
        expect(oppositeSide("right")).toBe("left");
        expect(oppositeSide("inside")).toBe("inside");
    });

    it("A CONTAINED BODY'S CONTACT EVENT READS `above`, not `inside`", () => {
        // The fixture the earlier stomp test could not be: the enemy is narrower than the hero AND
        // inside it vertically, which is the ordinary shape of a small enemy under a big player.
        // With the reciprocal computed rather than derived this pair read (below, inside).
        const doc = docWith([
            { id: "floor", x: 0, y: 400, w: 400, h: 32, userData: { bodyType: prop("static") } },
            { id: "enemy", x: 100, y: 392, w: 32, h: 8, userData: { bodyType: prop("dynamic") } },
            { id: "hero", x: 100, y: 368, w: 32, h: 32, userData: { bodyType: prop("dynamic") } }
        ]);
        const w = stepWorld(doc, worldFrom(doc));
        const pair = w.events.filter(e => e.kind === "contact").map(e => [e.bodyId, e.side]);
        expect(pair).toEqual([["enemy", "above"], ["hero", "below"]]);
    });
});

describe("the dirty set names what changed since the LAST frame", () => {
    /**
     * `movedIds` compared the world against the STORED document, which is a different question, and
     * they disagree in exactly the case a platformer produces constantly: a body that jumps and
     * lands back where it was authored agrees with the document again, so it went unnamed on the
     * very frame it arrived and the incremental geometry drew it mid-air for the rest of the run.
     */
    const level = () => docWith([
        { id: "floor", x: 0, y: 400, w: 400, h: 32, userData: { bodyType: prop("static") } },
        { id: "H", x: 100, y: 368, w: 32, h: 32, userData: { bodyType: prop("dynamic") } }
    ]);

    it("NAMES A BODY ON THE FRAME IT RETURNS to its authored position", () => {
        const doc = level();
        let w = worldFrom(doc);
        let landed: { named: boolean; namedWithout: boolean } | null = null;
        for (let i = 0; i < 60 && !landed; i++) {
            const before = w;
            w = stepWorld(doc, w, { input: { left: false, right: false, jump: i === 1 }, controlled: "H" });
            const y = w.bodies.get("H")!.y, wasY = before.bodies.get("H")!.y;
            // The frame of interest: back at the authored 368 having been somewhere else.
            if (y === 368 && wasY !== 368) {
                landed = { named: movedIds(doc, w, before).has("H"), namedWithout: movedIds(doc, w).has("H") };
            }
        }
        expect(landed).not.toBeNull();
        expect(landed!.named).toBe(true);
        // …and WITHOUT the previous world it is missed, which is the defect stated as a fact.
        expect(landed!.namedWithout).toBe(false);
    });

    it("still names nothing when a body has sat still at its authored position all along", () => {
        // Or the fix would mark everything dirty forever and the incremental path would be pointless.
        const doc = level();
        let w = worldFrom(doc);
        for (let i = 0; i < 5; i++) {
            const before = w;
            w = stepWorld(doc, w);
            if (i > 1) expect([...movedIds(doc, w, before)]).toEqual([]);
        }
    });
});

describe("SCENERY: a layered node is invisible to the physics", () => {
    /**
     * THE RULE: the physics must not collide with something whose position depends on where you
     * are looking. `applyParallax` shifts a layered node by an offset derived from the VIEWPORT, so
     * a depth-1 cloud is drawn somewhere different on every frame of a pan while its stored
     * geometry never moves. Collide against the stored box and the wall is nowhere near the
     * picture; collide against the drawn one and the level plays differently depending on the
     * camera.
     */
    const withGround = () => {
        const doc = docWith([
            { id: "floor", x: 0, y: 100, w: 200, h: 20, userData: { bodyType: prop("static") } },
            { id: "coin", x: 0, y: 40, w: 20, h: 20 },
            { id: "b", x: 10, y: 80, userData: { bodyType: prop("dynamic") } }
        ]);
        (doc.nodes.get("coin") as Node).className = "coin";
        return doc;
    };

    it("a layered SOLID stops being solid, and depth 0 is untouched", () => {
        const doc = withGround();
        // The control FIRST, so a later empty answer cannot pass for the wrong reason.
        expect(solidsOf(doc)).toHaveLength(1);
        (doc.nodes.get("floor") as Node).depth = 1;
        expect(solidsOf(doc)).toEqual([]);
        // …and back again: depth is the whole of the statement, so removing it restores the floor.
        (doc.nodes.get("floor") as Node).depth = 0;
        expect(solidsOf(doc)).toHaveLength(1);
    });

    it("a layered REGION reports nothing, or a coin is collected where it is not drawn", () => {
        const doc = withGround();
        expect(regionsOf(doc).map(r => r.nodeId)).toEqual(["coin"]);
        (doc.nodes.get("coin") as Node).depth = -1;      // FOREGROUND is layered too
        expect(regionsOf(doc)).toEqual([]);
    });

    it("A LAYERED TILEMAP IS NOT A WALL IN THE SKY — the defect this was found by", () => {
        // SOLIDITY IS THE TILESET TILE'S, and every layer drawing that tile shares it. The Kenney
        // map draws all three of its tile layers from ONE tileset, so a background built from the
        // same sheet as the ground was solid — measured on the real level as 0 solids up in the sky
        // before adding a scenery layer and 2 after.
        const doc = createEmptyDocument();
        doc.tilesets = [{
            id: "set", name: "s", src: "x.png", offsetX: 0, offsetY: 0,
            sheet: { columns: 2, tileWidth: 16, tileHeight: 16, spacing: 0, margin: 0 },
            tiles: [{ id: 0, userData: { bodyType: prop("static") } }]
        }] as unknown as ProjectDocument["tilesets"];
        const layer = (id: string, y: number, depth?: number) => {
            doc.nodes.set(id, {
                id, type: "core.tilemap", parent: null, children: [],
                geometry: { x: 0, y, width: 32, height: 16 },
                style: { fill: "#888888", opacity: 1 }, layout: {},
                ...(depth !== undefined ? { depth } : {}),
                tilemap: { cols: 2, rows: 1, tileWidth: 16, tileHeight: 16, tilesetId: "set",
                           tiles: [0, 0] }
            } as unknown as Node);
            doc.rootNodeUuids.push(id);
        };
        layer("ground", 100);
        // THE CONTROL, and it is the assertion my first fixture got wrong: a box that merely RESTS
        // on a surface does not overlap it, and reported zero solids for the floor as well — a
        // vacuous pass. It has to sink INTO the row.
        const near = (y: number) => tileSolidsNear(doc, { x: 0, y, width: 16, height: 16 }).length;
        expect(near(110)).toBeGreaterThan(0);
        expect(near(10)).toBe(0);                       // nothing up there yet

        layer("clouds", 0, 1);                          // scenery, at a depth
        expect(near(10)).toBe(0);                       // …and still nothing: it is not a wall
        expect(near(110)).toBeGreaterThan(0);           // while the ground is untouched
        // The same layer at depth 0 IS solid, which is what says the depth is doing the work rather
        // than something incidental about the second node.
        (doc.nodes.get("clouds") as Node).depth = 0;
        expect(near(10)).toBeGreaterThan(0);
    });
});

describe("BUMPING A BLOCK — the collision a level made of tiles could not report", () => {
    /**
     * A one-cell ceiling at (0,0)-(16,16) with a floor well below it, and a body under the ceiling.
     * 16px cells so the numbers are the fixture's rather than a grid's.
     */
    const CEIL = 16;
    const roomWithCeiling = () => {
        const doc = createEmptyDocument();
        doc.tilesets = [{
            id: "ts", name: "T", src: "t.png", offsetX: 0, offsetY: 0,
            sheet: { columns: 2, tileWidth: CEIL, tileHeight: CEIL, spacing: 0, margin: 0 },
            tiles: [{ id: 1, userData: { bodyType: prop("static") } }]
        }] as unknown as ProjectDocument["tilesets"];
        doc.nodes.set("blocks", {
            id: "blocks", type: "core.tilemap", parent: null, children: [], className: "brick",
            geometry: { x: 0, y: 0, width: 32, height: 16 },
            style: { fill: "none", opacity: 1 }, layout: {},
            tilemap: { cols: 2, rows: 1, tileWidth: CEIL, tileHeight: CEIL, tilesetId: "ts",
                       tiles: [1, 0] }              // ONE solid cell, col 0 row 0
        } as unknown as Node);
        doc.rootNodeUuids.push("blocks");
        doc.nodes.set("floor", {
            id: "floor", type: "core.rectangle", parent: null, children: [],
            geometry: { x: -100, y: 100, width: 400, height: 20 },
            style: { fill: "#888888", opacity: 1 }, layout: {},
            userData: { bodyType: prop("static") }
        } as Node);
        doc.rootNodeUuids.push("floor");
        doc.nodes.set("hero", {
            id: "hero", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 2, y: 88, width: 12, height: 12 },
            style: { fill: "#888888", opacity: 1 }, layout: {},
            userData: { bodyType: prop("dynamic") }
        } as Node);
        doc.rootNodeUuids.push("hero");
        return doc;
    };
    const bumps = (w: WorldState) => w.events.filter(e => e.kind === "bump");

    it("fires on a HEAD HIT, naming the tilemap AND the cell", () => {
        const doc = roomWithCeiling();
        // Launched straight up from under the solid cell. Nothing else in this fixture can stop it.
        const w0 = worldFrom(doc);
        let w: WorldState = { ...w0,
            bodies: new Map(w0.bodies).set("hero", { ...w0.bodies.get("hero")!, y: 30, vy: -300 }) };
        let seen: typeof w.events = [];
        for (let i = 0; i < 12 && seen.length === 0; i++) {
            w = stepWorld(doc, w, { controlled: "hero" });
            seen = bumps(w);
        }
        expect(seen).toHaveLength(1);
        expect(seen[0].nodeId).toBe("blocks");
        expect(seen[0].cell).toEqual({ col: 0, row: 0 });
        // THE SIDE IS `above`, said from the BODY's point of view exactly as a contact is: the
        // thing that stopped it is above it.
        expect(seen[0].side).toBe("above");
        // …and the class travels with it, so a rule can tell a brick from a question block without
        // reaching back into the document.
        expect(seen[0].className).toBe("brick");
        // The body really was stopped: it sits directly under the cell with no upward speed left.
        expect(w.bodies.get("hero")!.y).toBe(CEIL);
        expect(w.bodies.get("hero")!.vy).toBe(0);
    });

    it("does NOT fire on LANDING, or a floor would bump sixty times a second", () => {
        // THE HALF THAT MATTERS MOST. Standing on tiles is the common case in a level made of them,
        // and an event per step per cell would drown every real one.
        const doc = roomWithCeiling();
        let w = worldFrom(doc);
        for (let i = 0; i < 120; i++) w = stepWorld(doc, w, { controlled: "hero" });
        expect(w.bodies.get("hero")!.onGround).toBe(true);
        expect(bumps(w)).toEqual([]);
        // …and it keeps not firing while the body rests there.
        for (let i = 0; i < 30; i++) {
            w = stepWorld(doc, w, { controlled: "hero" });
            expect(bumps(w)).toEqual([]);
        }
    });

    it("says nothing for a NODE solid, whose own id was already the answer", () => {
        // A rectangle body has an id; a cell does not, which is the entire reason this exists. A
        // node solid firing a cell-less bump would be a second, weaker way to say what `contact`
        // already says properly.
        const doc = docWith([
            { id: "roof", x: -50, y: 0, w: 200, h: 16, userData: { bodyType: prop("static") } },
            { id: "b", x: 0, y: 60, userData: { bodyType: prop("dynamic") } }
        ]);
        const w0 = worldFrom(doc);
        let w: WorldState = { ...w0,
            bodies: new Map(w0.bodies).set("b", { ...w0.bodies.get("b")!, vy: -400 }) };
        // THE MINIMUM y, not the final one: it hits the roof and then falls back, so asking at the
        // end would ask whether gravity works rather than whether the roof stopped it.
        let highest = w.bodies.get("b")!.y;
        let fired = 0;
        for (let i = 0; i < 12; i++) {
            w = stepWorld(doc, w, { controlled: "b" });
            highest = Math.min(highest, w.bodies.get("b")!.y);
            fired += bumps(w).length;
        }
        expect(highest).toBe(16);                       // it really did hit the roof
        expect(fired).toBe(0);
    });
});
